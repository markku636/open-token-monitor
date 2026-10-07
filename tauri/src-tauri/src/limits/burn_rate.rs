//! 自適應（`limitsRefreshMode = adaptive`）額度探測的消耗速度估計（上游 src/shared/limits/burnRate.js
//! 的逐條移植）。
//!
//! 輪詢看到的剩餘比例是**上界**：上次探測之後用掉的看不到，而且誤差隨消耗速度變大。剩 90% 時無所謂，
//! 剩 10% 時剛好錯在危險的方向。所以間隔由「還能撐多久」決定，而不是「剩不到 N%」的門檻：
//! 門檻兩頭都錯——閒置但偏低的額度整晚狂查，從寬裕水位被快速消耗的額度又查得太慢。
//!
//! ```text
//! ttl   = 剩餘% / 消耗速度
//! delay = ttl / LIMITS_URGENCY_SAMPLES_AHEAD
//! ```
//!
//! 這是**控制目標，不是保證**：只要速度維持，下一次探測前大約用掉剩餘量的 1/4。速度是兩個樣本之間量的，
//! 下一段間隔裡突然加速看不到，不要把它寫成任何人能依賴的上界。
//!
//! - 閒置的額度速度為 0，直接回到固定的 5 分鐘；排程只會**縮短**基本間隔，不會拉長。
//! - 樣本只來自這個 runtime 自己成功探測的列（`live`）：暫時性失敗重發的 last-good、還沒探測過的列都不是量測。
//! - 速度變快立刻採用，變慢只以 0.3 的權重衰減：剩 8% 時停下來讀程式碼，不該剛好讓間隔放寬到下一波消耗落在看不到的時候。
//! - 跨過重置（`resetsAt` 變了，或已用比例變小）不是消耗：重新取基準、沿用舊的速度。
//! - 金額型窗口（`metric = credits`）的剩餘比例是畫面推出來的、不在 wire 上，沒有可量的東西。
//! - **只看額度觀測，絕不看本機用量**：工具的 token 可能記在第三方 key 上而不是訂閱，額度也可能被別台
//!   裝置或網頁版用掉，兩個方向的相關性都不成立。
//!
//! 上游的 `inFlight`（urgency 探測還沒結束就不再排）不需要：device/runtime.rs 的額度迴圈是序列的，
//! 探測結束後才重新計算下一次。

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;

use crate::wire::{LimitProvider, LimitWindow, LimitsSummary, ProviderStatus};

/// 自適應的基本間隔：它是自己的排程策略，不是固定間隔的修飾（1/2/5/15/30 分鐘的選項維持原意）。
pub const LIMITS_ADAPTIVE_BASE_MS: u64 = 5 * 60_000;
/// 提早探測的下限：同一個額度最快每分鐘一次。
pub const LIMITS_URGENCY_FLOOR_MS: f64 = 60_000.0;
pub const LIMITS_URGENCY_SAMPLES_AHEAD: f64 = 4.0;
/// 速度變慢時新樣本的權重（變快不經過它）。
pub const LIMITS_URGENCY_RELEASE_WEIGHT: f64 = 0.3;

/// 上游 `providerIdentityKey`：與 runtime.rs 的重置點 key 同一種寫法（名稱改了會重新累積，兩個樣本後自癒）。
pub fn provider_identity_key(p: &LimitProvider) -> String {
    [
        p.provider.as_str(),
        p.account_key.as_str(),
        p.account_email.as_str(),
        p.account_label.as_str(),
    ]
    .map(str::trim)
    .join(":")
}

/// 上游 `windowKey`：與 OpenCode 窗口合併同一組三元組，provider 重新排序窗口時歷史不會斷。
pub fn window_key(w: &LimitWindow) -> String {
    [
        w.kind.as_str(),
        w.metric.as_deref().unwrap_or(""),
        w.label.as_str(),
    ]
    .map(str::trim)
    .join(":")
}

