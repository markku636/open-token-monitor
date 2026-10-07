// 依工具或模型拆分的橫條清單（本機、全公司分頁與儀表板共用）。

import { useRef } from "react";
import { RowMark, useToolIcons } from "./BrandMark";
import { iconKindFor, type MarkKind } from "./brandIcons";
import { clientLabel } from "./clients";
import { fmtPercent, fmtTokens, fmtUsd, topShares } from "./format";
import { t } from "./i18n";
import { useApp, type Breakdown } from "./store";
import { foldMap } from "./modelAliases";
import { useListMotion, type ListMotion } from "./DataMotion";
import { useResolveModel } from "./useModelAlias";
import { useVendorColors } from "./useVendorColors";
import { clientColor, displayColor, modelColor, OTHER_BUCKET_COLOR } from "./vendorColors";

/** 本機的 PeriodTotals 與全公司的 CompanyTotals 都有這些欄位。 */
export interface BreakdownSource {
  totalTokens: number;
  clients: Record<string, number>;
  clientCosts: Record<string, number>;
  models: Record<string, number>;
  modelCosts: Record<string, number>;
}

/**
 * `motion` 給了就有列動畫（見 DataMotion.tsx `useListMotion`）；`variant="dashboard"` 是儀表板的樣式：
 * 只有長條動（800 ms、沒有 CSS 過場），數字是一般文字（上游 dashboard.js renderBreakdown）。
 * `lift`：儀表板把近黑的品牌色提亮（上游 dashboard.js 的色塊與長條都經過 displayColor）；widget 不提亮。
 * `marks`：名稱前面的品牌圖示或色點（上游 widget 清單的 row mark）；上游的儀表板沒有，儀表板傳 false。
 */
export function BreakdownList({
  p,
  by,
  limit = 7,
  motion,
  variant = "widget",
  lift = false,
  marks = true,
}: {
  p: BreakdownSource;
  by: Breakdown;
  limit?: number;
  motion?: ListMotion;
  variant?: "widget" | "dashboard";
  lift?: boolean;
  marks?: boolean;
}) {
  const resolve = useResolveModel();
  const list = useRef<HTMLUListElement>(null);
  const colors = useVendorColors();
  const icons = useToolIcons();
  // fmtUsd 讀模組層級的匯率：訂閱幣別，換了才會重繪（儀表板等不訂閱整個 store 的畫面）。
  useApp((s) => s.currency);
  // 模型依設定的別名合併後才排名（只影響顯示）。
  const shares =
    by === "client"
      ? topShares(p.clients, p.clientCosts, limit)
      : topShares(foldMap(p.models, resolve), foldMap(p.modelCosts, resolve), limit);
  const max = Math.max(...shares.map((s) => s.tokens), 1);
  // 保留原本 2% 的最小長度，沒有用量的列也看得到一點。
  const scaleOf = (tokens: number) => Math.max(2, (tokens / max) * 100) / 100;
  useListMotion(
    list,
    shares.map((s) => ({ key: s.key, value: s.tokens, scale: scaleOf(s.tokens) })),
    fmtTokens,
    motion,
    variant,
  );
  if (!shares.length) {
    return <div className="px-3 py-6 text-center text-xs text-fg/40">{t("這段期間沒有用量")}</div>;
  }
  const dashboard = variant === "dashboard";
  // 工具用廠商色（沒有的用 default）、模型依廠商或名稱雜湊（上游 toolRowsForPeriod / modelColor）；
  // 前 N 名以外合成的「其他」固定灰色。
  const colorOf = (key: string) => {
    const base = key === "__other" ? OTHER_BUCKET_COLOR : by === "client" ? clientColor(colors, key) : modelColor(colors, key);
    return lift ? displayColor(base) : base;
  };
  // 「其他」是 Tauri 專有的合併列，不是工具也不是模型：一律色點（否則模型模式會畫成 Σ）。
  const markOf = (key: string): MarkKind =>
    key === "__other" ? { kind: "dot" } : iconKindFor({ key }, by === "client" ? "tool" : "model", icons);
  return (
    <ul ref={list} className="relative space-y-1.5 px-3">
      {shares.map((s) => (
        <li key={s.key} data-motion-key={s.key}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="flex min-w-0 items-center gap-1.5">
              {marks && <RowMark mark={markOf(s.key)} color={colorOf(s.key)} />}
              <span className="truncate" title={s.key}>
                {by === "client" ? clientLabel(s.key) : s.key === "__other" ? t("其他") : s.key}
              </span>
            </span>
            <span className="num shrink-0 text-fg/60">
              {dashboard ? fmtTokens(s.tokens) : <span data-motion-number="" />} · {fmtUsd(s.cost)} · {fmtPercent(s.tokens, p.totalTokens)}
            </span>
          </div>
          <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-fg/10">
            <div className={dashboard ? "tm-bar-fill tm-bar-static" : "tm-bar-fill"} style={{ background: colorOf(s.key) }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
