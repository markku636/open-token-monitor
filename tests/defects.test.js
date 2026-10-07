'use strict';

// Regression tests for defects the overlay fixes. The A tests reproduce upstream
// hub defects that are still open upstream and that the overlay's ingest guard
// blocks; each is named after its entry in docs/defects.zh-TW.md. The rest
// pin fixes to the overlay's own persistence and stream code.

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const { checkIngestPayload } = require('../hub/ingestGuard');
const { captureRows } = require('../hub/persistence/capture');
const { toDbTime } = require('../hub/persistence/util');
const { createPersistQueue, isPermanentStoreError } = require('../hub/persistence/queue');
const { createStore } = require('../hub/persistence/store');
const { LOCK_CLASS, openPostgres } = require('../hub/persistence/drivers/postgres');
const { createStatsBroadcaster } = require('../hub/stream');
const { bearer, post, removeAll, startOverlayHub } = require('./helpers/overlayHub');
const { devicePayload, historyDay, merged } = require('./helpers/fixtures');
const { SKIP_SERVER, createTestSchema, openPglite } = require('./helpers/pg');

const CLIENT = bearer('client-secret');
const ADMIN = bearer('admin-secret');

async function json(response) {
  return { status: response.status, body: await response.json() };
}

function rawPost(base, body) {
  return fetch(`${base}/api/ingest`, { method: 'POST', headers: { ...CLIENT, 'content-type': 'application/json', 'x-token-monitor-response': 'minimal' }, body });
}

test('A6 an older snapshot is acknowledged but never replaces a newer one', async () => {
  const hub = await startOverlayHub();
  try {
    const newer = new Date().toISOString();
    const older = new Date(Date.now() - 60000).toISOString();
    await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'd', tokens: 2000, updatedAt: newer }), CLIENT);
    const replay = await json(await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'd', tokens: 1000, updatedAt: older }), CLIENT));
    assert.deepEqual(replay, { status: 200, body: { ok: true, deviceId: 'd' } });
    const [device] = hub.hub.getDevices();
    assert.equal(device.periods.today.totalTokens, 2000);
    assert.equal(hub.overlay.ingest.status().replays, 1);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

test('A7 device clocks cannot keep a period or a limits account alive forever', () => {
  const now = Date.parse('2026-09-20T03:00:00.000Z');
  const payload = devicePayload({ day: '2026-09-20' });
  payload.updatedAt = '2099-01-01T00:00:00.000Z';
  payload.periodWindows.today.endsAt = '2099-01-01T00:00:00.000Z';
  payload.periodWindows.month.endsAt = '2099-01-01T00:00:00.000Z';
  payload.limits.updatedAt = '2099-01-01T00:00:00.000Z';
  payload.limits.refreshMs = 1e12;
  payload.limits.providers[0].updatedAt = '2099-01-01T00:00:00.000Z';
  const { payload: checked } = checkIngestPayload(payload, { receivedAtMs: now });
  assert.ok(Date.parse(checked.updatedAt) <= now + 10 * 60000);
  assert.ok(Date.parse(checked.periodWindows.today.endsAt) <= now + 2 * 86400000);
  assert.ok(Date.parse(checked.periodWindows.month.endsAt) <= now + 33 * 86400000);
  assert.ok(Date.parse(checked.limits.providers[0].updatedAt) <= now + 10 * 60000);
  assert.equal(checked.limits.refreshMs, 24 * 60 * 60 * 1000);
});

