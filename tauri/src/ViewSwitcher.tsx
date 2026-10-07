// 底欄的循環視圖切換鈕（上游 app.js `renderViewSwitcher`，index.html #viewSwitcher，styles.css
// .view-switcher*）：按一下換到下一個視圖；長按、右鍵或滑到箭頭打開選單直接挑。

import { Activity, ArrowLeft, Building2, ChevronDown, Gauge, House, Laptop, TrendingUp, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { t } from "./i18n";
import { useApp } from "./store";
import { nextView, viewLabel, type ViewId } from "./viewPrefs";

/** 上游 VIEW_ICON_CLASSES 的對應（lucide 的同義圖示）。主頁模組標題旁的跳轉圖示也用這組。 */
export const VIEW_ICONS: Record<ViewId, LucideIcon> = {
  home: House,
  tool: Laptop,
  status: Activity,
  device: Building2,
  limits: Gauge,
  trends: TrendingUp,
};

/** 上游 `VIEW_SWITCHER_LONG_PRESS_MS` / `VIEW_SWITCHER_HOVER_CLOSE_MS`。 */
const LONG_PRESS_MS = 420;
const HOVER_CLOSE_MS = 160;
const MENU_ID = "view-switcher-menu";

export function ViewSwitcher({ order, current, currentRef }: { order: ViewId[]; current: ViewId; currentRef: RefObject<HTMLButtonElement> }) {
  const setView = useApp((s) => s.setView);
  const [open, setOpenState] = useState(false);
  const [focus, setFocus] = useState<"menu" | "disclosure" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const disclosure = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverClose = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef(false);

  const clearLongPress = useCallback(() => {
    if (longPress.current) clearTimeout(longPress.current);
    longPress.current = null;
  }, []);
  const clearHoverClose = useCallback(() => {
    if (hoverClose.current) clearTimeout(hoverClose.current);
    hoverClose.current = null;
  }, []);
  const setOpen = useCallback((next: boolean, focusTarget: "menu" | "disclosure" | null = null) => {
    setOpenState(next);
    if (focusTarget) setFocus(focusTarget);
  }, []);

  // 開啟時把焦點放在目前的項目，關閉（Esc）時回到箭頭鈕（上游 updateViewSwitcherOpenState）。
  useEffect(() => {
    if (!focus) return;
    const id = requestAnimationFrame(() => {
      if (focus === "menu") menu.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
      else disclosure.current?.focus();
      setFocus(null);
    });
    return () => cancelAnimationFrame(id);
  }, [focus]);

  // 點到切換鈕以外就關閉；放開滑鼠時取消長按計時，被觸發的長按旗標在這次 click 之後才清掉；
  // 視窗失去焦點時全部收起（上游 document pointerdown / pointerup 與 window blur）。
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpenState(false);
    };
    const onUp = () => {
      clearLongPress();
      setTimeout(() => {
        longPressTriggered.current = false;
      }, 0);
    };
    const onBlur = () => {
      clearLongPress();
      clearHoverClose();
      longPressTriggered.current = false;
      setOpenState(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("pointerup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerup", onUp);
      window.removeEventListener("blur", onBlur);
      clearLongPress();
      clearHoverClose();
    };
  }, [clearLongPress, clearHoverClose]);

  const next = nextView(order, current) as ViewId;
  const CurrentIcon = VIEW_ICONS[current];
  const nextTitle = t("下一個：{view}", { view: viewLabel(next) });

  const onCurrentPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    clearLongPress();
    longPressTriggered.current = false;
    longPress.current = setTimeout(() => {
      longPress.current = null;
      longPressTriggered.current = true;
      setOpen(true, "menu");
    }, LONG_PRESS_MS);
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false, "disclosure");
      return;
    }
    const direction = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!direction && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const index = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    const target = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (index + direction + items.length) % items.length;
    items[target]?.focus();
  };

  const pair = open ? "border-accent/25 bg-accent/10 text-fg" : "border-fg/15 bg-fg/[0.04] text-fg/75 hover:border-accent/25 hover:bg-accent/10 hover:text-fg";

  return (
    <div
      ref={root}
      className="relative flex min-w-0 shrink-0"
      onPointerEnter={clearHoverClose}
      onPointerLeave={() => {
        clearHoverClose();
        hoverClose.current = setTimeout(() => {
          hoverClose.current = null;
          setOpenState(false);
        }, HOVER_CLOSE_MS);
      }}
    >
      <button
        ref={currentRef}
        type="button"
        title={nextTitle}
        aria-label={nextTitle}
        className={`inline-flex h-[26px] min-w-0 max-w-[112px] items-center gap-1.5 rounded-l-[7px] border px-2 transition-colors ${pair}`}
        onClick={() => {
          if (longPressTriggered.current) {
            longPressTriggered.current = false;
            return;
          }
          setOpenState(false);
          setView(next);
        }}
        onPointerDown={onCurrentPointerDown}
        onPointerLeave={clearLongPress}
        onContextMenu={(e) => {
          e.preventDefault();
          clearLongPress();
          setOpen(true, "menu");
        }}
      >
        <CurrentIcon size={14} className="shrink-0" aria-hidden />
        <span className="truncate text-[11px]">{viewLabel(current)}</span>
      </button>
      <button
        ref={disclosure}
        type="button"
        title={t("選擇視圖")}
        aria-label={t("選擇視圖")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={MENU_ID}
        className={`-ml-px inline-flex h-[26px] w-6 shrink-0 items-center justify-center rounded-r-[7px] border transition-colors ${pair}`}
        onPointerEnter={(e) => {
          if (e.pointerType && e.pointerType !== "mouse") return;
          clearHoverClose();
          if (!open) setOpen(true);
        }}
        onClick={(e) => {
          // 滑鼠滑過時已經打開了，這次點擊不要又把它關掉（鍵盤觸發的 detail 是 0，照常切換）。
          if (e.detail > 0 && open) return;
          setOpen(!open, open ? null : "menu");
        }}
      >
        <ChevronDown size={12} aria-hidden className={`transition-transform duration-[190ms] motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
      </button>
      <div
        ref={menu}
        id={MENU_ID}
        role="menu"
        aria-label={t("選擇視圖")}
        aria-hidden={!open}
        onKeyDown={onMenuKeyDown}
        // 打開時 visibility 立刻變成 visible（焦點才放得進去），關閉時等淡出的 190ms 之後才藏起來。
        className={`absolute bottom-full left-0 z-30 mb-1.5 max-h-[min(280px,calc(100vh-84px))] w-full min-w-[8rem] overflow-y-auto rounded-[7px] border border-fg/15 bg-elevated p-1 shadow-lg duration-[190ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
          open ? "visible translate-y-0 opacity-100 transition-[opacity,transform]" : "pointer-events-none invisible translate-y-1 opacity-0 transition-[opacity,transform,visibility]"
        }`}
      >
        {order.map((id) => {
          const Icon = VIEW_ICONS[id];
          const active = id === current;
          return (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              aria-current={active ? "page" : undefined}
              tabIndex={open && active ? 0 : -1}
              className={`flex w-full items-center gap-2 rounded-[5px] px-2 py-1 text-left text-[11px] hover:bg-fg/10 focus-visible:bg-fg/10 focus-visible:outline-none ${
                active ? "text-accent" : "text-fg/80"
              }`}
              onClick={() => {
                setOpenState(false);
                if (active) setFocus("disclosure");
                else setView(id);
              }}
            >
              <Icon size={14} className="shrink-0" aria-hidden />
              <span className="truncate">{viewLabel(id)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 「返回主頁」（上游 index.html #viewBackRow）：從主頁的模組點進來時出現，換到其他視圖就收起來。
 * 用鍵盤按的（detail 是 0）回到主頁後把焦點放回切換鈕，不讓焦點掉到頁首。
 */
export function BackHomeRow({ switcherRef }: { switcherRef: RefObject<HTMLButtonElement> }) {
  const setView = useApp((s) => s.setView);
  const label = t("返回主頁");
  return (
    <div className="px-3 pb-1">
      <button
        type="button"
        title={label}
        aria-label={label}
        className="inline-flex h-[26px] items-center gap-1 text-[11px] text-fg/55 hover:text-fg"
        onClick={(e) => {
          setView("home");
          if (e.detail === 0) requestAnimationFrame(() => switcherRef.current?.focus());
        }}
      >
        <ArrowLeft size={12} aria-hidden />
        <span>{label}</span>
      </button>
    </div>
  );
}
