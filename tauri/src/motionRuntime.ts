// 減少動態效果的執行期狀態（每個視窗各一份）：設定 `reduceMotion` 與系統的 prefers-reduced-motion
// 合起來決定要不要播資料動畫。對應上游 app.js 的 `prefersReducedMotion` / `applyReduceMotionPreference`
// / `settleMotionAnimations` 與 dashboard.js 同名函式。
//
// CSS 動畫與過場由 styles.css 的 `data-reduce-motion` 規則處理；WAAPI（element.animate）與 rAF 不受
// CSS 影響，所以每一個 JavaScript 動畫開始前（rAF 每一幀也是）都要問 prefersReducedMotion()。
// 這裡不能 import store.ts（store 在 applySettings 時呼叫這裡，會循環）。

import { useSyncExternalStore } from "react";
import type { ReduceMotionSetting } from "./api";
import { normalizeReduceMotion, shouldReduceMotion } from "./motion";

/** index.html 的 pre-paint script 讀它，重新載入時第一幀就套用。 */
export const REDUCE_MOTION_KEY = "tm:reduceMotion";

const root = typeof document !== "undefined" ? document.documentElement : null;
let current: ReduceMotionSetting = normalizeReduceMotion(root?.dataset?.reduceMotion);
const mql = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") : undefined;

const changeListeners = new Set<() => void>();
const settleListeners = new Set<() => void>();
const flareListeners = new Set<() => void>();
let generation = 0;
let suppressHeadlineUntil = 0;
let viewChanged = false;

function notify() {
  for (const cb of [...changeListeners]) cb();
}

/** 現在該不該減少動態：設定 `on` 一律、`off` 從不、`system` 看系統。 */
export function prefersReducedMotion(): boolean {
  return shouldReduceMotion(current, Boolean(mql?.matches));
}

/** 目前的設定值（`system` / `on` / `off`）。 */
export function reduceMotionSetting(): ReduceMotionSetting {
  return current;
}

/**
 * 上游 `applyReduceMotionPreference`：`<html data-reduce-motion>` 跟著設定（styles.css 的總開關看它）、
 * 記進 localStorage 給 pre-paint；變成要減少時把進行中的動畫全部結束。
 */
export function applyReduceMotion(value: unknown) {
  const next = normalizeReduceMotion(value);
  if (root?.dataset) root.dataset.reduceMotion = next;
  try {
    localStorage.setItem(REDUCE_MOTION_KEY, next);
  } catch {
    /* 私密模式或被停用時不影響功能 */
  }
  const changed = next !== current;
  current = next;
  if (changed) notify();
  if (prefersReducedMotion()) settleMotion();
}

/**
 * 上游 `settleMotionAnimations`：WAAPI 動畫一律 finish（丟例外就 cancel），rAF 的數字動畫由
 * onSettle 的訂閱者直接寫上目標值；熱力圖還在等待的進場也作廢。
 */
export function settleMotion() {
  generation += 1;
  const animations = typeof document !== "undefined" ? (document.getAnimations?.() ?? []) : [];
  for (const animation of animations) {
    try {
      animation.finish();
    } catch {
      animation.cancel();
    }
  }
  for (const cb of [...settleListeners]) cb();
}

/** 每次 settleMotion 加一；排好的延遲動畫（儀表板熱力圖進場）開始前比對它，過期就不播。 */
export function motionGeneration(): number {
  return generation;
}

/** 動畫全部結束時通知（rAF 的數字動畫訂閱它，把文字寫成目標值）。回傳取消訂閱。 */
export function onSettle(cb: () => void): () => void {
  settleListeners.add(cb);
  return () => settleListeners.delete(cb);
}

// 系統的「動畫效果」切換時，只有設定是 system 才跟著（上游 app.js 的 reducedMotionMedia change）。
mql?.addEventListener?.("change", () => {
  if (current !== "system") return;
  notify();
  if (mql.matches) settleMotion();
});

function subscribe(cb: () => void) {
  changeListeners.add(cb);
  return () => {
    changeListeners.delete(cb);
  };
}

/** React 用：減少動態的狀態變了就重繪（例如儀表板熱力圖的待進場樣式）。 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, prefersReducedMotion);
}

/**
 * 泡泡展開時 widget 整個重建：下一個掛上的總數直接顯示，不從舊值重數
 * （上游 main 重建視窗時設的 `__TOKEN_MONITOR_SUPPRESS_INITIAL_NUMBER_ANIMATION__`）。
 */
export function suppressNextHeadlineMotion() {
  // 展開後一秒內掛上的才算（目前的視圖沒有總數時，不留到之後換視圖才掛上的那一個）。
  suppressHeadlineUntil = performance.now() + 1000;
}

/** 讀一次就清掉（只給新掛上的總數用）。 */
export function takeHeadlineSuppression(): boolean {
  const value = performance.now() < suppressHeadlineUntil;
  suppressHeadlineUntil = 0;
  return value;
}

/**
 * 使用者換了視圖（上游 app.js `renderBreakdownChange`；store.ts `setView` 呼叫）。之後才第一次掛上的清單
 * 算換視圖——長條從零長出、數字不動——不是視窗第一次畫面的進場：widget 預設打開主頁，清單幾乎都是
 * 從主頁換過去才第一次掛上，上游這時走的也是 renderBreakdownChange。
 */
export function noteViewChange() {
  viewChanged = true;
}

/** 這個視窗換過視圖了沒（見 noteViewChange；motion.ts `listMotionKind` 的 `windowViewChanged`）。 */
export function viewChangedInWindow(): boolean {
  return viewChanged;
}

/** 總數因為值變了開始數時通知（上游 `pulseLiveDot`；標題列的狀態點訂閱）。 */
export function flareLiveDot() {
  for (const cb of [...flareListeners]) cb();
}

export function onLiveDotFlare(cb: () => void): () => void {
  flareListeners.add(cb);
  return () => flareListeners.delete(cb);
}
