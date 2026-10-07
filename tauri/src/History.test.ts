import { describe, expect, it } from "vitest";
import { barHeights } from "./History";

describe("history strip", () => {
  it("scales bars to the busiest day and keeps small days visible", () => {
    expect(barHeights([{ tokens: 0 }, { tokens: 50 }, { tokens: 100 }, { tokens: 1 }])).toEqual([0, 0.5, 1, 0.06]);
  });

  it("is flat when nothing was used", () => {
    expect(barHeights([{ tokens: 0 }, { tokens: 0 }])).toEqual([0, 0]);
    expect(barHeights([])).toEqual([]);
  });
});
