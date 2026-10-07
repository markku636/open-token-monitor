//! hub 的即時串流：`GET /api/stats/stream`（上游 src/electron/main.js `startStatsStream`、
//! src/shared/hubProtocol.js）。給 widget 的「全公司」分頁。
//!
//! 協定（overlay 的 hub/stream.js 照上游格式送）：
//! - 連上時一個 `snapshot`，內容有變時 `stats`（`data.stats` 是整份 aggregate）；
//! - 帶 `x-token-monitor-stream: 2` 的連線在只有時間戳變動時收到 `freshness`（只有各裝置的
//!   updatedAt / receivedAt / ageMs / stale），套用 `apply_freshness`；
//! - 每 30 秒一個 `: hb` 註解當心跳；接受 gzip 的連線每個 frame 是一個獨立的 gzip member
//!   （數百台裝置時小 24 倍）。reqwest 0.12 的自動解壓遇到第二個 member 會報「extra bytes after
//!   body」，所以串流的 client 關掉自動解壓、自己送 `accept-encoding: gzip`，再以
//!   `flate2::write::MultiGzDecoder` 邊收邊解（`BodyDecoder`）。
//!
//! 數百台裝置時一個 frame 約 16 MB（每台裝置帶完整 periods 與 sessions）。這裡只反序列化畫面
//! 需要的欄位（`HubStats`），其餘用 serde 略過，不把整份 JSON 留在記憶體。
//!
//! 重連：1 秒起跳加倍到 30 秒、±20% 抖動，收到 snapshot 就歸零；90 秒沒有任何位元組視為斷線；
//! 401 / 403 等 60 秒再試（金鑰輪替中不要一直敲 hub）。

use std::sync::Arc;
use std::time::Duration;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::{classify_transport, HubClient, HubError};

