// 主頁模組的純函式（homeOverview.test.ts 與 homeViews.compat.test.ts 有測試）。逐字移植上游：
// - renderer/homeOverview.js：`remainingPercent`、`usedPercent`、`homeLimitAccounts`、
//   `homeLimitAccountsForProviders`、`homeModelRows`、`homeToolRows`、`homeDeviceRows`、
//   `homeTrendSummary`、`longRangePeakDayTokens`、`homeActivityScrollTarget`、`homeActivityScrollRecord`
// - shared/limitBalanceDisplay.js：`isCreditsWindow`、`creditsAmount`、`creditsCurrency`、`creditsMeterPercent`
// - renderer/usageAttributionRows.js：`attributionRows`、`visibleAttributionRows`
// 以及 app.js `homeLimitRows`、`formatHomeLimitWindowValue`、`homeLimitWindowLabel` 與 homeOverview.js
// `pickHomeHistory` 的 Tauri 版。

import type { HistoryPreview, LimitProvider, LimitsView, LimitWindow, TrendsView } from "./api";
import { t } from "./i18n";
import { limitProviderLabel } from "./limitCatalog";
import type { VendorColorMap } from "./vendorColors";
import { normalizeLimitProviderSelection, orderedLimitProviders } from "./viewPrefs";

/** 上游 homeOverview.js 的 `finiteNumber`：null、undefined、空白字串 → null。 */
function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** limitBalanceDisplay.js 的 `finiteNumber`（只有空字串算空，與上面那個不同）。 */
function balanceNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const clampPercent = (v: number) => Math.max(0, Math.min(100, v));

/** 上游 `windowPriority`：主頁每個帳號只放兩個窗口，依這個順序挑。 */
export const WINDOW_PRIORITY: ReadonlyMap<string, number> = new Map([
  ["session", 0],
  ["daily", 1],
  ["weekly", 2],
  ["billing", 3],
  ["monthly", 4],
]);

/** 主頁吃的窗口：wire 的 LimitWindow 加上其他 provider 才有的欄位（MiMo、antigravity 等之後移植的）。 */
export type LimitWindowLike = Partial<LimitWindow> & {
  boundaryKind?: string;
  resetDescription?: string;
  value?: string;
  planStatus?: string;
  detail?: string;
};

interface Balance {
  amount?: unknown;
  currency?: unknown;
  monthSpend?: unknown;
  planStatus?: string;
  planUsed?: unknown;
  planLimit?: unknown;
  planPercent?: unknown;
}

export interface HomeLimitAccountInput {
  key?: string;
  providerId?: string;
  iconId?: string;
  name?: string;
  color?: string;
  windows?: LimitWindowLike[];
  balance?: Balance | null;
}

export interface HomeLimitWindow {
  kind: string;
  metric: string;
  label: string;
  remainingPercent: number | null;
  remaining: number | null;
  currency: string;
  resetsAt: string | null | undefined;
  boundaryKind?: string;
  resetDescription: string;
  value: string;
  planStatus: string;
  showMeter: boolean;
  detail: string;
}

export interface HomeLimitAccount {
  key: string;
  providerId: string;
  iconId: string;
  name: string;
  color: string;
  lowestRemaining: number;
  windows: HomeLimitWindow[];
}

// ---- limitBalanceDisplay.js ---------------------------------------------------

export function isCreditsWindow(w: { metric?: string | null } | null | undefined): boolean {
  return w?.metric === "credits";
}

function normalizeCurrencyCode(value: unknown): string {
  const code = String(value || "")
    .trim()
    .toUpperCase();
  return /^[A-Z]{3,8}$/.test(code) ? code : "USD";
}

export function creditsAmount(account: { balance?: Balance | null } | null | undefined, w: LimitWindowLike | null | undefined): number | null {
  const fromWindow = balanceNumber(w?.remaining);
  return fromWindow === null ? balanceNumber(account?.balance?.amount) : fromWindow;
}

export function creditsCurrency(account: { balance?: Balance | null } | null | undefined, w: LimitWindowLike | null | undefined): string {
  const fromWindow = String(w?.currency || "").trim();
  if (fromWindow) return normalizeCurrencyCode(fromWindow);
  return normalizeCurrencyCode(account?.balance?.currency);
}

