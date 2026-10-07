import { describe, expect, it } from "vitest";
import type { TrendsView } from "./api";
import {
  activeDaysCount,
  activityStats,
  activityTrend,
  addDays,
  areaChart,
  fmtActiveDuration,
  HOME_TREND_PAD,
  heatmapIntensity,
  periodSeries,
  rollingYearHeatmap,
  shortLabel,
  smoothLinePath,
  statCards,
} from "./trendsFormat";

const day = (date: string, tokens: number, costUsd = tokens / 100, activeTimeMs = 0) => ({ date, tokens, costUsd, activeTimeMs });

function view(): TrendsView {
  return {
    today: "2026-09-24",
    daily: [day("2026-08-30", 100, 1, 60_000), day("2026-09-01", 400, 1), day("2026-09-20", 50, 8, 120_000), day("2026-09-24", 200, 2, 30_000)],
    monthly: [
      { month: "2026-08", tokens: 100, costUsd: 1, activeTimeMs: 60_000 },
      { month: "2026-09", tokens: 650, costUsd: 11, activeTimeMs: 150_000 },
    ],
    summary: {
      totalTokens: 750,
      totalCost: 12,
      activeDays: 4,
      currentStreak: 1,
      longestStreak: 2,
      peakDayTokens: 400,
      favoriteModel: "m",
      messages: 9,
      activeTimeMs: 210_000,
    },
  };
}

