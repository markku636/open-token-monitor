// 跨專案相容測試：同一份 tokscale JSON，分別交給上游 token-monitor 的 JavaScript 與我們的
// tm-agent，確認 hub 看到的數字完全一樣。
//
// 需要上游 checkout：TOKEN_MONITOR_REPO（預設 monorepo 的 ../upstream）。找不到就 skip。
// 有 overlay（TOKEN_MONITOR_CUSTOM，預設 monorepo 根目錄的 overlay）時，也讓它的 ingestGuard 驗過每一份 payload。
// TM_COMPAT_LIVE=1 另外用本機真的 tokscale 掃描結果比一次（輸出只放暫存目錄，不進版控）。
//
// 執行：npm run test:compat（會先編譯 tm-agent）

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CUSTOM, REPO, root } from "./repos.mjs";

const hasRepo = fs.existsSync(path.join(REPO, "src", "shared", "usage.js"));
const skip = hasRepo ? false : `upstream checkout not found at ${REPO} (set TOKEN_MONITOR_REPO)`;
const require = createRequire(import.meta.url);
const up = (rel) => require(path.join(REPO, "src", "shared", rel));

const FIXTURE = path.join(root, "src-tauri", "tests", "fixtures", "tokscale", "basic");
const PERIOD_FILES = [
  ["today", "today"],
  ["month", "month"],
  ["allTime", "alltime"],
];

function agentBin() {
  if (process.env.TM_AGENT_BIN) return process.env.TM_AGENT_BIN;
  const exe = process.platform === "win32" ? "tm-agent.exe" : "tm-agent";
  const bin = path.join(root, "src-tauri", "target", "debug", exe);
  const build = spawnSync(
    "cargo",
    ["build", "--manifest-path", path.join(root, "src-tauri", "Cargo.toml"), "--no-default-features", "--bin", "tm-agent"],
    { stdio: "inherit" },
  );
  assert.equal(build.status, 0, "cargo build tm-agent failed");
  return bin;
}

function runAgent(bin, fixtureDir, args) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-compat-"));
  const res = spawnSync(bin, ["once", "--dry-run", "--tokscale-json-dir", fixtureDir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      TOKEN_MONITOR_CONFIG_DIR: configDir,
      TOKEN_MONITOR_DISABLE_KEYRING: "1",
      TOKEN_MONITOR_DEVICE_ID: "compat-device",
    },
  });
  assert.equal(res.status, 0, `tm-agent failed: ${res.stderr}`);
  return res.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

// 上游 widget / agent 的等效流程：每次掃描先摺入 metadata，再抽用量，最後由 session 彙總專案。
function upstreamSummary(dir, { projectsEnabled = true } = {}) {
  const { applyTokscaleSessionMetadata } = up("sessionMetadata.js");
  const usage = up("usage.js");
  const summary = { deviceId: "compat-device", projectsEnabled };
  for (const [name, file] of PERIOD_FILES) {
    const json = JSON.parse(fs.readFileSync(path.join(dir, `${file}.json`), "utf8"));
    applyTokscaleSessionMetadata(json, { resolveProjects: projectsEnabled });
    summary[name] = usage.extractUsageFromTokscale(json);
  }
  if (projectsEnabled) usage.applyProjectRollups(summary);
  return plain(summary);
}

// null-prototype 物件與 undefined 欄位都正規化掉，只比 JSON 看得到的內容。
const plain = (v) => JSON.parse(JSON.stringify(v));

// session 標題只留在上游 widget 本機、永不上 wire；我們根本不產生。比較前從上游那邊拿掉。
function withoutTitles(period) {
  const copy = plain(period);
  for (const s of Object.values(copy.sessions || {})) delete s.title;
  return copy;
}

function diff(a, b, at = "$", out = []) {
  if (typeof a === "number" && typeof b === "number") {
    const tol = Math.max(1e-9, Math.abs(a) * 1e-12);
    if (Math.abs(a - b) > tol) out.push(`${at}: ${a} !== ${b}`);
    return out;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    if (a !== b) out.push(`${at}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${at}: array mismatch`);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) out.push(`${at}.${k}: missing on ours`);
    else if (!(k in b)) out.push(`${at}.${k}: extra on ours`);
    else diff(a[k], b[k], `${at}.${k}`, out);
  }
  return out;
}

function assertSame(ours, theirs, label) {
  const problems = diff(ours, theirs);
  assert.deepEqual(problems.slice(0, 40), [], `${label}: ${problems.length} difference(s)`);
}

