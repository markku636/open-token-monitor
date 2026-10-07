'use strict';

// hub/server.js duplicates the CLI bootstrap of src/hub/server.js (the
// `require.main === module` block), because that block calls its local
// createHub() directly and cannot be reused. These tests notice when upstream
// changes it, and check that the copy actually boots as a process.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const { ROOT, upstream } = require('../upstream');

const UPSTREAM = upstream('src/hub/server.js');
const OVERLAY = path.join(ROOT, 'hub', 'server.js');

// The trimmed, non-blank lines of a file's top-level `if (require.main ===
// module) { … }` block, which ends at the first column-0 `}` after it.
function bootstrapBlock(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith('if (require.main === module)'));
  assert.notEqual(start, -1, `${file} has no require.main block`);
  const end = lines.findIndex((line, index) => index > start && line.trimEnd() === '}');
  assert.notEqual(end, -1, `${file}: unterminated require.main block`);
  return lines.slice(start, end + 1).map((line) => line.trim()).filter(Boolean);
}

test('the overlay bootstrap keeps every line of the upstream one, in order', () => {
  // Upstream's block is the reference. The overlay may add lines between them
  // (the dashboard log line, the signal handlers) but must keep every upstream
  // statement verbatim, so a renamed flag, a changed default, a new env var or a
  // new createHub() option fails here instead of leaving a hub that quietly
  // ignores a setting `npm run hub` honours.
  const upstream = bootstrapBlock(UPSTREAM).map((line) => line.replace(/\bcreateHub\(/g, 'createDashboardHub('));
  const overlay = bootstrapBlock(OVERLAY);
  assert.ok(upstream.length >= 10, 'upstream bootstrap was not recognised');
  let cursor = 0;
  for (const line of upstream) {
    const at = overlay.indexOf(line, cursor);
    assert.notEqual(at, -1, `upstream bootstrap line is missing from hub/server.js (or out of order):\n  ${line}`);
    cursor = at + 1;
  }
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// The hub reads the repo's .env, and dotenv leaves a variable that is already
// set alone, even when it is empty. Blanking the overlay's own settings keeps a
// developer's .env (a database, a keyless dashboard) out of this test.
const NO_OVERLAY_SETTINGS = Object.freeze(Object.fromEntries([
  'TOKEN_MONITOR_CLIENT_SECRETS',
  'TOKEN_MONITOR_CLIENT_DOWNLOAD_URL',
  'TOKEN_MONITOR_PUBLIC_DASHBOARD',
  'TOKEN_MONITOR_TRUST_PROXY',
  'TOKEN_MONITOR_DATABASE_URL',
  'TOKEN_MONITOR_DATABASE_SCHEMA'
].map((name) => [name, ''])));

async function startOverlayHub(extraArgs = []) {
  const port = await freePort();
  const dataFile = path.join(os.tmpdir(), `tm-custom-boot-${process.pid}-${port}.json`);
  const child = spawn(process.execPath, [
    OVERLAY, '--port', String(port), '--host', '127.0.0.1', '--secret', 'spawned', '--dataFile', dataFile, ...extraArgs
  ], { cwd: ROOT, env: { ...process.env, ...NO_OVERLAY_SETTINGS }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));

  const deadline = Date.now() + 15000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
    } catch (_) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!ready) {
    // Kill it before failing, or a hub that came up late keeps the runner alive.
    if (child.exitCode === null) child.kill();
    await exited;
    fs.rmSync(dataFile, { force: true });
    assert.fail(`hub did not come up:\n${output}`);
  }

  return {
    port,
    child,
    exited,
    output: () => output,
    async cleanup() {
      if (child.exitCode === null) child.kill();
      await exited;
      fs.rmSync(dataFile, { force: true });
    }
  };
}

test('node hub/server.js boots the upstream hub with the dashboard in front', async () => {
  const hub = await startOverlayHub();
  try {
    const page = await fetch(`http://127.0.0.1:${hub.port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Token Monitor Hub<\/title>/);
    const stats = await fetch(`http://127.0.0.1:${hub.port}/api/stats`);
    assert.equal(stats.status, 401, 'the CLI secret must gate the data routes');
    assert.match(hub.output(), new RegExp(`Dashboard: http://127\\.0\\.0\\.1:${hub.port}/`));
  } finally {
    await hub.cleanup();
  }
});

test('SIGTERM stops the hub promptly with exit code 0', {
  skip: process.platform === 'win32' && 'signals are not delivered to child processes on Windows'
}, async () => {
  const hub = await startOverlayHub();
  try {
    // An open stream would otherwise keep the server's close() waiting; the
    // handler ends every SSE client first and races a deadline on top.
    const controller = new AbortController();
    const stream = fetch(`http://127.0.0.1:${hub.port}/api/stats/stream`, {
      headers: { authorization: 'Bearer spawned' },
      signal: controller.signal
    });
    await Promise.race([stream, new Promise((resolve) => setTimeout(resolve, 500))]);

    const started = Date.now();
    hub.child.kill('SIGTERM');
    const { code } = await hub.exited;
    controller.abort();
    assert.equal(code, 0);
    // Well under the handler's own 5 s deadline: this proves hub.stop() itself
    // was fast, not that the fallback eventually fired.
    assert.ok(Date.now() - started < 2000, 'shutdown must come from hub.stop(), not the 5 s fallback');
    assert.match(hub.output(), /Received SIGTERM, stopping the hub\./);
  } finally {
    await hub.cleanup();
  }
});
