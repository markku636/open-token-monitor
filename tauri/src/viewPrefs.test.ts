import { describe, expect, it } from "vitest";
import {
  availableViewIds,
  disabledViewIds,
  effectiveViewDisplayOrderValue,
  homeModuleIds,
  moveHomeModuleOrder,
  moveLimitProvider,
  moveViewDisplayOrder,
  nextView,
  normalizeHiddenHomeModules,
  normalizeHiddenViews,
  normalizeHomeModuleOrder,
  normalizeLimitProviderSelection,
  normalizeViewDisplayOrder,
  parseViewId,
  preferredViewId,
  reorderHomeModuleOrder,
  reorderViewDisplayOrder,
  VIEW_IDS,
  visibleViewCount,
  visibleViewOrder,
} from "./viewPrefs";

describe("view order and visibility", () => {
  it("shows every available view except the hidden status view by default", () => {
    expect(visibleViewOrder({ ids: VIEW_IDS, orderValue: "", hiddenValue: "status", availableIds: [...VIEW_IDS] })).toEqual([
      "home",
      "tool",
      "device",
      "limits",
      "trends",
    ]);
  });

  it("keeps a hidden view that the tray opened", () => {
    expect(visibleViewOrder({ ids: VIEW_IDS, hiddenValue: "status", includeIds: ["status"] })).toContain("status");
  });

  it("falls back to the first available view when nothing else is visible", () => {
    expect(visibleViewOrder({ ids: VIEW_IDS, orderValue: "trends,limits", hiddenValue: "home,tool,status,device,limits", availableIds: ["home", "limits"] })).toEqual(["limits"]);
  });

  it("prefers the current view, then the first visible one, then tool", () => {
    const input = { ids: VIEW_IDS, hiddenValue: "status", availableIds: [...VIEW_IDS] };
    expect(preferredViewId({ ...input, currentId: "limits" })).toBe("limits");
    expect(preferredViewId({ ...input, currentId: "limits", preferFirst: true })).toBe("home");
    expect(preferredViewId({ ...input, currentId: "status" })).toBe("home");
    expect(preferredViewId({ ...input, currentId: "bogus" })).toBe("home");
    expect(preferredViewId({ ids: VIEW_IDS, availableIds: [] })).toBe("tool");
  });

  it("puts Home first when a custom order leaves it out", () => {
    expect(effectiveViewDisplayOrderValue("trends,tool")).toBe("home,trends,tool,status,device,limits");
    expect(effectiveViewDisplayOrderValue("")).toBe("");
    expect(effectiveViewDisplayOrderValue("tool,home")).toBe("tool,home");
  });

  it("normalizes order and hidden values like upstream", () => {
    expect(normalizeViewDisplayOrder(" Trends ,HOME,trends,model", VIEW_IDS)).toEqual(["trends", "home", "tool", "status", "device", "limits"]);
    expect(normalizeHiddenViews("status,STATUS,x", VIEW_IDS)).toBe("status");
    expect(normalizeHiddenViews(VIEW_IDS.join(","), VIEW_IDS)).toBe("");
    expect(normalizeHiddenViews(["trends", "status"], VIEW_IDS)).toBe("trends,status");
  });

  it("drops trends without history and limits without providers", () => {
    expect(availableViewIds({ historyEnabled: false })).not.toContain("trends");
    expect(availableViewIds({ limitsEnabled: false, limitProviders: ["claude"] })).not.toContain("limits");
    expect(availableViewIds({ limitsEnabled: true, limitProviders: [] })).not.toContain("limits");
    expect(availableViewIds(null)).toEqual([...VIEW_IDS]);
    expect(disabledViewIds({ historyEnabled: false })).toEqual(["trends"]);
  });

  it("does not count disabled views as visible", () => {
    expect(visibleViewCount({ ids: VIEW_IDS, hiddenValue: "status", disabledIds: ["trends"] })).toBe(4);
  });

  it("cycles to the next view and wraps around", () => {
    const order = ["home", "tool", "device"];
    expect(nextView(order, "home")).toBe("tool");
    expect(nextView(order, "device")).toBe("home");
    expect(nextView(order, "status")).toBe("home");
    expect(nextView([], "home")).toBe("home");
  });

  it("maps legacy tab ids to views", () => {
    expect(parseViewId("local")).toBe("tool");
    expect(parseViewId("company")).toBe("device");
    expect(parseViewId("limits")).toBe("limits");
    expect(parseViewId(" STATUS ")).toBe("status");
    expect(parseViewId("bogus")).toBeNull();
    expect(parseViewId(null)).toBeNull();
  });

  it("moves and reorders within bounds", () => {
    expect(moveViewDisplayOrder("", VIEW_IDS, "home", "up")).toBe("home,tool,status,device,limits,trends");
    expect(moveViewDisplayOrder("", VIEW_IDS, "tool", "up")).toBe("tool,home,status,device,limits,trends");
    expect(reorderViewDisplayOrder("", VIEW_IDS, "home", Number.MAX_SAFE_INTEGER)).toBe("tool,status,device,limits,trends,home");
    expect(reorderViewDisplayOrder("", VIEW_IDS, "trends", -3)).toBe("trends,home,tool,status,device,limits");
  });
});

describe("home modules", () => {
  it("uses the default order for an empty value and always returns every module", () => {
    expect(normalizeHomeModuleOrder("")).toEqual(["limits", "tool", "device", "model", "trends"]);
    expect(normalizeHomeModuleOrder("model,limits")).toEqual(["model", "limits", "tool", "device", "trends"]);
  });

  it("resets when every module is hidden", () => {
    expect(normalizeHiddenHomeModules("limits,tool,device,model,trends")).toBe("");
    expect(normalizeHiddenHomeModules("device,tool,device")).toBe("device,tool");
  });

  it("lists the visible modules in order", () => {
    expect(homeModuleIds({ homeModuleOrder: "limits,tool,device,model,trends", hiddenHomeModules: "tool,device" })).toEqual(["limits", "model", "trends"]);
    expect(homeModuleIds(null)).toEqual(["limits", "model", "trends"]);
  });

  it("keeps boundary moves as no-ops and clamps reorders", () => {
    expect(moveHomeModuleOrder("", "limits", "up")).toBe("limits,tool,device,model,trends");
    expect(moveHomeModuleOrder("", "trends", "down")).toBe("limits,tool,device,model,trends");
    expect(reorderHomeModuleOrder("", "limits", 99)).toBe("tool,device,model,trends,limits");
  });
});

describe("limit provider order", () => {
  const catalog = ["claude", "codex", "cursor", "copilot"];
  it("moves providers and keeps the selection deduped without appending", () => {
    expect(moveLimitProvider("", catalog, "codex", "up")).toBe("codex,claude,cursor,copilot");
    expect(normalizeLimitProviderSelection("Codex, kimi,codex", catalog)).toEqual(["codex"]);
  });
});
