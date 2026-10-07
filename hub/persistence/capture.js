'use strict';

// Turns device records into the rows the database stores, and works out which
// of them changed since the last record that reached the database.
//
// Pure: no I/O, no clock beyond the timestamps passed in. The input records are
// the merged, normalized objects upstream's hub.ingest() returns (see
// normalizeDeviceRecord in src/shared/usage.js), and they are never mutated.
//
// Two sources feed the usage tables, and they are diffed separately:
// - live rows come from periods.today / periods.month and describe the device's
//   current day and month (periodWindows.*.key). They are the freshest numbers
//   for those two keys, so a history row never overwrites them.
// - history rows come from history.daily[] / history.monthly[] and are the final
//   accounting for every earlier day and month. Upstream replaces a record's
//   history wholesale and carries the previous one forward when a payload has
//   none, so history rows are only examined when the payload actually carried
//   history (or when nothing has been persisted for the device yet) and only the
//   dates whose row differs from the previously persisted history are emitted.
//   A day that differs only because upstream dropped its token split on the way
//   is not (see changedHistory), so the split the database holds stays.

const { hasOwn, stableJson, toDbTime } = require('./util');

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const EARLIEST_YEAR = 2015;
const FUTURE_SLACK_MS = 2 * 24 * 60 * 60 * 1000;

// Column limits from the schema. A key that does not fit is skipped rather than
// truncated: two keys that share a prefix would otherwise collide on the
// primary key and one device's row would silently overwrite another's.
const LIMITS = Object.freeze({
  deviceId: 191,
  client: 64,
  model: 191,
  projectKey: 255,
  sessionKey: 255,
  sessionId: 191,
  provider: 32,
  accountKey: 191,
  label: 255
});

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Every value is clamped into its column (BIGINT UNSIGNED, INT UNSIGNED,
// DECIMAL(18,8)): a value the database refuses would otherwise be a write that
// fails the same way on every retry.
const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const MAX_INT = 4294967295;
const MAX_MONEY = 9999999999;

function count(value) {
  return Math.min(MAX_COUNT, Math.max(0, Math.round(num(value))));
}

function smallCount(value) {
  return Math.min(MAX_INT, count(value));
}

function money(value) {
  const n = num(value);
  return n > 0 ? Number(Math.min(MAX_MONEY, n).toFixed(8)) : 0;
}

function signedMoney(value) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return null;
  return Number(Math.max(-MAX_MONEY, Math.min(MAX_MONEY, n)).toFixed(8));
}

function text(value, max = LIMITS.label) {
  const s = value === null || value === undefined ? '' : String(value);
  return s.length > max ? s.slice(0, max) : s;
}

