// 設定頁的 WSL 面板（上游 renderer app.js `renderWslPanel` 與 wslStatusPresentation.js）。

import type { WslState, WslStatus } from "./api";

/** 狀態標籤的色調：有用量是綠、找得到 WSL 但沒資料或沒在跑是黃，其他是灰（上游的 ok / neutral / muted）。 */
export type WslTone = "ok" | "neutral" | "muted";

export function wslTone(state: WslState): WslTone {
  if (state === "active") return "ok";
  if (state === "no-data" || state === "not-running") return "neutral";
  return "muted";
}

const SQLITE_HELP_STATES = new Set<string>(["active", "no-data"]);

function normalizeClientId(id: unknown): string {
  return String(id ?? "").trim().toLowerCase();
}

/**
 * 有找到標記、卻沒有任何用量的工具時才顯示 SQLite 的說明（上游 `shouldShowSqliteHelp`）：
 * 隔著 9P 讀不到的多半是資料庫型的工具。工具清單刻意不寫死，WSL 掃描不可能知道每一個。
 */
export function shouldShowSqliteHelp(status: WslStatus | null | undefined): boolean {
  if (!SQLITE_HELP_STATES.has(String(status?.state ?? "").toLowerCase())) return false;
  const detected = Array.isArray(status?.detected) ? status.detected : [];
  const withData = new Set((Array.isArray(status?.withData) ? status.withData : []).map(normalizeClientId).filter(Boolean));
  return detected.some((id) => {
    const clientId = normalizeClientId(id);
    return Boolean(clientId) && !withData.has(clientId);
  });
}
