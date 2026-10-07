// 介面字串：繁中原文就是 key，缺翻譯時直接顯示原文。
//
// 語言在這個模組載入時就決定（讀 localStorage 的 `tm:lang`），因為有些字串是其他模組
// 在載入時就翻好的常數（分頁、期間名稱）。ES module 的相依會先執行，所以任何 import t 的
// 模組都看得到正確的語言。切換語言時 store 會寫回 `tm:lang` 並重新載入視窗。

import { EN } from "./locales/en";

export type Lang = "zh-TW" | "en";
/** 設定裡的值：`auto` 依系統語言。 */
export type LangSetting = "auto" | Lang;

type Vars = Record<string, string | number>;

const LANG_KEY = "tm:lang";

/** `auto`：系統語言是中文（任何地區）就用繁中，否則英文。 */
export function resolveLang(setting: string | null | undefined, systemLang?: string): Lang {
  if (setting === "zh-TW" || setting === "en") return setting;
  const sys = (systemLang ?? (typeof navigator !== "undefined" ? navigator.language : "zh-TW")).toLowerCase();
  return sys.startsWith("zh") ? "zh-TW" : "en";
}

function readStoredSetting(): string | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}

let current: Lang = resolveLang(readStoredSetting());
let dict: Record<string, string> = current === "en" ? EN : {};

export function lang(): Lang {
  return current;
}

/**
 * 設定的語言與目前載入的不同時，記下來並回傳 true（呼叫端重新載入視窗）。
 * 第一次啟動（localStorage 還沒有值）也會走到這裡一次，之後就穩定了。
 */
export function syncLangSetting(setting: string): boolean {
  try {
    if (localStorage.getItem(LANG_KEY) !== setting) localStorage.setItem(LANG_KEY, setting);
  } catch {
    /* 無法儲存時仍照目前語言顯示 */
  }
  return resolveLang(setting) !== current;
}

/** 測試用：直接切換字典，不經 localStorage。 */
export function setLangForTest(l: Lang) {
  current = l;
  dict = l === "en" ? EN : {};
}

export function t(source: string, vars?: Vars): string {
  const text = dict[source] ?? source;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
