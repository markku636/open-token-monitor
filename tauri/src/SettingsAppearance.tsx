// 設定頁的「外觀」區塊（上游 widget 設定 Appearance：開關列與 Interface Theme 群組，index.html
// settings-theme-group 與 app.js 的 renderThemePresetChips / renderThemeColorGrid / renderVendorColorList /
// applyThemeCodeFromInput）：工具圖示、色彩模式、三種一鍵配色、TM1 主題代碼、進階自訂的四色，以及廠商色。
//
// 存檔一律整份取代（上游 saveSettings({ themeColors }) 同樣），Rust validate() 正規化後廣播
// settings-changed，每個視窗的 store 重新套用。調色盤拖曳時只在這個視窗預覽（上游設定與 widget
// 同一個視窗，Tauri 的設定是另一個視窗），放開（change）才存檔。
//
// 色格、預設晶片與主題代碼描述的是畫面上的配色（theme.ts effectiveThemeColors）：沒覆寫的鍵回到
// 所解析明暗的底色，淺色模式就是「瓷白」。上游一律以 DEFAULT_THEME 為底——它沒有淺色模式，那就是畫面。

import { ClipboardPaste, Copy, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SettingsView, ThemeSetting } from "./api";
import { t } from "./i18n";
import { previewTheme, useApp, usePrefersLight } from "./store";
import {
  decodeThemeCode,
  effectiveThemeColors,
  encodeThemeCode,
  INTERFACE_COLOR_KEYS,
  matchingThemePresetId,
  normalizeHex,
  normalizeOverrides,
  orderedVendorIds,
  presetOverrides,
  resolveLight,
  THEME_PRESETS,
  vendorLabel,
  type ColorMap,
  type PresetId,
  type ThemeColorKey,
} from "./theme";
import { Field, IconButton, Section, Segmented, Toggle } from "./ui";
import { BRAND_COLORS } from "./vendorColors";

const PRESET_LABELS: Record<PresetId, string> = {
  default: t("預設"),
  obsidian: t("黑曜"),
  porcelain: t("瓷白"),
};

const COLOR_LABELS: Record<ThemeColorKey, string> = {
  accent: t("強調色"),
  bg: t("背景"),
  text: t("文字"),
  muted: t("次要文字"),
};

const BRAND_IDS = Object.keys(BRAND_COLORS);
const VENDOR_IDS = orderedVendorIds(BRAND_COLORS);

function useCommit() {
  const updateSettings = useApp((x) => x.updateSettings);
  return {
    theme: (colors: ColorMap) => updateSettings({ themeColors: colors }),
    vendors: (colors: ColorMap) => updateSettings({ vendorColors: colors }),
  };
}

/** 上游 appearanceSummary：預設名稱或「自訂」；有廠商色覆寫時加上數量。 */
function appearanceSummary(presetId: PresetId | null, vendorColors: unknown): string {
  const theme = presetId ? PRESET_LABELS[presetId] : t("自訂");
  const vendors = Object.keys(normalizeOverrides(vendorColors, BRAND_IDS)).length;
  return vendors > 0 ? t("{theme} · 自訂 {vendors}", { theme, vendors }) : theme;
}

/**
 * 一列調色盤：名稱、`<input type="color">`、重設。
 * React 的 onChange 是原生 `input` 事件（拖曳中連續觸發），只拿來預覽；存檔掛在原生 `change`
 *（放開或關掉選色器時一次），與上游的 input / change 分工相同。用 div 而不是 label，
 * 按重設不會連帶打開選色器。
 */
