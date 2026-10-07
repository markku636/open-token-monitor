// 版本說明（latest.json 的 notes，打包時 -NotesFile 給的 Markdown）→ 分組的純文字。
// 規則照上游 src/shared/appUpdater.js：`<!-- app-update-notes:<語言>:start/end -->` 標記的區段優先，
// `### 標題` 開一組、`- 項目` 是一條；最多 4 組、12 條，每條 600 字、標題 80 字；連結與圖片留文字、
// 去掉反引號與粗體、行尾的 (#123) 參照。IT 寫的說明常常沒有標題，那就把每一行當一條、不分組。

import { textOutsideHtmlMarkup } from "./htmlText";

export interface NoteGroup {
  title: string;
  items: string[];
}

const MAX_BODY = 128 * 1024;
const MAX_GROUPS = 4;
const MAX_ITEMS = 12;
const MAX_ITEM_CHARS = 600;
const TRAILING_PR = /\s*(?:\(\s*#\d+(?:\s*,\s*#\d+)*\s*\)|（\s*#\d+(?:\s*[、，,]\s*#\d+)*\s*）)\s*$/;

function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

export function plainNoteText(value: string, max = MAX_ITEM_CHARS): string {
  const text = textOutsideHtmlMarkup(value)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/([：。！？])\s+/g, "$1")
    .trim()
    .replace(TRAILING_PR, "")
    .trimEnd();
  return truncate(text, max);
}

function markedSection(body: string, locale: string): string {
  const start = `<!-- app-update-notes:${locale}:start -->`;
  const end = `<!-- app-update-notes:${locale}:end -->`;
  const i = body.indexOf(start);
  if (i < 0) return "";
  const from = i + start.length;
  const j = body.indexOf(end, from);
  return j < 0 ? "" : body.slice(from, j);
}

function parseGroups(section: string): NoteGroup[] {
  const groups: NoteGroup[] = [];
  let current: NoteGroup | null = null;
  let count = 0;
  const finish = () => {
    if (current?.title && current.items.length && groups.length < MAX_GROUPS) groups.push(current);
  };
  for (const line of section.split(/\r?\n/)) {
    const heading = /^\s*###\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      finish();
      current = groups.length < MAX_GROUPS ? { title: plainNoteText(heading[1], 80), items: [] } : null;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!bullet || !current || count >= MAX_ITEMS) continue;
    const text = plainNoteText(bullet[1]);
    if (!text) continue;
    current.items.push(text);
    count += 1;
  }
  finish();
  return groups;
}

/** 介面語言的區段優先（繁中 → zh → en；英文 → en → zh），沒有標記時整份照 `###` 分組，再不行就逐行。 */
export function parseReleaseNotes(notes: string | null | undefined, lang: "zh-TW" | "en"): NoteGroup[] {
  if (typeof notes !== "string" || !notes.trim()) return [];
  const body = notes.slice(0, MAX_BODY);
  for (const locale of lang === "en" ? ["en", "zh", "zh-TW"] : ["zh-TW", "zh", "en"]) {
    const section = markedSection(body, locale);
    const groups = section ? parseGroups(section) : [];
    if (groups.length) return groups;
  }
  if (body.includes("<!-- app-update-notes:")) return [];
  const groups = parseGroups(body);
  if (groups.length) return groups;
  const items = body
    .split(/\r?\n/)
    .map((l) => plainNoteText(l.replace(/^\s*(?:[-*]|#+)\s+/, "")))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
  return items.length ? [{ title: "", items }] : [];
}
