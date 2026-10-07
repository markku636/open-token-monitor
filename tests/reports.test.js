'use strict';

// Organisation data (admin API) and the reports an external cost system pulls.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createStore } = require('../hub/persistence/store');
const { captureRows } = require('../hub/persistence/capture');
const { apiToken, bearer, removeAll, startOverlayHub } = require('./helpers/overlayHub');
const { devicePayload, historyDay, historyMonth, merged } = require('./helpers/fixtures');
const { BACKENDS } = require('./helpers/pg');


const ADMIN = bearer('admin-secret');

async function call(base, pathname, { method = 'GET', headers = ADMIN, body, type = 'application/json' } = {}) {
  const response = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': type, ...headers }, body });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

// Two devices with September history: laptop-1 moves from Alice (Sales) to Bob
// (R&D) on the 15th; laptop-2 has only a monthly row for August (older than the
// hub's daily history).
async function seed(openDriver) {
  const store = createStore(await openDriver());
  await store.migrate();
  const days = ['2026-09-10', '2026-09-14', '2026-09-15', '2026-09-20'];
  const one = merged(devicePayload({
    deviceId: 'laptop-1', hostname: 'LAPTOP-1', day: '2026-09-21', tokens: 0, cost: 0,
    history: { daily: days.map((d) => historyDay(d, { tokens: 100, cost: 1 })), monthly: [], summary: {} }
  }), undefined, '2026-09-21T01:00:00.000Z');
  const two = merged(devicePayload({
    deviceId: 'laptop-2', hostname: 'LAPTOP-2', day: '2026-09-21', tokens: 0, cost: 0,
    history: { daily: [], monthly: [historyMonth('2026-08', { tokens: 5000, cost: 7, client: 'codex' })], summary: {} }
  }), undefined, '2026-09-21T01:00:00.000Z');
  await store.writeCapture(captureRows(undefined, one));
  await store.writeCapture(captureRows(undefined, two));
  await store.close();
}

for (const backend of BACKENDS) test(`${backend.name}: organisation data is managed through the admin API and feeds the monthly report`, { skip: backend.skip }, async () => {
  const { openDriver, persistenceConfig, cleanup } = await backend.setup();
  await seed(openDriver);
  const hub = await startOverlayHub({ persistenceConfig });
  try {
    // The cost system reads with an API token of its own.
    const REPORT = await apiToken(hub.base, 'Ledger');
    const put = (pathname, body) => call(hub.base, pathname, { method: 'PUT', body: JSON.stringify(body) });
    const assign = (body) => call(hub.base, '/api/admin/owners', { method: 'POST', body: JSON.stringify(body) });
    // CO → BU "Business One" → 業務部 → East team; 研發部 sits in no BU.
    assert.deepEqual((await put('/api/admin/units/CO', { name: 'CO' })).body, { ok: true, unitId: 'CO' });
    assert.equal((await put('/api/admin/units/B1', { name: 'Business One', parentUnitId: 'CO' })).status, 200);
    assert.equal((await put('/api/admin/units/SALES', { name: '業務部', parentUnitId: 'B1', costCenter: 'CC-100' })).status, 200);
    assert.equal((await put('/api/admin/units/RND', { name: '研發部, 一處', parentUnitId: 'CO', level: 'department', costCenter: 'CC-200' })).status, 200);
    assert.equal((await put('/api/admin/units/EAST', { name: 'East', parentUnitId: 'SALES' })).status, 200);
    assert.deepEqual((await call(hub.base, '/api/admin/units')).body.units.map((u) => [u.unitId, u.level, u.parentUnitId]), [
      ['B1', 'bu', 'CO'], ['CO', 'company', null], ['EAST', 'team', 'SALES'], ['RND', 'department', 'CO'], ['SALES', 'department', 'B1']
    ], 'a unit is one level below its parent unless it names a deeper one');
    assert.equal((await put('/api/admin/units/X', { name: 'X', parentUnitId: 'EAST' })).status, 400, 'nothing under a team');
    assert.equal((await put('/api/admin/units/Y', { name: 'Y', parentUnitId: 'SALES', level: 'bu' })).status, 400, 'not above its parent');
    assert.equal((await put('/api/admin/units/Z', { name: 'Z', level: 'team' })).status, 400, 'a unit without a parent is a company');
    assert.equal((await put('/api/admin/employees/E1', { name: 'Alice', email: 'alice@example.test' })).status, 200);
    assert.equal((await put('/api/admin/employees/E2', { name: 'Bob', email: 'BOB@example.test' })).status, 200);
    assert.deepEqual((await call(hub.base, '/api/admin/employees')).body.employees.map((e) => e.email), ['alice@example.test', 'bob@example.test']);
    for (const [deviceId, employeeId, unitId, validFrom] of [['laptop-1', 'E1', 'EAST', '2026-09-01'], ['laptop-1', 'E2', 'RND', '2026-09-15'], ['laptop-2', 'E1', 'EAST', '2026-08-01']]) {
      assert.equal((await assign({ deviceId, employeeId, unitId, validFrom })).status, 200);
    }
    const unknown = await assign({ deviceId: 'laptop-9', employeeId: 'E9', unitId: 'RND', validFrom: '2026-09-01' });
    assert.deepEqual([unknown.status, unknown.body.error], [400, 'unknown_employee']);

    const ranges = (await call(hub.base, '/api/admin/owners?deviceId=laptop-1')).body.owners;
    assert.deepEqual(ranges.map((r) => [r.validFrom, r.validTo, r.employeeId]), [['2026-09-01', '2026-09-15', 'E1'], ['2026-09-15', null, 'E2']]);
    const overlap = await call(hub.base, '/api/admin/owners', { method: 'POST', body: JSON.stringify({ deviceId: 'laptop-1', employeeId: 'E1', unitId: 'EAST', validFrom: '2026-09-10' }) });
    assert.equal(overlap.status, 409);
    assert.equal(overlap.body.error, 'overlap');

    const september = await call(hub.base, '/api/reports/v1/usage/monthly?month=2026-09&groupBy=department', { headers: REPORT });
    assert.equal(september.status, 200);
    assert.equal(september.body.costBasis, 'api-list-price-equivalent');
    const byDept = Object.fromEntries(september.body.rows.map((r) => [r.key, r]));
    // Alice held laptop-1 for the 10th and 14th (in East, under 業務部), Bob
    // from the 15th (研發部).
    assert.deepEqual([byDept.SALES.tokens, byDept.SALES.costUsd, byDept.SALES.costCenter, byDept.SALES.path], [200, 2, 'CC-100', 'CO/Business One/業務部']);
    assert.deepEqual([byDept.RND.tokens, byDept.RND.label, byDept.RND.other], [200, '研發部, 一處', false]);
    assert.equal(september.body.totals.costUsd, 4);

    // Every level: what is in no unit of it is one "other" row, last.
    const rowsBy = async (groupBy, extra = '') => (await call(hub.base, `/api/reports/v1/usage/monthly?month=2026-09&groupBy=${groupBy}${extra}`, { headers: REPORT })).body.rows
      .map((r) => [r.key, r.label, r.tokens, r.devices, r.other]);
    assert.deepEqual(await rowsBy('company'), [['CO', 'CO', 400, 1, false]]);
    assert.deepEqual(await rowsBy('bu'), [['B1', 'Business One', 200, 1, false], [null, '其他', 200, 1, true]], '研發部 is in no BU');
    assert.deepEqual(await rowsBy('team'), [['EAST', 'East', 200, 1, false], [null, '其他', 200, 1, true]]);
    assert.deepEqual(await rowsBy('unit'), [['EAST', 'East', 200, 1, false], ['RND', '研發部, 一處', 200, 1, false]]);
    // A unit filter is the unit and everything under it.
    assert.deepEqual(await rowsBy('employee', '&unitId=B1'), [['E1', 'Alice', 200, 1, false]]);
    assert.equal((await call(hub.base, '/api/reports/v1/usage/monthly?month=2026-09&unitId=NOPE', { headers: REPORT })).body.error, 'unknown_unit');

    const august = await call(hub.base, '/api/reports/v1/usage/monthly?month=2026-08&groupBy=employee', { headers: REPORT });
    assert.deepEqual(august.body.rows.map((r) => [r.key, r.label, r.email, r.tokens]), [['E1', 'Alice', 'alice@example.test', 5000]], 'a month without daily rows falls back to the monthly row');
    const byClient = await call(hub.base, '/api/reports/v1/usage/monthly?month=2026-08&groupBy=client', { headers: REPORT });
    assert.deepEqual(byClient.body.rows.map((r) => [r.key, r.tokens]), [['codex', 5000]]);

    const daily = await call(hub.base, '/api/reports/v1/usage/daily?from=2026-09-14&to=2026-09-15&groupBy=employee', { headers: REPORT });
    assert.deepEqual(daily.body.rows.map((r) => [r.date, r.key]), [['2026-09-14', 'E1'], ['2026-09-15', 'E2']]);

    // ISO weeks: the range grows to whole weeks, named by their Mondays. The
    // 10th is in the week of the 7th; the 14th, 15th and 20th in the next.
    const weekly = await call(hub.base, '/api/reports/v1/usage/weekly?from=2026-09-10&to=2026-09-20&groupBy=employee', { headers: REPORT });
    assert.equal(weekly.status, 200, JSON.stringify(weekly.body));
    assert.deepEqual([weekly.body.from, weekly.body.to], ['2026-09-07', '2026-09-20']);
    assert.deepEqual(weekly.body.rows.map((r) => [r.week, r.key, r.tokens, r.devices]), [['2026-09-07', 'E1', 100, 1], ['2026-09-14', 'E2', 200, 1], ['2026-09-14', 'E1', 100, 1]]);
    const weeklyBu = await call(hub.base, '/api/reports/v1/usage/weekly?from=2026-09-14&to=2026-09-14&groupBy=bu', { headers: REPORT });
    assert.deepEqual(weeklyBu.body.rows.map((r) => [r.week, r.key, r.tokens, r.devices]), [['2026-09-14', 'B1', 100, 1], ['2026-09-14', null, 200, 1]], 'one laptop, counted once per row it was in');
    const weeklyCsv = Buffer.from(await (await fetch(`${hub.base}/api/reports/v1/usage/weekly?from=2026-09-14&to=2026-09-14&groupBy=bu&format=csv`, { headers: REPORT })).arrayBuffer()).subarray(3).toString('utf8');
    assert.ok(weeklyCsv.startsWith('week,key,label,other,tokens,costUsd,devices,path,costCenter\r\n'));
    assert.equal((await call(hub.base, '/api/reports/v1/usage/weekly?from=2025-01-01&to=2026-09-01', { headers: REPORT })).body.error, 'range_too_long');

    // Read the raw bytes: Response.text() strips a leading BOM.
    const asCsv = await fetch(`${hub.base}/api/reports/v1/usage/monthly?month=2026-09&groupBy=department&format=csv`, { headers: REPORT });
    assert.match(asCsv.headers.get('content-type'), /^text\/csv/);
    const bytes = Buffer.from(await asCsv.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'a BOM so Excel reads the file as UTF-8');
    const csvText = bytes.subarray(3).toString('utf8');
    assert.ok(csvText.startsWith('key,label,other,tokens,costUsd,devices,path,costCenter\r\n'));
    assert.ok(csvText.includes('"研發部, 一處"'));

    const devices = (await call(hub.base, '/api/reports/v1/devices', { headers: REPORT })).body.devices;
    assert.deepEqual(devices.map((d) => [d.deviceId, d.hostname, d.unitId]), [['laptop-1', 'LAPTOP-1', 'RND'], ['laptop-2', 'LAPTOP-2', 'EAST']]);
    const accounts = (await call(hub.base, '/api/reports/v1/accounts', { headers: REPORT })).body.accounts;
    assert.equal(accounts.length, 2);
    assert.equal(accounts[0].planLabel, 'Max');

    assert.equal((await call(hub.base, '/api/reports/v1/usage/monthly?month=2026-13', { headers: REPORT })).status, 400);
    assert.equal((await call(hub.base, '/api/reports/v1/usage/daily?from=2025-01-01&to=2026-09-01', { headers: REPORT })).body.error, 'range_too_long');
    assert.equal((await call(hub.base, '/api/reports/v1/usage/monthly?groupBy=nope', { headers: REPORT })).status, 400);
    assert.equal((await call(hub.base, '/api/admin/employees', { headers: REPORT })).status, 403, 'an API token cannot change organisation data');

    // Removing the latest range reopens the previous owner.
    assert.equal((await call(hub.base, '/api/admin/owners/laptop-1/2026-09-15', { method: 'DELETE' })).status, 200);
    const reopened = (await call(hub.base, '/api/admin/owners?deviceId=laptop-1')).body.owners;
    assert.deepEqual(reopened.map((r) => [r.validFrom, r.validTo]), [['2026-09-01', null]]);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
    await cleanup();
  }
});
