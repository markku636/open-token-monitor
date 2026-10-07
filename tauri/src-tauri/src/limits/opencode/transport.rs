//! OpenCode 探測用的 HTTP 抽象與幾個 JavaScript 語意的小工具。
//!
//! 所有 opencode.ai 的請求都經過 `Transport`：正式探測用 reqwest（`ReqwestTransport`），
//! `tm-agent limits --replay` 與單元測試用固定的回應（`FixtureTransport`）。這樣重放走的是與正式
//! 探測完全相同的程式路徑（路由、狀態碼、解析），`tests/compat` 才能拿同一份回應與上游逐欄比對。

use std::future::Future;
use std::time::Duration;

use serde_json::Value;

use super::api::GO_USAGE_URL;
use super::web::{SUBSCRIPTION_SERVER_ID, WORKSPACES_SERVER_ID};

#[derive(Debug, Clone, PartialEq)]
pub struct HttpRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Option<String>,
}

impl HttpRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct HttpResponse {
    pub status: u16,
    pub text: String,
    /// `Retry-After`（只有 429 用得到，最多一小時）。
    pub retry_after: Option<Duration>,
}

/// 網路層。`Err` 是連不上（上游 fetch 丟例外的情況），只帶給 log 的說明。
pub trait Transport: Sync {
    fn send(&self, req: HttpRequest) -> impl Future<Output = Result<HttpResponse, String>> + Send;
}

/// 正式探測：共用 limits runtime 的 reqwest client，每個請求 15 秒逾時（上游 `PROFILE_TIMEOUT_MS`）。
pub struct ReqwestTransport<'a> {
    pub http: &'a reqwest::Client,
    pub timeout: Duration,
}

impl Transport for ReqwestTransport<'_> {
    async fn send(&self, req: HttpRequest) -> Result<HttpResponse, String> {
        let mut builder = match req.method {
            "POST" => self.http.post(&req.url),
            _ => self.http.get(&req.url),
        };
        for (k, v) in &req.headers {
            builder = builder.header(*k, v);
        }
        if let Some(body) = req.body {
            builder = builder.body(body);
        }
        let resp = builder
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| format!("opencode request failed: {e}"))?;
        let status = resp.status().as_u16();
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| crate::limits::http::parse_retry_after(v, chrono::Utc::now()));
        let text = resp
            .text()
            .await
            .map_err(|e| format!("opencode response failed: {e}"))?;
        Ok(HttpResponse {
            status,
            text,
            retry_after,
        })
    }
}

/// 重放用的回應表：`responses` 以路由名稱為 key，值是 `{ status, text | json, throw }`。
/// 路由規則與 `tests/compat/wire-compat.test.mjs` 餵給上游的假 fetch 相同：
/// - `goApi`：`https://opencode.ai/zen/go/v1/usage`
/// - `workspaces:GET` / `workspaces:POST`、`subscription:GET` / `subscription:POST`：依 `X-Server-Id`
/// - `goPage`：`https://opencode.ai/workspace/<id>/go`
///
/// 表裡沒有的路由回 404、空內容。
pub struct FixtureTransport {
    pub responses: serde_json::Map<String, Value>,
}

pub fn route_of(req: &HttpRequest) -> String {
    if req.url == GO_USAGE_URL {
        return "goApi".into();
    }
    match req.header("X-Server-Id") {
        Some(id) if id == WORKSPACES_SERVER_ID => return format!("workspaces:{}", req.method),
        Some(id) if id == SUBSCRIPTION_SERVER_ID => return format!("subscription:{}", req.method),
        _ => {}
    }
    if req.url.ends_with("/go") {
        return "goPage".into();
    }
    format!("{} {}", req.method, req.url)
}

impl Transport for FixtureTransport {
    async fn send(&self, req: HttpRequest) -> Result<HttpResponse, String> {
        let Some(r) = self.responses.get(&route_of(&req)) else {
            return Ok(HttpResponse {
                status: 404,
                ..HttpResponse::default()
            });
        };
        if r.get("throw").and_then(Value::as_bool) == Some(true) {
            return Err("fixture network error".into());
        }
        let text = match (r.get("text"), r.get("json")) {
            (Some(Value::String(t)), _) => t.clone(),
            (_, Some(v)) => v.to_string(),
            _ => String::new(),
        };
        Ok(HttpResponse {
            status: r.get("status").and_then(Value::as_u64).unwrap_or(200) as u16,
            text,
            retry_after: None,
        })
    }
}

