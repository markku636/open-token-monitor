// 資料動畫的時間與判斷（純函式，不碰 DOM 也不碰 React；motion.test.ts、motion.compat.test.ts 有測試）。
// 數值逐字照上游 renderer：app.js（總數、清單列、期間長條、主頁熱力圖與趨勢線、額度重置）、
// dashboard.js（每日用量圖、K 線、熱力圖進場）、breakdownRenderPolicy.js（40 列上限）、
// src/electron/motionPreference.js（減少動態效果）與 limitResetMotion.js（額度重置，逐字移植）。
// 真正動 DOM 的是 DataMotion.tsx 與各元件；判斷「現在要不要動」看 motionRuntime.prefersReducedMotion()。

import type { ReduceMotionSetting } from "./api";

export type { ReduceMotionSetting };

const MOTION_VALUES: readonly string[] = ["system", "on", "off"];
const isMotionValue = (v: unknown): v is ReduceMotionSetting => typeof v === "string" && MOTION_VALUES.includes(v);

/**
 * 上游 motionPreference.js `normalize`：去掉前後空白、大小寫要相符（`ON` 不算），其他值回到 `fallback`
 * （本身也不合法時回到 `system`）。
 */
export function normalizeReduceMotion(value: unknown, fallback: unknown = "system"): ReduceMotionSetting {
  const next = String(value || "").trim();
  if (isMotionValue(next)) return next;
  return isMotionValue(fallback) ? fallback : "system";
}

/** 上游 motionPreference.js `shouldReduceMotion`：`on` 一律減少、`off` 一律播放、`system` 看系統的設定。 */
export function shouldReduceMotion(value: unknown, systemReduced: unknown = false): boolean {
  const preference = normalizeReduceMotion(value);
  if (preference === "on") return true;
  if (preference === "off") return false;
  return Boolean(systemReduced);
}

/** 上游資料動畫共用的曲線（app.js、dashboard.js 到處都是這一條）。 */
export const EASE_DATA = "cubic-bezier(0.22, 1, 0.36, 1)";
/** 上游 app.js `LIMIT_RESET_MOTION_EASING`：二次 ease-out 的三次貝茲寫法，長條與百分比文字同步。 */
export const LIMIT_RESET_EASING = "cubic-bezier(0.333, 0.667, 0.667, 1)";

/** 所有時間（毫秒）與幾何常數；右邊是上游出處。 */
export const M = {
  headlineMs: 1000, // app.js render：總數，平常
  headlinePeriodMs: 800, // 切換期間（periodMotionActive）
  rowLiveMs: 600, // renderRows 的即時更新
  rowPeriodMs: 800, // 期間分頁點擊
  rowDefaultMs: 420, // animateRowNumber / animateBreakdownFrom 的預設
  reorderMs: 280, // 排名變動的整列滑動
  enterMs: 240, // 新出現的列淡入上移
  enterStaggerMs: 18,
  enterStaggerCap: 6,
  enterOffsetPx: 7,
  barFromZeroMs: 420, // 換視圖時長條從零長出（applyBarScale）
  maxAnimatedRows: 40, // breakdownRenderPolicy.js MAX_ANIMATED_BREAKDOWN_ROWS
  sparkMs: 420, // animateTrendBarsFrom
  sparkStaggerMs: 14,
  sparkStaggerCap: 14,
  homeHistoryMs: 920, // HOME_HISTORY_MOTION_MS：趨勢線描出
  homeHeatmapMs: 640, // HOME_HEATMAP_MOTION_MS：熱力圖由左到右的總長
  homeHeatCellMs: 240, // HOME_HEAT_CELL_MOTION_MS：每一格淡入
  dashDataMs: 800, // dashboard.js DATA_MOTION_MS
  dashKlineMs: 560, // KLINE_MOTION_MS
  dashHeatmapMs: 720, // HEATMAP_MOTION_MS
  dashHeatCellMs: 280, // HEAT_CELL_MOTION_MS
  dashStaggerMs: 12,
  dashStaggerCap: 18,
  dashKlineStaggerMs: 10,
  limitGlowMs: 700, // LIMIT_RESET_GLOW_MS
  limitGlowLeadMs: 252, // LIMIT_RESET_GLOW_LEAD_MS
  liveDotFlareMs: 1200, // styles.css .live-dot.pulse
  spotlightLerp: 0.32, // setupHomeActivityHover
  spotlightSnap: 0.12,
  spotlightRadius: 82,
  tooltipGap: 9, // moveHomeActivityTooltip
  tooltipPad: 6,
  scrollEndThreshold: 2, // homeActivityScrollRecord
} as const;

