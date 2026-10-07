// 介面主題：三種一鍵配色、四色自訂、可分享的 TM1 主題代碼，以及廠商色清單的順序與名稱。
// 逐行照抄上游 src/electron/renderer/themePresets.js（加上 app.js 的 matchingThemePresetId /
// selectThemePreset），最後一段是 Tauri 的對應：四個鍵對到 styles.css 的 --c-* 色票。
//
// 刻意不 import 任何東西、只用可抹除的 TS 語法（沒有 enum、parameter property）：
// tests/compat/theme-compat.test.mjs 以 Node 的 type stripping 直接載入，與上游的 JavaScript 比對。

// 上游 INTERFACE_COLOR_KEYS：可自訂的介面色，依顯示順序。語意狀態色（成功、警告、危險、資訊）
// 刻意不開放：強調色換了，它們的意思也不能變。
// 這個順序是 TM1 格式的一部分：加欄位要換版本，舊代碼才不會被默默解讀成別的顏色。
export const INTERFACE_COLOR_KEYS = ["accent", "bg", "text", "muted"] as const;
export type ThemeColorKey = (typeof INTERFACE_COLOR_KEYS)[number];
export type ColorMap = Record<string, string>;
export type ThemePalette = Record<ThemeColorKey, string>;
export const THEME_CODE_VERSION = "TM1";

// 內建預設（上游 DEFAULT_THEME）；必須與 styles.css 深色 :root 的 --c-accent / --c-app / --c-fg / --c-muted 一致。
export const DEFAULT_THEME: ThemePalette = {
  accent: "#b7ead4",
  bg: "#303438",
  text: "#eef5fb",
  muted: "#a3adbb",
};

export type PresetId = "default" | "obsidian" | "porcelain";

// 一鍵配色（上游 THEME_PRESETS，同順序）：每個都是完整的四色，換的是整體氛圍而不只強調色。
export const THEME_PRESETS: { id: PresetId; colors: ThemePalette }[] = [
  { id: "default", colors: { ...DEFAULT_THEME } },
  { id: "obsidian", colors: { accent: "#e6e8ec", bg: "#0b0c0e", text: "#eceef2", muted: "#8f949c" } },
  { id: "porcelain", colors: { accent: "#2563eb", bg: "#f6f7f9", text: "#1c1f26", muted: "#5b626d" } },
];

// Tauri 淺色模式的底色：styles.css 的 :root.light 四個色票就是「瓷白」（theme.test.ts 守著）。上游沒有這個。
export const LIGHT_THEME: ThemePalette = { ...THEME_PRESETS.find((p) => p.id === "porcelain")!.colors };

// 廠商色清單的順序（上游 VENDOR_ORDER）：追蹤的工具在前，其次是模型廠商；品牌表裡有、這裡沒有的
// 接在後面，最後是 "default"。
export const VENDOR_ORDER: readonly string[] = [
  "claude", "codex", "opencode", "hermes", "openclaw", "cursor", "antigravity", "cline",
  "amp", "droid", "kimi", "qwen", "grok", "copilot", "pi", "zed", "kilo", "commandcode", "mimo", "zcode", "kiro", "codebuddy", "workbuddy", "proma", "qodercn", "reasonix", "dsh", "cherrystudio", "lmstudio", "unsloth", "devin",
  "openrouter", "gemini", "qoder", "deepseek", "xai", "meta", "mistral", "moonshot", "zai", "zaiteam", "cohere", "xiaomi", "minimax", "doubao", "hunyuan", "volcengine", "ollama", "trae", "alibaba", "nvidia", "stepfun", "thirdparty",
];

// 品牌表每個廠商的顯示名稱（上游 VENDOR_LABELS）；產品名不翻譯。
export const VENDOR_LABELS: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  hermes: "Hermes Agent",
  openclaw: "OpenClaw",
  cursor: "Cursor",
  antigravity: "Antigravity",
  cline: "Cline",
  amp: "Amp",
  droid: "Factory Droid",
  kimi: "Kimi",
  qwen: "Qwen",
  grok: "Grok Build",
  copilot: "GitHub Copilot",
  pi: "Pi",
  zed: "Zed",
  kilo: "Kilo",
  commandcode: "Command Code",
  mimo: "Xiaomi MiMo",
  zcode: "ZCode",
  kiro: "Kiro",
  codebuddy: "CodeBuddy",
  workbuddy: "WorkBuddy",
  proma: "Proma",
  qodercn: "Qoder CN",
  reasonix: "Reasonix",
  dsh: "DeepSeek Harness",
  cherrystudio: "Cherry Studio",
  lmstudio: "LM Studio",
  unsloth: "Unsloth",
  devin: "Devin",
  openrouter: "OpenRouter",
  gemini: "Gemini",
  qoder: "Qoder",
  deepseek: "DeepSeek",
  xai: "xAI",
  meta: "Meta",
  mistral: "Mistral",
  moonshot: "Moonshot",
  zai: "GLM",
  zaiteam: "GLM Team",
  cohere: "Cohere",
  xiaomi: "Xiaomi",
  minimax: "MiniMax",
  doubao: "Doubao",
  hunyuan: "Hunyuan",
  volcengine: "Volcengine",
  trae: "Trae CN",
  ollama: "Ollama",
  alibaba: "Alibaba Cloud",
  nvidia: "NVIDIA",
  stepfun: "StepFun",
  thirdparty: "Third-party APIs",
  default: "Default",
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isValidHex(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value.trim());
}