/** 儲值餘額的「剩餘 %」：有真正的百分比就用，否則以本月推估的起始金額換算（只顯示、不上傳）。 */
export function creditsMeterPercent(account: { balance?: Balance | null } | null | undefined, w: LimitWindowLike | null | undefined): number | null {
  const used = balanceNumber(w?.usedPercent);
  if (used !== null) return clampPercent(100 - used);
  const remaining = balanceNumber(w?.remainingPercent);
  if (remaining !== null) return clampPercent(remaining);
  const amount = creditsAmount(account, w);
  if (amount === null) return null;
  const funds = Math.max(0, amount);
  if (funds === 0) return 0;
  const spend = Math.max(0, balanceNumber(account?.balance?.monthSpend) ?? 0);
  return clampPercent((funds / (funds + spend)) * 100);
}

// ---- homeOverview.js ------------------------------------------------------------

/** 上游 `remainingPercent`：`showMeter === false` 的窗口沒有百分比。 */
export function remainingPercent(w: LimitWindowLike | null | undefined): number | null {
  if (!w || w.showMeter === false) return null;
  const remaining = finiteNumber(w.remainingPercent);
  if (remaining != null) return clampPercent(remaining);
  const used = finiteNumber(w.usedPercent);
  return used == null ? null : clampPercent(100 - used);
}

export function usedPercent(w: LimitWindowLike | null | undefined): number | null {
  const remaining = remainingPercent(w);
  return remaining == null ? null : 100 - remaining;
}

function mimoPlanWindow(balance: Balance | null | undefined): LimitWindowLike | null {
  if (!balance || balance.planStatus === "expired") return null;
  const used = finiteNumber(balance.planUsed);
  const limit = finiteNumber(balance.planLimit);
  const percent = finiteNumber(balance.planPercent);
  if (used == null && limit == null && percent == null) return null;
  const usedPct = percent != null ? clampPercent(percent) : used != null && limit != null && limit > 0 ? clampPercent((used / limit) * 100) : null;
  return {
    kind: "billing",
    label: "Token Plan",
    usedPercent: usedPct,
    remainingPercent: usedPct == null ? null : clampPercent(100 - usedPct),
  };
}

function isPlanWindow(w: LimitWindowLike | null | undefined): boolean {
  return (
    String(w?.kind || "")
      .trim()
      .toLowerCase() === "billing" && !isCreditsWindow(w)
  );
}

function accountWindows(account: HomeLimitAccountInput): LimitWindowLike[] {
  const providerId = String(account?.providerId || "")
    .trim()
    .toLowerCase();
  const windows = Array.isArray(account?.windows) ? [...account.windows] : [];
  if (providerId === "mimo" && account?.balance?.planStatus === "expired") {
    const withoutStalePlan = windows.filter((w) => !isPlanWindow(w));
    withoutStalePlan.unshift({ kind: "billing" as LimitWindow["kind"], label: "Token Plan", showMeter: false, planStatus: "expired" });
    return withoutStalePlan;
  }
  if (providerId === "mimo" && !windows.some(isPlanWindow)) {
    const plan = mimoPlanWindow(account.balance);
    if (plan) windows.unshift(plan);
  }
  return windows;
}

/**
 * 上游 `homeLimitAccounts`：每個帳號挑最多兩個有數字的窗口（session → daily → weekly → billing → monthly，
 * antigravity 維持原順序），`remaining` 排序依最低剩餘 % 由少到多，`configured` 依設定的順序，取前 `limit` 個。
 */
