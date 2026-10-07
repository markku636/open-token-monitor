//! 常駐 tm-agent 的偵測（上游 main.js `isExternalAgentActive`）：設定目錄的 `agent.pid` 指向一個
//! 還活著的程序，GUI 就讓出 session / daily history archive 的寫入，也不讓人清除它們。PID 檔的
//! 格式與判斷在 device/agent_pid.rs；這裡只有平台的「程序還活著嗎」。
//!
//! 上游用 `process.kill(pid, 0)`（Windows 上是以 `PROCESS_QUERY_INFORMATION` 開啟、看結束碼）。
//! 這裡以 `PROCESS_QUERY_LIMITED_INFORMATION` 開啟、看結束碼是不是 `STILL_ACTIVE`，另外比對程序的
//! 啟動時間：比 PID 檔晚啟動的程序不可能是寫下它的 agent（被強制結束的 agent 留下的 PID 檔、
//! PID 又被別的程序用走時，上游會一直以為 agent 還在）。

use std::time::{Duration, SystemTime};

use crate::device::agent_pid;

/// PID 檔的修改時間與程序啟動時間的容許誤差（兩者來自同一個系統時鐘，只防檔案系統的時間粒度）。
const START_SLACK: Duration = Duration::from_secs(2);

/// 常駐的 tm-agent 正在跑嗎（GUI 自己的 PID 永遠不算）。
pub fn external_agent_active() -> bool {
    agent_pid::external_agent_active(
        &crate::store::config_dir(),
        std::process::id(),
        process_alive,
    )
}

/// `started` 晚於 `written`（加上容許誤差）= PID 被重用。
fn started_after(started: SystemTime, written: Option<SystemTime>) -> bool {
    written.is_some_and(|w| started > w + START_SLACK)
}

#[cfg(windows)]
fn process_alive(pid: u32, written: Option<SystemTime>) -> bool {
    use windows::Win32::Foundation::{CloseHandle, FILETIME, STILL_ACTIVE};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: 只查詢（不需要其他權限）；handle 在每條路徑上都關掉。
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut code = 0u32;
        let running =
            GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
        let (mut created, mut exited, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        let started = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user)
            .ok()
            .and_then(|_| filetime_to_system(created));
        let _ = CloseHandle(handle);
        running && !started.is_some_and(|s| started_after(s, written))
    }
}

/// FILETIME（1601-01-01 起的 100 ns）→ SystemTime。
#[cfg(windows)]
fn filetime_to_system(ft: windows::Win32::Foundation::FILETIME) -> Option<SystemTime> {
    const UNIX_EPOCH_IN_FILETIME: u64 = 116_444_736_000_000_000;
    let ticks = (u64::from(ft.dwHighDateTime) << 32) | u64::from(ft.dwLowDateTime);
    let since_epoch = ticks.checked_sub(UNIX_EPOCH_IN_FILETIME)?;
    SystemTime::UNIX_EPOCH.checked_add(Duration::from_nanos(since_epoch.saturating_mul(100)))
}

/// 上游的 `process.kill(pid, 0)`；沒有程序啟動時間可比。
#[cfg(unix)]
fn process_alive(pid: u32, _written: Option<SystemTime>) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(not(any(windows, unix)))]
fn process_alive(_pid: u32, _written: Option<SystemTime>) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_process_started_after_the_pid_file_is_not_the_agent() {
        let written = SystemTime::now();
        assert!(!started_after(
            written - Duration::from_secs(60),
            Some(written)
        ));
        assert!(!started_after(
            written + Duration::from_secs(1),
            Some(written)
        ));
        assert!(started_after(
            written + Duration::from_secs(60),
            Some(written)
        ));
        assert!(!started_after(written, None), "no mtime: trust the pid");
    }

    #[test]
    fn this_process_is_alive_and_a_bogus_pid_is_not() {
        let now = Some(SystemTime::now());
        assert!(process_alive(std::process::id(), now));
        // 比這個程序啟動還早寫下的 PID 檔：這個程序不可能是寫下它的 agent。
        #[cfg(windows)]
        assert!(!process_alive(
            std::process::id(),
            Some(SystemTime::now() - Duration::from_secs(24 * 3600 * 365))
        ));
        assert!(!process_alive(u32::MAX - 1, now));
    }
}
