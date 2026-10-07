// 品牌圖示的圖檔網址：Vite 把 src/assets/brand/ 的 SVG 打包成檔案，或內嵌成 data URI（小於 4 KB 的）。
// 兩種都在 CSP 的 `img-src 'self' data:` 之內；webview 不連網。分開成一個檔是因為 import.meta.glob
// 只有 Vite 認得，brandIcons.ts 要留給 compat 測試直接以 Node 載入。

import { maskFileFor, type MarkVariant } from "./brandIcons";

const URLS = import.meta.glob("./assets/brand/*.svg", { query: "?url", import: "default", eager: true }) as Record<string, string>;

/** 圖示的網址；沒有遮罩規則或檔案不在時回 null（呼叫端退回色點）。 */
export function brandIconUrl(id: string, variant: MarkVariant = "row"): string | null {
  const file = maskFileFor(id, variant);
  return file ? (URLS[`./assets/brand/${file}`] ?? null) : null;
}
