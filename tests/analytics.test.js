'use strict';

// The reports API's analytics routes (analytics.js) and the scope that opens
// them: the org tree, the employees, the quota windows and the usage analysis,
// each answer checked against the OpenAPI document it is published with.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createStore } = require('../hub/persistence/store');
const { captureRows } = require('../hub/persistence/capture');
const { openApiDocument } = require('../hub/openapi');
const { analysisV1 } = require('../hub/analytics');
const { bearer, removeAll, startOverlayHub } = require('./helpers/overlayHub');
const { devicePayload, historyDay, merged, provider } = require('./helpers/fixtures');
const { BACKENDS } = require('./helpers/pg');

const ADMIN = bearer('admin-secret');
const DOC = openApiDocument();

async function call(base, pathname, { method = 'GET', headers = ADMIN, body } = {}) {
  const response = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', ...headers }, body });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

async function token(base, name, scopes) {
  const made = await call(base, '/api/admin/api-tokens', { method: 'POST', body: JSON.stringify(scopes ? { name, scopes } : { name }) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return { scopes: made.body.scopes, headers: bearer(made.body.token) };
}

// Just enough JSON Schema for the document's own schemas: every field an
// answer has is documented, every required one is there, and each has its type.
function conforms(value, schema, where = '$') {
  if (schema.$ref) return conforms(value, DOC.components.schemas[schema.$ref.split('/').pop()], where);
  const types = [].concat(schema.type || []);
  if (value === null) {
    assert.ok(types.includes('null'), `${where}: null is not allowed`);
    return;
  }
  if (types.length) {
    const kind = Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    const ok = types.includes(kind) || (kind === 'integer' && types.includes('number'));
    assert.ok(ok, `${where}: ${JSON.stringify(value)} is not ${types.join(' or ')}`);
  }
  if (schema.enum) assert.ok(schema.enum.includes(value), `${where}: ${value} is not one of ${schema.enum.join(', ')}`);
  if (Array.isArray(value)) {
    value.forEach((item, i) => conforms(item, schema.items, `${where}[${i}]`));
    return;
  }
  if (typeof value === 'object' && schema.properties) {
    for (const key of schema.required || []) assert.ok(key in value, `${where}.${key} is missing`);
    for (const [key, field] of Object.entries(value)) {
      assert.ok(schema.properties[key], `${where}.${key} is not in the OpenAPI document`);
      conforms(field, schema.properties[key], `${where}.${key}`);
    }
  }
}

const answerSchema = (pathname) => DOC.paths[pathname].get.responses[200].content['application/json'].schema;

// laptop-1 is Alice's (East, under 業務部) until the 15th, then Bob's (研發部);
// laptop-2 nobody's. Both report a Claude account with a 5-hour window.
async function seed(openDriver) {
  const store = createStore(await openDriver());
  await store.migrate();
  const one = merged(devicePayload({
    deviceId: 'laptop-1', hostname: 'LAPTOP-1', day: '2026-09-21', tokens: 0, cost: 0,
    history: { daily: ['2026-09-10', '2026-09-14', '2026-09-15', '2026-09-20'].map((d) => historyDay(d, { tokens: 100, cost: 1 })), monthly: [], summary: {} }
  }), undefined, '2026-09-21T01:00:00.000Z');
  const two = merged(devicePayload({
    deviceId: 'laptop-2', hostname: 'LAPTOP-2', day: '2026-09-21', tokens: 0, cost: 0,
    history: { daily: [historyDay('2026-09-16', { tokens: 50, cost: 0.5, client: 'codex', model: 'gpt-5' })], monthly: [], summary: {} }
  }), undefined, '2026-09-21T01:00:00.000Z');
  two.limits.providers = [
    provider({ provider: 'codex', email: 'shared@example.test', plan: 'Plus' }),
    { ...provider({ provider: 'gemini', email: 'nobody@example.test' }), status: 'notConfigured', windows: [] }
  ];
  await store.writeCapture(captureRows(undefined, one));
  await store.writeCapture(captureRows(undefined, two));
  await store.close();
}

async function organise(base) {
  const put = (pathname, body) => call(base, pathname, { method: 'PUT', body: JSON.stringify(body) });
  for (const [id, body] of [
    ['CO', { name: 'CO' }],
    ['B1', { name: 'Business One', parentUnitId: 'CO' }],
    ['SALES', { name: '業務部', parentUnitId: 'B1', costCenter: 'CC-100' }],
    ['RND', { name: '研發部', parentUnitId: 'CO', level: 'department', costCenter: 'CC-200' }],
    ['EAST', { name: 'East', parentUnitId: 'SALES' }],
    ['OLD', { name: 'Old', parentUnitId: 'CO', level: 'department', active: false }]
  ]) assert.equal((await put(`/api/admin/units/${id}`, body)).status, 200);
  assert.equal((await put('/api/admin/employees/E1', { name: 'Alice', email: 'alice@example.test' })).status, 200);
  assert.equal((await put('/api/admin/employees/E2', { name: '陳大文 Bob', email: 'bob@example.test' })).status, 200);
  for (const [deviceId, employeeId, unitId, validFrom] of [['laptop-1', 'E1', 'EAST', '2026-09-01'], ['laptop-1', 'E2', 'RND', '2026-09-15']]) {
    assert.equal((await call(base, '/api/admin/owners', { method: 'POST', body: JSON.stringify({ deviceId, employeeId, unitId, validFrom }) })).status, 200);
  }
}

for (const backend of BACKENDS) test(`${backend.name}: analytics:read opens the org tree, employees, quota windows and the usage analysis`, { skip: backend.skip }, async () => {
  const { openDriver, persistenceConfig, cleanup } = await backend.setup();
  await seed(openDriver);
  const hub = await startOverlayHub({ persistenceConfig });
  try {
    await organise(hub.base);
    const ledger = await token(hub.base, 'Ledger');
    const bi = await token(hub.base, 'BI', ['analytics:read']);
    const both = await token(hub.base, 'Both', ['reports:read', 'analytics:read']);
    assert.deepEqual([ledger.scopes, bi.scopes, both.scopes], [['reports:read'], ['analytics:read'], ['reports:read', 'analytics:read']], 'a token made without scopes keeps reports:read alone');

    // Each route needs its own scope.
    for (const pathname of ['/api/reports/v1/units', '/api/reports/v1/employees', '/api/reports/v1/limits', '/api/reports/v1/usage/analysis']) {
      assert.equal((await call(hub.base, pathname, { headers: ledger.headers })).status, 403, `reports:read alone: ${pathname}`);
      assert.equal((await call(hub.base, pathname, { headers: bi.headers })).status, 200, `analytics:read: ${pathname}`);
      assert.equal((await call(hub.base, pathname, { headers: both.headers })).status, 200, `both: ${pathname}`);
    }
    for (const pathname of ['/api/reports/v1/usage/monthly?month=2026-09', '/api/reports/v1/devices', '/api/reports/v1/accounts', '/api/reports/v1/usage/whatever']) {
      assert.equal((await call(hub.base, pathname, { headers: bi.headers })).status, 403, `analytics:read alone: ${pathname}`);
      assert.notEqual((await call(hub.base, pathname, { headers: ledger.headers })).status, 403, `reports:read: ${pathname}`);
    }
    for (const pathname of ['/api/custom/usage', '/api/stats', '/api/admin/employees']) {
      assert.equal((await call(hub.base, pathname, { headers: both.headers })).status, 403, `no token reads ${pathname}`);
    }

    const units = await call(hub.base, '/api/reports/v1/units', { headers: bi.headers });
    conforms(units.body, answerSchema('/api/reports/v1/units'));
    const byId = Object.fromEntries(units.body.units.map((u) => [u.unitId, u]));
    assert.deepEqual(Object.keys(byId).sort(), ['B1', 'CO', 'EAST', 'OLD', 'RND', 'SALES']);
    assert.deepEqual([byId.SALES.level, byId.SALES.parentUnitId, byId.SALES.path, byId.SALES.costCenter], ['department', 'B1', 'CO/Business One/業務部', 'CC-100']);
    assert.deepEqual([byId.RND.devices, byId.CO.devices, byId.CO.parentUnitId], [1, 1, null], 'laptop-1 is Bob\'s, in 研發部, today');
    assert.equal(byId.OLD.active, false);
    assert.deepEqual((await call(hub.base, '/api/reports/v1/units?active=false', { headers: bi.headers })).body.units.map((u) => u.unitId), ['OLD']);
    assert.equal((await call(hub.base, '/api/reports/v1/units?active=maybe', { headers: bi.headers })).body.error, 'bad_active');
    const unitsCsv = Buffer.from(await (await fetch(`${hub.base}/api/reports/v1/units?format=csv`, { headers: bi.headers })).arrayBuffer()).subarray(3).toString('utf8');
    assert.ok(unitsCsv.startsWith('unitId,name,level,parentUnitId,path,costCenter,active,headcount,ownHeadcount,devices,tokensLast30Days,costUsdLast30Days\r\n'), unitsCsv.split('\r\n')[0]);

    const employees = await call(hub.base, '/api/reports/v1/employees', { headers: bi.headers });
    conforms(employees.body, answerSchema('/api/reports/v1/employees'));
    assert.deepEqual(employees.body.employees.map((e) => [e.employeeId, e.name, e.email, e.devices]), [['E1', 'Alice', 'alice@example.test', 0], ['E2', 'Bob', 'bob@example.test', 1]], 'English names only');
    assert.equal((await call(hub.base, '/api/reports/v1/employees?unitId=NOPE', { headers: bi.headers })).body.error, 'unknown_unit');
    assert.deepEqual((await call(hub.base, '/api/reports/v1/employees?unitId=RND', { headers: bi.headers })).body.employees, [], 'an admin-made employee has no HR placement');

    const limits = await call(hub.base, '/api/reports/v1/limits', { headers: bi.headers });
    conforms(limits.body, answerSchema('/api/reports/v1/limits'));
    assert.deepEqual(limits.body.accounts.map((a) => [a.provider, a.accountEmail, a.deviceId, a.employeeName, a.unitId]), [
      ['claude', 'someone@example.test', 'laptop-1', 'Bob', 'RND'],
      ['codex', 'shared@example.test', 'laptop-2', null, null]
    ], 'notConfigured providers are left out');
    assert.deepEqual(limits.body.accounts[0].windows, [{ kind: 'session', label: null, metric: null, usedPercent: 40, remainingPercent: 60, used: null, limit: null, remaining: null, currency: null, resetsAt: '2026-09-20T05:00:00.000Z', windowMinutes: null }]);
    assert.deepEqual((await call(hub.base, '/api/reports/v1/limits?provider=codex', { headers: bi.headers })).body.accounts.map((a) => a.deviceId), ['laptop-2']);
    assert.deepEqual((await call(hub.base, '/api/reports/v1/limits?unitId=CO', { headers: bi.headers })).body.accounts.map((a) => a.deviceId), ['laptop-1']);
    const limitsCsv = Buffer.from(await (await fetch(`${hub.base}/api/reports/v1/limits?format=csv`, { headers: bi.headers })).arrayBuffer()).subarray(3).toString('utf8').split('\r\n');
    assert.ok(limitsCsv[0].endsWith(',windowKind,windowLabel,usedPercent,remainingPercent,used,limit,remaining,resetsAt,windowMinutes'), limitsCsv[0]);
    assert.equal(limitsCsv.filter(Boolean).length, 3, 'one line per window');

    // The week of the 14th against the one before, by department under CO.
    const analysis = await call(hub.base, '/api/reports/v1/usage/analysis?from=2026-09-14&to=2026-09-20&granularity=week&focus=range&unitId=CO&level=department', { headers: bi.headers });
    assert.equal(analysis.status, 200, JSON.stringify(analysis.body));
    conforms(analysis.body, answerSchema('/api/reports/v1/usage/analysis'));
    const a = analysis.body;
    assert.deepEqual(a.periods, [{ period: '2026-09-14', from: '2026-09-14', to: '2026-09-20', days: 7 }]);
    assert.deepEqual([a.focus.period, a.comparison.mode, a.comparison.from, a.comparison.to], ['range', 'previous', '2026-09-07', '2026-09-13']);
    assert.deepEqual(a.scope, { unitId: 'CO', name: 'CO', level: 'company', path: 'CO' });
    assert.deepEqual([a.focusTotals.tokens, a.comparisonTotals.tokens], [300, 100], 'laptop-2 is in no unit of CO');
    assert.deepEqual(a.trend, [{ period: '2026-09-14', tokens: 300, costUsd: 3, devices: 1, employees: 2 }]);
    assert.deepEqual(a.units.map((u) => [u.unitId, u.path, u.focus.tokens, u.comparison.tokens]), [['RND', 'CO/研發部', 200, 0], ['SALES', 'CO/Business One/業務部', 100, 100]]);
    assert.deepEqual(a.units[0].clients, [{ client: 'claude', focus: { tokens: 200, costUsd: 2 }, comparison: { tokens: 0, costUsd: 0 } }]);
    assert.deepEqual(a.models.map((m) => [m.model, m.focus.tokens, m.comparison.tokens, m.trend]), [['claude-sonnet-4-5', 300, 100, [{ period: '2026-09-14', tokens: 300, costUsd: 3 }]]]);
    assert.equal(a.composition.cacheRead, 180);
    assert.deepEqual(a.employees.map((e) => [e.employeeId, e.name, e.focus.tokens]), [['E2', 'Bob', 200], ['E1', 'Alice', 100]]);
    assert.deepEqual(a.active.devices.map((d) => [d.deviceId, d.hostname, d.employee.name, d.unit.unitId]), [['laptop-1', 'LAPTOP-1', 'Bob', 'RND']]);
    assert.deepEqual(a.accounts.map((x) => [x.account, x.holders, x.other, x.tools.map((t) => t.client)]), [['someone@example.test', ['someone@example.test'], false, ['claude']]]);
    assert.deepEqual(a.unownedDevices, [], 'every day in CO was someone\'s');
    assert.equal('devices' in a, false, 'devices is one person\'s view only');

    // Every company: laptop-2's codex day is nobody's.
    const all = (await call(hub.base, '/api/reports/v1/usage/analysis?from=2026-09-14&to=2026-09-20&focus=range&granularity=week&level=company', { headers: bi.headers })).body;
    conforms(all, answerSchema('/api/reports/v1/usage/analysis'));
    assert.deepEqual([all.scope, all.focusTotals.tokens, all.focusTotals.unownedDevices, all.other.focus.tokens], [null, 350, 1, 50]);
    assert.deepEqual(all.unownedDevices.map((d) => [d.deviceId, d.focus.tokens]), [['laptop-2', 50]]);
    assert.deepEqual(all.clients.map((c) => [c.client, c.focus.tokens]), [['claude', 300], ['codex', 50]]);
    assert.deepEqual(all.accounts.map((x) => [x.account, x.other]), [['someone@example.test', false], ['shared@example.test', false]]);

    // One person, wherever their days went; a year back; one tool.
    const bob = (await call(hub.base, '/api/reports/v1/usage/analysis?from=2026-09-01&to=2026-09-30&granularity=month&employeeId=E2&compare=year&client=claude', { headers: bi.headers })).body;
    conforms(bob, answerSchema('/api/reports/v1/usage/analysis'));
    assert.deepEqual([bob.employee.employeeId, bob.employee.name, bob.client, bob.comparison.mode, bob.comparison.from], ['E2', 'Bob', 'claude', 'year', '2025-09-01']);
    assert.deepEqual([bob.focusTotals.tokens, bob.units, bob.accounts, bob.active, bob.models], [200, [], [], null, []]);
    assert.deepEqual(bob.devices.map((d) => [d.deviceId, d.focus.tokens, d.trend]), [['laptop-1', 200, [{ period: '2026-09', tokens: 200, costUsd: 2 }]]]);
    assert.equal('unownedDevices' in bob, false);

    // Errors keep the reports' names.
    for (const [query, status, error] of [
      ['unitId=NOPE', 404, 'unknown_unit'],
      ['employeeId=E9', 404, 'unknown_employee'],
      ['from=2026-09-20&to=2026-09-01', 400, 'bad_range'],
      ['from=2025-01-01&to=2026-09-01', 400, 'range_too_long'],
      ['granularity=year', 400, 'bad_granularity'],
      ['compare=custom', 400, 'bad_compare'],
      ['unitId=RND&level=company', 400, 'bad_level']
    ]) {
      const answer = await call(hub.base, `/api/reports/v1/usage/analysis?${query}`, { headers: bi.headers });
      assert.deepEqual([answer.status, answer.body.error], [status, error], query);
      conforms(answer.body, DOC.components.schemas.Error, query);
    }
    // The dashboard's own names mean nothing here.
    const dashboardNames = (await call(hub.base, '/api/reports/v1/usage/analysis?org=NOPE&employee=E9&cfrom=x', { headers: bi.headers }));
    assert.equal(dashboardNames.status, 200);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
    await cleanup();
  }
});

test('the analytics routes need a database', async () => {
  const hub = await startOverlayHub();
  try {
    for (const pathname of ['/api/reports/v1/units', '/api/reports/v1/usage/analysis']) {
      const answer = await call(hub.base, pathname);
      assert.deepEqual([answer.status, answer.body.error], [503, 'store_unavailable'], pathname);
    }
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

// The analysis is usage.js's answer field by field: a field the dashboard
// adds later does not appear in v1 until it is added here, and documented.
test('the v1 analysis passes on only the fields it names', () => {
  const answer = analysisV1({
    currency: 'USD', costBasis: 'api-list-price-equivalent', generatedAt: '2026-10-05T00:00:00.000Z',
    from: '2026-10-01', to: '2026-10-02', granularity: 'day', buckets: [{ key: '2026-10-01', from: '2026-10-01', to: '2026-10-01', days: 1 }, { key: '2026-10-02', from: '2026-10-02', to: '2026-10-02', days: 1 }],
    focus: { key: '2026-10-02', from: '2026-10-02', to: '2026-10-02', days: 1 },
    previous: { from: '2026-09-25', to: '2026-09-25', days: 1, partial: false, mode: 'previous', tokens: 1, costUsd: 0, devices: 1, employees: 0, secret: 'x' },
    totals: { tokens: 3, costUsd: 0, devices: 1, employees: 0, activeDays: 2, brandNew: 1 },
    focusTotals: { tokens: 2, costUsd: 0, devices: 1, employees: 0, activeDays: 1, unownedDevices: 1 },
    trend: { tokens: [1, 2], costUsd: [0, 0], devices: [1, 1], employees: [0, 0] },
    units: [], users: [], devices: [], accounts: [], models: [], clients: [], idle: { models: [], clients: [] },
    other: { tokens: [1, 2], costUsd: [0, 0], devices: [1, 1], employees: [0, 0], focus: { tokens: 2, costUsd: 0, devices: 1, employees: 0 }, previous: { tokens: 1, costUsd: 0, devices: 1, employees: 0 } },
    active: { employees: [], devices: [] },
    composition: { total: 0, covered: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unclassified: 0 },
    tools: [{ client: 'claude' }],
    people: true,
    newDashboardField: { anything: true }
  });
  conforms(answer, DOC.components.schemas.Analysis);
  assert.equal('newDashboardField' in answer, false);
  assert.equal('tools' in answer, false);
  assert.deepEqual(answer.trend, [{ period: '2026-10-01', tokens: 1, costUsd: 0, devices: 1, employees: 0 }, { period: '2026-10-02', tokens: 2, costUsd: 0, devices: 1, employees: 0 }]);
});
