//! Antigravity 的額度：本機 language server 的 RPC（上游 src/shared/providers/antigravity/{probe,limits}.js）。
//!
//! - 找程序（`antigravity_os.rs` 列命令列，分類在這裡）：桌面版 / IDE 的 `language_server*` 必須帶
//!   `--csrf_token`；`agy` / `antigravity-cli` 的 language server 不用（`--hub` 模式除外）。來源優先序
//!   app → cli → ide，與 PID 順序無關；同一種來源的程序平行探測。
//! - 端點：`--hub-port`（明確，先試）→ 程序監聽的 port（HTTPS 再 HTTP）→ `--extension_server_port`（HTTP）。
//!   先以 `GetUnleashData` 預檢，任何 HTTP 回應都算連得到；預檢失敗只降低順序，不刪掉候選。
//! - 額度：`RetrieveUserQuotaSummary`（Gemini、Claude/GPT 兩組的 5 小時與每週）＋ `GetUserStatus` 的方案與 email；
//!   所有程序都拿不到分組額度時，才退回舊版的 `GetUserStatus.clientModelConfigs` 或 `GetCommandModelConfigs`，
//!   收斂成 Gemini Pro、Gemini Flash、Claude 三個池。
//! - 整次探測最多 8 秒（上游 `DEFAULT_PROBE_TIMEOUT_MS`），逾時是 unavailable。
//! - 本機 HTTPS 是自簽憑證：只有這個只連 `127.0.0.1` 的 client 略過憑證驗證，不影響其他任何連線。
//! - 上游的 Google 帳號（OAuth 登入、多帳號、IDE 沒開也能查）不在範圍內，只有本機 RPC 這條路。

use std::time::Duration;

use futures_util::future::{join_all, BoxFuture};
use futures_util::stream::{FuturesUnordered, StreamExt};
use serde_json::{json, Map, Value};
use tokio::time::Instant;

use super::antigravity_os;
use super::hash::hash_key;
use super::http::ProbeError;
use super::normalize::finish_provider;
use crate::usage::js::{to_js_string, truthy};
use crate::wire::{LimitProvider, LimitWindow, ProviderStatus, WindowKind};

/// 上游 `DEFAULT_PROBE_TIMEOUT_MS` / `DEFAULT_RPC_TIMEOUT_MS`。
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(8_000);
const RPC_TIMEOUT: Duration = Duration::from_millis(12_000);
/// 分組額度拿到之後，順便查方案與 email 最多等 1 秒。
const IDENTITY_TIMEOUT: Duration = Duration::from_millis(1_000);
const LS_SERVICE: &str = "exa.language_server_pb.LanguageServerService";
const MIN_WAIT: Duration = Duration::from_millis(1);

fn unavailable(message: impl Into<String>) -> ProbeError {
    ProbeError::new(ProviderStatus::Unavailable, message)
}

fn timeout_error() -> ProbeError {
    unavailable("Antigravity probe timed out")
}

// ---- 程序 ----------------------------------------------------------------------

/// 程序的來源。順序就是探測的優先序（上游 `PROCESS_KIND_ORDER`），也是 wire 的 `sourceDetail`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SourceKind {
    App,
    Cli,
    Ide,
}

impl SourceKind {
    const ORDER: [SourceKind; 3] = [SourceKind::App, SourceKind::Cli, SourceKind::Ide];

