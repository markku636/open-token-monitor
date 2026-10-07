//! 各工具的本機資料位置（上游 collector.js `clientSourceRoots`、`sourceRootExists`、
//! `clientSourceChecks`）。
//!
//! 同一張表決定兩件事：
//! - `clientStatus` 的 `waiting`（裝了但還沒有用量）與 `missing`（本機沒有這個工具）：任何一個來源
//!   存在就算有（上游 `clientDataDirPresence`）。
//! - watcher 的監看根目錄（collector/watch.rs 由這張表推出，上游 `clientWatchCandidates`）。
//!
//! 注意：Cursor 與 Antigravity 的 cache 是 tokscale 自己同步寫入的（collector/self_sync.rs），
//! 這裡列出只是為了判斷狀態；watcher 絕不能監看它們，否則會自我觸發無限重掃。

use std::path::{Path, PathBuf};

use indexmap::IndexMap;

use super::{antigravity, cursor};

/// 一個來源位置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceRoot {
    /// 來源的種類（上游的 source check id，例如 `codex-sessions`）；同一種可以有好幾個位置。
    pub id: &'static str,
    /// 目錄。有 `source_path` 時是那個檔案的上層：檔案可能之後才出現，監看的是目錄。
    pub dir: PathBuf,
    /// tokscale 只讀這一個檔案（`path.is_file()`），存在與否看它、不看目錄。
    pub source_path: Option<PathBuf>,
    /// 使用者設定的額外掃描目錄（`customScanPaths`）。
    pub custom: bool,
}

fn source(id: &'static str, dir: PathBuf) -> SourceRoot {
    SourceRoot {
        id,
        dir,
        source_path: None,
        custom: false,
    }
}

fn file_source(id: &'static str, file: PathBuf) -> SourceRoot {
    SourceRoot {
        id,
        dir: file.parent().map(Path::to_path_buf).unwrap_or_default(),
        source_path: Some(file),
        custom: false,
    }
}

/// 上游 `nonBlankEnvPath`：只有空白的值當作沒設，有值時原樣使用（不 trim）。
fn non_blank_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.to_string_lossy().trim().is_empty())
        .map(PathBuf::from)
}

/// 去掉前後空白後的值（上游 claude/paths.js 的 `nonBlank`、hermes/profiles.js 的 `.trim()`）。
fn trimmed_env(name: &str) -> Option<PathBuf> {
    let value = std::env::var_os(name)?;
    let trimmed = value.to_string_lossy().trim().to_string();
    (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
}

/// JS 的 `process.env.X || fallback`：只有空字串當作沒設。
fn non_empty_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// tokscale 的有效 home：Windows 上絕對路徑的 `$HOME` 優先於使用者設定檔目錄（上游 `tokscaleHomeDir`）。
fn tokscale_home(home: &Path) -> PathBuf {
    match non_blank_env("HOME") {
        Some(h) if h.is_absolute() => h,
        _ => home.to_path_buf(),
    }
}

/// Hermes Agent 的 home（上游 providers/hermes/profiles.js `resolveHermesHome`）：
/// `HERMES_HOME` → `~/.hermes`（有 state.db）→ Windows 原生安裝的 `%LOCALAPPDATA%\hermes` → `~/.hermes`。
pub fn hermes_home(home: &Path) -> PathBuf {
    if let Some(p) = trimmed_env("HERMES_HOME") {
        return p;
    }
    let dot = home.join(".hermes");
    if dot.join("state.db").exists() {
        return dot;
    }
    if cfg!(windows) {
        let local =
            non_empty_env("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData").join("Local"));
        let native = local.join("hermes");
        if native.join("state.db").exists() {
            return native;
        }
    }
    dot
}

/// Hermes 的 profile（上游 `discoverHermesProfileScanPaths`）：`<home>/profiles/<name>` 裡有 `state.db`
/// 的目錄，tokscale 每個都讀。依路徑排序。
pub fn hermes_profile_dirs(hermes_home: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(hermes_home.join("profiles")) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .filter(|dir| dir.join("state.db").exists())
        .collect();
    dirs.sort();
    dirs
}

/// tokscale 找 `codex exec --json` 擷取輸出的地方（上游 `tokscaleHeadlessRoots`）。兩個預設位置每個
/// 平台都掃；`TOKSCALE_HEADLESS_DIR` 取代這一對，而不是加在後面。兩者都不跟 `XDG_CONFIG_HOME`。
fn tokscale_headless_roots(home: &Path) -> Vec<PathBuf> {
    if let Some(dir) = non_blank_env("TOKSCALE_HEADLESS_DIR") {
        return vec![dir];
    }
    vec![
        home.join(".config").join("tokscale").join("headless"),
        home.join("Library")
            .join("Application Support")
            .join("tokscale")
            .join("headless"),
    ]
}

