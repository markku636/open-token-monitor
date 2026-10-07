// 設定頁「保留已刪除的 session」底下的狀態列（上游 renderer app.js `renderSessionUsageArchiveStatus`）。

import type { SessionArchiveStatus } from "./api";
import { t } from "./i18n";

/**
 * 保留功能關閉時說明現有資料仍在；否則是目前補回來的 session 數（上游只算已刪除、由 archive 補回的）。
 * 常駐的 tm-agent 在跑時另外註明：archive 由它寫，這裡不能清除。
 */
export function sessionArchiveNote(enabled: boolean, status: SessionArchiveStatus | null): string {
  let base = "";
  if (!enabled) base = t("保留功能已暫停，現有資料仍會保留");
  else if (status && status.archivedSessions > 0) base = t("目前保留 {n} 個已刪除的 session", { n: status.archivedSessions });
  else if (status) base = t("目前沒有保留已刪除的 session");
  if (!status?.agentActive) return base;
  const agent = t("tm-agent 正在執行，保留的資料由它寫入");
  return base ? `${base} · ${agent}` : agent;
}