/** 上游 app.js `easeOutQuart`（總數與清單數字）。 */
export const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);
/** 上游 `animateLimitResetPercent` 的 `1 − (1 − p)²`。 */
export const easeOutQuad = (t: number) => 1 - (1 - t) * (1 - t);

/**
 * CSS `cubic-bezier()` 的 JavaScript 版：用來算 WAAPI 動畫進行到一半時畫面上的值
 * （換期間時從目前看到的長度接著動）。Newton 法，收斂不了時改二分法，誤差 1e-6。
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return t;
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t = Math.min(1, Math.max(0, t - err / slope));
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 60 && hi - lo > 1e-9; i += 1) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) return t;
      if (x > v) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return sampleY(solve(x));
  };
}

export const easeData = cubicBezier(0.22, 1, 0.36, 1);
export const easeLimitReset = cubicBezier(0.333, 0.667, 0.667, 1);

/** 一段進行中的數值動畫（總數、清單數字、長條的比例），用來算「現在畫面上是多少」。 */
export interface Tween {
  from: number;
  to: number;
  /** performance.now() 的起點。 */
  start: number;
  delay: number;
  duration: number;
  ease: (t: number) => number;
}

/** 某個時間點的值：還在延遲裡是 `from`，結束後是 `to`。 */
export function tweenAt(tw: Tween, now: number): number {
  const elapsed = now - tw.start - tw.delay;
  if (elapsed <= 0) return tw.from;
  if (!(tw.duration > 0) || elapsed >= tw.duration) return tw.to;
  return tw.from + (tw.to - tw.from) * tw.ease(elapsed / tw.duration);
}

/** 動畫在 `now` 時還沒跑完（含延遲）。 */
export const tweenActive = (tw: Tween | null | undefined, now: number): tw is Tween => Boolean(tw) && now < tw!.start + tw!.delay + tw!.duration;

/** 上游 animateBreakdownFrom：新出現的列依序延遲 18 ms，第 7 列之後不再加。 */
export const rowEnterDelay = (i: number) => Math.min(i, M.enterStaggerCap) * M.enterStaggerMs;
/** 上游 animateTrendBarsFrom：從零長出（或新的長條）時依序延遲 14 ms，最多 14 根。 */
export const sparkBarDelay = (i: number, staggered: boolean) => (staggered ? Math.min(i, M.sparkStaggerCap) * M.sparkStaggerMs : 0);

/**
 * 上游 animateTrendBarsFrom 的起始比例：從零長出或沒有上一個高度是 0，否則舊高度 ÷ 新高度
 * （新高度 0 時是 1）；和 1 差不到 0.001 就不動（回 null）。
 */
export function sparkFromScale(prevHeight: number | undefined, targetHeight: number, fromZero: boolean): number | null {
  const from = fromZero || prevHeight === undefined ? 0 : targetHeight > 0 ? prevHeight / targetHeight : 1;
  return Math.abs(from - 1) < 0.001 ? null : from;
}

/** 上游 animateHomeHistoryVisuals：看得到的欄位由左到右，整段 640 ms、每格 240 ms。 */
export function homeHeatDelay(col: number, firstCol: number, lastCol: number): number {
  return (col - firstCol) * ((M.homeHeatmapMs - M.homeHeatCellMs) / Math.max(1, lastCol - firstCol));
}

