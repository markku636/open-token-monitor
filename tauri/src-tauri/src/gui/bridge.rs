//! 核心 runtime 與前端之間的橋：啟動 / 重啟 DeviceRuntime，把 CoreEvent 轉成前端事件。
//!
//! 前端事件：
//! - `stats-updated`：`LocalStats`（本機用量，每次掃描完成）
//! - `status-updated`：`AppStatus`（收集中、上傳結果、下次上傳時間）
//! - `settings-changed`：`SettingsView`
//! - `company-updated`：`CompanyStats`（hub 串流快照 + 本機疊加；hub 有新快照或本機有新 record 時）
//! - `limits-updated`：`LimitsView`（每一輪額度探測）

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use super::state::{AppState, AppStatus, SettingsView, UploadState};
use crate::collector::{CollectorConfig, ScanSource};
use crate::device::events::CoreEvent;
use crate::device::hub_sender;
use crate::device::runtime::{DeviceRuntime, RuntimeConfig, WatchConfig};
use crate::display::{compose_company, LocalStats};
use crate::hub::stream::{self, StreamEvent};
use crate::hub::HubClient;
use crate::identity;
use crate::settings::resolve_hub;
use crate::tokscale::Scanner;

pub const EVT_STATS: &str = "stats-updated";
pub const EVT_STATUS: &str = "status-updated";
pub const EVT_SETTINGS: &str = "settings-changed";
pub const EVT_COMPANY: &str = "company-updated";
pub const EVT_LIMITS: &str = "limits-updated";

/// hub 快照 + 最新本機 record → 全公司視圖，存起來並通知前端。還沒有 hub 快照時不做事。
fn refresh_company(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(hub) = state.hub_stats.read().unwrap().clone() else {
        return;
    };
    let record = state.record.read().unwrap().clone();
    let company = compose_company(
        &hub,
        record.as_deref(),
        chrono::Utc::now().timestamp_millis(),
    );
    *state.company.write().unwrap() = Some(company.clone());
    let _ = app.emit(EVT_COMPANY, company);
}

fn on_stream_event(app: &AppHandle, event: StreamEvent) {
    match event {
        StreamEvent::State { state, error } => update_status(app, |s| {
            s.hub_stream = Some(state);
            s.hub_stream_error = error;
        }),
        StreamEvent::Stats(stats) => {
            *app.state::<AppState>().hub_stats.write().unwrap() = Some(stats);
            refresh_company(app);
        }
    }
}

fn stop_stream(app: &AppHandle) {
    if let Some(cancel) = app.state::<AppState>().stream_cancel.lock().unwrap().take() {
        cancel.cancel();
    }
}

/// 全公司串流：有 hub 才開；hub 或金鑰改變時由 restart_runtime 重開。
fn start_stream(app: &AppHandle, client: HubClient) {
    stop_stream(app);
    let cancel = tokio_util::sync::CancellationToken::new();
    *app.state::<AppState>().stream_cancel.lock().unwrap() = Some(cancel.clone());
    let handle = app.clone();
    let sink: stream::StreamSink = Arc::new(move |event| on_stream_event(&handle, event));
    tauri::async_runtime::spawn(async move {
        let _ = stream::spawn(client, sink, cancel).await;
    });
}

pub(super) fn update_status(app: &AppHandle, f: impl FnOnce(&mut AppStatus)) {
    let state = app.state::<AppState>();
    let snapshot = {
        let mut status = state.status.write().unwrap();
        f(&mut status);
        status.clone()
    };
    let _ = app.emit(EVT_STATUS, snapshot);
}

fn on_core_event(app: &AppHandle, event: CoreEvent) {
    match event {
        CoreEvent::TickStarted { .. } => update_status(app, |s| s.collecting = true),
        CoreEvent::TickFinished { .. } => update_status(app, |s| {
            s.collecting = false;
            s.last_collect_error = None;
        }),
        CoreEvent::TickFailed { error, .. } => update_status(app, |s| {
            s.collecting = false;
            s.last_collect_error = Some(error.message);
        }),
        CoreEvent::RecordPublished { record, .. } => {
            let stats = LocalStats::from(&*record);
            let updated_at = stats.updated_at.clone();
            *app.state::<AppState>().local.write().unwrap() = Some(stats.clone());
            *app.state::<AppState>().record.write().unwrap() = Some(record);
            super::tray::refresh(app);
            let _ = app.emit(EVT_STATS, stats);
            update_status(app, |s| s.last_collect_at = Some(updated_at));
            // 自己的數字每幾秒就動：全公司視圖跟著疊上去，不必等下次上傳與 hub 的下一個快照。
            refresh_company(app);
        }
        CoreEvent::IngestSent { at, .. } => update_status(app, |s| {
            s.upload_state = UploadState::Ok;
            s.last_upload_at = Some(at);
            s.last_upload_error = None;
            s.last_upload_error_code = None;
        }),
        CoreEvent::IngestFailed { error, .. } => update_status(app, |s| {
            s.upload_state = UploadState::Error;
            s.last_upload_error = Some(error.message);
            s.last_upload_error_code = Some(error.code);
        }),
        CoreEvent::UploadScheduled { next_at } => {
            update_status(app, |s| s.next_upload_at = Some(next_at))
        }
        CoreEvent::WatcherReady { roots } => update_status(app, |s| {
            s.watching = true;
            s.watch_roots = roots;
            s.watch_error = None;
        }),
        CoreEvent::WatcherUnavailable { error } => update_status(app, |s| {
            s.watching = false;
            s.watch_roots.clear();
            s.watch_error = Some(error);
        }),
        CoreEvent::LimitsUpdated { summary, next_at } => {
            let view = super::state::LimitsView { summary, next_at };
            *app.state::<AppState>().limits.write().unwrap() = Some(view.clone());
            let _ = app.emit(EVT_LIMITS, view);
            super::tray::refresh(app);
        }
        CoreEvent::HistoryCollected { days, at, .. } => update_status(app, |s| {
            s.last_history_at = Some(at);
            s.history_days = days;
            s.history_error = None;
        }),
        CoreEvent::HistoryFailed { error, .. } => {
            update_status(app, |s| s.history_error = Some(error.message))
        }
        CoreEvent::SelfSync { reports } => update_status(app, |s| {
            for r in reports {
                s.self_sync.insert(r.client.clone(), r);
            }
        }),
    }
}

