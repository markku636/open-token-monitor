//! Windows：widget 拖到工作列上時，讓它留在工作列上面（上游 windowsTaskbarZOrder.js +
//! windowsForegroundHook.js，上游 issue #533）。只在 `floating` 模式且 `keepAboveTaskbar` 開啟時運作。
//!
//! 工作列取得啟用時，Windows 會把 Shell_TrayWnd 抬到 topmost 層的最上面；被蓋過的視窗收不到任何
//! 通知。所以：
//! - 視窗與工作列保留區重疊時，每 250 ms 重新 `SetWindowPos(HWND_TOPMOST)` 一次（不啟用、不搶焦點）。
//! - 系統任何視窗取得前景（`SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`，out-of-context，不注入別的程序）
//!   或 widget 自己失去焦點時，立刻重設，並在 60 / 200 / 400 / 800 ms 後再各補一次：shell 抬起工作列
//!   的時間點在事件之後，只做一次會被蓋回去。
//! - 視窗完全在工作區內時什麼都不跑（計時器與系統 hook 都拆掉）。
//!
//! tao 的 `set_always_on_top(true)` 只在狀態改變時才呼叫 `SetWindowPos`，重複呼叫不會重新置頂，
//! 所以這裡直接呼叫 Win32。

/// 實體像素的矩形（左上角 + 寬高）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn right(&self) -> i64 {
        self.x as i64 + self.width as i64
    }
    fn bottom(&self) -> i64 {
        self.y as i64 + self.height as i64
    }
    fn valid(&self) -> bool {
        self.width > 0 && self.height > 0
    }
}

/// 上游 `overlapsReservedArea`：視窗在這個螢幕上、而且有一部分落在工作區外（工作列在任何一邊都算）。
pub fn overlaps_reserved_area(bounds: Rect, screen: Rect, work_area: Rect) -> bool {
    if !bounds.valid() || !screen.valid() || !work_area.valid() {
        return false;
    }
    let intersects = (bounds.x as i64) < screen.right()
        && bounds.right() > screen.x as i64
        && (bounds.y as i64) < screen.bottom()
        && bounds.bottom() > screen.y as i64;
    if !intersects {
        return false;
    }
    let ix = bounds.x.max(screen.x) as i64;
    let iy = bounds.y.max(screen.y) as i64;
    let ir = bounds.right().min(screen.right());
    let ib = bounds.bottom().min(screen.bottom());
    let inside = ix >= work_area.x as i64
        && iy >= work_area.y as i64
        && ir <= work_area.right()
        && ib <= work_area.bottom();
    !inside
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use tauri::AppHandle;
    use tokio::sync::Notify;
    use tokio::time::Instant;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, EVENT_SYSTEM_FOREGROUND, HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
    };

    use super::{overlaps_reserved_area, Rect};
    use crate::gui::window;

    const INTERVAL: Duration = Duration::from_millis(250);
    const NUDGE_DELAYS_MS: [u64; 4] = [60, 200, 400, 800];

    struct Keeper {
        enabled: AtomicBool,
        /// 視窗移動、縮放、顯示或設定改變：重新判斷要不要運作。
        wake: Notify,
        /// 前景換了（系統 hook 或 widget 失去焦點）：立刻重設並補幾次。
        nudge: Notify,
        /// 已安裝的 hook（`HWINEVENTHOOK` 的值；0 = 沒有）。只在主執行緒安裝與拆除。
        hook: Mutex<isize>,
    }

    static KEEPER: OnceLock<Keeper> = OnceLock::new();

    fn keeper() -> &'static Keeper {
        KEEPER.get_or_init(|| Keeper {
            enabled: AtomicBool::new(false),
            wake: Notify::new(),
            nudge: Notify::new(),
            hook: Mutex::new(0),
        })
    }

    /// hook 的 callback 在主執行緒的訊息迴圈裡執行：只做交接，不碰 Tauri。
    unsafe extern "system" fn on_foreground(
        _hook: HWINEVENTHOOK,
        _event: u32,
        _hwnd: HWND,
        _id_object: i32,
        _id_child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if let Some(k) = KEEPER.get() {
            k.nudge.notify_one();
        }
    }

    fn set_hook(app: &AppHandle, install: bool) {
        let _ = app.run_on_main_thread(move || {
            let k = keeper();
            let mut hook = k.hook.lock().unwrap();
            if install && *hook == 0 {
                let h = unsafe {
                    SetWinEventHook(
                        EVENT_SYSTEM_FOREGROUND,
                        EVENT_SYSTEM_FOREGROUND,
                        None,
                        Some(on_foreground),
                        0,
                        0,
                        WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                    )
                };
                if h.is_invalid() {
                    tracing::warn!("foreground hook unavailable; interval re-assert only");
                } else {
                    *hook = h.0 as isize;
                }
            } else if !install && *hook != 0 {
                unsafe {
                    let _ = UnhookWinEvent(HWINEVENTHOOK(*hook as _));
                }
                *hook = 0;
            }
        });
    }

    fn should_keep(app: &AppHandle) -> bool {
        let Some(w) = window::main_window(app) else {
            return false;
        };
        if !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(true) {
            return false;
        }
        let (Ok(pos), Ok(size), Ok(Some(monitor))) =
            (w.outer_position(), w.outer_size(), w.current_monitor())
        else {
            return false;
        };
        let work = monitor.work_area();
        overlaps_reserved_area(
            Rect {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
            },
            Rect {
                x: monitor.position().x,
                y: monitor.position().y,
                width: monitor.size().width,
                height: monitor.size().height,
            },
            Rect {
                x: work.position.x,
                y: work.position.y,
                width: work.size.width,
                height: work.size.height,
            },
        )
    }

    fn reassert(app: &AppHandle) {
        let Some(hwnd) = window::main_window(app).and_then(|w| w.hwnd().ok()) else {
            return;
        };
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_ASYNCWINDOWPOS | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }

    async fn run(app: AppHandle) {
        let k = keeper();
        let mut hooked = false;
        let mut follow_ups: Vec<Instant> = Vec::new();
        let mut next_tick = Instant::now();
        loop {
            let keep = k.enabled.load(Ordering::SeqCst) && should_keep(&app);
            if !keep {
                if hooked {
                    set_hook(&app, false);
                    hooked = false;
                    tracing::info!("taskbar keeper stopped");
                }
                follow_ups.clear();
                tokio::select! {
                    _ = k.wake.notified() => {}
                    _ = k.nudge.notified() => {}
                }
                next_tick = Instant::now();
                continue;
            }
            if !hooked {
                set_hook(&app, true);
                hooked = true;
                tracing::info!("widget overlaps the taskbar; keeping it on top");
            }
            let now = Instant::now();
            let due = now >= next_tick || follow_ups.iter().any(|t| *t <= now);
            follow_ups.retain(|t| *t > now);
            if due {
                reassert(&app);
                if now >= next_tick {
                    next_tick = now + INTERVAL;
                }
            }
            let deadline = follow_ups.iter().copied().fold(next_tick, Instant::min);
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {}
                _ = k.nudge.notified() => {
                    reassert(&app);
                    // 事件常一次來好幾個：只保留最新一批補強。
                    let n = Instant::now();
                    follow_ups = NUDGE_DELAYS_MS.iter().map(|ms| n + Duration::from_millis(*ms)).collect();
                }
                _ = k.wake.notified() => next_tick = Instant::now(),
            }
        }
    }

    static STARTED: AtomicBool = AtomicBool::new(false);

    pub fn configure(app: &AppHandle, enabled: bool) {
        let k = keeper();
        k.enabled.store(enabled, Ordering::SeqCst);
        if !STARTED.swap(true, Ordering::SeqCst) {
            let app = app.clone();
            tauri::async_runtime::spawn(run(app));
        }
        k.wake.notify_one();
    }

    pub fn wake() {
        if let Some(k) = KEEPER.get() {
            k.wake.notify_one();
        }
    }

    pub fn nudge() {
        if let Some(k) = KEEPER.get() {
            if k.enabled.load(Ordering::SeqCst) {
                k.nudge.notify_one();
            }
        }
    }
}