pub const STREAM_HEADER: &str = "x-token-monitor-stream";
pub const STREAM_VERSION: &str = "2";
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
const UNAUTHORIZED_BACKOFF: Duration = Duration::from_secs(60);
/// 一個 frame 的上限：數百台裝置約 16 MB，留兩倍餘裕；超過就斷線重連，免得記憶體被撐爆。
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// 一個期間畫面需要的彙總（數字可能是浮點，照 hub 的 JSON 原樣收）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SlimPeriod {
    pub total_tokens: f64,
    pub cost_usd: f64,
    pub clients: IndexMap<String, f64>,
    pub client_costs: IndexMap<String, f64>,
    pub models: IndexMap<String, f64>,
    pub model_costs: IndexMap<String, f64>,
    /// 工具 → 模型 → token：全公司分頁點開一台裝置時的模型拆分（上游 deviceBreakdown.js）。
    pub client_models: IndexMap<String, IndexMap<String, f64>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SlimPeriods {
    pub today: SlimPeriod,
    pub month: SlimPeriod,
    pub all_time: SlimPeriod,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowEnd {
    pub ends_at: Option<String>,
    /// 裝置本地的日（YYYY-MM-DD）或月鍵：全公司的範圍以每台裝置自己的日期推算（上游
    /// fixedPeriodRanges.js `deviceDayState`）。
    pub key: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SlimPeriodWindows {
    pub today: Option<WindowEnd>,
    pub month: Option<WindowEnd>,
    /// 裝置的 IANA 時區；上游在裝置的日已過期時用它算今天，我們改由 `endsAt` 推出時差（ranges.rs）。
    pub time_zone: Option<String>,
}

/// hub aggregate 裡的一台裝置（上游 usage.js `aggregateDevices` 的 devices[]）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HubDevice {
    pub device_id: String,
    pub hostname: String,
    pub platform: String,
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub agent_version: String,
    pub agent_runtime: String,
    pub updated_at: Option<String>,
    pub received_at: Option<String>,
    pub age_ms: Option<f64>,
    pub stale: bool,
    pub sync_upload_interval_ms: Option<f64>,
    pub period_windows: Option<SlimPeriodWindows>,
    pub periods: SlimPeriods,
}

/// `/api/stats` 的瘦身版。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HubStats {
    pub updated_at: Option<String>,
    pub stale_after_ms: Option<f64>,
    pub devices: Vec<HubDevice>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct FreshDevice {
    device_id: String,
    updated_at: Option<String>,
    received_at: Option<String>,
    age_ms: Option<f64>,
    stale: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct FreshStats {
    updated_at: Option<String>,
    stale_after_ms: Option<f64>,
    devices: Vec<FreshDevice>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct FreshnessData {
    stats: Option<FreshStats>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct StatsData {
    stats: Option<HubStats>,
}

/// 上游 hubProtocol.js `applyFreshnessEvent`：只覆蓋時間戳與 stale，其餘沿用快取。
fn apply_freshness(stats: &HubStats, fresh: &FreshStats) -> HubStats {
    let mut next = stats.clone();
    if fresh.updated_at.is_some() {
        next.updated_at = fresh.updated_at.clone();
    }
    if let Some(ms) = fresh.stale_after_ms.filter(|v| v.is_finite()) {
        next.stale_after_ms = Some(ms);
    }
    for device in &mut next.devices {
        if let Some(f) = fresh
            .devices
            .iter()
            .find(|f| f.device_id == device.device_id)
        {
            if f.updated_at.is_some() {
                device.updated_at = f.updated_at.clone();
            }
            if f.received_at.is_some() {
                device.received_at = f.received_at.clone();
            }
            if f.age_ms.is_some() {
                device.age_ms = f.age_ms;
            }
            if let Some(stale) = f.stale {
                device.stale = stale;
            }
        }
    }
    next
}

/// 一個 SSE frame（`\n\n` 之間）：`event:` 與 `data:` 行，`:` 開頭是註解（上游 `parseSseChunk`）。
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub event: String,
    pub data: String,
}

pub fn parse_frame(chunk: &str) -> Option<Frame> {
    let mut event = "message".to_string();
    let mut data = Vec::new();
    for line in chunk.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(v) = line.strip_prefix("event:") {
            event = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("data:") {
            data.push(v.trim());
        }
    }
    if data.is_empty() {
        return None;
    }
    Some(Frame {
        event,
        data: data.join("\n"),
    })
}

/// 把收到的位元組切成完整的 frame；不完整的尾巴留在 buffer。
#[derive(Debug, Default)]
pub struct FrameSplitter {
    buffer: Vec<u8>,
}

impl FrameSplitter {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(bytes);
        let mut frames = Vec::new();
        while let Some(pos) = self.buffer.windows(2).position(|w| w == b"\n\n") {
            let chunk: Vec<u8> = self.buffer.drain(..pos + 2).collect();
            frames.push(String::from_utf8_lossy(&chunk[..pos]).into_owned());
        }
        frames
    }

    pub fn pending(&self) -> usize {
        self.buffer.len()
    }
}

/// 回應本文的解碼：原文照收，或逐塊解開串接的 gzip member。
enum BodyDecoder {
    Identity,
    Gzip(Box<flate2::write::MultiGzDecoder<Vec<u8>>>),
}

impl BodyDecoder {
    fn for_response(resp: &reqwest::Response) -> BodyDecoder {
        let gzip = resp
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("gzip"));
        if gzip {
            BodyDecoder::Gzip(Box::new(flate2::write::MultiGzDecoder::new(Vec::new())))
        } else {
            BodyDecoder::Identity
        }
    }

    /// 餵進一塊收到的位元組，回傳目前解得出來的原文。
    fn decode(&mut self, bytes: &[u8]) -> Result<Vec<u8>, HubError> {
        use std::io::Write;
        match self {
            BodyDecoder::Identity => Ok(bytes.to_vec()),
            BodyDecoder::Gzip(dec) => {
                dec.write_all(bytes)
                    .and_then(|_| dec.flush())
                    .map_err(|e| HubError::BadResponse(format!("gzip: {e}")))?;
                Ok(std::mem::take(dec.get_mut()))
            }
        }
    }
}

/// 串流的連線狀態（給 UI 與 log）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamState {
    Connecting,
    Connected,
    Reconnecting,
    Unauthorized,
}

