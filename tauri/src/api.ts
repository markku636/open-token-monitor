// 前端與 Rust 之間唯一的介面。型別對應
// src-tauri/src/gui/state.rs 與 src-tauri/src/display.rs 的 DTO，欄位一律 camelCase。
//
// 不在 Tauri 裡（純瀏覽器開 vite dev、vitest）時改用 mock，方便調版面。

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type WindowMode = "floating" | "normal" | "desktop" | "tray";
export type ThemeSetting = "system" | "dark" | "light";
export type ValueSource = "cli" | "env" | "settings" | "keyring" | "baked" | "none";
export type ClientStatus = "active" | "waiting" | "missing";
export type UploadState = "disabled" | "pending" | "ok" | "error";
export type PeriodName = "today" | "month" | "allTime";
/** 由每日歷史推出的範圍（src-tauri/src/ranges.rs）。 */
export type RangeName = "week" | "last7" | "last30";
/** widget 的期間選擇：tokscale 的三個期間或推出的範圍。 */
export type Selection = PeriodName | RangeName;

export interface Settings {
  version: number;
  deviceId: string;
  hubUrl: string;
  /** 使用者的公司信箱，隨上傳送給 hub 以自動對應員工；空字串 = 不回報。 */
  ownerEmail: string;
  syncUploadIntervalMs: number;
  trackedClients: string[];
  customScanPaths: Record<string, string[]>;
  allTimeSince: string;
  projectsEnabled: boolean;
  collectionIntervalMs: number;
  tokscaleTimeoutMs: number;
  watchEnabled: boolean;
  watchDebounceMs: number;
  sessionUsageArchiveEnabled: boolean;
  historyEnabled: boolean;
  historyIntervalMs: number;
  limitsEnabled: boolean;
  limitProviders: string[];
  limitsRefreshMs: number;
  /** `fixed` = 每 limitsRefreshMs；`adaptive` = 每 5 分鐘，快用完的額度提早（最快每分鐘）。 */
  limitsRefreshMode: "fixed" | "adaptive";
  language: "auto" | "zh-TW" | "en";
  theme: ThemeSetting;
  automaticAppUpdates: boolean;
  appUpdateDismissedVersion: string;
  showLiveTokenRate: boolean;
  tokenRateMode: "speed" | "burn";
  currency: string;
  currencyRates: Record<string, number>;
  exportAutoEnabled: boolean;
  exportDir: string;
  exportIntervalMs: number;
  serviceStatusRefreshMs: number;
  modelAliases: Record<string, string>;
  modelAliasGrouping: "off" | "duplicates" | "prefix";
  windowMode: WindowMode;
  keepAboveTaskbar: boolean;
  floatingBubbleEnabled: boolean;
  edgeDockEnabled: boolean;
  edgeDockSide: "right" | "left";
  edgeDockOffset: number;
  opacity: number;
  trayContent: "icon" | "bars" | "barsSessions";
  systemGlass: boolean;
  zoomFactor: number;
  windowToggleShortcut: string;
  autostart: boolean;
}

export interface SettingsView extends Settings {
  hub: {
    url: string | null;
    urlSource: ValueSource;
    secretMasked: string | null;
    secretSource: ValueSource;
    bakedUrl: string | null;
  };
  buildChannel: "corp" | "dev";
  appVersion: string;
  supportedClients: string[];
}

export type SettingsPatch = Partial<
  Pick<
    Settings,
    | "ownerEmail"
    | "syncUploadIntervalMs"
    | "trackedClients"
    | "projectsEnabled"
    | "collectionIntervalMs"
    | "watchEnabled"
    | "sessionUsageArchiveEnabled"
    | "historyEnabled"
    | "historyIntervalMs"
    | "limitsEnabled"
    | "limitProviders"
    | "limitsRefreshMs"
    | "limitsRefreshMode"
    | "windowMode"
    | "keepAboveTaskbar"
    | "floatingBubbleEnabled"
    | "edgeDockEnabled"
    | "edgeDockSide"
    | "edgeDockOffset"
    | "opacity"
    | "trayContent"
    | "systemGlass"
    | "zoomFactor"
    | "windowToggleShortcut"
    | "autostart"
    | "language"
    | "theme"
    | "automaticAppUpdates"
    | "appUpdateDismissedVersion"
    | "showLiveTokenRate"
    | "tokenRateMode"
    | "currency"
    | "currencyRates"
    | "exportAutoEnabled"
    | "exportIntervalMs"
    | "serviceStatusRefreshMs"
    | "modelAliases"
    | "modelAliasGrouping"
  >
>;

export interface PeriodTotals {
  totalTokens: number;
  costUsd: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  unclassifiedTokens: number;
  sessionCount: number;
  clients: Record<string, number>;
  clientCosts: Record<string, number>;
  models: Record<string, number>;
  modelCosts: Record<string, number>;
  timedTokens: number;
  timedOutputTokens: number;
  timedDurationMs: number;
  throughput: boolean;
}

export interface LocalStats {
  deviceId: string;
  hostname: string;
  updatedAt: string;
  periods: Record<PeriodName, PeriodTotals>;
  periodWindows: { timeZone?: string; today: { key: string; endsAt: string }; month: { key: string; endsAt: string } };
  trackedClients: string[];
  clientStatus: Record<string, ClientStatus>;
  history: HistoryPreview | null;
}

