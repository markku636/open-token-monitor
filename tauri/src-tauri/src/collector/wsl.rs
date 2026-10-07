//! WSL 裡的工具用量（上游 src/shared/wslUsage.js）。只在 Windows 上有意義，其他平台一律不做。
//!
//! - 偵測：`HKCU\…\Lxss` 存在才算裝了 WSL（唯讀，不會觸發安裝）；`wsl.exe --list --quiet --running`
//!   列出**執行中**的 distro（絕不替使用者啟動 WSL）。每個 distro 看 `\\wsl$\<distro>\home\*` 與
//!   `\\wsl$\<distro>\root`，家目錄裡有任何一個工具的資料夾標記（`WSL_DATA_MARKERS`）才掃。
//! - 掃描：每個家目錄以 `tokscale --home <家目錄>` 依序掃 today → month → allTime（**序列**，與主機
//!   同一條規則，上游 issue #15），三個期間各自相加成一份 WSL bundle。某個家目錄失敗只記 log、略過。
//! - 主機的期間與 WSL bundle **分開**保存在錨點裡（collector/mod.rs）：anchored tick 的精確 delta
//!   只作用在主機的期間上，WSL 在發佈前才加上去；檔案變動觸發的 tick 沿用凍結的 WSL 快照（隔著
//!   9P 掃描太重），定時 tick 才重新掃 WSL。
//! - `wslStatus`：`detected` 是找到標記的（追蹤中的）工具，`withData` 是 WSL 的 allTime 裡有 token 的
//!   工具；兩者的差是給使用者看的診斷（例如 SQLite 型的工具隔著 9P 讀不到）。
//!
//! 環境（登錄檔、wsl.exe、`\\wsl$` 檔案系統）都經過 `WslHost`，測試與相容測試用 `FixtureWsl`
//! 取代（固定 JSON 目錄裡的 `wsl.json`）。

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::{CollectorConfig, ScanSource};
use crate::error::{AppError, AppResult};
use crate::tokscale::ScanPeriod;
use crate::usage::merge::{is_empty_period, merge_periods};
use crate::usage::period_from_tokscale;
use crate::wire::{Period, WslState, WslStatus};

/// `HKCU` 底下的 WSL 登錄機碼；存在 = 裝了 WSL。
pub const LXSS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Lxss";
/// 上游 `defaultExec` 的 5 秒逾時：wsl.exe 卡住時不拖住整個 tick。
const WSL_EXEC_TIMEOUT: Duration = Duration::from_secs(5);
/// 固定 JSON 來源裡描述假 WSL 環境的檔案。
pub const FIXTURE_FILE: &str = "wsl.json";

