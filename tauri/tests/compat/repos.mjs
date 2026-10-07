// 相容測試用到的兩份程式：上游 token-monitor 與 monorepo 根目錄的 overlay（hub/、tests/helpers/…）。
// 兩者都在同一個 monorepo 裡：預設上游是 ../upstream（git subtree），overlay 是 ..（monorepo 根目錄）。
// 可用 TOKEN_MONITOR_REPO、TOKEN_MONITOR_CUSTOM 改。

import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPO = path.resolve(process.env.TOKEN_MONITOR_REPO || path.join(root, "..", "upstream"));
export const CUSTOM = path.resolve(process.env.TOKEN_MONITOR_CUSTOM || path.join(root, ".."));