function ColorRow({
  label,
  saved,
  resetTitle,
  onPreview,
  onCommit,
  onReset,
  onCancel,
}: {
  label: string;
  saved: string;
  resetTitle: string;
  onPreview?: (hex: string) => void;
  onCommit: (hex: string) => void;
  onReset: () => void;
  onCancel?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // 草稿只在它所根據的存檔值沒變時有效（拖曳中別的視窗改了同一個色就作廢）。
  const [draft, setDraft] = useState<{ value: string; base: string } | null>(null);
  const value = draft && draft.base === saved ? draft.value : saved;
  const commitRef = useRef(onCommit);
  useEffect(() => {
    commitRef.current = onCommit;
  });
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onNativeChange = () => {
      const hex = normalizeHex(el.value);
      if (hex) commitRef.current(hex);
      // 送出後就清掉：存檔失敗時 store 還原成舊值，留著的草稿會又對上 base、把沒存成的顏色顯示回來。
      setDraft(null);
    };
    el.addEventListener("change", onNativeChange);
    return () => el.removeEventListener("change", onNativeChange);
  }, []);
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2 text-xs text-muted">
      <span className="truncate" title={label}>
        {label}
      </span>
      <input
        ref={inputRef}
        type="color"
        className="color-input"
        aria-label={label}
        // 品牌表有 `#000` 這類 input 不接受的寫法；給 input 的值一律是 6 位小寫，顯示才不會變成黑色。
        value={normalizeHex(value) ?? expandShortHex(value)}
        onChange={(e) => {
          setDraft({ value: e.target.value, base: saved });
          onPreview?.(e.target.value);
        }}
        onBlur={() => {
          // 關掉選色器沒有選（或選了又取消）時不留下預覽。
          setDraft(null);
          onCancel?.();
        }}
      />
      <IconButton title={resetTitle} aria-label={`${resetTitle} · ${label}`} onClick={onReset}>
        <RotateCcw size={12} />
      </IconButton>
    </div>
  );
}

/** `#000` → `#000000`；其他無法解析的值給黑色（input type=color 的預設）。 */
function expandShortHex(value: string): string {
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value.trim());
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase() : "#000000";
}

/**
 * 主題代碼（上游 applyThemeCodeFromInput / pasteAndApplyThemeCode / copyCurrentThemeCode）。
 * 每個動作與每次輸入都換一個 generation；非同步的結果只有在 generation 沒變、輸入框也還是預期的代碼時
 * 才顯示，晚到的結果直接丟掉。沒在輸入時，輸入框跟著存檔的配色。
 *
 * `saved` 是畫面上配色的代碼；`syncKey` 是 store 的設定物件，每次存檔（含沒改到代碼的，例如按目前的
 * 預設、改廠商色）與每次 settings-changed 都換一個，上游 buildAppearanceColorControls 也是每次都重新對齊。
 */