describe("trendsFormat", () => {
  it("grades intensity linearly against the maximum", () => {
    expect(heatmapIntensity(0, 0)).toBe(0);
    expect(heatmapIntensity(1, 100)).toBe(1);
    expect(heatmapIntensity(25, 100)).toBe(2);
    expect(heatmapIntensity(50, 100)).toBe(3);
    expect(heatmapIntensity(75, 100)).toBe(4);
  });

  it("lays out a rolling year of Sunday-started weeks", () => {
    const map = rollingYearHeatmap(view().daily, "2026-09-24", "tokens");
    // 2025-10-01 是星期三，網格從前一個星期日（2025-09-28）開始。
    expect(map.cells[0].date).toBe("2025-09-28");
    expect(map.cells[0].row).toBe(0);
    expect(map.cells[map.cells.length - 1].date).toBe("2026-09-24");
    expect(map.monthLabels[0]).toEqual({ col: 0, month: "2025-10" });
    expect(map.monthLabels.map((m) => m.month)).toHaveLength(12);
    const sep1 = map.cells.find((c) => c.date === "2026-09-01")!;
    expect(sep1.level).toBe(4);
    expect(map.cells.find((c) => c.date === "2026-09-20")!.level).toBe(1);
    // 依成本分級時 09-20（成本最高）是 4。
    expect(rollingYearHeatmap(view().daily, "2026-09-24", "cost").cells.find((c) => c.date === "2026-09-20")!.level).toBe(4);
    expect(rollingYearHeatmap([], "bad", "tokens").cells).toEqual([]);
  });

  it("draws smooth area paths", () => {
    expect(smoothLinePath([])).toBe("");
    expect(smoothLinePath([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe("M0,0 L1,1");
    expect(smoothLinePath([{ x: 0, y: 0 }, { x: 6, y: 6 }, { x: 12, y: 0 }])).toBe("M0,0 C1,1 4,6 6,6 C8,6 11,1 12,0");
    const chart = areaChart([{ label: "a", value: 0 }, { label: "b", value: 10 }], 300, 70);
    expect(chart.points[0]).toMatchObject({ x: 6, y: 62 });
    expect(chart.points[1]).toMatchObject({ x: 294, y: 6 });
    expect(chart.area.endsWith("L294,62 L6,62 Z")).toBe(true);
    // 主頁活動的趨勢線 pad 4/3/4/3（上游 renderHomeTrendsModule）。
    const home = areaChart([{ label: "a", value: 0 }, { label: "b", value: 10 }], 300, 70, HOME_TREND_PAD);
    expect(home.points[0]).toMatchObject({ x: 3, y: 66 });
    expect(home.points[1]).toMatchObject({ x: 297, y: 4 });
  });

  it("counts active days for the last 12 months including the Sunday padding", () => {
    const v = view();
    // 2025-10-01 是星期三：熱力圖往前補到 09-28（星期日），那幾天有用量也算。
    v.daily = [day("2025-09-27", 5), day("2025-09-29", 5), day("2026-09-24", 5)];
    v.summary.activeDays = 40;
    const map = rollingYearHeatmap(v.daily, v.today, "tokens");
    expect(activeDaysCount(v, map, "year")).toBe(2);
    expect(activeDaysCount(v, map, "all")).toBe(40);
  });

  it("uses the last 45 rows and the higher peak for the trend line", () => {
    const v = view();
    v.summary.peakDayTokens = 10;
    expect(activityTrend(v).peak).toBe(400);
    expect(activityTrend(v).rows).toHaveLength(4);
  });

  it("builds the period series", () => {
    const v = view();
    const week = periodSeries(v, "today");
    expect(week.map((p) => p.label)).toEqual(["2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"]);
    expect(week.map((p) => p.tokens)).toEqual([0, 0, 50, 0, 0, 0, 200]);
    expect(periodSeries(v, "month").map((p) => p.label)).toEqual(["2026-09-01", "2026-09-20", "2026-09-24"]);
    expect(periodSeries(v, "allTime").map((p) => p.label)).toEqual(["2026-08", "2026-09"]);
    expect(shortLabel({ label: "2026-09-04", kind: "date" })).toBe("9/4");
    expect(shortLabel({ label: "2026-09", kind: "month" })).toBe("2026-09");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("follows the period for active time and peak", () => {
    const v = view();
    expect(activityStats(v, "today")).toEqual({ activeDays: 4, currentStreak: 1, activeTimeMs: 30_000, peakDayTokens: 200 });
    expect(activityStats(v, "month")).toEqual({ activeDays: 4, currentStreak: 1, activeTimeMs: 150_000, peakDayTokens: 400 });
    expect(activityStats(v, "allTime")).toEqual({ activeDays: 4, currentStreak: 1, activeTimeMs: 210_000, peakDayTokens: 400 });
    // 範圍：活躍天數與連續天數仍取 summary，活躍時間與峰值取範圍的摘要。
    expect(activityStats(v, "allTime", { activeDays: 2, currentStreak: 2, activeTimeMs: 5, peakDayTokens: 6 })).toEqual({
      activeDays: 4,
      currentStreak: 1,
      activeTimeMs: 5,
      peakDayTokens: 6,
    });
  });

  it("formats active time", () => {
    expect(fmtActiveDuration(0)).toBe("0m");
    expect(fmtActiveDuration(59_000)).toBe("1m");
    expect(fmtActiveDuration(3_720_000)).toBe("1h 2m");
  });

  it("builds the eight dashboard activity cards in upstream order", () => {
    const cards = statCards(view().summary);
    expect(cards.map((c) => c.key)).toEqual([
      "totalTokens",
      "totalCost",
      "activeDays",
      "currentStreak",
      "activeTimeMs",
      "peakDayTokens",
      "favoriteModel",
      "messages",
    ]);
    expect(cards.find((c) => c.key === "favoriteModel")).toEqual({ key: "favoriteModel", kind: "model", value: "m" });
    expect(cards.find((c) => c.key === "activeTimeMs")?.kind).toBe("duration");
    // 沒有 summary 或欄位壞掉：數字當 0、模型是空字串（畫面顯示「—」）。
    expect(statCards(null).map((c) => c.value)).toEqual([0, 0, 0, 0, 0, 0, "", 0]);
    expect(statCards({ totalTokens: Number.NaN, favoriteModel: "" }).slice(0, 1)[0].value).toBe(0);
  });
});
