//! GitHub Copilot 的額度（上游 src/shared/providers/copilot/{limits,deviceFlow}.js）。
//!
//! - token：設定頁以 GitHub device flow 登入取得（存 OS 認證管理員，`secrets::COPILOT_TOKEN`），
//!   或環境變數 `COPILOT_API_TOKEN` / `GITHUB_COPILOT_TOKEN`（上游 `copilotToken`）。
//! - `GET https://api.github.com/copilot_internal/user`：Premium requests 與 Chat 的剩餘比例、方案、
//!   重置日；`GET /user` 取 login 當 accountKey 的種子。企業版 GHE 以 `COPILOT_ENTERPRISE_HOST` 指定。
//! - device flow 的 client id 與 scope 與上游相同（Copilot 的公開 OAuth app，只要 `read:user`）。

use std::time::Duration;

use serde_json::{Map, Value};

use super::hash::hash_key;
use super::http::ProbeError;
use super::normalize::finish_provider;
use crate::wire::{LimitProvider, LimitWindow, ProviderStatus, WindowKind};

const DEFAULT_HOST: &str = "github.com";
const USER_AGENT: &str = "GitHubCopilotChat/0.26.7";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
pub const DEVICE_CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
pub const DEVICE_SCOPE: &str = "read:user";

/// 上游 `cleanSecret`：去掉前後空白與一層引號。
fn clean_secret(v: &str) -> String {
    let t = v.trim();
    let unquoted = if t.len() >= 2
        && ((t.starts_with('"') && t.ends_with('"')) || (t.starts_with('\'') && t.ends_with('\'')))
    {
        &t[1..t.len() - 1]
    } else {
        t
    };
    unquoted.trim().to_string()
}

/// 已登入的 token：認證管理員優先，其次環境變數。
pub fn token() -> Option<String> {
    crate::secrets::get(crate::secrets::COPILOT_TOKEN).or_else(|| {
        ["COPILOT_API_TOKEN", "GITHUB_COPILOT_TOKEN"]
            .iter()
            .find_map(|k| {
                std::env::var(k)
                    .ok()
                    .map(|v| clean_secret(&v))
                    .filter(|v| !v.is_empty())
            })
    })
}

/// 上游 `normalizedEnterpriseHost`。
pub fn normalized_host(raw: &str) -> String {
    let host = raw.trim();
    if host.is_empty() {
        return DEFAULT_HOST.into();
    }
    let with_scheme = if host.contains("://") {
        host.to_string()
    } else {
        format!("https://{host}")
    };
    if let Ok(url) = url::Url::parse(&with_scheme) {
        if let Some(h) = url.host_str() {
            return match url.port() {
                Some(p) => format!("{h}:{p}"),
                None => h.to_string(),
            };
        }
    }
    DEFAULT_HOST.into()
}

fn enterprise_host() -> String {
    std::env::var("COPILOT_ENTERPRISE_HOST")
        .or_else(|_| std::env::var("GITHUB_ENTERPRISE_HOST"))
        .unwrap_or_default()
}

/// 上游 `copilotApiHost`。
pub fn api_host(enterprise: &str) -> String {
    let host = normalized_host(enterprise);
    if host == DEFAULT_HOST {
        "api.github.com".into()
    } else if host.starts_with("api.") {
        host
    } else {
        format!("api.{host}")
    }
}

fn decode_number(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) if !s.trim().is_empty() => {
            s.trim().parse::<f64>().ok().filter(|f| f.is_finite())
        }
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Snapshot {
    entitlement: f64,
    remaining: f64,
    percent_remaining: f64,
    has_percent: bool,
    unlimited: bool,
    entitlement_decoded: bool,
    remaining_decoded: bool,
}

/// 上游 `parseQuotaSnapshot`。
fn parse_snapshot(raw: Option<&Value>) -> Option<Snapshot> {
    let raw = raw?.as_object()?;
    let ent = decode_number(raw.get("entitlement"));
    let rem = decode_number(raw.get("remaining"));
    let unlimited = raw.get("unlimited") == Some(&Value::Bool(true));
    let pct = decode_number(match raw.get("percent_remaining") {
        Some(Value::Null) | None => raw.get("percentRemaining"),
        v => v,
    });
    let (percent_remaining, has_percent) = if unlimited {
        (100.0, true)
    } else if let Some(p) = pct {
        (p, true)
    } else if let (Some(e), Some(r)) = (ent.filter(|e| *e > 0.0), rem) {
        (r / e * 100.0, true)
    } else {
        (0.0, false)
    };
    Some(Snapshot {
        entitlement: ent.unwrap_or(0.0),
        remaining: rem.unwrap_or(0.0),
        percent_remaining,
        has_percent,
        unlimited,
        entitlement_decoded: ent.is_some(),
        remaining_decoded: rem.is_some(),
    })
}

