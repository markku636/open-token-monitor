// 明細清單的純函式（detailFormat.test.ts 有測試）。規則照上游 renderer：
// fixedPeriodRanges.js `tokenComponentBreakdown`、toolDetails.js `detailPercentLabel` /
// `tokenInputPercentages`、usageAttributionRows.js `visibleAttributionRows`、
// sessionRows.js `sessionIdLabel` / `compactSessionTime` / `sessionModelLabel` / `messageLabel`、
// projectRows.js `clientGradient`、sessionLive.js 的 10 分鐘「進行中」。

import { fmtUsd } from "./format";

export interface TokenParts {
  cacheRead: number;
  cacheMiss: number;
  output: number;
  unclassified: number;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 快取未命中 = 總量 − 未分類 − 快取讀取 − 輸出（快取寫入算在未命中裡，與上游相同）。 */
export function tokenComponentBreakdown(
  total: number,
  c: { cacheReadTokens: number; outputTokens: number; unclassifiedTokens: number },
): TokenParts {
  const t = Math.max(0, num(total));
  const unclassified = Math.min(t, Math.max(0, num(c.unclassifiedTokens)));
  const classified = t - unclassified;
  const cacheRead = Math.min(classified, Math.max(0, num(c.cacheReadTokens)));
  const output = Math.min(classified - cacheRead, Math.max(0, num(c.outputTokens)));
  const cacheMiss = Math.max(0, classified - cacheRead - output);
  return { cacheRead, cacheMiss, output, unclassified };
}

/** 快取命中／未命中各佔「輸入」（命中 + 未命中）的百分比。 */
export function inputPercentages(parts: TokenParts): { hit: number; miss: number } {
  const input = parts.cacheRead + parts.cacheMiss;
  return input > 0 ? { hit: (parts.cacheRead / input) * 100, miss: (parts.cacheMiss / input) * 100 } : { hit: 0, miss: 0 };
}

export function detailPercentLabel(percent: number): string {
  const p = Math.max(0, num(percent));
  if (p > 0 && p < 1) return "<1%";
  return `${Math.round(Math.min(100, p))}%`;
}

/** 未分類那一列在 token 為 0、成本也顯示成 $0.00 時不顯示。 */
export function visibleShares<T extends { tokens: number; costUsd: number; unattributed?: boolean }>(rows: T[]): T[] {
  const zero = fmtUsd(0);
  return rows.filter((r) => r.unattributed !== true || r.tokens > 0 || fmtUsd(r.costUsd) !== zero);
}

const UUID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi;

/** session id 的顯示：取出 UUID（Codex 的 rollout 檔名、合併的多個 id），純時間戳不顯示。 */
export function sessionIdLabel(id: string): string {
  const raw = String(id || "").trim();
  if (!raw) return "";
  const uuids = raw.match(UUID) ?? [];
  if (uuids.length > 1) return uuids.join(" · ");
  const rollout = raw.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}[:-]\d{2}[:-]\d{2}-(.+)$/);
  if (rollout) return uuids[0] ?? rollout[1];
  if (/^\d{4}-\d{2}-\d{2}T\d{2}[:-]\d{2}/.test(raw)) return "";
  return raw;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 今天的只顯示 HH:mm，其他日子 MM/DD HH:mm（本地時間）。 */
