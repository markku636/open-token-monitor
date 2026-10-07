import { describe, expect, it } from "vitest";
import type { HistoryPreview, LimitProvider, LimitsView, LimitWindow, TrendsView } from "./api";
import { fmtUsd } from "./format";
import {
  attributionRows,
  compactLimitWindows,
  historyHasUsage,
  homeActivityScrollRecord,
  homeActivityScrollTarget,
  homeDeviceRows,
  homeLimitAccounts,
  homeLimitRows,
  homeLimitValueText,
  homeModelRows,
  homeToolRows,
  homeTrendSummary,
  longRangePeakDayTokens,
  pickHomeHistory,
  previewTrendsView,
  rankByTokens,
  visibleAttributionRows,
  type HomeLimitWindow,
} from "./homeOverview";

const win = (kind: LimitWindow["kind"], usedPercent: number | null, extra: Partial<LimitWindow> = {}): LimitWindow => ({
  kind,
  label: "",
  used: null,
  limit: null,
  remaining: null,
  usedPercent,
  remainingPercent: usedPercent === null ? null : 100 - usedPercent,
  resetsAt: null,
  windowMinutes: null,
  currency: null,
  showMeter: true,
  ...extra,
});

const provider = (id: string, windows: LimitWindow[], extra: Partial<LimitProvider> = {}): LimitProvider => ({
  provider: id,
  accountKey: "",
  accountLabel: "",
  accountEmail: "",
  status: "ok",
  source: "",
  updatedAt: null,
  windows,
  ...extra,
});

describe("homeLimitAccounts", () => {
  it("keeps the two highest-priority windows with numbers", () => {
    const [claude] = homeLimitAccounts([
      {
        providerId: "claude",
        name: "Claude",
        windows: [win("weekly", 76), win("weekly", 92, { label: "Fable" }), win("billing", 11.75, { metric: "spend", label: "Usage credits" }), win("session", 34)],
      },
    ]);
    expect(claude.windows.map((w) => [w.kind, w.label])).toEqual([
      ["session", "session"],
      ["weekly", "weekly"],
    ]);
    expect(claude.lowestRemaining).toBe(24);
  });

  it("skips windows without a meter and counts a window without a percent as full", () => {
    const [a] = homeLimitAccounts([{ providerId: "x", windows: [win("session", 10, { showMeter: false }), { kind: "weekly", value: "12 req" } as never] }]);
    expect(a.windows.map((w) => w.kind)).toEqual(["weekly"]);
    expect(a.lowestRemaining).toBe(100);
    expect(homeLimitAccounts([{ providerId: "x", windows: [win("session", 10, { showMeter: false })] }])).toEqual([]);
  });

  it("sorts by lowest remaining or keeps the configured order, then slices", () => {
    const accounts = [
      { key: "a", providerId: "claude", windows: [win("session", 10)] },
      { key: "b", providerId: "codex", windows: [win("session", 90)] },
      { key: "c", providerId: "cursor", windows: [win("session", 90)] },
    ];
    expect(homeLimitAccounts(accounts).map((a) => a.key)).toEqual(["b", "c", "a"]);
    expect(homeLimitAccounts(accounts, 3, { sort: "configured" }).map((a) => a.key)).toEqual(["a", "b", "c"]);
    expect(homeLimitAccounts(accounts, 1).map((a) => a.key)).toEqual(["b"]);
  });
});

