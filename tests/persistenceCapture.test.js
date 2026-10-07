'use strict';

// capture.js turns merged device records into rows and decides which of them
// changed. These cases pin those rules.

const assert = require('node:assert/strict');
const test = require('node:test');

const { upstream } = require('../upstream');
const { syncPayload } = require(upstream('src/shared/syncPayload'));
const { captureRows, validDay } = require('../hub/persistence/capture');
const { devicePayload, historyDay, historyMonth, merged } = require('./helpers/fixtures');

const DAY = '2026-09-20';
const RECEIVED = '2026-09-20T03:00:00.000Z';

function record(options = {}, existing) {
  return merged(devicePayload({ day: DAY, ...options }), existing, options.receivedAt || RECEIVED);
}

const HISTORY = {
  daily: [historyDay('2026-09-18'), historyDay('2026-09-19'), historyDay(DAY, { tokens: 1 })],
  monthly: [historyMonth('2026-08'), historyMonth('2026-09', { tokens: 1 })],
  summary: {}
};

test('a device seen for the first time yields live rows, earlier history, sessions and limits', () => {
  const rows = captureRows(undefined, record({ history: HISTORY }));
  assert.equal(rows.device.deviceId, 'dev-a');
  assert.equal(rows.device.todayKey, DAY);
  assert.equal(rows.device.monthKey, '2026-09');
  assert.equal(rows.device.receivedAt, '2026-09-20T03:00:00.000Z');

  const daily = Object.fromEntries(rows.daily.map((row) => [row.key, row]));
  assert.deepEqual(Object.keys(daily).sort(), ['2026-09-18', '2026-09-19', DAY]);
  // The history row for the device's current day is ignored: live is fresher.
  assert.equal(daily[DAY].source, 'live');
  assert.equal(daily[DAY].totals.tokens, 1000);
  assert.equal(daily['2026-09-18'].source, 'history');
  assert.equal(daily['2026-09-18'].totals.messages, 6);
  assert.equal(daily['2026-09-18'].projects, null, 'history carries no project attribution');
  assert.deepEqual(daily[DAY].clients.map((c) => c.key), ['claude']);
  assert.deepEqual(daily[DAY].projects.map((p) => p.key), ['alpha-service']);

  const monthly = Object.fromEntries(rows.monthly.map((row) => [row.key, row]));
  assert.deepEqual(Object.keys(monthly).sort(), ['2026-08', '2026-09']);
  assert.equal(monthly['2026-09'].source, 'live');
  assert.equal(monthly['2026-08'].source, 'history');
  assert.equal(monthly['2026-08'].totals.cacheReadTokens, null, 'monthly history has no top-level split');

  assert.equal(rows.sessions.length, 1);
  assert.equal(rows.sessions[0].month, '2026-09');
  assert.equal(rows.sessions[0].sessionKey, 'claude:s-1');
  assert.equal(Object.prototype.hasOwnProperty.call(rows.sessions[0], 'title'), false);
  assert.equal(rows.limits.length, 1);
  assert.equal(rows.limits[0].accountEmail, 'someone@example.test');
});

test('the same record again produces nothing but the device row', () => {
  const current = record({ history: HISTORY });
  const again = captureRows(current, JSON.parse(JSON.stringify(current)), { hadHistory: true });
  assert.deepEqual([again.daily.length, again.monthly.length, again.sessions.length, again.limits.length], [0, 0, 0, 0]);
});

test('a live tick rewrites only the current day and month', () => {
  const before = record({ history: HISTORY });
  const after = record({ tokens: 1500, monthTokens: 4500, receivedAt: '2026-09-20T03:10:00.000Z' }, before);
  const rows = captureRows(before, after, { hadHistory: false });
  assert.deepEqual(rows.daily.map((row) => [row.key, row.source, row.totals.tokens]), [[DAY, 'live', 1500]]);
  assert.deepEqual(rows.monthly.map((row) => [row.key, row.source]), [['2026-09', 'live']]);
});

test('history is only examined when the payload carried it, and only changed dates are emitted', () => {
  const before = record({ history: HISTORY });
  const carried = record({ receivedAt: '2026-09-20T03:10:00.000Z' }, before);
  assert.equal(captureRows(before, carried, { hadHistory: false }).daily.length, 0);

  const updated = {
    ...HISTORY,
    daily: [historyDay('2026-09-18'), historyDay('2026-09-19', { tokens: 900 }), historyDay(DAY)]
  };
  const next = record({ history: updated, receivedAt: '2026-09-20T03:20:00.000Z' }, before);
  const rows = captureRows(before, next, { hadHistory: true });
  assert.deepEqual(rows.daily.map((row) => [row.key, row.source, row.totals.tokens]), [['2026-09-19', 'history', 900]]);
});