/** 近 30 天（display.rs `HistoryPreview`）：以今天結尾、連續，今天是即時數字。 */
export interface HistoryPreview {
  daily: { date: string; tokens: number; costUsd: number }[];
  currentStreak: number;
  longestStreak: number;
  activeDays: number;
  peakDayTokens: number;
  favoriteModel: string;
}

export type SyncState = "synced" | "notSignedIn" | "noData" | "failed";

export interface SyncReport {
  client: string;
  state: SyncState;
  rows?: number | null;
  message?: string;
  at: string;
}

export interface AppStatus {
  collecting: boolean;
  lastCollectAt: string | null;
  lastCollectError: string | null;
  uploadState: UploadState;
  hubUrl: string | null;
  lastUploadAt: string | null;
  lastUploadError: string | null;
  lastUploadErrorCode: string | null;
  nextUploadAt: string | null;
  uploadIntervalMs: number;
  fatal: string | null;
  selfSync: Record<string, SyncReport>;
  watching: boolean;
  watchRoots: string[];
  watchError: string | null;
  hubStream: HubStreamState | null;
  hubStreamError: string | null;
  lastHistoryAt: string | null;
  historyDays: number;
  historyError: string | null;
  windowShortcut: "off" | "registered" | "unregistered" | "";
}

// 額度（對應 src-tauri/src/wire/limits.rs；hub 上的 limits 也是這個形狀）。
export type ProviderStatus =
  | "ok"
  | "disabled"
  | "notConfigured"
  | "unauthorized"
  | "rateLimited"
  | "sourceRateLimited"
  | "unavailable"
  | "error";

export interface LimitWindow {
  kind: "session" | "daily" | "weekly" | "billing";
  metric?: string;
  limitId?: string;
  additional?: boolean;
  label: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
  currency: string | null;
  showMeter: boolean;
}

export interface LimitProvider {
  provider: string;
  accountKey: string;
  accountLabel: string;
  accountEmail: string;
  status: ProviderStatus;
  source: string;
  updatedAt: string | null;
  windows: LimitWindow[];
}

export interface LimitsView {
  updatedAt: string | null;
  refreshMs: number;
  providers: LimitProvider[];
  nextAt: string;
}

// 全公司（對應 src-tauri/src/display.rs 的 CompanyStats）。
export type HubStreamState = "connecting" | "connected" | "reconnecting" | "unauthorized";

export interface CompanyTotals {
  totalTokens: number;
  costUsd: number;
  clients: Record<string, number>;
  clientCosts: Record<string, number>;
  models: Record<string, number>;
  modelCosts: Record<string, number>;
}

export interface Brief {
  totalTokens: number;
  costUsd: number;
}

export interface DeviceRow {
  deviceId: string;
  hostname: string;
  platform: string;
  osName: string | null;
  agentRuntime: string;
  agentVersion: string;
  isLocal: boolean;
  stale: boolean;
  ageMs: number | null;
  today: Brief;
  month: Brief;
  allTime: Brief;
  topClient: string | null;
}

/** AI 服務的線上狀態（src-tauri/src/service_status.rs）。 */
export interface ServiceStatus {
  id: string;
  label: string;
  pageUrl: string;
  status: "ok" | "degraded" | "outage" | "unknown";
  description: string;
  checkedAt: string;
  componentIssues: string[];
  incidentTitle: string;
  incidentCount: number;
  maintenanceCount: number;
  error: string | null;
}

/** 自動匯出的最近結果（src-tauri/src/gui/export.rs）。 */
export interface ExportStatus {
  lastAt: string | null;
  lastError: string | null;
}

/** 成本的顯示幣別（src-tauri/src/currency.rs `CurrencyView`）。 */
export interface CurrencyView {
  code: string;
  symbol: string;
  rate: number;
  mode: "manual" | "live" | "default";
  date: string | null;
}

/** 全公司分頁點開一台裝置（display.rs `DeviceDetail`）。 */
export interface DeviceDetail {
  deviceId: string;
  platform: string;
  osName: string | null;
  osVersion: string | null;
  agentRuntime: string;
  agentVersion: string;
  receivedAt: string | null;
  isLocal: boolean;
  totalTokens: number;
  tools: { key: string; tokens: number; percent: number; models: [string, number][] }[];
}

export interface CompanyStats {
  hubUpdatedAt: string | null;
  staleAfterMs: number | null;
  deviceCount: number;
  onlineCount: number;
  periods: Record<PeriodName, CompanyTotals>;
  devices: DeviceRow[];
}

export interface Diagnostics {
  appVersion: string;
  buildChannel: string;
  deviceId: string;
  hostname: string;
  os: string;
  platform: string;
  configDir: string;
  logDir: string;
  tokscalePath: string | null;
  tokscaleSource: string | null;
  uptimeMs: number;
  status: AppStatus;
  electronWidgetInstalled: boolean;
}

export interface AppError {
  kind: string;
  code: string;
  message: string;
}

