// 設定頁的「採集頻率」：上游 renderer 把 collectionMode 與 collectionIntervalMs 合成一個選單
// （index.html 的 collectionCadenceInput、app.js 的對應讀寫）。
import type { Settings, SettingsPatch } from "./api";

/** 選單的值：兩種模式，或 interval 模式的間隔（毫秒的字串，與上游 option 的 value 相同）。 */
export type CollectionCadence = "live" | "smart" | "300000" | "900000" | "1800000";

/** 上游 main.js `COLLECTION_INTERVAL_OPTIONS`（智慧採集固定 10 分鐘，不在這裡）。 */
const INTERVAL_OPTIONS: ReadonlySet<number> = new Set([300_000, 900_000, 1_800_000]);

/** 設定 → 選單的值；interval 的間隔不在選項裡時顯示 5 分鐘（上游相同）。 */
export function cadenceOf(s: Pick<Settings, "collectionMode" | "collectionIntervalMs">): CollectionCadence {
  if (s.collectionMode === "smart") return "smart";
  if (s.collectionMode === "interval") {
    const ms = INTERVAL_OPTIONS.has(s.collectionIntervalMs) ? s.collectionIntervalMs : 300_000;
    return String(ms) as CollectionCadence;
  }
  return "live";
}

/**
 * 選單的值 → 設定 patch。live 與 smart 不動 collectionIntervalMs：它留給切回 interval 時用
 * （上游選 smart 時送的 600000 本來就會被 Rust 端擋下）。
 */
export function cadencePatch(value: CollectionCadence): SettingsPatch {
  if (value === "live" || value === "smart") return { collectionMode: value };
  return { collectionMode: "interval", collectionIntervalMs: Number(value) };
}