export function normalizeHex(value: unknown): string | null {
  return isValidHex(value) ? value.trim().toLowerCase() : null;
}

// 上游 normalizeOverrides：只留允許的鍵與合法的色碼（小寫），回傳新物件。陣列照上游走 Object.entries。
export function normalizeOverrides(overrides: unknown, allowedKeys?: readonly string[]): ColorMap {
  const allowed = allowedKeys ? new Set(allowedKeys) : null;
  const out: ColorMap = {};
  if (!overrides || typeof overrides !== "object") return out;
  for (const [key, value] of Object.entries(overrides)) {
    if (allowed && !allowed.has(key)) continue;
    const hex = normalizeHex(value);
    if (hex) out[key] = hex;
  }
  return out;
}

// 完整的介面配色：預設值套上合法的覆寫。
export function mergeThemeColors(overrides: unknown): ThemePalette {
  const clean = normalizeOverrides(overrides, INTERFACE_COLOR_KEYS);
  return { ...DEFAULT_THEME, ...clean };
}

// 可攜、離線的主題代碼。編的是合併後的完整配色，所以空的覆寫也編出預設值。
export function encodeThemeCode(overrides: unknown): string {
  const colors = mergeThemeColors(overrides);
  const fields = INTERFACE_COLOR_KEYS.map((key) => colors[key].slice(1).toUpperCase());
  return `${THEME_CODE_VERSION}-${fields.join("-")}`;
}

export type DecodedThemeCode =
  | { ok: true; colors: ThemePalette; code: string }
  | { ok: false; reason: "invalid" | "unsupportedVersion" };

export function decodeThemeCode(value: unknown): DecodedThemeCode {
  const code = typeof value === "string" ? value.trim() : "";
  const version = /^TM(\d+)(?:-|$)/i.exec(code);
  if (version && version[1] !== "1") return { ok: false, reason: "unsupportedVersion" };

  const match = /^TM1-([0-9a-f]{6})-([0-9a-f]{6})-([0-9a-f]{6})-([0-9a-f]{6})$/i.exec(code);
  if (!match) return { ok: false, reason: "invalid" };

  const colors = Object.fromEntries(
    INTERFACE_COLOR_KEYS.map((key, index) => [key, `#${match[index + 1].toLowerCase()}`]),
  ) as ThemePalette;
  return { ok: true, colors, code: encodeThemeCode(colors) };
}

// 上游格式 "r, g, b"（逗號分隔）；# 可省略。
export function hexToRgbTriplet(hex: string): string {
  const v = String(hex).replace("#", "");
  return `${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)}`;
}