#[cfg(windows)]
pub use imp::{configure, nudge, wake};

#[cfg(not(windows))]
pub fn configure(_app: &tauri::AppHandle, _enabled: bool) {}
#[cfg(not(windows))]
pub fn wake() {}
#[cfg(not(windows))]
pub fn nudge() {}

/// 設定是否要求保持在工作列上方（上游 `taskbarZOrderEnabled`）。
pub fn enabled_for(settings: &crate::settings::Settings) -> bool {
    cfg!(windows)
        && settings.window_mode == crate::settings::WindowMode::Floating
        && settings.keep_above_taskbar
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };
    const WORK: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1032,
    };

    fn at(x: i32, y: i32) -> Rect {
        Rect {
            x,
            y,
            width: 340,
            height: 200,
        }
    }

    #[test]
    fn only_windows_reaching_into_the_taskbar_are_kept() {
        assert!(!overlaps_reserved_area(at(100, 100), SCREEN, WORK));
        assert!(
            !overlaps_reserved_area(at(100, 832), SCREEN, WORK),
            "touching the edge is still inside"
        );
        assert!(overlaps_reserved_area(at(100, 900), SCREEN, WORK));
        assert!(
            !overlaps_reserved_area(at(3000, 900), SCREEN, WORK),
            "on another screen"
        );
    }

    #[test]
    fn a_left_taskbar_counts_too() {
        let work = Rect {
            x: 62,
            y: 0,
            width: 1858,
            height: 1080,
        };
        assert!(overlaps_reserved_area(at(10, 100), SCREEN, work));
        assert!(!overlaps_reserved_area(at(100, 100), SCREEN, work));
    }
}