function ThemeCodeField({
  saved,
  syncKey,
  commit,
}: {
  saved: string;
  syncKey: unknown;
  commit: (colors: ColorMap) => Promise<boolean>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(saved);
  // 上游直接讀寫 input.value（同步）；React 的 state 要等重繪，這個 ref 同步記下目前的輸入框內容。
  const draftRef = useRef(saved);
  const generation = useRef(0);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);

  const setCode = (value: string) => {
    draftRef.current = value;
    setDraft(value);
  };
  const invalidate = () => {
    generation.current += 1;
    setStatus(null);
    return generation.current;
  };
  const isCurrent = (gen: number, code: string | undefined) => gen === generation.current && draftRef.current === code;

  useEffect(() => {
    if (document.activeElement === inputRef.current || draftRef.current === saved) return;
    generation.current += 1;
    setStatus(null);
    draftRef.current = saved;
    setDraft(saved);
  }, [saved, syncKey]);

  const apply = async (text: string) => {
    const gen = invalidate();
    const parsed = decodeThemeCode(text);
    if (!parsed.ok) {
      setStatus({
        text: parsed.reason === "unsupportedVersion" ? t("尚不支援這個主題代碼版本。") : t("主題代碼格式無效。"),
        ok: false,
      });
      return;
    }
    setCode(parsed.code);
    // 存的是完整四色（即使與預設相同），與上游相同。存檔失敗時 store 已還原並在頁首顯示錯誤，
    // 這裡就不說「已套用」（上游的設定與畫面在同一個 process，存檔不會被退回）。
    const ok = await commit(parsed.colors);
    if (ok && isCurrent(gen, parsed.code)) setStatus({ text: t("已套用主題。"), ok: true });
  };

  const paste = async () => {
    const gen = invalidate();
    const before = draftRef.current;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      if (isCurrent(gen, before)) setStatus({ text: t("無法存取剪貼簿。"), ok: false });
      return;
    }
    if (!isCurrent(gen, before)) return;
    const trimmed = (text || "").trim();
    setCode(trimmed);
    await apply(trimmed);
  };

  const copy = async () => {
    const gen = invalidate();
    // 複製的是存檔（畫面上）的配色，不是輸入框裡打到一半的字。
    const code = saved;
    setCode(code);
    let copied = true;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      copied = false;
    }
    if (!isCurrent(gen, code)) return;
    setStatus(copied ? { text: t("已複製主題代碼。"), ok: true } : { text: t("無法存取剪貼簿。"), ok: false });
  };

  return (
    <div className="py-2.5">
      <div className="text-sm">{t("主題代碼")}</div>
      <div className="mt-1.5 flex items-center gap-1">
        <input
          ref={inputRef}
          type="text"
          className="min-w-0 flex-1 rounded-sm border border-fg/15 bg-inset px-2 py-1 font-mono text-2xs uppercase"
          maxLength={64}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder={t("貼上 TM1 主題代碼")}
          aria-label={t("主題代碼")}
          value={draft}
          onChange={(e) => {
            invalidate();
            setCode(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            void apply(draftRef.current);
          }}
        />
        <IconButton title={t("複製主題碼")} aria-label={t("複製主題碼")} onClick={() => void copy()}>
          <Copy size={13} />
        </IconButton>
        <IconButton title={t("貼上並套用")} aria-label={t("貼上並套用")} onClick={() => void paste()}>
          <ClipboardPaste size={13} />
        </IconButton>
      </div>
      <p className="mt-1 text-xs text-muted">{t("僅分享介面配色。廠商色與外觀偏好會保留在本機。")}</p>
      <p aria-live="polite" className={`text-xs ${status ? `mt-1 ${status.ok ? "text-success" : "text-danger"}` : ""}`}>
        {status?.text}
      </p>
    </div>
  );
}

