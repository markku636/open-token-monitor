//! 視窗行為：widget 模式、顯示 / 隱藏、設定視窗。
//!
//! 模式（對應上游 src/electron/windowBehavior.js）：
//! - `floating`：永遠在最上層、可拖曳縮放。
//! - `normal`：一般視窗。
//! - `desktop`：貼在最底層（桌面上方），不可縮放；Win+D 仍會把它藏起來。
//! - `tray`：平常隱藏，按 tray 圖示（或快捷鍵）時在圖示旁彈出，失去焦點就收起來
//!   （上游 main.js `showPopover` / `togglePopover`，位置見 `popover_position`）。
//!
//! 工作列按鈕、最小化／最大化與關閉的規則在 `crate::window_policy`（上游 trayModeSettings.js、
//! windowState.js）：除了系統匣模式與 `hideAppIcon`，工作列都有 widget 的按鈕；最大化狀態存在
//! 設定 `windowMaximized`，顯示視窗時照它還原。
//!
//! Tauri（tao）的 always-on-top 是 `HWND_TOPMOST`，不像 Electron 的 floating 等級會自己降到
//! 工作列後面；但工作列取得啟用時仍會蓋上來，`keepAboveTaskbar` 開啟時由 taskbar.rs 重新置頂。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use super::state::AppState;
use crate::settings::{Settings, WindowMode};
use crate::window_policy::{self as policy, CloseAction};

pub const MAIN: &str = "main";
pub const SETTINGS: &str = "settings";
pub const DASHBOARD: &str = "dashboard";

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

pub fn apply_mode(app: &AppHandle, settings: &Settings) {
    let Some(w) = main_window(app) else { return };
    let mode = settings.window_mode;
    let result = match mode {
        WindowMode::Floating => w
            .set_always_on_bottom(false)
            .and_then(|_| w.set_always_on_top(true))
            .and_then(|_| w.set_resizable(true)),
        WindowMode::Normal => w
            .set_always_on_top(false)
            .and_then(|_| w.set_always_on_bottom(false))
            .and_then(|_| w.set_resizable(true)),
        WindowMode::Desktop => w
            .set_always_on_top(false)
            .and_then(|_| w.set_always_on_bottom(true))
            .and_then(|_| w.set_resizable(false)),
        WindowMode::Tray => {
            // 上游 enterTrayMode `suspendWindowMaximized`：popover 不能是最大化的，但
            // `windowMaximized` 不動（此時已是系統匣模式，on_resized 不會記），離開時照它還原。
            if w.is_maximized().unwrap_or(false) {
                let _ = w.unmaximize();
            }
            w.set_always_on_bottom(false)
                .and_then(|_| w.set_always_on_top(true))
                .and_then(|_| w.set_resizable(true))
                .and_then(|_| w.hide())
        }
    };
    if let Err(e) = result {
        tracing::warn!(error = %e, ?mode, "failed to apply window mode");
    }
    // 收合的泡泡自己管這兩項（bubble.rs）。
    if !super::bubble::current(app).collapsed {
        let _ = w.set_maximizable(policy::maximizable(settings));
        let _ = w.set_minimizable(true);
    }
    sync_taskbar(app);
}

fn settings(app: &AppHandle) -> Settings {
    app.state::<AppState>().settings()
}

fn tray_mode(app: &AppHandle) -> bool {
    settings(app).window_mode == WindowMode::Tray
}

/// 依設定（重新）套用工作列按鈕：上游 `skipTaskbarForSettings`，收合的泡泡一律不顯示。
///
/// 每次顯示視窗後都要再套一次：tao 的 `set_skip_taskbar` 是 `ITaskbarList::DeleteTab` /
/// `AddTab`，視窗藏起來再顯示時 Explorer 會自己決定要不要放按鈕。藏著的視窗不 `AddTab`
/// （會在工作列留下一個點了沒反應的按鈕），等顯示時再套。
pub fn sync_taskbar(app: &AppHandle) {
    let Some(w) = main_window(app) else { return };
    let skip = policy::skip_taskbar(&settings(app)) || super::bubble::current(app).collapsed;
    if !skip && !w.is_visible().unwrap_or(false) {
        return;
    }
    if let Err(e) = w.set_skip_taskbar(skip) {
        tracing::warn!(error = %e, skip, "failed to update the taskbar button");
    }
}

/// 上一次看到的最大化狀態；只有狀態真的改變時才寫回設定（上游的 maximize / unmaximize 事件）。
static LAST_MAXIMIZED: AtomicBool = AtomicBool::new(false);

