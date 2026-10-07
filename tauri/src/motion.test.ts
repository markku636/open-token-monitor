import { describe, expect, it } from "vitest";
import {
  cubicBezier,
  dashCandleDelay,
  dashHeatDelay,
  dashStackDelay,
  easeOutQuad,
  easeOutQuart,
  headlinePlan,
  homeHeatDelay,
  limitDisplayPercent,
  limitProviderMotionKey,
  limitRemainingPercent,
  limitResetDurationMs,
  limitWindowMotionKey,
  listMotionKind,
  normalizeReduceMotion,
  placeHeatTooltip,
  rowEnterDelay,
  shouldAnimateLimitReset,
  shouldAnimateRows,
  shouldReduceMotion,
  sparkBarDelay,
  sparkFromScale,
  spotlightStep,
  stackFlipFirst,
  tweenAt,
} from "./motion";

describe("reduce motion preference (upstream motionPreference.js)", () => {
  it("normalizes like upstream", () => {
    for (const v of ["system", "on", "off"]) expect(normalizeReduceMotion(v)).toBe(v);
    for (const v of ["unknown", "", null, undefined, 0, false]) expect(normalizeReduceMotion(v)).toBe("system");
    expect(normalizeReduceMotion(" on ")).toBe("on");
    expect(normalizeReduceMotion("ON")).toBe("system");
    expect(normalizeReduceMotion("x", "off")).toBe("off");
    expect(normalizeReduceMotion("x", "bogus")).toBe("system");
  });

  it("resolves against the system setting", () => {
    expect(shouldReduceMotion("system", true)).toBe(true);
    expect(shouldReduceMotion("system", false)).toBe(false);
    expect(shouldReduceMotion("on", false)).toBe(true);
    expect(shouldReduceMotion("off", true)).toBe(false);
    expect(shouldReduceMotion("junk", true)).toBe(true);
  });
});

describe("easings", () => {
  it("matches the upstream curves", () => {
    expect(easeOutQuart(0)).toBe(0);
    expect(easeOutQuart(0.5)).toBe(0.9375);
    expect(easeOutQuart(1)).toBe(1);
    expect(easeOutQuad(0.5)).toBe(0.75);
  });

  it("solves cubic-bezier monotonically with exact endpoints", () => {
    const ease = cubicBezier(0.22, 1, 0.36, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    let last = 0;
    for (let p = 0; p <= 1.0001; p += 0.01) {
      const v = ease(p);
      expect(v).toBeGreaterThanOrEqual(last - 1e-9);
      last = v;
    }
  });

  it("keeps the limit bar curve in step with the percent text (quadratic ease-out)", () => {
    const bar = cubicBezier(0.333, 0.667, 0.667, 1);
    for (let i = 0; i <= 20; i += 1) {
      const p = i * 0.05;
      expect(Math.abs(bar(p) - easeOutQuad(p))).toBeLessThan(2e-3);
    }
  });
});

describe("tweenAt", () => {
  const tw = { from: 0, to: 1, start: 100, delay: 50, duration: 200, ease: easeOutQuart };
  it("holds the start value during the delay and the target after the end", () => {
    expect(tweenAt(tw, 120)).toBe(0);
    expect(tweenAt(tw, 250)).toBe(easeOutQuart(0.5));
    expect(tweenAt(tw, 400)).toBe(1);
  });
});

describe("delays", () => {
  it("staggers like upstream", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(rowEnterDelay)).toEqual([0, 18, 36, 54, 72, 90, 108, 108, 108]);
    expect(sparkBarDelay(20, true)).toBe(196);
    expect(sparkBarDelay(5, false)).toBe(0);
    expect(homeHeatDelay(46, 40, 52)).toBe(200);
    // 只有一欄看得到時（first === last），那一欄的格子都沒有延遲。
    expect(homeHeatDelay(3, 3, 3)).toBe(0);
    expect(dashStackDelay(30)).toBe(216);
    expect(dashCandleDelay(30)).toBe(180);
    expect(dashHeatDelay(50, 0, 100)).toBe(220);
    expect(dashHeatDelay(40, 40, 40)).toBe(0);
  });
});

