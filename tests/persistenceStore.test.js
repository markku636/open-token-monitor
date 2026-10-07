'use strict';

// The store contract, run against PGlite always and against a PostgreSQL
// server when TOKEN_MONITOR_TEST_DATABASE_URL points at one (each run gets a
// throwaway schema). The writer lock needs a server: PGlite is one session.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { upstream } = require('../upstream');
const { syncPayload } = require(upstream('src/shared/syncPayload'));
const { createStore, loadMigrations } = require('../hub/persistence/store');
const { openPostgres } = require('../hub/persistence/drivers/postgres');
const { isoTimestamp } = require('../hub/persistence/drivers/types');
const { captureRows } = require('../hub/persistence/capture');
const { devicePayload, historyDay, merged } = require('./helpers/fixtures');
const { SKIP_SERVER, TEST_DATABASE_URL, createTestSchema, openPglite } = require('./helpers/pg');

const DAY = '2026-09-20';

function contract(name, open) {
  test(`${name}: migrations are idempotent and a newer schema is refused`, async () => {
    const { store, dispose } = await open();
    try {
      assert.deepEqual(await store.migrate(), loadMigrations().map((m) => m.name));
      assert.deepEqual(await store.migrate(), []);
      await store.execute('INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)', [9999, 'future', '2026-09-20T00:00:00.000Z']);
      await assert.rejects(store.migrate(), /newer than this hub understands/);
    } finally {
      await dispose();
    }
  });

  test(`${name}: a capture lands in every table and children are replaced as a set`, async () => {
    const { store, dispose } = await open();
    try {
      await store.migrate();
      const first = merged(devicePayload({ day: DAY, history: { daily: [historyDay('2026-09-19')], monthly: [], summary: {} } }), undefined, '2026-09-20T03:00:00.000Z');
      assert.equal(await store.writeCapture(captureRows(undefined, first, { meta: { sourceIp: '10.0.0.7' } })), 'applied');

      const daily = await store.query('SELECT usage_date, source, tokens, messages FROM device_daily_usage ORDER BY usage_date');
      assert.deepEqual(daily.map((r) => [r.usage_date, r.source, r.tokens]), [['2026-09-19', 'history', 800], [DAY, 'live', 1000]]);
      assert.equal(daily[1].messages, null);
      const clients = await store.query('SELECT client, tokens FROM device_daily_client_usage WHERE usage_date = $1', [DAY]);
      assert.deepEqual(clients.map((r) => [r.client, r.tokens]), [['claude', 1000]]);
      const projects = await store.query('SELECT project_key, clients FROM device_daily_project_usage WHERE usage_date = $1', [DAY]);
      assert.equal(projects.length, 1);
      assert.deepEqual(projects[0].clients, { claude: 1000 }, 'jsonb comes back as an object');
      const [session] = await store.query('SELECT session_key, project_label FROM device_session_monthly_usage');
      assert.equal(session.session_key, 'claude:s-1');
      const [limit] = await store.query('SELECT provider, plan_label, account_email FROM device_limits');
      assert.deepEqual([limit.provider, limit.plan_label, limit.account_email], ['claude', 'Max', 'someone@example.test']);

      // A later tick that moved usage from one client to another replaces the
      // whole breakdown; no stale client row survives.
      const payload = devicePayload({ day: DAY, tokens: 1200 });
      payload.today.clients = { codex: 1200 };
      payload.today.clientCosts = { codex: 0.7 };
      payload.today.clientCacheReads = {};
      payload.today.clientCacheWrites = {};
      payload.today.clientOutputs = {};
      const second = merged(payload, first, '2026-09-20T03:10:00.000Z');
      await store.writeCapture(captureRows(first, second));
      const after = await store.query('SELECT client, tokens FROM device_daily_client_usage WHERE usage_date = $1', [DAY]);
      assert.deepEqual(after.map((r) => [r.client, r.tokens]), [['codex', 1200]]);
      const [device] = await store.query('SELECT received_at, first_seen_at, record_bytes, today_key FROM devices');
      assert.equal(device.received_at, '2026-09-20T03:10:00.000Z', 'timestamptz comes back as ISO with milliseconds');
      assert.equal(device.today_key, DAY, 'a date comes back as YYYY-MM-DD');
      assert.ok(device.record_bytes > 0);
    } finally {
      await dispose();
    }
  });

  test(`${name}: a history row leaves the live project breakdown of its day in place`, async () => {
    const { store, dispose } = await open();
    try {
      await store.migrate();
      const live = merged(devicePayload({ day: DAY }), undefined, '2026-09-20T03:00:00.000Z');
      await store.writeCapture(captureRows(undefined, live));
      const rolled = merged(devicePayload({ day: '2026-09-21', history: { daily: [historyDay(DAY, { tokens: 1500 })], monthly: [], summary: {} } }), live, '2026-09-21T01:00:00.000Z');
      await store.writeCapture(captureRows(live, rolled, { hadHistory: true }));
      const [row] = await store.query('SELECT source, tokens FROM device_daily_usage WHERE usage_date = $1', [DAY]);
      assert.deepEqual([row.source, row.tokens], ['history', 1500]);
      const projects = await store.query('SELECT project_key FROM device_daily_project_usage WHERE usage_date = $1', [DAY]);
      assert.equal(projects.length, 1);
    } finally {
      await dispose();
    }
  });

  test(`${name}: a day that only lost its token split on the way keeps the split it was stored with`, async () => {
    const { store, dispose } = await open();
    try {
      await store.migrate();
      const old = '2026-09-10';
      const history = { daily: [historyDay(old)], monthly: [], summary: {} };
      const first = merged(devicePayload({ day: DAY, history }), undefined, '2026-09-20T03:00:00.000Z');
      await store.writeCapture(captureRows(undefined, first));
      // An over-budget upload: upstream sends every day without its split
      // (src/shared/syncPayload.js).
      const stripped = syncPayload({ history, periodWindows: { today: { key: DAY } } }, { omitHistoryTokenComponents: true }).history;
      assert.equal(Object.prototype.hasOwnProperty.call(stripped.daily[0], 'cacheReadTokens'), false);
      const second = merged(devicePayload({ day: DAY, history: stripped }), first, '2026-09-20T03:10:00.000Z');
      assert.equal(await store.writeCapture(captureRows(first, second, { hadHistory: true })), 'applied');

      const days = await store.query('SELECT tokens, cache_read_tokens, cache_write_tokens, output_tokens, unclassified_tokens, has_token_components FROM device_daily_usage WHERE usage_date = $1', [old]);
      assert.deepEqual(days.map((r) => [r.tokens, r.cache_read_tokens, r.cache_write_tokens, r.output_tokens, r.unclassified_tokens, r.has_token_components]), [[800, 480, 80, 40, 0, true]]);
      const clients = await store.query('SELECT client, tokens, messages, cache_read_tokens, cache_write_tokens, output_tokens, unclassified_tokens FROM device_daily_client_usage WHERE usage_date = $1', [old]);
      assert.deepEqual(clients.map((r) => [r.client, r.tokens, r.messages, r.cache_read_tokens, r.cache_write_tokens, r.output_tokens, r.unclassified_tokens]), [['claude', 800, 6, 480, 80, 40, 0]]);
      const models = await store.query('SELECT model, tokens, cache_read_tokens, cache_write_tokens, output_tokens, unclassified_tokens FROM device_daily_model_usage WHERE usage_date = $1', [old]);
      assert.deepEqual(models.map((r) => [r.model, r.tokens, r.cache_read_tokens, r.cache_write_tokens, r.output_tokens, r.unclassified_tokens]), [['claude-sonnet-4-5', 800, 480, 80, 40, 0]]);
      const [device] = await store.query('SELECT received_at FROM devices');
      assert.equal(device.received_at, '2026-09-20T03:10:00.000Z', 'the stripped record itself was stored');
    } finally {
      await dispose();
    }
  });

  test(`${name}: an older record never overwrites a newer one`, async () => {
    const { store, dispose } = await open();
    try {
      await store.migrate();
      const newer = merged(devicePayload({ day: DAY, tokens: 2000 }), undefined, '2026-09-20T04:00:00.000Z');
      const older = merged(devicePayload({ day: DAY, tokens: 1000 }), undefined, '2026-09-20T03:00:00.000Z');
      assert.equal(await store.writeCapture(captureRows(undefined, newer)), 'applied');
      assert.equal(await store.writeCapture(captureRows(undefined, older)), 'stale');
      const [row] = await store.query('SELECT tokens FROM device_daily_usage WHERE usage_date = $1', [DAY]);
      assert.equal(row.tokens, 2000);
    } finally {
      await dispose();
    }
  });

  test(`${name}: the snapshot rebuilds records exactly and skips soft-deleted devices`, async () => {
    const { store, dispose } = await open();
    try {
      await store.migrate();
      const a = merged(devicePayload({ deviceId: 'dev-a', day: DAY }), undefined, '2026-09-20T03:00:00.000Z');
      const b = merged(devicePayload({ deviceId: 'Dev-A', day: DAY }), undefined, '2026-09-20T03:00:00.000Z');
      await store.writeCapture(captureRows(undefined, a));
      await store.writeCapture(captureRows(undefined, b));
      const snapshot = await store.loadSnapshot();
      assert.deepEqual(Object.keys(snapshot.devices).sort(), ['Dev-A', 'dev-a'], 'device ids are case-sensitive');
      assert.deepEqual(snapshot.devices['dev-a'], JSON.parse(JSON.stringify(a)));

      await store.softDeleteDevice('dev-a');
      assert.deepEqual(Object.keys((await store.loadSnapshot()).devices), ['Dev-A']);
      const again = merged(devicePayload({ deviceId: 'dev-a', day: DAY }), undefined, '2026-09-20T05:00:00.000Z');
      await store.writeCapture(captureRows(undefined, again));
      assert.deepEqual(Object.keys((await store.loadSnapshot()).devices).sort(), ['Dev-A', 'dev-a'], 'an upload clears the delete mark');
    } finally {
      await dispose();
    }
  });

  test(`${name}: subscriptions round-trip with their concurrency token intact`, async () => {
    const { store, dispose } = await open();
    try {
      await store.migrate();
      const document = { version: 1, updatedAt: '2026-09-20T03:00:00.123Z', subscriptions: [{ id: 'sub_1', provider: 'claude', amountMinor: 2000, currency: 'USD' }] };
      await store.writeSubscriptions(document);
      await store.writeSubscriptions({ ...document, updatedAt: '2026-09-20T03:00:00.124Z' });
      const snapshot = await store.loadSnapshot();
      assert.equal(snapshot.subscriptions.updatedAt, '2026-09-20T03:00:00.124Z');
      assert.deepEqual(snapshot.subscriptions.subscriptions, document.subscriptions);
    } finally {
      await dispose();
    }
  });

  test(`${name}: audit rows are written in batches and pruned by age`, async () => {
    let clock = Date.parse('2026-09-20T00:00:00.000Z');
    const { store, dispose } = await open(() => clock);
    try {
      await store.migrate();
      await store.insertIngestEvents([
        { deviceId: 'dev-a', receivedAt: Date.parse('2026-05-01T00:00:00Z'), sourceIp: '10.0.0.1', authRole: 'client', authKeyIndex: 0, agentVersion: '0.61.0', payloadBytes: 100, hadHistory: false, outcome: 'applied' },
        { deviceId: 'dev-a', receivedAt: Date.parse('2026-09-19T00:00:00Z'), sourceIp: '10.0.0.1', authRole: 'client', authKeyIndex: 1, agentVersion: '0.61.0', payloadBytes: 100, hadHistory: true, outcome: 'coalesced' },
        // An address the hub could not parse is kept as unknown, not a failed batch.
        { deviceId: 'dev-b', receivedAt: Date.parse('2026-09-19T00:00:01Z'), sourceIp: 'not-an-ip', authRole: 'client', authKeyIndex: 0, agentVersion: '0.61.0', payloadBytes: 1e12, hadHistory: false, outcome: 'nonsense' }
      ]);
      clock = Date.parse('2026-09-20T00:00:00.000Z');
      const removed = await store.prune({ auditRetentionDays: 90, sessionRetentionMonths: 24 });
      assert.equal(removed.events, 1);
      const rows = await store.query('SELECT device_id, outcome, auth_key_index, source_ip, had_history, payload_bytes FROM ingest_events ORDER BY id');
      assert.deepEqual(rows.map((r) => [r.device_id, r.outcome, r.auth_key_index, r.source_ip, r.had_history]), [
        ['dev-a', 'coalesced', 1, '10.0.0.1', true],
        ['dev-b', 'rejected', 0, null, false]
      ]);
      assert.equal(rows[1].payload_bytes, 2147483647);
    } finally {
      await dispose();
    }
  });

  test(`${name}: a NUL character in client data is dropped instead of failing the write`, async () => {
    const { store, dispose } = await open();
    try {
      await store.migrate();
      const payload = devicePayload({ deviceId: 'dev-nul', day: DAY });
      payload.hostname = 'host\u0000name';
      payload.limits.providers[0].planLabel = 'Max\u0000';
      const record = merged(payload, undefined, '2026-09-20T03:00:00.000Z');
      assert.equal(await store.writeCapture(captureRows(undefined, record)), 'applied');
      const [device] = await store.query('SELECT hostname FROM devices');
      assert.equal(device.hostname, 'hostname');
      const [limit] = await store.query('SELECT plan_label, provider_json FROM device_limits');
      assert.equal(limit.plan_label, 'Max');
      assert.equal(limit.provider_json.planLabel, 'Max', 'jsonb too');
      // record_json keeps the record exactly: JSON text escapes the character.
      assert.equal((await store.loadSnapshot()).devices['dev-nul'].hostname, 'host\u0000name');
    } finally {
      await dispose();
    }
  });
}

