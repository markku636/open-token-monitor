// 移植上游 tests/electron/themePresets.test.js 裡不讀 CSS 檔的案例，加上 Tauri 對應（themeCssVars、
// resolveLight、預設配色與 styles.css 一致）的案例。與上游逐值比對在 tests/compat/theme-compat.test.mjs。

import { describe, expect, it } from "vitest";
import css from "./styles.css?raw";
import {
  basePalette,
  DEFAULT_THEME,
  decodeThemeCode,
  effectiveThemeColors,
  encodeThemeCode,
  hexToChannels,
  hexToRgbTriplet,
  INTERFACE_COLOR_KEYS,
  isLightHex,
  isValidHex,
  LIGHT_THEME,
  matchingThemePresetId,
  mergeThemeColors,
  mergeVendorColors,
  normalizeHex,
  normalizeOverrides,
  orderedVendorIds,
  presetOverrides,
  resolveLight,
  THEME_CODE_VERSION,
  THEME_CSS_VARS,
  THEME_PRESETS,
  themeCssVars,
  VENDOR_LABELS,
  vendorLabel,
} from "./theme";
import { BRAND_COLORS } from "./vendorColors";

describe("theme presets (upstream themePresets.js)", () => {
  it("is the four always-visible colours, each mapped to a CSS variable", () => {
    expect(INTERFACE_COLOR_KEYS).toEqual(["accent", "bg", "text", "muted"]);
    for (const dead of ["success", "blue", "orange", "purple", "yellow", "red"]) {
      expect(INTERFACE_COLOR_KEYS).not.toContain(dead);
    }
    for (const key of INTERFACE_COLOR_KEYS) {
      expect(THEME_CSS_VARS[key]).toMatch(/^--c-/);
      expect(isValidHex(DEFAULT_THEME[key])).toBe(true);
    }
    expect(hexToRgbTriplet(DEFAULT_THEME.bg)).toBe("48, 52, 56");
  });

  it("keeps the dark :root and :root.light tokens equal to Default and Porcelain", () => {
    // 「預設」存 {}：深色 :root 必須就是 DEFAULT_THEME，它的 TM1 代碼才與畫面相符；淺色 = 瓷白。
    const block = (selector: string) => new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    const token = (body: string, name: string) => new RegExp(`${name}:\\s*([\\d ]+);`).exec(body)?.[1]?.trim();
    const porcelain = THEME_PRESETS.find((p) => p.id === "porcelain")!.colors;
    expect(LIGHT_THEME).toEqual(porcelain);
    for (const key of INTERFACE_COLOR_KEYS) {
      expect(token(block(":root"), THEME_CSS_VARS[key]), key).toBe(hexToChannels(DEFAULT_THEME[key]));
      expect(token(block(":root.light"), THEME_CSS_VARS[key]), key).toBe(hexToChannels(porcelain[key]));
    }
  });

  it("hexToRgbTriplet converts hex to a CSS rgb triplet", () => {
    expect(hexToRgbTriplet("#000000")).toBe("0, 0, 0");
    expect(hexToRgbTriplet("#ffffff")).toBe("255, 255, 255");
    expect(hexToRgbTriplet("303438")).toBe("48, 52, 56");
    expect(hexToChannels("#303438")).toBe("48 52 56");
  });

  it("isLightHex detects pale backgrounds", () => {
    expect(isLightHex("#f6f7f9")).toBe(true);
    expect(isLightHex("#ffffff")).toBe(true);
    expect(isLightHex("#303438")).toBe(false);
    expect(isLightHex("#0b0c0e")).toBe(false);
    expect(isLightHex("not-a-hex")).toBe(false);
  });

  it("every preset is a full palette of valid hex; default comes first", () => {
    for (const preset of THEME_PRESETS) {
      expect(Object.keys(preset.colors).sort()).toEqual([...INTERFACE_COLOR_KEYS].sort());
      for (const key of INTERFACE_COLOR_KEYS) expect(isValidHex(preset.colors[key])).toBe(true);
    }
    expect(THEME_PRESETS[0].id).toBe("default");
    expect(THEME_PRESETS[0].colors).toEqual(DEFAULT_THEME);
  });

  it("isValidHex / normalizeHex", () => {
    expect(isValidHex("#aabbcc")).toBe(true);
    expect(isValidHex("#ABC")).toBe(false);
    expect(isValidHex("aabbcc")).toBe(false);
    expect(isValidHex("#zzzzzz")).toBe(false);
    expect(isValidHex(123)).toBe(false);
    expect(normalizeHex("  #AABBCC ")).toBe("#aabbcc");
    expect(normalizeHex("nope")).toBeNull();
  });

  it("normalizeOverrides drops invalid values and disallowed keys", () => {
    expect(normalizeOverrides({ accent: "#AABBCC", text: "bad", bogus: "#ffffff" }, INTERFACE_COLOR_KEYS)).toEqual({ accent: "#aabbcc" });
    expect(normalizeOverrides(null, INTERFACE_COLOR_KEYS)).toEqual({});
    expect(normalizeOverrides("#ffffff")).toEqual({});
    expect(normalizeOverrides({ anything: "#FFFFFF" })).toEqual({ anything: "#ffffff" });
  });

  it("mergeThemeColors layers valid overrides on defaults", () => {
    const merged = mergeThemeColors({ accent: "#111111", text: "invalid" });
    expect(merged.accent).toBe("#111111");
    expect(merged.text).toBe(DEFAULT_THEME.text);
    expect(merged.muted).toBe(DEFAULT_THEME.muted);
  });

  it("TM1 theme codes round-trip the four interface colours in a stable order", () => {
    expect(THEME_CODE_VERSION).toBe("TM1");
    const code = encodeThemeCode({ accent: "#112233", bg: "#445566", text: "#AABBCC", muted: "#778899" });
    expect(code).toBe("TM1-112233-445566-AABBCC-778899");
    expect(decodeThemeCode(code)).toEqual({
      ok: true,
      code,
      colors: { accent: "#112233", bg: "#445566", text: "#aabbcc", muted: "#778899" },
    });
  });

  it("encodes each preset as upstream documents", () => {
    expect(encodeThemeCode({})).toBe("TM1-B7EAD4-303438-EEF5FB-A3ADBB");
    expect(encodeThemeCode(presetOverrides("obsidian"))).toBe("TM1-E6E8EC-0B0C0E-ECEEF2-8F949C");
    expect(encodeThemeCode(presetOverrides("porcelain"))).toBe("TM1-2563EB-F6F7F9-1C1F26-5B626D");
  });

  it("TM1 theme codes normalize input and reject malformed or future versions", () => {
    const ok = decodeThemeCode("  tm1-b7ead4-303438-eef5fb-a3adbb  ");
    expect(ok).toEqual({ ok: true, code: "TM1-B7EAD4-303438-EEF5FB-A3ADBB", colors: { ...DEFAULT_THEME } });
    for (const future of ["TM2-B7EAD4-303438-EEF5FB-A3ADBB", "TM10-B7EAD4-303438-EEF5FB-A3ADBB", "TM01-B7EAD4-303438-EEF5FB-A3ADBB", "TM2"]) {
      expect(decodeThemeCode(future), future).toEqual({ ok: false, reason: "unsupportedVersion" });
    }
    for (const bad of ["TM1", "TM1-not-a-theme", "", "TM-1", "TM1-B7EAD4-303438-EEF5FB", "TM1-B7EAD4-303438-EEF5FB-A3ADBB-000000", null, 123, {}]) {
      expect(decodeThemeCode(bad), String(bad)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("mergeVendorColors overrides brand defaults, ignoring junk", () => {
    const brand = { claude: "#cc7c5e", codex: "#49a3b0", default: "#6ab4f0" };
    expect(mergeVendorColors(brand, {})).toEqual(brand);
    expect(mergeVendorColors(brand, { claude: "#000000", unknown: "#fff000", codex: "bad" })).toEqual({
      claude: "#000000",
      codex: "#49a3b0",
      default: "#6ab4f0",
    });
    expect(mergeVendorColors(BRAND_COLORS, undefined)).toEqual({ ...BRAND_COLORS });
  });

  it("orderedVendorIds covers every brand key once, tracked first, default last", () => {
    const ordered = orderedVendorIds(BRAND_COLORS);
    expect(ordered).toHaveLength(54);
    expect([...ordered].sort()).toEqual(Object.keys(BRAND_COLORS).sort());
    expect(new Set(ordered).size).toBe(ordered.length);
    expect(ordered[0]).toBe("claude");
    expect(ordered[ordered.length - 1]).toBe("default");
    expect(orderedVendorIds({ zzz: "#000000", codex: "#111111" })).toEqual(["codex", "zzz"]);
  });

  it("every non-default brand vendor has a display label", () => {
    for (const id of Object.keys(BRAND_COLORS)) {
      if (id !== "default") expect(VENDOR_LABELS[id], id).toBeTruthy();
    }
    expect(vendorLabel("claude")).toBe("Claude Code");
    expect(vendorLabel("somethingnew")).toBe("Somethingnew");
    expect(vendorLabel("")).toBe("");
  });
});

describe("theme presets (upstream app.js helpers)", () => {
  it("matches the resolved palette against the presets", () => {
    expect(matchingThemePresetId({})).toBe("default");
    const decoded = decodeThemeCode("TM1-B7EAD4-303438-EEF5FB-A3ADBB");
    expect(decoded.ok && matchingThemePresetId(decoded.colors)).toBe("default");
    expect(matchingThemePresetId(presetOverrides("obsidian"))).toBe("obsidian");
    expect(matchingThemePresetId(presetOverrides("porcelain"))).toBe("porcelain");
    expect(matchingThemePresetId({ accent: "#123456" })).toBeNull();
  });

  it("stores only the keys a preset changes from the default", () => {
    expect(presetOverrides("default")).toEqual({});
    expect(Object.keys(presetOverrides("porcelain"))).toEqual(["accent", "bg", "text", "muted"]);
    expect(presetOverrides("obsidian")).toEqual(THEME_PRESETS[1].colors);
  });

  it("uses the light base palette in light colour mode", () => {
    // 淺色模式沒有覆寫時畫面是瓷白：晶片要亮「瓷白」，「預設」要存整組才會變回深色。
    expect(matchingThemePresetId({}, true)).toBe("porcelain");
    expect(matchingThemePresetId({ accent: "#123456" }, true)).toBeNull();
    expect(presetOverrides("porcelain", true)).toEqual({});
    expect(presetOverrides("default", true)).toEqual(DEFAULT_THEME);
    expect(presetOverrides("obsidian", true)).toEqual(THEME_PRESETS[1].colors);
  });
});

describe("palette on screen (Tauri colour mode)", () => {
  const MODES: [string, boolean][] = [
    ["dark", false],
    ["light", false],
    ["system", true],
    ["system", false],
  ];

  it("falls back to the base palette of the resolved mode", () => {
    expect(basePalette(false)).toEqual(DEFAULT_THEME);
    expect(basePalette(true)).toEqual(LIGHT_THEME);
    expect(effectiveThemeColors({}, false)).toEqual(DEFAULT_THEME);
    expect(effectiveThemeColors({}, true)).toEqual(LIGHT_THEME);
    expect(effectiveThemeColors({ accent: "#112233", text: "bad" }, true)).toEqual({ ...LIGHT_THEME, accent: "#112233" });
    // 淺色模式、沒有自訂：複製出去的是瓷白的代碼，不是深色的預設。
    expect(encodeThemeCode(effectiveThemeColors({}, true))).toBe("TM1-2563EB-F6F7F9-1C1F26-5B626D");
  });

  it("every preset chip renders exactly its palette in every colour mode", () => {
    for (const [theme, prefersLight] of MODES) {
      const modeLight = resolveLight(theme, {}, prefersLight);
      for (const preset of THEME_PRESETS) {
        const stored = presetOverrides(preset.id, modeLight);
        const light = resolveLight(theme, stored, prefersLight);
        const label = JSON.stringify([theme, prefersLight, preset.id]);
        expect(effectiveThemeColors(stored, light), label).toEqual(preset.colors);
        expect(matchingThemePresetId(stored, light), label).toBe(preset.id);
      }
    }
  });

  it("applying the code shown for the screen keeps the screen unchanged", () => {
    const overrideSets = [{}, { accent: "#112233" }, { bg: "#ffffff" }, { bg: "#101010", muted: "#445566" }, presetOverrides("obsidian")];
    for (const [theme, prefersLight] of MODES) {
      for (const colors of overrideSets) {
        const shown = effectiveThemeColors(colors, resolveLight(theme, colors, prefersLight));
        const decoded = decodeThemeCode(encodeThemeCode(shown));
        if (!decoded.ok) throw new Error("round trip failed");
        const after = effectiveThemeColors(decoded.colors, resolveLight(theme, decoded.colors, prefersLight));
        expect(after, JSON.stringify([theme, prefersLight, colors])).toEqual(shown);
      }
    }
  });
});

describe("Tauri CSS mapping", () => {
  it("sets only overridden tokens as R G B channels", () => {
    expect(themeCssVars({})).toEqual({
      vars: { "--c-accent": null, "--c-app": null, "--c-fg": null, "--c-muted": null },
      light: null,
    });
    const light = themeCssVars({ bg: "#f6f7f9" });
    expect(light.vars["--c-app"]).toBe("246 247 249");
    expect(light.light).toBe(true);
    expect(themeCssVars({ bg: "#0b0c0e" }).light).toBe(false);
    expect(themeCssVars({ accent: "#112233" }).vars["--c-accent"]).toBe("17 34 51");
    expect(themeCssVars({ accent: "red", bg: "#fff" })).toEqual(themeCssVars({}));
  });

  it("resolves light from a background override first, then the colour mode", () => {
    const cases: [string | undefined, Record<string, string>, boolean, boolean][] = [
      ["system", {}, true, true],
      ["system", {}, false, false],
      ["light", {}, false, true],
      ["dark", {}, true, false],
      [undefined, {}, true, true],
      // 背景覆寫一律優先：深色模式 + 瓷白仍是淺色，淺色模式 + 黑曜仍是深色。
      ["dark", { bg: "#f6f7f9" }, false, true],
      ["light", { bg: "#0b0c0e" }, true, false],
      ["system", { bg: "#0b0c0e" }, true, false],
      // 只覆寫強調色時仍看色彩模式。
      ["light", { accent: "#112233" }, false, true],
    ];
    for (const [theme, colors, prefersLight, expected] of cases) {
      expect(resolveLight(theme, colors, prefersLight), JSON.stringify([theme, colors, prefersLight])).toBe(expected);
    }
  });
});
