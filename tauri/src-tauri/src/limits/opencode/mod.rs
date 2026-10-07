//! OpenCode 的額度：Go 訂閱的 5 小時／每週／每月額度與 Zen 的預付餘額
//! （上游 src/shared/providers/opencode/limits.js 的逐條移植）。
//!
//! 來源（`api.rs`、`web.rs`、`local.rs`）：
//! - **API key**：Go 的官方用量 API。key 可以是設定頁貼的（OS 認證管理員，`secrets::OPENCODE_API_KEY`），
//!   或 OpenCode 自己存在 auth.json 的（「自動偵測」，`opencodeAmbientEnabled`，預設開）。
//! - **cookie**：opencode.ai 的登入 cookie（設定頁貼上，`secrets::OPENCODE_COOKIE`，或
//!   `TOKEN_MONITOR_OPENCODE_COOKIE`），抓 Go 頁面的額度與 Zen 的窗口、餘額，也提供 workspace 身分。
//! - **本機估算**：OpenCode 的資料庫（`opencodeLocalLimitsEnabled`，預設關）。
//!
//! 帳號：上游的一個帳號是一個名字，名字底下可以有 API key 與 cookie（使用者自己宣告它們是同一個帳號，
//! 才能 Go 額度讀 key、身分與餘額讀 cookie）。這裡存的 key 與 cookie 就是名為 `default` 的那個帳號
//! （上游舊版單一 cookie 遷移後的名字）；環境變數的 cookie 是 `default (env)`；沒被任何帳號認領的
//! 自動偵測 key 是 `Auto-detected`。只有一個帳號時與上游的單帳號路徑完全相同。
//! **v1 每個 provider 只發佈一列**（runtime 與額度分頁都以 provider 為單位），有兩個以上帳號時只發佈
//! 第一個（依上面的順序），用上游多帳號時那一列的算法（`fetchOpenCodeProfile`）；其他帳號設定頁會提示。
//!
//! raw 憑證只在 Rust 端：設定頁只拿得到「有沒有」的布林值。

pub mod api;
pub mod local;
pub mod transport;
pub mod web;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

use self::api::GoApi;
use self::local::GoLocal;
use self::transport::{js_iso, js_space, Transport};
use self::web::{GoWeb, Zen};
use super::hash::hash_key;
use super::http::ProbeError;
use super::normalize::{finish_provider, window_label};
use crate::wire::{LimitProvider, LimitWindow, ProviderStatus, WindowKind};

/// OpenCode 自己存的 key 在還沒被命名前的帳號名稱。wire 上是英文原文（別的語系的裝置也會讀到），
/// 前端再翻譯（上游 `OPENCODE_AMBIENT_ACCOUNT_NAME`）。
pub const AMBIENT_ACCOUNT_NAME: &str = "Auto-detected";
/// 設定頁存的憑證所屬的帳號名稱。
pub const STORED_ACCOUNT_NAME: &str = "default";
pub const ENV_ACCOUNT_NAME: &str = "default (env)";
/// 上游 `OPENCODE_COMPONENT_PROVENANCE_DETAIL`。
const SOURCE_DETAIL: &str = "managed";
/// 上游 `PROFILE_TIMEOUT_MS`（多帳號時每個帳號的探測上限），也是每個請求的逾時。
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// 探測需要的環境變數（測試可以注入）。
#[derive(Debug, Clone, Default)]
pub struct OpencodeEnv {
    vars: HashMap<String, String>,
    /// `os.homedir()`：`HOME` 與 `USERPROFILE` 都沒有時才用。
    pub home: PathBuf,
}

const ENV_KEYS: &[&str] = &[
    "TOKEN_MONITOR_OPENCODE_API_KEY",
    "TOKEN_MONITOR_OPENCODE_COOKIE",
    "TOKEN_MONITOR_OPENCODE_WORKSPACE_ID",
    "TOKEN_MONITOR_OPENCODE_GO_LIMITS",
    "OPENCODE_AUTH_CONTENT",
    "OPENCODE_DB",
    "XDG_DATA_HOME",
    "HOME",
    "USERPROFILE",
];

impl OpencodeEnv {
    pub fn from_process() -> OpencodeEnv {
        OpencodeEnv {
            vars: ENV_KEYS
                .iter()
                .filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v)))
                .collect(),
            home: dirs::home_dir().unwrap_or_default(),
        }
    }

    pub fn from_pairs(pairs: &[(&str, &str)], home: &Path) -> OpencodeEnv {
        OpencodeEnv {
            vars: pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            home: home.to_path_buf(),
        }
    }

    /// 沒設定是空字串（與 JS 的 `env.X || ''` 相同）。
    pub fn var(&self, key: &str) -> &str {
        self.vars.get(key).map(String::as_str).unwrap_or("")
    }
}

/// 設定裡與 OpenCode 有關的開關（`LimitsConfig` 帶著）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeOptions {
    /// 追蹤 OpenCode 自己存的 key（上游 `opencodeAmbientEnabled`，預設開）。
    pub ambient_enabled: bool,
    /// 沒有線上數字時以本機資料庫估算 Go 額度（上游 `opencodeLocalLimitsEnabled`，預設關）。
    pub local_limits_enabled: bool,
    /// tm-agent：上游 agent 把 `TOKEN_MONITOR_OPENCODE_COOKIE` 當成舊版的單一 cookie（帳號名 `default`）。
    pub headless: bool,
}