// 感知亮度 > 0.6 算淺色背景（上游用它決定要不要翻成淺色的邊框與面板）。
export function isLightHex(hex: unknown): boolean {
  if (!isValidHex(hex)) return false;
  const v = hex.replace("#", "");
  const r = parseInt(v.slice(0, 2), 16),
    g = parseInt(v.slice(2, 4), 16),
    b = parseInt(v.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

// 生效的廠商色：品牌色套上合法的覆寫。只接受品牌表裡有的 id（brand 含 "default"）。
export function mergeVendorColors(brand: Readonly<ColorMap>, overrides: unknown): ColorMap {
  const clean = normalizeOverrides(overrides, Object.keys(brand || {}));
  return { ...(brand || {}), ...clean };
}

// 設定頁廠商色清單的順序：已知順序在前、其他品牌鍵其次、"default" 最後。
export function orderedVendorIds(brand: Readonly<ColorMap>): string[] {
  const keys = Object.keys(brand || {}).filter((k) => k !== "default");
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of VENDOR_ORDER) {
    if (keys.includes(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }
  for (const id of keys) {
    if (!seen.has(id)) ordered.push(id);
  }
  if (Object.prototype.hasOwnProperty.call(brand || {}, "default")) ordered.push("default");
  return ordered;
}

export function vendorLabel(id: string): string {
  return VENDOR_LABELS[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : id);
}

// 上游 app.js matchingThemePresetId：合併後的配色四個鍵都相同的第一個預設，否則 null（自訂）。
// `light` 是目前解析出的明暗（resolveLight）：比的是畫面上的配色（effectiveThemeColors），淺色模式
// 沒有覆寫時就是「瓷白」。預設 false 時與上游的 mergeThemeColors 相同。
export function matchingThemePresetId(overrides: unknown, light = false): PresetId | null {
  const resolved = effectiveThemeColors(overrides, light);
  for (const preset of THEME_PRESETS) {
    if (INTERFACE_COLOR_KEYS.every((k) => resolved[k] === preset.colors[k])) return preset.id;
  }
  return null;
}

// 上游 app.js selectThemePreset：只存與底色不同的鍵，沒動到的顏色會跟著底色的改版走。
// 上游的底色永遠是 DEFAULT_THEME（「預設」存 {}）；Tauri 的底色看色彩模式（`modeLight` =
// resolveLight(theme, {}, …)，不含目前的覆寫，因為存下去的會整份取代它們）：淺色模式「瓷白」存 {}、
// 「預設」存整組（背景 #303438 讓它變深色）。
export function presetOverrides(presetId: PresetId, modeLight = false): ColorMap {
  const preset = THEME_PRESETS.find((p) => p.id === presetId);
  const next: ColorMap = {};
  if (!preset) return next;
  const base = basePalette(modeLight);
  for (const key of INTERFACE_COLOR_KEYS) {
    if (preset.colors[key] !== base[key]) next[key] = preset.colors[key];
  }
  // 存下的背景讓明暗與色彩模式不同時，沒存的鍵會回到另一組底色：整組存下來畫面才會是這個預設。
  if (next.bg && isLightHex(next.bg) !== modeLight) return { ...preset.colors };
  return next;
}

// ---- Tauri 的對應（上游 themeCssVarEntries 的角色）----

// 四個鍵對到的 CSS 變數（styles.css 以 "R G B" 三元組存放，Tailwind 用 rgb(var(--x) / alpha)）。
// 上游的 --number 跟著 text、--accent-rgb 跟著 accent；Tauri 的大數字與強調色都直接用這兩個變數，不必另外設。
export const THEME_CSS_VARS: Record<ThemeColorKey, string> = {
  accent: "--c-accent",
  bg: "--c-app",
  text: "--c-fg",
  muted: "--c-muted",
};

// "#303438" → "48 52 56"。
export function hexToChannels(hex: string): string {
  return hexToRgbTriplet(hex).replace(/, /g, " ");
}

// 覆寫要設的 CSS 變數：沒覆寫的鍵是 null（removeProperty，回到 styles.css 的值）。
// `light`：有背景覆寫時依 isLightHex 決定明暗（上游的 light flip，只看覆寫）；沒有時是 null，
// 由設定 `theme`（色彩模式）決定。上游在淺色時另外換的 overlay / line / panel / sunken / success /
// color-scheme，在 Tauri 就是 <html class="light"> 帶來的 :root.light 色票。
export function themeCssVars(overrides: unknown): { vars: Record<string, string | null>; light: boolean | null } {
  const clean = normalizeOverrides(overrides, INTERFACE_COLOR_KEYS);
  const vars: Record<string, string | null> = {};
  for (const key of INTERFACE_COLOR_KEYS) {
    vars[THEME_CSS_VARS[key]] = clean[key] ? hexToChannels(clean[key]) : null;
  }
  return { vars, light: clean.bg ? isLightHex(clean.bg) : null };
}

// 明暗只有一條規則：背景有覆寫看背景亮度，否則看色彩模式（system 跟著 Windows）。
// store.ts applyTheme 用它；index.html 的 pre-paint 另有一份同樣的判斷（store.test.ts 比對兩者）。
export function resolveLight(theme: string | undefined, overrides: unknown, prefersLight: boolean): boolean {
  const forced = themeCssVars(overrides).light;
  return forced ?? (theme === "light" || (theme !== "dark" && prefersLight));
}

// 沒覆寫的鍵回到的底色：深色是 DEFAULT_THEME（:root），淺色是瓷白（:root.light）。
export function basePalette(light: boolean): ThemePalette {
  return light ? LIGHT_THEME : DEFAULT_THEME;
}

// 畫面上實際的四色：覆寫套在所解析明暗（resolveLight）的底色上。上游的 mergeThemeColors 永遠以
// DEFAULT_THEME 為底——它沒有「沒自訂背景卻是淺色」的狀態，所以那就是畫面。Tauri 的色彩模式可以是
// 淺色，設定頁的色格、預設晶片與主題代碼都用這個，複製出去的代碼才與畫面相同。
export function effectiveThemeColors(overrides: unknown, light: boolean): ThemePalette {
  return { ...basePalette(light), ...normalizeOverrides(overrides, INTERFACE_COLOR_KEYS) };
}