    pub fn as_str(self) -> &'static str {
        match self {
            SourceKind::App => "app",
            SourceKind::Cli => "cli",
            SourceKind::Ide => "ide",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: u32,
    pub kind: SourceKind,
    /// CLI 的 language server 沒有 token，是空字串。
    pub csrf_token: String,
    pub extension_port: Option<u16>,
    pub extension_csrf_token: Option<String>,
    pub hub_port: Option<u16>,
}

fn ends_token(rest: &str) -> bool {
    rest.chars().next().is_none_or(char::is_whitespace)
}

fn before_is(hay: &str, i: usize, ok: impl Fn(char) -> bool) -> bool {
    hay[..i].chars().next_back().is_none_or(ok)
}

/// `(?:[_-][a-z0-9]+)*(?:\.exe)?(\s|$)`：`language_server` 後面可以接 `_windows_x64`、`.exe`。
fn language_server_tail(mut rest: &str) -> bool {
    while let Some(tail) = rest.strip_prefix(['_', '-']) {
        let n = tail
            .bytes()
            .take_while(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            .count();
        if n == 0 {
            break;
        }
        rest = &tail[n..];
    }
    ends_token(rest) || rest.strip_prefix(".exe").is_some_and(ends_token)
}

/// 上游 `isLanguageServerCommand`：`(?:^|[\s/\\])language(?:_|-)server…`。
fn is_language_server_command(lower: &str) -> bool {
    ["language_server", "language-server"].iter().any(|needle| {
        lower.match_indices(needle).any(|(i, m)| {
            before_is(lower, i, |c| c.is_whitespace() || c == '/' || c == '\\')
                && language_server_tail(&lower[i + m.len()..])
        })
    })
}

/// 上游 `isAntigravityCommand`。
fn is_antigravity_command(lower: &str) -> bool {
    (lower.contains("--app_data_dir") && lower.contains("antigravity"))
        || lower.contains("/antigravity/")
        || lower.contains("\\antigravity\\")
        || lower.contains("/antigravity.app/")
}

/// 上游 `isHubModeCommand`：`(?:^|\s)--hub(?:\s|=|$)`。`--hub` 讓 CLI 變成對外的 RPC 服務，需要 CSRF token。
fn is_hub_mode_command(command: &str) -> bool {
    command.match_indices("--hub").any(|(i, m)| {
        before_is(command, i, char::is_whitespace)
            && command[i + m.len()..]
                .chars()
                .next()
                .is_none_or(|c| c.is_whitespace() || c == '=')
    })
}

/// 上游 `isAntigravityCliCommand`：`antigravity-cli` 目錄，或以路徑分隔字元開頭的 `agy`（`agy` 還要是
/// language server 或 hub 模式；互動的 agent session 不算）。
fn is_antigravity_cli_command(lower: &str) -> bool {
    let slash_before = |i: usize| before_is(lower, i, |c| c == '/' || c == '\\');
    let cli_dir = ["antigravity-cli", "antigravity_cli"].iter().any(|needle| {
        lower.match_indices(needle).any(|(i, m)| {
            slash_before(i)
                && lower[i + m.len()..]
                    .chars()
                    .next()
                    .is_none_or(|c| c.is_whitespace() || c == '/' || c == '\\')
        })
    });
    if cli_dir {
        return true;
    }
    let agy = lower.match_indices("agy").any(|(i, m)| {
        let rest = &lower[i + m.len()..];
        slash_before(i) && (ends_token(rest) || rest.strip_prefix(".exe").is_some_and(ends_token))
    });
    agy && (is_language_server_command(lower) || is_hub_mode_command(lower))
}

/// 上游 `isAntigravityIdeCommand`。
fn is_antigravity_ide_command(lower: &str) -> bool {
    [
        "antigravity ide.app/",
        "antigravity ide.app\\",
        "--app_data_dir antigravity-ide",
        "--app_data_dir=antigravity-ide",
        "/extensions/antigravity/bin/language_server",
        "\\extensions\\antigravity\\bin\\language_server",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

/// 上游 `antigravityProcessKind`：IDE 優先判斷，才保得住它需要 CSRF token 的規則。
pub fn process_kind(lower: &str) -> Option<SourceKind> {
    if is_language_server_command(lower) && is_antigravity_command(lower) {
        return Some(if is_antigravity_ide_command(lower) {
            SourceKind::Ide
        } else {
            SourceKind::App
        });
    }
    is_antigravity_cli_command(lower).then_some(SourceKind::Cli)
}

/// 上游 `commandForMatching`：`Win32_Process.CommandLine` 會把執行檔路徑包在引號裡；拆掉開頭那一對，
/// 比對才能繼續以路徑分隔字元與空白為界。後面帶引號的旗標值不動。
fn command_for_matching(command: &str) -> String {
    if let Some(rest) = command.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            let after = &rest[end + 1..];
            if end > 0 && ends_token(after) {
                return format!("{}{after}", &rest[..end]).to_lowercase();
            }
        }
    }
    command.to_lowercase()
}

/// 上游 `extractFlag`：`<flag>[=\s]+(\S+)`，旗標名稱不分大小寫。
fn extract_flag(flag: &str, command: &str) -> Option<String> {
    // ASCII 小寫不改變位元組位置，位移可以直接用在原字串上。
    let lower = command.to_ascii_lowercase();
    for (i, _) in lower.match_indices(&flag.to_ascii_lowercase()) {
        let rest = &command[i + flag.len()..];
        let value = rest.trim_start_matches(|c: char| c == '=' || c.is_whitespace());
        if value.len() == rest.len() {
            continue;
        }
        let end = value.find(char::is_whitespace).unwrap_or(value.len());
        if end > 0 {
            return Some(value[..end].to_string());
        }
    }
    None
}

fn extract_port_flag(flag: &str, command: &str) -> Option<u16> {
    extract_flag(flag, command)?
        .parse::<u16>()
        .ok()
        .filter(|p| *p > 0)
}

/// 上游 `parseProcessLine`：一個程序的命令列 → 候選。需要 token 卻沒有的回 `None`，讓後面合格的程序還能用。
pub fn process_info(pid: u32, command: &str) -> Option<ProcessInfo> {
    let command = command.trim();
    if pid == 0 || command.is_empty() {
        return None;
    }
    let kind = process_kind(&command_for_matching(command))?;
    let csrf_token = extract_flag("--csrf_token", command);
    if (kind != SourceKind::Cli || is_hub_mode_command(command)) && csrf_token.is_none() {
        return None;
    }
    Some(ProcessInfo {
        pid,
        kind,
        csrf_token: csrf_token.unwrap_or_default(),
        extension_port: extract_port_flag("--extension_server_port", command),
        extension_csrf_token: extract_flag("--extension_server_csrf_token", command),
        hub_port: extract_port_flag("--hub-port", command),
    })
}

/// 上游 `processInfosFromText` + `requireDetectedProcessInfos`：依來源、PID 排序。一個都沒有時，
/// 看到「應該有 token 卻沒有」的程序是 unavailable（設定有問題），否則 notConfigured（沒在執行）。
pub fn process_infos(entries: &[(u32, String)]) -> Result<Vec<ProcessInfo>, ProbeError> {
    let mut infos = Vec::new();
    let mut tokenless = false;
    for (pid, command) in entries {
        if let Some(info) = process_info(*pid, command) {
            infos.push(info);
            continue;
        }
        let command = command.trim();
        let lower = command_for_matching(command);
        let Some(kind) = process_kind(&lower) else {
            continue;
        };
        if extract_flag("--csrf_token", command).is_some() {
            continue;
        }
        if kind != SourceKind::Cli || is_hub_mode_command(&lower) {
            tokenless = true;
        }
    }
    infos.sort_by_key(|i| (i.kind, i.pid));
    if !infos.is_empty() {
        return Ok(infos);
    }
    Err(if tokenless {
        unavailable("Antigravity LS missing --csrf_token")
    } else {
        ProbeError::new(
            ProviderStatus::NotConfigured,
            "Antigravity language server not running",
        )
    })
}

// ---- 額度回應的解析 --------------------------------------------------------------

/// 上游 `parseResetTime`：數字大於 2e10 當毫秒、否則當秒；字串交給 JS 的日期解析。
fn parse_reset_time(v: Option<&Value>) -> Option<String> {
    use chrono::TimeZone;
    match v? {
        Value::Number(n) => {
            let f = n.as_f64()?;
            let ms = if f > 20_000_000_000.0 { f } else { f * 1000.0 };
            chrono::Utc
                .timestamp_millis_opt(ms.trunc() as i64)
                .single()
                .map(crate::wire::time::iso_millis)
        }
        Value::String(s) => crate::wire::time::parse_js_date(s).map(crate::wire::time::iso_millis),
        _ => None,
    }
}

/// `String(value || '').trim()`。
fn js_text(v: Option<&Value>) -> String {
    v.filter(|v| truthy(v))
        .map(to_js_string)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|f| f.is_finite())
}

/// 分組額度的一個窗口（上游 `quotaSummaryWindows` 的輸出）。
#[derive(Debug, Clone, PartialEq)]
pub struct QuotaWindow {
    pub kind: WindowKind,
    /// `Gemini 5-hour`、`Claude/GPT weekly`：前半是群組，畫面依此分組。
    pub name: String,
    pub remaining_fraction: Option<f64>,
    pub reset_time: Option<String>,
    pub reset_description: String,
    pub show_meter: bool,
}

/// 上游 `quotaGroupName`。
fn quota_group_name(display_name: Option<&Value>) -> String {
    let name = js_text(display_name);
    let lower = name.to_lowercase();
    if lower.contains("gemini") {
        "Gemini".into()
    } else if lower.contains("claude") || lower.contains("gpt") {
        "Claude/GPT".into()
    } else if name.is_empty() {
        "Quota".into()
    } else {
        name
    }
}

/// 上游 `quotaBucketKind`：依序看 `window`、`bucketId`、`displayName`（去掉結尾的 ` limit`）。
fn quota_bucket_kind(bucket: &Value) -> Option<WindowKind> {
    const SESSION: [&str; 5] = ["session", "5h", "5-hour", "five hour", "five-hour"];
    let mut candidates = Vec::new();
    for key in ["window", "bucketId", "displayName"] {
        let normalized = js_text(bucket.get(key)).to_lowercase().replace('_', "-");
        if normalized.is_empty() {
            continue;
        }
        let stripped = normalized.strip_suffix(" limit").map(str::to_string);
        candidates.push(normalized);
        candidates.extend(stripped);
    }
    for c in &candidates {
        if c == "weekly" || c.ends_with("-weekly") {
            return Some(WindowKind::Weekly);
        }
        if SESSION.contains(&c.as_str()) || SESSION.iter().any(|a| c.ends_with(&format!("-{a}"))) {
            return Some(WindowKind::Session);
        }
    }
    None
}

/// 上游 `quotaRemainingFraction`：`remainingFraction`、`remaining.remainingFraction` 或 protobuf oneof 的
/// `{ case: 'remainingFraction', value }`。
fn quota_remaining_fraction(bucket: &Value) -> Option<f64> {
    if let Some(f) = finite(bucket.get("remainingFraction")) {
        return Some(f);
    }
    let remaining = bucket.get("remaining");
    if let Some(f) = finite(remaining.and_then(|r| r.get("remainingFraction"))) {
        return Some(f);
    }
    if remaining
        .and_then(|r| r.get("case"))
        .and_then(Value::as_str)
        == Some("remainingFraction")
    {
        return finite(remaining.and_then(|r| r.get("value")));
    }
    None
}

/// 上游 `quotaSummaryWindows`：`RetrieveUserQuotaSummary` → 窗口，Gemini 先、Claude/GPT 次、同組 5 小時在前。
/// 停用的桶沒有數字、不畫長條。
pub fn quota_summary_windows(payload: &Value) -> Vec<QuotaWindow> {
    let summary = ["response", "summary"]
        .iter()
        .filter_map(|k| payload.get(k))
        .find(|v| truthy(v))
        .unwrap_or(payload);
    let empty = Vec::new();
    let groups = summary
        .get("groups")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let mut windows = Vec::new();
    for group in groups {
        let group_name = quota_group_name(group.get("displayName"));
        let buckets = group
            .get("buckets")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        for bucket in buckets {
            let Some(kind) = quota_bucket_kind(bucket) else {
                continue;
            };
            let fraction = quota_remaining_fraction(bucket);
            let disabled = bucket.get("disabled") == Some(&Value::Bool(true));
            let period = if kind == WindowKind::Session {
                "5-hour"
            } else {
                "weekly"
            };
            windows.push(QuotaWindow {
                kind,
                name: format!("{group_name} {period}"),
                remaining_fraction: if disabled { None } else { fraction },
                reset_time: parse_reset_time(bucket.get("resetTime")),
                reset_description: bucket
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                show_meter: !disabled && fraction.is_some(),
            });
        }
    }
    let group_rank = |name: &str| {
        if name.starts_with("Gemini ") {
            0
        } else if name.starts_with("Claude/GPT ") {
            1
        } else {
            2
        }
    };
    windows.sort_by_key(|w| (group_rank(&w.name), w.kind != WindowKind::Session));
    windows
}

/// 上游 `CC_MODEL_BLACKLIST`（源自 openusage / codexbar）：佔位與內部用的模型 id。
const MODEL_BLACKLIST: [&str; 9] = [
    "MODEL_CHAT_20706",
    "MODEL_CHAT_23310",
    "MODEL_GOOGLE_GEMINI_2_5_FLASH",
    "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING",
    "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE",
    "MODEL_GOOGLE_GEMINI_2_5_PRO",
    "MODEL_PLACEHOLDER_M19",
    "MODEL_PLACEHOLDER_M9",
    "MODEL_PLACEHOLDER_M12",
];

#[derive(Debug, Clone, PartialEq)]
struct Model {
    label: String,
    model_id: String,
    remaining_fraction: f64,
    reset_time: Option<String>,
}

/// 上游 `modelsFromConfigs`：有剩餘比例、不在黑名單的模型。
fn models_from_configs(configs: Option<&Value>) -> Vec<Model> {
    let Some(configs) = configs.and_then(Value::as_array) else {
        return Vec::new();
    };
    configs
        .iter()
        .filter_map(|cfg| {
            let model = cfg
                .get("modelOrAlias")
                .and_then(|m| m.get("model"))
                .filter(|v| truthy(v))?;
            if model.as_str().is_some_and(|m| MODEL_BLACKLIST.contains(&m)) {
                return None;
            }
            let model_id = to_js_string(model);
            let quota = cfg.get("quotaInfo").filter(|v| truthy(v))?;
            let remaining_fraction = quota.get("remainingFraction").and_then(Value::as_f64)?;
            let label = cfg
                .get("label")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map_or_else(|| model_id.clone(), str::to_string);
            Some(Model {
                label,
                model_id,
                remaining_fraction,
                reset_time: parse_reset_time(quota.get("resetTime")),
            })
        })
        .collect()
}

/// 舊版的模型池（上游 `collapsePools` 的輸出）。
#[derive(Debug, Clone, PartialEq)]
pub struct Pool {
    pub name: &'static str,
    pub remaining_fraction: f64,
    pub reset_time: Option<String>,
}

const POOL_ORDER: [&str; 3] = ["Gemini Pro", "Gemini Flash", "Claude"];

/// 上游 `poolForModel`：不是 Gemini 的都算進 Claude 池（GPT-OSS 也是）。
fn pool_for_model(label: &str, model_id: &str) -> &'static str {
    let lc = format!("{label} {model_id}").to_lowercase();
    if lc.contains("gemini") && lc.contains("pro") {
        POOL_ORDER[0]
    } else if lc.contains("gemini") && lc.contains("flash") {
        POOL_ORDER[1]
    } else {
        POOL_ORDER[2]
    }
}

