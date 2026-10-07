//! 來源目錄的檔案監看：有相關變動就請 runtime 跑一次 anchored tick（上游 collector.js 的
//! chokidar watcher 與 `watchPolicyEntries`）。
//!
//! 只監看 client **自己寫**的紀錄：
//! - Cursor 與 Antigravity 不監看。它們的用量來自 tokscale 自己同步寫入的 cache，監看會自我觸發
//!   無限重掃（上游 issue #15）；它們由定時的 anchored tick（含自我同步）更新。
//! - Copilot 的 `~/.copilot` 只算 `otel/` 與資料庫檔；VS Code 的 workspaceStorage 只算
//!   `<hash>/chatSessions/`：VS Code 隨時在那裡寫別的東西，不過濾就會一直重掃。
//! - 使用者設定的額外掃描目錄（`customScanPaths`）整棵監看，與 tokscale 的遞迴讀法一致。
//!
//! 監看是加速，不是事實來源：漏掉的事件由定時 tick 與每小時的完整掃描補上。

use std::path::{Component, Path, PathBuf};

use indexmap::IndexMap;
use notify::{EventKind, RecursiveMode, Watcher as _};

use super::roots;

/// 一個監看根目錄與它的事件過濾規則。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchRoot {
    pub client: String,
    pub dir: PathBuf,
    pub recursive: bool,
    pub filter: Filter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    /// tokscale 整棵讀的 transcript 樹：任何變動都算。
    All,
    /// `~/.copilot`：`otel/` 底下，或最上層的 `data.db` / `session-store.db`（含 -wal/-shm/-journal）。
    CopilotHome,
    /// VS Code `workspaceStorage`：只有 `<hash>/chatSessions/…`。
    WorkspaceStorage,
    /// OpenCode 資料目錄：`opencode*.db*` 與舊版的 `storage/…`。
    OpencodeData,
    /// Hermes home：只有 `state.db*`。
    HermesHome,
}

/// 不監看的 client：用量來自 tokscale 自己寫的 cache（見檔頭）。
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

fn is_db_file(name: &str, stem: &str) -> bool {
    name.strip_prefix(stem)
        .map(|rest| matches!(rest, "" | "-wal" | "-shm" | "-journal"))
        .unwrap_or(false)
}

impl WatchRoot {
    /// 這個路徑的變動會不會改變 tokscale 讀到的東西。根目錄本身（新建、刪除）一律算。
    pub fn is_relevant(&self, path: &Path) -> bool {
        let Some(parts) = parts(&self.dir, path) else {
            return false;
        };
        if parts.is_empty() {
            return true;
        }
        match self.filter {
            Filter::All => true,
            Filter::CopilotHome => {
                parts[0] == "otel"
                    || (parts.len() == 1
                        && (is_db_file(&parts[0], "data.db")
                            || is_db_file(&parts[0], "session-store.db")))
            }
            Filter::WorkspaceStorage => parts.len() >= 2 && parts[1] == "chatSessions",
            Filter::OpencodeData => {
                parts[0] == "storage"
                    || (parts[0].starts_with("opencode") && parts[0].contains(".db"))
            }
            Filter::HermesHome => parts.len() == 1 && is_db_file(&parts[0], "state.db"),
        }
    }
}

fn non_blank_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.to_string_lossy().trim().is_empty())
        .map(PathBuf::from)
}

fn root(client: &str, dir: PathBuf, recursive: bool, filter: Filter) -> WatchRoot {
    WatchRoot {
        client: client.to_string(),
        dir,
        recursive,
        filter,
    }
}

/// 追蹤中的 client 的監看根目錄（不檢查是否存在；`start` 只監看存在的）。
pub fn watch_roots(
    tracked: &[String],
    custom_scan_paths: &IndexMap<String, Vec<String>>,
    home: &Path,
) -> Vec<WatchRoot> {
    let mut out = Vec::new();
    for client in tracked {
        if SELF_SYNCED.contains(&client.as_str()) {
            continue;
        }
        match client.as_str() {
            "claude" => {
                let base =
                    non_blank_env("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude"));
                out.push(root("claude", base.join("projects"), true, Filter::All));
                out.push(root("claude", base.join("transcripts"), true, Filter::All));
            }
            "codex" => {
                let base = non_blank_env("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
                out.push(root("codex", base.join("sessions"), true, Filter::All));
                out.push(root(
                    "codex",
                    base.join("archived_sessions"),
                    true,
                    Filter::All,
                ));
            }
            "opencode" => {
                // 與 roots.rs 同一個位置（tokscale 的 XDG data home 下的 opencode）。
                if let Some(dir) = roots::source_roots("opencode", home).into_iter().next() {
                    out.push(root("opencode", dir, true, Filter::OpencodeData));
                }
            }
            "hermes" => {
                out.push(root(
                    "hermes",
                    roots::hermes_home(home),
                    false,
                    Filter::HermesHome,
                ));
            }
            "copilot" => {
                out.push(root(
                    "copilot",
                    home.join(".copilot"),
                    true,
                    Filter::CopilotHome,
                ));
                for dir in roots::source_roots("copilot", home)
                    .into_iter()
                    .filter(|d| d.ends_with("workspaceStorage"))
                {
                    out.push(root("copilot", dir, true, Filter::WorkspaceStorage));
                }
            }
            _ => {}
        }
        for dir in custom_scan_paths.get(client).into_iter().flatten() {
            out.push(root(client, PathBuf::from(dir), true, Filter::All));
        }
    }
    // 同一個目錄只監看一次（例如 APPDATA 與 home 推出同一個 workspaceStorage）。
    let mut seen = std::collections::HashSet::new();
    out.retain(|r| seen.insert(r.dir.clone()));
    out
}

