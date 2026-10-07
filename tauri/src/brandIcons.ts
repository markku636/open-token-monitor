// 工具／模型廠商的品牌圖示：哪些 id 有圖示、每個 id 用哪個遮罩檔，以及清單列該畫圖示還是色點。
// 規則照抄上游 src/electron/renderer/app.js（clientsWithIcon、limitMarksWithIcon、osIconFor、iconKindFor、
// serviceStatusIconId）與 styles.css 的 `.row-icon-<id>` 遮罩表；模型 → 廠商共用 modelVendor.ts
//（顏色與圖示同一份，不另抄第二份）。
//
// 圖檔網址在 brandIconUrl.ts（要 Vite 的 import.meta.glob）；這個檔只 import 同樣不依賴其他模組的
// modelVendor.ts（帶 .ts 副檔名），tests/compat/brand-icons.test.mjs 以 Node 的 type stripping 直接載入，
// 與上游的字面值比對。

import { modelVendorFor } from "./modelVendor.ts";

// 上游 app.js `clientsWithIcon`（照抄，含順序）：清單列畫品牌圖示的工具與模型廠商。
// 全公司分頁會出現 Electron 裝置回報的任何上游 client id，所以不只列 Tauri 支援的工具。
export const CLIENTS_WITH_ICON: ReadonlySet<string> = new Set([
  "claude", "codex", "opencode", "hermes", "openclaw", "cursor", "antigravity", "cline", "amp", "droid", "kimi", "qwen", "grok", "copilot", "pi", "zed", "kilo", "commandcode", "mimo", "zcode", "kiro", "codebuddy", "workbuddy", "proma", "qodercn", "reasonix", "dsh", "cherrystudio", "lmstudio", "unsloth", "devin",
  "gemini", "xai", "openrouter", "deepseek", "meta", "mistral", "moonshot", "zai", "zaiteam", "cohere", "xiaomi", "minimax", "doubao", "volcengine", "qoder", "trae", "ollama", "thirdparty", "hunyuan", "nvidia", "stepfun"
]);

// 上游 src/shared/limitProviders.js `LIMIT_PROVIDER_IDS`（照抄，含順序）。Tauri 只探測其中兩家，
// 但額度卡片的標頭照上游為每個 provider 準備圖示；compat 測試守著與上游一致。
export const UPSTREAM_LIMIT_PROVIDER_IDS: readonly string[] = [
  "claude", "codex", "opencode", "cursor", "antigravity", "cline", "factory", "kimi", "grok", "copilot", "zed", "commandcode", "mimo", "zai", "zaiteam", "kiro", "workbuddy", "qoder", "deepseek", "devin", "openrouter", "minimax", "volcengine", "ollama", "trae", "alibaba", "thirdparty",
];

// 上游 app.js `limitMarksWithIcon`：額度列比工具多幾個 provider（factory、alibaba、newapi、sub2api）。
export const LIMIT_MARK_IDS: ReadonlySet<string> = new Set([...CLIENTS_WITH_ICON, ...UPSTREAM_LIMIT_PROVIDER_IDS, "newapi", "sub2api"]);

// 上游 styles.css 的 `.row-icon-<id>` → `assets/icons/<file>`（照抄，一個 id 一行）。檔案在
// src/assets/brand/，逐字複製自上游。注意 grok（工具）用 xai.svg、xai（模型廠商）用 grok.svg，
// 與上游相同；project 是 renderer/icons/views/project-row.svg。
export const MASK_FILE: Readonly<Record<string, string>> = {
  claude: "claude.svg",
  codex: "codex.svg",
  hermes: "hermes-agent.svg",
  gemini: "gemini.svg",
  cursor: "cursor.svg",
  antigravity: "antigravity.svg",
  cline: "cline.svg",
  amp: "amp.svg",
  droid: "droid.svg",
  factory: "droid.svg",
  kimi: "kimi.svg",
  grok: "xai.svg",
  copilot: "copilot.svg",
  pi: "pi.svg",
  zed: "zed.svg",
  kilo: "kilo.svg",
  commandcode: "commandcode.svg",
  zcode: "zai.svg",
  kiro: "kiro.svg",
  codebuddy: "codebuddy.svg",
  workbuddy: "workbuddy.svg",
  proma: "proma.svg",
  reasonix: "reasonix.svg",
  dsh: "dsh.svg",
  cherrystudio: "cherrystudio.svg",
  lmstudio: "lmstudio.svg",
  unsloth: "unsloth.svg",
  devin: "devin.svg",
  opencode: "opencode.svg",
  openrouter: "openrouter.svg",
  openclaw: "openclaw.svg",
  deepseek: "deepseek.svg",
  hunyuan: "hunyuan.svg",
  xai: "grok.svg",
  meta: "meta.svg",
  mistral: "mistral.svg",
  qwen: "qwen.svg",
  moonshot: "moonshot.svg",
  zai: "zai.svg",
  zaiteam: "zai.svg",
  cohere: "cohere.svg",
  xiaomi: "xiaomi.svg",
  mimo: "xiaomi.svg",
  minimax: "minimax.svg",
  doubao: "doubao.svg",
  volcengine: "volcengine.svg",
  alibaba: "alibaba.svg",
  qoder: "qoder.svg",
  trae: "trae.svg",
  qodercn: "qodercn.svg",
  ollama: "ollama.svg",
  thirdparty: "thirdparty.svg",
  nvidia: "nvidia.svg",
  stepfun: "stepfun.svg",
  newapi: "newapi.svg",
  sub2api: "sub2api.svg",
  "token-monitor": "token-monitor.svg",
  "os-apple": "os-apple.svg",
  "os-linux": "os-linux.svg",
  "os-windows": "os-windows.svg",
  project: "project-row.svg",
};

