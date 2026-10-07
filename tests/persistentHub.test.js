'use strict';

// End to end over HTTP: the overlay hub with a PostgreSQL store (PGlite) behaves like
// upstream on the wire, persists what it is sent, and comes back after a
// restart exactly as it was.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { upstream } = require('../upstream');
const { createHub } = require(upstream('src/hub/server'));
const { writeJsonAtomic } = require(upstream('src/shared/config'));
const { createStore } = require('../hub/persistence/store');
const { openPglite } = require('./helpers/pg');
const { captureRows } = require('../hub/persistence/capture');
const { bearer, post, quiet, removeAll, startOverlayHub, tempPath } = require('./helpers/overlayHub');
const { dayKey, devicePayload, historyDay, merged } = require('./helpers/fixtures');

const CLIENT = bearer('client-secret');
const ADMIN = bearer('admin-secret');

async function json(response) {
  return { status: response.status, body: await response.json() };
}

// Timestamps differ between two hubs by construction.
function withoutTimes(result) {
  return JSON.parse(JSON.stringify(result, (key, value) => (key === 'updatedAt' ? '<time>' : value)));
}

test('uploads reach the database and a restart restores the hub exactly, receivedAt included', async () => {
  // A device that last reported an hour ago, already in the database.
  const seedDriver = await openPglite();
  const schema = seedDriver.schema;
  const seed = createStore(seedDriver);
  await seed.migrate();
  const old = merged(devicePayload({ deviceId: 'dev-old', extra: { syncUploadIntervalMs: 0 } }), undefined, new Date(Date.now() - 3600000).toISOString());
  await seed.writeCapture(captureRows(undefined, old));
  await seed.close();

  let hub = await startOverlayHub({ database: schema });
  let before;
  try {
    const history = { daily: [historyDay(dayKey(-1)), historyDay(dayKey(-2))], monthly: [], summary: {} };
    const upload = await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-a', history }), CLIENT);
    assert.deepEqual(await upload.json(), { ok: true, deviceId: 'dev-a' });
    await hub.settle();

    const rows = await hub.overlay.persistence.store.query('SELECT device_id, usage_date, source FROM device_daily_usage ORDER BY device_id, usage_date');
    assert.deepEqual(rows.filter((r) => r.device_id === 'dev-a').map((r) => r.source), ['history', 'history', 'live']);
    const [audit] = await hub.overlay.persistence.store.query('SELECT device_id, auth_role, auth_key_index, outcome, source_ip FROM ingest_events');
    assert.deepEqual([audit.device_id, audit.auth_role, audit.auth_key_index, audit.outcome, audit.source_ip], ['dev-a', 'client', 0, 'applied', '127.0.0.1']);

    before = (await json(await fetch(`${hub.base}/api/devices`, { headers: ADMIN }))).body.devices;
    assert.equal(before.length, 2);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }

  // A fresh cache file: everything has to come back from the database.
  const freshCache = tempPath('devices.json');
  hub = await startOverlayHub({ database: schema, dataFile: freshCache });
  try {
    const after = (await json(await fetch(`${hub.base}/api/devices`, { headers: ADMIN }))).body.devices;
    const byId = (list) => Object.fromEntries(list.map((d) => [d.deviceId, d]));
    assert.deepEqual(byId(after), byId(before));
    const stats = (await json(await fetch(`${hub.base}/api/stats`, { headers: CLIENT }))).body;
    const oldDevice = stats.devices.find((d) => d.deviceId === 'dev-old');
    assert.equal(oldDevice.stale, true, 'a device offline before the restart must not look fresh after it');
    assert.equal(stats.devices.find((d) => d.deviceId === 'dev-a').stale, false);
  } finally {
    await hub.stop();
    removeAll(freshCache);
  }
});

