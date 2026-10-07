//! hub 的 `GET /api/custom/device-daily`（本 repo 根目錄的 hub 目前沒有這個路由）：
//! 各裝置最近 32 天的每日 token、成本、活躍時間與依工具／模型的 token 與成本，全公司的
//! 本星期／最近 7、30 日用它逐台推（ranges.rs `company_ranges`）。
//!
//! 上游 widget 抓 `/api/devices` 的完整 record（數百台時 18–54 MB、每次重新序列化）；這份由 hub
//! 每個串流時間窗算一次、數百台約 3 MB（gzip 後不到 1 MB），reqwest 的 `gzip` 自動解壓。
//! 沒有這個路由的 hub 對 client 金鑰回 403（`/api/custom/*` 不開放）或 404：兩者都當作
//! 不支援（`Ok(None)`），全公司的範圍退回 `/api/history` 的合併版。

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

use super::{classify_status, classify_transport, HubClient, HubError};
use crate::ranges::DeviceHistory;

/// 解壓後的上限：數百台約 3 MB，與串流的 frame 上限（hub/stream.rs）同樣留足餘裕，超過就不收。
pub const MAX_DEVICE_DAILY_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeviceDailyPayload {
    pub generated_at: Option<String>,
    pub window_start: Option<String>,
    pub devices: Vec<DeviceDaily>,
}

/// 一台裝置：`history_available` 是上游 `parseDeviceHistories` 的判斷；`history_has_usage` 看整份
/// 每日歷史（不只這 32 天），上游以它決定裝置有沒有參與用量。
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeviceDaily {
    pub device_id: String,
    pub history_available: bool,
    pub history_has_usage: bool,
    pub daily: Vec<Value>,
}

impl DeviceDailyPayload {
    /// 有可用每日歷史的裝置 → 以 deviceId 為鍵；沒有的裝置不在表裡（範圍裡標成沒有歷史）。
    pub fn histories(&self) -> HashMap<String, DeviceHistory> {
        self.devices
            .iter()
            .filter(|d| d.history_available && !d.device_id.is_empty())
            .map(|d| {
                (
                    d.device_id.clone(),
                    DeviceHistory::from_window(&d.daily, d.history_has_usage),
                )
            })
            .collect()
    }
}

impl HubClient {
    /// `GET /api/custom/device-daily`。`Ok(None)` = 這個 hub 不提供（403 / 404）。
    pub async fn get_device_daily(&self) -> Result<Option<DeviceDailyPayload>, HubError> {
        self.get_device_daily_within(MAX_DEVICE_DAILY_BYTES).await
    }

    async fn get_device_daily_within(
        &self,
        max_bytes: usize,
    ) -> Result<Option<DeviceDailyPayload>, HubError> {
        let mut resp = self
            .authorized(
                self.http
                    .get(format!("{}/api/custom/device-daily", self.base)),
            )
            .send()
            .await
            .map_err(|e| classify_transport(&e))?;
        let status = resp.status().as_u16();
        if status == 403 || status == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            let headers = resp.headers().clone();
            let text = resp.text().await.unwrap_or_default();
            return Err(classify_status(status, &headers, &text));
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| classify_transport(&e))? {
            if body.len() + chunk.len() > max_bytes {
                return Err(HubError::BadResponse("device-daily body too large".into()));
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body)
            .map(Some)
            .map_err(|e| HubError::BadResponse(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 本機的假 hub：收一個請求、回一個固定的回應，交回收到的請求內容。
    async fn serve(response: Vec<u8>) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap();
            sock.write_all(&response).await.unwrap();
            sock.shutdown().await.unwrap();
            String::from_utf8_lossy(&buf[..n]).to_lowercase()
        });
        (format!("http://{addr}"), server)
    }

    fn response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n{headers}\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(bytes).unwrap();
        enc.finish().unwrap()
    }

    #[tokio::test]
    async fn an_older_hub_is_unsupported_not_an_error() {
        for status in ["403 Forbidden", "404 Not Found"] {
            let (base, server) = serve(response(status, "", b"{\"error\":\"forbidden\"}")).await;
            let client = HubClient::new(&base, Some("s3cret".into())).unwrap();
            assert_eq!(client.get_device_daily().await.unwrap(), None, "{status}");
            let req = server.await.unwrap();
            assert!(req.starts_with("get /api/custom/device-daily "));
            assert!(req.contains("authorization: bearer s3cret"));
        }
        let (base, server) = serve(response("401 Unauthorized", "", b"{}")).await;
        let client = HubClient::new(&base, Some("wrong".into())).unwrap();
        assert!(matches!(
            client.get_device_daily().await,
            Err(HubError::Unauthorized { status: 401 })
        ));
        server.await.unwrap();
        let (base, server) = serve(response("503 Service Unavailable", "", b"")).await;
        let client = HubClient::new(&base, None).unwrap();
        assert!(matches!(
            client.get_device_daily().await,
            Err(HubError::Server { status: 503 })
        ));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn a_gzipped_answer_is_decoded_and_parsed() {
        let body = json!({
            "ok": true, "generatedAt": "2026-09-24T03:00:00.000Z", "windowStart": "2026-08-24", "windowDays": 32,
            "devices": [
                { "deviceId": "a", "historyAvailable": true, "historyHasUsage": true,
                  "daily": [{ "date": "2026-09-20", "tokens": 100, "cost": 1.0, "perClient": { "claude": { "tokens": 100, "cost": 1.0 } }, "perModel": {} }] },
                { "deviceId": "b", "historyAvailable": false, "historyHasUsage": false, "daily": [] },
                { "deviceId": "c", "historyAvailable": true, "historyHasUsage": true, "daily": [] }
            ]
        })
        .to_string();
        let (base, server) = serve(response(
            "200 OK",
            "content-type: application/json\r\ncontent-encoding: gzip\r\n",
            &gzip(body.as_bytes()),
        ))
        .await;
        let client = HubClient::new(&base, None).unwrap();
        let payload = client.get_device_daily().await.unwrap().unwrap();
        let req = server.await.unwrap();
        assert!(req.contains("accept-encoding: gzip"));
        assert_eq!(payload.window_start.as_deref(), Some("2026-08-24"));
        assert_eq!(payload.devices.len(), 3);
        let histories = payload.histories();
        let mut ids: Vec<&str> = histories.keys().map(String::as_str).collect();
        ids.sort_unstable();
        assert_eq!(ids, ["a", "c"], "b has no usable history");
        assert!(
            histories["c"].has_usage,
            "usage older than the window still counts"
        );
    }

    #[tokio::test]
    async fn an_oversized_body_is_refused() {
        // 上限以解壓後的位元組計：gzip 後很小的回應也不能撐爆記憶體。
        let body = format!("{{\"devices\":[],\"pad\":\"{}\"}}", " ".repeat(4096));
        let (base, server) = serve(response(
            "200 OK",
            "content-encoding: gzip\r\n",
            &gzip(body.as_bytes()),
        ))
        .await;
        let client = HubClient::new(&base, None).unwrap();
        let err = client.get_device_daily_within(1024).await.unwrap_err();
        assert!(
            matches!(err, HubError::BadResponse(ref m) if m.contains("too large")),
            "{err:?}"
        );
        server.await.unwrap();
        assert_eq!(MAX_DEVICE_DAILY_BYTES, 64 * 1024 * 1024);
    }
}
