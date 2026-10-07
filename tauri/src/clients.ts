// client id → 顯示名稱（取自上游 src/shared/clientCatalog.js）。顏色在 vendorColors.ts（上游品牌表，可由設定覆寫）。

import { t } from "./i18n";

const LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  hermes: "Hermes Agent",
  openclaw: "OpenClaw",
  cursor: "Cursor IDE / CLI",
  antigravity: "Antigravity",
  cline: "Cline",
  amp: "Amp",
  droid: "Factory Droid",
  kimi: "Kimi",
  qwen: "Qwen",
  grok: "Grok Build",
  copilot: "GitHub Copilot",
  pi: "Pi",
  zed: "Zed",
  kilo: "Kilo",
  commandcode: "Command Code",
  mimo: "Xiaomi MiMo",
  zcode: "ZCode",
  kiro: "Kiro",
  codebuddy: "CodeBuddy",
  workbuddy: "WorkBuddy",
  reasonix: "Reasonix",
  dsh: "DeepSeek Harness",
  cherrystudio: "Cherry Studio",
  lmstudio: "LM Studio",
  unsloth: "Unsloth",
  devin: "Devin",
  __other: "其他",
  __unattributed: "未分類",
};

export function clientLabel(id: string): string {
  const label = LABELS[id] ?? id;
  // 產品名不翻；只有「其他」「未分類」這類中文標籤走 i18n。
  return id.startsWith("__") ? t(label) : label;
}