/// 上游 `isPlaceholder` + `usableQuotaSnapshot`。
fn usable(s: Option<Snapshot>) -> Option<Snapshot> {
    let s = s?;
    if s.unlimited {
        return Some(s);
    }
    let placeholder = (s.entitlement == 0.0
        && s.remaining == 0.0
        && s.percent_remaining == 0.0
        && !s.has_percent)
        || (s.entitlement_decoded
            && s.remaining_decoded
            && s.entitlement == 0.0
            && s.remaining == 0.0);
    (!placeholder && s.has_percent).then_some(s)
}

fn from_counts(monthly: Option<f64>, limited: Option<f64>) -> Option<Snapshot> {
    let (m, l) = (monthly?, limited?);
    let entitlement = m.max(0.0);
    if entitlement <= 0.0 {
        return None;
    }
    let remaining = l.max(0.0);
    let v = serde_json::json!({
        "entitlement": entitlement,
        "remaining": remaining,
        "percent_remaining": (remaining / entitlement * 100.0).clamp(0.0, 100.0),
    });
    parse_snapshot(Some(&v))
}

fn counts(raw: Option<&Value>) -> (Option<f64>, Option<f64>) {
    match raw.and_then(Value::as_object) {
        Some(o) => (
            decode_number(o.get("chat")),
            decode_number(o.get("completions")),
        ),
        None => (None, None),
    }
}

/// 上游 `parseDirectQuotaSnapshots`。
fn direct(raw: Option<&Map<String, Value>>) -> (Option<Snapshot>, Option<Snapshot>) {
    let Some(raw) = raw else {
        return (None, None);
    };
    let premium = usable(parse_snapshot(raw.get("premium_interactions")));
    let chat = usable(parse_snapshot(raw.get("chat")));
    if premium.is_some() || chat.is_some() {
        return (premium, chat);
    }
    let (mut fb_premium, mut fb_chat, mut first) = (None, None, None);
    for (key, value) in raw {
        let Some(s) = usable(parse_snapshot(Some(value))) else {
            continue;
        };
        if first.is_none() {
            first = Some(s.clone());
        }
        let name = key.to_lowercase();
        if name.contains("chat") {
            fb_chat.get_or_insert(s);
        } else if name.contains("premium") || name.contains("completion") || name.contains("code") {
            fb_premium.get_or_insert(s);
        }
    }
    let chat = fb_chat.or(if fb_premium.is_none() { first } else { None });
    (fb_premium, chat)
}

#[derive(Debug, Clone, PartialEq)]
pub struct CopilotUsage {
    premium: Option<Snapshot>,
    chat: Option<Snapshot>,
    pub plan: String,
    pub token_based_billing: bool,
    pub reset_date: Option<String>,
}

fn pick<'a>(o: &'a Map<String, Value>, a: &str, b: &str) -> Option<&'a Value> {
    o.get(a)
        .filter(|v| crate::usage::js::truthy(v))
        .or_else(|| o.get(b))
}

/// 上游 `parseCopilotUsageResponse`。
pub fn parse_usage(data: &Value) -> CopilotUsage {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    let src = data
        .as_object()
        .unwrap_or_else(|| EMPTY.get_or_init(Map::new));
    let (d_premium, d_chat) =
        direct(pick(src, "quota_snapshots", "quotaSnapshots").and_then(Value::as_object));
    let (m_chat, m_completions) = counts(pick(src, "monthly_quotas", "monthlyQuotas"));
    let (l_chat, l_completions) = counts(pick(src, "limited_user_quotas", "limitedUserQuotas"));
    let plan = pick(src, "copilot_plan", "copilotPlan")
        .filter(|v| crate::usage::js::truthy(v))
        .map(crate::usage::js::to_js_string)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into());
    CopilotUsage {
        premium: d_premium.or_else(|| usable(from_counts(m_completions, l_completions))),
        chat: d_chat.or_else(|| usable(from_counts(m_chat, l_chat))),
        plan,
        token_based_billing: src.get("token_based_billing") == Some(&Value::Bool(true))
            || src.get("tokenBasedBilling") == Some(&Value::Bool(true)),
        reset_date: pick(src, "quota_reset_date", "quotaResetDate")
            .filter(|v| crate::usage::js::truthy(v))
            .map(crate::usage::js::to_js_string),
    }
}

/// 上游 `parseQuotaResetDate`。
fn reset_iso(raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Some(crate::wire::time::iso_millis(d.with_timezone(&chrono::Utc)));
    }
    let date = chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d").ok()?;
    Some(crate::wire::time::iso_millis(
        date.and_hms_opt(0, 0, 0)?.and_utc(),
    ))
}

