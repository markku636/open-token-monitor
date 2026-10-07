//! 前端可呼叫的指令（src/api.ts 是對應的 typed wrapper）。都很薄：邏輯在核心模組。

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use super::bridge::{emit_settings, restart_runtime};
use super::state::{AppState, AppStatus, SettingsView};
use super::{updater, window};
use crate::display::LocalStats;
use crate::error::{AppError, AppResult};
use crate::settings::Settings;
use crate::update::UpdateState;

/// 改了這些欄位就要重建 runtime（收集內容或上傳目標變了）。
const RUNTIME_FIELDS: &[&str] = &[
    "hubUrl",
    "ownerEmail",
    "syncUploadIntervalMs",
    "trackedClients",
    "customScanPaths",
    "allTimeSince",
    "projectsEnabled",
    "collectionIntervalMs",
    "tokscaleTimeoutMs",
    "watchEnabled",
    "watchDebounceMs",
    "historyEnabled",
    "sessionUsageArchiveEnabled",
    "historyIntervalMs",
    "limitsEnabled",
    "limitProviders",
    "limitsRefreshMs",
];

fn save(state: &AppState, next: Settings) -> AppResult<()> {
    next.save_in(&crate::store::config_dir())?;
    *state.settings.write().unwrap() = next;
    Ok(())
}

