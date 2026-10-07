import { describe, expect, it } from "vitest";
import { brandIconUrl } from "./brandIconUrl";
import {
  CLIENTS_WITH_ICON,
  iconKindFor,
  LIMIT_MARK_IDS,
  MASK_FILE,
  maskFileFor,
  osIconFor,
  serviceStatusIconId,
  type BreakdownKind,
} from "./brandIcons";

const icon = (id: string) => ({ kind: "icon", id });
const dot = { kind: "dot" };

describe("brand icons", () => {
  it("draws dots everywhere when tool icons are off", () => {
    const kinds: BreakdownKind[] = ["tool", "model", "session", "project", "device", "limits"];
    for (const kind of kinds) {
      expect(iconKindFor({ key: "claude", client: "claude", platform: "win32-x64" }, kind, false)).toEqual(dot);
    }
  });

  it("maps device platforms to OS icons like upstream osIconFor", () => {
    expect(osIconFor("win32-x64")).toBe("windows");
    expect(osIconFor("WIN32-arm64")).toBe("windows");
    expect(osIconFor("darwin-arm64")).toBe("apple");
    for (const p of ["linux-x64", "freebsd-x64", "openbsd"]) expect(osIconFor(p)).toBe("linux");
    expect(osIconFor(null)).toBeNull();
    expect(iconKindFor({ platform: "win32-x64" }, "device", true)).toEqual(icon("os-windows"));
    expect(iconKindFor({ platform: "darwin-arm64" }, "device", true)).toEqual(icon("os-apple"));
    expect(iconKindFor({ platform: "" }, "device", true)).toEqual(dot);
    expect(iconKindFor({ platform: "aix-ppc64" }, "device", true)).toEqual(dot);
  });

  it("marks models by vendor and falls back to the Token Monitor mark", () => {
    // 預期值由上游 usageCharts.js 的 modelVendorFor 實際跑出來。
    const cases: [string, string][] = [
      ["claude-sonnet-4-5", "claude"],
      ["claude-opus-4-1-20250805", "claude"],
      ["gpt-5-codex", "codex"],
      ["gpt-5.1", "codex"],
      ["o3-mini", "codex"],
      ["o4-mini", "codex"],
      ["auto", "cursor"],
      ["cursor-auto", "cursor"],
      ["gemini-2.5-pro", "gemini"],
      ["gemma-3-27b", "gemini"],
      ["grok-code-fast-1", "xai"],
      ["deepseek-v3.2", "deepseek"],
      ["nemotron-nano", "nvidia"],
      ["llama-3.3-70b", "meta"],
      ["codestral-latest", "mistral"],
      ["qwq-32b", "qwen"],
      ["qwen3-coder", "qwen"],
      ["kimi-k2", "kimi"],
      ["k3-256k", "kimi"],
      ["glm-4.6", "zai"],
      ["command-r-plus", "cohere"],
      ["mimo-v2-flash", "xiaomi"],
      ["abab6.5s", "minimax"],
      ["seed-1.6", "doubao"],
      ["step-3", "stepfun"],
      ["hy3-preview", "hunyuan"],
      ["hunyuan-t1", "hunyuan"],
      ["swe-1.5", "devin"],
      ["big-pickle", "opencode"],
    ];
    for (const [model, vendor] of cases) expect(iconKindFor({ key: model }, "model", true), model).toEqual(icon(vendor));
    for (const model of ["__unattributed", "some-new-model", ""]) {
      expect(iconKindFor({ key: model }, "model", true), model).toEqual(icon("token-monitor"));
    }
  });

  it("marks sessions, projects, tools and limits like upstream iconKindFor", () => {
    expect(iconKindFor({ client: "codex" }, "session", true)).toEqual(icon("codex"));
    expect(iconKindFor({ client: "nope" }, "session", true)).toEqual(dot);
    expect(iconKindFor({}, "project", true)).toEqual(icon("project"));
    expect(iconKindFor({ key: "__unattributed" }, "tool", true)).toEqual(dot);
    expect(iconKindFor({ key: "claude" }, "tool", true)).toEqual(icon("claude"));
    // factory 只在額度的集合裡；hermes 在 clientsWithIcon 所以額度也有。
    expect(iconKindFor({ key: "factory" }, "tool", true)).toEqual(dot);
    for (const id of ["alibaba", "factory", "newapi", "hermes"]) expect(iconKindFor({ key: id }, "limits", true)).toEqual(icon(id));
  });

  it("resolves the upstream mask files, including the grok/xai swap", () => {
    expect(maskFileFor("grok")).toBe("xai.svg");
    expect(maskFileFor("grok", "limit")).toBe("grok.svg");
    expect(maskFileFor("xai")).toBe("grok.svg");
    expect(maskFileFor("xai", "limit")).toBe("grok.svg");
    expect(maskFileFor("factory")).toBe("droid.svg");
    expect(maskFileFor("mimo")).toBe("xiaomi.svg");
    expect(maskFileFor("xiaomi")).toBe("xiaomi.svg");
    expect(maskFileFor("project")).toBe("project-row.svg");
    expect(maskFileFor("nope")).toBeNull();
    // 物件原型上的鍵不是 id。
    expect(maskFileFor("constructor")).toBeNull();
    expect(brandIconUrl("constructor")).toBeNull();
    // 小檔案 Vite 會內嵌成 data URI，所以比網址本身：清單列與額度卡片的 Grok 是不同的圖。
    expect(brandIconUrl("grok")).not.toBe(brandIconUrl("grok", "limit"));
    expect(brandIconUrl("grok", "limit")).toBe(brandIconUrl("xai"));
  });

  it("has an image for every id it can draw, so none renders as a solid square", () => {
    const ids = new Set([...CLIENTS_WITH_ICON, ...LIMIT_MARK_IDS, ...Object.keys(MASK_FILE), "os-apple", "os-linux", "os-windows", "token-monitor", "project"]);
    const missing = [...ids].filter((id) => !brandIconUrl(id) || !brandIconUrl(id, "limit"));
    expect(missing).toEqual([]);
  });

  it("uses the Codex icon for the OpenAI status page", () => {
    expect(serviceStatusIconId("openai")).toBe("codex");
    expect(serviceStatusIconId("claude")).toBe("claude");
    for (const id of ["claude", "openai", "cursor", "deepseek"]) expect(brandIconUrl(serviceStatusIconId(id))).not.toBeNull();
  });
});
