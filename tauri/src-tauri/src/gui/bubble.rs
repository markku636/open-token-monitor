//! 浮動泡泡（上游 floatingBubble.js 與 main.js `collapseFloatingBubble` / `expandFloatingBubble`）。
//!
//! 浮動模式且 `floatingBubbleEnabled` 開啟時，widget 失去焦點 180 ms 後縮成貼在螢幕左右邊緣的小把手
//! （顯示今日 token），按一下還原成原本的大小；在 widget 上按 Esc 立刻收合。把手可以拖著上下移動。
//!
//! - 左右邊看視窗中心在工作區的哪一半（上游 `floatingBubbleSide`）；把手垂直置中於原本的視窗。
//! - 還原時以把手目前的位置為錨：貼左邊就從把手往右長、貼右邊就往左長，再夾回工作區留 8 px。
//! - 收合前的位置與大小只存在記憶體；結束程式前先還原（`restore_for_exit`），window-state plugin
//!   才不會把把手的大小存成下次啟動的視窗大小。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize};

use super::state::AppState;
use super::window;
use crate::settings::WindowMode;

/// 前端事件：`{ collapsed, side }`。
pub const EVT_BUBBLE: &str = "bubble-state";
/// 把手的大小（邏輯像素）。
const HANDLE: (f64, f64) = (52.0, 28.0);
/// 與 tauri.conf.json 的 minWidth / minHeight 相同。
const MIN_SIZE: (f64, f64) = (260.0, 220.0);
const MARGIN: i32 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Left,
    Right,
}

#[derive(Debug, Clone, Serialize)]
pub struct BubbleView {
    pub collapsed: bool,
    pub side: Option<Side>,
}

/// 實體像素的矩形 (x, y, 寬, 高)。
pub type Rect = (i32, i32, i32, i32);

#[derive(Default)]
struct State {
    collapsed: bool,
    side: Option<Side>,
    expanded: Option<Rect>,
}

static STATE: Mutex<State> = Mutex::new(State {
    collapsed: false,
    side: None,
    expanded: None,
});
/// 剛還原時會收到一次失去焦點（按把手的那一下），這段時間不收合（上游 `suppressNextCollapse`）。
static SUPPRESS: AtomicBool = AtomicBool::new(false);

/// 上游 `floatingBubbleSide`。
pub fn side_of(bounds: Rect, work: Rect) -> Side {
    let center = bounds.0 as f64 + bounds.2 as f64 / 2.0;
    let work_center = work.0 as f64 + work.2 as f64 / 2.0;
    if center <= work_center {
        Side::Left
    } else {
        Side::Right
    }
}

/// 上游 `clampBounds`：夾在工作區內，左右留 `mx`、上下留 `my`。
fn clamp(bounds: Rect, work: Rect, mx: i32, my: i32) -> Rect {
    let (x, y, w, h) = bounds;
    let min_x = work.0 + mx;
    let max_x = (work.0 + work.2 - w - mx).max(min_x);
    let min_y = work.1 + my;
    let max_y = (work.1 + work.3 - h - my).max(min_y);
    (x.clamp(min_x, max_x), y.clamp(min_y, max_y), w, h)
}

/// 上游 `collapsedFloatingBubbleBounds`：把手貼在視窗靠近的那一邊、垂直置中。Windows 上貼齊螢幕邊（不留邊距）。
pub fn collapsed_bounds(bounds: Rect, work: Rect, handle: (i32, i32)) -> (Side, Rect) {
    let side = side_of(bounds, work);
    let (hw, hh) = handle;
    let x = match side {
        Side::Left => bounds.0,
        Side::Right => bounds.0 + bounds.2 - hw,
    };
    let y = bounds.1 + (bounds.3 - hh) / 2;
    (side, clamp((x, y, hw, hh), work, 0, 0))
}

/// 上游 `expandedFloatingBubbleBounds`。
pub fn expanded_bounds(handle: Rect, work: Rect, size: (i32, i32)) -> Rect {
    let (w, h) = size;
    let x = match side_of(handle, work) {
        Side::Left => handle.0,
        Side::Right => handle.0 + handle.2 - w,
    };
    let y = handle.1 + (handle.3 - h) / 2;
    clamp((x, y, w, h), work, MARGIN, MARGIN)
}

fn enabled(app: &AppHandle) -> bool {
    let s = app.state::<AppState>().settings();
    s.floating_bubble_enabled && s.window_mode == WindowMode::Floating
}

fn bounds_and_work(app: &AppHandle) -> Option<(Rect, Rect, f64)> {
    let w = window::main_window(app)?;
    let pos = w.outer_position().ok()?;
    let size = w.outer_size().ok()?;
    let monitor = w.current_monitor().ok()??;
    // Windows 上把手貼齊螢幕邊（上游 `floatingBubbleCollapsedArea` 在 win32 用 display.bounds）。
    let area = if cfg!(windows) {
        (
            monitor.position().x,
            monitor.position().y,
            monitor.size().width as i32,
            monitor.size().height as i32,
        )
    } else {
        let work = monitor.work_area();
        (
            work.position.x,
            work.position.y,
            work.size.width as i32,
            work.size.height as i32,
        )
    };
    Some((
        (pos.x, pos.y, size.width as i32, size.height as i32),
        area,
        monitor.scale_factor(),
    ))
}