function fits(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validDay(key, referenceMs) {
  const match = DAY_RE.exec(String(key || ''));
  if (!match) return null;
  const year = Number(match[1]);
  if (year < EARLIEST_YEAR) return null;
  const ms = Date.UTC(year, Number(match[2]) - 1, Number(match[3]));
  // Reject impossible days ('2026-02-31') by requiring a UTC round trip.
  if (new Date(ms).toISOString().slice(0, 10) !== match[0]) return null;
  if (Number.isFinite(referenceMs) && ms > referenceMs + FUTURE_SLACK_MS) return null;
  return match[0];
}

function validMonth(key, referenceMs) {
  const match = MONTH_RE.exec(String(key || ''));
  if (!match) return null;
  return validDay(`${match[0]}-01`, referenceMs) ? match[0] : null;
}

// The day and month a record's today/month periods belong to. Devices stamp
// them in periodWindows; older producers did not, and upstream then falls back
// to the UTC day of updatedAt (isPeriodExpired in src/shared/usage.js).
function periodKeys(record) {
  const receivedMs = Date.parse(record?.receivedAt || '');
  const reference = Number.isFinite(receivedMs) ? receivedMs : Date.now();
  const windows = record?.periodWindows || {};
  const fallbackMs = Date.parse(record?.updatedAt || record?.receivedAt || '');
  const fallback = Number.isFinite(fallbackMs) ? new Date(fallbackMs).toISOString() : '';
  return {
    day: validDay(windows.today?.key, reference) || validDay(fallback.slice(0, 10), reference),
    month: validMonth(windows.month?.key, reference) || validMonth(fallback.slice(0, 7), reference),
    reference
  };
}

function breakdownEntry(key, fields, withMessages) {
  const entry = {
    key,
    tokens: count(fields.tokens),
    costUsd: money(fields.cost),
    cacheReadTokens: count(fields.cacheReadTokens),
    cacheWriteTokens: count(fields.cacheWriteTokens),
    outputTokens: count(fields.outputTokens),
    unclassifiedTokens: count(fields.unclassifiedTokens)
  };
  if (withMessages) entry.messages = fields.messages === null || fields.messages === undefined ? null : smallCount(fields.messages);
  return entry;
}

function sortedEntries(entries) {
  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// Per-client / per-model breakdown of a normalized period. The period keeps one
// map per counter (clients, clientCosts, clientCacheReads, …), so a key that
// appears in any of them becomes one entry.
function periodBreakdown(period, maps, max, withMessages) {
  const keys = new Set();
  for (const name of Object.values(maps)) {
    for (const key of Object.keys(period?.[name] || {})) keys.add(key);
  }
  const entries = [];
  for (const key of keys) {
    if (!fits(key, max)) continue;
    entries.push(breakdownEntry(key, {
      tokens: period[maps.tokens]?.[key],
      cost: period[maps.cost]?.[key],
      cacheReadTokens: period[maps.cacheRead]?.[key],
      cacheWriteTokens: period[maps.cacheWrite]?.[key],
      outputTokens: period[maps.output]?.[key],
      unclassifiedTokens: period[maps.unclassified]?.[key],
      messages: null
    }, withMessages));
  }
  return sortedEntries(entries);
}

const CLIENT_MAPS = Object.freeze({
  tokens: 'clients',
  cost: 'clientCosts',
  cacheRead: 'clientCacheReads',
  cacheWrite: 'clientCacheWrites',
  output: 'clientOutputs',
  unclassified: 'clientUnclassifiedTokens'
});

const MODEL_MAPS = Object.freeze({
  tokens: 'models',
  cost: 'modelCosts',
  cacheRead: 'modelCacheReads',
  cacheWrite: 'modelCacheWrites',
  output: 'modelOutputs',
  unclassified: 'modelUnclassifiedTokens'
});

function periodProjects(period) {
  const entries = [];
  for (const [key, project] of Object.entries(period?.projects || {})) {
    if (!fits(key, LIMITS.projectKey) || !project || typeof project !== 'object') continue;
    const clients = {};
    for (const [client, tokens] of Object.entries(project.clients || {})) clients[client] = count(tokens);
    entries.push({
      key,
      label: text(project.label || key),
      tokens: count(project.tokens),
      costUsd: money(project.costUsd),
      clients
    });
  }
  return sortedEntries(entries);
}

function liveRow(period, key, withMessages) {
  return {
    key,
    source: 'live',
    totals: {
      tokens: count(period?.totalTokens),
      costUsd: money(period?.costUsd),
      messages: null,
      cacheReadTokens: count(period?.cacheReadTokens),
      cacheWriteTokens: count(period?.cacheWriteTokens),
      outputTokens: count(period?.outputTokens),
      unclassifiedTokens: count(period?.unclassifiedTokens),
      tokenComponentsAvailable: period?.capabilities?.tokenComponents === true,
      activeTimeMs: 0
    },
    clients: periodBreakdown(period, CLIENT_MAPS, LIMITS.client, withMessages),
    models: periodBreakdown(period, MODEL_MAPS, LIMITS.model, false),
    projects: periodProjects(period)
  };
}

function historyBreakdown(map, max, withMessages) {
  const entries = [];
  for (const [key, fields] of Object.entries(map || {})) {
    if (!fits(key, max) || !fields || typeof fields !== 'object') continue;
    entries.push(breakdownEntry(key, fields, withMessages));
  }
  return sortedEntries(entries);
}

function historyRow(row, key, { monthly }) {
  const has = (field) => hasOwn(row, field);
  return {
    key,
    source: 'history',
    totals: {
      tokens: count(row.tokens),
      costUsd: money(row.cost),
      messages: monthly || !has('messages') ? null : smallCount(row.messages),
      // history.monthly rows carry no top-level token split (buildMonthly in
      // src/shared/history.js), so those stay NULL rather than a false zero.
      cacheReadTokens: has('cacheReadTokens') ? count(row.cacheReadTokens) : null,
      cacheWriteTokens: has('cacheWriteTokens') ? count(row.cacheWriteTokens) : null,
      outputTokens: has('outputTokens') ? count(row.outputTokens) : null,
      unclassifiedTokens: has('unclassifiedTokens') ? count(row.unclassifiedTokens) : null,
      tokenComponentsAvailable: row.tokenComponentsAvailable === true,
      activeTimeMs: count(row.activeTimeMs)
    },
    clients: historyBreakdown(row.perClient, LIMITS.client, true),
    models: historyBreakdown(row.perModel, LIMITS.model, false),
    // History rows carry no project attribution; only live rows replace the
    // project breakdown of a day or month.
    projects: null
  };
}

function historyRows(record, { monthly, excludeKeys, reference }) {
  const history = record?.history;
  if (!history || typeof history !== 'object') return new Map();
  const list = monthly ? history.monthly : history.daily;
  const rows = new Map();
  for (const row of Array.isArray(list) ? list : []) {
    if (!row || typeof row !== 'object') continue;
    const key = monthly ? validMonth(row.month, reference) : validDay(row.date, reference);
    if (!key || excludeKeys.includes(key)) continue;
    rows.set(key, historyRow(row, key, { monthly }));
  }
  return rows;
}

function sessionRows(record, month) {
  const rows = new Map();
  if (!month) return rows;
  for (const [sessionKey, s] of Object.entries(record?.periods?.month?.sessions || {})) {
    if (!s || typeof s !== 'object') continue;
    const client = String(s.client || '');
    const sessionId = String(s.sessionId || '');
    if (!fits(sessionKey, LIMITS.sessionKey) || !fits(client, LIMITS.client) || !fits(sessionId, LIMITS.sessionId)) continue;
    const projectId = s.projectId ? String(s.projectId) : '';
    rows.set(`${month}\u0000${sessionKey}`, {
      month,
      sessionKey,
      client,
      sessionId,
      sessionKind: text(s.sessionKind || '', 32),
      projectId: fits(projectId, LIMITS.sessionId) ? projectId : null,
      projectLabel: s.projectLabel ? text(s.projectLabel) : null,
      totalTokens: count(s.totalTokens),
      costUsd: money(s.costUsd),
      messageCount: smallCount(s.messageCount),
      inputTokens: count(s.inputTokens),
      outputTokens: count(s.outputTokens),
      cacheReadTokens: count(s.cacheReadTokens),
      cacheWriteTokens: count(s.cacheWriteTokens),
      reasoningTokens: count(s.reasoningTokens),
      startedAt: toDbTime(s.startedAt),
      lastUsedAt: toDbTime(s.lastUsedAt),
      models: s.models && typeof s.models === 'object' ? s.models : {},
      modelCosts: s.modelCosts && typeof s.modelCosts === 'object' ? s.modelCosts : {},
      providers: s.providers && typeof s.providers === 'object' ? s.providers : {}
    });
  }
  return rows;
}

function limitRows(record) {
  const rows = new Map();
  for (const p of Array.isArray(record?.limits?.providers) ? record.limits.providers : []) {
    if (!p || typeof p !== 'object') continue;
    const provider = String(p.provider || '');
    const accountKey = String(p.accountKey || '');
    if (!fits(provider, LIMITS.provider) || accountKey.length > LIMITS.accountKey) continue;
    rows.set(`${provider}\u0000${accountKey}`, {
      provider,
      accountKey,
      accountLabel: p.accountLabel ? text(p.accountLabel) : null,
      planLabel: p.planLabel ? text(p.planLabel, 128) : null,
      accountName: p.accountName ? text(p.accountName) : null,
      accountEmail: p.accountEmail ? text(p.accountEmail) : null,
      workspaceKind: p.workspaceKind ? text(p.workspaceKind, 32) : null,
      status: p.status ? text(p.status, 32) : null,
      source: p.source ? text(p.source, 32) : null,
      providerUpdatedAt: toDbTime(p.updatedAt),
      balanceUsd: signedMoney(p.balanceUsd),
      balance: p.balance ?? null,
      windows: Array.isArray(p.windows) ? p.windows : null,
      providerJson: p
    });
  }
  return rows;
}

function deviceRow(record, meta) {
  const keys = periodKeys(record);
  return {
    deviceId: String(record.deviceId),
    hostname: text(record.hostname || ''),
    platform: text(record.platform || '', 32),
    osName: hasOwn(record, 'osName') ? text(record.osName, 64) : null,
    osVersion: hasOwn(record, 'osVersion') ? text(record.osVersion, 128) : null,
    agentVersion: text(record.agentVersion || '', 64),
    agentRuntime: text(record.agentRuntime || '', 32),
    timeZone: record.periodWindows?.timeZone ? text(record.periodWindows.timeZone, 64) : null,
    todayKey: keys.day,
    monthKey: keys.month,
    syncUploadIntervalMs: hasOwn(record, 'syncUploadIntervalMs') ? smallCount(record.syncUploadIntervalMs) : null,
    projectsEnabled: hasOwn(record, 'projectsEnabled') ? record.projectsEnabled !== false : null,
    sessionDetailsOmitted: record.sessionDetailsOmitted || null,
    updatedAt: toDbTime(record.updatedAt) || toDbTime(record.receivedAt),
    receivedAt: toDbTime(record.receivedAt),
    lastSourceIp: meta?.sourceIp ? text(meta.sourceIp, 45) : null,
    recordJson: JSON.stringify(record)
  };
}

// Rows of `next` whose content differs from the same key in `previous`.
function changed(previous, next) {
  const out = [];
  for (const [key, row] of next) {
    const before = previous.get(key);
    if (!before || stableJson(before) !== stableJson(row)) out.push(row);
  }
  return out;
}

// The four fields of a history day's token split. historyRow() leaves the
// totals NULL when the day arrived without them.
const SPLIT_FIELDS = Object.freeze(['cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens']);

function hasSplit(row) {
  return SPLIT_FIELDS.some((field) => row.totals[field] !== null);
}

// The row historyRow() builds from the same day once upstream's
// stripTokenComponents (src/shared/syncPayload.js) has removed its split: the
// four totals NULL, tokenComponentsAvailable false, and the four fields of
// every client and model entry 0, since breakdownEntry counts a missing field
// as 0. Everything else is kept as it is.
function withoutSplit(row) {
  const fill = (target, value) => ({ ...target, ...Object.fromEntries(SPLIT_FIELDS.map((field) => [field, value])) });
  return {
    ...row,
    totals: { ...fill(row.totals, null), tokenComponentsAvailable: false },
    clients: row.clients.map((entry) => fill(entry, 0)),
    models: row.models.map((entry) => fill(entry, 0))
  };
}

// changed() for history.daily, except for a day whose only difference is that
// its token split went missing. Upstream's uploader drops the split from every
// day outside the last 30 (SYNC_HISTORY_COMPONENT_DAYS) and from every day of an
// over-budget upload or of the retry after a 413 (omitHistoryTokenComponents,
// src/shared/syncPayload.js), so an old day keeps arriving with the same totals
// and no split, and writing it would replace the stored split with NULLs.
//
// Such a day is skipped when the persisted row has a split, the new row has
// none, and the two are otherwise identical. Any other difference (tokens,
// cost, messages, active time, a client's or model's numbers, the set of
// entries) is written as usual, without a split. After a skip the queue's base
// is the stripped record, so later stripped uploads compare equal and write
// nothing; when the day arrives with its split again it is rewritten with it,
// which only writes the same numbers again. Live, monthly, session and limit
// rows keep changed(): upstream strips only history.daily.
//
// Known limits, where a stripped day is still written:
// - the first capture after DELETE /api/devices and a re-upload: the queue
//   forgets the device, so there is no base to compare with;
// - the history row that finalises the device's previous current day: that day
//   is left out of the base (see captureRows), so a stripped row replaces the
//   split its last live row stored;
// - a split that is already NULL in the database is not recovered, unless a
//   later upload carries it again (upstream sends it for the last 30 days only).
function changedHistory(previous, next) {
  const out = [];
  for (const [key, row] of next) {
    const before = previous.get(key);
    if (before && hasSplit(before) && !hasSplit(row) && stableJson(withoutSplit(before)) === stableJson(row)) continue;
    if (!before || stableJson(before) !== stableJson(row)) out.push(row);
  }
  return out;
}

function liveRows(record, key, period, withMessages) {
  const rows = new Map();
  if (key && period && typeof period === 'object') rows.set(key, liveRow(period, key, withMessages));
  return rows;
}

// The rows to write for `record`, given the record that was last persisted for
// the same device (`base`, undefined when nothing has been). `hadHistory` says
// whether any payload folded into `record` since `base` carried a history field.
function captureRows(base, record, { hadHistory = false, meta } = {}) {
  if (!record || typeof record !== 'object' || !fits(String(record.deviceId || ''), LIMITS.deviceId)) {
    throw new Error('capture: record has no usable deviceId');
  }
  const next = periodKeys(record);
  const prev = base ? periodKeys(base) : { day: null, month: null, reference: next.reference };

  const daily = changed(
    base ? liveRows(base, prev.day, base.periods?.today, true) : new Map(),
    liveRows(record, next.day, record.periods?.today, true)
  );
  const monthly = changed(
    base ? liveRows(base, prev.month, base.periods?.month, true) : new Map(),
    liveRows(record, next.month, record.periods?.month, true)
  );

  // The base's own current day and month were never written from history
  // (live stood for them), so they are left out of the comparison: otherwise a
  // finished day whose history did not change after midnight would look
  // "already written" and stay a live row forever.
  if (hadHistory || !base) {
    daily.push(...changedHistory(
      base ? historyRows(base, { monthly: false, excludeKeys: [prev.day, next.day], reference: prev.reference }) : new Map(),
      historyRows(record, { monthly: false, excludeKeys: [next.day], reference: next.reference })
    ));
    monthly.push(...changed(
      base ? historyRows(base, { monthly: true, excludeKeys: [prev.month, next.month], reference: prev.reference }) : new Map(),
      historyRows(record, { monthly: true, excludeKeys: [next.month], reference: next.reference })
    ));
  }

  return {
    device: deviceRow(record, meta),
    daily,
    monthly,
    sessions: changed(base ? sessionRows(base, prev.month) : new Map(), sessionRows(record, next.month)),
    limits: changed(base ? limitRows(base) : new Map(), limitRows(record))
  };
}

module.exports = { LIMITS, captureRows, periodKeys, validDay, validMonth };
