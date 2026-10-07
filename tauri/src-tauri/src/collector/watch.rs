//! 來源目錄的檔案監看：有相關變動就請 runtime 跑一次 anchored tick（上游 collector.js 的
//! chokidar watcher、`watchPolicyEntries` 與 `handleWatchError`）。
//!
//! 監看的根目錄由 roots.rs 的來源表推出（上游 `clientWatchCandidates`），只算 client **自己寫**的紀錄：
//! - Cursor 與 Antigravity 的內建位置不監看。它們的用量來自 tokscale 自己同步寫入的 cache，監看會自我
//!   觸發無限重掃（上游 issue #15）；它們由定時的 anchored tick（含自我同步）更新。使用者為它們設定的
//!   額外掃描目錄是外部輸入，照樣監看（上游相同）；但任何與這兩個 cache 重疊的根目錄一律不監看。
//! - Copilot 的 `~/.copilot` 只算 `otel/` 與兩個資料庫；VS Code 的 workspaceStorage 只算
//!   `<hash>/chatSessions/` 與 `<hash>/workspace.json`：VS Code 隨時在那裡寫別的東西，不過濾就會一直重掃。
//!   `COPILOT_OTEL_FILE_EXPORTER_PATH` 的檔案可能還不存在，所以監看它的上層，但只算那一個檔。
//! - Hermes 的 home 與每個 `profiles/<name>` 只算 `state.db`（含 -wal / -shm）。
//! - 使用者設定的額外掃描目錄（`customScanPaths`）整棵監看，與 tokscale 的遞迴讀法一致。
//!
//! 兩種監看方式（上游 `resolveWatchUsePolling`、`handleWatchError`）：
//! - 原生事件（預設；Windows 是 ReadDirectoryChangesW）。
//! - 每 2 秒輪詢：`TOKEN_MONITOR_WATCH_POLLING` 開啟時；或系統拒絕給監看描述符（ENOSPC / EMFILE /
//!   ENFILE，Linux 的 inotify 額度與編輯器共用）之後，這個 runtime 剩下的時間都輪詢（sticky，重試原生
//!   只會再撞一次同一個額度）。`TOKEN_MONITOR_WATCH_POLLING=0` 連這個退路也關掉。輪詢以與事件相同的規則
//!   剪枝，不走進 tokscale 不讀的子目錄（上游 issue #38：整棵輪詢 Hermes 的 runtime 把 CPU 吃滿）。
//!   notify 的 `PollWatcher` 不能剪枝、mtime 只到秒，所以自己走目錄。
//!
//! 監看是加速，不是事實來源：漏掉的事件由定時 tick 與每小時的完整掃描補上。

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use indexmap::IndexMap;
use notify::{EventKind, RecursiveMode, Watcher as _};
use serde::Serialize;

use super::roots;

/// 輪詢的間隔（上游 chokidar `interval: 2000`）。
pub const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// 一個監看根目錄與它的事件過濾規則。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchRoot {
    pub client: String,
    pub dir: PathBuf,
    pub recursive: bool,
    pub filter: Filter,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Filter {
    /// tokscale 整棵讀的 transcript 樹：任何變動都算。
    All,
    /// `~/.copilot`：`otel/` 底下，或最上層的 `data.db` / `session-store.db`（含 -wal / -shm）。
    CopilotHome,
    /// VS Code `workspaceStorage`：只有 `<hash>/chatSessions/…` 與 `<hash>/workspace.json`。
    WorkspaceStorage,
    /// OpenCode 資料目錄：`opencode[-<channel>].db`（含 -wal / -shm）與舊版的 `storage/message/*/*.json`。
    OpencodeData,
    /// Hermes 的 home 或 profile：只有 `state.db`（含 -wal / -shm）。
    HermesHome,
    /// 只有這一個檔名（`COPILOT_OTEL_FILE_EXPORTER_PATH`；tokscale 只讀那個檔）。
    File(String),
}

/// 不監看內建位置的 client：用量來自 tokscale 自己寫的 cache（見檔頭）。
pub const SELF_SYNCED: &[&str] = &["cursor", "antigravity"];