/// 串流對外的通知。`Stats` 帶的是套用 freshness 之後的完整快取。
#[derive(Debug, Clone)]
pub enum StreamEvent {
    State {
        state: StreamState,
        error: Option<String>,
    },
    Stats(Arc<HubStats>),
}

pub type StreamSink = Arc<dyn Fn(StreamEvent) + Send + Sync>;

/// 單一連線的結果：`Ok(true)` = 收過 snapshot 後正常結束（EOF），重連不必退避。
async fn read_stream(
    http: &reqwest::Client,
    client: &HubClient,
    sink: &StreamSink,
    cache: &mut Option<HubStats>,
    cancel: &CancellationToken,
) -> Result<bool, HubError> {
    let url = format!("{}/api/stats/stream", client.base_url());
    let mut req = http
        .get(&url)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .header(reqwest::header::ACCEPT_ENCODING, "gzip")
        .header(STREAM_HEADER, STREAM_VERSION);
    if let Some(secret) = client.secret() {
        req = req.bearer_auth(secret);
    }
    let mut resp = tokio::select! {
        r = req.send() => r.map_err(|e| classify_transport(&e))?,
        _ = cancel.cancelled() => return Ok(true),
    };
    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err(HubError::Unauthorized { status });
    }
    if !resp.status().is_success() {
        return Err(HubError::Unexpected {
            status,
            body: String::new(),
        });
    }
    (sink)(StreamEvent::State {
        state: StreamState::Connected,
        error: None,
    });
    let mut splitter = FrameSplitter::default();
    let mut decoder = BodyDecoder::for_response(&resp);
    let mut got_snapshot = false;
    loop {
        let chunk = tokio::select! {
            c = tokio::time::timeout(IDLE_TIMEOUT, resp.chunk()) => c,
            _ = cancel.cancelled() => return Ok(true),
        };
        let bytes = match chunk {
            Err(_) => return Err(HubError::Timeout),
            Ok(Err(e)) => return Err(classify_transport(&e)),
            Ok(Ok(None)) => return Ok(got_snapshot),
            Ok(Ok(Some(b))) => b,
        };
        let text_bytes = decoder.decode(&bytes)?;
        for text in splitter.push(&text_bytes) {
            let Some(frame) = parse_frame(&text) else {
                continue;
            };
            match frame.event.as_str() {
                "snapshot" | "stats" => match serde_json::from_str::<StatsData>(&frame.data) {
                    Ok(StatsData { stats: Some(stats) }) => {
                        got_snapshot = true;
                        *cache = Some(stats.clone());
                        (sink)(StreamEvent::Stats(Arc::new(stats)));
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!(error = %e, "hub stream frame is not valid stats"),
                },
                "freshness" => {
                    let (Some(current), Ok(FreshnessData { stats: Some(fresh) })) = (
                        cache.as_ref(),
                        serde_json::from_str::<FreshnessData>(&frame.data),
                    ) else {
                        continue;
                    };
                    let next = apply_freshness(current, &fresh);
                    *cache = Some(next.clone());
                    (sink)(StreamEvent::Stats(Arc::new(next)));
                }
                _ => {}
            }
        }
        if splitter.pending() > MAX_FRAME_BYTES {
            return Err(HubError::BadResponse("stream frame too large".into()));
        }
    }
}

fn jittered(base: Duration) -> Duration {
    // ±20%：大量裝置在 hub 重啟後不要同一秒湧回來。
    let seed = uuid::Uuid::new_v4().as_u128();
    let spread = base.as_millis() as u64 / 5;
    let offset = if spread == 0 {
        0
    } else {
        (seed % (2 * spread as u128 + 1)) as u64
    };
    Duration::from_millis(base.as_millis() as u64 - spread + offset)
}