/// 活著的監看。drop 即停止。
pub struct Watcher {
    _inner: notify::RecommendedWatcher,
    pub watched: Vec<PathBuf>,
}

/// 開始監看存在的根目錄；有相關變動就呼叫 `on_change`（在 notify 的執行緒上，要夠輕）。
/// 一個根目錄都監看不了時回錯，由 runtime 退回只靠定時 tick。
pub fn start(
    roots: Vec<WatchRoot>,
    on_change: impl Fn() + Send + 'static,
) -> Result<Watcher, String> {
    let existing: Vec<WatchRoot> = roots.into_iter().filter(|r| r.dir.exists()).collect();
    if existing.is_empty() {
        return Err("沒有可監看的來源目錄".into());
    }
    let filters = existing.clone();
    let mut inner = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        let relevant = event
            .paths
            .iter()
            .any(|p| filters.iter().any(|r| r.is_relevant(p)));
        if relevant {
            on_change();
        }
    })
    .map_err(|e| e.to_string())?;
    let mut watched = Vec::new();
    for r in &existing {
        let mode = if r.recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        match inner.watch(&r.dir, mode) {
            Ok(()) => watched.push(r.dir.clone()),
            Err(e) => tracing::warn!(dir = %r.dir.display(), error = %e, "cannot watch source dir"),
        }
    }
    if watched.is_empty() {
        return Err("來源目錄都無法監看".into());
    }
    Ok(Watcher {
        _inner: inner,
        watched,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn r(dir: &str, filter: Filter) -> WatchRoot {
        root("x", PathBuf::from(dir), true, filter)
    }

    #[test]
    fn copilot_home_only_counts_otel_and_databases() {
        let c = r("/h/.copilot", Filter::CopilotHome);
        assert!(c.is_relevant(Path::new("/h/.copilot/otel/2026-09-24.jsonl")));
        assert!(c.is_relevant(Path::new("/h/.copilot/data.db-wal")));
        assert!(c.is_relevant(Path::new("/h/.copilot/session-store.db")));
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
        assert!(!w.is_relevant(Path::new("/a/Code/User/workspaceStorage/abc/state.vscdb")));
        assert!(!w.is_relevant(Path::new("/a/Code/User/workspaceStorage/abc")));
    }

    #[test]
    fn opencode_and_hermes_filters() {
        let o = r("/x/opencode", Filter::OpencodeData);
        assert!(o.is_relevant(Path::new("/x/opencode/opencode.db-wal")));
        assert!(o.is_relevant(Path::new("/x/opencode/storage/message/a/b.json")));
        assert!(!o.is_relevant(Path::new("/x/opencode/log/today.log")));
        let h = r("/x/.hermes", Filter::HermesHome);
        assert!(h.is_relevant(Path::new("/x/.hermes/state.db-wal")));
        assert!(!h.is_relevant(Path::new("/x/.hermes/config.yaml")));
    }

    #[test]
    fn self_synced_clients_are_never_watched() {
        let tracked: Vec<String> = ["claude", "cursor", "antigravity", "copilot"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let mut custom = IndexMap::new();
        custom.insert("cursor".to_string(), vec!["/c/cursor-extra".to_string()]);
        custom.insert("claude".to_string(), vec!["/c/claude-extra".to_string()]);
        let roots = watch_roots(&tracked, &custom, Path::new("/home/u"));
        assert!(roots
            .iter()
            .all(|r| r.client != "cursor" && r.client != "antigravity"));
        assert!(roots
            .iter()
            .any(|r| r.dir == Path::new("/c/claude-extra") && r.filter == Filter::All));
        assert!(!roots.iter().any(|r| r.dir == Path::new("/c/cursor-extra")));
        assert!(roots.iter().any(|r| r.filter == Filter::CopilotHome));
    }

    #[test]
    fn a_write_under_a_watched_root_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let projects = dir.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let watcher = start(
            vec![
                root("claude", projects.clone(), true, Filter::All),
                root("claude", dir.path().join("missing"), true, Filter::All),
            ],
            move || {
                counter.fetch_add(1, Ordering::SeqCst);
            },
        )
        .expect("watch starts");
        assert_eq!(
            watcher.watched,
            vec![projects.clone()],
            "missing roots are skipped"
        );
        std::fs::create_dir_all(projects.join("p1")).unwrap();
        std::fs::write(projects.join("p1").join("s.jsonl"), b"{}\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while hits.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(hits.load(Ordering::SeqCst) > 0, "no event within 5 s");
    }

    #[test]
    fn nothing_to_watch_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = start(
            vec![root("claude", dir.path().join("nope"), true, Filter::All)],
            || {},
        )
        .err()
        .unwrap();
        assert!(err.contains("沒有"));
    }
}
