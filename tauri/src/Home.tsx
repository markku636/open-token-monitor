// 主頁（上游 Home 視圖，app.js `renderHome` 與 homeOverview.js）：總數下面依設定的順序放模組——
// 額度、工具、裝置、模型、活動（預設隱藏工具與裝置）。點模組打開對應的視圖並顯示「返回主頁」。
// 總數、工具與模型看這台電腦（與上游相同）；裝置看全公司串流；活動是本機的 history。

import { useEffect, type ReactNode } from "react";
import { api, type PeriodTotals, type RangeName, type Selection, type TrendsView } from "./api";
import { ActivityBody, activeDaysLabel } from "./Activity";
import { RowMark, useToolIcons } from "./BrandMark";
import { iconKindFor } from "./brandIcons";
import { clientLabel } from "./clients";
import { fmtTokens, fmtUsd } from "./format";
import { HomeLimits } from "./HomeLimits";
import {
  attributionRows,
  homeDeviceRows,
  homeModelRows,
  homeToolRows,
  pickHomeHistory,
  rankByTokens,
  UNATTRIBUTED_KEY,
  visibleAttributionRows,
  type HomeDeviceInput,
  type HomeRow,
} from "./homeOverview";
import { t } from "./i18n";
import { foldMap } from "./modelAliases";
import { isRange, weekStartDay } from "./periods";
import { useApp } from "./store";
import { emptyText } from "./Trends";
import { Button } from "./ui";
import { useFetched } from "./useFetched";
import { useResolveModel } from "./useModelAlias";
import { useVendorColors } from "./useVendorColors";
import { clientColor, modelColor } from "./vendorColors";
import { availableViewIds, HOME_MODULE_OPTIONS, homeModuleIds, normalizeHiddenViews, VIEW_IDS, type HomeModuleId, type ViewId } from "./viewPrefs";
import { VIEW_ICONS } from "./ViewSwitcher";

/** 設定視窗打開後捲到哪一段（同源的兩個視窗共用 localStorage，設定頁在掛上與 storage 事件時讀）。 */
export const SETTINGS_FOCUS_KEY = "tm:settingsFocus";

/** 上游 `openHomeSettings`：打開設定並展開主畫面的主頁模組。 */
export function openSettingsAt(section: "home") {
  try {
    localStorage.setItem(SETTINGS_FOCUS_KEY, section);
  } catch {
    /* 打不開 localStorage 時仍打開設定，只是不會自動捲到那一段 */
  }
  void api.windowOpenSettings();
}

