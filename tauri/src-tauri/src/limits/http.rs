//! 額度 provider 共用的 HTTP：狀態碼 → provider 狀態（上游 src/shared/limits/providerHelpers.js
//! `fetchJson` 與 `providerStatusFromError`）。

use std::time::Duration;

use serde_json::Value;

use crate::wire::ProviderStatus;

/// 一次 probe 失敗的原因。`message` 只進 log，不上 wire（上游同樣不送 error 文字）。
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeError {
    pub status: ProviderStatus,
    pub message: String,
    pub http_status: Option<u16>,
    /// hub 端要求的等待（`Retry-After`），最多一小時。
    pub retry_after: Option<Duration>,
}

impl ProbeError {
    pub fn new(status: ProviderStatus, message: impl Into<String>) -> ProbeError {
        ProbeError {
            status,
            message: message.into(),
            http_status: None,
            retry_after: None,
        }
    }
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.status, self.message)
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct FetchOptions {
    /// Codex：403 也當 unauthorized（除非是 Cloudflare 的挑戰頁）。
    pub forbidden_is_unauthorized: bool,
}

/// 上游 retryPolicy.js：秒數（可有小數）或 HTTP 日期，夾在 0–1 小時。
pub fn parse_retry_after(value: &str, now: chrono::DateTime<chrono::Utc>) -> Option<Duration> {
    let v = value.trim();
    let ms = if let Ok(secs) = v.parse::<f64>() {
        (secs * 1000.0).round() as i64
    } else {
        let when = chrono::DateTime::parse_from_rfc2822(v).ok()?;
        (when.with_timezone(&chrono::Utc) - now).num_milliseconds()
    };
    let ms = ms.clamp(0, 3_600_000);
    (ms > 0).then(|| Duration::from_millis(ms as u64))
}

/// HTTP 狀態 → provider 狀態。
pub fn status_for(code: u16, cf_challenge: bool, opts: FetchOptions) -> ProviderStatus {
    match code {
        401 => ProviderStatus::Unauthorized,
        403 if opts.forbidden_is_unauthorized && !cf_challenge => ProviderStatus::Unauthorized,
        429 => ProviderStatus::SourceRateLimited,
        _ => ProviderStatus::Unavailable,
    }
}

/// 送出請求並取回 JSON。網路錯誤、逾時與非 2xx 都轉成 `ProbeError`。
pub async fn fetch_json(
    req: reqwest::RequestBuilder,
    label: &str,
    opts: FetchOptions,
) -> Result<Value, ProbeError> {
    let resp = req.send().await.map_err(|e| {
        let what = if e.is_timeout() {
            "timed out"
        } else {
            "request failed"
        };
        ProbeError::new(ProviderStatus::Unavailable, format!("{label} {what}: {e}"))
    })?;
    let code = resp.status().as_u16();
    if !resp.status().is_success() {
        let headers = resp.headers();
        let cf_challenge = headers
            .get("cf-mitigated")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("challenge"));
        let retry_after = headers
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| parse_retry_after(v, chrono::Utc::now()));
        return Err(ProbeError {
            status: status_for(code, cf_challenge, opts),
            message: format!("{label} HTTP {code}"),
            http_status: Some(code),
            retry_after,
        });
    }
    resp.json::<Value>().await.map_err(|e| {
        ProbeError::new(
            ProviderStatus::Unavailable,
            format!("{label} invalid JSON: {e}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_follow_upstream() {
        let plain = FetchOptions::default();
        let codex = FetchOptions {
            forbidden_is_unauthorized: true,
        };
        assert_eq!(status_for(401, false, plain), ProviderStatus::Unauthorized);
        assert_eq!(
            status_for(403, false, plain),
            ProviderStatus::Unavailable,
            "Claude OAuth: 403 is not a login problem"
        );
        assert_eq!(status_for(403, false, codex), ProviderStatus::Unauthorized);
        assert_eq!(
            status_for(403, true, codex),
            ProviderStatus::Unavailable,
            "Cloudflare challenge"
        );
        assert_eq!(
            status_for(429, false, plain),
            ProviderStatus::SourceRateLimited
        );
        assert_eq!(status_for(503, false, codex), ProviderStatus::Unavailable);
    }

    #[test]
    fn retry_after_is_bounded() {
        let now = chrono::Utc::now();
        assert_eq!(parse_retry_after("30", now), Some(Duration::from_secs(30)));
        assert_eq!(
            parse_retry_after("1.5", now),
            Some(Duration::from_millis(1500))
        );
        assert_eq!(
            parse_retry_after("999999", now),
            Some(Duration::from_secs(3600))
        );
        assert_eq!(parse_retry_after("0", now), None);
        assert_eq!(parse_retry_after("soon", now), None);
    }
}
