// client id → 顯示名稱（取自上游 src/shared/clientCatalog.js）與圖表顏色。

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

const COLORS: Record<string, string> = {
  claude: "#d97757",
  codex: "#10a37f",
  copilot: "#8b5cf6",
  cursor: "#60a5fa",
  opencode: "#f59e0b",
  antigravity: "#22d3ee",
  __other: "#6b7280",
};

const PALETTE = ["#f472b6", "#a3e635", "#fb923c", "#38bdf8", "#c084fc", "#facc15", "#34d399", "#f87171"];

export function clientLabel(id: string): string {
  const label = LABELS[id] ?? id;
  // 產品名不翻；只有「其他」「未分類」這類中文標籤走 i18n。
  return id.startsWith("__") ? t(label) : label;
}

export function seriesColor(key: string, index: number): string {
  return COLORS[key] ?? PALETTE[index % PALETTE.length];
}