/// 上游 `collapsePools`：每個池取剩最少的模型，一樣少時取較早重置的。
fn collapse_pools(models: &[Model]) -> Vec<Pool> {
    let mut pools: Vec<Pool> = Vec::new();
    for m in models {
        let name = pool_for_model(&m.label, &m.model_id);
        let candidate = Pool {
            name,
            remaining_fraction: m.remaining_fraction,
            reset_time: m.reset_time.clone(),
        };
        match pools.iter_mut().find(|p| p.name == name) {
            None => pools.push(candidate),
            Some(existing) => {
                let earlier = match (&m.reset_time, &existing.reset_time) {
                    (Some(a), Some(b)) => a < b,
                    _ => false,
                };
                if m.remaining_fraction < existing.remaining_fraction
                    || (m.remaining_fraction == existing.remaining_fraction && earlier)
                {
                    *existing = candidate;
                }
            }
        }
    }
    POOL_ORDER
        .iter()
        .filter_map(|name| pools.iter().find(|p| p.name == *name).cloned())
        .collect()
}

/// 上游 `preferredPlanInfoName` 與 `firstTrimmedString`。
fn first_trimmed(values: &[Option<&Value>]) -> Option<String> {
    values.iter().map(|v| js_text(*v)).find(|s| !s.is_empty())
}

/// `GetUserStatus` 的方案（`userTier.name`，其次 `planStatus.planInfo` 的顯示名稱）與 email。
fn account_identity(data: &Value) -> (Option<String>, Option<String>) {
    let status = data.get("userStatus");
    let at = |path: &[&str]| path.iter().try_fold(status?, |v, key| v.get(*key));
    let plan = first_trimmed(&[at(&["userTier", "name"])]).or_else(|| {
        let info = at(&["planStatus", "planInfo"]);
        let field = |key: &str| info.and_then(|i| i.get(key));
        first_trimmed(&[
            field("planDisplayName"),
            field("displayName"),
            field("productName"),
            field("planName"),
            field("planShortName"),
        ])
    });
    let email = at(&["email"])
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    (plan, email)
}

// ---- 快照與 wire 的對應 ----------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Quota {
    Grouped(Vec<QuotaWindow>),
    Pools(Vec<Pool>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub account_plan: Option<String>,
    pub account_email: Option<String>,
    pub quota: Quota,
    pub source: SourceKind,
}

/// 上游 `mapAntigravitySnapshot`（本機 RPC 那條路）：有 email 時 accountKey 與上游 OAuth 帳號相同
/// （`hash("antigravity", email)`），hub 才能把同一個 Google 帳號併在一起；沒有時以方案名稱或 `default` 雜湊。
pub fn provider_row(snapshot: &Snapshot, updated_at: String) -> LimitProvider {
    let email = snapshot
        .account_email
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let plan = snapshot.account_plan.as_deref().unwrap_or("");
    let seed = if !email.is_empty() {
        email.as_str()
    } else if !plan.is_empty() {
        plan
    } else {
        "default"
    };
    let used = |fraction: f64| ((1.0 - fraction) * 100.0).clamp(0.0, 100.0);
    let windows: Vec<LimitWindow> = match &snapshot.quota {
        Quota::Grouped(windows) => windows
            .iter()
            .map(|w| LimitWindow {
                label: w.name.clone(),
                used_percent: w.remaining_fraction.map(used),
                resets_at: w.reset_time.clone(),
                reset_description: w.reset_description.clone(),
                window_minutes: Some(if w.kind == WindowKind::Session {
                    300.0
                } else {
                    10_080.0
                }),
                show_meter: w.show_meter,
                ..LimitWindow::new(w.kind)
            })
            .collect(),
        Quota::Pools(pools) => pools
            .iter()
            .map(|p| LimitWindow {
                label: p.name.into(),
                used_percent: Some(used(p.remaining_fraction)),
                resets_at: p.reset_time.clone(),
                ..LimitWindow::new(WindowKind::Weekly)
            })
            .collect(),
    };
    let status = if windows.is_empty() {
        ProviderStatus::Unavailable
    } else {
        ProviderStatus::Ok
    };
    finish_provider(LimitProvider {
        account_key: hash_key(&["antigravity", seed]),
        account_label: if plan.is_empty() {
            String::new()
        } else {
            super::plan::antigravity_plan_label(plan)
        },
        account_email: email.clone(),
        source: "rpc".into(),
        source_detail: snapshot.source.as_str().into(),
        windows,
        ..LimitProvider::status_row("antigravity", status, updated_at)
    })
}

/// 上游 `fetchAntigravityLimits` 探測失敗時自己回的那一列：沒有身分，`source` 仍是 `rpc`。
pub fn error_row(status: ProviderStatus, updated_at: String) -> LimitProvider {
    LimitProvider {
        source: "rpc".into(),
        ..LimitProvider::status_row("antigravity", status, updated_at)
    }
}

// ---- 探測 -----------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Https,
    Http,
}

impl Scheme {
    fn as_str(self) -> &'static str {
        match self {
            Scheme::Https => "https",
            Scheme::Http => "http",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub scheme: Scheme,
    pub port: u16,
    pub csrf_token: String,
}

/// 探測需要的外部動作。正式版是 [`System`]；replay 與測試換成固定的程序、port 與回應。
pub trait Host: Send + Sync {
    /// 候選程序的 (PID, 命令列)。
    fn processes(&self, timeout: Duration)
        -> BoxFuture<'_, Result<Vec<(u32, String)>, ProbeError>>;
    /// 程序監聽的 port；一個都沒有是錯誤。`'static`：探測會先開始找 port，需要時才等它。
    fn listening_ports(
        &self,
        pid: u32,
        timeout: Duration,
    ) -> BoxFuture<'static, Result<Vec<u16>, ProbeError>>;
    /// `POST /exa.language_server_pb.LanguageServerService/<method>`，回應經 [`response_result`]。
    fn call(
        &self,
        endpoint: Endpoint,
        method: &'static str,
        body: Value,
        timeout: Duration,
    ) -> BoxFuture<'_, Result<Value, ProbeError>>;
}

/// 上游 `callLs` 的回應處理：只有 200 算成功；非 200 依狀態碼分類，錯誤內容提到 CSRF 時一律是 unauthorized
/// （Connect RPC 的 `invalid_argument: missing CSRF token`）。錯誤帶 HTTP 狀態碼：有回應就證明端點連得到。
pub fn response_result(method: &str, code: u16, body: &[u8]) -> Result<Value, ProbeError> {
    if code == 200 {
        return serde_json::from_slice(body)
            .map_err(|e| unavailable(format!("{method} parse error: {e}")));
    }
    let mut status = match code {
        401 | 403 => ProviderStatus::Unauthorized,
        429 => ProviderStatus::SourceRateLimited,
        _ => ProviderStatus::Unavailable,
    };
    if let Ok(parsed) = serde_json::from_slice::<Value>(body) {
        let message = ["message", "error"]
            .iter()
            .filter_map(|k| parsed.get(k))
            .find(|v| truthy(v))
            .map(to_js_string)
            .unwrap_or_default()
            .to_lowercase();
        if message.contains("csrf") {
            status = ProviderStatus::Unauthorized;
        }
    }
    Err(ProbeError {
        status,
        message: format!("{method} returned {code}"),
        http_status: Some(code),
        retry_after: None,
    })
}

/// 正式的探測：這台電腦的程序與本機 HTTP(S)。
pub struct System {
    http: reqwest::Client,
}

impl System {
    pub fn new() -> Result<System, ProbeError> {
        let http = reqwest::Client::builder()
            // 本機 language server 的 HTTPS 是自簽憑證（上游 `rejectUnauthorized: false`）。這個 client 只連
            // 127.0.0.1（網址在 `call` 裡寫死），略過驗證不影響其他任何連線；也不走 proxy、不跟隨轉址。
            .danger_accept_invalid_certs(true)
            .tls_built_in_root_certs(false)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(format!(
                "token-monitor-tauri/{}",
                crate::baked::AGENT_VERSION
            ))
            .build()
            .map_err(|e| unavailable(format!("loopback client: {e}")))?;
        Ok(System { http })
    }
}

impl Host for System {
    fn processes(
        &self,
        timeout: Duration,
    ) -> BoxFuture<'_, Result<Vec<(u32, String)>, ProbeError>> {
        Box::pin(antigravity_os::processes(timeout))
    }

