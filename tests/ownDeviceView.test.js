'use strict';

// The company client's widget shows this machine's usage only
// (client/electron/ownDeviceView.js, docs/client-build.zh-TW.md「只顯示這台電腦」).
// Each test installs the view over shallow copies of the upstream modules, so
// the real ones stay as upstream wrote them.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { upstream } = require('../upstream');
const { createHubCore } = require('../hub/core');
const { dayKey, devicePayload, historyDay, period, provider } = require('./helpers/fixtures');
const {
  AGGREGATE_STATS_KEYS,
  PASS_THROUGH_STATS_KEYS,
  REPLACED_EXPORTS,
  createSettingsReader,
  installOwnDeviceView
} = require('../client/electron/ownDeviceView');
const { limitToThisDevice } = require('../client/electron/main');

const usage = require(upstream('src/shared/usage'));
const history = require(upstream('src/shared/history'));
const realModules = {
  syncDisplayStats: require(upstream('src/electron/syncDisplayStats')),
  historySource: require(upstream('src/electron/historySource')),
  macWidgetHistory: require(upstream('src/electron/macWidget/history'))
};

const OWN = 'own-pc';
const PEER = 'peer-pc';
const HUB_URL = 'https://hub.example';
const CLIENT = { hubMode: 'client', deviceId: OWN };

function tempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-own-device-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function install({ settings = CLIENT, defaultDeviceId = () => 'default-host' } = {}) {
  const modules = {
    syncDisplayStats: { ...realModules.syncDisplayStats },
    historySource: { ...realModules.historySource },
    macWidgetHistory: { ...realModules.macWidgetHistory },
    usage,
    history,
    defaultDeviceId,
    readSettings: typeof settings === 'function' ? settings : () => settings
  };
  const view = installOwnDeviceView(modules);
  return { ...modules, view };
}

// One upload, every name in it carrying `name`, so a leak shows up as text.
function upload(deviceId, name, { tokens, withHistory = true } = {}) {
  return devicePayload({
    deviceId,
    hostname: `${name}-host`,
    tokens,
    limits: false,
    history: withHistory
      ? { daily: [historyDay(dayKey(-1), { tokens: tokens * 2, model: `${name}-model` })], monthly: [], summary: {} }
      : undefined,
    extra: {
      today: period({ tokens, model: `${name}-model` }),
      limits: { updatedAt: new Date().toISOString(), refreshMs: 300000, providers: [provider({ email: `${name}@example.test` })] }
    }
  });
}

function hubWithColleague() {
  const hub = createHubCore();
  hub.ingest(upload(OWN, 'own', { tokens: 1000 }));
  hub.ingest(upload(PEER, 'peer', { tokens: 7000 }));
  return hub;
}

function localRecord(tokens = 1500) {
  return { ...upload(OWN, 'own', { tokens }), receivedAt: new Date().toISOString() };
}

function withoutUpdatedAt(stats) {
  const { updatedAt: _updatedAt, ...rest } = stats;
  return rest;
}

function fakeFetch(hub) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(url).pathname);
    const body = url.endsWith('/api/devices') ? { devices: hub.getDevices() } : hub.getHistory();
    return { ok: true, json: async () => body, text: async () => '' };
  };
  return { calls, fetchImpl };
}

function historyOptions(fetchImpl, extra = {}) {
  return {
    aggregateHistory: usage.aggregateHistory,
    embeddedHub: null,
    historyEnabled: true,
    hubMode: 'client',
    hubUrl: HUB_URL,
    localDevice: null,
    mode: 'sync',
    secret: 'client-key',
    fetchImpl,
    ...extra
  };
}

test('the hub stats in these tests carry the colleague', () => {
  const stats = hubWithColleague().getStats();
  assert.deepEqual(stats.devices.map((device) => device.deviceId), [OWN, PEER]);
  assert.match(JSON.stringify(stats), /peer-host/);
  assert.match(JSON.stringify(stats), /peer@example\.test/);
});

test('without a local record the widget shows this device from the hub only', () => {
  const stats = hubWithColleague().getStats();
  const { syncDisplayStats } = install();
  const shown = syncDisplayStats.composeLocalSyncSummary(stats, null);
  assert.deepEqual(shown.devices.map((device) => device.deviceId), [OWN]);
  assert.equal(shown.periods.today.totalTokens, 1000);
  assert.deepEqual(Object.keys(shown.periods.today.models), ['own-model']);
  assert.match(JSON.stringify(shown.limits), /own@example\.test/);
  assert.doesNotMatch(JSON.stringify(shown), /peer/);
  assert.equal(shown.staleAfterMs, stats.staleAfterMs);
  assert.equal(shown.subscriptionsUpdatedAt, stats.subscriptionsUpdatedAt);
  // The hub's /api/stats devices carry no History, so there is none to preview.
  assert.deepEqual(shown.historyPreview.daily.filter((day) => day.tokens > 0), []);
  assert.equal(syncDisplayStats.completeLocalSyncStats(shown), shown);
});

