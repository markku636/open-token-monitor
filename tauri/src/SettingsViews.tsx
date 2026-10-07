// 設定頁的「主畫面」（上游 Settings > Main，app.js `renderViewPreferences`、`renderHomeSettingsList`、
// `renderHomeLimitProviderList`）：視圖的順序與隱藏，主頁的模組、主頁額度的 provider 與活動的顯示方式。
// 值的正規化在 Rust（view_prefs.rs）；這裡只送 patch，排序與顯示用 viewPrefs.ts 的同一套規則。

import { Eye, RotateCcw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { SettingsView } from "./api";
import { SETTINGS_FOCUS_KEY } from "./Home";
import { providerNamesRequired } from "./homeOverview";
import { t } from "./i18n";
import { limitProviderSettingsLabel } from "./limitCatalog";
import { ReorderList, type ReorderItem } from "./ReorderList";
import { useApp } from "./store";
import { Field, IconButton, Section, Segmented, Toggle } from "./ui";
import {
  DEFAULT_HOME_MODULE_ORDER,
  disabledViewIds,
  effectiveViewDisplayOrderValue,
  hasCustomViewDisplayOrder,
  HOME_MODULE_OPTIONS,
  moveHomeModuleOrder,
  moveViewDisplayOrder,
  normalizeHiddenHomeModules,
  normalizeHiddenViews,
  normalizeHomeModuleOrder,
  normalizeLimitProviderSelection,
  normalizeViewDisplayOrder,
  orderedLimitProviders,
  orderedViews,
  reorderHomeModuleOrder,
  reorderViewDisplayOrder,
  VIEW_IDS,
  viewLabel,
  visibleViewCount,
} from "./viewPrefs";

const csvSet = (value: string) => new Set(value.split(",").filter(Boolean));

/** 說明文字加上右邊的「重設排序」與「顯示全部」（上游 .settings-note-row 的 ↺ 與眼睛）。 */
function NoteRow({ note, extra, canReset, onReset, canShowAll, onShowAll }: { note: string; extra?: ReactNode; canReset: boolean; onReset: () => void; canShowAll: boolean; onShowAll: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <p className="text-xs text-fg/50">{note}</p>
      <div className="flex shrink-0 items-center gap-1">
        {extra}
        <IconButton title={t("重設排序")} aria-label={t("重設排序")} disabled={!canReset} onClick={onReset}>
          <RotateCcw size={13} />
        </IconButton>
        <IconButton title={t("顯示全部")} aria-label={t("顯示全部")} disabled={!canShowAll} onClick={onShowAll}>
          <Eye size={13} />
        </IconButton>
      </div>
    </div>
  );
}

/** 在一份完整順序裡只重排看得到的那幾個（其他的留在原位），給只列出已啟用 provider 的清單用。 */
export function reorderVisible(full: readonly string[], visible: readonly string[], id: string, targetIndex: number): string[] {
  const from = visible.indexOf(id);
  if (from < 0) return [...full];
  const next = [...visible];
  const to = Math.max(0, Math.min(next.length - 1, Number(targetIndex) || 0));
  next.splice(to, 0, ...next.splice(from, 1));
  const shown = new Set(visible);
  let k = 0;
  return full.map((x) => (shown.has(x) ? next[k++] : x));
}

/** 主頁額度的子設定（上游 renderHomeLimitProviderList）。 */
function HomeLimitSettings({ s }: { s: SettingsView }) {
  const updateSettings = useApp((x) => x.updateSettings);
  const [count, setCount] = useState<string | null>(null);
  const catalog = s.supportedLimitProviders;
  const orderValue = s.homeLimitProviderOrder || s.limitProviderOrder;
  const full = orderedLimitProviders(catalog, orderValue);
  const enabled = new Set(s.limitsEnabled ? s.limitProviders : []);
  const providers = full.filter((id) => enabled.has(id));
  const hidden = new Set(normalizeLimitProviderSelection(s.hiddenHomeLimitProviders, catalog));
  const namesRequired = providerNamesRequired(s);
  const saveOrder = (next: string[]) => {
    const value = next.join(",");
    if (value !== full.join(",")) void updateSettings({ homeLimitProviderOrder: value });
  };
  const items: ReorderItem[] = providers.map((id) => ({ id, label: limitProviderSettingsLabel(id), hidden: hidden.has(id) }));
  return (
    <div className="border-l border-fg/10 pl-3">
      <Field label={t("顯示低額度提示")}>
        <Toggle checked={s.showHomeLimitBars} onChange={(v) => void updateSettings({ showHomeLimitBars: v })} />
      </Field>
      <Field label={t("多帳號顯示提供者名稱")} hint={namesRequired ? t("隱藏工具圖示時，仍會顯示提供者名稱。") : undefined}>
        <Toggle
          checked={namesRequired || s.showHomeLimitProviderNames}
          disabled={namesRequired}
          onChange={(v) => void updateSettings({ showHomeLimitProviderNames: v })}
        />
      </Field>
      <Field label={t("顯示帳號數")}>
        <input
          type="number"
          min={1}
          max={12}
          step={1}
          inputMode="numeric"
          className="w-16 rounded-sm border border-fg/15 bg-inset px-2 py-1 text-right text-sm"
          value={count ?? String(s.homeLimitAccountCount)}
          onChange={(e) => {
            setCount(e.target.value);
            // 上游在 change 時就存；Rust 端截去小數、夾在 1–12。空白時等輸入完再說。
            if (e.target.value.trim() !== "" && Number.isFinite(Number(e.target.value))) void updateSettings({ homeLimitAccountCount: Number(e.target.value) });
          }}
          onBlur={() => setCount(null)}
        />
      </Field>
      <NoteRow
        note={t("選擇主頁額度模組顯示哪些提供者。預設按剩餘額度最少優先；拖曳後才按此排序。")}
        canReset={Boolean(s.homeLimitProviderOrder)}
        onReset={() => void updateSettings({ homeLimitProviderOrder: "" })}
        canShowAll={providers.some((id) => hidden.has(id))}
        onShowAll={() => void updateSettings({ hiddenHomeLimitProviders: "" })}
      />
      <ReorderList
        items={items}
        onToggleHidden={(id) => {
          const next = new Set(hidden);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          void updateSettings({ hiddenHomeLimitProviders: [...next].join(",") });
        }}
        onMove={(id, direction) => {
          const index = providers.indexOf(id);
          saveOrder(reorderVisible(full, providers, id, direction === "up" ? index - 1 : index + 1));
        }}
        onReorder={(id, index) => saveOrder(reorderVisible(full, providers, id, index))}
        hideTitle={(name) => t("從主頁額度隱藏 {name}", { name })}
        showTitle={(name) => t("在主頁額度顯示 {name}", { name })}
        reorderTitle={(name) => t("拖曳排序主頁額度的 {name}，也可用上下鍵移動。", { name })}
      />
    </div>
  );
}

/** 主頁活動的子設定（上游 Settings > Main > Home > Activity）。 */
function HomeActivitySettings({ s }: { s: SettingsView }) {
  const updateSettings = useApp((x) => x.updateSettings);
  return (
    <div className="border-l border-fg/10 pl-3">
      <Field label={t("熱力圖顏色")}>
        <Segmented<"tokens" | "cost">
          size="xs"
          value={s.heatmapMetric}
          options={[
            { value: "tokens", label: "Tokens" },
            { value: "cost", label: t("成本") },
          ]}
          onChange={(v) => void updateSettings({ heatmapMetric: v })}
        />
      </Field>
      <Field label={t("活躍天數範圍")}>
        <Segmented<"all" | "year">
          size="xs"
          value={s.homeActiveDaysWindow}
          options={[
            { value: "all", label: t("全部時間") },
            { value: "year", label: t("近 12 個月") },
          ]}
          onChange={(v) => void updateSettings({ homeActiveDaysWindow: v })}
        />
      </Field>
    </div>
  );
}

/** 主頁模組的子設定（上游 renderHomeSettingsList）；最後一個看得到的模組不能再隱藏（上游沒有這道防護）。 */
function HomeModuleSettings({ s }: { s: SettingsView }) {
  const updateSettings = useApp((x) => x.updateSettings);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const order = normalizeHomeModuleOrder(s.homeModuleOrder);
  const hidden = csvSet(normalizeHiddenHomeModules(s.hiddenHomeModules));
  const visibleCount = order.filter((id) => !hidden.has(id)).length;
  const toggle = (id: string) => setExpanded((e) => ({ ...e, [id]: !e[id] }));
  const items: ReorderItem[] = order.map((id) => {
    const label = HOME_MODULE_OPTIONS.find((o) => o.id === id)?.label ?? id;
    const isHidden = hidden.has(id);
    const subgroup = id === "limits" ? <HomeLimitSettings s={s} /> : id === "trends" ? <HomeActivitySettings s={s} /> : undefined;
    return {
      id,
      label,
      hidden: isHidden,
      hideLocked: !isHidden && visibleCount <= 1,
      subgroup,
      expanded: Boolean(expanded[id]),
      onToggleExpand: () => toggle(id),
      expandTitle: id === "limits" ? t("設定主頁額度提供者") : t("設定主頁活動"),
    };
  });
  const save = (next: string) => {
    if (next !== order.join(",")) void updateSettings({ homeModuleOrder: next });
  };
  return (
    <div id="settings-home-modules" className="border-l border-fg/10 pl-3">
      <NoteRow
        note={t("選擇主頁顯示哪些模組與排序。")}
        canReset={order.join(",") !== DEFAULT_HOME_MODULE_ORDER}
        onReset={() => void updateSettings({ homeModuleOrder: DEFAULT_HOME_MODULE_ORDER })}
        canShowAll={hidden.size > 0}
        onShowAll={() => void updateSettings({ hiddenHomeModules: "" })}
      />
      <ReorderList
        items={items}
        onToggleHidden={(id) => {
          const next = new Set(hidden);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          void updateSettings({ hiddenHomeModules: order.filter((x) => next.has(x)).join(",") });
        }}
        onMove={(id, direction) => save(moveHomeModuleOrder(s.homeModuleOrder, id, direction))}
        onReorder={(id, index) => save(reorderHomeModuleOrder(s.homeModuleOrder, id, index))}
        hideTitle={(name) => t("從主頁隱藏 {name}", { name })}
        showTitle={(name) => t("在主頁顯示 {name}", { name })}
        reorderTitle={(name) => t("拖曳排序主頁的 {name}，也可用上下鍵移動。", { name })}
      />
    </div>
  );
}

/** 設定頁的「主畫面」區塊（放在「顯示」之前）。 */
export function ViewsSection({ s }: { s: SettingsView }) {
  const updateSettings = useApp((x) => x.updateSettings);
  const [homeOpen, setHomeOpen] = useState(false);

  // widget 主頁的「自訂主頁」寫下 tm:settingsFocus 再打開設定：展開主頁模組並捲過去（上游 openHomeSettings）。
  useEffect(() => {
    const focusHome = () => {
      try {
        if (localStorage.getItem(SETTINGS_FOCUS_KEY) !== "home") return;
        localStorage.removeItem(SETTINGS_FOCUS_KEY);
      } catch {
        return;
      }
      setHomeOpen(true);
      requestAnimationFrame(() => document.getElementById("settings-home-modules")?.scrollIntoView({ block: "nearest" }));
    };
    focusHome();
    const onStorage = (e: StorageEvent) => {
      if (e.key === SETTINGS_FOCUS_KEY && e.newValue === "home") focusHome();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const effective = effectiveViewDisplayOrderValue(s.viewDisplayOrder);
  const order = orderedViews(VIEW_IDS, effective);
  const hidden = csvSet(normalizeHiddenViews(s.hiddenViews, VIEW_IDS));
  const disabled = disabledViewIds(s);
  const visibleCount = visibleViewCount({ ids: VIEW_IDS, hiddenValue: s.hiddenViews, disabledIds: disabled });
  const items: ReorderItem[] = order.map((id) => {
    const isDisabled = disabled.includes(id);
    const isHidden = hidden.has(id) || isDisabled;
    return {
      id,
      label: viewLabel(id),
      hidden: isHidden,
      disabled: isDisabled,
      hideLocked: !isHidden && visibleCount <= 1,
      // 狀態視圖的服務清單（上游 serviceProviderDisplayOrder）之後由額度那邊的缺口補在這裡。
      subgroup: id === "home" ? <HomeModuleSettings s={s} /> : undefined,
      expanded: id === "home" && homeOpen,
      onToggleExpand: () => setHomeOpen((v) => !v),
      expandTitle: t("設定 {name}", { name: viewLabel(id) }),
    };
  });
  const saveOrder = (next: string) => {
    if (next !== normalizeViewDisplayOrder(effective, VIEW_IDS).join(",")) void updateSettings({ viewDisplayOrder: next });
  };
  return (
    <div id="settings-views">
      <Section title={t("主畫面")}>
        <NoteRow
          note={t("調整主畫面視圖的顯示與切換順序。")}
          extra={<span className="num mr-1 text-xs text-fg/45">{t("{visible}/{total} 顯示", { visible: visibleCount, total: VIEW_IDS.length })}</span>}
          canReset={hasCustomViewDisplayOrder(s.viewDisplayOrder)}
          onReset={() => void updateSettings({ viewDisplayOrder: "" })}
          canShowAll={hidden.size > 0}
          onShowAll={() => void updateSettings({ hiddenViews: "" })}
        />
        <ReorderList
          items={items}
          onToggleHidden={(id) => {
            if (disabled.includes(id as (typeof disabled)[number])) {
              // 上游 setTrendEnabled(true)：趨勢是因為 history 關閉才看不到，按眼睛就打開 history 並取消隱藏。
              void updateSettings({ historyEnabled: true, hiddenViews: order.filter((x) => hidden.has(x) && x !== id).join(",") });
              return;
            }
            const next = new Set(hidden);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            void updateSettings({ hiddenViews: order.filter((x) => next.has(x)).join(",") });
          }}
          onMove={(id, direction) => saveOrder(moveViewDisplayOrder(effective, VIEW_IDS, id, direction))}
          onReorder={(id, index) => saveOrder(reorderViewDisplayOrder(effective, VIEW_IDS, id, index))}
          hideTitle={(name) => t("隱藏 {name}", { name })}
          showTitle={(name) => t("顯示 {name}", { name })}
          reorderTitle={(name) => t("拖曳排序 {name}。也可用上下鍵移動。", { name })}
        />
      </Section>
    </div>
  );
}
