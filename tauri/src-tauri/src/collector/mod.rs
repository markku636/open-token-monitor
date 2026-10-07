//! 收集器：一次完整 tick = today → month → allTime 三次**序列**掃描（上游 collector.js
//! `collectUsageOnce`）。刻意不平行：同時跑三個 tokscale 會把 CPU / IO 峰值乘三
//! （上游 issue #15 的 500% CPU 迴圈就是這樣來的）。
//!
//! 掃描前先讓 tokscale 同步 Cursor 與 Antigravity 的 cache（self_sync.rs），否則這兩個工具永遠是 0。
//!
//! 完整掃描的結果同時是**錨點**（`Anchor`）。之後的 anchored tick（檔案變動或定時）只掃
//! `--today`，month / allTime 以精確 delta 推出（usage/delta.rs），上游 collector.js 的
//! `collectUsageOnce` 同一條路。錨點跨過本地午夜就失效，runtime 會改跑完整掃描。
//!
//! WSL（wsl.rs，只在 Windows）：完整掃描順便掃執行中 distro 的家目錄。錨點把主機的期間與 WSL
//! bundle 分開存，delta 只作用在主機的期間上、WSL 在發佈前才加上去，所以 delta 仍然精確。
//! anchored tick 有三種 WSL 模式（上游 `refreshWsl` / `wslAnchor`）：定時的重新掃 WSL、檔案變動
//! 觸發的沿用凍結的快照（每幾秒一次的 tick 不能隔著 9P 掃描）、完整掃描一起掃。

pub mod antigravity;
pub mod cursor;
pub mod roots;
pub mod self_sync;
pub mod watch;
pub mod wsl;