function checkDirectory(bin, dir, tag) {
  {
    const [record, payload] = runAgent(bin, dir, ["--json", "--payload"]);
    const theirs = upstreamSummary(dir, { projectsEnabled: true });

    // 1. 解析結果逐欄相同（包含每個 session、每個專案、每個 client × model）。
    for (const [name] of PERIOD_FILES) {
      assertSame(plain(record[name]), withoutTitles(theirs[name]), `${tag} period ${name}`);
    }

    // 2. hub 的正規化（normalizeDeviceRecord）看到的 periods 相同。
    const { normalizeDeviceRecord, aggregateDevices, mergeDeviceRecord } = up("usage.js");
    const oursNorm = plain(normalizeDeviceRecord(record));
    const theirsNorm = plain(
      normalizeDeviceRecord({ ...record, today: theirs.today, month: theirs.month, allTime: theirs.allTime }),
    );
    for (const [name] of PERIOD_FILES) {
      // normalizeSession 會替每個 session 補上空的 title，兩邊都拿掉再比。
      assertSame(withoutTitles(oursNorm.periods[name]), withoutTitles(theirsNorm.periods[name]), `${tag} normalized ${name}`);
    }

    // 3. 我們送出的欄位 hub 全部認得、也全部保留。
    for (const key of ["deviceId", "hostname", "platform", "agentVersion", "agentRuntime", "updatedAt"]) {
      assert.equal(oursNorm[key], record[key], `${tag} ${key} survives normalization`);
    }
    assert.equal(oursNorm.agentRuntime, "tauri-agent");
    assert.deepEqual(oursNorm.trackedClients, record.trackedClients);
    assert.deepEqual(oursNorm.clientStatus, record.clientStatus);
    assert.equal(oursNorm.projectsEnabled, record.projectsEnabled);
    assert.equal(oursNorm.historyAvailable, true);
    assert.equal(oursNorm.syncUploadIntervalMs, record.syncUploadIntervalMs);
    assert.equal(oursNorm.periodWindows.today.endsAt, record.periodWindows.today.endsAt);
    assert.equal(oursNorm.periodWindows.month.endsAt, record.periodWindows.month.endsAt);
    assert.equal(oursNorm.periodWindows.timeZone, record.periodWindows.timeZone, "IANA zone accepted by the hub");

    // 4. periodWindows 格式正確、尚未過期 → hub 會把今天的用量算進總數。
    const agg = aggregateDevices([{ ...record, receivedAt: new Date().toISOString() }], 20 * 60 * 1000);
    assert.equal(agg.periods.today.totalTokens, record.today.totalTokens, `${tag} hub aggregate counts today`);

    // 5. hub 以 mergeDeviceRecord 合併時不會丟掉我們的欄位。
    const merged = plain(mergeDeviceRecord(null, record));
    assert.equal(merged.periods.month.totalTokens, record.month.totalTokens);

    // 6. 上傳 payload（含大小預算）與上游 serializeSyncPayload 的結果相同。
    const { serializeSyncPayload, SYNC_PAYLOAD_BUDGET_BYTES } = up("syncPayload.js");
    const upstreamPayload = serializeSyncPayload(record);
    assertSame(payload, plain(upstreamPayload.payload), `${tag} sync payload`);
    assert.ok(upstreamPayload.bytes <= SYNC_PAYLOAD_BUDGET_BYTES);

    // 7. 有 graph.json 時：history 與上游 agent 的預設流程逐欄相同。archive 預設開（新的設定目錄 =
    //    空的 archive），所以是 retainDailyHistory：captureDailyHistoryArchive → graphFromDailyHistoryArchive
    //    → normalizeHistory(parseGraphResult())。hub 原樣保存，fork hub 的 ingestGuard 也接受這份 payload。
    const graphFile = path.join(dir, "graph.json");
    if (fs.existsSync(graphFile)) {
      const { normalizeHistory, parseGraphResult } = up("history.js");
      const archiveMod = up("dailyHistoryArchive.js");
      const todayKey = record.periodWindows.today.key;
      const graph = JSON.parse(fs.readFileSync(graphFile, "utf8"));
      const archive = archiveMod.captureDailyHistoryArchive(null, [graph], { todayKey });
      const rebuilt = archiveMod.graphFromDailyHistoryArchive([graph], archive, { todayKey });
      const theirHistory = plain(normalizeHistory(parseGraphResult(rebuilt), { todayKey }));
      if (theirHistory.daily.length || theirHistory.monthly.length) {
        assertSame(record.history, theirHistory, `${tag} history`);
        assertSame(oursNorm.history, record.history, `${tag} hub keeps history verbatim`);
      } else {
        assert.equal(record.history, undefined, `${tag} empty graph: no history key`);
      }
    }
    const guard = path.join(CUSTOM, "hub", "ingestGuard.js");
    if (fs.existsSync(guard)) {
      require(guard).checkIngestPayload(plain(payload));
    }
  }
}

