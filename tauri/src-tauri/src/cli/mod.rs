//! `tm-agent`：無頭代理程式（上游 src/agent/agent.js 的對應）。
//!
//! 與 GUI 共用設定目錄、deviceId 與內建的 hub 設定。環境變數名稱沿用上游 agent，
//! 讓既有的排程腳本不必改：`TOKEN_MONITOR_HUB_URL`、`TOKEN_MONITOR_SECRET`、
//! `TOKEN_MONITOR_DEVICE_ID`、`TOKEN_MONITOR_CLIENTS`、`TOKEN_MONITOR_INTERVAL_MS`、
//! `TOKEN_MONITOR_TOKSCALE_TIMEOUT_MS`、`TOKEN_MONITOR_ALL_TIME_SINCE`。
//!
//! 同一台電腦不要同時跑 GUI 與 `tm-agent run`：兩者用同一個 deviceId，會輪流覆蓋對方的上傳。

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use clap::{Parser, Subcommand, ValueEnum};
use tokio_util::sync::CancellationToken;

use crate::collector::{CollectorConfig, ScanSource};
use crate::device::events::{CoreEvent, EventSink};
use crate::device::hub_sender;
use crate::device::runtime::{DeviceRuntime, RuntimeConfig, WatchConfig};
use crate::error::{AppError, AppResult};
use crate::hub::payload::{serialize_sync_payload, PayloadOptions};
use crate::hub::{HubClient, HubError};
use crate::identity;
use crate::limits::runtime::{LimitsConfig, LimitsRuntime};
use crate::settings::{mask_secret, resolve_hub, HubResolution, Settings};
use crate::tokscale::{ScanPeriod, Scanner};

