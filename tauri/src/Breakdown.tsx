// 依工具或模型拆分的橫條清單（本機與全公司分頁共用）。

import { clientLabel, seriesColor } from "./clients";
import { fmtPercent, fmtTokens, fmtUsd, topShares } from "./format";
import { t } from "./i18n";
import { useApp, type Breakdown } from "./store";
import { foldMap } from "./modelAliases";
import { useResolveModel } from "./useModelAlias";

/** 本機的 PeriodTotals 與全公司的 CompanyTotals 都有這些欄位。 */
export interface BreakdownSource {
  totalTokens: number;
  clients: Record<string, number>;
  clientCosts: Record<string, number>;
  models: Record<string, number>;
  modelCosts: Record<string, number>;
}

export function BreakdownList({ p, by, limit = 7 }: { p: BreakdownSource; by: Breakdown; limit?: number }) {
  const resolve = useResolveModel();
  // fmtUsd 讀模組層級的匯率：訂閱幣別，換了才會重繪（儀表板等不訂閱整個 store 的畫面）。
  useApp((s) => s.currency);
  // 模型依設定的別名合併後才排名（只影響顯示）。
  const shares =
    by === "client"
      ? topShares(p.clients, p.clientCosts, limit)
      : topShares(foldMap(p.models, resolve), foldMap(p.modelCosts, resolve), limit);
  if (!shares.length) {
    return <div className="px-3 py-6 text-center text-xs text-fg/40">{t("這段期間沒有用量")}</div>;
  }
  const max = Math.max(...shares.map((s) => s.tokens), 1);
  return (
    <ul className="space-y-1.5 px-3">
      {shares.map((s, i) => (
        <li key={s.key}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="truncate" title={s.key}>
              {by === "client" ? clientLabel(s.key) : s.key === "__other" ? t("其他") : s.key}
            </span>
            <span className="num shrink-0 text-fg/60">
              {fmtTokens(s.tokens)} · {fmtUsd(s.cost)} · {fmtPercent(s.tokens, p.totalTokens)}
            </span>
          </div>
          <div className="mt-0.5 h-1 rounded-full bg-fg/10">
            <div
              className="h-1 rounded-full"
              style={{ width: `${Math.max(2, (s.tokens / max) * 100)}%`, background: seriesColor(s.key, i) }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
