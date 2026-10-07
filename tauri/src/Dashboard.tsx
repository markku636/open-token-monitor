// 用量儀表板（上游 dashboard.html 的視窗）：比 widget 大的獨立視窗，上方是今日／本月／全部的摘要，
// 接著是全期間的 8 張活動卡（上游 dashboard 活動分頁的 dashCards），
// 下面左邊是趨勢（熱力圖與趨勢線是主頁活動模組的元件，期間長條與活躍統計是 widget 的趨勢視圖），
// 右邊是依工具與模型的拆分。動畫用儀表板的版本（上游 dashboard.js：熱力圖等視窗有焦點才淡入、
// 拆分的長條 800 ms），摘要與活動卡不動（上游相同）。
// 由 tray 選單或 widget 標題列開啟（src-tauri/src/gui/window.rs `open_dashboard`）。

import { useEffect } from "react";
import { api, type PeriodName } from "./api";
import { ActivityBody } from "./Activity";
import { BreakdownList } from "./Breakdown";
import { fmtTokens, fmtUsd } from "./format";
import { t } from "./i18n";
import { useApp } from "./store";
import { TrendsPanel } from "./Trends";
import { DashboardTrends } from "./DashboardTrends";
import { Segmented } from "./ui";
import { fmtActiveDuration, statCards, type StatCard, type StatCardKey } from "./trendsFormat";
import { useFetched } from "./useFetched";

const STAT_LABELS: Record<StatCardKey, string> = {
  totalTokens: t("總 Token"),
  totalCost: t("總花費"),
  activeDays: t("活躍天數"),
  currentStreak: t("連續天數"),
  activeTimeMs: t("活躍時間"),
  peakDayTokens: t("峰值單日"),
  favoriteModel: t("常用模型"),
  messages: t("訊息數"),
  longestStreak: t("最長連續天數"),
};

function statValue(c: StatCard): string {
  if (c.kind === "model") return String(c.value) || "—";
  const n = Number(c.value);
  if (c.kind === "cost") return fmtUsd(n);
  if (c.kind === "duration") return fmtActiveDuration(n);
  if (c.kind === "tokens") return fmtTokens(n);
  return n.toLocaleString("en-US");
}

/** 全期間的活動卡（上游 renderActivity 的 statsCards）：資料是 history 的 summary，沒有 history 就不顯示。 */
function ActivityCards() {
  const view = useFetched(() => api.trendsGet(), "trends");
  if (!view || !view.daily.some((d) => d.tokens > 0)) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {statCards(view.summary).map((c) => (
        <div key={c.key} className="min-w-0 rounded-sm bg-inset px-3 py-2">
          <div className="text-2xs text-fg/50">{STAT_LABELS[c.key]}</div>
          <div className={`truncate font-semibold ${c.kind === "model" ? "text-sm" : "num text-base"}`} title={statValue(c)}>
            {statValue(c)}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 熱力圖與趨勢線（主頁活動模組的內容，儀表板的進場動畫）。 */
function DashboardActivity() {
  const view = useFetched(() => api.trendsGet(), "trends");
  const metric = useApp((s) => s.settings?.heatmapMetric ?? "cost");
  if (!view || !view.daily.some((d) => d.tokens > 0)) return null;
  return (
    <div className="px-3 pb-3">
      <ActivityBody view={view} metric={metric} variant="dashboard" />
    </div>
  );
}

const PERIODS: { value: PeriodName; label: string }[] = [
  { value: "today", label: t("今日") },
  { value: "month", label: t("本月") },
  { value: "allTime", label: t("全部") },
];

function SummaryCard({ label, tokens, cost, active }: { label: string; tokens: number; cost: number; active: boolean }) {
  return (
    <div className={`rounded-sm px-3 py-2 ${active ? "bg-accent/15" : "bg-inset"}`}>
      <div className="text-2xs text-fg/50">{label}</div>
      <div className="num text-xl font-semibold">{fmtTokens(tokens)}</div>
      <div className="num text-xs text-fg/60">{fmtUsd(cost)}</div>
    </div>
  );
}

export function Dashboard() {
  const bootstrap = useApp((s) => s.bootstrap);
  // fmtUsd 讀模組層級的匯率：訂閱幣別，換了才會重繪（SummaryCard 與子元件的金額）。
  useApp((s) => s.currency);
  const local = useApp((s) => s.local);
  const period = useApp((s) => s.period);
  const setPeriod = useApp((s) => s.setPeriod);
  const historyEnabled = useApp((s) => s.settings?.historyEnabled ?? true);
  useEffect(() => {
    void bootstrap();
    document.title = t("Token Monitor 儀表板");
  }, [bootstrap]);
  const slot: PeriodName = period === "today" || period === "month" || period === "allTime" ? period : "month";
  const p = local?.periods[slot];
  return (
    <div className="scroll-thin h-full overflow-y-auto bg-app">
      <div className="mx-auto max-w-[1100px] space-y-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">{t("用量儀表板")}</h1>
          <Segmented<PeriodName> value={slot} options={PERIODS} onChange={setPeriod} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          {PERIODS.map((x) => (
            <SummaryCard
              key={x.value}
              label={x.label}
              tokens={local?.periods[x.value].totalTokens ?? 0}
              cost={local?.periods[x.value].costUsd ?? 0}
              active={x.value === slot}
            />
          ))}
        </div>
        {historyEnabled && <ActivityCards />}
        <div className="grid gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <section className="rounded-sm bg-inset py-2">
            <h2 className="px-3 pb-1 text-sm font-medium">{t("趨勢")}</h2>
            {historyEnabled ? (
              <>
                <DashboardActivity />
                <TrendsPanel period={slot} variant="dashboard" />
              </>
            ) : (
              <div className="px-3 py-6 text-center text-xs text-fg/45">{t("每日歷史已關閉，沒有趨勢資料")}</div>
            )}
          </section>
          <div className="space-y-4">
            <section className="rounded-sm bg-inset py-2">
              <h2 className="px-3 pb-2 text-sm font-medium">{t("工具")}</h2>
              {/* 上游的儀表板視窗沒有品牌圖示（只有 widget 清單有），維持色塊與長條。 */}
              {p && <BreakdownList p={p} by="client" limit={10} variant="dashboard" lift marks={false} motion={{ surface: "dashboard-tools", periodKey: slot, viewKey: "client" }} />}
            </section>
            <section className="rounded-sm bg-inset py-2">
              <h2 className="px-3 pb-2 text-sm font-medium">{t("模型")}</h2>
              {p && <BreakdownList p={p} by="model" limit={10} variant="dashboard" lift marks={false} motion={{ surface: "dashboard-models", periodKey: slot, viewKey: "model" }} />}
            </section>
          </div>
        </div>
        {historyEnabled && (
          <section className="rounded-sm bg-inset py-3">
            <h2 className="px-3 pb-2 text-sm font-medium">{t("每日用量")}</h2>
            <DashboardTrends />
          </section>
        )}
      </div>
    </div>
  );
}
