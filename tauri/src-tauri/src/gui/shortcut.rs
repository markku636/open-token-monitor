//! 全域顯示／隱藏快捷鍵（上游 main.js `configureWindowToggleShortcut`）。
//!
//! 設定值已由 `settings::normalize_window_toggle_shortcut` 正規化成 `CommandOrControl+Shift+T` 這種
//! 格式，tauri-plugin-global-shortcut 直接認得。按下的處理在 gui/mod.rs 註冊 plugin 時（切換 widget）。
//! 註冊失敗（被別的程式占用）不改設定，只在設定頁顯示「無法註冊」，與上游相同。

use tauri::AppHandle;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use super::bridge::update_status;

pub fn apply(app: &AppHandle, shortcut: &str) {
    let manager = app.global_shortcut();
    if let Err(e) = manager.unregister_all() {
        tracing::warn!(error = %e, "failed to clear global shortcuts");
    }
    let state = if shortcut.is_empty() {
        "off"
    } else {
        match manager.register(shortcut) {
            Ok(()) => {
                tracing::info!(shortcut, "window toggle shortcut registered");
                "registered"
            }
            Err(e) => {
                tracing::warn!(shortcut, error = %e, "window toggle shortcut unavailable");
                "unregistered"
            }
        }
    };
    update_status(app, |s| s.window_shortcut = state);
}
