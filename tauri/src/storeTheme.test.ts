// 明暗與 --c-* 色票真正的套用點是 store.applyTheme；index.html 的 pre-paint 在 React 掛載前另跑一份
// 同樣的判斷（不能 import）。這裡在假的 document 上跑兩者：都要照 theme.ts resolveLight 的規則，而且
// pre-paint 讀回 applyTheme 寫的 localStorage 要得到同一個畫面（重新開視窗不閃）。
// 設定頁的色格、預設晶片與主題代碼用 theme.ts effectiveThemeColors：這裡確認它就是 applyTheme 畫出來的
// 配色（含淺色模式的瓷白），複製出的代碼貼回來畫面不變。
// 另外守 updateSettings 的回傳值：設定頁只在存檔成功時才說「已套用主題。」。

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import html from "../index.html?raw";
import css from "./styles.css?raw";
import type { SettingsView, ThemeSetting } from "./api";
import {
  decodeThemeCode,
  effectiveThemeColors,
  encodeThemeCode,
  hexToChannels,
  INTERFACE_COLOR_KEYS,
  matchingThemePresetId,
  resolveLight,
  THEME_CSS_VARS,
  themeCssVars,
} from "./theme";

type Store = typeof import("./store");

function fakeRoot() {
  const classes = new Set<string>();
  const props = new Map<string, string>();
  return {
    lang: "",
    dataset: {} as Record<string, string>,
    classList: {
      add: (c: string) => void classes.add(c),
      contains: (c: string) => classes.has(c),
      toggle: (c: string, on?: boolean) => {
        const next = on ?? !classes.has(c);
        if (next) classes.add(c);
        else classes.delete(c);
        return next;
      },
    },
    style: {
      setProperty: (k: string, v: string) => void props.set(k, v),
      removeProperty: (k: string) => void props.delete(k),
    },
    props,
  };
}
type FakeRoot = ReturnType<typeof fakeRoot>;

const storage = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
};
const mql = { matches: false, addEventListener: () => {}, removeEventListener: () => {} };

/** index.html 第一個 inline script（pre-paint），在假的 document 上執行。 */
function runPrePaint(root: FakeRoot) {
  const body = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!body) throw new Error("index.html 沒有 pre-paint script");
  const run = new Function("localStorage", "navigator", "document", "matchMedia", "location", body);
  run(fakeStorage, { language: "zh-TW" }, { documentElement: root }, () => mql, { search: "" });
}

function themeVars(root: FakeRoot) {
  return Object.fromEntries(Object.values(THEME_CSS_VARS).map((name) => [name, root.props.get(name) ?? null]));
}

/** 畫面上的四色（"r g b"）：<html> 內嵌的覆寫優先，否則是 styles.css 依 .light 選的那組色票。 */
function renderedPalette(root: FakeRoot) {
  const selector = root.classList.contains("light") ? ":root\\.light" : ":root";
  const block = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  const token = (name: string) => new RegExp(`${name}:\\s*([\\d ]+);`).exec(block)?.[1]?.trim();
  return Object.fromEntries(
    INTERFACE_COLOR_KEYS.map((key) => [key, root.props.get(THEME_CSS_VARS[key]) ?? token(THEME_CSS_VARS[key])]),
  );
}

let store: Store;