test('with a local record the widget shows that record and its History only', () => {
  const stats = hubWithColleague().getStats();
  const local = localRecord(1500);
  const { syncDisplayStats } = install();
  const shown = syncDisplayStats.composeLocalSyncSummary(stats, local);
  assert.deepEqual(shown.devices.map((device) => device.deviceId), [OWN]);
  assert.equal(shown.periods.today.totalTokens, 1500);
  assert.match(JSON.stringify(shown.limits), /own@example\.test/);
  assert.doesNotMatch(JSON.stringify(shown), /peer/);

  const merged = usage.aggregateHistory([local]);
  assert.deepEqual(shown.historyPreview, history.historyPreview(merged));
  assert.equal(shown.historyRevision, history.historyRevision(merged));
  assert.notDeepEqual(shown.historyPreview, stats.historyPreview);

  // What the exporter and the session list read.
  const complete = syncDisplayStats.completeLocalSyncStats(shown);
  assert.notEqual(complete, shown);
  assert.equal(complete.periods.today.totalTokens, 1500);
  assert.doesNotMatch(JSON.stringify(complete), /peer/);
});

test('no hub stats yet: the local record alone, or nothing', () => {
  const local = localRecord(1500);
  const { syncDisplayStats } = install();
  assert.equal(syncDisplayStats.composeLocalSyncSummary(null, null), null);
  const shown = syncDisplayStats.composeLocalSyncSummary(null, local);
  assert.deepEqual(shown.devices.map((device) => device.deviceId), [OWN]);
  assert.equal(shown.periods.today.totalTokens, 1500);
  assert.deepEqual(shown.historyPreview, history.historyPreview(usage.aggregateHistory([local])));
});

test('outside client mode the widget composes as upstream does', () => {
  const stats = hubWithColleague().getStats();
  const local = localRecord(1500);
  const nowMs = Date.now();
  for (const hubMode of ['host', 'local']) {
    const { syncDisplayStats } = install({ settings: { hubMode, deviceId: OWN } });
    assert.equal(syncDisplayStats.composeLocalSyncSummary(stats, null), stats);
    assert.deepEqual(
      withoutUpdatedAt(syncDisplayStats.composeLocalSyncSummary(stats, local, { nowMs })),
      withoutUpdatedAt(realModules.syncDisplayStats.composeLocalSyncSummary(stats, local, { nowMs }))
    );
  }
});

test('the hub stats and the local record are left as they were', () => {
  const stats = hubWithColleague().getStats();
  const local = localRecord(1500);
  const before = JSON.stringify({ stats, local });
  const { syncDisplayStats } = install();
  syncDisplayStats.composeLocalSyncSummary(stats, null);
  syncDisplayStats.completeLocalSyncStats(syncDisplayStats.composeLocalSyncSummary(stats, local));
  assert.equal(JSON.stringify({ stats, local }), before);
});

test('this device is the local record, else settings.json, else the default', () => {
  tempDir((dir) => {
    const file = path.join(dir, 'settings.json');
    const readSettings = createSettingsReader(file);
    const { view } = install({ settings: readSettings, defaultDeviceId: () => 'default-host' });
    assert.equal(view.ownDeviceId(null), 'default-host');
    fs.writeFileSync(file, JSON.stringify({ hubMode: 'client', deviceId: 'asset-1' }));
    assert.equal(view.ownDeviceId(null), 'asset-1');
    assert.equal(view.ownDeviceId({ deviceId: 'local-id' }), 'local-id');
    // A device ID changed while the app runs is read again.
    fs.writeFileSync(file, JSON.stringify({ hubMode: 'client', deviceId: 'asset-2000' }));
    assert.equal(view.ownDeviceId(null), 'asset-2000');
    // A half-written file keeps the last good read.
    fs.writeFileSync(file, '{"hubMode":');
    assert.equal(view.ownDeviceId(null), 'asset-2000');
    fs.writeFileSync(file, JSON.stringify({ hubMode: 'client' }));
    assert.equal(view.ownDeviceId(null), 'default-host');
  });
});

