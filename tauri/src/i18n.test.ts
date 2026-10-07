import { afterEach, describe, expect, it } from "vitest";
import { resolveLang, setLangForTest, t } from "./i18n";
import { EN } from "./locales/en";

// 所有原始碼（測試檔除外）的原文，由 Vite 在測試時讀進來。
const SOURCES = import.meta.glob(["./*.ts", "./*.tsx", "!./*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// 原始碼裡 t("…") / tr("…") 的中文 key。
function sourceKeys(): string[] {
  const keys = new Set<string>();
  for (const text of Object.values(SOURCES)) {
    for (const m of text.matchAll(/\bt(?:r)?\("((?:[^"\\]|\\.)+)"/g)) keys.add(m[1]);
  }
  return [...keys].filter((k) => /[一-鿿]/.test(k));
}

describe("i18n", () => {
  afterEach(() => setLangForTest("zh-TW"));

  it("resolves auto from the system language", () => {
    expect(resolveLang("auto", "zh-TW")).toBe("zh-TW");
    expect(resolveLang("auto", "zh-CN")).toBe("zh-TW");
    expect(resolveLang("auto", "en-US")).toBe("en");
    expect(resolveLang("en", "zh-TW")).toBe("en");
    expect(resolveLang(null, "ja-JP")).toBe("en");
  });

  it("translates and interpolates", () => {
    setLangForTest("en");
    expect(t("全公司 · 線上 {online} / {total} 台", { online: 3, total: 5 })).toBe("Company · 3 of 5 PCs online");
    expect(t("沒有翻譯的字")).toBe("沒有翻譯的字");
    setLangForTest("zh-TW");
    expect(t("{n} 分鐘前", { n: 3 })).toBe("3 分鐘前");
  });

  it("has an English string for every Chinese key in the source", () => {
    const missing = sourceKeys().filter((k) => !(k in EN));
    expect(missing).toEqual([]);
  });
});