beforeAll(async () => {
  vi.stubGlobal("localStorage", fakeStorage);
  // store.ts 在載入時取 matchMedia 的物件，之後每次讀它的 matches。
  vi.stubGlobal("window", { matchMedia: () => mql });
  store = await import("./store");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("applyTheme and the index.html pre-paint", () => {
  const cases: [ThemeSetting | undefined, Record<string, string>, boolean][] = [
    ["system", {}, true],
    ["system", {}, false],
    ["light", {}, false],
    ["dark", {}, true],
    [undefined, {}, true],
    ["dark", { bg: "#f6f7f9" }, false],
    ["light", { bg: "#0b0c0e" }, true],
    ["system", { bg: "#0b0c0e", accent: "#112233" }, true],
    ["light", { accent: "#112233", muted: "#445566" }, false],
    ["dark", { accent: "#e6e8ec", bg: "#0b0c0e", text: "#eceef2", muted: "#8f949c" }, false],
  ];

  it("toggles .light by resolveLight and sets only the overridden tokens", () => {
    for (const [theme, colors, prefersLight] of cases) {
      const label = JSON.stringify([theme, colors, prefersLight]);
      mql.matches = prefersLight;
      storage.clear();
      const root = fakeRoot();
      // 先留下一組舊的內嵌色票：沒覆寫的鍵要被移除，回到 styles.css 的值。
      root.props.set("--c-accent", "1 2 3");
      root.props.set("--c-app", "4 5 6");
      vi.stubGlobal("document", { documentElement: root });
      store.applyTheme(theme, colors);

      const light = resolveLight(theme, colors, prefersLight);
      expect(root.classList.contains("light"), label).toBe(light);
      expect(themeVars(root), label).toEqual(themeCssVars(colors).vars);

      const fresh = fakeRoot();
      runPrePaint(fresh);
      expect(fresh.classList.contains("light"), `pre-paint ${label}`).toBe(light);
      expect(themeVars(fresh), `pre-paint ${label}`).toEqual(themeCssVars(colors).vars);
    }
  });

  it("a preview does not persist for the pre-paint", () => {
    storage.clear();
    mql.matches = false;
    vi.stubGlobal("document", { documentElement: fakeRoot() });
    store.applyTheme("dark", {});
    store.applyTheme("dark", { bg: "#ffffff" }, { persist: false });
    const fresh = fakeRoot();
    runPrePaint(fresh);
    expect(fresh.classList.contains("light")).toBe(false);
    expect(fresh.props.get("--c-app")).toBeUndefined();
  });
});

describe("the palette the settings page shows (effectiveThemeColors)", () => {
  const cases: [ThemeSetting, Record<string, string>, boolean][] = [
    ["light", {}, false],
    ["system", {}, true],
    ["system", {}, false],
    ["dark", {}, true],
    ["dark", { bg: "#ffffff" }, false],
    ["light", { bg: "#101010" }, false],
    ["light", { accent: "#112233" }, false],
    ["dark", { accent: "#e6e8ec", bg: "#0b0c0e", text: "#eceef2", muted: "#8f949c" }, true],
  ];

  function render(theme: ThemeSetting, colors: Record<string, string>) {
    const root = fakeRoot();
    vi.stubGlobal("document", { documentElement: root });
    store.applyTheme(theme, colors);
    return root;
  }

  it("is what applyTheme paints, and pasting its code back paints the same", () => {
    for (const [theme, colors, prefersLight] of cases) {
      const label = JSON.stringify([theme, colors, prefersLight]);
      mql.matches = prefersLight;
      const before = render(theme, colors);
      const shown = effectiveThemeColors(colors, resolveLight(theme, colors, prefersLight));
      const channels = Object.fromEntries(INTERFACE_COLOR_KEYS.map((key) => [key, hexToChannels(shown[key])]));
      expect(renderedPalette(before), label).toEqual(channels);

      // 複製主題碼 → 貼上並套用：存的是解出來的完整四色。
      const decoded = decodeThemeCode(encodeThemeCode(shown));
      if (!decoded.ok) throw new Error(`round trip failed ${label}`);
      const after = render(theme, decoded.colors);
      expect(after.classList.contains("light"), label).toBe(before.classList.contains("light"));
      expect(renderedPalette(after), label).toEqual(renderedPalette(before));
    }
  });

  it("lights up 瓷白 in light mode without overrides", () => {
    mql.matches = false;
    const root = render("light", {});
    expect(matchingThemePresetId({}, resolveLight("light", {}, false))).toBe("porcelain");
    expect(renderedPalette(root)).toEqual({ accent: "37 99 235", bg: "246 247 249", text: "28 31 38", muted: "91 98 109" });
  });
});

describe("updateSettings", () => {
  const settings = {
    opacity: 90,
    theme: "dark",
    language: "zh-TW",
    themeColors: {},
    vendorColors: {},
  } as unknown as SettingsView;

  it("returns true and applies the saved settings on success", async () => {
    vi.stubGlobal("document", { documentElement: fakeRoot() });
    const saved = { ...settings, themeColors: { accent: "#112233" } };
    const spy = vi.spyOn((await import("./api")).api, "settingsUpdate").mockResolvedValue(saved);
    store.useApp.setState({ settings, error: null });
    await expect(store.useApp.getState().updateSettings({ themeColors: { accent: "#112233" } })).resolves.toBe(true);
    expect(store.useApp.getState().settings).toBe(saved);
    spy.mockRestore();
  });

  it("returns false, rolls back and keeps the error on failure", async () => {
    const spy = vi.spyOn((await import("./api")).api, "settingsUpdate").mockRejectedValue(new Error("disk full"));
    store.useApp.setState({ settings, error: null });
    await expect(store.useApp.getState().updateSettings({ themeColors: { accent: "#112233" } })).resolves.toBe(false);
    expect(store.useApp.getState().settings).toBe(settings);
    expect(store.useApp.getState().error).toContain("disk full");
    spy.mockRestore();
  });
});
