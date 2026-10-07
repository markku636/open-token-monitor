// 全公司範圍逐台計算的相容測試：同一批 hub 上的裝置 record（`/api/devices` 的形狀），上游以
// src/electron/historySource.js `parseDeviceHistories` + renderer/fixedPeriodRanges.js
// `joinDeviceHistorySources` / `fixedPeriodSnapshotFromDevices` 推出本星期／最近 7、30 日；我們把
// 同一批 record 經 hub 的 hub/deviceDaily.js `projectDevice`（`/api/custom/device-daily`
// 的一台）交給 `tm-agent device-ranges`（GUI 同一條 ranges.rs 路徑）。一次驗證 hub 的投影與 Rust 的移植。
//
// 需要 overlay 有 hub/deviceDaily.js（本 repo 根目錄的 hub 目前沒有，所以會 skip）；位置見 repos.mjs。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CUSTOM, REPO, root } from "./repos.mjs";

const DEVICE_DAILY = path.join(CUSTOM, "hub", "deviceDaily.js");
const RANGES = path.join(REPO, "src", "electron", "renderer", "fixedPeriodRanges.js");
const skip = fs.existsSync(DEVICE_DAILY) && fs.existsSync(RANGES)
  ? false
  : `hub/deviceDaily.js not found under ${CUSTOM}, or upstream renderer/fixedPeriodRanges.js under ${REPO}`;
const require = createRequire(import.meta.url);

let built = null;
function agentBin() {
  if (process.env.TM_AGENT_BIN) return process.env.TM_AGENT_BIN;
  if (built) return built;
  const build = spawnSync(
    "cargo",
    ["build", "--manifest-path", path.join(root, "src-tauri", "Cargo.toml"), "--no-default-features", "--bin", "tm-agent"],
    { stdio: "inherit" },
  );
  assert.equal(build.status, 0, "cargo build tm-agent failed");
  built = path.join(root, "src-tauri", "target", "debug", process.platform === "win32" ? "tm-agent.exe" : "tm-agent");
  return built;
}

// 觀看者的現在：東京 09-24 12:00、紐約（夏令時間 UTC−4）09-23 23:00，離日光節約的切換很遠。
const NOW = Date.parse("2026-09-24T03:00:00.000Z");
const VIEWER_TODAY = "2026-09-24";
const ZONES = {
  "Asia/Tokyo": 9,
  "America/New_York": -4,
};

function addDays(key, delta) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);
}

// 那個時區在 `key` 隔天的 00:00（UTC ISO）。
function midnightAfter(key, zone) {
  return new Date(Date.parse(`${addDays(key, 1)}T00:00:00Z`) - ZONES[zone] * 3600000).toISOString();
}

function zoneToday(zone) {
  return new Date(NOW + ZONES[zone] * 3600000).toISOString().slice(0, 10);
}

// 上傳的每日列：token 組成、訊息數、熱度都在，確認 hub 去掉它們不影響顯示的數字。
function day(date, seed, clients = ["claude", "codex"]) {
  const tokens = 1000 * seed + 37;
  const cost = Number((0.4 * seed + 0.013).toFixed(6));
  const part = (share) => {
    const t = Math.round(tokens * share);
    return { tokens: t, cost: Number((cost * share).toFixed(6)), messages: 2, unclassifiedTokens: 0, cacheReadTokens: Math.round(t * 0.6), cacheWriteTokens: Math.round(t * 0.1), outputTokens: Math.round(t * 0.05) };
  };
  return {
    date,
    tokens,
    cost,
    messages: 4,
    intensity: 2,
    cacheReadTokens: Math.round(tokens * 0.6),
    cacheWriteTokens: Math.round(tokens * 0.1),
    outputTokens: Math.round(tokens * 0.05),
    unclassifiedTokens: 0,
    tokenComponentsAvailable: true,
    activeTimeMs: 60000 * (seed % 4),
    perClient: Object.fromEntries(clients.map((client) => [client, part(1 / clients.length)])),
    perModel: { "claude-sonnet-4-5": part(0.7), "gpt-5.5": part(0.3) },
  };
}

function period(tokens, clients = { claude: tokens }) {
  const cost = tokens / 1000;
  return {
    totalTokens: tokens,
    costUsd: cost,
    clients,
    clientCosts: Object.fromEntries(Object.entries(clients).map(([k, v]) => [k, v / 1000])),
    models: tokens > 0 ? { "claude-sonnet-4-5": tokens } : {},
    modelCosts: tokens > 0 ? { "claude-sonnet-4-5": cost } : {},
  };
}

