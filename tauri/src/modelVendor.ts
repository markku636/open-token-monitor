// 模型 id → 廠商 id（上游 src/electron/renderer/usageCharts.js `modelVendorFor`，正規式與順序照抄）。
// 模型列、儀表板圖表的顏色（vendorColors.ts）與之後的品牌圖示都從這裡取廠商，只維護這一份。
//
// 刻意不 import 任何東西、只用可抹除的 TS 語法：tests/compat/theme-compat.test.mjs 以 Node 的
// type stripping 直接載入，與上游的 JavaScript 比對。

export function modelVendorFor(model: unknown): string | null {
  const name = String(model || "").toLowerCase();
  if (/^(cursor-)?auto$/.test(name)) return "cursor";
  if (/claude|anthropic|sonnet|opus|haiku/.test(name)) return "claude";
  if (/gpt|openai|codex|^o[134](?:-|$)|o[134]-(mini|pro|preview)|chatgpt/.test(name)) return "codex";
  if (/gemini|gemma|google/.test(name)) return "gemini";
  if (/grok|xai/.test(name)) return "xai";
  if (/deepseek/.test(name)) return "deepseek";
  if (/nemotron|nvidia/.test(name)) return "nvidia";
  if (/llama|meta|muse-spark(?:-|$)/.test(name)) return "meta";
  if (/mistral|mixtral|codestral/.test(name)) return "mistral";
  if (/qwen|qwq|qvq|qmodel/.test(name)) return "qwen";
  // Kimi 的 coding plan 也有不帶 `kimi` 前綴的 `k2` / `k3`（`k3`、`k3-256k`）；以分隔字元界定的
  // token 對應 tokscale 的廠商判斷，兩個 `-agent` id 因為後綴是英數字而另外列出。與上游同樣放在
  // 同一條正規式裡，不另寫第二個判斷。
  if (/kimi|moonshot|k2d6-agent|k3-agent|(?:^|[^a-z0-9])k[23](?:[^a-z0-9]|$)/.test(name)) return "kimi";
  if (/chatglm|\bglm-|\bzai\b|z\.ai|zhipu/.test(name)) return "zai";
  if (/cohere|command-r/.test(name)) return "cohere";
  if (/mimo|xiaomi/.test(name)) return "xiaomi";
  if (/minimax|\babab/.test(name)) return "minimax";
  if (/doubao|\bseed(?:-|$)/.test(name)) return "doubao";
  if (/stepfun|step-/.test(name)) return "stepfun";
  if (/hy\d|hunyuan/.test(name)) return "hunyuan";
  if (/^swe[-_]|devin|cognition/.test(name)) return "devin";
  if (/^big-pickle$/.test(name)) return "opencode"; // OpenCode Zen 的匿名模型，名稱裡沒有廠商線索
  return null;
}
