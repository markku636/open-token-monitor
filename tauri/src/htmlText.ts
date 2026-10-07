// 版本說明裡的 HTML：只去掉真的 HTML 標籤與註解，`<user>`、`Array<string>` 這類文字保留，實體解碼。
// 逐行照抄上游 src/shared/appUpdater.js 的 `textOutsideHtmlMarkup` / `startsHtmlMarkup` /
// `decodeHtmlEntities`（已知標籤清單 + 要有對應的結束標籤才算）。

const MAX_MARKUP_CHARS = 1024;

const HTML_TAGS = new Set([
  "a", "abbr", "article", "aside", "b", "blockquote", "br", "caption", "cite", "code",
  "col", "colgroup", "dd", "del", "details", "div", "dl", "dt", "em", "figcaption",
  "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i",
  "img", "ins", "kbd", "li", "main", "mark", "ol", "p", "picture", "pre", "q",
  "s", "samp", "script", "section", "small", "source", "span", "strong", "style",
  "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time",
  "tr", "u", "ul", "var",
]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

const NAMED: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };

export function decodeHtmlEntities(value: string): string {
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(NAMED, lower)) return NAMED[lower];
    const cp = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return match;
    try {
      return String.fromCodePoint(cp);
    } catch {
      return match;
    }
  });
}

const isLetter = (v: string, i: number) => {
  const c = v.charCodeAt(i);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
};
const isAlnum = (v: string, i: number) => {
  const c = v.charCodeAt(i);
  return isLetter(v, i) || (c >= 48 && c <= 57);
};
const isSpace = (v: string, i: number) => v[i] === "\t" || v[i] === "\n" || v[i] === "\f" || v[i] === "\r" || v[i] === " ";

function markupEnd(v: string, index: number): number {
  let quote = "";
  const limit = Math.min(v.length, index + MAX_MARKUP_CHARS);
  for (let c = index + 1; c < limit; c += 1) {
    if (quote) {
      if (v[c] === quote) quote = "";
    } else if (v[c] === '"' || v[c] === "'") {
      quote = v[c];
    } else if (v[c] === ">") {
      return c;
    }
  }
  return -1;
}

function containsNestedMarkup(v: string, index: number, end: number): boolean {
  for (let c = index + 1; c < end; c += 1) {
    if (v[c] === "<" && startsHtmlMarkup(v, c)) return true;
  }
  return false;
}

function hasMatchingClose(v: string, index: number, tag: string): boolean {
  const lower = v.toLowerCase();
  const prefix = `</${tag}`;
  let cursor = index;
  while (cursor < v.length) {
    const start = v.indexOf("<", cursor);
    if (start < 0) return false;
    if (v.startsWith("<!--", start)) {
      const commentEnd = v.indexOf("-->", start + 4);
      if (commentEnd < 0) return false;
      cursor = commentEnd + 3;
      continue;
    }
    if (lower.startsWith(prefix, start)) {
      let e = start + prefix.length;
      while (isSpace(v, e)) e += 1;
      if (v[e] === ">") return true;
    }
    const tagLike = isLetter(v, start + 1) || (v[start + 1] === "/" && isLetter(v, start + 2)) || v[start + 1] === "!" || v[start + 1] === "?";
    if (!tagLike) {
      cursor = start + 1;
      continue;
    }
    const e = markupEnd(v, start);
    if (e < 0) return false;
    cursor = e + 1;
  }
  return false;
}

export function startsHtmlMarkup(v: string, index: number): boolean {
  if (v[index] !== "<") return false;
  if (v.startsWith("<!--", index)) {
    const commentEnd = v.indexOf("-->", index + 4);
    return commentEnd >= 0 && commentEnd - index < MAX_MARKUP_CHARS;
  }
  const end = markupEnd(v, index);
  if (end < 0) return false;
  if (v[index + 1] === "!" || v[index + 1] === "?") return true;
  const closing = v[index + 1] === "/";
  const nameStart = index + (closing ? 2 : 1);
  if (!isLetter(v, nameStart)) return false;
  let nameEnd = nameStart + 1;
  while (isAlnum(v, nameEnd) || v[nameEnd] === "-") nameEnd += 1;
  const tag = v.slice(nameStart, nameEnd).toLowerCase();
  if (!HTML_TAGS.has(tag) && !VOID_TAGS.has(tag)) return containsNestedMarkup(v, index, end);
  if (closing || VOID_TAGS.has(tag)) return true;
  return hasMatchingClose(v, end + 1, tag);
}

export function textOutsideHtmlMarkup(value: string): string {
  const input = String(value || "");
  let output = "";
  let mode: "text" | "tag" | "comment" = "text";
  let quote = "";
  for (let i = 0; i < input.length; i += 1) {
    if (mode === "comment") {
      if (input[i] === "-" && input[i + 1] === "-" && input[i + 2] === ">") {
        mode = "text";
        i += 2;
      }
      continue;
    }
    if (mode === "tag") {
      if (quote) {
        if (input[i] === quote) quote = "";
      } else if (input[i] === '"' || input[i] === "'") {
        quote = input[i];
      } else if (input[i] === ">") {
        mode = "text";
      }
      continue;
    }
    if (startsHtmlMarkup(input, i)) {
      if (input[i + 1] === "!" && input[i + 2] === "-" && input[i + 3] === "-") {
        mode = "comment";
        i += 3;
      } else {
        mode = "tag";
        quote = "";
      }
      continue;
    }
    output += input[i];
  }
  return decodeHtmlEntities(output);
}