/** 上游 dashboard.js animateChartGeometry：新的長條依序延遲 12 ms，最多 18 根。 */
export const dashStackDelay = (i: number) => Math.min(i, M.dashStaggerCap) * M.dashStaggerMs;
/** 上游 dashboard.js animateCandles：每根 K 線延遲 10 ms，最多 18 根。 */
export const dashCandleDelay = (i: number) => Math.min(i, M.dashStaggerCap) * M.dashKlineStaggerMs;
/** 上游 dashboard.js animateHeatmapEntry：依格子的 x 在 720 − 280 ms 之間排開（只有一欄時都是 0）。 */
export const dashHeatDelay = (x: number, minX: number, maxX: number) =>
  (maxX > minX ? (x - minX) / (maxX - minX) : 0) * (M.dashHeatmapMs - M.dashHeatCellMs);

function rowCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/** 上游 breakdownRenderPolicy.js `shouldAnimateBreakdownRows`（逐字）：超過 40 列不做 FLIP 與數字動畫。 */
export function shouldAnimateBreakdownRows(count: unknown, options: { reducedMotion?: unknown } = {}): boolean {
  return options.reducedMotion !== true && rowCount(count) <= M.maxAnimatedRows;
}

/** 上游在舊 DOM（拍快照時）與新 DOM（開始動時）各檢查一次列數。 */
export function shouldAnimateRows(prevCount: number, nextCount: number, reduced: boolean): boolean {
  return shouldAnimateBreakdownRows(prevCount, { reducedMotion: reduced }) && shouldAnimateBreakdownRows(nextCount, { reducedMotion: reduced });
}

/**
 * 清單這次要怎麼動（上游 renderRows、期間分頁、月份選單與 renderBreakdownChange 對應到 React 的掛載）：
 * - `initial`：這份清單就在視窗的第一次畫面裡（還沒換過視圖），每一列都是新進場（600 ms）。
 * - `live`：同一份清單資料更新（600 ms）；`period`：同一份清單換期間（800 ms）。
 * - `view`：換了拆分或視圖，長條從零長出（420 ms，不受 40 列限制），數字不動；換過視圖之後才第一次
 *   掛上的清單也是（上游 renderBreakdownChange 設 animateBarsFromZero，renderRows 不拍快照）。
 * - `range`：換成範圍時換了一個元件（上游月份選單），長條從上次的長度過去（420 ms），數字不動。
 * - `none`：減少動態、或超過 40 列；只靠 CSS 的 420 ms 長條過場。
 */
export type ListMotionKind = "initial" | "live" | "period" | "view" | "range" | "none";

export function listMotionKind(i: {
  reduced: boolean;
  surfaceSeen: boolean;
  instanceCommitted: boolean;
  periodChanged: boolean;
  viewChanged: boolean;
  /** 這個視窗換過視圖（motionRuntime.viewChangedInWindow）。 */
  windowViewChanged: boolean;
  prevCount: number;
  nextCount: number;
}): ListMotionKind {
  if (i.reduced) return "none";
  if (!i.instanceCommitted) {
    if (!i.surfaceSeen) {
      // 從主頁（或其他視圖）換過來才第一次掛上：上游 renderBreakdownChange → applyBarScale，不是第一次畫面。
      if (i.windowViewChanged) return "view";
      return shouldAnimateRows(0, i.nextCount, false) ? "initial" : "none";
    }
    return i.periodChanged && !i.viewChanged ? "range" : "view";
  }
  if (i.viewChanged) return "view";
  const animate = shouldAnimateRows(i.prevCount, i.nextCount, false);
  if (i.periodChanged) return animate ? "period" : "none";
  return animate ? "live" : "none";
}

export type HeadlinePlan = { kind: "static" } | { kind: "keep" } | { kind: "tween"; from: number; to: number; duration: number };

