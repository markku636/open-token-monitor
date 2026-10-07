'use strict';

// Checks an upload before upstream's merge sees it (defects A6, A7, A9 in
// docs/defects.zh-TW.md, and malformed input in general).
//
// The client secret ships inside every installer, so anyone holding an
// installer may upload, and upstream's normalization is not meant to face
// hostile input: prototype keys, malformed history rows and unbounded values
// are refused here. Everything here is either rejected outright (400, one rule
// name, never the payload echoed back) or clamped to what the hub itself can
// vouch for.

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const LIMITS = Object.freeze({
  depth: 16,
  stringLength: 8192,
  arrayLength: 5000,
  objectKeys: 20000,
  nodes: 500000,
  magnitude: 1e15
});
const DEVICE_ID_RE = /^[\w.-]{1,128}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const FIELD_LENGTHS = Object.freeze({
  deviceId: 128,
  id: 128,
  updatedAt: 64,
  agentVersion: 64,
  agentRuntime: 32,
  hostname: 255,
  platform: 32,
  osName: 64,
  osVersion: 128
});
const OWNER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The company email a client says its user has (ownerEmail, hub/org.js),
// lower-cased, or '' when it is not a plausible address.
function normalizeOwnerEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  return email.length <= 254 && OWNER_EMAIL_RE.test(email) ? email : '';
}

// How far ahead of the hub's own clock a device may claim to be.
const CLOCK_SKEW_MS = 10 * 60 * 1000;
// A device-local day ends at most ~38 h after any instant (UTC+14 to UTC-12);
// a month at most 31 days plus that.
const MAX_TODAY_AHEAD_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_MONTH_AHEAD_MS = 33 * 24 * 60 * 60 * 1000;
const MIN_REFRESH_MS = 60 * 1000;
const MAX_REFRESH_MS = 24 * 60 * 60 * 1000;

class IngestRejected extends Error {
  constructor(rule) {
    super(`payload rejected: ${rule}`);
    this.rule = rule;
    this.code = 'ingest_rejected';
  }
}

