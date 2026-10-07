//! 額度的探測與保留（上游 src/shared/limits/{runtime,collector,retryPolicy}.js 的精簡版）。
//!
//! - provider 依設定順序**逐一**探測，每個最多 125 秒（上游 120 秒 + 5 秒寬限）；逾時記成 `error`。
//! - 成功：這一列成為 last-good。
//! - 暫時性失敗（rateLimited / sourceRateLimited / unavailable / error）：有 last-good 就發佈它、
//!   只換狀態（沿用舊的 updatedAt 與窗口，員工看得到上次的數字），沒有就發佈沒有身分的狀態列。
//! - 終止性失敗（unauthorized / notConfigured / disabled）：清掉 last-good，只發佈狀態列。
//! - 下一次探測：全部成功或終止性失敗 → `limitsRefreshMs`；有暫時性失敗 → 退避
//!   `min(300 秒, 5 秒 × 2^(n-1))` 的一半到全部（或 hub 的 Retry-After），不會比 refreshMs 更晚。
//! - 窗口的重置時間一過（`resetsAt` + 30 秒）就提早再查一次，員工不必等下一個間隔才看到額度歸零
//!   （上游 resetBoundary.js）；每個重置點只觸發一次，最少等 5 秒。
//! - **本機用量絕不觸發額度探測**（上游 tripwire）：只有定時、啟動、重置點與手動。
//!
//! v1 每個 provider 只追一個帳號（上游的多帳號 identity lane 不在範圍內）。

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use super::claude::{ClaudeEnv, ClaudeProvider};
use super::codex::{self, CodexEnv};
use super::http::ProbeError;
use super::opencode::OpencodeOptions;
use crate::wire::{LimitProvider, LimitsSummary, ProviderStatus};

pub const PROBE_DEADLINE: Duration = Duration::from_secs(125);
const BACKOFF_BASE: Duration = Duration::from_secs(5);
const BACKOFF_CAP: Duration = Duration::from_secs(300);
/// 上游 `LIMITS_RESET_BOUNDARY_DELAY_MS` / `LIMITS_RESET_BOUNDARY_MIN_TIMER_MS`。
const RESET_BOUNDARY_DELAY_MS: i64 = 30_000;
const RESET_BOUNDARY_MIN: Duration = Duration::from_secs(5);

/// 上游 `limitResetBoundaryEntries`：每個窗口的 (重置時間 ms, key)。
fn reset_entries(summary: &LimitsSummary) -> Vec<(i64, String)> {
    let mut out = Vec::new();
    for p in &summary.providers {
        let provider_key = [
            p.provider.as_str(),
            p.account_key.as_str(),
            p.account_email.as_str(),
            p.account_label.as_str(),
        ]
        .map(str::trim)
        .join(":");
        for w in &p.windows {
            let Some(at) = w
                .resets_at
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            else {
                continue;
            };
            let ms = at.timestamp_millis();
            let kind = serde_json::to_value(w.kind)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default();
            out.push((ms, format!("{provider_key}:{kind}:{ms}")));
        }
    }
    out
}