/**
 * 總數（上游 app.js render 的 headline 分支）：
 * 1. 減少動態 → 直接顯示。
 * 2. 這個視窗第一次 → 從 0 數上來（上游 currentTotal 起始是 0），1000 ms；是 0 就直接顯示。
 * 3. 泡泡展開重建的新元件 → 直接顯示（上游 suppressInitialNumberAnimation）。
 * 4. 已經在數向同一個值 → 讓它數完（上游 headlineNumberIsAnimatingTo）。
 * 5. 值變了 → 從畫面上的值數過去，換期間 800 ms、否則 1000 ms。
 * 6. 其他 → 直接顯示。
 */
export function headlinePlan(i: {
  reduced: boolean;
  seen: boolean;
  freshMount: boolean;
  suppressed: boolean;
  value: number;
  periodKey: string;
  lastTarget: number;
  lastPeriodKey: string;
  inFlightTo: number | null;
  visual: number;
}): HeadlinePlan {
  if (i.reduced) return { kind: "static" };
  if (!i.seen) return i.value === 0 ? { kind: "static" } : { kind: "tween", from: 0, to: i.value, duration: M.headlineMs };
  if (i.freshMount && i.suppressed) return { kind: "static" };
  if (i.inFlightTo === i.value) return { kind: "keep" };
  if (i.value !== i.lastTarget) {
    return { kind: "tween", from: i.visual, to: i.value, duration: i.periodKey !== i.lastPeriodKey ? M.headlinePeriodMs : M.headlineMs };
  }
  return { kind: "static" };
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 上游 dashboard.js animateChartGeometry 每根堆疊長條的第一個 keyframe：有舊位置就 FLIP
 * （位移與縮放都小於 0.5 px / 1% 時不動，回 null），沒有或要從零長出時從底部 scaleY(0)。
 */
export function stackFlipFirst(prev: Rect | undefined, next: Rect, fromZero: boolean): null | { transformOrigin: string; transform: string; staggered: boolean } {
  if (!fromZero && prev && prev.width > 0 && prev.height > 0 && next.width > 0 && next.height > 0) {
    const sx = prev.width / next.width;
    const sy = prev.height / next.height;
    const dx = prev.left - next.left;
    const dy = prev.top - next.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return null;
    return { transformOrigin: "0 0", transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, staggered: false };
  }
  return { transformOrigin: "center bottom", transform: "scaleY(0)", staggered: true };
}

/** 上游 setupHomeActivityHover 的聚光燈：每幀靠近 32%，兩個方向都差不到 0.12 就貼上。 */
export function spotlightStep(cur: { x: number; y: number }, target: { x: number; y: number }): { x: number; y: number; done: boolean } {
  const dx = target.x - cur.x;
  const dy = target.y - cur.y;
  if (Math.abs(dx) < M.spotlightSnap && Math.abs(dy) < M.spotlightSnap) return { x: target.x, y: target.y, done: true };
  return { x: cur.x + dx * M.spotlightLerp, y: cur.y + dy * M.spotlightLerp, done: false };
}

/**
 * 上游 moveHomeActivityTooltip：提示的中心對齊格子、左右夾在視窗內；上面放得下就放上面，
 * 否則放下面（也夾在視窗內）。回傳 `translate(x, y) translate(-50%, 0)` 的 x、y。
 */
export function placeHeatTooltip(
  cell: { left: number; top: number; bottom: number; width: number },
  tip: { width: number; height: number },
  view: { width: number; height: number },
): { x: number; y: number } {
  const gap = M.tooltipGap;
  const pad = M.tooltipPad;
  const desiredX = cell.left + cell.width / 2;
  const x = Math.max(pad + tip.width / 2, Math.min(view.width - pad - tip.width / 2, desiredX));
  const aboveY = cell.top - tip.height - gap;
  const belowY = cell.bottom + gap;
  const y = aboveY >= pad ? aboveY : Math.min(view.height - pad - tip.height, belowY);
  return { x, y };
}

// ---------------------------------------------------------------------------------------------
// 以下逐字移植上游 src/electron/renderer/limitResetMotion.js（額度重置時長條從用量補回的動畫）。
// 目前還沒有畫面用到：接到額度分頁是另一個步驟（LimitsPanel.tsx 屬於另一個工作）。

/** 上游 `FULL_PERCENT`：剩餘到 99.5% 以上才算補滿。 */
export const LIMIT_FULL_PERCENT = 99.5;

type Loose = Record<string, unknown> | null | undefined;

function clean(value: unknown): string {
  return String(value || "").trim();
}

function normalized(value: unknown): string {
  return clean(value).toLowerCase();
}

/** 上游 `opaqueKey`：FNV-1a 32 位元，輸出 base36；帳號與窗口名稱不會以明文出現在 DOM 上。 */
function opaqueKey(parts: unknown[]): string {
  const input = parts.map(clean).join("\0");
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** 上游 `providerKey`：provider + 帳號（accountKey → webAccountKey → 信箱 → 名稱 → 標籤 → profileId）。 */
export function limitProviderMotionKey(provider: unknown = {}): string {
  const source = (provider || {}) as Record<string, unknown>;
  const identity =
    clean(source.accountKey) ||
    clean(source.webAccountKey) ||
    normalized(source.accountEmail) ||
    clean(source.accountName) ||
    clean(source.accountLabel) ||
    clean(source.profileId) ||
    "default";
  return opaqueKey([normalized(source.provider), identity]);
}

/** 上游 `windowKey`：窗口種類、明確的 id、標籤，以及是不是 additional。 */
export function limitWindowMotionKey(label: string, window: unknown = {}): string {
  const source = (window || {}) as Record<string, unknown>;
  const explicitId = clean(source.limitId) || clean(source.id) || clean(source.quotaId) || clean(source.model) || clean(source.group);
  return opaqueKey([normalized(source.kind), explicitId, normalized(source.label || label), source.additional === true ? "additional" : "canonical"]);
}

function finitePercent(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function resetTime(value: unknown): number | null {
  if (!value) return null;
  const time = new Date(value as string).getTime();
  return Number.isFinite(time) ? time : null;
}

/** 上游 `remainingPercent`：有剩餘 % 用它，否則 100 − 已用 %。 */
export function limitRemainingPercent(window: unknown = {}): number | null {
  const source = (window || {}) as Record<string, unknown>;
  const remaining = finitePercent(source.remainingPercent);
  if (remaining !== null) return remaining;
  const used = finitePercent(source.usedPercent);
  return used === null ? null : 100 - used;
}

/** 上游 `displayPercent`：夾在 0–100。 */
export function limitDisplayPercent(value: unknown): number | null {
  return finitePercent(value);
}

/** 上游 `durationMs`：900 ms 加每 % 7 ms；任一端不明時 1100 ms。 */
export function limitResetDurationMs(fromPercent: unknown, toPercent: unknown = 100): number {
  const from = finitePercent(fromPercent);
  const to = finitePercent(toPercent);
  if (from === null || to === null) return 1100;
  return Math.round(900 + Math.abs(to - from) * 7);
}

/**
 * 上游 `shouldAnimateReset`：之前沒滿、現在滿了才動；兩邊都有重置時間時，新的必須比舊的晚
 * （擋掉剛好補滿的資料修正）。
 */
export function shouldAnimateLimitReset(previous: unknown, current: unknown): boolean {
  const prev = previous as Loose;
  const cur = current as Loose;
  const from = finitePercent(prev?.remainingPercent);
  const to = finitePercent(cur?.remainingPercent);
  if (from === null || to === null || from >= LIMIT_FULL_PERCENT || to < LIMIT_FULL_PERCENT) return false;
  const previousReset = resetTime(prev?.resetsAt);
  const currentReset = resetTime(cur?.resetsAt);
  if (previousReset !== null && currentReset !== null && currentReset <= previousReset) return false;
  return true;
}
