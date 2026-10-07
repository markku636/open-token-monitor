// 主頁「活動」模組的內容（從趨勢分頁搬來；儀表板的趨勢區也用）：滾動一年的熱力圖 + 最近 45 天的趨勢線。
// 畫法照上游 app.js `renderHomeTrendsModule` 與 usageCharts.js `heatmapSvg`（格子 9、間距 3、圓角 2，
// homeOverview.js `homeActivityHeatmapLayout`），捲動位置照 `homeActivityScrollTarget` /
// `homeActivityScrollRecord`，拖曳捲動、聚光燈與浮動提示照 `setupHomeActivityScroller` /
// `setupHomeActivityHover`，進場動畫照 `animateHomeHistoryVisuals`（儀表板照 dashboard.js
// `animateHeatmapEntry`）。時間與幾何在 motion.ts。

import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { TrendsView } from "./api";
import { fmtTokens } from "./format";
import { homeActivityScrollRecord, homeActivityScrollTarget, homeTrendSummary, longRangePeakDayTokens } from "./homeOverview";
import { lang, t } from "./i18n";
import { dashHeatDelay, EASE_DATA, homeHeatDelay, M, placeHeatTooltip, spotlightStep } from "./motion";
import { motionGeneration, onSettle, prefersReducedMotion, useReducedMotion } from "./motionRuntime";
import { activeDaysCount, areaChart, HOME_TREND_PAD, rollingYearHeatmap, shortLabel, TREND_ROWS, type HeatMetric, type Heatmap as HeatmapData } from "./trendsFormat";

const CELL = 9;
const GAP = 3;
const RADIUS = 2;
/** 等級 1–4 的不透明度（上游 styles.css 的熱力圖色階），用主題的強調色。 */
const LEVEL_ALPHA = [0, 0.18, 0.45, 0.8, 1];
/** 格子的光暈（styles.css `.tm-heat[data-active]` 以固定 id 引用）。 */
const GLOW_FILTER_ID = "tmHeatGlow";
/** 聚光燈離開格子時停的位置（上游 −200, −200）。 */
const SPOT_HIDDEN = { x: -200, y: -200 };

/** widget 的主頁與儀表板：進場動畫不同（上游 app.js 與 dashboard.js 各一套）。 */
export type ActivityVariant = "widget" | "dashboard";

/**
 * 熱力圖的捲動位置留在這次開啟期間（上游 state.homeActivityScrollLeft / homeActivityFollowEnd）：
 * 預設跟著最右邊（最新的一週），使用者往回捲之後回到主頁時停在同一個位置。
 */
const scrollMemory: { left: number | null; followEnd: boolean } = { left: null, followEnd: true };

