'use strict';

// hub/usage.js: the dashboard's figures for one unit over a range cut into
// days, weeks or months — the trend, the units of one level compared, what is
// in none of them ("other"), each person for an admin — and hub/periods.js,
// which does the cutting.

const assert = require('node:assert/strict');
const test = require('node:test');

const { apiToken, bearer, post, removeAll, startOverlayHub } = require('./helpers/overlayHub');
const { dayKey, devicePayload, historyDay, historyMonth, merged, provider } = require('./helpers/fixtures');
const { announcement } = require('./helpers/xlsx');
const { BACKENDS } = require('./helpers/pg');
const { bucketsFor, weekStart } = require('../hub/periods');
const { MAX_RUNNING, MAX_WAITING, STATEMENT_TIMEOUT_MS, createUsage, shownName } = require('../hub/usage');
const { createStore } = require('../hub/persistence/store');
const { captureRows } = require('../hub/persistence/capture');

const ADMIN = bearer('admin-secret');
const CLIENT = bearer('client-secret');

// Games is a BU; GM Office and Genome are departments in no BU.
const ACME = [
  { no: 'ACME-1', en: 'Ann Lee', zh: '李安', bu: 'Games', department: 'Aurora', team: 'Ember Team', email: 'ann@example.test' },
  { no: 'ACME-2', en: 'Bo', bu: 'Games', department: 'Aurora', team: '3D Team', email: 'bo@example.test' },
  { no: 'ACME-3', en: 'Cy', bu: 'Games', department: 'Aurora', team: '-', email: 'cy@example.test' },
  { no: 'ACME-4', en: 'Di', department: 'GM Office', team: '-', email: 'di@example.test' },
  { no: 'ACME-5', en: 'Ed', department: 'GM Office', team: '-', email: 'ed@example.test' }
];
const GLOBEX = [{ no: 'GLOBEX-1', en: 'Fay', department: 'Genome', email: 'fay@globex.test' }];

const D3 = dayKey(-3);
const D2 = dayKey(-2);
const D1 = dayKey(-1);
const D0 = dayKey(0);