test('deletes and subscription edits are admin-only, persisted, and survive a restart', async () => {
  let hub = await startOverlayHub({ database: true });
  const { schema } = hub;
  let subscriptions;
  try {
    await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-a' }), CLIENT);
    await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-b' }), CLIENT);
    await hub.settle();

    const clientDelete = await fetch(`${hub.base}/api/devices/dev-a`, { method: 'DELETE', headers: CLIENT });
    assert.deepEqual(await json(clientDelete), { status: 403, body: { error: 'forbidden' } });
    const adminDelete = await fetch(`${hub.base}/api/devices/dev-a`, { method: 'DELETE', headers: ADMIN });
    assert.deepEqual(await json(adminDelete), { status: 200, body: { ok: true, deviceId: 'dev-a' } });

    const body = JSON.stringify({ subscriptions: [{ provider: 'claude', planName: 'Max', amountMinor: 20000, currency: 'USD', interval: 'month', startDate: '2026-09-01' }], baseUpdatedAt: '' });
    const clientPut = await fetch(`${hub.base}/api/subscriptions`, { method: 'PUT', headers: { ...CLIENT, 'content-type': 'application/json' }, body });
    assert.equal(clientPut.status, 403);
    const adminPut = await json(await fetch(`${hub.base}/api/subscriptions`, { method: 'PUT', headers: { ...ADMIN, 'content-type': 'application/json' }, body }));
    assert.equal(adminPut.status, 200);
    subscriptions = adminPut.body;
    const [row] = await hub.overlay.persistence.store.query('SELECT deleted_at FROM devices WHERE device_id = $1', ['dev-a']);
    assert.ok(row.deleted_at, 'the delete is recorded, the history kept');
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }

  const freshCache = tempPath('devices.json');
  hub = await startOverlayHub({ database: schema, dataFile: freshCache });
  try {
    const devices = (await json(await fetch(`${hub.base}/api/devices`, { headers: ADMIN }))).body.devices;
    assert.deepEqual(devices.map((d) => d.deviceId), ['dev-b']);
    const restored = (await json(await fetch(`${hub.base}/api/subscriptions`, { headers: CLIENT }))).body;
    assert.equal(restored.updatedAt, subscriptions.updatedAt);
    assert.deepEqual(restored.subscriptions, subscriptions.subscriptions);
  } finally {
    await hub.stop();
    removeAll(freshCache);
  }
});

// A new installation starts from an empty database: the JSON file is only
// the cache the database is written into, never a source of devices.
test('the database is the source of truth: a JSON file it does not hold is replaced', async () => {
  const cache = tempPath('devices.json');
  const legacy = createHub({ port: 0, host: '127.0.0.1', dataFile: cache, logger: quiet });
  legacy.ingest(devicePayload({ deviceId: 'dev-legacy' }));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cache, 'utf8')).devices), ['dev-legacy']);
  const hub = await startOverlayHub({ database: true, dataFile: cache });
  try {
    const devices = (await json(await fetch(`${hub.base}/api/devices`, { headers: ADMIN }))).body.devices;
    assert.deepEqual(devices, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(cache, 'utf8')).devices, {});
  } finally {
    await hub.stop();
    removeAll(cache);
  }
});

