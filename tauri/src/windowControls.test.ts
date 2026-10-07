import { describe, expect, it } from "vitest";
import type { WindowMode } from "./api";
import { headerControls, trayOptions } from "./windowControls";

const base = { windowMode: "floating" as WindowMode, showTrayIcon: true, hideAppIcon: false, windowMaximized: false };

describe("headerControls", () => {
  it("offers maximize only where the window can maximize", () => {
    expect(headerControls({ ...base }).maximize).toBe(true);
    expect(headerControls({ ...base, windowMode: "normal" }).maximize).toBe(true);
    expect(headerControls({ ...base, windowMode: "desktop" }).maximize).toBe(false);
    expect(headerControls({ ...base, windowMode: "tray" }).maximize).toBe(false);
  });

  it("shows restore while maximized", () => {
    expect(headerControls({ ...base, windowMaximized: true }).maximized).toBe(true);
    // 系統匣模式時 windowMaximized 記的是離開後要還原的樣子，popover 本身沒有最大化。
    expect(headerControls({ ...base, windowMode: "tray", windowMaximized: true }).maximized).toBe(false);
  });

  it("closes to the tray only when there is a tray icon", () => {
    expect(headerControls({ ...base }).closeQuits).toBe(false);
    expect(headerControls({ ...base, showTrayIcon: false }).closeQuits).toBe(true);
    expect(headerControls(null)).toEqual({ maximize: true, maximized: false, closeQuits: false });
  });
});

describe("trayOptions", () => {
  it("hides the tray choices without a tray icon", () => {
    expect(trayOptions({ ...base, showTrayIcon: false })).toEqual({ trayMode: false, trayContent: false, hideAppIcon: false });
  });

  it("offers hideAppIcon outside tray mode", () => {
    expect(trayOptions({ ...base }).hideAppIcon).toBe(true);
    expect(trayOptions({ ...base, windowMode: "desktop" }).hideAppIcon).toBe(true);
    expect(trayOptions({ ...base, windowMode: "tray" }).hideAppIcon).toBe(false);
  });
});