fn parts(root: &Path, path: &Path) -> Option<Vec<String>> {
    let rel = path.strip_prefix(root).ok()?;
    Some(
        rel.components()
            .filter_map(|c| match c {
                Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect(),
    )
}

/// SQLite 的資料庫與它的 -wal / -shm（上游的 `*_DB_WATCH_PATTERN`；WAL/SHM 是即時寫入的訊號）。
fn is_sqlite_family(name: &str, db: &str) -> bool {
    name.strip_prefix(db)
        .is_some_and(|rest| matches!(rest, "" | "-wal" | "-shm"))
}

/// 上游 `OPENCODE_DB_WATCH_PATTERN`：`^opencode(?:-[A-Za-z0-9._-]+)?\.db(?:-(?:wal|shm))?$`。
fn is_opencode_db(name: &str) -> bool {
    let base = name
        .strip_suffix("-wal")
        .or_else(|| name.strip_suffix("-shm"))
        .unwrap_or(name);
    let Some(rest) = base
        .strip_suffix(".db")
        .and_then(|b| b.strip_prefix("opencode"))
    else {
        return false;
    };
    match rest.strip_prefix('-') {
        None => rest.is_empty(),
        Some(channel) => {
            !channel.is_empty()
                && channel
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        }
    }
}

/// 上游 opencode 的 watch policy：tokscale 只讀直接的資料庫與 `storage/message/*/*.json`。
fn opencode_keeps(parts: &[String]) -> bool {
    match parts {
        [one] => one == "storage" || is_opencode_db(one),
        [storage, ..] if storage != "storage" => false,
        [_, message] => message == "message",
        [_, message, ..] if message != "message" => false,
        [_, _, _session] => true,
        [_, _, _, file] => file.ends_with(".json"),
        _ => false,
    }
}

fn same_file_name(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

impl WatchRoot {
    /// 這個路徑的變動會不會改變 tokscale 讀到的東西。根目錄本身（新建、刪除）一律算。
    pub fn is_relevant(&self, path: &Path) -> bool {
        match parts(&self.dir, path) {
            Some(parts) => parts.is_empty() || self.keeps(&parts),
            None => false,
        }
    }

    /// `parts` 是根目錄底下的相對路徑（非空）。
    fn keeps(&self, parts: &[String]) -> bool {
        if !self.recursive && parts.len() > 1 {
            return false;
        }
        match &self.filter {
            Filter::All => true,
            Filter::CopilotHome => {
                parts[0] == "otel"
                    || (parts.len() == 1
                        && (is_sqlite_family(&parts[0], "data.db")
                            || is_sqlite_family(&parts[0], "session-store.db")))
            }
            // `<hash>` 目錄本身不算：VS Code 在裡面建刪別的檔時，它的修改時間一直在變。
            Filter::WorkspaceStorage => {
                parts.len() >= 2
                    && (parts[1] == "chatSessions"
                        || (parts.len() == 2 && parts[1] == "workspace.json"))
            }
            Filter::OpencodeData => opencode_keeps(parts),
            Filter::HermesHome => parts.len() == 1 && is_sqlite_family(&parts[0], "state.db"),
            Filter::File(name) => parts.len() == 1 && same_file_name(&parts[0], name),
        }
    }

    /// 輪詢時要不要走進這個子目錄（上游 chokidar 不遞迴進被 `ignored` 的目錄）。
    fn descends(&self, parts: &[String]) -> bool {
        if !self.recursive {
            return false;
        }
        match &self.filter {
            Filter::All => true,
            Filter::CopilotHome => parts[0] == "otel",
            Filter::WorkspaceStorage => parts.len() == 1 || parts[1] == "chatSessions",
            Filter::OpencodeData => parts.len() <= 3 && opencode_keeps(parts),
            Filter::HermesHome | Filter::File(_) => false,
        }
    }

    /// 輪詢：把這個根目錄底下相關的項目記進 `out`，只走 `descends` 允許的子目錄。
    /// 符號連結不跟（`DirEntry::metadata` 不解析連結），迴圈的連結才不會讓它走不完。
    fn scan_into(&self, out: &mut HashMap<PathBuf, Stamp>) {
        if !self.dir.is_dir() {
            return;
        }
        out.insert(self.dir.clone(), Stamp::DIR);
        let mut stack = vec![(self.dir.clone(), Vec::<String>::new())];
        while let Some((dir, prefix)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                let mut rel = prefix.clone();
                rel.push(entry.file_name().to_string_lossy().into_owned());
                let path = entry.path();
                if self.keeps(&rel) {
                    out.insert(path.clone(), Stamp::of(&meta));
                }
                if meta.is_dir() && self.descends(&rel) {
                    stack.push((path, rel));
                }
            }
        }
    }
}

/// 輪詢比對用的狀態。目錄只看有沒有（它的修改時間只反映子項目的增減，子項目本身另有紀錄）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    dir: bool,
    len: u64,
    modified: Option<SystemTime>,
}

impl Stamp {
    const DIR: Stamp = Stamp {
        dir: true,
        len: 0,
        modified: None,
    };

    fn of(meta: &std::fs::Metadata) -> Stamp {
        if meta.is_dir() {
            return Stamp::DIR;
        }
        Stamp {
            dir: false,
            len: meta.len(),
            modified: meta.modified().ok(),
        }
    }
}

fn snapshot(roots: &[WatchRoot]) -> HashMap<PathBuf, Stamp> {
    let mut out = HashMap::new();
    for root in roots {
        root.scan_into(&mut out);
    }
    out
}

/// Windows 的路徑不分大小寫。
fn fold(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    }
}

