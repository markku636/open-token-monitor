//! 常駐 tm-agent 的 PID 檔（上游 src/agent/agent.js `registerPidFile`、config.js `pidFilePath`、
//! main.js `isExternalAgentActive`）。
//!
//! tm-agent 與 GUI 共用設定目錄裡的 session usage archive 與 daily history archive。上游的做法是
//! agent 在掃描前寫下自己的 PID，GUI 看到活著的 agent 就讓出寫入權：archive 只讀（從檔案重新讀
//! agent 寫的內容），也不能清除。
//!
//! - 誰寫：`run` 與 `once`，dry run 不寫（上游 `if (!dryRun) registerPidFile(...)`）；結束時刪掉。
//! - 內容：只有十進位的 PID，沒有換行（上游 `String(process.pid)`）。
//! - 判斷（上游）：檔案讀得到、開頭的整數（`parseInt`）不是 0 也不是自己，而且那個程序還活著。
//!   被強制結束的 agent 會留下 PID 檔，靠「程序還活著」排除；這裡另外比對程序的啟動時間與 PID 檔
//!   的修改時間（`alive` 的第二個參數），PID 被新程序重用時不會一直誤判成 agent 還在。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use crate::error::{AppError, AppResult};

/// 設定目錄裡的檔名（上游同名）。
pub const PID_FILE: &str = "agent.pid";

/// 「常駐 tm-agent 正在跑嗎？」GUI 注入給 runtime；tm-agent 自己不需要（它就是寫入者）。
pub type ExternalAgentProbe = Arc<dyn Fn() -> bool + Send + Sync>;

/// 上游 `parseInt(raw.trim(), 10)` 的正整數部分：取開頭連續的數字，其他一律不算。
fn parse_pid(raw: &str) -> Option<u32> {
    let text = raw.trim();
    let text = text.strip_prefix('+').unwrap_or(text);
    let digits: &str = &text[..text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len())];
    digits.parse::<u32>().ok().filter(|pid| *pid != 0)
}

/// PID 檔裡的 PID 與檔案的修改時間（agent 寫下它的時間）。
pub fn read_pid(path: &Path) -> Option<(u32, Option<SystemTime>)> {
    let raw = std::fs::read_to_string(path).ok()?;
    let pid = parse_pid(&raw)?;
    let written = std::fs::metadata(path).and_then(|m| m.modified()).ok();
    Some((pid, written))
}

/// 上游 main.js `isExternalAgentActive`。`alive(pid, written)` 是平台的存活檢查，`written` 是 PID 檔的
/// 修改時間：在它之後才啟動的程序不可能是寫下它的 agent（PID 被重用）。
pub fn external_agent_active(
    dir: &Path,
    own_pid: u32,
    alive: impl Fn(u32, Option<SystemTime>) -> bool,
) -> bool {
    match read_pid(&dir.join(PID_FILE)) {
        Some((pid, written)) if pid != own_pid => alive(pid, written),
        _ => false,
    }
}

/// tm-agent 執行期間的 PID 檔；drop 時刪掉（上游在 `exit` 與 SIGINT / SIGTERM / SIGHUP 時刪）。
#[derive(Debug)]
pub struct PidFile {
    path: PathBuf,
    pid: u32,
}

impl PidFile {
    /// 在 `dir` 寫下這個程序的 PID（上游在任何掃描之前寫，GUI 才來得及讓出 archive 的寫入）。
    pub fn register(dir: &Path) -> AppResult<PidFile> {
        Self::register_as(dir, std::process::id())
    }

    fn register_as(dir: &Path, pid: u32) -> AppResult<PidFile> {
        std::fs::create_dir_all(dir)
            .map_err(|e| AppError::Storage(format!("{}: {e}", dir.display())))?;
        let path = dir.join(PID_FILE);
        std::fs::write(&path, pid.to_string())
            .map_err(|e| AppError::Storage(format!("{}: {e}", path.display())))?;
        Ok(PidFile { path, pid })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for PidFile {
    fn drop(&mut self) {
        // 只刪自己的：之後啟動的另一個 tm-agent 覆寫了同一個檔，就留給它（上游一律刪）。
        if read_pid(&self.path).map(|(pid, _)| pid) == Some(self.pid) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_like_parse_int() {
        assert_eq!(parse_pid("1234"), Some(1234));
        assert_eq!(parse_pid(" 1234\r\n"), Some(1234));
        assert_eq!(parse_pid("1234abc"), Some(1234));
        assert_eq!(parse_pid("+42"), Some(42));
        assert_eq!(
            parse_pid("0"),
            None,
            "parseInt gives 0, which upstream treats as no agent"
        );
        assert_eq!(parse_pid(""), None);
        assert_eq!(parse_pid("abc"), None);
        assert_eq!(parse_pid("-5"), None);
    }

    #[test]
    fn register_writes_the_bare_pid_and_drop_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(PID_FILE);
        {
            let pid = PidFile::register(dir.path()).unwrap();
            assert_eq!(pid.path(), path);
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                std::process::id().to_string()
            );
        }
        assert!(!path.exists());
    }

    #[test]
    fn drop_leaves_a_newer_agents_pid_file_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(PID_FILE);
        let first = PidFile::register_as(dir.path(), 111).unwrap();
        let second = PidFile::register_as(dir.path(), 222).unwrap();
        drop(first);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "222");
        drop(second);
        assert!(!path.exists());
    }

    #[test]
    fn external_agent_needs_a_live_foreign_pid() {
        let dir = tempfile::tempdir().unwrap();
        let alive = |pid: u32, written: Option<SystemTime>| {
            assert!(written.is_some(), "the file's mtime is passed along");
            pid == 4242
        };
        assert!(!external_agent_active(dir.path(), 1, alive), "no pid file");
        std::fs::write(dir.path().join(PID_FILE), "4242").unwrap();
        assert!(external_agent_active(dir.path(), 1, alive));
        assert!(
            !external_agent_active(dir.path(), 4242, alive),
            "our own pid is never an external agent"
        );
        std::fs::write(dir.path().join(PID_FILE), "999").unwrap();
        assert!(
            !external_agent_active(dir.path(), 1, alive),
            "a stale pid file of a dead agent"
        );
        std::fs::write(dir.path().join(PID_FILE), "garbage").unwrap();
        assert!(!external_agent_active(dir.path(), 1, |_, _| true));
    }
}
