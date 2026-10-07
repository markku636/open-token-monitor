//! widget 視窗的規則（上游 src/electron/trayModeSettings.js 與 windowState.js）。
//!
//! Tauri-free：`gui/window.rs` 照這裡的結果呼叫視窗 API，規則本身在 `--no-default-features` 下測。
//! 上游把「系統匣模式」與「視窗行為」分成 `trayMode` + `windowBehavior` 兩個鍵；我們只有一個
//! `windowMode`（`tray` 是其中一個值），所以「系統匣模式」= `window_mode == Tray`。

use crate::settings::{Settings, WindowMode};

/// 上游 `normalizeTrayModeSettings`：沒有系統匣圖示時，系統匣模式與 `hideAppIcon` 都收回——
/// 工作列按鈕與系統匣圖示都沒有的背景視窗，使用者既叫不回來也結束不了。手改 settings.json 也要
/// 同樣收斂，所以守在 `Settings::validate` 而不是 UI。
///
/// 系統匣模式退回浮動：上游退回另外記著的 `windowBehavior`（預設也是 floating），我們沒有那個鍵。
/// `hideAppIcon` 在系統匣模式時保留原值（上游同樣保留，離開系統匣模式後照它套用）。
pub fn normalize_tray_mode(s: &mut Settings) -> Vec<&'static str> {
    let mut changed = Vec::new();
    if s.show_tray_icon {
        return changed;
    }
    if s.window_mode == WindowMode::Tray {
        s.window_mode = WindowMode::Floating;
        changed.push("windowMode");
    }
    if s.hide_app_icon {
        s.hide_app_icon = false;
        changed.push("hideAppIcon");
    }
    changed
}

fn tray_mode(s: &Settings) -> bool {
    s.show_tray_icon && s.window_mode == WindowMode::Tray
}

/// 上游 `skipTaskbarForSettings`：系統匣模式或 `hideAppIcon` 時工作列不顯示 widget 的按鈕；
/// 其他時候（浮動、標準、桌面）都顯示。收合成泡泡時另外一律不顯示（`gui/bubble.rs`）。
pub fn skip_taskbar(s: &Settings) -> bool {
    tray_mode(s) || (s.show_tray_icon && s.hide_app_icon)
}

/// 關閉 widget（標題列的 ×、Alt+F4）要做什麼（上游 `mainWindowCloseAction`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// 收起來：系統匣模式收回 popover，其他模式藏到系統匣。
    Hide,
    /// 沒有系統匣圖示可以叫回來：直接結束程式。
    Quit,
}

pub fn close_action(s: &Settings) -> CloseAction {
    if tray_mode(s) || s.show_tray_icon {
        CloseAction::Hide
    } else {
        CloseAction::Quit
    }
}

/// 上游 `window:minimize`：系統匣模式收回 popover（它沒有「最小化」可言），其他模式最小化。
pub fn minimize_hides(s: &Settings) -> bool {
    tray_mode(s)
}

/// 能不能最大化：浮動與標準可以。系統匣的 popover 每次依圖示重新定位、大小固定（上游
/// `enterTrayMode` 的 `setWindowMaximizable(false)`）；桌面模式貼在最底層、不能縮放也不能拖曳。
pub fn maximizable(s: &Settings) -> bool {
    matches!(s.window_mode, WindowMode::Floating | WindowMode::Normal) && !tray_mode(s)
}

/// 上游 `shouldTrackWindowMaximized`：系統匣模式與收合的泡泡時，視窗的最大化狀態描述的不是
/// 「使用者會回到的那個視窗」，不寫回 `windowMaximized`。
pub fn track_maximized(s: &Settings, bubble_collapsed: bool) -> bool {
    !tray_mode(s) && !bubble_collapsed
}

