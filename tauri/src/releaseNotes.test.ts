import { describe, expect, it } from "vitest";
import { parseReleaseNotes, plainNoteText } from "./releaseNotes";

describe("releaseNotes", () => {
  it("cleans markdown into plain text", () => {
    expect(plainNoteText("Fix **tray** [menu](https://x) `icon` (#12, #13)")).toBe("Fix tray menu icon");
    expect(plainNoteText("修正　匯出。 之後")).toBe("修正 匯出。之後");
    expect(plainNoteText("x".repeat(700))).toHaveLength(600);
    // 只去掉真的 HTML 標籤；像 <user> 的文字保留，實體解碼（上游 textOutsideHtmlMarkup）。
    expect(plainNoteText("Fix crash when the path contains <user> or Array<string>")).toBe("Fix crash when the path contains <user> or Array<string>");
    expect(plainNoteText("R&amp;D <b>dashboard</b> <!-- hidden -->ok")).toBe("R&D dashboard ok");
  });

  it("prefers the section for the interface language", () => {
    const notes = [
      "<!-- app-update-notes:en:start -->",
      "### Fixes",
      "- Tray icon",
      "<!-- app-update-notes:en:end -->",
      "<!-- app-update-notes:zh-TW:start -->",
      "### 修正",
      "- 系統匣圖示",
      "<!-- app-update-notes:zh-TW:end -->",
    ].join("\n");
    expect(parseReleaseNotes(notes, "zh-TW")).toEqual([{ title: "修正", items: ["系統匣圖示"] }]);
    expect(parseReleaseNotes(notes, "en")).toEqual([{ title: "Fixes", items: ["Tray icon"] }]);
  });

  it("groups plain markdown and caps groups and items", () => {
    const notes = Array.from({ length: 6 }, (_, g) => `### G${g}\n${Array.from({ length: 4 }, (_, i) => `- item ${g}.${i}`).join("\n")}`).join("\n");
    const groups = parseReleaseNotes(notes, "en");
    // 12 條用完之後的組沒有項目，不顯示。
    expect(groups).toHaveLength(3);
    expect(groups.flatMap((g) => g.items)).toHaveLength(12);
    const many = Array.from({ length: 6 }, (_, g) => `### G${g}\n- only`).join("\n");
    expect(parseReleaseNotes(many, "en")).toHaveLength(4);
  });

  it("falls back to one item per line when there are no headings", () => {
    expect(parseReleaseNotes("修正上傳失敗\n\n- 加快掃描", "zh-TW")).toEqual([{ title: "", items: ["修正上傳失敗", "加快掃描"] }]);
    expect(parseReleaseNotes("", "en")).toEqual([]);
    expect(parseReleaseNotes(null, "en")).toEqual([]);
  });
});