// 本機明細（對應 src-tauri/src/detail.rs；打開畫面時才要，不隨掃描推送）。
export interface Share {
  key: string;
  tokens: number;
  costUsd: number;
  unattributed?: boolean;
}

export interface TokenComponents {
  cacheReadTokens: number;
  outputTokens: number;
  unclassifiedTokens: number;
}

export interface UsageRow extends Share {
  components: TokenComponents | null;
  models?: Share[];
}

export interface ProjectRow {
  key: string;
  label: string;
  tokens: number;
  costUsd: number;
  clients: Share[];
}

export interface PeriodDetail {
  totalTokens: number;
  costUsd: number;
  tools: UsageRow[];
  models: UsageRow[];
  projects: ProjectRow[];
  sessionCount: number;
}

export interface SessionRow {
  kind: "session";
  key: string;
  client: string;
  sessionId: string;
  models: string[];
  totalTokens: number;
  costUsd: number;
  messageCount: number;
  at: string;
  archived?: boolean;
}

export interface ReviewGroup {
  kind: "review";
  count: number;
  totalTokens: number;
  costUsd: number;
  latestAt: string;
  latestTokens: number;
}

/** session 的逐回合明細（src-tauri/src/session_detail.rs）。 */
export interface DetailTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface DetailTurn {
  timestamp: string;
  tokens: DetailTokens;
  tools: string[];
  costEstimate: number;
}

export interface DetailExchange {
  promptPreview: string;
  startedAt: string;
  endedAt: string;
  turnCount: number;
  tools: string[];
  tokens: DetailTokens;
  costEstimate: number;
  turns: DetailTurn[];
}

export interface SessionDetail {
  found: boolean;
  client: string;
  sessionId: string;
  period: string;
  exchanges: DetailExchange[];
  totalTokens: number;
  costUsd: number;
  turnCount: number;
}

export interface SessionPage {
  total: number;
  page: number;
  pageSize: number;
  maxTokens: number;
  rows: (SessionRow | ReviewGroup)[];
}

// 趨勢分頁（對應 src-tauri/src/trends.rs）。
export interface TrendDay {
  date: string;
  tokens: number;
  costUsd: number;
  activeTimeMs: number;
}

export interface TrendMonth {
  month: string;
  tokens: number;
  costUsd: number;
  activeTimeMs: number;
}

export interface TrendsView {
  today: string;
  daily: TrendDay[];
  monthly: TrendMonth[];
  summary: {
    totalTokens: number;
    totalCost: number;
    activeDays: number;
    currentStreak: number;
    longestStreak: number;
    peakDayTokens: number;
    favoriteModel: string;
    messages: number;
    activeTimeMs: number;
  };
}

/** 儀表板趨勢圖的一天（src-tauri/src/trends.rs `SeriesDay`）。 */
export interface SeriesDay {
  date: string;
  tokens: number;
  clients: Record<string, number>;
  models: Record<string, number>;
}

// 本星期／最近 7 日／最近 30 日（對應 src-tauri/src/ranges.rs 的 RangeResult）。
export interface RangeSummary {
  activeDays: number;
  currentStreak: number;
  activeTimeMs: number;
  peakDayTokens: number;
}

export type RangeResult =
  | { status: "ready"; start: string; end: string; totals: PeriodTotals; detail: PeriodDetail; summary: RangeSummary }
  | { status: "loading" }
  | { status: "disabled" };

/** 全公司的範圍（src-tauri/src/gui/views.rs `CompanyRange`）。 */
export type CompanyRangeResult =
  | { status: "ready"; start: string; end: string; totals: PeriodTotals; detail: PeriodDetail; summary: RangeSummary }
  | { status: "loading" }
  | { status: "error"; message: string };

// 對應 src-tauri/src/update.rs 的 UpdateState（serde tag = "state"）。
export type UpdateDisabledReason = "devBuild" | "debugBuild" | "noPublicKey" | "noHub" | "invalidHub";
export type UpdateState =
  | { state: "disabled"; reason: UpdateDisabledReason }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "upToDate"; checkedAt: string }
  | { state: "available"; version: string; notes: string | null; date: string | null }
  | { state: "downloading"; version: string; received: number; total: number | null }
  | { state: "ready"; version: string; notes: string | null; date: string | null }
  | { state: "installing"; version: string }
  | { state: "error"; message: string; retryAt: string | null };

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return mock(cmd, args) as T;
  return tauriInvoke<T>(cmd, args);
}

