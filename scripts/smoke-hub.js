'use strict';

// A throwaway hub for the manual checks of an upstream upgrade
// (docs/upstream-upgrade.zh-TW.md, "hub 冒煙"): this checkout's overlay on
// this checkout's upstream/, with an in-process PostgreSQL (PGlite) that is
// gone when it stops, test keys, and made-up employees, devices and history.
// No Docker, no real database, no real keys.
//
//   npm run smoke:hub                                  port 17399, every interface
//   npm run smoke:hub -- --port 18000 --host 127.0.0.1 --no-seed --private
//
// The dashboard is public (TOKEN_MONITOR_PUBLIC_DASHBOARD), as on the company
// hub; --private turns that off.
//
// The keys and the URL other computers reach it at go to tmp/smoke-hub.env
// (the keys are kept between runs), which packaging/build-client.ps1
// -HubEnvFile reads to build a test client that uploads here. Ctrl+C stops it.
//
// It starts the hub the way tests/helpers/overlayHub.js does (store, hub,
// overlay); hub/server.js's own bootstrap is checked by
// tests/hubOverlayBootstrap.test.js and by the image smoke test of
// npm run build:image.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT } = require('../upstream');
const { upstreamVersion } = require('./check-upstream');
const { startOverlayHub, tempPath, removeAll } = require('../tests/helpers/overlayHub');
const { announcement } = require('../tests/helpers/xlsx');
const { dayKey, devicePayload, historyDay, provider } = require('../tests/helpers/fixtures');

const ENV_FILE = path.join('tmp', 'smoke-hub.env');
const USAGE = 'usage: npm run smoke:hub -- [--port <n>] [--host <address>] [--no-seed] [--private]';

const PEOPLE = [
  { no: 'S001', en: 'Ada Smoke', zh: '測試甲', bu: 'Platform', department: 'Hub', team: 'Ingest', email: 'ada@example.test' },
  { no: 'S002', en: 'Ben Smoke', zh: '測試乙', bu: 'Platform', department: 'Hub', team: 'Dashboard', email: 'ben@example.test' },
  { no: 'S003', en: 'Cai Smoke', zh: '測試丙', bu: 'Platform', department: 'Client', team: 'Widget', email: 'cai@example.test' },
  { no: 'S004', en: 'Dee Smoke', zh: '測試丁', bu: 'Products', department: 'Apps', team: 'Mobile', email: 'dee@example.test' },
  { no: 'S005', en: 'Eli Smoke', zh: '測試戊', bu: 'Products', department: 'Apps', team: 'Web', email: 'eli@example.test' }
];

// deviceId, hostname, owner, the AI tool and account it uses.
const DEVICES = [
  ['smoke-dev-1', 'SMOKE-NB01', 'ada@example.test', 'claude', 'claude-sonnet-4-5', 'ada@example.test'],
  ['smoke-dev-2', 'SMOKE-NB02', 'ben@example.test', 'codex', 'gpt-5.1-codex', 'team-codex@example.test'],
  ['smoke-dev-3', 'SMOKE-NB03', 'cai@example.test', 'claude', 'claude-opus-4-1', 'cai@example.test'],
  ['smoke-dev-4', 'SMOKE-NB04', 'dee@example.test', 'codex', 'gpt-5.1-codex', 'team-codex@example.test'],
  ['smoke-dev-5', 'SMOKE-PC05', null, 'claude', 'claude-sonnet-4-5', 'shared@example.test']
];

function parseCli(argv) {
  const out = { port: 17399, host: '0.0.0.0', seed: true, publicDashboard: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-seed') out.seed = false;
    else if (arg === '--private') out.publicDashboard = false;
    else if (arg === '--port' && /^\d+$/.test(argv[i + 1] || '')) out.port = Number(argv[++i]);
    else if (arg === '--host' && argv[i + 1]) out.host = argv[++i];
    else throw new Error(`unexpected argument ${arg}; ${USAGE}`);
  }
  return out;
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  }
  return '127.0.0.1';
}

