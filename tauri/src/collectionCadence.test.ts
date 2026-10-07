import { describe, expect, it } from "vitest";
import { cadenceOf, cadencePatch } from "./collectionCadence";

describe("collection cadence selector", () => {
  it("shows the mode, or the interval for interval mode", () => {
    expect(cadenceOf({ collectionMode: "live", collectionIntervalMs: 900_000 })).toBe("live");
    expect(cadenceOf({ collectionMode: "smart", collectionIntervalMs: 900_000 })).toBe("smart");
    expect(cadenceOf({ collectionMode: "interval", collectionIntervalMs: 1_800_000 })).toBe("1800000");
    expect(cadenceOf({ collectionMode: "interval", collectionIntervalMs: 60_000 })).toBe("300000");
  });

  it("writes the mode, and the interval only for interval mode", () => {
    expect(cadencePatch("live")).toEqual({ collectionMode: "live" });
    expect(cadencePatch("smart")).toEqual({ collectionMode: "smart" });
    expect(cadencePatch("900000")).toEqual({ collectionMode: "interval", collectionIntervalMs: 900_000 });
  });

  it("round-trips every option", () => {
    for (const value of ["live", "smart", "300000", "900000", "1800000"] as const) {
      const patch = cadencePatch(value);
      const settings = {
        collectionMode: patch.collectionMode ?? "live",
        collectionIntervalMs: patch.collectionIntervalMs ?? 300_000,
      };
      expect(cadenceOf(settings)).toBe(value);
    }
  });
});