/** 上游 `homeModuleShell`：整塊可點（Enter／Space 也行），標題右邊是次要資訊與目標視圖的圖示。 */
function HomeModule({
  title,
  view,
  meta,
  gap = "gap-1.5",
  onOpen,
  children,
}: {
  title: string;
  view: ViewId;
  meta?: string;
  gap?: string;
  onOpen: () => void;
  children: ReactNode;
}) {
  const Icon = VIEW_ICONS[view];
  return (
    <section
      role="button"
      tabIndex={0}
      aria-label={title}
      className="grid cursor-pointer gap-[7px] border-b border-fg/10 pb-3 hover:opacity-[.94] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent/30"
      onClick={(e) => {
        // 熱力圖可以拖曳捲動，點在上面不換視圖（上游 .home-activity-scroll）。
        if ((e.target as Element).closest("[data-home-activity-scroll]")) return;
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onOpen();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] font-semibold uppercase text-fg">{title}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          {meta && <span className="num truncate text-2xs text-fg/45">{meta}</span>}
          <Icon size={13} className="shrink-0 text-fg/45 opacity-80" aria-hidden />
        </span>
      </div>
      <div className={`grid ${gap}`}>{children}</div>
    </section>
  );
}

const moduleEmpty = (text: string) => <div className="text-2xs text-fg/45">{text}</div>;

/** 工具與模型的一列：圖示或色點、名稱、token、占比（上游 .home-list-row 與 applyHomeListMark）。 */
function ShareRows({ rows, kind }: { rows: HomeRow[]; kind: "tool" | "model" }) {
  const icons = useToolIcons();
  return (
    <>
      {rows.map((row) => (
        <div key={row.key} className="grid grid-cols-[10px_minmax(0,1fr)_minmax(42px,auto)_minmax(31px,auto)] items-center gap-2">
          <RowMark mark={iconKindFor({ key: row.key }, kind, icons)} color={row.color} />
          <span className="truncate text-[11px]" title={row.name}>
            {row.name}
          </span>
          <span className="num text-right text-[11px]">{fmtTokens(row.value)}</span>
          <span className="num text-right text-2xs text-fg/45">{`${Math.round(row.share * 100)}%`}</span>
        </div>
      ))}
    </>
  );
}

/** 上游 `renderHomeToolModule`：不套用工具的隱藏與排序設定（上游相同）。 */
function HomeTools({ p }: { p: PeriodTotals }) {
  useApp((s) => s.currency);
  const colors = useVendorColors();
  const rows = homeToolRows(
    visibleAttributionRows(attributionRows(p.clients, p.clientCosts, { totalValue: p.totalTokens, totalCost: p.costUsd }), fmtUsd).map((r) => ({
      key: r.key,
      name: r.key === UNATTRIBUTED_KEY ? t("未分類") : clientLabel(r.key),
      value: r.value,
      color: clientColor(colors, r.key),
    })),
    p.totalTokens,
    5,
  );
  return rows.length ? <ShareRows rows={rows} kind="tool" /> : moduleEmpty(t("此期間尚無工具使用"));
}

/** 上游 `renderHomeModelModule`：模型依別名合併後，一律依 token 排名（不看 modelRankingMetric）。 */
function HomeModels({ p }: { p: PeriodTotals }) {
  const resolve = useResolveModel();
  useApp((s) => s.currency);
  const colors = useVendorColors();
  const ranked = rankByTokens(
    visibleAttributionRows(attributionRows(foldMap(p.models, resolve), foldMap(p.modelCosts, resolve), { totalValue: p.totalTokens, totalCost: p.costUsd }), fmtUsd),
  );
  const rows = homeModelRows(
    ranked.map((r) => ({
      key: r.key,
      name: r.key === UNATTRIBUTED_KEY ? t("未分類") : r.key,
      value: r.value,
      color: modelColor(colors, r.key),
    })),
    p.totalTokens,
    5,
  );
  return rows.length ? <ShareRows rows={rows} kind="model" /> : moduleEmpty(t("此期間尚無模型使用"));
}

/** 上游 `renderHomeDeviceModule`：全公司串流的裝置（沒有 hub 時只有這台），前 4 名。 */
function HomeDevices({ selection }: { selection: Selection }) {
  const company = useApp((s) => s.company);
  const local = useApp((s) => s.local);
  const localDeviceId = useApp((s) => s.settings?.deviceId) || local?.deviceId || "";
  if (isRange(selection)) {
    return company ? <HomeRangeDevices range={selection} localDeviceId={localDeviceId} /> : <HomeLocalRangeDevice range={selection} />;
  }
  const source: HomeDeviceInput[] = company
    ? company.devices.map((d) => ({
        deviceId: d.deviceId,
        // 全公司分頁以電腦名稱辨識裝置，這裡一樣。
        displayName: d.hostname,
        hostname: d.hostname,
        platform: d.platform,
        stale: d.stale,
        periods: { today: d.today, month: d.month, allTime: d.allTime },
      }))
    : local
      ? [{ deviceId: local.deviceId, hostname: local.hostname, stale: false, periods: local.periods }]
      : [];
  return <HomeDeviceList rows={homeDeviceRows(source, { localDeviceId, period: selection, limit: 4 })} />;
}

/**
 * 全公司的本星期／最近 7、30 日：用全公司分頁同一份逐台推出的範圍（上游 renderHomeDeviceModule 讀
 * fixedPeriodDevices()）。沒有可用每日歷史的裝置不列（上游 fixedPeriodDevices 不含它們）；舊的 hub
 * 沒有逐台的每日歷史時照舊說明。
 */
function HomeRangeDevices({ range, localDeviceId }: { range: RangeName; localDeviceId: string }) {
  const hubUpdatedAt = useApp((s) => s.company?.hubUpdatedAt ?? "");
  const r = useFetched(() => api.companyRangeGet(range, weekStartDay()), range, hubUpdatedAt);
  if (!r || r.status === "loading") return moduleEmpty(t("正在載入歷史記錄…"));
  if (r.status !== "ready") return moduleEmpty(t("歷史記錄暫時無法使用。"));
  if (!r.devices) return moduleEmpty(t("此範圍不提供裝置明細。"));
  const source: HomeDeviceInput[] = r.devices
    .filter((d) => d.available)
    .map((d) => ({
      deviceId: d.deviceId,
      displayName: d.hostname,
      hostname: d.hostname,
      platform: d.platform,
      stale: d.stale,
      periods: { [range]: { totalTokens: d.totalTokens } },
    }));
  return <HomeDeviceList rows={homeDeviceRows(source, { localDeviceId, period: range, limit: 4 })} />;
}

/** 沒有 hub 時只有這台：範圍的總數來自本機的每日歷史（與本機分頁同一份 range_get）。 */
function HomeLocalRangeDevice({ range }: { range: RangeName }) {
  const local = useApp((s) => s.local);
  const r = useFetched(() => api.rangeGet(range, weekStartDay()), range);
  if (!local) return moduleEmpty(t("尚無裝置"));
  if (!r || r.status === "loading") return moduleEmpty(t("正在載入歷史記錄…"));
  if (r.status !== "ready") return moduleEmpty(t("請啟用每日歷史以使用本星期、最近 7 日與最近 30 日。"));
  const source: HomeDeviceInput[] = [{ deviceId: local.deviceId, hostname: local.hostname, stale: false, periods: { [range]: { totalTokens: r.totals.totalTokens } } }];
  return <HomeDeviceList rows={homeDeviceRows(source, { localDeviceId: local.deviceId, period: range, limit: 4 })} />;
}

/** 裝置的一列：系統圖示（認不出系統時上線／離線的色點）、名稱、token（上游 renderHomeDeviceModule）。 */
function HomeDeviceList({ rows }: { rows: ReturnType<typeof homeDeviceRows> }) {
  const icons = useToolIcons();
  if (!rows.length) return moduleEmpty(t("尚無裝置"));
  return (
    <>
      {rows.map((row) => (
        <div
          key={row.key}
          className={`grid grid-cols-[10px_minmax(0,1fr)_minmax(42px,auto)] items-center gap-2 ${row.isStale ? "text-fg/45" : ""}`}
          title={row.isStale ? t("離線") : undefined}
        >
          <RowMark mark={iconKindFor({ platform: row.platform }, "device", icons)} color={row.isStale ? "#8c97a7" : "#73bdf5"} className={row.isStale ? "opacity-[.55]" : ""} />
          <span className="flex min-w-0 items-center gap-1.5 text-[11px]">
            <span className="truncate">{row.name}</span>
            {row.isLocal && <span className="shrink-0 rounded-xs bg-accent/15 px-1 text-2xs text-accent">{t("本機")}</span>}
          </span>
          <span className="num text-right text-[11px]">{fmtTokens(row.value)}</span>
        </div>
      ))}
    </>
  );
}

/**
 * 上次拿到的 trends_get（上游 state.homeHistory，這次開啟期間都留著）。離開主頁時模組會卸載，
 * 回來時先畫它，不會在重拉的來回之間閃出「尚無使用歷史」、資料到了又重播一次進場動畫。
 */
let lastTrends: TrendsView | null = null;

function HomeActivity({ onOpen }: { onOpen: () => void }) {
  const enabled = useApp((s) => s.settings?.historyEnabled ?? true);
  const hiddenViews = useApp((s) => s.settings?.hiddenViews ?? "status");
  const metric = useApp((s) => s.settings?.heatmapMetric ?? "cost");
  const daysWindow = useApp((s) => s.settings?.homeActiveDaysWindow ?? "all");
  const status = useApp((s) => s.status);
  const preview = useApp((s) => s.local?.history ?? null);
  const updateSettings = useApp((s) => s.updateSettings);
  const fetched = useFetched(() => (enabled ? api.trendsGet() : Promise.resolve(null)), `trends:${enabled}`);
  useEffect(() => {
    if (fetched) lastTrends = fetched;
  }, [fetched]);
  // 還沒拿到（第一次開啟）時用統計附帶的 30 天預覽（上游 pickHomeHistory）。
  const view = pickHomeHistory(fetched ?? lastTrends, preview);
  const title = t("活動");
  if (!enabled) {
    return (
      <HomeModule title={title} view="trends" onOpen={onOpen}>
        <div className="flex items-center justify-between gap-2 text-2xs text-fg/45">
          <span className="truncate">{t("趨勢功能尚未啟用")}</span>
          <Button
            variant="primary"
            className="shrink-0 px-2 py-0.5 text-2xs"
            onClick={(e) => {
              // 上游 setTrendEnabled：打開每日歷史，也把趨勢視圖從隱藏清單拿掉。
              e.stopPropagation();
              const hidden = normalizeHiddenViews(hiddenViews, VIEW_IDS)
                .split(",")
                .filter((id) => id && id !== "trends");
              void updateSettings({ historyEnabled: true, hiddenViews: hidden.join(",") });
            }}
          >
            {t("前往啟用")}
          </Button>
        </div>
      </HomeModule>
    );
  }
  if (!view) {
    return (
      <HomeModule title={title} view="trends" onOpen={onOpen}>
        {moduleEmpty(emptyText(status))}
      </HomeModule>
    );
  }
  return (
    <HomeModule title={title} view="trends" meta={activeDaysLabel(view, metric, daysWindow)} gap="gap-3" onOpen={onOpen}>
      <ActivityBody view={view} metric={metric} />
    </HomeModule>
  );
}

function HomeEmpty() {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
      <div className="text-xs font-medium">{t("主頁目前是空的")}</div>
      <div className="text-2xs text-fg/45">{t("顯示主頁模組，即可建立你的概覽。")}</div>
      <Button className="mt-1 text-xs" onClick={() => openSettingsAt("home")}>
        {t("自訂主頁")}
      </Button>
    </div>
  );
}