/// 上游 `shouldRestoreWindowMaximized`：顯示 widget 時要不要照 `windowMaximized` 還原成最大化。
pub fn restore_maximized(s: &Settings, bubble_collapsed: bool) -> bool {
    track_maximized(s, bubble_collapsed) && s.window_maximized
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(mode: WindowMode, show_tray_icon: bool, hide_app_icon: bool) -> Settings {
        Settings {
            window_mode: mode,
            show_tray_icon,
            hide_app_icon,
            ..Settings::default()
        }
    }

    #[test]
    fn defaults_show_the_tray_icon_and_the_taskbar_button() {
        let s = Settings::default();
        assert!(s.show_tray_icon);
        assert!(!s.hide_app_icon);
        assert!(!s.window_maximized);
        // 上游預設浮動模式也有工作列按鈕。
        assert!(!skip_taskbar(&s));
        assert_eq!(close_action(&s), CloseAction::Hide);
        assert!(maximizable(&s));
    }

    #[test]
    fn without_a_tray_icon_tray_mode_and_hide_app_icon_fall_back() {
        let mut s = settings(WindowMode::Tray, false, true);
        assert_eq!(normalize_tray_mode(&mut s), vec!["windowMode", "hideAppIcon"]);
        assert_eq!(s.window_mode, WindowMode::Floating);
        assert!(!s.hide_app_icon);
        assert!(!skip_taskbar(&s), "the taskbar button is the only way back");
        assert_eq!(close_action(&s), CloseAction::Quit);

        // 其他模式不動，只收回 hideAppIcon。
        let mut s = settings(WindowMode::Desktop, false, true);
        assert_eq!(normalize_tray_mode(&mut s), vec!["hideAppIcon"]);
        assert_eq!(s.window_mode, WindowMode::Desktop);
    }

    #[test]
    fn a_tray_icon_keeps_hide_app_icon_even_in_tray_mode() {
        let mut s = settings(WindowMode::Tray, true, true);
        assert!(normalize_tray_mode(&mut s).is_empty());
        assert!(s.hide_app_icon, "kept for when tray mode is left");
    }

    #[test]
    fn skip_taskbar_follows_upstream() {
        for (mode, hide, skip) in [
            (WindowMode::Floating, false, false),
            (WindowMode::Normal, false, false),
            (WindowMode::Desktop, false, false),
            (WindowMode::Tray, false, true),
            (WindowMode::Floating, true, true),
            (WindowMode::Desktop, true, true),
            (WindowMode::Tray, true, true),
        ] {
            assert_eq!(
                skip_taskbar(&settings(mode, true, hide)),
                skip,
                "{mode:?} hideAppIcon={hide}"
            );
        }
        // 沒有系統匣圖示時 hideAppIcon 不算數（即使還沒經過 validate）。
        assert!(!skip_taskbar(&settings(WindowMode::Floating, false, true)));
    }

    #[test]
    fn minimize_and_close_in_tray_mode_hide_the_popover() {
        let s = settings(WindowMode::Tray, true, false);
        assert!(minimize_hides(&s));
        assert_eq!(close_action(&s), CloseAction::Hide);
        assert!(!minimize_hides(&settings(WindowMode::Floating, true, false)));
    }

    #[test]
    fn only_floating_and_normal_windows_maximize() {
        assert!(maximizable(&settings(WindowMode::Floating, true, false)));
        assert!(maximizable(&settings(WindowMode::Normal, true, true)));
        assert!(!maximizable(&settings(WindowMode::Desktop, true, false)));
        assert!(!maximizable(&settings(WindowMode::Tray, true, false)));
    }

    #[test]
    fn maximized_state_is_tracked_and_restored_only_for_the_normal_window() {
        let mut s = settings(WindowMode::Floating, true, false);
        assert!(track_maximized(&s, false));
        assert!(!track_maximized(&s, true), "collapsed bubble");
        assert!(!restore_maximized(&s, false), "not maximized");
        s.window_maximized = true;
        assert!(restore_maximized(&s, false));
        assert!(!restore_maximized(&s, true));
        // 桌面模式也記（上游只排除系統匣與泡泡）。
        s.window_mode = WindowMode::Desktop;
        assert!(restore_maximized(&s, false));
        s.window_mode = WindowMode::Tray;
        assert!(!track_maximized(&s, false));
        assert!(!restore_maximized(&s, false));
    }
}
