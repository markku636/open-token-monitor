// 自動更新狀態的顯示文字（設定頁）。widget 的更新提示在 UpdatePill.tsx。狀態機本身在 Rust：src-tauri/src/update.rs。

import type { UpdateState } from "./api";
import { fmtTime } from "./format";
import { t } from "./i18n";

const DISABLED_REASON: Record<string, string> = {
  devBuild: t("開發版不會自動更新"),
  debugBuild: t("除錯建置不會自動更新"),
  noPublicKey: t("這個安裝檔沒有更新簽章，不會自動更新"),
  noHub: t("沒有設定公司 hub，無法取得更新"),
  invalidHub: t("hub 位置無效，無法取得更新"),
};

function fmtMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export function updateStatusText(u: UpdateState | null): string {
  if (!u) return t("讀取中…");
  switch (u.state) {
    case "disabled":
      return DISABLED_REASON[u.reason] ?? t("自動更新未啟用");
    case "idle":
      return t("尚未檢查");
    case "checking":
      return t("正在檢查更新…");
    case "upToDate":
      return t("已是最新版本（{t} 檢查）", { t: fmtTime(u.checkedAt) });
    case "available":
      return t("有新版 v{v} 可以下載", { v: u.version });
    case "downloading":
      return u.total
        ? t("正在下載 v{v}：{r} / {n} MB", { v: u.version, r: fmtMb(u.received), n: fmtMb(u.total) })
        : t("正在下載 v{v}：{r} MB", { v: u.version, r: fmtMb(u.received) });
    case "ready":
      return t("v{v} 已下載，重新啟動後完成更新", { v: u.version });
    case "installing":
      return t("正在安裝 v{v}…", { v: u.version });
    case "error":
      return u.retryAt ? t("{e}（{t} 自動重試）", { e: u.message, t: fmtTime(u.retryAt) }) : u.message;
  }
}

/**
 * widget 要不要顯示更新提示：下載好了一定顯示；有新版或下載中時，除非使用者忽略了這個版本
 * （上游 `showUpdateNotice = downloaded || (hasUpdate && !dismissed)`）。
 */
export function updatePillVisible(u: UpdateState | null, dismissed: string): u is Extract<UpdateState, { version: string }> {
  if (!u || !("version" in u)) return false;
  if (u.state === "ready") return true;
  if (u.state === "available" || u.state === "downloading") return u.version !== dismissed;
  return false;
}
