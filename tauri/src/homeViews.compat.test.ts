// 與上游 JavaScript 的相容測試：同一批隨機輸入交給上游 renderer 的 viewDisplayPreferences.js、
// homeModulePreferences.js、limitProviderOrder.js、homeOverview.js、usageAttributionRows.js 與我們的
// viewPrefs.ts / homeOverview.ts，結果必須完全相同。
//
// 需要上游 checkout：TOKEN_MONITOR_REPO（預設 monorepo 的 upstream/）；找不到就略過。
// 檔名以 .test.ts 結尾，i18n.test.ts 的原始碼掃描不會把這裡的字當成介面字串。

import { describe, expect, it } from "vitest";
import * as ours from "./homeOverview";
import * as prefs from "./viewPrefs";

// vitest 跑在 Node 裡，但前端的 tsconfig 沒有 Node 型別（也不為了一個測試加 @types/node）：
// 用 process.getBuiltinModule（Node 22.3+）取內建模組，只宣告用到的那幾個函式。
interface NodeProcess {
  env: Record<string, string | undefined>;
  getBuiltinModule(id: string): unknown;
}
const node = (globalThis as unknown as { process: NodeProcess }).process;
const { existsSync } = node.getBuiltinModule("node:fs") as { existsSync(p: string): boolean };
const { createRequire } = node.getBuiltinModule("node:module") as { createRequire(from: string): (id: string) => unknown };
const path = node.getBuiltinModule("node:path") as { join(...parts: string[]): string; resolve(...parts: string[]): string };
const { fileURLToPath } = node.getBuiltinModule("node:url") as { fileURLToPath(url: URL): string };

const REPO = node.env.TOKEN_MONITOR_REPO ? path.resolve(node.env.TOKEN_MONITOR_REPO) : fileURLToPath(new URL("../../upstream/", import.meta.url));
const RENDERER = path.join(REPO, "src", "electron", "renderer");
const exists = existsSync(path.join(RENDERER, "homeOverview.js"));
// limitProviderOrder.js 是較新的上游才有（v0.63.1 沒有）：沒有時略過這一項。
const hasProviderOrder = existsSync(path.join(RENDERER, "limitProviderOrder.js"));
const require = createRequire(import.meta.url);
type Api = Record<string, (...args: any[]) => any>;
const load = (name: string): Api => require(path.join(RENDERER, name)) as Api;