/** 可收合的小節（上游的 accordion，預設收起、不記住）。`action` 放在標題列右邊，按了不會開合。 */
function Accordion({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <details className="group py-2.5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-1.5">
          <span className="inline-block text-2xs text-muted transition-transform group-open:rotate-90">▸</span>
          {title}
        </span>
        {action}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

export function AppearanceSection({ s }: { s: SettingsView }) {
  const updateSettings = useApp((x) => x.updateSettings);
  const commit = useCommit();
  const themeOverrides = normalizeOverrides(s.themeColors, INTERFACE_COLOR_KEYS);
  const vendorOverrides = normalizeOverrides(s.vendorColors, BRAND_IDS);
  // 畫面上的明暗與四色（與 store.applyTheme 同一條規則）。`modeLight` 只看色彩模式：選預設時存下的
  // 覆寫會整份取代目前的，底色由色彩模式決定。
  const prefersLight = usePrefersLight();
  const light = resolveLight(s.theme, s.themeColors, prefersLight);
  const modeLight = resolveLight(s.theme, {}, prefersLight);
  const palette = effectiveThemeColors(s.themeColors, light);
  const activePreset = matchingThemePresetId(s.themeColors, light);
  // 取消預覽時回到存檔的配色；讀 store 而不是 props，拿到的是剛存檔（樂觀更新）後的值。
  const restoreTheme = () => previewTheme(useApp.getState().settings?.themeColors ?? {});
  const without = (map: ColorMap, key: string) => {
    const next = { ...map };
    delete next[key];
    return next;
  };

  return (
    <Section title={t("外觀")}>
      {/* 上游外觀區塊先列開關、再列介面主題；標題列的三個開關（即時指示器、標題改用圖示、交換按鈕）
          等 header 按鈕改完後依上游順序加在「工具圖示」前後。 */}
      <Field label={t("工具圖示")}>
        <Toggle checked={s.showToolIcons} onChange={(v) => void updateSettings({ showToolIcons: v })} />
      </Field>

      <Field label={t("色彩模式")} hint={t("沒有自訂背景色時決定明暗：深色是「預設」配色、淺色是「瓷白」；自訂背景色時依背景深淺決定")}>
        <Segmented<ThemeSetting>
          value={s.theme}
          options={[
            { value: "system", label: t("跟隨系統") },
            { value: "dark", label: t("深色") },
            { value: "light", label: t("淺色") },
          ]}
          onChange={(v) => void updateSettings({ theme: v })}
        />
      </Field>

      <div className="py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm">{t("介面主題")}</div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted">{appearanceSummary(activePreset, s.vendorColors)}</span>
            <IconButton title={t("全部重設")} aria-label={t("全部重設")} onClick={() => void commit.theme({})}>
              <RotateCcw size={12} />
            </IconButton>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {THEME_PRESETS.map((preset) => {
            const active = preset.id === activePreset;
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={active}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                  active ? "border-accent/60 bg-accent/10 text-accent" : "border-fg/15 text-muted hover:text-fg"
                }`}
                onClick={() => void commit.theme(presetOverrides(preset.id, modeLight))}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: preset.colors.accent, boxShadow: "inset 0 0 0 1px rgba(0,0,0,.25)" }}
                />
                {PRESET_LABELS[preset.id]}
              </button>
            );
          })}
        </div>
      </div>

      <ThemeCodeField saved={encodeThemeCode(palette)} syncKey={s} commit={commit.theme} />

      <Accordion title={t("進階自訂")}>
        <div className="grid gap-1.5">
          {INTERFACE_COLOR_KEYS.map((key) => (
            <ColorRow
              key={key}
              label={COLOR_LABELS[key]}
              saved={palette[key]}
              resetTitle={t("重設顏色")}
              onPreview={(hex) => previewTheme({ ...themeOverrides, [key]: hex })}
              // 存檔失敗時 store 只還原設定、不重套 CSS：把這個視窗留著的預覽換回存檔的配色。
              onCommit={(hex) =>
                void commit.theme({ ...themeOverrides, [key]: hex }).then((ok) => {
                  if (!ok) restoreTheme();
                })
              }
              onReset={() => void commit.theme(without(themeOverrides, key))}
              onCancel={restoreTheme}
            />
          ))}
        </div>
        {/* 字型設定（上游同一個「進階自訂」裡的介面／數字字型）移植時放在這裡，接在四色之後。 */}
      </Accordion>

      <Accordion
        title={t("廠商色")}
        action={
          <IconButton
            title={t("重設回品牌色")}
            aria-label={t("重設回品牌色")}
            onClick={(e) => {
              // 標題列在 <summary> 裡：不擋掉的話，按重設也會開合。
              e.preventDefault();
              e.stopPropagation();
              void commit.vendors({});
            }}
          >
            <RotateCcw size={12} />
          </IconButton>
        }
      >
        <p className="mb-2 text-xs text-muted">{t("覆寫每個工具在圖表與清單的顏色。重設即回到品牌色。")}</p>
        <div className="scroll-thin grid max-h-[196px] gap-1.5 overflow-y-auto pr-1">
          {VENDOR_IDS.map((id) => {
            const label = id === "default" ? t("其他工具") : vendorLabel(id);
            return (
              <ColorRow
                key={id}
                label={label}
                saved={vendorOverrides[id] ?? BRAND_COLORS[id]}
                resetTitle={t("重設回品牌色")}
                onCommit={(hex) => void commit.vendors({ ...vendorOverrides, [id]: hex })}
                onReset={() => void commit.vendors(without(vendorOverrides, id))}
              />
            );
          })}
        </div>
      </Accordion>
    </Section>
  );
}
