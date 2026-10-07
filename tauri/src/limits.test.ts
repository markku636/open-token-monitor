import { afterEach, describe, expect, it } from "vitest";
import type { LimitProvider, LimitWindow } from "./api";
import { setLangForTest } from "./i18n";
import {
  claudeResetGrantRows,
  durationText,
  expiryDateLabel,
  meterTone,
  moneyText,
  resetClearLabel,
  resetCreditsValue,
  resetCreditsView,
  statusNote,
  windowTitle,
} from "./limits";

const w = (over: Partial<LimitWindow>): LimitWindow => ({
  kind: "session",
  label: "",
  used: null,
  limit: null,
  remaining: null,
  usedPercent: null,
  remainingPercent: null,
  resetsAt: null,
  windowMinutes: null,
  currency: null,
  showMeter: true,
  ...over,
});

const p = (over: Partial<LimitProvider>): LimitProvider => ({
  provider: "claude",
  accountKey: "",
  accountLabel: "",
  accountEmail: "",
  status: "ok",
  source: "oauth",
  updatedAt: "2026-09-24T00:00:00.000Z",
  windows: [],
  ...over,
});

describe("limits", () => {
  it("names the windows the way people read them", () => {
    expect(windowTitle(w({ kind: "session" }))).toBe("5 小時");
    expect(windowTitle(w({ kind: "weekly" }))).toBe("每週（全部模型）");
    expect(windowTitle(w({ kind: "weekly", label: "Fable" }))).toBe("每週 · Fable");
    expect(windowTitle(w({ kind: "billing", label: "Monthly" }))).toBe("每月");
    expect(windowTitle(w({ kind: "billing", metric: "spend", label: "Usage credits" }))).toBe("額外用量");
    expect(windowTitle(w({ kind: "weekly", label: "gpt-reserve", additional: true }))).toBe("每週 · gpt-reserve");
  });

  it("colours the meter by how much is used", () => {
    expect(meterTone(95)).toBe("danger");
    expect(meterTone(75)).toBe("warning");
    expect(meterTone(10)).toBe("accent");
    expect(meterTone(null)).toBe("accent");
  });

  it("explains a provider that is not ok", () => {
    expect(statusNote(p({}))).toBe("");
    expect(statusNote(p({ status: "notConfigured" }))).toBe("這台電腦沒有登入 Claude Code");
    expect(statusNote(p({ status: "unauthorized", provider: "codex" }))).toBe("Codex 的登入已失效，請重新登入");
    expect(statusNote(p({ status: "unavailable", windows: [w({})] }))).toBe("暫時無法取得額度（顯示的是先前的數字）");
  });

  it("formats money windows", () => {
    expect(moneyText(w({ metric: "spend", used: 2.35, limit: 20, currency: "USD" }))).toBe("$2.35 / $20.00");
    expect(moneyText(w({ metric: "spend", used: 235, limit: null, currency: "JPY" }))).toBe("JPY 235.00");
  });
});