export const api = {
  settingsGet: () => invoke<SettingsView>("settings_get"),
  settingsUpdate: (patch: SettingsPatch) => invoke<SettingsView>("settings_update", { patch }),
  hubSetOverride: (o: { url?: string | null; secret?: string | null }) =>
    invoke<SettingsView>("hub_set_override", { url: o.url ?? null, secret: o.secret ?? null }),
  statsGet: () => invoke<LocalStats | null>("stats_get"),
  statusGet: () => invoke<AppStatus>("status_get"),
  usageRescan: () => invoke<void>("usage_rescan"),
  windowShowReady: () => invoke<void>("window_show_ready"),
  windowToggle: () => invoke<void>("window_toggle"),
  windowHide: () => invoke<void>("window_hide"),
  windowOpenSettings: () => invoke<void>("window_open_settings"),
  windowOpenDashboard: () => invoke<void>("window_open_dashboard"),
  appDiagnostics: () => invoke<Diagnostics>("app_diagnostics"),
  appOpenLogDir: () => invoke<void>("app_open_log_dir"),
  appQuit: () => invoke<void>("app_quit"),
  companyGet: () => invoke<CompanyStats | null>("company_get"),
  uiLanguage: (lang: "zh-TW" | "en") => invoke<void>("ui_language", { lang }),
  limitsGet: () => invoke<LimitsView | null>("limits_get"),
  bubbleGet: () => invoke<BubbleView | null>("bubble_get"),
  bubbleExpand: () => invoke<void>("bubble_expand"),
  bubbleCollapse: () => invoke<void>("bubble_collapse"),
  dockGet: () => invoke<DockView | null>("dock_get"),
  dockExpand: (cells: number) => invoke<void>("dock_expand", { cells }),
  dockCollapse: () => invoke<void>("dock_collapse"),
  dockOpenLimits: () => invoke<void>("dock_open_limits"),
  limitsRefresh: () => invoke<void>("limits_refresh"),
  cursorSetToken: (token: string) => invoke<void>("cursor_set_token", { token }),
  copilotLoginStart: () => invoke<CopilotDeviceCode>("copilot_login_start"),
  copilotLogout: () => invoke<void>("copilot_logout"),
  copilotSignedIn: () => invoke<boolean>("copilot_signed_in"),
  updateState: () => invoke<UpdateState>("update_state"),
  updateCheck: () => invoke<UpdateState>("update_check"),
  updateDownload: () => invoke<UpdateState>("update_download"),
  updateInstall: () => invoke<void>("update_install"),
  usageDetail: (period: PeriodName) => invoke<PeriodDetail | null>("usage_detail", { period }),
  sessionDetailGet: (client: string, sessionId: string, period: PeriodName, sessionCost: number) =>
    invoke<SessionDetail>("session_detail_get", { client, sessionId, period, sessionCost }),
  usageSessions: (period: PeriodName, page: number) => invoke<SessionPage | null>("usage_sessions", { period, page }),
  trendsGet: () => invoke<TrendsView | null>("trends_get"),
  historySeriesGet: () => invoke<SeriesDay[] | null>("history_series_get"),
  rangeGet: (range: RangeName, weekStart: number) => invoke<RangeResult | null>("range_get", { range, weekStart }),
  currencyGet: () => invoke<CurrencyView>("currency_get"),
  exportPickDir: () => invoke<string | null>("export_pick_dir"),
  exportNow: () => invoke<string | null>("export_now"),
  exportStatus: () => invoke<ExportStatus>("export_status"),
  serviceStatusGet: (force: boolean) => invoke<ServiceStatus[]>("service_status_get", { force }),
  serviceStatusOpen: (id: string) => invoke<void>("service_status_open", { id }),
  companyRangeGet: (range: RangeName, weekStart: number) =>
    invoke<CompanyRangeResult>("company_range_get", { range, weekStart }),
  companyDevice: (deviceId: string, period: PeriodName) => invoke<DeviceDetail | null>("company_device", { deviceId, period }),
};

function on<T>(name: string) {
  return (cb: (payload: T) => void): Promise<UnlistenFn> => {
    if (!isTauri()) return Promise.resolve(() => {});
    return listen<T>(name, (e) => cb(e.payload));
  };
}

export const onStatsUpdated = on<LocalStats>("stats-updated");
export const onStatusUpdated = on<AppStatus>("status-updated");
export const onSettingsChanged = on<SettingsView>("settings-changed");
export const onUpdateState = on<UpdateState>("update-state");
export const onCompanyUpdated = on<CompanyStats>("company-updated");
export const onLimitsUpdated = on<LimitsView>("limits-updated");
export const onCurrencyUpdated = on<CurrencyView>("currency-updated");
/** tray 選單的「開啟 ▸ 本機／全公司／額度」。 */
export const onOpenTab = on<string>("open-tab");
/** Copilot device flow（src-tauri/src/gui/commands.rs `copilot_login_start`）。 */
export interface CopilotDeviceCode {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}
export const onCopilotLogin = on<{ state: "done" | "error"; message: string }>("copilot-login");
/** 浮動泡泡收合／還原（src-tauri/src/gui/bubble.rs）。 */
export interface BubbleView {
  collapsed: boolean;
  side: "left" | "right" | null;
}
export const onBubbleState = on<BubbleView>("bubble-state");
/** 邊緣額度條（src-tauri/src/gui/dock.rs）。 */
export interface DockView {
  expanded: boolean;
  side: "right" | "left";
}
export const onDockState = on<DockView>("dock-state");

// ---- 瀏覽器預覽用的假資料 ----------------------------------------------------