// 相對於今天產生的 graph（固定日期的 fixture 一年後就全掉出 370 天的窗口）。涵蓋上游
// parseGraphResult 的每條規則：reasoning 只算進 codex、別名、Reasonix 的 messages、沒有 client /
// 模型、字串數字、明確的 unclassified、tokenComponentSummary、snake_case 的 timeMetrics，以及
// 370 天以外只算進 monthly 與 summary 的日子。
function syntheticGraph(todayKey) {
  const day = (back) => {
    const d = new Date(`${todayKey}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0, 10);
  };
  const contributions = [];
  for (const back of [0, 1, 2, 4, 5, 6, 7, 29, 30, 31, 120, 369, 370, 400, 800]) {
    const n = back + 1;
    contributions.push({
      date: `${day(back)}T00:00:00`,
      totals: { tokens: 999999, cost: 999 },
      clients: [
        { client: "claude", modelId: "claude-opus-5", tokens: { input: 10 * n, output: 5 * n, cacheRead: 100 * n, cacheWrite: 7 * n, reasoning: 3 * n }, cost: 0.1 * n, messages: n },
        { client: "codex", modelId: "gpt-5.5", tokens: { input: 4 * n, output: 2 * n, cacheRead: 0, cacheWrite: 0, reasoning: n }, cost: "$1,000.25", messages: 2 },
        { client: "Antigravity-CLI", model: "gemini-3", tokens: { input: 3, output: 1 }, cost: 0.03, messages: 1 },
        { client: "reasonix", model_id: "deepseek", tokens: { input: 5, output: 5, reasoning: 2 }, cost: 0.01, messages: 50 },
        { tokens: { input: 1 }, messages: 1 },
      ],
      activeTimeMs: 60000 * n,
    });
  }
  contributions.push({
    date: day(3),
    clients: [
      { client: "copilot", modelId: "gpt-4.1", tokens: { input: 50, output: 10 }, tokenComponentsAvailable: false, cost: 0.2, messages: 3 },
      { client: "opencode", modelId: "gpt-4.1", tokens: { input: 20, output: 20 }, unclassifiedTokens: 15, cost: 0.1, messages: 1 },
    ],
    active_time_ms: 1234,
  });
  contributions.push({
    date: day(8),
    clients: [{ client: "hermes", modelId: "hermes-4", tokens: { input: 30, output: 10 }, tokenComponentsAvailable: false, cost: 0.05, messages: 1 }],
    tokenComponentSummary: {
      tokenComponentsAvailable: true,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      perClient: { hermes: { outputTokens: 10 } },
      perModel: { "hermes-4": { outputTokens: 10 } },
    },
  });
  contributions.push({ date: "", clients: [{ client: "claude", tokens: { input: 1 } }] });
  return {
    contributions,
    time_metrics: { total_active_time_ms: 99999, longest_continuous_ms: 5000, max_concurrent_sessions: 3, session_count: 12 },
  };
}

function localTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("history: graph → daily / monthly / summary and payload match upstream", { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-history-"));
  try {
    for (const [, file] of PERIOD_FILES) fs.copyFileSync(path.join(FIXTURE, `${file}.json`), path.join(dir, `${file}.json`));
    fs.writeFileSync(path.join(dir, "graph.json"), JSON.stringify(syntheticGraph(localTodayKey())));
    const [record, payload] = runAgent(agentBin(), dir, ["--json", "--payload"]);
    assert.ok(record.history, "history is uploaded");
    assert.ok(record.history.daily.length >= 10 && record.history.daily.length < 17, "only the last 370 days are daily rows");
    assert.ok(payload.history.daily.some((r) => r.outputTokens === undefined), "rows older than 30 days lose token components");
    checkDirectory(agentBin(), dir, "history");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("history disabled: every record says history null", { skip }, () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-compat-"));
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({ deviceId: "compat-device", historyEnabled: false }));
  const res = spawnSync(agentBin(), ["once", "--dry-run", "--tokscale-json-dir", FIXTURE, "--json", "--payload"], {
    encoding: "utf8",
    env: { ...process.env, TOKEN_MONITOR_CONFIG_DIR: configDir, TOKEN_MONITOR_DISABLE_KEYRING: "1" },
  });
  assert.equal(res.status, 0, res.stderr);
  const [record, payload] = res.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.equal(record.historyAvailable, false);
  assert.equal(record.history, null);
  assert.equal(payload.history, null);
  const { normalizeDeviceRecord } = up("usage.js");
  assert.equal(normalizeDeviceRecord(record).historyAvailable, false);
});

test("synthetic fixture: parsing, hub normalization and payload match upstream", { skip }, () => {
  checkDirectory(agentBin(), FIXTURE, "fixture");
});

// 上游 collector.js `propagateTodayProjects` 原文（沒有匯出，照抄當參考實作）。
function upstreamPropagateTodayProjects(today, periods) {
  for (const [key, session] of Object.entries(today?.sessions || {})) {
    if (!session) continue;
    for (const period of periods) {
      const target = period?.sessions?.[key];
      if (!target) continue;
      if (session.projectId && !target.projectId) {
        target.projectId = session.projectId;
        target.projectLabel = session.projectLabel;
      }
      if (session.title && !target.title) target.title = session.title;
      if (session.sessionKind && !target.sessionKind) target.sessionKind = session.sessionKind;
      target.contextWindow = Number(session.contextWindow) || 0;
      target.contextTokens = Number(session.contextTokens) || 0;
      if (session.turnEnded === true || session.turnEnded === false) target.turnEnded = session.turnEnded;
      else delete target.turnEnded;
      if (session.startedAt && (!target.startedAt || Date.parse(session.startedAt) < Date.parse(target.startedAt))) {
        target.startedAt = session.startedAt;
      }
      if (session.lastUsedAt && (!target.lastUsedAt || Date.parse(session.lastUsedAt) > Date.parse(target.lastUsedAt))) {
        target.lastUsedAt = session.lastUsedAt;
      }
    }
  }
}

// 上游 watch tick 的等效流程：collectUsageOnce 的 anchorUsed 分支（新 today、applyPeriodDelta、
// propagateTodayProjects），再加上發佈前的 applyProjectRollups（main.js / agent.js）。
function upstreamWatchTick(anchorDir, freshDir) {
  const { applyTokscaleSessionMetadata } = up("sessionMetadata.js");
  const usage = up("usage.js");
  const anchor = upstreamSummary(anchorDir, { projectsEnabled: true });
  const json = JSON.parse(fs.readFileSync(path.join(freshDir, "today.json"), "utf8"));
  applyTokscaleSessionMetadata(json, { resolveProjects: true });
  const today = usage.extractUsageFromTokscale(json);
  const month = usage.applyPeriodDelta(anchor.month, today, anchor.today);
  const allTime = usage.applyPeriodDelta(anchor.allTime, today, anchor.today);
  upstreamPropagateTodayProjects(today, [month, allTime]);
  const summary = { today, month, allTime };
  usage.applyProjectRollups(summary);
  return plain(summary);
}

test("watch tick: anchored today + exact delta match upstream", { skip }, () => {
  const bin = agentBin();
  const fresh = path.join(root, "src-tauri", "tests", "fixtures", "tokscale", "watch");
  const [record, payload] = runAgent(bin, fresh, ["--anchor-json-dir", FIXTURE, "--json", "--payload"]);
  const theirs = upstreamWatchTick(FIXTURE, fresh);
  for (const [name] of PERIOD_FILES) {
    assertSame(plain(record[name]), withoutTitles(theirs[name]), `watch ${name}`);
  }
  // 新 session 與它的專案出現在 month / allTime，且成長量正好是 today 的成長量。
  const anchorOnly = runAgent(bin, FIXTURE, ["--json"])[0];
  for (const name of ["month", "allTime"]) {
    assert.ok(record[name].sessions["codex:x-new"], `${name} has the session that started after the anchor`);
    assert.equal(
      record[name].totalTokens - anchorOnly[name].totalTokens,
      record.today.totalTokens - anchorOnly.today.totalTokens,
      `${name} grew exactly as much as today`,
    );
  }
  const { serializeSyncPayload } = up("syncPayload.js");
  assertSame(payload, plain(serializeSyncPayload(record).payload), "watch payload");
});

// 上游 providers/codex/limits.js `normalizeCodexUsagePayload` 原文（沒有匯出，照抄當參考實作）：
// wham 回應先轉成 rateLimits / rateLimitsByLimitId，再交給 mapCodexRateLimitsToProvider。
function upstreamNormalizeCodexUsagePayload(payload = {}) {
  const byId = (p) => p.rateLimitsByLimitId || p.rate_limits_by_limit_id || {};
  const win = (w) => {
    if (!w || typeof w !== "object") return null;
    const seconds = Number(w.limitWindowSeconds ?? w.limit_window_seconds);
    return {
      ...w,
      usedPercent: w.usedPercent ?? w.used_percent,
      resetsAt: w.resetsAt ?? w.resetAt ?? w.reset_at,
      windowDurationMins: Number.isFinite(seconds) ? seconds / 60 : undefined,
    };
  };
  const rl = (rateLimit, meta = {}) => {
    const source = rateLimit && typeof rateLimit === "object" ? rateLimit : {};
    const primary = win(source.primaryWindow || source.primary_window);
    const secondary = win(source.secondaryWindow || source.secondary_window);
    return {
      ...(primary ? { primary } : {}),
      ...(secondary ? { secondary } : {}),
      ...(meta.limitId ? { limitId: meta.limitId } : {}),
      ...(meta.limitName ? { limitName: meta.limitName } : {}),
      planType: meta.planType,
    };
  };
  const hasUsageShape = ["rateLimit", "rate_limit", "additionalRateLimits", "additional_rate_limits"].some((k) => Object.hasOwn(payload, k));
  if (!hasUsageShape) return payload;
  const planType = payload.planType ?? payload.plan_type;
  const rateLimits = rl(payload.rateLimit ?? payload.rate_limit, { limitId: "codex", planType });
  const rateLimitsByLimitId = { ...byId(payload), codex: rateLimits };
  for (const entry of payload.additionalRateLimits ?? payload.additional_rate_limits ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const limitId = String(entry.meteredFeature ?? entry.metered_feature ?? "").trim();
    if (!limitId || limitId === "codex") continue;
    rateLimitsByLimitId[limitId] = rl(entry.rateLimit ?? entry.rate_limit, {
      limitId,
      limitName: String(entry.limitName ?? entry.limit_name ?? "").trim(),
      planType,
    });
  }
  return { ...payload, rateLimits, rateLimitsByLimitId };
}

test("limits: Cursor usage maps exactly like upstream", { skip }, async () => {
  const bin = agentBin();
  const dir = path.join(root, "src-tauri", "tests", "fixtures", "limits");
  const res = spawnSync(bin, ["limits", "--replay", dir], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const ours = JSON.parse(res.stdout).providers.find((p) => p.provider === "cursor");
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "cursor-usage.json"), "utf8"));
  const core = up("limits/core.js");
  const cursorLimits = require(path.join(REPO, "src", "shared", "providers", "cursor", "limits.js"));
  const cursorProbe = require(path.join(REPO, "src", "shared", "providers", "cursor", "probe.js"));
  // 同一份 API 回應交給上游 fetchCursorLimits（以 deps 注入 probe 與帳號），再經 hub 的正規化。
  const theirs = plain(
    core.normalizeLimitProvider(
      await cursorLimits.fetchCursorLimits(
        {},
        {
          now: () => Date.parse("2026-01-01T00:00:00.000Z"),
          listAccounts: () => [{ id: "user_replay", sessionToken: "replay", userId: null, label: null }],
          probe: async () => ({
            ok: true,
            usage: {
              ...cursorProbe.parseUsageSummary(raw.summary, { requestUsage: raw.requestUsage || null }),
              grokBot: raw.sand ? cursorProbe.parseGrokBotUsage(raw.sand) : null,
            },
            user: cursorProbe.parseUserInfo(raw.me),
          }),
        },
      ),
    ),
  );
  assertSame(ours.windows, theirs.windows, "cursor windows");
  for (const key of ["accountKey", "accountLabel", "accountEmail", "planLabel", "status", "source"]) {
    assert.equal(ours[key], theirs[key], `cursor ${key}`);
  }
  assertSame(ours, plain(core.normalizeLimitProvider(ours)), "cursor row is a fixed point of upstream normalization");
});

test("limits: GitHub Copilot usage maps exactly like upstream", { skip }, () => {
  const bin = agentBin();
  const dir = path.join(root, "src-tauri", "tests", "fixtures", "limits");
  const res = spawnSync(bin, ["limits", "--replay", dir], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const ours = JSON.parse(res.stdout).providers.find((p) => p.provider === "copilot");
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "copilot-usage.json"), "utf8"));
  const copilot = require(path.join(REPO, "src", "shared", "providers", "copilot", "limits.js"));
  const { hashKey } = require(path.join(REPO, "src", "shared", "hashKey.js"));
  const usage = copilot.parseCopilotUsageResponse(raw);
  const theirs = plain(
    copilot.mapCopilotUsageToProvider(usage, {
      accountKey: hashKey("copilot", "octocat"),
      accountName: "octocat",
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "api",
    }),
  );
  assertSame(ours.windows, theirs.windows, "copilot windows");
  for (const key of ["accountKey", "accountLabel", "accountName", "status", "source"]) {
    assert.equal(ours[key], theirs[key], `copilot ${key}`);
  }
});

test("limits: Claude and Codex usage map exactly like upstream", { skip }, () => {
  const bin = agentBin();
  const dir = path.join(root, "src-tauri", "tests", "fixtures", "limits");
  const res = spawnSync(bin, ["limits", "--replay", dir], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const ours = JSON.parse(res.stdout);
  const core = up("limits/core.js");
  const claudeLimits = require(path.join(REPO, "src", "shared", "providers", "claude", "limits.js"));
  const codexLimits = require(path.join(REPO, "src", "shared", "providers", "codex", "limits.js"));
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));

  // 1. 我們送出的摘要已經是上游正規化後的形狀：hub 再正規化一次也不會變。
  assertSame(ours, plain(core.normalizeLimitsSummary(ours)), "limits summary is a fixed point of upstream normalization");

  // 2. 同一份 API 回應，窗口（種類、標籤、百分比、重置時間、limitId、金額）逐欄與上游相同。
  const theirClaude = plain(core.normalizeLimitProvider({ ...claudeLimits.mapClaudeUsageToProvider(read("claude-usage.json")), status: "ok", source: "oauth" }));
  const codexPayload = upstreamNormalizeCodexUsagePayload(read("codex-usage.json"));
  const theirCodex = plain(core.normalizeLimitProvider({ ...codexLimits.mapCodexRateLimitsToProvider(codexPayload), status: "ok", source: "oauth" }));
  const byId = Object.fromEntries(ours.providers.map((p) => [p.provider, p]));
  assertSame(byId.claude.windows, theirClaude.windows, "claude windows");
  assertSame(byId.codex.windows, theirCodex.windows, "codex windows");
  assert.equal(byId.codex.accountLabel, theirCodex.accountLabel, "codex plan label");
  assert.ok(byId.claude.windows.some((w) => w.label === "Fable"), "the Fable weekly is kept");
  assert.ok(!byId.claude.windows.some((w) => w.label === "Opus"), "other scoped weeklies are dropped");
});

// 自適應額度排程的消耗速度估計：同一串觀測（上游正規化後的額度摘要、哪些 provider 是這次探測成功的、
// 提早探測的嘗試）依序交給上游 burnRate.js 與 tm-agent，每一步的「下一次提早探測」與各窗口的樣本
// （速度、基準時間）逐欄相同。涵蓋：未探測的列不當基準、暫時性失敗不取樣、速度變慢只衰減、跨過重置
// 重新取基準、金額與沒有百分比的窗口不量、最快每分鐘、嘗試的下限、同時到期、用完的窗口與修剪。
test("limits: the adaptive burn-rate schedule matches upstream step by step", { skip }, () => {
  const bin = agentBin();
  const core = up("limits/core.js");
  const burn = up("limits/burnRate.js");
  const T0 = Date.parse("2026-09-24T08:00:00.000Z");
  const MIN = 60_000;
  const iso = (ms) => new Date(ms).toISOString();
  const RESET_A = "2026-09-24T10:00:00.000Z";
  const RESET_B = "2026-09-24T15:00:00.000Z";
  const WEEK = "2026-09-30T00:00:00.000Z";
  const CLAUDE_ID = "claude:sha256:claude:dev@example.com:Max 5x";
  const claude = (at, session, { status = "ok", reset = RESET_A, weekly = 20, fable = null } = {}) => ({
    provider: "claude",
    accountKey: "sha256:claude",
    accountEmail: "dev@example.com",
    accountLabel: "Max 5x",
    status,
    updatedAt: iso(at),
    windows: [
      { kind: "session", label: "", usedPercent: session, resetsAt: reset, windowMinutes: 300 },
      { kind: "weekly", label: "", usedPercent: weekly, resetsAt: WEEK },
      { kind: "weekly", label: "Fable", additional: true, used: fable, limit: fable === null ? null : 100, resetsAt: WEEK },
    ],
  });
  const codex = (at, session) => ({
    provider: "codex",
    accountKey: "codex-key",
    accountLabel: "Pro",
    status: "ok",
    updatedAt: iso(at),
    windows: [{ kind: "session", label: "", usedPercent: session, resetsAt: RESET_A }],
  });
  const cursor = (at, used) => ({
    provider: "cursor",
    accountKey: "cursor-key",
    status: "ok",
    updatedAt: iso(at),
    windows: [
      { kind: "billing", label: "Auto", usedPercent: used, resetsAt: WEEK },
      { kind: "billing", metric: "credits", label: "On-demand", used: 12, limit: 20, resetsAt: WEEK },
    ],
  });
  const copilot = (at, used) => ({
    provider: "copilot",
    accountKey: "copilot-key",
    status: "ok",
    updatedAt: iso(at),
    windows: [{ kind: "billing", label: "Premium", usedPercent: used, resetsAt: WEEK }],
  });
  const all = ["claude", "codex", "cursor", "copilot"];
  const t = (m) => T0 + m;
  const raw = [
    // 1. 基準；Copilot 是上次留下的列（還沒探測過），不能當基準。
    { nowMs: t(0), probed: ["claude", "codex", "cursor"], providers: [claude(t(0), 40), codex(t(0), 10), cursor(t(0), 50), copilot(t(0), 30)] },
    // 2. Claude 5 分鐘用了 15%；Copilot 這次才第一次探測。
    { nowMs: t(5 * MIN), probed: all, providers: [claude(t(5 * MIN), 55, { weekly: 21, fable: 5 }), codex(t(5 * MIN), 10), cursor(t(5 * MIN), 52), copilot(t(5 * MIN), 31)] },
    // 3. 提早探測 Claude：更快了（立刻採用）；其他列沒重新探測（updatedAt 相同，不重複取樣）。
    { nowMs: t(8 * MIN + 45_000), attempt: { atMs: t(8 * MIN + 45_000), keys: [CLAUDE_ID] }, probed: ["claude"], providers: [claude(t(8 * MIN + 45_000), 70, { weekly: 22, fable: 6 }), codex(t(5 * MIN), 10), cursor(t(5 * MIN), 52), copilot(t(5 * MIN), 31)] },
    // 4. 暫時性失敗：重發 last-good，不取樣；嘗試照記。
    { nowMs: t(10 * MIN), attempt: { atMs: t(10 * MIN), keys: [CLAUDE_ID] }, probed: [], providers: [claude(t(8 * MIN + 45_000), 70, { status: "rateLimited", weekly: 22, fable: 6 }), codex(t(5 * MIN), 10), cursor(t(5 * MIN), 52), copilot(t(5 * MIN), 31)] },
    // 5. 變慢：只衰減。
    { nowMs: t(12 * MIN), probed: ["claude"], providers: [claude(t(12 * MIN), 71, { weekly: 22, fable: 6 }), codex(t(5 * MIN), 10), cursor(t(5 * MIN), 52), copilot(t(5 * MIN), 31)] },
    // 6. Claude 的 5 小時窗口重置：重新取基準、沿用速度；Cursor 不見了（修剪）。
    { nowMs: t(15 * MIN), probed: all, providers: [claude(t(15 * MIN), 3, { reset: RESET_B, weekly: 23, fable: 7 }), codex(t(15 * MIN), 60), copilot(t(15 * MIN), 31)] },
    // 7. Codex 與 Claude 同時快用完：兩個都被下限擋在同一時間。
    { nowMs: t(20 * MIN), probed: all, providers: [claude(t(20 * MIN), 90, { reset: RESET_B, weekly: 30, fable: 8 }), codex(t(20 * MIN), 99), copilot(t(20 * MIN), 31)] },
    // 8. 同時到期的提早探測：Codex 已經用完（不再提早），Claude 還在燒。
    { nowMs: t(21 * MIN), attempt: { atMs: t(21 * MIN), keys: [CLAUDE_ID, "codex:codex-key::Pro"] }, probed: ["claude", "codex"], providers: [claude(t(21 * MIN), 95, { reset: RESET_B, weekly: 31, fable: 9 }), codex(t(21 * MIN), 100), copilot(t(20 * MIN), 31)] },
  ];
  const steps = raw.map(({ providers, ...step }) => ({
    ...step,
    limits: plain(core.normalizeLimitsSummary({ updatedAt: iso(step.nowMs), refreshMs: 300_000, providers })),
  }));

  // 上游：與 limits/runtime.js 相同的呼叫順序。
  const state = burn.createLimitsBurnState();
  const theirs = steps.map((step) => {
    if (step.attempt) burn.recordLimitsUrgencyAttempt(state, step.attempt.keys, step.attempt.atMs);
    for (const row of step.limits.providers) {
      if (row.status === "ok" && step.probed.includes(row.provider)) burn.markLimitsProbeSuccess(state, row);
    }
    burn.recordLimitsSample(state, step.limits, step.nowMs);
    burn.pruneLimitsBurnState(state, step.limits);
    const due = burn.nextLimitsUrgencyRefresh(step.limits, state, step.nowMs, { baseRefreshMs: burn.LIMITS_ADAPTIVE_BASE_MS });
    return plain({
      due: due && { refreshAt: due.refreshAt, delayMs: due.delayMs, keys: due.keys, providers: due.scopes.map((s) => s.provider) },
      windows: Object.fromEntries(state.windows),
    });
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-burn-"));
  try {
    const file = path.join(dir, "steps.json");
    fs.writeFileSync(file, JSON.stringify({ steps }));
    const res = spawnSync(bin, ["limits", "--burn-replay", file], {
      encoding: "utf8",
      env: { ...process.env, TOKEN_MONITOR_CONFIG_DIR: path.join(dir, "config"), TOKEN_MONITOR_DISABLE_KEYRING: "1" },
    });
    assert.equal(res.status, 0, res.stderr);
    const ours = JSON.parse(res.stdout);
    assert.equal(ours.length, steps.length);
    ours.forEach((step, i) => assertSame(step, theirs[i], `step ${i + 1}`));
    // 這串觀測真的走到了各種情況（避免 fixture 退化成一路 null 也「相同」）。
    assert.equal(theirs[0].due, null, "a lone baseline has no rate");
    assert.ok(!Object.keys(theirs[0].windows).some((k) => k.startsWith("copilot:")), "an unprobed row is not a baseline");
    assert.ok(theirs.filter((s) => s.due).length >= 4, "several steps schedule an early probe");
    assert.ok(theirs.some((s) => s.due && s.due.keys.length === 2), "a tie keeps both providers");
    assert.ok(theirs.some((s) => s.due && s.due.delayMs > MIN), "a burn slower than the floor");
    assert.ok(!Object.keys(theirs[5].windows).some((k) => k.startsWith("cursor:")), "a provider that left is pruned");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 同一個設定目錄連跑兩次：第二次 client 已經刪掉 c-2 的紀錄。我們補回來的結果要與上游
// updateSessionUsageArchive + applySessionUsageArchive（+ applyProjectRollups）完全相同。
test("session usage archive: deleted sessions come back exactly like upstream", { skip }, () => {
  const bin = agentBin();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-archive-"));
  const trimmed = fs.mkdtempSync(path.join(os.tmpdir(), "tm-archive-fixture-"));
  try {
    for (const [, file] of PERIOD_FILES) {
      const json = JSON.parse(fs.readFileSync(path.join(FIXTURE, `${file}.json`), "utf8"));
      json.entries = (json.entries || []).filter((e) => e.sessionId !== "c-2");
      if (Array.isArray(json.sessions)) json.sessions = json.sessions.filter((s) => (s.sessionId ?? s.id) !== "c-2");
      fs.writeFileSync(path.join(trimmed, `${file}.json`), JSON.stringify(json));
    }
    const once = (dir, extra = []) => {
      const res = spawnSync(bin, ["once", "--dry-run", "--tokscale-json-dir", dir, "--json", ...extra], {
        encoding: "utf8",
        env: { ...process.env, TOKEN_MONITOR_CONFIG_DIR: configDir, TOKEN_MONITOR_DISABLE_KEYRING: "1", TOKEN_MONITOR_DEVICE_ID: "compat-device" },
      });
      assert.equal(res.status, 0, res.stderr);
      return res.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    };
    const [first] = once(FIXTURE, ["--write-archives"]);
    const [second, payload] = once(trimmed, ["--payload"]);
    assert.ok(second.allTime.sessions["claude:c-2"]?.archived, "c-2 is restored as archived");
    assert.equal(second.allTime.totalTokens, first.allTime.totalTokens, "allTime does not shrink");

    const { updateSessionUsageArchive, applySessionUsageArchive } = up("usage/sessionUsageArchive.js");
    const usage = up("usage.js");
    const raw = (dir) => upstreamSummary(dir, { projectsEnabled: true });
    let archive = updateSessionUsageArchive(null, raw(FIXTURE), new Date(first.updatedAt), { canonicalSummary: true }).archive;
    archive = updateSessionUsageArchive(archive, raw(trimmed), new Date(second.updatedAt), { canonicalSummary: true }).archive;
    const theirs = applySessionUsageArchive(raw(trimmed), archive, {
      now: new Date(second.updatedAt),
      canonical: true,
      canonicalSummary: true,
    });
    usage.applyProjectRollups(theirs);
    for (const [name] of PERIOD_FILES) {
      assertSame(plain(second[name]), withoutTitles(theirs[name]), `archive ${name}`);
    }
    const { serializeSyncPayload } = up("syncPayload.js");
    assertSame(payload, plain(serializeSyncPayload(second).payload), "archive payload");
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(trimmed, { recursive: true, force: true });
  }
});

// daily history archive：第二次的 graph 少了 30 天以前的日子（transcript 被刪），history 仍保留，
// 並與上游 captureDailyHistoryArchive → graphFromDailyHistoryArchive → normalizeHistory 完全相同。
test("daily history archive: deleted days stay in history exactly like upstream", { skip }, () => {
  const bin = agentBin();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-harchive-"));
  const full = fs.mkdtempSync(path.join(os.tmpdir(), "tm-harchive-full-"));
  const trimmed = fs.mkdtempSync(path.join(os.tmpdir(), "tm-harchive-trim-"));
  try {
    const todayKey = localTodayKey();
    const graphFull = syntheticGraph(todayKey);
    const cutoff = (() => {
      const d = new Date(`${todayKey}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 30);
      return d.toISOString().slice(0, 10);
    })();
    const graphTrimmed = {
      ...graphFull,
      contributions: graphFull.contributions.filter((c) => String(c.date).slice(0, 10) >= cutoff),
    };
    for (const [dir, graph] of [[full, graphFull], [trimmed, graphTrimmed]]) {
      for (const [, file] of PERIOD_FILES) fs.copyFileSync(path.join(FIXTURE, `${file}.json`), path.join(dir, `${file}.json`));
      fs.writeFileSync(path.join(dir, "graph.json"), JSON.stringify(graph));
    }
    // dry run 不寫 archive（上游相同）：第一次以隱藏的 --write-archives 寫進去，第二次照常 dry run。
    const once = (dir, extra = []) => {
      const res = spawnSync(bin, ["once", "--dry-run", "--tokscale-json-dir", dir, "--json", ...extra], {
        encoding: "utf8",
        env: { ...process.env, TOKEN_MONITOR_CONFIG_DIR: configDir, TOKEN_MONITOR_DISABLE_KEYRING: "1", TOKEN_MONITOR_DEVICE_ID: "compat-device" },
      });
      assert.equal(res.status, 0, res.stderr);
      return JSON.parse(res.stdout.trim().split(/\r?\n/)[0]);
    };
    const first = once(full, ["--write-archives"]);
    const second = once(trimmed);
    assert.equal(second.history.daily.length, first.history.daily.length, "no day is lost");
    assert.equal(second.history.summary.totalTokens, first.history.summary.totalTokens);

    const archiveMod = up("dailyHistoryArchive.js");
    const { normalizeHistory, parseGraphResult } = up("history.js");
    const key = second.periodWindows.today.key;
    let archive = archiveMod.captureDailyHistoryArchive(null, [graphFull], { todayKey: key });
    archive = archiveMod.captureDailyHistoryArchive(archive, [graphTrimmed], { todayKey: key });
    const rebuilt = archiveMod.graphFromDailyHistoryArchive([graphTrimmed], archive, { todayKey: key });
    const theirs = plain(normalizeHistory(parseGraphResult(rebuilt), { todayKey: key }));
    assertSame(second.history, theirs, "archived history");
  } finally {
    for (const d of [configDir, full, trimmed]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("dry run: no archive file is written (upstream dry runs have no side effects)", { skip }, () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-dry-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-dry-fixture-"));
  try {
    for (const [, file] of PERIOD_FILES) fs.copyFileSync(path.join(FIXTURE, `${file}.json`), path.join(dir, `${file}.json`));
    fs.writeFileSync(path.join(dir, "graph.json"), JSON.stringify(syntheticGraph(localTodayKey())));
    const res = spawnSync(agentBin(), ["once", "--dry-run", "--tokscale-json-dir", dir, "--json"], {
      encoding: "utf8",
      env: { ...process.env, TOKEN_MONITOR_CONFIG_DIR: configDir, TOKEN_MONITOR_DISABLE_KEYRING: "1", TOKEN_MONITOR_DEVICE_ID: "compat-device" },
    });
    assert.equal(res.status, 0, res.stderr);
    const [record] = res.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.ok(record.history, "history is still produced");
    const files = fs.readdirSync(configDir);
    assert.ok(!files.some((f) => f.startsWith("session-usage-archive")), `no session archive: ${files}`);
    assert.ok(!files.includes("daily-history-archive.json"), `no history archive: ${files}`);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("projects disabled: no project metadata leaves the device", { skip }, () => {
  const bin = agentBin();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-compat-"));
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({ deviceId: "compat-device", projectsEnabled: false }));
  const res = spawnSync(bin, ["once", "--dry-run", "--tokscale-json-dir", FIXTURE, "--json", "--payload"], {
    encoding: "utf8",
    env: { ...process.env, TOKEN_MONITOR_CONFIG_DIR: configDir, TOKEN_MONITOR_DISABLE_KEYRING: "1" },
  });
  assert.equal(res.status, 0, res.stderr);
  const [record, payload] = res.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
  const theirs = upstreamSummary(FIXTURE, { projectsEnabled: false });
  for (const [name] of PERIOD_FILES) {
    assertSame(plain(record[name]), withoutTitles(theirs[name]), `projects=false period ${name}`);
  }
  const { serializeSyncPayload } = up("syncPayload.js");
  assertSame(payload, plain(serializeSyncPayload(record).payload), "projects=false payload");
  const text = JSON.stringify(payload);
  assert.ok(!text.includes('"projectId"'), "no projectId in payload");
});

test("live tokscale scan matches upstream (TM_COMPAT_LIVE=1)", { skip: skip || (process.env.TM_COMPAT_LIVE !== "1" && "set TM_COMPAT_LIVE=1") }, () => {
  const bin = agentBin();
  const tokscale =
    process.env.TOKSCALE_BIN ||
    path.join(REPO, "node_modules", "@tokscale", "cli-win32-x64-msvc", "bin", "tokscale.exe");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-live-"));
  const clients = "claude,codex,copilot,cursor";
  for (const [flags, file] of [
    [["--today"], "today"],
    [["--month"], "month"],
    [["--since", "2024-01-01"], "alltime"],
  ]) {
    const res = spawnSync(tokscale, ["--json", "--client", clients, "--group-by", "client,workspace,session,model", ...flags], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    assert.equal(res.status, 0, res.stderr);
    fs.writeFileSync(path.join(dir, `${file}.json`), res.stdout);
  }
  const graph = spawnSync(tokscale, ["graph", "--client", clients, "--no-spinner"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  assert.equal(graph.status, 0, graph.stderr);
  fs.writeFileSync(path.join(dir, "graph.json"), graph.stdout);
  try {
    checkDirectory(bin, dir, "live");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