/**
 * 一台裝置的 hub record（經上游自己的 mergeDeviceRecord，與 /api/devices 回的相同）。
 * `key`：它最新的 today 屬於哪一天（預設是它時區的今天）；`daily`：每日歷史（null = 沒有可用的歷史）。
 */
function record(deviceId, { zone = "Asia/Tokyo", key = zoneToday(zone), today = 500, todayClients, month = today * 10, daily = [] } = {}) {
  const { mergeDeviceRecord } = require(path.join(REPO, "src", "shared", "usage.js"));
  const payload = {
    deviceId,
    hostname: deviceId.toUpperCase(),
    platform: "win32",
    agentVersion: "0.1.0",
    agentRuntime: "tauri-widget",
    updatedAt: new Date(NOW - 60000).toISOString(),
    syncUploadIntervalMs: 600000,
    today: period(today, todayClients),
    month: period(month),
    allTime: period(month * 3),
    periodWindows: {
      timeZone: zone,
      today: { key, endsAt: midnightAfter(key, zone) },
      month: { key: key.slice(0, 7), endsAt: midnightAfter(`${key.slice(0, 7)}-28`, zone) },
    },
    historyAvailable: daily !== null,
    history: daily === null ? null : { daily, monthly: [], summary: {} },
  };
  return mergeDeviceRecord(undefined, { ...payload, receivedAt: new Date(NOW - 60000).toISOString() });
}

function days(from, count, seedFrom = 1, clients) {
  return Array.from({ length: count }, (_, i) => day(addDays(from, i), seedFrom + (i % 6), clients));
}

function upstream(records, selection, locale) {
  const { parseDeviceHistories } = require(path.join(REPO, "src", "electron", "historySource.js"));
  const { fixedPeriodSnapshotFromDevices, joinDeviceHistorySources } = require(RANGES);
  const live = records.map((r) => ({ deviceId: r.deviceId, periods: r.periods, periodWindows: r.periodWindows }));
  const sources = joinDeviceHistorySources(parseDeviceHistories(records), live);
  return fixedPeriodSnapshotFromDevices(selection, sources, { historyEnabled: true, historyAvailable: true, todayKey: VIEWER_TODAY, locale, now: NOW });
}

