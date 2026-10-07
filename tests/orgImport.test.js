'use strict';

// hub/org.js, month to month: what a new HR list changes (diffImport, the
// preview), the imports that wait for a confirmation, moves charged from the
// day they took effect, the HR lists coming before an admin's email rules, and
// rules that give an address to a department or team.

const assert = require('node:assert/strict');
const test = require('node:test');

const { diffImport, evidenceFor, fileDateOf, parseAnnouncement } = require('../hub/org');
const { readWorkbook } = require('../hub/xlsx');
const { bearer, post, removeAll, startOverlayHub } = require('./helpers/overlayHub');
const { devicePayload, provider } = require('./helpers/fixtures');
const { announcement } = require('./helpers/xlsx');
const { BACKENDS } = require('./helpers/pg');

const ADMIN = bearer('admin-secret');
const CLIENT = bearer('client-secret');

const AUGUST = [
  { no: 'ACME-1', en: 'Ann', bu: 'Games', department: 'Aurora', team: 'Ember Team', email: 'ann@example.test' },
  { no: 'ACME-2', en: 'Bo', bu: 'Games', department: 'Aurora', team: '3D Team', email: 'bo@example.test' },
  { no: 'ACME-3', en: 'Cy', bu: 'Games', department: 'Aurora', email: 'cy@example.test' },
  { no: 'ACME-4', en: 'Di', department: 'GM Office', email: 'di@example.test' },
  { no: 'ACME-5', en: 'Ed', department: 'GM Office', email: 'ed@example.test' }
];
// September: Ann moves to GM Office, Bo leaves (and the 3D team with him), Cy
// is renamed, Ed has a new address, Fay joins.
const SEPTEMBER = [
  { ...AUGUST[0], bu: '-', department: 'GM Office', team: '-' },
  { ...AUGUST[2], en: 'Cyrus' },
  AUGUST[3],
  { ...AUGUST[4], email: 'edward@example.test' },
  { no: 'ACME-6', en: 'Fay', bu: 'Games', department: 'Aurora', email: 'fay@example.test' }
];

function parsed(people, company = 'ACME') {
  return parseAnnouncement(readWorkbook(announcement(people)), { company });
}

// What the database would hold after importing `people`.
function stateOf(people, company = 'ACME') {
  const list = parsed(people, company);
  return {
    employees: new Map(list.employees.map((e) => [e.employeeId, { ...e, active: true, companyId: company, effectiveFrom: null }])),
    units: new Map(list.units.map((u) => [u.id, { ...u, active: true }]))
  };
}

async function call(base, pathname, { method = 'GET', headers = ADMIN, body, type = 'application/json' } = {}) {
  const response = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': type, ...headers }, body });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: response.status, body: json };
}

function importFile(base, fileName, people, query = '') {
  const path = `/api/admin/org/import${query.startsWith('/') ? query.split('?')[0] : ''}`;
  const extra = query.includes('?') ? `&${query.split('?')[1]}` : '';
  return call(base, `${path}?company=ACME&fileName=${encodeURIComponent(fileName)}${extra}`, {
    method: 'POST', body: announcement(people), type: 'application/octet-stream'
  });
}

function aiAccounts(...emails) {
  return { limits: false, extra: { limits: { updatedAt: new Date().toISOString(), refreshMs: 300000, providers: emails.map((email, i) => provider({ provider: i ? 'codex' : 'claude', email })) } } };
}

test('a list\'s day comes from its file name', () => {
  assert.equal(fileDateOf('ACME Announcement 20260801.xlsx'), '2026-08-01');
  assert.equal(fileDateOf('C:\\hr\\INITECH Announcement 20260921.xlsx'), '2026-09-21');
  assert.equal(fileDateOf('ACME Announcement 20261301.xlsx'), null, 'no 13th month');
  assert.equal(fileDateOf('ACME list.xlsx'), null);
});