function monthName(month: string): string {
  try {
    return new Intl.DateTimeFormat(lang() === "en" ? "en" : "zh-TW", { month: "short", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
  } catch {
    return month.slice(5);
  }
}

/** 視窗看不到時先不播進場（上游在隱藏時整個不畫，看得到時才畫、才播），看得到時再呼叫 `run`。 */
function whenVisible(run: () => void): () => void {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") {
    run();
    return () => {};
  }
  const onChange = () => {
    if (document.visibilityState === "hidden") return;
    document.removeEventListener("visibilitychange", onChange);
    run();
  };
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** 趨勢線與熱力圖的進場要同時開始；趨勢線量好寬度之前先記著。 */
interface TrendDraw {
  pending: boolean;
  draw: (() => void) | null;
}

interface HoverTip {
  date: string;
  tokens: number;
}

function Heatmap({ map, variant, trend }: { map: HeatmapData; variant: ActivityVariant; trend: MutableRefObject<TrendDraw> }) {
  const scroller = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gradientRef = useRef<SVGRadialGradientElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  /** 進場還沒播（上游 state.animateChartsOnRender：切進主頁時是 true，播一次就清掉）。 */
  const entry = useRef(true);
  const alive = useRef(true);
  /** 程式設定的捲動（還原位置）接下來的 scroll 事件不是使用者捲的，不收起提示。 */
  const programmatic = useRef(false);
  const drag = useRef<{ id: number; x: number; left: number } | null>(null);
  const spot = useRef({ visible: false, frame: 0, cur: { ...SPOT_HIDDEN }, target: { ...SPOT_HIDDEN } });
  const active = useRef<SVGRectElement | null>(null);
  /** 游標停在哪一格（資料更新重畫後，游標沒動就接回同一天的提示）。 */
  const hover = useRef<{ x: number; y: number; date: string } | null>(null);
  const [tip, setTip] = useState<HoverTip | null>(null);
  const reduced = useReducedMotion();
  // 儀表板的格子先藏起來，等視窗有焦點、排好之後才淡入（上游 .is-motion-pending）。
  const [pending, setPending] = useState(() => variant === "dashboard" && !prefersReducedMotion());
  const idBase = useId().replace(/:/g, "");
  const gradientId = `${idBase}HeatSpotGradient`;
  const maskId = `${idBase}HeatSpotMask`;
  const width = map.weeks ? map.weeks * (CELL + GAP) - GAP : 0;
  const gridH = 7 * (CELL + GAP) - GAP;

  useLayoutEffect(() => {
    alive.current = true;
    const s = spot.current;
    return () => {
      alive.current = false;
      if (s.frame) cancelAnimationFrame(s.frame);
      s.frame = 0;
    };
  }, []);

  // 減少動態打開時（settleMotion）等待中的進場作廢，儀表板的格子直接顯示。不拿掉待進場樣式的話，
  // 之後再關掉減少動態時格子又被藏起來，也不會再有進場把它們淡入（上游 dashboard.js
  // applyReduceMotionPreference 作廢排好的進場，下一次重畫的 animateHeatmapEntry 拿掉 is-motion-pending）。
  useLayoutEffect(() => onSettle(() => setPending(false)), []);

  const setSpotlight = useCallback((p: { x: number; y: number }) => {
    const g = gradientRef.current;
    if (!g) return;
    g.setAttribute("cx", String(Math.round(p.x * 10) / 10));
    g.setAttribute("cy", String(Math.round(p.y * 10) / 10));
  }, []);

  const hide = useCallback(() => {
    hover.current = null;
    setTip(null);
    const tipEl = tipRef.current;
    if (tipEl) tipEl.style.transform = "translate(-9999px, -9999px)";
    const s = spot.current;
    if (s.frame) cancelAnimationFrame(s.frame);
    s.frame = 0;
    s.visible = false;
    s.target = { ...SPOT_HIDDEN };
    s.cur = { ...SPOT_HIDDEN };
    setSpotlight(s.cur);
    active.current?.removeAttribute("data-active");
    active.current = null;
  }, [setSpotlight]);

  // 聚光燈：第一次直接貼上游標，之後每幀靠近 32%（spotlightStep）。
  const scheduleSpot = useCallback(() => {
    const s = spot.current;
    if (s.frame || !gradientRef.current) return;
    const frame = () => {
      s.frame = 0;
      const next = spotlightStep(s.cur, s.target);
      s.cur = { x: next.x, y: next.y };
      if (!next.done) s.frame = requestAnimationFrame(frame);
      setSpotlight(s.cur);
    };
    s.frame = requestAnimationFrame(frame);
  }, [setSpotlight]);

  const moveSpot = useCallback(
    (x: number, y: number) => {
      const s = spot.current;
      s.target = { x, y };
      if (!s.visible) {
        s.visible = true;
        s.cur = { x, y };
        setSpotlight(s.cur);
        return;
      }
      scheduleSpot();
    },
    [scheduleSpot, setSpotlight],
  );

  /** 上游 showAtPoint：游標在格子上就點亮那一格並顯示提示，否則（或拖曳中）全部收起。 */
  const showAt = useCallback(
    (clientX: number, clientY: number, target: EventTarget | null) => {
      const svg = svgRef.current;
      if (!svg || scroller.current?.classList.contains("is-dragging")) {
        hide();
        return;
      }
      const rect = svg.getBoundingClientRect();
      // viewBox 與像素 1:1。
      moveSpot(clientX - rect.left, clientY - rect.top);
      const cell = target instanceof Element ? target.closest<SVGRectElement>(".tm-heat-base .tm-heat[data-d]") : null;
      if (!cell || !svg.contains(cell)) {
        hide();
        return;
      }
      const date = cell.dataset.d ?? "";
      const tokens = Number(cell.dataset.t || 0);
      hover.current = { x: clientX, y: clientY, date };
      if (active.current !== cell) {
        active.current?.removeAttribute("data-active");
        active.current = cell;
        cell.setAttribute("data-active", "true");
      }
      setTip((prev) => (prev && prev.date === date && prev.tokens === tokens ? prev : { date, tokens }));
    },
    [hide, moveSpot],
  );

  /** 資料重畫或還原捲動之後：游標沒動、還在同一天的格子上（±2 px）就接回提示，否則收起。 */
  const restoreHover = useCallback(() => {
    const point = hover.current;
    if (!point) return;
    const cell = Array.from(svgRef.current?.querySelectorAll<SVGRectElement>(".tm-heat-base .tm-heat[data-d]") ?? []).find((c) => c.dataset.d === point.date);
    if (!cell) {
      hide();
      return;
    }
    const r = cell.getBoundingClientRect();
    const slop = 2;
    if (point.x < r.left - slop || point.x > r.right + slop || point.y < r.top - slop || point.y > r.bottom + slop) {
      hide();
      return;
    }
    showAt(point.x, point.y, cell);
  }, [hide, showAt]);

  // 提示的位置要等內容畫好（寬度才對）才算。
  useLayoutEffect(() => {
    const tipEl = tipRef.current;
    const cell = active.current;
    if (!tip || !tipEl || !cell) return;
    const c = cell.getBoundingClientRect();
    const box = tipEl.getBoundingClientRect();
    const { x, y } = placeHeatTooltip({ left: c.left, top: c.top, bottom: c.bottom, width: c.width }, { width: box.width, height: box.height }, { width: window.innerWidth, height: window.innerHeight });
    tipEl.style.transform = `translate(${x}px, ${y}px) translate(-50%, 0)`;
  }, [tip]);

  useLayoutEffect(() => {
    restoreHover();
  }, [map, restoreHover]);

  // 離開主頁（卸載）時提示也收起（上游 hideHomeActivityTooltip）。
  useLayoutEffect(() => () => hide(), [hide]);

  // 版面定了才量得準：寬度一變（包括第一次出現）就依記住的狀態重新定位，第一次排好時播進場
  // （上游用 ResizeObserver 同樣的理由：冷啟動的視窗在 rAF 裡常量到還沒排好的寬度）。
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let cancelVisible = () => {};
    const applyScroll = () => {
      const target = homeActivityScrollTarget({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, followEnd: scrollMemory.followEnd, savedLeft: scrollMemory.left });
      if (Math.abs(el.scrollLeft - target) > 0.5) {
        programmatic.current = true;
        el.scrollLeft = target;
      }
      el.classList.toggle("is-scrolled", target > 2);
    };
    const playWidgetEntry = (generation: number) => {
      // 等視窗看得到的期間打開過減少動態（settleMotion 換了 generation）：這次進場作廢。
      if (generation !== motionGeneration()) return;
      // 上游 animateHomeHistoryVisuals：只動看得到的格子，依欄位由左到右。
      const viewport = el.getBoundingClientRect();
      const visible = Array.from(el.querySelectorAll<SVGRectElement>(".tm-heat-base .tm-heat"))
        .map((cell) => ({ cell, col: Number(cell.dataset.col), rect: cell.getBoundingClientRect() }))
        .filter(({ rect }) => rect.right > viewport.left && rect.left < viewport.right);
      const first = visible.length ? visible[0].col : 0;
      const last = visible.length ? visible[visible.length - 1].col : first;
      for (const { cell, col } of visible) {
        cell.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: M.homeHeatCellMs, delay: homeHeatDelay(col, first, last), easing: EASE_DATA, fill: "backwards" });
      }
      drawTrend(trend.current);
    };
    const playDashboardEntry = (generation: number) => {
      // 上游 animateHeatmapEntry：等視窗有焦點，再等兩幀，所有格子依 x 淡入；之後一幀拿掉待進場樣式。
      // 排好之後打開過減少動態（generation 換了）就不播；待進場樣式已由上面的 onSettle 拿掉。
      const stale = () => !alive.current || generation !== motionGeneration();
      const start = () => {
        if (stale()) return;
        if (!document.hasFocus()) {
          window.addEventListener("focus", start, { once: true });
          return;
        }
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (stale()) return;
            const cells = Array.from(el.querySelectorAll<SVGRectElement>(".tm-heat-base .tm-heat"));
            const xs = cells.map((cell) => Number(cell.getAttribute("x") || 0));
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            cells.forEach((cell, i) => {
              const animation = cell.animate?.([{ opacity: 0 }, { opacity: 1 }], {
                duration: M.dashHeatCellMs,
                delay: dashHeatDelay(xs[i], minX, maxX),
                easing: "ease",
                fill: "both",
              });
              animation?.finished.then(() => animation.cancel()).catch(() => {});
            });
            drawTrend(trend.current);
            requestAnimationFrame(() => {
              if (alive.current) setPending(false);
            });
          }),
        );
      };
      start();
    };
    const settle = () => {
      applyScroll();
      if (!entry.current) return;
      const svg = svgRef.current;
      if (el.clientWidth <= 0 || !svg || svg.getBoundingClientRect().width <= 0) return;
      entry.current = false;
      // 減少動態時照樣算播過了（上游同樣清掉旗標）。
      if (prefersReducedMotion()) {
        setPending(false);
        return;
      }
      // generation 在排程時取：等視窗看得到、等焦點的期間 settleMotion 過，都算過期。
      const generation = motionGeneration();
      cancelVisible = whenVisible(() => (variant === "dashboard" ? playDashboardEntry(generation) : playWidgetEntry(generation)));
    };
    settle();
    if (typeof ResizeObserver === "undefined") {
      const frame = requestAnimationFrame(() => requestAnimationFrame(settle));
      return () => {
        cancelAnimationFrame(frame);
        cancelVisible();
      };
    }
    const observer = new ResizeObserver(settle);
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelVisible();
    };
  }, [width, variant, trend]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    el.classList.toggle("is-scrolled", el.scrollLeft > 2);
    const record = homeActivityScrollRecord({ scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
    // 還沒排好或看不到時不記（避免存下錯的位置）。
    if (record) {
      scrollMemory.left = record.scrollLeft;
      scrollMemory.followEnd = record.followEnd;
    }
    if (programmatic.current) {
      programmatic.current = false;
      restoreHover();
      return;
    }
    hide();
  };
  // 滑鼠可以拖著橫向捲動（觸控本來就能捲，不攔）；上游 homeActivityScroll 的 pointer 拖曳。
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    e.preventDefault();
    drag.current = { id: e.pointerId, x: e.clientX, left: e.currentTarget.scrollLeft };
    e.currentTarget.classList.add("is-dragging");
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* 指標已經不在（例如合成的事件）：照樣拖，只是放開在元素外時收不到 pointerup */
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      e.preventDefault();
      e.currentTarget.scrollLeft = d.left - (e.clientX - d.x);
    }
    showAt(e.clientX, e.clientY, e.target);
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.classList.remove("is-dragging");
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const tooltip =
    typeof document === "undefined"
      ? null
      : createPortal(
          <div ref={tipRef} className="tm-heat-tooltip" role="tooltip" aria-hidden={!tip} data-visible={tip ? "true" : "false"}>
            <span className="tm-heat-tooltip-row">
              <span className="tm-heat-tooltip-count">{tip ? fmtTokens(tip.tokens) : ""}</span>
              {/* 上游這個字固定是英文 tokens，不翻譯。 */}
              <span className="tm-heat-tooltip-label">tokens</span>
            </span>
            <span className="tm-heat-tooltip-date">{tip?.date ?? ""}</span>
          </div>,
          document.body,
        );

  return (
    // min-w-0：外層是 grid 的項目，不設的話 624 px 的熱力圖會把整欄撐寬（捲動容器本身的最小寬度才是 0）。
    <div className={pending && !reduced ? "tm-heat-pending min-w-0" : "min-w-0"}>
      <div
        ref={scroller}
        data-home-activity-scroll=""
        tabIndex={0}
        role="region"
        aria-label={t("近 12 個月 Token 活動，可橫向捲動")}
        className="tm-heat-scroll outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        onScroll={onScroll}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={hide}
      >
        <svg ref={svgRef} width={width} height={gridH + 14} viewBox={`0 0 ${width} ${gridH + 14}`} role="img" aria-label={t("活動")} className="block select-none overflow-visible">
          <defs>
            <filter id={GLOW_FILTER_ID} className="tm-heat-glow" x="-80%" y="-80%" width="260%" height="260%" colorInterpolationFilters="sRGB">
              <feDropShadow className="tm-heat-glow-shadow" dx="0" dy="0" stdDeviation="2.1" floodOpacity="0.95" />
              <feDropShadow className="tm-heat-glow-shadow" dx="0" dy="0" stdDeviation="4.2" floodOpacity="0.42" />
            </filter>
            <radialGradient ref={gradientRef} id={gradientId} gradientUnits="userSpaceOnUse" cx={SPOT_HIDDEN.x} cy={SPOT_HIDDEN.y} r={M.spotlightRadius}>
              <stop offset="0" stopColor="white" stopOpacity="1" />
              <stop offset="0.35" stopColor="white" stopOpacity="0.62" />
              <stop offset="0.75" stopColor="white" stopOpacity="0" />
            </radialGradient>
            <mask id={maskId}>
              <rect x="0" y="0" width={width} height={gridH} fill={`url(#${gradientId})`} />
            </mask>
          </defs>
          <g className="tm-heat-base">
            {map.cells.map((c) => (
              <rect
                key={c.date}
                data-d={c.date}
                data-t={c.tokens}
                data-col={c.col}
                x={c.col * (CELL + GAP)}
                y={c.row * (CELL + GAP)}
                width={CELL}
                height={CELL}
                rx={RADIUS}
                className={c.level > 0 ? "tm-heat fill-info" : "tm-heat fill-fg/[0.07]"}
                fillOpacity={c.level > 0 ? LEVEL_ALPHA[c.level] : undefined}
              />
            ))}
          </g>
          <g className="tm-heat-bright-layer" mask={`url(#${maskId})`} aria-hidden="true">
            {map.cells.map((c) => (
              <rect key={c.date} x={c.col * (CELL + GAP)} y={c.row * (CELL + GAP)} width={CELL} height={CELL} rx={RADIUS} className={`tm-heat-bright lvl-${c.level}`} />
            ))}
          </g>
          {map.monthLabels.map((m) => (
            <text key={m.month} x={m.col * (CELL + GAP)} y={gridH + 12} className="fill-fg/40 text-[9px]">
              {monthName(m.month)}
            </text>
          ))}
        </svg>
      </div>
      {tooltip}
    </div>
  );
}

