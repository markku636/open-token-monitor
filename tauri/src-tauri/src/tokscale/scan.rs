//! 一次 tokscale 用量掃描（上游 collector.js `runTokscale`）。
//!
//! `tokscale --json --client <csv> --group-by client,workspace,session,model <--today|--month|--since D>`
//!
//! 兩個自動退路，都以 binary 為單位記住，避免每個 tick 重付探測成本：
//! - `invalid group-by value`：非 fork 版的 tokscale 不支援 workspace 分組 → 改用 `client,session,model`。
//! - `invalid value 'x' for '--client'`：這個 binary 不認得某個 client → 拿掉它再掃。

use std::collections::HashSet;
use std::sync::Mutex;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::locate::TokscaleBinary;
use super::spawn::{run_json, SpawnOptions};
use crate::error::{AppError, AppResult};
use crate::usage::client_name::tokscale_scan_ids;

pub const WORKSPACE_GROUP_BY: &str = "client,workspace,session,model";
pub const SESSION_GROUP_BY: &str = "client,session,model";
/// 上游 collector.js `HISTORY_TIMEOUT_MS`：graph 掃全部歷史，與用量掃描的逾時分開。
pub const GRAPH_TIMEOUT_MS: u64 = 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanPeriod {
    Today,
    Month,
    Since(String),
}

impl ScanPeriod {
    pub fn flags(&self) -> Vec<String> {
        match self {
            ScanPeriod::Today => vec!["--today".into()],
            ScanPeriod::Month => vec!["--month".into()],
            ScanPeriod::Since(d) => vec!["--since".into(), d.clone()],
        }
    }

    pub fn file_stem(&self) -> &'static str {
        match self {
            ScanPeriod::Today => "today",
            ScanPeriod::Month => "month",
            ScanPeriod::Since(_) => "alltime",
        }
    }
}

/// Token Monitor client id → tokscale `--client` 值（展開傘狀 id、去重、保序）。
pub fn client_filter(clients: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for c in clients {
        for id in tokscale_scan_ids(c.trim()) {
            if !id.is_empty() && seen.insert(id.to_string()) {
                out.push(id.to_string());
            }
        }
    }
    out
}

/// `invalid value 'bogus' for '--client <CLIENTS>'` → `bogus`
fn unknown_client_from_stderr(stderr: &str) -> Option<String> {
    let lower = stderr.to_lowercase();
    if !lower.contains("--client") {
        return None;
    }
    let start = lower.find("invalid value '")? + "invalid value '".len();
    let rest = &stderr[start..];
    let end = rest.find('\'')?;
    Some(rest[..end].to_string())
}

fn is_invalid_group_by(stderr: &str) -> bool {
    stderr.to_lowercase().contains("invalid group-by value")
}

#[derive(Debug)]
pub struct Scanner {
    pub bin: TokscaleBinary,
    pub timeout_ms: u64,
    pub extra_dirs: Option<String>,
    workspace_unsupported: Mutex<bool>,
    unsupported_clients: Mutex<HashSet<String>>,
}

impl Scanner {
    pub fn new(bin: TokscaleBinary, timeout_ms: u64, extra_dirs: Option<String>) -> Self {
        Scanner {
            bin,
            timeout_ms,
            extra_dirs,
            workspace_unsupported: Mutex::new(false),
            unsupported_clients: Mutex::new(HashSet::new()),
        }
    }

    fn opts(&self) -> SpawnOptions {
        SpawnOptions {
            timeout_ms: self.timeout_ms,
            extra_dirs: self.extra_dirs.clone(),
        }
    }

    pub async fn scan(
        &self,
        clients: &[String],
        period: &ScanPeriod,
        workspaces: bool,
        cancel: &CancellationToken,
    ) -> AppResult<Value> {
        self.scan_home(clients, period, workspaces, None, cancel)
            .await
    }

    /// `home` = 以 `--home <路徑>` 讀另一個家目錄（WSL 的 `\\wsl$\<distro>\home\<user>`，
    /// 上游 wslUsage.js）。tokscale 4.6 起明確給 `--home` 的掃描不會混進主機的根目錄。
    pub async fn scan_home(
        &self,
        clients: &[String],
        period: &ScanPeriod,
        workspaces: bool,
        home: Option<&str>,
        cancel: &CancellationToken,
    ) -> AppResult<Value> {
        let mut filter = self.filter_for(clients);
        // 每個被拒絕的 client 最多重試一次，保證會結束。
        for _ in 0..=filter.len() {
            if filter.is_empty() {
                return Ok(json!({ "entries": [] }));
            }
            let group_by = if workspaces && !*self.workspace_unsupported.lock().unwrap() {
                WORKSPACE_GROUP_BY
            } else {
                SESSION_GROUP_BY
            };
            let mut args = vec![
                "--json".to_string(),
                "--client".into(),
                filter.join(","),
                "--group-by".into(),
                group_by.into(),
            ];
            args.extend(period.flags());
            if let Some(home) = home {
                args.push("--home".into());
                args.push(home.to_string());
            }
            match run_json(&self.bin, &args, &self.opts(), cancel).await {
                Ok(v) => return Ok(v),
                Err(AppError::TokscaleExit { stderr, .. })
                    if group_by == WORKSPACE_GROUP_BY && is_invalid_group_by(&stderr) =>
                {
                    tracing::info!("tokscale does not support workspace grouping; falling back to {SESSION_GROUP_BY}");
                    *self.workspace_unsupported.lock().unwrap() = true;
                }
                Err(AppError::TokscaleExit {
                    code: Some(2),
                    stderr,
                }) => self.drop_rejected_client(&mut filter, stderr)?,
                Err(e) => return Err(e),
            }
        }
        Err(AppError::Internal(
            "tokscale scan retry limit reached".into(),
        ))
    }

