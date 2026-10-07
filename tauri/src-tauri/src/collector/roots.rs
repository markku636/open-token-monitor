//! 各工具的本機資料位置（上游 collector.js `clientSourceRoots`）。
//!
//! M1 用來判斷 `clientStatus` 的 `waiting`（裝了但還沒有用量）與 `missing`（本機沒有這個工具）；
//! M2 的 watcher 也會用同一張表。
//!
//! 注意：Cursor 與 Antigravity 的 cache 是 tokscale 自己同步寫入的（collector/self_sync.rs），
//! 這裡列出只是為了判斷狀態；M2 的 watcher 絕不能監看它們，否則會自我觸發無限重掃。

use std::path::{Path, PathBuf};

use super::{antigravity, cursor};

fn non_blank_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.to_string_lossy().trim().is_empty())
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
    if let Some(p) = non_blank_env("HERMES_HOME") {
        return p;
    }
    let dot = home.join(".hermes");
    if dot.join("state.db").exists() {
        return dot;
    }
    if cfg!(windows) {
        let local =
            non_blank_env("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData").join("Local"));
        let native = local.join("hermes");
        if native.join("state.db").exists() {
            return native;
        }
    }
    dot
}

pub fn source_roots(client: &str, home: &Path) -> Vec<PathBuf> {
    let t_home = tokscale_home(home);
    let xdg_data =
        non_blank_env("XDG_DATA_HOME").unwrap_or_else(|| t_home.join(".local").join("share"));
    let app_data = non_blank_env("APPDATA").unwrap_or_else(|| home.join("AppData").join("Roaming"));
    let vscode_storage = |base: PathBuf| base.join("Code").join("User").join("workspaceStorage");
    match client {
        "claude" => {
            let base = non_blank_env("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude"));
            vec![base.join("projects"), base.join("transcripts")]
        }
        "codex" => {
            let base = non_blank_env("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
            vec![base.join("sessions"), base.join("archived_sessions")]
        }
        // tokscale 讀 opencode*.db 與舊版的 storage/message/。
        "opencode" => vec![xdg_data.join("opencode")],
        "hermes" => vec![hermes_home(home).join("state.db")],
        // 帳號層級的用量匯出：IDE 與 CLI 共用。桌面版在就算「已安裝」，cache 由同步產生。
        "cursor" => {
            let mut roots = vec![cursor::cache_dir(&t_home)];
            roots.extend(cursor::desktop_state_candidates(home));
            roots
        }
        "antigravity" => {
            let mut roots = antigravity::data_roots(home);
            roots.push(
                home.join(".gemini")
                    .join("antigravity-cli")
                    .join("conversations"),
            );
            roots.push(antigravity::cache_dir(home));
            roots
        }
        "copilot" => vec![
            home.join(".copilot").join("otel"),
            home.join(".copilot").join("data.db"),
            home.join(".copilot").join("session-store.db"),
            vscode_storage(app_data),
            vscode_storage(home.join(".config")),
            vscode_storage(home.join("Library").join("Application Support")),
        ],
        _ => Vec::new(),
    }
}

pub fn client_present(client: &str, home: &Path) -> bool {
    source_roots(client, home).iter().any(|p| p.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_supported_client_has_roots() {
        let home = Path::new("/home/u");
        for id in crate::settings::SUPPORTED_CLIENTS {
            assert!(
                !source_roots(id, home).is_empty(),
                "{id} has no source roots"
            );
        }
        assert!(source_roots("unknown-client", home).is_empty());
    }

    #[test]
    fn hermes_prefers_env_then_dot_hermes() {
        let dir = tempfile::tempdir().unwrap();
        if std::env::var_os("HERMES_HOME").is_none() {
            assert_eq!(hermes_home(dir.path()), dir.path().join(".hermes"));
            std::fs::create_dir_all(dir.path().join(".hermes")).unwrap();
            std::fs::write(dir.path().join(".hermes").join("state.db"), b"").unwrap();
            assert!(client_present("hermes", dir.path()));
        }
    }
}
