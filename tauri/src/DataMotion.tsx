// 資料動畫的 React 元件與 hook：總數的數字動畫（AnimatedNumber）與清單的列動畫（useListMotion）。
// 對應上游 app.js 的 `animateNumber` / `animateTotalNumber`、`captureBreakdownMotion` /
// `animateBreakdownFrom` / `animateRowNumber` / `animateBarBetween` / `applyBarScale`，
// 與 dashboard.js `renderBreakdown` 的長條動畫。時間與判斷在 motion.ts。
//
// 規則：動畫中的文字與長條比例（`--bar-scale`）一律在 useLayoutEffect 裡直接寫 DOM，那些節點不放
// React 子節點、React 也不設 `--bar-scale`，所以重繪不會蓋掉進行中的動畫。每一個元件都可能在
// StrictMode 下被掛上兩次，記憶放在模組層級（依 surface），同一份資料重跑時只接續、不重播。

import { useLayoutEffect, useRef, type RefObject } from "react";
import { EASE_DATA, easeData, easeOutQuart, headlinePlan, listMotionKind, M, rowEnterDelay, tweenActive, tweenAt, type Tween } from "./motion";
import { flareLiveDot, onSettle, prefersReducedMotion, takeHeadlineSuppression, viewChangedInWindow } from "./motionRuntime";

const now = () => performance.now();

// ---- 長條 -------------------------------------------------------------------------------------

interface BarMotion {
  anim: Animation;
  tween: Tween;
}

const barMotions = new WeakMap<HTMLElement, BarMotion>();

function setBarScale(fill: HTMLElement, scale: number) {
  fill.style.setProperty("--bar-scale", String(scale));
}

/** 停掉這條長條自己的 JS 動畫，交回 CSS 的 420 ms 過場。 */
function stopBar(fill: HTMLElement) {
  if (!barMotions.has(fill)) return;
  barMotions.delete(fill);
  for (const a of fill.getAnimations?.() ?? []) a.cancel();
  fill.style.transition = "";
}

/** 畫面上這條長條現在的比例（含進行中的動畫與 CSS 過場；上游 captureBreakdownMotion 同樣量 DOM）。 */
function measureScale(fill: HTMLElement): number | null {
  const track = fill.parentElement?.getBoundingClientRect().width ?? 0;
  if (!(track > 0)) return null;
  return Math.max(0, Math.min(1, fill.getBoundingClientRect().width / track));
}

/**
 * 上游 `animateBarBetween`：已經有動畫在往（差不到 0.001 的）同一個比例走就讓它走完；否則取消這條
 * 長條上所有動畫，從 `from` 縮放到 `to`。`--bar-scale` 先寫成目標值（動畫結束後停在那裡），JS 動的
 * 期間關掉 CSS 過場，結束或取消時還原（兩者同時動時 Chromium 的結果沒有定義）。回傳這段動畫。
 */
export function animateBar(
  fill: HTMLElement,
  from: number,
  to: number,
  delay = 0,
  duration: number = M.barFromZeroMs,
  easing: string = EASE_DATA,
  ease: (t: number) => number = easeData,
): Tween | null {
  const active = barMotions.get(fill);
  if (active && (active.anim.pending || active.anim.playState === "running") && Math.abs(active.tween.to - to) < 0.001) {
    setBarScale(fill, to);
    return active.tween;
  }
  stopBar(fill);
  for (const a of fill.getAnimations?.() ?? []) a.cancel();
  if (Math.abs(to - from) < 0.001 || prefersReducedMotion() || typeof fill.animate !== "function") {
    setBarScale(fill, to);
    return null;
  }
  fill.style.transition = "none";
  setBarScale(fill, to);
  const anim = fill.animate([{ transform: `scaleX(${from})` }, { transform: `scaleX(${to})` }], { duration, delay, easing, fill: "backwards" });
  const motion: BarMotion = { anim, tween: { from, to, start: now(), delay, duration, ease } };
  const forget = () => {
    if (barMotions.get(fill) !== motion) return;
    barMotions.delete(fill);
    fill.style.transition = "";
  };
  anim.onfinish = forget;
  anim.oncancel = forget;
  barMotions.set(fill, motion);
  return motion.tween;
}

// ---- 總數 -------------------------------------------------------------------------------------

