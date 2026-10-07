// 端對端：tm-agent 上傳到 monorepo 根目錄的 overlay hub（根目錄的 hub/，client 金鑰 + PGlite（行程內的 PostgreSQL）持久化），
// 確認 hub 收下、分級權限生效、每日用量表（報表用）寫得出來。
//
// 用 overlay 自己的測試 helper（根目錄的 tests/helpers/overlayHub.js）在同一個程序裡起 hub，
// 所以 tm-agent 必須以非同步方式執行（spawnSync 會卡住 hub 的 event loop）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CUSTOM, root } from "./repos.mjs";

const run = promisify(execFile);
const helper = path.join(CUSTOM, "tests", "helpers", "overlayHub.js");
const skip = fs.existsSync(helper) ? false : `overlay hub helper not found at ${helper} (set TOKEN_MONITOR_CUSTOM)`;
const require = createRequire(import.meta.url);
const FIXTURE = path.join(root, "src-tauri", "tests", "fixtures", "tokscale", "basic");

function agentBin() {
  if (process.env.TM_AGENT_BIN) return process.env.TM_AGENT_BIN;
  const build = spawnSync(
    "cargo",
    ["build", "--manifest-path", path.join(root, "src-tauri", "Cargo.toml"), "--no-default-features", "--bin", "tm-agent"],
    { stdio: "inherit" },
  );
  assert.equal(build.status, 0, "cargo build tm-agent failed");
  return path.join(root, "src-tauri", "target", "debug", process.platform === "win32" ? "tm-agent.exe" : "tm-agent");
}