describe("homeLimitRows", () => {
  const limits = (providers: LimitProvider[]): LimitsView => ({ updatedAt: null, refreshMs: 0, nextAt: "", providers });
  const base = {
    supportedLimitProviders: ["claude", "codex", "cursor", "copilot"],
    limitsEnabled: true,
    limitProviders: ["claude", "codex"],
    homeLimitProviderOrder: "",
    hiddenHomeLimitProviders: "",
    homeLimitAccountCount: 3,
    showHomeLimitProviderNames: false,
  };

  it("drops codex additional windows", () => {
    const p = provider("codex", [win("session", 10), win("weekly", 20, { additional: true, label: "GPT-5.5" })]);
    expect(compactLimitWindows(p)).toHaveLength(1);
  });

  it("filters by the enabled and hidden providers and names accounts with the catalog label", () => {
    const view = limits([provider("claude", [win("session", 34)]), provider("codex", [win("session", 90)]), provider("copilot", [win("billing", 1, { label: "Premium" })])]);
    expect(homeLimitRows(view, base).map((r) => r.name)).toEqual(["Codex", "Claude"]);
    expect(homeLimitRows(view, { ...base, hiddenHomeLimitProviders: "codex" }).map((r) => r.name)).toEqual(["Claude"]);
    expect(homeLimitRows(view, { ...base, limitsEnabled: false }).map((r) => r.name)).toEqual(["Codex", "Claude", "GitHub Copilot"]);
    expect(homeLimitRows(view, { ...base, homeLimitProviderOrder: "claude,codex" }).map((r) => r.name)).toEqual(["Claude", "Codex"]);
  });

  it("prefixes the provider on multiple accounts when tool icons are off or names are asked for", () => {
    const view = limits([provider("codex", [win("session", 10)], { accountEmail: "a@x.test" }), provider("codex", [win("session", 20)], { accountLabel: "Team" })]);
    expect(homeLimitRows(view, { ...base, showToolIcons: false }).map((r) => r.name)).toEqual(["Codex · Team", "Codex · a@x.test"]);
    expect(homeLimitRows(view, { ...base, showToolIcons: true, showHomeLimitProviderNames: true }).map((r) => r.name)).toEqual(["Codex · Team", "Codex · a@x.test"]);
    // 上游只在 showToolIcons === false 時強制顯示名稱：沒有這個鍵（舊設定）時照圖示開著處理。
    expect(homeLimitRows(view, base).map((r) => r.name)).toEqual(["Team", "a@x.test"]);
    expect(homeLimitRows(view, { ...base, showToolIcons: true }).map((r) => r.name)).toEqual(["Team", "a@x.test"]);
  });
});

describe("homeLimitValueText", () => {
  const w = (extra: Partial<HomeLimitWindow>): HomeLimitWindow => ({
    kind: "session",
    metric: "",
    label: "",
    remainingPercent: 23.6,
    remaining: null,
    currency: "",
    resetsAt: null,
    resetDescription: "",
    value: "",
    planStatus: "",
    showMeter: true,
    detail: "",
    ...extra,
  });
  it("shows remaining by default and used when asked", () => {
    expect(homeLimitValueText(w({}), false)).toBe("24% 剩餘");
    expect(homeLimitValueText(w({}), true)).toBe("76% 已用");
    expect(homeLimitValueText(w({ detail: "unlimited" }), false)).toBe("無限制");
    expect(homeLimitValueText(w({ value: "3 / 10" }), false)).toBe("3 / 10");
    expect(homeLimitValueText(w({ metric: "credits", remaining: 12.5, currency: "USD" }), false)).toBe("$12.50");
  });
});

describe("home rows", () => {
  it("ranks tools by value then name and shares against the supplied total", () => {
    const rows = homeToolRows(
      [
        { key: "b", name: "B", value: 10 },
        { key: "a", name: "A", value: 10 },
        { key: "z", name: "Z", value: 0 },
        { key: "c", name: "C", value: 30 },
      ],
      100,
      2,
    );
    expect(rows.map((r) => [r.key, r.share])).toEqual([
      ["c", 0.3],
      ["a", 0.1],
    ]);
  });

  it("keeps the model order and shares against the sum when the total is zero", () => {
    const rows = homeModelRows(
      [
        { key: "m2", name: "m2", value: 1 },
        { key: "m1", name: "m1", value: 3 },
      ],
      0,
    );
    expect(rows.map((r) => [r.key, r.share])).toEqual([
      ["m2", 0.25],
      ["m1", 0.75],
    ]);
  });

  it("orders devices by value, then local, then online, then input order", () => {
    const period = (t: number) => ({ today: { totalTokens: t } });
    const rows = homeDeviceRows(
      [
        { deviceId: "a", stale: true, periods: period(5) },
        { deviceId: "b", periods: period(5) },
        { deviceId: "me", periods: period(5) },
        { deviceId: "c", periods: period(9) },
        { deviceId: "d", periods: period(0) },
        { deviceId: "e", periods: period(1) },
      ],
      { localDeviceId: "me", period: "today", limit: 4 },
    );
    expect(rows.map((r) => r.key)).toEqual(["c", "me", "b", "a"]);
    expect(rows[1].isLocal).toBe(true);
    expect(rows[3].isStale).toBe(true);
  });

  it("pushes the unattributed remainder and hides it when it rounds to nothing", () => {
    const rows = attributionRows({ claude: 60 }, { claude: 1 }, { totalValue: 100, totalCost: 1.5 });
    expect(rows[1]).toEqual({ key: "__unattributed", value: 40, cost: 0.5, unattributed: true });
    const zero = attributionRows({ claude: 60 }, { claude: 1 }, { totalValue: 60, totalCost: 1.001 });
    expect(zero).toHaveLength(2);
    expect(visibleAttributionRows(zero, (v) => v.toFixed(2))).toHaveLength(1);
    expect(visibleAttributionRows(zero, fmtUsd)).toHaveLength(2);
    expect(rankByTokens([{ key: "b", value: 1 }, { key: "a", value: 1 }, { key: "c", value: 5 }]).map((r) => r.key)).toEqual(["c", "a", "b"]);
  });
});