test('diffImport tells each kind of change apart', () => {
  const before = stateOf(AUGUST);
  before.employees.set('GLOBEX-9', { employeeId: 'GLOBEX-9', name: 'Gil', email: 'gil@example.test', active: true, companyId: 'GLOBEX', unitId: 'GLOBEX' });
  const rules = new Map([['fay@example.test', { unitId: 'ACME/Games/Aurora' }]]);
  const diff = diffImport(parsed([...SEPTEMBER, { no: 'ACME-7', en: 'Gil', email: 'gil@example.test' }]), { ...before, rules, seen: new Set(['ed@example.test']) });
  const ids = (list) => list.map((e) => e.employeeId);
  assert.deepEqual(ids(diff.joined), ['ACME-6', 'ACME-7']);
  assert.deepEqual(ids(diff.departed), ['ACME-2']);
  assert.deepEqual(diff.transferred.map((e) => [e.employeeId, e.from, e.to]), [['ACME-1', 'ACME/Games/Aurora/Ember Team', 'ACME/-/GM Office']]);
  assert.deepEqual(diff.renamed, [{ employeeId: 'ACME-3', from: 'Cy', to: 'Cyrus' }]);
  assert.deepEqual(diff.emailChanged, [{ employeeId: 'ACME-5', name: 'Ed', from: 'ed@example.test', to: 'edward@example.test', onDevices: true }]);
  assert.deepEqual(diff.emailMoved.map((m) => [m.email, m.from, m.to]), [['gil@example.test', 'GLOBEX-9', 'ACME-7']], 'a transfer between companies gets a new employee no.');
  assert.deepEqual(diff.unitsDeactivated.map((u) => u.id).sort(), ['ACME/Games/Aurora/3D Team', 'ACME/Games/Aurora/Ember Team']);
  assert.deepEqual(diff.unitsAdded, []);
  assert.deepEqual(diff.rulesSuperseded.map((r) => r.email), ['fay@example.test']);
  assert.equal(diff.unchanged, 1, 'Di');
  assert.deepEqual(diff.warnings, []);

  assert.deepEqual(diffImport(parsed(AUGUST), stateOf(AUGUST)).unchanged, 5, 'the same list again changes nothing');
  assert.deepEqual(diffImport(parsed(AUGUST), { ...stateOf(AUGUST), lastFileDate: '2026-09-01' }, { fileDate: '2026-08-01' }).warnings,
    [{ code: 'older_file', fileDate: '2026-08-01', lastFileDate: '2026-09-01' }]);
  assert.deepEqual(diffImport(parsed(AUGUST.slice(0, 1)), stateOf(AUGUST)).warnings, [{ code: 'mass_departure', departed: 4, active: 5 }]);
  assert.deepEqual(diffImport(parsed(AUGUST, 'GLOBEX'), { domains: new Map([['example.test', 'ACME']]) }).warnings, [{ code: 'domain_mismatch', domain: 'example.test', company: 'ACME' }]);
});

test('the HR lists come before an admin\'s rules, and two people on the lists are nobody\'s', () => {
  const ann = { employeeId: 'ACME-1', unitId: 'ACME/A' };
  const bo = { employeeId: 'ACME-2', unitId: 'ACME/B' };
  const people = new Map([['ann@x.test', ann], ['bo@x.test', bo]]);
  const staff = new Map([['ACME-1', ann], ['ACME-2', bo]]);
  const device = (...emails) => ({ limits: { providers: emails.map((accountEmail) => ({ accountEmail })) } });
  const rules = new Map([['ann@x.test', { other: true }], ['home@gmail.test', { employeeId: 'ACME-2' }], ['vendor@v.test', { unitId: 'ACME/C' }]]);
  assert.equal(evidenceFor(device('ann@x.test'), '', people, rules, staff).employeeId, 'ACME-1', 'a rule for a listed address is not read');
  assert.equal(evidenceFor(device('home@gmail.test'), 'ann@x.test', people, rules, staff).employeeId, 'ACME-1', 'the listed address beats the rule');
  assert.equal(evidenceFor(device('ann@x.test', 'bo@x.test'), '', people, rules, staff), null, 'a conflict');
  assert.equal(evidenceFor(device('ann@x.test', 'bo@x.test', 'home@gmail.test'), '', people, rules, staff), null, 'no rule settles a conflict');
  assert.deepEqual(evidenceFor(device('vendor@v.test'), '', people, rules, staff), { employeeId: null, unitId: 'ACME/C', source: 'auto:email-assigned' });
  assert.equal(evidenceFor(device('vendor@v.test', 'home@gmail.test'), '', people, rules, staff), null, 'two rules, two targets');
});

