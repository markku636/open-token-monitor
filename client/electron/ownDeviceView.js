'use strict';

// The company client shows this machine's usage only (TM_CLIENT_OWN_DEVICE_ONLY,
// on by default). In client mode upstream shows what the hub merges from every
// device that uploads to it: everyone's totals, models, history and the limits
// of every signed-in account. The entry installs the wrappers below over the
// upstream exports that bring that merge to the widget, before upstream's
// src/electron/main.js loads and destructures them. Uploads are unchanged, so
// the hub and its dashboard still have every device.
//
// Which device is this one: the local record's deviceId, else settings.json's,
// else upstream's default (the hostname), the order upstream itself uses.

const fs = require('node:fs');

// Hub /api/stats fields merged across devices. The view recomputes them from
// this device's record alone; a hub field in neither list fails
// ownDeviceView.test.js until it is sorted into one.
const AGGREGATE_STATS_KEYS = Object.freeze([
  'updatedAt',
  'periods',
  'devices',
  'projectsIncomplete',
  'limits',
  'sessionDetailsOmitted',
  'periodProjectsOmitted',
  'historyPreview',
  'historyRevision',
  'deviceHistoryRevision'
]);

// Hub fields about no device in particular, passed through as they are.
const PASS_THROUGH_STATS_KEYS = Object.freeze(['staleAfterMs', 'subscriptionsUpdatedAt']);

// The upstream exports replaced, by module.
const REPLACED_EXPORTS = Object.freeze({
  syncDisplayStats: Object.freeze(['composeLocalSyncSummary']),
  historySource: Object.freeze(['resolveCompleteHistory', 'resolveCompleteHistoryWithDevices']),
  macWidgetHistory: Object.freeze(['macWidgetHistorySourceKey'])
});

