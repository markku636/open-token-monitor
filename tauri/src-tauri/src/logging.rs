//! tracing 初始化。GUI 與 tm-agent 共用。
//!
//! - CLI：寫 stderr（`--dry-run --json` 的 stdout 只能有 JSON）。
//! - GUI：每日輪替的檔案 `<log_dir>/token-monitor.log.YYYY-MM-DD`，debug build 另寫 stderr。
//!
//! 層級由 `TM_LOG` 控制（預設 `info`），語法同 `RUST_LOG`。

use tracing_subscriber::{fmt, prelude::*, EnvFilter};

fn filter(default: &str) -> EnvFilter {
    EnvFilter::try_from_env("TM_LOG").unwrap_or_else(|_| EnvFilter::new(default))
}

pub fn init_cli(verbose: bool) {
    use std::io::IsTerminal;
    let default = if verbose {
        "token_monitor_lib=debug,tm_agent=debug,info"
    } else {
        "info"
    };
    // 輸出被導到檔案或排程器時不要 ANSI 顏色碼。
    let ansi = std::io::stderr().is_terminal();
    let _ = tracing_subscriber::registry()
        .with(filter(default))
        .with(
            fmt::layer()
                .with_writer(std::io::stderr)
                .with_target(false)
                .with_ansi(ansi),
        )
        .try_init();
}

/// 回傳的 guard 必須活到程式結束，否則最後幾行 log 不會寫到檔案。
pub fn init_file(log_dir: &std::path::Path) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    if std::fs::create_dir_all(log_dir).is_err() {
        init_cli(false);
        return None;
    }
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("token-monitor")
        .filename_suffix("log")
        .max_log_files(14)
        .build(log_dir);
    let Ok(appender) = appender else {
        init_cli(false);
        return None;
    };
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let registry = tracing_subscriber::registry()
        .with(filter("info"))
        .with(fmt::layer().with_writer(writer).with_ansi(false));
    if cfg!(debug_assertions) {
        let _ = registry
            .with(fmt::layer().with_writer(std::io::stderr))
            .try_init();
    } else {
        let _ = registry.try_init();
    }
    Some(guard)
}