for (const backend of BACKENDS) {
  test(`${backend.name}: a month's list is previewed, confirmed when it looks wrong, and moves count from the day they took effect`, { skip: backend.skip }, async () => {
    const env = await backend.setup();
    const hub = await startOverlayHub({ persistenceConfig: env.persistenceConfig });
    try {
      const store = hub.overlay.persistence.store;
      const owners = async (deviceId) => (await store.query('SELECT valid_from, valid_to, employee_id, unit_id, updated_by FROM device_owners WHERE device_id = $1 ORDER BY valid_from', [deviceId])).map((r) => ({ ...r }));
      await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-ann', ...aiAccounts('ann@example.test') }), CLIENT);
      await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-bo', ...aiAccounts('bo@example.test') }), CLIENT);
      await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-ed', ...aiAccounts('ed@example.test') }), CLIENT);
      await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-two', ...aiAccounts('cy@example.test', 'di@example.test') }), CLIENT);
      await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-vendor', ...aiAccounts('someone@vendor.test') }), CLIENT);
      await hub.settle();
      await store.execute('UPDATE devices SET first_seen_at = $1', ['2026-07-01T08:00:00.000Z']);

      // August: a preview writes nothing.
      const preview = await importFile(hub.base, 'ACME Announcement 20260801.xlsx', AUGUST, '/preview');
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.deepEqual([preview.body.dryRun, preview.body.fileDate, preview.body.effectiveFrom, preview.body.diff.joined.length], [true, '2026-08-01', '2026-08-01', 5]);
      assert.equal((await store.query('SELECT employee_id FROM employees')).length, 0);
      assert.equal((await importFile(hub.base, 'ACME Announcement 20260801.xlsx', AUGUST)).status, 200);
      assert.deepEqual((await owners('dev-ann')).map((r) => [r.valid_from, r.unit_id]), [['2026-07-01', 'ACME/Games/Aurora/Ember Team']]);

      // A rule for Fay's address before she is on a list; the vendor's address
      // goes to a department, not an employee.
      const rule = (address, body) => call(hub.base, `/api/admin/emails/${encodeURIComponent(address)}`, { method: 'PUT', body: JSON.stringify(body) });
      assert.equal((await rule('fay@example.test', { unitId: 'ACME/Games/Aurora' })).status, 200);
      assert.equal((await rule('someone@vendor.test', { unitId: 'ACME' })).body.error, 'bad_unit', 'a department or a team, not a company');
      assert.equal((await rule('someone@vendor.test', { unitId: 'ACME/Nope' })).body.error, 'unknown_unit');
      assert.equal((await rule('someone@vendor.test', { unitId: 'ACME/Games/Aurora', other: true })).status, 400);
      const vendor = await rule('someone@vendor.test', { unitId: 'ACME/Games/Aurora/3D Team', note: 'contractor' });
      assert.equal(vendor.status, 200, JSON.stringify(vendor.body));
      assert.deepEqual((await owners('dev-vendor')).map((r) => [r.employee_id, r.unit_id, r.updated_by]), [[null, 'ACME/Games/Aurora/3D Team', 'auto:email-assigned']]);

      // Unclassified: only the conflict is left, and it says so.
      const unclassified = (await call(hub.base, '/api/admin/emails/unclassified')).body.emails;
      assert.deepEqual(unclassified.map((e) => [e.email, e.reason]), [['cy@example.test', 'conflict'], ['di@example.test', 'conflict']]);
      const issues = (await call(hub.base, '/api/admin/org/issues')).body;
      assert.deepEqual(issues.conflicts.map((c) => [c.deviceId, c.employees.map((e) => e.employeeId)]), [['dev-two', ['ACME-3', 'ACME-4']]]);

      // An older file, or one that retires most of the company, waits.
      const older = await importFile(hub.base, 'ACME Announcement 20260715.xlsx', AUGUST);
      assert.deepEqual([older.status, older.body.error, older.body.preview.diff.warnings[0].code], [409, 'needs_confirm', 'older_file']);
      const few = await importFile(hub.base, 'ACME Announcement 20260901.xlsx', AUGUST.slice(0, 1));
      assert.deepEqual([few.status, few.body.preview.diff.warnings[0].code], [409, 'mass_departure']);
      assert.equal((await store.query('SELECT COUNT(*) AS n FROM employees WHERE is_active')).map((r) => Number(r.n))[0], 5, 'nothing was written');
      assert.equal((await importFile(hub.base, 'ACME Announcement 20260901.xlsx', AUGUST, '?effectiveFrom=2999-01-01')).status, 400, 'a move cannot take effect in the future');

      // September.
      const september = await importFile(hub.base, 'ACME Announcement 20260901.xlsx', SEPTEMBER, '/preview');
      const diff = september.body.diff;
      assert.deepEqual(
        Object.fromEntries(['joined', 'departed', 'transferred', 'renamed', 'emailChanged', 'unitsDeactivated', 'rulesSuperseded'].map((k) => [k, diff[k].length])),
        { joined: 1, departed: 1, transferred: 1, renamed: 1, emailChanged: 1, unitsDeactivated: 2, rulesSuperseded: 1 }
      );
      assert.equal(diff.emailChanged[0].onDevices, true, 'dev-ed still uses the old address');
      const done = await importFile(hub.base, 'ACME Announcement 20260901.xlsx', SEPTEMBER, '?dropSupersededRules=1&keepOldEmails=1');
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.deepEqual([done.body.rulesDropped, done.body.rulesKept, done.body.employeesDeactivated], [1, 1, 1]);

      // Ann is charged to GM Office from the day the list says she moved.
      assert.deepEqual((await owners('dev-ann')).map((r) => [r.valid_from, r.valid_to, r.unit_id]), [
        ['2026-07-01', '2026-09-01', 'ACME/Games/Aurora/Ember Team'],
        ['2026-09-01', null, 'ACME/-/GM Office']
      ]);
      // Bo left: his device keeps him, and the admin is told.
      assert.deepEqual((await owners('dev-bo')).map((r) => [r.employee_id, r.valid_to]), [['ACME-2', null]]);
      // Ed's old address stays Ed's by a rule the import made.
      assert.deepEqual((await owners('dev-ed')).map((r) => [r.employee_id, r.valid_to]), [['ACME-5', null]]);
      const rules = (await call(hub.base, '/api/admin/emails')).body.emails;
      assert.deepEqual(rules.map((r) => [r.email, r.employeeId, r.unitId, r.problem]), [
        ['ed@example.test', 'ACME-5', null, null],
        ['someone@vendor.test', null, 'ACME/Games/Aurora/3D Team', 'unit_inactive']
      ], 'Fay\'s rule is gone: the list has her now');
      const after = (await call(hub.base, '/api/admin/org/issues')).body;
      assert.deepEqual(after.departed.map((d) => [d.deviceId, d.employeeId]), [['dev-bo', 'ACME-2']]);
      assert.deepEqual(after.rules.map((r) => [r.email, r.problem]), [['someone@vendor.test', 'unit_inactive']]);

      // The history, and the lists an admin browses.
      const history = (await call(hub.base, '/api/admin/org/imports?company=ACME')).body;
      assert.deepEqual(history.history.map((h) => [h.fileDate, h.effectiveFrom, h.summary.changes.joined]), [['2026-09-01', '2026-09-01', 1], ['2026-08-01', '2026-08-01', 5]]);
      assert.deepEqual(history.imports.map((i) => [i.company, i.employees, i.overdue, i.last.fileName]), [['ACME', 5, false, 'ACME Announcement 20260901.xlsx']]);
      const units = new Map((await call(hub.base, '/api/admin/org/units')).body.units.map((u) => [u.id, u]));
      assert.deepEqual([units.get('ACME').headcount, units.get('ACME/-/GM Office').headcount, units.get('ACME/Games/Aurora').headcount], [5, 3, 2]);
      assert.equal(units.get('ACME/Games/Aurora/3D Team').active, false);
      assert.ok(units.get('ACME').recentTokens > 0);
      const people = new Map((await call(hub.base, '/api/admin/employees')).body.employees.map((e) => [e.employeeId, e]));
      assert.deepEqual([people.get('ACME-1').unitPath, people.get('ACME-1').effectiveFrom, people.get('ACME-1').devices], [['ACME', 'GM Office'], '2026-09-01', 1]);
      assert.equal(people.get('ACME-2').active, false);
      assert.equal((await call(hub.base, '/api/admin/org/units', { headers: CLIENT })).status, 403);

      // A device assigned by hand, turned back to automatic.
      assert.equal((await call(hub.base, '/api/admin/owners', { method: 'POST', body: JSON.stringify({ deviceId: 'dev-ann', employeeId: 'ACME-4' }) })).status, 200);
      assert.deepEqual((await call(hub.base, '/api/admin/org/issues')).body.manualOwners.map((m) => m.deviceId), ['dev-ann']);
      const released = await call(hub.base, '/api/admin/owners/dev-ann/release', { method: 'POST' });
      assert.equal(released.status, 200, JSON.stringify(released.body));
      assert.deepEqual((await owners('dev-ann')).map((r) => [r.valid_from, r.valid_to, r.employee_id, r.unit_id]), [
        ['2026-07-01', '2026-09-01', 'ACME-1', 'ACME/Games/Aurora/Ember Team'],
        ['2026-09-01', null, 'ACME-1', 'ACME/-/GM Office']
      ], 'as before the hand-made owner');
      assert.deepEqual((await call(hub.base, '/api/admin/org/issues')).body.manualOwners, []);
      assert.equal((await call(hub.base, '/api/admin/owners/dev-ann/release', { method: 'POST' })).body.error, 'not_manual');
    } finally {
      await hub.stop();
      removeAll(hub.dataFile);
      await env.cleanup();
    }
  });
}
