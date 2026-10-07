#!/usr/bin/env node
'use strict';

// Load generator: measures what a hub with hundreds of devices and widgets
// costs, in upstream's behaviour and with the overlay's windowed stream, so
// the bandwidth numbers are measured rather than estimated.
//
//   node scripts/loadgen.js --mode overlay --devices 300 --clients 100 --rate 0.5 --seconds 60
//   node scripts/loadgen.js --mode upstream --devices 300 --clients 20 --rate 0.5 --seconds 30
//   TOKEN_MONITOR_DATABASE_URL=postgres://… node scripts/loadgen.js --mode overlay --store postgres --devices 300 --clients 300 --seconds 125
//
// --store postgres runs the overlay with a PostgreSQL store, which switches it
// to its own core ("route B"): no whole-file JSON rewrite per upload. It
// needs TOKEN_MONITOR_DATABASE_URL, and works in a throwaway schema it drops
// at the end.
//
// --rate is uploads per second across the fleet (300 devices every 10 minutes
// is 0.5). Every upload changes that device's usage, the worst case for the
// stream. The hub runs in this process on a temp data file; nothing is kept.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');

const { upstream } = require('../upstream');
const { createHub } = require(upstream('src/hub/server'));
const { PAGE_PATHS, createDashboardHub } = require('../hub/server');
const { attachOverlay } = require('../hub/overlay');
const { openPersistence } = require('../hub/persistence');
const { createStore } = require('../hub/persistence/store');
const { captureRows } = require('../hub/persistence/capture');
const { openPostgres } = require('../hub/persistence/drivers/postgres');
const { mergeDeviceRecord } = require(upstream('src/shared/usage'));

function option(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}

function dayKey(offset = 0) {
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
}

// A record in the size range measured on real devices (27–42 KB minified):
// a month of sessions, a few limit providers and 30 days of history.
function payload(index, bump, { sessions = 23 } = {}) {
  const day = dayKey(0);
  const month = day.slice(0, 7);
  const clients = ['claude', 'codex', 'cursor'];
  const models = ['claude-sonnet-4-5', 'gpt-5.3-codex', 'claude-opus-4-1'];
  const sessionMap = {};
  for (let s = 0; s < sessions; s += 1) {
    const client = clients[s % clients.length];
    const tokens = 10000 + s * 137 + bump;
    sessionMap[`${client}:session-${index}-${s}`] = {
      client, sessionId: `session-${index}-${s}`, totalTokens: tokens, costUsd: tokens * 0.000003,
      messageCount: 12, inputTokens: tokens * 0.2, outputTokens: tokens * 0.05, cacheReadTokens: tokens * 0.7,
      cacheWriteTokens: tokens * 0.05, reasoningTokens: 0, startedAt: `${day}T01:00:00.000Z`, lastUsedAt: new Date().toISOString(),
      projectId: `sha256:project-${s % 6}`, projectLabel: `workspace-${s % 6}`,
      models: { [models[s % 3]]: tokens }, modelCosts: { [models[s % 3]]: tokens * 0.000003 }, providers: { anthropic: tokens }
    };
  }
  const period = (tokens) => ({
    totalTokens: tokens, costUsd: tokens * 0.000003, cacheReadTokens: tokens * 0.6, cacheWriteTokens: tokens * 0.1, outputTokens: tokens * 0.05,
    clients: Object.fromEntries(clients.map((c, i) => [c, tokens / (i + 2)])),
    clientCosts: Object.fromEntries(clients.map((c, i) => [c, tokens * 0.000003 / (i + 2)])),
    models: Object.fromEntries(models.map((m, i) => [m, tokens / (i + 2)])),
    modelCosts: Object.fromEntries(models.map((m, i) => [m, tokens * 0.000003 / (i + 2)])),
    sessions: sessionMap
  });
  return {
    deviceId: `load-${index}`,
    hostname: `LOAD-${String(index).padStart(3, '0')}`,
    platform: 'win32',
    agentVersion: '0.61.0-corp.1',
    agentRuntime: 'electron-widget',
    updatedAt: new Date().toISOString(),
    syncUploadIntervalMs: 600000,
    today: period(50000 + bump),
    month: period(900000 + bump),
    allTime: { totalTokens: 9000000 + bump, costUsd: 27 },
    periodWindows: {
      timeZone: 'Asia/Taipei',
      today: { key: day, endsAt: new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString() },
      month: { key: month, endsAt: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString() }
    },
    historyAvailable: true,
    history: {
      daily: Array.from({ length: 30 }, (_, d) => ({ date: dayKey(-30 + d), tokens: 40000 + d, cost: 0.12, messages: 20, activeTimeMs: 3600000, perClient: { claude: { tokens: 40000 + d, cost: 0.12, messages: 20 } }, perModel: { [models[0]]: { tokens: 40000 + d, cost: 0.12 } } })),
      monthly: [{ month, tokens: 900000, cost: 2.7, activeTimeMs: 36000000, perClient: {}, perModel: {} }],
      summary: {}
    },
    limits: {
      updatedAt: new Date().toISOString(),
      refreshMs: 300000,
      providers: ['claude', 'codex', 'cursor', 'copilot', 'gemini'].map((provider) => ({
        provider, accountKey: `sha256:${provider}-${index}`, accountEmail: `user${index}@example.test`, planLabel: 'Pro', status: 'ok',
        updatedAt: new Date().toISOString(), windows: [{ kind: 'session', usedPercent: 40, remainingPercent: 60, resetsAt: new Date(Date.now() + 3600000).toISOString() }]
      }))
    }
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)].toFixed(1));
}

