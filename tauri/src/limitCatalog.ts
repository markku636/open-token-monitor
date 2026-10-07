// 額度 provider 的名稱（上游 src/shared/limitProviders.js `LIMIT_PROVIDER_CATALOG`，逐字照抄）。
// 主頁用短名稱 `label`（「Claude」），設定頁的清單用 `settingsLabel`（「Claude Code」）。
// 放在獨立檔案，不動額度分頁的 limits.ts（另一個 session 的檔案）；之後兩邊再收斂成一份。

interface LimitProviderEntry {
  id: string;
  label: string;
  settingsLabel?: string;
}

export const LIMIT_PROVIDER_CATALOG: readonly LimitProviderEntry[] = [
  { id: "claude", label: "Claude", settingsLabel: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
  { id: "cursor", label: "Cursor" },
  { id: "antigravity", label: "Antigravity" },
  { id: "cline", label: "Cline" },
  { id: "factory", label: "Factory Droid" },
  { id: "kimi", label: "Kimi" },
  { id: "grok", label: "Grok" },
  { id: "copilot", label: "GitHub Copilot" },
  { id: "zed", label: "Zed" },
  { id: "commandcode", label: "Command Code" },
  { id: "mimo", label: "Xiaomi MiMo" },
  { id: "zai", label: "GLM", settingsLabel: "Z.ai / GLM" },
  { id: "zaiteam", label: "GLM Team" },
  { id: "kiro", label: "Kiro" },
  { id: "workbuddy", label: "WorkBuddy" },
  { id: "qoder", label: "Qoder" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "devin", label: "Devin" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "minimax", label: "Minimax" },
  { id: "volcengine", label: "Volcengine" },
  { id: "ollama", label: "Ollama" },
  { id: "trae", label: "Trae CN" },
  { id: "alibaba", label: "Alibaba Cloud" },
  { id: "thirdparty", label: "Third-party APIs" },
];

function entry(id: string): LimitProviderEntry | undefined {
  return LIMIT_PROVIDER_CATALOG.find((p) => p.id === id);
}

/** 主頁額度模組的帳號名稱（上游 app.js `homeLimitRows` 用 option 的 `label`）。 */
export function limitProviderLabel(id: string): string {
  return entry(id)?.label ?? id;
}

/** 設定頁的 provider 清單（上游 `settingsLabel || label`）。 */
export function limitProviderSettingsLabel(id: string): string {
  const e = entry(id);
  return e?.settingsLabel ?? e?.label ?? id;
}
