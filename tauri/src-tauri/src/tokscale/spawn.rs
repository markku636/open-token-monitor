//! 執行 tokscale 並解析 JSON（上游 collector.js `spawnTokscaleJson` / `parseJsonOutput`）。

use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::locate::TokscaleBinary;
use crate::error::{AppError, AppResult};

const MAX_STDERR_BYTES: usize = 64 * 1024;

/// 空白的這幾個變數會讓 tokscale 解析出錯誤的根目錄（例如 `/opencode`），必須整個拿掉
///（上游 `tokscaleEnvWithBlanksDropped`）。Windows 的環境變數名稱不分大小寫。
const BLANK_SENSITIVE_ENV_KEYS: &[&str] =
    &["XDG_DATA_HOME", "XDG_CONFIG_HOME", "TOKSCALE_HEADLESS_DIR"];

#[derive(Debug, Clone, Default)]
pub struct SpawnOptions {
    pub timeout_ms: u64,
    /// 設定 `TOKSCALE_EXTRA_DIRS`（已含繼承的值）。
    pub extra_dirs: Option<String>,
}

fn blank_env_names() -> Vec<std::ffi::OsString> {
    let mut out = Vec::new();
    for (name, value) in std::env::vars_os() {
        let n = name.to_string_lossy();
        let matches = BLANK_SENSITIVE_ENV_KEYS.iter().any(|k| {
            if cfg!(windows) {
                n.eq_ignore_ascii_case(k)
            } else {
                n == *k
            }
        });
        if matches && value.to_string_lossy().trim().is_empty() {
            out.push(name);
        }
    }
    out
}

pub fn parse_json_output(stdout: &[u8]) -> AppResult<Value> {
    let text = String::from_utf8_lossy(stdout);
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::TokscaleOutput(
            "tokscale produced empty stdout".into(),
        ));
    }
    if let Ok(v) = serde_json::from_str(text) {
        return Ok(v);
    }
    // 有些版本會在 JSON 前印進度文字：從第一個 `{` 或 `[` 開始再試。
    let mut starts: Vec<usize> = [text.find('{'), text.find('[')]
        .into_iter()
        .flatten()
        .collect();
    starts.sort_unstable();
    for start in starts {
        if let Ok(v) = serde_json::from_str(&text[start..]) {
            return Ok(v);
        }
    }
    Err(AppError::TokscaleOutput(text.chars().take(300).collect()))
}

pub async fn run(
    bin: &TokscaleBinary,
    args: &[String],
    opts: &SpawnOptions,
    cancel: &CancellationToken,
) -> AppResult<Vec<u8>> {
    run_detailed(bin, args, opts, cancel).await.0
}

/// 被我們終止（逾時或停止）的子程序：清理它可能留下的鎖檔時需要（antigravity.rs）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Killed {
    pub pid: u32,
    pub started_at_ms: i64,
}

pub async fn run_detailed(
    bin: &TokscaleBinary,
    args: &[String],
    opts: &SpawnOptions,
    cancel: &CancellationToken,
) -> (AppResult<Vec<u8>>, Option<Killed>) {
    let started_at_ms = chrono::Utc::now().timestamp_millis();
    let mut cmd = Command::new(&bin.path);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：GUI 程序呼叫 console 程式時不要閃出黑色視窗（等同 Node 的 windowsHide）。
        cmd.creation_flags(0x0800_0000);
    }
    for name in blank_env_names() {
        cmd.env_remove(name);
    }
    if let Some(extra) = &opts.extra_dirs {
        cmd.env("TOKSCALE_EXTRA_DIRS", extra);
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return (
                Err(AppError::TokscaleSpawn(format!(
                    "{}: {e}",
                    bin.path.display()
                ))),
                None,
            )
        }
    };
    let killed = Killed {
        pid: child.id().unwrap_or(0),
        started_at_ms,
    };

    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    let out_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf).await;
        buf
    });
    // stderr 持續讀完（避免 pipe 滿了卡住子程序），但只保留前 64 KiB。
    let err_task = tokio::spawn(async move {
        let mut kept = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let room = MAX_STDERR_BYTES.saturating_sub(kept.len());
                    kept.extend_from_slice(&chunk[..n.min(room)]);
                }
            }
        }
        kept
    });

    let timeout = Duration::from_millis(opts.timeout_ms.max(1));
    let status = tokio::select! {
        status = child.wait() => match status {
            Ok(s) => s,
            Err(e) => return (Err(AppError::TokscaleSpawn(e.to_string())), None),
        },
        _ = tokio::time::sleep(timeout) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return (Err(AppError::TokscaleTimeout(opts.timeout_ms)), Some(killed));
        }
        _ = cancel.cancelled() => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return (Err(AppError::Stopped), Some(killed));
        }
    };
    let stdout = out_task.await.unwrap_or_default();
    let stderr = err_task.await.unwrap_or_default();
    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
        let stderr = if stderr.is_empty() {
            String::from_utf8_lossy(&stdout)
                .trim()
                .chars()
                .take(2000)
                .collect()
        } else {
            stderr
        };
        return (
            Err(AppError::TokscaleExit {
                code: status.code(),
                stderr,
            }),
            None,
        );
    }
    (Ok(stdout), None)
}

pub async fn run_json(
    bin: &TokscaleBinary,
    args: &[String],
    opts: &SpawnOptions,
    cancel: &CancellationToken,
) -> AppResult<Value> {
    let stdout = run(bin, args, opts, cancel).await?;
    parse_json_output(&stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn salvages_json_after_noise() {
        assert_eq!(parse_json_output(br#"  {"a":1} "#).unwrap()["a"], 1);
        assert_eq!(parse_json_output(b"loading...\n{\"a\":2}").unwrap()["a"], 2);
        assert!(parse_json_output(b"   ").is_err());
        assert!(parse_json_output(b"nope").is_err());
    }
}
