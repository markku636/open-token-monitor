'use strict';

// The ingest guard's input rules: what an upload may not carry before it
// reaches upstream's merge (hub/ingestGuard.js).

const assert = require('node:assert/strict');
const test = require('node:test');

const { checkIngestPayload } = require('../hub/ingestGuard');
const { bearer, post, removeAll, startOverlayHub } = require('./helpers/overlayHub');
const { dayKey, devicePayload, historyDay } = require('./helpers/fixtures');

const CLIENT = bearer('client-secret');

function rule(payload) {
  try {
    checkIngestPayload(payload);
    return 'accepted';
  } catch (error) {
    return error.rule;
  }
}

function rawPost(base, body) {
  return fetch(`${base}/api/ingest`, { method: 'POST', headers: { ...CLIENT, 'content-type': 'application/json', 'x-token-monitor-response': 'minimal' }, body });
}

test('prototype keys are refused at any depth', async () => {
  const hub = await startOverlayHub();
  try {
    const top = await rawPost(hub.base, '{"deviceId":"x","periods":{"today":{"clientModels":{"__proto__":{"tokens":7}}}}}');
    assert.equal(top.status, 400);
    assert.deepEqual(await top.json(), { error: 'bad_request', message: 'payload rejected: forbidden_key' });
    const nested = await rawPost(hub.base, '{"deviceId":"x","history":{"daily":[{"date":"2026-09-01","perClient":{"constructor":{"tokens":1}}}]}}');
    assert.equal(nested.status, 400);
    await nested.arrayBuffer();
    assert.equal((await fetch(`${hub.base}/api/stats`, { headers: CLIENT })).status, 200);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

test('history rows of the wrong shape are refused, and stats and history still answer', async () => {
  const hub = await startOverlayHub();
  try {
    for (const history of [{ daily: [null], monthly: [] }, { daily: [{ date: '2026-09-01', perClient: { x: null } }], monthly: [] }, { daily: [{ date: '2026-02-31' }] }, { monthly: [{ month: '2026-13' }] }]) {
      const response = await post(hub.base, '/api/ingest', { ...devicePayload(), history }, CLIENT);
      assert.equal(response.status, 400, JSON.stringify(history));
      await response.arrayBuffer();
    }
    assert.equal((await fetch(`${hub.base}/api/stats`, { headers: CLIENT })).status, 200);
    assert.equal((await fetch(`${hub.base}/api/history`, { headers: CLIENT })).status, 200);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

test('wrongly typed fields, deep nesting and out-of-range numbers are refused', () => {
  assert.equal(rule({ deviceId: 'x', updatedAt: 1e15 }), 'field_updatedAt');
  assert.equal(rule({ deviceId: 'x', agentVersion: { a: 1 } }), 'field_agentVersion');
  let deep = [];
  for (let i = 0; i < 40; i += 1) deep = [deep];
  assert.equal(rule({ deviceId: 'x', history: { summary: { deep } } }), 'too_deep');
  assert.equal(rule({ deviceId: 'x', hostname: 'h'.repeat(300) }), 'field_hostname');
  assert.equal(rule(JSON.parse('{"deviceId":"x","today":{"totalTokens":1e400}}')), 'number_out_of_range');
  assert.equal(rule(devicePayload({ history: { daily: Array.from({ length: 370 }, (_, i) => historyDay(dayKey(-370 + i))), monthly: [], summary: {} } })), 'accepted', 'a full first-upload history passes');
});
