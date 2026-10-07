// 與上游 JavaScript 的相容測試：同一批輸入交給上游的 motionPreference.js、limitResetMotion.js、
// breakdownRenderPolicy.js 與我們的 motion.ts，結果必須完全相同（額度的 key 是 FNV 雜湊，要逐字相同）。
// 熱力圖的捲動位置（homeActivityScrollTarget / Record）在 homeViews.compat.test.ts 比對。
//
// 需要上游 checkout：TOKEN_MONITOR_REPO（預設 monorepo 的 upstream/）；找不到就略過。
// 檔名以 .test.ts 結尾，i18n.test.ts 的原始碼掃描不會把這裡的字當成介面字串。

import { describe, expect, it } from "vitest";
import * as ours from "./motion";

// vitest 跑在 Node 裡，但前端的 tsconfig 沒有 Node 型別（也不為了一個測試加 @types/node）：
// 用 process.getBuiltinModule（Node 22.3+）取內建模組，只宣告用到的那幾個函式。
interface NodeProcess {
  env: Record<string, string | undefined>;
  getBuiltinModule(id: string): unknown;
}
const node = (globalThis as unknown as { process: NodeProcess }).process;
const { existsSync } = node.getBuiltinModule("node:fs") as { existsSync(p: string): boolean };
const { createRequire } = node.getBuiltinModule("node:module") as { createRequire(from: string): (id: string) => unknown };
const path = node.getBuiltinModule("node:path") as { join(...parts: string[]): string; resolve(...parts: string[]): string };
const { fileURLToPath } = node.getBuiltinModule("node:url") as { fileURLToPath(url: URL): string };

const REPO = node.env.TOKEN_MONITOR_REPO ? path.resolve(node.env.TOKEN_MONITOR_REPO) : fileURLToPath(new URL("../../upstream/", import.meta.url));
const ELECTRON = path.join(REPO, "src", "electron");
const RENDERER = path.join(ELECTRON, "renderer");
const exists = existsSync(path.join(RENDERER, "limitResetMotion.js")) && existsSync(path.join(ELECTRON, "motionPreference.js"));
const require = createRequire(import.meta.url);
type Api = Record<string, (...args: any[]) => any>;
const load = (file: string): Api => require(file) as Api;

const PREFERENCES: unknown[] = ["system", "on", "off", " on ", "ON", "", null, undefined, 0, 5, "x", false, " off", "system "];
const PERCENTS: unknown[] = [null, "", -5, 0, 7, 14, 42.5, 69, 98, 99.4, 99.5, 100, 150, "abc", "55", undefined, NaN];
const RESETS: [unknown, unknown][] = [
  [undefined, undefined],
  ["2026-09-09T01:00:00.000Z", "2026-09-09T01:00:00.000Z"],
  ["2026-09-09T01:00:00.000Z", "2026-09-09T06:00:00.000Z"],
  ["2026-09-09T06:00:00.000Z", "2026-09-09T01:00:00.000Z"],
  ["not a date", "2026-09-09T06:00:00.000Z"],
  ["2026-09-09T01:00:00.000Z", undefined],
];

const PROVIDERS: unknown[] = [
  null,
  undefined,
  {},
  { provider: "claude" },
  { provider: "Claude", accountKey: "acct-1" },
  { provider: "claude", accountKey: " acct-1 " },
  { provider: "codex", accountEmail: "First@Example.com" },
  { provider: "codex", accountEmail: "first@example.com" },
  { provider: "codex", accountEmail: "second@example.com" },
  { provider: "codex", webAccountKey: "web-9", accountEmail: "x@y.z" },
  { provider: "cursor", accountName: "Mark" },
  { provider: "cursor", accountLabel: "Pro plan" },
  { provider: "copilot", profileId: "p-3" },
  { provider: "copilot", accountKey: "", accountEmail: "", accountName: "", profileId: "" },
  { provider: " CODEX ", accountKey: 42 },
  { provider: "claude", accountEmail: "  Mixed@Case.TW  " },
  { provider: "claude", accountKey: "鍵值" },
  { provider: null, accountKey: null },
  { provider: "kimi", accountName: "a\u0000b" },
  { provider: "claude", accountKey: "k", webAccountKey: "w", accountEmail: "e@x.y", accountName: "n", accountLabel: "l", profileId: "p" },
];