/// `COPILOT_OTEL_FILE_EXPORTER_PATH` 指的檔案（上游 `copilotExporterWatch`）。tokscale 只讀這一個檔，
/// 它可能還不存在，所以監看它的上層目錄。上層是磁碟根目錄時不監看；已經在 `~/.copilot/otel`
/// 底下的由那棵樹涵蓋，也回 `None`。
pub fn copilot_exporter_file(home: &Path) -> Option<PathBuf> {
    exporter_file_from(
        std::env::var_os("COPILOT_OTEL_FILE_EXPORTER_PATH").as_deref(),
        home,
    )
}

fn exporter_file_from(raw: Option<&std::ffi::OsStr>, home: &Path) -> Option<PathBuf> {
    let trimmed = raw?.to_string_lossy().trim().to_string();
    if trimmed.is_empty() {
        return None;
    }
    let file = std::path::absolute(&trimmed).ok()?;
    // 上游 `hasWatchableParent`：上層就是根目錄（`C:\`、`/`）時不監看。
    if file.parent()?.parent().is_none() {
        return None;
    }
    if file.starts_with(home.join(".copilot").join("otel")) {
        return None;
    }
    Some(file)
}

/// tokscale 自己同步寫入的 cache（Cursor、Antigravity）。watcher 絕不監看它們，也不監看包住它們的
/// 目錄：我們的同步一寫就是一個事件，事件又觸發下一次掃描（上游 issue #15）。
pub fn self_synced_cache_dirs(home: &Path) -> Vec<PathBuf> {
    vec![
        cursor::cache_dir(&tokscale_home(home)),
        antigravity::cache_dir(home),
    ]
}

/// VS Code 的 workspaceStorage（tokscale 讀每個 `<hash>/chatSessions/`）：順序與去重照上游。
fn copilot_workspace_roots(home: &Path) -> Vec<PathBuf> {
    let tail = |base: PathBuf| base.join("Code").join("User").join("workspaceStorage");
    let mut roots = vec![
        tail(home.join("Library").join("Application Support")),
        tail(home.join(".config")),
    ];
    if cfg!(windows) {
        roots.push(tail(
            non_empty_env("APPDATA").unwrap_or_else(|| home.join("AppData").join("Roaming")),
        ));
    }
    roots.push(tail(home.join("AppData").join("Roaming")));
    let mut seen = std::collections::HashSet::new();
    roots.retain(|r| seen.insert(r.clone()));
    roots
}

/// Antigravity CLI 自己的資料（tokscale 直接讀；上游 `antigravityCliDataDir`，跟 `GEMINI_CLI_HOME`）。
pub fn antigravity_cli_data_dir(home: &Path) -> PathBuf {
    non_empty_env("GEMINI_CLI_HOME")
        .unwrap_or_else(|| home.join(".gemini"))
        .join("antigravity-cli")
        .join("conversations")
}

fn builtin_roots(client: &str, home: &Path) -> Vec<SourceRoot> {
    let t_home = tokscale_home(home);
    let xdg_data =
        non_blank_env("XDG_DATA_HOME").unwrap_or_else(|| t_home.join(".local").join("share"));
    match client {
        "claude" => {
            let base = trimmed_env("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude"));
            vec![
                source("claude-projects", base.join("projects")),
                source("claude-transcripts", base.join("transcripts")),
            ]
        }
        "codex" => {
            let base = non_blank_env("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
            let mut roots = vec![
                source("codex-sessions", base.join("sessions")),
                source("codex-sessions", base.join("archived_sessions")),
            ];
            roots.extend(
                tokscale_headless_roots(home)
                    .into_iter()
                    .map(|dir| source("codex-sessions", dir.join("codex"))),
            );
            roots
        }
        // tokscale 讀 opencode*.db 與舊版的 storage/message/。
        "opencode" => vec![source("opencode-data", xdg_data.join("opencode"))],
        // home 目錄本身就算（上游 `dirExists(hermesHome)`），另外每個 profile 各是一個來源。
        "hermes" => {
            let hermes = hermes_home(home);
            let mut roots = vec![source("hermes-home", hermes.clone())];
            roots.extend(
                hermes_profile_dirs(&hermes)
                    .into_iter()
                    .map(|dir| source("hermes-profile", dir)),
            );
            roots
        }
        // 帳號層級的用量匯出：IDE 與 CLI 共用。上游只看 cache；這裡另外把桌面版的 state.vscdb 算成
        // 「已安裝」（cache 要等第一次同步才有，見 docs 的已知差異）。
        "cursor" => {
            let mut roots = vec![source("tokscale-cursor-cache", cursor::cache_dir(&t_home))];
            roots.extend(
                cursor::desktop_state_candidates(home)
                    .into_iter()
                    .map(|file| file_source("cursor-desktop-state", file)),
            );
            roots
        }
        // cache 由我們的同步寫入；IDE 的 session 目錄與 CLI 的資料是另外兩種來源（上游
        // `clientSourceChecks` 另外推入的 antigravity-ide-source 與 antigravity-cli-data）。
        "antigravity" => {
            let mut roots = vec![source(
                "tokscale-antigravity-cache",
                antigravity::cache_dir(home),
            )];
            roots.extend(
                antigravity::data_roots(home)
                    .into_iter()
                    .map(|dir| source("antigravity-ide-source", dir)),
            );
            roots.push(source(
                "antigravity-cli-data",
                antigravity_cli_data_dir(home),
            ));
            roots
        }
        "copilot" => {
            let copilot = home.join(".copilot");
            let mut roots = vec![
                source("copilot-otel", copilot.join("otel")),
                file_source("copilot-data", copilot.join("data.db")),
                file_source("copilot-session-store", copilot.join("session-store.db")),
            ];
            roots.extend(
                copilot_workspace_roots(home)
                    .into_iter()
                    .map(|dir| source("vscode-workspace-storage", dir)),
            );
            if let Some(file) = copilot_exporter_file(home) {
                roots.push(file_source("copilot-otel-exporter", file));
            }
            roots
        }
        _ => Vec::new(),
    }
}

