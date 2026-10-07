//! widget 視窗的外觀（上游 windowsChrome.js、windowsBackdrop.js、main.js `setZoomFactor`）。
//!
//! - Windows 11：`DWMWA_WINDOW_CORNER_PREFERENCE = ROUND` 讓 OS 以反鋸齒遮罩畫圓角（透明無框視窗
//!   用 CSS border-radius 在 Windows 上邊緣會有鋸齒），`DWMWA_BORDER_COLOR = NONE` 拿掉 DWM 在
//!   無框視窗外圍畫的 1px 淺色邊。Windows 10 沒有這兩個屬性，呼叫失敗就算了（純外觀）。
//! - 玻璃（`systemGlass`）：Tauri 內建的 `Effect::Acrylic`（window-vibrancy：Windows 11 22H2+ 用
//!   `DWMWA_SYSTEMBACKDROP_TYPE`，與 Electron 的 acrylic 同一條路）。前端的背景色以「不透明度」
//!   疊在上面。
//! - 縮放（`zoomFactor`，70–160%）：`WebviewWindow::set_zoom`，只縮內容不縮視窗。

use tauri::window::{Effect, EffectsBuilder};
use tauri::{AppHandle, WebviewWindow};

use super::window;
use crate::settings::Settings;

#[cfg(windows)]
fn apply_dwm_chrome(w: &WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };
    /// dwmapi.h `DWMWA_COLOR_NONE`。
    const COLOR_NONE: u32 = 0xFFFF_FFFE;
    let Ok(hwnd) = w.hwnd() else { return };
    unsafe {
        let round = DWMWCP_ROUND;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &round as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&round) as u32,
        );
        let none = COLOR_NONE;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            &none as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&none) as u32,
        );
    }
}

#[cfg(not(windows))]
fn apply_dwm_chrome(_w: &WebviewWindow) {}

/// 啟動與設定改變時呼叫：圓角、玻璃與縮放。
pub fn apply(app: &AppHandle, settings: &Settings) {
    let Some(w) = window::main_window(app) else {
        return;
    };
    apply_dwm_chrome(&w);
    let effects = settings
        .system_glass
        .then(|| EffectsBuilder::new().effect(Effect::Acrylic).build());
    if let Err(e) = w.set_effects(effects) {
        tracing::warn!(error = %e, "failed to apply window material");
    }
    apply_zoom(app, settings.zoom_factor);
}

pub fn apply_zoom(app: &AppHandle, zoom: f64) {
    if let Some(w) = window::main_window(app) {
        if let Err(e) = w.set_zoom(zoom) {
            tracing::warn!(error = %e, zoom, "failed to set zoom");
        }
    }
}
