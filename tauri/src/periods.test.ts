import { describe, expect, it } from "vitest";
import { isRange, isSelection, shortDate, slotOf, weekStartDay } from "./periods";

describe("periods", () => {
  it("tells ranges from native periods", () => {
    expect(isRange("week")).toBe(true);
    expect(isRange("last30")).toBe(true);
    expect(isRange("month")).toBe(false);
    expect(isSelection("allTime")).toBe(true);
    expect(isSelection("last7")).toBe(true);
    expect(isSelection("yesterday")).toBe(false);
    expect(slotOf("last7")).toBe("month");
    expect(slotOf("today")).toBe("today");
  });

  it("picks the week start from the regional locale", () => {
    const hasWeekInfo = (() => {
      const l = new Intl.Locale("en-US") as Intl.Locale & { getWeekInfo?: unknown; weekInfo?: unknown };
      return typeof l.getWeekInfo === "function" || l.weekInfo !== undefined;
    })();
    if (hasWeekInfo) {
      expect(weekStartDay("en-US")).toBe(0);
      expect(weekStartDay("de-DE")).toBe(1);
    }
    expect(weekStartDay("not a locale!!")).toBe(1);
  });

  it("formats short dates", () => {
    expect(shortDate("2026-09-08")).toBe("9/8");
    expect(shortDate("x")).toBe("x");
  });
});