function mockPeriod(scale: number): PeriodTotals {
  return {
    totalTokens: 38_766_423 * scale,
    costUsd: 119.89 * scale,
    outputTokens: 1_089_083 * scale,
    cacheReadTokens: 33_101_492 * scale,
    cacheWriteTokens: 4_562_316 * scale,
    unclassifiedTokens: 0,
    sessionCount: 8 * scale,
    timedTokens: 30_000_000 * scale,
    timedOutputTokens: 900_000 * scale,
    timedDurationMs: 21_000_000 * scale,
    throughput: true,
    clients: { claude: 30_000_000 * scale, codex: 6_000_000 * scale, copilot: 2_766_423 * scale },
    clientCosts: { claude: 100 * scale, codex: 15 * scale, copilot: 4.89 * scale },
    models: { "claude-fable-5-1": 28_000_000 * scale, "gpt-5.5": 6_000_000 * scale, "claude-haiku-4-5": 2_000_000 * scale, "gpt-4.1": 2_766_423 * scale },
    modelCosts: { "claude-fable-5-1": 98 * scale, "gpt-5.5": 15 * scale, "claude-haiku-4-5": 2 * scale, "gpt-4.1": 4.89 * scale },
  };
}

function mockHistory(todayKey: string): HistoryPreview {
  const daily = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(`${todayKey}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (29 - i));
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    const tokens = weekend ? (i % 3 === 0 ? 2_000_000 : 0) : Math.round(20_000_000 + 25_000_000 * Math.abs(Math.sin(i * 1.7)));
    return { date: d.toISOString().slice(0, 10), tokens: i === 29 ? 38_766_423 : tokens, costUsd: tokens / 320_000 };
  });
  return { daily, currentStreak: 3, longestStreak: 12, activeDays: 24, peakDayTokens: 45_000_000, favoriteModel: "claude-fable-5-1" };
}

function mockLimits(now: string): LimitsView {
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const win = (kind: LimitWindow["kind"], label: string, pct: number | null, h: number): LimitWindow => ({
    kind,
    label,
    used: null,
    limit: null,
    remaining: null,
    usedPercent: pct,
    remainingPercent: pct === null ? null : 100 - pct,
    resetsAt: inHours(h),
    windowMinutes: null,
    currency: null,
    showMeter: true,
  });
  return {
    updatedAt: now,
    refreshMs: 300_000,
    nextAt: inHours(0.08),
    providers: [
      {
        provider: "claude",
        accountKey: "sha256:preview",
        accountLabel: "Max 20x",
        accountEmail: "preview@example.com",
        status: "ok",
        source: "oauth",
        updatedAt: now,
        windows: [
          win("session", "", 34, 3),
          win("weekly", "", 76, 90),
          win("weekly", "Fable", 92, 90),
          { ...win("billing", "Usage credits", 11.75, 400), metric: "spend", used: 2.35, limit: 20, currency: "USD", resetsAt: null },
        ],
      },
      { provider: "codex", accountKey: "", accountLabel: "", accountEmail: "", status: "notConfigured", source: "", updatedAt: now, windows: [] },
    ],
  };
}

function mockCompany(now: string): CompanyStats {
  const hosts = ["PREVIEW-PC", "PC-LAPTOP-012", "PC-LAPTOP-031", "PC-DESKTOP-007", "PC-LAPTOP-044", "PC-LAPTOP-058"];
  const devices: DeviceRow[] = hosts.map((hostname, i) => {
    const scale = [1, 2.4, 1.6, 0.8, 0.3, 0][i];
    const brief = (k: number) => ({ totalTokens: Math.round(38_766_423 * scale * k), costUsd: 119.89 * scale * k });
    return {
      deviceId: `dev-${i}`,
      hostname,
      platform: "win32-x64",
      osName: "Windows 11",
      agentRuntime: i === 3 ? "electron-widget" : "tauri-widget",
      agentVersion: i === 3 ? "0.61.0-corp.1" : "0.1.0",
      isLocal: i === 0,
      stale: i === 5,
      ageMs: i === 0 ? 0 : i * 90_000,
      today: brief(1),
      month: brief(9),
      allTime: brief(20),
      topClient: ["claude", "codex", "claude", "cursor", "copilot", null][i],
    };
  });
  const totals = (k: number): CompanyTotals => ({ ...mockPeriod(6 * k) });
  return {
    hubUpdatedAt: now,
    staleAfterMs: 600_000,
    deviceCount: devices.length,
    onlineCount: devices.filter((d) => !d.stale).length,
    periods: { today: totals(1), month: totals(9), allTime: totals(20) },
    devices: devices.sort((a, b) => b.today.totalTokens - a.today.totalTokens),
  };
}

function mockDetail(scale: number): PeriodDetail {
  const p = mockPeriod(scale);
  const comp = (tokens: number): TokenComponents => ({
    cacheReadTokens: Math.round(tokens * 0.85),
    outputTokens: Math.round(tokens * 0.03),
    unclassifiedTokens: 0,
  });
  const row = (key: string, tokens: number, costUsd: number, models?: Share[]): UsageRow => ({ key, tokens, costUsd, components: comp(tokens), models });
  return {
    totalTokens: p.totalTokens,
    costUsd: p.costUsd,
    tools: [
      row("claude", p.clients.claude, p.clientCosts.claude, [
        { key: "claude-fable-5-1", tokens: p.models["claude-fable-5-1"], costUsd: p.modelCosts["claude-fable-5-1"] },
        { key: "claude-haiku-4-5", tokens: p.models["claude-haiku-4-5"], costUsd: p.modelCosts["claude-haiku-4-5"] },
      ]),
      row("codex", p.clients.codex, p.clientCosts.codex, [{ key: "gpt-5.5", tokens: p.models["gpt-5.5"], costUsd: p.modelCosts["gpt-5.5"] }]),
      row("copilot", p.clients.copilot, p.clientCosts.copilot),
    ],
    models: Object.entries(p.models).map(([k, v]) => row(k, v, p.modelCosts[k])),
    projects: [
      {
        key: "token-monitor",
        label: "token-monitor",
        tokens: 22_000_000 * scale,
        costUsd: 70 * scale,
        clients: [
          { key: "claude", tokens: 18_000_000 * scale, costUsd: 0 },
          { key: "codex", tokens: 4_000_000 * scale, costUsd: 0 },
        ],
      },
      { key: "demo-app", label: "demo-app", tokens: 12_000_000 * scale, costUsd: 40 * scale, clients: [{ key: "claude", tokens: 12_000_000 * scale, costUsd: 0 }] },
      { key: "website", label: "website", tokens: 4_766_423 * scale, costUsd: 9.89 * scale, clients: [{ key: "copilot", tokens: 2_766_423 * scale, costUsd: 0 }, { key: "codex", tokens: 2_000_000 * scale, costUsd: 0 }] },
    ],
    sessionCount: 8 * scale,
  };
}

function mockSessions(page: number): SessionPage {
  const now = Date.now();
  const rows: SessionPage["rows"] = Array.from({ length: 8 }, (_, i) => ({
    kind: "session" as const,
    key: `s${i}`,
    client: i % 3 === 1 ? "codex" : "claude",
    sessionId: i % 3 === 1 ? `rollout-2026-09-24T10-00-00-0199a1b2-c3d4-7e5f-8a9b-${String(i).padStart(12, "0")}` : `5f0c3a1e-7b2d-4c9e-8f10-${String(i).padStart(12, "0")}`,
    models: i % 3 === 1 ? ["gpt-5.5"] : i === 2 ? ["claude-fable-5-1", "claude-haiku-4-5"] : ["claude-fable-5-1"],
    totalTokens: Math.round(9_000_000 / (i + 1)),
    costUsd: 28 / (i + 1),
    messageCount: 120 - i * 13,
    at: new Date(now - i * 47 * 60_000).toISOString(),
  }));
  rows.push({ kind: "review", count: 3, totalTokens: 1_240_000, costUsd: 1.2, latestAt: new Date(now - 90 * 60_000).toISOString(), latestTokens: 410_000 });
  return { total: rows.length, page, pageSize: 100, maxTokens: 9_000_000, rows };
}

function mockTrends(today: string): TrendsView {
  const daily: TrendDay[] = [];
  const end = new Date(`${today}T00:00:00Z`);
  for (let back = 364; back >= 0; back -= 1) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - back);
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    // 前半年較少用，週末偶爾用：熱力圖才有層次。
    const ramp = back > 200 ? 0.25 : 1;
    const tokens = weekend ? (back % 5 === 0 ? 3_000_000 : 0) : Math.round(ramp * (10_000_000 + 30_000_000 * Math.abs(Math.sin(back * 0.9))));
    if (tokens > 0) daily.push({ date: d.toISOString().slice(0, 10), tokens, costUsd: tokens / 320_000, activeTimeMs: Math.round(tokens / 8_000) * 1000 });
  }
  const months = new Map<string, TrendMonth>();
  for (const d of daily) {
    const m = months.get(d.date.slice(0, 7)) ?? { month: d.date.slice(0, 7), tokens: 0, costUsd: 0, activeTimeMs: 0 };
    m.tokens += d.tokens;
    m.costUsd += d.costUsd;
    m.activeTimeMs += d.activeTimeMs;
    months.set(m.month, m);
  }
  return {
    today,
    daily,
    monthly: [...months.values()],
    summary: {
      totalTokens: daily.reduce((s, d) => s + d.tokens, 0),
      totalCost: daily.reduce((s, d) => s + d.costUsd, 0),
      activeDays: daily.length,
      currentStreak: 3,
      longestStreak: 21,
      peakDayTokens: Math.max(...daily.map((d) => d.tokens)),
      favoriteModel: "claude-fable-5-1",
      messages: 48_210,
      activeTimeMs: daily.reduce((s, d) => s + d.activeTimeMs, 0),
    },
  };
}

function mock(cmd: string, args?: Record<string, unknown>): unknown {
  const settings: SettingsView = {
    version: 1,
    deviceId: "preview-device",
    hubUrl: "",
    ownerEmail: "",
    syncUploadIntervalMs: 600_000,
    trackedClients: ["claude", "codex", "copilot"],
    customScanPaths: {},
    allTimeSince: "2024-01-01",
    projectsEnabled: true,
    collectionIntervalMs: 300_000,
    tokscaleTimeoutMs: 120_000,
    watchEnabled: true,
    watchDebounceMs: 1_500,
    sessionUsageArchiveEnabled: true,
    historyEnabled: true,
    historyIntervalMs: 900_000,
    limitsEnabled: true,
    limitProviders: ["claude", "codex"],
    limitsRefreshMs: 300_000,
    limitsRefreshMode: "fixed",
    language: "auto",
    theme: "system",
    automaticAppUpdates: true,
    appUpdateDismissedVersion: "",
    showLiveTokenRate: true,
    tokenRateMode: "speed",
    currency: new URLSearchParams(location.search).get("currency") ?? "USD",
    currencyRates: {},
    exportAutoEnabled: true,
    exportDir: String.raw`C:\Users\preview\OneDrive\Token Monitor`,
    exportIntervalMs: 60_000,
    serviceStatusRefreshMs: 60_000,
    modelAliases: { "claude-haiku-4-5": "Haiku 4.5" },
    modelAliasGrouping: "duplicates",
    windowMode: "floating",
    keepAboveTaskbar: true,
    floatingBubbleEnabled: false,
    edgeDockEnabled: false,
    edgeDockSide: "right",
    edgeDockOffset: 0.3,
    opacity: 92,
    trayContent: "icon",
    systemGlass: true,
    zoomFactor: 1,
    windowToggleShortcut: "CommandOrControl+Shift+T",
    autostart: true,
    hub: { url: "https://tokens.example.internal", urlSource: "baked", secretMasked: "••••ab12", secretSource: "baked", bakedUrl: "https://tokens.example.internal" },
    buildChannel: "dev",
    appVersion: __APP_VERSION__,
    supportedClients: ["claude", "codex", "opencode", "hermes", "cursor", "antigravity", "copilot"],
  };
  const now = new Date().toISOString();
  switch (cmd) {
    case "settings_get":
      return settings;
    case "settings_update":
      return { ...settings, ...(args?.patch as object) };
    case "stats_get":
      return {
        deviceId: "preview-device",
        hostname: "PREVIEW-PC",
        updatedAt: now,
        periods: { today: mockPeriod(1), month: mockPeriod(9), allTime: mockPeriod(20) },
        periodWindows: { today: { key: now.slice(0, 10), endsAt: now }, month: { key: now.slice(0, 7), endsAt: now } },
        trackedClients: ["claude", "codex", "copilot"],
        clientStatus: { claude: "active", codex: "active", copilot: "waiting" },
        history: mockHistory(now.slice(0, 10)),
      } satisfies LocalStats;
    case "status_get":
      return {
        collecting: false,
        lastCollectAt: now,
        lastCollectError: null,
        uploadState: "ok",
        hubUrl: "https://tokens.example.internal",
        lastUploadAt: now,
        lastUploadError: null,
        lastUploadErrorCode: null,
        nextUploadAt: new Date(Date.now() + 600_000).toISOString(),
        uploadIntervalMs: 600_000,
        fatal: null,
        selfSync: { cursor: { client: "cursor", state: "notSignedIn", at: now } },
        watching: true,
        watchRoots: [String.raw`C:\Users\preview\.claude\projects`],
        watchError: null,
        hubStream: "connected",
        hubStreamError: null,
        lastHistoryAt: now,
        historyDays: 214,
        historyError: null,
        windowShortcut: "registered",
      } satisfies AppStatus;
    case "company_get":
      return mockCompany(now);
    case "limits_get":
      return mockLimits(now);
    case "usage_detail":
      return mockDetail(args?.period === "allTime" ? 20 : args?.period === "month" ? 9 : 1);
    case "service_status_get": {
      const base = { componentIssues: [] as string[], incidentTitle: "", incidentCount: 0, maintenanceCount: 0, error: null, checkedAt: new Date(Date.now() - 12_000).toISOString() };
      return [
        { ...base, id: "claude", label: "Claude", pageUrl: "https://status.claude.com", status: "degraded", description: "Partially Degraded Service", componentIssues: ["Claude API"], incidentTitle: "Elevated errors on Claude Haiku 4.5", incidentCount: 1 },
        { ...base, id: "openai", label: "OpenAI", pageUrl: "https://status.openai.com", status: "ok", description: "All Systems Operational" },
        { ...base, id: "cursor", label: "Cursor", pageUrl: "https://status.cursor.com", status: "ok", description: "All Systems Operational", maintenanceCount: 1 },
        { ...base, id: "deepseek", label: "DeepSeek", pageUrl: "https://status.deepseek.com", status: "unknown", description: "Unable to check status", error: "timeout" },
      ] satisfies ServiceStatus[];
    }
    case "export_status":
      return { lastAt: now, lastError: null } satisfies ExportStatus;
    case "currency_get": {
      // 截圖用：`?currency=TWD`。
      const code = new URLSearchParams(location.search).get("currency") ?? "USD";
      const symbols: Record<string, [string, number]> = { USD: ["$", 1], TWD: ["NT$", 32.15], HKD: ["HK$", 7.79], CNY: ["¥", 7.1] };
      const [symbol, rate] = symbols[code] ?? symbols.USD;
      return { code, symbol, rate, mode: code === "USD" ? "default" : "live", date: now.slice(0, 10) } satisfies CurrencyView;
    }
    case "company_device":
      return {
        deviceId: String(args?.deviceId ?? ""),
        platform: "win32-x64",
        osName: "Windows 11",
        osVersion: "10.0.26200",
        agentRuntime: "tauri-widget",
        agentVersion: "0.1.0",
        receivedAt: new Date(Date.now() - 180_000).toISOString(),
        isLocal: false,
        totalTokens: 38_766_423,
        tools: [
          { key: "claude", tokens: 30_000_000, percent: 77.4, models: [["claude-fable-5-1", 28_000_000], ["claude-haiku-4-5", 2_000_000]] },
          { key: "codex", tokens: 6_000_000, percent: 15.5, models: [["gpt-5.5", 6_000_000]] },
          { key: "copilot", tokens: 2_766_423, percent: 7.1, models: [] },
        ],
      } satisfies DeviceDetail;
    case "company_range_get": {
      const totals = { ...mockPeriod(6 * (args?.range === "last30" ? 12 : args?.range === "last7" ? 4 : 2)), sessionCount: 0 };
      const detail = mockDetail(1);
      return {
        status: "ready",
        start: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10),
        end: now.slice(0, 10),
        totals,
        detail: { ...detail, projects: [], sessionCount: 0 },
        summary: { activeDays: 5, currentStreak: 3, activeTimeMs: 0, peakDayTokens: 0 },
      } satisfies CompanyRangeResult;
    }
    case "range_get": {
      const days = args?.range === "last30" ? 30 : args?.range === "last7" ? 7 : 4;
      const detail = mockDetail(days / 2);
      const totals = { ...mockPeriod(days / 2), sessionCount: 0 };
      const start = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      return {
        status: "ready",
        start,
        end: now.slice(0, 10),
        totals,
        detail: { ...detail, projects: [], sessionCount: 0 },
        summary: { activeDays: Math.min(days, 5), currentStreak: 3, activeTimeMs: days * 5_400_000, peakDayTokens: 45_000_000 },
      } satisfies RangeResult;
    }
    case "history_series_get":
      return mockTrends(now.slice(0, 10)).daily.map((d, i): SeriesDay => ({
        date: d.date,
        tokens: d.tokens,
        clients: { claude: Math.round(d.tokens * 0.7), codex: Math.round(d.tokens * 0.2), copilot: d.tokens - Math.round(d.tokens * 0.7) - Math.round(d.tokens * 0.2) },
        models: i % 3 ? { "claude-fable-5-1": Math.round(d.tokens * 0.7), "gpt-5.5": d.tokens - Math.round(d.tokens * 0.7) } : { "claude-haiku-4-5": d.tokens },
      })) satisfies SeriesDay[];
    case "trends_get":
      return mockTrends(now.slice(0, 10));
    case "session_detail_get": {
      const t = (i: number, o: number, cr: number, cw: number, r = 0): DetailTokens => ({ input: i, output: o, cacheRead: cr, cacheWrite: cw, reasoning: r, total: i + o + cr + cw });
      const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
      const turn = (m: number, tokens: DetailTokens, tools: string[]): DetailTurn => ({ timestamp: at(m), tokens, tools, costEstimate: tokens.total / 3_000_000 });
      const ex = (prompt: string, turns: DetailTurn[]): DetailExchange => ({
        promptPreview: prompt,
        startedAt: turns[0].timestamp,
        endedAt: turns[turns.length - 1].timestamp,
        turnCount: turns.length,
        tools: [...new Set(turns.flatMap((x) => x.tools))],
        tokens: turns.reduce((s, x) => t(s.input + x.tokens.input, s.output + x.tokens.output, s.cacheRead + x.tokens.cacheRead, s.cacheWrite + x.tokens.cacheWrite), t(0, 0, 0, 0)),
        costEstimate: turns.reduce((s, x) => s + x.costEstimate, 0),
        turns,
      });
      const exchanges = [
        ex("把 session 清單做成可以點開看每一輪", [turn(40, t(12, 900, 180_000, 20_000), ["Read", "Grep"]), turn(38, t(4, 2_400, 210_000, 5_000), ["Edit", "Bash"])]),
        ex("跑一次測試", [turn(12, t(3, 300, 220_000, 1_000), ["Bash"])]),
        ex("", [turn(55, t(900, 50, 0, 40_000), [])]),
      ];
      return { found: true, client: String(args?.client), sessionId: String(args?.sessionId), period: String(args?.period), exchanges, totalTokens: 0, costUsd: 0, turnCount: 4 } satisfies SessionDetail;
    }
    case "usage_sessions":
      return mockSessions(Number(args?.page ?? 0));
    case "update_state":
    case "update_check":
    case "update_download":
      // 截圖用：`?mockUpdate=1` 假裝有新版與版本說明。
      if (new URLSearchParams(location.search).get("mockUpdate")) {
        return {
          state: "available",
          version: "0.2.0",
          date: now,
          notes: [
            "### 新功能",
            "- 本機分頁多了專案與 Session 清單",
            "- 趨勢分頁：熱力圖與趨勢線",
            "### 修正",
            "- 修正上傳間隔設定沒有立即套用 (#12)",
          ].join("\n"),
        } satisfies UpdateState;
      }
      return { state: "disabled", reason: "devBuild" } satisfies UpdateState;
    default:
      return null;
  }
}
