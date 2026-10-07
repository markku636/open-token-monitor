//! Antigravity 額度探測的作業系統部分：列出候選程序的命令列、查某個程序在監聽哪些 TCP port
//! （上游 src/shared/providers/antigravity/probe.js `detectProcessInfos*` / `listeningPorts*`）。
//!
//! - Windows：上游每次都啟動 PowerShell 查 `Get-CimInstance Win32_Process` 與 `Get-NetTCPConnection`
//!   （一次 1–2 秒）。這裡直接讀同一份資料：ToolHelp 快照列程序、`NtQueryInformationProcess`
//!   （`ProcessCommandLineInformation`，WMI 的 `CommandLine` 也是讀這個）取命令列、`GetExtendedTcpTable`
//!   取 IPv4 與 IPv6 的監聽 port。名稱篩選與上游的 `-like` 相同；讀不到命令列的程序（別的使用者、
//!   權限較高）跳過，與 WMI 回空字串時一樣。
//! - 其他平台：與上游相同，`ps -ax -o pid=,command=` 與 `lsof`。

use std::time::Duration;

use super::http::ProbeError;
use crate::wire::ProviderStatus;

const NO_PORTS: &str = "no listening ports for antigravity LS";

fn unavailable(message: impl Into<String>) -> ProbeError {
    ProbeError::new(ProviderStatus::Unavailable, message)
}

/// 上游 PowerShell 的名稱篩選：`language_server*`、`language-server*`、`agy*`、`antigravity*`（不分大小寫）。
/// 精確的分類在 antigravity.rs 以命令列再做一次，這裡寬鬆沒關係。
pub fn candidate_process_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["language_server", "language-server", "agy", "antigravity"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

/// 候選程序的 (PID, 命令列)。
pub async fn processes(timeout: Duration) -> Result<Vec<(u32, String)>, ProbeError> {
    #[cfg(windows)]
    {
        let _ = timeout;
        blocking("list processes", win::processes).await
    }
    #[cfg(not(windows))]
    {
        let text = run(
            "ps",
            &["-ax", "-o", "pid=,command="],
            timeout.min(Duration::from_secs(8)),
        )
        .await?;
        Ok(ps_entries(&text))
    }
}

/// 程序正在監聽的 TCP port（遞增、不重複）；一個都沒有是錯誤（上游相同）。
pub async fn listening_ports(pid: u32, timeout: Duration) -> Result<Vec<u16>, ProbeError> {
    #[cfg(windows)]
    let ports = {
        let _ = timeout;
        blocking("list listening ports", move || win::listening_ports(pid)).await?
    };
    #[cfg(not(windows))]
    let ports = {
        let pid = pid.to_string();
        let text = run(
            "lsof",
            &["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", &pid],
            timeout.min(Duration::from_secs(6)),
        )
        .await
        .map_err(|e| unavailable(format!("lsof failed: {}", e.message)))?;
        lsof_ports(&text)
    };
    let mut ports = ports;
    ports.sort_unstable();
    ports.dedup();
    if ports.is_empty() {
        return Err(unavailable(NO_PORTS));
    }
    Ok(ports)
}

/// `ps` 的每一行「PID 命令列」；PID 不是正整數的行略過。
#[cfg_attr(windows, allow(dead_code))]
pub fn ps_entries(text: &str) -> Vec<(u32, String)> {
    text.lines().filter_map(split_process_line).collect()
}

/// 上游 `parseProcessLine` 的前半：第一個空白之前是 PID，之後（去掉前後空白）是命令列。
pub fn split_process_line(line: &str) -> Option<(u32, String)> {
    let trimmed = line.trim();
    let (pid, command) = trimmed.split_once(' ')?;
    let pid = pid.parse::<u32>().ok().filter(|p| *p > 0)?;
    let command = command.trim();
    (!command.is_empty()).then(|| (pid, command.to_string()))
}

/// 上游 `listeningPortsPosix`：`lsof` 輸出裡的 `:<port> (LISTEN)`。
#[cfg_attr(windows, allow(dead_code))]
pub fn lsof_ports(text: &str) -> Vec<u16> {
    const MARK: &str = "(LISTEN)";
    let mut ports = Vec::new();
    for (i, _) in text.match_indices(MARK) {
        let before = &text[..i];
        let trimmed = before.trim_end();
        if trimmed.len() == before.len() {
            continue;
        }
        let digits = trimmed.bytes().rev().take_while(u8::is_ascii_digit).count();
        let (head, number) = trimmed.split_at(trimmed.len() - digits);
        if digits == 0 || !head.ends_with(':') {
            continue;
        }
        if let Ok(port) = number.parse::<u16>() {
            ports.push(port);
        }
    }
    ports
}

/// 跑一個 console 程式取 stdout（上游 probe.js `runProcessText`）：找不到程式是 notConfigured，
/// 逾時或非零結束是 unavailable。逾時時 `kill_on_drop` 終止子程序。
#[cfg_attr(windows, allow(dead_code))]
async fn run(cmd: &str, args: &[&str], timeout: Duration) -> Result<String, ProbeError> {
    let mut command = tokio::process::Command::new(cmd);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：與 tokscale/spawn.rs 相同，不閃出 console 視窗（Node 的 windowsHide）。
        command.creation_flags(0x0800_0000);
    }
    let output = match tokio::time::timeout(timeout, command.output()).await {
        Err(_) => return Err(unavailable(format!("{cmd} timed out"))),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ProbeError::new(
                ProviderStatus::NotConfigured,
                format!("{cmd} not found"),
            ))
        }
        Ok(Err(e)) => return Err(unavailable(format!("{cmd}: {e}"))),
        Ok(Ok(output)) => output,
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(unavailable(if stderr.is_empty() {
            format!(
                "{cmd} exited {}",
                output
                    .status
                    .code()
                    .map_or_else(|| "?".into(), |c| c.to_string())
            )
        } else {
            stderr
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(windows)]
async fn blocking<T: Send + 'static>(
    what: &'static str,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, ProbeError> {
    match tokio::task::spawn_blocking(f).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(unavailable(format!("{what}: {e}"))),
        Err(e) => Err(unavailable(format!("{what}: {e}"))),
    }
}

