// 趨勢分頁：上游 widget 主頁的「活動」模組（滾動一年的熱力圖 + 最近 45 天的趨勢線）與 Trends 視圖
// （依期間的長條 + 活躍天數、連續天數、活躍時間、峰值單日）。資料是本機的 history（tokscale graph），
// 打開分頁時向 Rust 要（trends_get），本機有新 record 時重拉。

import { useLayoutEffect, useRef } from "react";
import { api, type AppStatus, type PeriodName, type RangeSummary, type Selection, type TrendsView } from "./api";
import { fmtTokens, fmtUsd } from "./format";
import { lang, t } from "./i18n";
import { useApp } from "./store";
import {
  activityStats,
  activityTrend,
  areaChart,
  fmtActiveDuration,
  periodSeries,
  rollingYearHeatmap,
  shortLabel,
  type HeatMetric,
} from "./trendsFormat";
import { Button, Segmented } from "./ui";
import { useFetched } from "./useFetched";
import { isRange, weekStartDay } from "./periods";

const CELL = 9;
const GAP = 3;
const RADIUS = 2;
/** 等級 1–4 的不透明度（上游 styles.css 的熱力圖色階），用主題的強調色。 */
const LEVEL_ALPHA = [0, 0.18, 0.45, 0.8, 1];

function monthName(month: string): string {
  try {
    return new Intl.DateTimeFormat(lang() === "en" ? "en" : "zh-TW", { month: "short", timeZone: "UTC" }).format(
      new Date(`${month}-01T00:00:00Z`),
    );
  } catch {
    return month.slice(5);
  }
}

function Heatmap({ view, metric }: { view: TrendsView; metric: HeatMetric }) {
  const scroller = useRef<HTMLDivElement>(null);
  const map = rollingYearHeatmap(view.daily, view.today, metric);
  const width = map.weeks ? map.weeks * (CELL + GAP) - GAP : 0;
  const gridH = 7 * (CELL + GAP) - GAP;
  // 最新的一週在最右邊：一打開就捲到底（上游同樣貼齊右緣）。
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [width]);
  return (
    <div ref={scroller} className="scroll-thin overflow-x-auto">
      <svg width={width} height={gridH + 14} role="img" aria-label={t("活動")} className="block">
        {map.cells.map((c) => (
          <rect
            key={c.date}
            x={c.col * (CELL + GAP)}
            y={c.row * (CELL + GAP)}
            width={CELL}
            height={CELL}
            rx={RADIUS}
            className={c.level > 0 ? "fill-accent" : "fill-fg/[0.07]"}
            fillOpacity={c.level > 0 ? LEVEL_ALPHA[c.level] : undefined}
          >
            <title>{`${fmtTokens(c.tokens)} tokens${c.cost > 0 ? ` · ${fmtUsd(c.cost)}` : ""}\n${c.date}`}</title>
          </rect>
        ))}
        {map.monthLabels.map((m) => (
          <text key={m.month} x={m.col * (CELL + GAP)} y={gridH + 12} className="fill-fg/40 text-[9px]">
            {monthName(m.month)}
          </text>
        ))}
      </svg>
    </div>
  );
}

function TrendLine({ view }: { view: TrendsView }) {
  const { rows, peak } = activityTrend(view);
  const chart = areaChart(
    rows.map((r) => ({ label: r.date, value: r.tokens })),
    300,
    70,
  );
  const labels = rows.length ? [rows[0], rows[Math.floor((rows.length - 1) / 2)], rows[rows.length - 1]] : [];
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between text-2xs text-fg/45">
        <span>{t("趨勢")}</span>
        <span className="num">{t("峰值 {value}", { value: fmtTokens(peak) })}</span>
      </div>
      <svg viewBox="0 0 300 70" preserveAspectRatio="none" className="mt-1 block h-[70px] w-full" role="img" aria-label={t("趨勢")}>
        <path d={chart.area} className="fill-accent/15" />
        <path d={chart.line} className="fill-none stroke-accent" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-2xs text-fg/40">
        {labels.map((r, i) => (
          <span key={`${r.date}-${i}`}>{shortLabel({ label: r.date, kind: "date" })}</span>
        ))}
      </div>
    </div>
  );
}