    fn listening_ports(
        &self,
        pid: u32,
        timeout: Duration,
    ) -> BoxFuture<'static, Result<Vec<u16>, ProbeError>> {
        Box::pin(antigravity_os::listening_ports(pid, timeout))
    }

    fn call(
        &self,
        endpoint: Endpoint,
        method: &'static str,
        body: Value,
        timeout: Duration,
    ) -> BoxFuture<'_, Result<Value, ProbeError>> {
        let url = format!(
            "{}://127.0.0.1:{}/{LS_SERVICE}/{method}",
            endpoint.scheme.as_str(),
            endpoint.port
        );
        let request = self
            .http
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header("connect-protocol-version", "1")
            .header("x-codeium-csrf-token", endpoint.csrf_token)
            .body(serde_json::to_vec(&body).unwrap_or_default())
            .timeout(timeout);
        Box::pin(async move {
            let response = request.send().await.map_err(|e| {
                unavailable(if e.is_timeout() {
                    format!("{method} timed out")
                } else {
                    format!("{method} failed: {e}")
                })
            })?;
            let code = response.status().as_u16();
            let body = response
                .bytes()
                .await
                .map_err(|e| unavailable(format!("{method} failed: {e}")))?;
            response_result(method, code, &body)
        })
    }
}

fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

/// 上游 `boundedTimeoutMs`：到期了就是逾時，否則 min(上限, 剩下的時間)。
fn bounded(deadline: Instant, max: Duration) -> Result<Duration, ProbeError> {
    let left = remaining(deadline);
    if left.is_zero() {
        return Err(timeout_error());
    }
    Ok(left.min(max).max(MIN_WAIT))
}

/// 現在起算、剩下時間的一半（上游 `halfDeadlineMs`）。
fn half_of(deadline: Instant) -> Instant {
    Instant::now() + (remaining(deadline) / 2).max(MIN_WAIT)
}

/// 上游 `callBeforeDeadline`。
async fn call_before(
    host: &dyn Host,
    endpoint: &Endpoint,
    method: &'static str,
    body: Value,
    deadline: Instant,
    max: Duration,
) -> Result<Value, ProbeError> {
    let wait = bounded(deadline, max)?;
    tokio::time::timeout(wait, host.call(endpoint.clone(), method, body, wait))
        .await
        .unwrap_or_else(|_| Err(timeout_error()))
}

fn metadata_body() -> Value {
    json!({
        "metadata": {
            "ideName": "antigravity",
            "extensionName": "antigravity",
            "ideVersion": "unknown",
            "locale": "en"
        }
    })
}

/// 上游 `UNLEASH_BODY`；`os` 是 Node 的 `process.platform`。
fn unleash_body() -> Value {
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    json!({
        "context": {
            "properties": {
                "devMode": "false",
                "extensionVersion": "unknown",
                "hasAnthropicModelAccess": "true",
                "ide": "antigravity",
                "ideVersion": "unknown",
                "installationId": "token-monitor",
                "language": "UNSPECIFIED",
                "os": os,
                "requestedModelId": "MODEL_UNSPECIFIED"
            }
        }
    })
}

/// 上游 `endpointCandidates`。
fn endpoint_candidates(info: &ProcessInfo, ports: &[u16]) -> Vec<Endpoint> {
    let at = |scheme, port| Endpoint {
        scheme,
        port,
        csrf_token: info.csrf_token.clone(),
    };
    let mut out = Vec::new();
    if let Some(hub) = info.hub_port {
        out.extend([at(Scheme::Https, hub), at(Scheme::Http, hub)]);
    }
    for &port in ports {
        out.extend([at(Scheme::Https, port), at(Scheme::Http, port)]);
    }
    if let Some(port) = info.extension_port {
        out.push(Endpoint {
            scheme: Scheme::Http,
            port,
            csrf_token: info
                .extension_csrf_token
                .clone()
                .unwrap_or_else(|| info.csrf_token.clone()),
        });
    }
    out
}

fn dedupe(candidates: Vec<Endpoint>) -> Vec<Endpoint> {
    let mut out: Vec<Endpoint> = Vec::with_capacity(candidates.len());
    for c in candidates {
        if !out.contains(&c) {
            out.push(c);
        }
    }
    out
}

fn prioritize(resolved: &Endpoint, candidates: &[Endpoint]) -> Vec<Endpoint> {
    std::iter::once(resolved.clone())
        .chain(candidates.iter().filter(|c| *c != resolved).cloned())
        .collect()
}

struct Resolved {
    candidates: Vec<Endpoint>,
    last_error: Option<ProbeError>,
}

/// 上游 `resolveWorkingEndpoint`：依序預檢，第一個有回應（成功或任何 HTTP 錯誤）的排到最前面。
/// 全部失敗時保留原順序與最後的錯誤（舊版伺服器可能沒有這個輕量端點，但額度 RPC 還是能用）。
async fn resolve_working_endpoint(
    host: &dyn Host,
    candidates: &[Endpoint],
    deadline: Instant,
) -> Result<Resolved, ProbeError> {
    let mut last_error = unavailable("no endpoint candidates");
    for (i, candidate) in candidates.iter().enumerate() {
        let attempts_left = (candidates.len() - i) as u32;
        let attempt = (remaining(deadline) / attempts_left).max(MIN_WAIT);
        match call_before(
            host,
            candidate,
            "GetUnleashData",
            unleash_body(),
            deadline,
            attempt,
        )
        .await
        {
            Ok(_) => {
                return Ok(Resolved {
                    candidates: prioritize(candidate, candidates),
                    last_error: None,
                })
            }
            Err(e) if e.http_status.is_some() => {
                return Ok(Resolved {
                    candidates: prioritize(candidate, candidates),
                    last_error: None,
                })
            }
            Err(e) => {
                last_error = e;
                if remaining(deadline).is_zero() {
                    return Err(timeout_error());
                }
            }
        }
    }
    Ok(Resolved {
        candidates: candidates.to_vec(),
        last_error: Some(last_error),
    })
}

/// 已經開始找的 port；探測結束（成功或逾時）就中止。
struct Discovery(tokio::task::JoinHandle<Result<Vec<u16>, ProbeError>>);

impl Discovery {
    fn start(host: &dyn Host, pid: u32, budget: Instant) -> Discovery {
        let task = match bounded(budget, RPC_TIMEOUT) {
            Err(e) => tokio::spawn(async move { Err(e) }),
            Ok(wait) => {
                let lookup = host.listening_ports(pid, wait);
                tokio::spawn(async move {
                    tokio::time::timeout(wait, lookup)
                        .await
                        .unwrap_or_else(|_| Err(timeout_error()))
                })
            }
        };
        Discovery(task)
    }