#[cfg(windows)]
mod win {
    use std::mem::size_of;

    use windows::Wdk::System::Threading::{
        NtQueryInformationProcess, ProcessCommandLineInformation,
    };
    use windows::Win32::Foundation::{CloseHandle, HANDLE, UNICODE_STRING};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID,
        MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;

    struct Owned(HANDLE);

    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: 這個 handle 由我們開啟、只關一次。
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    /// 緩衝區以 u64 配置，保證結構需要的 8 位元組對齊；`bytes` 是同一塊記憶體的位元組視圖。
    fn bytes(buf: &[u64]) -> &[u8] {
        // SAFETY: u64 切片的記憶體可以安全地以 u8 讀取，長度是位元組數。
        unsafe { std::slice::from_raw_parts(buf.as_ptr().cast::<u8>(), std::mem::size_of_val(buf)) }
    }

    pub fn processes() -> Result<Vec<(u32, String)>, String> {
        processes_named(super::candidate_process_name)
    }

    /// 執行檔名稱符合 `wanted` 的程序與命令列。
    pub fn processes_named(wanted: impl Fn(&str) -> bool) -> Result<Vec<(u32, String)>, String> {
        // SAFETY: 一般的 Win32 呼叫；快照 handle 交給 Owned 關閉。
        let snapshot = Owned(
            unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
                .map_err(|e| e.to_string())?,
        );
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut out = Vec::new();
        // SAFETY: entry.dwSize 已設定，指標指向本地變數。
        let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_ok();
        while more {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
            if wanted(&name) {
                if let Some(command) = command_line(entry.th32ProcessID) {
                    out.push((entry.th32ProcessID, command));
                }
            }
            // SAFETY: 同上。
            more = unsafe { Process32NextW(snapshot.0, &mut entry) }.is_ok();
        }
        Ok(out)
    }

