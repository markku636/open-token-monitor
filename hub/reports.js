'use strict';

// Reporting API for other systems (software-cost reports, BI), read with the
// report key (or the admin key):
//
//   GET /api/reports/v1/usage/monthly?month=YYYY-MM&groupBy=…
//   GET /api/reports/v1/usage/daily?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=…
//   GET /api/reports/v1/usage/weekly?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=…
//   GET /api/reports/v1/devices
//   GET /api/reports/v1/accounts
//
// groupBy is company | bu | department | team (the org tree's levels, each
// day's usage rolled up from the unit its owner had that day), unit (that unit
// itself), employee, device, client or model. Usage in no unit of the level
// asked for, or with no owner, is one row with key null: "other". Optional
// filters: deviceId, employeeId, unitId (a unit and everything under it). Add
// format=csv (or Accept: text/csv) for CSV. Money is USD at API list prices
// ("api-list-price-equivalent"): tokscale's estimate of what the tokens would
// cost, not an invoice.
//
// A month is summed from daily rows so that a device which changed hands in
// the middle of it is charged to each owner for their own days. Months older
// than the hub's own daily history fall back to the monthly rows, charged to
// whoever owned the device on the 1st.

const { upstream } = require('../upstream');
const { sendJson } = require(upstream('src/shared/http'));
const { fromDbTime } = require('./persistence/util');
const { LEVELS, unitTree } = require('./units');
const { addDays, daysBetween, validDay, weekStart } = require('./periods');

const GROUPS = Object.freeze({
  ...Object.fromEntries(LEVELS.map((level) => [level, { column: 'o.unit_id', table: '', level }])),
  unit: { column: 'o.unit_id', table: '' },
  employee: { column: 'o.employee_id', table: '' },
  device: { column: 'u.device_id', table: '' },
  client: { column: 'u.client', table: 'client' },
  model: { column: 'u.model', table: 'model' }
});
// The label of the one row usage outside any unit of the level (or without
// an owner) is folded into.
const OTHER_LABEL = '其他';
const TABLES = Object.freeze({
  daily: { '': 'device_daily_usage', client: 'device_daily_client_usage', model: 'device_daily_model_usage' },
  monthly: { '': 'device_monthly_usage', client: 'device_monthly_client_usage', model: 'device_monthly_model_usage' }
});
const FILTERS = Object.freeze({ deviceId: 'u.device_id', employeeId: 'o.employee_id' });
const MAX_DAILY_RANGE_DAYS = 400;
const MONTH_RE = /^\d{4}-\d{2}$/;
const COST_BASIS = 'api-list-price-equivalent';

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function nextMonthStart(month) {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 1)).toISOString().slice(0, 10);
}

function money(value) {
  return Number(Number(value || 0).toFixed(6));
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(columns, rows) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

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
  // A BOM so Excel opens the UTF-8 department and employee names correctly.
  res.end(`\uFEFF${csv}`);
}

function groupOf(url) {
  const groupBy = url.searchParams.get('groupBy') || 'department';
  if (!GROUPS[groupBy]) throw new RequestError(400, 'bad_group', `groupBy must be one of ${Object.keys(GROUPS).join(', ')}`);
  return groupBy;
}

// The filters a request asks for, as [column, value] pairs; a unit is itself
// and every unit under it.
function filtersOf(url, tree) {
  const filters = Object.entries(FILTERS)
    .map(([name, column]) => [column, url.searchParams.get(name)])
    .filter(([, value]) => value);
  const unitId = url.searchParams.get('unitId');
  if (unitId) {
    if (!tree.units.has(unitId)) throw new RequestError(404, 'unknown_unit', `unit ${unitId} does not exist`);
    filters.push(['o.unit_id', [...tree.subtree(unitId)]]);
  }
  return filters;
}

function unitGroup(groupBy) {
  return GROUPS[groupBy].column === 'o.unit_id';
}

// Collects the values of one statement and hands back their placeholders, so
// SQL assembled from pieces keeps $1…$n in step with its parameter list.
function parameters() {
  const values = [];
  return { values, add: (value) => `$${values.push(value)}` };
}

const OWNER_ON_DAY = 'o.device_id = u.device_id AND u.usage_date >= o.valid_from AND (o.valid_to IS NULL OR u.usage_date < o.valid_to)';
// The owner of a fixed day, given as a placeholder such as $1.
const ownerOnFixedDay = (day) => `o.device_id = u.device_id AND ${day}::date >= o.valid_from AND (o.valid_to IS NULL OR ${day}::date < o.valid_to)`;

