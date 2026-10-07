// 桌面小工具本體：本機或全公司的今日／本月／全部 token 與等值成本，依工具、模型、專案或 session 拆分。

import { getCurrentWindow } from "@tauri-apps/api/window";
import { LayoutDashboard, Monitor, Pin, PinOff, RefreshCw, Settings as SettingsIcon, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, isTauri, type AppStatus, type PeriodDetail, type PeriodName, type PeriodTotals, type RangeName, type WindowMode } from "./api";
import { BreakdownList } from "./Breakdown";
import { CompanyPanel, CompanyRangePanel } from "./Company";
import { ProjectList, SessionList, UsageList, usePeriodDetail } from "./Detail";
import { HistoryStrip } from "./History";
import { BubbleHandle, useBubble, useBubbleSync, useEscToCollapse } from "./Bubble";
import { LimitsPanel } from "./LimitsPanel";
import { ServiceStatusPanel } from "./ServiceStatus";
import { TrendsPanel } from "./Trends";
import { fmtAgo, fmtTime, fmtTokens, fmtUsd, uncachedInput } from "./format";
import { useApp, type Breakdown, type Tab } from "./store";
import { t } from "./i18n";
import { IconButton, Segmented } from "./ui";
import { zoomFromKey } from "./shortcut";
import { isRange, MONTH_MODES, monthModeLabel, shortDate, slotOf, weekStartDay } from "./periods";
import { useFetched } from "./useFetched";
import { AverageRate, LiveRate } from "./Rate";
import { UpdatePill } from "./UpdatePill";

const TABS: { value: Tab; label: string }[] = [
  { value: "local", label: t("本機") },
  { value: "company", label: t("全公司") },
  { value: "limits", label: t("額度") },
  { value: "trends", label: t("趨勢") },
];


function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function StatusDot({ status }: { status: AppStatus | null }) {
  if (!status) return <span className="h-2 w-2 rounded-full bg-fg/30" />;
  const color = status.fatal || status.uploadState === "error"
    ? "bg-danger"
    : status.uploadState === "ok"
      ? "bg-success"
      : status.uploadState === "pending"
        ? "bg-warning"
        : "bg-fg/40";
  return <span className={`h-2 w-2 rounded-full ${color} ${status.collecting ? "pulse" : ""}`} />;
}

/** 上游標題列的釘選鈕：浮動 → 標準 → 桌面 → 浮動（系統匣模式不在循環裡，widget 平常看不到）。 */
const NEXT_MODE: Record<WindowMode, WindowMode> = { floating: "normal", normal: "desktop", desktop: "floating", tray: "floating" };
const MODE_TITLE: Record<WindowMode, string> = {
  floating: t("浮動（永遠在最上層）；按一下改為標準"),
  normal: t("標準視窗；按一下改為桌面"),
  desktop: t("桌面（最底層）；按一下改為浮動"),
  tray: t("系統匣"),
};

function PinButton() {
  const mode = useApp((s) => s.settings?.windowMode ?? "floating");
  const updateSettings = useApp((s) => s.updateSettings);
  const Icon = mode === "floating" ? Pin : mode === "desktop" ? Monitor : PinOff;
  return (
    <IconButton title={MODE_TITLE[mode]} onClick={() => void updateSettings({ windowMode: NEXT_MODE[mode] })}>
      <Icon size={13} />
    </IconButton>
  );
}

function Header() {
  const status = useApp((s) => s.status);
  const desktop = useApp((s) => s.settings?.windowMode === "desktop");
  const drag = desktop ? {} : { "data-tauri-drag-region": true };
  return (
    <header className="flex items-center gap-2 px-3 pb-1 pt-2.5" {...drag}>
      <StatusDot status={status} />
      <span className="flex-1 text-xs font-medium text-fg/80" {...drag}>
        Token Monitor
      </span>
      <IconButton title={t("立即重新掃描")} onClick={() => void api.usageRescan()} disabled={status?.collecting}>
        <RefreshCw size={13} className={status?.collecting ? "animate-spin" : ""} />
      </IconButton>
      <IconButton title={t("用量儀表板")} onClick={() => void api.windowOpenDashboard()}>
        <LayoutDashboard size={13} />
      </IconButton>
      <PinButton />
      <IconButton title={t("設定")} onClick={() => void api.windowOpenSettings()}>
        <SettingsIcon size={13} />
      </IconButton>
      <IconButton title={t("收到系統匣")} onClick={() => void api.windowHide()}>
        <X size={14} />
      </IconButton>
    </header>
  );
}

