// 趨勢分頁的純函式（trendsFormat.test.ts 有測試）。規則照上游 renderer 的 usageCharts.js
// （`heatmapIntensity`、`contribHeatmap`、`rollingYearHeatmap`、`areaLineChart`、`smoothLinePath`、
// `selectPreviewSeries`、`patchTodayBar`）與 homeOverview.js（`activityStatsForPeriod`、
// `longRangePeakDayTokens`）、app.js `formatActiveDuration`。

import type { PeriodName, RangeSummary, TrendDay, TrendMonth, TrendsView } from "./api";

export type HeatMetric = "tokens" | "cost";

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 日期鍵（YYYY-MM-DD）加減天數，以 UTC 計算避免時區與夏令時間位移。 */
export function addDays(key: string, delta: number): string {
  const d = new Date(`${key.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const dayOfWeekSun = (key: string) => new Date(`${key.slice(0, 10)}T00:00:00Z`).getUTCDay();

/** 相對於最大值的線性分級：≥ 75% → 4、≥ 50% → 3、≥ 25% → 2、> 0 → 1。 */
export function heatmapIntensity(value: number, max: number): number {
  if (!(max > 0)) return 0;
  const ratio = num(value) / max;
  return ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : ratio > 0 ? 1 : 0;
}

export interface HeatCell {
  date: string;
  col: number;
  row: number;
  tokens: number;
  cost: number;
  level: number;
}

export interface Heatmap {
  cells: HeatCell[];
  weeks: number;
  /** 含每月 1 號的那一欄（第一個月貼齊左邊）。 */
  monthLabels: { col: number; month: string }[];
}

/**
 * 滾動一年的熱力圖：從 11 個月前那個月的 1 號（往前推到星期日）到今天，每欄一週、列為週日到週六，
 * 沒有用量的日子也畫（等級 0）。分級相對於傳入的所有日子的最大值，依 `metric`（token 或成本）。
 */
export function rollingYearHeatmap(daily: TrendDay[], endDate: string, metric: HeatMetric): Heatmap {
  const end = endDate.slice(0, 10);
  const e = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(e.getTime())) return { cells: [], weeks: 0, monthLabels: [] };
  const first = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() - 11, 1)).toISOString().slice(0, 10);
  const value = (d: TrendDay) => (metric === "cost" ? num(d.costUsd) : num(d.tokens));
  const max = Math.max(0, ...daily.map(value));
  const byDate = new Map(daily.map((d) => [d.date.slice(0, 10), d]));
  const start = addDays(first, -dayOfWeekSun(first));
  const cells: HeatCell[] = [];
  const monthLabels: Heatmap["monthLabels"] = [];
  let index = 0;
  for (let key = start; key <= end; key = addDays(key, 1), index += 1) {
    const col = Math.floor(index / 7);
    if (key.slice(8, 10) === "01") monthLabels.push({ col, month: key.slice(0, 7) });
    const d = byDate.get(key);
    cells.push({
      date: key,
      col,
      row: dayOfWeekSun(key),
      tokens: d ? num(d.tokens) : 0,
      cost: d ? num(d.costUsd) : 0,
      level: d ? heatmapIntensity(value(d), max) : 0,
    });
  }
  return { cells, weeks: cells.length ? cells[cells.length - 1].col + 1 : 0, monthLabels };
}

export interface ChartPoint {
  x: number;
  y: number;
  value: number;
  label: string;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** 平滑曲線（Catmull-Rom 轉三次貝茲，控制點 ±Δ/6）；少於三點時畫直線。 */
export function smoothLinePath(points: { x: number; y: number }[]): string {
  if (!points.length) return "";
  const straight = () => points.map((p, i) => `${i === 0 ? "M" : "L"}${r2(p.x)},${r2(p.y)}`).join(" ");
  if (points.length < 3) return straight();
  let path = `M${r2(points[0].x)},${r2(points[0].y)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    path += ` C${r2(c1x)},${r2(c1y)} ${r2(c2x)},${r2(c2y)} ${r2(p2.x)},${r2(p2.y)}`;
  }
  return path;
}

/** 面積折線圖（上游 `areaLineChart`，pad 6/6/8/6）。 */
export function areaChart(rows: { label: string; value: number }[], width: number, height: number) {
  const pad = { top: 6, right: 6, bottom: 8, left: 6 };
  const innerW = Math.max(0, width - pad.left - pad.right);
  const innerH = Math.max(0, height - pad.top - pad.bottom);
  const max = Math.max(1, ...rows.map((r) => num(r.value)));
  const points: ChartPoint[] = rows.map((r, i) => ({
    label: r.label,
    value: num(r.value),
    x: pad.left + (rows.length <= 1 ? innerW / 2 : (innerW * i) / (rows.length - 1)),
    y: pad.top + innerH - (innerH * num(r.value)) / max,
  }));
  const baseline = pad.top + innerH;
  const line = smoothLinePath(points);
  const area = points.length
    ? `${line} L${r2(points[points.length - 1].x)},${r2(baseline)} L${r2(points[0].x)},${r2(baseline)} Z`
    : "";
  return { points, line, area };
}

/** 主頁「活動」的趨勢線：最後 45 列（有用量的日子，不補空白）與峰值。 */
export const TREND_ROWS = 45;

export function activityTrend(view: TrendsView): { rows: TrendDay[]; peak: number } {
  const rows = view.daily.slice(-TREND_ROWS);
  const peak = Math.max(0, num(view.summary.peakDayTokens), ...view.daily.map((d) => num(d.tokens)));
  return { rows, peak };
}

export interface SeriesPoint {
  label: string;
  /** `date`（YYYY-MM-DD）或 `month`（YYYY-MM）。 */
  kind: "date" | "month";
  tokens: number;
}

/**
 * 期間的長條：今日 → 以今天結尾的 7 個日曆天（沒用的日子是 0）；本月 → 這個月有用量的日子；
 * 全部 → 每月。
 */
export function periodSeries(view: TrendsView, period: PeriodName): SeriesPoint[] {
  if (period === "allTime") {
    // 上游的長條來自 historyPreview，monthly 只留最後 12 個月。
    return view.monthly.slice(-12).map((m: TrendMonth) => ({ label: m.month, kind: "month", tokens: num(m.tokens) }));
  }
  if (period === "month") {
    const month = view.daily.length ? view.daily[view.daily.length - 1].date.slice(0, 7) : "";
    return view.daily.filter((d) => d.date.slice(0, 7) === month).map((d) => ({ label: d.date, kind: "date", tokens: num(d.tokens) }));
  }
  const byDate = new Map(view.daily.map((d) => [d.date, d]));
  if (!view.daily.length) return [];
  const out: SeriesPoint[] = [];
  for (let offset = -6; offset <= 0; offset += 1) {
    const key = addDays(view.today, offset);
    out.push({ label: key, kind: "date", tokens: num(byDate.get(key)?.tokens) });
  }
  return out;
}

/** 長條與軸上的短標籤：日期 M/D，月份 YYYY-MM。 */
export function shortLabel(p: { label: string; kind: "date" | "month" }): string {
  if (p.kind === "month") return p.label;
  const [, m, d] = p.label.split("-");
  return m && d ? `${Number(m)}/${Number(d)}` : p.label;
}

export interface ActivityStats {
  activeDays: number;
  currentStreak: number;
  activeTimeMs: number;
  peakDayTokens: number;
}

/**
 * 活躍天數與連續天數一律取 history 的 summary；活躍時間與峰值跟著期間，選的是範圍時用那個範圍的
 * 摘要（上游 `activityStatsForPeriod`）。
 */
export function activityStats(view: TrendsView, period: PeriodName, range: RangeSummary | null = null): ActivityStats {
  const base = { activeDays: num(view.summary.activeDays), currentStreak: num(view.summary.currentStreak) };
  if (range) return { ...base, activeTimeMs: num(range.activeTimeMs), peakDayTokens: num(range.peakDayTokens) };
  if (period === "allTime") {
    return { ...base, activeTimeMs: num(view.summary.activeTimeMs), peakDayTokens: num(view.summary.peakDayTokens) };
  }
  const day = view.today.slice(0, 10);
  const month = day.slice(0, 7);
  const selected = view.daily.filter((d) => (period === "today" ? d.date === day : d.date.slice(0, 7) === month));
  return {
    ...base,
    activeTimeMs: selected.reduce((s, d) => s + num(d.activeTimeMs), 0),
    peakDayTokens: selected.reduce((m, d) => Math.max(m, num(d.tokens)), 0),
  };
}

/** 儀表板活動卡的種類（上游 usageCharts.js `STAT_CARDS` 的 kind）。 */
export type StatCardKind = "tokens" | "cost" | "days" | "duration" | "model" | "count";
export type StatCardKey = keyof TrendsView["summary"];
export interface StatCard {
  key: StatCardKey;
  kind: StatCardKind;
  value: number | string;
}

const STAT_CARDS: { key: StatCardKey; kind: StatCardKind }[] = [
  { key: "totalTokens", kind: "tokens" },
  { key: "totalCost", kind: "cost" },
  { key: "activeDays", kind: "days" },
  { key: "currentStreak", kind: "days" },
  { key: "activeTimeMs", kind: "duration" },
  { key: "peakDayTokens", kind: "tokens" },
  { key: "favoriteModel", kind: "model" },
  { key: "messages", kind: "count" },
];

/** 上游 `statsCards`：history summary → 8 張卡，順序固定；模型是字串，其餘是數字（壞值當 0）。 */
export function statCards(summary: Partial<TrendsView["summary"]> | null | undefined): StatCard[] {
  const s: Partial<Record<StatCardKey, unknown>> = summary && typeof summary === "object" ? summary : {};
  return STAT_CARDS.map((c) => ({
    key: c.key,
    kind: c.kind,
    value: c.kind === "model" ? String(s[c.key] || "") : num(s[c.key]),
  }));
}

export function fmtActiveDuration(ms: number): string {
  const total = Math.max(0, Math.round(num(ms) / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "0m";
}