describe("activity helpers", () => {
  const preview = (tokens: number[]): HistoryPreview => ({
    daily: tokens.map((n, i) => ({ date: `2026-09-${String(20 + i).padStart(2, "0")}`, tokens: n, costUsd: n / 100 })),
    currentStreak: 1,
    longestStreak: 4,
    activeDays: 42,
    peakDayTokens: 900,
    favoriteModel: "m",
  });
  const trends = (tokens: number[]): TrendsView => ({
    today: "2026-09-24",
    daily: tokens.map((n, i) => ({ date: `2026-09-${String(20 + i).padStart(2, "0")}`, tokens: n, costUsd: 0, activeTimeMs: 0 })),
    monthly: [],
    summary: { totalTokens: 0, totalCost: 0, activeDays: 7, currentStreak: 0, longestStreak: 0, peakDayTokens: 0, favoriteModel: "", messages: 0, activeTimeMs: 0 },
  });

  it("reshapes the 30-day preview like trends_get: usage days plus today", () => {
    const v = previewTrendsView(preview([0, 5, 0, 7, 0]));
    expect(v?.today).toBe("2026-09-24");
    expect(v?.daily.map((d) => [d.date, d.tokens, d.costUsd])).toEqual([
      ["2026-09-21", 5, 0.05],
      ["2026-09-23", 7, 0.07],
      ["2026-09-24", 0, 0],
    ]);
    expect(v?.summary).toMatchObject({ totalTokens: 12, activeDays: 42, peakDayTokens: 900, longestStreak: 4 });
    expect(previewTrendsView(null)).toBeNull();
    expect(previewTrendsView(preview([]))).toBeNull();
  });

  it("prefers the full history but never lets an empty one hide the preview (upstream pickHomeHistory)", () => {
    const full = trends([3, 0, 4]);
    expect(pickHomeHistory(full, preview([1, 2]))).toBe(full);
    // 第一次開啟還沒拿到 trends_get：先畫預覽。
    expect(pickHomeHistory(null, preview([0, 2]))?.daily.map((d) => d.tokens)).toEqual([2]);
    // trends_get 冷啟動拿到只有今天（0）的結果：預覽有資料就用預覽。
    expect(pickHomeHistory(trends([0]), preview([6, 0]))?.summary.activeDays).toBe(42);
    expect(pickHomeHistory(trends([0]), preview([0, 0]))).toBeNull();
    expect(pickHomeHistory(null, null)).toBeNull();
    expect(historyHasUsage(trends([0, 0]))).toBe(false);
    expect(historyHasUsage(trends([0, 1]))).toBe(true);
  });

  it("summarizes the trend line", () => {
    expect(homeTrendSummary([{ date: "d1", tokens: 1 }, { date: "d2", tokens: 5 }, { date: "d3", tokens: 2 }, { date: "d4", tokens: 0 }])).toEqual({ peak: 5, dates: ["d1", "d2", "d4"] });
    expect(homeTrendSummary([])).toEqual({ peak: 0, dates: [] });
    expect(longRangePeakDayTokens({ historySummary: { peakDayTokens: 3 }, daily: [{ tokens: 7 }] })).toBe(7);
    expect(longRangePeakDayTokens({ historySummary: { peakDayTokens: 9 }, daily: [{ tokens: 7 }] })).toBe(9);
  });

  it("follows the end, clamps a saved offset and ignores an unsettled layout", () => {
    expect(homeActivityScrollTarget({ scrollWidth: 600, clientWidth: 300, followEnd: true, savedLeft: 10 })).toBe(300);
    expect(homeActivityScrollTarget({ scrollWidth: 600, clientWidth: 300, followEnd: false, savedLeft: 900 })).toBe(300);
    expect(homeActivityScrollTarget({ scrollWidth: 600, clientWidth: 300, followEnd: false, savedLeft: 40 })).toBe(40);
    expect(homeActivityScrollRecord({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 })).toBeNull();
    expect(homeActivityScrollRecord({ scrollLeft: 298, scrollWidth: 600, clientWidth: 300 })).toEqual({ scrollLeft: 298, followEnd: true });
    expect(homeActivityScrollRecord({ scrollLeft: 297, scrollWidth: 600, clientWidth: 300 })).toEqual({ scrollLeft: 297, followEnd: false });
  });
});