export function homeLimitAccounts(accounts: HomeLimitAccountInput[] | null | undefined, limit: number = 3, { sort = "remaining" }: { sort?: string } = {}): HomeLimitAccount[] {
  return (accounts || [])
    .map((account, index) => {
      const providerId = String(account?.providerId || "")
        .trim()
        .toLowerCase();
      const windows = accountWindows(account)
        .map((w, windowIndex) => {
          const credits = isCreditsWindow(w);
          return {
            kind: String(w.kind || "")
              .trim()
              .toLowerCase(),
            metric: w.metric || "",
            label: w.label || w.kind || "",
            remainingPercent: credits ? creditsMeterPercent(account, w) : remainingPercent(w),
            remaining: credits ? creditsAmount(account, w) : finiteNumber(w.remaining),
            currency: credits ? creditsCurrency(account, w) : "",
            resetsAt: w.resetsAt,
            ...(w.boundaryKind ? { boundaryKind: w.boundaryKind } : {}),
            resetDescription: w.resetDescription || "",
            value: w.value || "",
            planStatus: w.planStatus || "",
            showMeter: w.showMeter !== false,
            detail: w.detail || "",
            index: windowIndex,
          };
        })
        .filter(
          (w) => w.remainingPercent != null || w.planStatus === "expired" || w.value || (w.metric === "credits" && (w.remaining != null || w.detail)),
        )
        .sort((a, b) => {
          if (providerId === "antigravity") return a.index - b.index;
          const aPriority = WINDOW_PRIORITY.get(a.kind) ?? 10;
          const bPriority = WINDOW_PRIORITY.get(b.kind) ?? 10;
          return aPriority - bPriority || a.index - b.index;
        })
        .slice(0, 2)
        .map(({ index: _index, ...w }) => w as HomeLimitWindow);
      if (windows.length === 0) return null;
      return {
        key: account.key || String(index),
        providerId: account.providerId || "",
        iconId: account.iconId || "",
        name: account.name || "",
        color: account.color || "",
        lowestRemaining: Math.min(...windows.map((w) => w.remainingPercent ?? 100)),
        windows,
        index,
      };
    })
    .filter((a): a is HomeLimitAccount & { index: number } => a !== null)
    .sort((a, b) => (sort === "configured" ? a.index - b.index : a.lowestRemaining - b.lowestRemaining || a.index - b.index))
    .slice(0, Math.max(0, Number(limit) || 0))
    .map(({ index: _index, ...account }) => account);
}

export interface HomeRowInput {
  key?: string;
  name?: string;
  value?: number;
  color?: string;
}

export interface HomeRow {
  key: string;
  name: string;
  value: number;
  share: number;
  color: string;
}

/** 上游 `homeModelRows`：保留輸入的順序（呼叫端已依 token 排好），占比對傳入的總量，總量是 0 時對加總。 */
export function homeModelRows(rows: HomeRowInput[] | null | undefined, totalTokens: unknown, limit = 5): HomeRow[] {
  const visible = (rows || []).filter((row) => Math.max(0, Number(row?.value || 0)) > 0).slice(0, Math.max(0, Number(limit) || 0));
  const supplied = finiteNumber(totalTokens);
  const total = supplied != null && supplied > 0 ? supplied : visible.reduce((sum, row) => sum + Math.max(0, Number(row?.value || 0)), 0);
  return visible.map((row) => ({
    key: row.key || row.name || "",
    name: row.name || "",
    value: Math.max(0, Number(row.value || 0)),
    share: total > 0 ? Math.max(0, Number(row.value || 0)) / total : 0,
    color: row.color || "",
  }));
}

/** 上游 `homeToolRows`：依 token 由多到少、同數時依名稱，取前 `limit` 個。 */
export function homeToolRows(rows: HomeRowInput[] | null | undefined, totalTokens: unknown, limit = 5): HomeRow[] {
  const visible = (rows || [])
    .map((row) => ({
      key: row?.key || row?.name || "",
      name: row?.name || "",
      value: Math.max(0, Number(row?.value || 0)),
      color: row?.color || "",
    }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, Number(limit) || 0));
  const supplied = finiteNumber(totalTokens);
  const total = supplied != null && supplied > 0 ? supplied : visible.reduce((sum, row) => sum + row.value, 0);
  return visible.map((row) => ({ ...row, share: total > 0 ? row.value / total : 0 }));
}

export interface HomeDeviceInput {
  deviceId?: string;
  displayName?: string;
  hostname?: string;
  platform?: string;
  stale?: boolean;
  periods?: Record<string, { totalTokens?: number } | undefined>;
  [period: string]: unknown;
}

export interface HomeDeviceRow {
  key: string;
  name: string;
  value: number;
  platform: string;
  isLocal: boolean;
  isStale: boolean;
}