function Totals({ p, span }: { p: PeriodTotals; span?: { start: string; end: string } }) {
  const parts = [
    { label: t("快取讀取"), value: p.cacheReadTokens },
    { label: t("快取寫入"), value: p.cacheWriteTokens },
    { label: t("輸入"), value: uncachedInput(p) },
    { label: t("輸出"), value: p.outputTokens },
  ];
  return (
    <div className="px-3">
      <div className="flex items-baseline justify-between">
        <div className="num text-3xl font-semibold tracking-tight">{fmtTokens(p.totalTokens)}</div>
        <div className="num text-lg text-fg/80" title={t("依 API 牌價換算的等值成本，不是實際帳單")}>
          {fmtUsd(p.costUsd)}
        </div>
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 text-2xs text-fg/45">
        <span className="truncate">
          {span ? `tokens · ${shortDate(span.start)}–${shortDate(span.end)}` : t("tokens · {n} 個 session", { n: p.sessionCount })}
        </span>
        <AverageRate p={p} />
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1">
        {parts.map((x) => (
          <div key={x.label} className="rounded-sm bg-inset px-1.5 py-1">
            <div className="text-2xs text-fg/45">{x.label}</div>
            <div className="num text-xs">{fmtTokens(x.value)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 連著公司 hub 卻還沒填公司信箱時的提醒：hub 沒有信箱就只能靠 AI 帳號猜這台是誰的，
// 猜不到的裝置不會出現在公司與部門的統計裡。× 只在這次開啟期間收起，下次啟動再提醒。
function OwnerEmailPill() {
  const needed = useApp((s) => Boolean(s.status?.hubUrl) && s.settings?.ownerEmail === "");
  const [hidden, setHidden] = useState(false);
  if (!needed || hidden) return null;
  return (
    <div className="mx-3 mb-1 flex items-center gap-2 rounded-sm bg-accent/15 px-2 py-1 text-2xs">
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left hover:underline"
        onClick={() => void api.windowOpenSettings()}
      >
        {t("填上公司信箱，讓 hub 對應到你的部門")}
      </button>
      <button type="button" className="shrink-0 text-fg/45 hover:text-fg" title={t("稍後再說")} onClick={() => setHidden(true)}>
        ×
      </button>
    </div>
  );
}

function StatusBar() {
  const status = useApp((s) => s.status);
  const now = useNow(30_000);
  let text: string;
  let tone = "text-fg/45";
  if (!status) text = t("啟動中…");
  else if (status.fatal) {
    text = status.fatal;
    tone = "text-danger";
  } else if (status.lastCollectError) {
    text = t("掃描失敗：{e}", { e: status.lastCollectError });
    tone = "text-danger";
  } else if (status.uploadState === "disabled") {
    text = t("本機模式（未設定公司 hub）· 掃描於 {t}", { t: fmtTime(status.lastCollectAt) });
  } else if (status.uploadState === "error") {
    text = t("上傳失敗：{e}", { e: status.lastUploadError ?? "" });
    tone = "text-danger";
  } else if (status.uploadState === "pending") {
    text = status.collecting ? t("第一次掃描中…") : t("等待上傳…");
  } else {
    const next = status.nextUploadAt ? t(" · 下次 {t}", { t: fmtTime(status.nextUploadAt) }) : "";
    text = t("已上傳 {ago}{next}", { ago: fmtAgo(status.lastUploadAt, now), next });
  }
  return (
    <footer className="flex items-baseline gap-2 px-3 pb-2 pt-1 text-2xs">
      <span className={`min-w-0 flex-1 truncate ${tone}`} title={text}>
        {text}
      </span>
      <LiveRate />
    </footer>
  );
}

function ResizeGrip() {
  const desktop = useApp((s) => s.settings?.windowMode === "desktop");
  if (desktop || !isTauri()) return null;
  return (
    <div
      className="absolute bottom-0 right-0 h-3 w-3 cursor-se-resize"
      onMouseDown={(e) => {
        if (e.button === 0) void getCurrentWindow().startResizeDragging("SouthEast");
      }}
    />
  );
}

/** 本機的工具／模型／專案／session 清單；明細還沒拉到時先用 LocalStats 的簡易清單墊著。 */
function LocalBreakdown({ p, period }: { p: PeriodTotals; period: PeriodName }) {
  const breakdown = useApp((s) => s.breakdown);
  const projectsEnabled = useApp((s) => s.settings?.projectsEnabled ?? true);
  const detail = usePeriodDetail(period);
  const view = !projectsEnabled && breakdown === "project" ? "client" : breakdown;
  const simple = <BreakdownList p={p} by={view === "model" ? "model" : "client"} />;
  if (view === "session") {
    // 沒有 session 明細但有用量時改顯示模型（上游同樣的退路）。
    return <SessionList key={period} period={period} fallback={detail ? <UsageList rows={detail.models} kind="model" /> : simple} />;
  }
  if (!detail) return simple;
  if (view === "project") return <ProjectList rows={detail.projects} />;
  return <UsageList rows={view === "model" ? detail.models : detail.tools} kind={view === "model" ? "model" : "client"} />;
}

const centered = (text: string) => <div className="px-3 py-10 text-center text-xs text-fg/45">{text}</div>;

/** 範圍的清單只有工具與模型（每日歷史沒有 session 與專案，上游同樣不提供）。 */
function RangeBreakdown({ detail }: { detail: PeriodDetail }) {
  const stored = useApp((s) => s.breakdown);
  const projectsEnabled = useApp((s) => s.settings?.projectsEnabled ?? true);
  const breakdown = !projectsEnabled && stored === "project" ? "client" : stored;
  if (breakdown === "project") return centered(t("此範圍不提供專案明細。"));
  if (breakdown === "session") return centered(t("此範圍不提供 session 明細。"));
  return <UsageList rows={breakdown === "model" ? detail.models : detail.tools} kind={breakdown === "model" ? "model" : "client"} />;
}

function RangePanel({ range }: { range: RangeName }) {
  const local = useApp((s) => s.local);
  const status = useApp((s) => s.status);
  const updateSettings = useApp((s) => s.updateSettings);
  const r = useFetched(() => api.rangeGet(range, weekStartDay()), range);
  if (!r) return centered(t("正在載入歷史記錄…"));
  if (r.status === "disabled") {
    return (
      <div className="flex flex-col items-center gap-3 px-3 py-10 text-center text-xs text-fg/45">
        {t("請啟用每日歷史以使用本星期、最近 7 日與最近 30 日。")}
        <button type="button" className="text-accent hover:underline" onClick={() => void updateSettings({ historyEnabled: true })}>
          {t("前往啟用")}
        </button>
      </div>
    );
  }
  if (r.status === "loading") return centered(status?.historyError ? t("歷史記錄暫時無法使用。") : t("正在載入歷史記錄…"));
  return (
    <>
      <Totals p={r.totals} span={r} />
      {local?.history && <HistoryStrip history={local.history} />}
      <div className="mx-3 my-3 border-t border-fg/10" />
      <RangeBreakdown detail={r.detail} />
    </>
  );
}

function LocalPanel() {
  const { local, period: selection, ready, error } = useApp();
  if (isRange(selection)) return <RangePanel range={selection} />;
  const period = selection;
  const p = local?.periods[period];
  if (!p) {
    return (
      <div className="px-3 py-10 text-center text-xs text-fg/45">
        {error ? error : ready ? t("正在掃描本機用量…") : t("啟動中…")}
      </div>
    );
  }
  return (
    <>
      <Totals p={p} />
      {local.history && <HistoryStrip history={local.history} />}
      <div className="mx-3 my-3 border-t border-fg/10" />
      <LocalBreakdown p={p} period={period} />
    </>
  );
}

/**
 * 今日／（本月或範圍）／全部。中間那格顯示目前的模式；已經選在中間時再點一次打開選單，
 * 可改成本月、本星期、最近 7 日或最近 30 日（上游 period 選單）。
 */
function PeriodPicker() {
  const { period, monthMode, setPeriod } = useApp();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const slot = slotOf(period);
  const options: { value: PeriodName; label: string }[] = [
    { value: "today", label: t("今日") },
    // ▾ 提示中間那格可以換成其他範圍。
    { value: "month", label: `${monthModeLabel(monthMode)} ▾` },
    { value: "allTime", label: t("全部") },
  ];
  return (
    <div ref={box} className="relative">
      <Segmented
        value={slot}
        options={options}
        onChange={(v) => {
          if (v !== "month") {
            setOpen(false);
            setPeriod(v);
          } else if (slot === "month") setOpen(!open);
          else setPeriod(monthMode);
        }}
      />
      {open && (
        <div role="menu" className="absolute left-10 top-full z-10 mt-1 min-w-[8rem] rounded-sm border border-fg/10 bg-elevated py-1 text-xs shadow-lg">
          {MONTH_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={period === m}
              className={`block w-full px-3 py-1 text-left hover:bg-fg/10 ${period === m ? "text-accent" : ""}`}
              onClick={() => {
                setPeriod(m);
                setOpen(false);
              }}
            >
              {monthModeLabel(m)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BreakdownPicker() {
  const { tab, breakdown, setBreakdown } = useApp();
  const projectsEnabled = useApp((s) => s.settings?.projectsEnabled ?? true);
  const options: { value: Breakdown; label: string }[] = [
    { value: "client", label: t("工具") },
    { value: "model", label: t("模型") },
  ];
  // 專案與 session 只有本機有（hub 串流只帶工具與模型的彙總）。
  if (tab === "local") {
    if (projectsEnabled) options.push({ value: "project", label: t("專案") });
    options.push({ value: "session", label: "Session" });
  }
  const value = options.some((o) => o.value === breakdown) ? breakdown : "client";
  return <Segmented size="xs" value={value} options={options} onChange={setBreakdown} />;
}

function TabBody({ tab }: { tab: Tab }) {
  const { period, breakdown, company, status, limits, settings } = useApp();
  if (tab === "company") {
    // hub 串流只有 today / month / allTime；範圍改用 hub 合併好的每日歷史。
    if (isRange(period)) return <CompanyRangePanel range={period} status={status} breakdown={breakdown === "model" ? "model" : "client"} />;
    return <CompanyPanel company={company} status={status} period={period} breakdown={breakdown === "model" ? "model" : "client"} />;
  }
  if (tab === "trends") {
    return <TrendsPanel period={period} />;
  }
  if (tab === "limits") {
    return (
      <>
        <LimitsPanel limits={limits} enabled={settings?.limitsEnabled ?? true} />
        <div className="mx-3 my-3 border-t border-fg/10" />
        <ServiceStatusPanel />
      </>
    );
  }
  return <LocalPanel />;
}

function useZoomKeys() {
  const zoom = useApp((s) => s.settings?.zoomFactor ?? 1);
  const updateSettings = useApp((s) => s.updateSettings);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const next = zoomFromKey(e.key, e.ctrlKey || e.metaKey, zoom);
      if (next === null) return;
      e.preventDefault();
      if (next !== zoom) void updateSettings({ zoomFactor: next });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom, updateSettings]);
}

export default function Widget() {
  const { tab, setTab } = useApp();
  useZoomKeys();
  const historyEnabled = useApp((s) => s.settings?.historyEnabled ?? true);
  // 趨勢是本機 history 畫的：history 關閉時不顯示這個分頁（上游同樣移除 Trends 視圖）。
  const tabs = historyEnabled ? TABS : TABS.filter((x) => x.value !== "trends");
  const shownTab = tabs.some((x) => x.value === tab) ? tab : "local";
  useBubbleSync();
  useEscToCollapse();
  const collapsed = useBubble((s) => s.collapsed);
  if (collapsed) return <BubbleHandle />;
  return (
    <div className="widget-shell relative flex h-full flex-col overflow-hidden">
      <Header />
      <div className="px-3 pb-2">
        <Segmented value={shownTab} options={tabs} onChange={setTab} />
      </div>
      {shownTab !== "limits" && (
        <div className="flex flex-wrap items-center justify-between gap-1 px-3 pb-2">
          <PeriodPicker />
          {shownTab !== "trends" && <BreakdownPicker />}
        </div>
      )}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-2">
        <TabBody tab={shownTab} />
      </div>
      <UpdatePill />
      <OwnerEmailPill />
      <StatusBar />
      <ResizeGrip />
    </div>
  );
}
