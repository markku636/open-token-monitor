'use strict';

// hub/core.js mirrors the data core of upstream's createHub(). Two
// tripwires keep it honest: the same operations must give the same results
// through both, and the upstream functions it mirrors must still be the ones
// it was written against.

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');

const { upstream } = require('../upstream');
const { createHub } = require(upstream('src/hub/server'));
const { createHubCore } = require('../hub/core');
const { quiet, removeAll, tempPath } = require('./helpers/overlayHub');
const { dayKey, devicePayload, historyDay } = require('./helpers/fixtures');

// Normalized source fingerprints of the upstream functions core.js mirrors.
// When one changes, read the new upstream function, bring core.js in line,
// then update its fingerprint here.
const UPSTREAM_FINGERPRINTS = Object.freeze({
  getStats: '2d8d6ac8cf8cc067',
  getHistory: '616c006e4fe23b70',
  getDevices: 'fe2ebe0921acd152',
  ingest: '8687ca859cc92d76',
  deleteDevice: 'a066d024408fc30b',
  setSubscriptions: '1ffbb79acbfa9e9f'
});

function upstreamFunction(source, name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `src/hub/server.js no longer has function ${name}()`);
  let depth = 0;
  let index = source.indexOf('{', start);
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) break;
  }
  return source.slice(start, index + 1);
}

function fingerprint(text) {
  const normalized = text.split('\n').map((line) => line.replace(/\/\/.*$/, '').trim()).filter(Boolean).join('\n');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

test('the upstream functions core.js mirrors are unchanged', () => {
  const source = fs.readFileSync(upstream('src/hub/server.js'), 'utf8');
  for (const [name, expected] of Object.entries(UPSTREAM_FINGERPRINTS)) {
    assert.equal(fingerprint(upstreamFunction(source, name)), expected, `upstream ${name}() changed: compare it with hub/core.js, then update the fingerprint`);
  }
});

// Values that differ between two hubs by construction (clocks, random ids).
function scrub(value) {
  return JSON.parse(JSON.stringify(value, (key, v) => (['receivedAt', 'ageMs', 'updatedAt', 'subscriptionsUpdatedAt', 'now', 'id'].includes(key) ? '<volatile>' : v)));
}

function both(fn) {
  const file = tempPath('core-diff.json');
  const upstream = createHub({ port: 0, host: '127.0.0.1', secret: 's', dataFile: file, logger: quiet });
  const core = createHubCore({ secret: 's' });
  try {
    return fn(upstream, core);
  } finally {
    removeAll(file);
  }
}

function outcome(fn) {
  try {
    return { value: scrub(fn()) };
  } catch (error) {
    return { error: error.message, code: error.code, current: error.current ? scrub(error.current) : undefined };
  }
}

test('the same uploads, deletes and subscription writes give upstream\'s results', () => {
  both((upstream, core) => {
    const steps = [
      (hub) => hub.ingest(devicePayload({ deviceId: 'a', history: { daily: [historyDay(dayKey(-1))], monthly: [], summary: {} } })),
      (hub) => hub.ingest(devicePayload({ deviceId: 'b', tokens: 3000 })),
      (hub) => hub.ingest(devicePayload({ deviceId: 'a', tokens: 1500 })), // carries a's history forward
      (hub) => hub.ingest({ deviceId: 'a', limitsOnly: true, limits: { providers: [] } }),
      (hub) => hub.ingest({ today: {} }), // deviceId_required
      (hub) => hub.deleteDevice('b'),
      (hub) => hub.setSubscriptions({}, ''),
      (hub) => hub.setSubscriptions([{ provider: 'claude', amountMinor: 1, currency: 'XYZ' }], ''),
      (hub) => hub.setSubscriptions([{ provider: 'claude', planName: 'Max', amountMinor: 20000, currency: 'USD', interval: 'month', startDate: '2026-09-01' }], ''),
      (hub) => hub.setSubscriptions([], '2020-01-01T00:00:00.000Z') // stale
    ];
    for (const [index, step] of steps.entries()) {
      assert.deepEqual(outcome(() => step(core)), outcome(() => step(upstream)), `step ${index}`);
      assert.deepEqual(scrub(core.getStats()), scrub(upstream.getStats()), `stats after step ${index}`);
      assert.deepEqual(scrub(core.getDevices()), scrub(upstream.getDevices()), `devices after step ${index}`);
      assert.deepEqual(scrub(core.getHistory()), scrub(upstream.getHistory()), `history after step ${index}`);
      assert.deepEqual(scrub(core.getSubscriptions()), scrub(upstream.getSubscriptions()), `subscriptions after step ${index}`);
    }
  });
});

test('the health answer has upstream\'s shape', async () => {
  const file = tempPath('core-health.json');
  const upstream = createHub({ port: 0, host: '127.0.0.1', secret: 's', dataFile: file, logger: quiet });
  await upstream.start();
  try {
    const expected = await (await fetch(`http://127.0.0.1:${upstream.server.address().port}/api/health`)).json();
    assert.deepEqual(scrub(createHubCore({ secret: 's' }).health()), scrub(expected));
  } finally {
    await upstream.stop();
    removeAll(file);
  }
});

test('stats for a set of devices are getStats() for just those devices', () => {
  const core = createHubCore();
  core.ingest(devicePayload({ deviceId: 'a', tokens: 1000, history: { daily: [historyDay(dayKey(-1))], monthly: [], summary: {} } }));
  core.ingest(devicePayload({ deviceId: 'b', tokens: 3000 }));
  assert.deepEqual(scrub(core.getStatsFor(new Set(['a', 'b']))), scrub(core.getStats()), 'every device is the whole hub');

  const onlyB = core.getStatsFor(['b', 'missing']);
  assert.deepEqual(onlyB.devices.map((d) => d.deviceId), ['b'], 'unknown ids are ignored');
  assert.equal(onlyB.periods.today.totalTokens, 3000);
  assert.equal(onlyB.historyPreview.daily.length, 0, 'a\'s history is not in b\'s stats');
  assert.deepEqual(core.getStatsFor([]).devices, []);
});

test('a subscription write is only visible once it is committed', () => {
  const core = createHubCore();
  const next = core.prepareSubscriptions([{ provider: 'claude', planName: 'Max', amountMinor: 1000, currency: 'USD', interval: 'month', startDate: '2026-09-01' }], '');
  assert.deepEqual(core.getSubscriptions().subscriptions, [], 'prepared, not yet visible');
  core.commitSubscriptions(next);
  assert.equal(core.getSubscriptions().subscriptions.length, 1);
});
