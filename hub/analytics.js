'use strict';

// The reports API's analytics routes, for an API token with analytics:read
// (access.js scopeFor) or the admin key:
//
//   GET /api/reports/v1/units                the org tree: every unit with its
//                                            place, cost centre, headcount,
//                                            devices and last 30 days
//   GET /api/reports/v1/employees            the HR lists' employees, where each
//                                            sits, their devices, last 30 days
//   GET /api/reports/v1/limits               each AI account the devices last
//                                            reported, with its quota windows
//   GET /api/reports/v1/usage/analysis       the dashboard's analysis of a unit
//                                            or one person (usage.js): trend,
//                                            comparison window, units, models,
//                                            tools, token kinds, people
//
// These are a contract other systems build on (docs/reports-api.zh-TW.md and
// /llms-full.txt, apiDocs.js), so every answer is assembled here field by
// field: the dashboard's own routes (/api/custom/*) may change shape whenever
// the page does, and none of that may leak into v1. A field is only ever
// added. Employees' names never carry their Chinese part (shownName),
// the way the analysis has always shown them.

const { upstream } = require('../upstream');
const { sendJson } = require(upstream('src/shared/http'));
const { fromDbTime } = require('./persistence/util');
const { toCsv } = require('./reports');
const { shownName } = require('./usage');
const { unitTree } = require('./units');

const ROUTES_PREFIX = '/api/reports/v1';
const ANALYTICS_PATHS = new Set(['units', 'employees', 'limits', 'usage/analysis'].map((name) => `${ROUTES_PREFIX}/${name}`));
// The analysis's parameters by their v1 names → the names usage.js reads.
const ANALYSIS_PARAMS = Object.freeze({
  from: 'from',
  to: 'to',
  granularity: 'granularity',
  focus: 'focus',
  compare: 'compare',
  compareFrom: 'cfrom',
  compareTo: 'cto',
  unitId: 'org',
  level: 'level',
  employeeId: 'employee',
  client: 'client'
});
// The reports' own name for a unit that does not exist.
const ERROR_CODES = Object.freeze({ unknown_org: 'unknown_unit' });
// Accounts a device has nothing of: the usage views leave them out too.
const NO_ACCOUNT = new Set(['notConfigured', 'disabled']);
// upstream's normalizeWindowKind: the only kinds a window can be.
const WINDOW_KINDS = new Set(['session', 'daily', 'weekly', 'billing']);
const WINDOW_COLUMNS = ['windowKind', 'windowLabel', 'usedPercent', 'remainingPercent', 'used', 'limit', 'remaining', 'resetsAt', 'windowMinutes'];

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const text = (value) => (typeof value === 'string' && value !== '' ? value : null);
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const money = (value) => Number(Number(value || 0).toFixed(6));
const pathText = (path) => (Array.isArray(path) ? path.join('/') : null);

function wantsCsv(req, url) {
  const format = url.searchParams.get('format');
  if (format) return format.toLowerCase() === 'csv';
  return String(req.headers.accept || '').toLowerCase().includes('text/csv');
}

function sendCsv(res, filename, csv) {
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(`\uFEFF${csv}`);
}

function activeFilter(url) {
  const value = url.searchParams.get('active');
  if (value === null || value === '') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new RequestError(400, 'bad_active', 'active must be true or false');
}

// One quota window as v1 lists it: the fields upstream's normalizeLimitWindow
// gives a window, each only when it has the type it should.
function windowOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = text(raw.kind);
  if (!WINDOW_KINDS.has(kind)) return null;
  return {
    kind,
    label: text(raw.label),
    metric: text(raw.metric),
    usedPercent: number(raw.usedPercent),
    remainingPercent: number(raw.remainingPercent),
    used: number(raw.used),
    limit: number(raw.limit),
    remaining: number(raw.remaining),
    currency: text(raw.currency),
    resetsAt: text(raw.resetsAt),
    windowMinutes: number(raw.windowMinutes)
  };
}

// ---- usage/analysis: usage.js's answer, field by field

// A unit as the analysis refers to one (usage.js unitRef).
function unitRef(unit) {
  return unit ? { unitId: unit.id, name: unit.name, path: pathText(unit.path) } : null;
}

