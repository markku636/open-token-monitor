'use strict';

// What the dashboard's usage views show, read from the daily tables:
//
//   GET /api/custom/usage?org=<unit id>&from=YYYY-MM-DD&to=YYYY-MM-DD
//       &granularity=day|week|month&level=company|bu|department|team
//       &focus=last|range&employee=<employee id>&other=company|bu|department|team
//       &compare=previous|year|custom&cfrom=YYYY-MM-DD&cto=YYYY-MM-DD
//       &client=<tool, e.g. claude>&unowned=1
//
// The range is cut into buckets (days, ISO weeks from Monday, or calendar
// months; periods.js) and every trend comes per bucket, so one answer draws a
// whole view. The period the dashboard is looking at (`focus`) is the last
// bucket (focus=last, the default: the day, week and month views) or the
// whole range (focus=range, key 'range': the last 30 days, a custom range).
// Its figures are set against a comparison window (`previous`, periods.js):
//
//   focus=last   the same stretch of the period before: a week two days old
//                against the first two days of last week, a month clipped to
//                the 15th–30th against the 15th–30th of the month before, a
//                day against the same weekday one week earlier
//   focus=range  the window of the same length right before the range
//
// unless `compare` asks for another: year is the same stretch a year back
// (periods.js yearAgoWindow: 52 weeks for days and weeks, the same dates for
// months and ranges), custom is cfrom–cto, any window of at most
// MAX_RANGE_DAYS that ends by today and shares no day with the focus.
//
// A range is at most MAX_RANGE_DAYS, and so is its comparison window, so an
// answer reads at most twice that.
//
//   totals, trend  the scope (org, or every company) over the range: tokens,
//                  cost, and how many devices and employees had usage
//   focusTotals    the same over the focus, with the days that had usage and
//                  the devices whose usage in it nobody is charged with
//   previous       the scope over the comparison window, and which one it is
//   units          each unit of `level` in the scope, with its focus and
//                  previous figures; `level` defaults to the first level
//                  below the scope that has an active unit or usage
//   other          what in the scope is in no unit of that level: people HR
//                  placed above it (a department in no BU, when BUs are
//                  compared), devices placed in a company by email domain
//                  only, devices nobody owns
//   units[].clients, other.clients
//                  each unit's and other's usage by tool over the focus and the
//                  comparison window ({ client, focus, previous }, most used
//                  first): numbers and tool keys only. Not with client=, nor
//                  in one person's view
//   models,        the focus's usage by model and by tool, each with its
//   clients        trend and previous figures; `idle` has the ones used in
//                  the range or the comparison window but not in the focus
//   composition    the focus's tokens by kind (input, output, cache reads and
//                  writes, unclassified), from the rows that report the split
//   otherLevel     with other=<level>: the scope's "other" at that level on
//                  its own (其他 opened from 單位比較). Everything above is
//                  then only the usage in no unit of that level, with no
//                  levels or units below it and no headcount; the level must
//                  be below the scope, and `level` is ignored. null otherwise
//   unowned        with unowned=1: only the days no employee is charged with
//                  (沒有對應到員工 opened from 員工用量), in the scope and its
//                  other= if any. As with other=, no levels, units or
//                  headcount, and `level` is ignored; for a caller who may see
//                  names, `devices` come with trends, as in one person's view.
//                  false otherwise
//   collectingFrom the day the hub first saw a device: a comparison window
//                  before it holds only the history devices uploaded
//   earliest       the first day with daily usage and the first month with
//                  monthly usage, hub-wide ({ daily, monthly }): before
//                  daily, devices uploaded month totals only
//   client=        one AI tool only: every figure above counts that tool's
//                  usage alone (the day rows by tool), and `models` is empty,
//                  since the usage by model does not say which tool it was.
//                  `tools` lists every tool either way, for the picker
//   monthlyFallback the months of a month view counted from month totals
//                  (rowsFor): a device with no day rows in a whole month of
//                  the range or the comparison window counts its month total
//                  there, charged to whoever owned it on the 1st, with no
//                  active days. The reports do the same (reports.js)
//   purgedBefore   the first day of the month an admin deleted all usage
//                  before (刪除歷史資料, purge.js), or null: nothing earlier
//                  is left to count
//   active         the employees and the devices with usage in the focus
//                  (使用人數 and 活躍裝置 one by one): names, hostnames and
//                  device ids, units and figures, for every caller; not in
//                  one person's view
//   accounts       each AI account (email, else name) with usage in the
//                  focus or the comparison window, its tools and devices
//                  (帳號排行), for every caller: a tool's tokens on a device
//                  go to the account the device last reported for that
//                  tool's provider (accountsOf). Two or more such accounts on
//                  one device share them (`shared`); a tool with no account
//                  there is "other". Each account's usage by provider too
//                  (byProvider). Not in one person's view
//
// For a caller who may see names (the admin key) only:
//
//   users          each employee with a row in the range or the comparison
//                  window, plus one "other" for usage no employee is charged
//                  with; each with its usage by tool (clients) as units have
//   devices        the devices whose usage nobody is charged with; in one
//                  person's view, that person's devices, with trends
//   employee=      one person's view: their usage wherever it was charged,
//                  with no scope, levels or units, and who they are
//                  (`employee`). Anyone else gets 403 names_admin_only,
//                  whether or not the id exists.
//
// Everything else is numbers, unit ids, names and paths, model and tool
// keys and days: no name, email, employee no., hostname or device id, but for
// the names, hostnames and device ids in `active` (and the employee nos. there
// for the admin key), and the AI accounts' emails, hostnames and device ids
// in `accounts`. An employee's name never carries its Chinese part, for the
// admin key either (shownName).
//
// Days are charged the way the reports charge them (reports.js): to whoever
// owned the device that day. A day no ownership range covers counts in the
// company the device's email domain points at (org.js), with no unit below
// it, and otherwise only in "every company".
//
// Every statement holds the store's single lock, which uploads wait on too,
// and anyone who can reach the hub may ask. So the server cancels any one of
// them after STATEMENT_TIMEOUT_MS (503 usage_slow), and at most MAX_RUNNING answers are
// worked out at once and MAX_WAITING more wait for a turn; past that a caller
// without the admin key gets 503 usage_busy with Retry-After. Answers are
// reused for cacheMs, per question (org, range, granularity, level, focus,
// employee) and per whether the caller may see names, until the org chart or
// an owner changes.

const { upstream } = require('../upstream');
const { limitProviderForClient } = require(upstream('src/shared/limits/providers'));
const { COST_BASIS, OWNER_ON_DAY, ownerOnFixedDay, parameters } = require('./reports');
const { GRANULARITIES, addDays, bucketsFor, compareWindow, daysBetween, lastBucket, mergeSpans, overlaps, periodOf, validDay, windowBefore, yearAgoWindow } = require('./periods');
const { LEVELS, SHOWN_LEVELS, levelIndex, unitTree } = require('./units');

const MAX_RANGE_DAYS = 400;
// Past this a statement is cancelled by PostgreSQL (57014) and the answer is
// 503 usage_slow: a range, unit or tool filter that small enough answers fast.
const STATEMENT_TIMEOUT_MS = 15 * 1000;
const BOUNDED = Object.freeze({ timeoutMs: STATEMENT_TIMEOUT_MS });
const DEFAULT_RANGE_DAYS = 7;
const FOCUS_MODES = Object.freeze(['last', 'range']);
const COMPARE_MODES = Object.freeze(['previous', 'year', 'custom']);
// As long as an employee no. an HR import accepts (org.js).
const MAX_EMPLOYEE_ID = 64;
// As long as a tool key the store keeps (persistence/capture.js).
const MAX_CLIENT = 64;
const MAX_RUNNING = 2;
const MAX_WAITING = 16;
const RETRY_AFTER_S = 5;
const MAX_CACHED = 200;
// Roughly: the length of the answers' JSON.
const MAX_CACHED_BYTES = 64 * 1024 * 1024;
// How a person is keyed among the users; "other" is the one without an id.
const EMPLOYEE = 'employee:';