/** 上游 `homeDeviceRows`：依 token 由多到少，同數時本機優先、線上優先、原順序。 */
export function homeDeviceRows(
  devices: HomeDeviceInput[] | null | undefined,
  { localDeviceId = "", period = "today", limit = 4 }: { localDeviceId?: string; period?: string; limit?: number } = {},
): HomeDeviceRow[] {
  const localKey = String(localDeviceId || "").trim();
  return (devices || [])
    .map((device, index) => {
      const key = String(device?.deviceId || "").trim() || String(index);
      const direct = device?.[period] as { totalTokens?: number } | undefined;
      const value = Math.max(0, Number(device?.periods?.[period]?.totalTokens || direct?.totalTokens || 0));
      return {
        key,
        name: String(device?.displayName || device?.deviceId || device?.hostname || key).trim(),
        value,
        platform: device?.platform || "",
        isLocal: Boolean(localKey && key === localKey),
        isStale: Boolean(device?.stale),
        index,
      };
    })
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value || Number(b.isLocal) - Number(a.isLocal) || Number(a.isStale) - Number(b.isStale) || a.index - b.index)
    .slice(0, Math.max(0, Number(limit) || 0))
    .map(({ index: _index, ...row }) => row);
}

interface ProviderEntry {
  provider?: string;
  windows?: LimitWindowLike[];
  balance?: Balance | null;
}

export interface HomeLimitAccountsForProvidersInput<P extends ProviderEntry> {
  providers?: P[];
  providerOptions?: { id: string; label?: string }[];
  enabledProviderIds?: readonly string[];
  hiddenProviderIds?: readonly string[];
  colors?: Record<string, string>;
  limit?: number;
  sort?: string;
  accountName?: (provider: P, index: number, entries: P[]) => string;
  accountColor?: (provider: P, id: string, fallback: string) => string;
  accountIcon?: (provider: P, id: string) => string;
}

/** 上游 `homeLimitAccountsForProviders`：依 provider 選項的順序展開每個帳號；啟用清單是空的時不過濾。 */
export function homeLimitAccountsForProviders<P extends ProviderEntry>({
  providers = [],
  providerOptions = [],
  enabledProviderIds = [],
  hiddenProviderIds = [],
  colors = {},
  limit = 3,
  sort = "remaining",
  accountName,
  accountColor,
  accountIcon,
}: HomeLimitAccountsForProvidersInput<P> = {}): HomeLimitAccount[] {
  const norm = (id: unknown) =>
    String(id || "")
      .trim()
      .toLowerCase();
  const enabled = new Set((enabledProviderIds || []).map(norm).filter(Boolean));
  const hidden = new Set((hiddenProviderIds || []).map(norm).filter(Boolean));
  const byId = new Map<string, P[]>();
  for (const provider of providers || []) {
    const id = norm(provider?.provider);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push(provider);
  }
  const accounts: HomeLimitAccountInput[] = [];
  for (const { id: rawId, label } of providerOptions || []) {
    const id = norm(rawId);
    if (!id || hidden.has(id) || (enabled.size > 0 && !enabled.has(id))) continue;
    const entries = byId.get(id) || [];
    entries.forEach((provider, index) => {
      accounts.push({
        key: `${id}:${index}`,
        providerId: id,
        name: typeof accountName === "function" ? accountName(provider, index, entries) : label,
        color: typeof accountColor === "function" ? accountColor(provider, id, colors[id] || colors.default || "") : colors[id] || colors.default || "",
        iconId: typeof accountIcon === "function" ? accountIcon(provider, id) : id,
        windows: provider.windows || [],
        balance: provider.balance || null,
      });
    });
  }
  return homeLimitAccounts(accounts, limit, { sort });
}

/**
 * 上游 `historyHasDays` 的 Tauri 版：trends_get 一定補上今天那一列（可能是 0），30 天預覽也補滿 0，
 * 所以看有沒有哪一天有 token，而不是看列數。
 */
export function historyHasUsage(view: { daily?: readonly { tokens?: unknown }[] | null } | null | undefined): boolean {
  return Array.isArray(view?.daily) && view.daily.some((d) => Number(d?.tokens) > 0);
}

