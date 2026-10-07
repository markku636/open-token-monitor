// 可拖曳排序、可隱藏的清單（設定頁「主畫面」的視圖、主頁模組、主頁額度 provider）。照上游 renderer 的
// rowDragController.js / verticalDragSort.js 自己做：整列都能拖（按鈕除外），移動超過 4px 才算拖曳，
// 放開時依各列中線決定新位置；把手可用鍵盤（上下鍵移動、Home／End 到頭尾）。不引入拖放套件。

import { ChevronRight, Eye, EyeOff, GripVertical } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

export interface ReorderItem {
  id: string;
  label: string;
  /** 畫成隱藏（眼睛劃掉、字變淡）。 */
  hidden: boolean;
  /** 背後的功能關閉（例如 history 關閉時的趨勢）：一樣畫成隱藏。 */
  disabled?: boolean;
  /** 不能再隱藏（最後一個看得到的）。 */
  hideLocked?: boolean;
  /** 展開的子設定（chevron 打開）。 */
  subgroup?: ReactNode;
  expanded?: boolean;
  onToggleExpand?: () => void;
  expandTitle?: string;
}

export interface DragState {
  id: string;
  pointerId: number;
  from: number;
  startY: number;
  dy: number;
  active: boolean;
  /** 拖曳開始時各列標題的中線與被拖那列的高度。 */
  mids: number[];
  height: number;
}

/** 放開的位置：拿掉被拖的那列之後，中線在指標上方的列數（上游 verticalDragSort 的 targetIndex）。 */
export function dropIndex(mids: readonly number[], from: number, pointerY: number): number {
  let index = 0;
  mids.forEach((mid, i) => {
    if (i !== from && mid < pointerY) index += 1;
  });
  return index;
}

const THRESHOLD_PX = 4;

/**
 * pointermove 之後的拖曳狀態：不是同一個指標就不變；沒按著任何鍵回 null（放開事件沒回到這一列時，
 * 留下的狀態不能讓之後單純滑過就拖起來）；移動超過門檻才開始拖。
 */
export function dragAfterMove(d: DragState, move: { pointerId: number; clientY: number; buttons: number }): DragState | null {
  if (d.pointerId !== move.pointerId) return d;
  if (move.buttons === 0) return null;
  const dy = move.clientY - d.startY;
  if (!d.active && Math.abs(dy) < THRESHOLD_PX) return d;
  return { ...d, dy, active: true };
}

