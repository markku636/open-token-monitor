//! Codex 的額度（上游 src/shared/providers/codex/{auth,limits}.js 的 ChatGPT 後端路徑）。
//!
//! - 憑證：`$CODEX_HOME|~/.codex/auth.json`（Codex CLI 寫的）。不換 token：上游靠 Codex 的
//!   app-server RPC 讓 CLI 自己換，v1 沒有 RPC，401 就一直是 unauthorized，直到使用者的 Codex 換好。
//! - 用量：`GET <base>/wham/usage`，帶 `chatgpt-account-id`（小寫）與 FedRAMP 標頭。
//! - 身分：`accountKey = hash("codex", email + "\0" + account_id)`，與上游位元相同。
//!
//! 不做（v1）：app-server RPC、多帳號切換、reset-credits 查詢、WSL。

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{Map, Value};

use super::hash::hash_key;
use super::http::{fetch_json, FetchOptions, ProbeError};
use super::normalize::{as_number, finish_provider, iso_timestamp};
use super::plan::codex_plan_label;
use crate::wire::{LimitProvider, LimitWindow, ProviderStatus, WindowKind};

pub const DEFAULT_BASE_URL: &str = "https://chatgpt.com/backend-api";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub struct CodexEnv {
    pub codex_home: PathBuf,
}

impl CodexEnv {
    pub fn from_process() -> CodexEnv {
        let home = std::env::var_os("CODEX_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"));
        CodexEnv { codex_home: home }
    }
}

fn trimmed(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or("").trim().to_string()
}

fn first_str(objs: &[&Map<String, Value>], keys: &[&str]) -> String {
    for o in objs {
        for k in keys {
            if let Some(s) = o.get(*k).and_then(Value::as_str) {
                if !s.is_empty() {
                    return s.trim().to_string();
                }
            }
        }
    }
    String::new()
}