/** 主頁的模組清單（總數面板由 Widget 畫，與本機視圖共用載入中與範圍的說明）。 */
export function HomeModules({ p, selection }: { p: PeriodTotals; selection: Selection }) {
  const settings = useApp((s) => s.settings);
  const setView = useApp((s) => s.setView);
  const ids = homeModuleIds(settings);
  if (!ids.length) return <HomeEmpty />;
  const open = (id: HomeModuleId) => {
    const option = HOME_MODULE_OPTIONS.find((o) => o.id === id);
    // 目標視圖用不了時（例如 history 關閉的趨勢）不動，與上游 renderBreakdownChange 的可用檢查相同。
    if (!option || !availableViewIds(settings).includes(option.view)) return;
    setView(option.view, { fromHome: true, breakdown: option.breakdown });
  };
  const label = (id: HomeModuleId) => HOME_MODULE_OPTIONS.find((o) => o.id === id)?.label ?? id;
  return (
    <div className="mt-3 grid content-start gap-3 px-3">
      {ids.map((id) => {
        switch (id) {
          case "limits":
            return (
              <HomeModule key={id} title={label(id)} view="limits" gap="gap-3" onOpen={() => open(id)}>
                <HomeLimits />
              </HomeModule>
            );
          case "tool":
            return (
              <HomeModule key={id} title={label(id)} view="tool" onOpen={() => open(id)}>
                <HomeTools p={p} />
              </HomeModule>
            );
          case "device":
            return (
              <HomeModule key={id} title={label(id)} view="device" onOpen={() => open(id)}>
                <HomeDevices selection={selection} />
              </HomeModule>
            );
          case "model":
            return (
              <HomeModule key={id} title={label(id)} view="tool" onOpen={() => open(id)}>
                <HomeModels p={p} />
              </HomeModule>
            );
          case "trends":
            return <HomeActivity key={id} onOpen={() => open(id)} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