function pick(source, keys) {
  if (!source) return null;
  const out = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

const UNIT_FIGURES = ['tokens', 'costUsd', 'devices', 'employees'];
const PERSON_FIGURES = ['tokens', 'costUsd', 'devices', 'activeDays'];
const DEVICE_FIGURES = ['tokens', 'costUsd', 'activeDays'];

// Per-bucket arrays (usage.js trendOf and keysOf) as one row per period.
function trendRows(periods, trend) {
  if (!trend || !Array.isArray(trend.tokens)) return [];
  return periods.map((period, i) => {
    const row = { period: period.period, tokens: trend.tokens[i] ?? 0, costUsd: trend.costUsd?.[i] ?? 0 };
    if (Array.isArray(trend.devices)) row.devices = trend.devices[i] ?? 0;
    if (Array.isArray(trend.employees)) row.employees = trend.employees[i] ?? 0;
    return row;
  });
}

function toolsOf(list) {
  if (!Array.isArray(list)) return undefined;
  return list.map((tool) => ({ client: tool.client, focus: pick(tool.focus, ['tokens', 'costUsd']), comparison: pick(tool.previous, ['tokens', 'costUsd']) }));
}

// Models or tools: those used in the focus, then those used only elsewhere in
// the range or in the comparison window, with nothing in the focus.
function keyedUsage(list, idle, name, periods) {
  const entry = (item, focus) => ({
    [name]: item[name],
    focus,
    comparison: pick(item.previous, ['tokens', 'costUsd']),
    trend: trendRows(periods, item.trend)
  });
  return [
    ...(list || []).map((item) => entry(item, { tokens: item.tokens, costUsd: item.costUsd })),
    ...(idle || []).map((item) => entry(item, { tokens: 0, costUsd: 0 }))
  ];
}

function analysisV1(p) {
  const periods = (p.buckets || []).map((bucket) => ({ period: bucket.key, from: bucket.from, to: bucket.to, days: bucket.days }));
  const person = Boolean(p.employee);
  const clientsOf = (entry) => {
    const clients = toolsOf(entry.clients);
    return clients ? { clients } : {};
  };
  const device = (entry) => ({
    deviceId: entry.id,
    hostname: entry.hostname,
    deleted: entry.deleted === true,
    focus: pick(entry.focus, DEVICE_FIGURES),
    comparison: pick(entry.previous, DEVICE_FIGURES),
    ...(entry.trend ? { trend: trendRows(periods, entry.trend) } : {})
  });
  const answer = {
    ok: true,
    currency: p.currency,
    costBasis: p.costBasis,
    generatedAt: p.generatedAt,
    from: p.from,
    to: p.to,
    granularity: p.granularity,
    periods,
    focus: p.focus ? { period: p.focus.key, from: p.focus.from, to: p.focus.to, days: p.focus.days } : null,
    comparison: p.previous ? pick(p.previous, ['mode', 'from', 'to', 'days', 'partial']) : null,
    scope: p.scope ? { unitId: p.scope.id, name: p.scope.name, level: p.scope.level, path: pathText(p.scope.path) } : null,
    employee: person ? { employeeId: p.employee.id, name: p.employee.name, email: p.employee.email, active: p.employee.active, unit: unitRef(p.employee.unit) } : null,
    client: p.client ?? null,
    level: p.level ?? null,
    levels: p.levels || [],
    headcount: p.headcount ?? 0,
    dataFrom: { daily: p.earliest?.daily ?? null, monthly: p.earliest?.monthly ?? null },
    collectingFrom: p.collectingFrom ?? null,
    purgedBefore: p.purgedBefore ?? null,
    monthlyFallback: p.monthlyFallback || [],
    totals: pick(p.totals, [...UNIT_FIGURES, 'activeDays']),
    focusTotals: pick(p.focusTotals, [...UNIT_FIGURES, 'activeDays', 'unownedDevices']),
    comparisonTotals: pick(p.previous, UNIT_FIGURES),
    trend: trendRows(periods, p.trend),
    units: (p.units || []).map((unit) => ({
      unitId: unit.id,
      name: unit.name,
      path: pathText(unit.path),
      active: unit.active,
      headcount: unit.headcount,
      focus: pick(unit.focus, UNIT_FIGURES),
      comparison: pick(unit.previous, UNIT_FIGURES),
      trend: trendRows(periods, unit.trend),
      ...clientsOf(unit)
    })),
    other: p.other ? { focus: pick(p.other.focus, UNIT_FIGURES), comparison: pick(p.other.previous, UNIT_FIGURES), trend: trendRows(periods, p.other), ...clientsOf(p.other) } : null,
    models: keyedUsage(p.models, p.idle?.models, 'model', periods),
    clients: keyedUsage(p.clients, p.idle?.clients, 'client', periods),
    composition: pick(p.composition, ['total', 'covered', 'input', 'output', 'cacheRead', 'cacheWrite', 'unclassified']),
    employees: (p.users || []).map((user) => ({
      employeeId: user.id,
      name: user.name,
      email: user.email,
      other: user.other === true,
      unit: unitRef(user.unit),
      focus: pick(user.focus, PERSON_FIGURES),
      comparison: pick(user.previous, PERSON_FIGURES),
      trend: trendRows(periods, user.trend),
      ...clientsOf(user)
    })),
    ...(person ? { devices: (p.devices || []).map(device) } : { unownedDevices: (p.devices || []).map(device) }),
    accounts: (p.accounts || []).map((account) => ({
      account: account.other ? null : account.id,
      holders: account.who || [],
      shared: account.shared === true,
      other: account.other === true,
      providers: account.providers || [],
      unit: unitRef(account.unit),
      devices: (account.devices || []).map((d) => ({ deviceId: d.id, hostname: d.hostname })),
      tools: (account.tools || []).map((tool) => ({ client: tool.client, tokens: tool.tokens, costUsd: tool.costUsd })),
      focus: pick(account.focus, PERSON_FIGURES),
      comparison: pick(account.previous, PERSON_FIGURES)
    })),
    active: p.active ? {
      employees: p.active.employees.map((entry) => ({ employeeId: entry.id ?? null, name: entry.name, unit: unitRef(entry.unit), focus: pick(entry.focus, PERSON_FIGURES) })),
      devices: p.active.devices.map((entry) => ({
        deviceId: entry.id,
        hostname: entry.hostname,
        deleted: entry.deleted === true,
        employee: entry.employee ? { employeeId: entry.employee.id ?? null, name: entry.employee.name } : null,
        unit: unitRef(entry.unit),
        focus: pick(entry.focus, DEVICE_FIGURES)
      }))
    } : null
  };
  return answer;
}

function createAnalytics({ store = null, org = null, usage = null } = {}) {
  async function loadTree() {
    return unitTree(await store.query('SELECT unit_id, name, parent_unit_id, level, is_active FROM org_units'));
  }

  async function units(req, res, url) {
    const active = activeFilter(url);
    const costCentres = new Map((await store.query('SELECT unit_id, cost_center FROM org_units')).map((row) => [row.unit_id, row.cost_center || null]));
    const rows = (await org.unitStats())
      .filter((unit) => active === null || unit.active === active)
      .map((unit) => ({
        unitId: unit.id,
        name: unit.name,
        level: unit.level,
        parentUnitId: unit.parentId || null,
        path: pathText(unit.path),
        costCenter: costCentres.get(unit.id) ?? null,
        active: unit.active === true,
        headcount: unit.headcount,
        ownHeadcount: unit.ownHeadcount,
        devices: unit.devices,
        tokensLast30Days: unit.recentTokens,
        costUsdLast30Days: unit.recentCostUsd
      }));
    if (wantsCsv(req, url)) return sendCsv(res, 'token-monitor-units.csv', toCsv(Object.keys(rows[0] || { unitId: '' }), rows));
    return sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), units: rows });
  }

  async function employees(req, res, url) {
    const active = activeFilter(url);
    const unitId = url.searchParams.get('unitId');
    let scope = null;
    if (unitId) {
      const tree = await loadTree();
      if (!tree.units.has(unitId)) throw new RequestError(404, 'unknown_unit', `unit ${unitId} does not exist`);
      scope = tree.subtree(unitId);
    }
    const rows = (await org.employeeList())
      .filter((e) => (active === null || e.active === active) && (!scope || scope.has(e.unitId)))
      .map((e) => ({
        employeeId: e.employeeId,
        name: shownName(e.name, e.email),
        email: e.email || null,
        active: e.active,
        companyId: e.companyId,
        unitId: e.unitId,
        path: pathText(e.unitPath),
        effectiveFrom: e.effectiveFrom,
        devices: e.devices,
        tokensLast30Days: e.recentTokens,
        costUsdLast30Days: e.recentCostUsd,
        updatedAt: fromDbTime(e.updatedAt)
      }));
    if (wantsCsv(req, url)) return sendCsv(res, 'token-monitor-employees.csv', toCsv(Object.keys(rows[0] || { employeeId: '' }), rows));
    return sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), employees: rows });
  }

  const OWNER_TODAY = 'o.device_id = d.device_id AND o.valid_from <= $1::date AND (o.valid_to IS NULL OR $1::date < o.valid_to)';

  async function limits(req, res, url) {
    const today = new Date().toISOString().slice(0, 10);
    const q = url.searchParams;
    let scope = null;
    if (q.get('unitId')) {
      const tree = await loadTree();
      if (!tree.units.has(q.get('unitId'))) throw new RequestError(404, 'unknown_unit', `unit ${q.get('unitId')} does not exist`);
      scope = tree.subtree(q.get('unitId'));
    }
    const rows = (await store.query(
      `SELECT l.provider, l.account_email, l.account_name, l.account_label, l.plan_label, l.workspace_kind, l.status, l.source,
              l.provider_updated_at, l.source_received_at, l.balance_usd, l.windows,
              l.device_id, d.hostname, o.employee_id, e.name AS employee_name, e.email AS employee_email, o.unit_id, ou.name AS unit_name
       FROM device_limits l
       JOIN devices d ON d.device_id = l.device_id AND d.deleted_at IS NULL
       LEFT JOIN device_owners o ON ${OWNER_TODAY}
       LEFT JOIN employees e ON e.employee_id = o.employee_id
       LEFT JOIN org_units ou ON ou.unit_id = o.unit_id
       ORDER BY l.provider, l.account_email, l.device_id`,
      [today]
    ))
      .filter((row) => !NO_ACCOUNT.has(row.status))
      .filter((row) => (!q.get('provider') || row.provider === q.get('provider'))
        && (!q.get('deviceId') || row.device_id === q.get('deviceId'))
        && (!q.get('employeeId') || row.employee_id === q.get('employeeId'))
        && (!scope || scope.has(row.unit_id)))
      .map((row) => ({
        provider: row.provider,
        accountEmail: row.account_email,
        accountName: row.account_name,
        accountLabel: row.account_label,
        planLabel: row.plan_label,
        workspaceKind: row.workspace_kind,
        status: row.status,
        source: row.source,
        balanceUsd: row.balance_usd === null || row.balance_usd === undefined ? null : money(row.balance_usd),
        windows: (Array.isArray(row.windows) ? row.windows : []).map(windowOf).filter(Boolean),
        updatedAt: fromDbTime(row.provider_updated_at),
        receivedAt: fromDbTime(row.source_received_at),
        deviceId: row.device_id,
        hostname: row.hostname,
        employeeId: row.employee_id,
        employeeName: row.employee_id ? shownName(row.employee_name, row.employee_email) : null,
        unitId: row.unit_id,
        unitName: row.unit_name
      }));
    if (wantsCsv(req, url)) {
      // One line per window; an account without any is one line with them empty.
      const base = rows.length ? Object.keys(rows[0]).filter((key) => key !== 'windows') : ['provider'];
      const lines = rows.flatMap(({ windows, ...account }) => (windows.length ? windows : [null]).map((w) => ({
        ...account,
        windowKind: w?.kind ?? null,
        windowLabel: w?.label ?? null,
        usedPercent: w?.usedPercent ?? null,
        remainingPercent: w?.remainingPercent ?? null,
        used: w?.used ?? null,
        limit: w?.limit ?? null,
        remaining: w?.remaining ?? null,
        resetsAt: w?.resetsAt ?? null,
        windowMinutes: w?.windowMinutes ?? null
      })));
      return sendCsv(res, 'token-monitor-limits.csv', toCsv([...base, ...WINDOW_COLUMNS], lines));
    }
    return sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), accounts: rows });
  }

  async function analysis(req, res, url) {
    const asked = new URL('http://localhost/api/custom/usage');
    for (const [name, inner] of Object.entries(ANALYSIS_PARAMS)) {
      if (url.searchParams.has(name)) asked.searchParams.set(inner, url.searchParams.get(name));
    }
    // Names and all, like the admin's page, but asked to come back when the
    // hub is busy, like everyone else.
    const { status, payload, headers } = await usage.read(asked, { people: true, limited: true });
    if (status !== 200) {
      const code = ERROR_CODES[payload.error] || payload.error;
      return sendJson(res, status, { error: code, message: payload.message }, headers || {});
    }
    return sendJson(res, 200, analysisV1(payload));
  }

  const ROUTES = Object.freeze({
    [`${ROUTES_PREFIX}/units`]: units,
    [`${ROUTES_PREFIX}/employees`]: employees,
    [`${ROUTES_PREFIX}/limits`]: limits,
    [`${ROUTES_PREFIX}/usage/analysis`]: analysis
  });

  return {
    handles: (pathname) => ANALYTICS_PATHS.has(pathname),
    async handle(req, res, url) {
      const route = ROUTES[url.pathname];
      if (!route || req.method !== 'GET') return sendJson(res, 404, { error: 'not_found' });
      if (!store || !org || !usage) {
        return sendJson(res, 503, { error: 'store_unavailable', message: 'the analytics routes need a database: set TOKEN_MONITOR_DATABASE_URL' });
      }
      try {
        return await route(req, res, url);
      } catch (error) {
        if (error instanceof RequestError) return sendJson(res, error.status, { error: error.code, message: error.message });
        throw error;
      }
    }
  };
}

module.exports = { ANALYSIS_PARAMS, ANALYTICS_PATHS, analysisV1, createAnalytics };
