import { describe, expect, it } from "vitest";
import { updatePillVisible, updateStatusText } from "./update";

describe("update status", () => {
  it("explains why updates are off", () => {
    expect(updateStatusText({ state: "disabled", reason: "noPublicKey" })).toContain("簽章");
    expect(updateStatusText({ state: "disabled", reason: "devBuild" })).toContain("開發版");
  });

  it("shows download progress in MB", () => {
    expect(updateStatusText({ state: "downloading", version: "0.2.0", received: 5 * 1048576, total: 16 * 1048576 })).toBe(
      "正在下載 v0.2.0：5.0 / 16.0 MB",
    );
    expect(updateStatusText({ state: "downloading", version: "0.2.0", received: 1048576, total: null })).toBe(
      "正在下載 v0.2.0：1.0 MB",
    );
  });

  it("shows the pill unless the version was dismissed, and always once downloaded", () => {
    const available = { state: "available", version: "0.2.0", notes: null, date: null } as const;
    expect(updatePillVisible(available, "")).toBe(true);
    expect(updatePillVisible(available, "0.2.0")).toBe(false);
    expect(updatePillVisible({ ...available, version: "0.3.0" }, "0.2.0")).toBe(true);
    expect(updatePillVisible({ state: "downloading", version: "0.2.0", received: 0, total: null }, "")).toBe(true);
    expect(updatePillVisible({ state: "ready", version: "0.2.0", notes: null, date: null }, "0.2.0")).toBe(true);
    expect(updatePillVisible({ state: "upToDate", checkedAt: "2026-09-24T00:00:00Z" }, "")).toBe(false);
    expect(updatePillVisible(null, "")).toBe(false);
  });

  it("keeps the error and when it retries", () => {
    const text = updateStatusText({ state: "error", message: "檢查更新失敗：timeout", retryAt: null });
    expect(text).toBe("檢查更新失敗：timeout");
  });
});
