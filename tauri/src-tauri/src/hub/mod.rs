//! 公司 hub 的 client：上傳（`POST /api/ingest`）、健康檢查，以及全公司範圍要讀的每日歷史
//! （`/api/history`、`device_daily.rs` 的 `/api/custom/device-daily`）。
//!
//! hub 端是上游 `src/hub/server.js` 加上 monorepo 根目錄的 `hub/` overlay；client 角色的 secret 只能
//! ingest 與讀取（overlay 的 hub/access.js）。TLS 用 rustls + Windows 憑證庫（reqwest
//! `rustls-tls-native-roots`），企業內部 CA 簽的憑證不需額外設定。

pub mod device_daily;
pub mod payload;
pub mod stream;

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::error::truncate;
use crate::wire::DeviceRecord;
use payload::{serialize_sync_payload, PayloadOmissions, PayloadOptions};

pub const RESPONSE_HEADER: &str = "x-token-monitor-response";
pub const RESPONSE_MINIMAL: &str = "minimal";

#[derive(Debug, Clone, thiserror::Error, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HubError {
    #[error("unauthorized (HTTP {status})")]
    Unauthorized { status: u16 },
    #[error("not found (HTTP 404)")]
    NotFound,
    #[error("payload too large (HTTP 413)")]
    PayloadTooLarge,
    #[error("rate limited (HTTP 429)")]
    RateLimited { retry_after_secs: Option<u64> },
    #[error("server error (HTTP {status})")]
    Server { status: u16 },
    #[error("bad request (HTTP {status}): {body}")]
    BadRequest { status: u16, body: String },
    #[error("unexpected HTTP {status}: {body}")]
    Unexpected { status: u16, body: String },
    #[error("DNS lookup failed: {0}")]
    Dns(String),
    #[error("TLS failure: {0}")]
    Tls(String),
    #[error("connection failed: {0}")]
    Connect(String),
    #[error("timed out")]
    Timeout,
    #[error("invalid response: {0}")]
    BadResponse(String),
    #[error("transport error: {0}")]
    Transport(String),
    #[error("invalid hub URL: {0}")]
    InvalidUrl(String),
}

impl HubError {
    pub fn code(&self) -> &'static str {
        match self {
            HubError::Unauthorized { .. } => "ERR_HUB_UNAUTHORIZED",
            HubError::NotFound => "ERR_HUB_NOT_FOUND",
            HubError::PayloadTooLarge => "ERR_HUB_PAYLOAD_TOO_LARGE",
            HubError::RateLimited { .. } => "ERR_HUB_RATE_LIMITED",
            HubError::Server { .. } => "ERR_HUB_SERVER",
            HubError::BadRequest { .. } => "ERR_HUB_BAD_REQUEST",
            HubError::Unexpected { .. } => "ERR_HUB_UNEXPECTED",
            HubError::Dns(_) => "ERR_HUB_DNS",
            HubError::Tls(_) => "ERR_HUB_TLS",
            HubError::Connect(_) => "ERR_HUB_CONNECT",
            HubError::Timeout => "ERR_HUB_TIMEOUT",
            HubError::BadResponse(_) => "ERR_HUB_BAD_RESPONSE",
            HubError::Transport(_) => "ERR_HUB_TRANSPORT",
            HubError::InvalidUrl(_) => "ERR_HUB_INVALID_URL",
        }
    }

    pub fn message(&self) -> String {
        match self {
            HubError::Unauthorized { .. } => {
                "hub 拒絕了連線金鑰（可能已輪替，請更新 secret）".into()
            }
            HubError::NotFound => "hub 網址不正確（404）".into(),
            HubError::PayloadTooLarge => "上傳資料超過 hub 的大小上限".into(),
            HubError::RateLimited { .. } => "hub 暫時限流，稍後重試".into(),
            HubError::Server { status } => format!("hub 內部錯誤（HTTP {status}）"),
            HubError::BadRequest { body, .. } => format!("hub 拒絕了資料：{}", truncate(body, 200)),
            HubError::Unexpected { status, .. } => format!("hub 回應 HTTP {status}"),
            HubError::Dns(_) => "找不到 hub 主機（DNS）".into(),
            HubError::Tls(e) => format!("hub 的 TLS 憑證不受信任：{}", truncate(e, 200)),
            HubError::Connect(_) => "無法連線到 hub".into(),
            HubError::Timeout => "連線 hub 逾時".into(),
            HubError::BadResponse(e) => format!("hub 回應格式不正確：{}", truncate(e, 200)),
            HubError::Transport(e) => format!("連線 hub 失敗：{}", truncate(e, 200)),
            HubError::InvalidUrl(u) => format!("hub 網址不正確：{u}"),
        }
    }

    /// 暫時性錯誤才值得重試；401 / 400 / 413 重試只會得到同樣的答案。
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            HubError::RateLimited { .. }
                | HubError::Server { .. }
                | HubError::Dns(_)
                | HubError::Connect(_)
                | HubError::Timeout
                | HubError::Transport(_)
        )
    }
}