/// 上游 `displayPlanLabel`：第一個字大寫。
pub fn plan_label(plan: &str) -> String {
    let raw = plan.trim().to_lowercase();
    if raw.is_empty() || raw == "unknown" {
        return String::new();
    }
    let mut chars = raw.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn window(label: &str, s: &Snapshot, resets_at: &Option<String>) -> LimitWindow {
    let used = (100.0 - s.percent_remaining).max(0.0);
    LimitWindow {
        label: label.into(),
        used_percent: Some(used),
        remaining_percent: Some(s.percent_remaining.clamp(0.0, 100.0)),
        resets_at: if s.unlimited { None } else { resets_at.clone() },
        reset_description: if used > 100.0 {
            format!("{}% used", used.round())
        } else {
            String::new()
        },
        ..LimitWindow::new(WindowKind::Billing)
    }
}

/// 上游 `mapCopilotUsageToProvider`：有窗口是 ok，沒有是 unavailable。
pub fn provider_row(
    usage: &CopilotUsage,
    account_key: String,
    login: &str,
    updated_at: String,
) -> LimitProvider {
    let resets_at = reset_iso(usage.reset_date.as_deref());
    let mut windows = Vec::new();
    if let Some(s) = &usage.premium {
        windows.push(window("Premium", s, &resets_at));
    }
    if let Some(s) = &usage.chat {
        windows.push(window("Chat", s, &resets_at));
    }
    let status = if windows.is_empty() {
        ProviderStatus::Unavailable
    } else {
        ProviderStatus::Ok
    };
    finish_provider(LimitProvider {
        account_key,
        account_label: plan_label(&usage.plan),
        account_name: login.to_string(),
        source: "api".into(),
        windows,
        ..LimitProvider::status_row("copilot", status, updated_at)
    })
}

async fn get_json(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    copilot_headers: bool,
) -> Result<Value, ProbeError> {
    let mut req = http
        .get(url)
        .header("Accept", "application/json")
        .header("Authorization", format!("token {token}"))
        .timeout(REQUEST_TIMEOUT);
    if copilot_headers {
        req = req
            .header("Editor-Version", "vscode/1.96.2")
            .header("Editor-Plugin-Version", "copilot-chat/0.26.7")
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .header("X-Github-Api-Version", "2025-04-01");
    }
    let resp = req.send().await.map_err(|e| {
        ProbeError::new(
            ProviderStatus::Unavailable,
            format!("copilot request failed: {e}"),
        )
    })?;
    let code = resp.status().as_u16();
    if !resp.status().is_success() {
        let status = match code {
            401 | 403 => ProviderStatus::Unauthorized,
            429 => ProviderStatus::SourceRateLimited,
            _ => ProviderStatus::Unavailable,
        };
        return Err(ProbeError::new(status, format!("copilot HTTP {code}")));
    }
    resp.json::<Value>().await.map_err(|e| {
        ProbeError::new(
            ProviderStatus::Unavailable,
            format!("copilot invalid JSON: {e}"),
        )
    })
}

pub async fn probe(http: &reqwest::Client) -> Result<LimitProvider, ProbeError> {
    let updated_at = crate::wire::time::iso_millis(chrono::Utc::now());
    let Some(token) = token() else {
        return Err(ProbeError::new(
            ProviderStatus::NotConfigured,
            "Copilot is not signed in",
        ));
    };
    let host = enterprise_host();
    let api = api_host(&host);
    let usage_url = format!("https://{api}/copilot_internal/user");
    let user_url = if normalized_host(&host) == DEFAULT_HOST {
        "https://api.github.com/user".to_string()
    } else {
        format!("https://{api}/user")
    };
    let (usage, identity) = tokio::join!(
        get_json(http, &usage_url, &token, true),
        get_json(http, &user_url, &token, false)
    );
    let usage = parse_usage(&usage?);
    if usage.premium.is_none() && usage.chat.is_none() && !usage.token_based_billing {
        return Err(ProbeError::new(
            ProviderStatus::Unavailable,
            "Copilot usage response missing usable quotas",
        ));
    }
    let identity = identity.unwrap_or(Value::Null);
    let login = identity
        .get("login")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let seed = if !login.is_empty() {
        login.clone()
    } else {
        match identity.get("id") {
            Some(Value::Null) | None => token.chars().take(8).collect(),
            Some(v) => crate::usage::js::to_js_string(v),
        }
    };
    Ok(provider_row(
        &usage,
        hash_key(&["copilot", &seed]),
        &login,
        updated_at,
    ))
}

// ---- device flow --------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    #[serde(skip)]
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PollResult {
    Pending,
    SlowDown,
    Token(String),
    Expired,
    Denied,
    Failed(String),
}

async fn post_form(
    http: &reqwest::Client,
    url: &str,
    form: &[(&str, &str)],
) -> Result<Value, String> {
    let resp = http
        .post(url)
        .header("Accept", "application/json")
        .form(form)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("GitHub request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub HTTP {}", resp.status().as_u16()));
    }
    resp.json::<Value>()
        .await
        .map_err(|e| format!("GitHub invalid JSON: {e}"))
}

