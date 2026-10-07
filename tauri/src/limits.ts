// 額度的顯示文字（純函式，limits.test.ts 有測試）。資料形狀見 api.ts 的 LimitsView。

import type { LimitProvider, LimitWindow, ProviderStatus } from "./api";
import { t } from "./i18n";

const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export function providerName(id: string): string {
  return PROVIDER_NAMES[id] ?? id;
}

/** 窗口的標題：5 小時、每週（全部模型）、每週 · Fable、每月、額外用量…… */
export function windowTitle(w: LimitWindow): string {
  if (w.metric === "spend") return t("額外用量");
  const kind: Record<LimitWindow["kind"], string> = {
    session: w.windowMinutes && w.windowMinutes !== 300 ? t("短時段") : t("5 小時"),
    daily: t("每日"),
    weekly: t("每週"),
    billing: t("每月"),
  };
  const base = kind[w.kind];
  if (!w.label || w.label === "Monthly") return w.kind === "weekly" && !w.additional ? t("每週（全部模型）") : base;
  return `${base} · ${w.label}`;
}

/** 用量多寡的色調：90% 以上紅、70% 以上黃。 */
export function meterTone(pct: number | null): "danger" | "warning" | "accent" {
  if (pct === null) return "accent";
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warning";
  return "accent";
}

/** provider 不是 ok 時要說的話；ok 時為空字串。 */
export function statusNote(p: LimitProvider): string {
  const name = providerName(p.provider);
  const map: Partial<Record<ProviderStatus, string>> = {
    notConfigured: t("這台電腦沒有登入 {name}", { name }),
    unauthorized: t("{name} 的登入已失效，請重新登入", { name }),
    rateLimited: t("暫時被限流，稍後自動重試"),
    sourceRateLimited: t("暫時被限流，稍後自動重試"),
    unavailable: t("暫時無法取得額度"),
    error: t("取得額度時發生錯誤"),
    disabled: t("已停用"),
  };
  const note = map[p.status] ?? "";
  // 暫時性失敗時畫面上仍是上次成功的數字，說清楚那是什麼時候的。
  if (note && p.windows.length > 0 && p.updatedAt) {
    return t("{note}（顯示的是先前的數字）", { note });
  }
  return note;
}

/** 金額窗口的「$2.35 / $20.00」。 */
export function moneyText(w: LimitWindow): string {
  const cur = w.currency && w.currency !== "USD" ? `${w.currency} ` : "$";
  const f = (v: number) => `${cur}${v.toFixed(2)}`;
  if (w.used === null) return "";
  return w.limit === null ? f(w.used) : `${f(w.used)} / ${f(w.limit)}`;
}
