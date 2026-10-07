//! 收集器：一次完整 tick = today → month → allTime 三次**序列**掃描（上游 collector.js
//! `collectUsageOnce`）。刻意不平行：同時跑三個 tokscale 會把 CPU / IO 峰值乘三
//! （上游 issue #15 的 500% CPU 迴圈就是這樣來的）。
//!
//! 掃描前先讓 tokscale 同步 Cursor 與 Antigravity 的 cache（self_sync.rs），否則這兩個工具永遠是 0。
//!
//! 完整掃描的結果同時是**錨點**（`Anchor`）。之後的 anchored tick（檔案變動或定時）只掃
//! `--today`，month / allTime 以精確 delta 推出（usage/delta.rs），上游 collector.js 的
//! `collectUsageOnce` 同一條路。錨點跨過本地午夜就失效，runtime 會改跑完整掃描。

pub mod antigravity;
pub mod cursor;
pub mod roots;
pub mod self_sync;
pub mod watch;

use std::path::PathBuf;
use std::sync::Arc;

use chrono::{Local, Utc};
use indexmap::IndexMap;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::tokscale::{ScanPeriod, Scanner};
use crate::usage::delta::apply_period_delta;
use crate::usage::period_from_tokscale;
use crate::wire::time::iso_millis;
use crate::wire::{ClientStatus, Period, PeriodWindows, UsageSummary};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectorConfig {
    pub tracked_clients: Vec<String>,
    pub all_time_since: String,
    pub projects_enabled: bool,
    /// 上傳 history（上游 `historyEnabled`，預設開）。關閉時每筆 record 都送 `history: null`。
    pub history_enabled: bool,
}

/// 用量資料的來源：真正的 tokscale，或測試用的固定 JSON 目錄
/// （`today.json` / `month.json` / `alltime.json`，讓相容測試與 E2E 不依賴本機紀錄）。
#[derive(Debug, Clone)]
pub enum ScanSource {
    Tokscale(Arc<Scanner>),
    Fixtures(PathBuf),
}

impl CollectorConfig {
    pub fn from_settings(settings: &crate::settings::Settings) -> CollectorConfig {
        CollectorConfig {
            tracked_clients: settings.tracked_clients.clone(),
            all_time_since: settings.all_time_since.clone(),
            projects_enabled: settings.projects_enabled,
            history_enabled: settings.history_enabled,
        }
    }
}

impl ScanSource {
    async fn scan(
        &self,
        cfg: &CollectorConfig,
        period: &ScanPeriod,
        cancel: &CancellationToken,
    ) -> AppResult<Value> {
        match self {
            ScanSource::Tokscale(scanner) => {
                scanner
                    .scan(&cfg.tracked_clients, period, cfg.projects_enabled, cancel)
                    .await
            }
            ScanSource::Fixtures(dir) => {
                read_fixture(dir, period.file_stem(), json!({ "entries": [] }))
            }
        }
    }

    /// `tokscale graph`；固定 JSON 來源讀 `graph.json`（沒有就當作一天都沒有）。
    async fn graph(&self, cfg: &CollectorConfig, cancel: &CancellationToken) -> AppResult<Value> {
        match self {
            ScanSource::Tokscale(scanner) => scanner.graph(&cfg.tracked_clients, cancel).await,
            ScanSource::Fixtures(dir) => read_fixture(dir, "graph", json!({ "contributions": [] })),
        }
    }

    pub fn describe(&self) -> String {
        match self {
            ScanSource::Tokscale(s) => {
                format!("tokscale ({}) {}", s.bin.source, s.bin.path.display())
            }
            ScanSource::Fixtures(d) => format!("fixtures {}", d.display()),
        }
    }
}