impl Default for OpencodeOptions {
    fn default() -> Self {
        OpencodeOptions {
            ambient_enabled: true,
            local_limits_enabled: false,
            headless: false,
        }
    }
}

impl OpencodeOptions {
    pub fn from_settings(settings: &crate::settings::Settings) -> OpencodeOptions {
        OpencodeOptions {
            ambient_enabled: settings.opencode_ambient_enabled,
            local_limits_enabled: settings.opencode_local_limits_enabled,
            headless: false,
        }
    }
}

/// 設定頁存的憑證（OS 認證管理員）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Credentials {
    pub api_key: String,
    pub cookie: String,
}

impl Credentials {
    pub fn load() -> Credentials {
        Credentials {
            api_key: crate::secrets::get(crate::secrets::OPENCODE_API_KEY).unwrap_or_default(),
            cookie: crate::secrets::get(crate::secrets::OPENCODE_COOKIE).unwrap_or_default(),
        }
    }
}

/// 一個帳號與它的憑證（上游 `cookies` 陣列的一項）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Entry {
    pub name: String,
    pub api_key: String,
    pub cookie: String,
    pub ambient: bool,
}

/// 上游 `fetchOpenCodeLimits` 開頭的帳號清單：設定的帳號 → 環境變數的 cookie（已在帳號裡的不重複）
/// → 沒被認領、也沒被關掉的自動偵測 key。存的 key 與自動偵測的 key 相同就算認領。
pub fn entries(
    stored: &Credentials,
    env_cookie: &str,
    ambient_key: &str,
    opts: &OpencodeOptions,
) -> Vec<Entry> {
    let mut out = Vec::new();
    if !stored.api_key.is_empty() || !stored.cookie.is_empty() {
        out.push(Entry {
            name: STORED_ACCOUNT_NAME.into(),
            api_key: stored.api_key.clone(),
            cookie: stored.cookie.clone(),
            ambient: false,
        });
    } else if opts.headless {
        let legacy = env_cookie.trim_matches(js_space);
        if !legacy.is_empty() {
            out.push(Entry {
                name: STORED_ACCOUNT_NAME.into(),
                cookie: legacy.into(),
                ..Entry::default()
            });
        }
    }
    if !env_cookie.is_empty() && !out.iter().any(|e| e.cookie == env_cookie) {
        out.push(Entry {
            name: ENV_ACCOUNT_NAME.into(),
            cookie: env_cookie.into(),
            ..Entry::default()
        });
    }
    let claimed = !ambient_key.is_empty() && stored.api_key == ambient_key;
    if !ambient_key.is_empty() && !claimed && opts.ambient_enabled {
        out.push(Entry {
            name: AMBIENT_ACCOUNT_NAME.into(),
            api_key: ambient_key.into(),
            ambient: true,
            ..Entry::default()
        });
    }
    out
}

fn kind_name(kind: WindowKind) -> &'static str {
    match kind {
        WindowKind::Session => "session",
        WindowKind::Daily => "daily",
        WindowKind::Weekly => "weekly",
        WindowKind::Billing => "billing",
    }
}

/// 上游 core.js `openCodeWindowKey`：正規化後的 `kind:metric:label`。
fn window_key(w: &LimitWindow) -> String {
    let metric = w
        .metric
        .as_deref()
        .map(|m| m.trim().to_lowercase())
        .filter(|m| matches!(m.as_str(), "credits" | "spend"))
        .unwrap_or_default();
    format!("{}:{metric}:{}", kind_name(w.kind), window_label(&w.label))
}

fn tagged(windows: &[LimitWindow], source: &str) -> Vec<LimitWindow> {
    windows
        .iter()
        .cloned()
        .map(|w| LimitWindow {
            source: Some(source.into()),
            ..w
        })
        .collect()
}

/// 上游 `openCodeSupplementalZenWindows`：Zen 的窗口只補 Go 沒有的種類。
fn supplemental_zen_windows(taken: &[LimitWindow], zen: &Zen) -> Vec<LimitWindow> {
    let keys: Vec<String> = taken.iter().map(window_key).collect();
    let extra: Vec<LimitWindow> = zen
        .windows
        .iter()
        .filter(|w| !keys.contains(&window_key(w)))
        .cloned()
        .collect();
    tagged(&extra, "web")
}

/// 上游 `openCodeZenBalanceWindow`：Zen 的預付餘額是一個 `credits` 窗口（沒有固定分母，不畫進度條），
/// 永遠排在最後；`balanceUsd` 欄位也照舊帶著給舊的 hub 與畫面。
fn zen_balance_window(balance: Option<f64>) -> Option<LimitWindow> {
    let amount = balance.filter(|b| b.is_finite())?;
    Some(LimitWindow {
        metric: Some("credits".into()),
        source: Some("web".into()),
        label: "Balance".into(),
        remaining: Some(amount),
        currency: Some("USD".into()),
        show_meter: false,
        ..LimitWindow::new(WindowKind::Billing)
    })
}

