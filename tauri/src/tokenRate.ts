// Token 速率（上游 renderer tokenRatePresentation.js）。
//
// - 平均速率：整個期間的 timedOutputTokens × 1000 / timedDurationMs（tok/s，「速度」）或
//   timedTokens × 60000 / timedDurationMs（tok/min，「消耗」）。時間是 tokscale 回報的每則回覆的
//   生成時間加總，不是牆上時間。
// - 即時速率：每次本機有新的 today，取與上一次的計數差再算一次；任何計數變小（換日、重設）就清掉，
//   時間沒增加就沿用上一個樣本。樣本 8 秒內算「即時」，之後變暗保留到 3 分鐘，再來顯示「—」。

import { fmtTokens } from "./format";

export type RateMode = "speed" | "burn";

const MAX_RATE = 1e12;

export interface Counters {
  timedTokens: number;
  timedOutputTokens: number;
  timedDurationMs: number;
}

const positive = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const capped = (v: number) => Math.min(MAX_RATE, Math.max(0, v));

export function tokenRatePerSecond(c: Partial<Counters>): number {
  const ms = positive(c.timedDurationMs);
  const out = positive(c.timedOutputTokens);
  return ms && out ? capped((out * 1000) / ms) : 0;
}

export function tokenBurnPerMinute(c: Partial<Counters>): number {
  const ms = positive(c.timedDurationMs);
  const tokens = positive(c.timedTokens);
  return ms && tokens ? capped((tokens * 60_000) / ms) : 0;
}

export function rateFor(c: Partial<Counters>, mode: RateMode): number {
  return mode === "burn" ? tokenBurnPerMinute(c) : tokenRatePerSecond(c);
}

/** 平均速率的文字；四捨五入後是 0 就不顯示（上游 `tokenRateText`）。 */
export function averageRateText(c: Partial<Counters> & { throughput?: boolean }, mode: RateMode): string {
  if (c.throughput === false) return "";
  const rate = rateFor(c, mode);
  if (Math.round(rate) <= 0) return "";
  return `≈ ${fmtTokens(rate)} ${mode === "burn" ? "tok/min" : "tok/s"}`;
}

/** 即時速率的數字（上游 `formatLiveTokenRate`）：< 0.1 顯示「<0.1」，< 1 一位小數。 */
export function formatLiveRate(value: number): string {
  const rate = Math.max(0, Number(value) || 0);
  if (rate > 0 && rate < 0.1) return "<0.1";
  if (rate > 0 && rate < 1) return String(Math.round(rate * 10) / 10);
  return fmtTokens(rate);
}

export function liveRateText(value: number, mode: RateMode): string {
  return `${formatLiveRate(value)} ${mode === "burn" ? "TPM" : "tok/s"}`;
}

function counters(p: (Partial<Counters> & { throughput?: boolean }) | null | undefined): Counters | null {
  if (!p || p.throughput === false) return null;
  const vals = [p.timedTokens, p.timedOutputTokens, p.timedDurationMs].map((v) => Number(v));
  if (vals.some((v) => !Number.isFinite(v) || v < 0)) return null;
  return { timedTokens: vals[0], timedOutputTokens: vals[1], timedDurationMs: vals[2] };
}

export interface LiveSample {
  speed: number;
  burn: number;
  sampledAt: number;
}

export interface LiveReading {
  speed: number;
  burn: number;
  /** 超過 8 秒沒有新樣本：數字變暗，3 分鐘後不再顯示。 */
  idle: boolean;
  /** 狀態下次會變（變暗或消失）的時間。 */
  expiresAt: number;
}

export const LIVE_ACTIVE_MS = 8_000;
export const LIVE_CLEAR_MS = 180_000;

/** 單一裝置的即時速率追蹤（上游 `createLiveTokenRateTracker` + group tracker 的顯示規則）。 */
export function createLiveTracker(now: () => number = Date.now) {
  let baseline: Counters | null = null;
  let sample: LiveSample | null = null;

  return {
    /** 新的 today 期間；第一筆只當基準。回傳是否有新樣本。 */
    observe(p: (Partial<Counters> & { throughput?: boolean }) | null | undefined): boolean {
      const current = counters(p);
      if (!current) {
        baseline = null;
        sample = null;
        return false;
      }
      if (!baseline) {
        baseline = current;
        return false;
      }
      const delta: Counters = {
        timedTokens: current.timedTokens - baseline.timedTokens,
        timedOutputTokens: current.timedOutputTokens - baseline.timedOutputTokens,
        timedDurationMs: current.timedDurationMs - baseline.timedDurationMs,
      };
      baseline = current;
      if (delta.timedTokens < 0 || delta.timedOutputTokens < 0 || delta.timedDurationMs < 0) {
        sample = null;
        return false;
      }
      if (!(delta.timedDurationMs > 0)) return false;
      sample = { speed: tokenRatePerSecond(delta), burn: tokenBurnPerMinute(delta), sampledAt: now() };
      return true;
    },
    reading(): LiveReading | null {
      if (!sample) return null;
      const t = now();
      if (t < sample.sampledAt + LIVE_ACTIVE_MS) {
        return { speed: sample.speed, burn: sample.burn, idle: false, expiresAt: sample.sampledAt + LIVE_ACTIVE_MS };
      }
      if (t < sample.sampledAt + LIVE_CLEAR_MS) {
        return { speed: sample.speed, burn: sample.burn, idle: true, expiresAt: sample.sampledAt + LIVE_CLEAR_MS };
      }
      return null;
    },
    reset() {
      baseline = null;
      sample = null;
    },
  };
}