#[derive(Parser, Debug)]
#[command(
    name = "tm-agent",
    version,
    about = "Token Monitor headless agent: collect local AI usage and upload it to the company hub"
)]
pub struct Cli {
    /// hub 網址（覆寫設定檔與內建值）
    #[arg(long, global = true)]
    hub: Option<String>,
    /// client secret（建議改用 TOKEN_MONITOR_SECRET，命令列參數會留在程序清單）
    #[arg(long, global = true)]
    secret: Option<String>,
    /// 本次執行使用的 deviceId（不寫回設定檔）
    #[arg(long, global = true, env = "TOKEN_MONITOR_DEVICE_ID")]
    device: Option<String>,
    /// 設定目錄（預設與 GUI 相同）
    #[arg(long, global = true, env = "TOKEN_MONITOR_CONFIG_DIR")]
    config_dir: Option<PathBuf>,
    /// 追蹤的 client，逗號分隔（覆寫設定檔）
    #[arg(
        long,
        global = true,
        env = "TOKEN_MONITOR_CLIENTS",
        value_delimiter = ','
    )]
    clients: Option<Vec<String>>,
    /// allTime 的起始日 YYYY-MM-DD
    #[arg(long, global = true, env = "TOKEN_MONITOR_ALL_TIME_SINCE")]
    since: Option<String>,
    /// tokscale 逾時（毫秒）
    #[arg(long, global = true, env = "TOKEN_MONITOR_TOKSCALE_TIMEOUT_MS")]
    tokscale_timeout_ms: Option<u64>,
    /// 以固定 JSON 目錄（today.json / month.json / alltime.json）取代 tokscale 掃描（測試用；此時不探測額度）
    #[arg(long, global = true)]
    tokscale_json_dir: Option<PathBuf>,
    /// 額度探測；`0` / `false` / `no` / `off` 關閉（與上游 agent 相同）
    #[arg(long, global = true, env = "TOKEN_MONITOR_LIMITS_ENABLED")]
    limits: Option<String>,
    /// 保留 client 已刪除的 session 用量；`0` / `false` / `no` / `off` 關閉（與上游 agent 相同）
    #[arg(
        long,
        global = true,
        env = "TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED"
    )]
    session_archive: Option<String>,
    /// 上傳每天的用量歷史；`0` / `false` / `no` / `off` 關閉（與上游 agent 相同）
    #[arg(long, global = true, env = "TOKEN_MONITOR_HISTORY_ENABLED")]
    history: Option<String>,
    /// history 掃描間隔（毫秒；300000 / 600000 / 900000 / 1800000 / 3600000）
    #[arg(long, global = true, env = "TOKEN_MONITOR_HISTORY_INTERVAL_MS")]
    history_interval_ms: Option<u64>,
    /// 探測哪些額度，逗號分隔（claude,codex）
    #[arg(
        long,
        global = true,
        env = "TOKEN_MONITOR_LIMIT_PROVIDERS",
        value_delimiter = ','
    )]
    limit_providers: Option<Vec<String>>,
    /// 額度探測間隔（毫秒；60000 / 120000 / 300000 / 900000 / 1800000）
    #[arg(long, global = true, env = "TOKEN_MONITOR_LIMITS_REFRESH_MS")]
    limits_refresh_ms: Option<u64>,
    /// 專案（資料夾）統計；`0` / `false` / `no` / `off` 關閉（與上游 agent 相同）
    #[arg(long, global = true, env = "TOKEN_MONITOR_PROJECTS_ENABLED")]
    projects: Option<String>,
    /// 上傳間隔（毫秒；0 = 即時，600000 / 1200000 / 1800000）
    #[arg(long, global = true, env = "TOKEN_MONITOR_SYNC_UPLOAD_INTERVAL_MS")]
    sync_upload_interval_ms: Option<u64>,
    /// 使用者的公司信箱，隨上傳送給 hub 以自動對應員工（覆寫設定檔；不像 email 的值會被忽略）
    #[arg(long, global = true, env = "TOKEN_MONITOR_OWNER_EMAIL")]
    owner_email: Option<String>,
    /// 詳細 log
    #[arg(short, long, global = true)]
    verbose: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// 常駐：定時掃描並依上傳間隔送到 hub
    Run {
        /// 完整掃描間隔（毫秒）
        #[arg(long, env = "TOKEN_MONITOR_INTERVAL_MS")]
        interval_ms: Option<u64>,
        /// 每個核心事件印一行 JSON 到 stdout
        #[arg(long)]
        events: bool,
        /// 監看來源目錄、有變動就更新；`0` 關閉（與上游 agent 相同）
        #[arg(long, env = "TOKEN_MONITOR_WATCH")]
        watch: Option<String>,
        /// 檔案事件的防抖（毫秒）
        #[arg(long, env = "TOKEN_MONITOR_WATCH_DEBOUNCE_MS")]
        watch_debounce_ms: Option<u64>,
        /// 不上傳：每筆 record 印成一行 JSON（上游 agent 的連續 dry run；不需要 hub，archive 只讀不寫）
        #[arg(long)]
        dry_run: bool,
    },
    /// 掃描一次、上傳一次後結束
    Once {
        /// 不上傳
        #[arg(long)]
        dry_run: bool,
        /// 把 record 印成 JSON 到 stdout
        #[arg(long)]
        json: bool,
        /// 把實際上傳的 payload（已套用大小預算）印成 JSON 到 stdout
        #[arg(long)]
        payload: bool,
        /// 相容測試用：先以這個 JSON 目錄做完整掃描當錨點，再以 --tokscale-json-dir 的 today
        /// 跑一次檔案變動觸發的 anchored tick（watch tick 的真實路徑）
        #[arg(long, hide = true)]
        anchor_json_dir: Option<PathBuf>,
        /// 相容測試用：dry run 也把 archive 的變動寫回（讓下一次 dry run 讀得到）
        #[arg(long, hide = true)]
        write_archives: bool,
    },
    /// 只跑一次 tokscale，印出原始 JSON 或解析後的 period
    Scan {
        #[arg(long, value_enum, default_value = "today")]
        period: PeriodArg,
        /// 印 tokscale 原始輸出
        #[arg(long)]
        raw: bool,
    },
    /// 檢查 hub 的 /api/health
    Health,
    /// 探測一次 Claude Code / Codex 的額度並印出（上傳內容裡的 limits；不含任何 token）
    Limits {
        /// 印 JSON（LimitsSummary）
        #[arg(long)]
        json: bool,
        /// 相容測試用：不連網，以目錄裡的 claude-usage.json / codex-usage.json 跑對應，印 JSON
        #[arg(long, hide = true)]
        replay: Option<PathBuf>,
    },
    /// 連上 hub 的即時串流，印出全公司的用量摘要（widget「全公司」分頁的同一份資料）
    Company {
        /// 印 JSON（CompanyStats）
        #[arg(long)]
        json: bool,
        /// 等第一份快照的秒數
        #[arg(long, default_value_t = 30)]
        timeout_secs: u64,
        /// 拿到快照後繼續收這麼多秒，每次 hub 有更新就印一行（排查串流用）
        #[arg(long, default_value_t = 0)]
        follow_secs: u64,
    },
    /// 環境診斷：tokscale、設定、hub 連線與 secret 來源
    Doctor,
    /// 管理 client secret 的覆寫值（存在 OS 認證管理員，金鑰輪替用）
    Secret {
        #[command(subcommand)]
        action: SecretAction,
    },
    /// 印出目前的設定（secret 不在其中）
    Settings,
    /// 印出一個 session 的逐回合明細（widget 點開 session 的同一份資料；只讀本機紀錄，不上傳）
    SessionDetail {
        /// claude / codex / opencode
        client: String,
        /// tokscale 的 sessionId（Claude 的 UUID、Codex 的 rollout 檔名、OpenCode 的 ses_…）
        session_id: String,
        /// today / month / total
        #[arg(long, default_value = "total")]
        period: String,
        /// 這段期間 session 的成本（USD）；Claude / Codex 依 token 比例分攤給每一輪
        #[arg(long, default_value_t = 0.0)]
        cost: f64,
    },
}

#[derive(Subcommand, Debug)]
enum SecretAction {
    /// 從環境變數讀取新的 secret 並存起來
    Set {
        #[arg(long, default_value = "TOKEN_MONITOR_NEW_SECRET")]
        from_env: String,
    },
    /// 刪除覆寫值，回到內建的 secret
    Clear,
}

#[derive(ValueEnum, Clone, Debug)]
enum PeriodArg {
    Today,
    Month,
    Alltime,
}

const SUBCOMMANDS: &[&str] = &[
    "run",
    "once",
    "scan",
    "health",
    "limits",
    "company",
    "doctor",
    "secret",
    "settings",
    "session-detail",
    "help",
];

