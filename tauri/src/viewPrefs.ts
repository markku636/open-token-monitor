// widget 的視圖與主頁模組偏好（純函式，viewPrefs.test.ts 與 homeViews.compat.test.ts 有測試）。
// 演算法照上游 renderer 的 viewDisplayPreferences.js、homeModulePreferences.js、limitProviderOrder.js，
// 以及 app.js 的 `effectiveViewDisplayOrderValue`、`availableBreakdownIds`、`disabledViewIds`、
// `nextBreakdown`、`homeModuleIds`。上游的函式拿 `{id}` 物件清單，這裡直接拿 id 清單；
// compat 測試把同一份清單交給上游比對。Rust 端的設定正規化在 src-tauri/src/view_prefs.rs。

import type { Breakdown } from "./store";
import { t } from "./i18n";

/** Tauri widget 的視圖（上游 id）。model / project / session 在「本機」視圖裡是拆分，不是獨立視圖。 */
export type ViewId = "home" | "tool" | "status" | "device" | "limits" | "trends";

/** 上游 `DEFAULT_VIEW_LIST` 的順序（main.js:437），去掉 model / project / session。 */
export const VIEW_IDS: readonly ViewId[] = ["home", "tool", "status", "device", "limits", "trends"];

export const VIEW_OPTIONS: readonly { id: ViewId; label: string }[] = [
  { id: "home", label: t("主頁") },
  { id: "tool", label: t("本機") },
  { id: "status", label: t("狀態") },
  { id: "device", label: t("全公司") },
  { id: "limits", label: t("額度") },
  { id: "trends", label: t("趨勢") },
];

export function viewLabel(id: ViewId): string {
  return VIEW_OPTIONS.find((v) => v.id === id)?.label ?? id;
}

/** 舊的分頁 id（localStorage `tm:view.tab`、`?tab=`、tray 與邊緣額度條的 `open-tab`）→ 視圖。 */
export const LEGACY_VIEW: Readonly<Record<string, ViewId>> = {
  local: "tool",
  company: "device",
  limits: "limits",
  trends: "trends",
};

export function parseViewId(v: unknown): ViewId | null {
  const id = String(v ?? "").trim().toLowerCase();
  if ((VIEW_IDS as readonly string[]).includes(id)) return id as ViewId;
  return LEGACY_VIEW[id] ?? null;
}

type Csv = string | readonly unknown[] | null | undefined;