/// 上游 `nextLimitsResetBoundary` + `pruneAttemptedResetBoundaries`：最早、還沒試過的重置點要等多久，
/// 並把它記成已試過（同一時間的都算）。沒有就回 `None`。
pub fn next_reset_boundary(
    summary: &LimitsSummary,
    now_ms: i64,
    attempted: &mut HashSet<String>,
) -> Option<Duration> {
    let entries = reset_entries(summary);
    attempted.retain(|k| entries.iter().any(|(_, key)| key == k));
    let refresh_at = entries
        .iter()
        .filter(|(_, k)| !attempted.contains(k))
        .map(|(ms, _)| ms + RESET_BOUNDARY_DELAY_MS)
        .min()?;
    for (ms, key) in &entries {
        if ms + RESET_BOUNDARY_DELAY_MS == refresh_at {
            attempted.insert(key.clone());
        }
    }
    let delay = Duration::from_millis((refresh_at - now_ms).max(0) as u64);
    Some(delay.max(RESET_BOUNDARY_MIN))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitsConfig {
    pub providers: Vec<String>,
    pub refresh_ms: u64,
    /// OpenCode 的開關（自動偵測的 key、本機估算）；憑證本身不在這裡，探測時才從認證管理員讀。
    pub opencode: OpencodeOptions,
}

impl LimitsConfig {
    /// 關閉或沒有選任何 provider 時為 `None`（上傳時 payload 仍帶空的 limits，hub 會清掉舊值）。
    pub fn from_settings(settings: &crate::settings::Settings) -> Option<LimitsConfig> {
        (settings.limits_enabled && !settings.limit_providers.is_empty()).then(|| LimitsConfig {
            providers: settings.limit_providers.clone(),
            refresh_ms: settings.limits_refresh_ms,
            opencode: OpencodeOptions::from_settings(settings),
        })
    }
}

pub struct LimitsRuntime {
    config: LimitsConfig,
    http: reqwest::Client,
    claude: ClaudeProvider,
    last_good: HashMap<String, LimitProvider>,
    transient_streak: u32,
    attempted_resets: HashSet<String>,
}

fn now_iso() -> String {
    crate::wire::time::iso_millis(chrono::Utc::now())
}

/// 上游 retryPolicy：`cap = min(300 秒, 5 秒 × 2^(n-1))`，延遲在 cap/2 到 cap 之間。
pub fn backoff(attempt: u32, seed: u128) -> Duration {
    let exp = attempt.saturating_sub(1).min(16);
    let cap = BACKOFF_BASE
        .saturating_mul(1u32 << exp)
        .min(BACKOFF_CAP)
        .as_millis() as u64;
    let half = cap / 2;
    Duration::from_millis(half + (seed % (half as u128 + 1)) as u64)
}

impl LimitsRuntime {
    pub fn new(config: LimitsConfig) -> LimitsRuntime {
        let http = reqwest::Client::builder()
            .user_agent(format!(
                "token-monitor-tauri/{}",
                crate::baked::AGENT_VERSION
            ))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        LimitsRuntime {
            config,
            http,
            claude: ClaudeProvider::default(),
            last_good: HashMap::new(),
            transient_streak: 0,
            attempted_resets: HashSet::new(),
        }
    }

    pub fn refresh_ms(&self) -> u64 {
        self.config.refresh_ms
    }

    async fn probe_one(&self, provider: &str) -> Result<LimitProvider, ProbeError> {
        let fut = async {
            match provider {
                "claude" => {
                    self.claude
                        .probe(&self.http, &ClaudeEnv::from_process())
                        .await
                }
                "codex" => codex::probe(&self.http, &CodexEnv::from_process()).await,
                "opencode" => super::opencode::probe(&self.http, &self.config.opencode).await,
                "copilot" => super::copilot::probe(&self.http).await,
                "cursor" => match dirs::home_dir() {
                    Some(home) => super::cursor::probe(&self.http, &home).await,
                    None => Err(ProbeError::new(
                        ProviderStatus::NotConfigured,
                        "no home directory",
                    )),
                },
                other => Err(ProbeError::new(
                    ProviderStatus::Disabled,
                    format!("unsupported limits provider {other}"),
                )),
            }
        };
        match tokio::time::timeout(PROBE_DEADLINE, fut).await {
            Ok(r) => r,
            Err(_) => Err(ProbeError::new(
                ProviderStatus::Error,
                format!("{provider} probe timed out"),
            )),
        }
    }

    /// 依上游規則把一次探測的結果變成要發佈的那一列。
    pub fn apply(
        &mut self,
        provider: &str,
        result: Result<LimitProvider, ProbeError>,
    ) -> LimitProvider {
        match result {
            Ok(row) => {
                self.last_good.insert(provider.to_string(), row.clone());
                row
            }
            Err(e) if e.status.is_transient() => match self.last_good.get(provider) {
                Some(good) => LimitProvider {
                    status: e.status,
                    ..good.clone()
                },
                None => LimitProvider::status_row(provider, e.status, now_iso()),
            },
            Err(e) => {
                self.last_good.remove(provider);
                LimitProvider::status_row(provider, e.status, now_iso())
            }
        }
    }

    /// 探測所有 provider，回傳要發佈的摘要與下一次探測前要等多久。
    pub async fn probe_all(&mut self) -> (LimitsSummary, Duration) {
        let mut rows = Vec::new();
        let mut transient = false;
        let mut retry_after: Option<Duration> = None;
        for provider in self.config.providers.clone() {
            let result = self.probe_one(&provider).await;
            if let Err(e) = &result {
                tracing::info!(provider = %provider, status = ?e.status, error = %e.message, "limits probe failed");
                if e.status.is_transient() {
                    transient = true;
                    retry_after = retry_after.max(e.retry_after);
                }
            }
            rows.push(self.apply(&provider, result));
        }
        let interval = Duration::from_millis(self.config.refresh_ms);
        let next = if transient {
            self.transient_streak += 1;
            let wait = retry_after
                .unwrap_or_else(|| backoff(self.transient_streak, uuid::Uuid::new_v4().as_u128()));
            wait.min(interval)
        } else {
            self.transient_streak = 0;
            interval
        };
        let summary = LimitsSummary {
            updated_at: Some(now_iso()),
            refresh_ms: self.config.refresh_ms,
            providers: rows,
        };
        let now_ms = chrono::Utc::now().timestamp_millis();
        let next = match next_reset_boundary(&summary, now_ms, &mut self.attempted_resets) {
            Some(boundary) if boundary < next => {
                tracing::info!(
                    secs = boundary.as_secs(),
                    "limits: re-probing just after a window resets"
                );
                boundary
            }
            _ => next,
        };
        (summary, next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{LimitWindow, WindowKind};

    fn good() -> LimitProvider {
        LimitProvider {
            account_key: "sha256:abc".into(),
            source: "oauth".into(),
            windows: vec![LimitWindow::new(WindowKind::Session)],
            ..LimitProvider::status_row(
                "claude",
                ProviderStatus::Ok,
                "2026-09-24T00:00:00.000Z".into(),
            )
        }
    }

    #[test]
    fn transient_failures_keep_the_last_good_numbers() {
        let mut rt = LimitsRuntime::new(LimitsConfig {
            providers: vec!["claude".into()],
            refresh_ms: 300_000,
            opencode: OpencodeOptions::default(),
        });
        assert_eq!(rt.apply("claude", Ok(good())).status, ProviderStatus::Ok);
        let row = rt.apply(
            "claude",
            Err(ProbeError::new(ProviderStatus::SourceRateLimited, "429")),
        );
        assert_eq!(row.status, ProviderStatus::SourceRateLimited);
        assert_eq!(row.windows.len(), 1, "last-good windows survive");
        assert_eq!(
            row.updated_at.as_deref(),
            Some("2026-09-24T00:00:00.000Z"),
            "and so does their timestamp"
        );
        assert_eq!(row.account_key, "sha256:abc");

        let row = rt.apply(
            "claude",
            Err(ProbeError::new(ProviderStatus::Unauthorized, "401")),
        );
        assert_eq!(row.status, ProviderStatus::Unauthorized);
        assert!(
            row.windows.is_empty() && row.account_key.is_empty(),
            "terminal failures clear"
        );
        let row = rt.apply(
            "claude",
            Err(ProbeError::new(ProviderStatus::Unavailable, "503")),
        );
        assert!(
            row.windows.is_empty(),
            "nothing to fall back on after a terminal failure"
        );
    }

    #[test]
    fn a_reset_boundary_fires_once() {
        let mut p = good();
        p.windows[0].resets_at = Some("2026-09-24T10:00:00.000Z".into());
        let summary = LimitsSummary {
            providers: vec![p],
            ..LimitsSummary::default()
        };
        let reset_ms = chrono::DateTime::parse_from_rfc3339("2026-09-24T10:00:00.000Z")
            .unwrap()
            .timestamp_millis();
        let mut attempted = HashSet::new();
        assert_eq!(
            next_reset_boundary(&summary, reset_ms - 60_000, &mut attempted),
            Some(Duration::from_secs(90)),
            "30 seconds after the reset"
        );
        assert_eq!(
            next_reset_boundary(&summary, reset_ms, &mut attempted),
            None,
            "only once"
        );
        let mut fresh = HashSet::new();
        assert_eq!(
            next_reset_boundary(&summary, reset_ms + 3_600_000, &mut fresh),
            Some(Duration::from_secs(5)),
            "a past reset still waits at least 5 seconds"
        );
    }

    #[test]
    fn backoff_doubles_up_to_five_minutes() {
        for (attempt, lo, hi) in [
            (1, 2_500, 5_000),
            (2, 5_000, 10_000),
            (4, 20_000, 40_000),
            (10, 150_000, 300_000),
        ] {
            for seed in [0u128, 1, 12_345, u128::MAX] {
                let d = backoff(attempt, seed).as_millis() as u64;
                assert!((lo..=hi).contains(&d), "attempt {attempt}: {d}");
            }
        }
    }
}