/** 30 天預覽（`LocalStats.history`）→ trends_get 的形狀：只留有用量的日子加上今天（最後一格），與 trends.rs `trends_view` 相同。 */
export function previewTrendsView(preview: HistoryPreview | null | undefined): TrendsView | null {
  const days = Array.isArray(preview?.daily) ? preview.daily : [];
  if (!preview || !days.length) return null;
  const today = days[days.length - 1].date;
  const daily = days.filter((d) => d.tokens > 0 || d.date === today).map((d) => ({ date: d.date, tokens: d.tokens, costUsd: d.costUsd, activeTimeMs: 0 }));
  return {
    today,
    daily,
    monthly: [],
    summary: {
      totalTokens: daily.reduce((sum, d) => sum + d.tokens, 0),
      totalCost: daily.reduce((sum, d) => sum + d.costUsd, 0),
      activeDays: preview.activeDays,
      currentStreak: preview.currentStreak,
      longestStreak: preview.longestStreak,
      peakDayTokens: preview.peakDayTokens,
      favoriteModel: preview.favoriteModel,
      messages: 0,
      activeTimeMs: 0,
    },
  };
}

/**
 * 上游 `pickHomeHistory`：優先用完整的 history（trends_get）；還沒拿到或是空的時改用統計附帶的
 * 30 天預覽——空的 history 不能蓋掉有資料的預覽（上游 #39：冷啟動時比收集器先拿到空結果）。
 * 兩邊都沒有用量時回 null，主頁才顯示空狀態。
 */
export function pickHomeHistory(history: TrendsView | null | undefined, preview: HistoryPreview | null | undefined): TrendsView | null {
  if (history && historyHasUsage(history)) return history;
  const fallback = previewTrendsView(preview);
  return historyHasUsage(fallback) ? fallback : null;
}

/** 上游 `homeTrendSummary`：峰值與第一、中間、最後三個日期標籤。 */
export function homeTrendSummary(points: { date?: string; tokens?: number }[] | null | undefined): { peak: number; dates: string[] } {
  const visible = Array.isArray(points) ? points : [];
  const peak = Math.max(0, ...visible.map((p) => Math.max(0, Number(p?.tokens || 0))));
  const dates =
    visible.length === 0
      ? []
      : [visible[0]?.date || "", visible[Math.floor((visible.length - 1) / 2)]?.date || "", visible[visible.length - 1]?.date || ""];
  return { peak, dates };
}

/** 上游 `longRangePeakDayTokens`：summary 的峰值與每日最大值取大的。 */
export function longRangePeakDayTokens({ historySummary, daily }: { historySummary?: { peakDayTokens?: unknown } | null; daily?: { tokens?: unknown }[] | null } = {}): number {
  const summaryPeak = finiteNumber(historySummary?.peakDayTokens);
  const dailyPeak = (Array.isArray(daily) ? daily : []).reduce((peak, row) => Math.max(peak, finiteNumber(row?.tokens) || 0), 0);
  return Math.max(0, summaryPeak || 0, dailyPeak);
}

function maxScrollLeft(scrollWidth: unknown, clientWidth: unknown): number {
  return Math.max(0, Number(scrollWidth || 0) - Number(clientWidth || 0));
}

/** 上游 `homeActivityScrollTarget`：跟著最右邊（最新）時貼齊右緣，否則把記住的位置夾進目前的寬度。 */
export function homeActivityScrollTarget({ scrollWidth, clientWidth, followEnd, savedLeft }: { scrollWidth?: number; clientWidth?: number; followEnd?: boolean; savedLeft?: number | null } = {}): number {
  const max = maxScrollLeft(scrollWidth, clientWidth);
  if (followEnd || savedLeft == null) return max;
  const saved = Number(savedLeft);
  if (!Number.isFinite(saved)) return max;
  return Math.max(0, Math.min(max, saved));
}

/** 上游 `homeActivityScrollRecord`：還沒溢出（版面沒定）時回 null，避免太早量到的 0 蓋掉記住的位置。 */
export function homeActivityScrollRecord({
  scrollLeft,
  scrollWidth,
  clientWidth,
  endThreshold = 2,
}: { scrollLeft?: number; scrollWidth?: number; clientWidth?: number; endThreshold?: number } = {}): { scrollLeft: number; followEnd: boolean } | null {
  const max = maxScrollLeft(scrollWidth, clientWidth);
  if (max <= 0) return null;
  const left = Math.max(0, Math.min(max, Number(scrollLeft || 0)));
  return { scrollLeft: left, followEnd: left >= max - endThreshold };
}