/// 一個 client 的所有來源：內建位置，再加上使用者為它設定的額外掃描目錄。
pub fn client_source_roots(
    client: &str,
    home: &Path,
    custom_scan_paths: &IndexMap<String, Vec<String>>,
) -> Vec<SourceRoot> {
    let mut roots = builtin_roots(client, home);
    roots.extend(
        custom_scan_paths
            .get(client)
            .into_iter()
            .flatten()
            .map(|dir| SourceRoot {
                id: "custom-scan-path",
                dir: PathBuf::from(dir),
                source_path: None,
                custom: true,
            }),
    );
    roots
}

/// 上游 `hasCopilotChatSessions`：workspaceStorage 裡至少一個 `<hash>/chatSessions/` 目錄。
/// VS Code 本身就會建 workspaceStorage，只有它不代表用過 Copilot Chat。
fn has_copilot_chat_sessions(workspace_root: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(workspace_root) else {
        return false;
    };
    entries
        .flatten()
        .any(|e| e.file_type().is_ok_and(|t| t.is_dir()) && e.path().join("chatSessions").is_dir())
}

/// 上游 `sourceRootExists`：精確的檔案看檔案，workspaceStorage 看有沒有 chatSessions，其他看目錄。
pub fn source_root_exists(root: &SourceRoot) -> bool {
    if let Some(file) = &root.source_path {
        return file.is_file();
    }
    if root.id == "vscode-workspace-storage" {
        return has_copilot_chat_sessions(&root.dir);
    }
    root.dir.is_dir()
}

