//! Antigravity：IDE 的用量要先 `tokscale antigravity sync` 從執行中的 language server 拉進
//! tokscale 的 cache，之後的掃描才讀得到（上游 src/shared/providers/antigravity/selfSync.js）。
//! Antigravity CLI 的對話（`~/.gemini/antigravity-cli/conversations/`）tokscale 直接讀，不需要同步。
//!
//! 同步程序被我們逾時終止時，tokscale 可能留下 `sync.lock`。上游只清理「確定是我們剛剛終止的那個
//! 子程序」留下的鎖：一般檔案、內容是 `<pid> <秒>`、pid 相同、時間落在子程序存活期間，刪除前再比對一次。
//! 其他任何鎖都保留（可能是別的 tokscale 版本正在用）。

use std::path::{Path, PathBuf};

const DATA_ROOTS: &[&str] = &["antigravity", "antigravity-ide", "antigravity-backup"];
const LOCK_MAX_BYTES: u64 = 128;

pub fn data_roots(home: &Path) -> Vec<PathBuf> {
    DATA_ROOTS
        .iter()
        .map(|n| home.join(".gemini").join(n))
        .collect()
}

/// IDE 的資料夾都不存在就沒有東西可同步，不必啟動子程序。
pub fn data_present(home: &Path) -> bool {
    data_roots(home).iter().any(|p| p.is_dir())
}

/// tokscale 的設定目錄（上游 src/shared/tokscaleConfig.js `tokscaleConfigDir`）。
pub fn tokscale_config_dir(home: &Path) -> PathBuf {
    if let Some(v) = std::env::var_os("TOKSCALE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(v);
    }
    if cfg!(target_os = "macos") {
        return home.join(".config").join("tokscale");
    }
    if cfg!(windows) {
        let app_data = std::env::var_os("APPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        return app_data.join("tokscale");
    }
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.join(".config"));
    config.join("tokscale")
}

pub fn cache_dir(home: &Path) -> PathBuf {
    tokscale_config_dir(home).join("antigravity-cache")
}

pub fn sync_lock_path(home: &Path) -> PathBuf {
    cache_dir(home).join("sync.lock")
}

fn parse_lock(record: &str) -> Option<(u32, i64)> {
    let mut parts = record.split_whitespace();
    let pid = parts.next()?.parse().ok()?;
    let at = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((pid, at))
}

/// `removeOwnedAntigravitySyncLock`：只刪除我們剛剛終止的子程序留下的鎖。
pub fn remove_owned_lock(
    lock: &Path,
    child_pid: u32,
    child_started_at_ms: i64,
    now_ms: i64,
) -> bool {
    let Ok(first) = std::fs::symlink_metadata(lock) else {
        return false;
    };
    if !first.is_file() || first.len() > LOCK_MAX_BYTES {
        return false;
    }
    let Ok(record) = std::fs::read_to_string(lock) else {
        return false;
    };
    let Some((pid, recorded_at)) = parse_lock(&record) else {
        return false;
    };
    if pid != child_pid {
        return false;
    }
    let earliest = child_started_at_ms.div_euclid(1000) - 1;
    let latest = now_ms.div_euclid(1000) + 1;
    if recorded_at < earliest || recorded_at > latest {
        return false;
    }
    // 刪除前再確認一次：期間若有人換掉或改了這個檔案，就保留。
    // （Windows 的 std 沒有穩定的 inode，用大小、修改時間與內容代替。）
    let Ok(last) = std::fs::symlink_metadata(lock) else {
        return false;
    };
    if last.len() != first.len() || last.modified().ok() != first.modified().ok() {
        return false;
    }
    if std::fs::read_to_string(lock).ok().as_deref() != Some(record.as_str()) {
        return false;
    }
    std::fs::remove_file(lock).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_only_our_own_lock() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("sync.lock");
        let started = 1_790_000_000_000_i64;
        let now = started + 5_000;
        std::fs::write(&lock, format!("4242 {}\n", started / 1000 + 2)).unwrap();
        assert!(
            !remove_owned_lock(&lock, 9999, started, now),
            "different pid is kept"
        );
        assert!(lock.exists());
        std::fs::write(&lock, format!("4242 {}\n", started / 1000 - 100)).unwrap();
        assert!(
            !remove_owned_lock(&lock, 4242, started, now),
            "older record is kept"
        );
        std::fs::write(&lock, "garbage").unwrap();
        assert!(!remove_owned_lock(&lock, 4242, started, now));
        std::fs::write(&lock, format!("4242 {}", started / 1000 + 1)).unwrap();
        assert!(remove_owned_lock(&lock, 4242, started, now));
        assert!(!lock.exists());
        assert!(
            !remove_owned_lock(&lock, 4242, started, now),
            "missing lock is a no-op"
        );
    }

    #[test]
    fn data_roots_live_under_gemini() {
        let home = Path::new("/home/u");
        assert!(data_roots(home)
            .iter()
            .all(|p| p.starts_with("/home/u/.gemini")));
        assert!(!data_present(home));
    }
}