    fn filter_for(&self, clients: &[String]) -> Vec<String> {
        let unsupported = self.unsupported_clients.lock().unwrap().clone();
        client_filter(clients)
            .into_iter()
            .filter(|c| !unsupported.contains(c))
            .collect()
    }

    /// `invalid value 'x' for '--client'`：記住這個 binary 不認得 x，拿掉它再試；其他錯誤原樣回傳。
    fn drop_rejected_client(&self, filter: &mut Vec<String>, stderr: String) -> AppResult<()> {
        let rejected = || AppError::TokscaleExit {
            code: Some(2),
            stderr: stderr.clone(),
        };
        let Some(bad) = unknown_client_from_stderr(&stderr) else {
            return Err(rejected());
        };
        if !filter.contains(&bad) {
            return Err(rejected());
        }
        tracing::warn!(client = %bad, "tokscale rejected client id; scanning without it");
        self.unsupported_clients.lock().unwrap().insert(bad.clone());
        filter.retain(|c| c != &bad);
        Ok(())
    }

    /// `tokscale graph --client <csv> --no-spinner`（上游 collector.js `runTokscaleGraph`）：
    /// 每天 × client × model 的用量，給 history 用。輸出就是 JSON，不帶 `--json`。
    pub async fn graph(&self, clients: &[String], cancel: &CancellationToken) -> AppResult<Value> {
        let mut filter = self.filter_for(clients);
        let opts = SpawnOptions {
            timeout_ms: GRAPH_TIMEOUT_MS,
            extra_dirs: self.extra_dirs.clone(),
        };
        for _ in 0..=filter.len() {
            if filter.is_empty() {
                return Ok(json!({ "contributions": [] }));
            }
            let args = vec![
                "graph".to_string(),
                "--client".into(),
                filter.join(","),
                "--no-spinner".into(),
            ];
            match run_json(&self.bin, &args, &opts, cancel).await {
                Ok(v) => return Ok(v),
                Err(AppError::TokscaleExit {
                    code: Some(2),
                    stderr,
                }) => self.drop_rejected_client(&mut filter, stderr)?,
                Err(e) => return Err(e),
            }
        }
        Err(AppError::Internal(
            "tokscale graph retry limit reached".into(),
        ))
    }

    pub async fn version(&self, cancel: &CancellationToken) -> AppResult<String> {
        let opts = SpawnOptions {
            timeout_ms: 10_000,
            extra_dirs: None,
        };
        let out = super::spawn::run(&self.bin, &["--version".to_string()], &opts, cancel).await?;
        Ok(String::from_utf8_lossy(&out).trim().to_string())
    }
}

/// `TOKSCALE_EXTRA_DIRS`：`<scanId>:<dir>` 以逗號串接，接在繼承值之後（customScanPaths.js）。
pub fn extra_dirs_env(
    custom: &indexmap::IndexMap<String, Vec<String>>,
    inherited: Option<&str>,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(inh) = inherited.map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(inh.to_string());
    }
    for (client, dirs) in custom {
        // Pi / Kilo 的自訂根目錄只給其中一個 scan id，否則同一批檔案會被解析兩次（tokscaleClientMapping.js）。
        let ids: Vec<&str> = match client.as_str() {
            "pi" => vec!["pi"],
            "kilo" => vec!["kilocode"],
            other => tokscale_scan_ids(other),
        };
        for dir in dirs {
            for id in &ids {
                parts.push(format!("{id}:{dir}"));
            }
        }
    }
    (!parts.is_empty()).then(|| parts.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_umbrella_ids() {
        let f = client_filter(&[
            "claude".into(),
            "mimo".into(),
            "devin".into(),
            "claude".into(),
        ]);
        assert_eq!(
            f,
            vec![
                "claude",
                "micode",
                "micode-desktop",
                "devin-cli",
                "devin-desktop"
            ]
        );
        assert!(!client_filter(
            &crate::settings::SUPPORTED_CLIENTS
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        )
        .contains(&"synthetic".to_string()));
    }

    #[test]
    fn parses_tokscale_errors() {
        let e = "error: invalid value 'bogusclient' for '--client <CLIENTS>'\n  [possible values: opencode]";
        assert_eq!(
            unknown_client_from_stderr(e).as_deref(),
            Some("bogusclient")
        );
        assert!(is_invalid_group_by(
            "Error: Invalid group-by value: 'client,nope'. Valid options: model"
        ));
        assert_eq!(
            unknown_client_from_stderr("error: invalid value 'x' for '--since'"),
            None
        );
    }

    #[test]
    fn extra_dirs() {
        let mut m = indexmap::IndexMap::new();
        m.insert("claude".to_string(), vec!["D:\\alt\\claude".to_string()]);
        m.insert("pi".to_string(), vec!["D:\\pi".to_string()]);
        assert_eq!(
            extra_dirs_env(&m, Some("codex:/x")).as_deref(),
            Some("codex:/x,claude:D:\\alt\\claude,pi:D:\\pi")
        );
        assert_eq!(extra_dirs_env(&indexmap::IndexMap::new(), None), None);
    }
}