interface HeadlineMemory {
  seen: boolean;
  lastTarget: number;
  lastPeriodKey: string;
  tween: Tween | null;
  raf: number;
  el: HTMLElement | null;
  format: (n: number) => string;
}

const headlines = new Map<string, HeadlineMemory>();

function headlineMemory(surface: string): HeadlineMemory {
  let mem = headlines.get(surface);
  if (!mem) {
    mem = { seen: false, lastTarget: 0, lastPeriodKey: "", tween: null, raf: 0, el: null, format: String };
    headlines.set(surface, mem);
  }
  return mem;
}

function runHeadline(mem: HeadlineMemory) {
  if (mem.raf || !mem.tween) return;
  const frame = (time: number) => {
    mem.raf = 0;
    const tw = mem.tween;
    if (!tw) return;
    // 上游每一幀都重新檢查減少動態：中途切成減少就直接跳到目標值。
    const done = prefersReducedMotion() || time >= tw.start + tw.delay + tw.duration;
    if (mem.el) mem.el.textContent = mem.format(done ? tw.to : tweenAt(tw, time));
    if (done) {
      mem.tween = null;
      return;
    }
    mem.raf = requestAnimationFrame(frame);
  };
  mem.raf = requestAnimationFrame(frame);
}

/**
 * 總數：值變了就從畫面上的值數過去（easeOutQuart，1 秒；換期間 0.8 秒），視窗第一次從 0 數上來。
 * 同一個 `surface`（本機總數、全公司總數）在視圖之間共用記憶，換視圖但數字沒變時不重數
 * （上游整個視窗只有一個總數元素）。
 */
export function AnimatedNumber({
  surface,
  value,
  periodKey,
  format,
  className,
  title,
}: {
  surface: string;
  value: number;
  periodKey: string;
  format: (n: number) => string;
  className?: string;
  title?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const committed = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mem = headlineMemory(surface);
    mem.el = el;
    mem.format = format;
    const time = now();
    const fresh = !committed.current;
    committed.current = true;
    const inFlight = tweenActive(mem.tween, time) ? mem.tween : null;
    const wasSeen = mem.seen;
    const plan = headlinePlan({
      reduced: prefersReducedMotion(),
      seen: mem.seen,
      freshMount: fresh,
      suppressed: fresh && takeHeadlineSuppression(),
      value,
      periodKey,
      lastTarget: mem.lastTarget,
      lastPeriodKey: mem.lastPeriodKey,
      inFlightTo: inFlight ? inFlight.to : null,
      visual: inFlight ? tweenAt(inFlight, time) : mem.lastTarget,
    });
    if (plan.kind === "tween") {
      if (mem.raf) cancelAnimationFrame(mem.raf);
      mem.raf = 0;
      mem.tween = { from: plan.from, to: plan.to, start: time, delay: 0, duration: plan.duration, ease: easeOutQuart };
      el.textContent = format(plan.from);
      runHeadline(mem);
      // 上游 pulseLiveDot：值變了開始數時閃一下即時點（第一次從 0 數上來不算）。
      if (wasSeen) flareLiveDot();
    } else if (plan.kind === "keep" && inFlight) {
      // 換了元件（例如從主頁到本機視圖）或 StrictMode 重跑：接著原本的動畫數到底。
      el.textContent = format(tweenAt(inFlight, time));
      runHeadline(mem);
    } else {
      if (mem.raf) cancelAnimationFrame(mem.raf);
      mem.raf = 0;
      mem.tween = null;
      el.textContent = format(value);
    }
    mem.seen = true;
    mem.lastTarget = value;
    mem.lastPeriodKey = periodKey;
  }, [surface, value, periodKey, format]);
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      const mem = headlines.get(surface);
      if (!mem || mem.el !== el) return;
      // 記憶留著（下一個掛上的總數從畫面上的值接著動），只停掉這個元素的 rAF。
      mem.el = null;
      if (mem.raf) cancelAnimationFrame(mem.raf);
      mem.raf = 0;
    };
  }, [surface]);
  return <span ref={ref} className={className} title={title} />;
}

// ---- 清單 -------------------------------------------------------------------------------------

/** 一列的動畫資料：`value` 是 token 數，`scale` 是長條比例（0–1）。 */
export interface MotionRow {
  key: string;
  value: number;
  scale: number;
}

