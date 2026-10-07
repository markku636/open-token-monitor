// 模型別名（上游 renderer/modelAliases.js + src/electron/modelAliasPresentation.js）：把同一個模型的不同
// 寫法合併成一列顯示。只影響畫面；上傳到 hub 與匯出的檔案保留原本的模型 id（上游相同）。
//
// - 手動別名（設定 modelAliases：記錄中的 id → 合併成的 id）一律套用，以「小寫、. _ 空白換成 -」比對。
// - 自動合併（modelAliasGrouping）：`duplicates` 只在同一模型同時出現兩種以上寫法時合併；`prefix` 連單獨
//   出現的 `供應商/模型` 也去掉前綴。合併後的名稱依序偏好：與識別相同的葉名、沒有前綴、全小寫、
//   沒有 . _ 空白、最短。

import type { Share, UsageRow } from "./api";

export type AliasGrouping = "off" | "duplicates" | "prefix";

const MAX_ALIASES = 4096;
const MAX_MODEL_ID_LENGTH = 256;

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function matchKey(model: string): string {
  return text(model)
    .toLowerCase()
    .replace(/[._\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function modelLeaf(model: string): string {
  const raw = text(model);
  if (!raw) return "";
  const parts = raw.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? raw;
}

const identityKey = (model: string) => matchKey(modelLeaf(model));

export function validAliasPair(alias: string, canonical: string): boolean {
  const a = text(alias);
  const c = text(canonical);
  return Boolean(a && c && a.length <= MAX_MODEL_ID_LENGTH && c.length <= MAX_MODEL_ID_LENGTH && matchKey(a) !== matchKey(c));
}

function rank(model: string, identity: string): (number | string)[] {
  const leaf = modelLeaf(model);
  return [
    identityKey(model) === identity ? 0 : 1,
    model === leaf ? 0 : 1,
    leaf === leaf.toLowerCase() ? 0 : 1,
    /[._\s]/.test(leaf) ? 1 : 0,
    leaf.length,
    leaf.toLowerCase(),
    leaf,
  ];
}

function compareCandidates(a: string, b: string, identity: string): number {
  const x = rank(a, identity);
  const y = rank(b, identity);
  for (let i = 0; i < x.length; i += 1) {
    if (x[i] < y[i]) return -1;
    if (x[i] > y[i]) return 1;
  }
  return 0;
}

/** 上游 `inferModelAliases`。 */
export function inferModelAliases(modelIds: string[], grouping: AliasGrouping): Record<string, string> {
  if (grouping === "off") return {};
  const models = [...new Set(modelIds.map(text).filter((m) => m && m.length <= MAX_MODEL_ID_LENGTH))];
  if (models.length < (grouping === "prefix" ? 1 : 2)) return {};
  const groups = new Map<string, string[]>();
  for (const m of models) {
    const key = identityKey(m);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const out: Record<string, string> = {};
  let count = 0;
  for (const [identity, group] of groups) {
    if (grouping !== "prefix" && group.length < 2) continue;
    const canonical = modelLeaf([...group].sort((a, b) => compareCandidates(a, b, identity))[0]);
    for (const m of group) {
      if (m === canonical) continue;
      out[m] = canonical;
      if (++count >= MAX_ALIASES) return out;
    }
  }
  return out;
}

export type Resolve = (model: string) => string;

/** 上游 `createModelAliasResolver`：手動優先，自動的結果再套一次手動（可以把自動合併的名字再改名）。 */
export function createResolver(aliases: Record<string, string>, modelIds: string[], grouping: AliasGrouping): Resolve {
  const explicit = new Map(
    Object.entries(aliases ?? {})
      .filter(([a, c]) => validAliasPair(a, c))
      .map(([a, c]) => [matchKey(a), text(c)]),
  );
  const automatic = new Map(Object.entries(inferModelAliases(modelIds, grouping)).map(([a, c]) => [matchKey(a), c]));
  if (!explicit.size && !automatic.size) return (m) => m;
  return (model) => {
    const direct = explicit.get(matchKey(model));
    if (direct !== undefined) return direct;
    const inferred = automatic.get(matchKey(model));
    if (inferred === undefined) return model;
    return explicit.get(matchKey(inferred)) ?? inferred;
  };
}

/** `{ 模型: 數量 }` 依別名合併（token 與成本各一份）。 */
export function foldMap(map: Record<string, number>, resolve: Resolve): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    const key = resolve(k);
    out[key] = (out[key] ?? 0) + (Number(v) || 0);
  }
  return out;
}

/** 模型清單（明細）依別名合併：token、成本與組成相加；未分類那列不動。依 token 由多到少。 */
export function foldRows<T extends Share & Partial<Pick<UsageRow, "components">>>(rows: T[], resolve: Resolve): T[] {
  const byKey = new Map<string, T>();
  const out: T[] = [];
  for (const r of rows) {
    if (r.unattributed) {
      out.push(r);
      continue;
    }
    const key = resolve(r.key);
    const prev = byKey.get(key);
    if (!prev) {
      const copy = { ...r, key } as T;
      byKey.set(key, copy);
      out.push(copy);
      continue;
    }
    prev.tokens += r.tokens;
    prev.costUsd += r.costUsd;
    if ("components" in prev || "components" in r) {
      const a = prev.components ?? null;
      const b = r.components ?? null;
      prev.components =
        a && b
          ? {
              cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
              outputTokens: a.outputTokens + b.outputTokens,
              unclassifiedTokens: a.unclassifiedTokens + b.unclassifiedTokens,
            }
          : (a ?? b);
    }
  }
  return out.sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
}

/** session 的模型名稱：合併後去重、排序。 */
export function foldNames(models: string[], resolve: Resolve): string[] {
  return [...new Set(models.map(resolve))].sort();
}