/// device flow 第一步：拿使用者要輸入的代碼。驗證網址必須是同一台 GitHub 的 `/login/device`。
pub async fn device_start(http: &reqwest::Client) -> Result<DeviceCode, String> {
    let host = normalized_host(&enterprise_host());
    let v = post_form(
        http,
        &format!("https://{host}/login/device/code"),
        &[("client_id", DEVICE_CLIENT_ID), ("scope", DEVICE_SCOPE)],
    )
    .await?;
    let s = |a: &str, b: &str| {
        v.get(a)
            .or_else(|| v.get(b))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let n = |a: &str, def: u64| v.get(a).and_then(Value::as_u64).unwrap_or(def);
    let code = DeviceCode {
        device_code: s("device_code", "deviceCode"),
        user_code: s("user_code", "userCode"),
        verification_uri: s("verification_uri", "verificationUri"),
        expires_in: n("expires_in", 900),
        interval: n("interval", 5).max(1),
    };
    if code.device_code.is_empty() || code.user_code.is_empty() || code.verification_uri.is_empty()
    {
        return Err("GitHub device code response was incomplete".into());
    }
    let allowed = url::Url::parse(&code.verification_uri).is_ok_and(|u| {
        u.scheme() == "https"
            && u.host_str().is_some_and(|h| {
                let with_port = u
                    .port()
                    .map(|p| format!("{h}:{p}"))
                    .unwrap_or_else(|| h.to_string());
                with_port == host
            })
            && (u.path().starts_with("/login/device") || u.path().starts_with("/login/oauth"))
    });
    if !allowed {
        return Err("GitHub returned an unexpected verification URL".into());
    }
    Ok(code)
}

/// device flow 第二步：輪詢一次。
pub async fn device_poll(http: &reqwest::Client, device_code: &str) -> PollResult {
    let host = normalized_host(&enterprise_host());
    let v = match post_form(
        http,
        &format!("https://{host}/login/oauth/access_token"),
        &[
            ("client_id", DEVICE_CLIENT_ID),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ],
    )
    .await
    {
        Ok(v) => v,
        Err(e) => return PollResult::Failed(e),
    };
    if let Some(token) = v
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
    {
        return PollResult::Token(token.to_string());
    }
    match v.get("error").and_then(Value::as_str).unwrap_or("") {
        "authorization_pending" => PollResult::Pending,
        "slow_down" => PollResult::SlowDown,
        "expired_token" => PollResult::Expired,
        "access_denied" => PollResult::Denied,
        other => PollResult::Failed(format!("GitHub sign-in failed: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn premium_and_chat_quotas_become_billing_windows() {
        let u = parse_usage(&json!({
            "copilot_plan": "individual",
            "quota_reset_date": "2026-10-01",
            "quota_snapshots": {
                "premium_interactions": { "entitlement": 300, "remaining": 75, "percent_remaining": 25, "quota_id": "premium_interactions" },
                "chat": { "unlimited": true }
            }
        }));
        let row = provider_row(&u, "k".into(), "octocat", "2026-01-01T00:00:00.000Z".into());
        assert_eq!(row.status, ProviderStatus::Ok);
        assert_eq!(row.account_label, "Individual");
        assert_eq!(row.windows[0].label, "Premium");
        assert_eq!(row.windows[0].used_percent, Some(75.0));
        assert_eq!(
            row.windows[0].resets_at.as_deref(),
            Some("2026-10-01T00:00:00.000Z")
        );
        assert_eq!(row.windows[1].used_percent, Some(0.0));
        assert_eq!(row.windows[1].resets_at, None, "unlimited never resets");
    }

    #[test]
    fn legacy_counts_are_used_when_snapshots_are_placeholders() {
        let u = parse_usage(&json!({
            "quota_snapshots": { "chat": { "entitlement": 0, "remaining": 0 } },
            "monthly_quotas": { "chat": 50, "completions": 2000 },
            "limited_user_quotas": { "chat": 10, "completions": 1500 }
        }));
        assert_eq!(u.chat.as_ref().unwrap().percent_remaining, 20.0);
        assert_eq!(u.premium.as_ref().unwrap().percent_remaining, 75.0);
    }

    #[test]
    fn hosts_follow_upstream() {
        assert_eq!(api_host(""), "api.github.com");
        assert_eq!(api_host("https://ghe.example.com/"), "api.ghe.example.com");
        assert_eq!(api_host("api.ghe.example.com"), "api.ghe.example.com");
        assert_eq!(clean_secret(" 'gho_x' "), "gho_x");
    }
}
