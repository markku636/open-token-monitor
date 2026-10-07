'use strict';

// Starts the fork's hub in-process the way hub/server.js's bootstrap
// does (open the store, create the hub, attach the overlay), on port 0
// unless told otherwise (scripts/smoke-hub.js).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PAGE_PATHS, createDashboardHub } = require('../../hub/server');
const { attachOverlay } = require('../../hub/overlay');
const { openPersistence } = require('../../hub/persistence');
const { pgliteConfig } = require('./pg');

const quiet = { log() {}, warn() {}, error() {} };

function tempPath(name) {
  return path.join(os.tmpdir(), `tm-custom-${process.pid}-${Math.random().toString(16).slice(2)}-${name}`);
}

function removeAll(...files) {
  for (const file of files.filter(Boolean)) {
    for (const suffix of ['', '.tmp']) fs.rmSync(`${file}${suffix}`, { force: true, recursive: true });
  }
}

async function startOverlayHub({
  secret = 'admin-secret',
  clientSecrets = ['client-secret'],
  // true: a fresh PGlite database; a schema name: that one again (a restart).
  database = null,
  dataFile = tempPath('devices.json'),
  streamWindowMs = 50,
  ingestMinIntervalMs = 0,
  staleAfterMs,
  persistenceConfig = null,
  publicDashboard = false,
  // backups.js options; without a dir the hub makes no backups.
  backup = {},
  port = 0,
  host = '127.0.0.1',
  logger = quiet
} = {}) {
  const config = persistenceConfig
    || (database ? await pgliteConfig({ schema: typeof database === 'string' ? database : '' }) : null);
  const persistence = config ? await openPersistence(config, { dataFile, logger }) : null;
  const hub = createDashboardHub({ port, host, secret, dataFile, logger, ...(staleAfterMs ? { staleAfterMs } : {}) });
  const overlay = attachOverlay(hub, {
    secret, clientSecrets, streamWindowMs, ingestMinIntervalMs, persistence, dataFile, staleAfterMs,
    publicDashboard, publicPaths: PAGE_PATHS, backup, logger
  });
  await hub.start();
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  return {
    hub,
    overlay,
    base,
    dataFile,
    schema: config?.schema || null,
    async settle() {
      await overlay.persistence?.queue.whenIdle();
      await overlay.persistence?.events.flush();
    },
    async stop() {
      await hub.stop();
    }
  };
}

function bearer(secret) {
  return { authorization: `Bearer ${secret}` };
}

// An API token made through the admin API, as request headers.
async function apiToken(base, name = 'Ledger', admin = bearer('admin-secret')) {
  const response = await fetch(`${base}/api/admin/api-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...admin },
    body: JSON.stringify({ name })
  });
  const body = await response.json();
  if (response.status !== 201) throw new Error(`could not make an API token: ${response.status} ${JSON.stringify(body)}`);
  return bearer(body.token);
}

async function post(base, pathname, body, headers = {}) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-token-monitor-response': 'minimal', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

module.exports = { apiToken, bearer, post, quiet, removeAll, startOverlayHub, tempPath };