/**
 * 清單的動畫身分。`surface` 是同一個位置的清單（本機、全公司、儀表板的工具／模型），跨元件共用記憶；
 * `periodKey` 是清單資料所屬的期間或範圍，`viewKey` 是拆分（工具／模型／專案／session）。
 */
export interface ListMotion {
  surface: string;
  periodKey: string;
  viewKey: string;
}

interface RowNodes {
  li: HTMLElement;
  fill: HTMLElement | null;
  num: HTMLElement | null;
}

interface RowMemory {
  value: number;
  valueTween: Tween | null;
  scale: number;
  scaleTween: Tween | null;
  top: number;
}

interface SurfaceMemory {
  seen: boolean;
  periodKey: string;
  viewKey: string;
  rows: Map<string, RowMemory>;
  nodes: Map<string, RowNodes>;
  format: (n: number) => string;
  raf: number;
}

const surfaces = new Map<string, SurfaceMemory>();

function surfaceMemory(surface: string): SurfaceMemory {
  let mem = surfaces.get(surface);
  if (!mem) {
    mem = { seen: false, periodKey: "", viewKey: "", rows: new Map(), nodes: new Map(), format: String, raf: 0 };
    surfaces.set(surface, mem);
  }
  return mem;
}

/** 清單的每一列：`<li data-motion-key>` 下的長條 `.tm-bar-fill` 與 token 數字 `[data-motion-number]`。 */
function collectNodes(list: HTMLElement): Map<string, RowNodes> {
  const nodes = new Map<string, RowNodes>();
  for (const li of Array.from(list.children) as HTMLElement[]) {
    const key = li.dataset?.motionKey;
    if (key === undefined) continue;
    nodes.set(key, { li, fill: li.querySelector<HTMLElement>(".tm-bar-fill"), num: li.querySelector<HTMLElement>("[data-motion-number]") });
  }
  return nodes;
}

function writeNumber(el: HTMLElement | null, text: string) {
  if (el && el.textContent !== text) el.textContent = text;
}

/**
 * React 剛建立、還沒寫過比例的長條先寫上目標比例；要在第一次量版面（offsetTop、getBoundingClientRect）
 * 之前做。量版面會替新節點算出第一份樣式，那時沒有 `--bar-scale` 就是 scaleX(0)，之後才寫比例會觸發
 * CSS 的 420 ms 過場、變成從零長出（`none`、`range` 的新列不該動）。上游 updateRow 在 replaceChildren
 * 之後、量版面之前就寫 `--bar-scale`，新的列第一次畫出來就是最後的長度；要從零長出的由 WAAPI 負責。
 */
export function primeNewBars(nodes: Map<string, { fill: HTMLElement | null }>, rows: MotionRow[]) {
  for (const row of rows) {
    const fill = nodes.get(row.key)?.fill;
    if (fill && fill.style.getPropertyValue("--bar-scale") === "") setBarScale(fill, row.scale);
  }
}

/** 靜態寫上文字與長條（沒有動畫的清單、或這一列沒有在動）。 */
function writeStatic(node: RowNodes, row: MotionRow, format: (n: number) => string) {
  writeNumber(node.num, format(row.value));
  if (node.fill && !barMotions.has(node.fill) && node.fill.style.getPropertyValue("--bar-scale") !== String(row.scale)) setBarScale(node.fill, row.scale);
}

/** 上游 `animateRowNumber`：同一個目標的動畫在跑就保留；否則從畫面上的值（沒有時 `from`）數到 `to`。 */
function planNumber(prev: RowMemory | undefined, from: number, to: number, duration: number, time: number): Tween | null {
  const live = prev && tweenActive(prev.valueTween, time) ? prev.valueTween : null;
  if (live && live.to === to) return live;
  const start = live ? tweenAt(live, time) : from;
  if (!Number.isFinite(start) || !Number.isFinite(to) || start === to || prefersReducedMotion()) return null;
  return { from: start, to, start: time, delay: 0, duration, ease: easeOutQuart };
}

function visualValue(prev: RowMemory, time: number): number {
  return tweenActive(prev.valueTween, time) ? tweenAt(prev.valueTween, time) : prev.value;
}

function visualScale(prev: RowMemory, time: number): number {
  return tweenActive(prev.scaleTween, time) ? tweenAt(prev.scaleTween, time) : prev.scale;
}

