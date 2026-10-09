//! 自動更新：排程檢查 → （自動）下載並驗章 → 使用者按「重新啟動以更新」才安裝。
//!
//! 規則（feed 位置、排程、狀態）在 `crate::update`；這裡接 `tauri-plugin-updater`、tray 與前端。
//! 安裝只在使用者點擊時發生：上游 Electron 版也是（`autoInstallOnAppQuit = false`），
//! 員工正在看數字時不該突然重啟。

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

use super::state::AppState;
use crate::error::{AppError, AppResult};
use crate::update::{self, UpdateState};

pub const EVT_UPDATE: &str = "update-state";

/// 檢查與下載共用的請求逾時。下載 16 MB 走 VPN 也要留餘裕。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub struct UpdaterSlot {
    state: UpdateState,
    /// 找到但還沒下載（自動下載關閉時）。
    available: Option<Update>,
    /// 已下載並通過驗章的安裝檔。
    ready: Option<(Update, Vec<u8>)>,
}

/// `Mutex<UpdaterSlot>` 放在 AppState；這個別名讓 state.rs 不必 import plugin 型別。
pub type SharedSlot = Mutex<UpdaterSlot>;

impl Default for UpdaterSlot {
    fn default() -> Self {
        UpdaterSlot {
            state: UpdateState::Idle,
            available: None,
            ready: None,
        }
    }
}

/// 打包時寫進 `plugins.updater.pubkey` 的公鑰；repo 裡的 tauri.conf.json 是空字串。
fn configured_pubkey(app: &AppHandle) -> String {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

fn feed_url(app: &AppHandle) -> Result<url::Url, update::DisabledReason> {
    let settings = app.state::<AppState>().settings();
    let hub = crate::settings::resolve_hub(&settings, None, None);
    update::feed_url(
        crate::baked::is_corp_build(),
        cfg!(debug_assertions),
        &configured_pubkey(app),
        hub.url.as_deref(),
        crate::baked::github_update_repo(),
    )
}

/// 用系統瀏覽器開生效 hub 上的版本頁（`update::release_page_url`）。網址只由這裡組出，前端不能指定，與 `service_status_open` 相同。
pub fn open_release_page(app: &AppHandle) -> AppResult<()> {
    let url = if let Some(repo) = crate::baked::github_update_repo() {
        // GitHub 發行：版本頁是 repo 最新的 Release。
        update::github_release_page_url(repo)
            .ok_or_else(|| AppError::InvalidArgument("GitHub repo 無效，無法開啟版本頁".into()))?
    } else {
        let settings = app.state::<AppState>().settings();
        let hub = crate::settings::resolve_hub(&settings, None, None);
        let Some(hub_url) = hub.url.as_deref() else {
            return Err(AppError::HubNotConfigured);
        };
        let state = current_state(app);
        update::release_page_url(Some(hub_url), state.version())
            .ok_or_else(|| AppError::InvalidArgument("hub 位置無效，無法開啟版本頁".into()))?
    };
    tracing::info!(%url, "opening release page");
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| AppError::Internal(e.to_string()))
}

pub fn current_state(app: &AppHandle) -> UpdateState {
    app.state::<AppState>()
        .updater
        .lock()
        .unwrap()
        .state
        .clone()
}

fn set_state(app: &AppHandle, state: UpdateState) {
    {
        let slot = app.state::<AppState>();
        slot.updater.lock().unwrap().state = state.clone();
    }
    super::tray::set_update_item(&state);
    let _ = app.emit(EVT_UPDATE, state);
}

