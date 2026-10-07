// widget 標題列的視窗按鈕與設定頁的系統匣選項該不該出現（與 src-tauri/src/window_policy.rs 同一套規則，
// 上游 trayModeSettings.js 與 renderer app.js `syncHideAppIconControl`）。

import type { Settings } from "./api";

type WindowSettings = Pick<Settings, "windowMode" | "showTrayIcon" | "hideAppIcon" | "windowMaximized">;

export interface HeaderControls {
  /** 最大化鈕：只有浮動與標準模式能最大化（桌面固定在最底層、系統匣的 popover 大小固定）。 */
  maximize: boolean;
  /** 目前是最大化（按鈕顯示「還原」）。 */
  maximized: boolean;
  /** × 會結束程式：沒有系統匣圖示可以把藏起來的視窗叫回來（上游 mainWindowCloseAction）。 */
  closeQuits: boolean;
}

export function headerControls(s: WindowSettings | null | undefined): HeaderControls {
  const mode = s?.windowMode ?? "floating";
  const maximize = mode === "floating" || mode === "normal";
  return {
    maximize,
    maximized: maximize && s?.windowMaximized === true,
    closeQuits: s?.showTrayIcon === false,
  };
}

export interface TrayOptions {
  /** 視窗模式可以選「系統匣」（上游 trayModeInput.disabled = !showTrayIcon）。 */
  trayMode: boolean;
  /** 系統匣圖示的內容選項。 */
  trayContent: boolean;
  /** 「隱藏工作列按鈕」：有系統匣圖示、而且不是系統匣模式（那時本來就沒有按鈕）才顯示。 */
  hideAppIcon: boolean;
}

export function trayOptions(s: WindowSettings): TrayOptions {
  const showTrayIcon = s.showTrayIcon !== false;
  return {
    trayMode: showTrayIcon,
    trayContent: showTrayIcon,
    hideAppIcon: showTrayIcon && s.windowMode !== "tray",
  };
}
