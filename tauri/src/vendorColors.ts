// 廠商色：工具、模型、session、專案、裝置列與儀表板圖表的顏色。品牌表、模型的備用色與 modelColor
// 照抄上游 src/electron/renderer/usageCharts.js；limitProviderColor / colorWithAlpha 出自 app.js、
// readableColor 出自 edgeDock/dock.js、displayColor 出自 dashboard.js。
//
// 上游在設定變動時直接改寫共用的 clientColors；這裡改成傳入合併好的表（useVendorColors 以
// theme.ts 的 mergeVendorColors 把 `vendorColors` 覆寫套上 BRAND_COLORS），元件跟著設定重繪。
//
// 只 import 同樣不依賴其他模組的 modelVendor.ts（帶 .ts 副檔名，Node 的 type stripping 才找得到）：
// tests/compat/theme-compat.test.mjs 直接載入這個檔，與上游的 JavaScript 比對。

import { modelVendorFor } from "./modelVendor.ts";

export type VendorColorMap = Readonly<Record<string, string>>;

// 上游 clientColors（照抄，含鍵的順序）：廠商與它同名的工具共用顏色（moonshot/kimi、zai/zaiteam、xai/grok）。
// `pi: '#000'` 與幾個大寫值通不過 isValidHex；上游只驗證覆寫、不驗證品牌表，這裡同樣原樣保留。
export const BRAND_COLORS: VendorColorMap = {
  claude: "#cc7c5e", codex: "#49a3b0", opencode: "#000000", hermes: "#d4af37", openclaw: "#ff4d4d", cursor: "#000000", antigravity: "#4285f4", cline: "#9D4EDD",
  amp: "#F34E3F", droid: "#000000", kimi: "#16191e", qwen: "#615ced", grok: "#000000", copilot: "#000000", pi: "#000", zed: "#4173e7", kilo: "#F8F676", commandcode: "#8C4EDD", mimo: "#000000", zcode: "#000000", kiro: "#9046FF", codebuddy: "#6C4DFF", workbuddy: "#0DC8A5", proma: "#000000", qodercn: "#2ADB5C", reasonix: "#4d6bfe", dsh: "#4d6bfe", cherrystudio: "#EA5E5D", lmstudio: "#6C5CE7", unsloth: "#40B85A", devin: "#000000",
  openrouter: "#6566F1", gemini: "#4285f4", qoder: "#2ADB5C", deepseek: "#4d6bfe", xai: "#000000", meta: "#1d65c1", mistral: "#fa520f", moonshot: "#16191e", zai: "#000000", zaiteam: "#000000", cohere: "#39594d", xiaomi: "#000000", minimax: "#f23f5d", doubao: "#1E37FC", hunyuan: "#0053E0", volcengine: "#006EFF", trae: "#32F08C", ollama: "#888888", alibaba: "#615CED", nvidia: "#74B71B", stepfun: "#000000", thirdparty: "#8090A6",
  default: "#6ab4f0",
};

// 上游 fallbackModelColors：認不出廠商的模型與專案的固定顏色；刻意與每個品牌色都不同，
// 免得不相干的模型看起來像某家廠商的。
export const FALLBACK_MODEL_COLORS: readonly string[] = ["#6ab4f0", "#5fbf8a", "#a57df0", "#d97bc4", "#f0d66a", "#f06a7b"];

// Tauri 專有的「其他」列（format.ts topShares 把前 N 名以外合成 `__other`）：它不是廠商，
// 固定灰色、不能覆寫。
export const OTHER_BUCKET_COLOR = "#6b7280";

// 上游 modelColor：認得廠商就用廠商色，否則以小寫名稱的 UTF-16 碼元雜湊選備用色。
export function modelColor(colors: VendorColorMap, model: unknown): string {
  const vendor = modelVendorFor(model);
  if (vendor && colors[vendor]) return colors[vendor];
  const name = String(model || "").toLowerCase();
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_MODEL_COLORS[Math.abs(hash) % FALLBACK_MODEL_COLORS.length];
}

// 工具列與裝置明細（上游 app.js toolRowsForPeriod、deviceBreakdown.js）：沒有品牌色的（含
// `__unattributed`）用 "default"。
export function clientColor(colors: VendorColorMap, id: string): string {
  return colors[id] || colors.default;
}

// 上游 app.js limitProviderColor：Factory 的額度用 Droid 的顏色。給額度長條採用品牌色時用。
export function limitProviderColor(colors: VendorColorMap, id: string): string {
  if (id === "factory") return colors.droid;
  return colors[id] || colors.default;
}

// 上游 app.js colorWithAlpha：不是 6 位色碼時退回上游預設強調色。
export function colorWithAlpha(hex: string, alpha: number): string {
  const raw = String(hex || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(raw)) return `rgba(183, 234, 212, ${alpha})`;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function parseColor(value: string): number[] | null {
  const text = String(value || "").trim();
  let match = /^#([0-9a-f]{3})$/i.exec(text);
  if (match) return match[1].split("").map((digit) => Number.parseInt(digit + digit, 16));
  match = /^#([0-9a-f]{6})$/i.exec(text);
  if (match) {
    const hex = match[1];
    return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  }
  match = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(text);
  return match ? match.slice(1, 4).map(Number) : null;
}

function luminance(rgb: number[]): number {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// 上游 dock.js readableColor：近黑（或近白）的品牌色在同色調的底上看不見；對比低於 1.8 時改用文字色。
// 上游從 --glass-rgb 讀底色，這裡由呼叫端傳入（例如 `rgb(${--c-app})`），保持純函式。
export function readableColor(color: string, surface: string, fallback = "rgb(var(--c-fg))"): string {
  const rgb = parseColor(color);
  const base = parseColor(surface);
  if (!rgb || !base) return color;
  const a = luminance(rgb);
  const b = luminance(base);
  const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return contrast < 1.8 ? fallback : color;
}

// 上游 dashboard.js displayColor：Cursor、OpenCode 等純黑的品牌色在深色儀表板上看不見，
// 把很暗的顏色提亮成看得見的灰（色塊、長條、圖例）。widget 本身不提亮（上游相同）。
export function displayColor(hex: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ""));
  if (!m) return hex || "#6ab4f0";
  const r = parseInt(m[1].slice(0, 2), 16),
    g = parseInt(m[1].slice(2, 4), 16),
    b = parseInt(m[1].slice(4, 6), 16);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum >= 42) return hex;
  const lift = (c: number) => Math.round(c + (205 - c) * 0.62);
  return `rgb(${lift(r)}, ${lift(g)}, ${lift(b)})`;
}