/// 背景連線；`cancel` 後結束。只在設定了 hub 時呼叫。
pub fn spawn(client: HubClient, sink: StreamSink, cancel: CancellationToken) -> JoinHandle<()> {
    tokio::spawn(async move {
        // 串流不能有整體逾時（連線本來就不會結束）；閒置逾時在 read_stream 裡。
        // no_gzip：gzip 由 BodyDecoder 自己解（見檔頭）。
        let http = match reqwest::Client::builder()
            .user_agent(format!(
                "token-monitor-tauri/{}",
                crate::baked::AGENT_VERSION
            ))
            .connect_timeout(Duration::from_secs(10))
            .no_gzip()
            .build()
        {
            Ok(h) => h,
            Err(e) => {
                tracing::error!(error = %e, "cannot build the hub stream client");
                return;
            }
        };
        let mut cache: Option<HubStats> = None;
        let mut backoff = BACKOFF_MIN;
        loop {
            if cancel.is_cancelled() {
                break;
            }
            (sink)(StreamEvent::State {
                state: if cache.is_some() {
                    StreamState::Reconnecting
                } else {
                    StreamState::Connecting
                },
                error: None,
            });
            let wait = match read_stream(&http, &client, &sink, &mut cache, &cancel).await {
                Ok(_) if cancel.is_cancelled() => break,
                Ok(true) => {
                    backoff = BACKOFF_MIN;
                    jittered(BACKOFF_MIN)
                }
                Ok(false) => {
                    let w = jittered(backoff);
                    backoff = (backoff * 2).min(BACKOFF_MAX);
                    w
                }
                Err(HubError::Unauthorized { status }) => {
                    tracing::warn!(status, "hub stream unauthorized");
                    (sink)(StreamEvent::State {
                        state: StreamState::Unauthorized,
                        error: Some(HubError::Unauthorized { status }.message()),
                    });
                    UNAUTHORIZED_BACKOFF
                }
                Err(e) => {
                    tracing::info!(error = %e, "hub stream disconnected");
                    (sink)(StreamEvent::State {
                        state: StreamState::Reconnecting,
                        error: Some(e.message()),
                    });
                    let w = jittered(backoff);
                    backoff = (backoff * 2).min(BACKOFF_MAX);
                    w
                }
            };
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = cancel.cancelled() => break,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn frames_split_across_chunks_and_skip_comments() {
        let mut s = FrameSplitter::default();
        assert!(s.push(b": hb\n\nevent: snap").len() == 1);
        let frames = s.push(b"shot\ndata: {\"a\":\ndata: 1}\n\n");
        assert_eq!(frames.len(), 1);
        let f = parse_frame(&frames[0]).unwrap();
        assert_eq!(f.event, "snapshot");
        assert_eq!(f.data, "{\"a\":\n1}");
        assert!(parse_frame(": hb").is_none(), "a heartbeat carries no data");
    }

    #[test]
    fn freshness_only_moves_timestamps() {
        let stats = HubStats {
            updated_at: Some("t0".into()),
            stale_after_ms: Some(600_000.0),
            devices: vec![HubDevice {
                device_id: "a".into(),
                hostname: "A".into(),
                stale: true,
                age_ms: Some(9e6),
                periods: SlimPeriods {
                    today: SlimPeriod {
                        total_tokens: 42.0,
                        ..SlimPeriod::default()
                    },
                    ..SlimPeriods::default()
                },
                ..HubDevice::default()
            }],
        };
        let fresh: FreshnessData = serde_json::from_str(
            r#"{"type":"freshness","stats":{"updatedAt":"t1","staleAfterMs":1200000,"devices":[{"deviceId":"a","receivedAt":"r1","ageMs":5,"stale":false},{"deviceId":"ghost","stale":true}]}}"#,
        )
        .unwrap();
        let next = apply_freshness(&stats, fresh.stats.as_ref().unwrap());
        assert_eq!(next.updated_at.as_deref(), Some("t1"));
        assert_eq!(next.stale_after_ms, Some(1_200_000.0));
        assert_eq!(next.devices.len(), 1, "freshness never adds devices");
        assert!(!next.devices[0].stale);
        assert_eq!(next.devices[0].received_at.as_deref(), Some("r1"));
        assert_eq!(next.devices[0].periods.today.total_tokens, 42.0);
    }

    #[test]
    fn slim_stats_ignore_the_heavy_parts() {
        let json = r#"{"updatedAt":"u","staleAfterMs":600000,"periods":{"today":{"sessions":{"x":{}}}},
            "devices":[{"deviceId":"d","hostname":"H","agentRuntime":"electron-widget","periods":{"today":{"totalTokens":10,"costUsd":0.5,"clients":{"claude":10},"sessions":{"s":{"totalTokens":10}},"projects":{}}},"limits":{"providers":[]}}]}"#;
        let stats: HubStats = serde_json::from_str(json).unwrap();
        assert_eq!(stats.devices[0].periods.today.clients["claude"], 10.0);
        assert_eq!(stats.devices[0].agent_runtime, "electron-widget");
    }

    #[test]
    fn period_windows_keep_the_day_key_and_time_zone() {
        let json = r#"{"devices":[{"deviceId":"d","periodWindows":{"timeZone":"Asia/Taipei",
            "today":{"key":"2026-09-24","endsAt":"2026-09-24T16:00:00.000Z"},
            "month":{"key":"2026-09","endsAt":"2026-09-30T16:00:00.000Z"}}},{"deviceId":"old"}]}"#;
        let stats: HubStats = serde_json::from_str(json).unwrap();
        let windows = stats.devices[0].period_windows.as_ref().unwrap();
        let today = windows.today.as_ref().unwrap();
        assert_eq!(today.key.as_deref(), Some("2026-09-24"));
        assert_eq!(today.ends_at.as_deref(), Some("2026-09-24T16:00:00.000Z"));
        assert_eq!(
            windows.month.as_ref().unwrap().key.as_deref(),
            Some("2026-09")
        );
        assert_eq!(windows.time_zone.as_deref(), Some("Asia/Taipei"));
        assert!(
            stats.devices[1].period_windows.is_none(),
            "an older record without windows still parses"
        );
    }

    /// 最小的 SSE 伺服器：先回 snapshot，再送一個 freshness，最後關連線。
    async fn serve_once(listener: tokio::net::TcpListener, auth_ok: bool) {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 4096];
        let n = sock.read(&mut buf).await.unwrap();
        let req = String::from_utf8_lossy(&buf[..n]).to_lowercase();
        assert!(req.contains("x-token-monitor-stream: 2"));
        assert!(req.contains("authorization: bearer s3cret"));
        if !auth_ok {
            sock.write_all(b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n")
                .await
                .unwrap();
            return;
        }
        let body = concat!(
            ": hb\n\n",
            "event: snapshot\ndata: {\"type\":\"snapshot\",\"stats\":{\"updatedAt\":\"u1\",\"staleAfterMs\":600000,\"devices\":[{\"deviceId\":\"d1\",\"hostname\":\"H1\",\"stale\":true,\"periods\":{\"today\":{\"totalTokens\":5}}}]}}\n\n",
            "event: freshness\ndata: {\"type\":\"freshness\",\"stats\":{\"updatedAt\":\"u2\",\"devices\":[{\"deviceId\":\"d1\",\"stale\":false,\"ageMs\":1}]}}\n\n",
        );
        let head =
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";
        sock.write_all(head.as_bytes()).await.unwrap();
        sock.write_all(body.as_bytes()).await.unwrap();
        sock.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn reads_snapshot_then_freshness_from_a_live_socket() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(serve_once(listener, true));
        let client = HubClient::new(&format!("http://{addr}"), Some("s3cret".into())).unwrap();
        let got = Arc::new(std::sync::Mutex::new(Vec::new()));
        let g = got.clone();
        let sink: StreamSink = Arc::new(move |e| g.lock().unwrap().push(e));
        let http = reqwest::Client::new();
        let mut cache = None;
        let ok = read_stream(&http, &client, &sink, &mut cache, &CancellationToken::new())
            .await
            .unwrap();
        server.await.unwrap();
        assert!(ok, "EOF after a snapshot is a clean end");
        let events = got.lock().unwrap();
        let stats: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::Stats(s) => Some(s.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(stats.len(), 2);
        assert!(stats[0].devices[0].stale);
        assert!(!stats[1].devices[0].stale);
        assert_eq!(stats[1].updated_at.as_deref(), Some("u2"));
        assert_eq!(stats[1].devices[0].periods.today.total_tokens, 5.0);
    }

    #[tokio::test]
    async fn unauthorized_is_reported_as_such() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(serve_once(listener, false));
        let client = HubClient::new(&format!("http://{addr}"), Some("s3cret".into())).unwrap();
        let sink: StreamSink = Arc::new(|_| {});
        let err = read_stream(
            &reqwest::Client::new(),
            &client,
            &sink,
            &mut None,
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        server.await.unwrap();
        assert!(matches!(err, HubError::Unauthorized { status: 401 }));
    }

    fn gzip_member(text: &str) -> Vec<u8> {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(text.as_bytes()).unwrap();
        enc.finish().unwrap()
    }

    /// overlay 的 hub/stream.js：接受 gzip 的連線，每個 frame 各自是一個完整的 gzip member。
    #[tokio::test]
    async fn gzip_members_are_decoded_one_frame_at_a_time() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = sock.read(&mut buf).await.unwrap();
            assert!(String::from_utf8_lossy(&buf[..n])
                .to_lowercase()
                .contains("accept-encoding: gzip"));
            let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-encoding: gzip\r\ntransfer-encoding: chunked\r\n\r\n";
            sock.write_all(head.as_bytes()).await.unwrap();
            let chunk = |bytes: Vec<u8>| {
                let mut out = format!("{:x}\r\n", bytes.len()).into_bytes();
                out.extend(bytes);
                out.extend(b"\r\n");
                out
            };
            let snapshot = gzip_member("event: snapshot\ndata: {\"stats\":{\"updatedAt\":\"u1\",\"devices\":[{\"deviceId\":\"d1\",\"stale\":true}]}}\n\n");
            sock.write_all(&chunk(snapshot)).await.unwrap();
            sock.flush().await.unwrap();
            // 第二個 member 要等 client 已經處理完第一個才送：驗證解壓不是等到連線結束才吐資料。
            release_rx.await.unwrap();
            let fresh = gzip_member("event: freshness\ndata: {\"stats\":{\"updatedAt\":\"u2\",\"devices\":[{\"deviceId\":\"d1\",\"stale\":false}]}}\n\n");
            sock.write_all(&chunk(fresh)).await.unwrap();
            sock.write_all(b"0\r\n\r\n").await.unwrap();
            sock.shutdown().await.unwrap();
        });
        let client = HubClient::new(&format!("http://{addr}"), None).unwrap();
        let http = reqwest::Client::builder().no_gzip().build().unwrap();
        let release = std::sync::Mutex::new(Some(release_tx));
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let s = seen.clone();
        let sink: StreamSink = Arc::new(move |e| {
            if let StreamEvent::Stats(stats) = e {
                s.lock().unwrap().push(stats.devices[0].stale);
                if let Some(tx) = release.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
        });
        let ok = read_stream(&http, &client, &sink, &mut None, &CancellationToken::new())
            .await
            .unwrap();
        server.await.unwrap();
        assert!(ok);
        assert_eq!(
            *seen.lock().unwrap(),
            vec![true, false],
            "both gzip members were decoded"
        );
    }

    #[test]
    fn jitter_stays_within_twenty_percent() {
        for _ in 0..200 {
            let d = jittered(Duration::from_secs(10));
            assert!(
                d >= Duration::from_secs(8) && d <= Duration::from_secs(12),
                "{d:?}"
            );
        }
    }
}
