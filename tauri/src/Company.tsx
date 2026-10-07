// 全公司分頁：hub 串流的快照 + 本機即時疊加（Rust 端 display.rs compose_company 組好）。
// 全部裝置可見：員工看得到每台電腦的用量。

import { useEffect, useState, type ReactNode } from "react";
import {
  api,
  type AppStatus,
  type Brief,
  type CompanyStats,
  type DeviceDetail,
  type DeviceRow,
  type PeriodName,
  type RangeDeviceRow,
  type RangeName,
} from "./api";
import { BreakdownList } from "./Breakdown";
import { RowMark, useToolIcons } from "./BrandMark";
import { CLIENTS_WITH_ICON, iconKindFor } from "./brandIcons";
import { AnimatedNumber } from "./DataMotion";
import { clientLabel } from "./clients";
import { devicePlatformLabel } from "./detailFormat";
import { foldMap } from "./modelAliases";
import { useResolveModel } from "./useModelAlias";
import { useVendorColors } from "./useVendorColors";
import { clientColor } from "./vendorColors";
import { shortDate, weekStartDay } from "./periods";
import { useFetched } from "./useFetched";
import { fmtAgo, fmtTokens, fmtUsd } from "./format";
import { t } from "./i18n";
import { useApp } from "./store";
import type { Breakdown } from "./store";

const DEVICE_PAGE = 30;

function unavailableText(status: AppStatus | null): string | null {
  if (!status) return t("啟動中…");
  if (!status.hubUrl) return t("沒有設定公司 hub，看不到全公司的用量");
  if (status.hubStream === "unauthorized") return status.hubStreamError ?? t("hub 拒絕了連線金鑰");
  return null;
}

/**
 * 點開一台裝置：依工具（占比、token）與各工具的模型拆分，最後一行是系統、程式版本與同步時間。
 * `fetchKey` 決定拉哪一份（裝置與期間），`refresh` 變了（hub 有新快照、數字變了）就重拉。
 */
