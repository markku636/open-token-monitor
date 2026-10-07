'use strict';

// 頻寬控制 (bandwidth control): the overlay serves /api/stats and /api/stats/stream from a
// windowed cache, in upstream's exact wire format.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

const { upstream } = require('../upstream');
const { createHub } = require(upstream('src/hub/server'));
const { bearer, post, quiet, removeAll, startOverlayHub, tempPath } = require('./helpers/overlayHub');
const { devicePayload } = require('./helpers/fixtures');

const CLIENT = bearer('client-secret');
const ADMIN = bearer('admin-secret');

// Reads SSE events from a stream until `until(events)` is satisfied or the
// deadline passes; returns what arrived.
async function readEvents(base, headers, { until, timeoutMs = 3000, onOpen }) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/stats/stream`, { headers: { accept: 'text/event-stream', ...headers }, signal: controller.signal });
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  let opened = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (chunk.startsWith(':')) continue;
        const event = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] || 'null');
        events.push({ event, data });
      }
      if (!opened && events.length) {
        opened = true;
        await onOpen?.();
      }
      if (until(events)) break;
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
  return { response, events };
}

test('/api/stats answers with upstream headers and upstream content', async () => {
  const plainFile = tempPath('plain.json');
  const plain = createHub({ port: 0, host: '127.0.0.1', secret: 'admin-secret', dataFile: plainFile, logger: quiet });
  await plain.start();
  const plainBase = `http://127.0.0.1:${plain.server.address().port}`;
  const hub = await startOverlayHub();
  try {
    const payload = devicePayload({ deviceId: 'dev-a' });
    plain.ingest(payload);
    await post(hub.base, '/api/ingest', payload, CLIENT);
    for (const encoding of ['gzip', 'identity']) {
      const expected = await fetch(`${plainBase}/api/stats`, { headers: { ...ADMIN, 'accept-encoding': encoding } });
      const actual = await fetch(`${hub.base}/api/stats`, { headers: { ...CLIENT, 'accept-encoding': encoding } });
      const pick = (response) => Object.fromEntries([...response.headers].filter(([name]) => !['date', 'content-length', 'connection', 'keep-alive'].includes(name)));
      assert.deepEqual(pick(actual), pick(expected), `headers (${encoding})`);
      const scrub = (stats) => JSON.parse(JSON.stringify(stats, (key, value) => (['updatedAt', 'receivedAt', 'ageMs', 'subscriptionsUpdatedAt'].includes(key) ? '<volatile>' : value)));
      assert.deepEqual(scrub(await actual.json()), scrub(await expected.json()));
    }
  } finally {
    await plain.stop();
    await hub.stop();
    removeAll(hub.dataFile, plainFile);
    fs.rmSync(plainFile, { force: true });
  }
});

test('uploads inside one window reach a stream as one stats event, then freshness', async () => {
  // The window timer runs on its own phase, so the uploads may straddle one
  // tick; they go out together and the window is wide enough that they land in
  // one window, at worst two, even on a loaded machine.
  const windowMs = 1000;
  const hub = await startOverlayHub({ streamWindowMs: windowMs });
  try {
    await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-0' }), CLIENT);
    const { events } = await readEvents(hub.base, { ...CLIENT, 'x-token-monitor-stream': '2' }, {
      timeoutMs: 8000,
      async onOpen() {
        await Promise.all([1, 2, 3, 4, 5].map((i) => post(hub.base, '/api/ingest', devicePayload({ deviceId: `dev-${i}` }), CLIENT)));
        // Only its timestamp moves, so a later window carries freshness.
        setTimeout(() => post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-1', updatedAt: new Date().toISOString() }), CLIENT), windowMs * 1.5);
      },
      until: (list) => list.some((e) => e.event === 'freshness')
    });
    assert.equal(events[0].event, 'snapshot');
    assert.deepEqual(Object.keys(events[0].data), ['type', 'reason', 'stats', 'at']);
    assert.equal(events[0].data.reason, 'snapshot');
    const stats = events.filter((e) => e.event === 'stats');
    assert.ok(stats.length >= 1 && stats.length <= 2, `five uploads are coalesced into one broadcast (two if they straddled a tick), got ${stats.length}`);
    assert.ok(stats.every((e) => e.data.reason === 'ingest'));
    assert.equal(stats.at(-1).data.stats.devices.length, 6, 'every widget sees every device');
    const freshness = events.find((e) => e.event === 'freshness');
    assert.equal(freshness.data.type, 'freshness');
    assert.ok(Array.isArray(freshness.data.stats.devices));
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

test('a delete reaches connected streams at once, not at the end of the window', async () => {
  const hub = await startOverlayHub({ streamWindowMs: 60 * 1000 });
  try {
    await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-a' }), CLIENT);
    await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-b' }), CLIENT);
    const started = Date.now();
    const { events } = await readEvents(hub.base, CLIENT, {
      async onOpen() {
        await fetch(`${hub.base}/api/devices/dev-a`, { method: 'DELETE', headers: ADMIN });
      },
      until: (list) => list.some((e) => e.event === 'stats')
    });
    const update = events.find((e) => e.event === 'stats');
    assert.equal(update.data.reason, 'delete');
    assert.deepEqual(update.data.stats.devices.map((d) => d.deviceId), ['dev-b']);
    assert.ok(Date.now() - started < 3000);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

test('stopping the hub closes the overlay streams instead of hanging on them', async () => {
  const hub = await startOverlayHub();
  const controller = new AbortController();
  const response = await fetch(`${hub.base}/api/stats/stream`, { headers: CLIENT, signal: controller.signal });
  assert.equal(response.status, 200);
  const started = Date.now();
  await hub.stop();
  assert.ok(Date.now() - started < 2000);
  controller.abort();
  removeAll(hub.dataFile);
});
