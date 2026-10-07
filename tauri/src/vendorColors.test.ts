// 廠商色：品牌表、modelVendorFor / modelColor、displayColor 等（上游 usageCharts.js、dashboard.js、
// app.js、dock.js）。與上游逐值比對在 tests/compat/theme-compat.test.mjs。

import { describe, expect, it } from "vitest";
import { modelVendorFor } from "./modelVendor";
import { mergeVendorColors } from "./theme";
import {
  BRAND_COLORS,
  clientColor,
  colorWithAlpha,
  displayColor,
  FALLBACK_MODEL_COLORS,
  limitProviderColor,
  modelColor,
  OTHER_BUCKET_COLOR,
  readableColor,
} from "./vendorColors";

describe("vendor colours", () => {
  it("carries upstream's brand table", () => {
    expect(Object.keys(BRAND_COLORS)).toHaveLength(54);
    expect(BRAND_COLORS.kimi).toBe("#16191e");
    expect(BRAND_COLORS.claude).toBe("#cc7c5e");
    expect(BRAND_COLORS.codex).toBe("#49a3b0");
    expect(BRAND_COLORS.default).toBe("#6ab4f0");
    // 「其他」列不是廠商，不能與任何品牌色或備用色撞色。
    expect(Object.values(BRAND_COLORS)).not.toContain(OTHER_BUCKET_COLOR);
    expect(FALLBACK_MODEL_COLORS).not.toContain(OTHER_BUCKET_COLOR);
  });

  it("maps model ids to vendors and colours like upstream", () => {
    const cases: [string, string][] = [
      ["claude-opus-4-5", "#cc7c5e"],
      ["gpt-5.5", "#49a3b0"],
      ["gemini-3-pro", "#4285f4"],
      ["deepseek-v3", "#4d6bfe"],
      ["k3", "#16191e"],
      ["glm-4.6", "#000000"],
      ["big-pickle", "#000000"],
      ["o3-mini", "#49a3b0"],
      ["MiniMax-M2", "#f23f5d"],
      ["qwen3-coder", "#615ced"],
      ["__unattributed", "#5fbf8a"],
      ["some-unknown-model", "#f06a7b"],
    ];
    for (const [model, color] of cases) expect(modelColor(BRAND_COLORS, model), model).toBe(color);
    expect(modelVendorFor("cursor-auto")).toBe("cursor");
    expect(modelVendorFor("auto")).toBe("cursor");
    expect(modelVendorFor("k3")).toBe("kimi");
    expect(modelVendorFor("glm-4.6")).toBe("zai");
    expect(modelVendorFor("big-pickle")).toBe("opencode");
    expect(modelVendorFor("o3-mini")).toBe("codex");
    expect(modelVendorFor("")).toBeNull();
    expect(modelVendorFor(null)).toBeNull();
  });

  it("falls back to default for tools and maps Factory to Droid for limits", () => {
    expect(clientColor(BRAND_COLORS, "nope")).toBe("#6ab4f0");
    expect(clientColor(BRAND_COLORS, "__unattributed")).toBe("#6ab4f0");
    expect(limitProviderColor(BRAND_COLORS, "factory")).toBe(BRAND_COLORS.droid);
    expect(limitProviderColor(BRAND_COLORS, "claude")).toBe("#cc7c5e");
  });

  it("applies user overrides to tools and model vendors", () => {
    const colors = mergeVendorColors(BRAND_COLORS, { claude: "#010203", gemini: "#ABCDEF", bogus: "#ffffff" });
    expect(clientColor(colors, "claude")).toBe("#010203");
    expect(modelColor(colors, "claude-sonnet-4-5")).toBe("#010203");
    expect(modelColor(colors, "gemini-2.5-pro")).toBe("#abcdef");
    expect(colors.bogus).toBeUndefined();
  });

  it("lifts near-black colours on the dashboard only", () => {
    expect(displayColor("#000000")).toBe("rgb(127, 127, 127)");
    expect(displayColor("#16191e")).toBe("rgb(135, 137, 139)");
    expect(displayColor("#39594d")).toBe("#39594d");
    expect(displayColor("")).toBe("#6ab4f0");
    expect(displayColor("red")).toBe("red");
  });

  it("ports colorWithAlpha and readableColor", () => {
    expect(colorWithAlpha("#cc7c5e", 0.16)).toBe("rgba(204, 124, 94, 0.16)");
    expect(colorWithAlpha("nope", 0.5)).toBe("rgba(183, 234, 212, 0.5)");
    // 純黑在預設的石墨底上對比不足，改用文字色；亮色維持品牌色。
    expect(readableColor("#000000", "rgb(48 52 56)")).toBe("rgb(var(--c-fg))");
    expect(readableColor("#cc7c5e", "rgb(48 52 56)")).toBe("#cc7c5e");
    expect(readableColor("#000", "rgb(48, 52, 56)", "white")).toBe("white");
    expect(readableColor("var(--x)", "rgb(48 52 56)")).toBe("var(--x)");
  });
});
