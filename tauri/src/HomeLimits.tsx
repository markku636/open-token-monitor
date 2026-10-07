// 主頁的「額度」模組（上游 app.js `renderHomeLimitModule`）：每個帳號最多兩個窗口，預設依剩餘最少的排前面。
// 暫時自己畫一份精簡的列；額度分頁（LimitsPanel.tsx，另一個 session 的檔案）的共用列移植好之後改用它。

import { useEffect, useState } from "react";
import { RowMark, useToolIcons } from "./BrandMark";
import { iconKindFor } from "./brandIcons";
import { fmtUntil } from "./format";
import { homeLimitRows, homeLimitValueText, homeLimitWindowLabel, type HomeLimitAccount, type HomeLimitWindow } from "./homeOverview";
import { t } from "./i18n";
import { useApp } from "./store";
import { useVendorColors } from "./useVendorColors";

function WindowCell({ w, account, span, showUsed, highlight, now }: { w: HomeLimitWindow; account: HomeLimitAccount; span: boolean; showUsed: boolean; highlight: boolean; now: number }) {
  // 上游 showHomeLimitBars：剩不到 20% 標紅加圓點、不到 50% 用帳號的顏色。
  const remaining = w.remainingPercent == null ? null : Math.max(0, Math.min(100, Number(w.remainingPercent) || 0));
  const critical = highlight && remaining != null && remaining < 20;
  const low = highlight && remaining != null && !critical && remaining < 50;
  const until = w.resetsAt ? fmtUntil(w.resetsAt, now) : "";
  // 上游 formatLimitBoundary：已經過了重置時間就不寫；沒有時間但有說明時寫說明。
  const reset = w.resetsAt ? (until ? t("{until}重置", { until }) : "") : w.resetDescription ? t("重置 {value}", { value: w.resetDescription }) : "";
  return (
    <div className={`min-w-0 ${span ? "col-span-2" : ""}`}>
      <div className="flex items-baseline justify-between gap-1">
        <span className="truncate text-2xs text-fg/45">{homeLimitWindowLabel(w)}</span>
        <span
          className={`num shrink-0 text-2xs ${critical ? "relative pl-2 text-danger before:absolute before:left-0 before:top-1/2 before:h-1 before:w-1 before:-translate-y-1/2 before:rounded-full before:bg-danger" : ""}`}
          style={low ? { color: account.color } : undefined}
        >
          {homeLimitValueText(w, showUsed)}
        </span>
      </div>
      {reset && <div className="num truncate text-[9px] text-fg/45 opacity-80">{reset}</div>}
    </div>
  );
}

export function HomeLimits() {
  const limits = useApp((s) => s.limits);
  const settings = useApp((s) => s.settings);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const colors = useVendorColors();
  const icons = useToolIcons();
  const rows = homeLimitRows(limits, settings, colors);
  if (!rows.length) return <div className="text-2xs text-fg/45">{t("尚無即時額度資料")}</div>;
  // 上游預設顯示剩餘（showLimitUsed 還沒移植前一律是剩餘）。
  const showUsed = settings?.showLimitUsed === true;
  const highlight = settings?.showHomeLimitBars === true;
  return (
    <>
      {rows.map((account) => (
        <div key={account.key} className="grid gap-1">
          <div className="grid grid-cols-[10px_minmax(0,1fr)] items-center gap-2">
            <RowMark mark={iconKindFor({ key: account.iconId || account.providerId || account.key }, "limits", icons)} color={account.color} />
            <span className="truncate text-[11px]" title={account.name}>
              {account.name}
            </span>
          </div>
          <div className="ml-[18px] grid grid-cols-2 gap-3">
            {account.windows.map((w, i) => (
              <WindowCell key={`${w.kind}-${w.label}-${i}`} w={w} account={account} span={account.windows.length === 1} showUsed={showUsed} highlight={highlight} now={now} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
