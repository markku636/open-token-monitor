// 公司信箱的格式檢查，與 src-tauri/src/settings.rs 的 normalize_owner_email、以及公司版 hub
// （monorepo 根目錄的 overlay）的 hub/ingestGuard.js normalizeOwnerEmail 同一套規則：去空白、轉小寫，不像 email 就回傳空字串。
// 設定頁用它在儲存前提示打錯，免得打錯的信箱被後端靜默清掉。

const OWNER_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeOwnerEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254) return "";
  const at = email.indexOf("@");
  const domain = email.slice(at + 1);
  if (!OWNER_EMAIL.test(email) || domain.startsWith(".") || domain.endsWith(".")) return "";
  return email;
}
