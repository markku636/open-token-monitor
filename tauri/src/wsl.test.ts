import { describe, expect, it } from "vitest";
import type { WslStatus } from "./api";
import { shouldShowSqliteHelp, wslTone } from "./wsl";

describe("WSL panel", () => {
  it("colours the state like upstream", () => {
    expect(wslTone("active")).toBe("ok");
    expect(wslTone("no-data")).toBe("neutral");
    expect(wslTone("not-running")).toBe("neutral");
    expect(wslTone("not-installed")).toBe("muted");
    expect(wslTone("disabled")).toBe("muted");
  });

  it("explains SQLite tools only when a detected tool has no usage", () => {
    const status = (s: Partial<WslStatus>): WslStatus => ({ state: "active", detected: [], withData: [], ...s });
    expect(shouldShowSqliteHelp(status({ detected: ["claude", "hermes"], withData: ["claude"] }))).toBe(true);
    expect(shouldShowSqliteHelp(status({ state: "no-data", detected: ["opencode"] }))).toBe(true);
    expect(shouldShowSqliteHelp(status({ detected: ["claude"], withData: [" Claude "] }))).toBe(false);
    expect(shouldShowSqliteHelp(status({ state: "not-running", detected: ["hermes"] }))).toBe(false);
    expect(shouldShowSqliteHelp(status({ state: "disabled", detected: ["hermes"] }))).toBe(false);
    expect(shouldShowSqliteHelp(status({ withData: ["codex"] }))).toBe(false);
    expect(shouldShowSqliteHelp(null)).toBe(false);
  });
});
