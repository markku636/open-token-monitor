'use strict';

// POST /api/ingest for the overlay: the same request and response contract as
// upstream's handler (docs/API.md), plus three things upstream does not do:
//
// - per-device coalescing: a device that uploads again within
//   TOKEN_MONITOR_INGEST_MIN_INTERVAL_MS is answered at once, and its newest
//   payload is applied when the interval is up. Widgets default to live uploads
//   every few seconds; this is what keeps one of them switched back to "live"
//   from costing the hub a full-store rewrite each time.
// - handing each applied record to the persistence queue (PostgreSQL);
// - an audit row per upload, including the ones that are refused;
// - input validation (ingestGuard.js) before upstream's merge runs.
//
// Payloads are folded, not dropped: a later payload without `history` or
// `limits` keeps the ones the replaced payload carried, which is exactly what
// upstream's mergeDeviceRecord would have preserved had both been applied.

const { performance } = require('node:perf_hooks');
const { upstream } = require('../upstream');
const { readJsonBody, sendJson } = require(upstream('src/shared/http'));
const { wantsMinimalResponse } = require(upstream('src/shared/hubProtocol'));
const { IngestRejected, checkIngestPayload } = require('./ingestGuard');

const SAMPLE_LIMIT = 1000;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function combinePayloads(pending, next) {
  if (next?.limitsOnly === true && pending?.limitsOnly !== true) {
    return hasOwn(next, 'limits') ? { ...pending, limits: next.limits } : pending;
  }
  const combined = { ...next };
  if (!hasOwn(next, 'history') && hasOwn(pending, 'history')) {
    combined.history = pending.history;
    if (hasOwn(pending, 'historyAvailable') && !hasOwn(next, 'historyAvailable')) combined.historyAvailable = pending.historyAvailable;
  }
  if (!hasOwn(next, 'limits') && hasOwn(pending, 'limits')) combined.limits = pending.limits;
  if (!hasOwn(next, 'ownerEmail') && hasOwn(pending, 'ownerEmail')) combined.ownerEmail = pending.ownerEmail;
  return combined;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

function createIngestPipeline(hub, {
  minIntervalMs = 0,
  persistence = null,
  audit = null,
  onApplied = () => {},
  // The company email an accepted upload says its user has (ownerEmail).
  // Upstream's merge drops the field, so this is the only place it is seen.
  onOwnerEmail = () => {},
  // The record the hub holds for a device, for the replay check.
  lookup = (deviceId) => hub.getDevices().find((record) => record.deviceId === deviceId) || null,
  // Stats for a legacy (non-minimal) response; the overlay passes its cache.
  statsProvider = () => hub.getStats(),
  logger = console,
  now = () => Date.now()
} = {}) {
  const devices = new Map();
  const samples = [];
  const counters = { received: 0, applied: 0, coalesced: 0, rejected: 0, replays: 0 };
  let stopped = false;

  function recordAudit(payload, meta, outcome) {
    if (!audit) return;
    audit.push({
      deviceId: String(payload?.deviceId || payload?.id || '').slice(0, 191),
      receivedAt: now(),
      sourceIp: meta?.sourceIp || '',
      authRole: meta?.role === 'admin' ? 'admin' : 'client',
      authKeyIndex: meta?.keyIndex ?? null,
      agentVersion: String(payload?.agentVersion || '').slice(0, 64),
      payloadBytes: meta?.bytes || 0,
      hadHistory: hasOwn(payload, 'history'),
      outcome
    });
  }

  function apply(payload, meta) {
    const started = performance.now();
    const record = hub.ingest(payload);
    samples.push(performance.now() - started);
    if (samples.length > SAMPLE_LIMIT) samples.shift();
    counters.applied += 1;
    persistence?.enqueue(record, { hadHistory: hasOwn(payload, 'history'), meta });
    onApplied(record);
    return record;
  }

  function stateFor(deviceId) {
    let state = devices.get(deviceId);
    if (!state) {
      state = { lastAppliedAt: -Infinity, pending: null, pendingMeta: null, timer: null };
      devices.set(deviceId, state);
    }
    return state;
  }

  function flushDevice(deviceId) {
    const state = devices.get(deviceId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (!state.pending) return;
    const payload = state.pending;
    const meta = state.pendingMeta;
    state.pending = null;
    state.pendingMeta = null;
    state.lastAppliedAt = now();
    try {
      apply(payload, meta);
    } catch (error) {
      counters.rejected += 1;
      (logger.warn || console.warn)(`[ingest] deferred upload from ${deviceId} was rejected: ${error.message}`);
    }
  }

  // The core, without HTTP: returns the device id the response names and
  // whether the payload reached the hub now or was folded into a pending one.
  function submit(payload, meta = {}) {
    counters.received += 1;
    const deviceId = String(payload.deviceId || payload.id);
    const state = stateFor(deviceId);
    const due = now() - state.lastAppliedAt >= minIntervalMs;
    if (stopped || minIntervalMs <= 0 || (!state.pending && due)) {
      state.lastAppliedAt = now();
      const record = apply(payload, meta);
      recordAudit(payload, meta, 'applied');
      return { deviceId: record.deviceId, applied: true, record };
    }
    state.pending = state.pending ? combinePayloads(state.pending, payload) : payload;
    state.pendingMeta = meta;
    counters.coalesced += 1;
    recordAudit(payload, meta, 'coalesced');
    if (!state.timer) {
      const wait = Math.max(0, state.lastAppliedAt + minIntervalMs - now());
      state.timer = setTimeout(() => flushDevice(deviceId), wait);
      state.timer.unref?.();
    }
    return { deviceId, applied: false };
  }

  function flushAll() {
    for (const deviceId of [...devices.keys()]) flushDevice(deviceId);
  }

  function refuse(res, payload, meta, status, body, extraHeaders) {
    counters.rejected += 1;
    recordAudit(payload && typeof payload === 'object' ? payload : {}, meta, 'rejected');
    return sendJson(res, status, body, extraHeaders);
  }

  async function handle(req, res, meta = {}) {
    const requestMeta = { ...meta, bytes: Number(req.headers['content-length']) || 0 };
    let payload;
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      if (error.code === 'payload_too_large') {
        res.shouldKeepAlive = false;
        return refuse(res, null, requestMeta, 413, { error: 'payload_too_large', message: error.message }, { connection: 'close' });
      }
      return refuse(res, null, requestMeta, 400, { error: 'bad_request', message: error.message });
    }
    if (!payload || (!payload.deviceId && !payload.id)) {
      return refuse(res, payload, requestMeta, 400, { error: 'deviceId_required' });
    }
    let checked;
    try {
      checked = checkIngestPayload(payload, { receivedAtMs: now(), previous: lookup(String(payload.deviceId || payload.id)) });
    } catch (error) {
      if (!(error instanceof IngestRejected)) throw error;
      // The rule name only; echoing the payload back would hand an attacker a
      // reflection primitive and bloat the log.
      return refuse(res, payload, requestMeta, 400, { error: 'bad_request', message: error.message });
    }
    const minimal = wantsMinimalResponse(req);
    if (checked.replay) {
      // Acknowledged, not applied: an older snapshot must not overwrite a newer
      // one, and an error would only make the device send it again.
      counters.replays += 1;
      recordAudit(payload, requestMeta, 'rejected');
      const response = { ok: true, deviceId: String(payload.deviceId || payload.id) };
      return sendJson(res, 200, minimal ? response : { ...response, stats: statsProvider() });
    }
    if (checked.payload.ownerEmail) {
      try {
        onOwnerEmail(String(checked.payload.deviceId || checked.payload.id), checked.payload.ownerEmail);
      } catch (error) {
        (logger.warn || console.warn)(`[ingest] recording the owner email failed: ${error.message}`);
      }
    }
    let result;
    try {
      result = submit(checked.payload, requestMeta);
    } catch (error) {
      if (error.message === 'deviceId_required') return refuse(res, payload, requestMeta, 400, { error: 'deviceId_required' });
      return refuse(res, payload, requestMeta, 400, { error: 'bad_request', message: error.message });
    }
    const response = { ok: true, deviceId: result.deviceId };
    return sendJson(res, 200, minimal ? response : { ...response, stats: statsProvider() });
  }

  return {
    handle,
    submit,
    // A deleted device must not be resurrected by an upload still waiting.
    forget(deviceId) {
      const state = devices.get(String(deviceId));
      if (state?.timer) clearTimeout(state.timer);
      devices.delete(String(deviceId));
    },
    flushAll,
    status() {
      const sorted = [...samples].sort((a, b) => a - b);
      return {
        ...counters,
        pending: [...devices.values()].filter((state) => state.pending).length,
        minIntervalMs,
        ingestMsP50: percentile(sorted, 50),
        ingestMsP95: percentile(sorted, 95)
      };
    },
    stop() {
      stopped = true;
      flushAll();
    }
  };
}

module.exports = { combinePayloads, createIngestPipeline };