/** mulberry32：固定種子，失敗時可以重現。 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RUNS = 200;
const VIEW_OBJECTS = prefs.VIEW_IDS.map((id) => ({ id }));
const MODULE_OBJECTS = prefs.HOME_MODULE_IDS.map((id) => ({ id }));
const PROVIDERS = ["claude", "codex", "cursor", "copilot"];
const PROVIDER_OBJECTS = PROVIDERS.map((id) => ({ id }));

function gen(r: () => number) {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const maybe = <T>(v: T, p = 0.5): T | undefined => (r() < p ? v : undefined);
  const subset = <T>(xs: readonly T[]): T[] => xs.filter(() => r() < 0.5);
  const csv = (pool: readonly string[]): string | unknown[] | undefined | null => {
    const junk = ["", " ", "bogus", "model", "project", "session", "kimi", "x y"];
    const items = Array.from({ length: Math.floor(r() * 9) }, () => {
      const base = r() < 0.75 ? pick(pool) : pick(junk);
      const cased = r() < 0.2 ? base.toUpperCase() : base;
      return r() < 0.2 ? ` ${cased} ` : cased;
    });
    const shape = r();
    if (shape < 0.15) return items;
    if (shape < 0.2) return r() < 0.5 ? null : undefined;
    return items.join(",");
  };
  const num = (): unknown => pick([null, undefined, "", " ", "12", "abc", NaN, -5, 0, 3.7, 20, 55, 99.5, 100, 140, r() * 100]);
  return { pick, maybe, subset, csv, num };
}

function limitWindow(g: ReturnType<typeof gen>) {
  return {
    kind: g.pick(["session", "daily", "weekly", "billing", "monthly", "other", "", "Weekly"]),
    metric: g.pick(["", "", "credits", "spend"]),
    label: g.pick(["", "Fable", "Usage credits", "Monthly"]),
    usedPercent: g.num(),
    remainingPercent: g.maybe(g.num()),
    remaining: g.num(),
    currency: g.pick(["", "USD", "cny", "credits", "x"]),
    resetsAt: g.maybe("2026-09-25T10:00:00Z"),
    boundaryKind: g.maybe("expires", 0.2),
    resetDescription: g.maybe("in 3 days", 0.3),
    value: g.maybe("12 req", 0.15),
    planStatus: g.maybe("expired", 0.1),
    showMeter: g.pick([true, false, undefined]),
    detail: g.maybe(g.pick(["unlimited", "Unlimited", "n/a"]), 0.2),
  };
}

function balance(g: ReturnType<typeof gen>) {
  return g.maybe(
    {
      amount: g.num(),
      currency: g.pick(["USD", "CNY", ""]),
      monthSpend: g.num(),
      planStatus: g.pick(["", "active", "expired"]),
      planUsed: g.num(),
      planLimit: g.num(),
      planPercent: g.num(),
    },
    0.4,
  );
}

describe.skipIf(!exists)("home views match upstream", () => {
  it("view display preferences", () => {
    const up = load("viewDisplayPreferences.js");
    const r = rng(1);
    const g = gen(r);
    for (let i = 0; i < RUNS; i += 1) {
      const orderValue = g.csv(prefs.VIEW_IDS);
      const hiddenValue = g.csv(prefs.VIEW_IDS);
      const id = g.pick([...prefs.VIEW_IDS, "bogus", " HOME "]);
      const dir = g.pick(["up", "down", "sideways"] as const);
      const target = g.pick([0, 2, -1, 99, Number.MAX_SAFE_INTEGER, NaN, 1.5]);
      const availableIds = g.maybe(g.subset(prefs.VIEW_IDS), 0.7);
      const includeIds = g.maybe(g.subset(prefs.VIEW_IDS));
      const currentId = g.pick([...prefs.VIEW_IDS, "bogus", ""]);
      const preferFirst = r() < 0.3;
      const ctx = JSON.stringify({ i, orderValue, hiddenValue, id, dir, target, availableIds, includeIds, currentId, preferFirst });
      expect(prefs.normalizeViewDisplayOrder(orderValue as never, prefs.VIEW_IDS), ctx).toEqual(up.normalizeViewDisplayOrder(orderValue, VIEW_OBJECTS));
      expect(prefs.normalizeHiddenViews(hiddenValue as never, prefs.VIEW_IDS), ctx).toEqual(up.normalizeHiddenViews(hiddenValue, VIEW_OBJECTS));
      expect(prefs.hasCustomViewDisplayOrder(orderValue as never), ctx).toEqual(up.hasCustomViewDisplayOrder(orderValue));
      expect(prefs.moveViewDisplayOrder(orderValue as never, prefs.VIEW_IDS, id, dir as "up"), ctx).toEqual(up.moveViewDisplayOrder(orderValue, VIEW_OBJECTS, id, dir));
      expect(prefs.reorderViewDisplayOrder(orderValue as never, prefs.VIEW_IDS, id, target), ctx).toEqual(up.reorderViewDisplayOrder(orderValue, VIEW_OBJECTS, id, target));
      expect(prefs.visibleViewOrder({ ids: prefs.VIEW_IDS, orderValue: orderValue as never, hiddenValue: hiddenValue as never, availableIds, includeIds }), ctx).toEqual(
        up.visibleViewOrder({ views: VIEW_OBJECTS, orderValue, hiddenValue, availableIds, includeIds }),
      );
      expect(prefs.visibleViewCount({ ids: prefs.VIEW_IDS, hiddenValue: hiddenValue as never, disabledIds: includeIds }), ctx).toEqual(
        up.visibleViewCount({ views: VIEW_OBJECTS, hiddenValue, disabledIds: includeIds }),
      );
      expect(prefs.preferredViewId({ ids: prefs.VIEW_IDS, orderValue: orderValue as never, hiddenValue: hiddenValue as never, availableIds, currentId, preferFirst }), ctx).toEqual(
        up.preferredViewId({ views: VIEW_OBJECTS, orderValue, hiddenValue, availableIds, currentId, preferFirst }),
      );
    }
  });

  it("home module preferences", () => {
    const up = load("homeModulePreferences.js");
    expect(prefs.DEFAULT_HOME_MODULE_ORDER).toBe(up.DEFAULT_HOME_MODULE_ORDER as unknown as string);
    const r = rng(2);
    const g = gen(r);
    for (let i = 0; i < RUNS; i += 1) {
      const value = g.csv(prefs.HOME_MODULE_IDS);
      const hidden = g.csv(prefs.HOME_MODULE_IDS);
      const id = g.pick([...prefs.HOME_MODULE_IDS, "bogus"]);
      const dir = g.pick(["up", "down"] as const);
      const target = g.pick([0, 3, -2, 99, NaN]);
      const ctx = JSON.stringify({ i, value, hidden, id, dir, target });
      expect(prefs.normalizeHomeModuleOrder(value as never), ctx).toEqual(up.normalizeHomeModuleOrder(value, MODULE_OBJECTS));
      expect(prefs.normalizeHiddenHomeModules(hidden as never), ctx).toEqual(up.normalizeHiddenHomeModules(hidden, MODULE_OBJECTS));
      expect(prefs.moveHomeModuleOrder(value as never, id, dir), ctx).toEqual(up.moveHomeModuleOrder(value, MODULE_OBJECTS, id, dir));
      expect(prefs.reorderHomeModuleOrder(value as never, id, target), ctx).toEqual(up.reorderHomeModuleOrder(value, MODULE_OBJECTS, id, target));
    }
  });

  it.skipIf(!hasProviderOrder)("limit provider order", () => {
    const up = load("limitProviderOrder.js");
    const r = rng(3);
    const g = gen(r);
    for (let i = 0; i < RUNS; i += 1) {
      const value = g.csv(PROVIDERS);
      const id = g.pick([...PROVIDERS, "kimi"]);
      const dir = g.pick(["up", "down"] as const);
      const target = g.pick([0, 1, 7, -1, NaN]);
      const ctx = JSON.stringify({ i, value, id, dir, target });
      expect(prefs.normalizeLimitProviderOrder(value as never, PROVIDERS), ctx).toEqual(up.normalizeLimitProviderOrder(value, PROVIDER_OBJECTS));
      expect(prefs.normalizeLimitProviderSelection(value as never, PROVIDERS), ctx).toEqual(up.normalizeLimitProviderSelection(value, PROVIDER_OBJECTS));
      expect(prefs.moveLimitProvider(value as never, PROVIDERS, id, dir), ctx).toEqual(up.moveLimitProvider(value, PROVIDER_OBJECTS, id, dir));
      expect(prefs.reorderLimitProvider(value as never, PROVIDERS, id, target), ctx).toEqual(up.reorderLimitProvider(value, PROVIDER_OBJECTS, id, target));
    }
  });

  it("home limit accounts", () => {
    const up = load("homeOverview.js");
    const r = rng(4);
    const g = gen(r);
    for (let i = 0; i < RUNS; i += 1) {
      const accounts = Array.from({ length: Math.floor(r() * 5) }, (_, k) => ({
        key: g.maybe(`k${k}`),
        providerId: g.pick(["claude", "codex", "antigravity", "mimo", "MiMo ", "cursor", ""]),
        name: g.maybe("Name"),
        color: g.maybe("#fff"),
        iconId: g.maybe("icon"),
        windows: Array.from({ length: Math.floor(r() * 5) }, () => limitWindow(g)),
        balance: balance(g),
      }));
      const limit = g.pick([undefined, 0, 1, 3, 12, "2", NaN]);
      const sort = g.pick(["remaining", "configured", undefined]);
      const ctx = JSON.stringify({ i, accounts, limit, sort });
      expect(ours.homeLimitAccounts(accounts as never, limit as never, { sort }), ctx).toEqual(up.homeLimitAccounts(accounts, limit, { sort }));
      for (const w of accounts.flatMap((a) => a.windows)) {
        expect(ours.remainingPercent(w as never), ctx).toEqual(up.remainingPercent(w));
        expect(ours.usedPercent(w as never), ctx).toEqual(up.usedPercent(w));
      }
      const providers = Array.from({ length: Math.floor(r() * 6) }, () => ({
        provider: g.pick([...PROVIDERS, "CODEX", "", "kimi"]),
        windows: g.maybe(Array.from({ length: Math.floor(r() * 4) }, () => limitWindow(g)), 0.9),
        balance: balance(g),
      }));
      const input = {
        providers,
        providerOptions: g.subset(PROVIDERS).map((id) => ({ id, label: id.toUpperCase() })),
        enabledProviderIds: g.subset([...PROVIDERS, " Claude "]),
        hiddenProviderIds: g.subset(PROVIDERS),
        colors: g.maybe({ claude: "#d97757", default: "#999" }),
        limit: g.pick([1, 2, 3, 12]),
        sort: g.pick(["remaining", "configured"]),
      };
      const accountName = (p: { provider: string }, index: number, entries: unknown[]) => `${p.provider}:${index}/${entries.length}`;
      const ctx2 = JSON.stringify({ i, input });
      expect(ours.homeLimitAccountsForProviders(input as never), ctx2).toEqual(up.homeLimitAccountsForProviders(input));
      expect(ours.homeLimitAccountsForProviders({ ...input, accountName } as never), ctx2).toEqual(up.homeLimitAccountsForProviders({ ...input, accountName }));
    }
  });

  it("home rows, trend summary and activity scroll", () => {
    const up = load("homeOverview.js");
    const r = rng(5);
    const g = gen(r);
    for (let i = 0; i < RUNS; i += 1) {
      const rows = Array.from({ length: Math.floor(r() * 9) }, (_, k) => ({
        key: g.maybe(`key${k % 4}`),
        name: g.pick(["", "Alpha", "beta", "Gamma", "alpha"]),
        value: g.num(),
        color: g.maybe("#abc"),
      }));
      const total = g.num();
      const limit = g.pick([undefined, 0, 2, 5, "3"]);
      const ctx = JSON.stringify({ i, rows, total, limit });
      expect(ours.homeModelRows(rows as never, total, limit as never), ctx).toEqual(up.homeModelRows(rows, total, limit));
      expect(ours.homeToolRows(rows as never, total, limit as never), ctx).toEqual(up.homeToolRows(rows, total, limit));
      const period = g.pick(["today", "month", "allTime"]);
      const devices = Array.from({ length: Math.floor(r() * 7) }, (_, k) => ({
        deviceId: g.pick([`d${k}`, "me", "", " me "]),
        displayName: g.maybe("Laptop"),
        hostname: g.maybe(`HOST-${k}`),
        platform: g.maybe("win32-x64"),
        stale: g.pick([true, false, undefined]),
        periods: g.maybe({ [period]: { totalTokens: g.num() } }),
        [period]: g.maybe({ totalTokens: g.num() }),
      }));
      const opts = { localDeviceId: g.pick(["me", "", "d1"]), period, limit: g.pick([1, 4, undefined]) };
      expect(ours.homeDeviceRows(devices as never, opts as never), JSON.stringify({ i, devices, opts })).toEqual(up.homeDeviceRows(devices, opts));
      const points = Array.from({ length: Math.floor(r() * 6) }, (_, k) => ({ date: g.maybe(`2026-09-${10 + k}`, 0.9), tokens: g.num() }));
      expect(ours.homeTrendSummary(points as never), JSON.stringify(points)).toEqual(up.homeTrendSummary(points));
      const peakInput = { historySummary: g.maybe({ peakDayTokens: g.num() }), daily: g.maybe(points) };
      expect(ours.longRangePeakDayTokens(peakInput as never)).toEqual(up.longRangePeakDayTokens(peakInput));
      const scroll = {
        scrollWidth: g.pick([undefined, 0, 300, 600, 1200.5]),
        clientWidth: g.pick([undefined, 0, 300, 340]),
        followEnd: g.pick([true, false, undefined]),
        savedLeft: g.pick([undefined, null, 0, 40, 900, NaN, "12"]),
        scrollLeft: g.pick([undefined, 0, 250, 298, 299, 1000]),
      };
      expect(ours.homeActivityScrollTarget(scroll as never), JSON.stringify(scroll)).toEqual(up.homeActivityScrollTarget(scroll));
      expect(ours.homeActivityScrollRecord(scroll as never), JSON.stringify(scroll)).toEqual(up.homeActivityScrollRecord(scroll));
    }
  });

  it("attribution rows", () => {
    const up = load("usageAttributionRows.js");
    const r = rng(6);
    const g = gen(r);
    const format = (v: unknown) => Number(v).toFixed(2);
    for (let i = 0; i < RUNS; i += 1) {
      const keys = g.subset(["claude", "codex", "cursor", "copilot", "hermes"]);
      const values = g.maybe(Object.fromEntries(keys.map((k) => [k, g.num()])), 0.9);
      const costs = g.maybe(Object.fromEntries(g.subset(keys).map((k) => [k, g.num()])), 0.8);
      const options = { totalValue: g.num(), totalCost: g.num() };
      const ctx = JSON.stringify({ i, values, costs, options });
      const mine = ours.attributionRows(values as never, costs as never, options);
      expect(mine, ctx).toEqual(up.attributionRows(values, costs, options));
      expect(ours.visibleAttributionRows(mine, format), ctx).toEqual(up.visibleAttributionRows(mine, format));
    }
  });
});
