// 浮動泡泡的把手（src-tauri/src/gui/bubble.rs）：widget 收合時整個視窗只剩這個小把手，
// 顯示今日 token。按一下還原；按住拖曳可以沿著螢幕邊移動。狀態獨立在這裡，不放進主 store。

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { api, isTauri, onBubbleState, type BubbleView } from "./api";
import { fmtTokens } from "./format";
import { t } from "./i18n";
import { useApp } from "./store";

export const useBubble = create<BubbleView>(() => ({ collapsed: false, side: null }));

let subscribed = false;

/** 訂閱 Rust 的收合狀態；widget 載入時呼叫一次。 */
export function useBubbleSync() {
  useEffect(() => {
    if (subscribed || !isTauri()) return;
    subscribed = true;
    void onBubbleState((v) => useBubble.setState(v));
    void api.bubbleGet().then((v) => {
      if (v) useBubble.setState(v);
    });
  }, []);
}

/** widget 上按 Esc 立刻收合（上游 main.js `handleZoomShortcut` 的 Escape 分支）。 */
export function useEscToCollapse() {
  const enabled = useApp((s) => s.settings?.floatingBubbleEnabled === true && s.settings.windowMode === "floating");
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) void api.bubbleCollapse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** 按住移動超過這麼多像素才算拖曳，否則放開就是「按一下還原」。 */
const DRAG_THRESHOLD = 4;

export function BubbleHandle() {
  const side = useBubble((s) => s.side);
  const today = useApp((s) => s.local?.periods.today.totalTokens ?? 0);
  const start = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const rounded = side === "left" ? "rounded-r-md" : "rounded-l-md";
  return (
    <button
      type="button"
      title={t("按一下展開 Token Monitor")}
      className={`widget-shell flex h-full w-full items-center justify-center ${rounded} num text-xs font-semibold`}
      onPointerDown={(e) => {
        if (e.button === 0) start.current = { x: e.screenX, y: e.screenY, dragging: false };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s || s.dragging) return;
        if (Math.abs(e.screenX - s.x) + Math.abs(e.screenY - s.y) > DRAG_THRESHOLD) {
          s.dragging = true;
          void getCurrentWindow().startDragging();
        }
      }}
      onPointerUp={() => {
        const s = start.current;
        start.current = null;
        if (s && !s.dragging) void api.bubbleExpand();
      }}
    >
      {fmtTokens(today)}
    </button>
  );
}