    /// 程序建立時的命令列（與 `Win32_Process.CommandLine` 相同，原樣，含引號）。
    pub fn command_line(pid: u32) -> Option<String> {
        // SAFETY: 只要求查詢權限；handle 交給 Owned 關閉。
        let process =
            Owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?);
        let mut needed = 0u32;
        // 第一次只問需要多大（回 STATUS_INFO_LENGTH_MISMATCH）。
        // SAFETY: 長度 0 的緩衝區不會被寫入。
        let _ = unsafe {
            NtQueryInformationProcess(
                process.0,
                ProcessCommandLineInformation,
                std::ptr::null_mut(),
                0,
                &mut needed,
            )
        };
        let header = size_of::<UNICODE_STRING>();
        if (needed as usize) < header {
            return None;
        }
        let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
        let len = u32::try_from(std::mem::size_of_val(buf.as_slice())).ok()?;
        // SAFETY: 緩衝區至少有 `len` 位元組，系統只寫入這個範圍。
        let status = unsafe {
            NtQueryInformationProcess(
                process.0,
                ProcessCommandLineInformation,
                buf.as_mut_ptr().cast(),
                len,
                &mut needed,
            )
        };
        if status.0 < 0 {
            return None;
        }
        // 開頭是 UNICODE_STRING，Buffer 指向同一塊緩衝區裡緊接著的 UTF-16 字串；以位移讀，不解參照系統給的指標。
        // SAFETY: 緩衝區至少有 header 位元組；read_unaligned 不要求對齊。
        let us = unsafe { std::ptr::read_unaligned(buf.as_ptr().cast::<UNICODE_STRING>()) };
        let raw = bytes(&buf);
        let offset = (us.Buffer.0 as usize).checked_sub(raw.as_ptr() as usize)?;
        let text = raw.get(offset..offset.checked_add(us.Length as usize)?)?;
        let units: Vec<u16> = text
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let command = String::from_utf16_lossy(&units);
        (!command.trim().is_empty()).then_some(command)
    }

    /// `GetExtendedTcpTable(..., TCP_TABLE_OWNER_PID_LISTENER)` 的整張表。
    fn listener_table(family: u32) -> Result<Vec<u64>, String> {
        let mut size = 0u32;
        for _ in 0..4 {
            let mut buf = vec![0u64; (size as usize).div_ceil(8).max(1)];
            let mut len =
                u32::try_from(std::mem::size_of_val(buf.as_slice())).map_err(|e| e.to_string())?;
            // SAFETY: `len` 是緩衝區的實際大小；系統只寫入這個範圍，太小時回 ERROR_INSUFFICIENT_BUFFER 與需要的大小。
            let rc = unsafe {
                GetExtendedTcpTable(
                    Some(buf.as_mut_ptr().cast()),
                    &mut len,
                    false,
                    family,
                    TCP_TABLE_OWNER_PID_LISTENER,
                    0,
                )
            };
            match rc {
                0 => return Ok(buf),
                // 兩次呼叫之間表可能又變大：多留一點空間再試。
                ERROR_INSUFFICIENT_BUFFER => size = len.saturating_add(1024),
                other => return Err(format!("GetExtendedTcpTable failed ({other})")),
            }
        }
        Err("GetExtendedTcpTable kept growing".into())
    }

    /// 表頭（`dwNumEntries`）之後的每一列；列數超出緩衝區時只取放得下的。
    fn rows<Table, Row: Copy>(buf: &[u64], first_row: usize) -> Vec<Row> {
        let raw = bytes(buf);
        if raw.len() < size_of::<Table>() {
            return Vec::new();
        }
        let count = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
        let fits = raw.len().saturating_sub(first_row) / size_of::<Row>();
        (0..count.min(fits))
            .map(|i| {
                // SAFETY: 範圍已確認在緩衝區內；read_unaligned 不要求對齊。
                unsafe {
                    std::ptr::read_unaligned(
                        raw.as_ptr()
                            .add(first_row + i * size_of::<Row>())
                            .cast::<Row>(),
                    )
                }
            })
            .collect()
    }

    /// `dwLocalPort` 的低 16 位元是網路位元組序的 port。
    fn port(raw: u32) -> u16 {
        u16::from_be(raw as u16)
    }

    pub fn listening_ports(pid: u32) -> Result<Vec<u16>, String> {
        let mut ports = Vec::new();
        let v4 = listener_table(AF_INET)?;
        let offset = std::mem::offset_of!(MIB_TCPTABLE_OWNER_PID, table);
        for row in rows::<MIB_TCPTABLE_OWNER_PID, MIB_TCPROW_OWNER_PID>(&v4, offset) {
            if row.dwOwningPid == pid {
                ports.push(port(row.dwLocalPort));
            }
        }
        // IPv6 失敗（例如停用了 IPv6 堆疊）不影響 IPv4 的結果。
        if let Ok(v6) = listener_table(AF_INET6) {
            let offset = std::mem::offset_of!(MIB_TCP6TABLE_OWNER_PID, table);
            for row in rows::<MIB_TCP6TABLE_OWNER_PID, MIB_TCP6ROW_OWNER_PID>(&v6, offset) {
                if row.dwOwningPid == pid {
                    ports.push(port(row.dwLocalPort));
                }
            }
        }
        Ok(ports)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_upstream_powershell_filter() {
        for name in [
            "language_server_windows_x64.exe",
            "Language-Server.exe",
            "agy.exe",
            "Antigravity.exe",
        ] {
            assert!(candidate_process_name(name), "{name}");
        }
        for name in ["node.exe", "my_language_server.exe", "cursor.exe"] {
            assert!(!candidate_process_name(name), "{name}");
        }
    }

    #[test]
    fn ps_lines_split_into_pid_and_command() {
        let text = "  53602 /Applications/Antigravity.app/bin/language_server --csrf_token abc\n\
                    oops not-a-pid\n\
                    0 zero\n\
                    77\n\
                    9001  agy language-server  \n";
        assert_eq!(
            ps_entries(text),
            vec![
                (
                    53602,
                    "/Applications/Antigravity.app/bin/language_server --csrf_token abc".into()
                ),
                (9001, "agy language-server".into()),
            ]
        );
    }

    #[test]
    fn lsof_listen_ports() {
        // 上游 tests/shared/antigravityProbe.test.js 的 lsof 輸出。
        let text = "COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME\n\
            language_ 53602 javis    6u  IPv4 0x62d7cac36931a256      0t0  TCP 127.0.0.1:54733 (LISTEN)\n\
            language_ 53602 javis    7u  IPv4 0x62d7cac36931a257      0t0  TCP 127.0.0.1:54734 (LISTEN)\n\
            language_ 53602 javis    8u  IPv6 0x62d7cac36931a258      0t0  TCP [::1]:54735 (LISTEN)\n\
            language_ 53602 javis    9u  IPv4 0x62d7cac36931a259      0t0  TCP 127.0.0.1:54736->127.0.0.1:1 (ESTABLISHED)\n";
        assert_eq!(lsof_ports(text), vec![54733, 54734, 54735]);
        assert!(lsof_ports("TCP *:(LISTEN)").is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn reads_our_own_command_line() {
        let command = win::command_line(std::process::id()).expect("own command line");
        let exe = std::env::current_exe().unwrap();
        let stem = exe.file_stem().unwrap().to_string_lossy().to_lowercase();
        assert!(command.to_lowercase().contains(&stem), "{command}");
    }

    #[cfg(windows)]
    #[test]
    fn lists_processes_by_name() {
        // 用自己的執行檔名稱當篩選條件：快照裡一定有這個 PID，而且命令列讀得到。
        let exe = std::env::current_exe().unwrap();
        let name = exe.file_name().unwrap().to_string_lossy().to_lowercase();
        let listed = win::processes_named(|n| n.to_lowercase() == name).expect("snapshot");
        assert!(
            listed.iter().any(|(pid, _)| *pid == std::process::id()),
            "{listed:?}"
        );
        assert!(win::processes().is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn finds_a_port_we_listen_on() {
        let v4 = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let v6 = std::net::TcpListener::bind("[::1]:0").ok();
        let ports = win::listening_ports(std::process::id()).expect("tcp table");
        assert!(
            ports.contains(&v4.local_addr().unwrap().port()),
            "{ports:?}"
        );
        if let Some(v6) = v6 {
            assert!(
                ports.contains(&v6.local_addr().unwrap().port()),
                "{ports:?}"
            );
        }
        assert!(win::listening_ports(u32::MAX).unwrap().is_empty());
    }

    #[tokio::test]
    async fn no_listener_is_an_error() {
        let err = listening_ports(u32::MAX - 1, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(err.status, ProviderStatus::Unavailable);
    }
}
