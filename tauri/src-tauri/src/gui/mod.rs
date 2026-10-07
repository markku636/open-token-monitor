//! Tauri 殼：plugin、tray、視窗、指令。核心邏輯全在 Tauri-free 的模組裡。
//!
//! 啟動順序：single-instance（必須第一個）→ 載入設定（首次指派 deviceId）→ 檔案 log →
//! tray → 套用視窗模式 → 啟動收集 runtime → 前端首次繪製後 `window_show_ready`
//! （4 秒保險絲：前端掛了也要讓視窗出現，否則使用者只看得到 tray）。

mod bridge;
mod bubble;
mod chrome;
mod commands;
mod currency;
mod dock;
mod export;
mod i18n;
mod notify;
mod service_status;
mod shortcut;
mod state;
mod taskbar;
mod tray;
mod tray_bars;
mod updater;
mod views;
mod window;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_window_state::StateFlags;

use crate::settings::Settings;
use state::AppState;

static QUITTING: AtomicBool = AtomicBool::new(false);

/// 真正結束：先停 runtime（最後一次上傳最多等 5 秒），再退出。
pub(crate) fn quit(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    bubble::restore_for_exit(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        bridge::stop_runtime(&app).await;
        app.exit(0);
    });
}

pub fn run() {
    let config_dir = crate::store::config_dir();
    let log_guard = crate::logging::init_file(&crate::store::log_dir());
    let settings = match Settings::load_or_init(&config_dir) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(error = %e, "failed to load settings; using defaults");
            Settings::default()
        }
    };
    tracing::info!(
        version = crate::baked::AGENT_VERSION,
        channel = crate::baked::BUILD_CHANNEL,
        device_id = %settings.device_id,
        "Token Monitor starting"
    );
    let app_state = AppState::new(settings);
    *app_state.log_guard.lock().unwrap() = log_guard;

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            window::show_main(app);
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION | StateFlags::SIZE)
                .with_denylist(&[window::SETTINGS, dock::DOCK])
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        window::toggle_main(app);
                    }
                })
                .build(),
        )
        // 公鑰由打包時的 --config 寫進 plugins.updater.pubkey；端點在執行期依生效的 hub 決定。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = handle.state::<AppState>().settings();
            // `showTrayIcon` 關閉時不建 tray；之後在設定頁打開才建（tray::sync_visibility）。
            if settings.show_tray_icon {
                tray::build(&handle)?;
            }
            window::apply_mode(&handle, &settings);
            taskbar::configure(&handle, taskbar::enabled_for(&settings));
            chrome::apply(&handle, &settings);
            shortcut::apply(&handle, &settings.window_toggle_shortcut);
            dock::sync(&handle);
            commands::apply_autostart(&handle, settings.autostart);
            let h = handle.clone();
            tauri::async_runtime::spawn(async move { bridge::restart_runtime(&h).await });
            updater::start(&handle);
            currency::start(&handle);
            export::start(&handle);
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(4)).await;
                // 系統匣模式本來就不顯示，等使用者按 tray 圖示。
                let tray_mode = h.state::<AppState>().settings().window_mode
                    == crate::settings::WindowMode::Tray;
                if let Some(w) = window::main_window(&h).filter(|_| !tray_mode) {
                    if !w.is_visible().unwrap_or(true) {
                        tracing::warn!(
                            "frontend did not report ready within 4s; showing window anyway"
                        );
                        window::reveal_main(&h);
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings_get,
            commands::settings_update,
            commands::hub_set_override,
            commands::stats_get,
            commands::status_get,
            commands::usage_rescan,
            commands::window_show_ready,
            commands::window_toggle,
            commands::window_hide,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_close,
            commands::window_open_settings,
            commands::window_open_dashboard,
            commands::app_diagnostics,
            commands::app_open_log_dir,
            commands::app_quit,
            commands::company_get,
            commands::ui_language,
            commands::limits_get,
            commands::limits_refresh,
            commands::cursor_set_token,
            commands::copilot_login_start,
            commands::copilot_logout,
            commands::copilot_signed_in,
            commands::update_state,
            commands::update_check,
            commands::update_download,
            commands::update_install,
            commands::bubble_get,
            commands::bubble_expand,
            commands::bubble_collapse,
            dock::dock_get,
            dock::dock_expand,
            dock::dock_collapse,
            dock::dock_open_limits,
            views::usage_detail,
            views::usage_sessions,
            views::trends_get,
            views::range_get,
            views::company_device,
            views::history_series_get,
            views::company_range_get,
            views::session_detail_get,
            currency::currency_get,
            export::export_pick_dir,
            export::export_now,
            export::export_status,
            service_status::service_status_get,
            service_status::service_status_open,
        ])
        .on_window_event(|window, event| {
            if window.label() != window::MAIN {
                return;
            }
            match event {
                // widget 的關閉 = 收到 tray；要真的結束走 tray 選單的「結束」。沒有系統匣圖示時
                // 藏起來就叫不回來，改成結束（window::close_main，上游 mainWindowCloseAction）。
                WindowEvent::CloseRequested { api, .. } if !QUITTING.load(Ordering::SeqCst) => {
                    api.prevent_close();
                    window::close_main(window.app_handle());
                }
                // 拖到工作列上（或離開）時重新判斷要不要保持在工作列上方。
                WindowEvent::Moved(_) => taskbar::wake(),
                // 最大化與還原也是 Resized：順便把狀態寫回 `windowMaximized`。
                WindowEvent::Resized(_) => {
                    taskbar::wake();
                    window::on_resized(window.app_handle());
                }
                // 失去焦點多半是別的視窗（常常就是工作列）取得前景。
                WindowEvent::Focused(false) => {
                    taskbar::nudge();
                    window::on_blur(window.app_handle());
                    bubble::on_blur(window.app_handle());
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        // 最後一個視窗關閉不代表結束：widget 常駐在 tray。
        if let RunEvent::ExitRequested { api, code, .. } = &event {
            if code.is_none() && !QUITTING.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
        if let RunEvent::Exit = event {
            bubble::restore_for_exit(app);
            tauri::async_runtime::block_on(bridge::stop_runtime(app));
        }
    });
}