async function call(base, pathname, { method = 'GET', headers = ADMIN, body, type = 'application/json' } = {}) {
  const response = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': type, ...headers }, body });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

function upload(base, { deviceId, tokens, cost, ownerEmail, aiEmail, history }) {
  return post(base, '/api/ingest', devicePayload({
    deviceId,
    hostname: deviceId.toUpperCase(),
    tokens,
    cost,
    limits: false,
    history,
    extra: {
      ...(ownerEmail ? { ownerEmail } : {}),
      limits: { updatedAt: '2026-09-20T02:00:00.000Z', refreshMs: 300000, providers: aiEmail ? [provider({ email: aiEmail })] : [] }
    }
  }), CLIENT);
}

const usage = (base, query, headers = ADMIN) => call(base, `/api/custom/usage?from=${D3}&to=${D0}${query ? `&${query}` : ''}`, { headers });
// Per-bucket tokens by unit name.
const unitTrends = (body) => Object.fromEntries(body.units.map((u) => [u.name, u.trend.tokens]));

test('a range is cut into days, ISO weeks from Monday, or calendar months, the ends clipped to it', () => {
  assert.equal(weekStart('2026-10-04'), '2026-09-28', 'Sunday is the end of its week');
  assert.equal(weekStart('2026-09-28'), '2026-09-28');
  const weeks = bucketsFor('2026-09-24', '2026-10-06', 'week');
  assert.deepEqual(weeks.buckets, [
    { key: '2026-09-21', from: '2026-09-24', to: '2026-09-27', days: 4 },
    { key: '2026-09-28', from: '2026-09-28', to: '2026-10-04', days: 7 },
    { key: '2026-10-05', from: '2026-10-05', to: '2026-10-06', days: 2 }
  ]);
  assert.equal(weeks.indexOf('2026-10-04'), 1);
  assert.equal(weeks.indexOf('2026-09-23'), undefined, 'outside the range');
  const months = bucketsFor('2025-12-15', '2026-02-10', 'month');
  assert.deepEqual(months.buckets.map((b) => [b.key, b.from, b.to, b.days]), [['2025-12', '2025-12-15', '2025-12-31', 17], ['2026-01', '2026-01-01', '2026-01-31', 31], ['2026-02', '2026-02-01', '2026-02-10', 10]]);
  assert.equal(bucketsFor('2026-09-29', '2026-09-30', 'day').buckets.length, 2);
});

for (const backend of BACKENDS) {
  test(`${backend.name}: a scope's units of one level are compared per period, with "other" for what is in none of them`, { skip: backend.skip }, async () => {
    const env = await backend.setup();
    const hub = await startOverlayHub({ persistenceConfig: env.persistenceConfig, publicDashboard: true });
    try {
      // dev-a reports first without history, so it is assigned from today;
      // its history arrives after the import.
      await upload(hub.base, { deviceId: 'dev-a', tokens: 1000, cost: 0.5, ownerEmail: 'ann@example.test' });
      await upload(hub.base, { deviceId: 'dev-b', tokens: 0, cost: 0, ownerEmail: 'bo@example.test', history: { daily: [historyDay(D1, { tokens: 300, cost: 3, client: 'codex', model: 'gpt-5.1-codex' })], monthly: [], summary: {} } });
      await upload(hub.base, { deviceId: 'dev-c', tokens: 50, cost: 0.25, ownerEmail: 'di@example.test' });
      // Nobody on the list, but a domain only ACME uses; and one nobody knows.
      await upload(hub.base, { deviceId: 'dev-e', tokens: 20, cost: 0.1, aiEmail: 'eve@example.test' });
      await upload(hub.base, { deviceId: 'dev-n', tokens: 400, cost: 4, ownerEmail: 'fay@globex.test' });
      await upload(hub.base, { deviceId: 'dev-x', tokens: 7, cost: 0.07, aiEmail: 'x@other.test' });
      await hub.settle();
      assert.equal((await call(hub.base, '/api/admin/org/import?company=ACME', { method: 'POST', body: announcement(ACME), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).status, 200);
      assert.equal((await call(hub.base, '/api/admin/org/import?company=GLOBEX', { method: 'POST', body: announcement(GLOBEX), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).status, 200);
      const store = hub.overlay.persistence.store;
      const firstRange = async (deviceId) => (await store.query('SELECT valid_from FROM device_owners WHERE device_id = $1 ORDER BY valid_from LIMIT 1', [deviceId]))[0].valid_from;
      assert.equal(await firstRange('dev-b'), D1, 'a first owner covers the history the device uploaded');
      assert.equal(await firstRange('dev-a'), D0);
      await upload(hub.base, { deviceId: 'dev-a', tokens: 1000, cost: 0.5, ownerEmail: 'ann@example.test', history: { daily: [D3, D2].map((d) => historyDay(d, { tokens: 100, cost: 1 })), monthly: [], summary: {} } });
      await hub.settle();
      assert.equal((await call(hub.base, '/api/admin/org/reconcile', { method: 'POST' })).body.backdated, 1);
      assert.equal(await firstRange('dev-a'), D3, 'history that arrives later moves the first automatic range back');

      // Every company, keyless: companies compared, no people.
      const all = await usage(hub.base, '', {});
      assert.equal(all.status, 200, JSON.stringify(all.body));
      assert.equal(all.headers.get('access-control-allow-origin'), null, 'keyless: this site only');
      assert.deepEqual([all.body.granularity, all.body.level, all.body.levels], ['day', 'company', ['company', 'department']], 'BUs and teams are not offered');
      assert.deepEqual(all.body.buckets.map((b) => b.key), [D3, D2, D1, D0]);
      assert.deepEqual(all.body.focus, { key: D0, from: D0, to: D0, days: 1 });
      assert.deepEqual([all.body.totals.tokens, all.body.totals.costUsd], [1977, 9.92]);
      assert.deepEqual(all.body.trend.tokens, [100, 100, 300, 1477]);
      assert.deepEqual(unitTrends(all.body), { ACME: [100, 100, 300, 1070], GLOBEX: [0, 0, 0, 400] });
      assert.deepEqual(all.body.other.tokens, [0, 0, 0, 7], 'the device nobody knows');
      assert.equal(all.body.people, false);
      assert.equal(all.body.users, undefined);
      const { active: allActive, accounts: allAccounts, ...allRest } = all.body;
      assert.doesNotMatch(JSON.stringify(allRest), /Ann|李安|example\.test|ACME-\d|DEV-/, 'no names, emails, employee numbers or hostnames');
      // 帳號排行: the AI accounts with their hostnames, as an admin gets them,
      // but no employee and no employee no.
      assert.deepEqual(allAccounts.map((a) => [a.name, a.devices.map((d) => d.hostname), a.focus.tokens]), [['eve@example.test', ['DEV-E'], 20], ['x@other.test', ['DEV-X'], 7], [null, ['DEV-A', 'DEV-C', 'DEV-N'], 1450]]);
      assert.doesNotMatch(JSON.stringify(allAccounts), /Ann|李安|ACME-\d/);
      // 使用人數 and 活躍裝置 one by one: names and hostnames, never an email
      // or an employee no., and a name without its Chinese part.
      assert.doesNotMatch(JSON.stringify(all.body), /李安/);
      assert.deepEqual(allActive.employees.map((e) => [e.name, e.unit && e.unit.path.join('/'), e.focus.tokens]), [
        ['Ann Lee', 'ACME/Aurora', 1000],
        ['Fay', 'GLOBEX/Genome', 400],
        ['Di', 'ACME/GM Office', 50]
      ]);
      assert.deepEqual(allActive.devices.map((d) => [d.hostname, d.employee && d.employee.name, d.unit && d.unit.path.join('/'), d.focus.tokens]), [
        ['DEV-A', 'Ann Lee', 'ACME/Aurora', 1000],
        ['DEV-N', 'Fay', 'GLOBEX/Genome', 400],
        ['DEV-C', 'Di', 'ACME/GM Office', 50],
        ['DEV-E', null, 'ACME', 20],
        ['DEV-X', null, null, 7]
      ]);
      assert.doesNotMatch(JSON.stringify(allActive), /example\.test|ACME-\d|GLOBEX-\d/);

      // One company: its departments by default, the only level offered.
      const byDefault = await usage(hub.base, 'org=ACME', CLIENT);
      assert.deepEqual([byDefault.body.level, byDefault.body.levels], ['department', ['department']]);
      // Its BUs, asked for. GM Office is in no BU, and dev-e is in ACME by
      // domain only: both are other.
      const at = await usage(hub.base, 'org=ACME&level=bu', CLIENT);
      assert.equal(at.status, 200);
      assert.equal(at.headers.get('access-control-allow-origin'), '*');
      assert.deepEqual(at.body.scope, { id: 'ACME', name: 'ACME', level: 'company', path: ['ACME'] });
      assert.deepEqual([at.body.level, at.body.levels], ['bu', ['department']]);
      assert.deepEqual(unitTrends(at.body), { Games: [100, 100, 300, 1000] });
      assert.deepEqual(at.body.other.tokens, [0, 0, 0, 70]);
      assert.deepEqual(at.body.trend.tokens, [100, 100, 300, 1070]);
      assert.deepEqual([at.body.totals.tokens, at.body.totals.employees, at.body.totals.devices, at.body.headcount], [1570, 3, 4, 5]);
      assert.deepEqual([at.body.trend.employees, at.body.trend.devices], [[1, 1, 1, 2], [1, 1, 1, 3]]);
      assert.equal(at.body.people, false, 'the client key is handed to every user');
      assert.deepEqual(at.body.accounts.map((a) => [a.name, a.devices.map((d) => d.hostname), a.focus.tokens]), [['eve@example.test', ['DEV-E'], 20], [null, ['DEV-A', 'DEV-C'], 1050]], 'the client key gets 帳號排行 too, in the scope');
      assert.deepEqual(at.body.models.map((m) => [m.model, m.tokens]), [['claude-sonnet-4-5', 1070]], 'models are the focus day\'s');
      assert.deepEqual(at.body.clients.map((c) => [c.client, c.tokens]), [['claude', 1070]]);

      // The same company by department, and by team.
      const byDept = await usage(hub.base, 'org=ACME&level=department', CLIENT);
      assert.deepEqual(unitTrends(byDept.body), { Aurora: [100, 100, 300, 1000], 'GM Office': [0, 0, 0, 50] });
      assert.deepEqual(byDept.body.other.tokens, [0, 0, 0, 20]);
      const aurora = byDept.body.units.find((u) => u.name === 'Aurora');
      assert.deepEqual([aurora.id, aurora.path, aurora.headcount, aurora.trend.employees], ['ACME/Games/Aurora', ['ACME', 'Aurora'], 3, [1, 1, 1, 1]]);
      const byTeam = await usage(hub.base, 'org=ACME&level=team', CLIENT);
      assert.deepEqual(unitTrends(byTeam.body), { 'Ember Team': [100, 100, 0, 1000], '3D Team': [0, 0, 300, 0] }, 'sorted by the focus day');
      assert.deepEqual(byTeam.body.other.tokens, [0, 0, 0, 70], 'Cy is Aurora\'s own staff, Di is in GM Office, dev-e is ACME\'s by domain');

      // A scope's other on its own: only the usage in no unit of the level,
      // with nothing below it to compare and no roster.
      const atOther = await usage(hub.base, 'org=ACME&other=bu&level=team', CLIENT);
      assert.equal(atOther.status, 200, JSON.stringify(atOther.body));
      assert.deepEqual([atOther.body.scope.id, atOther.body.otherLevel, atOther.body.level, atOther.body.levels, atOther.body.units], ['ACME', 'bu', null, [], []]);
      assert.deepEqual(atOther.body.trend.tokens, [0, 0, 0, 70], 'Di in GM Office and dev-e by domain');
      assert.deepEqual(atOther.body.other.tokens, [0, 0, 0, 70]);
      assert.deepEqual([atOther.body.totals.tokens, atOther.body.totals.employees, atOther.body.totals.devices, atOther.body.headcount], [70, 1, 2, 0]);
      assert.deepEqual(atOther.body.models.map((m) => [m.model, m.tokens]), [['claude-sonnet-4-5', 70]], 'by model and by tool too');
      assert.deepEqual(atOther.body.clients.map((c) => [c.client, c.tokens]), [['claude', 70]]);
      assert.deepEqual(atOther.body.active.devices.map((d) => [d.hostname, d.employee && d.employee.name, d.focus.tokens]), [['DEV-C', 'Di', 50], ['DEV-E', null, 20]]);
      assert.deepEqual(atOther.body.active.employees.map((e) => e.name), ['Di']);
      assert.equal(at.body.otherLevel, null);
      assert.deepEqual((await usage(hub.base, 'org=ACME&other=department', CLIENT)).body.trend.tokens, [0, 0, 0, 20]);
      assert.deepEqual((await usage(hub.base, 'org=ACME&other=team', CLIENT)).body.trend.tokens, byTeam.body.other.tokens);
      const allOther = await usage(hub.base, 'other=company', {});
      assert.deepEqual([allOther.body.scope, allOther.body.trend.tokens, allOther.body.models.map((m) => m.tokens)], [null, [0, 0, 0, 7], [7]], 'the device nobody knows');
      assert.deepEqual(allOther.body.active.devices.map((d) => d.hostname), ['DEV-X']);
      const atOtherAdmin = await usage(hub.base, 'org=ACME&other=bu');
      assert.deepEqual(atOtherAdmin.body.users.map((u) => [u.name, u.other, u.focus.tokens]), [['Di', false, 50], [null, true, 20]]);
      assert.deepEqual(atOtherAdmin.body.devices.map((d) => d.hostname), ['DEV-E'], 'the devices nobody is charged with');
      assert.deepEqual(atOtherAdmin.body.accounts.map((a) => [a.name, a.focus.tokens]), [['eve@example.test', 20], [null, 50]]);

      // The usage no employee is charged with on its own (沒有對應到員工):
      // dev-e and dev-x, with nothing below it to compare and no roster.
      const unowned = await usage(hub.base, 'unowned=1&level=bu', {});
      assert.equal(unowned.status, 200, JSON.stringify(unowned.body));
      assert.deepEqual([unowned.body.scope, unowned.body.unowned, unowned.body.otherLevel, unowned.body.level, unowned.body.levels, unowned.body.units], [null, true, null, null, [], []]);
      assert.deepEqual(unowned.body.trend.tokens, [0, 0, 0, 27]);
      assert.deepEqual([unowned.body.totals.tokens, unowned.body.totals.employees, unowned.body.totals.devices, unowned.body.headcount, unowned.body.focusTotals.unownedDevices], [27, 0, 2, 0, 2]);
      assert.deepEqual(unowned.body.models.map((m) => m.tokens), [27], 'by model and by tool too');
      assert.deepEqual(unowned.body.active.devices.map((d) => [d.hostname, d.employee, d.unit && d.unit.id]), [['DEV-E', null, 'ACME'], ['DEV-X', null, null]]);
      assert.deepEqual(unowned.body.active.employees, []);
      assert.equal(all.body.unowned, false);
      assert.deepEqual((await usage(hub.base, 'org=ACME&unowned=1', CLIENT)).body.trend.tokens, [0, 0, 0, 20], 'in a scope: ACME has dev-e by domain');
      assert.deepEqual((await usage(hub.base, 'org=ACME&other=bu&unowned=1', CLIENT)).body.trend.tokens, [0, 0, 0, 20], 'and in its other');
      // An admin gets each device with its trend, and the accounts on them.
      const unownedAdmin = await usage(hub.base, 'unowned=1');
      assert.deepEqual(unownedAdmin.body.users.map((u) => [u.other, u.focus.tokens]), [[true, 27]]);
      assert.deepEqual(unownedAdmin.body.devices.map((d) => [d.hostname, d.trend.tokens]), [['DEV-E', [0, 0, 0, 20]], ['DEV-X', [0, 0, 0, 7]]]);
      assert.deepEqual(unownedAdmin.body.accounts.map((a) => [a.name, a.focus.tokens]), [['eve@example.test', 20], ['x@other.test', 7]]);
      assert.equal((await usage(hub.base, 'employee=ACME-1&unowned=1')).body.unowned, false, 'one person\'s view ignores it');

      // Inside a BU, its departments; inside a team, nothing below it.
      const games = await usage(hub.base, `org=${encodeURIComponent('ACME/Games')}`, {});
      assert.deepEqual([games.body.level, games.body.levels], ['department', ['department']]);
      assert.deepEqual(games.body.other.tokens, [0, 0, 0, 0]);
      const team = await usage(hub.base, `org=${encodeURIComponent('ACME/Games/Aurora/Ember Team')}`, {});
      assert.deepEqual([team.body.level, team.body.levels, team.body.units], [null, [], []]);
      assert.deepEqual(team.body.trend.tokens, [100, 100, 0, 1000]);

      // An admin sees each person, and the usage nobody is charged with.
      const atAdmin = await usage(hub.base, 'org=ACME');
      assert.equal(atAdmin.body.people, true);
      assert.deepEqual(atAdmin.body.users.map((u) => [u.name, u.other, u.unit && u.unit.path.join('/'), u.trend.tokens]), [
        ['Ann Lee', false, 'ACME/Aurora', [100, 100, 0, 1000]],
        ['Di', false, 'ACME/GM Office', [0, 0, 0, 50]],
        ['Bo', false, 'ACME/Aurora', [0, 0, 300, 0]],
        [null, true, null, [0, 0, 0, 20]]
      ]);
      assert.equal(atAdmin.body.users[0].email, 'ann@example.test');
      assert.doesNotMatch(JSON.stringify(atAdmin.body), /李安/, 'not for the admin either');
      // And each AI account: a tool's tokens go to the account its device
      // holds for the tool's provider, the rest to other.
      assert.deepEqual(atAdmin.body.accounts.map((a) => [a.name, a.other, a.shared, a.providers, a.devices.map((d) => d.hostname), a.tools.map((t) => [t.client, t.tokens]), a.focus.tokens]), [
        ['eve@example.test', false, false, ['claude'], ['DEV-E'], [['claude', 20]], 20],
        [null, true, false, [], ['DEV-A', 'DEV-C'], [['claude', 1050]], 1050]
      ]);
      assert.deepEqual(atAdmin.body.accounts[0].unit, { id: 'ACME', name: 'ACME', path: ['ACME'] });

      // Weeks and months hold the same usage, in fewer buckets.
      for (const granularity of ['week', 'month']) {
        const grained = await usage(hub.base, `org=ACME&granularity=${granularity}`, CLIENT);
        assert.equal(grained.status, 200);
        assert.equal(grained.body.granularity, granularity);
        const keys = [...new Set([D3, D2, D1, D0].map((d) => (granularity === 'week' ? weekStart(d) : d.slice(0, 7))))];
        assert.deepEqual(grained.body.buckets.map((b) => b.key), keys);
        assert.equal(grained.body.trend.tokens.reduce((a, b) => a + b, 0), 1570);
        assert.equal(grained.body.focus.to, D0);
      }

      // Bad requests.
      assert.equal((await call(hub.base, `/api/custom/usage?from=${D0}&to=${D3}`)).body.error, 'bad_range');
      assert.equal((await call(hub.base, '/api/custom/usage?from=2026-02-30&to=2026-03-01')).body.error, 'bad_range');
      assert.equal((await call(hub.base, '/api/custom/usage?from=2025-01-01&to=2026-06-01')).body.error, 'range_too_long');
      assert.equal((await usage(hub.base, 'granularity=hour')).body.error, 'bad_granularity');
      assert.equal((await usage(hub.base, 'level=nope')).body.error, 'bad_level');
      assert.equal((await usage(hub.base, `org=${encodeURIComponent('ACME/Games')}&level=bu`)).body.error, 'bad_level', 'not below the scope');
      assert.equal((await usage(hub.base, 'other=nope')).body.error, 'bad_other');
      assert.equal((await usage(hub.base, 'org=ACME&other=company')).body.error, 'bad_other', 'not below the scope');
      assert.equal((await usage(hub.base, 'unowned=yes')).body.error, 'bad_unowned');
      assert.equal((await usage(hub.base, 'org=NOPE', {})).status, 404);
      assert.equal((await usage(hub.base, '', await apiToken(hub.base))).status, 403, 'an API token reads /api/reports/v1 only');
    } finally {
      await hub.stop();
      await env.cleanup();
      removeAll(hub.dataFile);
    }
  });
}

test('a name is shown without its Chinese part, else as the email before the @', () => {
  assert.deepEqual([
    shownName('陳大文 David Chen', 'david@x.test'),
    shownName('David Chen', 'david@x.test'),
    shownName('陳大文', 'david.chen@x.test'),
    shownName('', 'david@x.test'),
    shownName('陳大文', null),
    shownName(null, null)
  ], ['David Chen', 'David Chen', 'david.chen', 'david', null, null]);
});

test('without a database the dashboard is told why there is no usage', async () => {
  const hub = await startOverlayHub();
  try {
    const answer = await call(hub.base, '/api/custom/usage');
    assert.equal(answer.status, 503);
    assert.equal(answer.body.error, 'store_unavailable');
    // Before anything about the question, one person's view included.
    for (const headers of [ADMIN, CLIENT]) {
      const person = await call(hub.base, '/api/custom/usage?employee=ACME-1&from=nope', { headers });
      assert.deepEqual([person.status, person.body.error], [503, 'store_unavailable']);
    }
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

// Fixed days, seeded straight into the store, so weeks, months and the
// windows they are compared with fall the same way on any day the tests run.
// Every device has a live day and history; cost is tokens / 100.
//
//   dev-a  Ann (Ember Team) from 08-01: 08-20 1000, 09-08 200,
//          09-10 400, 09-14 100, 09-16 200, 09-23 30, live 09-30 60
//   dev-b  Bo (3D Team) from 08-01: 09-09 300 with codex / gpt-5.1-codex
//   dev-z  Bo from 08-01: live 09-16 40 from a client that splits nothing
//   dev-u  nobody's: 09-15 70, all of it unclassified
//   dev-g  Cy, in the retired team Old/Gone from 09-01: 09-15 20; history
//          months back to 2026-06
const RECEIVED = '2026-09-30T12:00:00.000Z';
const WEEK = 'from=2026-08-31&to=2026-09-16&granularity=week';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PRIVATE = /Ann|李安|Fay|@|ACME-\d|GLOBEX-\d|dev-|DEV-/;

async function seedFixed(openDriver) {
  const store = createStore(await openDriver());
  await store.migrate();
  const day = (date, tokens, more = {}) => historyDay(date, { tokens, cost: tokens / 100, ...more });
  const device = (deviceId, { live = '2026-07-01', tokens = 0, daily = [], monthly = [] }) => merged(devicePayload({
    deviceId, hostname: deviceId.toUpperCase(), day: live, tokens, cost: tokens / 100, limits: false, updatedAt: RECEIVED,
    history: { daily, monthly, summary: {} }
  }), undefined, RECEIVED);
  const records = [
    device('dev-a', { live: '2026-09-30', tokens: 60, daily: [day('2026-08-20', 1000), day('2026-09-08', 200), day('2026-09-10', 400), day('2026-09-14', 100), day('2026-09-16', 200), day('2026-09-23', 30)] }),
    device('dev-b', { daily: [day('2026-09-09', 300, { client: 'codex', model: 'gpt-5.1-codex' })] }),
    device('dev-z', { live: '2026-09-16', tokens: 40 }),
    device('dev-u', { daily: [day('2026-09-15', 70)] }),
    device('dev-g', { daily: [day('2026-09-15', 20)], monthly: [historyMonth('2026-06', { tokens: 5000, cost: 50 })] })
  ];
  for (const record of records) await store.writeCapture(captureRows(undefined, record));
  // A live day whose client reports no split: zeros, not NULL, and no flag.
  await store.execute("UPDATE device_daily_usage SET cache_read_tokens = 0, cache_write_tokens = 0, output_tokens = 0, unclassified_tokens = 0, has_token_components = false WHERE device_id = 'dev-z'");
  // A day whose split is unknown and booked as unclassified.
  await store.execute("UPDATE device_daily_usage SET cache_read_tokens = 0, cache_write_tokens = 0, output_tokens = 0, unclassified_tokens = tokens, has_token_components = false WHERE device_id = 'dev-u'");
  await store.close();
}

const figures = (tokens, costUsd, devices, employees) => ({ tokens, costUsd, devices, employees });

for (const backend of BACKENDS) {
  test(`${backend.name}: the focus is set against the same stretch of the period before, per unit, person, model and tool`, { skip: backend.skip }, async () => {
    const { openDriver, persistenceConfig, cleanup } = await backend.setup();
    await seedFixed(openDriver);
    const hub = await startOverlayHub({ persistenceConfig, publicDashboard: true });
    const ask = (query, headers = ADMIN) => call(hub.base, `/api/custom/usage?${query}`, { headers });
    try {
      assert.equal((await call(hub.base, '/api/admin/org/import?company=ACME', { method: 'POST', body: announcement(ACME), type: XLSX })).status, 200);
      const put = (id, body) => call(hub.base, `/api/admin/units/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
      assert.equal((await put('ACME/Games/Old', { name: 'Old', parentUnitId: 'ACME/Games' })).status, 200);
      assert.equal((await put('ACME/Games/Old/Gone', { name: 'Gone', parentUnitId: 'ACME/Games/Old', active: false })).status, 200);
      for (const [deviceId, employeeId, validFrom, unitId] of [['dev-a', 'ACME-1', '2026-08-01'], ['dev-b', 'ACME-2', '2026-08-01'], ['dev-z', 'ACME-2', '2026-08-01'], ['dev-g', 'ACME-3', '2026-09-01', 'ACME/Games/Old/Gone']]) {
        const assigned = await call(hub.base, '/api/admin/owners', { method: 'POST', body: JSON.stringify({ deviceId, employeeId, validFrom, ...(unitId ? { unitId } : {}) }) });
        assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
      }
      assert.equal((await call(hub.base, '/api/admin/org/reconcile', { method: 'POST' })).status, 200);

      // Weeks, the last one three days old: Mon–Wed against last week's
      // Mon–Wed, so 09-10 (a Thursday) is in neither.
      const week = await ask(WEEK);
      assert.equal(week.status, 200, JSON.stringify(week.body));
      const w = week.body;
      assert.deepEqual(w.buckets.map((b) => b.key), ['2026-08-31', '2026-09-07', '2026-09-14']);
      assert.deepEqual(w.focus, { key: '2026-09-14', from: '2026-09-14', to: '2026-09-16', days: 3 });
      assert.deepEqual(w.focus, w.buckets[2]);
      assert.deepEqual(w.previous, { from: '2026-09-07', to: '2026-09-09', days: 3, partial: true, mode: 'previous', ...figures(500, 5, 2, 2) });
      assert.deepEqual(w.trend.tokens, [0, 900, 430]);
      assert.equal(w.totals.tokens, 1330);
      assert.deepEqual(w.focusTotals, { ...figures(430, 4.3, 4, 3), activeDays: 3, unownedDevices: 1 });
      assert.match(w.collectingFrom, /^\d{4}-\d{2}-\d{2}$/);
      // The first day with daily rows, and the first month with a month total.
      assert.match(w.earliest.daily, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(w.earliest.daily <= '2026-08-31', w.earliest.daily);
      assert.ok(w.earliest.monthly === null || /^\d{4}-\d{2}$/.test(w.earliest.monthly));
      assert.deepEqual([w.level, w.levels], ['company', ['company', 'department']]);
      assert.deepEqual(w.units.map((u) => [u.name, u.trend.tokens, u.focus, u.previous]), [['ACME', [0, 900, 360], figures(360, 3.6, 3, 3), figures(500, 5, 2, 2)]]);
      assert.deepEqual([w.other.tokens, w.other.focus, w.other.previous], [[0, 0, 70], figures(70, 0.7, 1, 0), figures(0, 0, 0, 0)]);
      // Each person, "other" last; each with the unit of their latest day.
      assert.deepEqual(w.users.map((u) => [u.name, u.unit && u.unit.path.join('/'), u.trend.tokens, u.focus, u.previous]), [
        ['Ann Lee', 'ACME/Aurora', [0, 600, 300], { tokens: 300, costUsd: 3, devices: 1, activeDays: 2 }, { tokens: 200, costUsd: 2, devices: 1, activeDays: 1 }],
        ['Bo', 'ACME/Aurora', [0, 300, 40], { tokens: 40, costUsd: 0.4, devices: 1, activeDays: 1 }, { tokens: 300, costUsd: 3, devices: 1, activeDays: 1 }],
        ['Cy', 'ACME/Old', [0, 0, 20], { tokens: 20, costUsd: 0.2, devices: 1, activeDays: 1 }, { tokens: 0, costUsd: 0, devices: 0, activeDays: 0 }],
        [null, null, [0, 0, 70], { tokens: 70, costUsd: 0.7, devices: 1, activeDays: 1 }, { tokens: 0, costUsd: 0, devices: 0, activeDays: 0 }]
      ]);
      // The devices whose usage nobody is charged with, for the admin.
      assert.deepEqual(w.devices, [{ id: 'dev-u', hostname: 'DEV-U', deleted: false, focus: { tokens: 70, costUsd: 0.7, activeDays: 1 }, previous: { tokens: 0, costUsd: 0, activeDays: 0 } }]);
      // 使用人數 and 活躍裝置 one by one: the focus's people and devices, as
      // many as focusTotals counts, with employee nos. for the admin.
      assert.deepEqual(w.active.employees.map((e) => [e.id, e.name, e.unit && e.unit.path.join('/'), e.focus]), [
        ['ACME-1', 'Ann Lee', 'ACME/Aurora', { tokens: 300, costUsd: 3, devices: 1, activeDays: 2 }],
        ['ACME-2', 'Bo', 'ACME/Aurora', { tokens: 40, costUsd: 0.4, devices: 1, activeDays: 1 }],
        ['ACME-3', 'Cy', 'ACME/Old', { tokens: 20, costUsd: 0.2, devices: 1, activeDays: 1 }]
      ]);
      assert.deepEqual(w.active.devices, [
        { id: 'dev-a', hostname: 'DEV-A', deleted: false, employee: { id: 'ACME-1', name: 'Ann Lee' }, unit: { id: 'ACME/Games/Aurora', name: 'Aurora', path: ['ACME', 'Aurora'] }, focus: { tokens: 300, costUsd: 3, activeDays: 2 } },
        { id: 'dev-u', hostname: 'DEV-U', deleted: false, employee: null, unit: null, focus: { tokens: 70, costUsd: 0.7, activeDays: 1 } },
        { id: 'dev-z', hostname: 'DEV-Z', deleted: false, employee: { id: 'ACME-2', name: 'Bo' }, unit: { id: 'ACME/Games/Aurora', name: 'Aurora', path: ['ACME', 'Aurora'] }, focus: { tokens: 40, costUsd: 0.4, activeDays: 1 } },
        { id: 'dev-g', hostname: 'DEV-G', deleted: false, employee: { id: 'ACME-3', name: 'Cy' }, unit: { id: 'ACME/Games/Old', name: 'Old', path: ['ACME', 'Old'] }, focus: { tokens: 20, costUsd: 0.2, activeDays: 1 } }
      ]);
      assert.deepEqual([w.active.employees.length, w.active.devices.length], [w.focusTotals.employees, w.focusTotals.devices]);
      // Models and tools: the focus's, as before, each with its comparison
      // and trend; the ones used only before are idle.
      assert.deepEqual(w.models, [{ model: 'claude-sonnet-4-5', tokens: 430, costUsd: 4.3, previous: { tokens: 200, costUsd: 2 }, trend: { tokens: [0, 600, 430], costUsd: [0, 6, 4.3] } }]);
      assert.deepEqual(w.clients.map((c) => [c.client, c.tokens, c.previous.tokens]), [['claude', 430, 200]]);
      assert.deepEqual(w.idle, {
        models: [{ model: 'gpt-5.1-codex', previous: { tokens: 300, costUsd: 3 }, trend: { tokens: [0, 300, 0], costUsd: [0, 3, 0] } }],
        clients: [{ client: 'codex', previous: { tokens: 300, costUsd: 3 }, trend: { tokens: [0, 300, 0], costUsd: [0, 3, 0] } }]
      });
      // dev-z's zeros are no split, so its 40 are not covered; dev-u's 70 are
      // covered, all unclassified.
      assert.deepEqual(w.composition, { total: 430, covered: 390, input: 80, output: 16, cacheRead: 192, cacheWrite: 32, unclassified: 70 });

      // Days: the same weekday a week earlier, inside the range or not.
      const days = await ask('from=2026-09-24&to=2026-09-30', {});
      assert.deepEqual(days.body.previous, { from: '2026-09-23', to: '2026-09-23', days: 1, partial: false, mode: 'previous', ...figures(30, 0.3, 1, 1) });
      assert.equal(days.body.focusTotals.tokens, 60);
      const today = await ask('from=2026-09-30&to=2026-09-30', CLIENT);
      assert.deepEqual([today.body.trend.tokens, today.body.totals.tokens, today.body.previous.from, today.body.previous.tokens], [[60], 60, '2026-09-23', 30]);
      assert.deepEqual(today.body.units.map((u) => [u.name, u.focus.tokens, u.previous.tokens]), [['ACME', 60, 30]]);

      // Months: a month clipped to the 15th–30th against the 15th–30th before.
      const month = await ask('from=2026-09-15&to=2026-09-30&granularity=month', {});
      assert.deepEqual(month.body.previous, { from: '2026-08-15', to: '2026-08-30', days: 16, partial: true, mode: 'previous', ...figures(1000, 10, 1, 1) });
      assert.equal(month.body.focusTotals.tokens, 420);
      const whole = await ask('from=2026-09-01&to=2026-09-30&granularity=month', {});
      assert.deepEqual([whole.body.previous.from, whole.body.previous.to, whole.body.previous.partial], ['2026-08-01', '2026-08-31', false]);

      // The whole range as the focus, against as many days right before it.
      const range = await ask('from=2026-09-10&to=2026-09-16&focus=range', {});
      assert.equal(range.status, 200);
      assert.deepEqual(range.body.focus, { key: 'range', from: '2026-09-10', to: '2026-09-16', days: 7 });
      assert.deepEqual(range.body.previous, { from: '2026-09-03', to: '2026-09-09', days: 7, partial: false, mode: 'previous', ...figures(500, 5, 2, 2) });
      assert.deepEqual(range.body.trend.tokens, [400, 0, 0, 0, 100, 90, 240]);
      assert.equal(range.body.focusTotals.tokens, 830);
      assert.deepEqual(range.body.units.map((u) => [u.name, u.focus.tokens, u.previous.tokens]), [['ACME', 760, 500]]);
      assert.deepEqual(range.body.models.map((m) => [m.model, m.tokens, m.previous.tokens]), [['claude-sonnet-4-5', 830, 200]]);
      assert.deepEqual(range.body.idle.models.map((m) => [m.model, m.previous.tokens]), [['gpt-5.1-codex', 300]]);
      // 去年同期: 52 weeks back for a week, the same dates for a month.
      const yearWeek = await ask(`${WEEK}&compare=year`, {});
      const yp = yearWeek.body.previous;
      assert.deepEqual([yp.from, yp.to, yp.days, yp.partial, yp.mode, yp.tokens], ['2025-09-15', '2025-09-17', 3, true, 'year', 0]);
      assert.deepEqual(yearWeek.body.units.map((u) => [u.name, u.focus.tokens, u.previous.tokens]), [['ACME', 360, 0]]);
      const yearMonth = await ask('from=2026-09-01&to=2026-09-30&granularity=month&compare=year', {});
      assert.deepEqual([yearMonth.body.previous.from, yearMonth.body.previous.to, yearMonth.body.previous.partial], ['2025-09-01', '2025-09-30', false]);
      const yearRange = await ask('from=2026-09-10&to=2026-09-16&focus=range&compare=year', {});
      assert.deepEqual([yearRange.body.previous.from, yearRange.body.previous.to], ['2025-09-11', '2025-09-17']);
      // A window of one's own: the same days as the default give its figures.
      const custom = await ask(`${WEEK}&compare=custom&cfrom=2026-09-07&cto=2026-09-09`, {});
      assert.equal(custom.status, 200, JSON.stringify(custom.body));
      assert.deepEqual(custom.body.previous, { ...w.previous, partial: false, mode: 'custom' });
      assert.deepEqual(custom.body.units.map((u) => [u.name, u.previous.tokens]), w.units.map((u) => [u.name, u.previous.tokens]));
      // Of any length, before the range or inside it.
      const longer = await ask(`${WEEK}&compare=custom&cfrom=2026-08-01&cto=2026-09-13`, {});
      assert.deepEqual([longer.status, longer.body.previous.days, longer.body.previous.tokens], [200, 44, 1900]);
      // By tool, per unit, other and person, over the focus and the window:
      // ACME's claude 360 against last week's 200, and dev-b's codex 300 before.
      assert.deepEqual(w.units.map((u) => [u.name, u.clients.map((c) => [c.client, c.focus.tokens, c.previous.tokens])]),
        [['ACME', [['claude', 360, 200], ['codex', 0, 300]]]]);
      assert.deepEqual(w.other.clients.map((c) => [c.client, c.focus.tokens, c.previous.tokens]), [['claude', 70, 0]]);
      // A unit's tools add up to its total.
      for (const u of w.units) assert.equal(u.clients.reduce((sum, c) => sum + c.focus.tokens, 0), u.focus.tokens, u.name);
      assert.equal(w.users.reduce((sum, u) => sum + u.clients.reduce((s, c) => s + c.focus.tokens, 0), 0), w.focusTotals.tokens);
      const keylessWeek = await ask(WEEK, {});
      assert.ok(keylessWeek.body.units.every((u) => Array.isArray(u.clients)));
      assert.equal(keylessWeek.body.users, undefined, 'people only for the admin');
      // Not in one person's view, nor with one tool.
      assert.equal((await ask(`${WEEK}&client=claude`, {})).body.units[0].clients, undefined);

      // One tool: every figure is that tool's alone, and models cannot be split
      // by tool. `tools` lists every tool either way.
      const codex = await ask(`${WEEK}&client=codex`, {});
      assert.equal(codex.status, 200, JSON.stringify(codex.body));
      assert.equal(codex.body.client, 'codex');
      assert.deepEqual(codex.body.trend.tokens, [0, 300, 0]);
      assert.deepEqual([codex.body.focusTotals.tokens, codex.body.previous.tokens], [0, 300]);
      assert.deepEqual([codex.body.models, codex.body.idle.models, codex.body.clients], [[], [], []]);
      assert.deepEqual(codex.body.idle.clients.map((c) => [c.client, c.previous.tokens]), [['codex', 300]]);
      assert.deepEqual(codex.body.tools.map((t) => [t.client, t.tokens, t.previous.tokens]), [['claude', 430, 200], ['codex', 0, 300]]);
      assert.deepEqual(w.tools.map((t) => t.client), ['claude', 'codex'], 'without a tool too');
      assert.equal(w.client, null);
      const claude = await ask(`${WEEK}&client=claude`, {});
      assert.deepEqual([claude.body.focusTotals.tokens, claude.body.previous.tokens, claude.body.totals.tokens], [430, 200, 1030]);
      assert.deepEqual(claude.body.clients.map((c) => [c.client, c.tokens]), [['claude', 430]]);
      assert.deepEqual(claude.body.units.map((u) => [u.name, u.focus.tokens, u.previous.tokens]), [['ACME', 360, 200]]);
      assert.equal(claude.body.composition.total, 430);
      assert.ok(claude.body.composition.covered <= 430);
      // The people and accounts too, for the admin.
      const claudeAdmin = await ask(`${WEEK}&client=claude`);
      assert.equal(claudeAdmin.body.users.reduce((sum, u) => sum + u.focus.tokens, 0), 430);
      assert.ok(claudeAdmin.body.accounts.every((a) => a.tools.every((t) => t.client === 'claude')));
      // Nothing used of a tool: zeros, not an error.
      const none = await ask(`${WEEK}&client=cursor`, {});
      assert.deepEqual([none.status, none.body.focusTotals.tokens, none.body.totals.tokens], [200, 0, 0]);
      // A month total by tool, in a month view.
      const juneClaude = await ask('from=2026-06-01&to=2026-06-30&granularity=month&client=claude', {});
      assert.deepEqual([juneClaude.body.focusTotals.tokens, juneClaude.body.monthlyFallback], [5000, ['2026-06']]);
      assert.equal((await ask('from=2026-06-01&to=2026-06-30&granularity=month&client=codex', {})).body.focusTotals.tokens, 0);

      // A month view counts a device's month total in a whole month it has no
      // day rows in: dev-g's June, owned by nobody on the 1st (its owner starts
      // 09-01), with no active days. July has day rows (the live 07-01 of
      // dev-b, dev-u and dev-g), so its month totals stay out.
      const june = await ask('from=2026-06-01&to=2026-07-31&granularity=month', {});
      assert.deepEqual(june.body.trend.tokens, [5000, 0]);
      assert.deepEqual([june.body.previous.tokens, june.body.monthlyFallback], [5000, ['2026-06']]);
      const juneOnly = await ask('from=2026-06-01&to=2026-06-30&granularity=month', {});
      const jf = juneOnly.body.focusTotals;
      assert.deepEqual([jf.tokens, jf.devices, jf.activeDays, juneOnly.body.totals.activeDays], [5000, 1, 0, 0]);
      assert.equal(juneOnly.body.other.focus.tokens, 5000, 'nobody owned dev-g on June 1');
      assert.deepEqual(juneOnly.body.models.map((m) => [m.model, m.tokens]), [['claude-sonnet-4-5', 5000]]);
      assert.deepEqual(juneOnly.body.clients.map((c) => [c.client, c.tokens]), [['claude', 5000]]);
      assert.deepEqual(juneOnly.body.active.devices.map((d) => [d.hostname, d.focus.tokens, d.focus.activeDays]), [['DEV-G', 5000, 0]]);
      // Weeks never count month totals, nor does a June cut short; the whole
      // June a cut-off July is compared with does.
      const weeks = await ask('from=2026-06-01&to=2026-06-30&granularity=week', {});
      assert.deepEqual([weeks.body.totals.tokens, weeks.body.monthlyFallback], [0, []]);
      const cut = await ask('from=2026-06-15&to=2026-07-31&granularity=month', {});
      assert.deepEqual([cut.body.trend.tokens, cut.body.previous.tokens], [[0, 0], 5000]);
      // A month with day rows ignores its month total (dev-z's September).
      const september = await ask('from=2026-09-01&to=2026-09-30&granularity=month', {});
      assert.deepEqual(september.body.monthlyFallback, []);
      // In a unit, only the month totals charged to it.
      const inAt = await ask('org=ACME&from=2026-06-01&to=2026-06-30&granularity=month', {});
      assert.deepEqual([inAt.status, inAt.body.focusTotals.tokens], [200, 0]);
      const longest = await ask('from=2025-01-01&to=2026-02-04&granularity=month&focus=range', {});
      assert.equal(longest.status, 200, 'a range of 400 days');
      assert.deepEqual([longest.body.previous.from, longest.body.previous.to, longest.body.previous.days], ['2023-11-28', '2024-12-31', 400]);

      // Levels: teams are not offered, but the retired team still counts
      // while usage is charged to it when asked for.
      const old = await ask(`org=${encodeURIComponent('ACME/Games/Old')}&level=team&${WEEK}`, {});
      assert.deepEqual([old.body.level, old.body.levels], ['team', []]);
      assert.deepEqual(old.body.units.map((u) => [u.name, u.active, u.focus.tokens]), [['Gone', false, 20]]);
      const oldQuiet = await ask(`org=${encodeURIComponent('ACME/Games/Old')}&from=2026-08-20&to=2026-08-20`, {});
      assert.deepEqual([oldQuiet.body.level, oldQuiet.body.levels, oldQuiet.body.units], [null, [], []], 'no active unit, no usage: nothing to compare');
      const at = await ask(`org=ACME&level=bu&${WEEK}`, CLIENT);
      assert.deepEqual([at.body.level, at.body.levels], ['bu', ['department']]);
      assert.deepEqual(at.body.units.map((u) => [u.name, u.focus.tokens, u.previous.tokens]), [['Games', 360, 500]]);
      assert.deepEqual(at.body.other.focus, figures(0, 0, 0, 0), 'dev-u is in no company');

      // One person's view, for the admin: org and level are ignored.
      const ann = await ask(`employee=ACME-1&org=NOPE&level=bu&${WEEK}`);
      assert.equal(ann.status, 200, JSON.stringify(ann.body));
      const a = ann.body;
      assert.deepEqual([a.scope, a.level, a.levels, a.units, a.headcount, a.people], [null, null, [], [], 0, true]);
      assert.deepEqual([a.other.tokens, a.other.focus], [[0, 0, 0], figures(0, 0, 0, 0)]);
      assert.deepEqual(a.employee, {
        id: 'ACME-1', name: 'Ann Lee', email: 'ann@example.test', active: true,
        unit: { id: 'ACME/Games/Aurora', name: 'Aurora', path: ['ACME', 'Aurora'] }
      });
      assert.deepEqual(a.users.map((u) => [u.id, u.focus.tokens, u.previous.tokens]), [['ACME-1', 300, 200]]);
      assert.deepEqual(a.devices, [{ id: 'dev-a', hostname: 'DEV-A', deleted: false, focus: { tokens: 300, costUsd: 3, activeDays: 2 }, previous: { tokens: 200, costUsd: 2, activeDays: 1 }, trend: { tokens: [0, 600, 300], costUsd: [0, 6, 3] } }]);
      assert.deepEqual([a.trend.tokens, a.focusTotals.tokens, a.previous.tokens], [[0, 600, 300], 300, 200]);
      assert.deepEqual([a.models.map((m) => [m.model, m.tokens]), a.idle.models], [[['claude-sonnet-4-5', 300]], []]);
      assert.deepEqual(a.composition, { total: 300, covered: 300, input: 75, output: 15, cacheRead: 180, cacheWrite: 30, unclassified: 0 });
      const bo = await ask(`employee=${encodeURIComponent(' ACME-2 ')}&${WEEK}`);
      assert.deepEqual(bo.body.devices.map((d) => [d.id, d.focus.tokens, d.previous.tokens, d.trend.tokens]), [['dev-z', 40, 0, [0, 0, 40]], ['dev-b', 0, 300, [0, 300, 0]]]);
      assert.deepEqual(bo.body.idle.models.map((m) => m.model), ['gpt-5.1-codex']);
      assert.deepEqual(bo.body.composition, { total: 40, covered: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unclassified: 0 });

      // Anyone else: the same 403 whether or not the person exists, before
      // anything is looked up; the admin learns about unknown ones.
      const refused = { error: 'names_admin_only', message: 'employee= needs the admin key' };
      for (const headers of [{}, CLIENT]) {
        for (const id of ['ACME-1', 'ACME-999']) {
          const answer = await ask(`employee=${id}&org=NOPE&${WEEK}`, headers);
          assert.deepEqual([answer.status, answer.body], [403, refused], `${JSON.stringify(headers)} ${id}`);
        }
      }
      const unknown = await ask('employee=ACME-999');
      assert.deepEqual([unknown.status, unknown.body.error], [404, 'unknown_employee']);
      const tooLong = await ask(`employee=${'X'.repeat(65)}`);
      assert.deepEqual([tooLong.status, tooLong.body.error], [400, 'bad_employee']);
      assert.equal((await ask('employee=%20')).body.error, 'bad_employee');
      assert.equal((await ask(`${WEEK}&focus=all`)).body.error, 'bad_focus');

      // Nobody without the admin key gets an email or an employee no. in any
      // answer, nor a name, a hostname or a device id outside `active`.
      const oneAnn = encodeURIComponent('ACME/Games/Aurora/Ember Team');
      for (const headers of [{}, CLIENT]) {
        const variants = [
          '', WEEK, `${WEEK}&focus=range`, `org=ACME&level=team&${WEEK}`, `org=${oneAnn}&${WEEK}`, `org=${oneAnn}&from=2026-09-01&to=2026-09-30&granularity=month`,
          'org=ACME&from=2026-08-01&to=2026-09-30&granularity=week', 'from=2026-08-01&to=2026-09-30&granularity=month&focus=range', 'from=2026-09-24&to=2026-09-30',
          `${WEEK}&client=codex`, `org=ACME&${WEEK}&client=claude`, `${WEEK}&compare=year`, `${WEEK}&compare=custom&cfrom=2026-08-01&cto=2026-08-31`,
          'from=2026-06-01&to=2026-07-31&granularity=month'
        ];
        for (const query of variants) {
          const answer = await ask(query, headers);
          assert.equal(answer.status, 200, query);
          const { active, accounts, ...rest } = answer.body;
          assert.doesNotMatch(JSON.stringify(rest), PRIVATE, query);
          assert.doesNotMatch(JSON.stringify(active), /@|ACME-\d|GLOBEX-\d/, query);
          // 帳號排行: AI accounts' emails and hostnames, never an employee or an employee no.
          assert.doesNotMatch(JSON.stringify(accounts), /Ann|李安|Fay|ACME-\d|GLOBEX-\d/, query);
          for (const key of ['users', 'devices', 'employee']) assert.equal(Object.hasOwn(answer.body, key), false, `${key} ${query}`);
          assert.equal(answer.body.people, false);
        }
        for (const query of ['employee=ACME-1', `employee=${'A'.repeat(65)}`, 'focus=x', 'level=x', 'org=NOPE', 'from=2026-02-30']) {
          const answer = await ask(query, headers);
          assert.ok(answer.status >= 400, query);
          assert.doesNotMatch(JSON.stringify(answer.body), PRIVATE, query);
        }
      }
      const single = await ask(`org=${oneAnn}&${WEEK}`, {});
      assert.deepEqual([single.body.focusTotals.tokens, single.body.focusTotals.employees], [300, 1], 'a one-person unit is that person\'s usage, as numbers only');

      // The owner form's default: each device's first day, owned or not.
      const placed = new Map((await call(hub.base, '/api/admin/org/devices')).body.devices.map((p) => [p.deviceId, [p.unitId, p.source, p.firstDay]]));
      assert.deepEqual(placed.get('dev-a'), ['ACME/Games/Aurora/Ember Team', 'owner', '2026-08-20']);
      assert.deepEqual(placed.get('dev-u'), [null, null, '2026-07-01'], 'its live day, even with no tokens');
      assert.deepEqual(placed.get('dev-z'), ['ACME/Games/Aurora/3D Team', 'owner', '2026-09-16']);
      assert.deepEqual(placed.get('dev-g'), ['ACME/Games/Old/Gone', 'owner', '2026-06-01'], 'a history month older than the daily rows');
      assert.equal(placed.size, 5);
    } finally {
      await hub.stop();
      await cleanup();
      removeAll(hub.dataFile);
    }
  });
}

// createUsage on its own, over a store that answers from memory and records
// every statement: company CO with the BU CO/B, the employee E1 in it, and
// one day of usage on an owned device, an unowned one CO has by email domain,
// and one nobody knows. With `gated`, every statement waits for open().
function fakeStore({ gated = false } = {}) {
  let open = () => {};
  const gate = gated ? new Promise((resolve) => { open = resolve; }) : null;
  const statements = [];
  const day = (deviceId, employeeId, unitId, tokens) => ({
    usage_date: '2026-09-01', device_id: deviceId, employee_id: employeeId, unit_id: unitId, tokens, cost_usd: tokens / 100,
    cache_read_tokens: null, cache_write_tokens: null, output_tokens: null, unclassified_tokens: null, has_token_components: false
  });
  return {
    statements,
    open: () => open(),
    async query(sql, params = [], options = {}) {
      statements.push({ sql, params, options });
      if (gate) await gate;
      if (sql.includes('FROM org_units')) {
        return [
          { unit_id: 'CO', name: 'CO', parent_unit_id: null, level: 'company', is_active: true },
          { unit_id: 'CO/B', name: 'B', parent_unit_id: 'CO', level: 'bu', is_active: true }
        ];
      }
      if (sql.includes('FROM employees e')) return params[0] === 'E1' ? [{ employee_id: 'E1', name: 'Eve', email: 'eve@co.test', is_active: true, unit_id: 'CO/B' }] : [];
      // The rows are the same whatever the filter: the checks in JS must hold.
      if (sql.startsWith('SELECT u.usage_date, u.device_id')) return [day('d-own', 'E1', 'CO/B', 10), day('d-dom', null, null, 7), day('d-none', null, null, 5)];
      return [];
    }
  };
}

const ORG = {
  has: (id) => id === 'CO' || id === 'CO/B',
  devices: () => [{ deviceId: 'd-dom', unitId: 'CO', source: 'domain' }, { deviceId: 'd-own', unitId: 'CO/B', source: 'owner' }]
};
const Q = 'from=2026-09-01&to=2026-09-07';
const settled = () => new Promise((resolve) => setImmediate(resolve));

function usageOf(store, { now = () => Date.parse('2026-09-30T08:00:00.000Z'), org = ORG } = {}) {
  const usage = createUsage({ store, org, cacheMs: 60000, now });
  return { usage, read: (query, people = false) => usage.read(new URL(`http://hub/api/custom/usage?${query}`), { people }) };
}

test('a scope is its unit tree in SQL, with the domain\'s devices only for a company, and checked again in JS', async () => {
  const store = fakeStore();
  const { read } = usageOf(store);
  const daily = () => store.statements.filter((s) => s.sql.startsWith('SELECT u.usage_date, u.device_id')).at(-1);
  const models = () => store.statements.filter((s) => s.sql.includes('FROM device_daily_model_usage')).at(-1);

  const company = await read(`${Q}&org=CO`);
  assert.equal(company.status, 200);
  assert.match(daily().sql, /\(o\.unit_id = ANY\(\$\d+\) OR \(o\.unit_id IS NULL AND u\.device_id = ANY\(\$\d+\)\)\)/);
  assert.match(models().sql, /o\.unit_id IS NULL AND u\.device_id = ANY/, 'by model and by tool the SQL is the only filter');
  assert.ok(daily().params.some((p) => Array.isArray(p) && p.join() === 'CO,CO/B'));
  assert.ok(daily().params.some((p) => Array.isArray(p) && p.join() === 'd-dom'));
  assert.equal(company.payload.totals.tokens, 17, 'the unit\'s rows and the domain\'s, not the device nobody knows');

  const bu = await read(`${Q}&org=${encodeURIComponent('CO/B')}`);
  assert.match(daily().sql, /o\.unit_id = ANY\(\$\d+\)/);
  assert.doesNotMatch(daily().sql, /u\.device_id = ANY/, 'a domain places a device in a company, never below it');
  assert.ok(daily().params.some((p) => Array.isArray(p) && p.join() === 'CO/B'));
  assert.equal(bu.payload.totals.tokens, 10);

  const all = await read(Q);
  assert.doesNotMatch(daily().sql, /ANY/);
  assert.doesNotMatch(models().sql, /device_owners/, 'no owner needed without a filter on it');
  assert.equal(all.payload.totals.tokens, 22);

  // A scope's other leaves out the days in a unit of its level, by owner
  // and, for every company, by domain.
  const coOther = await read(`${Q}&org=CO&other=bu`);
  assert.match(daily().sql, / AND NOT \(\(o\.unit_id IS NOT NULL AND o\.unit_id = ANY\(\$\d+\)\)\)$/);
  assert.match(models().sql, / AND NOT \(/);
  assert.ok(daily().params.some((p) => Array.isArray(p) && p.join() === 'CO/B'));
  assert.equal(coOther.payload.totals.tokens, 7, 'CO by domain, not its BU');
  const allOther = await read(`${Q}&other=company`);
  assert.match(daily().sql, / AND NOT \(\(o\.unit_id IS NOT NULL AND o\.unit_id = ANY\(\$\d+\)\) OR \(o\.unit_id IS NULL AND u\.device_id = ANY\(\$\d+\)\)\)$/);
  assert.match(models().sql, /LEFT JOIN device_owners/);
  assert.ok(daily().params.some((p) => Array.isArray(p) && p.join() === 'd-dom'));
  assert.equal(allOther.payload.totals.tokens, 5, 'only the device nobody knows');

  // unowned= leaves out the days charged to someone, in SQL and in JS.
  const coUnowned = await read(`${Q}&org=CO&unowned=1`);
  assert.match(daily().sql, / AND o\.employee_id IS NULL$/);
  assert.match(models().sql, /LEFT JOIN device_owners.* AND o\.employee_id IS NULL/);
  assert.equal(coUnowned.payload.totals.tokens, 7, 'CO\'s device by domain, not E1\'s');
  const allUnowned = await read(`${Q}&unowned=1`);
  assert.match(models().sql, /LEFT JOIN device_owners/);
  assert.equal(allUnowned.payload.totals.tokens, 12);

  await read(`${Q}&employee=E1`, true);
  assert.match(daily().sql, /o\.employee_id = \$\d+/);
  assert.match(models().sql, /o\.employee_id = \$\d+/);
  assert.ok(store.statements.every((s) => !/\bLIKE\b/i.test(s.sql)), 'never a prefix match on unit ids');
});

test('an answer takes at most 10 statements, names, hostnames, tools and accounts included, and the first day the hub saw a device is read once per cacheMs', async () => {
  const count = async (query, people) => {
    const store = fakeStore();
    const { read } = usageOf(store);
    assert.equal((await read(query, people)).status, 200);
    const n = store.statements.length;
    await read(`${query}&level=bu`, people);
    return [n, store.statements.length - n, store.statements.filter((s) => s.sql.includes('first_seen_at')).length];
  };
  // The whole range is the focus, so its people and devices are named.
  const range = `${Q}&focus=range`;
  const [keyless, keylessAgain, keylessFirst] = await count(range, false);
  assert.ok(keyless <= 10, `${keyless} statements`);
  assert.equal(keylessAgain, keyless - 1, 'the second answer reuses the first day');
  assert.equal(keylessFirst, 1);
  const [admin] = await count(range, true);
  assert.equal(admin, keyless, 'the admin\'s names come in the same two statements, and the accounts are everyone\'s');
  const [person] = await count(`${Q}&employee=E1`, true);
  assert.ok(person <= 8, `${person} statements`);
});

test('every statement is bounded, and one the server cancels is a 503 usage_slow that is not kept', async () => {
  const store = fakeStore();
  const slow = { ...store, query: async (sql, params, options) => {
    if (sql.startsWith('SELECT u.usage_date, u.device_id') && !slow.done) {
      slow.done = true;
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    }
    return store.query(sql, params, options);
  } };
  const { read } = usageOf(slow);
  const first = await read(Q, true);
  assert.deepEqual([first.status, first.payload.error], [503, 'usage_slow']);
  assert.match(first.payload.message, /15 s/);
  assert.equal(first.headers, undefined, 'no Retry-After: the same question would be as slow');
  assert.equal((await read(Q, true)).status, 200, 'asked again, it is worked out again');
  assert.ok(store.statements.length > 0);
  for (const { sql, options } of store.statements) assert.equal(options?.timeoutMs, STATEMENT_TIMEOUT_MS, sql.slice(0, 60));
  assert.equal(STATEMENT_TIMEOUT_MS, 15000);
});

test('an account is charged with its tools on the devices holding it; two on one device share them, none is other', async () => {
  const day = (date, deviceId, unitId, client, tokens) => ({ usage_date: date, client, device_id: deviceId, unit_id: unitId, tokens, cost_usd: tokens / 100 });
  const limit = (deviceId, provider, email, more = {}) => ({
    device_id: deviceId, provider, account_email: email, account_name: null, account_label: null, status: 'ok', windows: [{ usedPercent: 10 }], ...more
  });
  const statements = [];
  const store = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes('FROM org_units')) {
        return [
          { unit_id: 'CO', name: 'CO', parent_unit_id: null, level: 'company', is_active: true },
          { unit_id: 'CO/B', name: 'B', parent_unit_id: 'CO', level: 'bu', is_active: true }
        ];
      }
      if (sql.includes('u.client, u.device_id')) {
        return [
          day('2026-09-03', 'd1', 'CO/B', 'claude', 100), day('2026-09-03', 'd1', 'CO/B', 'codex', 40),
          day('2026-09-03', 'd1', 'CO/B', 'droid', 5), day('2026-09-03', 'd1', 'CO/B', 'amp', 3),
          day('2026-09-03', 'd2', 'CO', 'claude', 60), day('2026-09-03', 'd3', null, 'claude', 9),
          day('2026-08-28', 'd1', 'CO/B', 'claude', 20)
        ];
      }
      if (sql.includes('FROM device_limits')) {
        return [
          // One email on two providers is one account, whatever its case.
          limit('d1', 'claude', 'Su@co.test'), limit('d1', 'codex', 'su@co.test'),
          // Factory Droid's tokens go to its Factory account, here a name.
          limit('d1', 'factory', null, { account_name: 'Factory team' }),
          limit('d2', 'claude', 'b@co.test'), limit('d2', 'claude', 'a@co.test'),
          // Neither connected nor with windows: not an account it holds.
          limit('d3', 'claude', 'su@co.test', { status: 'error', windows: null })
        ];
      }
      return [];
    }
  };
  const { read } = usageOf(store);
  const answer = await read(`${Q}&focus=range`, true);
  assert.equal(answer.status, 200, JSON.stringify(answer.payload));
  const accounts = answer.payload.accounts;
  assert.deepEqual(accounts.map((a) => [a.id, a.name, a.shared, a.other, a.providers, a.devices.map((d) => d.id), a.tools.map((t) => [t.client, t.tokens]), a.focus.tokens, a.previous.tokens]), [
    ['su@co.test', 'Su@co.test', false, false, ['claude', 'codex'], ['d1'], [['claude', 100], ['codex', 40]], 140, 20],
    ['a@co.test + b@co.test', 'a@co.test、b@co.test', true, false, ['claude'], ['d2'], [['claude', 60]], 60, 0],
    ['factory team', 'Factory team', false, false, ['factory'], ['d1'], [['droid', 5]], 5, 0],
    ['other', null, false, true, [], ['d1', 'd3'], [['claude', 9], ['amp', 3]], 12, 0]
  ]);
  assert.deepEqual(accounts[0].who, ['Su@co.test']);
  // A BU is not shown: a device in one shows as in its company.
  assert.deepEqual(accounts[0].unit, { id: 'CO', name: 'CO', path: ['CO'] });
  assert.deepEqual(accounts[0].focus, { tokens: 140, costUsd: 1.4, devices: 1, activeDays: 1 });
  assert.equal(accounts[3].unit, null);
  // Each provider's share of an account, for 依工具: one email on Claude and
  // Codex is split back; "other" has no provider's account to split by.
  assert.deepEqual(accounts.map((a) => a.byProvider.map((p) => [p.provider, p.focus.tokens, p.previous.tokens])), [
    [['claude', 100, 20], ['codex', 40, 0]],
    [['claude', 60, 0]],
    [['factory', 5, 0]],
    []
  ]);
  assert.deepEqual(accounts[0].byProvider[1].focus, { tokens: 40, costUsd: 0.4, devices: 1, activeDays: 1 });

  // A unit's accounts are those of the rows charged inside it.
  const inB = await read(`${Q}&focus=range&org=${encodeURIComponent('CO/B')}`, true);
  assert.deepEqual(inB.payload.accounts.map((a) => [a.id, a.focus.tokens]), [['su@co.test', 140], ['factory team', 5], ['other', 3]]);

  // Without the admin key: the same accounts (帳號排行 is everyone's), and
  // the units' tools from the same rows.
  const keyless = await read(`${Q}&focus=range&org=CO`, false);
  assert.deepEqual(keyless.payload.accounts, (await read(`${Q}&focus=range&org=CO`, true)).payload.accounts);
  assert.deepEqual(keyless.payload.accounts.map((a) => [a.id, a.devices.map((d) => d.id)]), [['su@co.test', ['d1']], ['a@co.test + b@co.test', ['d2']], ['factory team', ['d1']], ['other', ['d1']]], 'd3 is in no unit of CO');
  // One tool: the accounts come from that tool's rows only.
  const before = statements.length;
  assert.equal((await read(`${Q}&focus=range&client=codex`, false)).status, 200);
  assert.ok(statements.slice(before).some((sql) => sql.includes('u.client, u.device_id') && /u\.client = \$\d+/.test(sql)), 'client= filters the rows by tool');
  assert.ok(statements.slice(before).some((sql) => sql.includes('FROM device_limits')));
  assert.ok(keyless.payload.units.every((u) => Array.isArray(u.clients)));
  assert.ok(Array.isArray(keyless.payload.other.clients));
  assert.equal(keyless.payload.users, undefined);
});

test('a comparison window is checked: a known mode, real days, at most 400 of them, by today, apart from the focus', async () => {
  const store = fakeStore();
  const { read } = usageOf(store);
  // Q's focus is its last day, 2026-09-07; today is 2026-09-30.
  for (const query of ['compare=bogus', 'compare=custom', 'compare=custom&cfrom=2026-08-01', 'compare=custom&cfrom=2026-08-10&cto=2026-08-01',
    'compare=custom&cfrom=2025-07-01&cto=2026-08-31', 'compare=custom&cfrom=2026-09-25&cto=2026-10-01', 'compare=custom&cfrom=2026-09-05&cto=2026-09-07',
    'compare=custom&cfrom=2026-09-07&cto=2026-09-07']) {
    const answer = await read(`${Q}&${query}`);
    assert.deepEqual([answer.status, answer.payload.error], [400, 'bad_compare'], query);
  }
  // A day of the range that is not the focus is fine, and so is one after it.
  assert.equal((await read(`${Q}&compare=custom&cfrom=2026-09-01&cto=2026-09-06`)).status, 200);
  assert.equal((await read(`${Q}&compare=custom&cfrom=2026-09-08&cto=2026-09-30`)).status, 200);
  const whole = await read(`${Q}&focus=range&compare=custom&cfrom=2026-09-07&cto=2026-09-08`);
  assert.deepEqual([whole.status, whole.payload.error], [400, 'bad_compare'], 'with focus=range the whole range is the focus');
  // cfrom and cto count only for custom: the same question otherwise.
  const before = store.statements.length;
  await read(Q);
  const asked = store.statements.length;
  assert.ok(asked > before);
  await read(`${Q}&cfrom=2026-01-01&cto=2026-01-31`);
  await read(`${Q}&compare=previous`);
  assert.equal(store.statements.length, asked, 'answered from the cache');
  await read(`${Q}&compare=year`);
  assert.ok(store.statements.length > asked, 'a year back is another question');
});

test('a tool is a short printable key, part of the question', async () => {
  const store = fakeStore();
  const { read } = usageOf(store);
  for (const query of ['client=', `client=${'x'.repeat(65)}`, 'client=a%0Ab', 'client=a%7Fb']) {
    const answer = await read(`${Q}&${query}`);
    assert.deepEqual([answer.status, answer.payload.error], [400, 'bad_client'], query);
  }
  assert.equal((await read(`${Q}&client=${'x'.repeat(64)}`)).status, 200);
  // With a tool the day rows come from the table by tool, and nothing is read by model.
  const before = store.statements.length;
  assert.equal((await read(`${Q}&client=codex`)).status, 200);
  const asked = store.statements.slice(before);
  const daily = asked.find((s) => s.sql.startsWith('SELECT u.usage_date, u.device_id'));
  assert.match(daily.sql, /FROM device_daily_client_usage u .* AND u\.client = \$\d+/);
  assert.ok(daily.params.includes('codex'));
  assert.equal(asked.filter((s) => s.sql.includes('device_daily_model_usage')).length, 0);
  // Another tool, another question.
  const again = store.statements.length;
  await read(`${Q}&client=codex`);
  assert.equal(store.statements.length, again, 'the same tool: the cache');
  await read(`${Q}&client=claude`);
  assert.ok(store.statements.length > again);
});

test('answers are reused for the same normalised question and asker, and only for that', async () => {
  const store = fakeStore();
  let clock = Date.parse('2026-09-30T08:00:00.000Z');
  const { read } = usageOf(store, { now: () => clock });
  const first = await read(Q);
  const n = store.statements.length;
  assert.equal((await read(Q)).payload, first.payload, 'the same object');
  assert.equal((await read('to=2026-09-07&from=2026-09-01&level=')).payload, first.payload, 'the same question in other words');
  assert.equal(store.statements.length, n);

  const range = await read(`${Q}&focus=range`);
  assert.notEqual(range.payload, first.payload);
  assert.ok(store.statements.length > n, 'another focus is another question');
  const admin = await read(Q, true);
  assert.notEqual(admin.payload, first.payload);
  assert.ok(Array.isArray(admin.payload.users));
  assert.equal((await read(Q)).payload.users, undefined, 'the admin\'s answer never reaches anyone else');

  // One person's view ignores org and level, so they do not split it.
  const eve = await read(`${Q}&employee=E1&org=CO`, true);
  const m = store.statements.length;
  assert.equal((await read(`${Q}&employee=E1&org=NOPE&level=team`, true)).payload, eve.payload);
  assert.equal(store.statements.length, m);
  assert.notEqual(eve.payload, admin.payload);
  assert.equal((await read(`${Q}&employee=E2`, true)).status, 404);
  const k = store.statements.length;
  assert.deepEqual((await read(`${Q}&employee=E9`)).payload, { error: 'names_admin_only', message: 'employee= needs the admin key' });
  assert.equal(store.statements.length, k, 'refused before any statement');

  clock += 60000;
  assert.notEqual((await read(Q)).payload, first.payload, 'kept for cacheMs only');

  const none = createUsage({});
  const offline = await none.read(new URL(`http://hub/api/custom/usage?${Q}&employee=E1`), { people: false });
  assert.deepEqual([offline.status, offline.payload.error], [503, 'store_unavailable']);
});

test('an org or owner change while an answer is worked out is not answered from the old state', async () => {
  // The same question asked meanwhile joins the running computation…
  const store = fakeStore({ gated: true });
  const { usage, read } = usageOf(store);
  const first = read(Q);
  const joined = read(Q);
  await settled();
  // …but not once the org chart changed: that one starts over.
  usage.invalidate();
  const after = read(Q);
  store.open();
  const [a, b, c] = await Promise.all([first, joined, after]);
  assert.equal(b.payload, a.payload);
  assert.notEqual(c.payload, a.payload);
  assert.equal((await read(Q)).payload, c.payload, 'the answer of the new state is kept');

  // A computation that ran across a change keeps its answer to itself.
  const store2 = fakeStore({ gated: true });
  const late = usageOf(store2);
  const running = late.read(Q);
  await settled();
  late.usage.invalidate();
  store2.open();
  const old = await running;
  const n = store2.statements.length;
  const next = await late.read(Q);
  assert.notEqual(next.payload, old.payload);
  assert.ok(store2.statements.length > n, 'worked out again');
});

test(`at most ${MAX_RUNNING} answers are worked out at once and ${MAX_WAITING} wait; past that only the admin is queued`, async () => {
  const store = fakeStore({ gated: true });
  const { read } = usageOf(store);
  const day = (i) => `from=2026-08-${String(i).padStart(2, '0')}&to=2026-08-${String(i).padStart(2, '0')}`;
  const pending = [];
  for (let i = 1; i <= MAX_RUNNING + MAX_WAITING; i += 1) pending.push(read(day(i)));
  // Joining a question already waiting takes no place in the line.
  const joined = read(day(3));
  // Answered at once, not queued (which would wait on the gate for ever).
  const refused = await Promise.race([Promise.all([read(day(25)), read(day(26))]), settled().then(() => [])]);
  assert.equal(refused.length, 2, 'refused right away');
  for (const answer of refused) {
    assert.deepEqual([answer.status, answer.payload.error, answer.headers], [503, 'usage_busy', { 'retry-after': '5' }]);
    assert.doesNotMatch(JSON.stringify(answer.payload), PRIVATE);
  }
  const admin = read(day(27), true);
  await settled();
  assert.equal(store.statements.filter((s) => s.sql.includes('FROM org_units')).length, MAX_RUNNING, 'the others wait for a turn');
  store.open();
  const answers = await Promise.all([...pending, joined, admin]);
  assert.ok(answers.every((answer) => answer.status === 200));
  assert.equal(answers[MAX_RUNNING + MAX_WAITING].payload, answers[2].payload);
  assert.equal(answers.at(-1).payload.people, true);
  assert.equal((await read(day(25))).status, 200, 'room again once the line is gone');
});