test('a day rollover starts a new live day and leaves the finished one to history', () => {
  const before = record({ history: HISTORY });
  const nextDay = merged(devicePayload({ day: '2026-09-21', tokens: 10 }), before, '2026-09-21T01:00:00.000Z');
  const rows = captureRows(before, nextDay, { hadHistory: false });
  assert.deepEqual(rows.daily.map((row) => row.key), ['2026-09-21']);

  // The next history tick finalizes the finished day, now that it is no longer
  // the device's current day.
  const final = merged(devicePayload({
    day: '2026-09-21',
    tokens: 10,
    history: { ...HISTORY, daily: [...HISTORY.daily.slice(0, 2), historyDay(DAY, { tokens: 1200 })] }
  }), nextDay, '2026-09-21T01:15:00.000Z');
  const finalRows = captureRows(nextDay, final, { hadHistory: true });
  assert.deepEqual(finalRows.daily.map((row) => [row.key, row.source, row.totals.tokens]), [[DAY, 'history', 1200]]);
});

// `history` as upstream's uploader sends it on `today` (src/shared/syncPayload.js):
// the token split of every day outside the last 30 is dropped, and that of every
// day when the upload is over budget or is the retry after a 413.
function uploaded(history, { today = DAY, overBudget = false } = {}) {
  return syncPayload({ history, periodWindows: { today: { key: today } } }, { omitHistoryTokenComponents: overBudget }).history;
}

// A history row's token split: the four totals, the capability flag and the
// four fields of every client and model entry.
function splitOf(row) {
  const parts = (entry) => [entry.cacheReadTokens, entry.cacheWriteTokens, entry.outputTokens, entry.unclassifiedTokens];
  return { totals: parts(row.totals), available: row.totals.tokenComponentsAvailable, clients: row.clients.map(parts), models: row.models.map(parts) };
}

const OLD = '2026-09-10';
const WITH_SPLIT = { daily: [historyDay(OLD), historyDay('2026-09-18')], monthly: [historyMonth('2026-08')], summary: {} };
const KEPT = { totals: [480, 80, 40, 0], available: true, clients: [[480, 80, 40, 0]], models: [[480, 80, 40, 0]] };
const STRIPPED = { totals: [null, null, null, null], available: false, clients: [[0, 0, 0, 0]], models: [[0, 0, 0, 0]] };

test('a day that only lost its token split on the way is not written again', () => {
  const before = record({ history: uploaded(WITH_SPLIT) });
  const next = record({ history: uploaded(WITH_SPLIT, { overBudget: true }), receivedAt: '2026-09-20T03:10:00.000Z' }, before);
  const alone = (rows) => rows.daily.find((row) => row.key === OLD);
  assert.deepEqual(splitOf(alone(captureRows(undefined, before))), KEPT);
  assert.deepEqual(splitOf(alone(captureRows(undefined, next))), STRIPPED, 'upstream sent the day without its split');
  const rows = captureRows(before, next, { hadHistory: true });
  assert.deepEqual(rows.daily, []);
  assert.deepEqual(rows.monthly, []);
});

test('the 30-day window moving past a day leaves the split it was stored with', () => {
  // On DAY the oldest day that still carries its split is DAY - 29; the next
  // day's upload sends it without one.
  const edge = '2026-08-22';
  const history = { daily: [historyDay(edge), historyDay('2026-09-19')], monthly: [], summary: {} };
  const before = record({ history: uploaded(history) });
  const nextDay = '2026-09-21';
  const later = { ...history, daily: [...history.daily, historyDay(DAY)] };
  const next = merged(devicePayload({ day: nextDay, history: uploaded(later, { today: nextDay }) }), before, '2026-09-21T01:00:00.000Z');
  const alone = (rows) => rows.daily.find((row) => row.key === edge);
  assert.deepEqual(splitOf(alone(captureRows(undefined, before))), KEPT);
  assert.deepEqual(splitOf(alone(captureRows(undefined, next))), STRIPPED);
  const rows = captureRows(before, next, { hadHistory: true });
  assert.deepEqual(rows.daily.map((row) => [row.key, row.source]), [[nextDay, 'live'], [DAY, 'history']], 'only the new live day and the finished day');
});

test('a day that lost its split and changed is written as usual, without a split', () => {
  const before = record({ history: uploaded(WITH_SPLIT) });
  const history = { ...WITH_SPLIT, daily: [historyDay(OLD, { tokens: 900 }), historyDay('2026-09-18')] };
  const next = record({ history: uploaded(history, { overBudget: true }), receivedAt: '2026-09-20T03:10:00.000Z' }, before);
  const rows = captureRows(before, next, { hadHistory: true });
  assert.deepEqual(rows.daily.map((row) => [row.key, row.source, row.totals.tokens]), [[OLD, 'history', 900]]);
  assert.deepEqual(splitOf(rows.daily[0]), STRIPPED);
});