function reject(rule) {
  throw new IngestRejected(rule);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// One pass over the whole payload: forbidden keys at any depth, and bounds on
// depth, sizes and numbers. JSON.parse defines `__proto__` as an own property,
// so Object.keys sees it.
function walk(value, depth, state) {
  if (value === null) return;
  switch (typeof value) {
    case 'string':
      if (value.length > LIMITS.stringLength) reject('string_too_long');
      return;
    case 'number':
      // 1e400 parses to Infinity; the magnitude bound keeps every counter
      // inside BIGINT and DECIMAL(18,8) and inside exact JavaScript integers.
      if (!Number.isFinite(value) || Math.abs(value) > LIMITS.magnitude) reject('number_out_of_range');
      return;
    case 'boolean':
      return;
    case 'object':
      break;
    default:
      reject('unsupported_value');
  }
  if (depth > LIMITS.depth) reject('too_deep');
  state.nodes += 1;
  if (state.nodes > LIMITS.nodes) reject('too_many_values');
  if (Array.isArray(value)) {
    if (value.length > LIMITS.arrayLength) reject('array_too_long');
    for (const item of value) walk(item, depth + 1, state);
    return;
  }
  const keys = Object.keys(value);
  if (keys.length > LIMITS.objectKeys) reject('too_many_keys');
  for (const key of keys) {
    if (PROTOTYPE_KEYS.has(key)) reject('forbidden_key');
    if (key.length > LIMITS.stringLength) reject('key_too_long');
    walk(value[key], depth + 1, state);
  }
}

function validDay(value) {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function validMonth(value) {
  return typeof value === 'string' && MONTH_RE.test(value) && validDay(`${value}-01`);
}

function parseTime(value) {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

// A device timestamp later than `limitMs` is replaced by `limitMs`: the hub
// cannot know the true time, but it knows the claim is impossible.
function clampTime(holder, key, limitMs, rule) {
  if (!holder || holder[key] === undefined || holder[key] === null || holder[key] === '') return;
  const ms = parseTime(holder[key]);
  if (!Number.isFinite(ms)) reject(rule);
  if (ms > limitMs) holder[key] = new Date(limitMs).toISOString();
}

function checkBreakdown(map, rule) {
  if (map === undefined) return;
  if (!isObject(map)) reject(rule);
  for (const entry of Object.values(map)) {
    if (!isObject(entry)) reject(rule);
  }
}

function checkHistory(history) {
  if (history === undefined || history === null) return;
  if (!isObject(history)) reject('history_not_object');
  if (history.daily !== undefined) {
    if (!Array.isArray(history.daily)) reject('history_daily_not_array');
    for (const row of history.daily) {
      if (!isObject(row) || !validDay(row.date)) reject('history_daily_row');
      checkBreakdown(row.perClient, 'history_daily_row');
      checkBreakdown(row.perModel, 'history_daily_row');
    }
  }
  if (history.monthly !== undefined) {
    if (!Array.isArray(history.monthly)) reject('history_monthly_not_array');
    for (const row of history.monthly) {
      if (!isObject(row) || !validMonth(row.month)) reject('history_monthly_row');
      checkBreakdown(row.perClient, 'history_monthly_row');
      checkBreakdown(row.perModel, 'history_monthly_row');
    }
  }
  if (history.summary !== undefined && !isObject(history.summary)) reject('history_summary_not_object');
}

function checkPeriods(payload) {
  for (const name of ['today', 'month', 'allTime']) {
    if (payload[name] !== undefined && payload[name] !== null && !isObject(payload[name])) reject('period_not_object');
    if (payload.periods?.[name] !== undefined && payload.periods[name] !== null && !isObject(payload.periods[name])) reject('period_not_object');
  }
  if (payload.periods !== undefined && !isObject(payload.periods)) reject('periods_not_object');
  for (const period of [payload.today, payload.month, payload.allTime, payload.periods?.today, payload.periods?.month, payload.periods?.allTime]) {
    if (!isObject(period)) continue;
    if (period.sessions !== undefined) checkBreakdown(period.sessions, 'session_not_object');
    if (period.projects !== undefined) checkBreakdown(period.projects, 'project_not_object');
    for (const nested of ['clientModels', 'clientModelCosts']) checkBreakdown(period[nested], 'period_breakdown');
  }
}

function checkWindows(payload, receivedMs) {
  const windows = payload.periodWindows;
  if (windows === undefined || windows === null) return;
  if (!isObject(windows)) reject('period_windows');
  for (const [name, aheadMs] of [['today', MAX_TODAY_AHEAD_MS], ['month', MAX_MONTH_AHEAD_MS]]) {
    const window = windows[name];
    if (window === undefined || window === null) continue;
    if (!isObject(window)) reject('period_windows');
    if (window.key !== undefined && !(name === 'today' ? validDay(window.key) : validMonth(window.key))) reject('period_windows');
    clampTime(window, 'endsAt', receivedMs + aheadMs, 'period_windows');
  }
}

function checkLimits(limits, receivedMs) {
  if (limits === undefined || limits === null) return;
  if (!isObject(limits)) reject('limits_not_object');
  clampTime(limits, 'updatedAt', receivedMs + CLOCK_SKEW_MS, 'limits_time');
  if (limits.refreshMs !== undefined && limits.refreshMs !== null) {
    if (typeof limits.refreshMs !== 'number') reject('limits_refresh');
    limits.refreshMs = Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, limits.refreshMs));
  }
  if (limits.providers === undefined) return;
  if (!Array.isArray(limits.providers)) reject('limits_providers');
  for (const provider of limits.providers) {
    if (!isObject(provider)) reject('limits_provider');
    clampTime(provider, 'updatedAt', receivedMs + CLOCK_SKEW_MS, 'limits_time');
    clampTime(provider, 'checkedAt', receivedMs + CLOCK_SKEW_MS, 'limits_time');
    if (provider.windows !== undefined && !Array.isArray(provider.windows)) reject('limits_windows');
    for (const window of provider.windows || []) {
      if (!isObject(window)) reject('limits_windows');
    }
  }
}

// Returns { payload, replay }. `payload` is the same object with impossible
// timestamps clamped; `replay` is true when it is older than what the hub
// already holds for the device (a resend or a queued snapshot arriving late),
// which the caller acknowledges without applying (defect A6).
function checkIngestPayload(payload, { receivedAtMs = Date.now(), previous = null } = {}) {
  if (!isObject(payload)) reject('payload_not_object');
  walk(payload, 0, { nodes: 0 });

  for (const [field, max] of Object.entries(FIELD_LENGTHS)) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.length > max) reject(`field_${field}`);
  }
  const deviceId = payload.deviceId || payload.id;
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId) || PROTOTYPE_KEYS.has(deviceId)) reject('device_id');
  // A mistyped address must not stop the device syncing, so an ownerEmail that
  // is not one is dropped instead of refusing the upload.
  if (Object.prototype.hasOwnProperty.call(payload, 'ownerEmail')) {
    const email = normalizeOwnerEmail(payload.ownerEmail);
    if (email) payload.ownerEmail = email;
    else delete payload.ownerEmail;
  }

  if (payload.updatedAt !== undefined && payload.updatedAt !== null && payload.updatedAt !== '') {
    clampTime(payload, 'updatedAt', receivedAtMs + CLOCK_SKEW_MS, 'field_updatedAt');
  }
  checkPeriods(payload);
  checkWindows(payload, receivedAtMs);
  checkHistory(payload.history);
  checkLimits(payload.limits, receivedAtMs);

  const previousMs = parseTime(previous?.updatedAt);
  const currentMs = parseTime(payload.updatedAt);
  const replay = Number.isFinite(previousMs) && Number.isFinite(currentMs) && currentMs < previousMs;
  return { payload, replay };
}

module.exports = { IngestRejected, LIMITS, checkIngestPayload, normalizeOwnerEmail };
