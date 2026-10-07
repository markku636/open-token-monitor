// 全域狀態（Zustand）。資料只從 Rust 來：bootstrap 先拉一次初值，之後靠事件更新。

import { useSyncExternalStore } from "react";
import { create } from "zustand";
import {
  api,
  errorMessage,
  onCompanyUpdated,
  onLimitsUpdated,
  onCurrencyUpdated,
  onOpenTab,
  onSettingsChanged,
  onStatsUpdated,
  onStatusUpdated,
  onUpdateState,
  type AppStatus,
  type CompanyStats,
  type CurrencyView,
  type LimitsView,
  type LocalStats,
  type Selection,
  type SettingsPatch,
  type SettingsView,
  type ThemeSetting,
  type UpdateState,
} from "./api";
import { lang, syncLangSetting } from "./i18n";
import { resolveLight, themeCssVars } from "./theme";
import { setMoney } from "./format";
import { applyReduceMotion, noteViewChange } from "./motionRuntime";
import { isRange, isSelection, MONTH_MODES, type MonthMode } from "./periods";
import { availableViewIds, effectiveViewDisplayOrderValue, parseViewId, preferredViewId, VIEW_IDS, type ViewId } from "./viewPrefs";

/** 本機分頁的清單：工具、模型、專案、session（全公司分頁只有工具與模型）。 */
export type Breakdown = "client" | "model" | "project" | "session";
/** 工具列展開後看 token 組成或模型拆分（上游 state.toolDetailMode）。 */
export type ToolDetailMode = "tokens" | "models";
/** widget 的視圖（上游 id：主頁、本機、狀態、全公司、額度、趨勢），見 viewPrefs.ts。 */
export type { ViewId };

/** setView 的選項，對應上游 app.js `setBreakdown(next, {fromHome, allowHidden})`。 */
export interface SetViewOptions {
  /** 從主頁的模組點進來：顯示「返回主頁」。 */
  fromHome?: boolean;
  /** tray／邊緣額度條打開的隱藏視圖：離開前留在切換順序裡。 */
  allowHidden?: boolean;
  /** 主頁的「模型」模組打開本機視圖的模型拆分。 */
  breakdown?: Breakdown;
  /**
   * 不是使用者換視圖（上游直接呼叫 `setBreakdown`、不經 `renderBreakdownChange`）：第一次套用設定的視圖
   * （applyInitialBreakdownPreference）與目前的視圖被隱藏時的修正（ensureBreakdownVisible）。
   * 這種切換不算進 motionRuntime 的「換過視圖」，第一次掛上的清單照第一次畫面進場。
   */
  quiet?: boolean;
}

interface ViewPrefs {
  /** 今日／本月／全部，或本星期／最近 7 日／最近 30 日。 */
  period: Selection;
  /** 中間那格目前是本月還是哪個範圍（上游 periodMonthMode）。 */
  monthMode: MonthMode;
  breakdown: Breakdown;
  /** 目前的視圖（上游 lastViewState.breakdown；Tauri 仍存在 localStorage，不進設定）。 */
  view: ViewId;
  toolDetailMode: ToolDetailMode;
}

interface AppStore extends ViewPrefs {
  settings: SettingsView | null;
  local: LocalStats | null;
  status: AppStatus | null;
  update: UpdateState | null;
  company: CompanyStats | null;
  limits: LimitsView | null;
  /** 成本的顯示幣別；換了之後整棵樹重繪，fmtUsd 就用新的匯率。 */
  currency: CurrencyView | null;
  ready: boolean;
  error: string | null;
  /** 從主頁點模組進來，顯示「返回主頁」（上游 homeReturnVisible，不存）。 */
  homeReturn: boolean;
  /** tray 打開的隱藏視圖（上游 directBreakdownOverride，不存）。 */
  viewOverride: ViewId | null;
  bootstrap(): Promise<void>;
  setPeriod(p: Selection): void;
  setBreakdown(b: Breakdown): void;
  setView(next: ViewId, opts?: SetViewOptions): void;
  setToolDetailMode(m: ToolDetailMode): void;
  /** 樂觀更新後存檔；失敗時還原、設 `error` 並回傳 false（不丟例外）。 */
  updateSettings(patch: SettingsPatch): Promise<boolean>;
  applySettings(view: SettingsView): void;
}