fn read_fixture(dir: &std::path::Path, stem: &str, missing: Value) -> AppResult<Value> {
    let path = dir.join(format!("{stem}.json"));
    match std::fs::read(&path) {
        Ok(bytes) => crate::tokscale::spawn::parse_json_output(&bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(missing),
        Err(e) => Err(AppError::Storage(format!("{}: {e}", path.display()))),
    }
}

fn client_status(clients: &[String], all_time: &Period) -> IndexMap<String, ClientStatus> {
    let home = dirs::home_dir().unwrap_or_default();
    clients
        .iter()
        .map(|c| {
            let status = if all_time.clients.get(c).copied().unwrap_or(0) > 0 {
                ClientStatus::Active
            } else if roots::client_present(c, &home) {
                ClientStatus::Waiting
            } else {
                ClientStatus::Missing
            };
            (c.clone(), status)
        })
        .collect()
}

/// 一次完整掃描的產出：上傳用的摘要，以及這次做了哪些自我同步（只給畫面與 log，不上 wire）。
#[derive(Debug, Clone)]
pub struct Collected {
    pub summary: UsageSummary,
    pub sync_reports: Vec<self_sync::SyncReport>,
}

/// 上一次完整掃描的三個期間：anchored tick 以它推出 month / allTime。
#[derive(Debug, Clone)]
pub struct Anchor {
    /// 錨點所屬的本地日期（`YYYY-MM-DD`）；換日就不能再用。
    pub date_key: String,
    pub today: Period,
    pub month: Period,
    pub all_time: Period,
    /// 完整掃描完成的時間；runtime 依它每小時強制重掃一次（上游 FULL_SCAN_INTERVAL_MS）。
    pub full_scan_at: std::time::Instant,
}

impl Anchor {
    pub fn from_summary(summary: &UsageSummary) -> Anchor {
        Anchor {
            date_key: summary.period_windows.today.key.clone(),
            today: summary.today.clone(),
            month: summary.month.clone(),
            all_time: summary.all_time.clone(),
            full_scan_at: std::time::Instant::now(),
        }
    }

    /// 錨點只在它的那一天有效（上游 `anchor.dateKey === localTodayKey(collectedAt)`）。
    pub fn usable_on(&self, date_key: &str) -> bool {
        self.date_key == date_key
    }

    /// 寫到 `collector-anchor.json`（上游同名檔）：重開程式或改了不影響掃描範圍的設定之後，
    /// 第一個 tick 只要掃 today。
    pub fn save(&self, path: &std::path::Path, cfg: &CollectorConfig) -> AppResult<()> {
        let elapsed = chrono::Duration::from_std(self.full_scan_at.elapsed())
            .unwrap_or_else(|_| chrono::Duration::zero());
        let saved = PersistedAnchor {
            date_key: self.date_key.clone(),
            full_scan_at: iso_millis(Utc::now() - elapsed),
            config_fingerprint: config_fingerprint(cfg),
            today: self.today.clone(),
            month: self.month.clone(),
            all_time: self.all_time.clone(),
        };
        let dir = path
            .parent()
            .ok_or_else(|| AppError::Storage("anchor path has no parent".into()))?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| AppError::Storage("bad anchor file name".into()))?;
        crate::store::write_json_in(dir, name, &saved)
    }

    /// 上游 `collectorAnchorTrust`：同一天、三個期間都在、設定指紋相同才沿用；掃描時間不可信
    /// （在未來或壞掉）就當成很舊，第一個定時 tick 會完整重掃。
    ///
    /// 第二個值是可信的掃描時間；不可信時為 `None`，這時錨點不能拿來當開機畫面
    /// （上游 anchorSeed.js：時間不明的快照不能當成剛拍的）。
    pub fn load(
        path: &std::path::Path,
        cfg: &CollectorConfig,
        today_key: &str,
    ) -> Option<(Anchor, Option<chrono::DateTime<Utc>>)> {
        let bytes = std::fs::read(path).ok()?;
        let saved: PersistedAnchor = serde_json::from_slice(&bytes).ok()?;
        if saved.date_key != today_key || saved.config_fingerprint != config_fingerprint(cfg) {
            return None;
        }
        let now = Utc::now();
        let captured_at = chrono::DateTime::parse_from_rfc3339(&saved.full_scan_at)
            .ok()
            .map(|t| t.with_timezone(&Utc))
            .filter(|t| *t <= now);
        let age = captured_at
            .and_then(|t| (now - t).to_std().ok())
            .unwrap_or(std::time::Duration::from_secs(24 * 3600));
        let full_scan_at = std::time::Instant::now()
            .checked_sub(age)
            .unwrap_or_else(std::time::Instant::now);
        let anchor = Anchor {
            date_key: saved.date_key,
            today: saved.today,
            month: saved.month,
            all_time: saved.all_time,
            full_scan_at,
        };
        Some((anchor, captured_at))
    }

    /// 以錨點與新的 today 推出 month / allTime（anchored tick 與完整掃描中的預覽共用）。
    pub fn periods_with(&self, cfg: &CollectorConfig, today: &Period) -> (Period, Period) {
        let mut month = apply_period_delta(&self.month, today, &self.today);
        let mut all_time = apply_period_delta(&self.all_time, today, &self.today);
        propagate_today_projects(today, &mut [&mut month, &mut all_time]);
        // 上游每次發佈前都由 session 重新彙總專案（main.js / agent.js 的 applyProjectRollups），
        // 不沿用 delta 出來的專案表：propagate 補上專案的 session 要算進它的專案。
        if cfg.projects_enabled {
            crate::usage::projects::apply_project_rollups(&mut month);
            crate::usage::projects::apply_project_rollups(&mut all_time);
        }
        (month, all_time)
    }

    /// 錨點本身當成一份用量（開機畫面用）；`at` 是錨點的掃描時間。
    pub fn to_summary(&self, cfg: &CollectorConfig, at: chrono::DateTime<Local>) -> UsageSummary {
        let mut summary = summary_of(
            cfg,
            at,
            self.today.clone(),
            self.month.clone(),
            self.all_time.clone(),
        );
        // 上游 deviceRecordFromAnchor 以「現在」算 periodWindows：錨點同一天，算出來一樣，
        // 但窗口與彙總比對的是現在。
        summary.period_windows = PeriodWindows::compute(Local::now());
        summary
    }
}