/// 根目錄在 tokscale 的 cache 裡，或（遞迴時）把 cache 包在裡面。
fn overlaps_self_synced_cache(root: &WatchRoot, caches: &[PathBuf]) -> bool {
    let dir = fold(&root.dir);
    caches
        .iter()
        .map(|c| fold(c))
        .any(|cache| dir.starts_with(&cache) || (root.recursive && cache.starts_with(&dir)))
}

/// 追蹤中的 client 的監看根目錄（不檢查是否存在；`start` 只監看存在的）。每次呼叫都重新計算：
/// Hermes 的 profile 可能之後才出現（上游每次 `setupWatchers` 都重新推一次）。
pub fn watch_roots(
    tracked: &[String],
    custom_scan_paths: &IndexMap<String, Vec<String>>,
    home: &Path,
) -> Vec<WatchRoot> {
    let caches = roots::self_synced_cache_dirs(home);
    let mut out: Vec<WatchRoot> = Vec::new();
    for client in tracked {
        let self_synced = SELF_SYNCED.contains(&client.as_str());
        for source in roots::client_source_roots(client, home, custom_scan_paths) {
            let spec = if source.custom {
                Some((true, Filter::All))
            } else if self_synced {
                None
            } else {
                match source.id {
                    "claude-projects" | "claude-transcripts" | "codex-sessions" => {
                        Some((true, Filter::All))
                    }
                    "opencode-data" => Some((true, Filter::OpencodeData)),
                    "hermes-home" | "hermes-profile" => Some((false, Filter::HermesHome)),
                    // 兩個資料庫的上層都是 `~/.copilot`，`otel/` 也由這棵樹涵蓋：不另外監看同一棵
                    // 子樹（上游 `clientWatchCandidates` 拿掉 copilot-otel）。
                    "copilot-data" | "copilot-session-store" => Some((true, Filter::CopilotHome)),
                    "vscode-workspace-storage" => Some((true, Filter::WorkspaceStorage)),
                    "copilot-otel-exporter" => source
                        .source_path
                        .as_deref()
                        .and_then(Path::file_name)
                        .map(|name| (false, Filter::File(name.to_string_lossy().into_owned()))),
                    _ => None,
                }
            };
            let Some((recursive, filter)) = spec else {
                continue;
            };
            let root = WatchRoot {
                client: client.clone(),
                dir: source.dir,
                recursive,
                filter,
            };
            if overlaps_self_synced_cache(&root, &caches) {
                tracing::warn!(
                    client = %client,
                    dir = %root.dir.display(),
                    "not watching a source dir that overlaps a tokscale cache"
                );
                continue;
            }
            if !out.contains(&root) {
                out.push(root);
            }
        }
    }
    out
}

/// 用哪一種方式監看。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WatchMode {
    Native,
    Polling,
}

/// 上游 `watchPollingEnvOverride`：三態。沒設（或空白）= 沒有意見；`0` / `false` / `no` / `off`
/// = 不輪詢；其他任何值 = 輪詢。
pub fn polling_override(raw: Option<&str>) -> Option<bool> {
    let value = raw?.trim().to_lowercase();
    if value.is_empty() {
        return None;
    }
    Some(!matches!(value.as_str(), "0" | "false" | "no" | "off"))
}

/// 監看方式的決策（上游 `watchUsePolling`、`watchNativeForced`、`watchDescriptorFallback`）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PollingPolicy {
    /// 一開始就輪詢（`TOKEN_MONITOR_WATCH_POLLING` 開啟）。預設是原生事件。
    pub use_polling: bool,
    /// `TOKEN_MONITOR_WATCH_POLLING=0`：描述符耗盡也不改輪詢。
    pub native_forced: bool,
    /// 描述符耗盡後改成輪詢的原因（`ENOSPC` 等）；之後都輪詢。
    pub fallback: Option<&'static str>,
}