fn with_slot<T>(app: &AppHandle, f: impl FnOnce(&mut UpdaterSlot) -> T) -> T {
    let state = app.state::<AppState>();
    let mut slot: std::sync::MutexGuard<'_, UpdaterSlot> = state.updater.lock().unwrap();
    f(&mut slot)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn error_state(message: String) -> UpdateState {
    let retry =
        chrono::Utc::now() + chrono::Duration::from_std(update::RETRY_AFTER).unwrap_or_default();
    UpdateState::Error {
        message,
        retry_at: Some(retry.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    }
}

/// feed 的 `pub_date`（RFC 3339）原樣給前端；plugin 解析後的 `OffsetDateTime` 轉字串不是 RFC 3339。
fn date_of(update: &Update) -> Option<String> {
    update
        .raw_json
        .get("pub_date")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// 背景排程：啟動後 30–120 秒第一次檢查，之後每小時 ±5 分；失敗 15 分鐘後重試。
/// 手動檢查（設定頁、tray）走 `check_now`，不影響排程。
pub fn start(app: &AppHandle) {
    if let Err(reason) = feed_url(app) {
        tracing::info!(?reason, "automatic updates disabled");
        set_state(app, UpdateState::Disabled { reason });
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut delay = update::first_check_delay(update::random_seed());
        loop {
            tokio::time::sleep(delay).await;
            check_now(&app).await;
            delay = match current_state(&app) {
                UpdateState::Error { .. } => update::RETRY_AFTER,
                // 已經下載好就不必再檢查，等使用者重啟。
                UpdateState::Ready { .. } | UpdateState::Installing { .. } => break,
                _ => update::next_check_delay(update::random_seed()),
            };
        }
    });
}

/// 立即檢查一次；有新版且開啟自動更新時接著下載。回傳檢查後的狀態。
pub async fn check_now(app: &AppHandle) -> UpdateState {
    let current = current_state(app);
    if current.is_busy() || current.ready_version().is_some() {
        return current;
    }
    let url = match feed_url(app) {
        Ok(url) => url,
        Err(reason) => {
            let state = UpdateState::Disabled { reason };
            set_state(app, state.clone());
            return state;
        }
    };
    set_state(app, UpdateState::Checking);
    let checked = async {
        app.updater_builder()
            .endpoints(vec![url])?
            .timeout(REQUEST_TIMEOUT)
            .build()?
            .check()
            .await
    }
    .await;
    match checked {
        Ok(None) => {
            let state = UpdateState::UpToDate {
                checked_at: now_iso(),
            };
            set_state(app, state.clone());
            state
        }
        Ok(Some(found)) => {
            tracing::info!(version = %found.version, "update available");
            let found_version = found.version.clone();
            let state = UpdateState::Available {
                version: found.version.clone(),
                notes: found.body.clone(),
                date: date_of(&found),
            };
            with_slot(app, |s| s.available = Some(found));
            set_state(app, state.clone());
            // 使用者按過「忽略此版本」的版本不自動下載（上游 shouldAutoDownloadAppUpdate）。
            let settings = app.state::<AppState>().settings();
            if settings.automatic_app_updates
                && settings.app_update_dismissed_version != found_version
            {
                download(app).await;
            }
            current_state(app)
        }
        Err(e) => {
            tracing::warn!(error = %e, "update check failed");
            let state = error_state(format!("檢查更新失敗：{e}"));
            set_state(app, state.clone());
            state
        }
    }
}

/// 下載已找到的新版並驗章（`Update::download` 內部以公鑰驗 minisign 簽章）。
pub async fn download(app: &AppHandle) -> UpdateState {
    let Some(found) = with_slot(app, |s| s.available.clone()) else {
        return current_state(app);
    };
    let version = found.version.clone();
    set_state(
        app,
        UpdateState::Downloading {
            version: version.clone(),
            received: 0,
            total: None,
        },
    );
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    let progress_app = app.clone();
    let progress_version = version.clone();
    let result = found
        .download(
            move |chunk, total| {
                received += chunk as u64;
                // 每 512 KiB 通知一次就夠了，不要每個 chunk 都丟事件給前端。
                if received - last_emit >= 512 * 1024 || Some(received) == total {
                    last_emit = received;
                    set_state(
                        &progress_app,
                        UpdateState::Downloading {
                            version: progress_version.clone(),
                            received,
                            total,
                        },
                    );
                }
            },
            || {},
        )
        .await;
    match result {
        Ok(bytes) => {
            tracing::info!(%version, bytes = bytes.len(), "update downloaded and verified");
            let state = UpdateState::Ready {
                version,
                notes: found.body.clone(),
                date: date_of(&found),
            };
            with_slot(app, |s| {
                s.available = None;
                s.ready = Some((found, bytes));
            });
            set_state(app, state.clone());
            state
        }
        Err(e) => {
            tracing::warn!(error = %e, %version, "update download failed");
            let state = error_state(format!("下載更新失敗：{e}"));
            set_state(app, state.clone());
            state
        }
    }
}

/// 安裝已下載的版本：先停 runtime（最後一筆上傳），再交給 NSIS（passive）；
/// Windows 上 `Update::install` 啟動安裝程式後直接結束程序，安裝完成後由 NSIS 重新啟動 app。
pub async fn install(app: &AppHandle) -> AppResult<()> {
    let Some((found, bytes)) = with_slot(app, |s| s.ready.take()) else {
        return Err(AppError::InvalidArgument("沒有已下載的更新".into()));
    };
    let version = found.version.clone();
    set_state(
        app,
        UpdateState::Installing {
            version: version.clone(),
        },
    );
    tracing::info!(%version, "installing update");
    super::bridge::stop_runtime(app).await;
    let result = tauri::async_runtime::spawn_blocking(move || found.install(bytes))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    // 只有失敗才會回到這裡（成功時程序已經結束）。runtime 已停，重新啟動它。
    if let Err(e) = result {
        tracing::error!(error = %e, %version, "update install failed");
        set_state(app, error_state(format!("安裝更新失敗：{e}")));
        super::bridge::restart_runtime(app).await;
        return Err(AppError::Internal(e.to_string()));
    }
    Ok(())
}
