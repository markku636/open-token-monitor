// 本機分頁的「近 30 天」長條圖。資料來自 Rust 的 HistoryPreview（display.rs）：以今天結尾、
// 連續 30 天（沒用的日子是 0），今天那一格是即時數字。

import type { HistoryPreview } from "./api";
import { fmtTokens, fmtUsd } from "./format";
import { t } from "./i18n";

/** 每一格的高度（0–1）。有用量的日子至少 0.06，才看得出「有用但很少」。 */
export function barHeights(daily: { tokens: number }[]): number[] {
  const max = daily.reduce((m, d) => Math.max(m, d.tokens), 0);
  return daily.map((d) => (max <= 0 || d.tokens <= 0 ? 0 : Math.max(0.06, d.tokens / max)));
}

export function HistoryStrip({ history }: { history: HistoryPreview }) {
  const heights = barHeights(history.daily);
  const last = history.daily.length - 1;
  const streak = history.currentStreak > 0 ? t("連續 {n} 天", { n: history.currentStreak }) : null;
  return (
    <div className="px-3 pt-3">
      <div className="flex items-baseline justify-between text-2xs text-fg/45">
        <span>{t("近 30 天")}</span>
        <span className="truncate pl-2">
          {[streak, t("最高 {n}", { n: fmtTokens(history.peakDayTokens) })].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div className="mt-1 flex h-9 items-end gap-px" role="img" aria-label={t("近 30 天")}>
        {history.daily.map((d, i) => (
          <div
            key={d.date}
            className="flex h-full flex-1 items-end"
            title={`${d.date} · ${fmtTokens(d.tokens)} tokens · ${fmtUsd(d.costUsd)}`}
          >
            <div
              className={`w-full rounded-t-[1px] ${i === last ? "bg-info" : "bg-info/45"}`}
              style={{ height: heights[i] > 0 ? `${heights[i] * 100}%` : "1px", opacity: heights[i] > 0 ? 1 : 0.25 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
