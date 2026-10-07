// 介面主題與廠商色的相容測試：上游 src/electron/renderer/themePresets.js、usageCharts.js 與我們的
// src/theme.ts、src/modelVendor.ts、src/vendorColors.ts 吃同一批輸入，結果必須完全相同。
// TM1 主題代碼要能在 Electron 與 Tauri 之間互貼，預設、品牌色與模型→廠商的判斷也要一致。
//
// 需要 Node 22.18+ 的 TypeScript type stripping 直接載入 .ts（沒有時略過）；上游的位置見 repos.mjs。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, root } from "./repos.mjs";

const RENDERER = path.join(REPO, "src", "electron", "renderer");
const hasRepo = fs.existsSync(path.join(RENDERER, "themePresets.js"));
const skip = !process.features.typescript
  ? "needs Node 22.18+ with TypeScript type stripping"
  : hasRepo
    ? false
    : `upstream checkout not found at ${REPO} (set TOKEN_MONITOR_REPO)`;
const require = createRequire(import.meta.url);
// 已知差異：這裡的廠商圖示、遮罩與主題照 2026-09-24 的上游 main 移植。上游 v0.63.1 把它們重構到
// vendorPresentation 與 rowIconMasks.js，下面標 todo 的比對對 v0.63.1 不成立；移植跟上之後拿掉 todo
// （tauri/docs/architecture.md「已知差異」）。
const UPSTREAM_GAP = "ported from upstream main of 2026-09-24; upstream v0.63.1 moved vendor icons and themes (vendorPresentation, rowIconMasks.js)";

async function load() {
  const upstream = {
    theme: require(path.join(RENDERER, "themePresets.js")),
    charts: require(path.join(RENDERER, "usageCharts.js")),
  };
  const ours = {
    theme: await import(pathToFileURL(path.join(root, "src", "theme.ts")).href),
    vendor: await import(pathToFileURL(path.join(root, "src", "modelVendor.ts")).href),
    colors: await import(pathToFileURL(path.join(root, "src", "vendorColors.ts")).href),
  };
  return { upstream, ours };
}

