//! Codex 的額度（上游 src/shared/providers/codex/{auth,limits}.js 的 ChatGPT 後端路徑）。
//!
//! - 憑證：`$CODEX_HOME|~/.codex/auth.json`（Codex CLI 寫的）。不換 token：上游靠 Codex 的
//!   app-server RPC 讓 CLI 自己換，v1 沒有 RPC，401 就一直是 unauthorized，直到使用者的 Codex 換好。
//! - 用量：`GET <base>/wham/usage`，帶 `chatgpt-account-id`（小寫）與 FedRAMP 標頭。
//! - 重置券：用量成功後再 `GET <base>/wham/rate-limit-reset-credits`（上游 `withCodexOAuthResetCredits`），
//!   每次 probe 一次、4 秒逾時；失敗只是這一輪沒有 API 的重置券，**不會**讓整個 probe 失敗。
//! - 身分：`accountKey = hash("codex", email + "\0" + account_id)`，與上游位元相同。
//!
//! 不做（v1）：app-server RPC、多帳號切換、WSL。

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{Map, Value};

use super::hash::hash_key;
use super::http::{fetch_json, FetchOptions, ProbeError};
use super::normalize::{
    as_number, date_parse_ms, finish_provider, is_js_object, iso_timestamp, js_number, nullish,
};
use super::plan::codex_plan_label;
use crate::usage::js::{to_js_string, truthy};
use crate::wire::{LimitProvider, LimitWindow, ProviderStatus, ResetCredits, WindowKind};

pub const DEFAULT_BASE_URL: &str = "https://chatgpt.com/backend-api";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// 上游 `codexResetCreditsTimeoutMs` 的預設值。
const RESET_CREDITS_TIMEOUT: Duration = Duration::from_secs(4);

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

/// 上游 `CODEX_BACKEND_PATHS.*.resetCredits`：路徑樣式跟著 usage 走。
pub fn reset_credits_url(base: &str) -> String {
    if base.contains("/backend-api") {
        format!("{base}/wham/rate-limit-reset-credits")
    } else {
        format!("{base}/api/codex/rate-limit-reset-credits")
    }
}

/// 上游 `parseCodexResetCreditsPayload`：reset-credits API 的回應 → 正規化前的中間形狀。
/// 次數不是非負數字就是壞回應（上游丟 unavailable，由呼叫端吞掉）；到期時間只收
/// `status: available` 而且還沒過期的，由早到晚。
pub fn parse_reset_credits_payload(payload: &Value, now_ms: i64) -> Result<Value, ProbeError> {
    let available = js_number(nullish(&[
        payload.get("available_count"),
        payload.get("availableCount"),
    ]));
    if !available.is_finite() || available < 0.0 {
        return Err(ProbeError::new(
            ProviderStatus::Unavailable,
            "Invalid Codex reset credits response",
        ));
    }
    let mut expirations: Vec<i64> = Vec::new();
    for credit in payload
        .get("credits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let status = credit
            .get("status")
            .filter(|v| truthy(v))
            .map(to_js_string)
            .unwrap_or_default()
            .to_lowercase();
        if status != "available" {
            continue;
        }
        let expires = nullish(&[credit.get("expires_at"), credit.get("expiresAt")]);
        match expires.and_then(date_parse_ms) {
            Some(ms) if ms > now_ms => expirations.push(ms),
            _ => {}
        }
    }
    expirations.sort_unstable();
    let isos: Vec<Value> = expirations
        .into_iter()
        .filter_map(super::normalize::iso_millis)
        .map(Value::String)
        .collect();
    let mut out = Map::new();
    out.insert(
        "availableCount".into(),
        serde_json::Number::from_f64(available.floor())
            .map(Value::Number)
            .unwrap_or(Value::Null),
    );
    out.insert(
        "nextExpiresAt".into(),
        isos.first().cloned().unwrap_or(Value::Null),
    );
    if !isos.is_empty() {
        out.insert("expirations".into(), Value::Array(isos));
    }
    Ok(Value::Object(out))
}