    async fn ports(mut self) -> Result<Vec<u16>, ProbeError> {
        (&mut self.0)
            .await
            .unwrap_or_else(|e| Err(unavailable(format!("port discovery: {e}"))))
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct Candidates {
    candidates: Vec<Endpoint>,
    error: Option<ProbeError>,
}

/// 上游 `resolveDiscoveredCandidates`：找到的 port 預檢後排序，再接上預檢失敗的 hub（最後才試）。
async fn resolve_discovered(
    host: &dyn Host,
    info: &ProcessInfo,
    discovery: Discovery,
    failed_hub: Vec<Endpoint>,
    deadline: Instant,
) -> Result<Candidates, ProbeError> {
    let (ports, discovery_error) = match discovery.ports().await {
        Ok(ports) => (ports, None),
        Err(e) => (Vec::new(), Some(e)),
    };
    if let (Some(e), None) = (&discovery_error, info.hub_port) {
        return Err(e.clone());
    }
    // `endpoint_candidates` 一定把 hub 放最前面；hub 已經預檢過，不要再經過一次。
    let discovered: Vec<Endpoint> = endpoint_candidates(info, &ports)
        .into_iter()
        .filter(|c| Some(c.port) != info.hub_port)
        .collect();
    let resolved = resolve_working_endpoint(host, &discovered, deadline)
        .await
        .unwrap_or_else(|e| Resolved {
            candidates: discovered.clone(),
            last_error: Some(e),
        });
    let mut all = resolved.candidates;
    all.extend(failed_hub);
    Ok(Candidates {
        candidates: dedupe(all),
        error: resolved.last_error.or(discovery_error),
    })
}

struct CandidateState {
    candidates: Vec<Endpoint>,
    /// 明確的 hub 預檢通過時，找到的 port 留到 hub 拿不到額度才用。
    fallback: Option<Discovery>,
    error: Option<ProbeError>,
}

/// 一個程序的候選端點。`--hub-port` 是明確指定的，不能讓找 port 拖住它：兩者同時開始，hub 連得到就先用。
async fn candidate_state(host: &dyn Host, info: &ProcessInfo, deadline: Instant) -> CandidateState {
    let explicit_hub = if info.hub_port.is_some() {
        endpoint_candidates(info, &[])
    } else {
        Vec::new()
    };
    let budget = if explicit_hub.is_empty() {
        deadline
    } else {
        half_of(deadline)
    };
    let discovery = Discovery::start(host, info.pid, budget);
    let failed_hub = if explicit_hub.is_empty() {
        Vec::new()
    } else {
        let hub = resolve_working_endpoint(host, &explicit_hub, half_of(deadline))
            .await
            .unwrap_or_else(|e| Resolved {
                candidates: explicit_hub.clone(),
                last_error: Some(e),
            });
        if hub.last_error.is_none() {
            return CandidateState {
                candidates: hub.candidates,
                fallback: Some(discovery),
                error: None,
            };
        }
        // 預檢失敗只把 hub 排到最後：舊版伺服器可能還是有額度 RPC。
        explicit_hub
    };
    match resolve_discovered(host, info, discovery, failed_hub, deadline).await {
        Ok(found) => CandidateState {
            candidates: found.candidates,
            fallback: None,
            error: found.error,
        },
        Err(e) => CandidateState {
            candidates: Vec::new(),
            fallback: None,
            error: Some(e),
        },
    }
}

/// 找到的額度，還不知道是哪一種來源。
#[derive(Debug, Clone)]
struct Found {
    account_plan: Option<String>,
    account_email: Option<String>,
    quota: Quota,
}

impl Found {
    fn into_snapshot(self, source: SourceKind) -> Snapshot {
        Snapshot {
            account_plan: self.account_plan,
            account_email: self.account_email,
            quota: self.quota,
            source,
        }
    }
}

struct Attempt {
    found: Option<Found>,
    last_error: ProbeError,
}

/// 上游 `groupedQuotaFromCandidates`：第一個回得出任何數字的端點；方案與 email 查不到也不影響。
async fn grouped_quota(
    host: &dyn Host,
    candidates: &[Endpoint],
    summary_deadline: Instant,
    probe_deadline: Instant,
) -> Attempt {
    let mut last_error = unavailable("no endpoint candidates");
    for candidate in candidates {
        match call_before(
            host,
            candidate,
            "RetrieveUserQuotaSummary",
            json!({ "forceRefresh": true }),
            summary_deadline,
            RPC_TIMEOUT,
        )
        .await
        {
            Ok(summary) => {
                let windows = quota_summary_windows(&summary);
                if windows.iter().any(|w| w.remaining_fraction.is_some()) {
                    let identity = call_before(
                        host,
                        candidate,
                        "GetUserStatus",
                        metadata_body(),
                        probe_deadline,
                        IDENTITY_TIMEOUT,
                    )
                    .await;
                    let (account_plan, account_email) = identity
                        .map(|v| account_identity(&v))
                        .unwrap_or((None, None));
                    return Attempt {
                        found: Some(Found {
                            account_plan,
                            account_email,
                            quota: Quota::Grouped(windows),
                        }),
                        last_error,
                    };
                }
                last_error = unavailable("empty quota summary");
            }
            Err(e) => {
                last_error = e;
                if remaining(summary_deadline).is_zero() {
                    break;
                }
            }
        }
    }
    Attempt {
        found: None,
        last_error,
    }
}

/// 上游 `legacyQuotaFromCandidates`：`GetUserStatus` 的模型設定（最多用一半的時間），再退回 `GetCommandModelConfigs`。
async fn legacy_quota(
    host: &dyn Host,
    candidates: &[Endpoint],
    probe_deadline: Instant,
) -> Attempt {
    let mut last_error = unavailable("no endpoint candidates");
    let user_status_deadline = half_of(probe_deadline);
    for candidate in candidates {
        match call_before(
            host,
            candidate,
            "GetUserStatus",
            metadata_body(),
            user_status_deadline,
            RPC_TIMEOUT,
        )
        .await
        {
            Ok(data) => {
                if let Some(status) = data.get("userStatus").filter(|v| truthy(v)) {
                    let models = models_from_configs(
                        status
                            .get("cascadeModelConfigData")
                            .and_then(|c| c.get("clientModelConfigs")),
                    );
                    if !models.is_empty() {
                        let (account_plan, account_email) = account_identity(&data);
                        return Attempt {
                            found: Some(Found {
                                account_plan,
                                account_email,
                                quota: Quota::Pools(collapse_pools(&models)),
                            }),
                            last_error,
                        };
                    }
                }
                last_error = unavailable("empty user status");
            }
            Err(e) => {
                last_error = e;
                if remaining(user_status_deadline).is_zero() {
                    break;
                }
            }
        }
    }
    for candidate in candidates {
        match call_before(
            host,
            candidate,
            "GetCommandModelConfigs",
            metadata_body(),
            probe_deadline,
            RPC_TIMEOUT,
        )
        .await
        {
            Ok(data) => {
                let models = models_from_configs(data.get("clientModelConfigs"));
                if !models.is_empty() {
                    return Attempt {
                        found: Some(Found {
                            account_plan: None,
                            account_email: None,
                            quota: Quota::Pools(collapse_pools(&models)),
                        }),
                        last_error,
                    };
                }
                last_error = unavailable("empty model configs");
            }
            Err(e) => {
                last_error = e;
                if remaining(probe_deadline).is_zero() {
                    break;
                }
            }
        }
    }
    Attempt {
        found: None,
        last_error,
    }
}

struct ProcessResult {
    candidates: Vec<Endpoint>,
    found: Option<Found>,
    last_error: Option<ProbeError>,
}

/// 一個程序的分組額度：先用 hub（或找到的 port），hub 拿不到才等找 port 的結果。
async fn grouped_for_process(
    host: &dyn Host,
    info: &ProcessInfo,
    deadline: Instant,
) -> ProcessResult {
    let state = candidate_state(host, info, deadline).await;
    if state.candidates.is_empty() {
        return ProcessResult {
            candidates: Vec::new(),
            found: None,
            last_error: state.error,
        };
    }
    let mut candidates = state.candidates;
    let mut grouped = grouped_quota(host, &candidates, half_of(deadline), deadline).await;
    let mut error = grouped.last_error.clone();
    if grouped.found.is_none() {
        if let Some(discovery) = state.fallback {
            let fallback = resolve_discovered(host, info, discovery, Vec::new(), deadline)
                .await
                .unwrap_or_else(|e| Candidates {
                    candidates: Vec::new(),
                    error: Some(e),
                });
            if let Some(e) = fallback.error {
                error = e;
            }
            if !fallback.candidates.is_empty() {
                let mut all = candidates;
                all.extend(fallback.candidates.iter().cloned());
                candidates = dedupe(all);
                grouped =
                    grouped_quota(host, &fallback.candidates, half_of(deadline), deadline).await;
                error = grouped.last_error.clone();
            }
        }
    }
    ProcessResult {
        candidates,
        found: grouped.found,
        last_error: Some(error),
    }
}

/// 上游 `probe` 的排程：來源依 app → cli → ide；同一種來源的程序平行，任何一個拿到分組額度就結束；
/// 全部拿不到分組額度才試舊版的模型池。都失敗時回最後一個錯誤。
async fn probe_processes(
    host: &dyn Host,
    infos: &[ProcessInfo],
    deadline: Instant,
) -> Result<Snapshot, ProbeError> {
    let mut last_error = ProbeError::new(
        ProviderStatus::NotConfigured,
        "Antigravity language server not running",
    );
    for kind in SourceKind::ORDER {
        let source: Vec<&ProcessInfo> = infos.iter().filter(|i| i.kind == kind).collect();
        if source.is_empty() {
            continue;
        }
        let mut pending: FuturesUnordered<_> = source
            .iter()
            .enumerate()
            .map(|(i, info)| async move { (i, grouped_for_process(host, info, deadline).await) })
            .collect();
        let mut results: Vec<Option<ProcessResult>> = source.iter().map(|_| None).collect();
        while let Some((i, result)) = pending.next().await {
            if let Some(found) = result.found {
                return Ok(found.into_snapshot(kind));
            }
            results[i] = Some(result);
        }
        drop(pending);
        let results: Vec<ProcessResult> = results.into_iter().flatten().collect();
        for r in &results {
            if let Some(e) = &r.last_error {
                last_error = e.clone();
            }
        }
        let reachable: Vec<&ProcessResult> = results
            .iter()
            .filter(|r| !r.candidates.is_empty())
            .collect();
        if reachable.is_empty() {
            continue;
        }
        let legacy = join_all(
            reachable
                .iter()
                .map(|r| legacy_quota(host, &r.candidates, deadline)),
        )
        .await;
        if let Some(found) = legacy.iter().find_map(|a| a.found.clone()) {
            return Ok(found.into_snapshot(kind));
        }
        if let Some(a) = legacy.into_iter().last() {
            last_error = a.last_error;
        }
    }
    Err(last_error)
}

/// 一次完整的探測（最多 `timeout`）。
pub async fn probe_with(host: &dyn Host, timeout: Duration) -> Result<Snapshot, ProbeError> {
    let deadline = Instant::now() + timeout;
    let work = async {
        let wait = bounded(deadline, RPC_TIMEOUT)?;
        let entries = tokio::time::timeout(wait, host.processes(wait))
            .await
            .unwrap_or_else(|_| Err(timeout_error()))?;
        let infos = process_infos(&entries)?;
        probe_processes(host, &infos, deadline).await
    };
    tokio::time::timeout(timeout, work)
        .await
        .unwrap_or_else(|_| Err(timeout_error()))
}

/// 額度 runtime 的入口。失敗的狀態列由 runtime 以 [`error_row`] 產生。
pub async fn probe() -> Result<LimitProvider, ProbeError> {
    let host = System::new()?;
    let snapshot = probe_with(&host, PROBE_TIMEOUT).await?;
    let row = provider_row(&snapshot, crate::wire::time::iso_millis(chrono::Utc::now()));
    // RPC 的快照一定有窗口；萬一沒有，當成暫時拿不到，不要變成 last-good。
    if row.status != ProviderStatus::Ok {
        return Err(ProbeError::new(row.status, "empty Antigravity quota"));
    }
    Ok(row)
}

// ---- replay（tests/compat 用同一份 fixture 跑上游） --------------------------------

/// 固定的程序、port 與 RPC 回應。fixture 的一個情境：
/// `{ processes: ["<pid> <命令列>", …], ports: [..] | portsError: "…", rpc: { <method>: { status, body } } }`。
/// 沒有列出的 method 回 404。
struct FixtureHost {
    processes: Vec<(u32, String)>,
    ports: Result<Vec<u16>, ProbeError>,
    rpc: Map<String, Value>,
}

impl FixtureHost {
    fn new(scenario: &Value) -> FixtureHost {
        let processes = scenario
            .get("processes")
            .and_then(Value::as_array)
            .map(|lines| {
                lines
                    .iter()
                    .filter_map(Value::as_str)
                    .filter_map(antigravity_os::split_process_line)
                    .collect()
            })
            .unwrap_or_default();
        let ports = match scenario.get("portsError").and_then(Value::as_str) {
            Some(message) => Err(unavailable(message)),
            None => {
                let ports: Vec<u16> = scenario
                    .get("ports")
                    .and_then(Value::as_array)
                    .map(|p| {
                        p.iter()
                            .filter_map(Value::as_u64)
                            .filter_map(|p| u16::try_from(p).ok())
                            .collect()
                    })
                    .unwrap_or_default();
                if ports.is_empty() {
                    Err(unavailable("no listening ports for antigravity LS"))
                } else {
                    Ok(ports)
                }
            }
        };
        FixtureHost {
            processes,
            ports,
            rpc: scenario
                .get("rpc")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
        }
    }
}

impl Host for FixtureHost {
    fn processes(&self, _: Duration) -> BoxFuture<'_, Result<Vec<(u32, String)>, ProbeError>> {
        Box::pin(std::future::ready(Ok(self.processes.clone())))
    }

    fn listening_ports(
        &self,
        _: u32,
        _: Duration,
    ) -> BoxFuture<'static, Result<Vec<u16>, ProbeError>> {
        Box::pin(std::future::ready(self.ports.clone()))
    }

