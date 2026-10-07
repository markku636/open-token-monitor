import { describe, expect, it } from "vitest";
import { formatShortcut, shortcutFromEvent, zoomFromKey } from "./shortcut";

describe("window toggle shortcut", () => {
  it("records modifiers in a fixed order", () => {
    expect(shortcutFromEvent({ code: "KeyT", shiftKey: true, ctrlKey: true })).toEqual({
      action: "record",
      shortcut: "CommandOrControl+Shift+T",
    });
    expect(shortcutFromEvent({ code: "F9", altKey: true, metaKey: true })).toEqual({
      action: "record",
      shortcut: "Alt+Super+F9",
    });
  });

  it("needs a primary modifier and a supported key", () => {
    expect(shortcutFromEvent({ code: "KeyT", shiftKey: true })).toEqual({ action: "invalid", reason: "modifierRequired" });
    expect(shortcutFromEvent({ code: "ArrowUp", key: "ArrowUp", ctrlKey: true })).toEqual({
      action: "invalid",
      reason: "unsupportedKey",
    });
  });

  it("cancels and clears", () => {
    expect(shortcutFromEvent({ code: "Escape" })).toEqual({ action: "cancel" });
    expect(shortcutFromEvent({ code: "Backspace" })).toEqual({ action: "clear", shortcut: "" });
  });

  it("formats for display", () => {
    expect(formatShortcut("CommandOrControl+Shift+T", "Off")).toBe("Ctrl+Shift+T");
    expect(formatShortcut("", "Off")).toBe("Off");
  });

  it("zooms in 10% steps within 70–160%", () => {
    expect(zoomFromKey("=", true, 1)).toBe(1.1);
    expect(zoomFromKey("-", true, 0.7)).toBe(0.7);
    expect(zoomFromKey("+", true, 1.6)).toBe(1.6);
    expect(zoomFromKey("0", true, 1.3)).toBe(1);
    expect(zoomFromKey("=", false, 1)).toBeNull();
  });
});
