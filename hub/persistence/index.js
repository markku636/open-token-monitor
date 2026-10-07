'use strict';

// Opening the database and bringing the hub's JSON cache in line with it.
//
// Upstream's createHub() reads its dataFile once, synchronously, while it is
// constructed, so the database is written into that file *before* the hub
// exists. With a store the overlay's own core (../core.js) holds the live state
// and upstream never writes the file again; the copy made here is what the hub
// falls back to if a later start cannot reach the database and
// TOKEN_MONITOR_STORE_REQUIRED=0 lets it run anyway.

const { upstream } = require('../../upstream');
const { writeJsonAtomic } = require(upstream('src/shared/config'));
const { createStore } = require('./store');
const { createEventBuffer, createPersistQueue } = require('./queue');
const { assertSchemaName } = require('./drivers/postgres');

const DEFAULT_SCHEMA = 'token_monitor';

function flag(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// The hub has a database when TOKEN_MONITOR_DATABASE_URL is set (postgres://…),
// and runs on upstream's JSON file alone when it is not.
function persistenceConfigFromEnv(env = process.env) {
  const databaseUrl = String(env.TOKEN_MONITOR_DATABASE_URL || '').trim();
  if (databaseUrl && !/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    throw new Error('TOKEN_MONITOR_DATABASE_URL must be a postgres:// (or postgresql://) URL');
  }
  return {
    kind: databaseUrl ? 'postgres' : 'none',
    databaseUrl,
    schema: assertSchemaName(String(env.TOKEN_MONITOR_DATABASE_SCHEMA || '').trim() || DEFAULT_SCHEMA),
    poolSize: positiveInt(env.TOKEN_MONITOR_DATABASE_POOL_SIZE, 4) || 4,
    required: flag(env.TOKEN_MONITOR_STORE_REQUIRED, true),
    sessionRetentionMonths: positiveInt(env.TOKEN_MONITOR_SESSION_RETENTION_MONTHS, 24),
    auditRetentionDays: positiveInt(env.TOKEN_MONITOR_AUDIT_RETENTION_DAYS, 90)
  };
}

// The tests hand in an in-process PostgreSQL (PGlite): config.driver, one
// driver, or config.connect(), which makes a new one for every attempt.
function openDriver(config, logger) {
  if (config.connect) return config.connect();
  if (config.driver) return config.driver;
  return require('./drivers/postgres').openPostgres(config.databaseUrl, { schema: config.schema, poolSize: config.poolSize, logger });
}

// A database that is still starting or briefly unreachable: worth waiting for
// at boot, unlike a wrong password or another hub holding the lock.
// 57P03 cannot_connect_now, 57P01 admin_shutdown, 08xxx connection exceptions.
const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', '57P03', '57P01']);

function transient(error) {
  const code = String(error?.code || '');
  return TRANSIENT_CODES.has(code) || /^08/.test(code);
}

async function openStore(config, { logger, now }) {
  const store = createStore(await openDriver(config, logger), { now });
  try {
    // The lock first: a second, newer hub must not migrate the schema under a
    // running one before finding out it may not write.
    await store.acquireWriterLock();
    await store.migrate();
    // Below the last 刪除歷史資料 nothing is written again (store.writeCapture).
    await store.loadPurgeFloor();
    return store;
  } catch (error) {
    await store.close().catch(() => {});
    throw error;
  }
}

// Takes the writer lock, migrates and rewrites `dataFile` from the database.
// Returns null when no database is configured (upstream behaviour, JSON only).
// A database that is not reachable yet is retried for connectRetryMs (30 s):
// the hub and its database often start together. After that, with
// TOKEN_MONITOR_STORE_REQUIRED=0 the hub logs it and runs on its existing JSON
// file instead of refusing to boot.
async function openPersistence(config, { dataFile, logger = console, now = () => Date.now(), clock = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!config || config.kind === 'none') return null;
  const deadline = clock() + (config.connectRetryMs ?? 30 * 1000);
  let wait = 500;
  let store;
  try {
    for (;;) {
      try {
        store = await openStore(config, { logger, now });
        break;
      } catch (error) {
        // One driver handed in cannot be opened again once it was closed.
        if ((config.driver && !config.connect) || !transient(error) || clock() + wait > deadline) throw error;
        (logger.warn || console.warn)(`[persistence] database not reachable yet (${error.message}); retrying in ${wait} ms`);
        await sleep(wait);
        wait = Math.min(wait * 2, 5000);
      }
    }
    const snapshot = await store.loadSnapshot();
    writeCache(dataFile, snapshot, now);
    const devices = Object.keys(snapshot.devices).length;
    (logger.log || console.log)(`[persistence] postgres store ready (schema ${config.schema}): ${devices} device(s) rehydrated`);
    return { store, config, snapshot, rehydratedDevices: devices };
  } catch (error) {
    if (store) await store.close().catch(() => {});
    else if (config.driver) await config.driver.close().catch(() => {});
    if (config.required) throw new Error(`persistence: ${error.message}`, { cause: error });
    (logger.error || console.error)(`[persistence] disabled, running on the JSON file only: ${error.message}`);
    return null;
  }
}

function writeCache(dataFile, snapshot, now) {
  const document = { version: 1, devices: snapshot.devices, savedAt: new Date(now()).toISOString() };
  if (snapshot.subscriptions) document.subscriptions = snapshot.subscriptions;
  writeJsonAtomic(dataFile, document);
}

function createPersistenceRuntime(persistence, { logger = console, now = () => Date.now() } = {}) {
  const { store, config } = persistence;
  const queue = createPersistQueue({ store, logger, now });
  const events = createEventBuffer({ store, logger });
  const pruneTimer = setInterval(() => { prune().catch(() => {}); }, 24 * 60 * 60 * 1000);
  pruneTimer.unref?.();

  async function prune() {
    try {
      const removed = await store.prune({
        sessionRetentionMonths: config.sessionRetentionMonths,
        auditRetentionDays: config.auditRetentionDays
      });
      if (removed.sessions || removed.events) {
        (logger.log || console.log)(`[persistence] pruned ${removed.sessions} session row(s), ${removed.events} audit row(s)`);
      }
    } catch (error) {
      (logger.warn || console.warn)(`[persistence] prune failed: ${error.message}`);
    }
  }
  prune();

  return {
    store,
    queue,
    events,
    kind: config.kind,
    prune,
    status() {
      return { kind: config.kind, ...queue.status(), audit: events.status(), purge: store.purgeState() };
    },
    async stop() {
      clearInterval(pruneTimer);
      await queue.stop();
      await events.stop();
      await store.close();
    }
  };
}

module.exports = { createPersistenceRuntime, openPersistence, persistenceConfigFromEnv };
