import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// tray.rs / dock.rs 以 `app.emit` 送 open-tab，每個視窗都收得到：記下哪些視窗真的訂閱了。
const openTab = vi.hoisted(() => ({ handlers: [] as ((payload: string) => void)[] }));
// stats-updated 的推送：測試自己送。
const statsPush = vi.hoisted(() => ({ handlers: [] as ((payload: unknown) => void)[] }));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    onOpenTab: (cb: (payload: string) => void) => {
      openTab.handlers.push(cb);
      return Promise.resolve(() => {});
    },
    onStatsUpdated: (cb: (payload: unknown) => void) => {
      statsPush.handlers.push(cb);
      return Promise.resolve(() => {});
    },
  };
});

/** store 在載入時讀 localStorage 與查詢字串，所以先換好視窗環境再重新載入模組。 */
async function loadStore(view: string, saved: object, env: { search?: string; doc?: object } = {}) {
  const storage = new Map<string, string>([["tm:view", JSON.stringify(saved)]]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal("location", { search: env.search ?? "", reload: vi.fn() });
  vi.stubGlobal("document", { documentElement: { dataset: { view }, style: { setProperty: () => {} }, classList: { toggle: () => {} } }, ...env.doc });
  vi.resetModules();
  const store = await import("./store");
  const { useApp } = store;
  await useApp.getState().bootstrap();
  return { useApp, store, saved: () => JSON.parse(storage.get("tm:view") ?? "{}") };
}

beforeEach(() => {
  openTab.handlers.length = 0;
  statsPush.handlers.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tm:view ownership", () => {
  it("keeps the dock, settings and dashboard windows from following open-tab or rewriting tm:view", async () => {
    for (const view of ["dock", "settings", "dashboard"]) {
      const { useApp, saved } = await loadStore(view, { view: "trends", period: "month", breakdown: "model" });
      expect(openTab.handlers, view).toHaveLength(0);
      useApp.getState().setPeriod("today");
      useApp.getState().setView("limits", { allowHidden: true });
      expect(saved(), view).toEqual({ view: "trends", period: "month", breakdown: "model" });
    }
  });

  it("lets the widget follow open-tab, including the legacy tab ids, and remember the view", async () => {
    const { useApp, saved } = await loadStore("widget", { view: "home", period: "month" });
    expect(openTab.handlers).toHaveLength(1);
    openTab.handlers[0]("company");
    expect(useApp.getState().view).toBe("device");
    expect(useApp.getState().viewOverride).toBe("device");
    expect(saved()).toMatchObject({ view: "device", period: "month" });
  });
});

describe("list motion view changes", () => {
  it("counts user view changes but not the initial view or quiet corrections", async () => {
    // 沒有記住的視圖：第一次拿到設定時開自訂順序的第一個（本機），這不是使用者換視圖。
    const { useApp } = await loadStore("widget", {}, { search: "?viewDisplayOrder=tool,home" });
    const runtime = await import("./motionRuntime");
    expect(useApp.getState().view).toBe("tool");
    expect(runtime.viewChangedInWindow()).toBe(false);
    useApp.getState().setView("home", { quiet: true });
    useApp.getState().setView("home");
    expect(runtime.viewChangedInWindow()).toBe(false);
    useApp.getState().setView("tool", { fromHome: true });
    expect(runtime.viewChangedInWindow()).toBe(true);
  });
});

describe("hidden window", () => {
  it("holds stats out of the store but still feeds every push to onLocalStats", async () => {
    const listeners = new Map<string, () => void>();
    const doc = {
      visibilityState: "visible",
      addEventListener: (type: string, cb: () => void) => void listeners.set(type, cb),
    };
    const { useApp, store } = await loadStore("widget", { view: "home" }, { doc });
    // loadStore 把 doc 展開成新的 document，之後改的是那一份。
    const visibility = document as unknown as { visibilityState: string };
    const before = useApp.getState().local!;
    const seen: number[] = [];
    store.onLocalStats((local) => seen.push(local.periods.today.totalTokens));
    const push = (totalTokens: number) =>
      statsPush.handlers[0]({ ...before, periods: { ...before.periods, today: { ...before.periods.today, totalTokens } } });
    visibility.visibilityState = "hidden";
    push(111);
    push(222);
    // 即時速率要看到每一筆（上游 onStatsPush 每一筆都 observeLiveTokenRate），畫面先不動。
    expect(seen).toEqual([111, 222]);
    expect(useApp.getState().local).toBe(before);
    visibility.visibilityState = "visible";
    listeners.get("visibilitychange")!();
    expect(useApp.getState().local?.periods.today.totalTokens).toBe(222);
    expect(seen).toEqual([111, 222]);
  });
});