fn opencode_key(part: &str) -> String {
    hash_key(&["opencode", part])
}

fn cookie_account_key(cookie: &str) -> String {
    let digest = Sha256::digest(cookie.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    opencode_key(&format!("cookie:{}", &hex[..12]))
}

struct WebIdentity {
    account_key: String,
    aliases: Vec<String>,
    include_zen: bool,
}

/// 上游 `openCodeWebIdentity`：Go 與 Zen 解出不同的 workspace 時以 Go 為準、Zen 的觀測整個不用。
fn web_identity(go_web: Option<&GoWeb>, zen: Option<&Zen>, cookie: &str) -> WebIdentity {
    let ok = ProviderStatus::Ok;
    let go_ws = go_web
        .filter(|g| g.status == ok)
        .map(|g| g.workspace_id.clone())
        .unwrap_or_default();
    let zen_ws = zen
        .filter(|z| z.status == ok)
        .map(|z| z.workspace_id.clone())
        .unwrap_or_default();
    let conflict = !go_ws.is_empty() && !zen_ws.is_empty() && go_ws != zen_ws;
    let include_zen = zen.is_some_and(|z| z.status == ok) && !conflict;
    let success = go_web.is_some_and(|g| g.status == ok) || include_zen;
    let workspace_id = if !go_ws.is_empty() {
        go_ws
    } else if include_zen {
        zen_ws
    } else {
        String::new()
    };
    if success && !workspace_id.is_empty() {
        return WebIdentity {
            account_key: opencode_key(&format!("workspace:{workspace_id}")),
            aliases: vec![
                opencode_key(&format!("go:{workspace_id}")),
                opencode_key(&format!("zen:{workspace_id}")),
            ],
            include_zen,
        };
    }
    if !cookie.is_empty() && success {
        return WebIdentity {
            account_key: cookie_account_key(cookie),
            aliases: Vec::new(),
            include_zen,
        };
    }
    WebIdentity {
        account_key: String::new(),
        aliases: Vec::new(),
        include_zen,
    }
}

/// 這些狀態是「來源壞了、使用者該看到」；notConfigured 只是這個來源沒有東西。
fn remote_fail(status: ProviderStatus) -> bool {
    matches!(
        status,
        ProviderStatus::Unauthorized
            | ProviderStatus::SourceRateLimited
            | ProviderStatus::Unavailable
    )
}

fn row(updated_at: String) -> LimitProvider {
    LimitProvider {
        source_detail: SOURCE_DETAIL.into(),
        ..LimitProvider::status_row("opencode", ProviderStatus::NotConfigured, updated_at)
    }
}

/// 上游單帳號路徑：Go 額度依序取 API → Go 頁面 → 本機估算，再疊上 Zen。
fn assemble_single(
    primary: &Entry,
    go_api: &GoApi,
    go_web: Option<&GoWeb>,
    zen: Option<&Zen>,
    go_local: &GoLocal,
    updated_at: String,
) -> LimitProvider {
    let ok = ProviderStatus::Ok;
    let identity = web_identity(go_web, zen, &primary.cookie);
    let mut windows: Vec<LimitWindow> = Vec::new();
    let mut status = ProviderStatus::NotConfigured;
    let mut source = "local";
    let mut account_label = "";
    let mut account_key = String::new();
    let mut balance_usd = None;

    // API 的窗口標成 `web`：windows[].source 是 hub 排序用的兩值 enum，較舊的 hub 會丟掉不認得的值、
    // 再把它排在本機估算之後。更細的來源放在 provider 層的 source。
    if go_api.status == ok && !go_api.windows.is_empty() {
        windows.extend(tagged(&go_api.windows, "web"));
        status = ok;
        source = "api";
        account_label = "Go";
        account_key = opencode_key(if go_api.identity.is_empty() {
            "go-api"
        } else {
            &go_api.identity
        });
    } else if let Some(g) = go_web.filter(|g| g.status == ok && !g.windows.is_empty()) {
        windows.extend(tagged(&g.windows, "web"));
        status = ok;
        source = "web";
        account_label = "Go";
        account_key = opencode_key(&format!("go:{}", g.workspace_id));
    } else if go_local.status == ok && go_api.entitled != Some(false) {
        // 伺服器明確說沒有 Go 方案（entitled: false）時，本機估算會一直從取消前的紀錄推出額度，不能用。
        windows.extend(tagged(&go_local.windows, "local"));
        status = ok;
        account_label = "Go";
        account_key = opencode_key(if go_local.identity.is_empty() {
            "go"
        } else {
            &go_local.identity
        });
    } else if go_local.status == ProviderStatus::Unavailable && go_api.entitled != Some(false) {
        status = ProviderStatus::Unavailable;
    }

    match zen.filter(|_| identity.include_zen) {
        Some(zen) => {
            let supplemental = supplemental_zen_windows(&windows, zen);
            windows.extend(supplemental);
            status = ok;
            // 只有每個額度窗口都是 web 時 provider 層才能說 web（舊 hub 會把它當成所有窗口的來源）；
            // api 已經代表伺服器的數字，保留較強的說法。
            if source != "api" && !windows.iter().any(|w| w.source.as_deref() == Some("local")) {
                source = "web";
            }
            balance_usd = zen.balance_usd.filter(|b| b.is_finite());
            windows.extend(zen_balance_window(balance_usd));
            if account_label.is_empty() {
                account_label = "Zen";
            }
            if account_key.is_empty() {
                account_key = opencode_key(&format!("zen:{}", zen.workspace_id));
            }
        }
        None if status != ok => {
            // 沒有任何窗口時，過期的 key 不能看起來像「沒設定」：把壞掉的來源說出來。
            let surfaced = if remote_fail(go_api.status) {
                Some((go_api.status, "api"))
            } else if let Some(g) = go_web.filter(|g| remote_fail(g.status)) {
                Some((g.status, "web"))
            } else {
                zen.filter(|z| remote_fail(z.status))
                    .map(|z| (z.status, "web"))
            };
            if let Some((s, src)) = surfaced {
                status = s;
                source = src;
            }
        }
        None => {}
    }

    // 探測失敗的 API 仍然說得出是哪個帳號（身分來自 key），hub 上才找得到原來那一列。
    if account_key.is_empty() && !go_api.identity.is_empty() {
        account_key = opencode_key(&go_api.identity);
    }
    if !identity.account_key.is_empty() {
        account_key = identity.account_key.clone();
    }
    // cookie 的 workspace 身分優先時，key 自己的身分放進 aliases，只有 key 的裝置才併得進同一個帳號。
    let mut aliases = identity.aliases.clone();
    if !go_api.identity.is_empty() {
        aliases.push(opencode_key(&go_api.identity));
    }
    finish_provider(LimitProvider {
        account_name: primary.name.clone(),
        account_key,
        web_account_key: Some(identity.account_key),
        account_key_aliases: aliases,
        account_label: account_label.into(),
        source: source.into(),
        status,
        windows,
        balance_usd,
        ..row(updated_at)
    })
}

/// 上游 `fetchOpenCodeProfile` 成功（或各來源自己失敗）時的那一列：多帳號時每個帳號各一列。
fn assemble_profile(
    entry: &Entry,
    go_web: Option<&GoWeb>,
    zen: Option<&Zen>,
    go_api: Option<&GoApi>,
    updated_at: String,
) -> LimitProvider {
    let ok = ProviderStatus::Ok;
    let mut windows: Vec<LimitWindow> = Vec::new();
    let mut status = ProviderStatus::NotConfigured;
    let mut plan_label = "";
    let mut balance_usd = None;
    let mut source = "web";

    if let Some(a) = go_api.filter(|a| a.status == ok && !a.windows.is_empty()) {
        windows.extend(tagged(&a.windows, "web"));
        status = ok;
        plan_label = "Go";
        source = "api";
    } else if let Some(g) = go_web.filter(|g| g.status == ok && !g.windows.is_empty()) {
        windows.extend(tagged(&g.windows, "web"));
        status = ok;
        plan_label = "Go";
    }

    let identity = web_identity(go_web, zen, &entry.cookie);
    if let Some(zen) = zen.filter(|_| identity.include_zen) {
        let supplemental = supplemental_zen_windows(&windows, zen);
        windows.extend(supplemental);
        status = ok;
        if plan_label.is_empty() {
            plan_label = "Zen";
        }
        balance_usd = zen.balance_usd.filter(|b| b.is_finite());
        windows.extend(zen_balance_window(balance_usd));
    }

    if status != ok {
        // API 的 notConfigured（沒有 Go 方案）排在 cookie 的失敗之後：不能蓋掉過期的 cookie，
        // 但沒有 cookie 時它才是真正的答案。狀態與它的來源一起走。
        let (s, src) = if let Some(a) = go_api.filter(|a| remote_fail(a.status)) {
            (a.status, "api")
        } else if let Some(g) = go_web {
            (g.status, "web")
        } else if let Some(z) = zen {
            (z.status, "web")
        } else if let Some(a) = go_api {
            (a.status, "api")
        } else {
            let src = if !entry.api_key.is_empty() && entry.cookie.is_empty() {
                "api"
            } else {
                "web"
            };
            (ProviderStatus::Unauthorized, src)
        };
        status = s;
        source = src;
    }

    // 身分：workspace 優先，其次 key（每台裝置都是同一個字串），最後才是 cookie 的雜湊；絕不用名字。
    let key_identity = if entry.api_key.is_empty() {
        String::new()
    } else {
        opencode_key(&api::go_api_identity(&entry.api_key))
    };
    let mut account_key = if identity.account_key.is_empty() {
        key_identity.clone()
    } else {
        identity.account_key.clone()
    };
    if account_key.is_empty() && !entry.cookie.is_empty() {
        account_key = cookie_account_key(&entry.cookie);
    }
    let mut aliases = identity.aliases.clone();
    if account_key != key_identity {
        aliases.push(key_identity);
    }
    finish_provider(LimitProvider {
        account_key,
        // 只有 cookie 解得出 workspace 身分；把 key 的雜湊放這裡會讓只有 key 的裝置搶走合併帳號的正式身分。
        web_account_key: Some(identity.account_key),
        account_key_aliases: aliases,
        account_name: entry.name.clone(),
        // 舊的畫面只看 accountLabel，所以放帳號名稱；方案（Go / Zen）在 planLabel。
        account_label: entry.name.clone(),
        plan_label: plan_label.into(),
        source: source.into(),
        status,
        windows,
        balance_usd,
        ..row(updated_at)
    })
}

/// 上游 `fetchOpenCodeProfile` 逾時（15 秒）的那一列：沒有 webAccountKey（什麼都沒探測到）。
fn profile_timeout_row(entry: &Entry, updated_at: String) -> LimitProvider {
    let mut account_key = if entry.api_key.is_empty() {
        String::new()
    } else {
        opencode_key(&api::go_api_identity(&entry.api_key))
    };
    if account_key.is_empty() && !entry.cookie.is_empty() {
        account_key = cookie_account_key(&entry.cookie);
    }
    let source = if !entry.api_key.is_empty() && entry.cookie.is_empty() {
        "api"
    } else {
        "web"
    };
    finish_provider(LimitProvider {
        account_key,
        account_name: entry.name.clone(),
        account_label: entry.name.clone(),
        source: source.into(),
        status: ProviderStatus::Unavailable,
        ..row(updated_at)
    })
}

async fn cookie_probes<T: Transport>(
    t: &T,
    cookie: &str,
    env: &OpencodeEnv,
    now_ms: i64,
) -> (Option<GoWeb>, Option<Zen>) {
    if cookie.is_empty() {
        return (None, None);
    }
    let (go, zen) = tokio::join!(
        web::fetch_go_web(t, cookie, env, now_ms),
        web::fetch_zen(t, cookie, env, now_ms)
    );
    (Some(go), Some(zen))
}

/// 探測一次，回傳要發佈的那一列（可能不是 ok）與 Go API 要求的等待時間。
/// `go_local` 由呼叫端算好（只有單帳號而且開了本機估算時才需要讀資料庫）。
pub async fn collect<T: Transport>(
    t: &T,
    entries: &[Entry],
    env: &OpencodeEnv,
    now_ms: i64,
    go_local: &GoLocal,
) -> (LimitProvider, Option<Duration>) {
    if entries.len() > 1 {
        // v1 只發佈第一個帳號，用上游多帳號時那一列的算法。
        return probe_profile(t, &entries[0], env, now_ms).await;
    }
    let primary = entries.first().cloned().unwrap_or_default();
    let (go_api, (go_web, zen)) = tokio::join!(
        api::collect_go_api(t, &primary.api_key),
        cookie_probes(t, &primary.cookie, env, now_ms)
    );
    let row = assemble_single(
        &primary,
        &go_api,
        go_web.as_ref(),
        zen.as_ref(),
        go_local,
        js_iso(now_ms as f64).unwrap_or_default(),
    );
    (row, go_api.retry_after)
}

/// 多帳號時的一個帳號（上游 `fetchOpenCodeProfile`），整個探測最多 15 秒。
async fn probe_profile<T: Transport>(
    t: &T,
    entry: &Entry,
    env: &OpencodeEnv,
    now_ms: i64,
) -> (LimitProvider, Option<Duration>) {
    let updated_at = js_iso(now_ms as f64).unwrap_or_default();
    let probes = async {
        let api_probe = async {
            if entry.api_key.is_empty() {
                None
            } else {
                Some(api::collect_go_api(t, &entry.api_key).await)
            }
        };
        tokio::join!(cookie_probes(t, &entry.cookie, env, now_ms), api_probe)
    };
    match tokio::time::timeout(REQUEST_TIMEOUT, probes).await {
        Ok(((go_web, zen), go_api)) => {
            let retry_after = go_api.as_ref().and_then(|a| a.retry_after);
            let row = assemble_profile(
                entry,
                go_web.as_ref(),
                zen.as_ref(),
                go_api.as_ref(),
                updated_at,
            );
            (row, retry_after)
        }
        Err(_) => (profile_timeout_row(entry, updated_at), None),
    }
}

/// 正式探測（limits runtime 呼叫）：讀認證管理員與環境，探測，非 ok 的結果交給 runtime 的保留／退避規則。
pub async fn probe(
    http: &reqwest::Client,
    opts: &OpencodeOptions,
) -> Result<LimitProvider, ProbeError> {
    let env = OpencodeEnv::from_process();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let ambient = api::read_go_api_key(&env);
    let list = entries(
        &Credentials::load(),
        env.var("TOKEN_MONITOR_OPENCODE_COOKIE"),
        &ambient,
        opts,
    );
    if list.len() > 1 {
        tracing::debug!(
            accounts = list.len(),
            using = %list[0].name,
            "opencode: more than one account; v1 publishes only the first"
        );
    }
    // 資料庫是整台電腦的、沒有帳號身分，所以要明確開啟才讀；多帳號路徑上游本來就不讀。
    let go_local = if list.len() <= 1 && opts.local_limits_enabled {
        let env = env.clone();
        tokio::task::spawn_blocking(move || local::collect_go(&env, now_ms))
            .await
            .unwrap_or_else(|_| GoLocal::not_configured())
    } else {
        GoLocal::not_configured()
    };
    let transport = transport::ReqwestTransport {
        http,
        timeout: REQUEST_TIMEOUT,
    };
    let (row, retry_after) = collect(&transport, &list, &env, now_ms, &go_local).await;
    if row.status == ProviderStatus::Ok {
        return Ok(row);
    }
    Err(ProbeError {
        status: row.status,
        message: format!("opencode {:?} ({})", row.status, row.source),
        http_status: None,
        retry_after: retry_after.filter(|_| row.status == ProviderStatus::SourceRateLimited),
    })
}

/// 重放（`tm-agent limits --replay`）：`opencode-*.json` 的一個情境。
/// `{ mode: "single" | "profile", name, apiKey, cookie, ambientKey, ambientEnabled, envCookie,
///    localRows: [{createdMs, cost}], env: {…}, responses: {…} }`
pub async fn replay(v: &serde_json::Value, now_ms: i64) -> LimitProvider {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let pairs: Vec<(String, String)> = v
        .get("env")
        .and_then(|e| e.as_object())
        .map(|o| {
            o.iter()
                .map(|(k, x)| (k.clone(), x.as_str().unwrap_or("").to_string()))
                .collect()
        })
        .unwrap_or_default();
    let env = OpencodeEnv {
        vars: pairs.into_iter().collect(),
        home: PathBuf::new(),
    };
    let t = transport::FixtureTransport {
        responses: v
            .get("responses")
            .and_then(|r| r.as_object())
            .cloned()
            .unwrap_or_default(),
    };
    if s("mode") == "profile" {
        // 多帳號時的一列（上游 `fetchOpenCodeProfile`）。
        let entry = Entry {
            name: s("name"),
            api_key: s("apiKey"),
            cookie: s("cookie"),
            ambient: false,
        };
        return probe_profile(&t, &entry, &env, now_ms).await.0;
    }
    let opts = OpencodeOptions {
        ambient_enabled: v.get("ambientEnabled").and_then(|x| x.as_bool()) != Some(false),
        ..OpencodeOptions::default()
    };
    let stored = Credentials {
        api_key: s("apiKey"),
        cookie: s("cookie"),
    };
    let list = entries(&stored, &s("envCookie"), &s("ambientKey"), &opts);
    let go_local = match v.get("localRows") {
        Some(rows) => {
            let rows: Vec<local::GoRow> = serde_json::from_value(rows.clone()).unwrap_or_default();
            GoLocal {
                status: ProviderStatus::Ok,
                windows: local::build_windows(&rows, now_ms, local::go_limits(&env)),
                identity: "opencode-go:replay.db".into(),
            }
        }
        None => GoLocal::not_configured(),
    };
    collect(&t, &list, &env, now_ms, &go_local).await.0
}

// ---- 設定頁 ------------------------------------------------------------------------------

/// 設定頁看得到的狀態：只有布林值與來源名稱，沒有任何憑證內容。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub api_key: bool,
    pub cookie: bool,
    pub env_cookie: bool,
    /// 這台電腦上有 OpenCode 自己存的 Go key（auth.json 等）。
    pub ambient_detected: bool,
    /// 那把 key 與設定頁存的 key 相同（已經屬於設定的帳號）。
    pub ambient_claimed: bool,
    /// 額度正在讀哪一個帳號：`stored` / `env` / `ambient` / `none`。
    pub active: &'static str,
    /// 另外還有幾個帳號沒有發佈（v1 每個 provider 只發佈一列）。
    pub skipped: usize,
}

