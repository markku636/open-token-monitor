// 「狀態」視圖（上游的 Status 視圖，預設隱藏）：Claude、OpenAI、Cursor、DeepSeek 的官方狀態頁。
// 顯示時每 serviceStatusRefreshMs 檢查一次（0 = 只在按重新整理時），點一列開官方狀態頁。

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type ServiceStatus } from "./api";
import { RowMark, useToolIcons } from "./BrandMark";
import { serviceStatusIconId } from "./brandIcons";
import { t } from "./i18n";
import { useApp } from "./store";
import { IconButton } from "./ui";

const TONE: Record<ServiceStatus["status"], { dot: string; label: string }> = {
  ok: { dot: "bg-success", label: t("正常") },
  degraded: { dot: "bg-warning", label: t("降級") },
  outage: { dot: "bg-danger", label: t("中斷") },
  unknown: { dot: "bg-fg/30", label: t("未知") },
};

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 60) return t("{n} 秒前", { n: s });
  if (s < 3600) return t("{n} 分鐘前", { n: Math.floor(s / 60) });
  return t("{n} 小時前", { n: Math.floor(s / 3600) });
}

/** 最近一次的結果留在模組層級：切到別的分頁再回來時不必重查，照設定的間隔（0 = 只手動）。 */
let lastList: ServiceStatus[] | null = null;

function isStale(list: ServiceStatus[] | null, refreshMs: number, now: number): boolean {
  if (!list?.length) return true;
  if (!refreshMs) return false;
  const checked = Math.min(...list.map((p) => Date.parse(p.checkedAt) || 0));
  return now - checked >= refreshMs;
}

function meta(p: ServiceStatus): string {
  if (p.error) return t("狀態檢查失敗");
  const parts = [
    p.componentIssues.length ? t("受影響組件：{count}", { count: p.componentIssues.length }) : "",
    p.incidentCount ? t("事件：{count}", { count: p.incidentCount }) : "",
    p.maintenanceCount ? t("維護：{count}", { count: p.maintenanceCount }) : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : p.status === "ok" ? t("無進行中的問題") : "";
}

export function ServiceStatusPanel() {
  const refreshMs = useApp((s) => s.settings?.serviceStatusRefreshMs ?? 60_000);
  const icons = useToolIcons();
  const indent = icons ? "pl-9" : "pl-3.5";
  const [list, setList] = useState<ServiceStatus[] | null>(lastList);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(async (force: boolean) => {
    setBusy(true);
    try {
      const next = await api.serviceStatusGet(force);
      lastList = next;
      setList(next);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (isStale(lastList, refreshMs, Date.now())) void load(false);
    if (!refreshMs) return;
    const id = setInterval(() => void load(false), refreshMs);
    return () => clearInterval(id);
  }, [load, refreshMs]);
  // 「N 秒前」每秒更新（上游相同）。
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="px-3">
      <div className="flex items-center justify-between">
        <span className="text-2xs font-medium uppercase tracking-wide text-fg/45">{t("服務狀態")}</span>
        <IconButton title={t("重新檢查")} onClick={() => void load(true)} disabled={busy}>
          <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
        </IconButton>
      </div>
      {!list ? (
        <div className="py-3 text-center text-xs text-fg/40">{t("檢查中...")}</div>
      ) : (
        <ul className="mt-1 space-y-1">
          {list.map((p) => {
            const tone = TONE[p.status];
            const line = p.incidentTitle || (p.error ? "" : p.description);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className="block w-full rounded-sm px-1.5 py-1 text-left hover:bg-fg/5"
                  title={p.componentIssues.length ? p.componentIssues.join(t("、")) : t("開啟 {name} status 頁", { name: p.label })}
                  onClick={() => void api.serviceStatusOpen(p.id)}
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
                    {/* 上游 renderServiceStatus 在名稱前畫 14px 的服務圖示（OpenAI 用 Codex 的）；Tauri 以色點表示
                        狀態，所以保留色點，圖示放在色點與名稱之間。 */}
                    {icons && <RowMark mark={{ kind: "icon", id: serviceStatusIconId(p.id) }} size={14} />}
                    <span className="flex-1 truncate">{p.label}</span>
                    <span className="shrink-0 text-2xs text-fg/55">{tone.label}</span>
                  </div>
                  {/* 下面兩行對齊名稱：色點 6px + 間距 8px，有圖示時再加 14px + 8px。 */}
                  {line && <div className={`truncate ${indent} text-2xs text-fg/55`}>{line}</div>}
                  <div className={`truncate ${indent} text-2xs text-fg/35`}>
                    {[meta(p), ago(p.checkedAt, now)].filter(Boolean).join(" · ")}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
