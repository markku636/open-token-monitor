//! 裝置 runtime：掃描 → 裝置狀態 → 上傳節奏 → 上傳佇列（上游 deviceRuntime.js +
//! src/agent/runtime.js + collector.js `startCollector`）。GUI 與 `tm-agent run` 共用；
//! `tm-agent once` 用 `run_once`。
//!
//! 掃描有兩種（collector/mod.rs）：
//! - **完整**：today → month → allTime 序列掃描，結果同時成為錨點（也寫到 `collector-anchor.json`）。
//!   手動重掃、換日、錨點超過一小時（上游 FULL_SCAN_INTERVAL_MS），以及啟動時沒有今天可用的
//!   持久化錨點時跑。
//! - **anchored**：只掃 `--today`，其餘以精確 delta 推出。來源檔案有變動（watch，防抖後）
//!   或定時（`collectionIntervalMs`）時跑；定時的那種順便做 Cursor / Antigravity 自我同步。
//!
//! 檔案事件的防抖是尾端 `watchDebounceMs`；到點時若有 tick 正在跑就重新計時，而不是排在
//! 它後面接著跑（上游 `scheduleTick`）。**沒有冷卻時間**：產品承諾 3–5 秒內更新。
//! 定時 tick 的時間表不受 watch tick 影響，否則一直有事件時 Cursor 永遠等不到同步。
//!
//! history（`tokscale graph`，上游 collector.js `collectHistoryOnce`）在用量發佈**之後**、同一個
//! tick 裡序列地跑，不拖慢 3–5 秒的即時更新，也不與用量掃描並行。第一個 tick、手動重掃、換日時一定跑，
//! 其他 tick 每 `historyIntervalMs` 跑一次；換日那次失敗就在 60 秒後補跑一次（上游
//! `settleRolloverHistoryAttempt`），之後回到一般間隔。
//!
//! session usage archive（usage/archive.rs）在收集之後、發佈之前套用：記住這次的 session，再把
//! client 已經刪掉的補回來。錨點是套用前的原始結果，精確 delta 不受影響。
//!
//! 上傳節奏（`syncUploadIntervalMs`）：
//! - `0`：每次有新 record 就送（即時）。
//! - 其他：第一筆立刻送（裝好馬上出現在 dashboard），之後每個間隔送一次最新的 record。
//! - 關閉時若有還沒送的 record，最後送一次（最多等 5 秒），下班關機前的用量才不會少算。
//!
//! 設定改變時由呼叫端停掉舊 runtime、用新設定重建；runtime 本身的設定不可變。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, Notify};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::events::{CoreEvent, ErrorInfo, EventSink};
use super::sink::{OrderedSink, SendFn};
use super::state::{DeviceState, Published};
use crate::collector::watch::{self, WatchRoot};
use crate::collector::{
    collect_anchored, collect_history, collect_once, local_today_key, Anchor, Collected,
    CollectorConfig, ProgressFn, ScanProgress, ScanSource,
};
use crate::error::{AppError, AppResult};
use crate::hub::IngestOutcome;
use crate::limits::runtime::{LimitsConfig, LimitsRuntime, LimitsWake};
use crate::usage::archive::CaptureAt;
use crate::usage::archive_store::ArchiveStore;
use crate::wire::time::iso_millis;
use crate::wire::{DeviceRecord, Envelope, UsageSummary};

const FINAL_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);
/// 錨點再怎麼有效，也至少每小時完整掃一次，補上 delta 看不到的變化（上游 FULL_SCAN_INTERVAL_MS）。
pub const FULL_SCAN_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// 換日的 history 掃描失敗後補跑一次的延遲（上游 `historyRetryMs`）。
pub const HISTORY_ROLLOVER_RETRY: Duration = Duration::from_secs(60);

/// 檔案監看的設定；`None` = 只靠定時 tick。
#[derive(Debug, Clone)]
pub struct WatchConfig {
    pub roots: Vec<WatchRoot>,
    pub debounce: Duration,
}

impl WatchConfig {
    /// GUI 與 tm-agent 共用：依設定的追蹤工具與額外掃描目錄決定監看哪些目錄。
    pub fn from_settings(settings: &crate::settings::Settings) -> Option<WatchConfig> {
        if !settings.watch_enabled {
            return None;
        }
        let home = dirs::home_dir()?;
        Some(WatchConfig {
            roots: watch::watch_roots(
                &settings.tracked_clients,
                &settings.custom_scan_paths,
                &home,
            ),
            debounce: Duration::from_millis(settings.watch_debounce_ms),
        })
    }
}

