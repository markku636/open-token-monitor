// 趨勢視圖（上游 widget 的 Trends 視圖）：依期間的長條 + 活躍天數、連續天數、活躍時間、峰值單日。
// 熱力圖與趨勢線是主頁「活動」模組（Activity.tsx），與上游相同不在這裡。資料是本機的 history
// （tokscale graph），打開視圖時向 Rust 要（trends_get），本機有新 record 時重拉。
// 長條的動畫照上游 app.js `animateTrendBarsFrom`，點長條開儀表板照 `renderTrends` 的 `.trends-spark`。

import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { api, type AppStatus, type PeriodName, type RangeSummary, type Selection, type TrendsView } from "./api";
import { fmtTokens } from "./format";
import { t } from "./i18n";
import { EASE_DATA, M, sparkBarDelay, sparkFromScale } from "./motion";
import { prefersReducedMotion } from "./motionRuntime";
import { useApp } from "./store";
import { activityStats, fmtActiveDuration, periodSeries, shortLabel, type SeriesPoint } from "./trendsFormat";
import { Button } from "./ui";
import { useFetched } from "./useFetched";
import { isRange, weekStartDay } from "./periods";

const RANGE_LABEL: Record<PeriodName, string> = {
  today: t("近 7 天"),
  month: t("本月每日"),
  allTime: t("歷年每月"),
};

/** widget 的趨勢視圖與儀表板：只有 widget 的長條可以點（開儀表板）。 */
export type TrendsVariant = "widget" | "dashboard";

/** 長條的高度（容器的百分比）；沒有用量的是 1 px。 */
function barHeight(p: SeriesPoint, max: number): string {
  return p.tokens > 0 ? `${Math.max(3, (p.tokens / max) * 100)}%` : "1px";
}

function barPixels(p: SeriesPoint, max: number, container: number): number {
  return p.tokens > 0 ? (container * Math.max(3, (p.tokens / max) * 100)) / 100 : 1;
}

function openDashboard() {
  void api.windowOpenDashboard();
}