const VIEW_KEY = "tm:view";
/** 熱力圖的 token／成本從 view 偏好 `heatMetric` 搬到設定 `heatmapMetric`：只搬一次。 */
const HEAT_MIGRATED_KEY = "tm:heatMetricMigrated";

/** 視圖是從 localStorage（或預覽的查詢字串）來的；不是時第一次拿到設定後改用設定的第一個視圖（上游相同）。 */
let viewFromStorage = false;
let initialViewApplied = false;
/** 舊版 view 偏好裡的 `heatMetric`（遷移用）。 */
let legacyHeatMetric: unknown;
/** 預覽用查詢字串指定的視圖：跟 tray 打開的一樣，隱藏的也先留著（allowHidden）。 */
let queryView: ViewId | null = null;

function readView(): ViewPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}");
    legacyHeatMetric = v.heatMetric;
    // 瀏覽器預覽（vite + 假資料）截圖用：`?view=device&breakdown=session&period=month`（舊的 `?tab=` 也行）。
    // app 本身從不帶這些查詢字串；設定視窗的 `?view=settings` 不是視圖 id，略過。
    const query = new URLSearchParams(location.search);
    for (const k of ["breakdown", "period", "monthMode", "toolDetailMode"]) {
      const q = query.get(k);
      if (q) v[k] = q;
    }
    queryView = parseViewId(query.get("view")) ?? parseViewId(query.get("tab"));
    if (queryView) v.view = queryView;
    // 舊版存的是分頁（local / company / limits / trends）。
    const view = parseViewId(v.view) ?? parseViewId(v.tab);
    viewFromStorage = view !== null;
    return {
      period: isSelection(v.period) ? v.period : "today",
      monthMode: MONTH_MODES.includes(v.monthMode) ? v.monthMode : isRange(v.period) ? v.period : "month",
      breakdown: ["model", "project", "session"].includes(v.breakdown) ? v.breakdown : "client",
      view: view ?? "home",
      toolDetailMode: v.toolDetailMode === "models" ? "models" : "tokens",
    };
  } catch {
    return { period: "today", monthMode: "month", breakdown: "client", view: "home", toolDetailMode: "tokens" };
  }
}

/** 只有 widget 視窗決定與記住視圖；設定、儀表板、邊緣額度條也載入 store，但不能改寫 `tm:view`。 */
const isWidgetWindow = () => typeof document === "undefined" || (document.documentElement.dataset.view ?? "widget") === "widget";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return true;
  }
}

function writeFlag(key: string) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* 不影響功能 */
  }
}

function saveView(prefs: ViewPrefs) {
  // 其他視窗的 store 是它載入當時讀到的舊值：儀表板換期間時整份寫回，會把 widget 之後選的視圖、
  // 拆分蓋回去，所以它們的選擇只留在自己的記憶體裡。
  if (!isWidgetWindow()) return;
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(prefs));
  } catch {
    /* 私密模式或被停用時不影響功能 */
  }
}

let subscribed = false;

/** 視窗看不到時先收著的資料（統計、全公司、額度）。 */
type Held = Partial<Pick<AppStore, "local" | "company" | "limits">>;
let held: Held | null = null;

const documentHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

const localObservers = new Set<(local: LocalStats) => void>();

/**
 * 每一筆本機統計都通知，包括視窗看不到、`deliver()` 先收著的那些：即時速率要以上一筆為基準
 * （上游 app.js onStatsPush 每一筆都呼叫 observeLiveTokenRate，只把重畫延後）。回傳取消訂閱。
 */
export function onLocalStats(cb: (local: LocalStats) => void): () => void {
  localObservers.add(cb);
  return () => {
    localObservers.delete(cb);
  };
}

function observeLocal(local: LocalStats | null) {
  if (!local) return;
  for (const cb of [...localObservers]) cb(local);
}

/**
 * 上游 statsRenderScheduler.js：視窗看不到時不畫資料，改記下最新的一份，看得到時一次畫上。
 * 總數與清單就從使用者上次看到的數字動到新的（系統匣模式啟動時是隱藏的，第一次打開才從 0 數上來）。
 * 設定、狀態、更新與幣別照常立即套用；即時速率另外經 onLocalStats 看每一筆（收著的也算）。
 */
