// 儀表板的「趨勢」圖（上游 dashboard.js 的 Trends 分頁）：最近 7／30／90／365 列或全部，依工具或模型
// 堆疊的每日長條（附圖例），或每根代表幾天的 K 線（開 = 第一天、收 = 最後一天、高／低 = 最忙／最閒）。
// 資料是本機的每日歷史（history_series_get），模型名稱照設定的別名合併。

import { useEffect, useRef, useState } from "react";
import { api, type SeriesDay } from "./api";
import { clientLabel, seriesColor } from "./clients";
import {
  axisEvery,
  bucketDaysFor,
  candleModel,
  CHART_PAD,
  clampDaily,
  dailyBarsModel,
  legendRows,
} from "./dashboardCharts";
import { stableColor } from "./detailFormat";
import { fmtTokens } from "./format";
import { t } from "./i18n";
import { foldMap } from "./modelAliases";
import { Segmented } from "./ui";
import { useFetched } from "./useFetched";
import { useResolveModel } from "./useModelAlias";

type Range = "7" | "30" | "90" | "365" | "all";
type Mode = "bars" | "kline";
type Stack = "client" | "model";

const HEIGHT = 260;
const MODEL_COLORS = ["#7aa2ff", "#f59e0b", "#34d399", "#f472b6", "#a78bfa", "#22d3ee", "#fb923c", "#a3e635", "#f87171", "#facc15"];

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
  const [range, setRange] = useState<Range>("30");
  const [mode, setMode] = useState<Mode>("bars");
  const [stack, setStack] = useState<Stack>("client");
  const [ref, width] = useWidth();
  const resolve = useResolveModel();
  const all = useFetched(() => api.historySeriesGet(), "series");
  const series = clampDaily(all ?? [], range === "all" ? 0 : Number(range)).map((d) => ({ ...d, models: foldMap(d.models, resolve) }));
  const color = (key: string, i: number) => (stack === "client" ? seriesColor(key, i) : stableColor(key, MODEL_COLORS));
  const label = (key: string) => (stack === "client" ? clientLabel(key) : key);

  let chart: React.ReactNode = <div className="py-10 text-center text-xs text-fg/45">{t("尚無使用歷史")}</div>;
  let legend: React.ReactNode = null;
  if (series.length && mode === "bars") {
    const m = dailyBarsModel(series as SeriesDay[], stack, width, HEIGHT);
    const every = axisEvery(m.bars.length);
    chart = (
      <svg width={width} height={HEIGHT} role="img" aria-label={t("趨勢")}>
        <YAxis max={m.maxTotal} plot={m.plot} />
        {m.bars.map((bar, i) => (
          <g key={bar.label}>
            <title>
              {[`${shortDate(bar.label)} · ${fmtTokens(bar.total)}`, ...[...bar.segments].sort((a, b) => b.value - a.value).map((s) => `${label(s.key)} ${fmtTokens(s.value)}`)].join("\n")}
            </title>
            {bar.segments.map((s) => (
              <rect key={s.key} x={bar.x} y={s.y} width={bar.width} height={Math.max(0, s.height)} fill={color(s.key, m.keys.indexOf(s.key))} />
            ))}
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
              <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: color(r.key, m.keys.indexOf(r.key)) }} />
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
    const every = axisEvery(m.candles.length);
    chart = (
      <svg width={width} height={HEIGHT} role="img" aria-label={t("K 線")}>
        <YAxis max={m.maxVal} plot={m.plot} />
        {m.candles.map((c, i) => {
          const tone = c.up ? "stroke-success fill-success" : "stroke-danger fill-danger";
          return (
            <g key={c.key} className={tone}>
              <title>
                {[
                  c.endKey !== c.key ? `${shortDate(c.key)} – ${shortDate(c.endKey)}` : shortDate(c.key),
                  `O ${fmtTokens(c.open)}`,
                  `H ${fmtTokens(c.high)}`,
                  `L ${fmtTokens(c.low)}`,
                  `C ${fmtTokens(c.close)}`,
                ].join("\n")}
              </title>
              <line x1={c.wickX} x2={c.wickX} y1={c.yHigh} y2={c.yLow} strokeWidth={1} />
              <rect x={c.x} y={c.bodyY} width={c.width} height={c.bodyHeight} />
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
