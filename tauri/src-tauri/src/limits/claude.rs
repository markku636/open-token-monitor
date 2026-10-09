//! Claude Code 的額度（上游 src/shared/providers/claude/limits.js 的 OAuth 路徑）。
//!
//! 1. 憑證：`CLAUDE_CODE_OAUTH_TOKEN` → `$CLAUDE_CONFIG_DIR|~/.claude/.credentials.json`
//!    → Windows 認證管理員（`Claude Code-credentials`、`…:<USER>`、`…/<USER>`）→ macOS 鑰匙圈。
//! 2. 到期前 5 分鐘主動換 token；用量 API 回 401 時換一次再試。只有檔案來源會寫回。
//! 3. 用量：`/api/oauth/usage?cedar_ember=1`（user-agent 必須是 claude-cli，否則 API 不給完整資料）。
//! 4. 身分：`/api/oauth/profile` → `accountKey = hash_key(["claude-account", stable])`，
//!    與上游位元相同，hub 才能把 Electron 與 Tauri 裝置上的同一個帳號合併。快取一小時。
//!
//! 不做（v1）：claude.ai cookie、`claude /usage` 與 `/status` 的 CLI 退路、WSL 內的憑證。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use super::hash::hash_key;
use super::http::{fetch_json, FetchOptions, ProbeError};
use super::normalize::{as_number, finish_provider, iso_from_text};
use super::plan::claude_plan_label;
use crate::wire::{LimitProvider, LimitWindow, ProviderStatus, WindowKind};

pub const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1";
pub const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
pub const TOKEN_URL: &str = "https://console.anthropic.com/v1/oauth/token";
pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// 用量 API 只對 Claude Code 的 user-agent 回完整資料（上游 L:43 的註解）。
pub const USAGE_USER_AGENT: &str = "claude-cli/2.1.280 (external, cli)";
pub const WINCRED_SERVICE: &str = "Claude Code-credentials";
const REFRESH_LEEWAY_MS: i64 = 300_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const IDENTITY_TTL: Duration = Duration::from_secs(3600);
const IDENTITY_CACHE_MAX: usize = 16;

#[derive(Debug, Clone, PartialEq)]
pub enum CredSource {
    Env,
    File { path: PathBuf, root_shape: bool },
    WinCred,
    Keychain,
}

impl CredSource {
    fn name(&self) -> &'static str {
        match self {
            CredSource::Env => "env",
            CredSource::File { .. } => "file",
            CredSource::WinCred => "wincred",
            CredSource::Keychain => "keychain",
        }
    }
}

#[derive(Clone, PartialEq)]
pub struct ClaudeCreds {
    pub source: CredSource,
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// 毫秒。
    pub expires_at: Option<i64>,
    /// 方案（`Max 20x` 等），來自憑證的 subscriptionType / rateLimitTier。
    pub account_label: String,
}

impl std::fmt::Debug for ClaudeCreds {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // token 絕不進 log。
        f.debug_struct("ClaudeCreds")
            .field("source", &self.source)
            .field("expires_at", &self.expires_at)
            .field("account_label", &self.account_label)
            .finish()
    }
}

pub type WinCredReader = Box<dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync>;
pub type KeychainReader = Box<dyn Fn() -> Option<String> + Send + Sync>;
/// profile 裡找欄位的順序：(物件, 候選鍵)。
type FieldSources<'a> = [(Option<&'a Map<String, Value>>, &'a [&'a str])];

/// 憑證的來源環境；測試時換成假的，不碰真的家目錄與認證管理員。
pub struct ClaudeEnv {
    pub oauth_token: Option<String>,
    pub config_dir: PathBuf,
    pub usernames: Vec<String>,
    pub use_wincred: bool,
    pub read_wincred: WinCredReader,
    pub read_keychain: KeychainReader,
    pub is_macos: bool,
}