function drawTrend(trend: TrendDraw) {
  if (trend.draw) trend.draw();
  else trend.pending = true;
}

function TrendLine({ view, trend }: { view: TrendsView; trend: MutableRefObject<TrendDraw> }) {
  const box = useRef<HTMLDivElement>(null);
  const lineRef = useRef<SVGPathElement>(null);
  const fillRef = useRef<SVGPathElement>(null);
  // 量到的像素寬度（還沒量到時 null）：viewBox 與畫面 1:1，線寬 2、圓端點（上游 .area-line-stroke），
  // getTotalLength() 才是畫面上的長度，描線動畫的虛線長度才對。
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const t = trend.current;
    if (width === null) {
      t.draw = null;
      return;
    }
    // 上游 animateHomeHistoryVisuals 的趨勢線：描出線條、面積由左往右展開，920 ms。
    t.draw = () => {
      if (prefersReducedMotion()) return;
      const line = lineRef.current;
      const length = line?.getTotalLength?.() ?? 0;
      if (line && length > 0) {
        line.animate?.(
          [
            { strokeDasharray: `${length} ${length}`, strokeDashoffset: length },
            { strokeDasharray: `${length} ${length}`, strokeDashoffset: 0 },
          ],
          { duration: M.homeHistoryMs, easing: EASE_DATA, fill: "backwards" },
        );
      }
      fillRef.current?.animate?.([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], {
        duration: M.homeHistoryMs,
        easing: EASE_DATA,
        fill: "backwards",
      });
    };
    if (t.pending) {
      t.pending = false;
      t.draw();
    }
  });
  // 上游 clampDaily(points, 45)：最後 45 列（有用量的日子，不補空白）。
  const rows = view.daily.slice(-TREND_ROWS);
  const peak = longRangePeakDayTokens({ historySummary: view.summary, daily: rows });
  const { dates } = homeTrendSummary(rows);
  const w = width ?? 300;
  const chart = areaChart(
    rows.map((r) => ({ label: r.date, value: r.tokens })),
    w,
    70,
    HOME_TREND_PAD,
  );
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between gap-2 text-2xs text-fg/45">
        <span className="font-medium text-fg/70">{t("趨勢")}</span>
        <span className="num">{t("峰值 {value}", { value: fmtTokens(peak) })}</span>
      </div>
      <div ref={box}>
        <svg viewBox={`0 0 ${w} 70`} className="block h-[70px] w-full" role="img" aria-label={t("趨勢")}>
          <path ref={fillRef} d={chart.area} className="fill-info/15" />
          <path ref={lineRef} d={chart.line} className="fill-none stroke-info" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="grid grid-cols-3 text-[9px] text-fg/40">
        {dates.map((d, i) => (
          <span key={`${d}-${i}`} className={i === 0 ? "text-left" : i === 1 ? "text-center" : "text-right"}>
            {shortLabel({ label: d, kind: "date" })}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 「活躍 N 天」或「近 12 個月活躍 N 天」（設定 `homeActiveDaysWindow`）。 */
export function activeDaysLabel(view: TrendsView, metric: HeatMetric, window: "all" | "year"): string {
  const count = activeDaysCount(view, rollingYearHeatmap(view.daily, view.today, metric), window).toLocaleString("en-US");
  return window === "year" ? t("近 12 個月活躍 {count} 天", { count }) : t("活躍 {count} 天", { count });
}

/**
 * 熱力圖 + 趨勢線。掛上時播一次進場動畫（上游只在切進主頁時播，更新數字時不播）：
 * widget 是看得到的格子依欄位由左到右淡入（640 ms），儀表板是等視窗有焦點後全部依 x 淡入（720 ms）；
 * 同時趨勢線描出來、面積由左往右展開。減少動態時不播。
 */
export function ActivityBody({ view, metric, variant = "widget" }: { view: TrendsView; metric: HeatMetric; variant?: ActivityVariant }) {
  const trend = useRef<TrendDraw>({ pending: false, draw: null });
  const map = useMemo(() => rollingYearHeatmap(view.daily, view.today, metric), [view, metric]);
  return (
    <div className="grid gap-3">
      <Heatmap map={map} variant={variant} trend={trend} />
      <TrendLine view={view} trend={trend} />
    </div>
  );
}