test('the hub device the widget keeps follows a device ID changed in settings.json', () => {
  const stats = hubWithColleague().getStats();
  let settings = CLIENT;
  const { syncDisplayStats } = install({ settings: () => settings });
  assert.equal(syncDisplayStats.composeLocalSyncSummary(stats, null).periods.today.totalTokens, 1000);
  settings = { hubMode: 'client', deviceId: PEER };
  assert.equal(syncDisplayStats.composeLocalSyncSummary(stats, null).periods.today.totalTokens, 7000);
});

test('History with a local record is read in-process, without the hub', async () => {
  const hub = hubWithColleague();
  const local = localRecord(1500);
  const { calls, fetchImpl } = fakeFetch(hub);
  const { historySource } = install();
  const expected = historySource.parseCompleteHistory(usage.aggregateHistory([local]));
  assert.deepEqual(await historySource.resolveCompleteHistory(historyOptions(fetchImpl, { localDevice: local })), expected);
  const withDevices = await historySource.resolveCompleteHistoryWithDevices(historyOptions(fetchImpl, { localDevice: local }));
  assert.deepEqual(withDevices.history, expected);
  assert.deepEqual(withDevices.deviceHistories.map((device) => device.deviceId), [OWN]);
  assert.deepEqual(calls, []);
});

test('History without a local record is this device\'s from /api/devices, never /api/history', async () => {
  const hub = hubWithColleague();
  const { calls, fetchImpl } = fakeFetch(hub);
  const { historySource } = install();
  const own = hub.getDevices().filter((device) => device.deviceId === OWN);
  const expected = historySource.parseCompleteHistory(usage.aggregateHistory(own));

  const complete = await historySource.resolveCompleteHistory(historyOptions(fetchImpl));
  assert.deepEqual(complete, expected);
  assert.doesNotMatch(JSON.stringify(complete), /peer/);
  const withDevices = await historySource.resolveCompleteHistoryWithDevices(historyOptions(fetchImpl));
  assert.deepEqual(withDevices.history, expected);
  assert.deepEqual(withDevices.deviceHistories.map((device) => device.deviceId), [OWN]);
  assert.doesNotMatch(JSON.stringify(withDevices), /peer/);
  assert.deepEqual(calls, ['/api/devices', '/api/devices']);
});

test('History outside client mode is read as upstream reads it', async () => {
  const hub = hubWithColleague();
  const { historySource } = install();
  const host = fakeFetch(hub);
  // A host without its embedded hub reads the hub over HTTP, as a client would.
  await historySource.resolveCompleteHistory(historyOptions(host.fetchImpl, { hubMode: 'host' }));
  assert.deepEqual(host.calls, ['/api/history']);
  const local = fakeFetch(hub);
  const record = localRecord(1500);
  assert.deepEqual(
    await historySource.resolveCompleteHistory(historyOptions(local.fetchImpl, { hubMode: 'local', mode: 'local', localDevice: record })),
    historySource.parseCompleteHistory(usage.aggregateHistory([record]))
  );
  assert.deepEqual(local.calls, []);
});

test('the macOS widget keeps its History cache apart in client mode only', () => {
  const { macWidgetHistory } = install();
  const config = historyOptions(null);
  const key = realModules.macWidgetHistory.macWidgetHistorySourceKey(config);
  assert.equal(macWidgetHistory.macWidgetHistorySourceKey(config), `${key}|own:${OWN}`);
  const host = { ...config, hubMode: 'host' };
  assert.equal(macWidgetHistory.macWidgetHistorySourceKey(host), realModules.macWidgetHistory.macWidgetHistorySourceKey(host));
});

test('installing changes nothing when upstream no longer has an export it needs', () => {
  const syncDisplayStats = { ...realModules.syncDisplayStats };
  const historySource = { ...realModules.historySource };
  delete historySource.resolveCompleteHistoryWithDevices;
  assert.throws(() => installOwnDeviceView({
    syncDisplayStats,
    historySource,
    macWidgetHistory: { ...realModules.macWidgetHistory },
    usage,
    history,
    defaultDeviceId: () => 'x',
    readSettings: () => null
  }), /historySource\.resolveCompleteHistoryWithDevices/);
  assert.equal(syncDisplayStats.composeLocalSyncSummary, realModules.syncDisplayStats.composeLocalSyncSummary);
  assert.equal(historySource.resolveCompleteHistory, realModules.historySource.resolveCompleteHistory);
});