// ---- usageAttributionRows.js ----------------------------------------------------

export const UNATTRIBUTED_KEY = "__unattributed";

export interface AttributionRow {
  key: string;
  value: number;
  cost: number;
  unattributed?: true;
}

const num0 = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 上游 `attributionRows`：有 token 或成本的列，總量大於加總的餘數推成「未分類」。 */
export function attributionRows(
  values: Record<string, unknown> | null | undefined,
  costs: Record<string, unknown> | null | undefined,
  options: { totalValue?: unknown; totalCost?: unknown; unattributedKey?: string } = {},
): AttributionRow[] {
  const valueMap = values && typeof values === "object" ? values : {};
  const costMap = costs && typeof costs === "object" ? costs : {};
  const keys = new Set([...Object.keys(valueMap), ...Object.keys(costMap)]);
  const rows: AttributionRow[] = Array.from(keys, (key) => ({ key, value: num0(valueMap[key]), cost: num0(costMap[key]) })).filter((row) => row.value > 0 || row.cost > 0);
  const attributedValue = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0);
  const attributedCost = rows.reduce((sum, row) => sum + Math.max(0, row.cost), 0);
  const remainderValue = Math.max(0, num0(options.totalValue) - attributedValue);
  const remainderCost = Math.max(0, Number((num0(options.totalCost) - attributedCost).toFixed(6)));
  if (remainderValue > 0 || remainderCost > 0) {
    rows.push({ key: options.unattributedKey || UNATTRIBUTED_KEY, value: remainderValue, cost: remainderCost, unattributed: true });
  }
  return rows;
}

/** 上游 `visibleAttributionRows`：未分類只有 token 是 0、成本也顯示成 0 時才拿掉。 */
export function visibleAttributionRows(rows: AttributionRow[] | null | undefined, formatCost?: (v: number) => string): AttributionRow[] {
  const source = Array.isArray(rows) ? rows : [];
  if (typeof formatCost !== "function") return source;
  const zeroCost = String(formatCost(0));
  return source.filter((row) => row?.unattributed !== true || num0(row.value) > 0 || String(formatCost(row.cost)) !== zeroCost);
}

/** 上游 `rankRowsWithValues(rows, 'tokens')` 的排序：token 由多到少、同數時依 key。 */
export function rankByTokens<R extends { key?: string; name?: string; value: number }>(rows: R[]): R[] {
  return [...rows].sort((a, b) => num0(b.value) - num0(a.value) || String(a.key || a.name || "").localeCompare(String(b.key || b.name || "")));
}

// ---- Tauri 的組裝（app.js 的 homeLimitRows / formatHomeLimitWindowValue / homeLimitWindowLabel） ----

/** codex 的額外窗口（各模型的 additional）主頁不顯示（上游 limitProviderPresentation.js `limitProviderCompactWindows`）。 */
export function compactLimitWindows(p: Pick<LimitProvider, "provider" | "windows">): LimitWindow[] {
  if (p.provider === "codex") return p.windows.filter((w) => w.additional !== true);
  return p.windows;
}

export interface HomeLimitSettings {
  supportedLimitProviders?: readonly string[];
  homeLimitProviderOrder?: string;
  /** 另一個缺口移植 `limitProviderOrder` 後，主頁在沒有自己的順序時沿用它（上游相同）。 */
  limitProviderOrder?: string;
  hiddenHomeLimitProviders?: string;
  limitsEnabled?: boolean;
  limitProviders?: readonly string[];
  homeLimitAccountCount?: number;
  showHomeLimitProviderNames?: boolean;
  /** 關閉工具圖示時一律顯示 provider 名稱（上游「隱藏工具圖示時仍顯示提供者名稱」）。 */
  showToolIcons?: boolean;
}

/** 多帳號時是否一定要顯示 provider 名稱：工具圖示關掉時就一定要（上游 app.js `showToolIcons === false`）。 */
export function providerNamesRequired(s: Pick<HomeLimitSettings, "showToolIcons"> | null | undefined): boolean {
  return s?.showToolIcons === false;
}

