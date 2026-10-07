//! 額度的探測與保留（上游 src/shared/limits/{runtime,collector,retryPolicy,resetBoundary}.js 的精簡版）。
//!
//! - provider 依設定順序**逐一**探測，每個最多 125 秒（上游 120 秒 + 5 秒寬限）；逾時記成 `error`。
//! - 成功：這一列成為 last-good。
//! - 暫時性失敗（rateLimited / sourceRateLimited / unavailable / error）：有 last-good 就發佈它、
//!   只換狀態（沿用舊的 updatedAt 與窗口，員工看得到上次的數字），沒有就發佈沒有身分的狀態列。
//! - 終止性失敗（unauthorized / notConfigured / disabled）：清掉 last-good，只發佈狀態列。
//!
//! 什麼時候探測（`next_wake`，由 device/runtime.rs 的迴圈序列地執行）：
//! - **完整**（啟動、手動、每 `limitsRefreshMs`）：探測全部。有暫時性失敗時下一次完整探測改在退避之後
//!   （`min(300 秒, 5 秒 × 2^(n-1))` 的一半到全部，或 Retry-After），不會比間隔更晚。
//! - **重置點**：窗口的重置時間一過（`resetsAt` + 30 秒，最少等 5 秒）只探測那個 provider，員工不必等
//!   下一個間隔才看到額度歸零（上游 resetBoundary.js）；每個重置點只在觸發時記一次。
//! - **提早探測**（只在 `limitsRefreshMode = adaptive`）：基本間隔固定 5 分鐘，消耗快、快用完的額度
//!   依 burn_rate.rs 提早探測那個 provider，最快每分鐘。
//! - **重試**：重置點或提早探測遇到暫時性失敗，只重試那個 provider，不動完整探測的時間表。
//! - 重置點與提早探測**不繞過退避**（上游 `COOLDOWN_BYPASS_REASONS` 沒有 `reset-boundary` 與
//!   `burn-rate`）：provider 正在退避時略過，由它自己的重試補上。
//! - **本機用量絕不觸發額度探測**（上游 tripwire）：消耗速度只來自額度本身的觀測。
//!
//! v1 每個 provider 只追一個帳號（上游的多帳號 identity lane 不在範圍內）。

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use super::burn_rate::{provider_identity_key, BurnState};
use super::claude::{ClaudeEnv, ClaudeProvider};
use super::codex::{self, CodexEnv};
use super::http::ProbeError;
use crate::wire::{LimitProvider, LimitsSummary, ProviderStatus};

pub const PROBE_DEADLINE: Duration = Duration::from_secs(125);
const BACKOFF_BASE: Duration = Duration::from_secs(5);
const BACKOFF_CAP: Duration = Duration::from_secs(300);
/// 上游 `LIMITS_RESET_BOUNDARY_DELAY_MS` / `_MIN_TIMER_MS` / `_MAX_TIMER_MS`。
const RESET_BOUNDARY_DELAY_MS: i64 = 30_000;
const RESET_BOUNDARY_MIN_MS: i64 = 5_000;
const RESET_BOUNDARY_MAX_MS: i64 = 2_147_483_647;

/// 上游 `limitResetBoundaryEntries`：每個窗口的 (重置時間 ms, key, provider)。
fn reset_entries(summary: &LimitsSummary) -> Vec<(i64, String, String)> {
    let mut out = Vec::new();
    for p in &summary.providers {
        let provider_key = provider_identity_key(p);
        for w in &p.windows {
            let Some(at) = w
                .resets_at
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            else {
                continue;
            };
            let ms = at.timestamp_millis();
            out.push((
                ms,
                format!("{provider_key}:{}:{ms}", w.kind.as_str()),
                p.provider.trim().to_string(),
            ));
        }
    }
    out
}

/// 最早、還沒試過的重置點（上游 `nextLimitsResetBoundary` 的回傳）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetDue {
    /// 什麼時候探測（ms）：重置點 + 30 秒，但至少在 5 秒後。
    pub at_ms: i64,
    /// 同一時間到期的所有重置點；**觸發時**才記成已試過。
    pub keys: Vec<String>,
    pub providers: Vec<String>,
}

