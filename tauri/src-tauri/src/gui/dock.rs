//! 邊緣額度條（上游 Edge Dock 的精簡版，src/electron/edgeDock/）。
//!
//! 一個獨立的小視窗貼在螢幕左或右邊緣：平常只露出一條細細的把手（peek），游標碰到就展開成
//! 額度圓環列（rail），離開 320 ms 後收回（上游 `EDGE_DOCK_TIMING`）。點圓環開啟 widget 的額度分頁。
//!
//! 與上游的差異：上游用兩個視窗（rail + 說明泡泡）並輪詢游標座標；這裡只有一個視窗，hover 直接用
//! webview 的滑鼠事件（非作用中的視窗也收得到），說明放在圓環下方的標籤。不做拖曳調整位置，
//! 位置由設定 `edgeDockOffset`（0.1–0.9，垂直位置比例）決定，只放在主螢幕。

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

use super::state::AppState;
use crate::settings::Settings;

pub const DOCK: &str = "dock";
/// 前端事件（dock 視窗）：`{ expanded, side }`。
pub const EVT_DOCK: &str = "dock-state";

/// 上游 `EDGE_DOCK_METRICS`（邏輯像素）：peek 7 × 34，rail 寬 64、每格 70。這裡的格子含標籤，稍矮。
const PEEK: (f64, f64) = (8.0, 44.0);
const RAIL_WIDTH: f64 = 64.0;
const CELL_HEIGHT: f64 = 62.0;
const RAIL_PADDING: f64 = 10.0;

#[derive(Debug, Clone, Serialize)]
pub struct DockView {
    pub expanded: bool,
    pub side: String,
}

static EXPANDED: AtomicBool = AtomicBool::new(false);

/// 目前的 dock 狀態（前端啟動時問一次）。
pub fn current(app: &AppHandle) -> DockView {
    DockView {
        expanded: EXPANDED.load(Ordering::SeqCst),
        side: app.state::<AppState>().settings().edge_dock_side,
    }
}

/// 依設定建立、移除或重新擺放 dock。
pub fn sync(app: &AppHandle) {
    let settings = app.state::<AppState>().settings();
    let existing = app.get_webview_window(DOCK);
    if !settings.edge_dock_enabled {
        if let Some(w) = existing {
            let _ = w.destroy();
        }
        return;
    }
    let w = match existing {
        Some(w) => w,
        None => match WebviewWindowBuilder::new(
            app,
            DOCK,
            WebviewUrl::App("index.html?view=dock".into()),
        )
        .title("Token Monitor Dock")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .focused(false)
        .visible(false)
        .build()
        {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!(error = %e, "failed to create the edge dock");
                return;
            }
        },
    };
    place(app, &settings, None);
    let _ = w.show();
}

/// 擺到主螢幕的邊緣。`cells` = 展開時的格數，`None` = 收成 peek。
fn place(app: &AppHandle, settings: &Settings, cells: Option<u32>) {
    let Some(w) = app.get_webview_window(DOCK) else {
        return;
    };
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let (lw, lh) = match cells {
        Some(n) => (
            RAIL_WIDTH,
            n.max(1) as f64 * CELL_HEIGHT + 2.0 * RAIL_PADDING,
        ),
        None => PEEK,
    };
    let (pw, ph) = ((lw * scale).round() as i32, (lh * scale).round() as i32);
    let screen_x = monitor.position().x;
    let screen_w = monitor.size().width as i32;
    let work = monitor.work_area();
    let (wy, wh) = (work.position.y, work.size.height as i32);
    let x = if settings.edge_dock_side == "left" {
        screen_x
    } else {
        screen_x + screen_w - pw
    };
    let center = wy + (settings.edge_dock_offset * wh as f64).round() as i32;
    let y = (center - ph / 2).clamp(wy, (wy + wh - ph).max(wy));
    let _ = w.set_size(PhysicalSize::new(pw as u32, ph as u32));
    let _ = w.set_position(PhysicalPosition::new(x, y));
    EXPANDED.store(cells.is_some(), Ordering::SeqCst);
    let _ = app.emit_to(
        DOCK,
        EVT_DOCK,
        DockView {
            expanded: cells.is_some(),
            side: settings.edge_dock_side.clone(),
        },
    );
}

#[tauri::command]
pub fn dock_get(app: AppHandle) -> DockView {
    current(&app)
}

/// 游標碰到 peek：展開成 `cells` 格。
#[tauri::command]
pub fn dock_expand(app: AppHandle, cells: u32) {
    let settings = app.state::<AppState>().settings();
    place(&app, &settings, Some(cells.min(12)));
}

#[tauri::command]
pub fn dock_collapse(app: AppHandle) {
    let settings = app.state::<AppState>().settings();
    place(&app, &settings, None);
}

/// 點圓環：叫出 widget 並切到額度分頁。
#[tauri::command]
pub fn dock_open_limits(app: AppHandle) {
    super::window::show_main(&app);
    let _ = app.emit(super::tray::EVT_OPEN_TAB, "limits");
}