const UNITS_SQL = 'SELECT unit_id, name, parent_unit_id, level, is_active FROM org_units';
const PERSON_SQL = 'SELECT e.employee_id, e.name, e.email, e.is_active, p.unit_id FROM employees e LEFT JOIN employee_placements p ON p.employee_id = e.employee_id WHERE e.employee_id = $1';
const HEADCOUNT_SQL = 'SELECT p.unit_id, COUNT(*) AS people FROM employee_placements p JOIN employees e ON e.employee_id = p.employee_id WHERE e.is_active GROUP BY p.unit_id';
const NAMES_SQL = 'SELECT employee_id, name, email FROM employees WHERE employee_id = ANY($1)';
const HOSTS_SQL = 'SELECT device_id, hostname, deleted_at IS NOT NULL AS deleted FROM devices WHERE device_id = ANY($1)';
// When the hub first saw a device, and the first day and month any usage is
// for: one statement, served by the indexes on usage_date and usage_month.
const COLLECTING_SQL = 'SELECT (SELECT MIN(first_seen_at) FROM devices)::date AS day, (SELECT MIN(usage_date) FROM device_daily_usage) AS daily_from, (SELECT MIN(usage_month) FROM device_monthly_usage) AS monthly_from';
// The AI accounts the devices last reported (accountHolders).
const LIMITS_SQL = "SELECT device_id, provider, account_email, account_name, account_label, status, windows FROM device_limits WHERE status IS DISTINCT FROM 'notConfigured' AND status IS DISTINCT FROM 'disabled'";

