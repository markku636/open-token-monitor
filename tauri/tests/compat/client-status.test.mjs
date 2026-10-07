// clientStatus 的相容測試：同一組資料夾，分別交給上游 src/shared/collector.js 的
// `deriveClientStatus`（`clientSourceRoots` + `sourceRootExists`）與 `tm-agent once`，比對每個工具是
// active / waiting / missing。
//
// 只比來源位置能用環境變數整個搬到暫存目錄的工具（Claude、Codex、Hermes、OpenCode）：Copilot 的
// `~/.copilot` 在上游跟 USERPROFILE、在 tm-agent 跟 Windows 的使用者設定檔 API，兩邊沒辦法指到同一個
// 假 home，這台電腦上真的 Copilot 資料會讓結果不穩定；它的規則由 Rust 的單元測試守著。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = path.resolve(process.env.TOKEN_MONITOR_REPO || path.join(root, "..", "token-monitor"));
const hasRepo = fs.existsSync(path.join(REPO, "src", "shared", "collector.js"));
const skip = hasRepo ? false : `upstream checkout not found at ${REPO} (set TOKEN_MONITOR_REPO)`;
const require = createRequire(import.meta.url);

const CLIENTS = ["claude", "codex", "hermes", "opencode"];

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

// 每個工具的資料都搬到 `base` 底下；這些資料夾一開始都不存在或是空的。
function sandboxEnv(base) {
  return {
    CLAUDE_CONFIG_DIR: path.join(base, "claude"),
    CODEX_HOME: path.join(base, "codex"),
    TOKSCALE_HEADLESS_DIR: path.join(base, "headless"),
    HERMES_HOME: path.join(base, "hermes"),
    XDG_DATA_HOME: path.join(base, "xdg"),
  };
}

function ours(bin, env, customScanPaths) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-status-cfg-"));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "tm-status-empty-"));
  try {
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({ trackedClients: CLIENTS, customScanPaths }),
    );
    const res = spawnSync(bin, ["once", "--dry-run", "--tokscale-json-dir", fixture, "--json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        TOKEN_MONITOR_CONFIG_DIR: configDir,
        TOKEN_MONITOR_DISABLE_KEYRING: "1",
        TOKEN_MONITOR_DEVICE_ID: "compat-device",
      },
    });
    assert.equal(res.status, 0, `tm-agent failed: ${res.stderr}`);
    const record = JSON.parse(res.stdout.trim().split(/\r?\n/)[0]);
    return record.clientStatus;
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

function upstream(env, customScanPaths) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const { deriveClientStatus } = require(path.join(REPO, "src", "shared", "collector.js"));
    return deriveClientStatus(CLIENTS.join(","), { clients: {} }, { customScanPaths });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("clientStatus: source roots and presence match upstream", { skip }, () => {
  const bin = agentBin();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tm-status-src-"));
  try {
    const env = sandboxEnv(base);
    const custom = path.join(base, "claude-extra");
    const customScanPaths = { claude: [custom] };
    const compare = (label, want) => {
      const theirs = upstream(env, customScanPaths);
      assert.deepEqual(theirs, want, `${label}: upstream`);
      assert.deepEqual(ours(bin, env, customScanPaths), theirs, `${label}: tm-agent`);
    };

    // 1. 什麼都沒有：全部 missing（Claude 的設定目錄存在但沒有 projects / transcripts 也一樣）。
    fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
    fs.mkdirSync(env.CODEX_HOME, { recursive: true });
    fs.mkdirSync(env.TOKSCALE_HEADLESS_DIR, { recursive: true });
    compare("nothing installed", { claude: "missing", codex: "missing", hermes: "missing", opencode: "missing" });

    // 2. 每個工具各以一個「新的」來源出現：額外掃描目錄、headless 擷取目錄、還沒有 state.db 的
    //    Hermes home、OpenCode 的資料目錄。
    fs.mkdirSync(custom, { recursive: true });
    fs.mkdirSync(path.join(env.TOKSCALE_HEADLESS_DIR, "codex"), { recursive: true });
    fs.mkdirSync(env.HERMES_HOME, { recursive: true });
    fs.mkdirSync(path.join(env.XDG_DATA_HOME, "opencode"), { recursive: true });
    compare("each tool through its new source", {
      claude: "waiting",
      codex: "waiting",
      hermes: "waiting",
      opencode: "waiting",
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