pub fn credential_status(opts: &OpencodeOptions) -> CredentialStatus {
    let env = OpencodeEnv::from_process();
    let stored = Credentials::load();
    let ambient = api::read_go_api_key(&env);
    let env_cookie = env.var("TOKEN_MONITOR_OPENCODE_COOKIE");
    let list = entries(&stored, env_cookie, &ambient, opts);
    let active = match list.first() {
        None => "none",
        Some(e) if e.ambient => "ambient",
        Some(e) if e.name == ENV_ACCOUNT_NAME => "env",
        // tm-agent 的舊版 cookie 也叫 default，但設定頁只在 GUI 顯示。
        Some(_) => "stored",
    };
    CredentialStatus {
        api_key: !stored.api_key.is_empty(),
        cookie: !stored.cookie.is_empty(),
        env_cookie: !env_cookie.is_empty(),
        ambient_detected: !ambient.is_empty(),
        ambient_claimed: !ambient.is_empty() && stored.api_key == ambient,
        active,
        skipped: list.len().saturating_sub(1),
    }
}

/// 儲存憑證前的檢查結果（上游 `opencode:saveProfile` 的錯誤分類）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SaveCheck {
    Saved,
    /// 空白或格式不對。
    Empty,
    /// OpenCode 拒絕（key 401，或 cookie 在 Go 與 Zen 都是 unauthorized）。
    Rejected,
    /// key 有效但那個帳號沒有 Go 訂閱（存了也永遠是空的）。
    NoSubscription,
    /// 連不上用量 API。
    Unreachable,
}