use std::borrow::Cow;
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
use crate::wire::{ClientStatus, Period, PeriodWindows, UsageSummary, WslState, WslStatus};
use wsl::{with_wsl, FixtureWsl, SystemWsl, WslBundle, WslHost};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectorConfig {
    pub tracked_clients: Vec<String>,
    pub all_time_since: String,
    pub projects_enabled: bool,
    /// 上傳 history（上游 `historyEnabled`，預設開）。關閉時每筆 record 都送 `history: null`。
    pub history_enabled: bool,
    /// 掃描 WSL 裡的工具（上游 `wslScanEnabled`，預設開；只在 Windows 有作用）。不進錨點的設定
    /// 指紋：主機的期間與它無關（上游刻意如此），關閉時只是不再讀回凍結的 WSL 快照。
    pub wsl_scan_enabled: bool,
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
            wsl_scan_enabled: settings.wsl_scan_enabled,
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

    /// WSL 家目錄的一次掃描（`tokscale --home <家目錄>`）；固定 JSON 來源讀 `wsl.json` 的 `scans`。
    async fn scan_home(
        &self,
        cfg: &CollectorConfig,
        period: &ScanPeriod,
        home: &str,
        cancel: &CancellationToken,
    ) -> AppResult<Value> {
        match self {
            ScanSource::Tokscale(scanner) => {
                scanner
                    .scan_home(
                        &cfg.tracked_clients,
                        period,
                        cfg.projects_enabled,
                        Some(home),
                        cancel,
                    )
                    .await
            }
            ScanSource::Fixtures(dir) => Ok(FixtureWsl::load(dir)
                .map(|f| f.scan(home, period.file_stem()))
                .unwrap_or_else(|| json!({ "entries": [] }))),
        }
    }

    /// 這個來源的 WSL 環境；`None` = 沒有 WSL（非 Windows，或沒有 `wsl.json` 的固定 JSON 來源），
    /// 這時 `wslStatus` 是 `null`（上游 `platform !== 'win32'`）。
    pub fn wsl_host(&self) -> Option<Arc<dyn WslHost>> {
        match self {
            ScanSource::Tokscale(_) => {
                cfg!(windows).then(|| Arc::new(SystemWsl) as Arc<dyn WslHost>)
            }
            ScanSource::Fixtures(dir) => {
                FixtureWsl::load(dir).map(|f| Arc::new(f) as Arc<dyn WslHost>)
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

/// `wsl_detected`：WSL 裡找到標記的工具也算「本機有這個工具」（上游 `clientSourceChecks` 的
/// `wsl-home`），只裝在 WSL 裡、還沒有用量的工具才不會顯示成 missing。
fn client_status(
    clients: &[String],
    all_time: &Period,
    wsl_detected: &[String],
) -> IndexMap<String, ClientStatus> {
    let home = dirs::home_dir().unwrap_or_default();
    clients
        .iter()
        .map(|c| {
            let status = if all_time.clients.get(c).copied().unwrap_or(0) > 0 {
                ClientStatus::Active
            } else if roots::client_present(c, &home) || wsl_detected.contains(c) {
                ClientStatus::Waiting
            } else {
                ClientStatus::Missing
            };
            (c.clone(), status)
        })
        .collect()
}

/// 一次掃描的產出：上傳用的摘要（主機 + WSL），以及這次做了哪些自我同步（只給畫面與 log，不上 wire）。
#[derive(Debug, Clone)]
pub struct Collected {
    pub summary: UsageSummary,
    /// 完整掃描的新錨點（主機的期間與 WSL 分開）；anchored tick 是 `None`。
    pub anchor: Option<Anchor>,
    /// 定時的 anchored tick 重新掃了 WSL：錨點裡凍結的 WSL 快照要換成這個（上游 `refreshWsl`）。
    pub wsl_refresh: Option<WslSnapshot>,
    pub sync_reports: Vec<self_sync::SyncReport>,
}

/// 凍結在錨點裡的 WSL 快照（上游 `wslAnchor` / `wslStatusAnchor`）。`bundle` 是 `None` 表示
/// 沒有快照（WSL 掃描關閉時讀回的錨點，或舊版的檔案）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WslSnapshot {
    pub bundle: Option<WslBundle>,
    pub status: Option<WslStatus>,
}

/// 上一次完整掃描的三個期間：anchored tick 以它推出 month / allTime。期間只含主機的用量，
/// WSL 另外放在 `wsl`，delta 才精確（上游 anchor + wslAnchor）。
#[derive(Debug, Clone)]
pub struct Anchor {
    /// 錨點所屬的本地日期（`YYYY-MM-DD`）；換日就不能再用。
    pub date_key: String,
    pub today: Period,
    pub month: Period,
    pub all_time: Period,
    pub wsl: WslSnapshot,
    /// 完整掃描完成的時間；runtime 依它每小時強制重掃一次（上游 FULL_SCAN_INTERVAL_MS）。
    pub full_scan_at: std::time::Instant,
}

impl Anchor {
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
            wsl_bundle: self.wsl.bundle.clone(),
            wsl_status: self.wsl.status.clone(),
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
        // WSL 掃描現在關著就不讀回凍結的快照：設定指紋刻意不含這個開關（主機的期間仍然有效），
        // 不擋的話預覽會先把舊的 WSL 用量加回來，等第一次完整掃描才清掉。
        let wsl = if cfg.wsl_scan_enabled {
            WslSnapshot {
                bundle: saved.wsl_bundle,
                status: saved.wsl_status,
            }
        } else {
            WslSnapshot::default()
        };
        let anchor = Anchor {
            date_key: saved.date_key,
            today: saved.today,
            month: saved.month,
            all_time: saved.all_time,
            wsl,
            full_scan_at,
        };
        Some((anchor, captured_at))
    }

    /// 以錨點與新的 today 推出 month / allTime（anchored tick 與完整掃描中的預覽共用）。
    /// 只有主機的部分：WSL 由呼叫端另外加。
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
    ///
    /// 上游 anchorSeed.js：同一天的錨點，三個期間都加上凍結的 WSL 快照；`wslStatus` 在沒有 WSL 的
    /// 平台是 `null`、WSL 掃描關閉時是 `disabled`（兩者對下游是不同的狀態），否則沿用錨點的快照。
    pub fn to_summary(
        &self,
        cfg: &CollectorConfig,
        at: chrono::DateTime<Local>,
        wsl_supported: bool,
    ) -> UsageSummary {
        let wsl = self.wsl.bundle.as_ref().filter(|_| cfg.wsl_scan_enabled);
        let merge = |host: &Period, part: Option<&Period>| {
            with_wsl(cfg.projects_enabled, host.clone(), part)
        };
        let status = if !wsl_supported {
            None
        } else if !cfg.wsl_scan_enabled {
            Some(WslStatus::empty(WslState::Disabled))
        } else {
            self.wsl.status.clone()
        };
        let mut summary = summary_of(
            cfg,
            at,
            merge(&self.today, wsl.map(|b| &b.today)),
            merge(&self.month, wsl.map(|b| &b.month)),
            merge(&self.all_time, wsl.map(|b| &b.all_time)),
            status,
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
    /// 上游同名欄位；舊版的檔案沒有，讀回來是 `None`。
    #[serde(default)]
    wsl_bundle: Option<WslBundle>,
    #[serde(default)]
    wsl_status: Option<WslStatus>,
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
    wsl_status: Option<WslStatus>,
) -> UsageSummary {
    let detected = wsl_status
        .as_ref()
        .map(|s| s.detected.as_slice())
        .unwrap_or_default();
    UsageSummary {
        updated_at: iso_millis(collected_at.with_timezone(&Utc)),
        projects_enabled: cfg.projects_enabled,
        tracked_clients: cfg.tracked_clients.clone(),
        client_status: client_status(&cfg.tracked_clients, &all_time, detected),
        period_windows: PeriodWindows::compute(collected_at),
        history_available: cfg.history_enabled,
        wsl_status,
        today,
        month,
        all_time,
    }
}

/// 這個 tick 的 WSL 怎麼來（上游 collectUsageOnce 的三種模式）。
enum WslMode<'a> {
    /// 完整掃描，或定時的 anchored tick（`refreshWsl`）：重新掃。
    Fresh,
    /// 檔案變動觸發的 anchored tick：沿用錨點凍結的快照，也不重新探測（每幾秒一次的 tick 不能
    /// 每次都跑 wsl.exe）。
    Frozen(&'a WslSnapshot),
}

/// 上游 collectUsageOnce 的 WSL 段落：這次要加上去的 WSL bundle 與 `wslStatus`。
async fn wsl_part<'a>(
    source: &ScanSource,
    cfg: &CollectorConfig,
    mode: WslMode<'a>,
    cancel: &CancellationToken,
) -> AppResult<(Cow<'a, WslBundle>, Option<WslStatus>)> {
    let host = source.wsl_host();
    let tracked = !cfg.tracked_clients.is_empty();
    let mut bundle: Cow<'a, WslBundle> = Cow::Owned(WslBundle::default());
    let mut detected = Vec::new();
    if tracked && cfg.wsl_scan_enabled {
        match (&mode, &host) {
            (WslMode::Fresh, Some(host)) => {
                let usage = wsl::collect_wsl_usage(source, host, cfg, cancel).await?;
                bundle = Cow::Owned(usage.bundle);
                detected = usage.detected;
            }
            (WslMode::Frozen(snapshot), _) => {
                if let Some(frozen) = &snapshot.bundle {
                    bundle = Cow::Borrowed(frozen);
                }
            }
            // 沒有 WSL 的平台：上游 collectWslUsage 找不到任何家目錄，結果就是空的。
            (WslMode::Fresh, None) => {}
        }
    }
    if cancel.is_cancelled() {
        return Err(AppError::Stopped);
    }
    let Some(host) = host.filter(|_| tracked) else {
        return Ok((bundle, None));
    };
    let status = if !cfg.wsl_scan_enabled {
        WslStatus::empty(WslState::Disabled)
    } else {
        match &mode {
            WslMode::Frozen(WslSnapshot {
                bundle: Some(_),
                status: Some(frozen),
            }) => frozen.clone(),
            _ => wsl::status_after_probe(&host, &bundle, detected).await?,
        }
    };
    Ok((bundle, Some(status)))
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
    // 主機的三個期間掃完才掃 WSL（仍然序列）；錨點留主機的期間，WSL 另外凍結。
    let (bundle, status) = wsl_part(source, cfg, WslMode::Fresh, cancel).await?;
    let bundle = bundle.into_owned();
    let merge = |host: &Period, part: &Period| {
        wsl::with_wsl(cfg.projects_enabled, host.clone(), Some(part))
    };
    let summary = summary_of(
        cfg,
        collected_at,
        merge(&today, &bundle.today),
        merge(&month, &bundle.month),
        merge(&all_time, &bundle.all_time),
        status.clone(),
    );
    let anchor = Anchor {
        date_key: summary.period_windows.today.key.clone(),
        today,
        month,
        all_time,
        wsl: WslSnapshot {
            bundle: Some(bundle),
            status,
        },
        full_scan_at: std::time::Instant::now(),
    };
    Ok(Collected {
        summary,
        anchor: Some(anchor),
        wsl_refresh: None,
        sync_reports,
    })
}

/// anchored tick：只掃 `--today`，month / allTime = 錨點 + (新 today − 錨點 today)。
///
/// `self_sync`：定時的 anchored tick 要（Cursor / Antigravity 的 cache 由同步產生、沒有檔案事件），
/// 檔案變動觸發的 tick 不要（3–5 秒的承諾禁不起 Antigravity 最多 30 秒的同步）。
/// `refresh_wsl`：定時的 anchored tick 重新掃 WSL（5 分鐘太久，不能讓 WSL 一直停在錨點），
/// 檔案變動觸發的沿用凍結的快照。delta 只作用在主機的期間上，WSL 在最後才加。
/// 呼叫端負責確認錨點屬於今天（`Anchor::usable_on`）；跨日時必須改跑 `collect_once`。
pub async fn collect_anchored(
    source: &ScanSource,
    cfg: &CollectorConfig,
    anchor: &Anchor,
    self_sync: bool,
    refresh_wsl: bool,
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
    let mode = if refresh_wsl {
        WslMode::Fresh
    } else {
        WslMode::Frozen(&anchor.wsl)
    };
    let (bundle, status) = wsl_part(source, cfg, mode, cancel).await?;
    let p = cfg.projects_enabled;
    let summary = summary_of(
        cfg,
        collected_at,
        wsl::with_wsl(p, today, Some(&bundle.today)),
        wsl::with_wsl(p, month, Some(&bundle.month)),
        wsl::with_wsl(p, all_time, Some(&bundle.all_time)),
        status.clone(),
    );
    let wsl_refresh = refresh_wsl.then(|| WslSnapshot {
        bundle: Some(bundle.into_owned()),
        status,
    });
    Ok(Collected {
        summary,
        anchor: None,
        wsl_refresh,
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
            wsl_scan_enabled: true,
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
        assert_eq!(s.wsl_status, None, "no wsl.json: a source without WSL");
    }

    // ---- WSL（假的 WSL 環境：固定 JSON 目錄裡的 wsl.json）----

    const ALICE: &str = r"\\wsl$\Ubuntu\home\alice";
    const ROOT: &str = r"\\wsl$\Ubuntu\root";

    fn rows(client: &str, session: &str, tokens: i64) -> Value {
        json!({ "entries": [{ "client": client, "sessionId": session, "model": "m", "input": tokens }] })
    }

    fn write_host(dir: &std::path::Path, today: i64, month: i64, all_time: i64) {
        for (stem, tokens) in [("today", today), ("month", month), ("alltime", all_time)] {
            std::fs::write(
                dir.join(format!("{stem}.json")),
                rows("claude", "s", tokens).to_string(),
            )
            .unwrap();
        }
    }

    /// alice 有 Claude（有用量）與 Hermes（只有標記），root 有 Codex。
    fn write_wsl(dir: &std::path::Path, running: &[&str], alice: [i64; 3]) {
        let scans = |client: &str, session: &str, t: [i64; 3]| json!({ "today": rows(client, session, t[0]), "month": rows(client, session, t[1]), "alltime": rows(client, session, t[2]) });
        let wsl = json!({
            "installed": true,
            "running": running,
            "paths": [
                format!(r"{ALICE}\.claude\projects\repo\w.jsonl"),
                format!(r"{ALICE}\.hermes\state.db"),
                format!(r"{ROOT}\.codex\sessions"),
            ],
            "scans": { ALICE: scans("claude", "w", alice), ROOT: scans("codex", "r", [5, 6, 7]) },
        });
        std::fs::write(dir.join(wsl::FIXTURE_FILE), wsl.to_string()).unwrap();
    }

    fn wsl_cfg(enabled: bool) -> CollectorConfig {
        CollectorConfig {
            tracked_clients: vec!["claude".into(), "codex".into(), "hermes".into()],
            all_time_since: "2024-01-01".into(),
            projects_enabled: true,
            history_enabled: true,
            wsl_scan_enabled: enabled,
        }
    }

    fn totals(s: &UsageSummary) -> [i64; 3] {
        [
            s.today.total_tokens,
            s.month.total_tokens,
            s.all_time.total_tokens,
        ]
    }

    async fn full(dir: &std::path::Path, cfg: &CollectorConfig) -> Collected {
        collect_once(
            &ScanSource::Fixtures(dir.into()),
            cfg,
            false,
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn a_full_scan_adds_wsl_to_every_period_but_anchors_host_periods_only() {
        let dir = tempfile::tempdir().unwrap();
        write_host(dir.path(), 1, 10, 100);
        write_wsl(dir.path(), &["Ubuntu"], [1000, 2000, 3000]);
        let collected = full(dir.path(), &wsl_cfg(true)).await;
        let s = &collected.summary;
        assert_eq!(totals(s), [1006, 2016, 3107]);
        assert_eq!(
            s.wsl_status,
            Some(WslStatus {
                state: WslState::Active,
                detected: vec!["claude".into(), "hermes".into(), "codex".into()],
                with_data: vec!["claude".into(), "codex".into()],
            })
        );
        assert_ne!(
            s.client_status["hermes"],
            ClientStatus::Missing,
            "a tool found only inside WSL is installed"
        );
        assert!(s.all_time.sessions.contains_key("claude:w"));
        let anchor = collected.anchor.expect("a full scan anchors");
        assert_eq!(
            [
                anchor.today.total_tokens,
                anchor.month.total_tokens,
                anchor.all_time.total_tokens
            ],
            [1, 10, 100]
        );
        let bundle = anchor.wsl.bundle.expect("the WSL snapshot is frozen");
        assert_eq!(bundle.today.total_tokens, 1005);
        assert_eq!(anchor.wsl.status, s.wsl_status);
    }

    #[tokio::test]
    async fn anchored_ticks_freeze_wsl_unless_they_refresh_it() {
        let dir = tempfile::tempdir().unwrap();
        write_host(dir.path(), 1, 10, 100);
        write_wsl(dir.path(), &["Ubuntu"], [1000, 2000, 3000]);
        let cfg = wsl_cfg(true);
        let anchor = full(dir.path(), &cfg).await.anchor.unwrap();
        // 主機 today +2；WSL 裡的 Claude 也多了，但檔案變動觸發的 tick 不重新掃 WSL。
        write_host(dir.path(), 3, 10, 100);
        write_wsl(dir.path(), &["Ubuntu"], [9000, 9500, 9900]);
        let source = ScanSource::Fixtures(dir.path().into());
        let cancel = CancellationToken::new();
        let watch = collect_anchored(&source, &cfg, &anchor, false, false, &cancel)
            .await
            .unwrap();
        assert_eq!(totals(&watch.summary), [3 + 1005, 12 + 2006, 102 + 3007]);
        assert_eq!(watch.summary.wsl_status, anchor.wsl.status);
        assert!(watch.wsl_refresh.is_none() && watch.anchor.is_none());

        // 定時的 anchored tick：主機仍是精確 delta，WSL 重新掃。
        let timed = collect_anchored(&source, &cfg, &anchor, true, true, &cancel)
            .await
            .unwrap();
        assert_eq!(totals(&timed.summary), [3 + 9005, 12 + 9506, 102 + 9907]);
        let refreshed = timed
            .wsl_refresh
            .expect("the new snapshot replaces the frozen one");
        assert_eq!(refreshed.bundle.unwrap().month.total_tokens, 9506);

        // WSL 停了：定時 tick 的探測看得到，WSL 的部分變成空的。
        write_wsl(dir.path(), &[], [9000, 9500, 9900]);
        let stopped = collect_anchored(&source, &cfg, &anchor, true, true, &cancel)
            .await
            .unwrap();
        assert_eq!(totals(&stopped.summary), [3, 12, 102]);
        assert_eq!(
            stopped.summary.wsl_status,
            Some(WslStatus::empty(WslState::NotRunning))
        );
    }

    #[tokio::test]
    async fn wsl_status_follows_the_setting_and_the_platform() {
        let dir = tempfile::tempdir().unwrap();
        write_host(dir.path(), 1, 10, 100);
        write_wsl(dir.path(), &["Ubuntu"], [1000, 2000, 3000]);
        let off = full(dir.path(), &wsl_cfg(false)).await;
        assert_eq!(totals(&off.summary), [1, 10, 100]);
        assert_eq!(
            off.summary.wsl_status,
            Some(WslStatus::empty(WslState::Disabled))
        );

        let untracked = CollectorConfig {
            tracked_clients: Vec::new(),
            ..wsl_cfg(true)
        };
        assert_eq!(full(dir.path(), &untracked).await.summary.wsl_status, None);

        let mut fixture: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(wsl::FIXTURE_FILE)).unwrap())
                .unwrap();
        fixture["installed"] = json!(false);
        std::fs::write(dir.path().join(wsl::FIXTURE_FILE), fixture.to_string()).unwrap();
        let absent = full(dir.path(), &wsl_cfg(true)).await;
        assert_eq!(totals(&absent.summary), [1, 10, 100]);
        assert_eq!(
            absent.summary.wsl_status,
            Some(WslStatus::empty(WslState::NotInstalled))
        );

        // 在跑但沒有任何工具的資料：no-data。
        std::fs::write(
            dir.path().join(wsl::FIXTURE_FILE),
            json!({ "installed": true, "running": ["Ubuntu"], "paths": [r"\\wsl$\Ubuntu\home\bob\notes"] })
                .to_string(),
        )
        .unwrap();
        assert_eq!(
            full(dir.path(), &wsl_cfg(true)).await.summary.wsl_status,
            Some(WslStatus::empty(WslState::NoData))
        );
    }

    #[tokio::test]
    async fn the_persisted_anchor_keeps_the_wsl_snapshot_apart() {
        let dir = tempfile::tempdir().unwrap();
        write_host(dir.path(), 1, 10, 100);
        write_wsl(dir.path(), &["Ubuntu"], [1000, 2000, 3000]);
        let cfg = wsl_cfg(true);
        let anchor = full(dir.path(), &cfg).await.anchor.unwrap();
        let path = dir.path().join(ANCHOR_FILE);
        anchor.save(&path, &cfg).unwrap();
        let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["today"]["totalTokens"], 1);
        assert_eq!(saved["wslBundle"]["allTime"]["totalTokens"], 3007);
        assert_eq!(saved["wslStatus"]["state"], "active");

        let (loaded, at) = Anchor::load(&path, &cfg, &anchor.date_key).unwrap();
        assert_eq!(loaded.wsl, anchor.wsl);
        // 開機畫面：同一天的錨點，三個期間都加上 WSL。
        let seed = loaded.to_summary(&cfg, at.unwrap().with_timezone(&Local), true);
        assert_eq!(totals(&seed), [1006, 2016, 3107]);
        assert_eq!(seed.wsl_status, anchor.wsl.status);
        assert_eq!(
            loaded
                .to_summary(&cfg, at.unwrap().with_timezone(&Local), false)
                .wsl_status,
            None,
            "a platform without WSL reports no status"
        );

        // 關掉 WSL 掃描：錨點照樣可用（指紋不含這個開關），但不讀回凍結的 WSL。
        let off = wsl_cfg(false);
        let (loaded, at) = Anchor::load(&path, &off, &anchor.date_key).unwrap();
        assert_eq!(loaded.wsl, WslSnapshot::default());
        let seed = loaded.to_summary(&off, at.unwrap().with_timezone(&Local), true);
        assert_eq!(totals(&seed), [1, 10, 100]);
        assert_eq!(seed.wsl_status, Some(WslStatus::empty(WslState::Disabled)));

        // 舊版的檔案沒有 WSL 欄位。
        let mut old = saved.clone();
        old.as_object_mut().unwrap().remove("wslBundle");
        old.as_object_mut().unwrap().remove("wslStatus");
        std::fs::write(&path, old.to_string()).unwrap();
        let (loaded, _) = Anchor::load(&path, &cfg, &anchor.date_key).unwrap();
        assert_eq!(loaded.wsl, WslSnapshot::default());
    }
}
