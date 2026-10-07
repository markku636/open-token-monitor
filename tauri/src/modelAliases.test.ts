import { describe, expect, it } from "vitest";
import { createResolver, foldMap, foldNames, foldRows, inferModelAliases, matchKey, modelLeaf, validAliasPair } from "./modelAliases";

describe("modelAliases", () => {
  it("normalizes model ids for matching", () => {
    expect(matchKey(" Claude_Opus.5 ")).toBe("claude-opus-5");
    expect(modelLeaf("anthropic/claude-opus-5")).toBe("claude-opus-5");
    expect(validAliasPair("gpt_5", "gpt-5")).toBe(false);
    expect(validAliasPair("gpt-5-cc", "gpt-5")).toBe(true);
  });

  it("merges duplicates only when both spellings are present", () => {
    expect(inferModelAliases(["anthropic/claude-opus-5"], "duplicates")).toEqual({});
    expect(inferModelAliases(["anthropic/claude-opus-5", "claude-opus-5"], "duplicates")).toEqual({
      "anthropic/claude-opus-5": "claude-opus-5",
    });
    expect(inferModelAliases(["openai/gpt-5.5"], "prefix")).toEqual({ "openai/gpt-5.5": "gpt-5.5" });
    expect(inferModelAliases(["a/x", "x"], "off")).toEqual({});
  });

  it("applies manual aliases before and after automatic grouping", () => {
    const resolve = createResolver({ "gpt-5-cc": "gpt-5", "claude-opus-5": "Opus 5" }, ["anthropic/claude-opus-5", "claude-opus-5"], "duplicates");
    expect(resolve("GPT_5_CC")).toBe("gpt-5");
    expect(resolve("anthropic/claude-opus-5")).toBe("Opus 5");
    expect(resolve("other")).toBe("other");
  });

  it("folds maps, rows and names", () => {
    const resolve = createResolver({ b: "a" }, [], "off");
    expect(foldMap({ a: 1, b: 2, c: 3 }, resolve)).toEqual({ a: 3, c: 3 });
    const rows = foldRows(
      [
        { key: "b", tokens: 5, costUsd: 1, components: { cacheReadTokens: 1, outputTokens: 1, unclassifiedTokens: 0 } },
        { key: "c", tokens: 4, costUsd: 1, components: null },
        { key: "a", tokens: 2, costUsd: 1, components: { cacheReadTokens: 1, outputTokens: 0, unclassifiedTokens: 0 } },
        { key: "__unattributed", tokens: 9, costUsd: 0, unattributed: true, components: null },
      ],
      resolve,
    );
    expect(rows.map((r) => [r.key, r.tokens])).toEqual([
      ["__unattributed", 9],
      ["a", 7],
      ["c", 4],
    ]);
    expect(rows[1].components).toEqual({ cacheReadTokens: 2, outputTokens: 1, unclassifiedTokens: 0 });
    expect(foldNames(["b", "a", "c"], resolve)).toEqual(["a", "c"]);
  });
});