function createReports({ store = null } = {}) {
  async function loadTree() {
    return unitTree(await store.query('SELECT unit_id, name, parent_unit_id, level, is_active FROM org_units'));
  }

  async function labels(groupBy, keys, tree) {
    const wanted = keys.filter((key) => key !== null && key !== undefined);
    const map = new Map();
    if (!wanted.length) return map;
    if (groupBy === 'employee') {
      for (const row of await store.query('SELECT employee_id, name, email FROM employees WHERE employee_id = ANY($1)', [wanted])) {
        map.set(row.employee_id, { label: row.name, email: row.email || null });
      }
    } else if (unitGroup(groupBy)) {
      for (const row of await store.query('SELECT unit_id, name, level, cost_center FROM org_units WHERE unit_id = ANY($1)', [wanted])) {
        map.set(row.unit_id, { label: row.name, level: row.level, path: tree.pathOf(row.unit_id).join('/'), costCenter: row.cost_center || null });
      }
    } else if (groupBy === 'device') {
      for (const row of await store.query('SELECT device_id, hostname FROM devices WHERE device_id = ANY($1)', [wanted])) {
        map.set(row.device_id, { label: row.hostname || row.device_id });
      }
    }
    return map;
  }

  // Rows by (period, key). `keyOf` rolls a key up (a unit to its unit of a
  // level), `bucketOf` a day up (to its week). Either way the SQL rows are one
  // device's each, so every device counts once in the row it is folded into.
  // A device counts where it has usage, not merely a row of zeros.
  function addInto(target, rows, { keyOf, bucketOf, perDevice }) {
    for (const row of rows) {
      const groupKey = keyOf ? keyOf(row.group_key) : row.group_key ?? null;
      const period = row.usage_date == null ? null : bucketOf ? bucketOf(String(row.usage_date)) : row.usage_date;
      const key = `${period ?? ''}\u0000${groupKey ?? ''}`;
      const current = target.get(key) || { usage_date: period, group_key: groupKey, tokens: 0, cost_usd: 0, devices: 0, deviceIds: new Set() };
      current.tokens += Number(row.tokens || 0);
      current.cost_usd += Number(row.cost_usd || 0);
      if (!perDevice) current.devices += Number(row.devices || 0);
      else if (Number(row.tokens) > 0 || Number(row.cost_usd) > 0) current.deviceIds.add(row.device_id);
      target.set(key, current);
    }
  }

  async function aggregate({ grain, groupBy, from, toExclusive, month, filters, byDay, bucketOf = null, dateField = 'date', tree }) {
    const group = GROUPS[groupBy];
    const keyOf = group.level ? (unit) => (unit && tree.units.has(unit) ? tree.ancestorAt(unit, group.level) : null) : null;
    const perDevice = Boolean(keyOf || bucketOf);
    const fold = { keyOf, bucketOf, perDevice };
    const extra = perDevice ? ', u.device_id' : '';
    const select = `${byDay ? 'u.usage_date AS usage_date, ' : ''}${group.column} AS group_key${perDevice ? ', u.device_id AS device_id' : ''}, SUM(u.tokens) AS tokens, SUM(u.cost_usd) AS cost_usd, COUNT(DISTINCT u.device_id) FILTER (WHERE u.tokens > 0 OR u.cost_usd > 0) AS devices`;
    const groupClause = `GROUP BY ${byDay ? 'u.usage_date, ' : ''}${group.column}${extra}`;
    const where = (p) => filters.map(([column, value]) => (Array.isArray(value) ? ` AND ${column} = ANY(${p.add(value)})` : ` AND ${column} = ${p.add(value)}`)).join('');
    const merged = new Map();

    const d = parameters();
    const daily = await store.query(
      `SELECT ${select} FROM ${TABLES.daily[group.table]} u LEFT JOIN device_owners o ON ${OWNER_ON_DAY} WHERE u.usage_date >= ${d.add(from)} AND u.usage_date < ${d.add(toExclusive)}${where(d)} ${groupClause}`,
      d.values
    );
    addInto(merged, daily, fold);

    if (grain === 'monthly') {
      const m = parameters();
      const first = m.add(from);
      const monthly = await store.query(
        `SELECT ${select} FROM ${TABLES.monthly[group.table]} u LEFT JOIN device_owners o ON ${ownerOnFixedDay(first)} WHERE u.usage_month = ${m.add(month)} AND NOT EXISTS (SELECT 1 FROM device_daily_usage x WHERE x.device_id = u.device_id AND x.usage_date >= ${first}::date AND x.usage_date < ${m.add(toExclusive)})${where(m)} ${groupClause}`,
        m.values
      );
      addInto(merged, monthly, fold);
    }

    const rows = [...merged.values()];
    const names = await labels(groupBy, [...new Set(rows.map((row) => row.group_key))], tree);
    return rows
      .map((row) => {
        const info = names.get(row.group_key) || {};
        const other = row.group_key === null;
        return {
          ...(byDay ? { [dateField]: row.usage_date } : {}),
          key: row.group_key,
          label: other ? OTHER_LABEL : (info.label ?? row.group_key),
          ...(groupBy === 'employee' ? { email: info.email ?? null } : {}),
          ...(unitGroup(groupBy) ? { path: info.path ?? null, costCenter: info.costCenter ?? null } : {}),
          other,
          tokens: row.tokens,
          costUsd: money(row.cost_usd),
          devices: perDevice ? row.deviceIds.size : row.devices
        };
      })
      // By period, then by cost; "other" last within its period.
      .sort((a, b) => String(a[dateField] || '').localeCompare(String(b[dateField] || '')) || Number(a.other) - Number(b.other) || b.costUsd - a.costUsd);
  }

  function csvColumns(groupBy, dateField) {
    return [
      ...(dateField ? [dateField] : []), 'key', 'label', 'other', 'tokens', 'costUsd', 'devices',
      ...(groupBy === 'employee' ? ['email'] : []),
      ...(unitGroup(groupBy) ? ['path', 'costCenter'] : [])
    ];
  }

  function totals(rows) {
    return {
      tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
      costUsd: money(rows.reduce((sum, row) => sum + row.costUsd, 0))
    };
  }

  async function monthly(req, res, url) {
    const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
    if (!MONTH_RE.test(month) || !validDay(`${month}-01`)) throw new RequestError(400, 'bad_month', 'month must be YYYY-MM');
    const groupBy = groupOf(url);
    const from = `${month}-01`;
    const tree = await loadTree();
    const rows = await aggregate({ grain: 'monthly', groupBy, from, toExclusive: nextMonthStart(month), month, filters: filtersOf(url, tree), tree });
    if (wantsCsv(req, url)) return sendCsv(res, `token-monitor-${month}-${groupBy}.csv`, toCsv(csvColumns(groupBy, null), rows));
    return sendJson(res, 200, { ok: true, month, groupBy, currency: 'USD', costBasis: COST_BASIS, generatedAt: new Date().toISOString(), totals: totals(rows), rows });
  }

  async function daily(req, res, url) {
    const to = validDay(url.searchParams.get('to') || new Date().toISOString().slice(0, 10));
    const from = validDay(url.searchParams.get('from') || (to && addDays(to, -29)));
    if (!from || !to) throw new RequestError(400, 'bad_range', 'from and to must be YYYY-MM-DD');
    if (from > to) throw new RequestError(400, 'bad_range', 'from must not be after to');
    if (daysBetween(from, to) >= MAX_DAILY_RANGE_DAYS) {
      throw new RequestError(400, 'range_too_long', `at most ${MAX_DAILY_RANGE_DAYS} days per request`);
    }
    const groupBy = groupOf(url);
    const tree = await loadTree();
    const rows = await aggregate({ grain: 'daily', groupBy, from, toExclusive: addDays(to, 1), filters: filtersOf(url, tree), byDay: true, tree });
    if (wantsCsv(req, url)) return sendCsv(res, `token-monitor-${from}_${to}-${groupBy}.csv`, toCsv(csvColumns(groupBy, 'date'), rows));
    return sendJson(res, 200, { ok: true, from, to, groupBy, currency: 'USD', costBasis: COST_BASIS, generatedAt: new Date().toISOString(), totals: totals(rows), rows });
  }

  // ISO weeks, Monday to Sunday: the range grows to whole weeks, and each row
  // is one week, named by its Monday. Defaults to the last 12 weeks.
  async function weekly(req, res, url) {
    const today = new Date().toISOString().slice(0, 10);
    const lastDay = validDay(url.searchParams.get('to') || today);
    const firstDay = validDay(url.searchParams.get('from') || (lastDay && addDays(weekStart(lastDay), -77)));
    if (!firstDay || !lastDay) throw new RequestError(400, 'bad_range', 'from and to must be YYYY-MM-DD');
    if (firstDay > lastDay) throw new RequestError(400, 'bad_range', 'from must not be after to');
    const from = weekStart(firstDay);
    const to = addDays(weekStart(lastDay), 6);
    if (daysBetween(from, to) >= MAX_DAILY_RANGE_DAYS) {
      throw new RequestError(400, 'range_too_long', `at most ${MAX_DAILY_RANGE_DAYS} days per request`);
    }
    const groupBy = groupOf(url);
    const tree = await loadTree();
    const rows = await aggregate({ grain: 'daily', groupBy, from, toExclusive: addDays(to, 1), filters: filtersOf(url, tree), byDay: true, bucketOf: weekStart, dateField: 'week', tree });
    if (wantsCsv(req, url)) return sendCsv(res, `token-monitor-${from}_${to}-weekly-${groupBy}.csv`, toCsv(csvColumns(groupBy, 'week'), rows));
    return sendJson(res, 200, { ok: true, from, to, groupBy, currency: 'USD', costBasis: COST_BASIS, generatedAt: new Date().toISOString(), totals: totals(rows), rows });
  }

  const OWNER_TODAY = 'o.device_id = d.device_id AND o.valid_from <= $1::date AND (o.valid_to IS NULL OR $1::date < o.valid_to)';

  async function devices(req, res, url) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = (await store.query(
      `SELECT d.device_id, d.hostname, d.platform, d.os_name, d.os_version, d.agent_version, d.agent_runtime, d.received_at, d.first_seen_at,
              o.employee_id, e.name AS employee_name, e.email AS employee_email, o.unit_id, ou.name AS unit_name, ou.cost_center
       FROM devices d
       LEFT JOIN device_owners o ON ${OWNER_TODAY}
       LEFT JOIN employees e ON e.employee_id = o.employee_id
       LEFT JOIN org_units ou ON ou.unit_id = o.unit_id
       WHERE d.deleted_at IS NULL
       ORDER BY d.hostname, d.device_id`,
      [today]
    )).map((row) => ({
      deviceId: row.device_id,
      hostname: row.hostname,
      platform: row.platform,
      osName: row.os_name,
      osVersion: row.os_version,
      agentVersion: row.agent_version,
      agentRuntime: row.agent_runtime,
      lastSeenAt: fromDbTime(row.received_at),
      firstSeenAt: fromDbTime(row.first_seen_at),
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      employeeEmail: row.employee_email,
      unitId: row.unit_id,
      unitName: row.unit_name,
      costCenter: row.cost_center
    }));
    if (wantsCsv(req, url)) return sendCsv(res, 'token-monitor-devices.csv', toCsv(Object.keys(rows[0] || { deviceId: '' }), rows));
    return sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), devices: rows });
  }

  async function accounts(req, res, url) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = (await store.query(
      `SELECT l.provider, l.account_email, l.account_name, l.account_label, l.plan_label, l.status, l.provider_updated_at,
              l.device_id, d.hostname, o.employee_id, e.name AS employee_name, o.unit_id, ou.name AS unit_name
       FROM device_limits l
       JOIN devices d ON d.device_id = l.device_id AND d.deleted_at IS NULL
       LEFT JOIN device_owners o ON ${OWNER_TODAY}
       LEFT JOIN employees e ON e.employee_id = o.employee_id
       LEFT JOIN org_units ou ON ou.unit_id = o.unit_id
       ORDER BY l.provider, l.account_email, l.device_id`,
      [today]
    )).map((row) => ({
      provider: row.provider,
      accountEmail: row.account_email,
      accountName: row.account_name,
      accountLabel: row.account_label,
      planLabel: row.plan_label,
      status: row.status,
      updatedAt: fromDbTime(row.provider_updated_at),
      deviceId: row.device_id,
      hostname: row.hostname,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      unitId: row.unit_id,
      unitName: row.unit_name
    }));
    if (wantsCsv(req, url)) return sendCsv(res, 'token-monitor-accounts.csv', toCsv(Object.keys(rows[0] || { provider: '' }), rows));
    return sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), accounts: rows });
  }

  const ROUTES = Object.freeze({
    '/api/reports/v1/usage/monthly': monthly,
    '/api/reports/v1/usage/daily': daily,
    '/api/reports/v1/usage/weekly': weekly,
    '/api/reports/v1/devices': devices,
    '/api/reports/v1/accounts': accounts
  });

  return {
    async handle(req, res, url) {
      const route = ROUTES[url.pathname];
      if (!route || req.method !== 'GET') return sendJson(res, 404, { error: 'not_found' });
      if (!store) {
        return sendJson(res, 503, { error: 'store_unavailable', message: 'reports need a database: set TOKEN_MONITOR_DATABASE_URL' });
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

module.exports = { COST_BASIS, OWNER_ON_DAY, createReports, ownerOnFixedDay, parameters, toCsv };
