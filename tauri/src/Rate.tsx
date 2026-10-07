// Token 速率：總數下方的期間平均（≈ 42 tok/s）與底欄的即時速率（設定「顯示即時 Token 速率」）。
// 點任一個都在 tok/s 與 tok/min（TPM）之間切換，記在設定 tokenRateMode（上游相同）。

import { useEffect, useState } from "react";
import type { PeriodTotals } from "./api";
import { t } from "./i18n";
import { onLocalStats, useApp } from "./store";
import { averageRateText, createLiveTracker, liveRateText, type RateMode } from "./tokenRate";

// 即時速率要看每一次本機更新（不只是底欄顯示時），基準才會是上一筆；所以在模組層級訂閱。
// 訂閱的是每一筆推送（onLocalStats），不是 store 的 local：視窗看不到時 store 先收著資料，只看 store 的話
// 打開時會拿藏起來前的最後一筆當基準，把一段早就結束的平均當成剛量到的即時速率
// （上游 app.js onStatsPush 每一筆都呼叫 observeLiveTokenRate）。
const live = createLiveTracker();
let lastDevice = "";
onLocalStats((local) => {
  if (local.deviceId !== lastDevice) {
    lastDevice = local.deviceId;
    live.reset();
  }
  live.observe(local.periods.today);
});

function useRateMode(): [RateMode, () => void] {
  const mode = useApp((s) => (s.settings?.tokenRateMode === "burn" ? "burn" : "speed"));
  const updateSettings = useApp((s) => s.updateSettings);
  return [mode, () => void updateSettings({ tokenRateMode: mode === "burn" ? "speed" : "burn" })];
}

/** 期間的平均速率；四捨五入是 0 或沒有速率資料（範圍、聚合來源）時不顯示。 */
export function AverageRate({ p }: { p: PeriodTotals }) {
  const [mode, toggle] = useRateMode();
  const text = averageRateText(p, mode);
  if (!text) return null;
  return (
    <button
      type="button"
      className="num shrink-0 text-fg/45 hover:text-fg/70"
      title={mode === "burn" ? t("平均 token 消耗；點擊切換至 tok/s") : t("平均生成速度；點擊切換至 tok/min")}
      onClick={toggle}
    >
      {text}
    </button>
  );
}

/** 底欄的即時速率：8 秒內的新樣本正常顯示，之後變暗，3 分鐘後顯示「—」。 */
export function LiveRate() {
  const enabled = useApp((s) => s.settings?.showLiveTokenRate ?? false);
  // 讀 local 讓每次本機更新都重繪（tracker 已在上面的訂閱裡更新）。
  useApp((s) => s.local);
  const [, tick] = useState(0);
  const [mode, toggle] = useRateMode();
  const reading = enabled ? live.reading() : null;
  const expiresAt = reading?.expiresAt ?? 0;
  useEffect(() => {
    if (!expiresAt) return;
    const id = setTimeout(() => tick((n) => n + 1), Math.max(0, expiresAt - Date.now()) + 50);
    return () => clearTimeout(id);
  }, [expiresAt]);
  if (!enabled) return null;
  const unit = mode === "burn" ? "TPM" : "tok/s";
  const scope = t("這部裝置");
  if (!reading) {
    return (
      <button type="button" className="num shrink-0 text-fg/30" onClick={toggle} title={t("顯示即時 Token 速率")}>
        — {unit}
      </button>
    );
  }
  const value = liveRateText(mode === "burn" ? reading.burn : reading.speed, mode);
  const title = reading.idle
    ? mode === "burn"
      ? t("最近一次 Token 消耗（{scope}）：{value}。點擊切換至 tok/s。", { scope, value })
      : t("最近一次生成速度（{scope}）：{value}。點擊切換至 TPM。", { scope, value })
    : mode === "burn"
      ? t("即時 Token 消耗（{scope}）：{value}。點擊切換至即時 tok/s。", { scope, value })
      : t("即時生成速度（{scope}）：{value}。點擊切換至即時 TPM。", { scope, value });
  return (
    <button type="button" className={`num shrink-0 ${reading.idle ? "text-fg/35" : "text-accent"}`} onClick={toggle} title={title}>
      {value}
    </button>
  );
}