/// 上游 `nextLimitsResetBoundary`。只看不記：記在觸發的時候（`LimitsRuntime::begin`），
/// 比完整探測更晚的重置點才不會在排程時被吃掉。
pub fn next_reset_boundary(
    summary: &LimitsSummary,
    now_ms: i64,
    attempted: &HashSet<String>,
) -> Option<ResetDue> {
    let entries = reset_entries(summary);
    let refresh_at = entries
        .iter()
        .filter(|(_, k, _)| !attempted.contains(k))
        .map(|(ms, _, _)| ms + RESET_BOUNDARY_DELAY_MS)
        .min()?;
    let mut keys = Vec::new();
    let mut providers: Vec<String> = Vec::new();
    for (ms, key, provider) in entries {
        if ms + RESET_BOUNDARY_DELAY_MS != refresh_at || attempted.contains(&key) {
            continue;
        }
        keys.push(key);
        if !providers.contains(&provider) {
            providers.push(provider);
        }
    }
    let delay = (refresh_at - now_ms).clamp(RESET_BOUNDARY_MIN_MS, RESET_BOUNDARY_MAX_MS);
    Some(ResetDue {
        at_ms: now_ms + delay,
        keys,
        providers,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitsConfig {
    pub providers: Vec<String>,
    /// 實際的基本間隔：`adaptive` 時固定 5 分鐘（wire 的 `refreshMs` 也是這個），否則 `limitsRefreshMs`。
    pub refresh_ms: u64,
    /// `limitsRefreshMode = adaptive`：消耗快的額度提早探測。
    pub adaptive: bool,
}

impl LimitsConfig {
    /// 關閉或沒有選任何 provider 時為 `None`（上傳時 payload 仍帶空的 limits，hub 會清掉舊值）。
    pub fn from_settings(settings: &crate::settings::Settings) -> Option<LimitsConfig> {
        (settings.limits_enabled && !settings.limit_providers.is_empty()).then(|| LimitsConfig {
            providers: settings.limit_providers.clone(),
            refresh_ms: settings.effective_limits_refresh_ms(),
            adaptive: settings.limits_adaptive(),
        })
    }
}

/// 下一次醒來要做什麼（`LimitsRuntime::next_wake`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LimitsWake {
    /// 啟動、手動、定時或完整探測的退避重試：探測全部。
    Full,
    /// 窗口剛重置（上游 `reset-boundary`）。
    Reset {
        keys: Vec<String>,
        providers: Vec<String>,
    },
    /// 自適應的提早探測（上游 `burn-rate`）。
    Urgent {
        keys: Vec<String>,
        providers: Vec<String>,
    },
    /// 重置點或提早探測遇到暫時性失敗後的重試（上游 lane 的 retry timer）。
    Retry { providers: Vec<String> },
}

impl LimitsWake {
    fn reason(&self) -> &'static str {
        match self {
            LimitsWake::Full => "full",
            LimitsWake::Reset { .. } => "reset-boundary",
            LimitsWake::Urgent { .. } => "burn-rate",
            LimitsWake::Retry { .. } => "retry",
        }
    }
}

type ProbeResult = Result<LimitProvider, ProbeError>;

pub struct LimitsRuntime {
    config: LimitsConfig,
    http: reqwest::Client,
    claude: ClaudeProvider,
    last_good: HashMap<String, LimitProvider>,
    /// 每個 provider 最近發佈的那一列：只探測一部分時，其他 provider 沿用它重組摘要。
    rows: HashMap<String, LimitProvider>,
    summary: LimitsSummary,
    transient_streak: u32,
    attempted_resets: HashSet<String>,
    /// 下一次完整探測的時間（ms）；`None` = 還沒探測過，立刻。
    full_due_ms: Option<i64>,
    /// 正在退避的 provider → 重試時間（ms）。
    cooling_until: HashMap<String, i64>,
    burn: BurnState,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn iso_at(ms: i64) -> String {
    crate::wire::time::iso_millis(
        chrono::DateTime::from_timestamp_millis(ms).unwrap_or_else(chrono::Utc::now),
    )
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

fn transient_failure(result: &ProbeResult) -> Option<&ProbeError> {
    result.as_ref().err().filter(|e| e.status.is_transient())
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
            summary: LimitsSummary {
                refresh_ms: config.refresh_ms,
                ..LimitsSummary::default()
            },
            config,
            http,
            claude: ClaudeProvider::default(),
            last_good: HashMap::new(),
            rows: HashMap::new(),
            transient_streak: 0,
            attempted_resets: HashSet::new(),
            full_due_ms: None,
            cooling_until: HashMap::new(),
            burn: BurnState::default(),
        }
    }

    pub fn refresh_ms(&self) -> u64 {
        self.config.refresh_ms
    }

    /// 最近一次發佈的摘要。
    pub fn summary(&self) -> &LimitsSummary {
        &self.summary
    }

    async fn probe_one(&self, provider: &str) -> ProbeResult {
        let fut = async {
            match provider {
                "claude" => {
                    self.claude
                        .probe(&self.http, &ClaudeEnv::from_process())
                        .await
                }
                "codex" => codex::probe(&self.http, &CodexEnv::from_process()).await,
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

    async fn probe_many(&self, providers: &[String]) -> Vec<(String, ProbeResult)> {
        let mut out = Vec::new();
        for provider in providers {
            let result = self.probe_one(provider).await;
            if let Err(e) = &result {
                tracing::info!(provider = %provider, status = ?e.status, error = %e.message, "limits probe failed");
            }
            out.push((provider.clone(), result));
        }
        out
    }

    /// 依上游規則把一次探測的結果變成要發佈的那一列。
    pub fn apply(&mut self, provider: &str, result: ProbeResult) -> LimitProvider {
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
                None => LimitProvider::status_row(provider, e.status, iso_at(now_ms())),
            },
            Err(e) => {
                self.last_good.remove(provider);
                LimitProvider::status_row(provider, e.status, iso_at(now_ms()))
            }
        }
    }

    fn commit(&mut self, provider: &str, result: ProbeResult) {
        let probed_ok = result.is_ok();
        let row = self.apply(provider, result);
        // 只有這個 runtime 自己探測成功的列能成為消耗速度的基準（上游 markLimitsProbeSuccess）。
        if probed_ok && row.status == ProviderStatus::Ok {
            self.burn.mark_probe_success(&row);
        }
        self.rows.insert(provider.to_string(), row);
    }

    /// 上游 `rebuildSnapshot`：依設定順序重組摘要、修剪已不存在的重置點，並記下消耗速度的樣本。
    fn rebuild(&mut self, now: i64) -> LimitsSummary {
        let providers = self
            .config
            .providers
            .iter()
            .filter_map(|p| self.rows.get(p).cloned())
            .collect();
        let summary = LimitsSummary {
            updated_at: Some(iso_at(now)),
            refresh_ms: self.config.refresh_ms,
            providers,
        };
        let current: HashSet<String> = reset_entries(&summary)
            .into_iter()
            .map(|(_, key, _)| key)
            .collect();
        self.attempted_resets.retain(|k| current.contains(k));
        self.burn.record_sample(&summary, now);
        self.burn.prune(&summary);
        self.summary = summary.clone();
        summary
    }

    fn retry_wait(&mut self, results: &[(String, ProbeResult)]) -> Option<Duration> {
        let mut transient = false;
        let mut retry_after: Option<Duration> = None;
        for (_, result) in results {
            if let Some(e) = transient_failure(result) {
                transient = true;
                retry_after = retry_after.max(e.retry_after);
            }
        }
        if !transient {
            return None;
        }
        self.transient_streak += 1;
        let wait = retry_after
            .unwrap_or_else(|| backoff(self.transient_streak, uuid::Uuid::new_v4().as_u128()));
        Some(wait.min(Duration::from_millis(self.config.refresh_ms)))
    }

    /// 完整探測的結果：下一次完整探測排在間隔（或退避）之後，並重組摘要。
    fn commit_full(&mut self, results: Vec<(String, ProbeResult)>, now: i64) -> LimitsSummary {
        let wait = match self.retry_wait(&results) {
            Some(wait) => wait,
            None => {
                self.transient_streak = 0;
                Duration::from_millis(self.config.refresh_ms)
            }
        };
        let due = now + wait.as_millis() as i64;
        self.full_due_ms = Some(due);
        self.cooling_until.clear();
        for (provider, result) in results {
            if transient_failure(&result).is_some() {
                self.cooling_until.insert(provider.clone(), due);
            }
            self.commit(&provider, result);
        }
        self.rebuild(now)
    }

    /// 只探測一部分（重置點、提早探測、重試）的結果：完整探測的時間表不動，暫時性失敗只排那個 provider 的重試。
    fn commit_scoped(&mut self, results: Vec<(String, ProbeResult)>, now: i64) -> LimitsSummary {
        let retry_at = self
            .retry_wait(&results)
            .map(|wait| now + wait.as_millis() as i64);
        for (provider, result) in results {
            if let Some(at) = retry_at.filter(|_| transient_failure(&result).is_some()) {
                self.cooling_until.insert(provider.clone(), at);
            } else {
                self.cooling_until.remove(&provider);
            }
            self.commit(&provider, result);
        }
        self.rebuild(now)
    }

    fn cooling(&self, provider: &str, now: i64) -> bool {
        self.cooling_until
            .get(provider)
            .is_some_and(|&until| until > now)
    }

    /// 醒來時先記下這次嘗試，回傳要探測的 provider；`None` = 完整探測。
    fn begin(&mut self, wake: &LimitsWake, now: i64) -> Option<Vec<String>> {
        let configured = |p: &String| self.config.providers.contains(p);
        let targets: Vec<String> = match wake {
            LimitsWake::Full => return None,
            LimitsWake::Retry { providers } => providers
                .iter()
                .filter(|p| configured(p))
                .cloned()
                .collect(),
            LimitsWake::Reset { keys, providers } => {
                self.attempted_resets.extend(keys.iter().cloned());
                providers
                    .iter()
                    .filter(|p| configured(p))
                    .cloned()
                    .collect()
            }
            LimitsWake::Urgent { keys, providers } => {
                // 每個到期的 key 都記（被略過的也算），否則略過的那個會立刻再觸發（上游 recordLimitsUrgencyAttempt）。
                self.burn.record_attempt(keys, now);
                providers
                    .iter()
                    .filter(|p| configured(p))
                    .cloned()
                    .collect()
            }
        };
        let mut out: Vec<String> = Vec::new();
        for p in targets {
            // 重置點與提早探測不繞過退避：退避中的 provider 等它自己的重試。
            if !matches!(wake, LimitsWake::Retry { .. }) && self.cooling(&p, now) {
                tracing::debug!(provider = %p, reason = wake.reason(), "limits probe deferred while backing off");
                continue;
            }
            if !out.contains(&p) {
                out.push(p);
            }
        }
        Some(out)
    }

    /// 執行一次醒來；全部延後（退避中）時回 `None`，摘要不變。
    pub async fn run(&mut self, wake: LimitsWake) -> Option<LimitsSummary> {
        let targets = self.begin(&wake, now_ms());
        match targets {
            None => Some(self.probe_all().await),
            Some(targets) if targets.is_empty() => None,
            Some(targets) => {
                tracing::info!(reason = wake.reason(), providers = %targets.join(","), "limits: probing between intervals");
                let results = self.probe_many(&targets).await;
                Some(self.commit_scoped(results, now_ms()))
            }
        }
    }

    /// 探測全部一次（`tm-agent limits`、`once`，以及迴圈的完整探測）。
    pub async fn probe_all(&mut self) -> LimitsSummary {
        let providers = self.config.providers.clone();
        let results = self.probe_many(&providers).await;
        self.commit_full(results, now_ms())
    }

    /// 下一次醒來的時間（ms）與要做的事：完整探測、重試、重置點與（自適應時）提早探測中最早的那個。
    /// 同時到期時完整探測優先（它涵蓋全部）。
    pub fn next_wake(&self, now: i64) -> (i64, LimitsWake) {
        let mut at = self.full_due_ms.unwrap_or(now);
        let mut wake = LimitsWake::Full;
        let retry = self
            .config
            .providers
            .iter()
            .filter_map(|p| self.cooling_until.get(p).copied())
            .min();
        if let Some(until) = retry {
            if until < at {
                at = until;
                wake = LimitsWake::Retry {
                    providers: self
                        .config
                        .providers
                        .iter()
                        .filter(|p| self.cooling_until.get(*p) == Some(&until))
                        .cloned()
                        .collect(),
                };
            }
        }
        if let Some(reset) = next_reset_boundary(&self.summary, now, &self.attempted_resets) {
            if reset.at_ms < at {
                at = reset.at_ms;
                wake = LimitsWake::Reset {
                    keys: reset.keys,
                    providers: reset.providers,
                };
            }
        }
        if self.config.adaptive {
            if let Some(due) = self
                .burn
                .next_urgency(&self.summary, now, self.config.refresh_ms)
            {
                let due_at = (now as f64 + due.delay_ms).ceil() as i64;
                if due_at < at {
                    at = due_at;
                    wake = LimitsWake::Urgent {
                        keys: due.keys,
                        providers: due.providers,
                    };
                }
            }
        }
        (at, wake)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{LimitWindow, WindowKind};

    const MIN: i64 = 60_000;

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

    /// 已用 `used`% 的 Claude 列；`at` 讓每次探測的 updatedAt 不同。
    fn claude(used: f64, at: i64) -> ProbeResult {
        let mut row = good();
        row.windows[0].used_percent = Some(used);
        row.updated_at = Some(iso_at(at));
        Ok(row)
    }

    fn codex_ok(at: i64) -> ProbeResult {
        let mut row = LimitProvider::status_row("codex", ProviderStatus::Ok, iso_at(at));
        row.account_key = "codex-key".into();
        Ok(row)
    }

    fn rt(adaptive: bool) -> LimitsRuntime {
        LimitsRuntime::new(LimitsConfig {
            providers: vec!["claude".into(), "codex".into()],
            refresh_ms: 300_000,
            adaptive,
        })
    }

    fn rate_limited() -> ProbeResult {
        Err(ProbeError::new(ProviderStatus::RateLimited, "429"))
    }

    #[test]
    fn transient_failures_keep_the_last_good_numbers() {
        let mut rt = LimitsRuntime::new(LimitsConfig {
            providers: vec!["claude".into()],
            refresh_ms: 300_000,
            adaptive: false,
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
        let due = next_reset_boundary(&summary, reset_ms - 60_000, &attempted).unwrap();
        assert_eq!(due.at_ms, reset_ms + 30_000, "30 seconds after the reset");
        assert_eq!(due.providers, vec!["claude"]);
        assert_eq!(
            next_reset_boundary(&summary, reset_ms, &attempted).map(|d| d.at_ms),
            Some(reset_ms + 30_000),
            "looking does not consume it"
        );
        attempted.extend(due.keys);
        assert_eq!(
            next_reset_boundary(&summary, reset_ms, &attempted),
            None,
            "only once"
        );
        let fresh = HashSet::new();
        let now = reset_ms + 3_600_000;
        assert_eq!(
            next_reset_boundary(&summary, now, &fresh).map(|d| d.at_ms),
            Some(now + 5_000),
            "a past reset still waits at least 5 seconds"
        );
    }

    #[test]
    fn a_reset_after_the_next_interval_is_not_lost() {
        let mut rt = rt(false);
        let now = 1_000 * MIN;
        let mut row = good();
        row.windows[0].resets_at = Some(iso_at(now + 7 * MIN));
        rt.commit_full(
            vec![
                ("claude".into(), Ok(row.clone())),
                ("codex".into(), codex_ok(now)),
            ],
            now,
        );
        assert_eq!(rt.next_wake(now), (now + 5 * MIN, LimitsWake::Full));
        // 間隔到了先完整探測（窗口還沒重置），重置點仍在：之後準時補一次、只探測 Claude。
        let later = now + 5 * MIN;
        rt.commit_full(
            vec![
                ("claude".into(), Ok(row)),
                ("codex".into(), codex_ok(later)),
            ],
            later,
        );
        let (at, wake) = rt.next_wake(later);
        assert_eq!(at, now + 7 * MIN + 30_000);
        assert!(matches!(&wake, LimitsWake::Reset { providers, .. } if providers == &["claude"]));
        assert_eq!(rt.begin(&wake, at), Some(vec!["claude".to_string()]));
        assert_eq!(
            rt.next_wake(at).1,
            LimitsWake::Full,
            "each boundary fires once"
        );
    }

    /// 兩次完整探測之間 Claude 從 80% 用到 95%（5 分鐘 15%）。
    fn burning(adaptive: bool) -> (LimitsRuntime, i64) {
        let mut rt = rt(adaptive);
        let t0 = 1_000 * MIN;
        rt.commit_full(
            vec![
                ("claude".into(), claude(80.0, t0)),
                ("codex".into(), codex_ok(t0)),
            ],
            t0,
        );
        let t1 = t0 + 5 * MIN;
        rt.commit_full(
            vec![
                ("claude".into(), claude(95.0, t1)),
                ("codex".into(), codex_ok(t1)),
            ],
            t1,
        );
        (rt, t1)
    }

    #[test]
    fn fixed_mode_never_probes_early() {
        let (rt, now) = burning(false);
        assert_eq!(rt.next_wake(now), (now + 5 * MIN, LimitsWake::Full));
    }

    #[test]
    fn adaptive_mode_probes_a_burning_quota_early_and_only_that_provider() {
        let (mut rt, now) = burning(true);
        let (at, wake) = rt.next_wake(now);
        // 剩 5%，照這個速度 100 秒用完；四分之一是 25 秒，但最快每分鐘。
        assert_eq!(at, now + MIN);
        let LimitsWake::Urgent { keys, providers } = &wake else {
            panic!("expected an urgency probe, got {wake:?}");
        };
        assert_eq!(providers, &["claude"]);
        assert_eq!(keys, &["claude:sha256:abc::"]);
        assert_eq!(rt.begin(&wake, at), Some(vec!["claude".to_string()]));
        let summary = rt.commit_scoped(vec![("claude".into(), claude(97.0, at))], at);
        assert_eq!(summary.refresh_ms, 300_000);
        assert_eq!(summary.providers.len(), 2, "codex keeps its row");
        assert_eq!(
            rt.full_due_ms,
            Some(now + 5 * MIN),
            "the regular interval is untouched"
        );
        let (next, wake) = rt.next_wake(at);
        assert!(matches!(wake, LimitsWake::Urgent { .. }));
        assert_eq!(next, at + MIN, "never faster than the floor");
    }

    #[test]
    fn a_burn_rate_probe_never_bypasses_backoff() {
        let (mut rt, now) = burning(true);
        let (at, wake) = rt.next_wake(now);
        assert!(matches!(wake, LimitsWake::Urgent { .. }));
        // 提早探測遇到 429：只排 Claude 的重試，完整探測的時間不動。
        rt.begin(&wake, at);
        rt.commit_scoped(vec![("claude".into(), rate_limited())], at);
        assert_eq!(rt.full_due_ms, Some(now + 5 * MIN));
        let retry_at = rt.cooling_until["claude"];
        assert!(
            (at + 2_500..=at + 5_000).contains(&retry_at),
            "{}",
            retry_at - at
        );
        let (next, wake) = rt.next_wake(at);
        assert_eq!(
            (next, &wake),
            (
                retry_at,
                &LimitsWake::Retry {
                    providers: vec!["claude".into()]
                }
            )
        );
        // 退避中到期的提早探測只記下嘗試，不探測。
        let urgent = LimitsWake::Urgent {
            keys: vec!["claude:sha256:abc::".into()],
            providers: vec!["claude".into()],
        };
        assert_eq!(rt.begin(&urgent, at + 1), Some(Vec::new()));
        // 重試本身不被擋。
        assert_eq!(rt.begin(&wake, retry_at), Some(vec!["claude".to_string()]));
        rt.commit_scoped(vec![("claude".into(), claude(96.0, retry_at))], retry_at);
        assert!(rt.cooling_until.is_empty());
    }

    #[test]
    fn a_full_round_with_a_transient_failure_backs_off_everything() {
        let mut rt = rt(true);
        let now = 1_000 * MIN;
        rt.commit_full(
            vec![
                ("claude".into(), rate_limited()),
                ("codex".into(), codex_ok(now)),
            ],
            now,
        );
        let due = rt.full_due_ms.unwrap();
        assert!((now + 2_500..=now + 5_000).contains(&due));
        assert_eq!(
            rt.next_wake(now),
            (due, LimitsWake::Full),
            "a full retry covers the cooling provider"
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