function normalizeId(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function csvItems(value: Csv): readonly unknown[] {
  return Array.isArray(value) ? value : String(value || "").split(",");
}

function knownIds(ids: readonly string[]): string[] {
  return ids.map(normalizeId).filter(Boolean);
}

/** 上游 `hasCustomViewDisplayOrder`。 */
export function hasCustomViewDisplayOrder(value: Csv): boolean {
  return csvItems(value).some((item) => normalizeId(item));
}

/** 上游 `normalizeViewDisplayOrder`：已知 id 依第一次出現的順序、去重，缺的依清單順序補上。 */
export function normalizeViewDisplayOrder(value: Csv, ids: readonly string[]): string[] {
  const known = knownIds(ids);
  const knownSet = new Set(known);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const item of csvItems(value)) {
    const id = normalizeId(item);
    if (!knownSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const id of known) {
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  return order;
}

/** 上游 `normalizeHiddenViews`：已知 id 依輸入順序去重；全部隱藏時回空字串。 */
export function normalizeHiddenViews(value: Csv, ids: readonly string[]): string {
  const known = knownIds(ids);
  const knownSet = new Set(known);
  const seen = new Set<string>();
  const hidden: string[] = [];
  for (const item of csvItems(value)) {
    const id = normalizeId(item);
    if (!knownSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    hidden.push(id);
  }
  return hidden.length >= known.length ? "" : hidden.join(",");
}

export function orderedViews(ids: readonly ViewId[], value: Csv): ViewId[] {
  return normalizeViewDisplayOrder(value, ids) as ViewId[];
}

/** 上游 `moveViewDisplayOrder`：與相鄰的交換；做不到時回正規化後的順序。 */
export function moveViewDisplayOrder(value: Csv, ids: readonly string[], id: string, direction: "up" | "down"): string {
  const order = normalizeViewDisplayOrder(value, ids);
  const from = order.indexOf(normalizeId(id));
  const offset = direction === "up" ? -1 : direction === "down" ? 1 : 0;
  const to = from + offset;
  if (from < 0 || offset === 0 || to < 0 || to >= order.length) return order.join(",");
  const [item] = order.splice(from, 1);
  order.splice(to, 0, item);
  return order.join(",");
}

/** 上游 `reorderViewDisplayOrder`：目標位置夾在 0…len-1。 */
export function reorderViewDisplayOrder(value: Csv, ids: readonly string[], id: string, targetIndex: number): string {
  const order = normalizeViewDisplayOrder(value, ids);
  const from = order.indexOf(normalizeId(id));
  if (from < 0) return order.join(",");
  const to = Math.max(0, Math.min(order.length - 1, Number(targetIndex) || 0));
  if (from === to) return order.join(",");
  const [item] = order.splice(from, 1);
  order.splice(to, 0, item);
  return order.join(",");
}

export interface VisibleViewInput {
  ids: readonly string[];
  orderValue?: Csv;
  hiddenValue?: Csv;
  availableIds?: readonly string[];
  includeIds?: readonly string[];
}

/**
 * 上游 `visibleViewOrder`：依順序、可用、沒隱藏（或在 includeIds 裡：tray 開啟的隱藏視圖）的視圖；
 * 一個都沒有時回第一個可用的，切換鈕永遠有東西可顯示。
 */
export function visibleViewOrder({ ids, orderValue, hiddenValue, availableIds, includeIds }: VisibleViewInput): string[] {
  const ordered = normalizeViewDisplayOrder(orderValue, ids);
  const available = new Set((availableIds || ordered).map(normalizeId).filter(Boolean));
  const hidden = new Set(normalizeHiddenViews(hiddenValue, ids).split(",").filter(Boolean));
  const included = new Set((includeIds || []).map(normalizeId).filter(Boolean));
  const visible = ordered.filter((id) => available.has(id) && (!hidden.has(id) || included.has(id)));
  if (visible.length > 0) return visible;
  return ordered.filter((id) => available.has(id)).slice(0, 1);
}

/** 上游 `visibleViewCount`：停用的視圖（history 關閉時的趨勢）不算可見。 */
export function visibleViewCount({ ids, hiddenValue, disabledIds }: { ids: readonly string[]; hiddenValue?: Csv; disabledIds?: readonly string[] }): number {
  const hidden = new Set(normalizeHiddenViews(hiddenValue, ids).split(",").filter(Boolean));
  const disabled = new Set(knownIds(disabledIds || []));
  return knownIds(ids).filter((id) => !hidden.has(id) && !disabled.has(id)).length;
}

/** 上游 `preferredViewId`：目前的視圖還看得到就留著（`preferFirst` 除外），否則第一個可見的。 */
export function preferredViewId({
  currentId,
  preferFirst = false,
  fallback = "tool",
  ...input
}: Omit<VisibleViewInput, "includeIds"> & { currentId?: string; preferFirst?: boolean; fallback?: string }): string {
  const order = visibleViewOrder(input);
  const current = normalizeId(currentId);
  if (!preferFirst && order.includes(current)) return current;
  return order[0] || fallback;
}

/** 上游 app.js `effectiveViewDisplayOrderValue`：自訂的順序缺主頁時把主頁放在最前面。 */
export function effectiveViewDisplayOrderValue(raw: string | null | undefined): string {
  const rawIds = String(raw || "")
    .split(",")
    .map(normalizeId)
    .filter(Boolean);
  if (rawIds.length > 0 && !rawIds.includes("home")) {
    const normalized = normalizeViewDisplayOrder(raw, VIEW_IDS);
    return ["home", ...normalized.filter((id) => id !== "home")].join(",");
  }
  return String(raw || "");
}

interface AvailabilitySettings {
  historyEnabled?: boolean;
  limitsEnabled?: boolean;
  limitProviders?: readonly string[];
}

/**
 * 上游 `availableBreakdownIds`：history 關閉時沒有趨勢；額度關閉或一個 provider 都沒選時沒有額度。
 * 設定還沒載入時全部可用（不先把使用者踢到別的視圖）。
 */
export function availableViewIds(s: AvailabilitySettings | null | undefined): ViewId[] {
  return VIEW_IDS.filter((id) => {
    if (id === "trends") return s?.historyEnabled !== false;
    if (id === "limits") return s?.limitsEnabled !== false && (s?.limitProviders?.length ?? 1) > 0;
    return true;
  });
}

/** 上游 `disabledViewIds`：設定頁畫成隱藏、不算進可見數量的視圖。 */
export function disabledViewIds(s: AvailabilitySettings | null | undefined): ViewId[] {
  return s?.historyEnabled === false ? ["trends"] : [];
}

/** 上游 `nextBreakdown`：下一個視圖，最後一個之後回到第一個；不在清單裡時到第一個。 */
export function nextView(order: readonly string[], current: string): string {
  if (order.length === 0) return "home";
  const index = order.indexOf(current);
  return order[(index + 1) % order.length] || order[0];
}

// ---- 主頁模組（homeModulePreferences.js） --------------------------------------

export type HomeModuleId = "limits" | "tool" | "device" | "model" | "trends";

export const HOME_MODULE_IDS: readonly HomeModuleId[] = ["limits", "tool", "device", "model", "trends"];
export const DEFAULT_HOME_MODULE_ORDER = "limits,tool,device,model,trends";

/** 上游 app.js `HOME_MODULE_OPTIONS`：模組 → 點下去打開的視圖（模型在 Tauri 是本機視圖的模型拆分）。 */
export const HOME_MODULE_OPTIONS: readonly { id: HomeModuleId; label: string; view: ViewId; breakdown?: Breakdown }[] = [
  { id: "limits", label: t("額度"), view: "limits" },
  { id: "tool", label: t("工具"), view: "tool", breakdown: "client" },
  { id: "device", label: t("裝置"), view: "device" },
  { id: "model", label: t("模型"), view: "tool", breakdown: "model" },
  { id: "trends", label: t("活動"), view: "trends" },
];

/** 上游 `normalizeHomeModuleOrder`：空值用預設順序，永遠回完整的排列。 */
export function normalizeHomeModuleOrder(value: Csv, ids: readonly string[] = HOME_MODULE_IDS): string[] {
  const known = knownIds(ids);
  const knownSet = new Set(known);
  const raw = Array.isArray(value) ? value : String(value || DEFAULT_HOME_MODULE_ORDER).split(",");
  const seen = new Set<string>();
  const order: string[] = [];
  for (const item of raw) {
    const id = normalizeId(item);
    if (!knownSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const id of known) {
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  return order;
}

/** 上游 `normalizeHiddenHomeModules`：全部隱藏時回空字串。 */
export function normalizeHiddenHomeModules(value: Csv, ids: readonly string[] = HOME_MODULE_IDS): string {
  return normalizeHiddenViews(value, ids);
}

function moveInOrder(order: string[], id: string, direction: "up" | "down"): string {
  const from = order.indexOf(normalizeId(id));
  const offset = direction === "up" ? -1 : direction === "down" ? 1 : 0;
  const to = from + offset;
  if (from < 0 || offset === 0 || to < 0 || to >= order.length) return order.join(",");
  const [item] = order.splice(from, 1);
  order.splice(to, 0, item);
  return order.join(",");
}

function reorderInOrder(order: string[], id: string, targetIndex: number): string {
  const from = order.indexOf(normalizeId(id));
  if (from < 0) return order.join(",");
  const to = Math.max(0, Math.min(order.length - 1, Number(targetIndex) || 0));
  if (from === to) return order.join(",");
  const [item] = order.splice(from, 1);
  order.splice(to, 0, item);
  return order.join(",");
}

export function moveHomeModuleOrder(value: Csv, id: string, direction: "up" | "down", ids: readonly string[] = HOME_MODULE_IDS): string {
  return moveInOrder(normalizeHomeModuleOrder(value, ids), id, direction);
}

export function reorderHomeModuleOrder(value: Csv, id: string, targetIndex: number, ids: readonly string[] = HOME_MODULE_IDS): string {
  return reorderInOrder(normalizeHomeModuleOrder(value, ids), id, targetIndex);
}

/** 上游 app.js `homeModuleIds`：依順序、去掉隱藏的模組。 */
export function homeModuleIds(s: { homeModuleOrder?: string; hiddenHomeModules?: string } | null | undefined): HomeModuleId[] {
  const hidden = new Set(normalizeHiddenHomeModules(s?.hiddenHomeModules ?? "tool,device").split(",").filter(Boolean));
  return normalizeHomeModuleOrder(s?.homeModuleOrder).filter((id) => !hidden.has(id)) as HomeModuleId[];
}

// ---- 額度 provider 的順序（limitProviderOrder.js） --------------------------------

/** 上游 `normalizeLimitProviderOrder`：已知 id，缺的補在後面。 */
export function normalizeLimitProviderOrder(value: Csv, ids: readonly string[]): string[] {
  return normalizeViewDisplayOrder(value, ids);
}

/** 上游 `normalizeLimitProviderSelection`：已知 id、去重，不補。 */
export function normalizeLimitProviderSelection(value: Csv, ids: readonly string[]): string[] {
  const knownSet = new Set(knownIds(ids));
  const seen = new Set<string>();
  const selection: string[] = [];
  for (const item of csvItems(value)) {
    const id = normalizeId(item);
    if (!knownSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    selection.push(id);
  }
  return selection;
}

export function orderedLimitProviders(ids: readonly string[], value: Csv): string[] {
  return normalizeLimitProviderOrder(value, ids);
}

export function moveLimitProvider(value: Csv, ids: readonly string[], id: string, direction: "up" | "down"): string {
  return moveInOrder(normalizeLimitProviderOrder(value, ids), id, direction);
}

export function reorderLimitProvider(value: Csv, ids: readonly string[], id: string, targetIndex: number): string {
  return reorderInOrder(normalizeLimitProviderOrder(value, ids), id, targetIndex);
}
