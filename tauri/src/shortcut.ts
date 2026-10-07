// 全域快捷鍵的錄製與顯示（上游 src/electron/windowShortcut.js 的移植）。儲存格式與 Rust 的
// settings::normalize_window_toggle_shortcut 相同：`CommandOrControl+Shift+T`。

const MODIFIER_ORDER = ["CommandOrControl", "Command", "Control", "Alt", "Shift", "Super"] as const;
const PRIMARY = new Set(["CommandOrControl", "Command", "Control", "Alt", "Super"]);

export interface KeyLike {
  code?: string;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export type RecordResult =
  | { action: "record"; shortcut: string }
  | { action: "clear"; shortcut: "" }
  | { action: "cancel" }
  | { action: "invalid"; reason: "modifierRequired" | "unsupportedKey" };

function keyFromEvent(e: KeyLike): string {
  const code = e.code ?? "";
  if (code === "Escape" || code === "Backspace" || code === "Delete") return code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (code === "Space" || code === "Tab") return code;
  if (code === "Enter" || code === "NumpadEnter") return "Enter";
  const key = (e.key ?? "").trim();
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  return "";
}

/** Windows：Ctrl = CommandOrControl、Win 鍵 = Super（上游 `shortcutModifiersFromEvent`）。 */
function modifiersFromEvent(e: KeyLike): string[] {
  const set = new Set<string>();
  if (e.metaKey) set.add("Super");
  if (e.ctrlKey) set.add("CommandOrControl");
  if (e.altKey) set.add("Alt");
  if (e.shiftKey) set.add("Shift");
  return MODIFIER_ORDER.filter((m) => set.has(m));
}

/** 錄製中的一次按鍵：Esc 取消、單獨的 Backspace / Delete 清除，至少要一個 Ctrl / Alt / Win。 */
export function shortcutFromEvent(e: KeyLike): RecordResult {
  const key = keyFromEvent(e);
  if (key === "Escape") return { action: "cancel" };
  const modifiers = modifiersFromEvent(e);
  if ((key === "Backspace" || key === "Delete") && modifiers.length === 0) return { action: "clear", shortcut: "" };
  if (!key || key === "Backspace" || key === "Delete") {
    return { action: "invalid", reason: modifiers.some((m) => PRIMARY.has(m)) ? "unsupportedKey" : "modifierRequired" };
  }
  if (!modifiers.some((m) => PRIMARY.has(m))) return { action: "invalid", reason: "modifierRequired" };
  return { action: "record", shortcut: [...modifiers, key].join("+") };
}

/** 顯示用：`CommandOrControl+Shift+T` → `Ctrl+Shift+T`。 */
export function formatShortcut(shortcut: string, offLabel: string): string {
  if (!shortcut) return offLabel;
  return shortcut
    .split("+")
    .map((p) => (p === "CommandOrControl" || p === "Control" ? "Ctrl" : p === "Super" ? "Win" : p))
    .join("+");
}

/** 上游 main.js `handleZoomShortcut`：Ctrl + = / - 以 10% 調整，Ctrl + 0 還原。 */
export function zoomFromKey(key: string, ctrl: boolean, current: number): number | null {
  if (!ctrl) return null;
  const clamp = (v: number) => Math.min(1.6, Math.max(0.7, Math.round(v * 100) / 100));
  if (key === "=" || key === "+") return clamp(current + 0.1);
  if (key === "-" || key === "_") return clamp(current - 0.1);
  if (key === "0") return 1;
  return null;
}