// 可重現的亂數（mulberry32），每次跑同一批「隨機」輸入。
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260925);
const hex6 = () => Math.floor(rand() * 0x1000000).toString(16).padStart(6, "0");
const randomCase = (s) => [...s].map((c) => (rand() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join("");

const PRESET_CODES = ["TM1-B7EAD4-303438-EEF5FB-A3ADBB", "TM1-E6E8EC-0B0C0E-ECEEF2-8F949C", "TM1-2563EB-F6F7F9-1C1F26-5B626D"];

const CODE_CORPUS = [
  ...PRESET_CODES,
  "  tm1-b7ead4-303438-eef5fb-a3adbb  ",
  "tM1-b7EaD4-303438-eEf5Fb-A3aDbB",
  "\tTM1-112233-445566-AABBCC-778899\n",
  "TM2-B7EAD4-303438-EEF5FB-A3ADBB",
  "TM10-B7EAD4-303438-EEF5FB-A3ADBB",
  "TM01-B7EAD4-303438-EEF5FB-A3ADBB",
  "TM2",
  "tm3-",
  "TM1",
  "TM1-",
  "TM1-not-a-theme",
  "",
  "   ",
  "TM-1",
  "TM1-B7EAD4-303438-EEF5FB",
  "TM1-B7EAD4-303438-EEF5FB-A3ADBB-000000",
  "TM1-B7EAD-303438-EEF5FB-A3ADBB",
  "TM1-GGGGGG-303438-EEF5FB-A3ADBB",
  "TM1_B7EAD4_303438_EEF5FB_A3ADBB",
  "TM1-#B7EAD4-303438-EEF5FB-A3ADBB",
  "XTM1-B7EAD4-303438-EEF5FB-A3ADBB",
  null,
  undefined,
  123,
  {},
  [],
  ["TM1-B7EAD4-303438-EEF5FB-A3ADBB"],
];
for (let i = 0; i < 200; i++) {
  const code = `TM1-${hex6()}-${hex6()}-${hex6()}-${hex6()}`;
  CODE_CORPUS.push(i % 3 === 0 ? randomCase(code) : i % 3 === 1 ? ` ${code.toLowerCase()} ` : code.toUpperCase());
}

const OVERRIDE_CORPUS = [
  {},
  null,
  undefined,
  "#ffffff",
  42,
  [],
  ["#ffffff", "#000000"],
  { accent: "#AABBCC" },
  { bg: " #F6F7F9 " },
  { bg: "#fff" },
  { bg: "#808080" },
  { bg: "#999999" },
  { bg: "#0b0c0e", text: "bad" },
  { bogus: "#123456", accent: 123 },
  { accent: "#b7ead4", bg: "#303438", text: "#eef5fb", muted: "#a3adbb" },
  { accent: "#e6e8ec", bg: "#0b0c0e", text: "#eceef2", muted: "#8f949c" },
  { accent: "#2563eb", bg: "#f6f7f9", text: "#1c1f26", muted: "#5b626d" },
  { muted: "#ABCDEF", text: "#123456" },
  { bg: "303438" },
];
for (let i = 0; i < 60; i++) {
  const o = {};
  for (const key of ["accent", "bg", "text", "muted"]) if (rand() < 0.7) o[key] = `#${i % 2 ? hex6().toUpperCase() : hex6()}`;
  OVERRIDE_CORPUS.push(o);
}

test("theme: constants match upstream themePresets.js and usageCharts.js", { skip, todo: UPSTREAM_GAP }, async () => {
  const { upstream, ours } = await load();
  for (const name of ["INTERFACE_COLOR_KEYS", "THEME_CODE_VERSION", "DEFAULT_THEME", "THEME_PRESETS", "VENDOR_ORDER", "VENDOR_LABELS"]) {
    assert.deepStrictEqual(ours.theme[name], upstream.theme[name], name);
  }
  // 品牌表連鍵的順序都要相同（orderedVendorIds 把不在 VENDOR_ORDER 的鍵依插入順序接在後面）。
  assert.deepStrictEqual(Object.entries(ours.colors.BRAND_COLORS), Object.entries(upstream.charts.clientColors));
  assert.deepStrictEqual(ours.colors.FALLBACK_MODEL_COLORS, upstream.charts.fallbackModelColors);
});

test("theme: TM1 codes decode and encode exactly like upstream", { skip }, async () => {
  const { upstream, ours } = await load();
  for (const input of CODE_CORPUS) {
    assert.deepStrictEqual(ours.theme.decodeThemeCode(input), upstream.theme.decodeThemeCode(input), JSON.stringify(input));
  }
  for (const o of OVERRIDE_CORPUS) {
    const label = JSON.stringify(o);
    assert.equal(ours.theme.encodeThemeCode(o), upstream.theme.encodeThemeCode(o), label);
    assert.deepStrictEqual(ours.theme.mergeThemeColors(o), upstream.theme.mergeThemeColors(o), label);
  }
  // 我們的預設配色存 {}，編出來的代碼要是上游「預設」的代碼。
  assert.equal(ours.theme.encodeThemeCode({}), PRESET_CODES[0]);
});

test("theme: overrides, vendor merge and ordering match upstream", { skip, todo: UPSTREAM_GAP }, async () => {
  const { upstream, ours } = await load();
  const keys = upstream.theme.INTERFACE_COLOR_KEYS;
  const brand = upstream.charts.clientColors;
  const vendorOverrides = [
    ...OVERRIDE_CORPUS,
    { claude: "#010203", codex: "BAD", unknown: "#ffffff", default: "#ABCDEF" },
    { kimi: " #16191E ", pi: "#000" },
  ];
  for (const o of vendorOverrides) {
    const label = JSON.stringify(o);
    assert.deepStrictEqual(ours.theme.normalizeOverrides(o), upstream.theme.normalizeOverrides(o), label);
    assert.deepStrictEqual(ours.theme.normalizeOverrides(o, keys), upstream.theme.normalizeOverrides(o, keys), label);
    assert.deepStrictEqual(ours.theme.mergeVendorColors(ours.colors.BRAND_COLORS, o), upstream.theme.mergeVendorColors(brand, o), label);
  }
  const brands = [brand, { zzz: "#000000", codex: "#111111" }, { default: "#000000" }, {}, { ...brand, extra: "#123456", another: "#654321" }];
  for (const b of brands) assert.deepStrictEqual(ours.theme.orderedVendorIds(b), upstream.theme.orderedVendorIds(b), JSON.stringify(Object.keys(b)));
  for (const id of [...Object.keys(brand), "somethingnew", "", "x"]) {
    assert.equal(ours.theme.vendorLabel(id), upstream.theme.vendorLabel(id), id);
  }
  for (const v of ["#aabbcc", " #AABBCC ", "#abc", "aabbcc", "#zzzzzz", "", null, 123, "#aabbcc\n"]) {
    assert.equal(ours.theme.isValidHex(v), upstream.theme.isValidHex(v), JSON.stringify(v));
    assert.equal(ours.theme.normalizeHex(v), upstream.theme.normalizeHex(v), JSON.stringify(v));
  }
});

test("theme: isLightHex and the CSS mapping match upstream themeCssVarEntries", { skip }, async () => {
  const { upstream, ours } = await load();
  const inputs = ["", "#fff", "not-a-hex", null, 123, " #ffffff", "#FFFFFF ", "#808080"];
  for (let v = 0; v < 4096; v++) {
    const [r, g, b] = [v >> 8, (v >> 4) & 15, v & 15].map((d) => d.toString(16));
    inputs.push(`#${r}${r}${g}${g}${b}${b}`);
  }
  for (const v of inputs) assert.equal(ours.theme.isLightHex(v), upstream.theme.isLightHex(v), JSON.stringify(v));

  const channels = (value) => {
    if (value == null) return null;
    return value.startsWith("#") ? upstream.theme.hexToRgbTriplet(value).replace(/, /g, " ") : value.replace(/, /g, " ");
  };
  const UPSTREAM_VAR = { accent: "--accent", bg: "--glass-rgb", text: "--text", muted: "--muted" };
  for (const o of OVERRIDE_CORPUS) {
    const label = JSON.stringify(o);
    const entries = Object.fromEntries(upstream.theme.themeCssVarEntries(o).map((e) => [e.name, e.value]));
    const { vars, light } = ours.theme.themeCssVars(o);
    for (const key of upstream.theme.INTERFACE_COLOR_KEYS) {
      assert.equal(vars[ours.theme.THEME_CSS_VARS[key]], channels(entries[UPSTREAM_VAR[key]]), `${label} ${key}`);
    }
    assert.equal(light === true, entries["color-scheme"] === "light", label);
  }
});

test("vendor colours: modelVendorFor and modelColor match upstream, with and without overrides", { skip, todo: UPSTREAM_GAP }, async () => {
  const { upstream, ours } = await load();
  const models = [
    "auto", "cursor-auto", "claude-sonnet-4-5", "anthropic/claude-opus-4", "haiku-3", "gpt-5.1-codex", "o1", "o3-mini", "o4-pro",
    "chatgpt-4o-latest", "gemini-2.5-pro", "gemma-3", "grok-4", "xai/grok", "deepseek-v3.2", "nemotron-70b", "llama-3.1-70b",
    "muse-spark-1", "mistral-large", "mixtral-8x7b", "codestral", "qwen3-coder", "qwq-32b", "qvq", "kimi-k2", "moonshot-v1",
    "k2d6-agent", "k3-agent", "k3", "k3-256k", "chatglm", "glm-4.6", "zai", "z.ai-glm", "zhipu", "command-r-plus", "mimo-7b",
    "minimax-m2", "MiniMax-M2", "abab6.5", "doubao-seed-1.6", "seed-oss", "step-3", "hy3", "hunyuan-t1", "swe-1.5", "devin",
    "cognition", "big-pickle", "", "unknown-model", "some-unknown-model", "__unattributed", "模型😀-𠮷", "Claude Haiku 4.5",
    null, undefined, 0,
  ];
  const charts = upstream.charts;
  const brand = { ...charts.clientColors };
  const check = (colors, tag) => {
    for (const m of models) {
      assert.equal(ours.vendor.modelVendorFor(m), charts.modelVendorFor(m), `${tag} vendor ${JSON.stringify(m)}`);
      assert.equal(ours.colors.modelColor(colors, m), charts.modelColor(m), `${tag} color ${JSON.stringify(m)}`);
    }
    for (const id of [...Object.keys(brand), "nope", "__unattributed"]) {
      assert.equal(ours.colors.clientColor(colors, id), charts.clientColors[id] || charts.clientColors.default, `${tag} client ${id}`);
    }
  };
  check(ours.colors.BRAND_COLORS, "brand");
  // 上游以 mergeVendorColors 直接改寫共用的 clientColors（app.js applyVendorColorOverrides）；比完還原。
  const overrides = { claude: "#010203", xai: "#ABCDEF", kimi: "#fedcba", default: "#123456", bogus: "#ffffff", gemini: "bad" };
  try {
    const merged = upstream.theme.mergeVendorColors(brand, overrides);
    for (const key of Object.keys(brand)) charts.clientColors[key] = merged[key];
    check(ours.theme.mergeVendorColors(ours.colors.BRAND_COLORS, overrides), "override");
  } finally {
    for (const key of Object.keys(brand)) charts.clientColors[key] = brand[key];
  }
});
