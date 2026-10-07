//! 視窗行為：widget 模式、顯示 / 隱藏、設定視窗。
//!
//! 模式（對應上游 src/electron/windowBehavior.js）：
//! - `floating`：永遠在最上層、不出現在工作列、可拖曳縮放。
//! - `normal`：一般視窗，出現在工作列。
//! - `desktop`：貼在最底層（桌面上方），不可縮放；Win+D 仍會把它藏起來。
//! - `tray`：平常隱藏，按 tray 圖示（或快捷鍵）時在圖示旁彈出，失去焦點就收起來
//!   （上游 main.js `showPopover` / `togglePopover`，位置見 `popover_position`）。
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

use crate::settings::WindowMode;

pub const MAIN: &str = "main";
pub const SETTINGS: &str = "settings";
pub const DASHBOARD: &str = "dashboard";

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

pub fn apply_mode(app: &AppHandle, mode: WindowMode) {
    let Some(w) = main_window(app) else { return };
    let result = match mode {
        WindowMode::Floating => w
            .set_always_on_bottom(false)
            .and_then(|_| w.set_always_on_top(true))
            .and_then(|_| w.set_skip_taskbar(true))
            .and_then(|_| w.set_resizable(true)),
        WindowMode::Normal => w
            .set_always_on_top(false)
            .and_then(|_| w.set_always_on_bottom(false))
            .and_then(|_| w.set_skip_taskbar(false))
            .and_then(|_| w.set_resizable(true)),
        WindowMode::Desktop => w
            .set_always_on_top(false)
            .and_then(|_| w.set_always_on_bottom(true))
            .and_then(|_| w.set_skip_taskbar(true))
            .and_then(|_| w.set_resizable(false)),
        WindowMode::Tray => w
            .set_always_on_bottom(false)
            .and_then(|_| w.set_always_on_top(true))
            .and_then(|_| w.set_skip_taskbar(true))
            .and_then(|_| w.set_resizable(true))
            .and_then(|_| w.hide()),
    };
    if let Err(e) = result {
        tracing::warn!(error = %e, ?mode, "failed to apply window mode");
    }
}

fn tray_mode(app: &AppHandle) -> bool {
    app.state::<super::state::AppState>().settings().window_mode == WindowMode::Tray
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