/// 依目前設定（重新）啟動收集與上傳。設定裡影響收集或上傳的欄位改變時呼叫。
pub async fn restart_runtime(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut slot = state.runtime.lock().await;
    if let Some(old) = slot.take() {
        old.stop().await;
    }
    let settings = state.settings();
    let hub = resolve_hub(&settings, None, None);

    let bin = match crate::tokscale::locate() {
        Ok(bin) => bin,
        Err(e) => {
            tracing::error!(error = %e, "tokscale not found");
            update_status(app, |s| s.fatal = Some(e.message()));
            return;
        }
    };
    *state.tokscale.write().unwrap() =
        Some((bin.path.display().to_string(), bin.source.to_string()));
    let extra = crate::tokscale::scan::extra_dirs_env(
        &settings.custom_scan_paths,
        std::env::var("TOKSCALE_EXTRA_DIRS").ok().as_deref(),
    );
    let source = ScanSource::Tokscale(Arc::new(Scanner::new(
        bin,
        settings.tokscale_timeout_ms,
        extra,
    )));

    let hub_client = match hub
        .url
        .as_deref()
        .map(|url| HubClient::new(url, hub.secret.clone()))
    {
        Some(Ok(client)) => Some(client),
        Some(Err(e)) => {
            tracing::warn!(error = %e, "invalid hub configuration; running local-only");
            None
        }
        None => None,
    };
    // hub 換了（或拿掉了）：舊快照不能再當全公司的數字。
    *state.hub_stats.write().unwrap() = None;
    *state.company.write().unwrap() = None;
    match &hub_client {
        Some(client) => start_stream(app, client.clone()),
        None => stop_stream(app),
    }
    let sender = hub_client.map(hub_sender);
    let has_sender = sender.is_some();
    update_status(app, |s| {
        s.fatal = None;
        s.hub_url = hub.url.clone();
        s.upload_interval_ms = settings.sync_upload_interval_ms;
        s.next_upload_at = None;
        // 新的 runtime 會重新回報監看狀態（WatcherReady / WatcherUnavailable）。
        s.watching = false;
        s.watch_roots.clear();
        s.watch_error = None;
        s.hub_stream = None;
        s.hub_stream_error = None;
        if !has_sender {
            s.upload_state = UploadState::Disabled;
        } else if s.upload_state == UploadState::Disabled {
            s.upload_state = UploadState::Pending;
        }
    });

    let handle = app.clone();
    let rt = DeviceRuntime::start(RuntimeConfig {
        envelope: identity::envelope(&settings.device_id, identity::RUNTIME_WIDGET)
            .with_owner_email(&crate::settings::resolve_owner_email(&settings)),
        collector: CollectorConfig::from_settings(&settings),
        source,
        collection_interval: Duration::from_millis(settings.collector_interval_ms()),
        history_interval: Duration::from_millis(settings.history_interval_ms),
        session_archive: settings
            .session_usage_archive_enabled
            .then(|| crate::store::config_dir().join(crate::usage::archive_store::ARCHIVE_FILE)),
        archive_writes: true,
        anchor_file: Some(crate::store::config_dir().join(crate::collector::ANCHOR_FILE)),
        upload_interval_ms: settings.sync_upload_interval_ms,
        sender,
        events: Arc::new(move |event| on_core_event(&handle, event)),
        watch: WatchConfig::from_settings(&settings),
        interval_requires_activity: settings.interval_requires_activity(),
        limits: crate::limits::runtime::LimitsConfig::from_settings(&settings),
        progressive: true,
        seed_from_anchor: state.record.read().unwrap().is_none(),
    });
    if !settings.limits_enabled {
        *state.limits.write().unwrap() = None;
    }
    *slot = Some(rt);
}

pub async fn stop_runtime(app: &AppHandle) {
    stop_stream(app);
    let state = app.state::<AppState>();
    let rt = state.runtime.lock().await.take();
    if let Some(rt) = rt {
        rt.stop().await;
    }
}

pub fn emit_settings(app: &AppHandle) {
    let view = SettingsView::from_settings(&app.state::<AppState>().settings());
    let _ = app.emit(EVT_SETTINGS, view);
}
