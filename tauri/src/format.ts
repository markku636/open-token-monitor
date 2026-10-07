// 數字與時間的顯示格式。全部是純函式，format.test.ts 有測試。

import { t as tr } from "./i18n";

export function fmtTokens(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const abs = Math.abs(v);
  // 先選單位再四捨五入時，999_999 會變成「1000K」：四捨五入後到 1000 就進位到下一個單位
  // （上游 compactTokens.js 的 promotionBoundary）。
  if (abs >= 1e9) return `${trim(v / 1e9, 2)}B`;
  if (abs >= 1e6) {
    const m = trim(v / 1e6, 2);
    return Math.abs(Number(m)) >= 1000 ? `${trim(v / 1e9, 2)}B` : `${m}M`;
  }
  if (abs >= 1e3) {
    const k = trim(v / 1e3, 1);
    return Math.abs(Number(k)) >= 1000 ? `${trim(v / 1e6, 2)}M` : `${k}K`;
  }
  const rounded = Math.round(v);
  return Math.abs(rounded) >= 1000 ? `${trim(v / 1e3, 1)}K` : String(rounded);
}

function trim(v: number, digits: number): string {
  return v.toFixed(digits).replace(/\.?0+$/, "");
}

/** 顯示成本用的幣別（設定 `currency`；匯率由 Rust 決定：手動 > 每日匯率 > 內建）。 */
export interface Money {
  code: string;
  symbol: string;
  rate: number;
}

const USD: Money = { code: "USD", symbol: "$", rate: 1 };
let money: Money = USD;

/** store 收到 `currency-updated` 時呼叫；之後所有 fmtUsd 都換成這個幣別。 */
export function setMoney(m: Money | null | undefined) {
  money = m && Number.isFinite(m.rate) && m.rate > 0 ? m : USD;
}

// 金額是依 API 牌價換算的等值成本（不是實際帳單）。輸入一律是 USD，顯示時換成設定的幣別；
// 固定兩位小數，一萬以上取整數加千分位。
export function fmtUsd(n: number): string {
  const v = (Number.isFinite(n) ? n : 0) * money.rate;
  const s = money.symbol;
  if (v > 0 && v < 0.01) return `<${s}0.01`;
  if (v >= 10_000) return `${s}${Math.round(v).toLocaleString("en-US")}`;
  return `${s}${v.toFixed(2)}`;
}

/** 匯率的顯示：≥ 1 兩位小數、< 1 四位，去掉尾端的 0（上游 `formatRate`）。 */
export function fmtRate(rate: number): string {
  const r = Number.isFinite(rate) ? rate : 0;
  return r.toFixed(r >= 1 ? 2 : 4).replace(/\.?0+$/, "");
}

export function fmtPercent(part: number, total: number): string {
  if (!total || !Number.isFinite(part)) return "0%";
  const p = (part / total) * 100;
  if (p > 0 && p < 1) return "<1%";
  return `${Math.round(p)}%`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return tr("剛剛");
  const m = Math.round(s / 60);
  if (m < 60) return tr("{n} 分鐘前", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return tr("{n} 小時前", { n: h });
  return tr("{n} 天前", { n: Math.round(h / 24) });
}

export function fmtInterval(ms: number): string {
  if (ms <= 0) return tr("即時");
  const m = Math.round(ms / 60_000);
  return m < 60 ? tr("{n} 分鐘", { n: m }) : tr("{n} 小時", { n: Math.round(m / 60) });
}

// 額度的重置時間：「45 分鐘後」「3 小時後」「2 天後」；過去或無效回空字串。
export function fmtUntil(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= now) return "";
  const m = Math.ceil((t - now) / 60_000);
  if (m < 60) return tr("{n} 分鐘後", { n: m });
  const h = Math.round(m / 60);
  if (h < 36) return tr("{n} 小時後", { n: h });
  return tr("{n} 天後", { n: Math.round(h / 24) });
}

// cache 未命中的輸入 = 總量扣掉已分類的三塊（與上游 widget 的「cache miss」一致）。
export function uncachedInput(p: { totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number; unclassifiedTokens: number }): number {
  return Math.max(0, p.totalTokens - p.cacheReadTokens - p.cacheWriteTokens - p.outputTokens - p.unclassifiedTokens);
}

export interface Share {
  key: string;
  tokens: number;
  cost: number;
}

// 依 token 排序取前 `limit` 名，其餘合併成 `__other`。
export function topShares(tokens: Record<string, number>, costs: Record<string, number>, limit = 6): Share[] {
  const all = Object.entries(tokens)
    .map(([key, t]) => ({ key, tokens: t, cost: costs[key] ?? 0 }))
    .filter((s) => s.tokens > 0 || s.cost > 0)
    .sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
  if (all.length <= limit) return all;
  const head = all.slice(0, limit - 1);
  const rest = all.slice(limit - 1);
  head.push({
    key: "__other",
    tokens: rest.reduce((a, s) => a + s.tokens, 0),
    cost: rest.reduce((a, s) => a + s.cost, 0),
  });
  return head;
}