/** 上游 app.js `homeLimitRows`。`colors` 是生效的廠商色（useVendorColors）。 */
export function homeLimitRows(
  limits: LimitsView | null | undefined,
  s: HomeLimitSettings | null | undefined,
  colors: VendorColorMap = {},
): HomeLimitAccount[] {
  const catalog = s?.supportedLimitProviders ?? [];
  const providerOrder = s?.homeLimitProviderOrder || s?.limitProviderOrder;
  const options = orderedLimitProviders(catalog, providerOrder);
  const namesRequired = providerNamesRequired(s);
  return homeLimitAccountsForProviders<LimitProvider>({
    providers: (limits?.providers ?? []).map((p) => ({ ...p, windows: compactLimitWindows(p) })),
    providerOptions: options.map((id) => ({ id, label: limitProviderLabel(id) })),
    enabledProviderIds: s?.limitsEnabled === false ? [] : (s?.limitProviders ?? []),
    hiddenProviderIds: normalizeLimitProviderSelection(s?.hiddenHomeLimitProviders, catalog),
    // 上游 `{ ...clientColors, factory: clientColors.droid }`：Factory 的額度用 Droid 的顏色。
    colors: { ...colors, factory: colors.droid },
    limit: s?.homeLimitAccountCount ?? 3,
    sort: s?.homeLimitProviderOrder ? "configured" : "remaining",
    accountName: (provider, index, entries) => {
      const label = limitProviderLabel(provider.provider);
      if (entries.length <= 1) return label;
      // 上游的 limitAccountTitle 依 provider 各有規則；共用的額度列移植前先用信箱或方案名稱。
      const title = provider.accountEmail || provider.accountLabel || t("帳號 {n}", { n: index + 1 });
      return namesRequired || s?.showHomeLimitProviderNames === true ? `${label} · ${title}` : title;
    },
  });
}

/** 上游 limitBalanceDisplay.js `formatMoney` / `formatCompactMoney`（十萬以上用精簡單位）。 */
function formatMoney(value: number, currency: string): string {
  const code = normalizeCurrencyCode(currency);
  const symbols: Record<string, string> = { CNY: "¥", USD: "$" };
  if (Math.abs(value) >= 100_000) {
    const prefix = code === "CREDITS" ? "" : symbols[code] || `${code} `;
    return `${prefix}${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value)}`;
  }
  if (code === "CREDITS") return value.toFixed(2);
  const symbol = symbols[code];
  return symbol ? `${symbol}${value.toFixed(2)}` : `${code} ${value.toFixed(2)}`;
}

/** 上游 app.js `formatHomeLimitWindowValue`（`window.value` 優先）。 */
export function homeLimitValueText(w: HomeLimitWindow, showUsed: boolean): string {
  if (w.value) return w.value;
  if (w.planStatus === "expired") return t("方案已到期");
  if (String(w.detail || "").toLowerCase() === "unlimited") return t("無限制");
  if (isCreditsWindow(w)) {
    if (w.remaining == null) return w.detail || "--";
    return formatMoney(w.remaining, w.currency);
  }
  // 上游 limitFillPercent：只看 remainingPercent（主頁的窗口一定有）。
  const remaining = Number(w.remainingPercent);
  const fill = Number.isFinite(remaining) ? (showUsed ? 100 - remaining : remaining) : 0;
  const pct = `${Math.round(fill)}%`;
  return showUsed ? t("{pct} 已用", { pct }) : t("{pct} 剩餘", { pct });
}

/** 上游 app.js `homeLimitWindowLabel`：有名稱的 billing 窗口用名稱，其他依種類（用額度分頁既有的字）。 */
export function homeLimitWindowLabel(w: HomeLimitWindow): string {
  if (w.kind === "billing") {
    const label = String(w.label || "").trim();
    if (label && label !== "billing") return label;
  }
  switch (w.kind) {
    case "session":
      return t("5 小時");
    case "daily":
      return t("每日");
    case "weekly":
      return t("每週");
    case "billing":
    case "monthly":
      return t("每月");
    default:
      return w.label;
  }
}