impl PollingPolicy {
    /// GUI 與 tm-agent 共用同一個環境變數，兩者不會分岔（上游在 collector 裡解析而不是各入口）。
    pub fn from_env() -> PollingPolicy {
        let raw = std::env::var_os("TOKEN_MONITOR_WATCH_POLLING");
        PollingPolicy::from_override(polling_override(
            raw.as_ref().map(|v| v.to_string_lossy()).as_deref(),
        ))
    }

    pub fn from_override(value: Option<bool>) -> PollingPolicy {
        PollingPolicy {
            use_polling: value == Some(true),
            native_forced: value == Some(false),
            fallback: None,
        }
    }

    pub fn mode(&self) -> WatchMode {
        if self.use_polling || self.fallback.is_some() {
            WatchMode::Polling
        } else {
            WatchMode::Native
        }
    }

    /// 原生監看拿不到描述符。回 `true` = 這次開始改用輪詢，呼叫端要重建 watcher。
    pub fn on_exhausted(&mut self, code: &'static str) -> bool {
        if self.use_polling || self.native_forced || self.fallback.is_some() {
            return false;
        }
        self.fallback = Some(code);
        true
    }
}

/// 監看送給 runtime 的訊號（在 notify 或輪詢的執行緒上，要夠輕）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    /// 有相關的變動。
    Change,
    /// 執行中的原生監看拿不到描述符（例如 inotify 為新目錄加監看時）。
    Exhausted(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartError {
    /// 系統的監看描述符用完了（上游 `WATCH_DESCRIPTOR_ERROR_CODES`）。
    Exhausted(&'static str),
    Other(String),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::Exhausted(code) => write!(f, "系統的檔案監看額度已用完（{code}）"),
            StartError::Other(message) => f.write_str(message),
        }
    }
}

/// 上游只認 ENOSPC / EMFILE / ENFILE。inotify 的額度 notify 報成 `MaxFilesWatch`；Windows 的錯誤碼
/// 依 libuv 的對照換成同一組名字（ERROR_TOO_MANY_OPEN_FILES → EMFILE，磁碟滿 → ENOSPC）。
fn exhaustion_code(error: &notify::Error) -> Option<&'static str> {
    match &error.kind {
        notify::ErrorKind::MaxFilesWatch => Some("ENOSPC"),
        notify::ErrorKind::Io(io) => io.raw_os_error().and_then(os_exhaustion_code),
        _ => None,
    }
}

fn os_exhaustion_code(raw: i32) -> Option<&'static str> {
    if cfg!(windows) {
        match raw {
            4 => Some("EMFILE"),
            39 | 112 => Some("ENOSPC"),
            _ => None,
        }
    } else {
        // Linux 與 macOS / BSD 的 errno 值相同。
        match raw {
            28 => Some("ENOSPC"),
            24 => Some("EMFILE"),
            23 => Some("ENFILE"),
            _ => None,
        }
    }
}

/// 活著的監看。drop 即停止（輪詢執行緒在下一次等待時結束）。
pub struct Watcher {
    _native: Option<notify::RecommendedWatcher>,
    _poll_stop: Option<std::sync::mpsc::Sender<()>>,
    pub watched: Vec<PathBuf>,
    pub mode: WatchMode,
}

/// 開始監看存在的根目錄；有相關變動就送 `Signal::Change`。一個根目錄都監看不了時回錯，由 runtime
/// 退回只靠定時 tick；原生監看拿不到描述符時回 `StartError::Exhausted`，由 runtime 決定是否改輪詢。
pub fn start(
    roots: Vec<WatchRoot>,
    mode: WatchMode,
    on_signal: impl Fn(Signal) + Send + Sync + 'static,
) -> Result<Watcher, StartError> {
    start_with(roots, mode, POLL_INTERVAL, on_signal)
}

fn start_with(
    roots: Vec<WatchRoot>,
    mode: WatchMode,
    poll_interval: Duration,
    on_signal: impl Fn(Signal) + Send + Sync + 'static,
) -> Result<Watcher, StartError> {
    let existing: Vec<WatchRoot> = roots.into_iter().filter(|r| r.dir.is_dir()).collect();
    if existing.is_empty() {
        return Err(StartError::Other("沒有可監看的來源目錄".into()));
    }
    // 同一個目錄只監看一次，任何一個根要遞迴就遞迴；事件的過濾是所有根的聯集（上游
    // `watchIgnoreMatcher`：每個包含這個路徑的根都不要時才略過）。
    let mut targets: Vec<(PathBuf, bool)> = Vec::new();
    for r in &existing {
        match targets.iter_mut().find(|(dir, _)| *dir == r.dir) {
            Some(target) => target.1 |= r.recursive,
            None => targets.push((r.dir.clone(), r.recursive)),
        }
    }
    match mode {
        WatchMode::Native => start_native(existing, targets, on_signal),
        WatchMode::Polling => start_polling(existing, targets, poll_interval, on_signal),
    }
}