const RANGE_LABEL: Record<PeriodName, string> = {
  today: t("近 7 天"),
  month: t("本月每日"),
  allTime: t("歷年每月"),
};

function PeriodBars({ view, selection }: { view: TrendsView; selection: Selection }) {
  // 範圍（本星期／最近 7、30 日）維持長期的每月長條，活躍時間與峰值則是那個範圍的（上游 renderTrends）。
  const range = isRange(selection) ? selection : null;
  const r = useFetched(() => (range ? api.rangeGet(range, weekStartDay()) : Promise.resolve(null)), selection);
  const rangeSummary: RangeSummary | null = r?.status === "ready" ? r.summary : null;
  const period: PeriodName = range ? "allTime" : (selection as PeriodName);
  const points = periodSeries(view, period);
  const stats = activityStats(view, period, rangeSummary);
  const max = Math.max(1, ...points.map((p) => p.tokens));
  const cards = [
    { label: t("活躍天數"), value: stats.activeDays.toLocaleString("en-US") },
    { label: t("連續天數"), value: stats.currentStreak.toLocaleString("en-US") },
    { label: t("活躍時間"), value: fmtActiveDuration(stats.activeTimeMs) },
    { label: t("峰值單日"), value: fmtTokens(stats.peakDayTokens) },
  ];
  return (
    <div className="px-3">
      <div className="text-2xs text-fg/45">{RANGE_LABEL[period]}</div>
      {points.length ? (
        <>
          <div className="mt-1 flex h-16 items-end gap-[3px]" role="img" aria-label={RANGE_LABEL[period]}>
            {points.map((p, i) => (
              <div key={p.label} className="flex h-full flex-1 items-end" title={`${shortLabel(p)} · ${fmtTokens(p.tokens)}`}>
                <div
                  className={`w-full rounded-t-[2px] ${i === points.length - 1 ? "bg-accent" : "bg-accent/45"}`}
                  style={{ height: p.tokens > 0 ? `${Math.max(3, (p.tokens / max) * 100)}%` : "1px", opacity: p.tokens > 0 ? 1 : 0.3 }}
                />
              </div>
            ))}
          </div>
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

function emptyText(status: AppStatus | null): string {
  // 還沒掃過 history（第一次掃描要幾秒到幾十秒）時說明在掃；掃過但沒有任何一天才是「尚無」。
  if (status && !status.lastHistoryAt && !status.historyError) return t("掃描使用歷史中...");
  return t("尚無使用歷史");
}

export function TrendsPanel({ period }: { period: Selection }) {
  const enabled = useApp((s) => s.settings?.historyEnabled ?? true);
  const status = useApp((s) => s.status);
  const metric = useApp((s) => s.heatMetric);
  const setMetric = useApp((s) => s.setHeatMetric);
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
  return (
    <>
      <div className="px-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 truncate text-2xs text-fg/45">
            <span className="text-xs text-fg/80">{t("活動")}</span>
            <span className="ml-2">{t("活躍 {count} 天", { count: view.summary.activeDays.toLocaleString("en-US") })}</span>
          </div>
          <Segmented<HeatMetric>
            size="xs"
            value={metric}
            options={[
              { value: "tokens", label: "Tokens" },
              { value: "cost", label: t("成本") },
            ]}
            onChange={setMetric}
          />
        </div>
        <div className="mt-2">
          <Heatmap view={view} metric={metric} />
        </div>
        <TrendLine view={view} />
      </div>
      <div className="mx-3 my-3 border-t border-fg/10" />
      <PeriodBars view={view} selection={period} />
    </>
  );
}