/// 上游 agent 的旗標拼法（src/shared/config.js `parseArgs` 是自由格式的 `--key[=value]`）→ 這裡的名稱。
const LEGACY_FLAGS: &[(&str, &str)] = &[
    ("--hubUrl", "--hub"),
    ("--hub-url", "--hub"),
    ("--deviceId", "--device"),
    ("--device-id", "--device"),
    ("--intervalMs", "--interval-ms"),
    ("--interval", "--interval-ms"),
    ("--timeoutMs", "--tokscale-timeout-ms"),
    ("--watchDebounceMs", "--watch-debounce-ms"),
    ("--sessionArchive", "--session-archive"),
    ("--sessionUsageArchiveEnabled", "--session-archive"),
    ("--limitProviders", "--limit-providers"),
    ("--limitsEnabled", "--limits"),
    ("--limitsRefreshMs", "--limits-refresh-ms"),
    ("--historyEnabled", "--history"),
    ("--historyIntervalMs", "--history-interval-ms"),
    ("--projectsEnabled", "--projects"),
    ("--allTimeSince", "--since"),
    ("--dryRun", "--dry-run"),
];

/// 讓上游 agent 的呼叫方式也能用（既有的排程腳本不必改）：旗標改名；沒有子命令時，有 `--once` 就是
/// `once`，否則是 `run`（上游不帶參數就是常駐）。`once` 用不到的 `--interval-ms` 丟掉。
pub fn normalize_args(args: Vec<std::ffi::OsString>) -> Vec<std::ffi::OsString> {
    let mut out: Vec<String> = Vec::new();
    let mut iter = args.into_iter();
    let program = iter.next();
    let mut once = false;
    for arg in iter {
        let Some(s) = arg.to_str() else {
            return std::iter::once(program.unwrap_or_default())
                .chain(std::iter::once(arg))
                .collect();
        };
        if s == "--once" {
            once = true;
            continue;
        }
        let (name, value) = match s.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n, Some(v)),
            _ => (s, None),
        };
        let mapped = LEGACY_FLAGS
            .iter()
            .find(|(from, _)| *from == name)
            .map(|(_, to)| *to)
            .unwrap_or(name);
        out.push(match value {
            Some(v) => format!("{mapped}={v}"),
            None => mapped.to_string(),
        });
    }
    let has_subcommand = out.iter().any(|a| SUBCOMMANDS.contains(&a.as_str()));
    let only_meta = out
        .iter()
        .all(|a| matches!(a.as_str(), "--help" | "-h" | "--version" | "-V"));
    if !has_subcommand && !(only_meta && !out.is_empty()) {
        out.insert(0, if once { "once" } else { "run" }.to_string());
    }
    if out.first().map(String::as_str) == Some("once") {
        let mut i = 0;
        while i < out.len() {
            if out[i] == "--interval-ms" {
                out.drain(i..(i + 2).min(out.len()));
            } else if out[i].starts_with("--interval-ms=") {
                out.remove(i);
            } else {
                i += 1;
            }
        }
    }
    std::iter::once(program.unwrap_or_else(|| "tm-agent".into()))
        .chain(out.into_iter().map(Into::into))
        .collect()
}

/// 上游 `loadDotEnv`：讀執行檔旁邊的 `.env`（`KEY=VALUE`，# 開頭是註解，值可以加引號），
/// 已經存在的環境變數不覆寫。
pub fn load_dotenv() {
    let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(dir.join(".env")) else {
        return;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || std::env::var_os(key).is_some() {
            continue;
        }
        let v = value.trim();
        let v = if v.len() >= 2
            && ((v.starts_with('"') && v.ends_with('"'))
                || (v.starts_with('\'') && v.ends_with('\'')))
        {
            &v[1..v.len() - 1]
        } else {
            v
        };
        std::env::set_var(key, v);
    }
}

pub mod exit {
    pub const OK: u8 = 0;
    pub const FAILURE: u8 = 1;
    pub const UNAUTHORIZED: u8 = 3;
    pub const TOKSCALE_MISSING: u8 = 4;
    pub const HUB_NOT_CONFIGURED: u8 = 5;
}

fn exit_code_for(e: &AppError) -> u8 {
    match e {
        AppError::Hub(HubError::Unauthorized { .. }) => exit::UNAUTHORIZED,
        AppError::TokscaleMissing(_) => exit::TOKSCALE_MISSING,
        AppError::HubNotConfigured => exit::HUB_NOT_CONFIGURED,
        _ => exit::FAILURE,
    }
}

struct Context {
    settings: Settings,
    device_id: String,
    hub: HubResolution,
}

/// 上游 `parseBoolean`：空字串用預設值，`0` / `false` / `no` / `off` 是 false，其他都是 true。
fn parse_bool(value: &str, default: bool) -> bool {
    let v = value.trim().to_lowercase();
    if value.is_empty() {
        return default;
    }
    !matches!(v.as_str(), "0" | "false" | "no" | "off")
}