/// JWT 的 payload（base64url，容忍有無 padding）；解不開就是空物件。
pub fn jwt_payload(token: &str) -> Map<String, Value> {
    let Some(part) = token.split('.').nth(1).filter(|p| !p.is_empty()) else {
        return Map::new();
    };
    let engine = base64::engine::GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    engine
        .decode(part.trim_end_matches('='))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// 由 auth.json 推出的請求內容與身分。
#[derive(Debug, Clone, PartialEq)]
pub struct CodexAuth {
    pub access_token: String,
    /// 送 `chatgpt-account-id` 用（已小寫）。
    pub account_id: String,
    pub is_fedramp: bool,
    pub email: String,
    /// 身分用的 workspace id：auth.json 存的優先，否則 JWT 的宣告。
    pub workspace_account_id: String,
}

pub fn parse_auth(auth: &Value) -> Result<CodexAuth, ProbeError> {
    let empty = Map::new();
    let root = auth.as_object().unwrap_or(&empty);
    let tokens = root
        .get("tokens")
        .and_then(Value::as_object)
        .unwrap_or(root);
    let access_token = first_str(&[tokens, root], &["access_token", "accessToken"]);
    if access_token.is_empty() {
        return Err(ProbeError::new(
            ProviderStatus::Unauthorized,
            "Codex access token not found",
        ));
    }
    let id_token = first_str(&[tokens, root], &["id_token", "idToken"]);
    let payload = jwt_payload(&id_token);
    let nested = payload
        .get("https://api.openai.com/auth")
        .or_else(|| payload.get("https://api.openai.com/profile"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let claimed_account = first_str(&[&payload, &nested], &["chatgpt_account_id"]).to_lowercase();
    let claimed_fedramp = nested
        .get("chatgpt_account_is_fedramp")
        .and_then(Value::as_bool)
        .or_else(|| {
            payload
                .get("chatgpt_account_is_fedramp")
                .and_then(Value::as_bool)
        });
    let stored_account = first_str(&[tokens, root], &["account_id", "accountId"]).to_lowercase();
    let account_id = if stored_account.is_empty() {
        claimed_account.clone()
    } else {
        stored_account.clone()
    };
    let is_fedramp =
        !account_id.is_empty() && account_id == claimed_account && claimed_fedramp == Some(true);
    let account = root.get("account").and_then(Value::as_object);
    let mut email = first_str(&[&payload, &nested], &["email"]);
    if email.is_empty() {
        email = account
            .map(|a| trimmed(a.get("email")))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| trimmed(root.get("email")));
    }
    let workspace = if stored_account.is_empty() {
        claimed_account
    } else {
        stored_account
    };
    Ok(CodexAuth {
        access_token,
        account_id,
        is_fedramp,
        email: email.to_lowercase(),
        workspace_account_id: workspace,
    })
}

/// 上游 `hashAccountKey`：已經是 `sha256:` 開頭就原樣，否則 `hash_key(["codex", seed])`。
fn hash_account(seed: &str) -> String {
    let raw = seed.trim();
    if raw.is_empty() {
        String::new()
    } else if raw.starts_with("sha256:") {
        raw.to_string()
    } else {
        hash_key(&["codex", raw])
    }
}

/// 上游 `codexAccountKey`。
pub fn account_key(email: &str, account_id: &str) -> String {
    let (e, a) = (
        email.trim().to_lowercase(),
        account_id.trim().to_lowercase(),
    );
    if !e.is_empty() && !a.is_empty() {
        hash_account(&format!("{e}\0{a}"))
    } else if !a.is_empty() {
        hash_account(&a)
    } else {
        hash_account(&e)
    }
}

/// `config.toml` 的 `chatgpt_base_url`（上游同樣是逐行的簡單解析）。
pub fn base_url(config_toml: Option<&str>) -> String {
    let mut base = DEFAULT_BASE_URL.to_string();
    if let Some(text) = config_toml {
        for line in text.lines() {
            let line = line.split('#').next().unwrap_or("").trim();
            if let Some(rest) = line.strip_prefix("chatgpt_base_url") {
                if let Some(value) = rest.trim_start().strip_prefix('=') {
                    let v = value.trim();
                    let v = v.strip_prefix(['"', '\'']).unwrap_or(v);
                    let v = v.strip_suffix(['"', '\'']).unwrap_or(v);
                    if !v.is_empty() {
                        base = v.to_string();
                    }
                    break;
                }
            }
        }
    }
    let base = base.trim_end_matches('/').to_string();
    let lower = base.to_lowercase();
    if matches!(
        lower.as_str(),
        "https://chatgpt.com" | "https://chat.openai.com" | "https://chatgpt.openai.com"
    ) {
        return format!("{base}/backend-api");
    }
    base
}

pub fn usage_url(base: &str) -> String {
    if base.contains("/backend-api") {
        format!("{base}/wham/usage")
    } else {
        format!("{base}/api/codex/usage")
    }
}

fn js_number(v: Option<&Value>) -> Option<f64> {
    // 上游 `Number(x)`：缺值是 NaN（→ None），null 是 0，字串照數字解析。
    match v {
        None => None,
        Some(Value::Null) => Some(0.0),
        Some(Value::String(s)) if s.trim().is_empty() => Some(0.0),
        Some(other) => as_number(other),
    }
}

/// 上游 `codexWindowKind`（以分鐘判斷；30 天是 billing，其次 weekly / daily / 5 小時 session）。
pub fn window_kind(name: &str, minutes: Option<f64>) -> WindowKind {
    let m = minutes.unwrap_or(0.0);
    if m == 43_200.0 {
        WindowKind::Billing
    } else if m >= 10_080.0 {
        WindowKind::Weekly
    } else if m >= 1_440.0 {
        WindowKind::Daily
    } else if m == 300.0 {
        WindowKind::Session
    } else if name == "secondary" {
        WindowKind::Weekly
    } else {
        WindowKind::Session
    }
}

fn alias<'a>(obj: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .find_map(|k| obj.get(*k).filter(|v| !v.is_null()))
}

fn window_from(
    name: &str,
    w: &Value,
    limit_id: &str,
    label: Option<&str>,
    additional: bool,
) -> Option<LimitWindow> {
    if !w.is_object() {
        return None;
    }
    let secs = js_number(
        w.get("limitWindowSeconds")
            .or_else(|| w.get("limit_window_seconds")),
    );
    let minutes = secs.map(|s| s / 60.0);
    let kind = window_kind(name, minutes);
    let mut win = LimitWindow::new(kind);
    win.label = match label {
        Some(l) => l.to_string(),
        None if kind == WindowKind::Billing => "Monthly".into(),
        None => String::new(),
    };
    win.limit_id = Some(limit_id.to_string());
    win.additional = additional;
    win.used_percent = alias(w, &["usedPercent", "used_percent"]).and_then(as_number);
    win.resets_at = alias(w, &["resetsAt", "resetAt", "reset_at"]).and_then(iso_timestamp);
    win.window_minutes = minutes;
    Some(win)
}

fn rate_limit_windows(
    rl: &Value,
    limit_id: &str,
    label: Option<&str>,
    additional: bool,
) -> Vec<LimitWindow> {
    let mut out = Vec::new();
    for (name, keys) in [
        ("primary", ["primary_window", "primaryWindow"]),
        ("secondary", ["secondary_window", "secondaryWindow"]),
    ] {
        if let Some(w) = alias(rl, &keys) {
            if let Some(win) = window_from(name, w, limit_id, label, additional) {
                out.push(win);
            }
        }
    }
    out
}

/// 上游的 wham 用量對應：canonical 的桶 limitId 是 `codex`，其他 metered_feature 是 additional。
pub fn map_usage(payload: &Value) -> Vec<LimitWindow> {
    let has_shape = [
        "rate_limit",
        "rateLimit",
        "additional_rate_limits",
        "additionalRateLimits",
    ]
    .iter()
    .any(|k| payload.get(*k).is_some());
    if !has_shape {
        return Vec::new();
    }
    let mut out = Vec::new();
    if let Some(rl) = alias(payload, &["rate_limit", "rateLimit"]) {
        out.extend(rate_limit_windows(rl, "codex", None, false));
    }
    if let Some(entries) = alias(payload, &["additional_rate_limits", "additionalRateLimits"])
        .and_then(Value::as_array)
    {
        // 同一個 limitId 出現兩次時後者覆蓋、位置沿用第一次（上游用物件當 map）。
        let mut buckets: Vec<(String, Vec<LimitWindow>)> = Vec::new();
        for e in entries {
            let id = e
                .get("metered_feature")
                .or_else(|| e.get("meteredFeature"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if id.is_empty() || id == "codex" {
                continue;
            }
            let name = e
                .get("limit_name")
                .or_else(|| e.get("limitName"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&id)
                .to_string();
            let windows = alias(e, &["rate_limit", "rateLimit"])
                .map(|rl| rate_limit_windows(rl, &id, Some(&name), true))
                .unwrap_or_default();
            match buckets.iter_mut().find(|(k, _)| *k == id) {
                Some(slot) => slot.1 = windows,
                None => buckets.push((id, windows)),
            }
        }
        // JS 物件先列整數樣式的鍵。
        buckets.sort_by_key(|(k, _)| !k.chars().all(|c| c.is_ascii_digit()));
        out.extend(buckets.into_iter().flat_map(|(_, w)| w));
    }
    out
}

/// 一次 probe（上游 `fetchLiveCodexAccount` 的 OAuth 部分）。
pub async fn probe(http: &reqwest::Client, env: &CodexEnv) -> Result<LimitProvider, ProbeError> {
    let started = crate::wire::time::iso_millis(chrono::Utc::now());
    let auth_path = env.codex_home.join("auth.json");
    let auth_value: Value = std::fs::read_to_string(&auth_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or_else(|| {
            ProbeError::new(ProviderStatus::NotConfigured, "Codex auth.json not found")
        })?;
    let auth = parse_auth(&auth_value)?;
    let config = std::fs::read_to_string(env.codex_home.join("config.toml")).ok();
    let url = usage_url(&base_url(config.as_deref()));
    let mut req = http
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .bearer_auth(&auth.access_token)
        .timeout(REQUEST_TIMEOUT);
    if !auth.account_id.is_empty() {
        req = req.header("chatgpt-account-id", &auth.account_id);
    }
    if auth.is_fedramp {
        req = req.header("x-openai-fedramp", "true");
    }
    let payload = fetch_json(
        req,
        "wham/usage",
        FetchOptions {
            forbidden_is_unauthorized: true,
        },
    )
    .await?;
    let key = if !auth.email.is_empty() && !auth.workspace_account_id.is_empty() {
        account_key(&auth.email, &auth.workspace_account_id)
    } else {
        let seed = [
            account_key(&auth.email, &auth.workspace_account_id),
            fallback_seed(&auth_path),
        ]
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or_default();
        hash_account(if seed.is_empty() { "account" } else { &seed })
    };
    let plan = payload
        .get("plan_type")
        .or_else(|| payload.get("planType"))
        .and_then(Value::as_str)
        .unwrap_or("");
    Ok(finish_provider(LimitProvider {
        account_key: key,
        account_label: codex_plan_label(plan),
        account_email: auth.email.clone(),
        source: "oauth".into(),
        windows: map_usage(&payload),
        ..LimitProvider::status_row("codex", ProviderStatus::Ok, started)
    }))
}

/// 沒有 email 也沒有 account id 時，上游以 `account::<auth.json 路徑>` 當種子。
fn fallback_seed(auth_path: &Path) -> String {
    format!("account::{}", auth_path.display())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn jwt(claims: Value) -> String {
        let enc = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!("x.{}.sig", enc.encode(serde_json::to_vec(&claims).unwrap()))
    }

    #[test]
    fn account_keys_match_upstream() {
        assert_eq!(
            account_key("user@example.com", "acct-123"),
            "sha256:5a75133b4af1e30ad35fe4461e61e3af867de2545c6ab5a9df3758fe62ade6f1"
        );
        assert_eq!(
            account_key("member@example.com", "workspace-team"),
            "sha256:ea6bd85844989ab272fd0d18c296cce19fe6fba6306e5b496f9555625988f64e"
        );
        assert_eq!(
            account_key("User@Example.com", ""),
            "sha256:71831264eb752addd76e4a79084656206df8d9d7e2ea69f9be18365fda209654"
        );
        assert_eq!(
            hash_account(&fallback_seed(Path::new(r"\x\auth.json"))),
            "sha256:ed4357a605bd44ba1aba6d8151099b7728ccd4a6bfa739ef80c4a81e4159b651"
        );
    }

    #[test]
    fn stored_account_wins_over_the_claim_and_fedramp_needs_both() {
        let claims = json!({"email": "Member@Example.com", "https://api.openai.com/auth": {"chatgpt_account_id": "workspace-personal", "chatgpt_account_is_fedramp": true}});
        let auth = parse_auth(&json!({"tokens": {"access_token": "tok", "account_id": "Workspace-Team", "id_token": jwt(claims.clone())}})).unwrap();
        assert_eq!(auth.account_id, "workspace-team");
        assert!(!auth.is_fedramp, "stored id differs from the claim");
        assert_eq!(auth.email, "member@example.com");
        let auth = parse_auth(&json!({"tokens": {"access_token": "tok", "account_id": "workspace-personal", "id_token": jwt(claims)}})).unwrap();
        assert!(auth.is_fedramp);
        assert_eq!(
            parse_auth(&json!({"tokens": {}})).unwrap_err().status,
            ProviderStatus::Unauthorized
        );
    }

    #[test]
    fn usage_maps_like_the_upstream_fixture() {
        let payload = json!({
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": {"used_percent": 12, "reset_at": 1_770_000_000, "limit_window_seconds": 18_000},
                "secondary_window": {"used_percent": 34.5, "reset_at": 1_770_500_000, "limit_window_seconds": 604_800}
            },
            "additional_rate_limits": [
                {"limit_name": "gpt-reserve", "metered_feature": "base_model_inference", "rate_limit": {"primary_window": {"used_percent": 70, "reset_at": 1_770_500_000, "limit_window_seconds": 604_800}}}
            ]
        });
        let p = finish_provider(LimitProvider {
            windows: map_usage(&payload),
            ..LimitProvider::status_row("codex", ProviderStatus::Ok, "t".into())
        });
        let got: Vec<_> = p
            .windows
            .iter()
            .map(|w| {
                (
                    w.kind,
                    w.label.as_str(),
                    w.limit_id.as_deref(),
                    w.additional,
                    w.used_percent,
                    w.window_minutes,
                    w.resets_at.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    WindowKind::Session,
                    "",
                    Some("codex"),
                    false,
                    Some(12.0),
                    Some(300.0),
                    Some("2026-02-02T02:40:00.000Z")
                ),
                (
                    WindowKind::Weekly,
                    "",
                    Some("codex"),
                    false,
                    Some(34.5),
                    Some(10_080.0),
                    Some("2026-02-07T21:33:20.000Z")
                ),
                (
                    WindowKind::Weekly,
                    "gpt-reserve",
                    Some("base_model_inference"),
                    true,
                    Some(70.0),
                    Some(10_080.0),
                    Some("2026-02-07T21:33:20.000Z")
                ),
            ]
        );
        assert_eq!(p.windows[1].remaining_percent, Some(65.5));
    }

    #[test]
    fn additional_buckets_without_the_canonical_lane() {
        let payload = json!({"plan_type": "pro", "rate_limit": null, "additional_rate_limits": [
            {"limit_name": "Codex Other", "metered_feature": "codex_other", "rate_limit": {"primary_window": {"used_percent": 70, "limit_window_seconds": 604_800}}},
            {"metered_feature": "codex_spark", "rate_limit": {"primary_window": {"used_percent": 20, "limit_window_seconds": 18_000}}}
        ]});
        let p = finish_provider(LimitProvider {
            windows: map_usage(&payload),
            ..LimitProvider::status_row("codex", ProviderStatus::Ok, "t".into())
        });
        let got: Vec<_> = p
            .windows
            .iter()
            .map(|w| (w.kind, w.label.as_str(), w.used_percent))
            .collect();
        assert_eq!(
            got,
            vec![
                (WindowKind::Session, "codex_spark", Some(20.0)),
                (WindowKind::Weekly, "Codex Other", Some(70.0))
            ]
        );
        assert!(
            map_usage(&json!({})).is_empty(),
            "no usage shape: ok with no windows"
        );
    }

    #[test]
    fn window_kinds_follow_the_duration_table() {
        let k = |name: &str, secs: Option<f64>| window_kind(name, secs.map(|s| s / 60.0));
        assert_eq!(k("primary", Some(18_000.0)), WindowKind::Session);
        assert_eq!(k("primary", Some(3_600.0)), WindowKind::Session);
        assert_eq!(k("primary", Some(86_400.0)), WindowKind::Daily);
        assert_eq!(k("primary", Some(604_800.0)), WindowKind::Weekly);
        assert_eq!(k("primary", Some(2_592_000.0)), WindowKind::Billing);
        assert_eq!(k("primary", Some(2_678_400.0)), WindowKind::Weekly);
        assert_eq!(k("secondary", Some(21_600.0)), WindowKind::Weekly);
        assert_eq!(k("secondary", Some(18_000.0)), WindowKind::Session);
        assert_eq!(k("secondary", None), WindowKind::Weekly);
    }

    #[test]
    fn base_url_from_config_toml() {
        assert_eq!(base_url(None), "https://chatgpt.com/backend-api");
        assert_eq!(
            base_url(Some(
                "chatgpt_base_url = \"https://chatgpt.com/\" # comment"
            )),
            "https://chatgpt.com/backend-api"
        );
        assert_eq!(
            base_url(Some(
                "model = \"x\"\nchatgpt_base_url='https://proxy.example/codex'"
            )),
            "https://proxy.example/codex"
        );
        assert_eq!(
            usage_url("https://proxy.example/codex"),
            "https://proxy.example/codex/api/codex/usage"
        );
        assert_eq!(
            usage_url(DEFAULT_BASE_URL),
            "https://chatgpt.com/backend-api/wham/usage"
        );
    }
}
