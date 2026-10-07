'use strict';

// Per-device ingest coalescing: a device uploading faster than the
// minimum interval is answered at once and applied once per interval, without
// losing anything upstream's merge would have kept.

const assert = require('node:assert/strict');
const test = require('node:test');

const { combinePayloads, createIngestPipeline } = require('../hub/ingest');
const { devicePayload } = require('./helpers/fixtures');

function fakeHub() {
  const applied = [];
  return {
    applied,
    ingest(payload) {
      applied.push(payload);
      return { deviceId: String(payload.deviceId || payload.id) };
    },
    getStats() {
      return {};
    }
  };
}

test('a later payload keeps the history and limits the payload it replaced carried', () => {
  const withHistory = { deviceId: 'd', history: { daily: [1] }, historyAvailable: true, limits: { providers: [1] }, today: 1 };
  const plain = { deviceId: 'd', today: 2 };
  assert.deepEqual(combinePayloads(withHistory, plain), { deviceId: 'd', today: 2, history: { daily: [1] }, historyAvailable: true, limits: { providers: [1] } });
  const newerHistory = { deviceId: 'd', history: { daily: [2] }, today: 3 };
  assert.deepEqual(combinePayloads(withHistory, newerHistory).history, { daily: [2] });
  // A legacy limits-only update only replaces the limits of a full pending one.
  assert.deepEqual(combinePayloads(plain, { deviceId: 'd', limitsOnly: true, limits: { providers: [9] } }), { deviceId: 'd', today: 2, limits: { providers: [9] } });
});

test('uploads inside the interval are answered at once and applied once, newest last', async () => {
  let clock = 1000;
  const hub = fakeHub();
  const applied = [];
  const pipeline = createIngestPipeline(hub, { minIntervalMs: 60000, now: () => clock, onApplied: (record) => applied.push(record.deviceId) });
  try {
    assert.equal(pipeline.submit(devicePayload({ deviceId: 'd', tokens: 1 })).applied, true);
    clock += 1000;
    assert.equal(pipeline.submit(devicePayload({ deviceId: 'd', tokens: 2 })).applied, false);
    assert.equal(pipeline.submit(devicePayload({ deviceId: 'd', tokens: 3 })).applied, false);
    assert.equal(pipeline.submit(devicePayload({ deviceId: 'other' })).applied, true, 'devices are coalesced independently');
    assert.equal(hub.applied.length, 2);
    clock += 60000;
    pipeline.flushAll();
    assert.equal(hub.applied.length, 3);
    assert.equal(hub.applied[2].today.totalTokens, 3, 'the newest payload is the one applied');
    assert.deepEqual(applied, ['d', 'other', 'd']);
    const status = pipeline.status();
    assert.deepEqual([status.received, status.applied, status.coalesced], [4, 3, 2]);
  } finally {
    pipeline.stop();
  }
});

test('a deleted device is not resurrected by an upload still waiting', () => {
  let clock = 0;
  const hub = fakeHub();
  const pipeline = createIngestPipeline(hub, { minIntervalMs: 60000, now: () => clock });
  pipeline.submit(devicePayload({ deviceId: 'd' }));
  clock += 10;
  pipeline.submit(devicePayload({ deviceId: 'd' }));
  pipeline.forget('d');
  pipeline.flushAll();
  assert.equal(hub.applied.length, 1);
  pipeline.stop();
});

test('stopping the pipeline applies what is waiting', () => {
  let clock = 0;
  const hub = fakeHub();
  const pipeline = createIngestPipeline(hub, { minIntervalMs: 60000, now: () => clock });
  pipeline.submit(devicePayload({ deviceId: 'd' }));
  clock += 10;
  pipeline.submit(devicePayload({ deviceId: 'd', tokens: 7 }));
  pipeline.stop();
  assert.equal(hub.applied.length, 2);
  assert.equal(hub.applied[1].today.totalTokens, 7);
});