export function ReorderList({
  items,
  onToggleHidden,
  onMove,
  onReorder,
  hideTitle,
  showTitle,
  reorderTitle,
}: {
  items: ReorderItem[];
  onToggleHidden: (id: string) => void;
  onMove: (id: string, direction: "up" | "down") => void;
  onReorder: (id: string, index: number) => void;
  hideTitle: (name: string) => string;
  showTitle: (name: string) => string;
  reorderTitle: (name: string) => string;
}) {
  const list = useRef<HTMLUListElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const update = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };
  // 鍵盤移動後列會換位置，焦點跟著把手走（React 搬動節點時焦點可能掉）。
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    pendingFocus.current = null;
    const handle = Array.from(list.current?.querySelectorAll<HTMLElement>(":scope > li [data-reorder-handle]") ?? []).find((h) => h.dataset.reorderHandle === id);
    if (handle && document.activeElement !== handle) handle.focus();
  }, [items]);

  // 拖曳中按 Esc 放棄（上游 rowDragController 的 cancel）。
  useEffect(() => {
    if (!drag?.active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") update(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag?.active]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>, id: string, index: number) => {
    // 新的一次按下（包括按在按鈕上）先丟掉沒收尾的狀態（上游 startRowDrag 的 `if (drag) finishRowDrag(false)`）。
    if (dragRef.current) update(null);
    if (e.button !== 0) return;
    // 按鈕、輸入框與把手以外的地方都能拖；點按鈕照常是按鈕。
    if ((e.target as Element).closest("button, input, select, textarea, label, a")) return;
    const heads = Array.from(list.current?.querySelectorAll<HTMLElement>(":scope > li > [data-reorder-head]") ?? []);
    const rects = heads.map((h) => h.getBoundingClientRect());
    // 按下就 capture，放開或取消一定回到這一列；否則還沒拖滿 4px 就在列外放開時，狀態會留著，之後
    // 滑過去就被當成拖曳。上游 rowDragController 過了門檻才 capture，是怕把巢狀按鈕的 click 改送到
    // 整列；這裡按在按鈕上根本不會走到這一步，所以提早 capture 不影響按鈕。
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 指標已經不在（合成事件）：照樣記下，pointermove 沒按鍵時會丟掉 */
    }
    update({
      id,
      pointerId: e.pointerId,
      from: index,
      startY: e.clientY,
      dy: 0,
      active: false,
      mids: rects.map((r) => r.top + r.height / 2),
      height: (list.current?.children[index] as HTMLElement | undefined)?.getBoundingClientRect().height ?? rects[index]?.height ?? 0,
    });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const next = dragAfterMove(d, { pointerId: e.pointerId, clientY: e.clientY, buttons: e.buttons });
    if (next !== d) update(next);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    update(null);
    if (!d.active) return;
    const to = dropIndex(d.mids, d.from, d.mids[d.from] + d.dy);
    if (to !== d.from) onReorder(d.id, to);
  };
  const onPointerCancel = () => update(null);
  // capture 被搶走時當成取消（上游 rowDragController 的 lostpointercapture → onDragAbort）。這個事件會冒泡：
  // 觸控按下時瀏覽器先隱含 capture 在按到的子元素，改 capture 到整列時子元素的 lost 不算。
  const onLostCapture = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) update(null);
  };

  const target = drag?.active ? dropIndex(drag.mids, drag.from, drag.mids[drag.from] + drag.dy) : -1;
  const shiftFor = (index: number): number => {
    if (!drag?.active || index === drag.from) return 0;
    if (drag.from < target && index > drag.from && index <= target) return -drag.height;
    if (drag.from > target && index >= target && index < drag.from) return drag.height;
    return 0;
  };

  const onHandleKey = (e: KeyboardEvent<HTMLSpanElement>, id: string) => {
    if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) pendingFocus.current = id;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      onMove(id, e.key === "ArrowUp" ? "up" : "down");
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      onReorder(id, e.key === "Home" ? 0 : Number.MAX_SAFE_INTEGER);
    }
  };

  return (
    <ul ref={list} className="divide-y divide-fg/5">
      {items.map((item, index) => {
        const dragging = drag?.active && drag.from === index;
        const shown = !item.hidden && !item.disabled;
        return (
          <li
            key={item.id}
            className={`relative bg-panel ${dragging ? "z-10 shadow-lg" : "transition-transform duration-150 motion-reduce:transition-none"}`}
            style={{ transform: `translateY(${dragging ? (drag?.dy ?? 0) : shiftFor(index)}px)` }}
          >
            <div
              data-reorder-head=""
              className={`flex select-none items-center gap-1.5 py-1.5 ${drag?.active ? "cursor-grabbing" : "cursor-grab"}`}
              onPointerDown={(e) => onPointerDown(e, item.id, index)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onLostPointerCapture={onLostCapture}
            >
              <span className={`min-w-0 flex-1 truncate text-sm ${shown ? "" : "text-fg/45"}`}>{item.label}</span>
              {item.subgroup && (
                <button
                  type="button"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-fg/60 hover:bg-fg/10 hover:text-fg"
                  title={item.expandTitle}
                  aria-label={item.expandTitle}
                  aria-expanded={Boolean(item.expanded)}
                  onClick={item.onToggleExpand}
                >
                  <ChevronRight size={14} className={`transition-transform motion-reduce:transition-none ${item.expanded ? "rotate-90" : ""}`} aria-hidden />
                </button>
              )}
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-fg/60 hover:bg-fg/10 hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
                title={shown ? hideTitle(item.label) : showTitle(item.label)}
                aria-label={shown ? hideTitle(item.label) : showTitle(item.label)}
                aria-pressed={shown}
                disabled={item.hideLocked}
                onClick={() => onToggleHidden(item.id)}
              >
                {shown ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}
              </button>
              <span
                role="button"
                tabIndex={0}
                data-reorder-handle={item.id}
                className="inline-flex h-6 w-5 items-center justify-center rounded-sm text-fg/40 hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent/50"
                title={reorderTitle(item.label)}
                aria-label={reorderTitle(item.label)}
                onKeyDown={(e) => onHandleKey(e, item.id)}
              >
                <GripVertical size={14} aria-hidden />
              </span>
            </div>
            {item.subgroup && item.expanded && <div className="pb-2 pl-3">{item.subgroup}</div>}
          </li>
        );
      })}
    </ul>
  );
}
