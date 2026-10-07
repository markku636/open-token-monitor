// session 逐回合明細的相容測試：同一份 Claude Code / Codex transcript，分別交給上游的
// src/shared/sessionDetail.js `readSessionDetail` 與 `tm-agent session-detail`，比對分組、每一輪的
// token、工具與分攤的成本。
//
// TM_COMPAT_LIVE=1 另外拿這台電腦上最近的幾份真的 transcript 各比一次（只讀，不寫任何檔）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO, root } from "./repos.mjs";

const hasRepo = fs.existsSync(path.join(REPO, "src", "shared", "sessionDetail.js"));
const skip = hasRepo ? false : `upstream checkout not found at ${REPO} (set TOKEN_MONITOR_REPO)`;
const require = createRequire(import.meta.url);

function agentBin() {
  if (process.env.TM_AGENT_BIN) return process.env.TM_AGENT_BIN;
  const exe = process.platform === "win32" ? "tm-agent.exe" : "tm-agent";
  const build = spawnSync(
    "cargo",
    ["build", "--manifest-path", path.join(root, "src-tauri", "Cargo.toml"), "--no-default-features", "--bin", "tm-agent"],
    { stdio: "inherit" },
  );
  assert.equal(build.status, 0, "cargo build tm-agent failed");
  return path.join(root, "src-tauri", "target", "debug", exe);
}