contract('pglite', async (now) => {
  const store = createStore(await openPglite(), now ? { now } : {});
  return { store, dispose: () => store.close() };
});

if (TEST_DATABASE_URL) {
  contract('postgres', async (now) => {
    const schema = await createTestSchema();
    const store = createStore(openPostgres(schema.url, { schema: schema.schema }), now ? { now } : {});
    return { store, dispose: async () => { await store.close(); await schema.drop(); } };
  });
} else {
  test('postgres: store contract', { skip: SKIP_SERVER }, () => {});
}

test('postgres: one hub per schema (advisory lock), and the lock is free again once it closes', { skip: SKIP_SERVER }, async () => {
  const schema = await createTestSchema();
  const first = createStore(openPostgres(schema.url, { schema: schema.schema }));
  const second = createStore(openPostgres(schema.url, { schema: schema.schema }));
  let third = null;
  try {
    await first.acquireWriterLock();
    await assert.rejects(second.acquireWriterLock(), /writer lock/);
    await first.close();
    third = createStore(openPostgres(schema.url, { schema: schema.schema }));
    await third.acquireWriterLock();
  } finally {
    await first.close().catch(() => {});
    await second.close();
    if (third) await third.close();
    await schema.drop();
  }
});

test('postgres: the store creates its schema when it is missing', { skip: SKIP_SERVER }, async () => {
  const holder = await createTestSchema();
  const missing = `${holder.schema}_new`;
  const store = createStore(openPostgres(holder.url, { schema: missing }));
  try {
    await store.migrate();
    const [row] = await holder.admin.query('SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1', [missing]).then((r) => r.rows);
    assert.ok(row.n >= 15, 'the tables are in the new schema');
  } finally {
    await store.close();
    await holder.admin.query(`DROP SCHEMA IF EXISTS ${missing} CASCADE`);
    await holder.drop();
  }
});