// And what the wrappers call.
const REQUIRED_EXPORTS = Object.freeze({
  historySource: Object.freeze(['completeHistorySource']),
  usage: Object.freeze(['aggregateDevices', 'aggregateHistory']),
  history: Object.freeze(['historyPreview', 'historyRevision', 'deviceHistoryRevision', 'localDayKey'])
});

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function nonNegativeNumber(value) {
  const numeric = Number(value);
  return value !== undefined && value !== null && Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

// settings.json as upstream last wrote it, read again only when it changes:
// the device ID and the hub mode can change while the app runs. A missing or
// half-written file keeps the last good read.
function createSettingsReader(file, fsApi = fs) {
  let stamp = '';
  let last = null;
  return function readSettings() {
    try {
      const stat = fsApi.statSync(file);
      const next = `${stat.mtimeMs}:${stat.size}`;
      if (next !== stamp) {
        const parsed = JSON.parse(fsApi.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) last = parsed;
        stamp = next;
      }
    } catch (_) {
      // Keep the last good read.
    }
    return last;
  };
}

function missingExports(modules) {
  const missing = [];
  for (const table of [REPLACED_EXPORTS, REQUIRED_EXPORTS]) {
    for (const [name, keys] of Object.entries(table)) {
      for (const key of keys) {
        if (typeof modules[name]?.[key] !== 'function') missing.push(`${name}.${key}`);
      }
    }
  }
  for (const key of ['defaultDeviceId', 'readSettings']) {
    if (typeof modules[key] !== 'function') missing.push(key);
  }
  return missing;
}

// Replaces the exports in REPLACED_EXPORTS with wrappers that keep this device
// only. Changes nothing and throws when an export it needs is missing.
function installOwnDeviceView(modules) {
  const missing = missingExports(modules || {});
  if (missing.length) throw new Error(`upstream no longer exports ${missing.join(', ')}`);
  const { syncDisplayStats, historySource, macWidgetHistory, usage, history, defaultDeviceId, readSettings } = modules;
  const original = {
    composeLocalSyncSummary: syncDisplayStats.composeLocalSyncSummary,
    resolveCompleteHistory: historySource.resolveCompleteHistory,
    resolveCompleteHistoryWithDevices: historySource.resolveCompleteHistoryWithDevices,
    completeHistorySource: historySource.completeHistorySource,
    macWidgetHistorySourceKey: macWidgetHistory.macWidgetHistorySourceKey
  };

  function ownDeviceId(localDevice) {
    return String(localDevice?.deviceId || readSettings()?.deviceId || defaultDeviceId() || '').trim();
  }

  // Upstream composes only in client mode; this guards the host-mode paths
  // that fall through to the same call.
  function composesClientStats() {
    const hubMode = readSettings()?.hubMode;
    return !hubMode || hubMode === 'client';
  }

  // The hub keeps no History in /api/stats device entries, so the preview is
  // the local record's, as in local mode. One local record at a time; the day
  // is part of the key because the merge fills days up to today.
  let historyCache = null;
  function historyFields(localDevice) {
    const day = history.localDayKey(new Date());
    if (historyCache && historyCache.localDevice === localDevice && historyCache.day === day) return historyCache.fields;
    const devices = localDevice ? [localDevice] : [];
    const merged = usage.aggregateHistory(devices);
    const fields = {
      historyPreview: history.historyPreview(merged),
      historyRevision: history.historyRevision(merged),
      deviceHistoryRevision: history.deviceHistoryRevision(devices)
    };
    historyCache = { localDevice, day, fields };
    return fields;
  }

  // The hub stats as if this device were the only one uploading. With a local
  // record, upstream merges it over this and recomputes the totals; without
  // one, upstream shows this as it is, so it is complete on its own. Neither
  // argument is changed: hubStats is upstream's shared cache.
  function ownHubStats(hubStats, localDevice, nowMs) {
    const id = ownDeviceId(localDevice);
    const own = (Array.isArray(hubStats?.devices) ? hubStats.devices : [])
      .filter((device) => String(device?.deviceId || '') === id);
    const view = {};
    for (const key of PASS_THROUGH_STATS_KEYS) {
      if (hasOwn(hubStats, key)) view[key] = hubStats[key];
    }
    view.devices = own;
    Object.assign(view, historyFields(localDevice));
    if (localDevice?.deviceId) return view;

    const staleAfterMs = nonNegativeNumber(hubStats?.staleAfterMs);
    const aggregate = usage.aggregateDevices(own, staleAfterMs ?? 0, nowMs);
    const hubEntries = new Map(own.map((device) => [String(device.deviceId), device]));
    view.updatedAt = aggregate.updatedAt;
    view.periods = aggregate.periods;
    // The hub's own staleness wins when it sends no window to recompute it by,
    // as in upstream's composeLocalSyncStats.
    view.devices = aggregate.devices.map((device) => {
      const entry = hubEntries.get(device.deviceId);
      if (!entry) return device;
      if (staleAfterMs !== null) return { ...entry, ...device };
      return { ...entry, ...device, stale: entry.stale, ageMs: entry.ageMs };
    });
    view.projectsIncomplete = aggregate.projectsIncomplete;
    view.limits = aggregate.limits;
    for (const key of ['sessionDetailsOmitted', 'periodProjectsOmitted']) {
      if (hasOwn(aggregate, key)) view[key] = aggregate[key];
    }
    return view;
  }

  function composeLocalSyncSummary(hubStats, localDevice, options = {}) {
    if (!composesClientStats() || (!hubStats && !localDevice?.deviceId)) {
      return original.composeLocalSyncSummary(hubStats, localDevice, options);
    }
    // One clock for the view and upstream's summary and completion of it.
    const nowMs = options.nowMs ?? Date.now();
    return original.composeLocalSyncSummary(ownHubStats(hubStats, localDevice, nowMs), localDevice, { ...options, nowMs });
  }

  // Only the hub's History is shared; a local or embedded one is this machine's.
  function readsHubHistory(options) {
    return options?.hubMode === 'client' && original.completeHistorySource(options) === 'remote';
  }

  // The local collector carries this machine's History forward on every
  // record, so once it has one the hub is not asked at all.
  function hasLocalHistory(options) {
    return Boolean(options.localDevice?.deviceId) && hasOwn(options.localDevice, 'history');
  }

  async function resolveCompleteHistoryWithDevices(options = {}) {
    if (!readsHubHistory(options)) return original.resolveCompleteHistoryWithDevices(options);
    if (hasLocalHistory(options)) return original.resolveCompleteHistoryWithDevices({ ...options, mode: 'local' });
    const id = ownDeviceId(options.localDevice);
    const isOwn = (record) => String(record?.deviceId || record?.id || '').trim() === id;
    const aggregate = typeof options.aggregateHistory === 'function' ? options.aggregateHistory : usage.aggregateHistory;
    const resolved = await original.resolveCompleteHistoryWithDevices({
      ...options,
      aggregateHistory: (devices) => aggregate((Array.isArray(devices) ? devices : []).filter(isOwn))
    });
    return {
      ...resolved,
      deviceHistories: (resolved.deviceHistories || []).filter(isOwn)
    };
  }

  // /api/history is merged on the hub and cannot be split by device, so the
  // hub's History comes from /api/devices instead.
  async function resolveCompleteHistory(options = {}) {
    if (!readsHubHistory(options)) return original.resolveCompleteHistory(options);
    if (hasLocalHistory(options)) return original.resolveCompleteHistory({ ...options, mode: 'local' });
    return (await resolveCompleteHistoryWithDevices(options)).history;
  }

  // The macOS widget keeps the last History it showed on disk under this key;
  // a different key keeps one saved before this view, with every device, from
  // being shown.
  function macWidgetHistorySourceKey(config = {}) {
    const key = original.macWidgetHistorySourceKey(config);
    return readsHubHistory(config) ? `${key}|own:${ownDeviceId(config.localDevice)}` : key;
  }

  syncDisplayStats.composeLocalSyncSummary = composeLocalSyncSummary;
  historySource.resolveCompleteHistory = resolveCompleteHistory;
  historySource.resolveCompleteHistoryWithDevices = resolveCompleteHistoryWithDevices;
  macWidgetHistory.macWidgetHistorySourceKey = macWidgetHistorySourceKey;
  return { ownDeviceId, ownHubStats };
}

module.exports = {
  AGGREGATE_STATS_KEYS,
  PASS_THROUGH_STATS_KEYS,
  REPLACED_EXPORTS,
  createSettingsReader,
  installOwnDeviceView
};