fn start_native(
    roots: Vec<WatchRoot>,
    targets: Vec<(PathBuf, bool)>,
    on_signal: impl Fn(Signal) + Send + Sync + 'static,
) -> Result<Watcher, StartError> {
    let filters = roots;
    let mut inner =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
            Ok(event) => {
                if matches!(event.kind, EventKind::Access(_)) {
                    return;
                }
                let relevant = event
                    .paths
                    .iter()
                    .any(|p| filters.iter().any(|r| r.is_relevant(p)));
                if relevant {
                    on_signal(Signal::Change);
                }
            }
            Err(error) => match exhaustion_code(&error) {
                Some(code) => on_signal(Signal::Exhausted(code)),
                None => tracing::debug!(%error, "file watch error"),
            },
        })
        .map_err(|e| match exhaustion_code(&e) {
            Some(code) => StartError::Exhausted(code),
            None => StartError::Other(e.to_string()),
        })?;
    let mut watched = Vec::new();
    for (dir, recursive) in &targets {
        let mode = if *recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        match inner.watch(dir, mode) {
            Ok(()) => watched.push(dir.clone()),
            // 額度用完後每個根都會撞同一個錯；已加上的監看隨 `inner` 一起放掉。
            Err(e) => match exhaustion_code(&e) {
                Some(code) => return Err(StartError::Exhausted(code)),
                None => {
                    tracing::warn!(dir = %dir.display(), error = %e, "cannot watch source dir")
                }
            },
        }
    }
    if watched.is_empty() {
        return Err(StartError::Other("來源目錄都無法監看".into()));
    }
    Ok(Watcher {
        _native: Some(inner),
        _poll_stop: None,
        watched,
        mode: WatchMode::Native,
    })
}

