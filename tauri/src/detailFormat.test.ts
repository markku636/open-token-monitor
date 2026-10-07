import { describe, expect, it } from "vitest";
import {
  barWidth,
  callsLabel,
  clientGradient,
  compactSessionTime,
  devicePlatformLabel,
  exchangeRows,
  turnSplit,
  detailPercentLabel,
  inputPercentages,
  isLive,
  sessionIdLabel,
  sessionModelLabel,
  tokenComponentBreakdown,
  visibleShares,
} from "./detailFormat";

describe("detailFormat", () => {
  it("splits tokens into cache hit, cache miss and output like upstream", () => {
    const parts = tokenComponentBreakdown(1000, { cacheReadTokens: 600, outputTokens: 100, unclassifiedTokens: 50 });
    expect(parts).toEqual({ cacheRead: 600, cacheMiss: 250, output: 100, unclassified: 50 });
    const pct = inputPercentages(parts);
    expect(Math.round(pct.hit)).toBe(71);
    expect(Math.round(pct.miss)).toBe(29);
    // 組成超過總量時逐項夾住，不會出現負的未命中。
    expect(tokenComponentBreakdown(100, { cacheReadTokens: 90, outputTokens: 50, unclassifiedTokens: 0 })).toEqual({
      cacheRead: 90,
      cacheMiss: 0,
      output: 10,
      unclassified: 0,
    });
    expect(inputPercentages({ cacheRead: 0, cacheMiss: 0, output: 5, unclassified: 0 })).toEqual({ hit: 0, miss: 0 });
  });

  it("labels detail percentages", () => {
    expect(detailPercentLabel(0)).toBe("0%");
    expect(detailPercentLabel(0.4)).toBe("<1%");
    expect(detailPercentLabel(49.6)).toBe("50%");
    expect(detailPercentLabel(130)).toBe("100%");
  });

  it("hides an empty unattributed row", () => {
    const rows = [
      { key: "a", tokens: 1, costUsd: 0 },
      { key: "__unattributed", tokens: 0, costUsd: 0.001, unattributed: true },
    ];
    expect(visibleShares(rows).map((r) => r.key)).toEqual(["a", "__unattributed"]);
    expect(visibleShares([{ key: "u", tokens: 0, costUsd: 0, unattributed: true }])).toEqual([]);
  });

  it("cleans session ids", () => {
    const uuid = "0199a1b2-c3d4-7e5f-8a9b-000000000001";
    expect(sessionIdLabel(`rollout-2026-09-24T10-00-00-${uuid}`)).toBe(uuid);
    expect(sessionIdLabel(`rollout-2026-09-24T10-00-00-${uuid}+rollout-2026-09-24T11-00-00-${uuid.replace("1", "2")}`)).toContain(" · ");
    expect(sessionIdLabel("2026-09-24T10:00:00Z")).toBe("");
    expect(sessionIdLabel("ses_abc")).toBe("ses_abc");
    expect(sessionIdLabel("")).toBe("");
  });

  it("formats session times, models and calls", () => {
    const now = new Date(2026, 8, 24, 15, 0);
    expect(compactSessionTime(new Date(2026, 8, 24, 9, 5).toISOString(), now)).toBe("09:05");
    expect(compactSessionTime(new Date(2026, 8, 3, 21, 30).toISOString(), now)).toBe("09/03 21:30");
    expect(compactSessionTime("nope", now)).toBe("");
    expect(sessionModelLabel([])).toBe("");
    expect(sessionModelLabel(["gpt-5.5"])).toBe("gpt-5.5");
    expect(sessionModelLabel(["a", "b"])).toBe("2 models");
    expect(callsLabel(0)).toBe("");
    expect(callsLabel(1)).toBe("1 call");
    expect(callsLabel(1234)).toBe("1,234 calls");
  });

  it("marks sessions active within ten minutes", () => {
    const now = Date.parse("2026-09-24T03:00:00Z");
    expect(isLive("2026-09-24T02:55:00Z", now)).toBe(true);
    expect(isLive("2026-09-24T02:49:00Z", now)).toBe(false);
    expect(isLive("", now)).toBe(false);
  });

  it("builds a client gradient for project bars", () => {
    const color = (k: string) => ({ a: "#111", b: "#222" })[k] ?? "";
    expect(clientGradient([], color, "#fff")).toBe("#fff");
    expect(clientGradient([{ key: "a", tokens: 5 }], color, "#fff")).toBe("#111");
    expect(clientGradient([{ key: "b", tokens: 25 }, { key: "a", tokens: 75 }], color, "#fff")).toBe(
      "linear-gradient(90deg, #111 0%, #111 73.50%, #222 76.50%, #222 100%)",
    );
  });

  it("models session detail rows like upstream", () => {
    const tk = (i: number, o: number, cr: number, cw: number, r = 0) => ({ input: i, output: o, cacheRead: cr, cacheWrite: cw, reasoning: r, total: i + o + cr + cw });
    expect(turnSplit(tk(1, 2, 3, 4), String)).toBe("in 1 · out 2 · cache 7");
    expect(turnSplit(tk(1, 2, 3, 4, 5), String)).toBe("in 1 · out 2 · cache 7 · reason 5");
    const now = new Date(2026, 8, 24, 15, 0);
    const exchanges = [
      { promptPreview: "", startedAt: new Date(2026, 8, 24, 9, 0).toISOString(), turnCount: 1, tools: [], tokens: { total: 50 }, costEstimate: 0.5, turns: [{ tokens: tk(50, 0, 0, 0), tools: [], costEstimate: 0.5 }] },
      { promptPreview: "fix", startedAt: new Date(2026, 8, 24, 10, 5).toISOString(), turnCount: 2, tools: ["Bash"], tokens: { total: 20 }, costEstimate: 0.2, turns: [{ tokens: tk(10, 0, 0, 0), tools: ["Bash", "Bash"], costEstimate: 0.1 }, { tokens: tk(10, 0, 0, 0), tools: [], costEstimate: 0.1 }] },
    ];
    const byTime = exchangeRows(exchanges, "time", String, now);
    expect(byTime.map((r) => r.title)).toEqual(["fix", "(session start)"]);
    expect(byTime[0].subtitle).toBe("10:05 · 2 turns · 1 tool");
    expect(byTime[0].turns.map((x) => [x.label, x.tools])).toEqual([["Reply #1", "Bash"], ["Reply #2", ""]]);
    expect(byTime[1].subtitle).toBe("09:00 · 1 turn");
    expect(exchangeRows(exchanges, "tokens", String, now)[0].title).toBe("(session start)");
  });

  it("labels device platforms", () => {
    expect(devicePlatformLabel("win32-x64", "Windows 11", "10.0.26200")).toBe("Windows 11 10.0.26200");
    expect(devicePlatformLabel("darwin-arm64", null, "15.1")).toBe("macOS 15.1");
    expect(devicePlatformLabel("linux", "", null)).toBe("Linux");
  });

  it("sizes bars against the largest row", () => {
    expect(barWidth(0, 10)).toBe(0);
    expect(barWidth(1, 1000)).toBe(2);
    expect(barWidth(5, 10)).toBe(50);
  });
});
