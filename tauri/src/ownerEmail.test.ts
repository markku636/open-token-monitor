import { describe, expect, it } from "vitest";
import { normalizeOwnerEmail } from "./ownerEmail";

describe("normalizeOwnerEmail", () => {
  it("lower-cases and trims an address", () => {
    expect(normalizeOwnerEmail(" Jane.Doe@Initech.EXAMPLE ")).toBe("jane.doe@initech.example");
  });

  it("rejects what the Rust side and the hub reject", () => {
    for (const bad of ["jane.doe", "a b@c.d", "@c.d", "a@c", "a@.c", "a@c.", "a@b@c.d", ""]) {
      expect(normalizeOwnerEmail(bad), bad).toBe("");
    }
    expect(normalizeOwnerEmail(`${"a".repeat(250)}@x.test`)).toBe("");
  });
});