/** 一個 surface 一個 rAF：寫所有還在數的列（上游每列一個 rAF，效果相同）。 */
function runNumbers(surf: SurfaceMemory) {
  if (surf.raf) return;
  if (![...surf.rows.values()].some((r) => r.valueTween)) return;
  const frame = (time: number) => {
    surf.raf = 0;
    const reduced = prefersReducedMotion();
    let active = false;
    for (const [key, mem] of surf.rows) {
      const tw = mem.valueTween;
      if (!tw) continue;
      const done = reduced || time >= tw.start + tw.delay + tw.duration;
      writeNumber(surf.nodes.get(key)?.num ?? null, surf.format(done ? tw.to : tweenAt(tw, time)));
      if (done) mem.valueTween = null;
      else active = true;
    }
    if (active) surf.raf = requestAnimationFrame(frame);
  };
  surf.raf = requestAnimationFrame(frame);
}

// 減少動態打開時（上游 settleMotionAnimations）：數字直接寫成目標值；WAAPI 由 motionRuntime 結束。
onSettle(() => {
  for (const mem of headlines.values()) {
    if (mem.raf) cancelAnimationFrame(mem.raf);
    mem.raf = 0;
    mem.tween = null;
    if (mem.el) mem.el.textContent = mem.format(mem.lastTarget);
  }
  for (const surf of surfaces.values()) {
    if (surf.raf) cancelAnimationFrame(surf.raf);
    surf.raf = 0;
    for (const [key, mem] of surf.rows) {
      if (mem.valueTween) writeNumber(surf.nodes.get(key)?.num ?? null, surf.format(mem.value));
      mem.valueTween = null;
      mem.scaleTween = null;
    }
  }
});

/**
 * 清單的列動畫。沒有 `motion` 時只負責寫上數字與長條（靜態清單）。
 *
 * widget（`variant` 預設）：依 motion.ts `listMotionKind` 決定——既有的列排名變了就整列滑動（280 ms）、
 * 長條與數字從畫面上的值動過去（即時 600 ms、換期間 800 ms）；新出現的列淡入上移（每列延遲 18 ms）、
 * 長條與數字從 0 開始；換拆分時長條從零長出（420 ms）。超過 40 列只留 CSS 的長條過場。
 *
 * 儀表板（`dashboard`）：只有長條，第一次從 0、之後從畫面上的比例動到新的比例，一律 800 ms；
 * 數字是 React 的文字（上游 dashboard.js renderBreakdown）。
 */