describe("reset credits", () => {
  afterEach(() => setLangForTest("zh-TW"));

  const NOW = Date.parse("2026-09-24T00:00:00Z");
  const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

  it("formats durations like upstream limitDurationText", () => {
    expect(durationText(0)).toBe("<1 分");
    expect(durationText(29_000)).toBe("<1 分");
    expect(durationText(59_000)).toBe("1 分");
    expect(durationText((3 * 60 + 5) * 60_000)).toBe("3 小時 5 分");
    expect(durationText((2 * 24 + 3) * 3_600_000 + 20 * 60_000)).toBe("2 天 3 小時");
    setLangForTest("en");
    expect(durationText((2 * 24 + 3) * 3_600_000)).toBe("2d 3h");
    expect(durationText(3 * 3_600_000)).toBe("3h 0m");
    expect(durationText(5 * 60_000)).toBe("5m");
    expect(durationText(1)).toBe("<1m");
  });

  it("shows a count only when there are resets to use", () => {
    expect(resetCreditsValue(null)).toBe("");
    expect(resetCreditsValue({ availableCount: null, nextExpiresAt: at(5) })).toBe("");
    expect(resetCreditsValue({ availableCount: 0, nextExpiresAt: null })).toBe("");
    expect(resetCreditsValue({ availableCount: 1, nextExpiresAt: null })).toBe("可重置 1 次");
    expect(resetCreditsValue({ availableCount: 3.7, nextExpiresAt: null })).toBe("可重置 3 次");
    setLangForTest("en");
    expect(resetCreditsValue({ availableCount: 1, nextExpiresAt: null })).toBe("1 reset");
    expect(resetCreditsValue({ availableCount: 3, nextExpiresAt: null })).toBe("3 resets");
    expect(resetCreditsView({ availableCount: 0, nextExpiresAt: at(5) }, NOW)).toBeNull();
  });

  it("lays out Codex credits: nearest three expiries, then the rest as +N", () => {
    const dates = [at(50), at(2), at(-1), at(200), at(26)];
    const view = resetCreditsView({ availableCount: 5, nextExpiresAt: at(-1), expirations: dates }, NOW)!;
    expect(view.value).toBe("可重置 5 次");
    expect(view.timeline).toEqual(["現在", "2 小時 0 分", "1 天 2 小時", "+2"]);
    expect(view.detail).toEqual(
      [at(-1), at(2), at(26), at(50), at(200)].map((iso, i) => ({
        name: expiryDateLabel(new Date(iso)),
        value: ["現在", "2 小時 0 分", "1 天 2 小時", "2 天 2 小時", "8 天 8 小時"][i],
      })),
    );
    setLangForTest("en");
    // 沒有到期清單時退回 nextExpiresAt。
    const en = resetCreditsView({ availableCount: 2, nextExpiresAt: at(3), expirations: [] }, NOW)!;
    expect(en.timeline).toEqual(["3h 0m"]);
    expect(en.detailLabel).toBe("Reset 1: Expires in 3h 0m");
    expect(en.ariaLabel).toBe("Reset credits, 2 resets, Expires in 3h 0m");
  });

  it("has no detail when Codex gives only a count", () => {
    const view = resetCreditsView({ availableCount: 2, nextExpiresAt: null }, NOW)!;
    expect(view.timeline).toEqual([]);
    expect(view.detail).toEqual([]);
  });

  it("names cleared windows the way the limits panel does", () => {
    expect(resetClearLabel("five_hour")).toBe("5 小時");
    expect(resetClearLabel("seven_day")).toBe("每週（全部模型）");
    expect(resetClearLabel("seven_day_overage_included")).toBe("每週 · Fable");
    expect(resetClearLabel("seven_day_opus")).toBe("每週 · Opus");
    expect(resetClearLabel("seven_day_new_bucket")).toBe("seven day new bucket");
  });

  it("explains each Claude grant", () => {
    const grants = [
      { label: "Launch promo reset", resetsLeft: 1, endsAt: at(26), clears: ["five_hour", "seven_day", "seven_day_overage_included"], usableNow: true },
      { label: "Limit reset", resetsLeft: 2, clears: ["seven_day_overage_included"], useRequiresLimit: true, usableNow: false },
      { resetsLeft: 1, endsAt: at(-2), usableNow: false },
      { resetsLeft: 1, endsAt: at(5), paused: true },
    ];
    expect(claudeResetGrantRows(grants, NOW)).toEqual([
      { caption: "Launch promo reset", separated: false },
      { name: "到期", value: `${expiryDateLabel(new Date(at(26)))} · 1 天 2 小時` },
      { name: "重置範圍", value: "5 小時 · 每週（全部模型）" },
      { caption: "Limit reset", separated: true },
      { name: "到期", value: "不會過期" },
      { name: "重置範圍", value: "每週 · Fable" },
      { name: "可用時機", value: "只在達到上限時" },
      { name: "到期", value: `${expiryDateLabel(new Date(at(-2)))} · 已過期` },
      { name: "可用時機", value: "目前不能用" },
      { name: "到期", value: `${expiryDateLabel(new Date(at(5)))} · 已暫停` },
    ]);
    const view = resetCreditsView({ availableCount: 5, nextExpiresAt: at(26), expirations: [at(26)], grants }, NOW)!;
    expect(view.timeline).toEqual(["1 天 2 小時"]);
    expect(view.detail).toHaveLength(10);

    setLangForTest("en");
    const en = resetCreditsView({ availableCount: 1, nextExpiresAt: null, grants: [grants[1]] }, NOW)!;
    expect(en.timeline).toEqual([]);
    expect(en.detailLabel).toBe("Reset 1, 2 left, Limit reset, Expires: No expiry, Clears: Weekly · Fable, Usable: at a limit only");
  });
});