// 上游 styles.css `.limit-icon.row-icon-grok`：額度卡片的 Grok 用 grok.svg（清單列的 grok 是 xai.svg）。
export const LIMIT_MASK_OVERRIDE: Readonly<Record<string, string>> = {
  grok: "grok.svg",
};

export type MarkVariant = "row" | "limit";

/** 遮罩檔名；沒有對應時回 null（呼叫端退回色點，不會像上游缺規則時畫成實心方塊）。 */
export function maskFileFor(id: string, variant: MarkVariant = "row"): string | null {
  if (variant === "limit" && Object.prototype.hasOwnProperty.call(LIMIT_MASK_OVERRIDE, id)) return LIMIT_MASK_OVERRIDE[id];
  return Object.prototype.hasOwnProperty.call(MASK_FILE, id) ? MASK_FILE[id] : null;
}

/** 上游 app.js `osIconFor`：platform 字串（`win32-x64`）的前綴 → 系統圖示。 */
export function osIconFor(platform: string | null | undefined): "apple" | "windows" | "linux" | null {
  const prefix = String(platform || "").toLowerCase().split("-")[0];
  if (prefix === "darwin") return "apple";
  if (prefix === "win32") return "windows";
  if (prefix === "linux" || prefix === "freebsd" || prefix === "openbsd") return "linux";
  return null;
}

export type BreakdownKind = "tool" | "model" | "session" | "project" | "device" | "limits";
export type MarkKind = { kind: "dot" } | { kind: "icon"; id: string };

const DOT: MarkKind = { kind: "dot" };

/**
 * 上游 app.js `iconKindFor`：清單列前面畫哪個圖示，或退回色點。`enabled` 是 `showToolIcons`
 *（上游在函式裡讀 state.settings，這裡由呼叫端傳入，保持純函式）。
 *
 * - device：系統圖示，認不出系統時色點。
 * - model：廠商圖示；認不出廠商（含 `__unattributed`）時畫 Token Monitor 的 Σ。
 * - session：工具圖示，沒有時色點。
 * - project：資料夾。
 * - tool / limits：key 在 `CLIENTS_WITH_ICON`（額度用 `LIMIT_MARK_IDS`）裡才畫。
 *
 * 主頁總覽（與之後移植的訂閱清單）也用這個函式；主頁額度的帳號名稱在 `showToolIcons` 關閉時一定要顯示
 *（上游 settings.home.providerNamesRequiredWithoutIcons），沒有圖示就只剩名稱能辨認 provider。
 */
export function iconKindFor(row: { key?: string; platform?: string; client?: string }, breakdown: BreakdownKind, enabled: boolean): MarkKind {
  if (!enabled) return DOT;
  if (breakdown === "device") {
    const os = osIconFor(row.platform);
    return os ? { kind: "icon", id: `os-${os}` } : DOT;
  }
  if (breakdown === "model") {
    const vendor = modelVendorFor(row.key);
    return vendor && CLIENTS_WITH_ICON.has(vendor) ? { kind: "icon", id: vendor } : { kind: "icon", id: "token-monitor" };
  }
  if (breakdown === "session") {
    return row.client && CLIENTS_WITH_ICON.has(row.client) ? { kind: "icon", id: row.client } : DOT;
  }
  if (breakdown === "project") return { kind: "icon", id: "project" };
  const iconSet = breakdown === "limits" ? LIMIT_MARK_IDS : CLIENTS_WITH_ICON;
  return row.key && iconSet.has(row.key) ? { kind: "icon", id: row.key } : DOT;
}

/** 上游 app.js `serviceStatusIconId`：服務狀態的 OpenAI 用 Codex 的圖示，其他 id 與圖示同名。 */
export function serviceStatusIconId(id: string): string {
  return id === "openai" ? "codex" : id;
}