/// 上游：key 被拒絕、沒有 Go 方案、連不上都不存。
pub async fn check_api_key<T: Transport>(t: &T, key: &str) -> SaveCheck {
    let key = key.trim();
    if key.is_empty() {
        return SaveCheck::Empty;
    }
    match api::fetch_go_api(t, key).await.status {
        ProviderStatus::Ok => SaveCheck::Saved,
        ProviderStatus::Unauthorized => SaveCheck::Rejected,
        ProviderStatus::NotConfigured => SaveCheck::NoSubscription,
        _ => SaveCheck::Unreachable,
    }
}

/// 上游：只有 Go 與 Zen 都說 unauthorized（cookie 過期）才拒絕；連不上時照樣存。
pub async fn check_cookie<T: Transport>(t: &T, cookie: &str, env: &OpencodeEnv) -> SaveCheck {
    let cookie = web::sanitize_cookie_header(cookie);
    if cookie.is_empty() {
        return SaveCheck::Empty;
    }
    let now_ms = chrono::Utc::now().timestamp_millis();
    match cookie_probes(t, &cookie, env, now_ms).await {
        (Some(go), Some(zen)) if web::link_expired(&go, &zen) => SaveCheck::Rejected,
        _ => SaveCheck::Saved,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_767_225_600_000;

    fn fixture(responses: serde_json::Value) -> transport::FixtureTransport {
        transport::FixtureTransport {
            responses: responses.as_object().cloned().unwrap_or_default(),
        }
    }

    fn go_api_ok() -> serde_json::Value {
        json!({ "status": 200, "json": { "usage": {
            "rolling": { "percent": 30, "resetsAt": "2026-01-01T02:00:00Z" },
            "weekly": { "percent": 10, "resetsAt": "2026-01-05T00:00:00Z" },
            "monthly": { "percent": 5, "resetsAt": "2026-01-20T00:00:00Z" }
        } } })
    }

    fn env() -> OpencodeEnv {
        OpencodeEnv::from_pairs(&[], Path::new("."))
    }

    fn opts() -> OpencodeOptions {
        OpencodeOptions::default()
    }

    #[test]
    fn accounts_are_listed_like_upstream() {
        let none = Credentials::default();
        assert!(entries(&none, "", "", &opts()).is_empty());
        let only_ambient = entries(&none, "", "sk-amb", &opts());
        assert_eq!(only_ambient.len(), 1);
        assert_eq!(only_ambient[0].name, AMBIENT_ACCOUNT_NAME);
        assert!(
            entries(
                &none,
                "",
                "sk-amb",
                &OpencodeOptions {
                    ambient_enabled: false,
                    ..opts()
                }
            )
            .is_empty(),
            "the auto-detected key can be switched off"
        );
        let stored = Credentials {
            api_key: "sk-amb".into(),
            cookie: "auth=x".into(),
        };
        let claimed = entries(&stored, "auth=x", "sk-amb", &opts());
        assert_eq!(
            claimed.len(),
            1,
            "a stored copy of the key claims it; the env cookie is the same"
        );
        assert_eq!(claimed[0].name, STORED_ACCOUNT_NAME);
        let three = entries(
            &Credentials {
                cookie: "auth=x".into(),
                ..none.clone()
            },
            "auth=y",
            "sk-amb",
            &opts(),
        );
        let names: Vec<&str> = three.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            [STORED_ACCOUNT_NAME, ENV_ACCOUNT_NAME, AMBIENT_ACCOUNT_NAME]
        );
        let agent = entries(
            &none,
            " auth=y ",
            "",
            &OpencodeOptions {
                headless: true,
                ..opts()
            },
        );
        let names: Vec<(&str, &str)> = agent
            .iter()
            .map(|e| (e.name.as_str(), e.cookie.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                (STORED_ACCOUNT_NAME, "auth=y"),
                (ENV_ACCOUNT_NAME, " auth=y ")
            ],
            "the agent's legacy cookie is trimmed, the env comparison is not (upstream quirk)"
        );
    }

    #[tokio::test]
    async fn the_auto_detected_key_alone_reads_go_quota_from_the_api() {
        let t = fixture(json!({ "goApi": go_api_ok() }));
        let list = entries(&Credentials::default(), "", "sk-amb", &opts());
        let (row, _) = collect(&t, &list, &env(), NOW, &GoLocal::not_configured()).await;
        assert_eq!(row.status, ProviderStatus::Ok);
        assert_eq!(row.source, "api");
        assert_eq!(row.account_label, "Go");
        assert_eq!(row.account_name, "Auto-detected");
        let identity = api::go_api_identity("sk-amb");
        assert_eq!(row.account_key, opencode_key(&identity));
        assert!(
            row.account_key_aliases.is_empty(),
            "the alias equal to the key is dropped"
        );
        assert_eq!(row.web_account_key, None);
        let kinds: Vec<_> = row
            .windows
            .iter()
            .map(|w| (w.kind, w.source.as_deref()))
            .collect();
        assert_eq!(
            kinds,
            [
                (WindowKind::Session, Some("web")),
                (WindowKind::Weekly, Some("web")),
                (WindowKind::Billing, Some("web"))
            ]
        );
        assert_eq!(row.windows[0].remaining_percent, Some(70.0));
    }

    #[tokio::test]
    async fn a_cookie_adds_the_zen_balance_and_the_workspace_identity() {
        let t = fixture(json!({
            "goApi": go_api_ok(),
            "workspaces:GET": { "status": 200, "text": "[{id:\"wrk_ABC\",name:\"Team\"}]" },
            "goPage": { "status": 200, "text": "rollingUsage:{usagePercent:1,resetInSec:1},weeklyUsage:{usagePercent:2}" },
            "subscription:GET": { "status": 200, "text": "{\"rollingUsage\":{\"usagePercent\":55},\"balanceUSD\":20.75}" }
        }));
        let stored = Credentials {
            api_key: "sk-mine".into(),
            cookie: "auth=c".into(),
        };
        let list = entries(&stored, "", "", &opts());
        let (row, _) = collect(&t, &list, &env(), NOW, &GoLocal::not_configured()).await;
        assert_eq!(row.status, ProviderStatus::Ok);
        assert_eq!(row.source, "api", "the API outranks the Go page");
        assert_eq!(row.account_key, opencode_key("workspace:wrk_ABC"));
        assert_eq!(
            row.web_account_key.as_deref(),
            Some(row.account_key.as_str())
        );
        assert_eq!(row.account_key_aliases.len(), 3);
        assert_eq!(row.balance_usd, Some(20.75));
        let last = row.windows.last().unwrap();
        assert_eq!(last.metric.as_deref(), Some("credits"));
        assert_eq!(last.label, "Balance");
        assert_eq!(last.remaining, Some(20.75));
        assert!(!last.show_meter);
        assert_eq!(
            row.windows
                .iter()
                .filter(|w| w.kind == WindowKind::Session)
                .count(),
            1,
            "Zen's rolling window does not duplicate Go's"
        );
    }

    #[tokio::test]
    async fn an_expired_key_is_reported_not_hidden() {
        let t = fixture(json!({ "goApi": { "status": 401, "text": "" } }));
        let list = entries(&Credentials::default(), "", "sk-old", &opts());
        let (row, _) = collect(&t, &list, &env(), NOW, &GoLocal::not_configured()).await;
        assert_eq!(row.status, ProviderStatus::Unauthorized);
        assert_eq!(row.source, "api");
        assert_eq!(
            row.account_key,
            opencode_key(&api::go_api_identity("sk-old"))
        );

        let t = fixture(
            json!({ "goApi": { "status": 403, "json": { "error": { "type": "EntitlementError" } } } }),
        );
        let local = GoLocal {
            status: ProviderStatus::Ok,
            windows: vec![LimitWindow::new(WindowKind::Session)],
            identity: "opencode-go:x".into(),
        };
        let (row, _) = collect(&t, &list, &env(), NOW, &local).await;
        assert_eq!(
            row.status,
            ProviderStatus::NotConfigured,
            "no Go plan: the local estimate must not take over"
        );
        let t = fixture(json!({ "goApi": { "status": 403, "text": "blocked by WAF" } }));
        let (row, _) = collect(&t, &list, &env(), NOW, &local).await;
        assert_eq!(
            row.status,
            ProviderStatus::Ok,
            "a proxy's 403 leaves room for the estimate"
        );
        assert_eq!(row.windows[0].source.as_deref(), Some("local"));
        assert_eq!(row.source, "local");
    }

    #[tokio::test]
    async fn with_two_accounts_the_first_uses_the_profile_rules() {
        let t = fixture(json!({
            "workspaces:GET": { "status": 200, "text": "not signed in, please login" }
        }));
        let stored = Credentials {
            cookie: "auth=old".into(),
            ..Credentials::default()
        };
        let list = entries(&stored, "", "sk-amb", &opts());
        assert_eq!(list.len(), 2);
        let (row, _) = collect(&t, &list, &env(), NOW, &GoLocal::not_configured()).await;
        assert_eq!(row.status, ProviderStatus::Unauthorized);
        assert_eq!(row.account_name, STORED_ACCOUNT_NAME);
        assert_eq!(row.account_label, STORED_ACCOUNT_NAME);
        assert_eq!(row.source, "web");
        assert_eq!(row.account_key, cookie_account_key("auth=old"));
    }

    #[tokio::test]
    async fn saving_checks_follow_upstream() {
        let t = fixture(json!({ "goApi": { "status": 401 } }));
        assert_eq!(check_api_key(&t, " sk ").await, SaveCheck::Rejected);
        assert_eq!(check_api_key(&t, "  ").await, SaveCheck::Empty);
        let t = fixture(
            json!({ "goApi": { "status": 403, "json": { "error": { "type": "EntitlementError" } } } }),
        );
        assert_eq!(check_api_key(&t, "sk").await, SaveCheck::NoSubscription);
        let t = fixture(json!({ "goApi": { "throw": true } }));
        assert_eq!(check_api_key(&t, "sk").await, SaveCheck::Unreachable);
        let t = fixture(json!({ "goApi": go_api_ok() }));
        assert_eq!(check_api_key(&t, "sk").await, SaveCheck::Saved);

        let t = fixture(json!({ "workspaces:GET": { "status": 401 } }));
        assert_eq!(check_cookie(&t, "abc", &env()).await, SaveCheck::Rejected);
        let t = fixture(json!({ "workspaces:GET": { "throw": true } }));
        assert_eq!(
            check_cookie(&t, "abc", &env()).await,
            SaveCheck::Saved,
            "offline still saves"
        );
        assert_eq!(check_cookie(&t, " ; ", &env()).await, SaveCheck::Empty);
    }
}
