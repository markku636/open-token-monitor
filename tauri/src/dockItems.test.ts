import { describe, expect, it } from "vitest";
import type { LimitProvider, LimitWindow, LimitsView } from "./api";
import { dockCells } from "./dockItems";

function w(kind: LimitWindow["kind"], label: string, usedPercent: number | null, extra: Partial<LimitWindow> = {}): LimitWindow {
  return {
    kind,
    label,
    used: null,
    limit: null,
    remaining: null,
    usedPercent,
    remainingPercent: usedPercent === null ? null : 100 - usedPercent,
    resetsAt: null,
    windowMinutes: null,
    currency: null,
    showMeter: true,
    ...extra,
  };
}

function p(provider: string, status: LimitProvider["status"], windows: LimitWindow[]): LimitProvider {
  return { provider, accountKey: "", accountLabel: "", accountEmail: "", status, source: "oauth", updatedAt: "", windows };
}

const view = (providers: LimitProvider[]): LimitsView => ({ updatedAt: null, refreshMs: 300_000, nextAt: "", providers });

describe("edge dock cells", () => {
  it("takes the 5-hour and the all-models weekly window of each signed-in tool", () => {
    const cells = dockCells(
      view([
        p("claude", "ok", [w("session", "", 34), w("weekly", "", 76), w("weekly", "Fable", 92)]),
        p("codex", "notConfigured", []),
      ]),
    );
    expect(cells.map((c) => [c.key, c.used])).toEqual([
      ["claude:session", 34],
      ["claude:weekly", 76],
    ]);
  });

  it("skips credits and Codex's additional windows", () => {
    const cells = dockCells(
      view([
        p("codex", "ok", [
          w("session", "", 10),
          w("weekly", "GPT-5.3-Codex-Spark", 99, { additional: true }),
          w("billing", "Credits", null, { metric: "credits" }),
        ]),
      ]),
    );
    expect(cells.map((c) => c.key)).toEqual(["codex:session"]);
  });

  it("is empty without limits", () => {
    expect(dockCells(null)).toEqual([]);
  });
});