/// 完整掃描的中間結果（上游 `onProgress`）：today 掃完、month 掃完各通知一次，
/// 讓畫面不必等 allTime（最慢的那一段）。`collected_at` 與最後結果相同。
pub struct ScanProgress<'a> {
    pub collected_at: chrono::DateTime<Local>,
    pub today: &'a Period,
    pub month: Option<&'a Period>,
}

pub type ProgressFn<'a> = &'a (dyn Fn(ScanProgress<'_>) + Send + Sync);

pub const ANCHOR_FILE: &str = "collector-anchor.json";

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAnchor {
    date_key: String,
    full_scan_at: String,
    config_fingerprint: String,
    today: Period,
    month: Period,
    all_time: Period,
}

/// 上游 `configFingerprint`：錨點正確與否取決於的設定；變了就不能沿用。
fn config_fingerprint(cfg: &CollectorConfig) -> String {
    format!(
        "{}|{}|projects:{}",
        cfg.tracked_clients.join(","),
        cfg.all_time_since,
        if cfg.projects_enabled { "on" } else { "off" }
    )
}

/// 與 `PeriodWindows::compute` 的 today key 同一個格式。
pub fn local_today_key(now: chrono::DateTime<Local>) -> String {
    now.format("%Y-%m-%d").to_string()
}

async fn run_self_sync(
    source: &ScanSource,
    cfg: &CollectorConfig,
    force: bool,
    cancel: &CancellationToken,
) -> AppResult<Vec<self_sync::SyncReport>> {
    let reports = match source {
        ScanSource::Tokscale(scanner) => {
            self_sync::run(scanner, &cfg.tracked_clients, force, cancel).await
        }
        ScanSource::Fixtures(_) => Vec::new(),
    };
    if cancel.is_cancelled() {
        return Err(AppError::Stopped);
    }
    Ok(reports)
}

pub(crate) fn summary_of(
    cfg: &CollectorConfig,
    collected_at: chrono::DateTime<Local>,
    today: Period,
    month: Period,
    all_time: Period,
) -> UsageSummary {
    UsageSummary {
        updated_at: iso_millis(collected_at.with_timezone(&Utc)),
        projects_enabled: cfg.projects_enabled,
        tracked_clients: cfg.tracked_clients.clone(),
        client_status: client_status(&cfg.tracked_clients, &all_time),
        period_windows: PeriodWindows::compute(collected_at),
        history_available: cfg.history_enabled,
        today,
        month,
        all_time,
    }
}

/// 一次完整掃描。`force_self_sync` = 手動重掃（不等 Cursor / Antigravity 同步的 5 分鐘節流）。
///
/// `progress`：today 與 month 掃完時各呼叫一次（仍然序列掃描，只是先讓人看到）。
pub async fn collect_once(
    source: &ScanSource,
    cfg: &CollectorConfig,
    force_self_sync: bool,
    progress: Option<ProgressFn<'_>>,
    cancel: &CancellationToken,
) -> AppResult<Collected> {
    let sync_reports = run_self_sync(source, cfg, force_self_sync, cancel).await?;
    // 同一個瞬間決定 updatedAt 與 periodWindows，跨午夜的掃描才不會一半算昨天一半算今天。
    let collected_at = Local::now();
    let today = period_from_tokscale(
        source.scan(cfg, &ScanPeriod::Today, cancel).await?,
        cfg.projects_enabled,
    );
    if let Some(notify) = progress {
        notify(ScanProgress {
            collected_at,
            today: &today,
            month: None,
        });
    }
    let month = period_from_tokscale(
        source.scan(cfg, &ScanPeriod::Month, cancel).await?,
        cfg.projects_enabled,
    );
    if let Some(notify) = progress {
        notify(ScanProgress {
            collected_at,
            today: &today,
            month: Some(&month),
        });
    }
    let all_time = period_from_tokscale(
        source
            .scan(cfg, &ScanPeriod::Since(cfg.all_time_since.clone()), cancel)
            .await?,
        cfg.projects_enabled,
    );
    Ok(Collected {
        summary: summary_of(cfg, collected_at, today, month, all_time),
        sync_reports,
    })
}

/// anchored tick：只掃 `--today`，month / allTime = 錨點 + (新 today − 錨點 today)。
///
/// `self_sync`：定時的 anchored tick 要（Cursor / Antigravity 的 cache 由同步產生、沒有檔案事件），
/// 檔案變動觸發的 tick 不要（3–5 秒的承諾禁不起 Antigravity 最多 30 秒的同步）。
/// 呼叫端負責確認錨點屬於今天（`Anchor::usable_on`）；跨日時必須改跑 `collect_once`。
pub async fn collect_anchored(
    source: &ScanSource,
    cfg: &CollectorConfig,
    anchor: &Anchor,
    self_sync: bool,
    cancel: &CancellationToken,
) -> AppResult<Collected> {
    let sync_reports = if self_sync {
        run_self_sync(source, cfg, false, cancel).await?
    } else {
        Vec::new()
    };
    let collected_at = Local::now();
    let today = period_from_tokscale(
        source.scan(cfg, &ScanPeriod::Today, cancel).await?,
        cfg.projects_enabled,
    );
    let (month, all_time) = anchor.periods_with(cfg, &today);
    Ok(Collected {
        summary: summary_of(cfg, collected_at, today, month, all_time),
        sync_reports,
    })
}

/// history 的 graph 掃描（上游 `collectHistoryOnce`）。`Ok(None)` = graph 裡一天都沒有，
/// 這時與失敗一樣不送 `history`（hub 保留上一份）。`today_key` 是本地日期：370 天的窗口與
/// 連續天數都以它為準。
///
/// `archive` = daily history archive 的檔案與是否寫回（usage/history_archive.rs）：先記住這次 graph
/// 的每一天，再以 archive 重建 graph，client 刪掉紀錄的日子才不會從 history 消失（上游
/// `retainDailyHistory`）。dry run 只讀不寫（上游 `dailyHistoryArchiveWriteEnabled: !dryRun`）。
pub async fn collect_history(
    source: &ScanSource,
    cfg: &CollectorConfig,
    today_key: &str,
    archive: Option<(&std::path::Path, bool)>,
    cancel: &CancellationToken,
) -> AppResult<Option<Value>> {
    let raw = source.graph(cfg, cancel).await?;
    let graph = match archive {
        Some((path, write)) => {
            let mut store = crate::usage::history_archive::HistoryArchive::load(path);
            if store.capture(&raw, today_key) && write {
                if let Err(e) = store.save(path) {
                    tracing::warn!(error = %e, "daily history archive write failed");
                }
            }
            store.to_graph(&raw, today_key)
        }
        None => raw,
    };
    Ok(crate::usage::history::history_from_graph(&graph, today_key))
}

/// 兩個 ISO 時間都能解析時才比較（JS 的 `Date.parse` 對 NaN 的比較一律是 false）。
fn compare_iso(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    let ms = |s: &str| chrono::DateTime::parse_from_rfc3339(s).map(|d| d.timestamp_millis());
    match (ms(a), ms(b)) {
        (Ok(x), Ok(y)) => Some(x.cmp(&y)),
        _ => None,
    }
}

/// 把 today 剛解析出的專案身分與時間補到 delta 推出的期間（上游 collector.js
/// `propagateTodayProjects`）。錨點裡已有、當時還沒有專案的 session，delta 會留下 base 的
/// 空字串（空字串不是 null），要在這裡補。v1 的 session 沒有標題、context 與 turnEnded，
/// 所以只處理專案、種類與時間。
pub fn propagate_today_projects(today: &Period, periods: &mut [&mut Period]) {
    use std::cmp::Ordering;
    for (key, session) in &today.sessions {
        for period in periods.iter_mut() {
            let Some(target) = period.sessions.get_mut(key) else {
                continue;
            };
            if !session.project_id.is_empty() && target.project_id.is_empty() {
                target.project_id = session.project_id.clone();
                target.project_label = session.project_label.clone();
            }
            if !session.session_kind.is_empty() && target.session_kind.is_empty() {
                target.session_kind = session.session_kind.clone();
            }
            if !session.started_at.is_empty()
                && (target.started_at.is_empty()
                    || compare_iso(&session.started_at, &target.started_at) == Some(Ordering::Less))
            {
                target.started_at = session.started_at.clone();
            }
            if !session.last_used_at.is_empty()
                && (target.last_used_at.is_empty()
                    || compare_iso(&session.last_used_at, &target.last_used_at)
                        == Some(Ordering::Greater))
            {
                target.last_used_at = session.last_used_at.clone();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fixtures_source_reads_three_periods() {
        let dir = tempfile::tempdir().unwrap();
        let row = |tokens: i64| json!({ "entries": [{ "client": "claude", "sessionId": "s", "model": "m", "input": tokens }] });
        std::fs::write(dir.path().join("today.json"), row(1).to_string()).unwrap();
        std::fs::write(dir.path().join("month.json"), row(10).to_string()).unwrap();
        std::fs::write(dir.path().join("alltime.json"), row(100).to_string()).unwrap();
        let cfg = CollectorConfig {
            tracked_clients: vec!["claude".into(), "codex".into()],
            all_time_since: "2024-01-01".into(),
            projects_enabled: true,
            history_enabled: true,
        };
        let seen = std::sync::Mutex::new(Vec::new());
        let progress = |p: ScanProgress<'_>| {
            seen.lock()
                .unwrap()
                .push((p.today.total_tokens, p.month.map(|m| m.total_tokens)));
        };
        let s = collect_once(
            &ScanSource::Fixtures(dir.path().into()),
            &cfg,
            false,
            Some(&progress),
            &CancellationToken::new(),
        )
        .await
        .unwrap()
        .summary;
        assert_eq!(*seen.lock().unwrap(), vec![(1, None), (1, Some(10))]);
        assert_eq!(s.today.total_tokens, 1);
        assert_eq!(s.month.total_tokens, 10);
        assert_eq!(s.all_time.total_tokens, 100);
        assert_eq!(s.client_status["claude"], ClientStatus::Active);
        assert!(s.period_windows.today.ends_at > s.updated_at);
    }
}
