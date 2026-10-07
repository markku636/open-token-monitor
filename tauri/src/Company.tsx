// 全公司分頁：hub 串流的快照 + 本機即時疊加（Rust 端 display.rs compose_company 組好）。
// 全部裝置可見：員工看得到每台電腦的用量。

import { useEffect, useState } from "react";
import { api, type AppStatus, type CompanyStats, type DeviceDetail, type DeviceRow, type PeriodName, type RangeName } from "./api";
import { BreakdownList } from "./Breakdown";
import { clientLabel, seriesColor } from "./clients";
import { devicePlatformLabel } from "./detailFormat";
import { foldMap } from "./modelAliases";
import { useResolveModel } from "./useModelAlias";
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

/** 點開一台裝置：依工具（占比、token）與各工具的模型拆分，最後一行是系統、程式版本與同步時間。 */
function DeviceBreakdown({ d, period, hubUpdatedAt }: { d: DeviceRow; period: PeriodName; hubUpdatedAt: string | null }) {
  const [detail, setDetail] = useState<{ key: string; data: DeviceDetail | null } | null>(null);
  const key = `${d.deviceId}:${period}`;
  const tokens = d[period].totalTokens;
  useEffect(() => {
    let alive = true;
    api
      .companyDevice(d.deviceId, period)
      .then((data) => alive && setDetail({ key, data }))
      .catch(() => alive && setDetail({ key, data: null }));
    return () => {
      alive = false;
    };
    // hub 有新快照時重拉（本機那台在 company-updated 時也會換）。
  }, [d.deviceId, period, key, hubUpdatedAt, tokens]);
  const resolve = useResolveModel();
  const data = detail?.key === key ? detail.data : null;
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
        data.tools.map((tool, i) => (
          <div key={tool.key}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5 text-fg/70">
                <span className="h-1.5 w-1.5 shrink-0 rounded-[1px]" style={{ background: seriesColor(tool.key === "__unattributed" ? "__other" : tool.key, i) }} />
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

function DeviceLine({
  d,
  period,
  now,
  open,
  onToggle,
  hubUpdatedAt,
}: {
  d: DeviceRow;
  period: PeriodName;
  now: number;
  open: boolean;
  onToggle: () => void;
  hubUpdatedAt: string | null;
}) {
  const brief = d[period];
  const age = d.isLocal ? t("本機") : d.stale ? t("離線 {ago}", { ago: fmtAgo(new Date(now - (d.ageMs ?? 0)).toISOString(), now) }) : t("線上");
  return (
    <li className="py-1 text-xs">
      <button type="button" className="flex w-full items-center gap-2 text-left" aria-expanded={open} onClick={onToggle}>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${d.stale ? "bg-fg/25" : "bg-success"}`} />
        <span className="min-w-0 flex-1">
          <span className={`block truncate ${d.isLocal ? "font-medium" : ""}`} title={`${d.hostname} · ${d.agentRuntime} ${d.agentVersion}`}>
            {d.hostname || d.deviceId}
          </span>
          <span className="block truncate text-2xs text-fg/40">
            {age}
            {d.topClient ? ` · ${clientLabel(d.topClient)}` : ""}
          </span>
        </span>
        <span className="num shrink-0 text-right">
          <span className="block">{fmtTokens(brief.totalTokens)}</span>
          <span className="block text-2xs text-fg/45">{fmtUsd(brief.costUsd)}</span>
        </span>
      </button>
      {open && <DeviceBreakdown d={d} period={period} hubUpdatedAt={hubUpdatedAt} />}
    </li>
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
          <div className="num text-3xl font-semibold tracking-tight">{fmtTokens(p.totalTokens)}</div>
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
      <BreakdownList p={p} by={breakdown} limit={6} />
      <div className="mx-3 my-3 border-t border-fg/10" />
      <ul className="divide-y divide-fg/5 px-3">
        {shown.map((d) => (
          <DeviceLine
            key={d.deviceId}
            d={d}
            period={period}
            now={now}
            open={open === d.deviceId}
            onToggle={() => setOpen(open === d.deviceId ? null : d.deviceId)}
            hubUpdatedAt={company.hubUpdatedAt}
          />
        ))}
      </ul>
      {devices.length > DEVICE_PAGE && (
        <button type="button" className="mx-3 mt-1 text-2xs text-accent hover:underline" onClick={() => setShowAll(!showAll)}>
          {showAll ? t("只顯示前 {n} 台", { n: DEVICE_PAGE }) : t("顯示全部 {n} 台", { n: devices.length })}
        </button>
      )}
    </>
  );
}

/**
 * 全公司的本星期／最近 7、30 日：hub 合併好的每日歷史（只含有上傳每日歷史的裝置）加上全公司即時的今日。
 * 範圍沒有逐台裝置的數字（上游同樣不提供），只看總數與工具、模型的拆分。
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
          <div className="num text-3xl font-semibold tracking-tight">{fmtTokens(r.totals.totalTokens)}</div>
          <div className="num text-lg text-fg/80" title={t("依 API 牌價換算的等值成本，不是實際帳單")}>
            {fmtUsd(r.totals.costUsd)}
          </div>
        </div>
        <div className="mt-1 text-2xs text-fg/45">
          {t("全公司 · {from}–{to}", { from: shortDate(r.start), to: shortDate(r.end) })}
        </div>
      </div>
      <div className="mx-3 my-3 border-t border-fg/10" />
      <BreakdownList p={r.totals} by={breakdown} limit={8} />
      <div className="px-3 pt-3 text-2xs text-fg/40">{t("依各裝置上傳的每日歷史計算；範圍沒有逐台裝置的數字。")}</div>
    </>
  );
}
