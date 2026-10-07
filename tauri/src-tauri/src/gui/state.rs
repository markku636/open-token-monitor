//! GUI 共享狀態與給前端的 DTO。

use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use serde::Serialize;

use crate::device::runtime::DeviceRuntime;
use crate::display::LocalStats;
use crate::settings::{resolve_hub, Settings, ValueSource};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum UploadState {
    /// 沒有設定 hub（dev 建置），只做本機統計。
    #[default]
    Disabled,
    /// 已設定 hub，還沒上傳過。
    Pending,
    Ok,
    Error,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub collecting: bool,
    pub last_collect_at: Option<String>,
    pub last_collect_error: Option<String>,
    pub upload_state: UploadState,
    pub hub_url: Option<String>,
    pub last_upload_at: Option<String>,
    pub last_upload_error: Option<String>,
    pub last_upload_error_code: Option<String>,
    pub next_upload_at: Option<String>,
    pub upload_interval_ms: u64,
    /// 找不到 tokscale 等讓收集完全無法進行的問題。
    pub fatal: Option<String>,
    /// Cursor / Antigravity 最近一次的同步結果（client id → report）。
    pub self_sync: std::collections::BTreeMap<String, crate::collector::self_sync::SyncReport>,
    /// 是否正在監看來源目錄（有變動時 3–5 秒內更新）。
    pub watching: bool,
    pub watch_roots: Vec<String>,
    /// 監看無法啟動的原因（只靠定時掃描）。
    pub watch_error: Option<String>,
    /// 全公司串流（`/api/stats/stream`）的狀態；沒有設定 hub 時為 `None`。
    pub hub_stream: Option<crate::hub::stream::StreamState>,
    pub hub_stream_error: Option<String>,
    /// 最近一次 history 掃描成功的時間與天數、或失敗的原因。
    pub last_history_at: Option<String>,
    pub history_days: usize,
    pub history_error: Option<String>,
    /// 全域快捷鍵：`off` | `registered` | `unregistered`（被別的程式占用或系統拒絕）。
    pub window_shortcut: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubView {
    pub url: Option<String>,
    pub url_source: ValueSource,
    pub secret_masked: Option<String>,
    pub secret_source: ValueSource,
    pub baked_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    #[serde(flatten)]
    pub settings: Settings,
    pub hub: HubView,
    pub build_channel: &'static str,
    pub app_version: &'static str,
    pub supported_clients: &'static [&'static str],
    /// 主頁額度與設定頁「主畫面」列出的 provider（上游的 `LIMIT_PROVIDER_CATALOG`，只含支援的）。
    pub supported_limit_providers: &'static [&'static str],
}

impl SettingsView {
    pub fn from_settings(settings: &Settings) -> Self {
        let hub = resolve_hub(settings, None, None);
        SettingsView {
            settings: settings.clone(),
            hub: HubView {
                url: hub.url.clone(),
                url_source: hub.url_source,
                secret_masked: hub.secret_masked(),
                secret_source: hub.secret_source,
                baked_url: crate::baked::hub_url().map(str::to_string),
            },
            build_channel: crate::baked::BUILD_CHANNEL,
            app_version: crate::baked::AGENT_VERSION,
            supported_clients: crate::settings::SUPPORTED_CLIENTS,
            supported_limit_providers: crate::settings::SUPPORTED_LIMIT_PROVIDERS,
        }
    }
}

/// 給前端的額度（事件 `limits-updated`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsView {
    #[serde(flatten)]
    pub summary: crate::wire::LimitsSummary,
    pub next_at: String,
}

pub struct AppState {
    pub settings: RwLock<Settings>,
    pub runtime: tokio::sync::Mutex<Option<Arc<DeviceRuntime>>>,
    pub local: RwLock<Option<LocalStats>>,
    pub status: RwLock<AppStatus>,
    pub tokscale: RwLock<Option<(String, String)>>,
    pub started_at: Instant,
    pub log_guard: Mutex<Option<tracing_appender::non_blocking::WorkerGuard>>,
    pub updater: super::updater::SharedSlot,
    /// 最新的本機 record（全公司視圖用它蓋掉 hub 上自己那一列）。
    pub record: RwLock<Option<Arc<crate::wire::DeviceRecord>>>,
    /// hub 串流的最新快照（瘦身版，見 hub/stream.rs）。
    pub hub_stats: RwLock<Option<Arc<crate::hub::stream::HubStats>>>,
    pub company: RwLock<Option<crate::display::CompanyStats>>,
    /// 最近一輪的額度探測結果與下一次的時間。
    pub limits: RwLock<Option<LimitsView>>,
    /// 停止目前的串流（設定改變或結束時）。
    pub stream_cancel: Mutex<Option<tokio_util::sync::CancellationToken>>,
}

impl AppState {
    pub fn new(settings: Settings) -> Self {
        AppState {
            settings: RwLock::new(settings),
            runtime: tokio::sync::Mutex::new(None),
            local: RwLock::new(None),
            status: RwLock::new(AppStatus::default()),
            tokscale: RwLock::new(None),
            started_at: Instant::now(),
            log_guard: Mutex::new(None),
            updater: Mutex::new(super::updater::UpdaterSlot::default()),
            record: RwLock::new(None),
            hub_stats: RwLock::new(None),
            company: RwLock::new(None),
            limits: RwLock::new(None),
            stream_cancel: Mutex::new(None),
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.read().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_view_lists_the_supported_limit_providers() {
        let view = serde_json::to_value(SettingsView::from_settings(&Settings::default())).unwrap();
        assert_eq!(
            view["supportedLimitProviders"],
            serde_json::json!(crate::settings::SUPPORTED_LIMIT_PROVIDERS)
        );
        assert_eq!(view["hiddenViews"], "status");
        assert_eq!(view["homeLimitAccountCount"], 3);
    }
}