async function main(argv = process.argv.slice(2)) {
  const mode = option(argv, 'mode', 'overlay');
  const devices = Number(option(argv, 'devices', 300));
  const clients = Number(option(argv, 'clients', 100));
  const rate = Number(option(argv, 'rate', 0.5));
  const seconds = Number(option(argv, 'seconds', 60));
  const windowMs = Number(option(argv, 'window-ms', 60000));
  const sessions = Number(option(argv, 'sessions', 23));
  const storeKind = option(argv, 'store', 'none');
  const secret = 'loadgen-secret';
  let overlay = null;
  const dataFile = path.join(os.tmpdir(), `tm-loadgen-${process.pid}.json`);
  const quiet = { log() {}, warn() {}, error() {} };

  const databaseUrl = String(process.env.TOKEN_MONITOR_DATABASE_URL || '').trim();
  const schema = `tm_loadgen_${process.pid}`;
  if (!['none', 'postgres'].includes(storeKind)) throw new Error('--store must be none or postgres');
  if (storeKind === 'postgres') {
    if (!databaseUrl) throw new Error('--store postgres needs TOKEN_MONITOR_DATABASE_URL');
    // The database begins with every device, the way a running hub's would.
    const seed = createStore(openPostgres(databaseUrl, { schema }));
    await seed.migrate();
    for (let i = 0; i < devices; i += 1) {
      const record = mergeDeviceRecord(undefined, { ...payload(i, 0, { sessions }), receivedAt: new Date().toISOString() });
      await seed.writeCapture(captureRows(undefined, record));
    }
    await seed.close();
  }
  const persistence = storeKind === 'postgres'
    ? await openPersistence({ kind: 'postgres', databaseUrl, schema, poolSize: 4, required: true, sessionRetentionMonths: 24, auditRetentionDays: 90 }, { dataFile, logger: quiet })
    : null;
  const hub = mode === 'upstream'
    ? createHub({ port: 0, host: '127.0.0.1', secret, dataFile, logger: quiet })
    : createDashboardHub({ port: 0, host: '127.0.0.1', secret, dataFile, logger: quiet });
  if (mode !== 'upstream') {
    overlay = attachOverlay(hub, { secret, streamWindowMs: windowMs, ingestMinIntervalMs: 0, dataFile, persistence, publicPaths: PAGE_PATHS, logger: quiet });
  }
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const auth = { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'x-token-monitor-response': 'minimal' };

  process.stdout.write(`Seeding ${devices} devices… `);
  if (storeKind !== 'postgres') for (let i = 0; i < devices; i += 1) hub.ingest(payload(i, 0, { sessions }));
  const recordBytes = Buffer.byteLength(JSON.stringify(hub.getDevices()[0]));
  const statsBytes = Buffer.byteLength(JSON.stringify(hub.getStats()));
  console.log(`one record ${(recordBytes / 1024).toFixed(1)} KB, stats ${(statsBytes / 1048576).toFixed(2)} MB`);

  let received = 0;
  const controllers = [];
  // Connections are opened in batches: hundreds of simultaneous connects
  // overflow the listen backlog on Windows and come back ECONNREFUSED.
  const openStream = async () => {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${base}/api/stats/stream`, { headers: { ...auth, 'x-token-monitor-stream': '2' }, signal: controller.signal });
    (async () => {
      try {
        for await (const chunk of response.body) {
          received += chunk.byteLength;
        }
      } catch (_) {
        // Aborted at the end of the run.
      }
    })();
  };
  for (let opened = 0; opened < clients; opened += 50) {
    await Promise.all(Array.from({ length: Math.min(50, clients - opened) }, openStream));
  }
  const receivedAtStart = received;
  // Egress as the hub wrote it: fetch hands the reader decompressed bytes, so
  // for the overlay (which compresses) the client-side count would overstate it.
  const writtenAtStart = overlay ? overlay.health().stream.bytesWritten : 0;

  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const latencies = [];
  const started = performance.now();
  let bump = 1;
  let sent = 0;
  const interval = 1000 / Math.max(0.01, rate);
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (performance.now() - started >= seconds * 1000) {
        clearInterval(timer);
        resolve();
        return;
      }
      const index = Math.floor(Math.random() * devices);
      const body = JSON.stringify(payload(index, bump++, { sessions }));
      const t0 = performance.now();
      sent += 1;
      fetch(`${base}/api/ingest`, { method: 'POST', headers: auth, body })
        .then((r) => r.arrayBuffer())
        .then(() => latencies.push(performance.now() - t0))
        .catch(() => {});
    }, interval);
  });
  const elapsed = (performance.now() - started) / 1000;
  loop.disable();
  const streamBytes = overlay ? overlay.health().stream.bytesWritten - writtenAtStart : received - receivedAtStart;
  const cacheBytes = fs.existsSync(dataFile) ? fs.statSync(dataFile).size : 0;
  const hubIngest = overlay ? overlay.health().ingest : null;

  for (const controller of controllers) controller.abort();
  await hub.stop();
  fs.rmSync(dataFile, { force: true });
  fs.rmSync(`${dataFile}.tmp`, { force: true });
  if (storeKind === 'postgres') {
    const { Client } = require('pg');
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }

  const summary = {
    mode,
    store: storeKind,
    devices,
    clients,
    uploadsPerSecond: Number((sent / elapsed).toFixed(2)),
    seconds: Number(elapsed.toFixed(1)),
    recordKB: Number((recordBytes / 1024).toFixed(1)),
    statsMB: Number((statsBytes / 1048576).toFixed(2)),
    streamMBps: Number((streamBytes / elapsed / 1048576).toFixed(2)),
    streamMBpsPerClient: Number((streamBytes / elapsed / Math.max(1, clients) / 1048576).toFixed(3)),
    ingestMsP50: percentile(latencies, 50),
    ingestMsP95: percentile(latencies, 95),
    hubIngestMsP95: hubIngest ? hubIngest.ingestMsP95 : null,
    eventLoopMsP99: Number((loop.percentile(99) / 1e6).toFixed(1)),
    cacheFileMB: Number((cacheBytes / 1048576).toFixed(1))
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { main, payload };