/// WSL 家目錄底下的相對路徑（Linux 寫法）→ 擁有它的工具 id（上游 `WSL_DATA_MARKERS` +
/// `MARKER_CLIENTS`，順序照抄）。任何一個存在，這個家目錄就值得掃；偵測結果只回報追蹤中的工具。
/// 包含公司沒有追蹤的工具：它們的家目錄照樣掃（與上游相同），只是不會出現在 `detected`。
pub const WSL_DATA_MARKERS: &[(&str, &str)] = &[
    (".claude/projects", "claude"),
    (".claude/transcripts", "claude"),
    (".codex/sessions", "codex"),
    (".local/share/opencode", "opencode"),
    (".openclaw/agents", "openclaw"),
    (".clawdbot/agents", "openclaw"),
    (".moltbot/agents", "openclaw"),
    (".moldbot/agents", "openclaw"),
    (".hermes", "hermes"),
    (".kimi/sessions", "kimi"),
    (".kimi-code/sessions", "kimi"),
    (".qwen/projects", "qwen"),
    (".grok/sessions", "grok"),
    (".copilot/otel", "copilot"),
    (".gemini/antigravity-cli/conversations", "antigravity"),
    (
        ".config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks",
        "cline",
    ),
    (
        ".vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/tasks",
        "cline",
    ),
    (".local/share/amp/threads", "amp"),
    (".pi/agent/sessions", "pi"),
    (".omp/agent/sessions", "pi"),
    (".local/share/zed/threads/threads.db", "zed"),
    (".local/share/kilo/kilo.db", "kilo"),
    (
        ".config/Code/User/globalStorage/kilocode.kilo-code/tasks",
        "kilo",
    ),
    (
        ".vscode-server/data/User/globalStorage/kilocode.kilo-code/tasks",
        "kilo",
    ),
    (".commandcode/projects", "commandcode"),
    (".dsh/sessions", "dsh"),
    (".factory/sessions", "droid"),
    (".local/share/mimocode/mimocode.db", "mimo"),
    (".zcode/projects", "zcode"),
    (".zcode/cli/db", "zcode"),
    (".kiro/sessions", "kiro"),
    (".local/share/kiro-cli/data.sqlite3", "kiro"),
    (".config/Kiro/User/globalStorage/kiro.kiroagent", "kiro"),
    (".config/kiro/User/globalStorage/kiro.kiroagent", "kiro"),
    (".codebuddy/projects", "codebuddy"),
    (".workbuddy", "workbuddy"),
    (".workbuddy-ai", "workbuddy"),
    (".proma/agent-sessions", "proma"),
    (".lmstudio/server-logs", "lmstudio"),
    (".unsloth/studio/studio.db", "unsloth"),
    (".local/share/devin/cli/sessions.db", "devin"),
    ("AppData/Roaming/devin/cli/sessions.db", "devin"),
    (".config/Devin/User/acp-events", "devin"),
    (".config/devin/User/acp-events", "devin"),
    ("AppData/Roaming/Devin/User/acp-events", "devin"),
    ("Library/Application Support/Devin/User/acp-events", "devin"),
];

/// WSL 環境：登錄檔、wsl.exe 與 `\\wsl$` 檔案系統。方法都是同步的（可能碰到 9P），
/// 呼叫端在 `spawn_blocking` 裡用。
pub trait WslHost: Send + Sync {
    /// `HKCU\…\Lxss` 存在。
    fn installed(&self) -> bool;
    /// 執行中的 distro 名稱（`wsl.exe --list --quiet --running`）；失敗或逾時是空的。
    fn running_distros(&self) -> Vec<String>;
    fn exists(&self, path: &str) -> bool;
    /// 資料夾的子項目名稱；不存在或讀不到是 `None`。
    fn read_dir(&self, path: &str) -> Option<Vec<String>>;
}

/// 真正的 Windows 環境。
pub struct SystemWsl;