export function compactSessionTime(iso: string, now: Date = new Date()): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${time}`;
}

/** 單一模型顯示名稱，多個顯示「N models」（上游刻意不翻譯）。 */
export function sessionModelLabel(models: string[]): string {
  if (models.length === 0) return "";
  if (models.length === 1) return models[0];
  return `${models.length} models`;
}

/** tokscale 的 messageCount 是有用量的回覆數，上游刻意以英文「calls」顯示（計費單位，不翻）。 */
export function callsLabel(count: number): string {
  const n = Math.round(num(count));
  if (n <= 0) return "";
  return `${n.toLocaleString("en-US")} ${n === 1 ? "call" : "calls"}`;
}

/** 最後活動在 10 分鐘內（上游 sessionLive.js 的 running；我們沒有 transcript，不看 turnEnded）。 */
export const LIVE_WINDOW_MS = 10 * 60_000;

export function isLive(iso: string, now: number = Date.now()): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && now - t >= 0 && now - t <= LIVE_WINDOW_MS;
}

/** 專案列的長條：依各工具 token 比例的漸層，交界處混色 ±min(1.5%, 各自一半)。 */
export function clientGradient(clients: { key: string; tokens: number }[], colorFor: (key: string) => string, fallback: string): string {
  const entries = clients
    .map((c) => ({ key: c.key, value: Math.max(0, num(c.tokens)) }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  if (entries.length === 0) return fallback;
  const colors = entries.map((e) => colorFor(e.key) || fallback);
  if (entries.length === 1) return colors[0];
  const total = entries.reduce((s, e) => s + e.value, 0);
  const stops = [`${colors[0]} 0%`];
  let cumulative = 0;
  for (let i = 0; i < entries.length - 1; i += 1) {
    const current = (entries[i].value / total) * 100;
    const next = (entries[i + 1].value / total) * 100;
    cumulative += current;
    const blend = Math.min(1.5, current / 2, next / 2);
    stops.push(`${colors[i]} ${Math.max(0, cumulative - blend).toFixed(2)}%`);
    stops.push(`${colors[i + 1]} ${Math.min(100, cumulative + blend).toFixed(2)}%`);
  }
  stops.push(`${colors[colors.length - 1]} 100%`);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

const STABLE_COLORS = ["#6ab4f0", "#cc7c5e", "#a57df0", "#49a3b0", "#f0d66a", "#f06a7b"];

/** 依字串雜湊的固定顏色（上游 sessionRows.js `stableColor`）。 */
export function stableColor(value: string, colors: readonly string[] = STABLE_COLORS): string {
  let hash = 0;
  for (const ch of String(value || "")) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length] ?? STABLE_COLORS[0];
}

/** 長條寬度：相對於所有列的最大值，至少 2%；值為 0 時不畫。 */
export function barWidth(value: number, max: number): number {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.max(2, (value / max) * 100);
}

/** 上游 deviceBreakdown.js `devicePlatformLabel`：OS 名稱（沒有時由 platform 推）＋版本。 */
export function devicePlatformLabel(platform: string, osName: string | null, osVersion: string | null): string {
  const p = String(platform || "").toLowerCase().split("-")[0];
  const fallback = p === "darwin" ? "macOS" : p === "win32" ? "Windows" : p === "linux" ? "Linux" : String(platform || "");
  return [String(osName || "").trim() || fallback, String(osVersion || "").trim()].filter(Boolean).join(" ");
}

// ---- session 逐回合明細（上游 renderer/sessionDetail.js）------------------------------

export interface ExchangeRow {
  key: string;
  isPrompt: boolean;
  title: string;
  subtitle: string;
  value: number;
  cost: number;
  startTime: number;
  turns: { key: string; label: string; value: number; cost: number; split: string; tools: string }[];
}

const timeValue = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** 一輪的 token 組成：`in X · out Y · cache Z`（快取 = 讀 + 寫），有推理時加 `· reason R`。 */
export function turnSplit(t: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }, fmt: (n: number) => string): string {
  const parts = [`in ${fmt(t.input)}`, `out ${fmt(t.output)}`, `cache ${fmt(t.cacheRead + t.cacheWrite)}`];
  if (t.reasoning > 0) parts.push(`reason ${fmt(t.reasoning)}`);
  return parts.join(" · ");
}

/**
 * 上游 `exchangeRows`：每則提問一列（沒有提問的開頭是「(session start)」，不翻譯），副標是
 * 「時間 · N turns · N tools」（上游刻意不翻譯的計數），可依時間（新到舊）或 token 排序。
 */
export function exchangeRows(
  exchanges: {
    promptPreview: string;
    startedAt: string;
    turnCount: number;
    tools: string[];
    tokens: { total: number };
    costEstimate: number;
    turns: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number }; tools: string[]; costEstimate: number }[];
  }[],
  sortBy: "time" | "tokens",
  fmt: (n: number) => string,
  now: Date = new Date(),
): ExchangeRow[] {
  const rows = exchanges.map((ex, i) => {
    const toolCount = ex.tools.length;
    const subtitle = [
      compactSessionTime(ex.startedAt, now),
      `${ex.turnCount} turn${ex.turnCount === 1 ? "" : "s"}`,
      toolCount > 0 ? `${toolCount} tool${toolCount === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      key: `exchange:${i}`,
      isPrompt: Boolean(ex.promptPreview),
      title: ex.promptPreview || "(session start)",
      subtitle,
      value: ex.tokens.total,
      cost: ex.costEstimate,
      startTime: timeValue(ex.startedAt),
      turns: ex.turns.map((t, j) => ({
        key: `turn:${j}`,
        label: `Reply #${j + 1}`,
        value: t.tokens.total,
        cost: t.costEstimate,
        split: turnSplit(t.tokens, fmt),
        tools: [...new Set(t.tools.filter(Boolean))].join(" · "),
      })),
    };
  });
  if (sortBy === "tokens") rows.sort((a, b) => b.value - a.value || b.startTime - a.startTime);
  else rows.sort((a, b) => b.startTime - a.startTime || b.value - a.value);
  return rows;
}