function ours(client, sessionId, { cost = 0, period = "total", env = {} } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-sdetail-cfg-"));
  try {
    const res = spawnSync(agentBin(), ["session-detail", client, sessionId, "--period", period, "--cost", String(cost)], {
      encoding: "utf8",
      env: { ...process.env, TOKEN_MONITOR_CONFIG_DIR: configDir, TOKEN_MONITOR_DISABLE_KEYRING: "1", ...env },
    });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

function upstream(client, sessionId, { cost = 0, period = "total", env = process.env, home = os.homedir() } = {}) {
  const { readSessionDetail } = require(path.join(REPO, "src", "shared", "sessionDetail.js"));
  return readSessionDetail({ client, sessionId, period, sessionCost: cost, home, env });
}

const round = (n) => Math.round(Number(n) * 1e9) / 1e9;
const tok = (t) => ({
  input: t.input,
  output: t.output,
  cacheRead: t.cacheRead,
  cacheWrite: t.cacheWrite,
  reasoning: t.reasoning,
  total: t.total,
});

/** 兩邊共同的欄位（上游另有 tokensAvailable、totals 包成物件）。 */
function shape(detail) {
  return {
    found: detail.found,
    exchanges: detail.exchanges.map((e) => ({
      promptPreview: e.promptPreview,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      turnCount: e.turnCount,
      tools: e.tools,
      tokens: tok(e.tokens),
      costEstimate: round(e.costEstimate),
      turns: e.turns.map((t) => ({ timestamp: t.timestamp, tokens: tok(t.tokens), tools: t.tools, costEstimate: round(t.costEstimate) })),
    })),
  };
}

const line = (o) => JSON.stringify(o);

function claudeFixture() {
  const usage = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
  return [
    line({ type: "user", uuid: "u0", timestamp: "2026-09-20T01:00:00.000Z", message: { content: "<command-name>/clear</command-name>" } }),
    line({ type: "user", uuid: "u1", timestamp: "2026-09-20T01:00:01.000Z", message: { content: "修一下 [Image: source: C:/x.png] 這個 bug [Image #1]" } }),
    line({ type: "assistant", uuid: "a1", timestamp: "2026-09-20T01:00:05.000Z", message: { id: "m1", usage: usage(10, 5, 100, 20), content: [{ type: "thinking" }] } }),
    // 同一個回覆拆成第二行：token 不重算，工具合併。
    line({ type: "assistant", uuid: "a1b", timestamp: "2026-09-20T01:00:06.000Z", message: { id: "m1", usage: usage(10, 5, 100, 20), content: [{ type: "tool_use", name: "Bash" }] } }),
    line({ type: "user", uuid: "u2", timestamp: "2026-09-20T01:00:07.000Z", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    line({ type: "assistant", uuid: "a2", timestamp: "2026-09-20T01:00:09.000Z", message: { id: "m2", usage: usage(3, 40, 150, 0), content: [{ type: "tool_use", name: "Edit" }, { type: "tool_use", name: "Bash" }] } }),
    // 續接時重放的舊行（相同 uuid）要略過。
    line({ type: "assistant", uuid: "a2", timestamp: "2026-09-20T01:00:09.000Z", message: { id: "m2", usage: usage(3, 40, 150, 0), content: [] } }),
    line({ type: "user", uuid: "u3", timestamp: "2026-09-21T02:00:00.000Z", message: { content: [{ type: "image" }, { type: "text", text: "[Image: source: C:/y.png]" }] } }),
    line({ type: "assistant", uuid: "a3", timestamp: "2026-09-21T02:00:03.000Z", message: { id: "m3", usage: usage(1, 2, 3, 4), content: [] } }),
    "not json",
    line({ type: "user", uuid: "u4", timestamp: "2026-09-21T02:10:00.000Z", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
  ].join("\n");
}

function codexFixture() {
  const tc = (i, cached, o, r) => ({ type: "event_msg", timestamp: "", payload: { type: "token_count", info: { last_token_usage: { input_tokens: i, cached_input_tokens: cached, output_tokens: o, reasoning_output_tokens: r } } } });
  const rows = [
    { type: "session_meta", timestamp: "2026-09-22T08:00:00.000Z", payload: {} },
    { type: "response_item", timestamp: "2026-09-22T08:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# Context from my IDE\n\n## My request for Codex:\n加上測試" }] } },
    { type: "event_msg", timestamp: "2026-09-22T08:00:01.000Z", payload: { type: "user_message", message: "# Context from my IDE\n\n## My request for Codex:\n加上測試" } },
    { type: "response_item", timestamp: "2026-09-22T08:00:02.000Z", payload: { type: "function_call", name: "shell" } },
    { type: "event_msg", timestamp: "2026-09-22T08:00:03.000Z", payload: { type: "mcp_tool_call_end", tool_name: "github" } },
    { ...tc(1200, 1000, 300, 120), timestamp: "2026-09-22T08:00:04.000Z" },
    { ...tc(0, 0, 0, 0), timestamp: "2026-09-22T08:00:05.000Z" },
    { type: "event_msg", timestamp: "2026-09-22T08:00:06.000Z", payload: { type: "token_count", info: null } },
    { type: "event_msg", timestamp: "2026-09-22T09:00:00.000Z", payload: { type: "user_message", message: "看圖", images: ["a", "b"] } },
    { type: "response_item", timestamp: "2026-09-22T09:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_image" }, { type: "input_image" }, { type: "input_text", text: "看圖" }] } },
    { ...tc(500, 100, 50, 0), timestamp: "2026-09-22T09:00:02.000Z" },
    { type: "response_item", timestamp: "2026-09-22T09:10:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "AGENTS.md instructions" }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["context.agents"] } } },
    { ...tc(10, 0, 5, 0), timestamp: "2026-09-22T09:10:01.000Z" },
  ];
  return rows.map(line).join("\n");
}

test("session detail: Claude and Codex transcripts match upstream", { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-sdetail-"));
  try {
    const claudeDir = path.join(dir, "claude");
    const codexHome = path.join(dir, "codex");
    const claudeId = "0199a1b2-c3d4-4e5f-8a9b-000000000001";
    const codexId = "rollout-2026-09-22T08-00-00-0199a1b2-c3d4-7e5f-8a9b-000000000002";
    fs.mkdirSync(path.join(claudeDir, "projects", "D--projects-demo"), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "projects", "D--projects-demo", `${claudeId}.jsonl`), claudeFixture());
    fs.mkdirSync(path.join(codexHome, "sessions", "2026", "09", "22"), { recursive: true });
    fs.writeFileSync(path.join(codexHome, "sessions", "2026", "09", "22", `${codexId}.jsonl`), codexFixture());
    const env = { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome };
    for (const [client, id, cost] of [
      ["claude", claudeId, 1.25],
      ["codex", codexId, 0.5],
    ]) {
      const a = shape(ours(client, id, { cost, env }));
      const b = shape(upstream(client, id, { cost, env: { ...process.env, ...env } }));
      assert.ok(b.found && b.exchanges.length > 0, `${client}: upstream found the fixture`);
      assert.deepEqual(a, b, `${client} detail differs from upstream`);
    }
    // 找不到檔案、不安全的 id：兩邊都回 found=false。
    assert.equal(ours("claude", "missing-id", { env }).found, false);
    assert.equal(ours("codex", "..", { env }).found, false);
    assert.equal(upstream("codex", "..", { env: { ...process.env, ...env } }).found, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function newestJsonl(rootDir, limit) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push({ p, m: fs.statSync(p).mtimeMs });
    }
  };
  walk(rootDir, 0);
  return out.sort((a, b) => b.m - a.m).slice(0, limit).map((x) => path.basename(x.p, ".jsonl"));
}

test("session detail: live transcripts on this PC match upstream (TM_COMPAT_LIVE=1)", { skip: skip || (process.env.TM_COMPAT_LIVE !== "1" && "set TM_COMPAT_LIVE=1") }, () => {
  const home = os.homedir();
  const claudeRoot = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "projects");
  const codexRoot = path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "sessions");
  let compared = 0;
  for (const [client, rootDir] of [
    ["claude", claudeRoot],
    ["codex", codexRoot],
  ]) {
    for (const id of newestJsonl(rootDir, 5)) {
      for (const period of ["total", "today", "month"]) {
        const a = shape(ours(client, id, { cost: 3.5, period }));
        const b = shape(upstream(client, id, { cost: 3.5, period }));
        assert.deepEqual(a, b, `${client} ${id} ${period} differs from upstream`);
        compared += 1;
      }
    }
  }
  assert.ok(compared > 0, "no local transcripts to compare");
});