test('a database that is not reachable yet is waited for, within a limit', async () => {
  const { openPersistence } = require('../hub/persistence');
  const os = require('node:os');
  const warnings = [];
  const logger = { log() {}, warn: (message) => warnings.push(message), error() {} };
  // A clock that only moves while the hub waits.
  let elapsed = 0;
  const clock = () => elapsed;
  const sleep = async (ms) => { elapsed += ms; };
  const starting = (code) => ({
    dialect: 'postgres',
    schema: 'token_monitor',
    async acquireWriterLock() { throw Object.assign(new Error('the database system is starting up'), { code }); },
    async close() {}
  });
  const dataFile = path.join(os.tmpdir(), `tm-retry-${process.pid}.json`);

  // Starting up twice (57P03, then a refused connection), then there.
  let attempts = 0;
  const config = {
    kind: 'postgres', schema: 'token_monitor', required: true, connectRetryMs: 30000,
    connect: async () => { attempts += 1; return attempts <= 2 ? starting(attempts === 1 ? '57P03' : 'ECONNREFUSED') : openPglite(); }
  };
  const drivers = [];
  const connect = () => config.connect().then((driver) => { drivers.push(driver); return driver; });
  const opened = await openPersistence({ ...config, connect }, { dataFile, logger, clock, sleep });
  try {
    assert.ok(opened, 'the store opens once the database is there');
    assert.equal(attempts, 3);
    assert.deepEqual(warnings.map((w) => /retrying in (\d+) ms/.exec(w)[1]), ['500', '1000']);
  } finally {
    await opened?.store.close();
    fs.rmSync(dataFile, { force: true });
  }

  // Never there: the boot fails once the limit is spent.
  warnings.length = 0;
  elapsed = 0;
  const never = { kind: 'postgres', schema: 'token_monitor', required: true, connectRetryMs: 1500, connect: async () => starting('ECONNREFUSED') };
  await assert.rejects(openPersistence(never, { dataFile, logger, clock, sleep }), /persistence: the database system is starting up/);
  assert.equal(warnings.length, 2, 'waits of 500 and 1000 ms fit in 1.5 s, the next 2 s does not');
  // A wrong password is not waited for; not required, the hub runs on JSON.
  warnings.length = 0;
  const refused = { ...never, required: false, connect: async () => starting('28P01') };
  assert.equal(await openPersistence(refused, { dataFile, logger, clock, sleep }), null);
  assert.equal(warnings.length, 0);
});