/// 上游 `measurableWindow`：金額型窗口與算不出百分比的窗口不量（不把「沒有」當成 0%）。
fn measurable_window(w: &LimitWindow) -> Option<f64> {
    if w.metric.as_deref() == Some("credits") {
        return None;
    }
    w.used_percent.filter(|v| v.is_finite())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BurnSample {
    pub used_percent: f64,
    /// 取樣時間（這個 runtime 的時鐘，ms），不是列上的 updatedAt。
    pub at: i64,
    pub updated_at: String,
    pub resets_at: String,
    /// 已用百分比 / ms。
    pub rate: f64,
}

/// 下一次提早探測（上游 `nextLimitsUrgencyRefresh` 的回傳）。`keys[i]` 是 `providers[i]` 那一列的身分。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UrgencyDue {
    pub refresh_at: f64,
    pub delay_ms: f64,
    pub keys: Vec<String>,
    pub providers: Vec<String>,
}

/// 上游 `createLimitsBurnState`（少了 `inFlight`，見檔頭）。
#[derive(Debug, Default)]
pub struct BurnState {
    windows: BTreeMap<String, BurnSample>,
    attempts: HashMap<String, i64>,
    live: HashSet<String>,
}

impl BurnState {
    /// 上游 `markLimitsProbeSuccess`：這個 runtime 自己探測成功的列才能成為量測；其他東西都不能標記。
    pub fn mark_probe_success(&mut self, row: &LimitProvider) {
        self.live.insert(provider_identity_key(row));
    }

    /// 上游 `recordLimitsSample`：每次重組摘要後呼叫。
    pub fn record_sample(&mut self, limits: &LimitsSummary, now_ms: i64) {
        for p in &limits.providers {
            // 失敗時重發的是保留下來的 last-good；updatedAt 沒變代表同一次探測，別的 provider 重組摘要時不重複取樣。
            if p.status != ProviderStatus::Ok {
                continue;
            }
            let updated_at = p.updated_at.as_deref().unwrap_or("").trim();
            if updated_at.is_empty() {
                continue;
            }
            let identity = provider_identity_key(p);
            if !self.live.contains(&identity) {
                continue;
            }
            for w in &p.windows {
                let Some(used_percent) = measurable_window(w) else {
                    continue;
                };
                let key = format!("{identity}|{}", window_key(w));
                let resets_at = w.resets_at.as_deref().unwrap_or("").trim().to_string();
                let Some(previous) = self.windows.get(&key) else {
                    self.windows.insert(
                        key,
                        BurnSample {
                            used_percent,
                            at: now_ms,
                            updated_at: updated_at.to_string(),
                            resets_at,
                            rate: 0.0,
                        },
                    );
                    continue;
                };
                if previous.updated_at == updated_at {
                    continue;
                }
                let elapsed_ms = now_ms - previous.at;
                // 跨過重置的差不是消耗：重新取基準，沿用舊的速度，而不是拿不存在的證據把它衰減到 0。
                let reset = resets_at != previous.resets_at || used_percent < previous.used_percent;
                let mut rate = previous.rate;
                if !reset && elapsed_ms > 0 {
                    let instant = (used_percent - previous.used_percent) / elapsed_ms as f64;
                    rate = if instant >= previous.rate {
                        instant
                    } else {
                        (LIMITS_URGENCY_RELEASE_WEIGHT * instant)
                            + ((1.0 - LIMITS_URGENCY_RELEASE_WEIGHT) * previous.rate)
                    };
                }
                self.windows.insert(
                    key,
                    BurnSample {
                        used_percent,
                        at: now_ms,
                        updated_at: updated_at.to_string(),
                        resets_at,
                        rate,
                    },
                );
            }
        }
    }

    /// 上游 `recordLimitsUrgencyAttempt`：觸發時對每個到期的 key 記下嘗試（被略過的也算），
    /// 同一個額度至少隔一個下限才會再觸發，即使探測失敗、樣本沒動。
    pub fn record_attempt(&mut self, keys: &[String], now_ms: i64) {
        for key in keys {
            self.attempts.insert(key.clone(), now_ms);
        }
    }