fn load_context(cli: &Cli) -> AppResult<Context> {
    if let Some(dir) = &cli.config_dir {
        std::env::set_var(crate::store::CONFIG_DIR_ENV, dir);
    }
    let mut settings = Settings::load_or_init(&crate::store::config_dir())?;
    if let Some(clients) = &cli.clients {
        settings.tracked_clients = clients.clone();
    }
    if let Some(since) = &cli.since {
        settings.all_time_since = since.clone();
    }
    if let Some(t) = cli.tokscale_timeout_ms {
        settings.tokscale_timeout_ms = t;
    }
    if let Some(v) = &cli.limits {
        settings.limits_enabled = parse_bool(v, true);
    }
    if let Some(v) = &cli.session_archive {
        settings.session_usage_archive_enabled = parse_bool(v, true);
    }
    if let Some(v) = &cli.projects {
        settings.projects_enabled = parse_bool(v, true);
    }
    if let Some(ms) = cli.sync_upload_interval_ms {
        settings.sync_upload_interval_ms = ms;
    }
    if let Some(v) = &cli.history {
        settings.history_enabled = parse_bool(v, true);
    }
    if let Some(ms) = cli.history_interval_ms {
        settings.history_interval_ms = ms;
    }
    if let Some(p) = &cli.limit_providers {
        settings.limit_providers = p.clone();
    }
    if let Some(ms) = cli.limits_refresh_ms {
        settings.limits_refresh_ms = ms;
    }
    if let Some(email) = &cli.owner_email {
        settings.owner_email = email.clone();
    }
    settings.validate();
    let device_id = cli
        .device
        .clone()
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| settings.device_id.clone());
    let hub = resolve_hub(&settings, cli.hub.as_deref(), cli.secret.as_deref());
    Ok(Context {
        settings,
        device_id,
        hub,
    })
}

fn scan_source(cli: &Cli, settings: &Settings) -> AppResult<ScanSource> {
    if let Some(dir) = &cli.tokscale_json_dir {
        return Ok(ScanSource::Fixtures(dir.clone()));
    }
    let bin = crate::tokscale::locate()?;
    let extra = crate::tokscale::scan::extra_dirs_env(
        &settings.custom_scan_paths,
        std::env::var("TOKSCALE_EXTRA_DIRS").ok().as_deref(),
    );
    Ok(ScanSource::Tokscale(Arc::new(Scanner::new(
        bin,
        settings.tokscale_timeout_ms,
        extra,
    ))))
}

/// 固定 JSON 來源是測試：不碰真的 Claude / Codex 憑證與網路。
fn limits_config(settings: &Settings, source: &ScanSource) -> Option<LimitsConfig> {
    match source {
        ScanSource::Fixtures(_) => None,
        ScanSource::Tokscale(_) => LimitsConfig::from_settings(settings),
    }
}

fn hub_client(hub: &HubResolution) -> AppResult<HubClient> {
    let url = hub.url.as_deref().ok_or(AppError::HubNotConfigured)?;
    if hub.secret.is_none() {
        tracing::warn!("no client secret configured; posting without authorization");
    }
    Ok(HubClient::new(url, hub.secret.clone())?)
}

fn print_json(value: &impl serde::Serialize, pretty: bool) {
    let text = if pretty {
        serde_json::to_string_pretty(value)
    } else {
        serde_json::to_string(value)
    }
    .expect("serializable");
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{text}");
}

fn event_printer() -> EventSink {
    Arc::new(|event: CoreEvent| {
        // RecordPublished 夾帶整筆 record，太大；只印摘要。
        let line = match &event {
            CoreEvent::RecordPublished { revision, record } => serde_json::json!({
                "type": "recordPublished", "revision": revision,
                "today": record.today.total_tokens, "month": record.month.total_tokens, "allTime": record.all_time.total_tokens,
            }),
            other => serde_json::to_value(other).unwrap_or_default(),
        };
        print_json(&line, false);
    })
}

fn log_event() -> EventSink {
    Arc::new(|event: CoreEvent| match event {
        CoreEvent::IngestSent {
            revision,
            bytes,
            retried,
            ..
        } => {
            tracing::info!(revision, bytes, retried, "posted to hub")
        }
        CoreEvent::IngestFailed {
            revision,
            error,
            will_retry,
            ..
        } => {
            tracing::warn!(revision, code = %error.code, will_retry, "{}", error.message)
        }
        CoreEvent::TickFinished {
            reason,
            duration_ms,
        } => tracing::info!(%reason, duration_ms, "collected"),
        CoreEvent::TickFailed { reason, error } => {
            tracing::warn!(%reason, code = %error.code, "{}", error.message)
        }
        CoreEvent::HistoryCollected {
            days, duration_ms, ..
        } => tracing::info!(days, duration_ms, "history collected"),
        CoreEvent::SelfSync { reports } => {
            for r in reports {
                tracing::info!(client = %r.client, state = ?r.state, "self-sync");
            }
        }
        _ => {}
    })
}

/// 等到該結束的時候：Ctrl+C，Windows 的關閉主控台／登出／關機，或 Unix 的 SIGTERM / SIGHUP
/// （上游 agent.js 處理 SIGINT / SIGTERM / SIGHUP）。之後由呼叫端停 runtime、送出最後一筆。
async fn wait_for_shutdown() {
    #[cfg(windows)]
    {
        use tokio::signal::windows;
        let (mut close, mut logoff, mut shutdown, mut brk) = (
            windows::ctrl_close().ok(),
            windows::ctrl_logoff().ok(),
            windows::ctrl_shutdown().ok(),
            windows::ctrl_break().ok(),
        );
        async fn next<T>(s: Option<&mut T>) -> Option<()>
        where
            T: WindowsSignal,
        {
            match s {
                Some(s) => s.recv_signal().await,
                None => std::future::pending().await,
            }
        }
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = next(close.as_mut()) => {}
            _ = next(logoff.as_mut()) => {}
            _ = next(shutdown.as_mut()) => {}
            _ = next(brk.as_mut()) => {}
        }
    }
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).ok();
        let mut hup = signal(SignalKind::hangup()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async { match term.as_mut() { Some(s) => { s.recv().await; } None => std::future::pending::<()>().await } } => {}
            _ = async { match hup.as_mut() { Some(s) => { s.recv().await; } None => std::future::pending::<()>().await } } => {}
        }
    }
}