test('any other change to a day that lost its split is written too', () => {
  const before = record({ history: uploaded(WITH_SPLIT) });
  const changes = {
    messages: (day) => ({ ...day, messages: 7 }),
    'active time': (day) => ({ ...day, activeTimeMs: 120000 }),
    'client messages': (day) => ({ ...day, perClient: { claude: { ...day.perClient.claude, messages: 7 } } }),
    'client cost': (day) => ({ ...day, perClient: { claude: { ...day.perClient.claude, cost: 0.3 } } }),
    'model entries': (day) => ({ ...day, perModel: { ...day.perModel, 'gpt-5.1-codex': { tokens: 0, cost: 0 } } })
  };
  for (const [name, change] of Object.entries(changes)) {
    const history = { ...WITH_SPLIT, daily: [change(historyDay(OLD)), historyDay('2026-09-18')] };
    const next = record({ history: uploaded(history, { overBudget: true }), receivedAt: '2026-09-20T03:10:00.000Z' }, before);
    // Exactly the row the day builds on its own: the change, and no split.
    const expected = captureRows(undefined, next).daily.find((row) => row.key === OLD);
    assert.deepEqual(splitOf(expected).totals, [null, null, null, null], name);
    assert.deepEqual(captureRows(before, next, { hadHistory: true }).daily, [expected], name);
  }
});

test('a day whose split comes back after stripped uploads is rewritten with it', () => {
  const before = record({ history: uploaded(WITH_SPLIT) });
  const stripped = record({ history: uploaded(WITH_SPLIT, { overBudget: true }), receivedAt: '2026-09-20T03:10:00.000Z' }, before);
  assert.deepEqual(captureRows(before, stripped, { hadHistory: true }).daily, []);
  // The queue's base is now the stripped record, so another stripped upload
  // compares equal and writes nothing either.
  const again = record({ history: uploaded(WITH_SPLIT, { overBudget: true }), receivedAt: '2026-09-20T03:20:00.000Z' }, stripped);
  assert.deepEqual(captureRows(stripped, again, { hadHistory: true }).daily, []);
  const back = record({ history: uploaded(WITH_SPLIT), receivedAt: '2026-09-20T03:30:00.000Z' }, again);
  const rows = captureRows(again, back, { hadHistory: true });
  assert.deepEqual(rows.daily.map((row) => [row.key, row.source]), [[OLD, 'history'], ['2026-09-18', 'history']]);
  for (const row of rows.daily) assert.deepEqual(splitOf(row), KEPT, row.key);
});

test('history.monthly keeps the plain diff: a month that lost a split is written', () => {
  // Upstream never strips monthly rows (they carry no top-level split), so this
  // month is synthetic: it pins that the exception is history.daily's alone.
  const split = { cacheReadTokens: 3000, cacheWriteTokens: 500, outputTokens: 250, unclassifiedTokens: 0, tokenComponentsAvailable: true };
  const history = { daily: [historyDay(OLD)], monthly: [{ ...historyMonth('2026-08'), ...split }, historyMonth('2026-07')], summary: {} };
  const before = record({ history: uploaded(history) });
  const next = record({
    history: { ...uploaded(history, { overBudget: true }), monthly: [historyMonth('2026-08'), historyMonth('2026-07')] },
    receivedAt: '2026-09-20T03:10:00.000Z'
  }, before);
  const rows = captureRows(before, next, { hadHistory: true });
  assert.deepEqual(rows.daily, [], 'the day that only lost its split is skipped');
  assert.deepEqual(rows.monthly.map((row) => [row.key, row.source, row.totals.cacheReadTokens, row.totals.tokenComponentsAvailable]), [['2026-08', 'history', null, false]]);
});

test('impossible or future dates and keys that do not fit a column are skipped', () => {
  assert.equal(validDay('2026-02-31'), null);
  assert.equal(validDay('2026-9-1'), null);
  assert.equal(validDay('2014-12-31'), null);
  const rows = captureRows(undefined, record({
    history: { daily: [historyDay('2026-02-31'), historyDay('2031-01-01'), historyDay('2026-09-10', { client: 'x'.repeat(65) })], monthly: [], summary: {} }
  }));
  const history = rows.daily.filter((row) => row.source === 'history');
  assert.deepEqual(history.map((row) => row.key), ['2026-09-10']);
  assert.deepEqual(history[0].clients, [], 'a client key longer than the column is dropped, not truncated');
});

test('a record without periodWindows falls back to the UTC day of updatedAt', () => {
  const payload = devicePayload({ day: DAY, updatedAt: '2026-09-19T22:00:00.000Z' });
  delete payload.periodWindows;
  const rows = captureRows(undefined, merged(payload, undefined, RECEIVED));
  assert.equal(rows.device.todayKey, '2026-09-19');
  assert.equal(rows.device.monthKey, '2026-09');
});

test('a record without a usable device id is refused', () => {
  assert.throws(() => captureRows(undefined, { deviceId: '' }), /deviceId/);
  assert.throws(() => captureRows(undefined, { deviceId: 'd'.repeat(192), periods: {} }), /deviceId/);
});