function readEnv(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

// Test keys, made once and kept so a test client built against them keeps working.
function smokeEnv({ port, host }) {
  const file = path.join(ROOT, ENV_FILE);
  const old = readEnv(file);
  const admin = old.TOKEN_MONITOR_SECRET || `smoke-admin-${crypto.randomBytes(12).toString('hex')}`;
  const client = old.TOKEN_MONITOR_CLIENT_SECRETS || `smoke-client-${crypto.randomBytes(12).toString('hex')}`;
  const reachable = host === '0.0.0.0' ? lanAddress() : host;
  const hubUrl = `http://${reachable}:${port}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '# npm run smoke:hub: a throwaway test hub. Not real keys; tmp/ is not committed.',
    `TOKEN_MONITOR_HUB_URL=${hubUrl}`,
    `TOKEN_MONITOR_SECRET=${admin}`,
    `TOKEN_MONITOR_CLIENT_SECRETS=${client}`,
    ''
  ].join('\n'));
  return { admin, client, hubUrl };
}

async function call(base, pathname, { method = 'GET', key, body, type = 'application/json' } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': type } : {}) },
    body: body && type === 'application/json' ? JSON.stringify(body) : body
  });
  if (!response.ok) throw new Error(`${method} ${pathname}: ${response.status} ${await response.text()}`);
  return response;
}

async function seed(hub, { admin, client }) {
  const workbook = announcement(PEOPLE);
  await call(hub.base, '/api/admin/org/import?company=SMOKE&fileName=smoke.xlsx&confirm=1', {
    method: 'POST', key: admin, body: workbook, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  for (const [index, [deviceId, hostname, ownerEmail, tool, model, account]] of DEVICES.entries()) {
    const daily = Array.from({ length: 45 }, (_, ago) => historyDay(dayKey(-ago), {
      tokens: (2000 + 700 * index) * (1 + (ago % 7 === 0 ? 0 : 1)),
      cost: 0.6 + index * 0.3,
      client: tool,
      model
    }));
    const payload = devicePayload({
      deviceId,
      hostname,
      tokens: daily[0].tokens,
      cost: daily[0].cost,
      history: { daily, monthly: [], summary: {} },
      extra: ownerEmail ? { ownerEmail } : {}
    });
    // Fresh limits, so the dashboard does not mark them stale.
    const now = new Date().toISOString();
    payload.limits = {
      ...payload.limits,
      updatedAt: now,
      providers: [{ ...provider({ provider: tool === 'codex' ? 'codex' : 'claude', email: account, plan: tool === 'codex' ? 'Pro' : 'Max' }), updatedAt: now }]
    };
    await call(hub.base, '/api/ingest', { method: 'POST', key: client, body: payload });
  }
  await hub.settle();
  await call(hub.base, '/api/admin/org/reconcile', { method: 'POST', key: admin });
  await hub.settle();
}

async function main(argv) {
  const cli = parseCli(argv);
  const keys = smokeEnv(cli);
  const dataFile = tempPath('smoke-devices.json');
  const hub = await startOverlayHub({
    secret: keys.admin,
    clientSecrets: [keys.client],
    database: true,
    dataFile,
    streamWindowMs: 2000,
    publicDashboard: cli.publicDashboard,
    port: cli.port,
    host: cli.host,
    logger: { log() {}, warn: console.warn, error: console.error }
  });
  if (cli.seed) await seed(hub, keys);

  const local = `http://127.0.0.1:${hub.hub.server.address().port}`;
  console.log(`Smoke hub on upstream ${upstreamVersion(ROOT)}: ${local}${cli.host === '0.0.0.0' ? `  (other computers: ${keys.hubUrl})` : ''}`);
  console.log(`  dashboard   ${local}/   admin ${local}/admin   install ${local}/install`);
  console.log(`  admin key   ${keys.admin}`);
  console.log(`  client key  ${keys.client}`);
  console.log(cli.seed ? `  seeded      ${PEOPLE.length} employees of company SMOKE, ${DEVICES.length} devices with 45 days of history` : '  no data (--no-seed)');
  console.log(`Keys and URL: ${ENV_FILE} (test client: .\\packaging\\build-client.ps1 -HubEnvFile ${ENV_FILE.replace(/\//g, '\\')}). Ctrl+C stops it; its data goes with it.`);

  const stop = async () => {
    await hub.stop().catch(() => {});
    removeAll(dataFile);
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { parseCli };