    /// 上游 `pruneLimitsBurnState`：摘要裡已經沒有的窗口與身分丟掉。
    pub fn prune(&mut self, limits: &LimitsSummary) {
        let mut identities = HashSet::new();
        let mut windows = HashSet::new();
        for p in &limits.providers {
            let identity = provider_identity_key(p);
            for w in &p.windows {
                windows.insert(format!("{identity}|{}", window_key(w)));
            }
            identities.insert(identity);
        }
        self.windows.retain(|k, _| windows.contains(k));
        self.attempts.retain(|k, _| identities.contains(k));
        self.live.retain(|k| identities.contains(k));
    }

    /// 上游 `nextLimitsUrgencyRefresh`（預設的下限與 samplesAhead）：最早該提早探測的時間與對象，
    /// 沒有比基本間隔更早的就回 `None`。
    pub fn next_urgency(
        &self,
        limits: &LimitsSummary,
        now_ms: i64,
        base_refresh_ms: u64,
    ) -> Option<UrgencyDue> {
        let base = base_refresh_ms as f64;
        let floor = LIMITS_URGENCY_FLOOR_MS;
        // 設定的間隔已經不比下限長：這裡只會縮短間隔，不製造使用者在設定裡選不到的間隔。
        if base <= floor {
            return None;
        }
        let mut refresh_at = f64::INFINITY;
        let mut keys: Vec<String> = Vec::new();
        let mut providers: Vec<String> = Vec::new();
        for p in &limits.providers {
            let identity = provider_identity_key(p);
            let attempted_at = self.attempts.get(&identity).copied().unwrap_or(0) as f64;
            for w in &p.windows {
                let Some(used_percent) = measurable_window(w) else {
                    continue;
                };
                let remaining = 100.0 - used_percent;
                if remaining <= 0.0 {
                    continue;
                }
                let Some(sample) = self
                    .windows
                    .get(&format!("{identity}|{}", window_key(w)))
                    .filter(|s| s.rate > 0.0)
                else {
                    continue;
                };
                let delay_ms = remaining / sample.rate / LIMITS_URGENCY_SAMPLES_AHEAD;
                // 上游 `!(delayMs < baseRefreshMs)`：NaN 也略過。
                if delay_ms.is_nan() || delay_ms >= base {
                    continue;
                }
                // 以產生它的樣本為基準：被更急的 provider 搶先時，自己的期限不會每次往後漂一整個 delay。
                // 探測失敗、樣本沒動時，嘗試的下限照樣成立。
                let candidate = (sample.at as f64 + delay_ms.max(floor)).max(attempted_at + floor);
                if candidate > refresh_at {
                    continue;
                }
                if candidate < refresh_at {
                    refresh_at = candidate;
                    keys.clear();
                    providers.clear();
                }
                if !keys.contains(&identity) {
                    keys.push(identity.clone());
                    providers.push(p.provider.trim().to_string());
                }
            }
        }
        if !refresh_at.is_finite() {
            return None;
        }
        Some(UrgencyDue {
            refresh_at,
            delay_ms: (refresh_at - now_ms as f64).max(0.0),
            keys,
            providers,
        })
    }