function deliver(set: (patch: Held) => void, patch: Held) {
  if (documentHidden()) {
    held = { ...held, ...patch };
    return;
  }
  set(patch);
}

export const useApp = create<AppStore>((set, get) => {
  const prefs = (): ViewPrefs => ({
    period: get().period,
    monthMode: get().monthMode,
    breakdown: get().breakdown,
    view: get().view,
    toolDetailMode: get().toolDetailMode,
  });
  return {
    settings: null,
    local: null,
    status: null,
    update: null,
    company: null,
    limits: null,
    currency: null,
    ...readView(),
    ready: false,
    error: null,
    homeReturn: false,
    viewOverride: queryView,

    async bootstrap() {
      if (!subscribed) {
        subscribed = true;
        void onStatsUpdated((local) => {
          observeLocal(local);
          deliver(set, { local });
        });
        void onStatusUpdated((status) => set({ status }));
        void onSettingsChanged((settings) => get().applySettings(settings));
        void onUpdateState((update) => set({ update }));
        void onCompanyUpdated((company) => deliver(set, { company }));
        void onLimitsUpdated((limits) => deliver(set, { limits }));
        if (typeof document !== "undefined") {
          document.addEventListener?.("visibilitychange", () => {
            if (documentHidden() || !held) return;
            const patch = held;
            held = null;
            set(patch);
          });
        }
        void onCurrencyUpdated((currency) => {
          setMoney(currency);
          set({ currency });
        });
        // 上游 openViewFromTray：可用的視圖才開，隱藏的也能開（allowHidden）；舊的分頁 id 照樣接受。
        // `app.emit` 送到每個 webview（tray.rs、dock.rs），只有 widget 有視圖，其他視窗不接。
        if (isWidgetWindow()) {
          void onOpenTab((payload) => {
            const id = parseViewId(payload);
            if (id && availableViewIds(get().settings).includes(id)) get().setView(id, { allowHidden: true });
          });
        }
      }
      try {
        const [settings, local, status, update, company, limits] = await Promise.all([
          api.settingsGet(),
          api.statsGet(),
          api.statusGet(),
          api.updateState(),
          api.companyGet(),
          api.limitsGet(),
        ]);
        set({ status, update, ready: true });
        observeLocal(local);
        deliver(set, { local, company, limits });
        get().applySettings(settings);
        void api.currencyGet().then((currency) => {
          setMoney(currency);
          set({ currency });
        });
        // tray 的字跟著前端解析出的語言（「自動」要看系統語言，只有前端知道）。
        void api.uiLanguage(lang());
      } catch (e) {
        set({ error: errorMessage(e), ready: true });
      }
    },

    setPeriod(period) {
      set(period === "month" || isRange(period) ? { period, monthMode: period } : { period });
      saveView(prefs());
    },

    setBreakdown(breakdown) {
      set({ breakdown });
      saveView(prefs());
    },

    setView(next, opts = {}) {
      const prev = get().view;
      const patch: Partial<AppStore> = { viewOverride: opts.allowHidden ? next : null };
      if (next !== prev) {
        // 上游 setBreakdown：只有從主頁點進別的視圖才顯示「返回主頁」，其他換視圖都收起來。
        patch.homeReturn = Boolean(opts.fromHome) && prev === "home" && next !== "home";
        patch.view = next;
        // 在重畫之前記下：這次掛上的清單在 layout effect 裡就要知道是換視圖（上游 renderBreakdownChange）。
        if (!opts.quiet) noteViewChange();
      }
      if (opts.breakdown) patch.breakdown = opts.breakdown;
      set(patch);
      saveView(prefs());
    },

    setToolDetailMode(toolDetailMode) {
      set({ toolDetailMode });
      saveView(prefs());
    },

    async updateSettings(patch) {
      const prev = get().settings;
      if (prev) set({ settings: { ...prev, ...patch } });
      try {
        get().applySettings(await api.settingsUpdate(patch));
        set({ error: null });
        return true;
      } catch (e) {
        if (prev) set({ settings: prev });
        set({ error: errorMessage(e) });
        return false;
      }
    },

    applySettings(settings) {
      set({ settings });
      if (isWidgetWindow()) applyInitialView(settings);
      document.documentElement.style.setProperty("--shell-alpha", String(Math.min(100, Math.max(40, settings.opacity)) / 100));
      applyTheme(settings.theme, settings.themeColors);
      applyReduceMotion(settings.reduceMotion);
      // 語言變了（或第一次啟動、localStorage 還沒記）：記下來並重新載入，模組層級的字串才會跟著換。
      if (syncLangSetting(settings.language)) location.reload();
    },
  };
});

