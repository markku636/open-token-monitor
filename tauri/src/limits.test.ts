import { describe, expect, it } from "vitest";
import type { LimitProvider, LimitWindow } from "./api";
import {
  accountText,
  creditsMeterPercent,
  creditsText,
  formatMoney,
  meterTone,
  spendText,
  statusNote,
  windowDisplay,
  windowTitle,
} from "./limits";

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

  it("formats money like upstream formatMoney", () => {
    expect(formatMoney(2.349, "usd")).toBe("$2.35");
    expect(formatMoney(12, "CNY")).toBe("¥12.00");
    expect(formatMoney(235, "JPY")).toBe("JPY 235.00");
    expect(formatMoney(680, "CREDITS")).toBe("680.00");
    expect(formatMoney(1, "not a code!")).toBe("$1.00");
    expect(formatMoney(null, "USD")).toBe("");
  });

  it("says spent when a spend window has no cap", () => {
    expect(spendText(w({ metric: "spend", used: 2.35, limit: 20, currency: "USD" }))).toBe("$2.35 / $20.00");
    expect(spendText(w({ metric: "spend", used: 235, limit: null, currency: "JPY" }))).toBe("已花費 JPY 235.00");
    expect(spendText(w({ metric: "spend", used: null }))).toBe("");
  });

  it("shows a credits window as money, never as a percentage", () => {
    const balance = w({ kind: "billing", metric: "credits", label: "Balance", remaining: 18.4, currency: "USD", showMeter: false });
    const oc = p({ provider: "opencode", windows: [balance] });
    expect(windowTitle(balance)).toBe("餘額");
    expect(windowDisplay(oc, balance)).toEqual({ value: "$18.40", used: null });
    // 沒有固定分母的餘額：以本月花費推算的剩餘比例只給畫面用，已用 = 100 − 剩餘。
    const metered = { ...balance, showMeter: true };
    expect(windowDisplay(p({ balance: { monthSpend: 6 } }), { ...metered, remaining: 18 })).toEqual({ value: "$18.00", used: 25 });
    expect(creditsMeterPercent(p({}), { ...metered, remaining: 0 })).toBe(0);
    expect(creditsMeterPercent(p({}), { ...metered, remaining: 5 })).toBe(100);
    expect(creditsMeterPercent(p({}), { ...metered, usedPercent: 30 })).toBe(70);
    // 舊裝置只有 provider 層的 balance。
    const bare = { ...metered, remaining: null, currency: null };
    expect(creditsText(p({ balance: { amount: 3, currency: "CNY" } }), bare)).toBe("¥3.00");
    expect(creditsText(p({}), { ...bare, detail: "unlimited" })).toBe("unlimited");
    expect(creditsText(p({}), bare)).toBe("—");
  });

  it("keeps percentages for quota windows", () => {
    expect(windowDisplay(p({}), w({ kind: "weekly", usedPercent: 41.6 }))).toEqual({ value: "42%", used: 41.6 });
    expect(windowDisplay(p({}), w({ kind: "weekly", usedPercent: 41.6, showMeter: false }))).toEqual({ value: "42%", used: null });
    expect(windowDisplay(p({}), w({ metric: "spend", used: 2.35, limit: 20, usedPercent: 11.75 }))).toEqual({
      value: "$2.35 / $20.00",
      used: 11.75,
    });
  });

  it("names the OpenCode account and plan once each", () => {
    expect(accountText(p({ provider: "opencode", accountLabel: "Go" }))).toBe("Go");
    expect(accountText(p({ accountLabel: "work", planLabel: "Zen" }))).toBe("work · Zen");
    expect(accountText(p({ accountLabel: "a@b.co", planLabel: "Pro", accountEmail: "a@b.co" }))).toBe("a@b.co · Pro");
    expect(statusNote(p({ provider: "opencode", status: "notConfigured" }))).toBe("這台電腦沒有登入 OpenCode");
  });
});