describe("list motion", () => {
  it("caps FLIP and number motion at 40 rows on both sides", () => {
    expect(shouldAnimateRows(40, 40, false)).toBe(true);
    expect(shouldAnimateRows(41, 1, false)).toBe(false);
    expect(shouldAnimateRows(1, 41, false)).toBe(false);
    expect(shouldAnimateRows(1, 1, true)).toBe(false);
  });

  const base = {
    reduced: false,
    surfaceSeen: true,
    instanceCommitted: true,
    periodChanged: false,
    viewChanged: false,
    windowViewChanged: false,
    prevCount: 5,
    nextCount: 5,
  };
  it("maps mounts and changes to the upstream motion kinds", () => {
    expect(listMotionKind({ ...base, reduced: true })).toBe("none");
    expect(listMotionKind({ ...base, reduced: true, surfaceSeen: false, instanceCommitted: false, windowViewChanged: true })).toBe("none");
    // 新元件：視窗的第一次畫面就是這份清單（冷啟動直接在本機視圖）
    expect(listMotionKind({ ...base, surfaceSeen: false, instanceCommitted: false })).toBe("initial");
    expect(listMotionKind({ ...base, surfaceSeen: false, instanceCommitted: false, nextCount: 41 })).toBe("none");
    // 新元件：從主頁換過來才第一次掛上（上游 renderBreakdownChange：長條從零長出，不受 40 列限制）
    expect(listMotionKind({ ...base, surfaceSeen: false, instanceCommitted: false, windowViewChanged: true })).toBe("view");
    expect(listMotionKind({ ...base, surfaceSeen: false, instanceCommitted: false, windowViewChanged: true, nextCount: 90 })).toBe("view");
    expect(listMotionKind({ ...base, instanceCommitted: false, periodChanged: true, windowViewChanged: true })).toBe("range");
    expect(listMotionKind({ ...base, instanceCommitted: false, periodChanged: true })).toBe("range");
    expect(listMotionKind({ ...base, instanceCommitted: false, periodChanged: true, viewChanged: true })).toBe("view");
    expect(listMotionKind({ ...base, instanceCommitted: false })).toBe("view");
    // 同一個元件
    expect(listMotionKind({ ...base, viewChanged: true, nextCount: 90 })).toBe("view");
    expect(listMotionKind({ ...base, periodChanged: true })).toBe("period");
    expect(listMotionKind({ ...base, periodChanged: true, prevCount: 41 })).toBe("none");
    expect(listMotionKind(base)).toBe("live");
    expect(listMotionKind({ ...base, nextCount: 41 })).toBe("none");
    // 換過視圖不影響同一個元件的資料更新
    expect(listMotionKind({ ...base, windowViewChanged: true })).toBe("live");
  });
});

describe("headline", () => {
  const base = { reduced: false, seen: true, freshMount: false, suppressed: false, value: 500, periodKey: "today", lastTarget: 100, lastPeriodKey: "today", inFlightTo: null, visual: 100 };
  it("counts up from zero the first time", () => {
    expect(headlinePlan({ ...base, seen: false })).toEqual({ kind: "tween", from: 0, to: 500, duration: 1000 });
    expect(headlinePlan({ ...base, seen: false, value: 0 })).toEqual({ kind: "static" });
  });

  it("follows the upstream render decision", () => {
    expect(headlinePlan({ ...base, freshMount: true, suppressed: true })).toEqual({ kind: "static" });
    expect(headlinePlan({ ...base, inFlightTo: 500, visual: 300 })).toEqual({ kind: "keep" });
    expect(headlinePlan({ ...base, periodKey: "month", visual: 250 })).toEqual({ kind: "tween", from: 250, to: 500, duration: 800 });
    expect(headlinePlan({ ...base, inFlightTo: 200, visual: 150 })).toEqual({ kind: "tween", from: 150, to: 500, duration: 1000 });
    expect(headlinePlan({ ...base, lastTarget: 500 })).toEqual({ kind: "static" });
    expect(headlinePlan({ ...base, reduced: true })).toEqual({ kind: "static" });
  });
});

describe("dashboard stacked bars", () => {
  const rect = { left: 10, top: 20, width: 8, height: 40 };
  it("uses FLIP from the previous geometry or grows from the bottom", () => {
    expect(stackFlipFirst(rect, rect, false)).toBeNull();
    expect(stackFlipFirst({ ...rect, left: 20 }, rect, false)).toEqual({ transformOrigin: "0 0", transform: "translate(10px, 0px) scale(1, 1)", staggered: false });
    expect(stackFlipFirst(undefined, rect, false)).toEqual({ transformOrigin: "center bottom", transform: "scaleY(0)", staggered: true });
    expect(stackFlipFirst({ ...rect, left: 20 }, rect, true)).toEqual({ transformOrigin: "center bottom", transform: "scaleY(0)", staggered: true });
  });
});

describe("period bars", () => {
  it("scales from the previous height", () => {
    expect(sparkFromScale(20, 40, false)).toBe(0.5);
    expect(sparkFromScale(undefined, 40, false)).toBe(0);
    expect(sparkFromScale(20, 40, true)).toBe(0);
    expect(sparkFromScale(40, 40, false)).toBeNull();
    expect(sparkFromScale(20, 0, false)).toBeNull();
  });
});