test('a write the database refuses is answered 503 and undone in memory', async () => {
  const hub = await startOverlayHub({ database: true });
  try {
    await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-a' }), CLIENT);
    await hub.settle();
    const store = hub.overlay.persistence.store;
    store.writeSubscriptions = async () => { throw new Error('database unavailable'); };
    store.softDeleteDevice = async () => { throw new Error('database unavailable'); };

    const put = await json(await fetch(`${hub.base}/api/subscriptions`, {
      method: 'PUT',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ subscriptions: [{ provider: 'claude', planName: 'Max', amountMinor: 20000, currency: 'USD', interval: 'month', startDate: '2026-09-01' }], baseUpdatedAt: '' })
    }));
    assert.equal(put.status, 503);
    assert.equal(put.body.error, 'storage_unavailable');
    assert.deepEqual(hub.hub.getSubscriptions().subscriptions, [], 'the rejected records are not served');

    const del = await json(await fetch(`${hub.base}/api/devices/dev-a`, { method: 'DELETE', headers: ADMIN }));
    assert.equal(del.status, 503);
    assert.equal(hub.hub.getDevices().length, 1, 'the device stays when its delete could not be recorded');
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

// Error answers must be upstream's, so widgets and agents cannot tell the
// overlay from a plain hub.
test('ingest and subscription errors match a plain upstream hub', async () => {
  const plainFile = tempPath('plain.json');
  const plain = createHub({ port: 0, host: '127.0.0.1', secret: 'admin-secret', dataFile: plainFile, logger: quiet });
  await plain.start();
  const plainBase = `http://127.0.0.1:${plain.server.address().port}`;
  const hub = await startOverlayHub({ database: true });
  const cases = [
    ['ingest without deviceId', 'POST', '/api/ingest', JSON.stringify({ today: {} }), ADMIN],
    ['ingest with invalid JSON', 'POST', '/api/ingest', '{"deviceId":', ADMIN],
    ['ingest without a secret', 'POST', '/api/ingest', JSON.stringify(devicePayload()), {}],
    ['ingest with a wrong secret', 'POST', '/api/ingest', JSON.stringify(devicePayload()), bearer('nope')],
    ['ingest over 1 MiB', 'POST', '/api/ingest', JSON.stringify({ deviceId: 'x', pad: 'x'.repeat(1024 * 1024) }), ADMIN],
    ['subscriptions not an array', 'PUT', '/api/subscriptions', JSON.stringify({ subscriptions: {}, baseUpdatedAt: '' }), ADMIN],
    ['subscriptions with an unknown currency', 'PUT', '/api/subscriptions', JSON.stringify({ subscriptions: [{ provider: 'claude', amountMinor: 1, currency: 'XYZ' }], baseUpdatedAt: '' }), ADMIN],
    ['a stale subscriptions write', 'PUT', '/api/subscriptions', JSON.stringify({ subscriptions: [], baseUpdatedAt: '2020-01-01T00:00:00.000Z' }), ADMIN],
    ['an unknown route', 'GET', '/api/nope', undefined, ADMIN]
  ];
  try {
    // Give both a written subscription list, so a write against an old token
    // is genuinely stale on both.
    const first = { method: 'PUT', headers: { ...ADMIN, 'content-type': 'application/json' }, body: JSON.stringify({ subscriptions: [], baseUpdatedAt: '' }) };
    assert.equal((await fetch(`${plainBase}/api/subscriptions`, first)).status, 200);
    assert.equal((await fetch(`${hub.base}/api/subscriptions`, first)).status, 200);
    for (const [name, method, pathname, body, headers] of cases) {
      const request = { method, headers: { 'content-type': 'application/json', 'x-token-monitor-response': 'minimal', ...headers }, body };
      const expected = await fetch(`${plainBase}${pathname}`, request).then(json).catch((error) => ({ error: error.message }));
      const actual = await fetch(`${hub.base}${pathname}`, request).then(json).catch((error) => ({ error: error.message }));
      assert.deepEqual(withoutTimes(actual), withoutTimes(expected), name);
    }
  } finally {
    await plain.stop();
    await hub.stop();
    removeAll(plainFile, hub.dataFile);
  }
});

test('without a store the overlay still serves the hub from its JSON file', async () => {
  const hub = await startOverlayHub();
  try {
    await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-a' }), CLIENT);
    const health = (await json(await fetch(`${hub.base}/api/custom/health`, { headers: ADMIN }))).body;
    assert.equal(health.persistence.kind, 'none');
    const report = await json(await fetch(`${hub.base}/api/reports/v1/devices`, { headers: ADMIN }));
    assert.equal(report.status, 503);
    assert.equal(report.body.error, 'store_unavailable');
    const saved = JSON.parse(fs.readFileSync(hub.dataFile, 'utf8'));
    assert.deepEqual(Object.keys(saved.devices), ['dev-a']);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

test('writeJsonAtomic is the seam rehydration relies on', () => {
  // openPersistence writes the cache with upstream's own writer, so a change to
  // its signature has to fail here rather than at the first production boot.
  const file = tempPath('seam.json');
  writeJsonAtomic(file, { version: 1, devices: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, devices: {} });
  removeAll(file);
});
