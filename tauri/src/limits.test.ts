import { describe, expect, it } from "vitest";
import type { LimitProvider, LimitWindow } from "./api";
import {
  antigravityQuotaGroups,
  antigravityQuotaWindow,
  meterTone,
  moneyText,
  providerWindowTitle,
  resetNote,
  statusNote,
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

  it("formats money windows", () => {
    expect(moneyText(w({ metric: "spend", used: 2.35, limit: 20, currency: "USD" }))).toBe("$2.35 / $20.00");
    expect(moneyText(w({ metric: "spend", used: 235, limit: null, currency: "JPY" }))).toBe("JPY 235.00");
  });

  it("groups Antigravity quota by model family like upstream", () => {
    const grouped = p({
      provider: "antigravity",
      windows: [
        w({ kind: "session", label: "Gemini 5-hour" }),
        w({ kind: "weekly", label: "Gemini weekly" }),
        w({ kind: "session", label: "Claude/GPT 5-hour" }),
        w({ kind: "weekly", label: "Claude/GPT weekly" }),
      ],
    });
    expect(antigravityQuotaGroups(grouped).map((g) => [g.label, g.windows.map((x) => x.kind)])).toEqual([
      ["Gemini", ["session", "weekly"]],
      ["Claude/GPT", ["session", "weekly"]],
    ]);
    expect(antigravityQuotaWindow(w({ kind: "weekly", label: "Gemini 5-hour" }))).toBeNull();
    // 舊版的模型池不分組，標題只有模型名稱。
    const pools = p({ provider: "antigravity", windows: [w({ kind: "weekly", label: "Gemini Pro" }), w({ kind: "weekly", label: "Claude" })] });
    expect(antigravityQuotaGroups(pools)).toEqual([]);
    expect(providerWindowTitle("antigravity", pools.windows[0])).toBe("Gemini Pro");
    expect(providerWindowTitle("claude", w({ kind: "weekly", label: "Fable" }))).toBe("每週 · Fable");
  });

  it("shows the reset countdown, or the provider's note when there is no reset time", () => {
    expect(resetNote(w({ resetsAt: "2026-10-01T00:00:00Z" }), "3 小時後")).toBe("3 小時後重置");
    expect(resetNote(w({ resetsAt: "2026-10-01T00:00:00Z", resetDescription: "x" }), "")).toBe("");
    expect(resetNote(w({ resetDescription: "Refreshes in four hours." }), "")).toBe("Refreshes in four hours.");
    expect(resetNote(w({}), "")).toBe("");
  });

  it("says Antigravity is not running rather than not signed in", () => {
    expect(statusNote(p({ provider: "antigravity", status: "notConfigured" }))).toBe(
      "Antigravity 沒有在執行；開啟 Antigravity 或 agy 後才讀得到額度",
    );
  });
});