    /// 目前每個窗口的樣本（相容測試逐欄比對上游 `state.windows` 用）。
    pub fn samples(&self) -> &BTreeMap<String, BurnSample> {
        &self.windows
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::WindowKind;

    const MIN: i64 = 60_000;

    fn window(kind: WindowKind, used: Option<f64>, resets: &str) -> LimitWindow {
        LimitWindow {
            used_percent: used,
            resets_at: (!resets.is_empty()).then(|| resets.to_string()),
            ..LimitWindow::new(kind)
        }
    }

    fn row(status: ProviderStatus, at: &str, windows: Vec<LimitWindow>) -> LimitProvider {
        LimitProvider {
            account_key: "sha256:abc".into(),
            windows,
            ..LimitProvider::status_row("claude", status, at.into())
        }
    }

    fn summary(rows: Vec<LimitProvider>) -> LimitsSummary {
        LimitsSummary {
            updated_at: None,
            refresh_ms: LIMITS_ADAPTIVE_BASE_MS,
            providers: rows,
        }
    }

    fn session(used: f64) -> Vec<LimitWindow> {
        vec![window(
            WindowKind::Session,
            Some(used),
            "2026-09-24T10:00:00.000Z",
        )]
    }

    /// 以「探測成功 → 取樣 → 修剪」的順序餵一個樣本（runtime 每次提交後做的事）。
    fn observe(state: &mut BurnState, limits: &LimitsSummary, now_ms: i64) {
        for p in &limits.providers {
            if p.status == ProviderStatus::Ok {
                state.mark_probe_success(p);
            }
        }
        state.record_sample(limits, now_ms);
        state.prune(limits);
    }

    #[test]
    fn idle_quotas_stay_on_the_base_interval() {
        let mut state = BurnState::default();
        observe(
            &mut state,
            &summary(vec![row(ProviderStatus::Ok, "a", session(92.0))]),
            0,
        );
        let same = summary(vec![row(ProviderStatus::Ok, "b", session(92.0))]);
        observe(&mut state, &same, 5 * MIN);
        assert_eq!(
            state.next_urgency(&same, 5 * MIN, LIMITS_ADAPTIVE_BASE_MS),
            None
        );
    }

    #[test]
    fn a_fast_burn_probes_early_but_never_faster_than_the_floor() {
        let mut state = BurnState::default();
        observe(
            &mut state,
            &summary(vec![row(ProviderStatus::Ok, "a", session(80.0))]),
            0,
        );
        // 5 分鐘用掉 8%：剩 12%，照這個速度 7.5 分鐘用完，四分之一是 112.5 秒。
        let now = summary(vec![row(ProviderStatus::Ok, "b", session(88.0))]);
        observe(&mut state, &now, 5 * MIN);
        let due = state
            .next_urgency(&now, 5 * MIN, LIMITS_ADAPTIVE_BASE_MS)
            .unwrap();
        assert!((due.delay_ms - 112_500.0).abs() < 1e-6, "{}", due.delay_ms);
        assert_eq!(due.keys, vec!["claude:sha256:abc::"]);
        assert_eq!(due.providers, vec!["claude"]);

        // 同樣的速度只剩 1%：算出來 9.4 秒，但最快每分鐘。
        let nearly = summary(vec![row(ProviderStatus::Ok, "c", session(99.0))]);
        observe(&mut state, &nearly, 5 * MIN + 1);
        let due = state
            .next_urgency(&nearly, 5 * MIN + 1, LIMITS_ADAPTIVE_BASE_MS)
            .unwrap();
        assert_eq!(due.refresh_at, (5 * MIN + 1 + MIN) as f64);

        // 已經用完的窗口沒有東西可以提早看。
        let spent = summary(vec![row(ProviderStatus::Ok, "d", session(100.0))]);
        observe(&mut state, &spent, 6 * MIN);
        assert_eq!(
            state.next_urgency(&spent, 6 * MIN, LIMITS_ADAPTIVE_BASE_MS),
            None
        );
    }

    #[test]
    fn a_slower_burn_only_decays_the_rate() {
        let mut state = BurnState::default();
        observe(
            &mut state,
            &summary(vec![row(ProviderStatus::Ok, "a", session(80.0))]),
            0,
        );
        observe(
            &mut state,
            &summary(vec![row(ProviderStatus::Ok, "b", session(90.0))]),
            5 * MIN,
        );
        let fast = state.samples().values().next().unwrap().rate;
        observe(
            &mut state,
            &summary(vec![row(ProviderStatus::Ok, "c", session(90.0))]),
            10 * MIN,
        );
        let decayed = state.samples().values().next().unwrap().rate;
        assert!(fast > 0.0);
        assert!(
            (decayed - 0.7 * fast).abs() < 1e-15,
            "a quiet interval keeps 70% of the rate"
        );
    }

    #[test]
    fn a_reset_rebaselines_and_keeps_the_rate() {
        let mut state = BurnState::default();
        observe(
            &mut state,
            &summary(vec![row(ProviderStatus::Ok, "a", session(40.0))]),
            0,
        );
        observe(
            &mut state,
            &summary(vec![row(ProviderStatus::Ok, "b", session(60.0))]),
            5 * MIN,
        );
        let rate = state.samples().values().next().unwrap().rate;
        let after = vec![window(
            WindowKind::Session,
            Some(2.0),
            "2026-09-24T15:00:00.000Z",
        )];
        observe(
            &mut state,
            &summary(vec![row(ProviderStatus::Ok, "c", after)]),
            10 * MIN,
        );
        let sample = state.samples().values().next().unwrap();
        assert_eq!((sample.used_percent, sample.rate), (2.0, rate));
    }

    #[test]
    fn only_this_runtimes_successful_probes_are_measurements() {
        let mut state = BurnState::default();
        // 沒有探測成功過的列（例如上次留下的）不是基準。
        let seed = summary(vec![row(ProviderStatus::Ok, "a", session(10.0))]);
        state.record_sample(&seed, 0);
        assert!(state.samples().is_empty());

        observe(
            &mut state,
            &summary(vec![row(ProviderStatus::Ok, "b", session(10.0))]),
            MIN,
        );
        // 暫時性失敗重發的是 last-good：不取樣。
        let failed = summary(vec![row(ProviderStatus::RateLimited, "c", session(50.0))]);
        observe(&mut state, &failed, 2 * MIN);
        assert_eq!(state.samples().values().next().unwrap().used_percent, 10.0);
        // 同一次探測（updatedAt 相同）在別的 provider 重組摘要時不重複取樣。
        let again = summary(vec![row(ProviderStatus::Ok, "b", session(10.0))]);
        observe(&mut state, &again, 3 * MIN);
        assert_eq!(state.samples().values().next().unwrap().at, MIN);
    }

    #[test]
    fn credit_windows_and_missing_percentages_are_not_measured() {
        let mut state = BurnState::default();
        let credits = LimitWindow {
            metric: Some("credits".into()),
            ..window(WindowKind::Billing, Some(50.0), "")
        };
        let rows = |at: &str, used: Option<f64>| {
            summary(vec![row(
                ProviderStatus::Ok,
                at,
                vec![credits.clone(), window(WindowKind::Weekly, used, "")],
            )])
        };
        observe(&mut state, &rows("a", None), 0);
        observe(&mut state, &rows("b", Some(50.0)), MIN);
        assert_eq!(
            state.samples().len(),
            1,
            "only the weekly, from its first real reading"
        );
        assert_eq!(state.samples().values().next().unwrap().rate, 0.0);
    }

    #[test]
    fn an_attempt_holds_the_floor_even_when_the_sample_does_not_move() {
        let mut state = BurnState::default();
        observe(
            &mut state,
            &summary(vec![row(ProviderStatus::Ok, "a", session(80.0))]),
            0,
        );
        let now = summary(vec![row(ProviderStatus::Ok, "b", session(95.0))]);
        observe(&mut state, &now, 5 * MIN);
        let due = state
            .next_urgency(&now, 5 * MIN, LIMITS_ADAPTIVE_BASE_MS)
            .unwrap();
        assert_eq!(due.refresh_at, (6 * MIN) as f64);
        state.record_attempt(&due.keys, 6 * MIN);
        let due = state
            .next_urgency(&now, 6 * MIN, LIMITS_ADAPTIVE_BASE_MS)
            .unwrap();
        assert_eq!(
            due.refresh_at,
            (7 * MIN) as f64,
            "a failed probe waits a floor"
        );
    }

    #[test]
    fn a_base_at_or_below_the_floor_adds_nothing() {
        let mut state = BurnState::default();
        observe(
            &mut state,
            &summary(vec![row(ProviderStatus::Ok, "a", session(80.0))]),
            0,
        );
        let now = summary(vec![row(ProviderStatus::Ok, "b", session(95.0))]);
        observe(&mut state, &now, 5 * MIN);
        assert_eq!(state.next_urgency(&now, 5 * MIN, 60_000), None);
    }

    #[test]
    fn pruning_forgets_rows_that_left_the_summary() {
        let mut state = BurnState::default();
        observe(
            &mut state,
            &summary(vec![row(ProviderStatus::Ok, "a", session(80.0))]),
            0,
        );
        state.record_attempt(&["claude:sha256:abc::".to_string()], 0);
        observe(&mut state, &summary(Vec::new()), MIN);
        assert!(state.samples().is_empty());
        assert!(state.attempts.is_empty() && state.live.is_empty());
    }
}