// ---- JavaScript 語意 -------------------------------------------------------------------

/// JS 正規表示式的 `\s`（與 Rust 的 `char::is_whitespace` 差在 U+0085 與 U+FEFF）。
pub fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// 字串的 `Number(s)`：空字串是 0、`0x` / `0o` / `0b` 前綴、`Infinity`；其他不是數字的是 NaN。
pub fn js_string_to_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |acc, c| {
                acc * radix as f64 + c.to_digit(radix).unwrap() as f64
            });
        }
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // Rust 另外接受 `inf`、`nan` 與 `_` 以外的寫法 JS 都不接受。
    let ok = t
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'));
    if !ok {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(value)`：null 是 0、布林是 0／1、陣列先轉字串、物件是 NaN。`None` 是 undefined（NaN）。
pub fn js_to_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_string_to_number(s),
        Some(v @ Value::Array(_)) => js_string_to_number(&crate::usage::js::to_js_string(v)),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// 上游 providerHelpers.js `cleanSecret`：只接受字串，去空白與一層引號。
pub fn clean_secret(v: &str) -> String {
    let raw = js_trim(v);
    let quoted = (raw.starts_with('"') && raw.ends_with('"'))
        || (raw.starts_with('\'') && raw.ends_with('\''));
    if quoted {
        let inner = if raw.len() >= 2 {
            &raw[1..raw.len() - 1]
        } else {
            ""
        };
        return js_trim(inner).to_string();
    }
    raw.to_string()
}

/// `Math.round(v * 10) / 10`（v 已夾在 0 以上，JS 的 Math.round 與 f64::round 一致）。
pub fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

pub fn clamp_pct(v: f64) -> f64 {
    v.clamp(0.0, 100.0)
}

/// `new Date(ms).toISOString()`。超出 JS 日期範圍時上游會丟 RangeError，這裡回 `None`。
/// 年份在 0–9999 以外時用 JS 的擴充格式（`+010000-…`）；chrono 到 ±262143 年為止，再往外也回 `None`。
pub fn js_iso(ms: f64) -> Option<String> {
    use chrono::Datelike;
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return None;
    }
    let dt = chrono::DateTime::from_timestamp_millis(ms.trunc() as i64)?;
    let rest = dt.format("-%m-%dT%H:%M:%S%.3fZ");
    let year = dt.year();
    Some(if (0..=9999).contains(&year) {
        format!("{year:04}{rest}")
    } else {
        format!(
            "{}{:06}{rest}",
            if year < 0 { '-' } else { '+' },
            year.unsigned_abs()
        )
    })
}

/// `Date.parse(text)` 的毫秒；解析不了是 `None`（這裡只認 ISO 與日期的寫法，與 normalize.rs 相同）。
pub fn js_date_parse(text: &str) -> Option<f64> {
    let iso = crate::limits::normalize::iso_from_text(text)?;
    chrono::DateTime::parse_from_rfc3339(&iso)
        .ok()
        .map(|d| d.timestamp_millis() as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_follow_js() {
        assert_eq!(js_string_to_number(" 12.5 "), 12.5);
        assert_eq!(js_string_to_number(""), 0.0);
        assert_eq!(js_string_to_number("0x1F"), 31.0);
        assert!(js_string_to_number("12abc").is_nan());
        assert!(js_string_to_number("inf").is_nan());
        assert!(js_string_to_number("Infinity").is_infinite());
        assert_eq!(js_to_number(Some(&json!(null))), 0.0);
        assert_eq!(js_to_number(Some(&json!(true))), 1.0);
        assert_eq!(js_to_number(Some(&json!([7]))), 7.0);
        assert!(js_to_number(Some(&json!({}))).is_nan());
        assert!(js_to_number(None).is_nan());
    }

    #[test]
    fn secrets_lose_one_layer_of_quotes() {
        assert_eq!(clean_secret("  'sk-abc' "), "sk-abc");
        assert_eq!(clean_secret("\" sk \""), "sk");
        assert_eq!(clean_secret("\""), "");
        assert_eq!(clean_secret("sk"), "sk");
    }

    #[test]
    fn iso_matches_to_iso_string() {
        assert_eq!(
            js_iso(1_767_225_600_000.9).as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
        assert_eq!(
            js_iso(253_402_300_800_000.0).as_deref(),
            Some("+010000-01-01T00:00:00.000Z")
        );
        assert_eq!(js_iso(8.64e15 + 1.0), None);
    }
}