const WINDOWS: [string, unknown][] = [
  ["Session", { kind: "session" }],
  ["Weekly", { kind: "weekly" }],
  ["Weekly", null],
  ["Weekly", undefined],
  ["Weekly", { kind: "Weekly", label: "Weekly (Fable)" }],
  ["", { kind: "weekly", limitId: "L1" }],
  ["x", { kind: "weekly", id: "id-2", quotaId: "q" }],
  ["x", { kind: "monthly", quotaId: "q" }],
  ["x", { kind: "daily", model: "claude-fable-5-1" }],
  ["x", { kind: "daily", group: "g" }],
  ["Additional", { kind: "weekly", additional: true }],
  ["Additional", { kind: "weekly", additional: "true" }],
  ["  Spaced  ", { label: "  " }],
  ["額度", { kind: "billing" }],
];

describe.skipIf(!exists)("motion matches upstream", () => {
  it("reduce motion preference", () => {
    const up = load(path.join(ELECTRON, "motionPreference.js"));
    for (const value of PREFERENCES) {
      expect(ours.normalizeReduceMotion(value), String(value)).toBe(up.normalize(value));
      for (const fallback of ["off", "on", "bogus", undefined]) {
        expect(ours.normalizeReduceMotion(value, fallback), `${String(value)} / ${String(fallback)}`).toBe(up.normalize(value, fallback));
      }
      for (const system of [true, false, 1, 0, undefined]) {
        expect(ours.shouldReduceMotion(value, system), `${String(value)} / ${String(system)}`).toBe(up.shouldReduceMotion(value, system));
      }
    }
  });

  it("limit reset durations and percentages", () => {
    const up = load(path.join(RENDERER, "limitResetMotion.js"));
    for (const from of PERCENTS) {
      for (const to of [100, 50, undefined, null, "abc"]) {
        expect(ours.limitResetDurationMs(from, to), `${String(from)} → ${String(to)}`).toBe(up.durationMs(from, to));
      }
      expect(ours.limitDisplayPercent(from), String(from)).toBe(up.displayPercent(from));
      for (const used of PERCENTS) {
        const w = { remainingPercent: from, usedPercent: used };
        expect(ours.limitRemainingPercent(w), JSON.stringify(w)).toBe(up.remainingPercent(w));
      }
    }
    expect(ours.limitRemainingPercent(null)).toBe(up.remainingPercent(null));
    expect(ours.limitRemainingPercent(undefined)).toBe(up.remainingPercent(undefined));
  });

  it("limit reset decision", () => {
    const up = load(path.join(RENDERER, "limitResetMotion.js"));
    const remaining: unknown[] = [null, "", 0, 50, 99.4, 99.5, 100, "abc"];
    for (const a of remaining) {
      for (const b of remaining) {
        for (const [ra, rb] of RESETS) {
          const prev = { remainingPercent: a, resetsAt: ra };
          const cur = { remainingPercent: b, resetsAt: rb };
          expect(ours.shouldAnimateLimitReset(prev, cur), JSON.stringify([prev, cur])).toBe(up.shouldAnimateReset(prev, cur));
        }
      }
    }
    expect(ours.shouldAnimateLimitReset(null, { remainingPercent: 100 })).toBe(up.shouldAnimateReset(null, { remainingPercent: 100 }));
    expect(ours.shouldAnimateLimitReset({ remainingPercent: 0 }, undefined)).toBe(up.shouldAnimateReset({ remainingPercent: 0 }, undefined));
  });

  it("limit motion keys (FNV-1a, string-identical)", () => {
    const up = load(path.join(RENDERER, "limitResetMotion.js"));
    for (const provider of PROVIDERS) {
      expect(ours.limitProviderMotionKey(provider), JSON.stringify(provider)).toBe(up.providerKey(provider));
    }
    expect(ours.limitProviderMotionKey()).toBe(up.providerKey());
    for (const [label, window] of WINDOWS) {
      expect(ours.limitWindowMotionKey(label, window), JSON.stringify([label, window])).toBe(up.windowKey(label, window));
    }
    expect(ours.limitWindowMotionKey("Weekly")).toBe(up.windowKey("Weekly"));
  });

  it("breakdown row cap", () => {
    const up = load(path.join(RENDERER, "breakdownRenderPolicy.js"));
    for (const count of [-1, 0, 1, 39, 40, 41, "40", "41", NaN, null, undefined, 2.9, 40.5, Infinity]) {
      for (const reducedMotion of [true, false, undefined, "true"]) {
        const options = { reducedMotion };
        expect(ours.shouldAnimateBreakdownRows(count, options), JSON.stringify([count, reducedMotion])).toBe(up.shouldAnimateBreakdownRows(count, options));
      }
      expect(ours.shouldAnimateBreakdownRows(count), String(count)).toBe(up.shouldAnimateBreakdownRows(count));
    }
    expect(ours.M.maxAnimatedRows).toBe(up.MAX_ANIMATED_BREAKDOWN_ROWS as unknown as number);
  });
});
