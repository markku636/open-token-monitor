// 清單列前面的標記：品牌圖示或色點（上游 app.js renderBreakdownRow 的 `row-mark row-icon <cls>` / `.dot`）。
// 圖示一律用 CSS 遮罩、顏色是 currentColor（跟著那一列文字的顏色，上游 styles.css `.row-icon`）：
// 有些 SVG 把顏色寫死（例如 os-windows 的 #0078d4），直接內嵌會破壞單色的清單。

import { brandIconUrl } from "./brandIconUrl";
import type { MarkKind, MarkVariant } from "./brandIcons";
import { useApp } from "./store";

/**
 * `showToolIcons`。上游多數地方用 `=== true`；Tauri 的設定是 serde bool，只有設定還沒載入（null）時
 * 兩者不同——用 `!== false`，啟動時才不會先畫色點再閃成圖示（預設就是開）。
 */
export function useToolIcons(): boolean {
  return useApp((s) => s.settings?.showToolIcons !== false);
}

/**
 * `mark` 是 brandIcons.ts `iconKindFor` 的結果。圖示找不到檔案時退回色點；沒給 `color` 時色點也不畫
 *（服務狀態這類只在有圖示時才加標記的地方）。
 */
export function RowMark({
  mark,
  color,
  size = 10,
  variant = "row",
  className = "",
}: {
  mark: MarkKind;
  color?: string;
  size?: number;
  variant?: MarkVariant;
  className?: string;
}) {
  const url = mark.kind === "icon" ? brandIconUrl(mark.id, variant) : null;
  if (!url) {
    if (!color) return null;
    return <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${className}`} style={{ background: color }} />;
  }
  const image = `url("${url}")`;
  return <span aria-hidden className={`brand-icon ${className}`} style={{ width: size, height: size, maskImage: image, WebkitMaskImage: image }} />;
}
