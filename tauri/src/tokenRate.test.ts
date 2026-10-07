import { describe, expect, it } from "vitest";
import { averageRateText, createLiveTracker, formatLiveRate, liveRateText, tokenBurnPerMinute, tokenRatePerSecond } from "./tokenRate";

describe("tokenRate", () => {
  it("computes speed and burn from timed counters", () => {
    const c = { timedTokens: 120_000, timedOutputTokens: 5_000, timedDurationMs: 100_000 };
    expect(tokenRatePerSecond(c)).toBe(50);
    expect(tokenBurnPerMinute(c)).toBe(72_000);
    expect(tokenRatePerSecond({ timedOutputTokens: 5, timedDurationMs: 0 })).toBe(0);
  });

  it("shows the period average only when it rounds above zero", () => {
    const c = { timedTokens: 120_000, timedOutputTokens: 5_000, timedDurationMs: 100_000 };
    expect(averageRateText(c, "speed")).toBe("≈ 50 tok/s");
    expect(averageRateText(c, "burn")).toBe("≈ 72K tok/min");
    expect(averageRateText({ ...c, timedOutputTokens: 40 }, "speed")).toBe("");
    expect(averageRateText({ ...c, throughput: false }, "speed")).toBe("");
  });

  it("formats live rates", () => {
    expect(formatLiveRate(0.05)).toBe("<0.1");
    expect(formatLiveRate(0.44)).toBe("0.4");
    expect(formatLiveRate(42.4)).toBe("42");
    expect(liveRateText(1500, "burn")).toBe("1.5K TPM");
  });

  it("samples deltas between snapshots and ages them out", () => {
    let now = 0;
    const tracker = createLiveTracker(() => now);
    const snap = (tokens: number, out: number, ms: number) => ({ timedTokens: tokens, timedOutputTokens: out, timedDurationMs: ms });
    expect(tracker.observe(snap(100, 10, 1_000))).toBe(false);
    expect(tracker.reading()).toBeNull();
    now = 1_000;
    expect(tracker.observe(snap(700, 70, 3_000))).toBe(true);
    expect(tracker.reading()).toMatchObject({ speed: 30, burn: 18_000, idle: false });
    // 時間沒增加：沿用上一個樣本。
    expect(tracker.observe(snap(700, 70, 3_000))).toBe(false);
    expect(tracker.reading()?.speed).toBe(30);
    now = 9_500;
    expect(tracker.reading()?.idle).toBe(true);
    now = 181_001;
    expect(tracker.reading()).toBeNull();
    // 計數變小（換日）：清掉，下一筆重新當基準。
    now = 200_000;
    tracker.observe(snap(900, 90, 4_000));
    expect(tracker.observe(snap(10, 1, 100))).toBe(false);
    expect(tracker.reading()).toBeNull();
    expect(tracker.observe({ timedTokens: 1, timedOutputTokens: 1, timedDurationMs: 1, throughput: false })).toBe(false);
  });
});
