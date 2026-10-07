import { afterEach, describe, expect, it } from "vitest";
import { setLangForTest } from "./i18n";
import { sessionArchiveNote } from "./sessionArchive";

describe("sessionArchiveNote", () => {
  afterEach(() => setLangForTest("zh-TW"));

  it("counts the retained sessions like upstream", () => {
    setLangForTest("en");
    expect(sessionArchiveNote(true, { archivedSessions: 3, agentActive: false })).toBe("Deleted sessions retained: 3");
    expect(sessionArchiveNote(true, { archivedSessions: 0, agentActive: false })).toBe("No deleted sessions retained");
    expect(sessionArchiveNote(true, null)).toBe("");
  });

  it("says the data stays while preservation is paused", () => {
    setLangForTest("en");
    expect(sessionArchiveNote(false, { archivedSessions: 0, agentActive: false })).toBe(
      "Preservation paused; retained data is kept",
    );
  });

  it("names the running agent as the writer", () => {
    expect(sessionArchiveNote(true, { archivedSessions: 2, agentActive: true })).toBe(
      "目前保留 2 個已刪除的 session · tm-agent 正在執行，保留的資料由它寫入",
    );
    expect(sessionArchiveNote(true, null)).toBe("");
  });
});