fn error_chain(e: &dyn std::error::Error) -> String {
    let mut parts = vec![e.to_string()];
    let mut source = e.source();
    while let Some(s) = source {
        parts.push(s.to_string());
        source = s.source();
    }
    parts.join(": ")
}

pub fn classify_transport(e: &reqwest::Error) -> HubError {
    let chain = error_chain(e);
    let lower = chain.to_lowercase();
    if e.is_timeout() {
        HubError::Timeout
    } else if lower.contains("certificate")
        || lower.contains("unknownissuer")
        || lower.contains("tls")
    {
        HubError::Tls(chain)
    } else if lower.contains("dns") || lower.contains("resolve") || lower.contains("no such host") {
        HubError::Dns(chain)
    } else if e.is_connect() {
        HubError::Connect(chain)
    } else {
        HubError::Transport(chain)
    }
}

fn classify_status(status: u16, headers: &reqwest::header::HeaderMap, body: &str) -> HubError {
    match status {
        401 | 403 => HubError::Unauthorized { status },
        404 => HubError::NotFound,
        413 => HubError::PayloadTooLarge,
        429 => HubError::RateLimited {
            retry_after_secs: headers
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse().ok()),
        },
        500..=599 => HubError::Server { status },
        400 => HubError::BadRequest {
            status,
            body: truncate(body, 500),
        },
        _ => HubError::Unexpected {
            status,
            body: truncate(body, 500),
        },
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestOutcome {
    pub bytes: usize,
    pub retried: bool,
    pub omissions: PayloadOmissions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthInfo {
    pub status: u16,
    pub body: Value,
}

#[derive(Clone)]
pub struct HubClient {
    base: String,
    secret: Option<String>,
    http: reqwest::Client,
}

impl std::fmt::Debug for HubClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // secret 絕不進 Debug / log。
        f.debug_struct("HubClient")
            .field("base", &self.base)
            .field("secret", &self.secret.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl HubClient {
    pub fn new(base: &str, secret: Option<String>) -> Result<Self, HubError> {
        let base = base.trim().trim_end_matches('/').to_string();
        let parsed = url::Url::parse(&base).map_err(|_| HubError::InvalidUrl(base.clone()))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(HubError::InvalidUrl(base));
        }
        let http = reqwest::Client::builder()
            .user_agent(format!(
                "token-monitor-tauri/{}",
                crate::baked::AGENT_VERSION
            ))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| HubError::Transport(e.to_string()))?;
        Ok(HubClient {
            base,
            secret: secret.filter(|s| !s.trim().is_empty()),
            http,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    /// 串流（hub/stream.rs）用同一把 client secret；不外露給 log 或前端。
    pub(crate) fn secret(&self) -> Option<&str> {
        self.secret.as_deref()
    }

    pub fn has_secret(&self) -> bool {
        self.secret.is_some()
    }

    fn authorized(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.secret {
            Some(s) => req.bearer_auth(s),
            None => req,
        }
    }

    /// `GET /api/health`（不需認證）。
    pub async fn health(&self) -> Result<HealthInfo, HubError> {
        let resp = self
            .http
            .get(format!("{}/api/health", self.base))
            .send()
            .await
            .map_err(|e| classify_transport(&e))?;
        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        let text = resp.text().await.map_err(|e| classify_transport(&e))?;
        if !(200..300).contains(&status) {
            return Err(classify_status(status, &headers, &text));
        }
        let body = serde_json::from_str(&text).map_err(|e| HubError::BadResponse(e.to_string()))?;
        Ok(HealthInfo { status, body })
    }

    /// `GET /api/history`：hub 把所有有上傳每日歷史的裝置合併成一份（上游 `aggregateHistory`）。
    /// hub 沒有 `/api/custom/device-daily` 時，全公司分頁的本星期／最近 7、30 日退回用它。
    pub async fn get_history(&self) -> Result<serde_json::Value, HubError> {
        let resp = self
            .authorized(self.http.get(format!("{}/api/history", self.base)))
            .send()
            .await
            .map_err(|e| classify_transport(&e))?;
        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        let text = resp.text().await.map_err(|e| classify_transport(&e))?;
        if !(200..300).contains(&status) {
            return Err(classify_status(status, &headers, &text));
        }
        serde_json::from_str(&text).map_err(|e| HubError::BadResponse(e.to_string()))
    }

    async fn post_body(
        &self,
        body: Vec<u8>,
    ) -> Result<(u16, reqwest::header::HeaderMap, String), HubError> {
        let resp = self
            .authorized(self.http.post(format!("{}/api/ingest", self.base)))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(RESPONSE_HEADER, RESPONSE_MINIMAL)
            .body(body)
            .send()
            .await
            .map_err(|e| classify_transport(&e))?;
        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        let text = resp.text().await.unwrap_or_default();
        Ok((status, headers, text))
    }

    /// 上傳一筆裝置記錄（上游 `postSyncPayload`）：先照預算縮減；hub 仍回 413 時，
    /// 以「history 不帶 token 組成、不帶 allTime 專案」重送一次（內容確實不同才送）。
    pub async fn post_record(&self, record: &DeviceRecord) -> Result<IngestOutcome, HubError> {
        let summary =
            serde_json::to_value(record).map_err(|e| HubError::BadResponse(e.to_string()))?;
        let mut serialized = serialize_sync_payload(&summary, PayloadOptions::default());
        let (mut status, mut headers, mut text) = self.post_body(serialized.body.clone()).await?;
        let mut retried = false;
        if status == 413 {
            let reduced = serialize_sync_payload(
                &summary,
                PayloadOptions {
                    omit_all_time_projects: true,
                    omit_history_token_components: true,
                    ..Default::default()
                },
            );
            if reduced.body != serialized.body {
                tracing::warn!(
                    "hub rejected the payload (413); retrying once without history token components or all-time projects"
                );
                serialized = reduced;
                (status, headers, text) = self.post_body(serialized.body.clone()).await?;
                retried = true;
            }
        }
        if !(200..300).contains(&status) {
            return Err(classify_status(status, &headers, &text));
        }
        let parsed: Value =
            serde_json::from_str(&text).map_err(|e| HubError::BadResponse(e.to_string()))?;
        if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(HubError::BadResponse(truncate(&text, 200)));
        }
        Ok(IngestOutcome {
            bytes: serialized.body.len(),
            retried,
            omissions: serialized.omissions,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_urls_and_redacts_secret() {
        assert!(HubClient::new("ftp://x", None).is_err());
        assert!(HubClient::new("not a url", None).is_err());
        let c = HubClient::new("https://hub.example/", Some("topsecret".into())).unwrap();
        assert_eq!(c.base_url(), "https://hub.example");
        assert!(!format!("{c:?}").contains("topsecret"));
    }

    #[test]
    fn retryable_classification() {
        assert!(!HubError::Unauthorized { status: 401 }.is_retryable());
        assert!(HubError::Server { status: 503 }.is_retryable());
        assert!(!HubError::PayloadTooLarge.is_retryable());
        let h = reqwest::header::HeaderMap::new();
        assert!(matches!(
            classify_status(403, &h, ""),
            HubError::Unauthorized { status: 403 }
        ));
        assert!(matches!(
            classify_status(400, &h, "deviceId_required"),
            HubError::BadRequest { .. }
        ));
    }
}