/// 上游 `mergeCodexResetCredits`：API 的結果優先，缺的欄位才用 usage 回應本身帶的。
pub fn merge_reset_credits(primary: Option<&Value>, fallback: Option<&Value>) -> Option<Value> {
    let first = primary.filter(|v| is_js_object(v));
    let second = fallback.filter(|v| is_js_object(v));
    let (f, s) = match (first, second) {
        (None, s) => return s.cloned(),
        (Some(f), None) => return Some(f.clone()),
        (Some(f), Some(s)) => (f, s),
    };
    let pick = |keys: &[&str]| -> Option<Value> {
        let candidates: Vec<Option<&Value>> = [f, s]
            .iter()
            .flat_map(|o| keys.iter().map(move |k| o.get(*k)))
            .collect();
        nullish(&candidates).cloned()
    };
    let mut out = Map::new();
    // 值為 undefined 的鍵在上游等於沒有這個鍵，所以 None 就不寫。
    if let Some(v) = pick(&["availableCount", "available_count"]) {
        out.insert("availableCount".into(), v);
    }
    if let Some(v) = pick(&[
        "nextExpiresAt",
        "next_expires_at",
        "expiresAt",
        "expires_at",
    ]) {
        out.insert("nextExpiresAt".into(), v);
    }
    if let Some(v) = pick(&[
        "expirations",
        "expirationTimes",
        "expiresAtList",
        "expires_at_list",
    ])
    .filter(truthy)
    {
        out.insert("expirations".into(), v);
    }
    Some(Value::Object(out))
}

/// 上游 `codexResetCreditsSnapshot`：usage 回應本身帶的 reset credits（第一個 truthy 的）。
/// wham 形狀的回應在上游會先轉成新的 rateLimits 物件，裡面不會有 reset credits，
/// 所以只剩頂層這兩個鍵（RPC 的形狀 v1 不支援，見檔頭）。
fn usage_reset_credits(usage: &Value) -> Option<&Value> {
    [
        usage.get("rateLimitResetCredits"),
        usage.get("rate_limit_reset_credits"),
    ]
    .into_iter()
    .flatten()
    .find(|v| truthy(v))
}

/// usage 回應 + reset-credits API 的中間形狀（API 失敗時是 None）→ wire 的 `resetCredits`
///（上游 `withCodexOAuthResetCredits` → `mapCodexRateLimitsToProvider` → `normalizeLimitProvider`）。
pub fn resolve_reset_credits(usage: &Value, fetched: Option<&Value>) -> Option<ResetCredits> {
    let existing = usage_reset_credits(usage);
    let merged = match fetched {
        Some(api) => merge_reset_credits(Some(api), existing),
        None => existing.cloned(),
    };
    merged.as_ref().and_then(super::reset_credits::normalize)
}

/// 上游 `codexOAuthRequestHeaders`：usage 與 reset-credits 共用。
fn oauth_get(http: &reqwest::Client, url: &str, auth: &CodexAuth) -> reqwest::RequestBuilder {
    let mut req = http
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .bearer_auth(&auth.access_token);
    if !auth.account_id.is_empty() {
        req = req.header("chatgpt-account-id", &auth.account_id);
    }
    if auth.is_fedramp {
        req = req.header("x-openai-fedramp", "true");
    }
    req
}