pub struct RuntimeConfig {
    pub envelope: Envelope,
    pub collector: CollectorConfig,
    pub source: ScanSource,
    pub collection_interval: Duration,
    pub upload_interval_ms: u64,
    /// `None` = 只做本機統計（沒有設定 hub 的 dev 建置）。
    pub sender: Option<SendFn>,
    pub events: EventSink,
    pub watch: Option<WatchConfig>,
    /// history 的 graph 掃描間隔（`collector.history_enabled` 關閉時不用）。
    pub history_interval: Duration,
    /// session usage archive 的 SQLite 檔；`None` = 關閉。
    pub session_archive: Option<std::path::PathBuf>,
    /// 是否把 archive 的變動寫回檔案；dry run 為 false（只讀、照樣補回）。
    pub archive_writes: bool,
    /// 持久化的錨點（`collector-anchor.json`）；`None` = 不讀不寫（`once` 與 dry run，上游
    /// `anchorPersistenceEnabled: !once && !dryRun`）。
    pub anchor_file: Option<std::path::PathBuf>,
    /// `None` = 不探測額度（關閉，或測試用的固定 JSON 來源）。
    pub limits: Option<LimitsConfig>,
    /// 完整掃描中 today（與 month）掃完就先發佈（上游 `progressive: true`，只有 widget 開）。
    pub progressive: bool,
    /// 冷啟動時先以持久化錨點填畫面（上游 main.js `primeLocalStatsFromAnchor`）。
    /// 已經有數字的重啟（改設定）不要：那些數字比錨點新。
    pub seed_from_anchor: bool,
}

#[derive(Debug, Clone, Default)]
pub struct CollectStatus {
    pub last_collect_at: Option<String>,
    pub last_error: Option<ErrorInfo>,
    pub collecting: bool,
}

/// 為什麼跑這次 tick；決定完整或 anchored（`plan_tick`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TickReason {
    Startup,
    Interval,
    Manual,
    Watch,
    Once,
    /// 換日的 history 掃描失敗後的補跑。
    HistoryRetry,
}

