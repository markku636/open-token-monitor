// proxy 環境變數的相容測試：同一組環境變數與網址，分別交給上游 src/shared/outboundFetch.js 的
// `resolveProxyConfig` + undici `EnvHttpProxyAgent`（上游 createOutboundFetch 用的就是它）與
// `tm-agent proxy --json`，比對每個網址是直連、走哪個 proxy，還是因為設定錯誤整個擋下。
//
// 只比有設 proxy 環境變數的情況：沒設時 Windows 會查系統 proxy，結果看這台電腦的設定。
// Windows 的環境變數不分大小寫，所以一個案例裡同一個變數只給一種大小寫（小寫優先的規則在 Rust 單元測試）。

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
const hasRepo =
  fs.existsSync(path.join(REPO, "src", "shared", "outboundFetch.js")) &&
  fs.existsSync(path.join(REPO, "node_modules", "undici", "lib", "core", "symbols.js"));
const skip = hasRepo ? false : `upstream checkout with node_modules not found at ${REPO} (set TOKEN_MONITOR_REPO)`;
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

const PROXY_VAR = /^(http|https|all|no)_proxy$/i;

function ours(bin, vars, urls) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-proxy-cfg-"));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !PROXY_VAR.test(k)));
    const res = spawnSync(bin, ["proxy", "--json", ...urls], {
      encoding: "utf8",
      env: { ...env, ...vars, TOKEN_MONITOR_CONFIG_DIR: configDir, TOKEN_MONITOR_DISABLE_KEYRING: "1" },
    });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout).map((row) => (row.route === "proxy" ? row.proxy : row.route));
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

const origin = (href) => {
  const u = new URL(href);
  return `${u.protocol}//${u.host}`;
};

// 上游：createOutboundFetch → new EnvHttpProxyAgent(resolveProxyConfig(env))；建構丟錯就是整個不能用。
// 以替換三個內部 agent 的 dispatch 看它把請求交給哪一個。
function upstream(vars, urls) {
  const { resolveProxyConfig } = require(path.join(REPO, "src", "shared", "outboundFetch.js"));
  const { EnvHttpProxyAgent } = require(path.join(REPO, "node_modules", "undici"));
  const sym = require(path.join(REPO, "node_modules", "undici", "lib", "core", "symbols.js"));
  const cfg = resolveProxyConfig(vars);
  assert.ok(cfg.httpProxy || cfg.httpsProxy, "only cases with a proxy env are comparable");
  let agent;
  try {
    agent = new EnvHttpProxyAgent(cfg);
  } catch {
    return urls.map(() => "blocked");
  }
  const none = agent[sym.kNoProxyAgent];
  const http = agent[sym.kHttpProxyAgent];
  const https = agent[sym.kHttpsProxyAgent];
  none.dispatch = () => "direct";
  if (http !== none) http.dispatch = () => origin(cfg.httpProxy);
  if (https !== http && https !== none) https.dispatch = () => origin(cfg.httpsProxy);
  try {
    return urls.map((url) => agent[sym.kDispatch]({ origin: new URL(url).origin, path: "/", method: "GET" }, {}));
  } finally {
    void agent.close().catch(() => {});
  }
}

const URLS = [
  "https://api.anthropic.com/api/oauth/usage",
  "https://chatgpt.com/backend-api/wham/usage",
  "http://hub.corp.example:17321/api/ingest",
  "https://hub.corp.example/api/stats/stream",
  "https://corp.example/",
  "https://notcorp.example/",
  "http://localhost:17321/api/health",
  "http://localhost:8080/",
  "https://api.github.com/copilot_internal/user",
  "https://x.api.github.com/",
  "https://10.0.0.5:8443/",
  "https://10.0.0.5/",
  "http://[::1]:9000/",
];

const CASES = [
  { name: "https proxy only", vars: { HTTPS_PROXY: "http://secure.proxy:8443" } },
  { name: "http proxy covers https", vars: { HTTP_PROXY: "http://web.proxy:3128" } },
  { name: "ALL_PROXY fallback", vars: { ALL_PROXY: "http://all.proxy:1080" } },
  { name: "lowercase names", vars: { https_proxy: "http://lower.proxy:8080", no_proxy: "chatgpt.com" } },
  { name: "quoted values", vars: { HTTPS_PROXY: "'http://quoted.proxy:8080'", NO_PROXY: '"api.github.com"' } },
  {
    name: "separate proxies with NO_PROXY",
    vars: {
      HTTP_PROXY: "http://h.proxy:1",
      HTTPS_PROXY: "https://s.proxy:443",
      NO_PROXY: ".corp.example, localhost:17321 api.github.com,10.0.0.5:8443,[::1]",
    },
  },
  { name: "NO_PROXY wildcard", vars: { HTTPS_PROXY: "http://p:8080", NO_PROXY: "*" } },
  { name: "wildcard among others", vars: { HTTPS_PROXY: "http://p:8080", NO_PROXY: "*, *.corp.example" } },
  { name: "default port", vars: { HTTP_PROXY: "http://p:80", NO_PROXY: "localhost:80" } },
  { name: "scheme-less proxy fails closed", vars: { HTTPS_PROXY: "proxy.corp:8080" } },
  { name: "socks proxy fails closed", vars: { ALL_PROXY: "socks5://127.0.0.1:1080" } },
  { name: "bad http proxy blocks https too", vars: { HTTP_PROXY: "not a url", HTTPS_PROXY: "http://s:1" } },
];

test("proxy env routing matches upstream EnvHttpProxyAgent", { skip }, () => {
  const bin = agentBin();
  for (const { name, vars } of CASES) {
    assert.deepEqual(ours(bin, vars, URLS), upstream(vars, URLS), name);
  }
});
