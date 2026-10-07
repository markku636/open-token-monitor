// 額度的顯示文字（純函式，limits.test.ts 有測試）。資料形狀見 api.ts 的 LimitsView。

import type { LimitProvider, LimitWindow, ProviderStatus } from "./api";
import { t } from "./i18n";

const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export function providerName(id: string): string {
  return PROVIDER_NAMES[id] ?? id;
}

/**
 * 金額型窗口：wire 上的 `metric === "credits"` 表示這個窗口的主要數字是錢（預付餘額），不是百分比。
 * 一律看這個標記，不列 provider（上游 limitBalanceDisplay.js `isCreditsWindow`）。
 */
export function isCreditsWindow(w: LimitWindow): boolean {
  return w.metric === "credits";
}

/** 窗口的標題：5 小時、每週（全部模型）、每週 · Fable、每月、額外用量、餘額…… */
export function windowTitle(w: LimitWindow): string {
  if (w.metric === "spend") return t("額外用量");
  if (isCreditsWindow(w)) return !w.label || w.label === "Balance" ? t("餘額") : w.label;
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

/** 卡片標題旁的帳號說明：帳號、方案、email，重複的只留一個。 */
export function accountText(p: LimitProvider): string {
  const parts = [p.accountLabel, p.planLabel ?? "", p.accountEmail].filter(Boolean);
  return [...new Set(parts)].join(" · ");
}

function finiteNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const CURRENCY_SYMBOLS: Record<string, string> = { CNY: "¥", USD: "$" };

function currencyCode(v: unknown): string {
  const code = String(v ?? "").trim().toUpperCase();
  return /^[A-Z]{3,8}$/.test(code) ? code : "USD";
}

/**
 * 額度的金額（上游 limitBalanceDisplay.js `formatMoney`）：USD 與 CNY 用符號，其他幣別寫代碼，
 * 點數（`CREDITS`）只寫數字。額度的金額是 provider 回報的原幣，不換成設定的顯示幣別。
 */
export function formatMoney(value: unknown, currency?: string | null): string {
  const n = finiteNumber(value);
  if (n === null) return "";
  const code = currencyCode(currency);
  if (code === "CREDITS") return n.toFixed(2);
  const symbol = CURRENCY_SYMBOLS[code];
  return symbol ? `${symbol}${n.toFixed(2)}` : `${code} ${n.toFixed(2)}`;
}

/** 花費型窗口（`metric === "spend"`）：有上限是「$2.35 / $20.00」，沒有是「已花費 $2.35」（上游 `spendValue`）。 */
export function spendText(w: LimitWindow): string {
  const used = finiteNumber(w.used);
  if (used === null) return "";
  const limit = finiteNumber(w.limit);
  const usedText = formatMoney(used, w.currency);
  return limit !== null && limit > 0
    ? `${usedText} / ${formatMoney(limit, w.currency)}`
    : t("已花費 {amount}", { amount: usedText });
}

/** 金額型窗口的餘額：窗口的 `remaining`，沒有時退回 provider 的 `balance.amount`（上游 `creditsAmount`）。 */
export function creditsAmount(p: LimitProvider, w: LimitWindow | null): number | null {
  const fromWindow = finiteNumber(w?.remaining);
  return fromWindow === null ? finiteNumber(p.balance?.amount) : fromWindow;
}

/** 金額型窗口的主要數字：餘額（窗口的幣別，其次 provider 的 balance），沒有餘額時是窗口自己的說明。 */
export function creditsText(p: LimitProvider, w: LimitWindow): string {
  const amount = creditsAmount(p, w);
  if (amount === null) return w.detail || "—";
  const currency = String(w.currency ?? "").trim() || p.balance?.currency;
  return formatMoney(amount, currency);
}

/**
 * 金額型窗口的進度條（剩餘的比例，只給畫面、絕不上 wire；上游 `creditsMeterPercent`）：
 * 有百分比就用；否則以「目前餘額 ÷（餘額 + 本月花費）」估本月的起始資金，沒有花費時是滿的，餘額 0 是空的。
 */
export function creditsMeterPercent(p: LimitProvider, w: LimitWindow | null): number | null {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const used = finiteNumber(w?.usedPercent);
  if (used !== null) return clamp(100 - used);
  const remaining = finiteNumber(w?.remainingPercent);
  if (remaining !== null) return clamp(remaining);
  const amount = creditsAmount(p, w);
  if (amount === null) return null;
  const funds = Math.max(0, amount);
  if (funds === 0) return 0;
  const spend = Math.max(0, finiteNumber(p.balance?.monthSpend) ?? 0);
  return clamp((funds / (funds + spend)) * 100);
}

/**
 * 一個窗口的主要數字與進度條（已用比例；null = 不畫）。額度分頁一律畫已用，所以金額型窗口的剩餘比例
 * 換成已用；`showMeter: false`（例如 OpenCode Zen 的餘額，沒有固定分母）不畫。
 */
export function windowDisplay(p: LimitProvider, w: LimitWindow): { value: string; used: number | null } {
  if (isCreditsWindow(w)) {
    const left = w.showMeter ? creditsMeterPercent(p, w) : null;
    return { value: creditsText(p, w), used: left === null ? null : 100 - left };
  }
  const pct = w.usedPercent;
  const percent = pct === null ? "—" : `${Math.round(pct)}%`;
  const money = w.metric === "spend" ? spendText(w) : "";
  return { value: money || percent, used: w.showMeter ? pct : null };
}