export function useListMotion(
  listRef: RefObject<HTMLElement>,
  rows: MotionRow[],
  format: (n: number) => string,
  motion?: ListMotion,
  variant: "widget" | "dashboard" = "widget",
) {
  const inst = useRef({ committed: false, count: 0, fingerprint: "" });
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const nodes = collectNodes(list);
    const state = inst.current;
    if (!motion) {
      for (const row of rows) {
        const node = nodes.get(row.key);
        if (node) writeStatic(node, row, format);
      }
      return;
    }
    const surf = surfaceMemory(motion.surface);
    surf.nodes = nodes;
    surf.format = format;
    // 儀表板的長條沒有 CSS 過場（tm-bar-static），新節點照舊從量到的 0 開始動。
    if (variant === "widget") primeNewBars(nodes, rows);
    const fingerprint = JSON.stringify([rows.map((r) => [r.key, r.value, r.scale]), motion.surface, motion.periodKey, motion.viewKey, variant]);
    const time = now();
    if (fingerprint === state.fingerprint) {
      // 同一份資料的重繪（展開一列、StrictMode 重跑）：補上被 React 重建的節點、接續還在跑的數字，
      // 記下新的位置給下一次的滑動用。
      for (const row of rows) {
        const node = nodes.get(row.key);
        const mem = surf.rows.get(row.key);
        if (!node) continue;
        if (!mem || !tweenActive(mem.valueTween, time)) writeNumber(node.num, format(row.value));
        if (node.fill && !barMotions.has(node.fill) && node.fill.style.getPropertyValue("--bar-scale") !== String(row.scale)) setBarScale(node.fill, row.scale);
        if (mem) mem.top = node.li.offsetTop;
      }
      runNumbers(surf);
      return;
    }
    state.fingerprint = fingerprint;
    const reduced = prefersReducedMotion();
    const next = new Map<string, RowMemory>();

    if (variant === "dashboard") {
      for (const row of rows) {
        const node = nodes.get(row.key);
        if (!node) continue;
        const prev = surf.rows.get(row.key);
        const mem: RowMemory = { value: row.value, valueTween: null, scale: row.scale, scaleTween: null, top: node.li.offsetTop };
        if (node.fill) {
          const from = state.committed && prev ? (measureScale(node.fill) ?? visualScale(prev, time)) : 0;
          mem.scaleTween = reduced ? (setBarScale(node.fill, row.scale), null) : animateBar(node.fill, from, row.scale, 0, M.dashDataMs);
        }
        next.set(row.key, mem);
      }
    } else {
      const kind = listMotionKind({
        reduced,
        surfaceSeen: surf.seen,
        instanceCommitted: state.committed,
        periodChanged: surf.seen && surf.periodKey !== motion.periodKey,
        viewChanged: surf.seen && surf.viewKey !== motion.viewKey,
        windowViewChanged: viewChangedInWindow(),
        prevCount: state.count,
        nextCount: rows.length,
      });
      const duration = kind === "period" ? M.rowPeriodMs : M.rowLiveMs;
      let entering = 0;
      for (const row of rows) {
        const node = nodes.get(row.key);
        if (!node) continue;
        const prev = surf.rows.get(row.key);
        const top = node.li.offsetTop;
        const mem: RowMemory = { value: row.value, valueTween: null, scale: row.scale, scaleTween: null, top };
        const { li, fill, num } = node;
        if (kind === "initial" || kind === "live" || kind === "period") {
          if (kind !== "initial" && prev) {
            const dy = prev.top - top;
            if (Math.abs(dy) > 0.5) {
              li.animate?.([{ transform: `translate3d(0, ${dy}px, 0)` }, { transform: "translate3d(0, 0, 0)" }], { duration: M.reorderMs, easing: EASE_DATA });
            }
            if (fill) mem.scaleTween = animateBar(fill, measureScale(fill) ?? visualScale(prev, time), row.scale, 0, duration);
            mem.valueTween = planNumber(prev, visualValue(prev, time), row.value, duration, time);
          } else {
            const delay = rowEnterDelay(entering);
            entering += 1;
            li.animate?.(
              [
                { opacity: 0, transform: `translate3d(0, ${M.enterOffsetPx}px, 0)` },
                { opacity: 1, transform: "translate3d(0, 0, 0)" },
              ],
              { duration: M.enterMs, delay, easing: EASE_DATA, fill: "backwards" },
            );
            if (fill) mem.scaleTween = animateBar(fill, 0, row.scale, delay, Math.max(1, duration - delay));
            // 上游新列的數字不延遲，從 0 數整段。
            mem.valueTween = planNumber(undefined, 0, row.value, duration, time);
          }
          writeNumber(num, format(mem.valueTween ? tweenAt(mem.valueTween, time) : row.value));
        } else if (kind === "view") {
          // 上游 renderBreakdownChange → applyBarScale：每一條都從零長出（不受 40 列限制），數字不動。
          if (fill) mem.scaleTween = animateBar(fill, 0, row.scale, 0, M.barFromZeroMs);
          writeNumber(num, format(row.value));
        } else if (kind === "range") {
          // 上游月份選單：列留在原地，長條跟著 420 ms 的 CSS 過場；這裡換了元件，用記住的長度接著動。
          if (fill) {
            if (prev) mem.scaleTween = animateBar(fill, visualScale(prev, time), row.scale, 0, M.barFromZeroMs);
            else setBarScale(fill, row.scale);
          }
          writeNumber(num, format(row.value));
        } else {
          if (fill) {
            stopBar(fill);
            setBarScale(fill, row.scale);
          }
          writeNumber(num, format(row.value));
        }
        next.set(row.key, mem);
      }
    }
    surf.rows = next;
    surf.seen = true;
    surf.periodKey = motion.periodKey;
    surf.viewKey = motion.viewKey;
    state.committed = true;
    state.count = rows.length;
    runNumbers(surf);
  });
  const surface = motion?.surface;
  useLayoutEffect(() => {
    return () => {
      if (!surface) return;
      const surf = surfaces.get(surface);
      if (!surf) return;
      // 記憶留給下一個掛上的清單（換成範圍時從記住的長度接著動）；只停掉這份清單的 rAF 與節點。
      if (surf.raf) cancelAnimationFrame(surf.raf);
      surf.raf = 0;
      surf.nodes = new Map();
    };
  }, [surface]);
}
