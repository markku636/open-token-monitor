// 期間選擇：tokscale 的今日／本月／全部，加上由每日歷史推出的本星期／最近 7 日／最近 30 日
// （上游 renderer fixedPeriodRanges.js）。中間那格顯示「本月」或選中的範圍。

import type { PeriodName, RangeName, Selection } from "./api";
import { t } from "./i18n";

export const RANGES: readonly RangeName[] = ["week", "last7", "last30"];

/** 中間那格的模式（上游 `periodMonthMode`）。 */
export type MonthMode = "month" | RangeName;
export const MONTH_MODES: readonly MonthMode[] = ["month", "week", "last7", "last30"];

export function isRange(s: Selection | string | null | undefined): s is RangeName {
  return (RANGES as readonly string[]).includes(String(s));
}

export function isSelection(s: unknown): s is Selection {
  return s === "today" || s === "month" || s === "allTime" || isRange(s as string);
}

/** 這個選擇落在哪一格（今日、中間、全部）。 */
export function slotOf(s: Selection): PeriodName {
  return s === "today" || s === "allTime" ? s : "month";
}

export function monthModeLabel(m: MonthMode): string {
  switch (m) {
    case "week":
      return t("本星期");
    case "last7":
      return t("最近 7 日");
    case "last30":
      return t("最近 30 日");
    default:
      return t("本月");
  }
}

/**
 * 一週從星期幾開始（0 = 星期日）：依系統的地區設定（`navigator.languages[0]`，不是介面語言），
 * 取不到時用星期一（上游 `weekStartsOn`）。
 */
export function weekStartDay(locale: string | undefined = typeof navigator !== "undefined" ? navigator.languages?.[0] : undefined): number {
  try {
    const l = new Intl.Locale(String(locale || "en")) as Intl.Locale & {
      getWeekInfo?: () => { firstDay?: number };
      weekInfo?: { firstDay?: number };
    };
    const first = Number((typeof l.getWeekInfo === "function" ? l.getWeekInfo() : l.weekInfo)?.firstDay);
    if (Number.isInteger(first) && first >= 1 && first <= 7) return first % 7;
  } catch {
    /* 退回星期一 */
  }
  return 1;
}

/** `2026-09-18` → `9/18`。 */
export function shortDate(key: string): string {
  const [, m, d] = key.split("-");
  return m && d ? `${Number(m)}/${Number(d)}` : key;
}