impl TickReason {
    pub fn as_str(self) -> &'static str {
        match self {
            TickReason::Startup => "startup",
            TickReason::Interval => "interval",
            TickReason::Manual => "manual",
            TickReason::Watch => "watch",
            TickReason::Once => "once",
            TickReason::HistoryRetry => "history-rollover-retry",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TickPlan {
    Full,
    Anchored { self_sync: bool },
}

/// 上游 collector.js `loop` / `scheduleTick` 的決策，抽成純函式方便測試。
pub fn plan_tick(
    reason: TickReason,
    anchor: Option<(&str, Duration)>,
    today_key: &str,
) -> TickPlan {
    let usable = |max_age: Option<Duration>| match anchor {
        Some((key, age)) => key == today_key && max_age.is_none_or(|m| age < m),
        None => false,
    };
    match reason {
        TickReason::Manual | TickReason::Once => TickPlan::Full,
        // 重開程式後有今天、一小時內的持久化錨點：只掃 today（上游 startCollector 讀回錨點）。
        TickReason::Startup if usable(Some(FULL_SCAN_INTERVAL)) => {
            TickPlan::Anchored { self_sync: true }
        }
        TickReason::Startup => TickPlan::Full,
        TickReason::Watch | TickReason::HistoryRetry if usable(None) => {
            TickPlan::Anchored { self_sync: false }
        }
        TickReason::Interval if usable(Some(FULL_SCAN_INTERVAL)) => {
            TickPlan::Anchored { self_sync: true }
        }
        _ => TickPlan::Full,
    }
}

/// 這個 tick 要不要順便掃 history（上游 `shouldIncludeHistory`）。
pub fn should_include_history(
    enabled: bool,
    reason: TickReason,
    rolled_over: bool,
    since_last: Option<Duration>,
    interval: Duration,
) -> bool {
    if !enabled {
        return false;
    }
    let forced = rolled_over
        || matches!(
            reason,
            TickReason::Startup | TickReason::Manual | TickReason::Once | TickReason::HistoryRetry
        );
    forced || since_last.is_none_or(|elapsed| elapsed >= interval)
}

pub struct DeviceRuntime {
    state: Mutex<DeviceState>,
    collector: CollectorConfig,
    source: ScanSource,
    collection_interval: Duration,
    upload_interval_ms: u64,
    sink: Option<OrderedSink>,
    events: EventSink,
    cancel: CancellationToken,
    rescan: Notify,
    watch_fire: Notify,
    tick_in_flight: AtomicBool,
    anchor: Mutex<Option<Anchor>>,
    last_enqueued: AtomicU64,
    status: Mutex<CollectStatus>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    watcher: Mutex<Option<watch::Watcher>>,
    /// 監看的候選根目錄與事件通道；完整掃描後據此重新監看新出現的目錄。
    watch_roots: Mutex<Option<(Vec<WatchRoot>, mpsc::UnboundedSender<()>)>>,
    limits: Option<LimitsConfig>,
    limits_refresh: Notify,
    history_interval: Duration,
    /// 上一次**嘗試** history 的時間（失敗也算，上游 `lastHistoryAt`）。
    last_history_at: Mutex<Option<Instant>>,
    history_retry: Notify,
    archive: Mutex<Option<ArchiveStore>>,
    /// daily history archive 的 JSON 檔（與 session archive 同一個開關、同一個目錄）。
    history_archive: Option<std::path::PathBuf>,
    archive_writes: bool,
    anchor_file: Option<std::path::PathBuf>,
    progressive: bool,
}

impl DeviceRuntime {
    fn build(cfg: RuntimeConfig, sink: Option<OrderedSink>) -> DeviceRuntime {
        let restored = cfg.anchor_file.as_deref().and_then(|path| {
            let today = local_today_key(chrono::Local::now());
            let anchor = Anchor::load(path, &cfg.collector, &today);
            if anchor.is_some() {
                tracing::info!(
                    "restored today's collector anchor; the first tick scans today only"
                );
            }
            anchor
        });
        let seed = restored
            .as_ref()
            .filter(|_| cfg.seed_from_anchor)
            .and_then(|(anchor, at)| {
                at.map(|at| anchor.to_summary(&cfg.collector, at.with_timezone(&chrono::Local)))
            });
        let rt = DeviceRuntime {
            state: Mutex::new(DeviceState::new(cfg.envelope, cfg.upload_interval_ms)),
            collector: cfg.collector,
            source: cfg.source,
            collection_interval: cfg.collection_interval,
            upload_interval_ms: cfg.upload_interval_ms,
            sink,
            events: cfg.events,
            cancel: CancellationToken::new(),
            rescan: Notify::new(),
            watch_fire: Notify::new(),
            tick_in_flight: AtomicBool::new(false),
            anchor: Mutex::new(restored.map(|(anchor, _)| anchor)),
            last_enqueued: AtomicU64::new(0),
            status: Mutex::new(CollectStatus::default()),
            tasks: Mutex::new(Vec::new()),
            watcher: Mutex::new(None),
            watch_roots: Mutex::new(None),
            limits: cfg.limits,
            limits_refresh: Notify::new(),
            history_interval: cfg.history_interval,
            last_history_at: Mutex::new(None),
            history_retry: Notify::new(),
            history_archive: cfg.session_archive.as_deref().and_then(|p| {
                p.parent()
                    .map(|d| d.join(crate::usage::history_archive::HISTORY_ARCHIVE_FILE))
            }),
            archive_writes: cfg.archive_writes,
            anchor_file: cfg.anchor_file.clone(),
            progressive: cfg.progressive,
            archive: Mutex::new(cfg.session_archive.as_deref().and_then(|path| {
                let opened = if cfg.archive_writes || path.exists() {
                    ArchiveStore::open(path)
                } else {
                    ArchiveStore::open_in_memory()
                };
                match opened {
                    Ok(mut store) => {
                        store.set_read_only(!cfg.archive_writes);
                        tracing::info!(sessions = store.len(), "session usage archive loaded");
                        Some(store)
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "session usage archive unavailable");
                        None
                    }
                }
            })),
        };
        if let Some(summary) = seed {
            // 與真正的 record 一樣先補上 archive（唯讀：幾小時前的錨點不是新的觀察）。
            let summary = rt.archive_projection(summary, false);
            let record = rt.state.lock().unwrap().seed(summary);
            (rt.events)(CoreEvent::RecordPublished {
                revision: 0,
                record,
            });
        }
        rt
    }

    /// 執行一次額度的醒來（完整、重置點、提早或重試），把結果交給裝置狀態（第一筆用量出現前會先緩衝，
    /// 見 device/state.rs），回傳下一次醒來前要等多久、要做什麼。全部延後（退避中）時摘要不變、不發佈。
    async fn run_limits_round(
        &self,
        lr: &mut LimitsRuntime,
        wake: LimitsWake,
    ) -> (Duration, LimitsWake) {
        let probed = lr.run(wake).await;
        let now = chrono::Utc::now();
        let now_ms = now.timestamp_millis();
        let (at_ms, next) = lr.next_wake(now_ms);
        let next_at = chrono::DateTime::from_timestamp_millis(at_ms).unwrap_or(now);
        (self.events)(CoreEvent::LimitsUpdated {
            summary: lr.summary().clone(),
            next_at: iso_millis(next_at),
        });
        if let Some(summary) = probed {
            let published = self.state.lock().unwrap().update_limits(summary);
            if let Some(p) = published {
                self.after_publish(&p);
            }
        }
        (Duration::from_millis((at_ms - now_ms).max(0) as u64), next)
    }

    /// 要求立刻重新探測額度（設定頁、tray）。本機用量變動**不**呼叫這個。
    pub fn request_limits_refresh(&self) {
        self.limits_refresh.notify_one();
    }

    /// 啟動背景迴圈（必須在 tokio runtime 內呼叫）。
    pub fn start(cfg: RuntimeConfig) -> Arc<DeviceRuntime> {
        let sink = cfg
            .sender
            .clone()
            .map(|send| OrderedSink::start(send, cfg.events.clone(), None));
        let watch_cfg = cfg.watch.clone();
        let rt = Arc::new(DeviceRuntime::build(cfg, sink));

        let collect = {
            let rt = rt.clone();
            tokio::spawn(async move {
                let mut reason = TickReason::Startup;
                let mut next_interval = tokio::time::Instant::now() + rt.collection_interval;
                loop {
                    let _ = rt.do_tick(reason).await;
                    // watch tick 不重設定時表（見檔頭）；其他 tick 都掃過全部 client，從現在重新計時。
                    if !matches!(reason, TickReason::Watch | TickReason::HistoryRetry) {
                        next_interval = tokio::time::Instant::now() + rt.collection_interval;
                    }
                    tokio::select! {
                        _ = tokio::time::sleep_until(next_interval) => reason = TickReason::Interval,
                        _ = rt.rescan.notified() => reason = TickReason::Manual,
                        _ = rt.watch_fire.notified() => reason = TickReason::Watch,
                        _ = rt.history_retry.notified() => reason = TickReason::HistoryRetry,
                        _ = rt.cancel.cancelled() => break,
                    }
                }
            })
        };
        let mut tasks = vec![collect];
        if let Some(wc) = watch_cfg {
            if let Some(task) = rt.clone().start_watching(wc) {
                tasks.push(task);
            }
        }
        if let Some(lc) = rt.limits.clone() {
            // 額度只由啟動、定時、重置點、（自適應時）額度本身的消耗速度與手動觸發；
            // 絕不跟著本機用量（上游 limits/runtime.js 的規則）。序列執行：一次醒來探測完才排下一次。
            let rt3 = rt.clone();
            tasks.push(tokio::spawn(async move {
                let mut lr = LimitsRuntime::new(lc);
                let mut wake = LimitsWake::Full;
                loop {
                    let (wait, next) = tokio::select! {
                        r = rt3.run_limits_round(&mut lr, wake) => r,
                        _ = rt3.cancel.cancelled() => break,
                    };
                    wake = tokio::select! {
                        _ = tokio::time::sleep(wait) => next,
                        _ = rt3.limits_refresh.notified() => LimitsWake::Full,
                        _ = rt3.cancel.cancelled() => break,
                    };
                }
            }));
        }
        if rt.sink.is_some() && rt.upload_interval_ms > 0 {
            let rt2 = rt.clone();
            tasks.push(tokio::spawn(async move {
                let period = Duration::from_millis(rt2.upload_interval_ms);
                loop {
                    let next = chrono::Utc::now()
                        + chrono::Duration::milliseconds(rt2.upload_interval_ms as i64);
                    (rt2.events)(CoreEvent::UploadScheduled {
                        next_at: iso_millis(next),
                    });
                    tokio::select! {
                        _ = tokio::time::sleep(period) => rt2.enqueue_latest_if_new(),
                        _ = rt2.cancel.cancelled() => break,
                    }
                }
            }));
        }
        *rt.tasks.lock().unwrap() = tasks;
        rt
    }

    /// 以目前存在的根目錄（重新）建立 notify watcher。監看不了就回報，只靠定時 tick。
    fn arm_watcher(&self, roots: &[WatchRoot], tx: mpsc::UnboundedSender<()>) {
        match watch::start(roots.to_vec(), move || {
            let _ = tx.send(());
        }) {
            Ok(w) => {
                tracing::info!(roots = w.watched.len(), "watching source dirs");
                (self.events)(CoreEvent::WatcherReady {
                    roots: w.watched.iter().map(|p| p.display().to_string()).collect(),
                });
                *self.watcher.lock().unwrap() = Some(w);
            }
            Err(error) => {
                tracing::warn!(%error, "file watching unavailable; interval ticks only");
                self.watcher.lock().unwrap().take();
                (self.events)(CoreEvent::WatcherUnavailable { error });
            }
        }
    }

    /// 完整掃描後：工具的資料夾在啟動之後才出現（或消失）時重新監看，新工具不必等到重開程式才有
    /// 即時更新（上游 collector.js 在 full tick 後的 `setupWatchers`）。
    fn rearm_watcher_if_roots_changed(&self) {
        let guard = self.watch_roots.lock().unwrap();
        let Some((roots, tx)) = guard.as_ref() else {
            return;
        };
        let mut existing: Vec<std::path::PathBuf> = roots
            .iter()
            .filter(|r| r.dir.exists())
            .map(|r| r.dir.clone())
            .collect();
        let mut current = self
            .watcher
            .lock()
            .unwrap()
            .as_ref()
            .map(|w| w.watched.clone())
            .unwrap_or_default();
        existing.sort();
        existing.dedup();
        current.sort();
        current.dedup();
        if existing == current {
            return;
        }
        tracing::info!(
            before = current.len(),
            now = existing.len(),
            "source dirs changed; re-arming the watcher"
        );
        self.arm_watcher(roots, tx.clone());
    }

    /// 啟動檔案監看與防抖任務。一開始一個目錄都沒有也照樣起防抖任務，之後出現的目錄才接得上。
    fn start_watching(self: Arc<Self>, wc: WatchConfig) -> Option<JoinHandle<()>> {
        let (tx, mut rx) = mpsc::unbounded_channel::<()>();
        self.arm_watcher(&wc.roots, tx.clone());
        *self.watch_roots.lock().unwrap() = Some((wc.roots.clone(), tx));
        let debounce = wc.debounce;
        Some(tokio::spawn(async move {
            loop {
                tokio::select! {
                    got = rx.recv() => if got.is_none() { break },
                    _ = self.cancel.cancelled() => break,
                }
                // 尾端防抖：安靜滿 `debounce` 才觸發；到點時有 tick 在跑就重新計時。
                loop {
                    tokio::select! {
                        got = rx.recv() => if got.is_none() { return },
                        _ = tokio::time::sleep(debounce) => {
                            if !self.tick_in_flight.load(Ordering::SeqCst) {
                                break;
                            }
                        }
                        _ = self.cancel.cancelled() => return,
                    }
                }
                self.watch_fire.notify_one();
            }
        }))
    }

    fn enqueue_latest_if_new(&self) {
        let Some(sink) = &self.sink else { return };
        let Some((revision, record)) = self.state.lock().unwrap().snapshot() else {
            return;
        };
        if revision > self.last_enqueued.load(Ordering::SeqCst) {
            self.last_enqueued.store(revision, Ordering::SeqCst);
            sink.enqueue(revision, record);
        }
    }

    fn after_publish(&self, published: &Published) {
        (self.events)(CoreEvent::RecordPublished {
            revision: published.revision,
            record: published.record.clone(),
        });
        let Some(sink) = &self.sink else { return };
        let first = self.last_enqueued.load(Ordering::SeqCst) == 0;
        if self.upload_interval_ms == 0 || first {
            self.last_enqueued
                .store(published.revision, Ordering::SeqCst);
            sink.enqueue(published.revision, published.record.clone());
        }
    }

    async fn collect(&self, reason: TickReason) -> AppResult<Collected> {
        let today_key = local_today_key(chrono::Local::now());
        let anchor = self.anchor.lock().unwrap().clone();
        let plan = plan_tick(
            reason,
            anchor
                .as_ref()
                .map(|a| (a.date_key.as_str(), a.full_scan_at.elapsed())),
            &today_key,
        );
        match (plan, &anchor) {
            (TickPlan::Anchored { self_sync }, Some(anchor)) if anchor.usable_on(&today_key) => {
                collect_anchored(
                    &self.source,
                    &self.collector,
                    anchor,
                    self_sync,
                    &self.cancel,
                )
                .await
            }
            _ => {
                let preview = |p: ScanProgress<'_>| self.publish_preview(p, anchor.as_ref());
                let collected = collect_once(
                    &self.source,
                    &self.collector,
                    reason == TickReason::Manual,
                    self.progressive.then_some(&preview as ProgressFn<'_>),
                    &self.cancel,
                )
                .await?;
                let anchor = Anchor::from_summary(&collected.summary);
                if let Some(path) = &self.anchor_file {
                    if let Err(e) = anchor.save(path, &self.collector) {
                        tracing::warn!(error = %e, "collector anchor write failed");
                    }
                }
                *self.anchor.lock().unwrap() = Some(anchor);
                self.rearm_watcher_if_roots_changed();
                Ok(collected)
            }
        }
    }

    /// 完整掃描中的預覽（上游 `onPreview`）：today（與 month）是剛掃到的；其餘由今天的錨點
    /// 以精確 delta 推出，與 anchored tick 同一條算式；錨點不能用（跨日）就沿用上一筆。
    /// 兩者都沒有時不發佈（上游 deviceState `hasCompleteUsageBaseline`）：只有 today 的
    /// record 會讓 month / allTime 顯示成 0。預覽只補 archive、不寫：最後的結果會寫。
    fn publish_preview(&self, p: ScanProgress<'_>, anchor: Option<&Anchor>) {
        let today_key = local_today_key(p.collected_at);
        let (month, all_time) = match anchor.filter(|a| a.usable_on(&today_key)) {
            Some(anchor) => {
                let (month, all_time) = anchor.periods_with(&self.collector, p.today);
                (p.month.cloned().unwrap_or(month), all_time)
            }
            None => {
                let state = self.state.lock().unwrap();
                let Some(base) = state.baseline() else {
                    return;
                };
                (
                    p.month.cloned().unwrap_or_else(|| base.month.clone()),
                    base.all_time.clone(),
                )
            }
        };
        let summary = crate::collector::summary_of(
            &self.collector,
            p.collected_at,
            p.today.clone(),
            month,
            all_time,
        );
        let summary = self.archive_projection(summary, false);
        let published = self.state.lock().unwrap().update_usage(summary);
        self.after_publish(&published);
    }

    /// 記住這次的 session，再把 client 刪掉的補回來（上游 agent.js `summaryWithSessionUsageArchive`）。
    fn with_archive(&self, summary: UsageSummary) -> UsageSummary {
        self.archive_projection(summary, true)
    }

    /// `capture` = 同時記下這次的觀察；預覽與開機畫面只補不記。
    fn archive_projection(&self, mut summary: UsageSummary, capture: bool) -> UsageSummary {
        let mut guard = self.archive.lock().unwrap();
        let Some(store) = guard.as_mut() else {
            return summary;
        };
        let at = chrono::DateTime::parse_from_rfc3339(&summary.updated_at)
            .map(|d| CaptureAt::from_local(d.with_timezone(&chrono::Local)))
            .unwrap_or_else(|_| CaptureAt::from_local(chrono::Local::now()));
        if capture {
            if let Err(e) = store.capture(&summary, &at) {
                tracing::warn!(error = %e, "session usage archive update failed");
            }
        }
        let added = store.apply(&mut summary, &at);
        if added > 0 && self.collector.projects_enabled {
            for period in [
                &mut summary.today,
                &mut summary.month,
                &mut summary.all_time,
            ] {
                crate::usage::projects::apply_project_rollups(period);
            }
        }
        summary
    }

    async fn do_tick(self: &Arc<Self>, reason: TickReason) -> AppResult<Published> {
        self.tick_in_flight.store(true, Ordering::SeqCst);
        let result = self.do_tick_with_history(reason).await;
        self.tick_in_flight.store(false, Ordering::SeqCst);
        result
    }

    async fn do_tick_with_history(self: &Arc<Self>, reason: TickReason) -> AppResult<Published> {
        let today_key = local_today_key(chrono::Local::now());
        let rolled_over = self
            .anchor
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|a| !a.usable_on(&today_key));
        let include_history = {
            let mut last = self.last_history_at.lock().unwrap();
            let include = should_include_history(
                self.collector.history_enabled,
                reason,
                rolled_over,
                last.map(|t| t.elapsed()),
                self.history_interval,
            );
            if include {
                *last = Some(Instant::now());
            }
            include
        };
        let published = self.do_tick_inner(reason).await?;
        if !include_history {
            return Ok(published);
        }
        match self.collect_history_step(&today_key).await {
            Ok(Some(p)) => Ok(p),
            Ok(None) | Err(AppError::Stopped) => Ok(published),
            Err(_) => {
                if rolled_over && reason != TickReason::HistoryRetry {
                    let rt = self.clone();
                    tokio::spawn(async move {
                        tokio::select! {
                            _ = tokio::time::sleep(HISTORY_ROLLOVER_RETRY) => rt.history_retry.notify_one(),
                            _ = rt.cancel.cancelled() => {}
                        }
                    });
                }
                Ok(published)
            }
        }
    }

    /// 掃 history 並發佈。`Ok(None)` = graph 沒有任何一天（不送 history）。
    async fn collect_history_step(&self, today_key: &str) -> AppResult<Option<Published>> {
        let started = Instant::now();
        match collect_history(
            &self.source,
            &self.collector,
            today_key,
            self.history_archive
                .as_deref()
                .map(|p| (p, self.archive_writes)),
            &self.cancel,
        )
        .await
        {
            Ok(Some(history)) => {
                let days = history
                    .get("daily")
                    .and_then(|d| d.as_array())
                    .map_or(0, Vec::len);
                (self.events)(CoreEvent::HistoryCollected {
                    days,
                    duration_ms: started.elapsed().as_millis() as u64,
                    at: iso_millis(chrono::Utc::now()),
                });
                let published = self.state.lock().unwrap().update_history(history);
                if let Some(p) = &published {
                    self.after_publish(p);
                }
                Ok(published)
            }
            Ok(None) => Ok(None),
            Err(e) => {
                if !matches!(e, AppError::Stopped) {
                    tracing::warn!(error = %e, "history scan failed");
                    (self.events)(CoreEvent::HistoryFailed {
                        error: ErrorInfo::from(&e),
                        at: iso_millis(chrono::Utc::now()),
                    });
                }
                Err(e)
            }
        }
    }

    async fn do_tick_inner(&self, reason: TickReason) -> AppResult<Published> {
        let reason_str = reason.as_str();
        (self.events)(CoreEvent::TickStarted {
            reason: reason_str.into(),
        });
        self.status.lock().unwrap().collecting = true;
        let started = Instant::now();
        let result = self.collect(reason).await;
        let mut status = self.status.lock().unwrap();
        status.collecting = false;
        match result {
            Ok(collected) => {
                let summary = self.with_archive(collected.summary);
                status.last_collect_at = Some(summary.updated_at.clone());
                status.last_error = None;
                drop(status);
                if !collected.sync_reports.is_empty() {
                    (self.events)(CoreEvent::SelfSync {
                        reports: collected.sync_reports,
                    });
                }
                let published = self.state.lock().unwrap().update_usage(summary);
                (self.events)(CoreEvent::TickFinished {
                    reason: reason_str.into(),
                    duration_ms: started.elapsed().as_millis() as u64,
                });
                self.after_publish(&published);
                Ok(published)
            }
            Err(e) => {
                let info = ErrorInfo::from(&e);
                status.last_error = Some(info.clone());
                drop(status);
                if !matches!(e, AppError::Stopped) {
                    tracing::warn!(reason = reason_str, error = %e, "collection tick failed");
                    (self.events)(CoreEvent::TickFailed {
                        reason: reason_str.into(),
                        error: info,
                    });
                }
                Err(e)
            }
        }
    }

    /// 要求立刻完整重掃（進行中的 tick 結束後馬上再跑一次）。
    pub fn request_rescan(&self) {
        self.rescan.notify_one();
    }

    pub fn snapshot(&self) -> Option<Arc<DeviceRecord>> {
        self.state.lock().unwrap().snapshot().map(|(_, r)| r)
    }

    pub fn collect_status(&self) -> CollectStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn device_id(&self) -> String {
        self.state.lock().unwrap().envelope().device_id.clone()
    }

    pub fn has_uploader(&self) -> bool {
        self.sink.is_some()
    }

    pub fn is_watching(&self) -> bool {
        self.watcher.lock().unwrap().is_some()
    }

    /// 停止：先切斷收集（進行中的 tokscale 會被終止）與監看，再把還沒送的 record 送出去。
    pub async fn stop(&self) {
        self.cancel.cancel();
        self.watcher.lock().unwrap().take();
        self.watch_roots.lock().unwrap().take();
        let tasks: Vec<JoinHandle<()>> = std::mem::take(&mut *self.tasks.lock().unwrap());
        for t in tasks {
            let _ = t.await;
        }
        if let Some(sink) = &self.sink {
            self.enqueue_latest_if_new();
            if tokio::time::timeout(FINAL_FLUSH_TIMEOUT, sink.flush())
                .await
                .is_err()
            {
                tracing::warn!("final upload did not finish within {FINAL_FLUSH_TIMEOUT:?}");
            }
            sink.stop();
        }
    }

    /// `tm-agent once`：掃一次、（有 sender 時）直接送一次，不重試，回傳 record 與上傳結果。
    pub async fn run_once(
        cfg: RuntimeConfig,
    ) -> AppResult<(Arc<DeviceRecord>, Option<AppResult<IngestOutcome>>)> {
        Self::run_once_with_anchor(cfg, None).await
    }

    /// 相容測試用：先以 `anchor_source` 跑一次完整掃描當錨點，再以設定的 source 跑一次
    /// 檔案變動觸發的 anchored tick，回傳後者。重現 watch tick 的真實路徑（delta + propagate）。
    pub async fn run_once_with_anchor(
        cfg: RuntimeConfig,
        anchor_source: Option<ScanSource>,
    ) -> AppResult<(Arc<DeviceRecord>, Option<AppResult<IngestOutcome>>)> {
        let sender = cfg.sender.clone();
        let rt = Arc::new(DeviceRuntime::build(cfg, None));
        let reason = if let Some(source) = anchor_source {
            let collected = collect_once(&source, &rt.collector, false, None, &rt.cancel).await?;
            *rt.anchor.lock().unwrap() = Some(Anchor::from_summary(&collected.summary));
            TickReason::Watch
        } else {
            TickReason::Once
        };
        let mut published = rt.do_tick(reason).await?;
        // 上游 runAgentOnce：掃描之後、上傳之前探測一次額度（startup-once）。
        if let Some(lc) = rt.limits.clone() {
            let summary = LimitsRuntime::new(lc).probe_all().await;
            if let Some(p) = rt.state.lock().unwrap().update_limits(summary) {
                published = p;
            }
        }
        let ingest = match sender {
            Some(send) => Some(send(published.record.clone()).await),
            None => None,
        };
        Ok((published.record, ingest))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: Duration = Duration::from_secs(3600);

    #[test]
    fn manual_and_once_always_scan_everything() {
        let fresh = Some(("2026-09-24", Duration::from_secs(1)));
        for reason in [TickReason::Manual, TickReason::Once] {
            assert_eq!(
                plan_tick(reason, fresh, "2026-09-24"),
                TickPlan::Full,
                "{reason:?}"
            );
        }
    }

    #[test]
    fn startup_reuses_a_fresh_persisted_anchor() {
        let today = "2026-09-24";
        assert_eq!(
            plan_tick(
                TickReason::Startup,
                Some((today, Duration::from_secs(600))),
                today
            ),
            TickPlan::Anchored { self_sync: true }
        );
        assert_eq!(
            plan_tick(TickReason::Startup, Some((today, 2 * HOUR)), today),
            TickPlan::Full
        );
        assert_eq!(
            plan_tick(
                TickReason::Startup,
                Some(("2026-09-23", Duration::from_secs(60))),
                today
            ),
            TickPlan::Full
        );
        assert_eq!(plan_tick(TickReason::Startup, None, today), TickPlan::Full);
    }

    #[test]
    fn watch_ticks_use_todays_anchor_without_self_sync() {
        let anchor = Some(("2026-09-24", 2 * HOUR));
        assert_eq!(
            plan_tick(TickReason::Watch, anchor, "2026-09-24"),
            TickPlan::Anchored { self_sync: false },
            "a watch tick never waits for the hourly full scan"
        );
        assert_eq!(
            plan_tick(TickReason::Watch, None, "2026-09-24"),
            TickPlan::Full
        );
        assert_eq!(
            plan_tick(TickReason::Watch, anchor, "2026-09-25"),
            TickPlan::Full,
            "a new local day invalidates the anchor"
        );
    }

    #[test]
    fn history_runs_on_first_manual_rollover_and_interval_ticks() {
        let quarter = Duration::from_secs(15 * 60);
        let recent = Some(Duration::from_secs(60));
        let include =
            |reason, rolled, since| should_include_history(true, reason, rolled, since, quarter);
        assert!(include(TickReason::Startup, false, recent));
        assert!(include(TickReason::Manual, false, recent));
        assert!(
            include(TickReason::Watch, false, None),
            "never collected yet"
        );
        assert!(
            !include(TickReason::Watch, false, recent),
            "a watch tick does not pay for a graph scan"
        );
        assert!(include(TickReason::Interval, false, Some(quarter)));
        assert!(
            include(TickReason::Watch, true, recent),
            "local midnight finalizes yesterday"
        );
        assert!(!should_include_history(
            false,
            TickReason::Manual,
            true,
            None,
            quarter
        ));
        assert_eq!(
            plan_tick(
                TickReason::HistoryRetry,
                Some(("2026-09-24", 2 * HOUR)),
                "2026-09-24"
            ),
            TickPlan::Anchored { self_sync: false }
        );
    }

    #[test]
    fn interval_ticks_are_anchored_until_the_anchor_is_an_hour_old() {
        let today = "2026-09-24";
        assert_eq!(
            plan_tick(
                TickReason::Interval,
                Some((today, HOUR - Duration::from_secs(1))),
                today
            ),
            TickPlan::Anchored { self_sync: true }
        );
        assert_eq!(
            plan_tick(TickReason::Interval, Some((today, HOUR)), today),
            TickPlan::Full
        );
        assert_eq!(plan_tick(TickReason::Interval, None, today), TickPlan::Full);
    }

    type Seen = Arc<Mutex<Vec<(u64, i64, i64, i64)>>>;

    /// 每一筆發佈的 (revision, today, month, allTime) 總量。
    fn recorder() -> (Seen, EventSink) {
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let events: EventSink = Arc::new(move |event| {
            if let CoreEvent::RecordPublished { revision, record } = event {
                sink.lock().unwrap().push((
                    revision,
                    record.today.total_tokens,
                    record.month.total_tokens,
                    record.all_time.total_tokens,
                ));
            }
        });
        (seen, events)
    }

    fn write_periods(dir: &std::path::Path, today: i64, month: i64, all_time: i64) {
        let row = |tokens: i64| {
            serde_json::json!({ "entries": [{ "client": "claude", "sessionId": "s", "model": "m", "input": tokens }] })
                .to_string()
        };
        std::fs::write(dir.join("today.json"), row(today)).unwrap();
        std::fs::write(dir.join("month.json"), row(month)).unwrap();
        std::fs::write(dir.join("alltime.json"), row(all_time)).unwrap();
    }

    fn fixture_runtime(
        dir: &std::path::Path,
        events: EventSink,
        anchor_file: Option<std::path::PathBuf>,
        seed_from_anchor: bool,
    ) -> DeviceRuntime {
        DeviceRuntime::build(
            RuntimeConfig {
                envelope: crate::identity::envelope("preview-test", "test"),
                collector: CollectorConfig {
                    tracked_clients: vec!["claude".into()],
                    all_time_since: "2024-01-01".into(),
                    projects_enabled: false,
                    history_enabled: false,
                },
                source: ScanSource::Fixtures(dir.into()),
                collection_interval: Duration::from_secs(300),
                upload_interval_ms: 0,
                sender: None,
                events,
                watch: None,
                history_interval: Duration::from_secs(900),
                session_archive: None,
                archive_writes: false,
                anchor_file,
                limits: None,
                progressive: true,
                seed_from_anchor,
            },
            None,
        )
    }

    #[tokio::test]
    async fn a_full_scan_previews_today_and_month_before_all_time() {
        let dir = tempfile::tempdir().unwrap();
        write_periods(dir.path(), 1, 10, 100);
        let (seen, events) = recorder();
        let rt = fixture_runtime(dir.path(), events, None, false);
        rt.do_tick_inner(TickReason::Manual).await.unwrap();
        assert_eq!(
            *seen.lock().unwrap(),
            vec![(1, 1, 10, 100)],
            "no baseline and no anchor yet: nothing to preview against"
        );
        // today +4；month 另外多了 6、allTime 另外多了 96（例如補同步的舊資料）：
        // 預覽先以錨點 delta 推出，掃到了才換成真的。
        write_periods(dir.path(), 5, 20, 200);
        rt.do_tick_inner(TickReason::Manual).await.unwrap();
        assert_eq!(
            seen.lock().unwrap()[1..],
            [(2, 5, 14, 104), (3, 5, 20, 104), (4, 5, 20, 200)]
        );
    }

    #[tokio::test]
    async fn a_cold_start_shows_the_anchor_without_uploading_it() {
        let dir = tempfile::tempdir().unwrap();
        let anchor_file = dir.path().join(crate::collector::ANCHOR_FILE);
        write_periods(dir.path(), 1, 10, 100);
        let (_, events) = recorder();
        fixture_runtime(dir.path(), events, Some(anchor_file.clone()), false)
            .do_tick_inner(TickReason::Manual)
            .await
            .unwrap();

        // 改設定的重啟：不拿錨點蓋掉畫面上比較新的數字。
        let (seen, events) = recorder();
        let rt = fixture_runtime(dir.path(), events, Some(anchor_file.clone()), false);
        assert!(seen.lock().unwrap().is_empty());
        assert!(rt.snapshot().is_none());

        // 冷啟動、錨點兩小時前：先顯示錨點（revision 0），完整掃描中以它為基準預覽。
        let mut saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&anchor_file).unwrap()).unwrap();
        saved["fullScanAt"] = iso_millis(chrono::Utc::now() - chrono::Duration::hours(2)).into();
        std::fs::write(&anchor_file, saved.to_string()).unwrap();
        write_periods(dir.path(), 3, 12, 102);
        let (seen, events) = recorder();
        let rt = fixture_runtime(dir.path(), events, Some(anchor_file.clone()), true);
        assert_eq!(*seen.lock().unwrap(), vec![(0, 1, 10, 100)]);
        assert_eq!(rt.state.lock().unwrap().snapshot().unwrap().0, 0);
        rt.do_tick_inner(TickReason::Startup).await.unwrap();
        assert_eq!(
            seen.lock().unwrap()[1..],
            [(1, 3, 12, 102), (2, 3, 12, 102), (3, 3, 12, 102)]
        );

        // 掃描時間不可信的錨點不當開機畫面（仍可當 delta 的錨點）。
        saved["fullScanAt"] = "not a time".into();
        std::fs::write(&anchor_file, saved.to_string()).unwrap();
        let (seen, events) = recorder();
        let _rt = fixture_runtime(dir.path(), events, Some(anchor_file), true);
        assert!(seen.lock().unwrap().is_empty());
    }
}
