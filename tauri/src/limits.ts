// 額度的顯示文字（純函式，limits.test.ts 有測試）。資料形狀見 api.ts 的 LimitsView。

import type { LimitProvider, LimitWindow, ProviderStatus, ResetCredits, ResetGrant } from "./api";
import { lang, t } from "./i18n";

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

// ---- 額度重置券（上游 renderer/limitWindowsView.js 的 codexResetCreditsNode / claudeResetCreditsNode）----

/** 上游 `limitDurationText`：「3 天 4 小時」「4 小時 5 分」「5 分」「<1 分」。 */
export function durationText(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(Number(ms || 0) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return t("{d} 天 {h} 小時", { d: days, h: hours });
  if (hours > 0) return t("{h} 小時 {m} 分", { h: hours, m: minutes });
  if (minutes > 0) return t("{m} 分", { m: minutes });
  return t("<1 分");
}

/** 上游 `formatCodexResetCreditsValue`：「可重置 3 次」；沒有可用的次數時是空字串（整列不顯示）。 */
export function resetCreditsValue(rc: ResetCredits | null | undefined): string {
  const available = Number(rc?.availableCount);
  if (!Number.isFinite(available)) return "";
  const count = Math.max(0, Math.floor(available));
  if (count <= 0) return "";
  return count === 1 ? t("可重置 1 次") : t("可重置 {n} 次", { n: count });
}

/** 全部到期時間由早到晚；沒有清單時退回 `nextExpiresAt`（上游 `codexResetCreditExpirationDates`）。 */
export function resetCreditExpirationDates(rc: ResetCredits | null | undefined): Date[] {
  const dates = (rc?.expirations ?? [])
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length > 0) return dates;
  const fallback = rc?.nextExpiresAt ? new Date(rc.nextExpiresAt) : null;
  return fallback && !Number.isNaN(fallback.getTime()) ? [fallback] : [];
}

/** 時間軸上的一格：已經到期是「現在」，否則還剩多久。 */
export function resetCreditExpiryLabel(date: Date, now: number): string {
  const diff = date.getTime() - now;
  return diff <= 0 ? t("現在") : durationText(diff);
}

function resetCreditExpiryDetailLabel(date: Date, now: number): string {
  const diff = date.getTime() - now;
  return diff <= 0 ? t("現在到期") : t("{d}後到期", { d: durationText(diff) });
}

