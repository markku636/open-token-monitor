'use strict';

// The hub's data core, owned by the overlay when a database is configured
// ("route B": the overlay keeps its own core instead of upstream's JSON store).
//
// Upstream's createHub() keeps the same state in a closure and rewrites its
// whole JSON file on every upload: measured at 300 devices, one ingest() spends
// ~170 ms, 77 ms of it pretty-printing a 21 MB store, and it grows with every
// day of history. With the database as the store that rewrite buys nothing, so
// the overlay keeps the state here instead and persists only what changed.
//
// This mirrors upstream's createHub() internals (src/hub/server.js) statement
// for statement, built from the same exported helpers, so merge, aggregation
// and subscription semantics are upstream's. tests/core.test.js runs the
// same operations through both and fails when upstream changes any of them.

const { upstream } = require('../upstream');
const {
  aggregateDevices,
  aggregateHistory,
  mergeDeviceRecord,
  stripSessionTextFromDeviceRecord
} = require(upstream('src/shared/usage'));
const { DEFAULT_STALE_AFTER_MS } = require(upstream('src/shared/syncUploadInterval'));
const { deviceHistoryRevision, historyPreview, historyRevision } = require(upstream('src/shared/history'));
const {
  emptySubscriptionDocument,
  isStaleSubscriptionWrite,
  subscriptionDocument
} = require(upstream('src/shared/subscriptionDisplay'));
const { CURRENCY_CODES, normalizeCurrency } = require(upstream('src/shared/currency'));
const { currentHubBuild } = require(upstream('src/shared/hubBuildIdentity'));

function createHubCore({ staleAfterMs = DEFAULT_STALE_AFTER_MS, secret = '', devices = {}, subscriptions = null } = {}) {
  const store = {
    version: 1,
    devices: { ...(devices && typeof devices === 'object' ? devices : {}) },
    subscriptions: subscriptions && typeof subscriptions === 'object' ? subscriptions : emptySubscriptionDocument()
  };

  function getStats() {
    const stats = aggregateDevices(Object.values(store.devices), staleAfterMs);
    stats.staleAfterMs = staleAfterMs;
    const history = aggregateHistory(Object.values(store.devices));
    stats.historyPreview = historyPreview(history);
    stats.historyRevision = historyRevision(history);
    stats.deviceHistoryRevision = deviceHistoryRevision(Object.values(store.devices));
    stats.subscriptionsUpdatedAt = store.subscriptions?.updatedAt || '';
    return stats;
  }

  // Not in upstream's hub object: getStats() for some devices only, for the
  // dashboard's company / department / team filter (org.js). The same steps as
  // getStats() above on the chosen records; core.test.js checks that all of
  // them give exactly getStats().
  function getStatsFor(deviceIds) {
    const records = [...deviceIds].filter((id) => Object.prototype.hasOwnProperty.call(store.devices, id)).map((id) => store.devices[id]);
    const stats = aggregateDevices(records, staleAfterMs);
    stats.staleAfterMs = staleAfterMs;
    const history = aggregateHistory(records);
    stats.historyPreview = historyPreview(history);
    stats.historyRevision = historyRevision(history);
    stats.deviceHistoryRevision = deviceHistoryRevision(records);
    stats.subscriptionsUpdatedAt = store.subscriptions?.updatedAt || '';
    return stats;
  }

  function getHistory() {
    return aggregateHistory(Object.values(store.devices));
  }

  function getDevices() {
    return Object.values(store.devices);
  }

  // Not in upstream's hub object; the overlay's replay check uses it.
  function getDevice(deviceId) {
    return Object.prototype.hasOwnProperty.call(store.devices, deviceId) ? store.devices[deviceId] : null;
  }

  function ingest(payload) {
    if (!payload || (!payload.deviceId && !payload.id)) {
      throw new Error('deviceId_required');
    }
    const deviceId = String(payload.deviceId || payload.id);
    const existing = stripSessionTextFromDeviceRecord(store.devices[deviceId]);
    const incoming = stripSessionTextFromDeviceRecord(payload);
    const record = mergeDeviceRecord(existing, { ...incoming, receivedAt: new Date().toISOString() });
    store.devices[record.deviceId] = record;
    return record;
  }

  function deleteDevice(deviceId) {
    delete store.devices[deviceId];
  }

  function getSubscriptions() {
    return store.subscriptions;
  }

  // Upstream validates, persists, then moves the in-memory list. The split lets
  // the overlay put its database write where upstream's file write is: after
  // validation, before the list any reader sees changes.
  function prepareSubscriptions(subscriptions, baseUpdatedAt) {
    if (!Array.isArray(subscriptions)) {
      const error = new Error('subscriptions must be an array');
      error.code = 'bad_subscriptions';
      throw error;
    }
    if (isStaleSubscriptionWrite(store.subscriptions, baseUpdatedAt)) {
      const error = new Error('stale_write');
      error.code = 'stale_write';
      error.current = store.subscriptions;
      throw error;
    }
    const unsupported = subscriptions.find(
      (entry) => entry?.currency && !CURRENCY_CODES.includes(String(entry.currency).trim().toUpperCase())
    );
    if (unsupported) {
      const error = new Error(`unsupported currency: ${String(unsupported.currency).trim().toUpperCase()}`);
      error.code = 'bad_subscriptions';
      throw error;
    }
    return subscriptionDocument(subscriptions, {
      previousUpdatedAt: store.subscriptions?.updatedAt,
      currencyApi: { normalizeCurrency }
    });
  }

  function commitSubscriptions(document) {
    store.subscriptions = document;
    return store.subscriptions;
  }

  function setSubscriptions(subscriptions, baseUpdatedAt) {
    return commitSubscriptions(prepareSubscriptions(subscriptions, baseUpdatedAt));
  }

  function health() {
    return {
      ok: true,
      role: 'hub',
      runtime: 'node-hub',
      version: store.version || 1,
      hubBuild: currentHubBuild('node-hub'),
      deviceCount: Object.keys(store.devices).length,
      secretRequired: Boolean(secret),
      now: new Date().toISOString()
    };
  }

  return {
    getStats,
    getStatsFor,
    getHistory,
    getDevices,
    getDevice,
    ingest,
    deleteDevice,
    getSubscriptions,
    prepareSubscriptions,
    commitSubscriptions,
    setSubscriptions,
    health
  };
}

module.exports = { createHubCore };
