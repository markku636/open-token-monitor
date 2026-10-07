import { afterEach, describe, expect, it } from "vitest";
import { rangeDeviceNote, rangeFooter } from "./Company";
import { setLangForTest } from "./i18n";

describe("company range texts", () => {
  afterEach(() => setLangForTest("zh-TW"));

  it("says when the hub has no per-device history", () => {
    expect(rangeFooter(null)).toBe("依各裝置上傳的每日歷史計算；這個 hub 不提供逐台裝置的範圍數字。");
    setLangForTest("en");
    expect(rangeFooter(null)).toBe("Computed from each PC's uploaded daily history; this hub doesn't provide per-PC numbers for ranges.");
  });

  it("counts the devices left out for lack of daily history", () => {
    const devices = [{ available: true }, { available: false }, { available: false }];
    expect(rangeFooter(devices)).toBe("依各裝置上傳的每日歷史計算；2 台沒有可用每日歷史的裝置未計入。");
    setLangForTest("en");
    expect(rangeFooter(devices)).toBe("Computed from each PC's uploaded daily history; 2 PCs without usable daily history are not counted.");
  });

  it("only explains the source when every device counts", () => {
    for (const devices of [[{ available: true }], []]) {
      setLangForTest("zh-TW");
      expect(rangeFooter(devices)).toBe("依各裝置上傳的每日歷史計算。");
      setLangForTest("en");
      expect(rangeFooter(devices)).toBe("Computed from each PC's uploaded daily history.");
    }
  });

  it("marks a device without daily history and nothing else", () => {
    expect(rangeDeviceNote({ available: false })).toBe("沒有可用的每日歷史");
    expect(rangeDeviceNote({ available: true })).toBeNull();
    setLangForTest("en");
    expect(rangeDeviceNote({ available: false })).toBe("No usable daily history");
  });
});