test('A9 device ids must be short plain strings, and a bad escape in DELETE is a 400', async () => {
  const hub = await startOverlayHub();
  try {
    for (const body of ['{"deviceId":{"a":1}}', '{"deviceId":"__proto__"}', '{"deviceId":"has space"}', `{"deviceId":"${'d'.repeat(129)}"}`]) {
      const response = await rawPost(hub.base, body);
      assert.equal(response.status, 400, body);
      await response.arrayBuffer();
    }
    const guid = await rawPost(hub.base, JSON.stringify(devicePayload({ deviceId: '0f8fad5b-d9cb-469f-a165-70867728950e' })));
    assert.equal(guid.status, 200, 'the installer-generated GUID is accepted');
    await guid.arrayBuffer();
    const bad = await json(await fetch(`${hub.base}/api/devices/%E0%A4%A`, { method: 'DELETE', headers: ADMIN }));
    assert.equal(bad.status, 400);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

test('a finished day whose history did not change after midnight still gets its history row', () => {
  const history = { daily: [historyDay('2026-09-21'), historyDay('2026-09-22', { tokens: 900 })], monthly: [], summary: {} };
  const base = merged(devicePayload({ day: '2026-09-22', history }), undefined, '2026-09-22T15:00:00.000Z');
  const next = merged(devicePayload({ day: '2026-09-23', history }), base, '2026-09-23T01:00:00.000Z');
  const rows = captureRows(base, next, { hadHistory: true }).daily;
  assert.deepEqual(rows.map((row) => [row.key, row.source]).sort(), [['2026-09-22', 'history'], ['2026-09-23', 'live']]);
});

function fakeStream(headers = {}) {
  const res = {
    chunks: [],
    writableLength: 0,
    destroyed: false,
    writeHead() {},
    write(chunk) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk); return true; },
    end() {},
    destroy() { this.destroyed = true; }
  };
  const req = { headers, on() {} };
  return { req, res };
}

function statsHub() {
  let version = 0;
  return {
    calls: 0,
    bump() { version += 1; },
    getStats() {
      this.calls += 1;
      return { updatedAt: new Date().toISOString(), version, devices: [], limits: {} };
    }
  };
}

test('a poll between an upload and the window does not swallow the stream update', async () => {
  const hub = statsHub();
  const stream = createStatsBroadcaster(hub, { windowMs: 100, compress: false });
  try {
    const { req, res } = fakeStream();
    stream.handleStream(req, res);
    hub.bump();
    stream.markDirty();
    stream.handleStats(fakeStream().req, fakeStream().res); // rebuilds the cache
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(res.chunks.some((chunk) => chunk.startsWith('event: stats')), 'the stream still got the change');
  } finally {
    stream.stop();
  }
});

test('the stats cache is rebuilt after a window even without uploads', async () => {
  const hub = statsHub();
  const stream = createStatsBroadcaster(hub, { windowMs: 100, compress: false });
  try {
    stream.handleStats(fakeStream().req, fakeStream().res);
    const calls = hub.calls;
    await new Promise((resolve) => setTimeout(resolve, 150));
    stream.handleStats(fakeStream().req, fakeStream().res);
    assert.ok(hub.calls > calls, 'ageMs, stale flags and day expiry follow the clock');
  } finally {
    stream.stop();
  }
});

test('a connection that cannot keep up is cut instead of buffering without bound', () => {
  const hub = statsHub();
  const stream = createStatsBroadcaster(hub, { windowMs: 60000, compress: false, maxBufferedBytes: 10 });
  try {
    const { req, res } = fakeStream();
    res.writableLength = 11;
    stream.handleStream(req, res);
    assert.equal(res.destroyed, true);
    assert.equal(stream.status().clients, 0);
    assert.equal(stream.status().slowClientsCut, 1);
  } finally {
    stream.stop();
  }
});

test('values outside a column are clamped, and a record the database refuses is dropped, not retried forever', async () => {
  assert.equal(toDbTime(1e15), null);
  assert.equal(toDbTime('2026-09-20T03:00:00Z'), '2026-09-20T03:00:00.000Z');
  const payload = devicePayload({ day: '2026-09-20', tokens: 1e18, cost: 1e12 });
  const rows = captureRows(undefined, merged(payload, undefined, '2026-09-20T03:00:00.000Z'));
  const today = rows.daily.find((row) => row.key === '2026-09-20');
  assert.equal(today.totals.tokens, Number.MAX_SAFE_INTEGER);
  assert.equal(today.totals.costUsd, 9999999999);

  // SQLSTATE class 22 (data exception) and 23 (constraint) can never succeed;
  // a lost connection, a serialization failure or a lock timeout can.
  assert.equal(isPermanentStoreError({ code: '22003' }), true);
  assert.equal(isPermanentStoreError({ code: '23505' }), true);
  assert.equal(isPermanentStoreError({ code: '40001' }), false);
  assert.equal(isPermanentStoreError({ code: '57P01' }), false);
  assert.equal(isPermanentStoreError({ code: 'ECONNREFUSED' }), false);
  assert.equal(isPermanentStoreError(new Error('connect ECONNREFUSED')), false);
  let attempts = 0;
  const store = { async writeCapture() { attempts += 1; const error = new Error('numeric field overflow'); error.code = '22003'; throw error; } };
  const queue = createPersistQueue({ store, logger: { warn() {}, error() {} } });
  queue.enqueue(merged(devicePayload({ deviceId: 'bad' })));
  await queue.whenIdle();
  assert.equal(attempts, 1);
  assert.equal(queue.status().dropped, 1);
  await queue.stop();
});

test('a late live row never replaces the day\'s final history row', async () => {
  const store = createStore(await openPglite());
  try {
    await store.migrate();
    const day = '2026-09-20';
    const live = merged(devicePayload({ day, tokens: 100 }), undefined, '2026-09-20T10:00:00.000Z');
    await store.writeCapture(captureRows(undefined, live));
    const final = merged(devicePayload({ day: '2026-09-21', history: { daily: [historyDay(day, { tokens: 900 })], monthly: [], summary: {} } }), live, '2026-09-21T01:00:00.000Z');
    await store.writeCapture(captureRows(live, final, { hadHistory: true }));
    // A snapshot from before midnight, queued on the device, arrives late.
    const late = merged(devicePayload({ day, tokens: 150 }), undefined, '2026-09-21T02:00:00.000Z');
    await store.writeCapture(captureRows(undefined, late));
    const [row] = await store.query('SELECT source, tokens FROM device_daily_usage WHERE usage_date = $1', [day]);
    assert.deepEqual([row.source, row.tokens], ['history', 900]);
  } finally {
    await store.close();
  }
});

test('a bounded read is cancelled by the server and leaves its connection as it was', { skip: SKIP_SERVER }, async () => {
  const schema = await createTestSchema();
  const store = createStore(openPostgres(schema.url, { schema: schema.schema, poolSize: 1, logger: { warn() {}, error() {} } }));
  try {
    await assert.rejects(store.query('SELECT pg_sleep(2)', [], { timeoutMs: 50 }), (error) => error.code === '57014');
    // One pooled connection: the next read gets the same one, with no limit left on it.
    const [row] = await store.query('SHOW statement_timeout');
    assert.equal(row.statement_timeout, '0');
    assert.deepEqual(await store.query('SELECT 1 AS one', [], { timeoutMs: 5000 }), [{ one: 1 }]);
  } finally {
    await store.close();
    await schema.drop();
  }
});

test('on PGlite a bounded read is a plain one', async () => {
  const store = createStore(await openPglite());
  try {
    assert.deepEqual(await store.query('SELECT 1 AS one', [], { timeoutMs: 50 }), [{ one: 1 }]);
  } finally {
    await store.close();
  }
});

test('writer locks are per schema, and a lost lock pauses writes until it is back', { skip: SKIP_SERVER }, async () => {
  const quietLogger = { warn() {}, error() {} };
  const one = await createTestSchema();
  const two = await createTestSchema();
  const a = openPostgres(one.url, { schema: one.schema, logger: quietLogger });
  const b = openPostgres(two.url, { schema: two.schema, logger: quietLogger });
  const rival = openPostgres(one.url, { schema: one.schema, logger: quietLogger });
  try {
    await a.acquireWriterLock();
    await b.acquireWriterLock(); // another schema in the same database is not blocked
    const { rows: [holder] } = await one.admin.query(
      "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = $1::int4::oid AND objid = hashtext($2)::oid",
      [LOCK_CLASS, `token_monitor.writer.${one.schema}`]
    );
    await one.admin.query('SELECT pg_terminate_backend($1)', [holder.pid]);
    await rival.acquireWriterLock(); // someone else takes it while `a` is gone
    await a.checkLock();
    assert.throws(() => a.assertWriter(), /does not hold the writer lock/);
    await rival.close();
    await a.checkLock();
    assert.doesNotThrow(() => a.assertWriter(), 'the lock is taken back once it is free');
  } finally {
    await a.close();
    await b.close();
    await rival.close().catch(() => {});
    await one.drop();
    await two.drop();
  }
});

test('refused uploads are audited too, and audit values are kept within their columns', async () => {
  const hub = await startOverlayHub({ database: true });
  try {
    await (await rawPost(hub.base, '{"deviceId":')).arrayBuffer();
    await (await rawPost(hub.base, '{"today":{}}')).arrayBuffer();
    await (await rawPost(hub.base, '{"deviceId":"__proto__"}')).arrayBuffer();
    await hub.settle();
    const rows = await hub.overlay.persistence.store.query('SELECT device_id, outcome FROM ingest_events ORDER BY id');
    assert.deepEqual(rows.map((r) => r.outcome), ['rejected', 'rejected', 'rejected']);
    await hub.overlay.persistence.store.insertIngestEvents([{ deviceId: 'd', receivedAt: Date.now(), sourceIp: 'x'.repeat(200), authRole: 'client', agentVersion: 'v'.repeat(200), payloadBytes: 1, hadHistory: false, outcome: 'applied' }]);
    const [long] = await hub.overlay.persistence.store.query("SELECT source_ip, agent_version FROM ingest_events WHERE device_id = 'd'");
    assert.deepEqual([long.source_ip, long.agent_version.length], [null, 64], 'an address that is not one is unknown');
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

test('stopping the queue writes everything that is still waiting', async () => {
  const written = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const store = {
    async writeCapture(capture) {
      if (!written.length) await gate;
      written.push(capture.device.deviceId);
      return 'applied';
    }
  };
  const queue = createPersistQueue({ store, logger: { warn() {}, error() {} } });
  queue.enqueue(merged(devicePayload({ deviceId: 'one' })));
  await new Promise((resolve) => setTimeout(resolve, 10)); // `one` is now in flight
  queue.enqueue(merged(devicePayload({ deviceId: 'two' })));
  const stopping = queue.stop();
  release();
  await stopping;
  assert.deepEqual(written, ['one', 'two']);
});

test('streams are gzip-compressed for clients that accept it and plain for the rest', async () => {
  const hub = await startOverlayHub();
  try {
    await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'd' }), CLIENT);
    const port = hub.hub.server.address().port;
    const plain = await new Promise((resolve, reject) => {
      const req = http.get({ port, host: '127.0.0.1', path: '/api/stats/stream', headers: CLIENT }, (res) => {
        res.once('data', (chunk) => { resolve({ encoding: res.headers['content-encoding'], text: chunk.toString('utf8') }); req.destroy(); });
      });
      req.on('error', reject);
    });
    assert.equal(plain.encoding, undefined);
    assert.match(plain.text, /^event: snapshot\n/);

    const controller = new AbortController();
    const compressed = await fetch(`${hub.base}/api/stats/stream`, { headers: CLIENT, signal: controller.signal });
    assert.equal(compressed.headers.get('content-encoding'), 'gzip');
    const reader = compressed.body.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /^event: snapshot\n/, 'fetch decodes each gzip member as it arrives');
    controller.abort();
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});