test('the company entry installs the view only when the build asks for it', () => {
  tempDir((dir) => {
    const loaded = {};
    const load = (id) => {
      loaded[id] = loaded[id] || { ...require(upstream(`src/${id}`)) };
      return loaded[id];
    };
    assert.equal(limitToThisDevice({ dir, defaults: null, load }), false);
    assert.equal(limitToThisDevice({ dir, defaults: { hubUrl: HUB_URL }, load }), false);
    assert.equal(limitToThisDevice({ dir, defaults: { ownDeviceOnly: false }, load }), false);
    assert.deepEqual(loaded, {});
    assert.equal(limitToThisDevice({ dir, defaults: { ownDeviceOnly: true }, load }), true);
    assert.notEqual(loaded['electron/syncDisplayStats'].composeLocalSyncSummary, realModules.syncDisplayStats.composeLocalSyncSummary);
    assert.notEqual(loaded['electron/historySource'].resolveCompleteHistory, realModules.historySource.resolveCompleteHistory);
  });
});

// A field the hub adds to /api/stats is either merged across devices, and
// rebuilt from this device alone, or about no device, and passed through.
test('every hub stats field is sorted into merged or passed through', () => {
  const hub = hubWithColleague();
  const keys = new Set(Object.keys(hub.getStats()));
  for (const key of ['sessionDetailsOmitted', 'periodProjectsOmitted']) keys.add(key);
  for (const key of keys) {
    assert.ok(
      AGGREGATE_STATS_KEYS.includes(key) || PASS_THROUGH_STATS_KEYS.includes(key),
      `hub /api/stats has "${key}": add it to AGGREGATE_STATS_KEYS or PASS_THROUGH_STATS_KEYS in client/electron/ownDeviceView.js`
    );
  }
});

function upstreamSources(dir = upstream('src')) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...upstreamSources(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

// The seams in upstream this view relies on. When one of these fails after an
// upstream update, re-read upstream's main.js and adjust ownDeviceView.js.
test('upstream still takes the replaced exports once, from main.js only', () => {
  const main = fs.readFileSync(upstream('src/electron/main.js'), 'utf8');
  // Taken when main.js loads, after the company entry has replaced them.
  assert.match(main, /\nconst \{ completeHistorySource, resolveCompleteHistory, resolveCompleteHistoryWithDevices \} = require\('\.\/historySource'\);/);
  assert.match(main, /\nconst \{ macWidgetHistorySourceKey, resolveMacWidgetHistory \} = require\('\.\/macWidget\/history'\);/);
  assert.match(main, /\nconst \{\n {2}attachLocalNativeViews,\n {2}attachLocalPresentationNativeViews,\n {2}completeLocalSyncStats,\n {2}composeLocalOnlySummary,\n {2}composeLocalSyncSummary\n\} = require\('\.\/syncDisplayStats'\);/);
  // Client mode composes the hub's stats here only: the stream and fetchStats.
  assert.equal(main.match(/composeLocalSyncSummary\(/g).length, 2);
  assert.match(main, /const displayStats = composeLocalSyncSummary\(latestHubStats, lastCollectedDevice\);/);
  assert.match(main, /return injectLocalDeviceStatus\(composeLocalSyncSummary\(stats, lastCollectedDevice\)\);/);
  // The History reads carry the mode and this machine's record.
  assert.match(main, /hubMode: settings\?\.hubMode,\n {4}hubUrl,/);
  assert.match(main, /localDevice: ownsUsageRuntime\(\) \? \(lastCollectedDevice \|\| localDevice\) : null,/);
  assert.match(main, /const sourceKey = macWidgetHistorySourceKey\(resolverConfig\);/);
  // The device ID upstream uploads under.
  const runtimeConfig = fs.readFileSync(upstream('src/electron/runtimeConfig.js'), 'utf8');
  assert.match(runtimeConfig, /deviceId: settings\.deviceId \|\| context\.defaultDeviceId,/);
  assert.match(main, /defaultDeviceId: defaultDeviceId\(\)/);

  // No other upstream module uses a replaced export.
  const names = Object.values(REPLACED_EXPORTS).flat();
  const users = upstreamSources()
    .filter((file) => file !== upstream('src/electron/main.js'))
    .filter((file) => !['syncDisplayStats.js', 'historySource.js'].includes(path.basename(file)) && file !== upstream('src/electron/macWidget/history.js'))
    .filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return names.some((name) => new RegExp(`\\b${name}\\b`).test(text));
    })
    .map((file) => path.relative(upstream('src'), file));
  assert.deepEqual(users, []);
});