test('timestamps come back as ISO 8601 whatever fraction PostgreSQL sends', () => {
  assert.equal(isoTimestamp('2026-09-20 03:10:00+00'), '2026-09-20T03:10:00.000Z');
  assert.equal(isoTimestamp('2026-09-20 03:10:00.5+00'), '2026-09-20T03:10:00.500Z');
  assert.equal(isoTimestamp('2026-09-20 11:10:00.123456+08'), '2026-09-20T03:10:00.123Z');
  assert.equal(isoTimestamp('2026-09-20 03:10:00'), '2026-09-20T03:10:00.000Z', 'timestamp without time zone is UTC');
  assert.equal(isoTimestamp('infinity'), 'infinity');
});

// docs/postgres.zh-TW.md, "命名慣例": the schema uses PostgreSQL's types and
// naming, not MySQL's.
test('the schema follows the PostgreSQL naming and type conventions', () => {
  const sql = fs.readdirSync(path.join(__dirname, '..', 'hub', 'persistence', 'sql'))
    .map((name) => fs.readFileSync(path.join(__dirname, '..', 'hub', 'persistence', 'sql', name), 'utf8'))
    .join('\n')
    .replace(/--[^\n]*/g, '');
  for (const forbidden of [/\bvarchar\b/i, /\bchar\s*\(/i, /\btinyint\b/i, /\bdatetime\b/i, /\bmediumtext\b/i, /\bunsigned\b/i, /\bauto_increment\b/i, /\benum\s*\(/i, /\bengine\s*=/i, /`/, /\bIF NOT EXISTS\b/]) {
    assert.doesNotMatch(sql, forbidden, `the schema must not use ${forbidden}`);
  }
  const tables = [...sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)];
  assert.ok(tables.length >= 15, 'the tables were not recognised');
  for (const [, table, body] of tables) {
    assert.match(table, /^[a-z][a-z0-9_]*(s|_usage)$/, `${table}: snake_case and plural`);
    for (const line of body.split('\n').map((l) => l.trim()).filter((l) => /^[a-z_]+\s+[a-z]/.test(l) && !/^(PRIMARY|CHECK|UNIQUE|CONSTRAINT)\b/i.test(l))) {
      const [column, rawType] = line.split(/\s+/);
      const type = rawType.replace(/,$/, '');
      assert.match(column, /^[a-z][a-z0-9_]*$/, `${table}.${column}: snake_case`);
      if (/_at$/.test(column)) assert.equal(type, 'timestamptz', `${table}.${column}: an instant is timestamptz`);
      if (/_date$|^valid_(from|to)$/.test(column)) assert.equal(type, 'date', `${table}.${column}: a day is date`);
    }
  }
  for (const [, index, table] of sql.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+) ON (\w+)/g)) {
    assert.ok(index.startsWith(`${table}_`) && index.endsWith('_idx'), `${index}: named <table>_<columns>_idx`);
  }
});
