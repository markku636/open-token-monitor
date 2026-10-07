// 設定頁的「顯示」區塊：widget 上數字怎麼呈現（幣別、即時速率等）。放在獨立檔案，一般區塊的視窗、
// tray 設定與這裡互不干擾。

import { useState } from "react";
import type { SettingsView } from "./api";
import { fmtRate } from "./format";
import { t } from "./i18n";
import { useApp } from "./store";
import { Field, Section, Segmented, Select, Toggle } from "./ui";
import { ModelAliasFields } from "./SettingsAliases";

const CURRENCIES = [
  { value: "USD", label: t("USD - 美金") },
  { value: "TWD", label: t("TWD - 台幣") },
  { value: "HKD", label: t("HKD - 港幣") },
  { value: "CNY", label: t("CNY - 人民幣") },
];

/** 匯率：自動（每日匯率，抓不到用內建值）或手動（1 USD = 輸入的值）。上游 currencyRateMode。 */
function RateField({ s }: { s: SettingsView }) {
  const updateSettings = useApp((x) => x.updateSettings);
  const currency = useApp((x) => x.currency);
  const code = s.currency;
  const manual = (s.currencyRates[code] ?? 0) > 0;
  const rate = currency?.code === code ? currency.rate : (s.currencyRates[code] ?? 0);
  const [draft, setDraft] = useState<string | null>(null);
  const setOverride = (value: number | null) => {
    const next = { ...s.currencyRates };
    if (value && value > 0) next[code] = value;
    else delete next[code];
    void updateSettings({ currencyRates: next });
  };
  let hint = t("1 USD = {rate}", { rate: fmtRate(rate) });
  if (manual) hint = t("手動設定的匯率");
  else if (currency?.mode === "live" && currency.date) {
    hint = t("1 USD = {rate} · 更新 {date}", { rate: fmtRate(rate), date: currency.date.slice(5) });
  }
  return (
    <Field label={t("匯率")} hint={hint}>
      {manual && (
        <label className="flex items-center gap-1 text-xs text-fg/60">
          {"1 USD ="}
          <input
            type="number"
            min={0}
            step={0.0001}
            className="w-24 rounded-sm border border-fg/15 bg-inset px-2 py-1 text-right text-sm"
            value={draft ?? String(s.currencyRates[code] ?? "")}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft === null) return;
              const v = Number(draft);
              // 空白或無效 = 刪掉手動值、回到自動（上游相同）。
              setOverride(Number.isFinite(v) && v > 0 ? v : null);
              setDraft(null);
            }}
          />
        </label>
      )}
      <Segmented<"auto" | "manual">
        value={manual ? "manual" : "auto"}
        options={[
          { value: "auto", label: t("自動") },
          { value: "manual", label: t("手動") },
        ]}
        // 切到手動時先填入目前生效的匯率，再讓使用者改。
        onChange={(v) => setOverride(v === "manual" ? rate || null : null)}
      />
    </Field>
  );
}

export function DisplaySection({ s }: { s: SettingsView }) {
  const updateSettings = useApp((x) => x.updateSettings);
  return (
    <Section title={t("顯示")}>
      <Field label={t("貨幣")} hint={t("成本依各家 API 牌價以美金計算，這裡只換算顯示")}>
        <Select<string> value={s.currency} options={CURRENCIES} onChange={(v) => void updateSettings({ currency: v })} />
      </Field>
      {s.currency !== "USD" && <RateField s={s} />}
      <ModelAliasFields s={s} />
      <Field label={t("服務狀態檢查間隔")} hint={t("狀態視圖的 Claude、OpenAI、Cursor、DeepSeek 官方狀態")}>
        <Select<number>
          value={s.serviceStatusRefreshMs}
          options={[
            { value: 0, label: t("手動") },
            { value: 60_000, label: t("1 分鐘") },
            { value: 120_000, label: t("2 分鐘") },
            { value: 300_000, label: t("5 分鐘") },
            { value: 900_000, label: t("15 分鐘") },
            { value: 1_800_000, label: t("30 分鐘") },
          ]}
          onChange={(v) => void updateSettings({ serviceStatusRefreshMs: v })}
        />
      </Field>
      <Field label={t("顯示即時 Token 速率")} hint={t("在底欄顯示最新生成速度；點擊可在 tok/s 與 TPM 之間切換。")}>
        <Toggle checked={s.showLiveTokenRate} onChange={(v) => void updateSettings({ showLiveTokenRate: v })} />
      </Field>
    </Section>
  );
}