/// 主視窗大小改變（含最大化、還原）：把最大化狀態寫回 `windowMaximized`。
/// 系統匣模式與收合的泡泡不記（上游 `shouldTrackWindowMaximized`）。
pub fn on_resized(app: &AppHandle) {
    let Some(w) = main_window(app) else { return };
    // 最小化時 tao 會把最大化旗標清掉（WM_SIZE 的 SIZE_MINIMIZED），那不是使用者還原了視窗。
    if w.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = w.is_maximized().unwrap_or(false);
    if LAST_MAXIMIZED.swap(maximized, Ordering::SeqCst) == maximized {
        return;
    }
    if policy::track_maximized(&settings(app), super::bubble::current(app).collapsed) {
        super::commands::persist_window_maximized(app, maximized);
    }
}

/// 顯示 widget 時照 `windowMaximized` 還原成最大化（上游 `restoreWindowMaximized`）。
pub fn restore_maximized(app: &AppHandle, w: &WebviewWindow) {
    if policy::restore_maximized(&settings(app), super::bubble::current(app).collapsed)
        && !w.is_maximized().unwrap_or(true)
    {
        let _ = w.maximize();
    }
}

/// 啟動時第一次顯示（前端首次繪製、或 4 秒保險絲）。系統匣模式不顯示，等使用者按 tray 圖示。
pub fn reveal_main(app: &AppHandle) {
    if tray_mode(app) {
        return;
    }
    if let Some(w) = main_window(app) {
        let _ = w.show();
        restore_maximized(app, &w);
        sync_taskbar(app);
    }
}

/// 標題列的最小化鈕（上游 `window:minimize`）：系統匣模式收回 popover，其他模式最小化。
pub fn minimize_main(app: &AppHandle) {
    let Some(w) = main_window(app) else { return };
    if policy::minimize_hides(&settings(app)) {
        let _ = w.hide();
    } else {
        let _ = w.minimize();
    }
    super::taskbar::wake();
}

/// 標題列的最大化鈕：最大化 ↔ 還原；桌面與系統匣模式不能最大化。雙擊標題列走 Tauri 內建的
/// `internal_toggle_maximize`，結果一樣由 `on_resized` 記下來。
pub fn toggle_maximize_main(app: &AppHandle) {
    let Some(w) = main_window(app) else { return };
    if w.is_maximized().unwrap_or(false) {
        let _ = w.unmaximize();
    } else if policy::maximizable(&settings(app)) && !super::bubble::current(app).collapsed {
        let _ = w.maximize();
    }
}

/// 關閉 widget（× 與 Alt+F4，上游 `mainWindowCloseAction`）：有系統匣圖示就藏起來，
/// 沒有就結束程式——否則藏起來的視窗再也叫不回來。
pub fn close_main(app: &AppHandle) {
    match policy::close_action(&settings(app)) {
        CloseAction::Hide => {
            if let Some(w) = main_window(app) {
                let _ = w.hide();
            }
            super::taskbar::wake();
        }
        CloseAction::Quit => super::quit(app),
    }
}

/// 最近一次點 tray 圖示時圖示的位置與大小（實體像素）；popover 以它為錨點。
static TRAY_ANCHOR: Mutex<Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>> = Mutex::new(None);
/// popover 剛顯示時會收到一次失去焦點（點 tray 的那一下焦點還在工作列），這段時間不收起來。
static SUPPRESS_BLUR_HIDE: AtomicBool = AtomicBool::new(false);

pub fn set_tray_anchor(position: PhysicalPosition<i32>, size: PhysicalSize<u32>) {
    *TRAY_ANCHOR.lock().unwrap() = Some((position, size));
}

/// 上游 tray.js `popoverBounds`：水平置中於圖示、在圖示上方 8 px（放不下改到下方），夾在工作區內留 4 px。
/// `anchor` = (圖示中心 x, 圖示上緣 y, 圖示高度)；`work` = 工作區 (x, y, 寬, 高)。
pub fn popover_position(
    anchor: (i32, i32, i32),
    size: (i32, i32),
    work: (i32, i32, i32, i32),
) -> (i32, i32) {
    let (ax, ay, ah) = anchor;
    let (w, h) = size;
    let (wx, wy, ww, wh) = work;
    let x = (ax - w / 2).min(wx + ww - w - 4).max(wx + 4);
    let mut y = ay - h - 8;
    if y < wy + 4 {
        y = ay + ah + 8;
    }
    let y = y.min(wy + wh - h - 4).max(wy + 4);
    (x, y)
}