/**
 * 第一次拿到設定時（widget 視窗）：
 * - 沒有記住的視圖就開自訂順序裡第一個可見的視圖（上游 applyInitialBreakdownPreference）。
 * - 舊版 view 偏好選了 token 上色的，搬到設定 `heatmapMetric`（只搬一次）。
 */
function applyInitialView(settings: SettingsView) {
  if (initialViewApplied) return;
  initialViewApplied = true;
  const store = useApp.getState();
  if (!viewFromStorage) {
    const id = parseViewId(
      preferredViewId({
        ids: VIEW_IDS,
        orderValue: effectiveViewDisplayOrderValue(settings.viewDisplayOrder),
        hiddenValue: settings.hiddenViews,
        availableIds: availableViewIds(settings),
        preferFirst: true,
      }),
    );
    if (id) store.setView(id, { quiet: true });
  }
  if (legacyHeatMetric === "tokens" && settings.heatmapMetric === "cost" && !readFlag(HEAT_MIGRATED_KEY)) {
    writeFlag(HEAT_MIGRATED_KEY);
    void store.updateSettings({ heatmapMetric: "tokens" });
  }
}

const THEME_KEY = "tm:theme";
const THEME_VARS_KEY = "tm:themeVars";
const prefersLight = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: light)") : undefined;

/**
 * 套用色彩模式與介面配色（上游 app.js applyThemeColors + themeCssVarEntries）。
 * - 明暗（theme.ts resolveLight，測試守的就是這條路）：`themeColors.bg` 有覆寫時依背景亮度（上游的
 *   light flip），否則看 `theme`（`system` 跟著 Windows）；`<html class="light">` 切換 styles.css 的 :root.light 色票。
 * - 四個覆寫色直接設在 <html> 的 --c-accent / --c-app / --c-fg / --c-muted；沒覆寫的移除，回到該模式的色票。
 * 每個視窗（widget、設定、儀表板、邊緣額度條，泡泡是縮小的 widget）都在 applySettings 呼叫它，
 * 收到 settings-changed 就一起換色。`persist: false` 給設定頁的調色盤預覽：只改這個視窗、不寫 localStorage。
 */
export function applyTheme(
  theme: ThemeSetting | undefined,
  themeColors?: Record<string, string>,
  { persist = true }: { persist?: boolean } = {},
) {
  const root = document.documentElement;
  const { vars, light: forced } = themeCssVars(themeColors);
  const light = resolveLight(theme, themeColors, Boolean(prefersLight?.matches));
  root.classList.toggle("light", light);
  for (const [name, value] of Object.entries(vars)) {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  if (!persist) return;
  try {
    // index.html 的 pre-paint script 讀這兩個，重新載入或新開的視窗（儀表板、額度條）才不會先閃一下預設配色。
    // localStorage 同源共用，所有視窗讀到同一份。
    localStorage.setItem(THEME_KEY, theme ?? "system");
    localStorage.setItem(THEME_VARS_KEY, JSON.stringify({ light: forced, vars }));
  } catch {
    /* 不影響功能 */
  }
}

/** 設定頁拖曳調色盤時的即時預覽：只在這個視窗套用，放開（change）才存檔並廣播給其他視窗。 */
export function previewTheme(themeColors: Record<string, string>) {
  applyTheme(useApp.getState().settings?.theme, themeColors, { persist: false });
}

const subscribePrefersLight = (onChange: () => void) => {
  prefersLight?.addEventListener?.("change", onChange);
  return () => prefersLight?.removeEventListener?.("change", onChange);
};

/** Windows 目前是不是淺色模式（色彩模式「跟隨系統」看它）；系統切換時重繪。 */
export function usePrefersLight(): boolean {
  return useSyncExternalStore(subscribePrefersLight, () => Boolean(prefersLight?.matches), () => false);
}

prefersLight?.addEventListener?.("change", () => {
  const s = useApp.getState().settings;
  applyTheme(s?.theme, s?.themeColors);
});