fn emit(app: &AppHandle, collapsed: bool, side: Option<Side>) {
    let _ = app.emit(EVT_BUBBLE, BubbleView { collapsed, side });
}

pub fn current(app: &AppHandle) -> BubbleView {
    let _ = app;
    let s = STATE.lock().unwrap();
    BubbleView {
        collapsed: s.collapsed,
        side: s.side,
    }
}

/// widget 失去焦點：180 ms 後仍沒有焦點就收合（上游 `scheduleFloatingBubbleAutoCollapse`）。
pub fn on_blur(app: &AppHandle) {
    if !enabled(app) || SUPPRESS.load(Ordering::SeqCst) || STATE.lock().unwrap().collapsed {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(180)).await;
        let focused = window::main_window(&app)
            .and_then(|w| w.is_focused().ok())
            .unwrap_or(true);
        if !focused {
            collapse(&app);
        }
    });
}

pub fn collapse(app: &AppHandle) {
    if !enabled(app) {
        return;
    }
    let Some(w) = window::main_window(app) else {
        return;
    };
    if !w.is_visible().unwrap_or(false) {
        return;
    }
    let Some((bounds, area, scale)) = bounds_and_work(app) else {
        return;
    };
    let mut st = STATE.lock().unwrap();
    if st.collapsed {
        return;
    }
    let handle = (
        (HANDLE.0 * scale).round() as i32,
        (HANDLE.1 * scale).round() as i32,
    );
    let (side, (x, y, hw, hh)) = collapsed_bounds(bounds, area, handle);
    st.collapsed = true;
    st.side = Some(side);
    st.expanded = Some(bounds);
    drop(st);
    let _ = w.set_min_size(None::<LogicalSize<f64>>);
    let _ = w.set_resizable(false);
    // 上游在 Windows 上以 `skipTaskbar`、不可最大化／最小化的視窗重建把手；這裡原地改。
    // 最大化的視窗在 set_size 時會被還原，那時已經是收合狀態，`windowMaximized` 不會被改掉。
    let _ = w.set_maximizable(false);
    let _ = w.set_minimizable(false);
    let _ = w.set_size(PhysicalSize::new(hw as u32, hh as u32));
    let _ = w.set_position(PhysicalPosition::new(x, y));
    window::sync_taskbar(app);
    emit(app, true, Some(side));
}

/// 還原（按把手、關閉泡泡、換視窗模式、結束程式）。`focus` = 還原後是否取得焦點。
pub fn expand(app: &AppHandle, focus: bool) {
    let Some(w) = window::main_window(app) else {
        return;
    };
    let mut st = STATE.lock().unwrap();
    if !st.collapsed {
        return;
    }
    let expanded = st.expanded.take();
    st.collapsed = false;
    st.side = None;
    drop(st);
    let _ = w.set_resizable(true);
    let _ = w.set_minimizable(true);
    let settings = app.state::<AppState>().settings();
    let _ = w.set_maximizable(crate::window_policy::maximizable(&settings));
    let _ = w.set_min_size(Some(LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1)));
    if let (Some((_, _, ew, eh)), Some((handle, _, _))) = (expanded, bounds_and_work(app)) {
        let work = w
            .current_monitor()
            .ok()
            .flatten()
            .map(|m| {
                let a = m.work_area();
                (
                    a.position.x,
                    a.position.y,
                    a.size.width as i32,
                    a.size.height as i32,
                )
            })
            .unwrap_or(handle);
        let (x, y, width, height) = expanded_bounds(handle, work, (ew, eh));
        let _ = w.set_size(PhysicalSize::new(width as u32, height as u32));
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
    window::sync_taskbar(app);
    emit(app, false, None);
    if focus {
        SUPPRESS.store(true, Ordering::SeqCst);
        let _ = w.set_focus();
        // 上游 expandFloatingBubble：要取得焦點的還原才照 `windowMaximized` 最大化回去。
        window::restore_maximized(app, &w);
        tauri::async_runtime::spawn(async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            SUPPRESS.store(false, Ordering::SeqCst);
        });
    }
}

/// 設定改變：關掉泡泡或換了視窗模式就先還原。
pub fn sync(app: &AppHandle) {
    if !enabled(app) {
        expand(app, false);
    }
}

/// 結束前還原，window-state plugin 存的才是正常大小。
pub fn restore_for_exit(app: &AppHandle) {
    expand(app, false);
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: Rect = (0, 0, 1920, 1080);

    #[test]
    fn collapses_to_the_nearer_edge_and_centers_on_the_window() {
        let (side, r) = collapsed_bounds((1500, 200, 500, 800), WORK, (76, 41));
        assert_eq!(side, Side::Right);
        assert_eq!(r, (1844, 579, 76, 41), "right edge of the (clamped) window");
        let (side, r) = collapsed_bounds((100, 200, 500, 800), WORK, (76, 41));
        assert_eq!(side, Side::Left);
        assert_eq!(r, (100, 579, 76, 41));
    }

    #[test]
    fn expands_away_from_the_edge_inside_the_work_area() {
        assert_eq!(
            expanded_bounds((1844, 579, 76, 41), WORK, (500, 800)),
            (1412, 200, 500, 800)
        );
        assert_eq!(
            expanded_bounds((0, 1050, 76, 30), WORK, (500, 800)),
            (8, 272, 500, 800)
        );
    }
}