function DeviceBreakdown({ load, fetchKey, refresh }: { load: () => Promise<DeviceDetail | null>; fetchKey: string; refresh: string }) {
  const [detail, setDetail] = useState<{ key: string; data: DeviceDetail | null } | null>(null);
  useEffect(() => {
    let alive = true;
    load()
      .then((data) => alive && setDetail({ key: fetchKey, data }))
      .catch(() => alive && setDetail({ key: fetchKey, data: null }));
    return () => {
      alive = false;
    };
    // load 每次重繪都是新的函式；要拉什麼已經由 fetchKey 決定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey, refresh]);
  const resolve = useResolveModel();
  const colors = useVendorColors();
  const icons = useToolIcons();
  const data = detail?.key === fetchKey ? detail.data : null;
  if (!data) return null;
  const meta = [
    devicePlatformLabel(data.platform, data.osName, data.osVersion),
    data.agentRuntime
      ? `${/agent/i.test(data.agentRuntime) ? "Agent" : "Widget"}${data.agentVersion ? ` v${data.agentVersion}` : ""}`
      : "",
    data.receivedAt ? t("{age}同步", { age: fmtAgo(data.receivedAt) }) : "",
  ].filter(Boolean);
  return (
    <div className="mb-1 mt-1 space-y-1 rounded-sm bg-inset px-2 py-1.5 text-2xs">
      {data.tools.length === 0 ? (
        <div className="text-fg/45">{data.totalTokens > 0 ? t("這台裝置未提供工具明細。") : t("此期間尚無工具使用")}</div>
      ) : (
        data.tools.map((tool) => (
          <div key={tool.key}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5 text-fg/70">
                {/* 上游 renderDeviceAccordion：`toolIconsEnabled && clientsWithIcon.has(tool.client)` 時 9px 圖示，否則色塊。 */}
                {icons && CLIENTS_WITH_ICON.has(tool.key) ? (
                  <RowMark mark={{ kind: "icon", id: tool.key }} size={9} />
                ) : (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-[1px]" style={{ background: clientColor(colors, tool.key) }} />
                )}
                <span className="truncate">{tool.key === "__unattributed" ? t("未分類") : clientLabel(tool.key)}</span>
                <span className="text-fg/40">{Math.round(tool.percent)}%</span>
              </span>
              <span className="num shrink-0 text-fg/75">{fmtTokens(tool.tokens)}</span>
            </div>
            {Object.entries(foldMap(Object.fromEntries(tool.models), resolve))
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .map(([model, tokens]) => (
              <div key={model} className="flex items-baseline justify-between gap-2 pl-3 text-fg/45">
                <span className="truncate">{model}</span>
                <span className="num shrink-0">{fmtTokens(tokens)}</span>
              </div>
            ))}
          </div>
        ))
      )}
      {meta.length > 0 && <div className="border-t border-fg/10 pt-1 text-fg/40">{meta.join(" · ")}</div>}
    </div>
  );
}

/** 裝置清單一列要的身分與狀態（`DeviceRow` 與範圍的 `RangeDeviceRow` 都有）。 */
type DeviceIdentity = Pick<DeviceRow, "deviceId" | "hostname" | "platform" | "agentRuntime" | "agentVersion" | "isLocal" | "stale" | "ageMs" | "topClient">;

/**
 * 清單的一列：狀態點、名稱、本機／線上／離線與最常用的工具（`note` 接在後面），右邊是數字；
 * `value` 是 `null` 時顯示「—」。有 `onToggle` 才能點開，點開時顯示 `children`。
 */
function DeviceItem({
  d,
  value,
  note,
  now,
  open = false,
  onToggle,
  children,
}: {
  d: DeviceIdentity;
  value: Brief | null;
  note?: string | null;
  now: number;
  open?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}) {
  const age = d.isLocal ? t("本機") : d.stale ? t("離線 {ago}", { ago: fmtAgo(new Date(now - (d.ageMs ?? 0)).toISOString(), now) }) : t("線上");
  // 上游 iconKindFor(row, 'device')：認得系統就畫系統圖示（離線的列變淡，上游 stale 列是 muted），
  // 否則維持上線／離線點。上線狀態仍寫在第二行。
  const mark = iconKindFor({ platform: d.platform }, "device", useToolIcons());
  const body = (
    <>
      {mark.kind === "icon" ? (
        <RowMark mark={mark} className={d.stale ? "text-fg/30" : "text-fg/80"} />
      ) : (
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${d.stale ? "bg-fg/25" : "bg-success"}`} />
      )}
      <span className="min-w-0 flex-1">
        <span className={`block truncate ${d.isLocal ? "font-medium" : ""}`} title={`${d.hostname} · ${d.agentRuntime} ${d.agentVersion}`}>
          {d.hostname || d.deviceId}
        </span>
        <span className="block truncate text-2xs text-fg/40">
          {age}
          {d.topClient ? ` · ${clientLabel(d.topClient)}` : ""}
          {note ? ` · ${note}` : ""}
        </span>
      </span>
      <span className="num shrink-0 text-right">
        {value ? (
          <>
            <span className="block">{fmtTokens(value.totalTokens)}</span>
            <span className="block text-2xs text-fg/45">{fmtUsd(value.costUsd)}</span>
          </>
        ) : (
          <span className="block text-fg/45">—</span>
        )}
      </span>
    </>
  );
  return (
    <li className="py-1 text-xs">
      {onToggle ? (
        <button type="button" className="flex w-full items-center gap-2 text-left" aria-expanded={open} onClick={onToggle}>
          {body}
        </button>
      ) : (
        <div className="flex w-full items-center gap-2">{body}</div>
      )}
      {open && children}
    </li>
  );
}

function ShowAllToggle({ count, showAll, onToggle }: { count: number; showAll: boolean; onToggle: () => void }) {
  if (count <= DEVICE_PAGE) return null;
  return (
    <button type="button" className="mx-3 mt-1 text-2xs text-accent hover:underline" onClick={onToggle}>
      {showAll ? t("只顯示前 {n} 台", { n: DEVICE_PAGE }) : t("顯示全部 {n} 台", { n: count })}
    </button>
  );
}

export function CompanyPanel({
  company,
  status,
  period,
  breakdown,
}: {
  company: CompanyStats | null;
  status: AppStatus | null;
  period: PeriodName;
  breakdown: Breakdown;
}) {
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const unavailable = unavailableText(status);
  if (unavailable) {
    return <div className="px-3 py-10 text-center text-xs text-fg/45">{unavailable}</div>;
  }
  if (!company) {
    return <div className="px-3 py-10 text-center text-xs text-fg/45">{t("正在連線到公司 hub…")}</div>;
  }
  const p = company.periods[period];
  const now = Date.now();
  const devices = [...company.devices].sort(
    (a, b) => b[period].totalTokens - a[period].totalTokens || a.hostname.localeCompare(b.hostname),
  );
  const shown = showAll ? devices : devices.slice(0, DEVICE_PAGE);
  return (
    <>
      <div className="px-3">
        <div className="flex items-baseline justify-between">
          <AnimatedNumber surface="company-headline" value={p.totalTokens} periodKey={period} format={fmtTokens} className="num text-3xl font-semibold tracking-tight" />
          <div className="num text-lg text-fg/80" title={t("依 API 牌價換算的等值成本，不是實際帳單")}>
            {fmtUsd(p.costUsd)}
          </div>
        </div>
        <div className="mt-1 text-2xs text-fg/45">
          {t("全公司 · 線上 {online} / {total} 台", { online: company.onlineCount, total: company.deviceCount })}
          {status?.hubStream === "reconnecting" ? t(" · 重新連線中") : ""}
        </div>
      </div>
      <div className="mx-3 my-3 border-t border-fg/10" />
      <BreakdownList p={p} by={breakdown} limit={6} motion={{ surface: "company-list", periodKey: period, viewKey: breakdown }} />
      <div className="mx-3 my-3 border-t border-fg/10" />
      <ul className="divide-y divide-fg/5 px-3">
        {shown.map((d) => (
          <DeviceItem
            key={d.deviceId}
            d={d}
            value={d[period]}
            now={now}
            open={open === d.deviceId}
            onToggle={() => setOpen(open === d.deviceId ? null : d.deviceId)}
          >
            {/* hub 有新快照時重拉（本機那台在 company-updated 時也會換）。 */}
            <DeviceBreakdown
              load={() => api.companyDevice(d.deviceId, period)}
              fetchKey={`${d.deviceId}:${period}`}
              refresh={`${company.hubUpdatedAt}:${d[period].totalTokens}`}
            />
          </DeviceItem>
        ))}
      </ul>
      <ShowAllToggle count={devices.length} showAll={showAll} onToggle={() => setShowAll(!showAll)} />
    </>
  );
}

/** 範圍清單上沒有數字的裝置的附註（沒有可用的每日歷史，不計入總數）。 */
export function rangeDeviceNote(d: Pick<RangeDeviceRow, "available">): string | null {
  return d.available ? null : t("沒有可用的每日歷史");
}

/** 範圍底下的說明：數字怎麼來的，以及哪些裝置沒有算進去。 */
export function rangeFooter(devices: Pick<RangeDeviceRow, "available">[] | null): string {
  if (devices === null) return t("依各裝置上傳的每日歷史計算；這個 hub 不提供逐台裝置的範圍數字。");
  const missing = devices.filter((d) => !d.available).length;
  if (missing > 0) return t("依各裝置上傳的每日歷史計算；{n} 台沒有可用每日歷史的裝置未計入。", { n: missing });
  return t("依各裝置上傳的每日歷史計算。");
}

function RangeDeviceList({ devices, range, hubUpdatedAt }: { devices: RangeDeviceRow[]; range: RangeName; hubUpdatedAt: string }) {
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const now = Date.now();
  const shown = showAll ? devices : devices.slice(0, DEVICE_PAGE);
  return (
    <>
      <ul className="divide-y divide-fg/5 px-3">
        {shown.map((d) =>
          d.available ? (
            <DeviceItem
              key={d.deviceId}
              d={d}
              value={d}
              now={now}
              open={open === d.deviceId}
              onToggle={() => setOpen(open === d.deviceId ? null : d.deviceId)}
            >
              <DeviceBreakdown
                load={() => api.companyRangeDevice(d.deviceId, range, weekStartDay())}
                fetchKey={`${d.deviceId}:${range}`}
                refresh={`${hubUpdatedAt}:${d.totalTokens}`}
              />
            </DeviceItem>
          ) : (
            <DeviceItem key={d.deviceId} d={d} value={null} note={rangeDeviceNote(d)} now={now} />
          ),
        )}
      </ul>
      <ShowAllToggle count={devices.length} showAll={showAll} onToggle={() => setShowAll(!showAll)} />
    </>
  );
}

/**
 * 全公司的本星期／最近 7、30 日：每台裝置以自己上傳的每日歷史、即時的今日與自己的日期推出範圍，
 * 總數是各台相加（上游 fixedPeriodSnapshotFromDevices），下面列出每台。沒有可用每日歷史的裝置標出來、
 * 不計入；舊的 hub 沒有逐台的每日歷史時，只看 hub 合併好的總數與工具、模型的拆分。
 */
export function CompanyRangePanel({ range, status, breakdown }: { range: RangeName; status: AppStatus | null; breakdown: Breakdown }) {
  const hubUpdatedAt = useApp((x) => x.company?.hubUpdatedAt ?? "");
  // hub 有新快照時重拉，但不放進 key：換 key 時 useFetched 會先回 null，畫面每分鐘閃一次「載入中」。
  const r = useFetched(() => api.companyRangeGet(range, weekStartDay()), range, hubUpdatedAt);
  const unavailable = unavailableText(status);
  if (unavailable) return <div className="px-3 py-10 text-center text-xs text-fg/45">{unavailable}</div>;
  if (!r || r.status === "loading") return <div className="px-3 py-10 text-center text-xs text-fg/45">{t("正在載入歷史記錄…")}</div>;
  if (r.status === "error") {
    return <div className="px-3 py-10 text-center text-xs text-fg/45">{t("歷史記錄暫時無法使用。")}</div>;
  }
  return (
    <>
      <div className="px-3">
        <div className="flex items-baseline justify-between">
          <AnimatedNumber surface="company-headline" value={r.totals.totalTokens} periodKey={range} format={fmtTokens} className="num text-3xl font-semibold tracking-tight" />
          <div className="num text-lg text-fg/80" title={t("依 API 牌價換算的等值成本，不是實際帳單")}>
            {fmtUsd(r.totals.costUsd)}
          </div>
        </div>
        <div className="mt-1 text-2xs text-fg/45">
          {t("全公司 · {from}–{to}", { from: shortDate(r.start), to: shortDate(r.end) })}
        </div>
      </div>
      <div className="mx-3 my-3 border-t border-fg/10" />
      <BreakdownList p={r.totals} by={breakdown} limit={8} motion={{ surface: "company-list", periodKey: range, viewKey: breakdown }} />
      {r.devices && r.devices.length > 0 && (
        <>
          <div className="mx-3 my-3 border-t border-fg/10" />
          {/* range 換了就是另一份清單：展開與「顯示全部」都從頭開始。 */}
          <RangeDeviceList key={range} devices={r.devices} range={range} hubUpdatedAt={hubUpdatedAt} />
        </>
      )}
      <div className="px-3 pt-3 text-2xs text-fg/40">{rangeFooter(r.devices)}</div>
    </>
  );
}