    fn call(
        &self,
        _: Endpoint,
        method: &'static str,
        _: Value,
        _: Duration,
    ) -> BoxFuture<'_, Result<Value, ProbeError>> {
        let (code, body) = match self.rpc.get(method) {
            Some(entry) => {
                let code = entry
                    .get("status")
                    .and_then(Value::as_u64)
                    .and_then(|c| u16::try_from(c).ok())
                    .unwrap_or(200);
                let body = match entry.get("body") {
                    Some(Value::String(text)) => text.clone().into_bytes(),
                    Some(v) => serde_json::to_vec(v).unwrap_or_default(),
                    None => b"{}".to_vec(),
                };
                (code, body)
            }
            None => (404, b"404 page not found".to_vec()),
        };
        Box::pin(std::future::ready(response_result(method, code, &body)))
    }
}

/// `tm-agent limits --replay`：與正式探測同一條排程與對應，只是程序、port 與回應是固定的。
pub async fn replay(scenario: &Value, updated_at: String) -> LimitProvider {
    let host = FixtureHost::new(scenario);
    match probe_with(&host, PROBE_TIMEOUT).await {
        Ok(snapshot) => provider_row(&snapshot, updated_at),
        Err(e) => error_row(e.status, updated_at),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Option<ProcessInfo> {
        let (pid, command) = antigravity_os::split_process_line(line)?;
        process_info(pid, &command)
    }

    #[test]
    fn process_lines_follow_upstream() {
        // 上游 tests/shared/antigravityProbe.test.js 的命令列。
        let info = parse("53602 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --override_ide_name antigravity --csrf_token ea1dbb2a-65a8-4766-a155-8e70f032f4ac --app_data_dir antigravity --extension_server_port 12345 --extension_server_csrf_token deadbeef").unwrap();
        assert_eq!(info.pid, 53602);
        assert_eq!(info.kind, SourceKind::App);
        assert_eq!(info.csrf_token, "ea1dbb2a-65a8-4766-a155-8e70f032f4ac");
        assert_eq!(info.extension_port, Some(12345));
        assert_eq!(info.extension_csrf_token.as_deref(), Some("deadbeef"));

        assert_eq!(parse("123 /bin/bash --login"), None);
        assert_eq!(
            parse("456 /Applications/Cursor.app/Contents/MacOS/Cursor"),
            None
        );
        assert_eq!(
            parse(
                "789 /Applications/Antigravity.app/.../language_server --app_data_dir antigravity"
            ),
            None,
            "a desktop LS needs --csrf_token"
        );

        let win = parse("7777 C:\\Program Files\\Antigravity\\language_server.exe --app_data_dir antigravity --csrf_token abc-123").unwrap();
        assert_eq!(
            (win.kind, win.csrf_token.as_str()),
            (SourceKind::App, "abc-123")
        );
        let quoted = parse("7777 \"C:\\Program Files\\Antigravity\\language_server.exe\" --app_data_dir antigravity --csrf_token win-token").unwrap();
        assert_eq!(
            (quoted.kind, quoted.csrf_token.as_str()),
            (SourceKind::App, "win-token")
        );
        let hyphen = parse("7778 C:\\Program Files\\Antigravity\\language-server.exe --app_data_dir antigravity --csrf_token win-token").unwrap();
        assert_eq!(hyphen.kind, SourceKind::App);

        for line in [
            "53603 /Applications/Antigravity IDE.app/Contents/Resources/bin/language_server --csrf_token ide-a --app_data_dir antigravity-ide",
            "53604 /Users/example/.vscode/extensions/antigravity/bin/language_server --csrf_token ide-b --app_data_dir antigravity",
            "4242 \"C:\\Users\\me\\AppData\\Local\\Programs\\Antigravity\\resources\\app\\extensions\\antigravity\\bin\\language_server_windows_x64.exe\" --csrf_token t --app_data_dir antigravity",
        ] {
            assert_eq!(parse(line).unwrap().kind, SourceKind::Ide, "{line}");
        }

        for line in [
            "60123 /Users/example/.antigravity/bin/agy language-server --stdio",
            "60124 /opt/antigravity-cli/resources/language_server_macos --standalone",
            "9001 C:\\Users\\j\\.antigravity\\agy.exe language-server",
            "9001 \"C:\\Users\\j\\.antigravity\\agy.exe\" language-server",
            "9002 \"agy.exe\" language-server",
        ] {
            let info = parse(line).unwrap();
            assert_eq!(
                (info.kind, info.csrf_token.as_str()),
                (SourceKind::Cli, ""),
                "{line}"
            );
        }

        for line in [
            "703 C:\\tools\\watcher.exe --exec \"C:\\Users\\j\\.antigravity\\agy.exe\"",
            "700 /opt/imagytool/bin/run --serve",
            "701 /usr/local/bin/legacy-agent start",
            "28668 \"C:\\Users\\yuwell\\AppData\\Local\\agy\\bin\\agy.exe\" --mode=accept-edits --dangerously-skip-permissions",
            "9001 C:\\Users\\j\\.antigravity\\agy.exe --hub --hub-port=55555 --app_data_dir=antigravity",
        ] {
            assert_eq!(parse(line), None, "{line}");
        }

        let hub = parse("9001 C:\\Users\\j\\.antigravity\\agy.exe --hub --hub-port=55555 --csrf_token=abc123 --app_data_dir=antigravity").unwrap();
        assert_eq!(
            (hub.kind, hub.hub_port, hub.csrf_token.as_str()),
            (SourceKind::Cli, Some(55555), "abc123")
        );
    }

    #[test]
    fn detection_orders_sources_and_explains_failures() {
        let entries = |lines: &[&str]| -> Vec<(u32, String)> {
            lines
                .iter()
                .filter_map(|l| antigravity_os::split_process_line(l))
                .collect()
        };
        let infos = process_infos(&entries(&[
            "30 /Users/x/.vscode/extensions/antigravity/bin/language_server --csrf_token i --app_data_dir antigravity",
            "20 /Users/x/.antigravity/bin/agy language-server",
            "40 /Applications/Antigravity.app/bin/language_server --csrf_token b --app_data_dir antigravity",
            "10 /Applications/Antigravity.app/bin/language_server --csrf_token a --app_data_dir antigravity",
        ]))
        .unwrap();
        let order: Vec<_> = infos.iter().map(|i| (i.kind, i.pid)).collect();
        assert_eq!(
            order,
            [
                (SourceKind::App, 10),
                (SourceKind::App, 40),
                (SourceKind::Cli, 20),
                (SourceKind::Ide, 30)
            ]
        );

        let none = process_infos(&entries(&["1 /bin/bash"])).unwrap_err();
        assert_eq!(none.status, ProviderStatus::NotConfigured);
        let tokenless = process_infos(&entries(&[
            "7777 \"C:\\Program Files\\Antigravity\\language_server.exe\" --app_data_dir antigravity",
        ]))
        .unwrap_err();
        assert_eq!(tokenless.status, ProviderStatus::Unavailable);
        let hub = process_infos(&entries(&[
            "9001 C:\\Users\\j\\.antigravity\\agy.exe --hub --hub-port=55555 --app_data_dir=antigravity",
        ]))
        .unwrap_err();
        assert!(
            hub.message.contains("missing --csrf_token"),
            "{}",
            hub.message
        );
    }

    #[test]
    fn flags_are_case_insensitive_and_need_a_separator() {
        assert_eq!(
            extract_flag("--csrf_token", "x --CSRF_TOKEN=Abc").as_deref(),
            Some("Abc")
        );
        assert_eq!(
            extract_flag("--csrf_token", "x --csrf_tokenx y --csrf_token  z"),
            Some("z".into())
        );
        assert_eq!(extract_flag("--csrf_token", "x --csrf_token"), None);
        assert_eq!(extract_port_flag("--hub-port", "a --hub-port=70000"), None);
        assert!(is_hub_mode_command("agy --hub"));
        assert!(!is_hub_mode_command("agy --hub-port=1"));
        assert!(is_language_server_command(
            "/x/language_server_linux_x64 --a"
        ));
        assert!(!is_language_server_command("/x/language_server.exe.bak"));
    }

    #[test]
    fn quota_summary_maps_two_groups() {
        // 上游 `_quotaSummaryWindows maps two model groups to session and weekly windows`。
        let windows = quota_summary_windows(&json!({
            "response": {
                "groups": [
                    {
                        "displayName": "Claude and GPT models",
                        "buckets": [
                            { "bucketId": "3p-weekly", "displayName": "Weekly Limit", "remaining": { "remainingFraction": 0.64 }, "resetTime": "2026-06-20T00:39:54Z" },
                            { "bucketId": "3p-5h", "displayName": "Five Hour Limit", "remaining": { "remainingFraction": 0.73 }, "resetTime": "2026-06-15T12:52:10Z" }
                        ]
                    },
                    {
                        "displayName": "Gemini Models",
                        "buckets": [
                            { "bucketId": "gemini-weekly", "displayName": "Weekly Limit", "remaining": { "case": "remainingFraction", "value": 0.82 } },
                            { "bucketId": "gemini-5h", "displayName": "Five Hour Limit", "remainingFraction": 0.91, "description": "Refreshes in four hours." }
                        ]
                    }
                ]
            }
        }));
        let got: Vec<_> = windows
            .iter()
            .map(|w| (w.name.as_str(), w.kind, w.remaining_fraction))
            .collect();
        assert_eq!(
            got,
            [
                ("Gemini 5-hour", WindowKind::Session, Some(0.91)),
                ("Gemini weekly", WindowKind::Weekly, Some(0.82)),
                ("Claude/GPT 5-hour", WindowKind::Session, Some(0.73)),
                ("Claude/GPT weekly", WindowKind::Weekly, Some(0.64)),
            ]
        );
        assert_eq!(windows[0].reset_description, "Refreshes in four hours.");
        assert_eq!(
            windows[2].reset_time.as_deref(),
            Some("2026-06-15T12:52:10.000Z")
        );

        // 上游 `recognizes cadence aliases and marks disabled buckets unknown`。
        let windows = quota_summary_windows(&json!({
            "groups": [{
                "displayName": "Gemini Models",
                "buckets": [
                    { "window": "5h", "displayName": "Five Hour Limit Remaining", "remaining": { "remainingFraction": 0.75 } },
                    { "window": "weekly", "displayName": "Weekly Limit Remaining", "remainingFraction": 0.5, "disabled": true },
                    { "bucketId": "gemini-session-history", "displayName": "Session History", "remainingFraction": 0.25 }
                ]
            }]
        }));
        let names: Vec<_> = windows.iter().map(|w| w.name.as_str()).collect();
        assert_eq!(names, ["Gemini 5-hour", "Gemini weekly"]);
        assert!(windows[0].show_meter);
        assert_eq!(windows[1].remaining_fraction, None);
        assert!(!windows[1].show_meter);
    }

    #[test]
    fn legacy_models_collapse_into_three_pools() {
        let models = models_from_configs(Some(&json!([
            { "label": "Gemini 3 Pro (High)", "modelOrAlias": { "model": "MODEL_GEMINI_3_PRO_HIGH" }, "quotaInfo": { "remainingFraction": 0.7, "resetTime": "2026-06-03T03:00:00Z" } },
            { "label": "Blacklisted", "modelOrAlias": { "model": "MODEL_PLACEHOLDER_M9" }, "quotaInfo": { "remainingFraction": 1.0 } },
            { "label": "Missing quota", "modelOrAlias": { "model": "MODEL_NO_QUOTA" } },
            { "label": "GPT-OSS 120B (Medium)", "modelOrAlias": { "model": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM" }, "quotaInfo": { "remainingFraction": 0.9, "resetTime": null } }
        ])));
        let ids: Vec<_> = models.iter().map(|m| m.model_id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "MODEL_GEMINI_3_PRO_HIGH",
                "MODEL_OPENAI_GPT_OSS_120B_MEDIUM"
            ]
        );

        let m = |label: &str, fraction: f64, reset: &str| Model {
            label: label.into(),
            model_id: "X".into(),
            remaining_fraction: fraction,
            reset_time: Some(reset.into()),
        };
        let pools = collapse_pools(&[
            m("Gemini 3 Pro (High)", 0.8, "2026-06-03T03:00:00Z"),
            m("Gemini 3 Pro (Medium)", 0.4, "2026-06-03T02:00:00Z"),
            m("Gemini 3 Flash", 0.9, "2026-06-03T01:00:00Z"),
            m("Claude Opus", 0.7, "2026-06-03T04:00:00Z"),
            m("GPT-OSS 120B", 0.6, "2026-06-03T05:00:00Z"),
            m("Claude Sonnet", 0.6, "2026-06-03T00:00:00Z"),
        ]);
        let got: Vec<_> = pools
            .iter()
            .map(|p| (p.name, p.remaining_fraction, p.reset_time.as_deref()))
            .collect();
        assert_eq!(
            got,
            [
                ("Gemini Pro", 0.4, Some("2026-06-03T02:00:00Z")),
                ("Gemini Flash", 0.9, Some("2026-06-03T01:00:00Z")),
                ("Claude", 0.6, Some("2026-06-03T00:00:00Z")),
            ],
            "ties go to the earlier reset"
        );
    }

    #[test]
    fn snapshot_maps_like_upstream() {
        // 上游 `fetchAntigravityLimits maps quota summary to two session and weekly groups`。
        let window = |name: &str, kind, fraction, reset: &str| QuotaWindow {
            kind,
            name: name.into(),
            remaining_fraction: Some(fraction),
            reset_time: Some(reset.into()),
            reset_description: String::new(),
            show_meter: true,
        };
        let mut windows = vec![
            window(
                "Gemini 5-hour",
                WindowKind::Session,
                0.65,
                "2026-06-03T02:00:00.000Z",
            ),
            window(
                "Gemini weekly",
                WindowKind::Weekly,
                0.92,
                "2026-06-09T02:00:00.000Z",
            ),
            window(
                "Claude/GPT 5-hour",
                WindowKind::Session,
                1.0,
                "2026-06-03T04:00:00.000Z",
            ),
            window(
                "Claude/GPT weekly",
                WindowKind::Weekly,
                1.0,
                "2026-06-09T04:00:00.000Z",
            ),
        ];
        windows[0].reset_description = "Refreshes soon.".into();
        let row = provider_row(
            &Snapshot {
                account_plan: Some("Google AI Pro".into()),
                account_email: Some(" A@B.com ".into()),
                quota: Quota::Grouped(windows),
                source: SourceKind::App,
            },
            "2026-01-01T00:00:00.000Z".into(),
        );
        assert_eq!(row.status, ProviderStatus::Ok);
        assert_eq!(
            (row.source.as_str(), row.source_detail.as_str()),
            ("rpc", "app")
        );
        assert_eq!(row.account_label, "Pro");
        assert_eq!(row.account_email, "a@b.com");
        assert_eq!(row.account_key, hash_key(&["antigravity", "a@b.com"]));
        let got: Vec<_> = row
            .windows
            .iter()
            .map(|w| (w.label.as_str(), w.window_minutes, w.remaining_percent))
            .collect();
        assert_eq!(
            got,
            [
                ("Gemini 5-hour", Some(300.0), Some(65.0)),
                ("Gemini weekly", Some(10_080.0), Some(92.0)),
                ("Claude/GPT 5-hour", Some(300.0), Some(100.0)),
                ("Claude/GPT weekly", Some(10_080.0), Some(100.0)),
            ]
        );
        assert_eq!(row.windows[0].reset_description, "Refreshes soon.");

        // 上游 `preserves legacy 3-pool fallback as weekly windows`；沒有 email 時以方案雜湊。
        let row = provider_row(
            &Snapshot {
                account_plan: Some("Pro".into()),
                account_email: None,
                quota: Quota::Pools(vec![Pool {
                    name: "Gemini Pro",
                    remaining_fraction: 0.5,
                    reset_time: None,
                }]),
                source: SourceKind::Cli,
            },
            "2026-01-01T00:00:00.000Z".into(),
        );
        assert_eq!(row.account_key, hash_key(&["antigravity", "Pro"]));
        assert_eq!(row.windows[0].kind, WindowKind::Weekly);
        assert_eq!(row.windows[0].window_minutes, None);
        assert_eq!(row.windows[0].used_percent, Some(50.0));
    }

    #[test]
    fn rpc_errors_follow_upstream() {
        let status = |code, body: &str| {
            response_result("M", code, body.as_bytes())
                .unwrap_err()
                .status
        };
        assert_eq!(status(401, ""), ProviderStatus::Unauthorized);
        assert_eq!(status(403, "{}"), ProviderStatus::Unauthorized);
        assert_eq!(status(429, ""), ProviderStatus::SourceRateLimited);
        assert_eq!(status(500, "oops"), ProviderStatus::Unavailable);
        assert_eq!(
            status(
                400,
                r#"{"code":"invalid_argument","message":"missing CSRF token"}"#
            ),
            ProviderStatus::Unauthorized
        );
        assert_eq!(
            status(
                400,
                r#"{"code":"invalid_argument","message":"bad request"}"#
            ),
            ProviderStatus::Unavailable
        );
        let e = response_result("M", 404, b"404 page not found").unwrap_err();
        assert_eq!(e.http_status, Some(404));
        assert_eq!(
            response_result("M", 200, br#"{"a":1}"#).unwrap(),
            json!({"a": 1})
        );
        let bad = response_result("M", 200, b"not json").unwrap_err();
        assert_eq!(
            (bad.status, bad.http_status),
            (ProviderStatus::Unavailable, None)
        );
    }

    #[test]
    fn the_loopback_client_builds() {
        assert!(System::new().is_ok());
    }

    fn scenario(v: Value) -> FixtureHost {
        FixtureHost::new(&v)
    }

    #[tokio::test]
    async fn grouped_quota_wins_over_legacy_and_names_the_source() {
        let host = scenario(json!({
            "processes": ["20 /Applications/Antigravity.app/bin/language_server --csrf_token a --app_data_dir antigravity"],
            "ports": [51000],
            "rpc": {
                "RetrieveUserQuotaSummary": { "body": { "groups": [{ "displayName": "Gemini", "buckets": [{ "window": "weekly", "remainingFraction": 0.25 }] }] } },
                "GetUserStatus": { "body": { "userStatus": { "email": "Dev@Example.com", "userTier": { "name": "Google AI Ultra" },
                    "cascadeModelConfigData": { "clientModelConfigs": [{ "label": "Claude", "modelOrAlias": { "model": "M" }, "quotaInfo": { "remainingFraction": 0.1 } }] } } } }
            }
        }));
        let snapshot = probe_with(&host, PROBE_TIMEOUT).await.unwrap();
        assert_eq!(snapshot.source, SourceKind::App);
        assert_eq!(snapshot.account_plan.as_deref(), Some("Google AI Ultra"));
        assert_eq!(snapshot.account_email.as_deref(), Some("Dev@Example.com"));
        assert!(matches!(snapshot.quota, Quota::Grouped(ref w) if w.len() == 1));
    }

    #[tokio::test]
    async fn legacy_pools_then_command_model_configs() {
        let host = scenario(json!({
            "processes": ["20 /Users/x/.antigravity/bin/agy language-server"],
            "ports": [51000],
            "rpc": {
                "GetUserStatus": { "body": {} },
                "GetCommandModelConfigs": { "body": { "clientModelConfigs": [{ "label": "Gemini 3 Flash", "modelOrAlias": { "model": "F" }, "quotaInfo": { "remainingFraction": 0.5 } }] } }
            }
        }));
        let snapshot = probe_with(&host, PROBE_TIMEOUT).await.unwrap();
        assert_eq!(snapshot.source, SourceKind::Cli);
        assert_eq!(snapshot.account_plan, None);
        assert_eq!(
            snapshot.quota,
            Quota::Pools(vec![Pool {
                name: "Gemini Flash",
                remaining_fraction: 0.5,
                reset_time: None
            }])
        );
    }

    #[tokio::test]
    async fn failures_report_the_last_error() {
        let csrf = json!({ "status": 400, "body": { "message": "missing CSRF token" } });
        let host = scenario(json!({
            "processes": ["20 /Applications/Antigravity.app/bin/language_server --csrf_token a --app_data_dir antigravity"],
            "ports": [51000],
            "rpc": {
                "GetUnleashData": csrf.clone(),
                "RetrieveUserQuotaSummary": csrf.clone(),
                "GetUserStatus": csrf.clone(),
                "GetCommandModelConfigs": csrf
            }
        }));
        let err = probe_with(&host, PROBE_TIMEOUT).await.unwrap_err();
        assert_eq!(err.status, ProviderStatus::Unauthorized);

        let host = scenario(json!({ "processes": [] }));
        let err = probe_with(&host, PROBE_TIMEOUT).await.unwrap_err();
        assert_eq!(err.status, ProviderStatus::NotConfigured);

        // 找 port 失敗、又沒有 hub：回報找 port 的錯誤。
        let host = scenario(json!({
            "processes": ["20 /Users/x/.antigravity/bin/agy language-server"],
            "portsError": "lsof failed"
        }));
        let err = probe_with(&host, PROBE_TIMEOUT).await.unwrap_err();
        assert_eq!(err.message, "lsof failed");
    }

    #[tokio::test]
    async fn an_explicit_hub_port_is_tried_even_when_discovery_fails() {
        let host = scenario(json!({
            "processes": ["9001 C:\\Users\\j\\.antigravity\\agy.exe --hub --hub-port=55555 --csrf_token=abc --app_data_dir=antigravity"],
            "portsError": "Get-NetTCPConnection failed",
            "rpc": { "RetrieveUserQuotaSummary": { "body": { "groups": [{ "displayName": "Claude", "buckets": [{ "window": "5h", "remainingFraction": 0.5 }] }] } } }
        }));
        let snapshot = probe_with(&host, PROBE_TIMEOUT).await.unwrap();
        assert_eq!(snapshot.source, SourceKind::Cli);
    }

    /// 端點不回應時整次探測在期限內結束（上游 `enforces one provider-wide deadline`）。
    struct Hanging;

    impl Host for Hanging {
        fn processes(&self, _: Duration) -> BoxFuture<'_, Result<Vec<(u32, String)>, ProbeError>> {
            Box::pin(std::future::ready(Ok(vec![(
                7,
                "/Applications/Antigravity.app/bin/language_server --csrf_token a --app_data_dir antigravity".into(),
            )])))
        }
        fn listening_ports(
            &self,
            _: u32,
            _: Duration,
        ) -> BoxFuture<'static, Result<Vec<u16>, ProbeError>> {
            Box::pin(std::future::ready(Ok(vec![1234])))
        }
        fn call(
            &self,
            _: Endpoint,
            _: &'static str,
            _: Value,
            _: Duration,
        ) -> BoxFuture<'_, Result<Value, ProbeError>> {
            Box::pin(std::future::pending())
        }
    }

    #[tokio::test]
    async fn a_hanging_server_times_out_within_the_deadline() {
        let started = Instant::now();
        let err = probe_with(&Hanging, Duration::from_millis(300))
            .await
            .unwrap_err();
        assert_eq!(err.status, ProviderStatus::Unavailable);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    /// 真的走 HTTP：本機假的 language server 只回 HTTP，HTTPS 那一個候選失敗後改用 HTTP；
    /// 檢查路徑、CSRF header 與 Connect 的版本 header。
    #[tokio::test]
    async fn talks_to_a_local_language_server_over_http() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let mut seen = Vec::new();
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let n = socket.read(&mut chunk).await.unwrap_or(0);
                if !chunk[..n].starts_with(b"POST ") {
                    // HTTPS 的 ClientHello：直接關掉。
                    continue;
                }
                buf.extend_from_slice(&chunk[..n]);
                // 讀完整個請求（標頭 + content-length 的內容）才回覆，關閉時才不會變成 RST。
                loop {
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|l| {
                                l.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if buf.len() >= end + 4 + length {
                            break;
                        }
                    }
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let request = String::from_utf8_lossy(&buf).to_string();
                let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
                let lower = request.to_lowercase();
                assert!(lower.contains("x-codeium-csrf-token: tok"), "{request}");
                assert!(lower.contains("connect-protocol-version: 1"), "{request}");
                let body = if path.ends_with("/RetrieveUserQuotaSummary") {
                    r#"{"groups":[{"displayName":"Gemini","buckets":[{"window":"5h","remainingFraction":0.4}]}]}"#
                } else {
                    "{}"
                };
                seen.push(path);
                let reply = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
                if seen.len() >= 3 {
                    break;
                }
            }
            seen
        });

        struct Local {
            system: System,
            port: u16,
        }
        impl Host for Local {
            fn processes(
                &self,
                _: Duration,
            ) -> BoxFuture<'_, Result<Vec<(u32, String)>, ProbeError>> {
                Box::pin(std::future::ready(Ok(vec![(
                    7,
                    "/Applications/Antigravity.app/bin/language_server --csrf_token tok --app_data_dir antigravity".into(),
                )])))
            }
            fn listening_ports(
                &self,
                _: u32,
                _: Duration,
            ) -> BoxFuture<'static, Result<Vec<u16>, ProbeError>> {
                Box::pin(std::future::ready(Ok(vec![self.port])))
            }
            fn call(
                &self,
                e: Endpoint,
                m: &'static str,
                b: Value,
                t: Duration,
            ) -> BoxFuture<'_, Result<Value, ProbeError>> {
                self.system.call(e, m, b, t)
            }
        }

        let host = Local {
            system: System::new().unwrap(),
            port,
        };
        let snapshot = probe_with(&host, PROBE_TIMEOUT).await.unwrap();
        assert!(matches!(snapshot.quota, Quota::Grouped(_)));
        let seen = server.await.unwrap();
        assert_eq!(
            seen,
            [
                format!("/{LS_SERVICE}/GetUnleashData"),
                format!("/{LS_SERVICE}/RetrieveUserQuotaSummary"),
                format!("/{LS_SERVICE}/GetUserStatus"),
            ]
        );
    }
}