impl ClaudeEnv {
    pub fn from_process() -> ClaudeEnv {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let config_dir = env("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".claude"));
        let mut usernames = Vec::new();
        for k in ["USER", "USERNAME"] {
            if let Some(v) = env(k) {
                if !usernames.contains(&v) {
                    usernames.push(v);
                }
            }
        }
        ClaudeEnv {
            oauth_token: env("CLAUDE_CODE_OAUTH_TOKEN"),
            config_dir,
            usernames,
            use_wincred: cfg!(windows),
            read_wincred: Box::new(read_wincred_blob),
            read_keychain: Box::new(read_macos_keychain),
            is_macos: cfg!(target_os = "macos"),
        }
    }
}

fn read_wincred_blob(target: &str) -> Option<Vec<u8>> {
    if !cfg!(windows) || std::env::var_os("TOKEN_MONITOR_DISABLE_KEYRING").is_some() {
        return None;
    }
    // keyring 以 TargetName 找認證（service / user 只是屬性，查詢用不到）；Claude Code 寫的是
    // 一般認證，blob 是 UTF-8（或帶 BOM 的 UTF-16）JSON。
    let entry = keyring::Entry::new_with_target(target, WINCRED_SERVICE, "token-monitor").ok()?;
    entry.get_secret().ok()
}

fn read_macos_keychain() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = std::process::Command::new("security")
        .args(["find-generic-password", "-s", WINCRED_SERVICE, "-w"])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 上游 `normalizeExpiresAt`：大於 2e10 當毫秒，否則秒；字串交給日期解析（純數字字串不算）。
pub fn normalize_expires_at(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => {
            let f = n.as_f64().filter(|f| f.is_finite())?;
            Some(if f > 20_000_000_000.0 {
                f.floor() as i64
            } else {
                (f * 1000.0).floor() as i64
            })
        }
        Value::String(s) if !s.trim().is_empty() => iso_from_text(s)
            .and_then(|iso| chrono::DateTime::parse_from_rfc3339(&iso).ok())
            .map(|d| d.timestamp_millis()),
        _ => None,
    }
}

fn truthy_string(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// 從憑證 JSON 取出 OAuth 區塊（`claudeAiOauth` → `oauth` → 根）。
fn creds_from_json(raw: &Value, source: CredSource) -> Option<ClaudeCreds> {
    let obj = raw.as_object()?;
    let (oauth, root_shape) = match obj.get("claudeAiOauth").or_else(|| obj.get("oauth")) {
        Some(Value::Object(inner)) => (inner, !obj.contains_key("claudeAiOauth")),
        _ => (obj, true),
    };
    let access_token = truthy_string(oauth.get("accessToken"))?;
    let label = claude_plan_label(
        oauth
            .get("subscriptionType")
            .and_then(Value::as_str)
            .unwrap_or(""),
        oauth
            .get("rateLimitTier")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let source = match source {
        CredSource::File { path, .. } => CredSource::File { path, root_shape },
        other => other,
    };
    Some(ClaudeCreds {
        source,
        access_token,
        refresh_token: truthy_string(oauth.get("refreshToken")),
        expires_at: normalize_expires_at(oauth.get("expiresAt")),
        account_label: label,
    })
}

/// 上游 `decodeCredentialBlob`：先試 UTF-8；看起來不像 JSON 且長度是偶數時試 UTF-16LE（含 BOM）。
pub fn decode_blob(bytes: &[u8]) -> String {
    let trim = |s: String| {
        s.trim_end_matches('\0')
            .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
            .to_string()
    };
    let looks_json =
        |s: &str| s.starts_with('{') || s.starts_with('[') || s.contains("\"accessToken\"");
    let utf8 = trim(String::from_utf8_lossy(bytes).into_owned());
    let utf16 = if bytes.len().is_multiple_of(2) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        trim(String::from_utf16_lossy(&units))
    } else {
        String::new()
    };
    if looks_json(&utf8) && serde_json::from_str::<Value>(&utf8).is_ok() {
        return utf8;
    }
    // 上游在沒有 BOM 的 UTF-16 JSON 會誤判成 UTF-8 而失敗；這裡兩種都試，能解析的那個優先。
    if looks_json(&utf16) {
        return utf16;
    }
    if !utf8.is_empty() {
        utf8
    } else {
        utf16
    }
}

fn wincred_targets(usernames: &[String]) -> Vec<String> {
    let mut out = vec![WINCRED_SERVICE.to_string()];
    for u in usernames {
        for t in [
            format!("{WINCRED_SERVICE}:{u}"),
            format!("{WINCRED_SERVICE}/{u}"),
        ] {
            if !out.contains(&t) {
                out.push(t);
            }
        }
    }
    out
}

/// 依上游順序找憑證；都沒有就是 notConfigured。
pub fn read_credentials(env: &ClaudeEnv) -> Result<ClaudeCreds, ProbeError> {
    if let Some(token) = env.oauth_token.clone() {
        return Ok(ClaudeCreds {
            source: CredSource::Env,
            access_token: token,
            refresh_token: None,
            expires_at: None,
            account_label: String::new(),
        });
    }
    let path = env.config_dir.join(".credentials.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(raw) = serde_json::from_str::<Value>(&text) {
            let src = CredSource::File {
                path: path.clone(),
                root_shape: false,
            };
            if let Some(c) = creds_from_json(&raw, src) {
                return Ok(c);
            }
        }
    }
    if env.use_wincred {
        for target in wincred_targets(&env.usernames) {
            let Some(blob) = (env.read_wincred)(&target) else {
                continue;
            };
            let text = decode_blob(&blob);
            if text.is_empty() {
                continue;
            }
            if let Some(c) = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|raw| creds_from_json(&raw, CredSource::WinCred))
            {
                return Ok(c);
            }
        }
    }
    if env.is_macos {
        if let Some(text) = (env.read_keychain)() {
            let raw: Value = serde_json::from_str(&text).map_err(|e| {
                ProbeError::new(ProviderStatus::Unavailable, format!("keychain JSON: {e}"))
            })?;
            if let Some(c) = creds_from_json(&raw, CredSource::Keychain) {
                return Ok(c);
            }
        }
    }
    Err(ProbeError::new(
        ProviderStatus::NotConfigured,
        "Claude credentials not found",
    ))
}

