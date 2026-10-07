import { describe, expect, it } from "vitest";
import type { SeriesDay } from "./api";
import { axisEvery, bucketDaysFor, candleModel, clampDaily, dailyBarsModel, legendRows } from "./dashboardCharts";

const PAD = { top: 0, right: 0, bottom: 0, left: 0 };
const day = (date: string, clients: Record<string, number>): SeriesDay => ({
  date,
  tokens: Object.values(clients).reduce((a, b) => a + b, 0),
  clients,
  models: {},
});

describe("dashboardCharts", () => {
  it("clamps to the last rows and spaces axis labels", () => {
    expect(clampDaily([1, 2, 3, 4], 2)).toEqual([3, 4]);
    expect(clampDaily([1, 2], 0)).toEqual([1, 2]);
    expect(axisEvery(9)).toBe(1);
    expect(axisEvery(30)).toBe(4);
  });

  it("stacks the largest series at the bottom", () => {
    const series = [day("2026-09-01", { a: 10, b: 30 }), day("2026-09-02", { b: 20 })];
    const m = dailyBarsModel(series, "client", 200, 100, PAD, 0);
    expect(m.keys).toEqual(["b", "a"]);
    expect(m.maxTotal).toBe(40);
    const first = m.bars[0];
    expect(first.segments.map((s) => [s.key, s.height])).toEqual([
      ["b", 75],
      ["a", 25],
    ]);
    expect(first.segments[0].y).toBe(25);
    expect(first.segments[1].y).toBe(0);
    expect(m.bars[1].x).toBe(100);
    expect(legendRows(m).map((r) => [r.key, r.value, Math.round(r.pct)])).toEqual([
      ["b", 50, 83],
      ["a", 10, 17],
    ]);
  });

  it("buckets candles back from the latest day", () => {
    const series = ["2026-09-01", "2026-09-02", "2026-09-04", "2026-09-05", "2026-09-06"].map((d, i) => day(d, { a: [5, 9, 1, 4, 7][i] }));
    const { candles } = candleModel(series, 3, 300, 100, PAD, 0);
    // 由 09-06 往回每 3 天：[09-04..09-06]、[09-01..09-02]。
    expect(candles.map((c) => [c.key, c.endKey, c.open, c.high, c.low, c.close, c.up])).toEqual([
      ["2026-09-01", "2026-09-02", 5, 9, 5, 9, true],
      ["2026-09-04", "2026-09-06", 1, 7, 1, 7, true],
    ]);
    expect(candles[0].yHigh).toBe(0);
    expect(bucketDaysFor(series, 600)).toBe(2);
  });
});