/// 上游 `fetchCodexResetCredits`：另外帶 Codex Desktop 的 `openai-beta` 與 `originator`。
async fn fetch_reset_credits(
    http: &reqwest::Client,
    base: &str,
    auth: &CodexAuth,
) -> Result<Value, ProbeError> {
    let req = oauth_get(http, &reset_credits_url(base), auth)
        .header("openai-beta", "codex-1")
        .header("originator", "Codex Desktop")
        .timeout(RESET_CREDITS_TIMEOUT);
    let json = fetch_json(
        req,
        "rate-limit-reset-credits",
        FetchOptions {
            forbidden_is_unauthorized: true,
        },
    )
    .await?;
    parse_reset_credits_payload(&json, chrono::Utc::now().timestamp_millis())
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
    // 上游 `Number(w.limitWindowSeconds ?? w.limit_window_seconds)`，不是有限數字就沒有長度。
    let secs = js_number(nullish(&[
        w.get("limitWindowSeconds"),
        w.get("limit_window_seconds"),
    ]));
    let minutes = secs.is_finite().then_some(secs / 60.0);
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
    let base = base_url(config.as_deref());
    let req = oauth_get(http, &usage_url(&base), &auth).timeout(REQUEST_TIMEOUT);
    let payload = fetch_json(
        req,
        "wham/usage",
        FetchOptions {
            forbidden_is_unauthorized: true,
        },
    )
    .await?;
    // 用量成功後才問重置券（上游同樣在 usage 之後、依序）；失敗不影響這次 probe。
    let fetched = match fetch_reset_credits(http, &base, &auth).await {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::debug!(status = ?e.status, error = %e.message, "Codex reset credits unavailable");
            None
        }
    };
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
        reset_credits: resolve_reset_credits(&payload, fetched.as_ref()),
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
        assert_eq!(
            reset_credits_url(DEFAULT_BASE_URL),
            "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
        );
        assert_eq!(
            reset_credits_url("https://codex.example.com"),
            "https://codex.example.com/api/codex/rate-limit-reset-credits"
        );
    }

    const JUNE_30: i64 = 1_782_777_600_000; // 2026-06-30T00:00:00Z

    /// 上游 limitCollector.codex.test.js「augments reset credits expiry from the Codex OAuth endpoint」。
    #[test]
    fn reset_credits_parse_like_upstream() {
        let api = parse_reset_credits_payload(
            &json!({
                "credits": [
                    {"id": "expired", "status": "available", "expires_at": "2026-06-17T00:39:53Z"},
                    {"id": "later", "status": "available", "expires_at": "2026-07-18T00:39:53.731630Z"},
                    {"id": "earlier", "status": "Available", "expires_at": "2026-07-12T04:03:43.263391Z"},
                    {"id": "future-status", "status": "future_status", "expires_at": "2026-07-10T04:03:43Z"},
                    {"id": "no-date", "status": "available"}
                ],
                "available_count": 2
            }),
            JUNE_30,
        )
        .unwrap();
        let usage = json!({"rate_limit": {}, "rateLimitResetCredits": {"availableCount": 7}});
        let got = resolve_reset_credits(&usage, Some(&api)).unwrap();
        assert_eq!(got.available_count, Some(2.0), "the API count wins");
        assert_eq!(
            got.next_expires_at.as_deref(),
            Some("2026-07-12T04:03:43.263Z")
        );
        assert_eq!(
            got.expirations,
            vec!["2026-07-12T04:03:43.263Z", "2026-07-18T00:39:53.731Z"]
        );
        assert!(got.grants.is_empty(), "Codex credits are anonymous");
    }

    #[test]
    fn a_bad_reset_credits_answer_is_an_error() {
        for bad in [
            json!({}),
            json!({"available_count": -1}),
            json!({"available_count": "many"}),
            json!(null),
        ] {
            let err = parse_reset_credits_payload(&bad, JUNE_30).unwrap_err();
            assert_eq!(err.status, ProviderStatus::Unavailable, "{bad}");
        }
        let zero = parse_reset_credits_payload(&json!({"availableCount": "0"}), JUNE_30).unwrap();
        assert_eq!(zero, json!({"availableCount": 0.0, "nextExpiresAt": null}));
    }

    #[test]
    fn usage_credits_fill_what_the_api_lacks() {
        let api = parse_reset_credits_payload(&json!({"available_count": 1.7}), JUNE_30).unwrap();
        let usage = json!({"rate_limit_reset_credits": {
            "available_count": 9,
            "next_expires_at": "2026-07-02T00:00:00Z",
            "expires_at_list": ["2026-07-03T00:00:00Z", "2026-07-02T00:00:00Z"]
        }});
        let got = resolve_reset_credits(&usage, Some(&api)).unwrap();
        assert_eq!(got.available_count, Some(1.0));
        assert_eq!(
            got.next_expires_at.as_deref(),
            Some("2026-07-02T00:00:00.000Z")
        );
        assert_eq!(
            got.expirations,
            vec!["2026-07-02T00:00:00.000Z", "2026-07-03T00:00:00.000Z"]
        );
        // API 失敗：只剩 usage 回應本身帶的。
        let fallback = resolve_reset_credits(&usage, None).unwrap();
        assert_eq!(fallback.available_count, Some(9.0));
        assert_eq!(
            resolve_reset_credits(&json!({"rate_limit": {}}), None),
            None
        );
        assert_eq!(
            resolve_reset_credits(&json!({"rate_limit_reset_credits": {}}), None),
            None,
            "an empty object normalizes to null"
        );
    }

    /// 最小的 HTTP 伺服器：usage 固定成功，reset-credits 回 `reset`；記下每個請求（小寫）。
    async fn serve(
        listener: tokio::net::TcpListener,
        reset: (u16, &'static str),
        log: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        const USAGE: &str = r#"{"plan_type":"plus","rate_limit":{"primary_window":{"used_percent":4,"reset_at":1770000000,"limit_window_seconds":18000}},"rate_limit_reset_credits":{"available_count":5}}"#;
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = sock.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let req = String::from_utf8_lossy(&buf).to_lowercase();
            let (code, body) = if req.starts_with("get /backend-api/wham/usage ") {
                (200, USAGE)
            } else if req.starts_with("get /backend-api/wham/rate-limit-reset-credits ") {
                reset
            } else {
                (404, "{}")
            };
            log.lock().unwrap().push(req);
            let head = format!(
                "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            sock.write_all(head.as_bytes()).await.unwrap();
            sock.write_all(body.as_bytes()).await.unwrap();
            let _ = sock.shutdown().await;
        }
    }

    async fn probe_against(reset: (u16, &'static str)) -> (LimitProvider, Vec<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let server = tokio::spawn(serve(listener, reset, log.clone()));
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("auth.json"),
            r#"{"tokens":{"access_token":"tok","account_id":"Acct-Live"}}"#,
        )
        .unwrap();
        std::fs::write(
            home.path().join("config.toml"),
            format!("chatgpt_base_url = \"http://{addr}/backend-api\"\n"),
        )
        .unwrap();
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let env = CodexEnv {
            codex_home: home.path().to_path_buf(),
        };
        let provider = probe(&http, &env).await.unwrap();
        server.abort();
        let requests = log.lock().unwrap().clone();
        (provider, requests)
    }

    #[tokio::test]
    async fn probe_asks_for_reset_credits_after_usage() {
        let (p, requests) = probe_against((
            200,
            r#"{"available_count":2,"credits":[{"status":"available","expires_at":"2099-01-02T00:00:00Z"},{"status":"available","expires_at":"2099-01-01T00:00:00Z"}]}"#,
        ))
        .await;
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("get /backend-api/wham/usage "));
        let reset = &requests[1];
        assert!(reset.starts_with("get /backend-api/wham/rate-limit-reset-credits "));
        for header in [
            "authorization: bearer tok",
            "chatgpt-account-id: acct-live",
            "accept: application/json",
            "openai-beta: codex-1",
            "originator: codex desktop",
        ] {
            assert!(reset.contains(header), "missing {header}");
        }
        assert!(
            !requests[0].contains("openai-beta"),
            "only the reset-credits call presents as Codex Desktop"
        );
        let rc = p.reset_credits.unwrap();
        assert_eq!(rc.available_count, Some(2.0));
        assert_eq!(
            rc.expirations,
            vec!["2099-01-01T00:00:00.000Z", "2099-01-02T00:00:00.000Z"]
        );
        assert_eq!(p.windows.len(), 1);
    }

    #[tokio::test]
    async fn a_failed_reset_credits_call_keeps_the_probe() {
        for reset in [(500, "{}"), (401, "{}"), (200, r#"{"available_count":-1}"#)] {
            let (p, requests) = probe_against(reset).await;
            assert_eq!(requests.len(), 2);
            assert_eq!(p.status, ProviderStatus::Ok, "{reset:?}");
            assert_eq!(p.windows.len(), 1);
            assert_eq!(
                p.reset_credits.and_then(|r| r.available_count),
                Some(5.0),
                "falls back to the usage payload's own reset credits"
            );
        }
    }
}