/// 換 token 後寫回憑證檔（只有檔案來源）：保留原有鍵與順序，tmp + rename。失敗只記 log。
fn write_back(path: &Path, root_shape: bool, creds: &ClaudeCreds) {
    let result = (|| -> std::io::Result<()> {
        let text = std::fs::read_to_string(path)?;
        let mut existing: Value = serde_json::from_str(&text)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let Some(obj) = existing.as_object_mut() else {
            return Ok(());
        };
        let target: &mut Map<String, Value> = if root_shape {
            obj
        } else {
            match obj.get_mut("claudeAiOauth") {
                Some(Value::Object(inner)) => inner,
                _ => return Ok(()),
            }
        };
        target.insert(
            "accessToken".into(),
            Value::String(creds.access_token.clone()),
        );
        if let Some(rt) = &creds.refresh_token {
            target.insert("refreshToken".into(), Value::String(rt.clone()));
        }
        if let Some(exp) = creds.expires_at {
            target.insert("expiresAt".into(), Value::from(exp));
        }
        let body = serde_json::to_string_pretty(&existing)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?
            + "\n";
        let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
        std::fs::write(&tmp, body)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, path).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
    })();
    if let Err(e) = result {
        tracing::warn!(error = %e, "could not write refreshed Claude credentials back");
    }
}

/// 身分：hub 以 accountKey 合併同一個帳號。
#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    pub account_key: String,
    pub account_name: String,
    pub account_email: String,
}

fn str_field<'a>(obj: Option<&'a Map<String, Value>>, keys: &[&str]) -> &'a str {
    let Some(obj) = obj else { return "" };
    for k in keys {
        if let Some(s) = obj.get(*k).and_then(Value::as_str) {
            if !s.is_empty() {
                return s;
            }
        }
    }
    ""
}

/// 上游 `claudeOauthAccountIdentity`。
pub fn identity_from_profile(profile: &Value) -> Option<Identity> {
    let root = profile.as_object();
    let acct = profile.get("account").and_then(Value::as_object);
    let org = profile.get("organization").and_then(Value::as_object);
    let first = |parts: &FieldSources| -> String {
        parts
            .iter()
            .map(|(o, k)| str_field(*o, k))
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let account_id = first(&[(acct, &["uuid", "id"]), (root, &["account_uuid"])]);
    let org_id = first(&[(org, &["uuid", "id"]), (root, &["organization_uuid"])]);
    let email = first(&[
        (acct, &["email", "email_address"]),
        (root, &["email", "email_address"]),
    ])
    .to_lowercase();
    let name = first(&[
        (acct, &["display_name", "full_name", "name"]),
        (org, &["display_name", "name"]),
    ]);
    let stable = if !account_id.is_empty() {
        format!("account:{account_id}")
    } else if !org_id.is_empty() {
        format!("organization:{org_id}")
    } else {
        email.clone()
    };
    if stable.is_empty() {
        return None;
    }
    Some(Identity {
        account_key: hash_key(&["claude-account", &stable]),
        account_name: name,
        account_email: email,
    })
}

fn alias<'a>(obj: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .find_map(|k| obj.get(*k).filter(|v| !v.is_null()))
}

