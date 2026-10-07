// 儀表板的「趨勢」圖（上游 dashboard.js 的 Trends 分頁）：最近 7／30／90／365 列或全部，依工具或模型
// 堆疊的每日長條（附圖例），或每根代表幾天的 K 線（開 = 第一天、收 = 最後一天、高／低 = 最忙／最閒）。
// 資料是本機的每日歷史（history_series_get），模型名稱照設定的別名合併。
// 動畫照上游 dashboard.js 的 `animateChartGeometry`（堆疊長條 FLIP／從底部長出）與 `animateCandles`。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type SeriesDay } from "./api";
import { clientLabel } from "./clients";
import {
  axisEvery,
  bucketDaysFor,
  candleModel,
  CHART_PAD,
  clampDaily,
  dailyBarsModel,
  legendRows,
  type Bar,
} from "./dashboardCharts";
import { fmtTokens } from "./format";
import { t } from "./i18n";
import { foldMap } from "./modelAliases";
import { dashCandleDelay, dashStackDelay, EASE_DATA, M, stackFlipFirst, type Rect } from "./motion";
import { prefersReducedMotion } from "./motionRuntime";
import { Segmented } from "./ui";
import { useFetched } from "./useFetched";
import { useResolveModel } from "./useModelAlias";
import { useVendorColors } from "./useVendorColors";
import { clientColor, displayColor, modelColor } from "./vendorColors";

type Range = "7" | "30" | "90" | "365" | "all";
type Mode = "bars" | "kline";
type Stack = "client" | "model";
/**
 * 這次重畫要怎麼動（上游 dashboard.js state.motion）：第一次有資料 `entry`、資料更新與換範圍或圖種
 * `update`、換堆疊方式 `series`，其他（視窗寬度變了）`none`。
 */
type Motion = "entry" | "update" | "series" | "none";

const HEIGHT = 260;

function shortDate(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
  return m ? `${Number(m[2])}/${Number(m[3])}` : key;
}

function useWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setWidth(Math.max(320, Math.floor(entries[0].contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** 一根堆疊長條在圖上的範圍（從模型算，不量 DOM：捲動或正在動畫都不影響）。 */
function stackRect(bar: Bar, plotBottom: number): Rect {
  const shown = bar.segments.filter((seg) => seg.height > 0);
  const top = shown.length ? Math.min(...shown.map((seg) => seg.y)) : plotBottom;
  return { left: bar.x, top, width: bar.width, height: shown.reduce((sum, seg) => sum + seg.height, 0) };
}

/** 上游 animateCandles：每根 K 線的實體從中間展開、影線描出來，560 ms，依序延遲 10 ms。 */
function animateCandles(root: HTMLElement) {
  root.querySelectorAll<SVGGElement>(".candle-stack").forEach((candle, index) => {
    const delay = dashCandleDelay(index);
    candle.querySelector<SVGRectElement>(".tm-candle-body")?.animate?.(
      [
        { transform: "scaleY(0)", transformOrigin: "center center" },
        { transform: "scaleY(1)", transformOrigin: "center center" },
      ],
      { duration: M.dashKlineMs, delay, easing: EASE_DATA, fill: "backwards" },
    );
    for (const wick of Array.from(candle.querySelectorAll<SVGLineElement>(".candle-wick"))) {
      const length = wick.getTotalLength?.() ?? 0;
      if (length <= 0) continue;
      wick.animate?.(
        [
          { strokeDasharray: `${length} ${length}`, strokeDashoffset: length },
          { strokeDasharray: `${length} ${length}`, strokeDashoffset: 0 },
        ],
        { duration: M.dashKlineMs, delay, easing: EASE_DATA, fill: "backwards" },
      );
    }
  });
}

function YAxis({ max, plot }: { max: number; plot: { x: number; y: number; w: number; h: number } }) {
  return (
    <>
      {[0, 1, 2, 3, 4].map((i) => {
        const y = plot.y + plot.h - (plot.h * i) / 4;
        return (
          <g key={i}>
            <line x1={plot.x} x2={plot.x + plot.w} y1={y} y2={y} className="stroke-fg/10" />
            <text x={plot.x - 6} y={y + 3} textAnchor="end" className="fill-fg/40 text-[10px]">
              {fmtTokens((max * i) / 4)}
            </text>
          </g>
        );
      })}
    </>
  );
}

export function DashboardTrends() {
  const [range, setRangeState] = useState<Range>("30");
  const [mode, setModeState] = useState<Mode>("bars");
  const [stack, setStackState] = useState<Stack>("client");
  const [ref, width] = useWidth();
  const resolve = useResolveModel();
  const colors = useVendorColors();
  const all = useFetched(() => api.historySeriesGet(), "series");
  const motion = useRef<Motion>("entry");
  const prevAll = useRef<SeriesDay[] | null>(null);
  /** 上一次畫的圖種與每根堆疊長條的範圍（依日期）。 */
  const geometry = useRef<{ kind: Mode | null; rects: Map<string, Rect> }>({ kind: null, rects: new Map() });
  // 點已經選著的按鈕什麼都不做（上游每個按鈕都先比對 `if (state.range === …) return`）：Segmented 照樣
  // 呼叫 onChange、React 不重畫，先記下的動作會留到下一次不相干的重畫（資料更新、視窗寬度變了）才播。
  const setRange = (v: Range) => {
    if (v === range) return;
    motion.current = "update";
    setRangeState(v);
  };
  const setMode = (v: Mode) => {
    if (v === mode) return;
    motion.current = "update";
    setModeState(v);
  };
  const setStack = (v: Stack) => {
    if (v === stack) return;
    motion.current = "series";
    setStackState(v);
  };
  const series = clampDaily(all ?? [], range === "all" ? 0 : Number(range)).map((d) => ({ ...d, models: foldMap(d.models, resolve) }));
  // 上游 dashboard.js colorFor：工具用廠商色、模型用 modelColor，都經過 displayColor 把近黑提亮。
  const color = (key: string) => displayColor(stack === "client" ? clientColor(colors, key) : modelColor(colors, key));
  const label = (key: string) => (stack === "client" ? clientLabel(key) : key);

  let chart: React.ReactNode = <div className="py-10 text-center text-xs text-fg/45">{t("尚無使用歷史")}</div>;
  let legend: React.ReactNode = null;
  /** 這次畫出來的圖（給下面的動畫用）。 */
  let drawn: { kind: "bars"; bars: Bar[]; plotBottom: number } | { kind: "kline" } | null = null;
  if (series.length && mode === "bars") {
    const m = dailyBarsModel(series as SeriesDay[], stack, width, HEIGHT);
    drawn = { kind: "bars", bars: m.bars, plotBottom: m.plot.y + m.plot.h };
    const every = axisEvery(m.bars.length);
    chart = (
      <svg width={width} height={HEIGHT} role="img" aria-label={t("趨勢")}>
        <YAxis max={m.maxTotal} plot={m.plot} />
        {m.bars.map((bar, i) => (
          <g key={bar.label}>
            <title>
              {[`${shortDate(bar.label)} · ${fmtTokens(bar.total)}`, ...[...bar.segments].sort((a, b) => b.value - a.value).map((s) => `${label(s.key)} ${fmtTokens(s.value)}`)].join("\n")}
            </title>
            {/* 動畫只縮放長條本身，軸上的日期不跟著縮（上游 .bar-stack）。 */}
            <g className="tm-bar-stack" data-motion-key={bar.label}>
              {bar.segments.map((s) => (
                <rect key={s.key} x={bar.x} y={s.y} width={bar.width} height={Math.max(0, s.height)} fill={color(s.key)} />
              ))}
            </g>
            {i % every === 0 && (
              <text x={bar.x + bar.width / 2} y={HEIGHT - 8} textAnchor="middle" className="fill-fg/40 text-[10px]">
                {shortDate(bar.label)}
              </text>
            )}
          </g>
        ))}
      </svg>
    );
    legend = (
      <div className="mt-2 grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
        {legendRows(m).map((r) => (
          <div key={r.key} className="flex items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: color(r.key) }} />
              <span className="truncate">{label(r.key)}</span>
            </span>
            <span className="num shrink-0 text-fg/60">
              {fmtTokens(r.value)} <span className="text-fg/40">{r.pct.toFixed(1)}%</span>
            </span>
          </div>
        ))}
      </div>
    );
  } else if (series.length) {
    const plotWidth = width - CHART_PAD.left - CHART_PAD.right;
    const m = candleModel(series as SeriesDay[], bucketDaysFor(series as SeriesDay[], plotWidth), width, HEIGHT);
    drawn = { kind: "kline" };
    const every = axisEvery(m.candles.length);
    chart = (
      <svg width={width} height={HEIGHT} role="img" aria-label={t("K 線")}>
        <YAxis max={m.maxVal} plot={m.plot} />
        {m.candles.map((c, i) => {
          const tone = c.up ? "stroke-success fill-success" : "stroke-danger fill-danger";
          return (
            <g key={c.key} className={`candle-stack ${tone}`}>
              <title>
                {[
                  c.endKey !== c.key ? `${shortDate(c.key)} – ${shortDate(c.endKey)}` : shortDate(c.key),
                  `O ${fmtTokens(c.open)}`,
                  `H ${fmtTokens(c.high)}`,
                  `L ${fmtTokens(c.low)}`,
                  `C ${fmtTokens(c.close)}`,
                ].join("\n")}
              </title>
              <line className="candle-wick" x1={c.wickX} x2={c.wickX} y1={c.yHigh} y2={c.yLow} strokeWidth={1} />
              <rect className="tm-candle-body" x={c.x} y={c.bodyY} width={c.width} height={c.bodyHeight} />
              {i % every === 0 && (
                <text x={c.wickX} y={HEIGHT - 8} textAnchor="middle" className="fill-fg/40 stroke-none text-[10px]">
                  {shortDate(c.key)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    );
  }

  // 每次重畫後：有要動就動一次（之後回到 none），並記下這次的幾何給下一次 FLIP。
  useLayoutEffect(() => {
    // 重新拉到資料（新的陣列）算一次更新；第一份資料維持 entry（上游 refresh）。
    if (all !== prevAll.current) {
      if (prevAll.current !== null && all !== null && motion.current === "none") motion.current = "update";
      prevAll.current = all;
    }
    const root = ref.current;
    const shown = drawn;
    // 還沒有圖（載入中、沒有歷史）時保留這次的動作，等圖畫出來再用。
    if (!shown || !root) return;
    const kind = motion.current;
    motion.current = "none";
    const animate = kind !== "none" && !prefersReducedMotion();
    if (shown.kind === "kline") {
      if (animate) animateCandles(root);
      geometry.current = { kind: "kline", rects: new Map() };
      return;
    }
    const plotBottom = shown.plotBottom;
    const rects = new Map(shown.bars.map((bar) => [bar.label, stackRect(bar, plotBottom)]));
    if (animate) {
      const fromZero = kind === "entry" || kind === "series" || geometry.current.kind !== "bars";
      const previous = geometry.current.rects;
      root.querySelectorAll<SVGGElement>(".tm-bar-stack[data-motion-key]").forEach((stackEl, index) => {
        const key = stackEl.dataset.motionKey ?? "";
        const next = rects.get(key);
        if (!next) return;
        const first = stackFlipFirst(previous.get(key), next, fromZero);
        if (!first) return;
        for (const a of stackEl.getAnimations?.() ?? []) a.cancel();
        stackEl.animate?.(
          [
            { transformOrigin: first.transformOrigin, transform: first.transform },
            { transformOrigin: first.transformOrigin, transform: "none" },
          ],
          { duration: M.dashDataMs, delay: first.staggered ? dashStackDelay(index) : 0, easing: EASE_DATA, fill: "backwards" },
        );
      });
    }
    geometry.current = { kind: "bars", rects };
  });

  return (
    <div className="px-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Range>
          size="xs"
          value={range}
          options={[
            { value: "7", label: t("7 天") },
            { value: "30", label: t("30 天") },
            { value: "90", label: t("90 天") },
            { value: "365", label: t("1 年") },
            { value: "all", label: t("全部") },
          ]}
          onChange={setRange}
        />
        <Segmented<Mode>
          size="xs"
          value={mode}
          options={[
            { value: "bars", label: t("棒形圖") },
            { value: "kline", label: t("K 線") },
          ]}
          onChange={setMode}
        />
        {mode === "bars" && (
          <Segmented<Stack>
            size="xs"
            value={stack}
            options={[
              { value: "client", label: t("依工具") },
              { value: "model", label: t("依模型") },
            ]}
            onChange={setStack}
          />
        )}
      </div>
      <div ref={ref} className="mt-3 w-full overflow-hidden">
        {chart}
      </div>
      {legend}
    </div>
  );
}