async function agent(bin, args, env) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-e2e-"));
  try {
    const { stdout, stderr } = await run(bin, args, {
      env: { ...process.env, TOKEN_MONITOR_CONFIG_DIR: configDir, TOKEN_MONITOR_DISABLE_KEYRING: "1", ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

test("tm-agent uploads to the fork overlay hub with a client key", { skip }, async () => {
  const bin = agentBin();
  const { startOverlayHub, removeAll, bearer } = require(helper);
  const hub = await startOverlayHub({ clientSecrets: ["client-e2e-key"], database: true });
  try {
    const env = { TOKEN_MONITOR_HUB_URL: hub.base, TOKEN_MONITOR_SECRET: "client-e2e-key", TOKEN_MONITOR_DEVICE_ID: "e2e-device" };
    const ok = await agent(bin, ["once", "--tokscale-json-dir", FIXTURE, "--json"], env);
    assert.equal(ok.code, 0, ok.stderr);
    const record = JSON.parse(ok.stdout.trim().split(/\r?\n/)[0]);
    await hub.settle();

    const res = await fetch(`${hub.base}/api/devices`, { headers: bearer("client-e2e-key") });
    assert.equal(res.status, 200);
    const body = await res.json();
    const device = (body.devices || body).find((d) => d.deviceId === "e2e-device");
    assert.ok(device, "device is listed");
    assert.equal(device.agentRuntime, "tauri-agent");
    assert.equal(device.syncUploadIntervalMs, 600000);
    assert.equal(device.periods.month.totalTokens, record.month.totalTokens);

    // client 金鑰不能刪裝置（overlay 的 hub/access.js）
    const del = await fetch(`${hub.base}/api/devices/e2e-device`, { method: "DELETE", headers: bearer("client-e2e-key") });
    assert.equal(del.status, 403);

    // 錯的金鑰 → exit 3
    const bad = await agent(bin, ["once", "--tokscale-json-dir", FIXTURE], { ...env, TOKEN_MONITOR_SECRET: "wrong-key" });
    assert.equal(bad.code, 3, bad.stderr);
    assert.match(bad.stderr, /ERR_HUB_UNAUTHORIZED/);

    // hub 把我們的 record 拆成每日用量列（報表用）
    const store = hub.overlay.persistence.store;
    const [day] = await store.query(
      "SELECT usage_date, tokens, cost_usd, source FROM device_daily_usage WHERE device_id = $1",
      ["e2e-device"],
    );
    assert.ok(day, "daily row written");
    assert.equal(day.usage_date, record.periodWindows.today.key);
    assert.equal(Number(day.tokens), record.today.totalTokens);
    assert.equal(day.source, "live");
    const clients = await store.query(
      "SELECT client, tokens FROM device_daily_client_usage WHERE device_id = $1 ORDER BY client",
      ["e2e-device"],
    );
    assert.deepEqual(
      Object.fromEntries(clients.map((c) => [c.client, Number(c.tokens)])),
      record.today.clients,
    );
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

test("the reported work email assigns the device to its employee on the fork hub", { skip }, async () => {
  const bin = agentBin();
  const { startOverlayHub, removeAll, bearer } = require(helper);
  const { announcement } = require(path.join(CUSTOM, "tests", "helpers", "xlsx.js"));
  const hub = await startOverlayHub({ clientSecrets: ["client-e2e-key"], database: true });
  try {
    const env = {
      TOKEN_MONITOR_HUB_URL: hub.base,
      TOKEN_MONITOR_SECRET: "client-e2e-key",
      TOKEN_MONITOR_DEVICE_ID: "e2e-owner",
      TOKEN_MONITOR_OWNER_EMAIL: " Someone@Example.test ",
    };
    const ok = await agent(bin, ["once", "--tokscale-json-dir", FIXTURE, "--payload"], env);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout.trim().split(/\r?\n/)[0]).ownerEmail, "someone@example.test", "sent lower-cased");
    await hub.settle();

    // 公司的人事公告（合成的，不含真實資料）匯入後，hub 依回報的信箱把裝置歸給這位員工。
    const workbook = announcement([{ no: "ACME-1", en: "Someone", department: "Aurora", team: "3D Team", email: "someone@example.test" }]);
    const imported = await fetch(`${hub.base}/api/admin/org/import?company=ACME`, {
      method: "POST",
      headers: { ...bearer("admin-secret"), "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      body: workbook,
    });
    const summary = await imported.json();
    assert.equal(imported.status, 200, JSON.stringify(summary));
    assert.equal(summary.reconciled.assigned, 1);

    const owners = await (await fetch(`${hub.base}/api/admin/owners?deviceId=e2e-owner`, { headers: bearer("admin-secret") })).json();
    assert.equal(owners.owners[0].employeeId, "ACME-1");
    // 人事公告沒填 BU 時，部門直接掛在公司下：ACME/-/<部門>（overlay 的 hub/org.js）。
    assert.equal(owners.owners[0].unitId, "ACME/-/Aurora/3D Team");
    assert.equal(owners.owners[0].unitLevel, "team");
    assert.equal(owners.owners[0].updatedBy, "auto:reported");
    const unit = await (await fetch(`${hub.base}/api/stats?org=ACME`, { headers: bearer("client-e2e-key") })).json();
    assert.deepEqual(unit.devices.map((d) => d.deviceId), ["e2e-owner"]);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

function dayBefore(key, back) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

test("history reaches the hub: /api/history and persisted history rows", { skip }, async () => {
  const bin = agentBin();
  const { startOverlayHub, removeAll, bearer } = require(helper);
  const hub = await startOverlayHub({ clientSecrets: ["client-e2e-key"], database: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-e2e-history-"));
  try {
    for (const f of ["today.json", "month.json", "alltime.json"]) fs.copyFileSync(path.join(FIXTURE, f), path.join(dir, f));
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const row = (date, input) => ({
      date,
      clients: [{ client: "claude", modelId: "claude-opus-5", tokens: { input, output: 10, cacheRead: 100, cacheWrite: 5 }, cost: 1.25, messages: 4 }],
      activeTimeMs: 60000,
    });
    const yesterday = dayBefore(todayKey, 1);
    fs.writeFileSync(
      path.join(dir, "graph.json"),
      JSON.stringify({ contributions: [row(dayBefore(todayKey, 40), 7), row(yesterday, 1000)] }),
    );
    const env = { TOKEN_MONITOR_HUB_URL: hub.base, TOKEN_MONITOR_SECRET: "client-e2e-key", TOKEN_MONITOR_DEVICE_ID: "e2e-history" };
    const ok = await agent(bin, ["once", "--tokscale-json-dir", dir, "--json"], env);
    assert.equal(ok.code, 0, ok.stderr);
    const record = JSON.parse(ok.stdout.trim().split(/\r?\n/)[0]);
    assert.equal(record.history.daily.length, 2);
    await hub.settle();

    const res = await fetch(`${hub.base}/api/history`, { headers: bearer("client-e2e-key") });
    assert.equal(res.status, 200);
    const history = await res.json();
    const day = history.daily.find((d) => d.date === yesterday);
    assert.ok(day, "yesterday is in the company history");
    assert.equal(day.tokens, 1115);
    assert.equal(day.perClient.claude.messages, 4);

    const [persisted] = await hub.overlay.persistence.store.query(
      "SELECT tokens, source FROM device_daily_usage WHERE device_id = $1 AND usage_date = $2",
      ["e2e-history", yesterday],
    );
    assert.ok(persisted, "history row persisted for daily usage reports");
    assert.equal(Number(persisted.tokens), 1115);
    assert.equal(persisted.source, "history");
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