fn percent(w: &Value) -> Option<f64> {
    alias(w, &["usedPercent", "used_percent"])
        .or_else(|| alias(w, &["utilization", "percent"]))
        .and_then(as_number)
}

fn reset(w: &Value) -> Option<String> {
    alias(w, &["resets_at", "resetsAt"]).and_then(super::normalize::iso_timestamp)
}

fn upper_trim(v: &str) -> Option<String> {
    let s = v.trim().to_uppercase();
    (!s.is_empty()).then_some(s)
}

/// `{amount_minor, exponent, currency}` → (金額, 幣別)。
fn money(v: Option<&Value>) -> Option<(f64, Option<String>)> {
    let v = v?;
    let minor = alias(v, &["amount_minor", "amountMinor"]).and_then(Value::as_f64)?;
    let scale = v
        .get("exponent")
        .and_then(Value::as_f64)
        .filter(|e| e.is_finite())
        .map(|e| 10f64.powf(e))
        .unwrap_or(100.0);
    let currency = v
        .get("currency")
        .and_then(Value::as_str)
        .and_then(upper_trim);
    Some((minor / scale, currency))
}

/// 額外用量（usage credits）窗口；沒開就沒有（上游 L:448-510）。
fn credits_window(u: &Value) -> Option<LimitWindow> {
    let spend = u.get("spend");
    let extra = alias(u, &["extra_usage", "extraUsage"]);
    let enabled = spend.and_then(|s| s.get("enabled")) == Some(&Value::Bool(true))
        || extra.and_then(|e| alias(e, &["is_enabled", "isEnabled"])) == Some(&Value::Bool(true));
    if !enabled {
        return None;
    }
    let xmoney = |key: &str| -> Option<f64> {
        let e = extra?;
        let raw = e.get(key).and_then(Value::as_f64)?;
        let places = alias(e, &["decimal_places", "decimalPlaces"])
            .and_then(Value::as_f64)
            .filter(|p| p.is_finite() && *p >= 0.0)
            .unwrap_or(2.0);
        Some(raw / 10f64.powf(places))
    };
    let used_money = money(spend.and_then(|s| s.get("used")));
    let used = used_money
        .as_ref()
        .map(|m| m.0)
        .or_else(|| xmoney("used_credits"))?;
    let limit = money(spend.and_then(|s| s.get("limit")))
        .map(|m| m.0)
        .or_else(|| xmoney("monthly_limit"));
    let currency = used_money.and_then(|m| m.1).or_else(|| {
        extra
            .and_then(|e| e.get("currency"))
            .and_then(Value::as_str)
            .and_then(upper_trim)
            .or_else(|| Some("USD".into()))
    });
    let mut w = LimitWindow::new(WindowKind::Billing);
    w.metric = Some("spend".into());
    w.label = "Usage credits".into();
    w.used = Some(used);
    w.limit = limit;
    w.currency = currency;
    w.show_meter = limit.is_some();
    Some(w)
}

