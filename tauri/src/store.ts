// 全域狀態（Zustand）。資料只從 Rust 來：bootstrap 先拉一次初值，之後靠事件更新。

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
import { setMoney } from "./format";
import type { HeatMetric } from "./trendsFormat";
import { isRange, isSelection, MONTH_MODES, type MonthMode } from "./periods";

/** 本機分頁的清單：工具、模型、專案、session（全公司分頁只有工具與模型）。 */
export type Breakdown = "client" | "model" | "project" | "session";
/** 工具列展開後看 token 組成或模型拆分（上游 state.toolDetailMode）。 */
export type ToolDetailMode = "tokens" | "models";
/** widget 的分頁：本機用量、全公司（hub 串流）、額度或趨勢（本機的 history）。 */
export type Tab = "local" | "company" | "limits" | "trends";
/** 熱力圖依 token 或成本上色（上游 heatmapMetric，預設成本）。 */
export type { HeatMetric };

interface ViewPrefs {
  /** 今日／本月／全部，或本星期／最近 7 日／最近 30 日。 */
  period: Selection;
  /** 中間那格目前是本月還是哪個範圍（上游 periodMonthMode）。 */
  monthMode: MonthMode;
  breakdown: Breakdown;
  tab: Tab;
  toolDetailMode: ToolDetailMode;
  heatMetric: HeatMetric;
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
  bootstrap(): Promise<void>;
  setPeriod(p: Selection): void;
  setBreakdown(b: Breakdown): void;
  setTab(t: Tab): void;
  setToolDetailMode(m: ToolDetailMode): void;
  setHeatMetric(m: HeatMetric): void;
  updateSettings(patch: SettingsPatch): Promise<void>;
  applySettings(view: SettingsView): void;
}

const VIEW_KEY = "tm:view";

function readView(): ViewPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}");
    // 瀏覽器預覽（vite + 假資料）截圖用：`?tab=company&breakdown=session&period=month`。app 本身從不帶查詢字串。
    const query = new URLSearchParams(location.search);
    for (const k of ["tab", "breakdown", "period", "monthMode", "toolDetailMode", "heatMetric"]) {
      const q = query.get(k);
      if (q) v[k] = q;
    }
    return {
      period: isSelection(v.period) ? v.period : "today",
      monthMode: MONTH_MODES.includes(v.monthMode) ? v.monthMode : isRange(v.period) ? v.period : "month",
      breakdown: ["model", "project", "session"].includes(v.breakdown) ? v.breakdown : "client",
      tab: ["company", "limits", "trends"].includes(v.tab) ? v.tab : "local",
      toolDetailMode: v.toolDetailMode === "models" ? "models" : "tokens",
      heatMetric: v.heatMetric === "tokens" ? "tokens" : "cost",
    };
  } catch {
    return { period: "today", monthMode: "month", breakdown: "client", tab: "local", toolDetailMode: "tokens", heatMetric: "cost" };
  }
}

function saveView(prefs: ViewPrefs) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(prefs));
  } catch {
    /* 私密模式或被停用時不影響功能 */
  }
}

let subscribed = false;

export const useApp = create<AppStore>((set, get) => {
  const prefs = (): ViewPrefs => ({
    period: get().period,
    monthMode: get().monthMode,
    breakdown: get().breakdown,
    tab: get().tab,
    toolDetailMode: get().toolDetailMode,
    heatMetric: get().heatMetric,
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

    async bootstrap() {
      if (!subscribed) {
        subscribed = true;
        void onStatsUpdated((local) => set({ local }));
        void onStatusUpdated((status) => set({ status }));
        void onSettingsChanged((settings) => get().applySettings(settings));
        void onUpdateState((update) => set({ update }));
        void onCompanyUpdated((company) => set({ company }));
        void onLimitsUpdated((limits) => set({ limits }));
        void onCurrencyUpdated((currency) => {
          setMoney(currency);
          set({ currency });
        });
        void onOpenTab((tab) => {
          if (["local", "company", "limits", "trends"].includes(tab)) get().setTab(tab as Tab);
        });
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
        set({ local, status, update, company, limits, ready: true });
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

    setTab(tab) {
      set({ tab });
      saveView(prefs());
    },

    setToolDetailMode(toolDetailMode) {
      set({ toolDetailMode });
      saveView(prefs());
    },

    setHeatMetric(heatMetric) {
      set({ heatMetric });
      saveView(prefs());
    },

    async updateSettings(patch) {
      const prev = get().settings;
      if (prev) set({ settings: { ...prev, ...patch } });
      try {
        get().applySettings(await api.settingsUpdate(patch));
        set({ error: null });
      } catch (e) {
        if (prev) set({ settings: prev });
        set({ error: errorMessage(e) });
      }
    },

    applySettings(settings) {
      set({ settings });
      document.documentElement.style.setProperty("--shell-alpha", String(Math.min(100, Math.max(40, settings.opacity)) / 100));
      applyTheme(settings.theme);
      // 語言變了（或第一次啟動、localStorage 還沒記）：記下來並重新載入，模組層級的字串才會跟著換。
      if (syncLangSetting(settings.language)) location.reload();
    },
  };
});

const THEME_KEY = "tm:theme";
const prefersLight = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: light)") : undefined;

/** `<html class="light">` 切換淺色（styles.css 的 :root.light 覆寫色票）；`system` 跟著 Windows。 */
export function applyTheme(theme: ThemeSetting | undefined) {
  const light = theme === "light" || (theme !== "dark" && Boolean(prefersLight?.matches));
  document.documentElement.classList.toggle("light", light);
  try {
    // index.html 的 pre-paint script 讀它，避免重新載入時先閃一下深色。
    localStorage.setItem(THEME_KEY, theme ?? "system");
  } catch {
    /* 不影響功能 */
  }
}

prefersLight?.addEventListener?.("change", () => applyTheme(useApp.getState().settings?.theme));