/** 到期的日期時間（上游 `expiryDateLabel`：月／日 時:分，跟著介面語言）。 */
export function expiryDateLabel(date: Date): string {
  return new Intl.DateTimeFormat(lang() === "en" ? "en" : "zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

// Claude 重置券 `clears` 的窗口 id → 與額度分頁上那個窗口相同的標題（上游 claudeResetClearLabel
// 的原則：用 provider 自己窗口的字）。不認得的 id 仍以文字顯示，Anthropic 會陸續加新的窗口。
const CLEAR_WINDOWS: Record<string, Pick<LimitWindow, "kind" | "label">> = {
  five_hour: { kind: "session", label: "" },
  seven_day: { kind: "weekly", label: "" },
  // Claude Code 自己的標籤叫「Fable limit」：Fable 模型的每週額度，不是 seven_day 的修飾。
  seven_day_overage_included: { kind: "weekly", label: "Fable" },
  seven_day_opus: { kind: "weekly", label: "Opus" },
  seven_day_sonnet: { kind: "weekly", label: "Sonnet" },
  seven_day_oauth_apps: { kind: "weekly", label: "OAuth apps" },
  seven_day_cowork: { kind: "weekly", label: "Cowork" },
  seven_day_omelette: { kind: "weekly", label: "Omelette" },
};

export function resetClearLabel(key: string): string {
  const known = CLEAR_WINDOWS[key];
  if (!known) return String(key || "").replace(/_/g, " ").trim();
  return windowTitle({
    ...known,
    used: null,
    limit: null,
    remaining: null,
    usedPercent: null,
    remainingPercent: null,
    resetsAt: null,
    windowMinutes: null,
    currency: null,
    showMeter: false,
  });
}

/** 說明裡的一列：整行的說明文字（券的標籤），或「名稱：值」。 */
export type ResetDetailRow = { caption: string; separated: boolean } | { name: string; value: string };

/** 上游 `claudeResetGrantRows`：每張券一段——標籤、到期、清掉哪些窗口、使用限制。 */
export function claudeResetGrantRows(grants: ResetGrant[], now: number): ResetDetailRow[] {
  const rows: ResetDetailRow[] = [];
  grants.forEach((grant, index) => {
    const endsAt = grant.endsAt ? new Date(grant.endsAt) : null;
    const date = endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : null;
    let remaining = "";
    if (grant.paused === true) remaining = t("已暫停");
    else if (date) remaining = date.getTime() - now <= 0 ? t("已過期") : durationText(date.getTime() - now);
    if (grant.label) rows.push({ caption: grant.label, separated: index > 0 });
    rows.push({
      name: t("到期"),
      value: date ? [expiryDateLabel(date), remaining].filter(Boolean).join(" · ") : remaining || t("不會過期"),
    });
    const keys = Array.isArray(grant.clears) ? grant.clears : [];
    // Fable 的每週額度只在它是唯一的每週窗口時才列：旁邊已經有一般的每週時只是雜訊。
    const clears = keys
      .filter((key) => key !== "seven_day_overage_included" || !keys.includes("seven_day"))
      .map(resetClearLabel)
      .filter(Boolean)
      .join(" · ");
    if (clears) rows.push({ name: t("重置範圍"), value: clears });
    if (grant.useRequiresLimit === true) rows.push({ name: t("可用時機"), value: t("只在達到上限時") });
    else if (grant.usableNow === false) rows.push({ name: t("可用時機"), value: t("目前不能用") });
  });
  return rows;
}

function rowText(row: ResetDetailRow): string {
  return "caption" in row ? row.caption : `${row.name}: ${row.value}`;
}

export interface ResetCreditsView {
  /** 「可重置 3 次」。 */
  value: string;
  /** 最近三個到期時間還剩多久，再多的以「+N」表示。 */
  timeline: string[];
  /** 展開的說明（Codex：每個到期的日期；Claude：每張券的明細）；空的時候沒有說明按鈕。 */
  detail: ResetDetailRow[];
  /** 說明按鈕給螢幕閱讀器的文字。 */
  detailLabel: string;
  /** 整列給螢幕閱讀器的文字。 */
  ariaLabel: string;
}

/**
 * 額度分頁上的重置券一列（上游 codexResetCreditsNode；Claude 的券帶 grants 時是
 * claudeResetCreditsNode：同樣的一行，說明換成每張券為什麼發、清掉什麼、現在能不能用）。
 * 沒有可用的次數時回 null。
 */
export function resetCreditsView(rc: ResetCredits | null | undefined, now: number): ResetCreditsView | null {
  const value = resetCreditsValue(rc);
  if (!value) return null;
  const dates = resetCreditExpirationDates(rc);
  const shown = dates.slice(0, 3).map((date) => resetCreditExpiryLabel(date, now));
  const hidden = dates.length - shown.length;
  const timeline = hidden > 0 ? [...shown, `+${hidden}`] : shown;
  const grants = rc?.grants ?? [];
  let detail: ResetDetailRow[];
  let detailLabel: string;
  if (grants.length > 0) {
    detail = claudeResetGrantRows(grants, now);
    detailLabel = grants
      .map((grant, index) => {
        const left = Number(grant.resetsLeft);
        const count = Number.isFinite(left) ? t("剩 {n} 次", { n: Math.max(0, Math.floor(left)) }) : "";
        const rows = claudeResetGrantRows([grant], now).map(rowText).join(", ");
        return [t("第 {n} 張", { n: index + 1 }), count, rows].filter(Boolean).join(", ");
      })
      .join("; ");
  } else {
    detail = dates.map((date) => ({ name: expiryDateLabel(date), value: resetCreditExpiryLabel(date, now) }));
    detailLabel = dates
      .map((date, index) => t("第 {n} 次：{when}", { n: index + 1, when: resetCreditExpiryDetailLabel(date, now) }))
      .join(", ");
  }
  const ariaLabel = [t("重置券"), value, dates.map((date) => resetCreditExpiryDetailLabel(date, now)).join(", ")]
    .filter(Boolean)
    .join(", ");
  return { value, timeline, detail, detailLabel, ariaLabel };
}