/// 上游 `mapClaudeUsageToProvider` 的窗口部分。
pub fn map_usage(u: &Value) -> Vec<LimitWindow> {
    let mut windows = Vec::new();
    let mut push = |kind, w: &Value, label: String| {
        let mut win = LimitWindow::new(kind);
        win.label = label;
        win.used_percent = percent(w);
        win.resets_at = reset(w);
        windows.push(win);
    };
    if let Some(s) = alias(u, &["five_hour", "fiveHour"]).filter(|v| *v != &Value::Bool(false)) {
        push(WindowKind::Session, s, String::new());
    }
    if let Some(w) = alias(u, &["seven_day", "sevenDay"]).filter(|v| *v != &Value::Bool(false)) {
        push(WindowKind::Weekly, w, String::new());
    }
    // 只有 Fable 的 weekly_scoped 會變成窗口（上游刻意丟掉其他模型的 scoped weekly）。
    if let Some(entries) = u.get("limits").and_then(Value::as_array) {
        let fable = entries.iter().find(|e| {
            e.get("kind").and_then(Value::as_str) == Some("weekly_scoped")
                && e.pointer("/scope/model/display_name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| n.trim().eq_ignore_ascii_case("fable"))
        });
        if let Some(e) = fable {
            let label = e
                .pointer("/scope/model/display_name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            push(WindowKind::Weekly, e, label);
        }
    }
    if let Some(c) = credits_window(u) {
        windows.push(c);
    }
    windows
}

struct CachedIdentity {
    identity: Identity,
    resolved_at: Instant,
}

/// Claude provider：身分快取跨 probe 保留（每小時最多問一次 profile）。
pub struct ClaudeProvider {
    identities: Mutex<HashMap<String, CachedIdentity>>,
    order: Mutex<Vec<String>>,
}

impl Default for ClaudeProvider {
    fn default() -> Self {
        ClaudeProvider {
            identities: Mutex::new(HashMap::new()),
            order: Mutex::new(Vec::new()),
        }
    }
}

fn fingerprint(c: &ClaudeCreds) -> String {
    let secret = c.refresh_token.as_deref().unwrap_or(&c.access_token);
    hash_key(&["claude-oauth-identity-cache", c.source.name(), secret])
}

fn now_iso() -> String {
    crate::wire::time::iso_millis(chrono::Utc::now())
}

impl ClaudeProvider {
    fn cache_put(&self, key: String, identity: Identity) {
        let mut map = self.identities.lock().unwrap();
        let mut order = self.order.lock().unwrap();
        // 上游的怪癖：同一把 key 已有身分時沿用舊的 accountKey（避免 profile 換欄位時跳帳號）。
        let identity = match map.get(&key) {
            Some(old) => Identity {
                account_key: old.identity.account_key.clone(),
                ..identity
            },
            None => identity,
        };
        map.insert(
            key.clone(),
            CachedIdentity {
                identity,
                resolved_at: Instant::now(),
            },
        );
        order.retain(|k| k != &key);
        order.push(key);
        while order.len() > IDENTITY_CACHE_MAX {
            let old = order.remove(0);
            map.remove(&old);
        }
    }

    /// token 輪替後，把舊指紋的身分帶到新指紋（上游 L:933-939）。
    fn carry(&self, before: &ClaudeCreds, after: &ClaudeCreds) {
        let (old, new) = (fingerprint(before), fingerprint(after));
        if old == new {
            return;
        }
        let entry = self
            .identities
            .lock()
            .unwrap()
            .get(&old)
            .map(|c| c.identity.clone());
        if let Some(identity) = entry {
            self.cache_put(new, identity);
        }
    }

    async fn refresh(
        &self,
        http: &reqwest::Client,
        env: &ClaudeEnv,
        creds: &ClaudeCreds,
    ) -> Result<ClaudeCreds, ProbeError> {
        if env.is_macos {
            // 上游在 macOS 交給 Claude Code 自己換（`claude /status`）；v1 只重讀，換了就用。
            let again = read_credentials(env)?;
            if again.access_token != creds.access_token {
                return Ok(again);
            }
            return Err(ProbeError::new(
                ProviderStatus::Unauthorized,
                "Claude Code did not refresh the OAuth token",
            ));
        }
        let Some(rt) = creds.refresh_token.clone() else {
            return Err(ProbeError::new(
                ProviderStatus::Unauthorized,
                "No refresh token available",
            ));
        };
        let resp = http
            .post(TOKEN_URL)
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(REQUEST_TIMEOUT)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", rt.as_str()),
                ("client_id", CLIENT_ID),
            ])
            .send()
            .await
            .map_err(|e| {
                ProbeError::new(ProviderStatus::Unavailable, format!("oauth/token: {e}"))
            })?;
        let code = resp.status().as_u16();
        if !resp.status().is_success() {
            let status = match code {
                400 | 401 => ProviderStatus::Unauthorized,
                429 => ProviderStatus::SourceRateLimited,
                _ => ProviderStatus::Unavailable,
            };
            return Err(ProbeError {
                status,
                message: format!("oauth/token HTTP {code}"),
                http_status: Some(code),
                retry_after: None,
            });
        }
        let json: Value = resp.json().await.map_err(|e| {
            ProbeError::new(
                ProviderStatus::Unavailable,
                format!("oauth/token JSON: {e}"),
            )
        })?;
        let access = truthy_string(json.get("access_token")).ok_or_else(|| {
            ProbeError::new(
                ProviderStatus::Unauthorized,
                "oauth/token returned no access token",
            )
        })?;
        let expires_in = json
            .get("expires_in")
            .and_then(Value::as_f64)
            .filter(|v| *v > 0.0)
            .unwrap_or(3600.0)
            .max(60.0);
        let next = ClaudeCreds {
            access_token: access,
            refresh_token: truthy_string(json.get("refresh_token")).or(Some(rt)),
            expires_at: Some(chrono::Utc::now().timestamp_millis() + (expires_in * 1000.0) as i64),
            ..creds.clone()
        };
        if let CredSource::File { path, root_shape } = &next.source {
            write_back(path, *root_shape, &next);
        }
        self.carry(creds, &next);
        Ok(next)
    }

    async fn usage(http: &reqwest::Client, creds: &ClaudeCreds) -> Result<Value, ProbeError> {
        let req = http
            .get(USAGE_URL)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::USER_AGENT, USAGE_USER_AGENT)
            .header("anthropic-beta", "oauth-2025-04-20")
            .bearer_auth(&creds.access_token)
            .timeout(REQUEST_TIMEOUT);
        fetch_json(req, "oauth/usage", FetchOptions::default()).await
    }

    /// 身分：新鮮的快取直接用；否則問 profile，失敗時退回舊快取。
    /// 回傳的錯誤帶著 profile 自己的狀態（unauthorized 時呼叫端會換 token 再試）。
    async fn identity(
        &self,
        http: &reqwest::Client,
        creds: &ClaudeCreds,
    ) -> Result<Identity, ProbeError> {
        let key = fingerprint(creds);
        let cached = self
            .identities
            .lock()
            .unwrap()
            .get(&key)
            .map(|c| (c.identity.clone(), c.resolved_at.elapsed() <= IDENTITY_TTL));
        if let Some((identity, true)) = &cached {
            return Ok(identity.clone());
        }
        let req = http
            .get(PROFILE_URL)
            .header(reqwest::header::ACCEPT, "application/json")
            .bearer_auth(&creds.access_token)
            .timeout(REQUEST_TIMEOUT);
        match fetch_json(req, "oauth/profile", FetchOptions::default()).await {
            Ok(profile) => match identity_from_profile(&profile) {
                Some(identity) => {
                    self.cache_put(key.clone(), identity);
                    Ok(self.identities.lock().unwrap()[&key].identity.clone())
                }
                None => cached.map(|c| c.0).ok_or_else(|| {
                    ProbeError::new(ProviderStatus::Unavailable, "Claude identity unavailable")
                }),
            },
            Err(e) => match cached {
                Some((identity, _)) => Ok(identity),
                None => Err(e),
            },
        }
    }

    /// 一次完整的 probe（上游 `fetchClaudeLimits` 的 OAuth 部分）。
    pub async fn probe(
        &self,
        http: &reqwest::Client,
        env: &ClaudeEnv,
    ) -> Result<LimitProvider, ProbeError> {
        let started = now_iso();
        let mut creds = read_credentials(env)?;
        let now_ms = chrono::Utc::now().timestamp_millis();
        if !env.is_macos
            && creds.refresh_token.is_some()
            && creds
                .expires_at
                .is_some_and(|e| e - now_ms < REFRESH_LEEWAY_MS)
        {
            match self.refresh(http, env, &creds).await {
                Ok(next) => creds = next,
                Err(e) => tracing::info!(error = %e, "proactive Claude token refresh failed"),
            }
        }
        let usage = match Self::usage(http, &creds).await {
            Err(e) if e.status == ProviderStatus::Unauthorized => {
                creds = self.refresh(http, env, &creds).await?;
                Self::usage(http, &creds).await?
            }
            other => other?,
        };
        let identity = match self.identity(http, &creds).await {
            Err(e) if e.status == ProviderStatus::Unauthorized => {
                creds = self.refresh(http, env, &creds).await?;
                self.identity(http, &creds).await.map_err(|e| ProbeError {
                    status: ProviderStatus::Unavailable,
                    ..e
                })?
            }
            Err(e) => {
                return Err(ProbeError {
                    status: ProviderStatus::Unavailable,
                    ..e
                })
            }
            Ok(identity) => identity,
        };
        Ok(finish_provider(LimitProvider {
            account_key: identity.account_key,
            account_label: creds.account_label.clone(),
            account_name: identity.account_name,
            account_email: identity.account_email,
            source: "oauth".into(),
            windows: map_usage(&usage),
            ..LimitProvider::status_row("claude", ProviderStatus::Ok, started)
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_env(dir: &Path) -> ClaudeEnv {
        ClaudeEnv {
            oauth_token: None,
            config_dir: dir.to_path_buf(),
            usernames: vec!["Javis".into()],
            use_wincred: false,
            read_wincred: Box::new(|_| None),
            read_keychain: Box::new(|| None),
            is_macos: false,
        }
    }

    #[test]
    fn identity_matches_upstream_hashes() {
        let profile = json!({
            "account": {"uuid": "account-default", "email": "Owner@Example.com"},
            "organization": {"uuid": "organization-default", "name": "Example Workspace"}
        });
        let id = identity_from_profile(&profile).unwrap();
        assert_eq!(
            id.account_key,
            "sha256:39fb83bb250916372e0d955cccff7a0b5ffeb55a5904200806fabcd1329caf63"
        );
        assert_eq!(id.account_email, "owner@example.com");
        assert_eq!(id.account_name, "Example Workspace");
        let org_only =
            identity_from_profile(&json!({"organization": {"uuid": "organization-default"}}))
                .unwrap();
        assert_eq!(
            org_only.account_key,
            "sha256:0a379fe0a6b230deb7cc4143a00c5f0b4445a38c30cbd804bd8bae430c0a770d"
        );
        let email_only = identity_from_profile(&json!({"email": "owner@example.com"})).unwrap();
        assert_eq!(
            email_only.account_key,
            "sha256:17a1cfaa38eacf472cc393852b127fc54f7e484154354e3bfcd52c6524a0734d"
        );
        assert!(identity_from_profile(&json!({})).is_none());
    }

    #[test]
    fn usage_maps_like_upstream_fable_example() {
        let u = json!({
            "five_hour": {"utilization": 96, "resets_at": "2026-07-02T14:00:00Z"},
            "seven_day": {"utilization": 22, "resets_at": "2026-07-03T10:00:00Z"},
            "seven_day_opus": {"utilization": 50},
            "limits": [
                {"kind": "weekly_all", "percent": 22},
                {"kind": "weekly_scoped", "percent": 3, "scope": {"model": {"display_name": "Opus"}}},
                {"kind": "weekly_scoped", "percent": 1, "resets_at": "2026-07-03T09:59:59Z", "scope": {"model": {"id": null, "display_name": "Fable"}}}
            ]
        });
        let p = finish_provider(LimitProvider {
            windows: map_usage(&u),
            ..LimitProvider::status_row("claude", ProviderStatus::Ok, "t".into())
        });
        let got: Vec<_> = p
            .windows
            .iter()
            .map(|w| {
                (
                    w.kind,
                    w.label.as_str(),
                    w.used_percent,
                    w.remaining_percent,
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
                    Some(96.0),
                    Some(4.0),
                    Some("2026-07-02T14:00:00.000Z")
                ),
                (
                    WindowKind::Weekly,
                    "",
                    Some(22.0),
                    Some(78.0),
                    Some("2026-07-03T10:00:00.000Z")
                ),
                (
                    WindowKind::Weekly,
                    "Fable",
                    Some(1.0),
                    Some(99.0),
                    Some("2026-07-03T09:59:59.000Z")
                ),
            ]
        );
        assert!(p.windows.iter().all(|w| w.window_minutes.is_none()));
    }

    #[test]
    fn usage_credits_follow_spend_or_extra_usage() {
        let metered = json!({
            "five_hour": {"utilization": 30, "resets_at": "2026-07-27T10:50:00.800650+00:00"},
            "extra_usage": {"is_enabled": true, "monthly_limit": 2000, "used_credits": 235, "currency": "USD", "decimal_places": 2},
            "spend": {"enabled": true, "used": {"amount_minor": 235, "currency": "USD", "exponent": 2}, "limit": {"amount_minor": 2000, "currency": "USD", "exponent": 2}, "percent": 12}
        });
        let windows: Vec<_> = map_usage(&metered)
            .into_iter()
            .map(super::super::normalize::finish_window)
            .collect();
        let credits = windows
            .iter()
            .find(|w| w.metric.as_deref() == Some("spend"))
            .unwrap();
        assert_eq!(credits.kind, WindowKind::Billing);
        assert_eq!(credits.label, "Usage credits");
        assert_eq!((credits.used, credits.limit), (Some(2.35), Some(20.0)));
        assert_eq!(credits.used_percent, Some(11.75));
        assert_eq!(credits.currency.as_deref(), Some("USD"));
        assert!(credits.show_meter);
        assert_eq!(
            windows[0].resets_at.as_deref(),
            Some("2026-07-27T10:50:00.800Z")
        );

        let unlimited = json!({"spend": {"enabled": true, "used": {"amount_minor": 235, "currency": "USD", "exponent": 2}, "limit": null}});
        let w = &map_usage(&unlimited)[0];
        assert_eq!((w.used, w.limit, w.show_meter), (Some(2.35), None, false));

        let jpy = json!({"extra_usage": {"is_enabled": true, "used_credits": 235, "monthly_limit": 2000, "currency": "jpy", "decimal_places": 0}});
        let w = &map_usage(&jpy)[0];
        assert_eq!(
            (w.used, w.limit, w.currency.as_deref()),
            (Some(235.0), Some(2000.0), Some("JPY"))
        );

        assert!(
            map_usage(&json!({"extra_usage": {"is_enabled": false, "used_credits": 5}})).is_empty()
        );
        assert!(
            map_usage(&json!({"five_hour": null})).is_empty(),
            "null suppresses a window"
        );
    }

    #[test]
    fn credentials_file_then_wincred() {
        let dir = tempfile::tempdir().unwrap();
        let env = test_env(dir.path());
        assert_eq!(
            read_credentials(&env).unwrap_err().status,
            ProviderStatus::NotConfigured
        );

        std::fs::write(
            dir.path().join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"at","refreshToken":"rt","expiresAt":1753500000000,"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}"#,
        )
        .unwrap();
        let c = read_credentials(&env).unwrap();
        assert_eq!(c.access_token, "at");
        assert_eq!(c.refresh_token.as_deref(), Some("rt"));
        assert_eq!(c.expires_at, Some(1_753_500_000_000));
        assert_eq!(c.account_label, "Max 20x");
        assert!(matches!(
            c.source,
            CredSource::File {
                root_shape: false,
                ..
            }
        ));

        // 秒數也接受。
        std::fs::write(
            dir.path().join(".credentials.json"),
            r#"{"accessToken":"x","expiresAt":1753500000}"#,
        )
        .unwrap();
        let c = read_credentials(&env).unwrap();
        assert_eq!(c.expires_at, Some(1_753_500_000_000));
        assert!(matches!(
            c.source,
            CredSource::File {
                root_shape: true,
                ..
            }
        ));
    }

    #[test]
    fn wincred_blobs_decode_both_encodings() {
        let json = r#"{"claudeAiOauth":{"accessToken":"credential-manager-token","subscriptionType":"max","rateLimitTier":"default_claude_max_5x"}}"#;
        assert_eq!(decode_blob(format!("{json}\0").as_bytes()), json);
        let mut utf16 = vec![0xFF, 0xFE];
        for u in json.encode_utf16() {
            utf16.extend(u.to_le_bytes());
        }
        assert_eq!(decode_blob(&utf16), json);
        // 沒有 BOM 的 UTF-16：上游會失敗，我們兩種都試。
        let bare: Vec<u8> = json.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(decode_blob(&bare), json);

        let dir = tempfile::tempdir().unwrap();
        let mut env = test_env(dir.path());
        env.use_wincred = true;
        let blob = json.as_bytes().to_vec();
        env.read_wincred =
            Box::new(move |t| (t == "Claude Code-credentials:Javis").then(|| blob.clone()));
        let c = read_credentials(&env).unwrap();
        assert_eq!(c.source, CredSource::WinCred);
        assert_eq!(c.account_label, "Max 5x");
        assert_eq!(
            wincred_targets(&["Javis".to_string()]),
            vec![
                "Claude Code-credentials",
                "Claude Code-credentials:Javis",
                "Claude Code-credentials/Javis"
            ]
        );
    }

    #[test]
    fn write_back_keeps_other_keys_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".credentials.json");
        std::fs::write(&path, r#"{"claudeAiOauth":{"accessToken":"old","refreshToken":"r0","expiresAt":1,"scopes":["a"],"subscriptionType":"max"},"other":true}"#).unwrap();
        let creds = ClaudeCreds {
            source: CredSource::File {
                path: path.clone(),
                root_shape: false,
            },
            access_token: "new".into(),
            refresh_token: Some("r1".into()),
            expires_at: Some(99),
            account_label: String::new(),
        };
        write_back(&path, false, &creds);
        let text = std::fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["claudeAiOauth"]["accessToken"], "new");
        assert_eq!(v["claudeAiOauth"]["refreshToken"], "r1");
        assert_eq!(v["claudeAiOauth"]["expiresAt"], 99);
        assert_eq!(v["claudeAiOauth"]["scopes"], json!(["a"]));
        assert_eq!(v["other"], true);
        let keys: Vec<_> = v["claudeAiOauth"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(
            keys,
            vec![
                "accessToken",
                "refreshToken",
                "expiresAt",
                "scopes",
                "subscriptionType"
            ]
        );
    }
}