describe("heatmap hover", () => {
  it("eases the spotlight and snaps when close", () => {
    expect(spotlightStep({ x: 0, y: 0 }, { x: 10, y: 0 })).toEqual({ x: 3.2, y: 0, done: false });
    expect(spotlightStep({ x: 0, y: 0 }, { x: 0.1, y: -0.1 })).toEqual({ x: 0.1, y: -0.1, done: true });
  });

  const view = { width: 340, height: 600 };
  const tip = { width: 80, height: 30 };
  it("places the tooltip above the cell when there is room, otherwise below", () => {
    expect(placeHeatTooltip({ left: 100, top: 200, bottom: 209, width: 9 }, tip, view)).toEqual({ x: 104.5, y: 161 });
    expect(placeHeatTooltip({ left: 100, top: 30, bottom: 39, width: 9 }, tip, view)).toEqual({ x: 104.5, y: 48 });
    expect(placeHeatTooltip({ left: 0, top: 200, bottom: 209, width: 9 }, tip, view).x).toBe(46);
    expect(placeHeatTooltip({ left: 335, top: 200, bottom: 209, width: 9 }, tip, view).x).toBe(294);
    expect(placeHeatTooltip({ left: 100, top: 20, bottom: 590, width: 9 }, tip, view).y).toBe(564);
  });
});

describe("limit reset motion (upstream limitResetMotion.js)", () => {
  it("animates only an existing non-full value reaching full", () => {
    expect(shouldAnimateLimitReset({ remainingPercent: 0 }, { remainingPercent: 100 })).toBe(true);
    expect(shouldAnimateLimitReset({ remainingPercent: 69 }, { remainingPercent: 100 })).toBe(true);
    expect(shouldAnimateLimitReset(null, { remainingPercent: 100 })).toBe(false);
    expect(shouldAnimateLimitReset({ remainingPercent: 70 }, { remainingPercent: 85 })).toBe(false);
    expect(shouldAnimateLimitReset({ remainingPercent: 100 }, { remainingPercent: 100 })).toBe(false);
  });

  it("derives remaining and clamps display percentages", () => {
    expect(limitRemainingPercent(null)).toBeNull();
    expect(limitRemainingPercent({ remainingPercent: null })).toBeNull();
    expect(limitRemainingPercent({ usedPercent: 100 })).toBe(0);
    expect(limitRemainingPercent({ usedPercent: 31 })).toBe(69);
    expect(limitRemainingPercent({ remainingPercent: 42, usedPercent: 58 })).toBe(42);
    expect(limitDisplayPercent(-1)).toBe(0);
    expect(limitDisplayPercent(101)).toBe(100);
    expect(limitDisplayPercent(42.5)).toBe(42.5);
    expect(limitDisplayPercent(null)).toBeNull();
  });

  it("scales the refill duration with the distance", () => {
    expect(limitResetDurationMs(0, 100)).toBe(1600);
    expect(limitResetDurationMs(69, 100)).toBe(1117);
    expect(limitResetDurationMs(null, 100)).toBe(1100);
  });

  it("requires the reset boundary to advance", () => {
    const first = "2026-09-09T01:00:00.000Z";
    const next = "2026-09-09T06:00:00.000Z";
    expect(shouldAnimateLimitReset({ remainingPercent: 14, resetsAt: first }, { remainingPercent: 100, resetsAt: next })).toBe(true);
    expect(shouldAnimateLimitReset({ remainingPercent: 14, resetsAt: first }, { remainingPercent: 100, resetsAt: first })).toBe(false);
    expect(shouldAnimateLimitReset({ remainingPercent: 14, resetsAt: next }, { remainingPercent: 100, resetsAt: first })).toBe(false);
    expect(
      shouldAnimateLimitReset({ remainingPercent: limitRemainingPercent({ usedPercent: 86 }) }, { remainingPercent: limitRemainingPercent({ usedPercent: 0 }) }),
    ).toBe(true);
  });

  it("keeps account and window identity without exposing labels", () => {
    expect(limitProviderMotionKey(null)).toBe(limitProviderMotionKey());
    expect(limitWindowMotionKey("Weekly", null)).toBe(limitWindowMotionKey("Weekly"));
    const first = limitProviderMotionKey({ provider: "codex", accountEmail: "first@example.com" });
    const second = limitProviderMotionKey({ provider: "codex", accountEmail: "second@example.com" });
    expect(first).not.toBe(second);
    expect(first).not.toMatch(/first|example/);
    expect(limitWindowMotionKey("Session", { kind: "session" })).not.toBe(limitWindowMotionKey("Weekly", { kind: "weekly" }));
  });
});