function ours(records, selection, weekStart) {
  const { projectDevice, windowStart } = require(DEVICE_DAILY);
  const start = windowStart(NOW);
  const input = {
    devices: records.map((r) => ({ deviceId: r.deviceId, periods: r.periods, periodWindows: r.periodWindows, deviceDaily: projectDevice(r, start) })),
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-ranges-"));
  try {
    const file = path.join(dir, "input.json");
    fs.writeFileSync(file, JSON.stringify(input));
    const res = spawnSync(
      agentBin(),
      ["device-ranges", "--input", file, "--range", selection, "--week-start", String(weekStart), "--now", new Date(NOW).toISOString(), "--today", VIEWER_TODAY],
      { encoding: "utf8", env: { ...process.env, TOKEN_MONITOR_CONFIG_DIR: dir, TOKEN_MONITOR_DISABLE_KEYRING: "1" } },
    );
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 畫面上顯示的欄位：總數、成本，工具與模型的 token 與成本。
function assertPeriod(actual, expected, label) {
  assert.equal(actual.totalTokens, expected.totalTokens, `${label} totalTokens`);
  assert.ok(Math.abs(actual.costUsd - expected.costUsd) <= 1e-6, `${label} costUsd ${actual.costUsd} vs ${expected.costUsd}`);
  for (const [tokens, costs] of [["clients", "clientCosts"], ["models", "modelCosts"]]) {
    assert.deepEqual(actual[tokens], expected[tokens], `${label} ${tokens}`);
    assert.deepEqual(Object.keys(actual[costs]).sort(), Object.keys(expected[costs]).sort(), `${label} ${costs} keys`);
    for (const [key, value] of Object.entries(expected[costs])) {
      assert.ok(Math.abs(actual[costs][key] - value) <= 1e-6, `${label} ${costs}.${key} ${actual[costs][key]} vs ${value}`);
    }
  }
}

const SELECTIONS = [
  ["week", "en-US"],
  ["week", "de-DE"],
  ["last7", "en-US"],
  ["last30", "en-US"],
];

function compare(records, label) {
  const { weekStartsOn } = require(RANGES);
  for (const [selection, locale] of SELECTIONS) {
    const tag = `${label} ${selection} ${locale}`;
    const expected = upstream(records, selection, locale);
    const actual = ours(records, selection, weekStartsOn(locale));
    assert.equal(expected.status, "ready", `${tag}: upstream is ready`);
    assert.deepEqual({ start: actual.start, end: actual.end }, expected.range, `${tag} range`);
    assert.deepEqual(actual.summary, expected.summary, `${tag} summary`);
    assertPeriod(actual.period, expected.period, tag);
    assert.deepEqual(actual.devices.map((d) => d.deviceId), expected.devices.map((d) => d.deviceId), `${tag} devices`);
    for (const [i, device] of expected.devices.entries()) {
      const mine = actual.devices[i];
      assert.equal(mine.status, "ready", `${tag} ${device.deviceId} status`);
      assert.deepEqual({ start: mine.start, end: mine.end }, device.range, `${tag} ${device.deviceId} range`);
      assertPeriod(mine.period, device.period, `${tag} ${device.deviceId}`);
    }
  }
}

test("device ranges: one time zone matches upstream", { skip }, () => {
  compare(
    [
      record("dev-a", { today: 9000, daily: days("2026-08-10", 46, 1) }),
      record("dev-b", { today: 1234, daily: days("2026-09-01", 20, 3, ["claude"]) }),
      record("dev-c", { today: 777, daily: days("2026-08-20", 10, 2) }),
    ],
    "one zone",
  );
});

test("device ranges: Tokyo and New York devices keep their own day keys", { skip }, () => {
  const ny = "America/New_York";
  assert.equal(zoneToday(ny), "2026-09-23", "the fixture straddles a date line");
  compare(
    [
      record("tokyo-1", { today: 4000, daily: days("2026-08-25", 31, 1) }),
      record("ny-1", { zone: ny, today: 2500, daily: days("2026-08-24", 31, 2) }),
      record("ny-2", { zone: ny, today: 60, daily: days("2026-09-10", 14, 4, ["codex"]) }),
    ],
    "mixed zones",
  );
});

test("device ranges: expired windows, smaller live days, folded tools and idle devices match upstream", { skip }, () => {
  compare(
    [
      // 兩天前關機：它最後的 today 落在 09-22，範圍到東京的今天。
      record("offline", { key: "2026-09-22", today: 3100, daily: days("2026-08-30", 20, 2) }),
      // 即時的今天比 history 裡的今天小：保留 history 那一列。
      record("smaller-live", { today: 10, daily: days("2026-09-15", 10, 5) }),
      // antigravity-cli 併進 antigravity（history 與即時的今天都有）。
      record("folded", { today: 900, todayClients: { "antigravity-cli": 600, claude: 300 }, daily: days("2026-09-05", 18, 1, ["antigravity-cli", "claude"]) }),
      // 完全沒有用量：不列。
      record("idle", { today: 0, month: 0, daily: [{ date: "2026-09-20", tokens: 0, cost: 0 }] }),
      // 只有 32 天以前的歷史有用量：仍參與，範圍是 0。
      record("old-only", { today: 0, month: 0, daily: [day("2026-03-01", 3)] }),
    ],
    "edge cases",
  );
});

test("device ranges: an empty fleet is zero over the viewer's range", { skip }, () => {
  compare([], "empty");
  const actual = ours([], "last7", 1);
  assert.deepEqual({ start: actual.start, end: actual.end }, { start: "2026-09-18", end: "2026-09-24" });
  assert.equal(actual.period.totalTokens, 0);
  assert.deepEqual(actual.devices, []);
});

test("device ranges: a device without history is left out and marked instead of failing the range (v1 deviation)", { skip }, () => {
  const records = [
    record("with-history", { today: 800, daily: days("2026-09-10", 14, 2) }),
    record("without-history", { today: 5000, daily: null }),
    // 即時全是 0、又沒有歷史（例如 allTimeSince 把前幾天排除）：上游不會把它當成沒參與。
    record("quiet-without-history", { today: 0, month: 0, daily: null }),
  ];
  // 上游只要有一台沒有可用的歷史，整個範圍就不顯示；只有即時全是 0 的那台缺歷史也一樣。
  for (const fleet of [records, [records[0], records[2]]]) {
    const expected = upstream(fleet, "last7", "en-US");
    assert.equal(expected.status, "unavailable");
    assert.equal(expected.reason, "historyUnavailable");
  }
  // 我們照算其他裝置，沒有歷史的裝置（不論即時數字）標成 unavailable、不計入。
  const actual = ours(records, "last7", 1);
  assert.deepEqual(actual.devices.map((d) => [d.deviceId, d.status]), [
    ["quiet-without-history", "unavailable"],
    ["with-history", "ready"],
    ["without-history", "unavailable"],
  ]);
  const alone = upstream(records.slice(0, 1), "last7", "en-US");
  assertPeriod(actual.period, alone.period, "the rest equals upstream without those devices");
  assert.deepEqual({ start: actual.start, end: actual.end }, alone.range);
});