pub(super) fn apply_autostart(app: &AppHandle, enabled: bool) {
    // dev build 不註冊開機啟動：否則會把 target\debug 的執行檔寫進使用者的 Run 機碼。
    if cfg!(debug_assertions) {
        return;
    }
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    let current = launcher.is_enabled().unwrap_or(false);
    let result = match (enabled, current) {
        (true, false) => launcher.enable(),
        (false, true) => launcher.disable(),
        _ => Ok(()),
    };
    if let Err(e) = result {
        tracing::warn!(error = %e, enabled, "failed to update autostart");
    }
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> SettingsView {
    SettingsView::from_settings(&state.settings())
}

#[tauri::command]
pub async fn settings_update(app: AppHandle, patch: Map<String, Value>) -> AppResult<SettingsView> {
    apply_settings_patch(&app, patch).await
}

/// 設定頁與 tray 選單共用：驗證、存檔，並套用有變動的部分。
pub(super) async fn apply_settings_patch(
    app: &AppHandle,
    patch: Map<String, Value>,
) -> AppResult<SettingsView> {
    let state = app.state::<AppState>();
    let app = app.clone();
    let current = state.settings();
    let next = current.patched(&patch)?;
    let before = serde_json::to_value(&current).unwrap_or_default();
    let after = serde_json::to_value(&next).unwrap_or_default();
    let changed = |k: &str| before.get(k) != after.get(k);
    let restart = RUNTIME_FIELDS.iter().any(|k| changed(k));
    save(&state, next.clone())?;
    if changed("windowMode") {
        window::apply_mode(&app, next.window_mode);
    }
    if changed("systemGlass") || changed("zoomFactor") {
        super::chrome::apply(&app, &next);
    }
    if changed("windowToggleShortcut") {
        super::shortcut::apply(&app, &next.window_toggle_shortcut);
    }
    if changed("edgeDockEnabled") || changed("edgeDockSide") || changed("edgeDockOffset") {
        super::dock::sync(&app);
    }
    if changed("windowMode") || changed("floatingBubbleEnabled") {
        super::bubble::sync(&app);
    }
    if changed("windowMode") || changed("keepAboveTaskbar") {
        super::taskbar::configure(&app, super::taskbar::enabled_for(&next));
    }
    if changed("autostart") {
        apply_autostart(&app, next.autostart);
    }
    if changed("currency") || changed("currencyRates") {
        super::currency::on_settings_changed(&app);
    }
    if changed("exportAutoEnabled") || changed("exportDir") || changed("exportIntervalMs") {
        super::export::on_settings_changed();
    }
    super::tray::sync_checks(&next);
    if changed("trayContent") {
        super::tray::refresh(&app);
    }
    if restart {
        restart_runtime(&app).await;
    }
    emit_settings(&app);
    Ok(SettingsView::from_settings(&next))
}

/// 金鑰輪替用：`url` 空字串 = 回到內建值；`secret` 空字串 = 刪除覆寫，`None` = 不動。
#[tauri::command]
pub async fn hub_set_override(
    app: AppHandle,
    state: State<'_, AppState>,
    url: Option<String>,
    secret: Option<String>,
) -> AppResult<SettingsView> {
    if let Some(url) = url {
        let url = url.trim().trim_end_matches('/').to_string();
        if !url.is_empty() {
            crate::hub::HubClient::new(&url, None)?;
        }
        let mut next = state.settings();
        next.hub_url = url;
        next.validate();
        save(&state, next)?;
    }
    if let Some(secret) = secret {
        if secret.trim().is_empty() {
            crate::secrets::clear_override_secret()?;
        } else {
            if secret.trim().len() < 8 {
                return Err(AppError::InvalidArgument("secret 太短".into()));
            }
            crate::secrets::set_override_secret(&secret)?;
        }
    }
    restart_runtime(&app).await;
    emit_settings(&app);
    Ok(SettingsView::from_settings(&state.settings()))
}

#[tauri::command]
pub fn stats_get(state: State<'_, AppState>) -> Option<LocalStats> {
    state.local.read().unwrap().clone()
}

#[tauri::command]
pub fn status_get(state: State<'_, AppState>) -> AppStatus {
    state.status.read().unwrap().clone()
}

#[tauri::command]
pub async fn usage_rescan(state: State<'_, AppState>) -> AppResult<()> {
    if let Some(rt) = state.runtime.lock().await.as_ref() {
        rt.request_rescan();
    }
    Ok(())
}

#[tauri::command]
pub fn window_show_ready(app: AppHandle, window: WebviewWindow) {
    // 系統匣模式啟動時不顯示，等使用者按 tray 圖示。
    let tray = app.state::<AppState>().settings().window_mode == crate::settings::WindowMode::Tray;
    if window.label() == window::MAIN && !tray {
        let _ = window.show();
    }
}

#[tauri::command]
pub fn bubble_get(app: AppHandle) -> super::bubble::BubbleView {
    super::bubble::current(&app)
}

#[tauri::command]
pub fn bubble_expand(app: AppHandle) {
    super::bubble::expand(&app, true);
}

/// widget 上按 Esc：立刻收合（泡泡關閉或不是浮動模式時不做事）。
#[tauri::command]
pub fn bubble_collapse(app: AppHandle) {
    super::bubble::collapse(&app);
}

#[tauri::command]
pub fn window_toggle(app: AppHandle) {
    window::toggle_main(&app);
}

#[tauri::command]
pub fn window_hide(app: AppHandle) {
    if let Some(w) = window::main_window(&app) {
        let _ = w.hide();
    }
}

#[tauri::command]
pub fn window_open_dashboard(app: AppHandle) -> AppResult<()> {
    window::open_dashboard(&app).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command]
pub fn window_open_settings(app: AppHandle) -> AppResult<()> {
    window::open_settings(&app).map_err(|e| AppError::Internal(e.to_string()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub app_version: &'static str,
    pub build_channel: &'static str,
    pub device_id: String,
    pub hostname: String,
    pub os: String,
    pub platform: String,
    pub config_dir: String,
    pub log_dir: String,
    pub tokscale_path: Option<String>,
    pub tokscale_source: Option<String>,
    pub uptime_ms: u128,
    pub status: AppStatus,
    pub electron_widget_installed: bool,
}

fn electron_widget_installed() -> bool {
    dirs::data_local_dir()
        .map(|d| {
            d.join("Programs")
                .join("Token Monitor")
                .join("Token Monitor.exe")
                .exists()
        })
        .unwrap_or(false)
}

#[tauri::command]
pub fn app_diagnostics(state: State<'_, AppState>) -> Diagnostics {
    let settings = state.settings();
    let (os_name, os_version) = crate::identity::os_info();
    let tokscale = state.tokscale.read().unwrap().clone();
    Diagnostics {
        app_version: crate::baked::AGENT_VERSION,
        build_channel: crate::baked::BUILD_CHANNEL,
        device_id: settings.device_id,
        hostname: crate::identity::hostname(),
        os: format!("{os_name} {os_version}").trim().to_string(),
        platform: crate::identity::platform(),
        config_dir: crate::store::config_dir().display().to_string(),
        log_dir: crate::store::log_dir().display().to_string(),
        tokscale_path: tokscale.as_ref().map(|t| t.0.clone()),
        tokscale_source: tokscale.map(|t| t.1),
        uptime_ms: state.started_at.elapsed().as_millis(),
        status: state.status.read().unwrap().clone(),
        electron_widget_installed: electron_widget_installed(),
    }
}

pub(super) fn open_log_dir(app: &AppHandle) {
    let dir = crate::store::log_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Err(e) = app
        .opener()
        .open_path(dir.display().to_string(), None::<&str>)
    {
        tracing::warn!(error = %e, "failed to open log dir");
    }
}

#[tauri::command]
pub fn app_open_log_dir(app: AppHandle) {
    open_log_dir(&app);
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    super::quit(&app);
}

/// 前端解析好的介面語言（`zh-TW` / `en`），tray 跟著換字。
#[tauri::command]
pub fn ui_language(app: AppHandle, lang: String) {
    super::i18n::set_english(lang == "en");
    super::tray::retitle(&app);
}

#[tauri::command]
pub fn limits_get(state: State<'_, AppState>) -> Option<super::state::LimitsView> {
    state.limits.read().unwrap().clone()
}

/// 手動重新探測額度（本機用量變動不會觸發，只有使用者按的時候）。
#[tauri::command]
pub async fn limits_refresh(state: State<'_, AppState>) -> AppResult<()> {
    if let Some(rt) = state.runtime.lock().await.as_ref() {
        rt.request_limits_refresh();
    }
    Ok(())
}

/// 手動貼上 Cursor 的 session token（只用 Cursor CLI、沒裝桌面版的人）。寫進 tokscale 的帳號檔，
/// 用量同步與額度都用它；接受 cookie header、`WorkosCursorSessionToken=…`、`user::token` 或 JWT。
/// token 不回傳、不進設定檔與 log。
#[tauri::command]
pub async fn cursor_set_token(state: State<'_, AppState>, token: String) -> AppResult<()> {
    let normalized = crate::collector::cursor::normalize_session_token(&token);
    if normalized.is_empty() {
        return Err(AppError::InvalidArgument("Cursor token 格式不正確".into()));
    }
    let home = dirs::home_dir().ok_or_else(|| AppError::Internal("no home directory".into()))?;
    let now = crate::wire::time::iso_millis(chrono::Utc::now());
    crate::collector::cursor::upsert_account(
        &crate::collector::cursor::credentials_path(&home),
        &normalized,
        &now,
    )?;
    tracing::info!("cursor token saved from settings");
    if let Some(rt) = state.runtime.lock().await.as_ref() {
        rt.request_limits_refresh();
        rt.request_rescan();
    }
    Ok(())
}

/// Copilot 的 GitHub 登入（device flow，上游 providers/copilot/deviceFlow.js）：回傳要在 github.com
/// 輸入的代碼並開啟驗證頁；背景輪詢到拿到 token 為止，存進 OS 認證管理員，事件 `copilot-login`
/// 回報結果。token 不回傳給前端。
#[tauri::command]
pub async fn copilot_login_start(app: AppHandle) -> AppResult<crate::limits::copilot::DeviceCode> {
    use crate::limits::copilot::{device_poll, device_start, PollResult};
    use tauri::Emitter;
    let http = reqwest::Client::new();
    let code = device_start(&http).await.map_err(AppError::Internal)?;
    let _ = app.opener().open_url(&code.verification_uri, None::<&str>);
    let device_code = code.device_code.clone();
    let mut interval = std::time::Duration::from_secs(code.interval);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(code.expires_in);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let emit = |state: &str, message: &str| {
            let _ = handle.emit(
                "copilot-login",
                serde_json::json!({ "state": state, "message": message }),
            );
        };
        while std::time::Instant::now() < deadline {
            tokio::time::sleep(interval).await;
            match device_poll(&http, &device_code).await {
                PollResult::Pending => {}
                PollResult::SlowDown => interval += std::time::Duration::from_secs(5),
                PollResult::Token(token) => {
                    match crate::secrets::set(crate::secrets::COPILOT_TOKEN, &token) {
                        Ok(()) => {
                            tracing::info!("copilot signed in");
                            emit("done", "");
                            if let Some(rt) =
                                handle.state::<AppState>().runtime.lock().await.as_ref()
                            {
                                rt.request_limits_refresh();
                            }
                        }
                        Err(e) => emit("error", &e.message()),
                    }
                    return;
                }
                PollResult::Expired => return emit("error", "expired"),
                PollResult::Denied => return emit("error", "denied"),
                PollResult::Failed(e) => return emit("error", &e),
            }
        }
        emit("error", "expired");
    });
    Ok(code)
}

#[tauri::command]
pub async fn copilot_logout(state: State<'_, AppState>) -> AppResult<()> {
    crate::secrets::clear(crate::secrets::COPILOT_TOKEN)?;
    if let Some(rt) = state.runtime.lock().await.as_ref() {
        rt.request_limits_refresh();
    }
    Ok(())
}

/// 是否已有 Copilot 的登入（認證管理員或環境變數）。
#[tauri::command]
pub fn copilot_signed_in() -> bool {
    crate::limits::copilot::token().is_some()
}

#[tauri::command]
pub fn company_get(state: State<'_, AppState>) -> Option<crate::display::CompanyStats> {
    state.company.read().unwrap().clone()
}

#[tauri::command]
pub fn update_state(app: AppHandle) -> UpdateState {
    updater::current_state(&app)
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> UpdateState {
    let state = updater::check_now(&app).await;
    // 手動檢查找到被忽略的那個版本：解除忽略（上游 restoreDismissedAppUpdate），需要時接著自動下載。
    if let UpdateState::Available { version, .. } = &state {
        let settings = app.state::<AppState>().settings();
        if settings.app_update_dismissed_version == *version {
            let mut patch = Map::new();
            patch.insert(
                "appUpdateDismissedVersion".into(),
                Value::String(String::new()),
            );
            let _ = apply_settings_patch(&app, patch).await;
            if settings.automatic_app_updates {
                return updater::download(&app).await;
            }
        }
    }
    state
}

#[tauri::command]
pub async fn update_download(app: AppHandle) -> UpdateState {
    updater::download(&app).await
}

#[tauri::command]
pub async fn update_install(app: AppHandle) -> AppResult<()> {
    updater::install(&app).await
}
