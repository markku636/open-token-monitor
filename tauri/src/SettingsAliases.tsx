// 設定頁「顯示」裡的模型別名（上游 settings.modelAliases）：自動合併的方式與手動的別名清單。
// 只影響畫面；上傳與匯出保留原本的模型 id。

import { X } from "lucide-react";
import { useState } from "react";
import type { SettingsView } from "./api";
import { t } from "./i18n";
import { matchKey, validAliasPair, type AliasGrouping } from "./modelAliases";
import { useApp } from "./store";
import { Button, Field, Select } from "./ui";

export function ModelAliasFields({ s }: { s: SettingsView }) {
  const updateSettings = useApp((x) => x.updateSettings);
  const models = useApp((x) => x.local?.periods.allTime.models);
  const [alias, setAlias] = useState("");
  const [canonical, setCanonical] = useState("");
  const [invalid, setInvalid] = useState(false);
  const entries = Object.entries(s.modelAliases);
  const add = () => {
    // 同一個別名（依比對鍵，與 Rust 的 normalize_model_aliases 相同）只留新的那組。
    const kept = entries.filter(([a]) => matchKey(a) !== matchKey(alias));
    if (!validAliasPair(alias, canonical) || kept.length >= 4096) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const next = Object.fromEntries(kept);
    next[alias.trim()] = canonical.trim();
    void updateSettings({ modelAliases: next });
    setAlias("");
    setCanonical("");
  };
  const remove = (key: string) => {
    const next = { ...s.modelAliases };
    delete next[key];
    void updateSettings({ modelAliases: next });
  };
  return (
    <>
      <Field
        label={t("模型別名")}
        hint={t("「合併重複」只處理同一模型同時出現兩種寫法的情況；「移除前綴」會移除所有模型名稱中 / 前面的 provider 名稱，例如 anthropic/claude-opus-5 → claude-opus-5。")}
      >
        <Select<AliasGrouping>
          value={s.modelAliasGrouping}
          options={[
            { value: "off", label: t("關閉") },
            { value: "duplicates", label: t("合併重複") },
            { value: "prefix", label: t("移除前綴") },
          ]}
          onChange={(v) => void updateSettings({ modelAliasGrouping: v })}
        />
      </Field>
      <div className="space-y-1.5 py-2.5">
        <div className="text-xs text-fg/50">{t("把同一個模型的不同名稱合併成一列顯示。")}</div>
        {entries.map(([a, c]) => (
          <div key={a} className="flex items-center gap-2 rounded-sm bg-inset px-2 py-1 font-mono text-xs">
            <span className="min-w-0 flex-1 truncate" title={a}>
              {a}
            </span>
            <span className="text-fg/40">→</span>
            <span className="min-w-0 flex-1 truncate" title={c}>
              {c}
            </span>
            <button type="button" className="text-fg/40 hover:text-danger" title={t("移除")} onClick={() => remove(a)}>
              <X size={12} />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <input
            list="tm-model-ids"
            className="min-w-0 flex-1 rounded-sm border border-fg/15 bg-inset px-2 py-1 font-mono text-xs"
            placeholder={t("別名（記錄中的模型 ID）")}
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
          />
          <span className="text-fg/40">→</span>
          <input
            list="tm-model-ids"
            className="min-w-0 flex-1 rounded-sm border border-fg/15 bg-inset px-2 py-1 font-mono text-xs"
            placeholder={t("合併至（模型 ID）")}
            value={canonical}
            onChange={(e) => setCanonical(e.target.value)}
          />
          <Button onClick={add}>{t("新增別名")}</Button>
          <datalist id="tm-model-ids">
            {Object.keys(models ?? {}).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
        {invalid && <div className="text-xs text-danger">{t("請輸入兩個不同的模型 ID（1–256 個字元），最多 4,096 組對應。")}</div>}
      </div>
    </>
  );
}