fn show_popover(app: &AppHandle, w: &WebviewWindow) {
    let anchor = *TRAY_ANCHOR.lock().unwrap();
    let (ax, ay, ah) = match anchor {
        Some((pos, size)) => (pos.x + size.width as i32 / 2, pos.y, size.height as i32),
        None => match app.cursor_position() {
            Ok(p) => (p.x as i32, p.y as i32, 0),
            Err(_) => (0, 0, 0),
        },
    };
    if let (Ok(size), Ok(Some(monitor))) =
        (w.outer_size(), app.monitor_from_point(ax as f64, ay as f64))
    {
        let work = monitor.work_area();
        let (x, y) = popover_position(
            (ax, ay, ah),
            (size.width as i32, size.height as i32),
            (
                work.position.x,
                work.position.y,
                work.size.width as i32,
                work.size.height as i32,
            ),
        );
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
    SUPPRESS_BLUR_HIDE.store(true, Ordering::SeqCst);
    let _ = w.show();
    let _ = w.set_focus();
    sync_taskbar(app);
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(Duration::from_millis(250)).await;
        SUPPRESS_BLUR_HIDE.store(false, Ordering::SeqCst);
    });
}

/// 系統匣模式下 widget 失去焦點就收起來。
pub fn on_blur(app: &AppHandle) {
    if tray_mode(app) && !SUPPRESS_BLUR_HIDE.load(Ordering::SeqCst) {
        if let Some(w) = main_window(app) {
            let _ = w.hide();
        }
    }
}

pub fn show_main(app: &AppHandle) {
    if super::bubble::current(app).collapsed {
        super::bubble::expand(app, true);
        return;
    }
    if tray_mode(app) {
        if let Some(w) = main_window(app) {
            show_popover(app, &w);
        }
        return;
    }
    if let Some(w) = main_window(app) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        // 上游 focusExistingWindow：顯示後照 `windowMaximized` 還原。
        restore_maximized(app, &w);
        sync_taskbar(app);
    }
    super::taskbar::wake();
}

/// 上游 `windowToggleShortcutAction`：看得到（而且沒縮小）就藏起來，否則叫出來。
pub fn toggle_main(app: &AppHandle) {
    if super::bubble::current(app).collapsed {
        super::bubble::expand(app, true);
        return;
    }
    if let Some(w) = main_window(app) {
        if tray_mode(app) {
            // 上游 `togglePopover`：看得到而且有焦點才收，否則（例如被別的視窗蓋住）叫到前面。
            if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
                let _ = w.hide();
            } else {
                show_popover(app, &w);
            }
            return;
        }
        if w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
            let _ = w.hide();
            super::taskbar::wake();
        } else {
            show_main(app);
        }
    }
}

/// 用量儀表板（上游 main.js `createDashboardWindow`）：一般視窗，大小與位置由 window-state 記住。
pub fn open_dashboard(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(DASHBOARD) {
        w.show()?;
        w.unminimize()?;
        w.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        DASHBOARD,
        WebviewUrl::App("index.html?view=dashboard".into()),
    )
    .title("Token Monitor")
    .inner_size(980.0, 700.0)
    .min_inner_size(640.0, 480.0)
    .resizable(true)
    .center()
    .build()?;
    Ok(())
}

pub fn open_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(SETTINGS) {
        w.show()?;
        w.unminimize()?;
        w.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        SETTINGS,
        WebviewUrl::App("index.html?view=settings".into()),
    )
    .title("Token Monitor 設定")
    .inner_size(640.0, 600.0)
    .min_inner_size(520.0, 420.0)
    .resizable(true)
    .center()
    .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::popover_position;

    const WORK: (i32, i32, i32, i32) = (0, 0, 1920, 1032);

    #[test]
    fn popover_opens_above_a_bottom_taskbar_icon() {
        // 圖示在工作區外（工作列上），所以底邊貼齊工作區底部再留 4 px。
        assert_eq!(
            popover_position((1700, 1040, 32), (500, 800), WORK),
            (1416, 228)
        );
    }

    #[test]
    fn popover_stays_inside_the_work_area() {
        assert_eq!(popover_position((10, 1040, 32), (500, 800), WORK), (4, 228));
        // 工作列在上方：上面放不下就放到圖示下方。
        let top = (0, 40, 1920, 1040);
        assert_eq!(popover_position((900, 4, 32), (500, 800), top), (650, 44));
    }
}