fn start_polling(
    roots: Vec<WatchRoot>,
    targets: Vec<(PathBuf, bool)>,
    interval: Duration,
    on_signal: impl Fn(Signal) + Send + Sync + 'static,
) -> Result<Watcher, StartError> {
    // 第一份快照在這裡同步取：start 回來之後的變動一定比得出來。
    let mut before = snapshot(&roots);
    let (stop, stopped) = std::sync::mpsc::channel::<()>();
    std::thread::Builder::new()
        .name("tm-watch-poll".into())
        .spawn(move || loop {
            match stopped.recv_timeout(interval) {
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                // Watcher 被 drop（sender 斷線）。
                _ => return,
            }
            let now = snapshot(&roots);
            if now != before {
                before = now;
                on_signal(Signal::Change);
            }
        })
        .map_err(|e| StartError::Other(e.to_string()))?;
    Ok(Watcher {
        _native: None,
        _poll_stop: Some(stop),
        watched: targets.into_iter().map(|(dir, _)| dir).collect(),
        mode: WatchMode::Polling,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    fn root(client: &str, dir: PathBuf, recursive: bool, filter: Filter) -> WatchRoot {
        WatchRoot {
            client: client.to_string(),
            dir,
            recursive,
            filter,
        }
    }

    fn r(dir: &str, filter: Filter) -> WatchRoot {
        let recursive = !matches!(filter, Filter::HermesHome | Filter::File(_));
        root("x", PathBuf::from(dir), recursive, filter)
    }

    #[test]
    fn copilot_home_only_counts_otel_and_databases() {
        let c = r("/h/.copilot", Filter::CopilotHome);
        assert!(c.is_relevant(Path::new("/h/.copilot/otel/2026-09-24.jsonl")));
        assert!(c.is_relevant(Path::new("/h/.copilot/data.db-wal")));
        assert!(c.is_relevant(Path::new("/h/.copilot/session-store.db")));
        assert!(!c.is_relevant(Path::new("/h/.copilot/data.db-journal")));
        assert!(!c.is_relevant(Path::new("/h/.copilot/logs/x.log")));
        assert!(!c.is_relevant(Path::new("/h/.copilot/config.json")));
        assert!(!c.is_relevant(Path::new("/elsewhere/data.db")));
        assert!(c.is_relevant(Path::new("/h/.copilot")), "the root itself");
    }

    #[test]
    fn workspace_storage_only_counts_chat_sessions() {
        let w = r("/a/Code/User/workspaceStorage", Filter::WorkspaceStorage);
        assert!(w.is_relevant(Path::new(
            "/a/Code/User/workspaceStorage/abc/chatSessions/1.json"
        )));
        assert!(w.is_relevant(Path::new("/a/Code/User/workspaceStorage/abc/chatSessions")));
        assert!(w.is_relevant(Path::new(
            "/a/Code/User/workspaceStorage/abc/workspace.json"
        )));
        assert!(!w.is_relevant(Path::new("/a/Code/User/workspaceStorage/abc/state.vscdb")));
        assert!(!w.is_relevant(Path::new(
            "/a/Code/User/workspaceStorage/abc/GitHub.copilot-chat/x.json"
        )));
        assert!(!w.is_relevant(Path::new("/a/Code/User/workspaceStorage/abc")));
    }

    #[test]
    fn opencode_filter_matches_upstream_policy() {
        let o = r("/x/opencode", Filter::OpencodeData);
        assert!(o.is_relevant(Path::new("/x/opencode/opencode.db")));
        assert!(o.is_relevant(Path::new("/x/opencode/opencode.db-wal")));
        assert!(o.is_relevant(Path::new("/x/opencode/opencode-dev.db-shm")));
        assert!(o.is_relevant(Path::new("/x/opencode/storage/message/ses_1/msg_1.json")));
        assert!(o.is_relevant(Path::new("/x/opencode/storage/message/ses_1")));
        assert!(!o.is_relevant(Path::new("/x/opencode/storage/part/ses_1/p.json")));
        assert!(!o.is_relevant(Path::new("/x/opencode/storage/message/ses_1/deep/x.json")));
        assert!(!o.is_relevant(Path::new("/x/opencode/storage/message/ses_1/x.txt")));
        assert!(!o.is_relevant(Path::new("/x/opencode/opencode.db.bak")));
        assert!(!o.is_relevant(Path::new("/x/opencode/opencode-.db")));
        assert!(!o.is_relevant(Path::new("/x/opencode/log/today.log")));
        for (name, want) in [
            ("opencode.db", true),
            ("opencode-beta.1_x.db-wal", true),
            ("opencode-a b.db", false),
            ("opencodex.db", false),
            ("opencode.db-journal", false),
        ] {
            assert_eq!(is_opencode_db(name), want, "{name}");
        }
    }

    #[test]
    fn hermes_and_exporter_filters_see_direct_children_only() {
        let h = r("/x/.hermes", Filter::HermesHome);
        assert!(h.is_relevant(Path::new("/x/.hermes/state.db-wal")));
        assert!(!h.is_relevant(Path::new("/x/.hermes/config.yaml")));
        assert!(!h.is_relevant(Path::new("/x/.hermes/profiles/work/state.db")));
        let f = r("/x/exports", Filter::File("copilot.jsonl".into()));
        assert!(f.is_relevant(Path::new("/x/exports/copilot.jsonl")));
        assert!(!f.is_relevant(Path::new("/x/exports/other.jsonl")));
        assert!(!f.is_relevant(Path::new("/x/exports/sub/copilot.jsonl")));
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn self_synced_caches_are_never_watched() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let tracked = strings(&["claude", "cursor", "antigravity", "copilot"]);
        let caches = roots::self_synced_cache_dirs(home);
        let mut custom = IndexMap::new();
        custom.insert(
            "antigravity".to_string(),
            strings(&["/c/antigravity-extra"]),
        );
        custom.insert(
            "claude".to_string(),
            vec![
                "/c/claude-extra".to_string(),
                // 包住 tokscale 的 cache：監看它等於監看 cache。
                caches[0].parent().unwrap().to_string_lossy().into_owned(),
            ],
        );
        let watched = watch_roots(&tracked, &custom, home);
        assert!(
            !watched.iter().any(|r| r.client == "cursor"),
            "no built-in cursor root"
        );
        assert_eq!(
            watched
                .iter()
                .filter(|r| r.client == "antigravity")
                .map(|r| r.dir.clone())
                .collect::<Vec<_>>(),
            vec![PathBuf::from("/c/antigravity-extra")],
            "only the user's own antigravity dir"
        );
        assert!(watched
            .iter()
            .any(|r| r.dir == Path::new("/c/claude-extra") && r.filter == Filter::All));
        for r in &watched {
            for cache in &caches {
                assert!(
                    !cache.starts_with(&r.dir) && !r.dir.starts_with(cache),
                    "{} overlaps {}",
                    r.dir.display(),
                    cache.display()
                );
            }
        }
        assert!(watched.iter().any(|r| r.filter == Filter::CopilotHome));
        assert_eq!(
            watched
                .iter()
                .filter(|r| r.filter == Filter::CopilotHome)
                .count(),
            1,
            "data.db and session-store.db share one ~/.copilot root"
        );
    }

    #[test]
    fn hermes_profiles_and_codex_headless_dirs_are_watched() {
        if std::env::var_os("HERMES_HOME").is_some()
            || std::env::var_os("TOKSCALE_HEADLESS_DIR").is_some()
        {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let hermes = home.join(".hermes");
        if roots::hermes_home(home) != hermes {
            return;
        }
        let profile = hermes.join("profiles").join("work");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("state.db"), b"").unwrap();
        let watched = watch_roots(&strings(&["hermes", "codex"]), &IndexMap::new(), home);
        let hermes_roots: Vec<_> = watched
            .iter()
            .filter(|r| r.client == "hermes")
            .map(|r| (r.dir.clone(), r.recursive, r.filter.clone()))
            .collect();
        assert_eq!(
            hermes_roots,
            vec![
                (hermes, false, Filter::HermesHome),
                (profile, false, Filter::HermesHome)
            ]
        );
        assert!(watched.iter().any(|r| r.dir
            == home
                .join(".config")
                .join("tokscale")
                .join("headless")
                .join("codex")
            && r.filter == Filter::All));
    }

    #[test]
    fn polling_override_is_tri_state() {
        for raw in ["1", "true", "YES", " on ", "polling"] {
            assert_eq!(polling_override(Some(raw)), Some(true), "{raw:?}");
        }
        for raw in ["0", "false", "No", " OFF "] {
            assert_eq!(polling_override(Some(raw)), Some(false), "{raw:?}");
        }
        assert_eq!(polling_override(Some("  ")), None);
        assert_eq!(polling_override(None), None);
    }

    #[test]
    fn descriptor_exhaustion_falls_back_to_polling_once() {
        let mut p = PollingPolicy::from_override(None);
        assert_eq!(p.mode(), WatchMode::Native);
        assert!(p.on_exhausted("ENOSPC"));
        assert_eq!(p.mode(), WatchMode::Polling);
        assert_eq!(p.fallback, Some("ENOSPC"));
        assert!(!p.on_exhausted("EMFILE"), "sticky: rebuild only once");
        assert_eq!(p.fallback, Some("ENOSPC"));

        let mut forced_native = PollingPolicy::from_override(Some(false));
        assert!(!forced_native.on_exhausted("EMFILE"));
        assert_eq!(forced_native.mode(), WatchMode::Native);

        let mut forced_polling = PollingPolicy::from_override(Some(true));
        assert_eq!(forced_polling.mode(), WatchMode::Polling);
        assert!(!forced_polling.on_exhausted("EMFILE"));
        assert_eq!(forced_polling.fallback, None);
    }

    #[test]
    fn exhaustion_codes_match_upstream() {
        let io = |raw| notify::Error::io(std::io::Error::from_raw_os_error(raw));
        assert_eq!(
            exhaustion_code(&notify::Error::new(notify::ErrorKind::MaxFilesWatch)),
            Some("ENOSPC")
        );
        if cfg!(windows) {
            assert_eq!(exhaustion_code(&io(4)), Some("EMFILE"));
            assert_eq!(exhaustion_code(&io(112)), Some("ENOSPC"));
        } else {
            assert_eq!(exhaustion_code(&io(24)), Some("EMFILE"));
            assert_eq!(exhaustion_code(&io(23)), Some("ENFILE"));
            assert_eq!(exhaustion_code(&io(28)), Some("ENOSPC"));
        }
        assert_eq!(exhaustion_code(&io(2)), None, "not found is not exhaustion");
        assert_eq!(exhaustion_code(&notify::Error::path_not_found()), None);
    }

    fn counter() -> (
        Arc<Mutex<Vec<Signal>>>,
        impl Fn(Signal) + Send + Sync + 'static,
    ) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        (seen, move |s| sink.lock().unwrap().push(s))
    }

    fn wait_for(seen: &Mutex<Vec<Signal>>, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if !seen.lock().unwrap().is_empty() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        !seen.lock().unwrap().is_empty()
    }

    #[test]
    fn a_write_under_a_watched_root_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let projects = dir.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        let (seen, on_signal) = counter();
        let watcher = start(
            vec![
                root("claude", projects.clone(), true, Filter::All),
                root("claude", dir.path().join("missing"), true, Filter::All),
            ],
            WatchMode::Native,
            on_signal,
        )
        .expect("watch starts");
        assert_eq!(watcher.mode, WatchMode::Native);
        assert_eq!(
            watcher.watched,
            vec![projects.clone()],
            "missing roots are skipped"
        );
        std::fs::create_dir_all(projects.join("p1")).unwrap();
        std::fs::write(projects.join("p1").join("s.jsonl"), b"{}\n").unwrap();
        assert!(
            wait_for(&seen, Duration::from_secs(5)),
            "no event within 5 s"
        );
        assert!(seen.lock().unwrap().iter().all(|s| *s == Signal::Change));
    }

    #[test]
    fn polling_reports_relevant_changes_and_prunes_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let storage = dir.path().join("workspaceStorage");
        let hash = storage.join("abc");
        std::fs::create_dir_all(hash.join("chatSessions")).unwrap();
        std::fs::write(hash.join("chatSessions").join("1.json"), b"{}").unwrap();
        let (seen, on_signal) = counter();
        let watcher = start_with(
            vec![root(
                "copilot",
                storage.clone(),
                true,
                Filter::WorkspaceStorage,
            )],
            WatchMode::Polling,
            Duration::from_millis(40),
            on_signal,
        )
        .expect("polling starts");
        assert_eq!(watcher.mode, WatchMode::Polling);
        assert_eq!(watcher.watched, vec![storage.clone()]);

        // VS Code 自己的檔：不觸發。
        std::fs::write(hash.join("state.vscdb"), b"x").unwrap();
        std::fs::create_dir_all(hash.join("other")).unwrap();
        std::fs::write(hash.join("other").join("big.bin"), b"x").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(seen.lock().unwrap().is_empty(), "pruned paths stay quiet");

        // 聊天紀錄變了：觸發。
        std::fs::write(hash.join("chatSessions").join("1.json"), b"{\"more\":1}").unwrap();
        assert!(wait_for(&seen, Duration::from_secs(5)), "no poll event");
        assert_eq!(seen.lock().unwrap()[0], Signal::Change);

        // 新的 workspace 帶著 chatSessions 出現：也觸發。
        seen.lock().unwrap().clear();
        std::fs::create_dir_all(storage.join("def").join("chatSessions")).unwrap();
        assert!(
            wait_for(&seen, Duration::from_secs(5)),
            "new workspace not seen"
        );

        // drop 後不再送。
        drop(watcher);
        std::thread::sleep(Duration::from_millis(100));
        seen.lock().unwrap().clear();
        std::fs::write(hash.join("chatSessions").join("2.json"), b"{}").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(seen.lock().unwrap().is_empty(), "stopped after drop");
    }

    #[test]
    fn polling_snapshot_skips_what_tokscale_does_not_read() {
        let dir = tempfile::tempdir().unwrap();
        let oc = dir.path().join("opencode");
        std::fs::create_dir_all(oc.join("storage").join("message").join("s1")).unwrap();
        std::fs::create_dir_all(oc.join("storage").join("part").join("s1")).unwrap();
        std::fs::create_dir_all(oc.join("snapshot").join("objects")).unwrap();
        std::fs::write(oc.join("opencode.db"), b"").unwrap();
        std::fs::write(
            oc.join("storage").join("message").join("s1").join("m.json"),
            b"",
        )
        .unwrap();
        std::fs::write(
            oc.join("storage").join("part").join("s1").join("p.json"),
            b"",
        )
        .unwrap();
        std::fs::write(oc.join("snapshot").join("objects").join("o"), b"").unwrap();
        let snap = snapshot(&[root("opencode", oc.clone(), true, Filter::OpencodeData)]);
        let mut keys: Vec<PathBuf> = snap
            .keys()
            .map(|p| p.strip_prefix(&oc).unwrap().to_path_buf())
            .collect();
        keys.sort();
        let want: Vec<PathBuf> = [
            "",
            "opencode.db",
            "storage",
            "storage/message",
            "storage/message/s1",
            "storage/message/s1/m.json",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();
        assert_eq!(keys, want);
    }

    #[test]
    fn nothing_to_watch_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = start(
            vec![root("claude", dir.path().join("nope"), true, Filter::All)],
            WatchMode::Native,
            |_| {},
        )
        .err()
        .unwrap();
        assert!(err.to_string().contains("沒有"));
    }
}
