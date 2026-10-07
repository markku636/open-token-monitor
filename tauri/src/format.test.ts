import { describe, expect, it } from "vitest";
import { fmtAgo, fmtInterval, fmtPercent, fmtRate, fmtTokens, fmtUntil, fmtUsd, setMoney, topShares, uncachedInput } from "./format";

describe("format", () => {
  it("formats tokens compactly", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1234)).toBe("1.2K");
    expect(fmtTokens(1_000_000)).toBe("1M");
    expect(fmtTokens(38_766_423)).toBe("38.77M");
    expect(fmtTokens(1_016_976_578)).toBe("1.02B");
    expect(fmtTokens(Number.NaN)).toBe("0");
    // 四捨五入到 1000 時進位到下一個單位（上游 compactTokens 的 promotionBoundary）。
    expect(fmtTokens(999_999)).toBe("1M");
    expect(fmtTokens(999_995_000)).toBe("1B");
    expect(fmtTokens(999.6)).toBe("1K");
    expect(fmtTokens(999_949)).toBe("999.9K");
  });

  it("formats money", () => {
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(0.004)).toBe("<$0.01");
    expect(fmtUsd(119.893793)).toBe("$119.89");
    expect(fmtUsd(12_345.6)).toBe("$12,346");
  });

  it("converts money to the chosen currency", () => {
    setMoney({ code: "TWD", symbol: "NT$", rate: 32 });
    expect(fmtUsd(1)).toBe("NT$32.00");
    expect(fmtUsd(500)).toBe("NT$16,000");
    expect(fmtUsd(0.0001)).toBe("<NT$0.01");
    setMoney({ code: "X", symbol: "?", rate: 0 });
    expect(fmtUsd(1)).toBe("$1.00");
    setMoney(null);
    expect(fmtRate(31.5)).toBe("31.5");
    expect(fmtRate(0.14)).toBe("0.14");
    expect(fmtRate(0.123456)).toBe("0.1235");
    expect(fmtRate(32)).toBe("32");
  });

  it("formats percentages and intervals", () => {
    expect(fmtPercent(1, 0)).toBe("0%");
    expect(fmtPercent(1, 1000)).toBe("<1%");
    expect(fmtPercent(1, 3)).toBe("33%");
    expect(fmtInterval(0)).toBe("即時");
    expect(fmtInterval(600_000)).toBe("10 分鐘");
  });

  it("formats relative time", () => {
    const now = Date.parse("2026-09-23T10:00:00Z");
    expect(fmtAgo("2026-09-23T09:59:50Z", now)).toBe("剛剛");
    expect(fmtAgo("2026-09-23T09:57:00Z", now)).toBe("3 分鐘前");
    expect(fmtAgo("2026-09-23T07:00:00Z", now)).toBe("3 小時前");
    expect(fmtAgo(null, now)).toBe("—");
  });

  it("formats time until a reset", () => {
    const now = Date.parse("2026-09-23T10:00:00Z");
    expect(fmtUntil("2026-09-23T10:44:10Z", now)).toBe("45 分鐘後");
    expect(fmtUntil("2026-09-23T13:10:00Z", now)).toBe("3 小時後");
    expect(fmtUntil("2026-09-26T10:00:00Z", now)).toBe("3 天後");
    expect(fmtUntil("2026-09-23T09:00:00Z", now)).toBe("");
    expect(fmtUntil(null, now)).toBe("");
  });

  it("derives uncached input", () => {
    expect(uncachedInput({ totalTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 20, outputTokens: 10, unclassifiedTokens: 5 })).toBe(15);
    expect(uncachedInput({ totalTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, outputTokens: 0, unclassifiedTokens: 0 })).toBe(0);
  });

  it("groups the long tail into other", () => {
    const tokens = { a: 50, b: 40, c: 30, d: 20, e: 10, f: 5, g: 1 };
    const shares = topShares(tokens, { a: 1 }, 4);
    expect(shares.map((s) => s.key)).toEqual(["a", "b", "c", "__other"]);
    expect(shares[3].tokens).toBe(36);
    expect(topShares({ x: 0 }, {})).toEqual([]);
  });
});