impl WslHost for SystemWsl {
    fn installed(&self) -> bool {
        #[cfg(windows)]
        {
            use winreg::enums::HKEY_CURRENT_USER;
            winreg::RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey(LXSS_KEY)
                .is_ok()
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    fn running_distros(&self) -> Vec<String> {
        run_wsl_list().map_or_else(Vec::new, |out| parse_distro_list(&out))
    }

    fn exists(&self, path: &str) -> bool {
        Path::new(path).exists()
    }

    fn read_dir(&self, path: &str) -> Option<Vec<String>> {
        let entries = std::fs::read_dir(path).ok()?;
        Some(
            entries
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect(),
        )
    }
}

/// `wsl.exe --list --quiet --running`：stdin 是 NUL（非 WSL 的 wsl.exe 殼會停在「按任意鍵安裝」），
/// 5 秒逾時就終止。非 0 結束（例如沒有執行中的 distro）與上游 `execFileSync` 一樣當成失敗。
fn run_wsl_list() -> Option<Vec<u8>> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["--list", "--quiet", "--running"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：GUI 程序呼叫 console 程式時不要閃出黑色視窗。
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    // 另開執行緒讀完 stdout，pipe 滿了才不會卡住子程序。
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let deadline = std::time::Instant::now() + WSL_EXEC_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = reader.join().ok()?;
                return status.success().then_some(out);
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// wsl.exe 的輸出預設是 UTF-16LE（上游一律這樣解）；設了 `WSL_UTF8=1` 時是 UTF-8，
/// 所以有 NUL 位元組才當 UTF-16LE。每行去掉 NUL、BOM 與空白，空行略過。
pub fn parse_distro_list(bytes: &[u8]) -> Vec<String> {
    let text = if bytes.contains(&0) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.split('\n')
        .map(|line| line.replace(['\0', '\u{feff}'], "").trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

/// 假的 WSL 環境（固定 JSON 來源的 `wsl.json`，也給單元測試用）：
///
/// ```json
/// { "installed": true, "running": ["Ubuntu"],
///   "paths": ["\\\\wsl$\\Ubuntu\\home\\alice\\.claude\\projects"],
///   "scans": { "\\\\wsl$\\Ubuntu\\home\\alice": { "today": {…}, "month": {…}, "alltime": {…} } } }
/// ```
///
/// `paths` 是存在的檔案或資料夾，它們的上層資料夾也視為存在；`scans` 是那個家目錄的 tokscale 輸出
/// （缺的期間是空的）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct FixtureWsl {
    pub installed: bool,
    pub running: Vec<String>,
    pub paths: Vec<String>,
    pub scans: IndexMap<String, IndexMap<String, Value>>,
}

impl FixtureWsl {
    /// 目錄裡沒有 `wsl.json` 就是 `None`（這個來源沒有 WSL，等同非 Windows）。
    pub fn load(dir: &Path) -> Option<FixtureWsl> {
        let bytes = std::fs::read(dir.join(FIXTURE_FILE)).ok()?;
        match serde_json::from_slice(&bytes) {
            Ok(fixture) => Some(fixture),
            Err(e) => {
                tracing::warn!(error = %e, "wsl.json fixture is unreadable; ignoring it");
                None
            }
        }
    }

    /// 那個家目錄、那個期間（`today` / `month` / `alltime`）的 tokscale 輸出。
    pub fn scan(&self, home: &str, stem: &str) -> Value {
        self.scans
            .get(home)
            .and_then(|periods| periods.get(stem))
            .cloned()
            .unwrap_or_else(|| json!({ "entries": [] }))
    }
}

impl WslHost for FixtureWsl {
    fn installed(&self) -> bool {
        self.installed
    }

    fn running_distros(&self) -> Vec<String> {
        if self.installed {
            self.running.clone()
        } else {
            Vec::new()
        }
    }

    fn exists(&self, path: &str) -> bool {
        let prefix = format!("{path}\\");
        self.paths
            .iter()
            .any(|p| p == path || p.starts_with(&prefix))
    }

    fn read_dir(&self, path: &str) -> Option<Vec<String>> {
        let prefix = format!("{path}\\");
        let mut names: IndexSet<String> = IndexSet::new();
        let mut found = false;
        for p in &self.paths {
            if p == path {
                found = true;
            } else if let Some(rest) = p.strip_prefix(&prefix) {
                found = true;
                if let Some(name) = rest.split('\\').next().filter(|n| !n.is_empty()) {
                    names.insert(name.to_string());
                }
            }
        }
        found.then(|| names.into_iter().collect())
    }
}

/// 上游 `wslHomePath`：Linux 寫法的相對路徑接在 UNC 家目錄後面。
fn home_path(home: &str, relative: &str) -> String {
    format!("{home}\\{}", relative.replace('/', "\\"))
}

/// 上游 `homeHasData`：這個家目錄裡有資料的工具 id（依標記順序、去重）。VS Code 的
/// `workspaceStorage` 不是 Copilot 專屬，要有 tokscale 真的會讀的 `chatSessions` 才算。
pub fn home_has_data(host: &dyn WslHost, home: &str) -> Vec<String> {
    let mut ids: IndexSet<String> = IndexSet::new();
    for (rel, client) in WSL_DATA_MARKERS {
        if host.exists(&home_path(home, rel)) {
            ids.insert((*client).to_string());
        }
    }
    let workspace_root = home_path(home, ".config/Code/User/workspaceStorage");
    for workspace in host.read_dir(&workspace_root).unwrap_or_default() {
        if host.exists(&format!("{workspace_root}\\{workspace}\\chatSessions")) {
            ids.insert("copilot".into());
            break;
        }
    }
    ids.into_iter().collect()
}

/// 上游 `listRunningWslDistros`。
pub fn list_running_distros(host: &dyn WslHost) -> Vec<String> {
    if !host.installed() {
        return Vec::new();
    }
    host.running_distros()
}

/// 上游 `wslUsageHomes`：執行中 distro 裡有資料的家目錄，連同找到的工具。
pub fn wsl_usage_homes(host: &dyn WslHost) -> Vec<(String, Vec<String>)> {
    let mut homes = Vec::new();
    for distro in list_running_distros(host) {
        let home_root = format!("\\\\wsl$\\{distro}\\home");
        let mut candidates: Vec<String> = host
            .read_dir(&home_root)
            .unwrap_or_default()
            .into_iter()
            .map(|user| format!("{home_root}\\{user}"))
            .collect();
        candidates.push(format!("\\\\wsl$\\{distro}\\root"));
        for home in candidates {
            let clients = home_has_data(host, &home);
            if !clients.is_empty() {
                homes.push((home, clients));
            }
        }
    }
    homes
}

/// 上游 `probeWslState`：不跑 tokscale 的便宜探測。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WslProbe {
    NotInstalled,
    NotRunning,
    Ok,
}

pub fn probe_wsl_state(host: &dyn WslHost) -> WslProbe {
    if !host.installed() {
        WslProbe::NotInstalled
    } else if host.running_distros().is_empty() {
        WslProbe::NotRunning
    } else {
        WslProbe::Ok
    }
}

/// WSL 的三個期間（上游 `emptyWslBundle()` 的形狀；`collector-anchor.json` 的 `wslBundle`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WslBundle {
    pub today: Period,
    pub month: Period,
    pub all_time: Period,
}

/// 上游 `collectWslUsage` 的結果。
#[derive(Debug, Clone, Default)]
pub struct WslUsage {
    pub bundle: WslBundle,
    /// 找到標記的追蹤中工具（跨家目錄、依第一次出現的順序）。
    pub detected: Vec<String>,
}

/// 在執行緒池裡跑同步的 WSL 探測（碰到 wsl.exe 與 9P，可能要幾秒）。
async fn blocking<T: Send + 'static>(
    host: &Arc<dyn WslHost>,
    f: impl FnOnce(&dyn WslHost) -> T + Send + 'static,
) -> AppResult<T> {
    let host = host.clone();
    tokio::task::spawn_blocking(move || f(&*host))
        .await
        .map_err(|e| AppError::Internal(format!("wsl probe panicked: {e}")))
}

/// 上游 `collectWslUsage`。只有停止（`AppError::Stopped`）會回錯；個別家目錄掃描失敗只記 log。
pub async fn collect_wsl_usage(
    source: &ScanSource,
    host: &Arc<dyn WslHost>,
    cfg: &CollectorConfig,
    cancel: &CancellationToken,
) -> AppResult<WslUsage> {
    let stopped = || {
        if cancel.is_cancelled() {
            Err(AppError::Stopped)
        } else {
            Ok(())
        }
    };
    stopped()?;
    let mut usage = WslUsage::default();
    if cfg.tracked_clients.is_empty() {
        return Ok(usage);
    }
    let tracked: HashSet<&str> = cfg.tracked_clients.iter().map(String::as_str).collect();
    let mut detected: IndexSet<String> = IndexSet::new();
    let homes = blocking(host, wsl_usage_homes).await?;
    for (home, clients) in homes {
        stopped()?;
        // 偵測只看標記，與 tokscale 讀不讀得到無關。
        for id in clients {
            if tracked.contains(id.as_str()) {
                detected.insert(id);
            }
        }
        match scan_home(source, cfg, &home, cancel).await {
            Ok([today, month, all_time]) => {
                let bundle = &mut usage.bundle;
                bundle.today = merge_periods(&[&bundle.today, &today]);
                bundle.month = merge_periods(&[&bundle.month, &month]);
                bundle.all_time = merge_periods(&[&bundle.all_time, &all_time]);
            }
            Err(AppError::Stopped) => return Err(AppError::Stopped),
            Err(e) => {
                stopped()?;
                tracing::warn!(%home, error = %e, "wsl usage scan failed");
            }
        }
    }
    usage.detected = detected.into_iter().collect();
    Ok(usage)
}

/// 一個家目錄：today → month → allTime **序列**（上游 issue #15：絕不同時跑）。
async fn scan_home(
    source: &ScanSource,
    cfg: &CollectorConfig,
    home: &str,
    cancel: &CancellationToken,
) -> AppResult<[Period; 3]> {
    let mut out: [Period; 3] = Default::default();
    let periods = [
        ScanPeriod::Today,
        ScanPeriod::Month,
        ScanPeriod::Since(cfg.all_time_since.clone()),
    ];
    for (slot, period) in out.iter_mut().zip(periods.iter()) {
        let json = source.scan_home(cfg, period, home, cancel).await?;
        if cancel.is_cancelled() {
            return Err(AppError::Stopped);
        }
        *slot = period_from_tokscale(json, cfg.projects_enabled);
    }
    Ok(out)
}

/// 上游 collectUsageOnce 的 `wslStatus`：探測不到執行中的 distro 就是那個狀態；否則依 WSL 的
/// allTime 有沒有 token 分成 `active` / `no-data`。
pub async fn status_after_probe(
    host: &Arc<dyn WslHost>,
    bundle: &WslBundle,
    detected: Vec<String>,
) -> AppResult<WslStatus> {
    let probe = blocking(host, probe_wsl_state).await?;
    Ok(match probe {
        WslProbe::NotInstalled => WslStatus::empty(WslState::NotInstalled),
        WslProbe::NotRunning => WslStatus::empty(WslState::NotRunning),
        WslProbe::Ok => {
            let with_data: Vec<String> = bundle.all_time.clients.keys().cloned().collect();
            WslStatus {
                state: if with_data.is_empty() {
                    WslState::NoData
                } else {
                    WslState::Active
                },
                detected,
                with_data,
            }
        }
    })
}

/// 上游 `wslPeriodsForPreview`：凍結的 WSL 快照只有在同一天（today）、同一個月（month）拍的，
/// 才能併進完整掃描中的預覽；否則跨日、跨月的掃描會短暫把上一段期間的 WSL 用量加進來。
pub fn wsl_periods_for_preview<'a>(
    bundle: Option<&'a WslBundle>,
    anchor_date_key: &str,
    today_key: &str,
) -> (Option<&'a Period>, Option<&'a Period>) {
    let Some(bundle) = bundle else {
        return (None, None);
    };
    // JS 的 `key.slice(0, 7)`。
    let month_of = |key: &str| key.chars().take(7).collect::<String>();
    (
        (anchor_date_key == today_key).then_some(&bundle.today),
        (month_of(anchor_date_key) == month_of(today_key)).then_some(&bundle.month),
    )
}

