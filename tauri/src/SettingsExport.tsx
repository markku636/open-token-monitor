// 設定頁的「資料匯出」（上游 Data export）：自動匯出到資料夾（CSV / JSON），或手動匯出一次。
// 檔案格式與寫法在 src-tauri/src/export.rs；選資料夾用系統的對話框。

import { useEffect, useState } from "react";
import { api, errorMessage, type ExportStatus, type SettingsView } from "./api";
import { fmtTime } from "./format";
import { t } from "./i18n";
import { useApp } from "./store";
import { Button, Field, Section, Select, Toggle } from "./ui";

const INTERVALS = [
  { value: 30_000, label: t("每 30 秒") },
  { value: 60_000, label: t("每分鐘") },
  { value: 300_000, label: t("每 5 分鐘") },
  { value: 900_000, label: t("每 15 分鐘") },
  { value: 1_800_000, label: t("每 30 分鐘") },
  { value: 3_600_000, label: t("每 60 分鐘") },
];

export function ExportSection({ s }: { s: SettingsView }) {
  const updateSettings = useApp((x) => x.updateSettings);
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [manual, setManual] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const [manualError, setManualError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void api.exportStatus().then((x) => {
        if (alive) setStatus(x);
      });
    load();
    const id = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  // 「已匯出 ✓」「匯出失敗」顯示 1.6 秒（上游相同）。
  useEffect(() => {
    if (manual !== "done" && manual !== "failed") return;
    const id = setTimeout(() => setManual("idle"), 1_600);
    return () => clearTimeout(id);
  }, [manual]);
  const ready = s.exportAutoEnabled && s.exportDir.trim() !== "";
  const exportNow = async () => {
    setManual("busy");
    setManualError(null);
    try {
      const dir = await api.exportNow();
      setManual(dir ? "done" : "idle");
    } catch (e) {
      setManualError(errorMessage(e));
      setManual("failed");
    }
  };
  const autoHint = (() => {
    if (!s.exportAutoEnabled) return t("匯出成 CSV / JSON —— 用 Excel 開啟，或接進 Obsidian、自寫腳本。");
    if (status?.lastError) return t("上次匯出失敗：{e}", { e: status.lastError });
    if (status?.lastAt) return t("上次匯出於 {t}", { t: fmtTime(status.lastAt) });
    return t("匯出成 CSV / JSON —— 用 Excel 開啟，或接進 Obsidian、自寫腳本。");
  })();
  return (
    <Section title={t("資料匯出")}>
      <Field label={t("自動匯出到資料夾")} hint={autoHint}>
        {s.exportAutoEnabled && (
          <span className={`text-xs ${ready ? "text-success" : "text-fg/45"}`}>{ready ? t("● 運作中") : t("未設定")}</span>
        )}
        <Toggle checked={s.exportAutoEnabled} onChange={(v) => void updateSettings({ exportAutoEnabled: v })} />
      </Field>
      {s.exportAutoEnabled && (
        <>
          <Field label={t("自動匯出頻率")}>
            <Select<number> value={s.exportIntervalMs} options={INTERVALS} onChange={(v) => void updateSettings({ exportIntervalMs: v })} />
          </Field>
          <Field label={t("資料夾")} hint={<span className="break-all font-mono">{s.exportDir || t("尚未選擇資料夾")}</span>}>
            <Button onClick={() => void api.exportPickDir()}>{t("選擇資料夾…")}</Button>
          </Field>
        </>
      )}
      <Field label={t("或立即手動匯出一次到你選的資料夾：")} hint={manualError ?? undefined}>
        <Button disabled={manual === "busy"} onClick={() => void exportNow()}>
          {manual === "done" ? t("已匯出 ✓") : manual === "failed" ? t("匯出失敗") : t("手動匯出…")}
        </Button>
      </Field>
    </Section>
  );
}
