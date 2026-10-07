import { describe, expect, it } from "vitest";
import type { LimitProvider, LimitWindow } from "./api";
import { meterTone, moneyText, statusNote, windowTitle } from "./limits";

const w = (over: Partial<LimitWindow>): LimitWindow => ({
  kind: "session",
  label: "",
  used: null,
  limit: null,
  remaining: null,
  usedPercent: null,
  remainingPercent: null,
  resetsAt: null,
  windowMinutes: null,
  currency: null,
  showMeter: true,
  ...over,
});

const p = (over: Partial<LimitProvider>): LimitProvider => ({
  provider: "claude",
  accountKey: "",
  accountLabel: "",
  accountEmail: "",
  status: "ok",
  source: "oauth",
  updatedAt: "2026-09-24T00:00:00.000Z",
  windows: [],
  ...over,
});

describe("limits", () => {
  it("names the windows the way people read them", () => {
    expect(windowTitle(w({ kind: "session" }))).toBe("5 小時");
    expect(windowTitle(w({ kind: "weekly" }))).toBe("每週（全部模型）");
    expect(windowTitle(w({ kind: "weekly", label: "Fable" }))).toBe("每週 · Fable");
    expect(windowTitle(w({ kind: "billing", label: "Monthly" }))).toBe("每月");
    expect(windowTitle(w({ kind: "billing", metric: "spend", label: "Usage credits" }))).toBe("額外用量");
    expect(windowTitle(w({ kind: "weekly", label: "gpt-reserve", additional: true }))).toBe("每週 · gpt-reserve");
  });

  it("colours the meter by how much is used", () => {
    expect(meterTone(95)).toBe("danger");
    expect(meterTone(75)).toBe("warning");
    expect(meterTone(10)).toBe("accent");
    expect(meterTone(null)).toBe("accent");
  });

  it("explains a provider that is not ok", () => {
    expect(statusNote(p({}))).toBe("");
    expect(statusNote(p({ status: "notConfigured" }))).toBe("這台電腦沒有登入 Claude Code");
    expect(statusNote(p({ status: "unauthorized", provider: "codex" }))).toBe("Codex 的登入已失效，請重新登入");
    expect(statusNote(p({ status: "unavailable", windows: [w({})] }))).toBe("暫時無法取得額度（顯示的是先前的數字）");
  });

  it("formats money windows", () => {
    expect(moneyText(w({ metric: "spend", used: 2.35, limit: 20, currency: "USD" }))).toBe("$2.35 / $20.00");
    expect(moneyText(w({ metric: "spend", used: 235, limit: null, currency: "JPY" }))).toBe("JPY 235.00");
  });
});