#[cfg(windows)]
trait WindowsSignal {
    async fn recv_signal(&mut self) -> Option<()>;
}

#[cfg(windows)]
macro_rules! windows_signal {
    ($($t:ty),*) => {$(
        impl WindowsSignal for $t {
            async fn recv_signal(&mut self) -> Option<()> {
                self.recv().await
            }
        }
    )*};
}

#[cfg(windows)]
windows_signal!(
    tokio::signal::windows::CtrlClose,
    tokio::signal::windows::CtrlLogoff,
    tokio::signal::windows::CtrlShutdown,
    tokio::signal::windows::CtrlBreak
);

/// dry run 的輸出：每筆發佈的 record 印一行 JSON（上游 agent.js `deliver`），其他事件照常記 log。
fn record_printer() -> EventSink {
    let log = log_event();
    Arc::new(move |event| {
        if let CoreEvent::RecordPublished { record, .. } = &event {
            print_json(&**record, false);
        }
        log(event);
    })
}

async fn cmd_run(
    cli: &Cli,
    ctx: Context,
    interval_ms: Option<u64>,
    events: bool,
    dry_run: bool,
) -> AppResult<()> {
    let source = scan_source(cli, &ctx.settings)?;
    let client = if dry_run {
        None
    } else {
        Some(hub_client(&ctx.hub)?)
    };
    let interval = interval_ms
        .unwrap_or(ctx.settings.collection_interval_ms)
        .max(60_000);
    // 固定 JSON 來源（測試）沒有檔案可監看，也不探測額度。
    let watch = match source {
        ScanSource::Tokscale(_) => WatchConfig::from_settings(&ctx.settings),
        ScanSource::Fixtures(_) => None,
    };
    let limits = limits_config(&ctx.settings, &source);
    tracing::info!(
        device = %ctx.device_id,
        hub = %client.as_ref().map_or_else(|| "(dry run)".to_string(), |c| c.base_url().to_string()),
        interval_ms = interval,
        upload_interval_ms = ctx.settings.sync_upload_interval_ms, source = %source.describe(),
        watch = watch.is_some(),
        limits = ?limits.as_ref().map(|l| l.providers.join(",")),
        "tm-agent started"
    );
    let sink = if events {
        event_printer()
    } else if dry_run {
        record_printer()
    } else {
        log_event()
    };
    let rt = DeviceRuntime::start(RuntimeConfig {
        envelope: identity::envelope(&ctx.device_id, identity::RUNTIME_AGENT)
            .with_owner_email(&ctx.settings.owner_email),
        collector: CollectorConfig::from_settings(&ctx.settings),
        source,
        collection_interval: Duration::from_millis(interval),
        history_interval: Duration::from_millis(ctx.settings.history_interval_ms),
        session_archive: ctx
            .settings
            .session_usage_archive_enabled
            .then(|| crate::store::config_dir().join(crate::usage::archive_store::ARCHIVE_FILE)),
        archive_writes: !dry_run,
        anchor_file: (!dry_run)
            .then(|| crate::store::config_dir().join(crate::collector::ANCHOR_FILE)),
        upload_interval_ms: ctx.settings.sync_upload_interval_ms,
        sender: client.map(hub_sender),
        events: sink,
        watch,
        limits,
        progressive: false,
        seed_from_anchor: false,
    });
    wait_for_shutdown().await;
    tracing::info!("stopping");
    rt.stop().await;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn cmd_once(
    cli: &Cli,
    ctx: Context,
    dry_run: bool,
    write_archives: bool,
    json: bool,
    payload: bool,
    anchor: Option<ScanSource>,
) -> AppResult<()> {
    let source = scan_source(cli, &ctx.settings)?;
    let limits = limits_config(&ctx.settings, &source);
    let sender = if dry_run {
        None
    } else {
        Some(hub_sender(hub_client(&ctx.hub)?))
    };
    let (record, ingest) = DeviceRuntime::run_once_with_anchor(
        RuntimeConfig {
            envelope: identity::envelope(&ctx.device_id, identity::RUNTIME_AGENT)
                .with_owner_email(&ctx.settings.owner_email),
            collector: CollectorConfig::from_settings(&ctx.settings),
            source,
            collection_interval: Duration::from_secs(300),
            history_interval: Duration::from_millis(ctx.settings.history_interval_ms),
            session_archive: ctx.settings.session_usage_archive_enabled.then(|| {
                crate::store::config_dir().join(crate::usage::archive_store::ARCHIVE_FILE)
            }),
            archive_writes: !dry_run || write_archives,
            anchor_file: None,
            upload_interval_ms: ctx.settings.sync_upload_interval_ms,
            sender,
            events: crate::device::events::noop_sink(),
            watch: None,
            limits,
            progressive: false,
            seed_from_anchor: false,
        },
        anchor,
    )
    .await?;
    if json {
        print_json(&*record, false);
    }
    if payload {
        let value =
            serde_json::to_value(&*record).map_err(|e| AppError::Internal(e.to_string()))?;
        print_json(
            &serialize_sync_payload(&value, PayloadOptions::default()).payload,
            false,
        );
    }
    match ingest {
        None => {
            eprintln!(
                "dry run {}: today={} month={} allTime={}",
                record.device_id,
                record.today.total_tokens,
                record.month.total_tokens,
                record.all_time.total_tokens
            );
            Ok(())
        }
        Some(Ok(outcome)) => {
            eprintln!(
                "[{}] posted {}: today={} month={} allTime={} ({} bytes{})",
                crate::wire::time::iso_millis(chrono::Utc::now()),
                record.device_id,
                record.today.total_tokens,
                record.month.total_tokens,
                record.all_time.total_tokens,
                outcome.bytes,
                if outcome.retried {
                    ", reduced after 413"
                } else {
                    ""
                }
            );
            Ok(())
        }
        Some(Err(e)) => Err(e),
    }
}

/// 相容測試：把固定的 API 回應交給與正式探測相同的對應函式，身分欄位留空、時間固定。
fn cmd_limits_replay(dir: &std::path::Path) -> AppResult<()> {
    use crate::limits::normalize::finish_provider;
    use crate::wire::{LimitProvider, LimitsSummary, ProviderStatus};
    const AT: &str = "2026-01-01T00:00:00.000Z";
    let read = |name: &str| -> AppResult<Option<serde_json::Value>> {
        match std::fs::read_to_string(dir.join(name)) {
            Ok(t) => serde_json::from_str(&t)
                .map(Some)
                .map_err(|e| AppError::InvalidArgument(format!("{name}: {e}"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(AppError::Storage(e.to_string())),
        }
    };
    let mut providers = Vec::new();
    if let Some(u) = read("claude-usage.json")? {
        providers.push(finish_provider(LimitProvider {
            source: "oauth".into(),
            windows: crate::limits::claude::map_usage(&u),
            ..LimitProvider::status_row("claude", ProviderStatus::Ok, AT.into())
        }));
    }
    if let Some(u) = read("codex-usage.json")? {
        let plan = u.get("plan_type").and_then(|v| v.as_str()).unwrap_or("");
        providers.push(finish_provider(LimitProvider {
            source: "oauth".into(),
            account_label: crate::limits::plan::codex_plan_label(plan),
            windows: crate::limits::codex::map_usage(&u),
            ..LimitProvider::status_row("codex", ProviderStatus::Ok, AT.into())
        }));
    }
    if let Some(u) = read("copilot-usage.json")? {
        providers.push(crate::limits::copilot::provider_row(
            &crate::limits::copilot::parse_usage(&u),
            crate::limits::hash::hash_key(&["copilot", "octocat"]),
            "octocat",
            AT.into(),
        ));
    }
    if let Some(u) = read("cursor-usage.json")? {
        providers.push(crate::limits::cursor::replay(&u, AT.into()));
    }
    print_json(
        &LimitsSummary {
            updated_at: Some(AT.into()),
            refresh_ms: 300_000,
            providers,
        },
        false,
    );
    Ok(())
}

async fn cmd_limits(ctx: Context, json: bool) -> AppResult<()> {
    let config = LimitsConfig::from_settings(&ctx.settings).unwrap_or(LimitsConfig {
        providers: crate::settings::SUPPORTED_LIMIT_PROVIDERS
            .iter()
            .map(|s| s.to_string())
            .collect(),
        refresh_ms: ctx.settings.limits_refresh_ms,
    });
    let (summary, _) = LimitsRuntime::new(config).probe_all().await;
    if json {
        print_json(&summary, false);
        return Ok(());
    }
    for p in &summary.providers {
        println!(
            "{:<7} {:?}  {} {}",
            p.provider, p.status, p.account_label, p.account_email
        );
        for w in &p.windows {
            let pct = w
                .used_percent
                .map(|v| format!("{v:.1}%"))
                .unwrap_or_else(|| "-".into());
            println!(
                "   {:<8} {:<14} {:>7}  resets {}",
                format!("{:?}", w.kind).to_lowercase(),
                w.label,
                pct,
                w.resets_at.as_deref().unwrap_or("-")
            );
        }
    }
    Ok(())
}

async fn cmd_company(
    ctx: Context,
    json: bool,
    timeout_secs: u64,
    follow_secs: u64,
) -> AppResult<()> {
    use crate::hub::stream::{self, StreamEvent, StreamState};
    let client = hub_client(&ctx.hub)?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();
    let cancel = tokio_util::sync::CancellationToken::new();
    let task = stream::spawn(
        client,
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
        cancel.clone(),
    );
    let wait = async {
        while let Some(event) = rx.recv().await {
            match event {
                StreamEvent::Stats(stats) => return Ok(stats),
                StreamEvent::State {
                    state: StreamState::Unauthorized,
                    ..
                } => return Err(AppError::Hub(HubError::Unauthorized { status: 401 })),
                StreamEvent::State { state, error } => {
                    tracing::debug!(?state, ?error, "hub stream");
                }
            }
        }
        Err(AppError::Internal("stream ended".into()))
    };
    let result = tokio::time::timeout(Duration::from_secs(timeout_secs.max(1)), wait).await;
    let mut stats = match result {
        Ok(Ok(stats)) => stats,
        Ok(Err(e)) => {
            cancel.cancel();
            let _ = task.await;
            return Err(e);
        }
        Err(_) => {
            cancel.cancel();
            let _ = task.await;
            return Err(AppError::Hub(HubError::Timeout));
        }
    };
    if follow_secs > 0 {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(follow_secs);
        while let Ok(Some(event)) = tokio::time::timeout_at(deadline, rx.recv()).await {
            match event {
                StreamEvent::Stats(s) => {
                    let online = s.devices.iter().filter(|d| !d.stale).count();
                    println!(
                        "[{}] update: {} devices, {} online (hub updatedAt {})",
                        crate::wire::time::iso_millis(chrono::Utc::now()),
                        s.devices.len(),
                        online,
                        s.updated_at.as_deref().unwrap_or("-")
                    );
                    // 最後的摘要用最新的快照。
                    stats = s;
                }
                StreamEvent::State { state, error } => {
                    println!("stream {state:?} {}", error.unwrap_or_default());
                }
            }
        }
    }
    cancel.cancel();
    let _ = task.await;
    let company =
        crate::display::compose_company(&stats, None, chrono::Utc::now().timestamp_millis());
    if json {
        print_json(&company, false);
        return Ok(());
    }
    let p = &company.periods;
    println!(
        "devices {} (online {}) · today {} tokens ${:.2} · month {} tokens ${:.2}",
        company.device_count,
        company.online_count,
        p.today.total_tokens,
        p.today.cost_usd,
        p.month.total_tokens,
        p.month.cost_usd
    );
    for d in company.devices.iter().take(20) {
        println!(
            "  {:<20} {:<14} {:>14} {}",
            d.hostname,
            d.agent_runtime,
            d.today.total_tokens,
            if d.stale { "stale" } else { "online" }
        );
    }
    Ok(())
}

async fn cmd_scan(cli: &Cli, ctx: Context, period: PeriodArg, raw: bool) -> AppResult<()> {
    let source = scan_source(cli, &ctx.settings)?;
    let ScanSource::Tokscale(scanner) = source else {
        return Err(AppError::InvalidArgument(
            "scan needs the real tokscale".into(),
        ));
    };
    let period = match period {
        PeriodArg::Today => ScanPeriod::Today,
        PeriodArg::Month => ScanPeriod::Month,
        PeriodArg::Alltime => ScanPeriod::Since(ctx.settings.all_time_since.clone()),
    };
    let json = scanner
        .scan(
            &ctx.settings.tracked_clients,
            &period,
            ctx.settings.projects_enabled,
            &CancellationToken::new(),
        )
        .await?;
    if raw {
        print_json(&json, true);
    } else {
        print_json(
            &crate::usage::period_from_tokscale(json, ctx.settings.projects_enabled),
            true,
        );
    }
    Ok(())
}

async fn cmd_health(ctx: Context) -> AppResult<()> {
    let client = hub_client(&ctx.hub)?;
    let info = client.health().await?;
    print_json(&info.body, true);
    Ok(())
}

async fn cmd_doctor(cli: &Cli, ctx: Context) -> AppResult<()> {
    let ok = |b: bool| if b { "ok  " } else { "FAIL" };
    println!(
        "Token Monitor {} ({} build)",
        crate::baked::AGENT_VERSION,
        crate::baked::BUILD_CHANNEL
    );
    println!("config dir      {}", crate::store::config_dir().display());
    println!("device id       {}", ctx.device_id);
    println!("hostname        {}", identity::hostname());
    let (os_name, os_version) = identity::os_info();
    println!(
        "os              {os_name} {os_version} ({})",
        identity::platform()
    );
    println!("tracked clients {}", ctx.settings.tracked_clients.join(","));
    println!(
        "upload interval {} ms",
        ctx.settings.sync_upload_interval_ms
    );
    let mut healthy = true;
    match scan_source(cli, &ctx.settings) {
        Ok(ScanSource::Tokscale(s)) => {
            let v = s.version(&CancellationToken::new()).await;
            healthy &= v.is_ok();
            println!(
                "[{}] tokscale    {} ({}) {}",
                ok(v.is_ok()),
                s.bin.path.display(),
                s.bin.source,
                v.unwrap_or_else(|e| e.message())
            );
        }
        Ok(other) => println!("[ok  ] source      {}", other.describe()),
        Err(e) => {
            healthy = false;
            println!("[FAIL] tokscale    {}", e.message());
            if let AppError::TokscaleMissing(paths) = &e {
                for p in paths {
                    println!("         searched {p}");
                }
            }
        }
    }
    println!(
        "[{}] hub url     {} ({:?})",
        ok(ctx.hub.url.is_some()),
        ctx.hub.url.as_deref().unwrap_or("-"),
        ctx.hub.url_source
    );
    println!(
        "[{}] secret      {} ({:?})",
        ok(ctx.hub.secret.is_some()),
        ctx.hub
            .secret
            .as_deref()
            .map(mask_secret)
            .unwrap_or_else(|| "-".into()),
        ctx.hub.secret_source
    );
    healthy &= ctx.hub.url.is_some() && ctx.hub.secret.is_some();
    let home = dirs::home_dir().unwrap_or_default();
    let tracked = |c: &str| ctx.settings.tracked_clients.iter().any(|x| x == c);
    if tracked("cursor") {
        // 只讀不寫：doctor 不改任何帳號檔。
        let desktop = crate::collector::cursor::read_desktop_access_token(
            &crate::collector::cursor::desktop_state_candidates(&home),
        );
        let saved = crate::collector::cursor::saved_account_count(
            &crate::collector::cursor::credentials_path(&home),
        );
        let desktop = match desktop {
            Ok(Some(_)) => "desktop signed in".to_string(),
            Ok(None) => "desktop not signed in".to_string(),
            Err(e) => format!("desktop unreadable: {}", e.message()),
        };
        println!("[info] cursor      {desktop}; {saved} saved tokscale account(s)");
    }
    if tracked("antigravity") {
        let present = crate::collector::antigravity::data_present(&home);
        println!(
            "[info] antigravity {}",
            if present {
                "IDE data found (synced before each scan)"
            } else {
                "no IDE data"
            }
        );
    }
    if ctx.hub.url.is_some() {
        match hub_client(&ctx.hub) {
            Ok(client) => match client.health().await {
                Ok(info) => {
                    let build = info
                        .body
                        .pointer("/hubBuild/coreBuildId")
                        .and_then(|v| v.as_str())
                        .map(|s| {
                            s.trim_start_matches("sha256:")
                                .chars()
                                .take(12)
                                .collect::<String>()
                        })
                        .unwrap_or_else(|| "?".into());
                    let devices = info
                        .body
                        .get("deviceCount")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    println!(
                        "[ok  ] hub health  HTTP {} core={build} devices={devices}",
                        info.status
                    );
                }
                Err(e) => {
                    healthy = false;
                    println!("[FAIL] hub health  {} ({})", e.message(), e.code());
                }
            },
            Err(e) => {
                healthy = false;
                println!("[FAIL] hub         {}", e.message());
            }
        }
    }
    if healthy {
        Ok(())
    } else {
        Err(AppError::Internal("doctor found problems".into()))
    }
}

fn cmd_secret(action: SecretAction) -> AppResult<()> {
    match action {
        SecretAction::Set { from_env } => {
            let value = std::env::var(&from_env).map_err(|_| {
                AppError::InvalidArgument(format!("environment variable {from_env} is not set"))
            })?;
            if value.trim().len() < 8 {
                return Err(AppError::InvalidArgument("secret is too short".into()));
            }
            crate::secrets::set_override_secret(&value)?;
            eprintln!("saved override secret {}", mask_secret(value.trim()));
        }
        SecretAction::Clear => {
            crate::secrets::clear_override_secret()?;
            eprintln!("override secret cleared; the built-in secret is used again");
        }
    }
    Ok(())
}

pub async fn run(cli: Cli) -> ExitCode {
    crate::logging::init_cli(cli.verbose);
    let result = async {
        let ctx = load_context(&cli)?;
        match cli.command {
            Command::Run {
                interval_ms,
                events,
                ref watch,
                watch_debounce_ms,
                dry_run,
            } => {
                let mut ctx = ctx;
                if let Some(w) = watch {
                    ctx.settings.watch_enabled = w.trim() != "0";
                }
                if let Some(ms) = watch_debounce_ms {
                    ctx.settings.watch_debounce_ms = ms;
                    ctx.settings.validate();
                }
                cmd_run(&cli, ctx, interval_ms, events, dry_run).await
            }
            Command::Once {
                dry_run,
                json,
                payload,
                ref anchor_json_dir,
                write_archives,
            } => {
                let anchor = anchor_json_dir.clone().map(ScanSource::Fixtures);
                cmd_once(&cli, ctx, dry_run, write_archives, json, payload, anchor).await
            }
            Command::Scan { ref period, raw } => cmd_scan(&cli, ctx, period.clone(), raw).await,
            Command::Health => cmd_health(ctx).await,
            Command::Limits { json, ref replay } => match replay {
                Some(dir) => cmd_limits_replay(dir),
                None => cmd_limits(ctx, json).await,
            },
            Command::Company {
                json,
                timeout_secs,
                follow_secs,
            } => cmd_company(ctx, json, timeout_secs, follow_secs).await,
            Command::Doctor => cmd_doctor(&cli, ctx).await,
            Command::Secret { action } => cmd_secret(action),
            Command::Settings => {
                print_json(&ctx.settings, true);
                Ok(())
            }
            Command::SessionDetail {
                ref client,
                ref session_id,
                ref period,
                cost,
            } => {
                let home = dirs::home_dir().unwrap_or_default();
                let detail = crate::session_detail::read_session_detail(
                    client,
                    session_id,
                    period,
                    cost,
                    &home,
                    chrono::Local::now(),
                );
                print_json(&detail, true);
                Ok(())
            }
        }
    }
    .await;
    match result {
        Ok(()) => ExitCode::from(exit::OK),
        Err(e) => {
            eprintln!("error: {} ({})", e.message(), e.code());
            ExitCode::from(exit_code_for(&e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        normalize_args(list.iter().map(|s| std::ffi::OsString::from(*s)).collect())
            .into_iter()
            .map(|a| a.into_string().unwrap())
            .collect()
    }

    #[test]
    fn upstream_agent_invocations_still_work() {
        assert_eq!(
            args(&[
                "tm-agent",
                "--once",
                "--dry-run",
                "--hubUrl=https://hub",
                "--intervalMs",
                "5000"
            ]),
            ["tm-agent", "once", "--dry-run", "--hub=https://hub"]
        );
        assert_eq!(
            args(&["tm-agent", "--deviceId", "pc-1", "--watchDebounceMs=900"]),
            [
                "tm-agent",
                "run",
                "--device",
                "pc-1",
                "--watch-debounce-ms=900"
            ]
        );
        assert_eq!(args(&["tm-agent"]), ["tm-agent", "run"]);
        assert_eq!(args(&["tm-agent", "doctor"]), ["tm-agent", "doctor"]);
        assert_eq!(args(&["tm-agent", "--help"]), ["tm-agent", "--help"]);
    }
}