pub fn client_present(
    client: &str,
    home: &Path,
    custom_scan_paths: &IndexMap<String, Vec<String>>,
) -> bool {
    client_source_roots(client, home, custom_scan_paths)
        .iter()
        .any(source_root_exists)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none() -> IndexMap<String, Vec<String>> {
        IndexMap::new()
    }

    fn ids(roots: &[SourceRoot]) -> Vec<&'static str> {
        roots.iter().map(|r| r.id).collect()
    }

    #[test]
    fn every_supported_client_has_roots() {
        let home = Path::new("/home/u");
        for id in crate::settings::SUPPORTED_CLIENTS {
            assert!(
                !client_source_roots(id, home, &none()).is_empty(),
                "{id} has no source roots"
            );
        }
        assert!(client_source_roots("unknown-client", home, &none()).is_empty());
    }

    #[test]
    fn hermes_home_counts_as_present_and_profiles_are_sources() {
        if std::env::var_os("HERMES_HOME").is_some() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let hermes = dir.path().join(".hermes");
        if hermes_home(dir.path()) != hermes {
            return; // 這台電腦有 Windows 原生安裝的 Hermes
        }
        assert!(!client_present("hermes", dir.path(), &none()));
        std::fs::create_dir_all(hermes.join("profiles").join("work")).unwrap();
        std::fs::create_dir_all(hermes.join("profiles").join("empty")).unwrap();
        // 上游 `dirExists(hermesHome)`：還沒有 state.db 的 home 也是「裝了、等用量」。
        assert!(client_present("hermes", dir.path(), &none()));
        std::fs::write(hermes.join("profiles").join("work").join("state.db"), b"").unwrap();
        let roots = client_source_roots("hermes", dir.path(), &none());
        assert_eq!(ids(&roots), ["hermes-home", "hermes-profile"]);
        assert_eq!(roots[1].dir, hermes.join("profiles").join("work"));
    }

    #[test]
    fn codex_includes_the_headless_capture_roots() {
        if std::env::var_os("TOKSCALE_HEADLESS_DIR").is_some()
            || std::env::var_os("CODEX_HOME").is_some()
        {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let roots = client_source_roots("codex", dir.path(), &none());
        assert_eq!(roots.len(), 4);
        assert!(roots.iter().all(|r| r.id == "codex-sessions"));
        assert!(!client_present("codex", dir.path(), &none()));
        let headless = dir
            .path()
            .join("Library")
            .join("Application Support")
            .join("tokscale")
            .join("headless")
            .join("codex");
        std::fs::create_dir_all(&headless).unwrap();
        assert!(client_present("codex", dir.path(), &none()));
    }

    #[test]
    fn workspace_storage_needs_a_chat_sessions_dir() {
        let dir = tempfile::tempdir().unwrap();
        let storage = dir.path().join("workspaceStorage");
        std::fs::create_dir_all(storage.join("abc")).unwrap();
        std::fs::write(storage.join("abc").join("state.vscdb"), b"").unwrap();
        let root = source("vscode-workspace-storage", storage.clone());
        assert!(!source_root_exists(&root), "VS Code alone is not Copilot");
        std::fs::create_dir_all(storage.join("abc").join("chatSessions")).unwrap();
        assert!(source_root_exists(&root));
    }

    #[test]
    fn exact_file_sources_check_the_file_not_the_dir() {
        let dir = tempfile::tempdir().unwrap();
        let root = file_source("copilot-data", dir.path().join("data.db"));
        assert_eq!(root.dir, dir.path());
        assert!(
            !source_root_exists(&root),
            "the directory alone is not the database"
        );
        std::fs::create_dir_all(dir.path().join("data.db")).unwrap();
        assert!(
            !source_root_exists(&root),
            "a directory named data.db is not the database"
        );
        std::fs::remove_dir(dir.path().join("data.db")).unwrap();
        std::fs::write(dir.path().join("data.db"), b"").unwrap();
        assert!(source_root_exists(&root));
    }

    #[test]
    fn copilot_lists_every_workspace_storage_spelling_once() {
        let home = Path::new("/home/u");
        let roots = client_source_roots("copilot", home, &none());
        let storage: Vec<&PathBuf> = roots
            .iter()
            .filter(|r| r.id == "vscode-workspace-storage")
            .map(|r| &r.dir)
            .collect();
        let unique: std::collections::HashSet<_> = storage.iter().collect();
        assert_eq!(unique.len(), storage.len());
        assert!(storage.contains(
            &&home
                .join("AppData")
                .join("Roaming")
                .join("Code")
                .join("User")
                .join("workspaceStorage")
        ));
        assert_eq!(
            ids(&roots[..3]),
            ["copilot-otel", "copilot-data", "copilot-session-store"]
        );
    }

    #[test]
    fn copilot_exporter_is_an_exact_file_outside_otel() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let os = |s: &Path| s.as_os_str().to_owned();
        let file = home.join("exports").join("copilot.jsonl");
        assert_eq!(
            exporter_file_from(Some(&os(&file)), home),
            Some(file.clone())
        );
        let padded = std::ffi::OsString::from(format!("  {}  ", file.display()));
        assert_eq!(exporter_file_from(Some(&padded), home), Some(file));
        assert_eq!(exporter_file_from(None, home), None);
        assert_eq!(exporter_file_from(Some("   ".as_ref()), home), None);
        // 已經在 ~/.copilot/otel 底下：那棵樹本來就整棵監看。
        let inside = home.join(".copilot").join("otel").join("x.jsonl");
        assert_eq!(exporter_file_from(Some(&os(&inside)), home), None);
        // 上層是磁碟根目錄：不監看整個磁碟。
        let at_root = std::path::absolute(Path::new("/x.jsonl")).unwrap();
        assert_eq!(exporter_file_from(Some(&os(&at_root)), home), None);
    }

    #[test]
    fn custom_scan_paths_are_sources_of_their_client() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let extra = dir.path().join("extra");
        let mut custom = IndexMap::new();
        custom.insert(
            "claude".to_string(),
            vec![extra.to_string_lossy().into_owned()],
        );
        if std::env::var_os("CLAUDE_CONFIG_DIR").is_none() {
            assert!(!client_present("claude", &home, &custom));
        }
        std::fs::create_dir_all(&extra).unwrap();
        assert!(client_present("claude", &home, &custom));
        let last = client_source_roots("claude", &home, &custom).pop().unwrap();
        assert!(last.custom);
        assert_eq!(last.id, "custom-scan-path");
        assert!(!client_source_roots("codex", &home, &custom)
            .iter()
            .any(|r| r.custom));
    }
}
