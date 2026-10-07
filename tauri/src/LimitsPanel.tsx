// 額度分頁：Claude Code 與 Codex 的用量上限（Rust 端 limits/ 探測，每 5 分鐘一次）。

import { RefreshCw } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { api, type LimitProvider, type LimitWindow, type LimitsView, type ResetCredits } from "./api";
import { fmtTime, fmtUntil } from "./format";
import { t } from "./i18n";
import { meterTone, moneyText, providerName, resetCreditsView, statusNote, windowTitle } from "./limits";
import { IconButton } from "./ui";

const TONE_BAR = { danger: "bg-danger", warning: "bg-warning", accent: "bg-accent" } as const;

function WindowRow({ w, now }: { w: LimitWindow; now: number }) {
  const pct = w.usedPercent;
  const until = fmtUntil(w.resetsAt, now);
  const money = w.metric === "spend" ? moneyText(w) : "";
  return (
    <li className="py-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate">{windowTitle(w)}</span>
        <span className="num shrink-0 text-fg/70">
          {money || (pct === null ? "—" : `${Math.round(pct)}%`)}
        </span>
      </div>
      {w.showMeter && pct !== null && (
        <div className="mt-0.5 h-1 rounded-full bg-fg/10">
          <div className={`h-1 rounded-full ${TONE_BAR[meterTone(pct)]}`} style={{ width: `${Math.max(2, pct)}%` }} />
        </div>
      )}
      {until && <div className="mt-0.5 text-2xs text-fg/40">{t("{until}重置", { until })}</div>}
    </li>
  );
}

// 重置券：「可重置 N 次」加上最近的到期時間；ⓘ 展開每個到期日（Codex）或每張券的明細（Claude）。
// 上游是滑過顯示的浮動提示；widget 只有 340 px 寬，這裡改成按一下在列下方展開。
function ResetCreditsRow({ rc, now }: { rc: ResetCredits; now: number }) {
  const [open, setOpen] = useState(false);
  const view = resetCreditsView(rc, now);
  if (!view) return null;
  return (
    <li className="py-1" aria-label={view.ariaLabel}>
      <div className="flex items-center justify-between gap-2 text-2xs text-fg/55">
        <span className="truncate">{view.value}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {view.timeline.length > 0 && (
            <span className="num text-fg/45">
              {view.timeline.map((part, i) => (
                <Fragment key={i}>
                  {i > 0 && (
                    <span className="px-1 opacity-70" aria-hidden="true">
                      ·
                    </span>
                  )}
                  {part}
                </Fragment>
              ))}
            </span>
          )}
          {view.detail.length > 0 && (
            <button
              type="button"
              aria-expanded={open}
              aria-label={view.detailLabel}
              title={t("重置券明細")}
              onClick={() => setOpen(!open)}
              className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border text-[9px] leading-none ${
                open ? "border-fg/50 text-fg" : "border-fg/25 text-fg/55 hover:text-fg"
              }`}
            >
              i
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-xs bg-fg/5 px-2 py-1.5 text-2xs">
          {view.detail.map((row, i) =>
            "caption" in row ? (
              <div key={i} className={`col-span-2 text-fg/70 ${row.separated ? "mt-1 border-t border-fg/10 pt-1" : ""}`}>
                {row.caption}
              </div>
            ) : (
              <Fragment key={i}>
                <span className="text-fg/45">{row.name}</span>
                <span className="num text-fg/75">{row.value}</span>
              </Fragment>
            ),
          )}
        </div>
      )}
    </li>
  );
}

function ProviderCard({ p, now }: { p: LimitProvider; now: number }) {
  const note = statusNote(p);
  const rc = p.resetCredits;
  return (
    <section className="mx-3 mb-3 rounded-sm bg-inset px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{providerName(p.provider)}</span>
        <span className="truncate text-2xs text-fg/45" title={p.accountEmail}>
          {[p.accountLabel, p.accountEmail].filter(Boolean).join(" · ")}
        </span>
      </div>
      {note && <p className={`mt-1 text-2xs ${p.status === "ok" ? "text-fg/45" : "text-warning"}`}>{note}</p>}
      {(p.windows.length > 0 || rc) && (
        <ul className="mt-1">
          {p.windows.map((w, i) => (
            <WindowRow key={`${w.kind}-${w.limitId ?? ""}-${w.label}-${i}`} w={w} now={now} />
          ))}
          {rc && <ResetCreditsRow rc={rc} now={now} />}
        </ul>
      )}
    </section>
  );
}

export function LimitsPanel({ limits, enabled }: { limits: LimitsView | null; enabled: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!enabled) {
    return <div className="px-3 py-10 text-center text-xs text-fg/45">{t("額度已在設定中關閉")}</div>;
  }
  if (!limits) {
    return <div className="px-3 py-10 text-center text-xs text-fg/45">{t("正在取得額度…")}</div>;
  }
  const refresh = async () => {
    setBusy(true);
    try {
      await api.limitsRefresh();
    } finally {
      setTimeout(() => setBusy(false), 3000);
    }
  };
  return (
    <>
      {limits.providers.map((p) => (
        <ProviderCard key={p.provider} p={p} now={now} />
      ))}
      <div className="flex items-center justify-between px-3 text-2xs text-fg/40">
        <span>{t("更新於 {at} · 下次 {next}", { at: fmtTime(limits.updatedAt), next: fmtTime(limits.nextAt) })}</span>
        <IconButton title={t("立即重新取得額度")} onClick={() => void refresh()} disabled={busy}>
          <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
        </IconButton>
      </div>
    </>
  );
}
