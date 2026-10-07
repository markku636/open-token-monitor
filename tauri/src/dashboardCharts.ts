// 儀表板「趨勢」圖的幾何（上游 renderer/usageCharts.js `dailyBarsChart`、`candleChart`、`clampDaily`，
// dashboard.js `renderTrends` 的 bucket 規則）。純函式，dashboardCharts.test.ts 有測試。

import type { SeriesDay } from "./api";

export interface Pad {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const CHART_PAD: Pad = { top: 10, right: 14, bottom: 24, left: 52 };

const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** 上游 `clampDaily`：取最後 N 列（有用量的日子，不補空白）；0 = 全部。 */
export function clampDaily<T>(daily: T[], range: number): T[] {
  return range > 0 ? daily.slice(-range) : daily;
}

/** 軸上每幾個標一次，最多約 9 個標籤。 */
export function axisEvery(count: number): number {
  return Math.max(1, Math.ceil(count / 9));
}

export interface Segment {
  key: string;
  value: number;
  y: number;
  height: number;
}

export interface Bar {
  label: string;
  x: number;
  width: number;
  total: number;
  segments: Segment[];
}

export interface BarsModel {
  keys: string[];
  bars: Bar[];
  maxTotal: number;
  plot: { x: number; y: number; w: number; h: number };
}

/** 堆疊的每日長條：key 依整段期間的總量排序（大的在下），每根長條的高度相對於最高的那天。 */
export function dailyBarsModel(
  series: SeriesDay[],
  stackBy: "client" | "model",
  width: number,
  height: number,
  pad: Pad = CHART_PAD,
  gap = 0.3,
): BarsModel {
  const field = (d: SeriesDay) => (stackBy === "model" ? d.models : d.clients);
  const keyTotals: Record<string, number> = {};
  for (const d of series) for (const [k, v] of Object.entries(field(d))) keyTotals[k] = (keyTotals[k] ?? 0) + n(v);
  const keys = Object.keys(keyTotals).sort((a, b) => keyTotals[b] - keyTotals[a] || a.localeCompare(b));
  const totals = series.map((d) => Object.values(field(d)).reduce((s, v) => s + n(v), 0));
  const maxTotal = Math.max(1, ...totals);
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const slot = series.length ? w / series.length : w;
  const barWidth = slot * (1 - gap);
  const bars = series.map((d, i) => {
    const x = pad.left + i * slot + (slot - barWidth) / 2;
    const source = field(d);
    let cum = 0;
    const segments: Segment[] = [];
    for (const k of keys) {
      if (source[k] === undefined) continue;
      const value = n(source[k]);
      const sh = (h * value) / maxTotal;
      cum += sh;
      segments.push({ key: k, value, y: pad.top + h - cum, height: sh });
    }
    return { label: d.date, x, width: barWidth, total: totals[i], segments };
  });
  return { keys, bars, maxTotal, plot: { x: pad.left, y: pad.top, w, h } };
}

export interface Candle {
  key: string;
  endKey: string;
  days: number;
  open: number;
  high: number;
  low: number;
  close: number;
  up: boolean;
  x: number;
  width: number;
  wickX: number;
  yHigh: number;
  yLow: number;
  bodyY: number;
  bodyHeight: number;
}

const dayMs = (key: string) => Date.parse(`${key.slice(0, 10)}T00:00:00Z`);
const daysBetween = (a: string, b: string) => Math.round((dayMs(b) - dayMs(a)) / 86_400_000);

/** 上游 dashboard.js：跨度 ≤ 10 天每根 2 天，否則讓 K 棒約 24 px 寬、至少 3 天。 */
export function bucketDaysFor(series: SeriesDay[], plotWidth: number): number {
  if (!series.length) return 1;
  const span = daysBetween(series[0].date, series[series.length - 1].date) + 1;
  const target = Math.max(8, Math.round(plotWidth / 24));
  return span <= 10 ? 2 : Math.max(3, Math.round(span / target));
}

/**
 * 上游 `candleChart`：每根 K 棒是連續 `bucketDays` 個日曆天（從最新的一天往回分組），
 * 開 = 第一天、收 = 最後一天、高／低 = 最忙／最閒的一天。
 */
export function candleModel(
  series: SeriesDay[],
  bucketDays: number,
  width: number,
  height: number,
  pad: Pad = CHART_PAD,
  gap = 0.4,
): { candles: Candle[]; maxVal: number; plot: { x: number; y: number; w: number; h: number } } {
  const days = series.map((d) => ({ date: d.date.slice(0, 10), value: n(d.tokens) })).sort((a, b) => a.date.localeCompare(b.date));
  const size = Math.max(1, Math.round(bucketDays));
  const groups = new Map<number, { date: string; value: number }[]>();
  if (days.length) {
    const last = days[days.length - 1].date;
    for (const d of days) {
      const idx = Math.floor(daysBetween(d.date, last) / size);
      groups.set(idx, [...(groups.get(idx) ?? []), d]);
    }
  }
  const base = [...groups.keys()]
    .sort((a, b) => b - a)
    .map((idx) => {
      const ds = groups.get(idx)!;
      const values = ds.map((d) => d.value);
      return {
        key: ds[0].date,
        endKey: ds[ds.length - 1].date,
        days: ds.length,
        open: ds[0].value,
        close: ds[ds.length - 1].value,
        high: Math.max(...values),
        low: Math.min(...values),
        up: ds[ds.length - 1].value >= ds[0].value,
      };
    });
  const maxVal = Math.max(1, ...base.map((c) => c.high));
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const slot = base.length ? w / base.length : w;
  const bodyW = slot * (1 - gap);
  const yOf = (v: number) => pad.top + h - (h * v) / maxVal;
  const candles = base.map((c, i) => {
    const x = pad.left + i * slot + (slot - bodyW) / 2;
    const bodyY = yOf(Math.max(c.open, c.close));
    return {
      ...c,
      x,
      width: bodyW,
      wickX: x + bodyW / 2,
      yHigh: yOf(c.high),
      yLow: yOf(c.low),
      bodyY,
      bodyHeight: Math.max(1, yOf(Math.min(c.open, c.close)) - bodyY),
    };
  });
  return { candles, maxVal, plot: { x: pad.left, y: pad.top, w, h } };
}

/** 圖例：各 key 在整段期間的總量與占比（一位小數），依大到小。 */
export function legendRows(model: BarsModel): { key: string; value: number; pct: number }[] {
  const totals: Record<string, number> = {};
  for (const bar of model.bars) for (const s of bar.segments) totals[s.key] = (totals[s.key] ?? 0) + s.value;
  const grand = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  return model.keys
    .map((key) => ({ key, value: totals[key] ?? 0, pct: ((totals[key] ?? 0) / grand) * 100 }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
}