class UsageError extends Error {
  constructor(status, code, message, retryAfter = 0) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function money(value) {
  return Number(Number(value || 0).toFixed(6));
}

// An employee's name as the usage views show it: without the Chinese name HR
// lists before the English one (org.js keeps "陳大文 David Chen"). Someone with
// no English name shows as the part of their email before the @.
function shownName(name, email) {
  const latin = String(name || '').replace(/\p{Script=Han}+/gu, ' ').replace(/\s+/g, ' ').trim();
  return latin || String(email || '').split('@')[0] || null;
}

// Per-bucket sums, and who had usage in each bucket.
function series(n) {
  return {
    tokens: new Array(n).fill(0),
    cost: new Array(n).fill(0),
    devices: Array.from({ length: n }, () => new Set()),
    employees: Array.from({ length: n }, () => new Set())
  };
}

function addTo(target, i, row) {
  target.tokens[i] += row.tokens;
  target.cost[i] += row.costUsd;
  if (row.tokens > 0 || row.costUsd > 0) {
    target.devices[i].add(row.deviceId);
    if (row.employeeId) target.employees[i].add(row.employeeId);
  }
}

function trendOf(entry) {
  return {
    tokens: entry.tokens,
    costUsd: entry.cost.map(money),
    devices: entry.devices.map((set) => set.size),
    employees: entry.employees.map((set) => set.size)
  };
}

// Sums over one window (the focus, or the comparison window), and which
// devices and employees had usage in it, on which days.
function tally() {
  return { tokens: 0, cost: 0, devices: new Set(), employees: new Set(), days: new Set() };
}

// A month total (day null) counts no active day.
function addToTally(target, row) {
  target.tokens += row.tokens;
  target.cost += row.costUsd;
  if (row.tokens > 0 || row.costUsd > 0) {
    target.devices.add(row.deviceId);
    if (row.employeeId) target.employees.add(row.employeeId);
    if (row.day) target.days.add(row.day);
  }
}

// A tally as the figures of a unit (and of the scope), of a person, of a device.
function unitFigures(t) {
  return { tokens: t.tokens, costUsd: money(t.cost), devices: t.devices.size, employees: t.employees.size };
}

function personFigures(t) {
  return { tokens: t.tokens, costUsd: money(t.cost), devices: t.devices.size, activeDays: t.days.size };
}

function deviceFigures(t) {
  return { tokens: t.tokens, costUsd: money(t.cost), activeDays: t.days.size };
}

// One unit's, person's or device's usage: per bucket over the range, and over
// the focus and the comparison window. `trend` is 'series' (who had usage in
// each bucket too), 'sums' (plain per-bucket sums, which keeps a person's
// devices light) or 'none'. `used`: any usage in the range or the window.
function entity(n, trend = 'series') {
  return {
    series: trend === 'series' ? series(n) : null,
    sums: trend === 'sums' ? { tokens: new Array(n).fill(0), cost: new Array(n).fill(0) } : null,
    focus: tally(),
    previous: tally(),
    used: false
  };
}

function addToEntity(target, at, row) {
  if (at.i !== undefined) {
    if (target.series) addTo(target.series, at.i, row);
    if (target.sums) {
      target.sums.tokens[at.i] += row.tokens;
      target.sums.cost[at.i] += row.costUsd;
    }
  }
  if (at.inFocus) addToTally(target.focus, row);
  if (at.inCompare) addToTally(target.previous, row);
  if (row.tokens > 0 || row.costUsd > 0) target.used = true;
}

// A day with usage in the focus, for 使用人數 and 活躍裝置 one by one: the
// sums of its device and of the employee charged with it, and the owner and
// unit of each one's latest such day.
function addToActive(active, day, row, unit) {
  const entries = [[active.devices, row.deviceId]];
  if (row.employeeId) entries.push([active.employees, row.employeeId]);
  for (const [map, id] of entries) {
    if (!map.has(id)) map.set(id, { focus: tally(), day: '', employeeId: null, unit: null });
    const entry = map.get(id);
    addToTally(entry.focus, row);
    if (entry.day <= day) Object.assign(entry, { day, employeeId: row.employeeId, unit });
  }
}

// The focus's tokens by kind. A row counts (`covered`) when its split was
// stored (history that lost it has NULLs there) and either its client
// reported every component or the unknown rest was booked as unclassified; a
// total from a client that splits nothing is only in `total`. Input is what
// the other kinds leave of a row's tokens.
function composition() {
  return { total: 0, covered: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unclassified: 0 };
}

function addToComposition(target, raw, tokens) {
  target.total += tokens;
  const unclassified = Number(raw.unclassified_tokens) || 0;
  if (raw.cache_read_tokens === null || raw.cache_read_tokens === undefined) return;
  if (raw.has_token_components !== true && !(unclassified > 0)) return;
  const cacheRead = Number(raw.cache_read_tokens) || 0;
  const cacheWrite = Number(raw.cache_write_tokens) || 0;
  const output = Number(raw.output_tokens) || 0;
  target.covered += tokens;
  target.cacheRead += cacheRead;
  target.cacheWrite += cacheWrite;
  target.output += output;
  target.unclassified += unclassified;
  target.input += Math.max(0, tokens - cacheRead - cacheWrite - output - unclassified);
}

// The buckets of the range, the focus and the window it is compared with, the
// spans of days the statements read (the range and that window, merged), and
// where a day falls: its bucket (undefined outside the range), and whether it
// is in the focus and in the comparison window.
function windowsFor({ from, to, granularity, focusMode, compare: mode = 'previous', cfrom = '', cto = '' }) {
  const { buckets, indexOf } = bucketsFor(from, to, granularity);
  const whole = focusMode === 'range';
  // focus=last: the last bucket itself, the very object in `buckets`.
  const focus = whole ? { key: 'range', from, to, days: daysBetween(from, to) + 1 } : buckets[buckets.length - 1];
  let compare;
  if (mode === 'custom') {
    compare = { from: cfrom, to: cto, days: daysBetween(cfrom, cto) + 1, partial: false };
  } else if (mode === 'year') {
    const period = periodOf(focus.from, granularity);
    compare = yearAgoWindow(focus.from, focus.to, granularity, !whole && !(focus.from === period.from && focus.to === period.to));
  } else {
    compare = whole ? windowBefore(from, to) : compareWindow(focus.from, focus.to, granularity);
  }
  compare = { ...compare, mode };
  const places = new Map();
  const place = (value) => {
    const day = String(value).slice(0, 10);
    if (!places.has(day)) {
      places.set(day, { day, i: indexOf(day), inFocus: day >= focus.from && day <= focus.to, inCompare: day >= compare.from && day <= compare.to });
    }
    return places.get(day);
  };
  // A month total belongs only where its whole month is: a bucket that is
  // the whole month, the focus or the comparison window around all of it.
  const inside = (window, month) => window.from <= month.from && month.to <= window.to;
  const placeMonth = (value) => {
    const first = `${String(value).slice(0, 7)}-01`;
    if (!places.has(first + 'm')) {
      const month = periodOf(first, 'month');
      const i = indexOf(first);
      const whole = i !== undefined && buckets[i].from === month.from && buckets[i].to === month.to;
      places.set(first + 'm', { day: first, monthly: true, i: whole ? i : undefined, inFocus: inside(focus, month), inCompare: inside(compare, month) });
    }
    return places.get(first + 'm');
  };
  // A row of rowsFor, a day's or (monthly) a month total's.
  const placeRow = (raw) => (raw.monthly === true ? placeMonth(raw.usage_date) : place(raw.usage_date));
  // The whole months of the range and of the comparison window, in a month view.
  const months = new Set();
  if (granularity === 'month') {
    for (const window of [{ from, to }, compare]) {
      for (let first = `${window.from.slice(0, 7)}-01`; first <= window.to; first = addDays(periodOf(first, 'month').to, 1)) {
        if (inside(window, periodOf(first, 'month'))) months.add(first.slice(0, 7));
      }
    }
  }
  return { buckets, n: buckets.length, focus, compare, spans: mergeSpans([[from, to], [compare.from, compare.to]]), place, placeRow, fallbackMonths: [...months].sort() };
}

// The days of `spans` as a condition on u.usage_date.
function daysFilter(p, spans) {
  const each = spans.map(([from, to]) => `(u.usage_date >= ${p.add(from)} AND u.usage_date < ${p.add(addDays(to, 1))})`);
  return each.length === 1 ? each[0] : `(${each.join(' OR ')})`;
}

// ` AND …` for the rows of the scope, or '' for every company. A unit is
// itself and every unit under it; a day no one owned the device counts where
// its email domain puts it, which is only ever a company; one person is every
// day charged to them. The scope's "other" (other=) leaves out the days in a
// unit of its level, by owner or by domain; unowned= leaves out the days
// charged to someone. The statements by model and by tool carry no device or
// unit to check again, so for them this is the whole filter; the day rows are
// also checked with unitOf()/inScope().
function scopeFilter(p, employee, { scopeIds, domainDevices, outside, unowned }) {
  if (employee) return ` AND o.employee_id = ${p.add(employee)}`;
  let sql = '';
  if (scopeIds) {
    const owned = `o.unit_id = ANY(${p.add([...scopeIds])})`;
    sql += domainDevices.length ? ` AND (${owned} OR (o.unit_id IS NULL AND u.device_id = ANY(${p.add(domainDevices)})))` : ` AND ${owned}`;
  }
  if (outside) {
    const placed = [];
    if (outside.unitIds.length) placed.push(`(o.unit_id IS NOT NULL AND o.unit_id = ANY(${p.add(outside.unitIds)}))`);
    if (outside.domainDevices.length) placed.push(`(o.unit_id IS NULL AND u.device_id = ANY(${p.add(outside.domainDevices)}))`);
    if (placed.length) sql += ` AND NOT (${placed.join(' OR ')})`;
  }
  if (unowned) sql += ' AND o.employee_id IS NULL';
  return sql;
}

// The levels units can be compared at under the scope: of the shown levels
// (company and department), those with an active unit below it, and those
// in-range usage was charged to (a department HR retired since). A level
// that is not shown can still be asked for. Worked out ahead of the fold, which compares units of the level
// picked here.
function levelsFor(asked, ctx, plan, daily) {
  const { tree, scope, person, other, unowned } = ctx;
  if (person || other || unowned) return { levels: [], level: null };
  const scopeLevel = scope ? levelIndex(scope.level) : -1;
  if (asked && levelIndex(asked) <= scopeLevel) throw new UsageError(400, 'bad_level', `level ${asked} is not below the ${scope.level} ${scope.name}`);
  const used = new Set();
  const seen = new Set();
  for (const raw of daily) {
    if (!(Number(raw.tokens) > 0 || Number(raw.cost_usd) > 0) || plan.placeRow(raw).i === undefined) continue;
    const unit = ctx.unitOf(raw.device_id, raw.unit_id);
    if (unit === null || seen.has(unit) || !ctx.inScope(unit, raw.employee_id)) continue;
    seen.add(unit);
    for (const id of tree.chainOf(unit)) {
      if (ctx.below(tree.units.get(id))) used.add(tree.units.get(id).level);
    }
  }
  const active = (level) => [...tree.units.values()].some((unit) => unit.level === level && unit.active && ctx.below(unit));
  const levels = SHOWN_LEVELS.filter((level) => levelIndex(level) > scopeLevel && (active(level) || used.has(level)));
  return { levels, level: asked || levels[0] || null };
}

// One pass over the day rows of the range and the comparison window: the
// scope, the units of `level` and "other", and, for a caller who may see
// names, each person and the devices (in one person's view all of theirs,
// elsewhere those with usage nobody is charged with; with trends in one
// person's view and with unowned=).
function fold({ people }, ctx, plan, daily, level) {
  const { person, unowned } = ctx;
  const { n } = plan;
  const acc = {
    total: entity(n),
    other: entity(n),
    units: new Map(),
    users: new Map(),
    userUnit: new Map(),
    devices: new Map(),
    range: { devices: new Set(), employees: new Set(), days: new Set() },
    unowned: new Set(),
    active: { employees: new Map(), devices: new Map() },
    composition: composition()
  };
  for (const raw of daily) {
    const at = plan.placeRow(raw);
    if (at.i === undefined && !at.inCompare && !at.inFocus) continue;
    const unit = ctx.unitOf(raw.device_id, raw.unit_id);
    if (!ctx.inScope(unit, raw.employee_id)) continue;
    const row = { day: at.monthly ? null : at.day, deviceId: raw.device_id, employeeId: raw.employee_id || null, tokens: Number(raw.tokens) || 0, costUsd: Number(raw.cost_usd) || 0 };
    const used = row.tokens > 0 || row.costUsd > 0;
    addToEntity(acc.total, at, row);
    if (at.i !== undefined && used) {
      acc.range.devices.add(row.deviceId);
      if (row.employeeId) acc.range.employees.add(row.employeeId);
      if (row.day) acc.range.days.add(row.day);
    }
    if (at.inFocus) {
      addToComposition(acc.composition, raw, row.tokens);
      if (used && !row.employeeId) acc.unowned.add(row.deviceId);
      if (used && !person) addToActive(acc.active, at.day, row, unit);
    }
    if (!person) {
      // The unit of `level` the day's unit is in, or null: "other".
      const target = ctx.unitAt(level, unit);
      if (target && !acc.units.has(target)) acc.units.set(target, entity(n));
      addToEntity(target ? acc.units.get(target) : acc.other, at, row);
    }
    if (!people) continue;
    const key = row.employeeId ? `${EMPLOYEE}${row.employeeId}` : 'other';
    if (!acc.users.has(key)) acc.users.set(key, entity(n));
    addToEntity(acc.users.get(key), at, row);
    // An employee is shown under the unit their latest day went to.
    const seen = acc.userUnit.get(key);
    if (row.employeeId && unit && (!seen || seen.day <= at.day)) acc.userUnit.set(key, { day: at.day, unit });
    if (person || !row.employeeId) {
      if (!acc.devices.has(row.deviceId)) acc.devices.set(row.deviceId, entity(n, person || unowned ? 'sums' : 'none'));
      addToEntity(acc.devices.get(row.deviceId), at, row);
    }
  }
  return acc;
}

// Each unit's of `level`, other's and (for a caller who may see names) each
// person's usage by tool, over the focus and the comparison window, from the
// day rows per device and tool. 單位比較 and 使用者比較 split their bars by
// it and sort by one tool.
function foldTools({ people }, ctx, plan, rows, level) {
  const out = { units: new Map(), other: new Map(), users: new Map() };
  const into = (map, id, client, at, tokens, cost) => {
    if (!map.has(id)) map.set(id, new Map());
    const tools = map.get(id);
    if (!tools.has(client)) tools.set(client, { focus: { tokens: 0, cost: 0 }, previous: { tokens: 0, cost: 0 } });
    const entry = tools.get(client);
    if (at.inFocus) {
      entry.focus.tokens += tokens;
      entry.focus.cost += cost;
    }
    if (at.inCompare) {
      entry.previous.tokens += tokens;
      entry.previous.cost += cost;
    }
  };
  for (const raw of rows) {
    const at = plan.placeRow(raw);
    if (!at.inFocus && !at.inCompare) continue;
    const unit = ctx.unitOf(raw.device_id, raw.unit_id);
    if (!ctx.inScope(unit, raw.employee_id)) continue;
    const tokens = Number(raw.tokens) || 0;
    const cost = Number(raw.cost_usd) || 0;
    if (!(tokens > 0 || cost > 0)) continue;
    const target = ctx.unitAt(level, unit);
    if (target) into(out.units, target, raw.client, at, tokens, cost);
    else into(out.other, 'other', raw.client, at, tokens, cost);
    if (people) into(out.users, raw.employee_id ? `${EMPLOYEE}${raw.employee_id}` : 'other', raw.client, at, tokens, cost);
  }
  return out;
}

// One entity's tools as the answer lists them: most used in the focus first.
function toolList(tools) {
  return [...(tools || new Map())]
    .map(([client, entry]) => ({
      client,
      focus: { tokens: entry.focus.tokens, costUsd: money(entry.focus.cost) },
      previous: { tokens: entry.previous.tokens, costUsd: money(entry.previous.cost) }
    }))
    .sort((a, b) => b.focus.tokens - a.focus.tokens || b.previous.tokens - a.previous.tokens || a.client.localeCompare(b.client));
}

// Who holds each provider's account on each device: device id → provider →
// identity (the email, else the name or label, lower-cased) → as written. An
// account counts the way the dashboard lists it: reported as connected, or
// with quota windows. device_limits keeps only the latest report, so it
// stands for every day of the range.
function accountHolders(limits) {
  const holders = new Map();
  for (const row of limits) {
    const windows = Array.isArray(row.windows) ? row.windows : [];
    if (row.status !== 'ok' && !windows.length) continue;
    const who = String(row.account_email || row.account_name || row.account_label || '').trim();
    if (!who) continue;
    if (!holders.has(row.device_id)) holders.set(row.device_id, new Map());
    const byProvider = holders.get(row.device_id);
    if (!byProvider.has(row.provider)) byProvider.set(row.provider, new Map());
    const accounts = byProvider.get(row.provider);
    if (!accounts.has(who.toLowerCase())) accounts.set(who.toLowerCase(), who);
  }
  return holders;
}

// Each account's usage over the focus and the comparison window, from the
// day rows per device and tool: a tool's tokens go to the account its device
// holds for the tool's provider; with two or more there, to all of them
// together (one entry keyed by them all), with none, to "other". The unit is
// the one the account's latest day in scope was charged to. An account on
// two providers (one email for Claude and Codex) has each one's share in
// byProvider; "other" has none.
function accountsOf(ctx, plan, rows, holders) {
  const accounts = new Map();
  for (const raw of rows) {
    const at = plan.placeRow(raw);
    if (!at.inFocus && !at.inCompare) continue;
    const unit = ctx.unitOf(raw.device_id, raw.unit_id);
    if (!ctx.inScope(unit, raw.employee_id)) continue;
    const provider = limitProviderForClient(raw.client);
    const held = (provider && holders.get(raw.device_id)?.get(provider)) || new Map();
    const ids = [...held.keys()].sort();
    const key = ids.length ? ids.join(' + ') : 'other';
    if (!accounts.has(key)) {
      accounts.set(key, { who: ids.map((id) => held.get(id)), figures: entity(0, 'none'), byProvider: new Map(), providers: new Set(), devices: new Set(), tools: new Map(), unit: null });
    }
    const entry = accounts.get(key);
    const row = { day: at.monthly ? null : at.day, deviceId: raw.device_id, employeeId: null, tokens: Number(raw.tokens) || 0, costUsd: Number(raw.cost_usd) || 0 };
    addToEntity(entry.figures, at, row);
    if (ids.length) {
      if (!entry.byProvider.has(provider)) entry.byProvider.set(provider, entity(0, 'none'));
      addToEntity(entry.byProvider.get(provider), at, row);
    }
    if (!(row.tokens > 0 || row.costUsd > 0)) continue;
    entry.devices.add(row.deviceId);
    if (ids.length) entry.providers.add(provider);
    if (unit && (!entry.unit || entry.unit.day <= at.day)) entry.unit = { day: at.day, unit };
    if (!at.inFocus) continue;
    if (!entry.tools.has(raw.client)) entry.tools.set(raw.client, { tokens: 0, cost: 0 });
    const tool = entry.tools.get(raw.client);
    tool.tokens += row.tokens;
    tool.cost += row.costUsd;
  }
  return accounts;
}

// Usage by model or by tool, from rows summed per day and key. The list is
// the focus's, as before: keys with usage in the focus, most tokens first,
// now each with its trend over the range and its comparison-window sums. Keys
// used only elsewhere in the range or in the comparison window are `idle`,
// the most used before first.
function keysOf(rows, plan) {
  const byKey = new Map();
  for (const raw of rows) {
    const at = plan.placeRow(raw);
    if (at.i === undefined && !at.inCompare && !at.inFocus) continue;
    if (!byKey.has(raw.key)) {
      byKey.set(raw.key, { key: raw.key, focus: { tokens: 0, cost: 0 }, previous: { tokens: 0, cost: 0 }, tokens: new Array(plan.n).fill(0), cost: new Array(plan.n).fill(0), used: false });
    }
    const entry = byKey.get(raw.key);
    const tokens = Number(raw.tokens) || 0;
    const cost = Number(raw.cost_usd) || 0;
    if (at.i !== undefined) {
      entry.tokens[at.i] += tokens;
      entry.cost[at.i] += cost;
    }
    for (const [inside, sums] of [[at.inFocus, entry.focus], [at.inCompare, entry.previous]]) {
      if (!inside) continue;
      sums.tokens += tokens;
      sums.cost += cost;
    }
    if (tokens > 0 || cost > 0) entry.used = true;
  }
  const figures = (entry) => ({
    previous: { tokens: entry.previous.tokens, costUsd: money(entry.previous.cost) },
    trend: { tokens: entry.tokens, costUsd: entry.cost.map(money) }
  });
  const inFocus = (entry) => entry.focus.tokens > 0 || entry.focus.cost > 0;
  const entries = [...byKey.values()];
  return {
    list: entries.filter(inFocus)
      .map((entry) => ({ key: entry.key, tokens: entry.focus.tokens, costUsd: money(entry.focus.cost), ...figures(entry) }))
      .sort((a, b) => b.tokens - a.tokens || b.costUsd - a.costUsd),
    idle: entries.filter((entry) => entry.used && !inFocus(entry))
      .map((entry) => ({ key: entry.key, ...figures(entry) }))
      .sort((a, b) => b.previous.tokens - a.previous.tokens || b.previous.costUsd - a.previous.costUsd || String(a.key).localeCompare(String(b.key)))
  };
}

// 使用人數 and 活躍裝置 one by one, most tokens first: the people and the
// devices with usage in the focus, by name and hostname for every caller.
// Employee nos. only for a caller who may see names (they open a person's view).
function activeLists(key, acc, labels, unitRef) {
  const byTokens = (a, b) => b.focus.tokens - a.focus.tokens || b.focus.costUsd - a.focus.costUsd || String(a.name || a.hostname || a.id).localeCompare(String(b.name || b.hostname || b.id));
  const who = (id) => ({ ...(key.people ? { id } : {}), name: labels.names.get(id)?.name || (key.people ? id : null) });
  return {
    employees: [...acc.active.employees].map(([id, entry]) => ({
      ...who(id),
      unit: entry.unit ? unitRef(entry.unit) : null,
      focus: personFigures(entry.focus)
    })).sort(byTokens),
    devices: [...acc.active.devices].map(([id, entry]) => ({
      id,
      hostname: labels.hosts.get(id)?.hostname || null,
      deleted: labels.hosts.get(id)?.deleted === true,
      employee: entry.employeeId ? who(entry.employeeId) : null,
      unit: entry.unit ? unitRef(entry.unit) : null,
      focus: deviceFigures(entry.focus)
    })).sort(byTokens)
  };
}

// The answer, from everything the statements and the fold found.
function shape({ key, ctx, plan, rows, levels, level, acc, labels, generatedAt, purgedBefore = null }) {
  const { tree, scope, person } = ctx;
  const { n } = plan;
  // A person's or device's unit, as shown: its department, or its company.
  const unitRef = (id) => {
    const shown = tree.shownOf(id);
    return { id: shown, name: tree.units.get(shown).name, path: tree.shownPathOf(shown) };
  };

  // Active people on the HR lists, per unit and everything above it.
  const headcount = new Map();
  for (const row of rows.heads) {
    if (!tree.units.has(row.unit_id)) continue;
    for (const id of tree.chainOf(row.unit_id)) headcount.set(id, (headcount.get(id) || 0) + Number(row.people || 0));
  }
  // The scope's other has no roster, as in 單位比較, nor has the usage no
  // employee is charged with.
  let listed = 0;
  if (ctx.other || ctx.unowned) listed = 0;
  else if (scope) listed = headcount.get(scope.id) || 0;
  else if (!person) listed = [...tree.units.values()].filter((unit) => !unit.parentId).reduce((sum, unit) => sum + (headcount.get(unit.id) || 0), 0);

  const byFocus = (a, b) => b.focus.tokens - a.focus.tokens || String(a.name).localeCompare(String(b.name));
  const units = level
    ? [...tree.units.values()]
      .filter((unit) => unit.level === level && ctx.below(unit) && (unit.active || acc.units.has(unit.id)))
      .map((unit) => {
        const entry = acc.units.get(unit.id) || entity(n);
        return {
          id: unit.id,
          name: unit.name,
          path: tree.shownPathOf(unit.id),
          active: unit.active,
          headcount: headcount.get(unit.id) || 0,
          trend: trendOf(entry.series),
          focus: unitFigures(entry.focus),
          previous: unitFigures(entry.previous),
          ...(acc.tools ? { clients: toolList(acc.tools.units.get(unit.id)) } : {})
        };
      })
      .sort(byFocus)
    : [];

  const personKey = person ? `${EMPLOYEE}${person.id}` : null;
  const named = {};
  if (key.people) {
    // One person's view has that person even without a single row.
    const entries = person ? [[personKey, acc.users.get(personKey) || entity(n)]] : [...acc.users];
    named.users = entries.map(([userKey, entry]) => {
      const id = userKey === 'other' ? null : userKey.slice(EMPLOYEE.length);
      const listing = person || labels.names.get(id);
      const unit = acc.userUnit.get(userKey)?.unit || null;
      return {
        id,
        name: id ? listing?.name || id : null,
        email: id ? listing?.email || null : null,
        other: !id,
        unit: unit ? unitRef(unit) : null,
        trend: trendOf(entry.series),
        focus: personFigures(entry.focus),
        previous: personFigures(entry.previous),
        ...(acc.tools ? { clients: toolList(acc.tools.users.get(userKey)) } : {})
      };
    }).sort((a, b) => Number(a.other) - Number(b.other) || byFocus(a, b));
    named.devices = [...acc.devices]
      .filter(([, entry]) => person || entry.used)
      .map(([id, entry]) => ({
        id,
        hostname: labels.hosts.get(id)?.hostname || null,
        deleted: labels.hosts.get(id)?.deleted === true,
        focus: deviceFigures(entry.focus),
        previous: deviceFigures(entry.previous),
        ...(entry.sums ? { trend: { tokens: entry.sums.tokens, costUsd: entry.sums.cost.map(money) } } : {})
      }))
      .sort((a, b) => b.focus.tokens - a.focus.tokens || b.previous.tokens - a.previous.tokens || a.id.localeCompare(b.id));
  }
  // 帳號排行, for every caller.
  if (!person) named.accounts = [...acc.accounts]
    .filter(([, entry]) => entry.figures.used)
    .map(([id, entry]) => ({
      id,
      name: entry.who.length ? entry.who.join('、') : null,
      who: entry.who,
      shared: entry.who.length > 1,
      other: !entry.who.length,
      providers: [...entry.providers].sort(),
      unit: entry.who.length && entry.unit ? unitRef(entry.unit.unit) : null,
      devices: [...entry.devices].map((deviceId) => ({ id: deviceId, hostname: labels.hosts.get(deviceId)?.hostname || null }))
        .sort((a, b) => String(a.hostname || a.id).localeCompare(String(b.hostname || b.id))),
      tools: [...entry.tools].map(([client, t]) => ({ client, tokens: t.tokens, costUsd: money(t.cost) }))
        .sort((a, b) => b.tokens - a.tokens || b.costUsd - a.costUsd || a.client.localeCompare(b.client)),
      byProvider: [...entry.byProvider].filter(([, part]) => part.used)
        .map(([provider, part]) => ({ provider, focus: personFigures(part.focus), previous: personFigures(part.previous) }))
        .sort((a, b) => b.focus.tokens - a.focus.tokens || b.previous.tokens - a.previous.tokens || a.provider.localeCompare(b.provider)),
      focus: personFigures(entry.figures.focus),
      previous: personFigures(entry.figures.previous)
    }))
    .sort((a, b) => Number(a.other) - Number(b.other) || b.focus.tokens - a.focus.tokens || b.previous.tokens - a.previous.tokens || a.id.localeCompare(b.id));
  if (person) {
    // Where HR placed them, else where their latest charged day went.
    const unit = person.unitId || acc.userUnit.get(personKey)?.unit || null;
    named.employee = { id: person.id, name: person.name, email: person.email, active: person.active, unit: unit ? unitRef(unit) : null };
  }

  const models = keysOf(rows.models, plan);
  // Every tool, unfiltered: what client= may pick. With a tool, `clients`
  // is that one only.
  const tools = keysOf(rows.clients, plan);
  const only = (list) => (key.client ? list.filter((entry) => entry.key === key.client) : list);
  const clients = { list: only(tools.list), idle: only(tools.idle) };
  const as = (name) => ({ key: value, ...entry }) => ({ [name]: value, ...entry });
  const totalTrend = trendOf(acc.total.series);
  return {
    ok: true,
    from: key.from,
    to: key.to,
    granularity: key.granularity,
    level,
    levels,
    buckets: plan.buckets,
    focus: plan.focus,
    scope: scope ? { id: scope.id, name: scope.name, level: scope.level, path: tree.shownPathOf(scope.id) } : null,
    otherLevel: ctx.other,
    unowned: ctx.unowned,
    people: key.people,
    currency: 'USD',
    costBasis: COST_BASIS,
    generatedAt,
    collectingFrom: rows.collectingFrom,
    earliest: rows.earliest,
    monthlyFallback: [...new Set(rows.daily.filter((raw) => raw.monthly === true && (Number(raw.tokens) > 0 || Number(raw.cost_usd) > 0)).map((raw) => String(raw.usage_date).slice(0, 7)))].sort(),
    purgedBefore,
    headcount: listed,
    totals: {
      tokens: totalTrend.tokens.reduce((a, b) => a + b, 0),
      costUsd: money(acc.total.series.cost.reduce((a, b) => a + b, 0)),
      devices: acc.range.devices.size,
      employees: acc.range.employees.size,
      activeDays: acc.range.days.size
    },
    focusTotals: { ...unitFigures(acc.total.focus), activeDays: acc.total.focus.days.size, unownedDevices: acc.unowned.size },
    ...(person ? {} : { active: activeLists(key, acc, labels, unitRef) }),
    trend: totalTrend,
    previous: { from: plan.compare.from, to: plan.compare.to, days: plan.compare.days, partial: plan.compare.partial, mode: plan.compare.mode, ...unitFigures(acc.total.previous) },
    units,
    other: { ...trendOf(acc.other.series), focus: unitFigures(acc.other.focus), previous: unitFigures(acc.other.previous), ...(acc.tools ? { clients: toolList(acc.tools.other.get('other')) } : {}) },
    ...named,
    models: models.list.map(as('model')),
    clients: clients.list.map(as('client')),
    idle: { models: models.idle.map(as('model')), clients: clients.idle.map(as('client')) },
    client: key.client || null,
    tools: [
      ...tools.list.map((entry) => ({ client: entry.key, tokens: entry.tokens, costUsd: entry.costUsd, previous: entry.previous })),
      ...tools.idle.map((entry) => ({ client: entry.key, tokens: 0, costUsd: 0, previous: entry.previous }))
    ],
    composition: acc.composition
  };
}

function createUsage({ store = null, org = null, cacheMs = 60 * 1000, now = () => Date.now() } = {}) {
  // The question a request asks, normalised: everything that changes the
  // answer, and nothing else, since it is the cache key.
  function request(url) {
    const params = url.searchParams;
    const today = new Date(now()).toISOString().slice(0, 10);
    const to = validDay(params.get('to') || today);
    const from = validDay(params.get('from') || (to && addDays(to, 1 - DEFAULT_RANGE_DAYS)));
    if (!from || !to) throw new UsageError(400, 'bad_range', 'from and to must be YYYY-MM-DD');
    if (from > to) throw new UsageError(400, 'bad_range', 'from must not be after to');
    if (daysBetween(from, to) >= MAX_RANGE_DAYS) throw new UsageError(400, 'range_too_long', `at most ${MAX_RANGE_DAYS} days per request`);
    const granularity = params.get('granularity') || 'day';
    if (!GRANULARITIES.includes(granularity)) throw new UsageError(400, 'bad_granularity', `granularity must be one of ${GRANULARITIES.join(', ')}`);
    const focusMode = params.get('focus') || 'last';
    if (!FOCUS_MODES.includes(focusMode)) throw new UsageError(400, 'bad_focus', `focus must be one of ${FOCUS_MODES.join(', ')}`);
    const { compare, cfrom, cto } = comparison(params, { from, to, granularity, focusMode, today });
    const client = toolOf(params);
    if (params.has('employee')) {
      const employee = params.get('employee').trim();
      if (!employee || employee.length > MAX_EMPLOYEE_ID) throw new UsageError(400, 'bad_employee', `employee must be an employee no. of 1 to ${MAX_EMPLOYEE_ID} characters`);
      // One person's view has no unit, no level, no other and no unowned:
      // they are ignored.
      return { scopeId: '', from, to, granularity, level: '', focusMode, employee, other: '', unowned: false, compare, cfrom, cto, client };
    }
    const other = params.get('other') || '';
    if (other && levelIndex(other) < 0) throw new UsageError(400, 'bad_other', `other must be one of ${LEVELS.join(', ')}`);
    const unowned = params.has('unowned');
    if (unowned && params.get('unowned') !== '1') throw new UsageError(400, 'bad_unowned', 'unowned must be 1');
    // The scope's other and the unowned usage have no units to compare: the
    // level is ignored.
    const level = other || unowned ? '' : params.get('level') || '';
    if (level && levelIndex(level) < 0) throw new UsageError(400, 'bad_level', `level must be one of ${LEVELS.join(', ')}`);
    return { scopeId: params.get('org') || '', from, to, granularity, level, focusMode, employee: '', other, unowned, compare, cfrom, cto, client };
  }

  // The one tool asked for, or '' for all of them. Any key a client reported
  // may be asked for, so it is only kept short and printable.
  function toolOf(params) {
    if (!params.has('client')) return '';
    const client = params.get('client');
    let printable = client.length > 0 && client.length <= MAX_CLIENT;
    for (let i = 0; printable && i < client.length; i += 1) {
      const code = client.charCodeAt(i);
      if (code < 32 || code === 127) printable = false;
    }
    if (!printable) throw new UsageError(400, 'bad_client', `client must be a tool key of 1 to ${MAX_CLIENT} printable characters`);
    return client;
  }

  // What the focus is compared with. cfrom and cto count only for custom, so
  // they never split the cache otherwise.
  function comparison(params, { from, to, granularity, focusMode, today }) {
    const compare = params.get('compare') || 'previous';
    if (!COMPARE_MODES.includes(compare)) throw new UsageError(400, 'bad_compare', `compare must be one of ${COMPARE_MODES.join(', ')}`);
    if (compare !== 'custom') return { compare, cfrom: '', cto: '' };
    const cfrom = validDay(params.get('cfrom'));
    const cto = validDay(params.get('cto'));
    if (!cfrom || !cto) throw new UsageError(400, 'bad_compare', 'compare=custom needs cfrom and cto as YYYY-MM-DD');
    if (cfrom > cto) throw new UsageError(400, 'bad_compare', 'cfrom must not be after cto');
    if (daysBetween(cfrom, cto) >= MAX_RANGE_DAYS) throw new UsageError(400, 'bad_compare', `a comparison window is at most ${MAX_RANGE_DAYS} days`);
    if (cto > today) throw new UsageError(400, 'bad_compare', 'a comparison window must end by today');
    const focus = focusMode === 'range' ? { from, to } : lastBucket(from, to, granularity);
    if (overlaps(focus, { from: cfrom, to: cto })) throw new UsageError(400, 'bad_compare', 'a comparison window must not share a day with the period it is compared with');
    return { compare, cfrom, cto };
  }

  // The first phase: the org tree and the scope in it, or the one person; and
  // where the scope's rows are, its units and the devices its company has by
  // email domain, for the statements of the second phase. With other=, also
  // the units of that level and everything under them, and the devices they
  // have by domain: the days the scope's other leaves out.
  async function contextFor({ scopeId, employee, other, unowned }) {
    const [unitRows, personRows] = await Promise.all([
      store.query(UNITS_SQL, [], BOUNDED),
      employee ? store.query(PERSON_SQL, [employee], BOUNDED) : []
    ]);
    const tree = unitTree(unitRows);
    const scope = scopeId ? tree.units.get(scopeId) || null : null;
    if (scopeId && !scope) throw new UsageError(404, 'unknown_org', `unit ${scopeId} does not exist`);
    if (other && scope && levelIndex(other) <= levelIndex(scope.level)) {
      throw new UsageError(400, 'bad_other', `other ${other} is not below the ${scope.level} ${scope.name}`);
    }
    let person = null;
    if (employee) {
      const [row] = personRows;
      if (!row) throw new UsageError(404, 'unknown_employee', 'no employee has that employee no.');
      person = { id: row.employee_id, name: shownName(row.name, row.email), email: row.email || null, active: row.is_active === true, unitId: tree.units.has(row.unit_id) ? row.unit_id : null };
    }
    // Where an unowned device counts today by its email domain (org.js).
    const byDomain = new Map((org?.devices() || []).filter((place) => place.source === 'domain').map((place) => [place.deviceId, place.unitId]));
    const scopeIds = scope ? tree.subtree(scope.id) : null;
    // The unit of `level` a unit is in, below the scope, or null: "other".
    const unitAt = (level, unit) => {
      if (!level || !unit) return null;
      const target = tree.ancestorAt(unit, level);
      return target && target !== scope?.id ? target : null;
    };
    const placed = other ? new Set([...tree.units.keys()].filter((id) => unitAt(other, id))) : null;
    return {
      tree,
      scope,
      person,
      other: other || null,
      unowned: Boolean(unowned),
      scopeIds,
      domainDevices: scopeIds ? [...byDomain].filter(([, unit]) => scopeIds.has(unit)).map(([deviceId]) => deviceId) : [],
      outside: placed ? {
        unitIds: [...placed],
        domainDevices: [...byDomain].filter(([, unit]) => placed.has(unit)).map(([deviceId]) => deviceId)
      } : null,
      unitAt,
      unitOf: (deviceId, ownerUnit) => {
        const unit = ownerUnit || byDomain.get(deviceId) || null;
        return unit && tree.units.has(unit) ? unit : null;
      },
      // A day's unit and the employee charged with it.
      inScope: (unit, employeeId) => (!scope || (unit !== null && tree.within(unit, scope.id))) && !placed?.has(unit) && !(unowned && employeeId),
      below: (unit) => unit.id !== scope?.id && (!scope || tree.within(unit.id, scope.id))
    };
  }

  // The day the hub first saw a device and the first usage, hub-wide: read
  // once per cacheMs.
  let collecting = null;
  function collectingFrom() {
    if (!collecting || now() - collecting.at >= cacheMs) {
      const promise = store.query(COLLECTING_SQL, [], BOUNDED).then(([row]) => ({
        day: validDay(String(row?.day ?? '').slice(0, 10)),
        daily: validDay(String(row?.daily_from ?? '').slice(0, 10)),
        monthly: /^\d{4}-\d{2}$/.test(String(row?.monthly_from ?? '')) ? row.monthly_from : null
      }));
      collecting = { at: now(), promise };
      promise.catch(() => {
        if (collecting?.promise === promise) collecting = null;
      });
    }
    return collecting.promise;
  }

  // The second phase, once the scope is known: the day rows of the range and
  // the comparison window, the same by model and by tool (summed per day in
  // SQL), the names on the HR lists per unit, and when the hub started.
  async function rowsFor(key, plan, ctx) {
    const statement = (build) => {
      const p = parameters();
      const sql = build(p);
      return store.query(sql, p.values, BOUNDED);
    };
    const where = (p) => `${daysFilter(p, plan.spans)}${scopeFilter(p, key.employee, ctx)}`;
    // Only a filter on the owner needs the owner of the day.
    const filtered = key.employee || ctx.scopeIds || ctx.outside || ctx.unowned;
    const owners = filtered ? ` LEFT JOIN device_owners o ON ${OWNER_ON_DAY}` : '';
    // A month view's month totals (windowsFor fallbackMonths): the whole months
    // in which a device has no day rows, charged to the owner of the 1st, as a
    // second part of the same statement (no statement more). `columns` are
    // the day part's, of the monthly table's alias u.
    const months = plan.fallbackMonths;
    const firstOfMonth = "(u.usage_month || '-01')";
    const monthly = (p, table, columns, { join = true, group = '', also = null } = {}) => (months.length
      ? ` UNION ALL SELECT ${firstOfMonth}::date AS usage_date, ${columns}, true AS monthly FROM ${table} u${join ? ` LEFT JOIN device_owners o ON ${ownerOnFixedDay(firstOfMonth)}` : ''}`
        + ` WHERE u.usage_month = ANY(${p.add(months)}) AND NOT EXISTS (SELECT 1 FROM device_daily_usage x WHERE x.device_id = u.device_id AND x.usage_date >= ${firstOfMonth}::date AND x.usage_date < (${firstOfMonth}::date + interval '1 month')::date)`
        + `${scopeFilter(p, key.employee, ctx)}${also ? also(p) : ''}${group}`
      : '');
    const flag = months.length ? ', false AS monthly' : '';
    // client=: the day rows of one tool, from the table by tool. Its split
    // columns are 0, never NULL, when nothing was reported, so a split is
    // there when any of them is not.
    const tool = (p) => (key.client ? ` AND u.client = ${p.add(key.client)}` : '');
    const toolSplit = '(u.cache_read_tokens + u.cache_write_tokens + u.output_tokens + u.unclassified_tokens) > 0 AS has_token_components';
    const byKey = (table, monthlyTable, column) => statement((p) => `SELECT u.usage_date, u.${column} AS key, SUM(u.tokens) AS tokens, SUM(u.cost_usd) AS cost_usd${flag} FROM ${table} u${owners} WHERE ${where(p)} GROUP BY u.usage_date, u.${column}`
      + monthly(p, monthlyTable, `u.${column} AS key, SUM(u.tokens) AS tokens, SUM(u.cost_usd) AS cost_usd`, { join: Boolean(filtered), group: ` GROUP BY u.usage_month, u.${column}` }));
    // The day rows per device and tool, over the focus and the comparison
    // window only: the tools of each unit, other and person (foldTools), and
    // who used which account (帳號排行), with the accounts the devices hold.
    // Not needed in one person's view.
    const accounts = !key.employee;
    const clientColumns = 'u.client, u.device_id, o.employee_id, o.unit_id, u.tokens, u.cost_usd';
    const windows = mergeSpans([[plan.focus.from, plan.focus.to], [plan.compare.from, plan.compare.to]]);
    const byDevice = accounts
      ? statement((p) => `SELECT u.usage_date, ${clientColumns}${flag} FROM device_daily_client_usage u LEFT JOIN device_owners o ON ${OWNER_ON_DAY} WHERE ${daysFilter(p, windows)}${scopeFilter(p, key.employee, ctx)}${tool(p)}`
        + monthly(p, 'device_monthly_client_usage', clientColumns, { also: tool }))
      : [];
    const dayColumns = 'u.device_id, o.employee_id, o.unit_id, u.tokens, u.cost_usd, u.cache_read_tokens, u.cache_write_tokens, u.output_tokens, u.unclassified_tokens';
    const days = key.client
      ? (p) => `SELECT u.usage_date, ${dayColumns}, ${toolSplit}${flag} FROM device_daily_client_usage u LEFT JOIN device_owners o ON ${OWNER_ON_DAY} WHERE ${where(p)}${tool(p)}`
        + monthly(p, 'device_monthly_client_usage', `${dayColumns}, ${toolSplit}`, { also: tool })
      : (p) => `SELECT u.usage_date, ${dayColumns}, u.has_token_components${flag} FROM device_daily_usage u LEFT JOIN device_owners o ON ${OWNER_ON_DAY} WHERE ${where(p)}`
        + monthly(p, 'device_monthly_usage', `${dayColumns}, u.has_token_components`);
    const [daily, models, clients, heads, first, deviceClients, limits] = await Promise.all([
      statement(days),
      // By model there is no tool to filter on: none with client=.
      key.client ? [] : byKey('device_daily_model_usage', 'device_monthly_model_usage', 'model'),
      byKey('device_daily_client_usage', 'device_monthly_client_usage', 'client'),
      key.employee ? [] : store.query(HEADCOUNT_SQL, [], BOUNDED),
      collectingFrom(),
      byDevice,
      accounts ? store.query(LIMITS_SQL, [], BOUNDED) : []
    ]);
    return { daily, models, clients, heads, collectingFrom: first.day, earliest: { daily: first.daily, monthly: first.monthly }, deviceClients, limits };
  }

  // The third phase: the names of the people and the hostnames of the devices
  // the answer lists, those in `active` and the accounts' devices for
  // everyone, and for a caller who may see names the users and the devices
  // too (one person's view already has the person's name).
  async function labelsFor({ people }, ctx, acc) {
    const ids = new Set(acc.active.employees.keys());
    const deviceIds = new Set(acc.active.devices.keys());
    for (const entry of acc.accounts.values()) for (const deviceId of entry.devices) deviceIds.add(deviceId);
    if (people) {
      if (!ctx.person) for (const userKey of acc.users.keys()) if (userKey !== 'other') ids.add(userKey.slice(EMPLOYEE.length));
      for (const [deviceId, entry] of acc.devices) if (ctx.person || entry.used) deviceIds.add(deviceId);
    }
    const [names, hosts] = await Promise.all([
      ids.size ? store.query(NAMES_SQL, [[...ids]], BOUNDED) : [],
      deviceIds.size ? store.query(HOSTS_SQL, [[...deviceIds]], BOUNDED) : []
    ]);
    return { names: new Map(names.map((row) => [row.employee_id, { ...row, name: shownName(row.name, row.email) }])), hosts: new Map(hosts.map((row) => [row.device_id, row])) };
  }

  async function compute(key) {
    const plan = windowsFor(key);
    const ctx = await contextFor(key);
    const rows = await rowsFor(key, plan, ctx);
    const { levels, level } = levelsFor(key.level, ctx, plan, rows.daily);
    const acc = fold(key, ctx, plan, rows.daily, level);
    acc.accounts = accountsOf(ctx, plan, rows.deviceClients, accountHolders(rows.limits));
    acc.tools = !key.employee && !key.client ? foldTools(key, ctx, plan, rows.deviceClients, level) : null;
    const labels = await labelsFor(key, ctx, acc);
    const purgedBefore = store.purgeState?.().floor?.day || null;
    return shape({ key, ctx, plan, rows, levels, level, acc, labels, generatedAt: new Date(now()).toISOString(), purgedBefore });
  }

  // Answers kept for cacheMs, within MAX_CACHED entries and MAX_CACHED_BYTES.
  const cache = new Map();
  let cachedBytes = 0;
  // The computations under way by question, each of the generation it was
  // asked in: invalidate() starts a new one.
  const jobs = new Map();
  let generation = 0;
  const waiting = [];
  let running = 0;

  function forget(id) {
    const entry = cache.get(id);
    if (!entry) return;
    cache.delete(id);
    cachedBytes -= entry.bytes;
  }

  // Expired answers go first, then the oldest, until both limits hold.
  function remember(id, payload) {
    const at = now();
    forget(id);
    for (const [other, entry] of cache) if (at - entry.at >= cacheMs) forget(other);
    const bytes = JSON.stringify(payload).length;
    cache.set(id, { at, payload, bytes });
    cachedBytes += bytes;
    while (cache.size > MAX_CACHED || cachedBytes > MAX_CACHED_BYTES) forget(cache.keys().next().value);
  }

  // Runs `work` once one of the MAX_RUNNING turns is free, in order of arrival.
  function inTurn(work) {
    return new Promise((resolve, reject) => {
      const start = () => {
        running += 1;
        Promise.resolve().then(work).then(resolve, reject).finally(() => {
          running -= 1;
          waiting.shift()?.();
        });
      };
      if (running < MAX_RUNNING) start();
      else waiting.push(start);
    });
  }

  // One computation per question at a time, its answer reused for cacheMs:
  // the page polls, and anyone who can reach the hub may ask. The same
  // question asked meanwhile waits for that answer, unless the org chart or an
  // owner changed since the computation began.
  function cached(key, limited) {
    const id = JSON.stringify(key);
    const hit = cache.get(id);
    if (hit && now() - hit.at < cacheMs) return Promise.resolve(hit.payload);
    const current = jobs.get(id);
    if (current && current.generation === generation) return current.promise;
    // The admin's page always gets its answer; anyone else, another system
    // with an API token too, is asked to come back rather than pile up behind
    // the lock the uploads need.
    if (limited && running >= MAX_RUNNING && waiting.length >= MAX_WAITING) {
      return Promise.reject(new UsageError(503, 'usage_busy', 'the hub is working out other usage answers; try again shortly', RETRY_AFTER_S));
    }
    const job = { generation };
    job.promise = inTurn(() => compute(key))
      .then((payload) => {
        if (job.generation === generation) remember(id, payload);
        return payload;
      })
      .finally(() => {
        if (jobs.get(id) === job) jobs.delete(id);
      });
    jobs.set(id, job);
    return job.promise;
  }

  return {
    // → { status, payload, headers? }; the caller writes it, with or without
    // CORS. limited: may be told usage_busy (everyone but the admin).
    async read(url, { people = false, limited = !people } = {}) {
      if (!store) {
        return { status: 503, payload: { error: 'store_unavailable', message: 'usage needs a database: set TOKEN_MONITOR_DATABASE_URL' } };
      }
      try {
        const asked = request(url);
        // Before any query, and the same whether or not the employee exists:
        // the answer must not tell who is on the HR list.
        if (asked.employee && !people) return { status: 403, payload: { error: 'names_admin_only', message: 'employee= needs the admin key' } };
        if (asked.scopeId && org && !org.has(asked.scopeId)) throw new UsageError(404, 'unknown_org', `unit ${asked.scopeId} does not exist`);
        return { status: 200, payload: await cached({ ...asked, people: Boolean(people) }, limited) };
      } catch (error) {
        // PostgreSQL cancelled a statement at STATEMENT_TIMEOUT_MS. Nothing was
        // cached; asking again computes again.
        if (error?.code === '57014') {
          return { status: 503, payload: { error: 'usage_slow', message: `a statement took longer than ${STATEMENT_TIMEOUT_MS / 1000} s; ask for a shorter range or a smaller unit` } };
        }
        if (!(error instanceof UsageError)) throw error;
        const answer = { status: error.status, payload: { error: error.code, message: error.message } };
        return error.retryAfter ? { ...answer, headers: { 'retry-after': String(error.retryAfter) } } : answer;
      }
    },
    // The org chart or an owner changed: later answers must not reuse old
    // ones, nor wait for one still being worked out from the old state.
    invalidate() {
      generation += 1;
      cache.clear();
      cachedBytes = 0;
    }
  };
}

module.exports = { MAX_RANGE_DAYS, MAX_RUNNING, MAX_WAITING, STATEMENT_TIMEOUT_MS, createUsage, shownName };