/// 主機的期間加上 WSL 的期間（上游 `mergePeriods(windowsPeriods.x, wslBundle.x)`）。WSL 是空的就
/// 原樣回傳（與空期間相加是恆等）；有相加時照上游發佈前的 `applyProjectRollups` 重新彙總專案。
pub fn with_wsl(projects_enabled: bool, host: Period, wsl: Option<&Period>) -> Period {
    match wsl.filter(|p| !is_empty_period(p)) {
        Some(wsl) => {
            let mut merged = merge_periods(&[&host, wsl]);
            if projects_enabled {
                crate::usage::projects::apply_project_rollups(&mut merged);
            }
            merged
        }
        None => host,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(paths: &[&str]) -> FixtureWsl {
        FixtureWsl {
            installed: true,
            running: vec!["Ubuntu".into()],
            paths: paths.iter().map(|p| p.to_string()).collect(),
            scans: IndexMap::new(),
        }
    }

    #[test]
    fn decodes_utf16_and_utf8_distro_lists() {
        let utf16: Vec<u8> = "\u{feff}Ubuntu\r\ndocker-desktop\r\n\r\n"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        assert_eq!(parse_distro_list(&utf16), ["Ubuntu", "docker-desktop"]);
        assert_eq!(parse_distro_list(b"Debian\n  \n"), ["Debian"]);
        assert!(parse_distro_list(b"").is_empty());
    }

    #[test]
    fn markers_attribute_homes_to_clients_in_marker_order() {
        let home = r"\\wsl$\Ubuntu\home\alice";
        let host = fixture(&[
            r"\\wsl$\Ubuntu\home\alice\.codex\sessions\2026",
            r"\\wsl$\Ubuntu\home\alice\.claude\transcripts",
            r"\\wsl$\Ubuntu\home\alice\.kimi-code\sessions",
            r"\\wsl$\Ubuntu\home\alice\.config\Code\User\workspaceStorage\abc\chatSessions",
        ]);
        assert_eq!(
            home_has_data(&host, home),
            ["claude", "codex", "kimi", "copilot"]
        );
        // workspaceStorage 本身不算 Copilot。
        let bare = fixture(&[r"\\wsl$\Ubuntu\home\bob\.config\Code\User\workspaceStorage\abc"]);
        assert!(home_has_data(&bare, r"\\wsl$\Ubuntu\home\bob").is_empty());
    }

    #[test]
    fn only_running_distros_with_markers_are_scanned() {
        let host = FixtureWsl {
            running: vec!["Ubuntu".into(), "docker-desktop".into()],
            ..fixture(&[
                r"\\wsl$\Ubuntu\home\alice\.claude\projects",
                r"\\wsl$\Ubuntu\home\bob\notes",
                r"\\wsl$\Ubuntu\root\.hermes",
                r"\\wsl$\Stopped\home\carol\.claude\projects",
            ])
        };
        let homes: Vec<String> = wsl_usage_homes(&host).into_iter().map(|(h, _)| h).collect();
        assert_eq!(homes, [r"\\wsl$\Ubuntu\home\alice", r"\\wsl$\Ubuntu\root"]);
        assert_eq!(probe_wsl_state(&host), WslProbe::Ok);
        let idle = FixtureWsl {
            running: Vec::new(),
            ..host.clone()
        };
        assert_eq!(probe_wsl_state(&idle), WslProbe::NotRunning);
        assert!(wsl_usage_homes(&idle).is_empty());
        let absent = FixtureWsl {
            installed: false,
            ..host
        };
        assert_eq!(probe_wsl_state(&absent), WslProbe::NotInstalled);
        assert!(wsl_usage_homes(&absent).is_empty());
    }

    #[test]
    fn fixture_fs_answers_like_a_directory_tree() {
        let host = fixture(&[r"\\wsl$\U\home\a\x\y", r"\\wsl$\U\home\b"]);
        assert!(host.exists(r"\\wsl$\U\home\a\x"));
        assert!(!host.exists(r"\\wsl$\U\home\a\x\z"));
        assert!(!host.exists(r"\\wsl$\U\home\ab"));
        assert_eq!(host.read_dir(r"\\wsl$\U\home").unwrap(), ["a", "b"]);
        assert_eq!(
            host.read_dir(r"\\wsl$\U\home\b").unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(host.read_dir(r"\\wsl$\U\nope"), None);
    }

    #[test]
    fn preview_merges_the_frozen_snapshot_only_within_its_window() {
        let mut bundle = WslBundle::default();
        bundle.today.total_tokens = 1;
        bundle.month.total_tokens = 2;
        let same_day = wsl_periods_for_preview(Some(&bundle), "2026-09-24", "2026-09-24");
        assert_eq!(same_day.0.map(|p| p.total_tokens), Some(1));
        assert_eq!(same_day.1.map(|p| p.total_tokens), Some(2));
        let next_day = wsl_periods_for_preview(Some(&bundle), "2026-09-23", "2026-09-24");
        assert!(next_day.0.is_none());
        assert_eq!(next_day.1.map(|p| p.total_tokens), Some(2));
        let next_month = wsl_periods_for_preview(Some(&bundle), "2026-08-31", "2026-09-01");
        assert!(next_month.0.is_none() && next_month.1.is_none());
        let none = wsl_periods_for_preview(None, "2026-09-24", "2026-09-24");
        assert!(none.0.is_none() && none.1.is_none());
    }
}