function PeriodBars({ view, selection, variant }: { view: TrendsView; selection: Selection; variant: TrendsVariant }) {
  // 範圍（本星期／最近 7、30 日）維持長期的每月長條，活躍時間與峰值則是那個範圍的（上游 renderTrends）。
  const range = isRange(selection) ? selection : null;
  const r = useFetched(() => (range ? api.rangeGet(range, weekStartDay()) : Promise.resolve(null)), selection);
  const rangeSummary: RangeSummary | null = r?.status === "ready" ? r.summary : null;
  const period: PeriodName = range ? "allTime" : (selection as PeriodName);
  const points = periodSeries(view, period);
  const stats = activityStats(view, period, rangeSummary);
  const max = Math.max(1, ...points.map((p) => p.tokens));
  const chart = useRef<HTMLDivElement>(null);
  /** 掛上（切進趨勢視圖）時長條從零長出（上游 animateChartsOnRender），之後從上一次的高度變過去。 */
  const fromZero = useRef(true);
  /** 上一次畫的每根長條高度（px，依 label）。 */
  const heights = useRef(new Map<string, number>());
  const signature = points.map((p) => `${p.label}:${p.tokens}`).join("|");
  useLayoutEffect(() => {
    const el = chart.current;
    if (!el) return;
    const container = el.clientHeight;
    const bars = Array.from(el.querySelectorAll<HTMLElement>(".tm-spark-bar[data-motion-key]"));
    const zero = fromZero.current;
    fromZero.current = false;
    const prev = heights.current;
    const next = new Map<string, number>();
    const reduced = prefersReducedMotion();
    bars.forEach((bar, index) => {
      const point = points[index];
      if (!point) return;
      const target = barPixels(point, max, container);
      next.set(point.label, target);
      if (reduced) return;
      const from = sparkFromScale(prev.get(point.label), target, zero);
      if (from === null) return;
      for (const a of bar.getAnimations?.() ?? []) a.cancel();
      bar.animate?.([{ transform: `scaleY(${from})` }, { transform: "scaleY(1)" }], {
        duration: M.sparkMs,
        delay: sparkBarDelay(index, zero || !prev.has(point.label)),
        easing: EASE_DATA,
        fill: "backwards",
      });
    });
    heights.current = next;
    // 只在長條本身變了時動（signature 涵蓋 label 與值）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  const cards = [
    { label: t("活躍天數"), value: stats.activeDays.toLocaleString("en-US") },
    { label: t("連續天數"), value: stats.currentStreak.toLocaleString("en-US") },
    { label: t("活躍時間"), value: fmtActiveDuration(stats.activeTimeMs) },
    { label: t("峰值單日"), value: fmtTokens(stats.peakDayTokens) },
  ];
  const clickable = variant === "widget";
  // 上游 .trends-spark：整塊可以點（Enter／Space 也行）開儀表板。
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openDashboard();
  };
  const bars = (
    <div ref={chart} className="flex h-16 items-end gap-[3px]" role="img" aria-label={RANGE_LABEL[period]}>
      {points.map((p, i) => (
        <div key={p.label} className="flex h-full flex-1 items-end" title={`${shortLabel(p)} · ${fmtTokens(p.tokens)}`}>
          <div
            data-motion-key={p.label}
            className={`tm-spark-bar w-full rounded-t-[2px] ${i === points.length - 1 ? "bg-info" : "bg-info/45"}`}
            style={{ height: barHeight(p, max), opacity: p.tokens > 0 ? 1 : 0.3 }}
          />
        </div>
      ))}
    </div>
  );
  return (
    <div className="px-3">
      <div className="flex items-baseline justify-between gap-2 text-2xs text-fg/45">
        <span>{RANGE_LABEL[period]}</span>
        {clickable && (
          <span className="cursor-pointer text-[13px] leading-none opacity-75" title={t("開啟儀表板")} onClick={openDashboard}>
            ↗
          </span>
        )}
      </div>
      {points.length ? (
        <>
          {clickable ? (
            <div role="button" tabIndex={0} title={t("開啟儀表板")} className="tm-spark mt-1 -mx-1" onClick={openDashboard} onKeyDown={onKeyDown}>
              {bars}
            </div>
          ) : (
            <div className="mt-1">{bars}</div>
          )}
          <div className="mt-0.5 flex justify-between text-2xs text-fg/40">
            <span>{shortLabel(points[0])}</span>
            <span>{shortLabel(points[points.length - 1])}</span>
          </div>
        </>
      ) : (
        <div className="py-4 text-center text-xs text-fg/40">{t("尚無使用歷史")}</div>
      )}
      <div className="mt-2 grid grid-cols-4 gap-1">
        {cards.map((c) => (
          <div key={c.label} className="rounded-sm bg-inset px-1.5 py-1">
            <div className="num text-xs">{c.value}</div>
            <div className="text-2xs leading-tight text-fg/45">{c.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 還沒掃過 history（第一次掃描要幾秒到幾十秒）時說明在掃；掃過但沒有任何一天才是「尚無」。主頁的活動模組共用。 */
export function emptyText(status: AppStatus | null): string {
  if (status && !status.lastHistoryAt && !status.historyError) return t("掃描使用歷史中...");
  return t("尚無使用歷史");
}

export function TrendsPanel({ period, variant = "widget" }: { period: Selection; variant?: TrendsVariant }) {
  const enabled = useApp((s) => s.settings?.historyEnabled ?? true);
  const status = useApp((s) => s.status);
  const updateSettings = useApp((s) => s.updateSettings);
  const view = useFetched(() => api.trendsGet(), "trends");
  if (!enabled) {
    return (
      <div className="flex flex-col items-center gap-3 px-3 py-10 text-center text-xs text-fg/45">
        {t("趨勢功能尚未啟用")}
        <Button variant="primary" className="text-xs" onClick={() => void updateSettings({ historyEnabled: true })}>
          {t("前往啟用")}
        </Button>
      </div>
    );
  }
  if (!view || !view.daily.some((d) => d.tokens > 0)) {
    return <div className="px-3 py-10 text-center text-xs text-fg/45">{emptyText(status)}</div>;
  }
  return <PeriodBars view={view} selection={period} variant={variant} />;
}
