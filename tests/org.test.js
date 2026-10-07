'use strict';

// hub/org.js: HR announcement imports, automatic device owners, and the
// company → BU → department → team tree and filtered stats the dashboard reads.

const assert = require('node:assert/strict');
const test = require('node:test');

const { readWorkbook } = require('../hub/xlsx');
const { checkIngestPayload, normalizeOwnerEmail } = require('../hub/ingestGuard');
const { companyFromDomains, companyFromFileName, domainOf, parseAnnouncement, unitId } = require('../hub/org');
const { bearer, post, removeAll, startOverlayHub } = require('./helpers/overlayHub');
const { devicePayload, provider } = require('./helpers/fixtures');
const { announcement } = require('./helpers/xlsx');
const { BACKENDS } = require('./helpers/pg');

const ADMIN = bearer('admin-secret');
const CLIENT = bearer('client-secret');


// Games is a BU; GM Office is a department in no BU.
const ACME = [
  { no: 'ACME-1', en: 'Ann Lee', zh: '李安', bu: 'Games', department: 'Aurora', team: 'Ember Team', email: 'Ann@Example.test' },
  { no: 'ACME-2', en: 'Bo', bu: 'GAMES', department: 'AUrora', team: '3D Team', email: 'Bo@Example.TEST' },
  { no: 'ACME-3', en: 'Cy', bu: 'Games', department: 'Aurora', team: 'Aurora Department', email: 'cy@example.test' },
  { no: 'ACME-4', en: 'Di', bu: '-', department: 'GM Office', team: '-', email: 'di@example.test' },
  { no: 'ACME-5', en: 'Ed', department: 'GM Office', team: 'GM Office', email: 'ed@example.test' }
];

async function call(base, pathname, { method = 'GET', headers = ADMIN, body, type = 'application/json' } = {}) {
  const response = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': type, ...headers }, body });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

function importXlsx(base, company, workbook, headers = ADMIN) {
  return call(base, `/api/admin/org/import?company=${company}`, { method: 'POST', headers, body: workbook, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// Rows are compared as plain objects.
const plain = (rows) => rows.map((row) => ({ ...row }));

function aiAccounts(...emails) {
  return { limits: false, extra: { limits: { updatedAt: '2026-09-20T02:00:00.000Z', refreshMs: 300000, providers: emails.map((email, i) => provider({ provider: i ? 'codex' : 'claude', email })) } } };
}

test('an announcement becomes company, BU, department and team units, and nothing sensitive is read', () => {
  const sheets = readWorkbook(announcement([
    ...ACME,
    { no: 'ACME-6', en: 'No Mail', department: 'GM Office' },
    { no: 'ACME-1', en: 'Twice', department: 'GM Office', email: 'twice@example.test' },
    // A department named like its BU, and none at all: the BU's own staff. A
    // team counts only under a department.
    { no: 'ACME-8', en: 'Gus', bu: 'Games', department: 'games', team: 'X Team', email: 'gus@example.test' },
    { no: 'ACME-9', en: 'Hal', bu: 'Games', email: 'hal@example.test' },
    { no: 'ACME-10', en: 'Ivy', email: 'ivy@example.test' }
  ]));
  const parsed = parseAnnouncement(sheets, { company: 'ACME' });
  assert.deepEqual(parsed.units.map((u) => [u.id, u.level, u.parentId]), [
    ['ACME', 'company', null],
    ['ACME/Games', 'bu', 'ACME'],
    ['ACME/Games/Aurora', 'department', 'ACME/Games'],
    ['ACME/Games/Aurora/Ember Team', 'team', 'ACME/Games/Aurora'],
    ['ACME/Games/Aurora/3D Team', 'team', 'ACME/Games/Aurora'],
    ['ACME/-/GM Office', 'department', 'ACME']
  ], 'GAMES is Games and AUrora is Aurora; "-", blank, the unit\'s own name and "<department> Department" are the unit\'s own staff; a department in no BU sits under the company');
  assert.deepEqual(parsed.employees.map((e) => [e.employeeId, e.unitId]), [
    ['ACME-1', 'ACME/Games/Aurora/Ember Team'],
    ['ACME-2', 'ACME/Games/Aurora/3D Team'],
    ['ACME-3', 'ACME/Games/Aurora'],
    ['ACME-4', 'ACME/-/GM Office'],
    ['ACME-5', 'ACME/-/GM Office'],
    ['ACME-8', 'ACME/Games'],
    ['ACME-9', 'ACME/Games'],
    ['ACME-10', 'ACME']
  ]);
  assert.equal(parsed.employees[0].name, '李安 Ann Lee');
  assert.equal(parsed.employees[0].email, 'ann@example.test');
  assert.deepEqual(parsed.skipped, [{ line: 7, reason: 'email' }]);
  assert.equal(parsed.warnings.length, 1, 'a second ACME-1 is reported, not imported');
  assert.doesNotMatch(JSON.stringify(parsed), /SECRET|chat-secret|45000|Engineer/, 'grades, promotion, chat ids and titles never leave the workbook');
});

test('an email domain names a company only when one company uses it', () => {
  const domains = new Map([['initech.example', 'INITECH'], ['globex.example', 'GLOBEX']]);
  const device = (...emails) => ({ limits: { providers: emails.map((accountEmail) => ({ accountEmail })) } });
  assert.equal(domainOf('Jane.Doe@Initech.EXAMPLE'), 'initech.example');
  assert.equal(domainOf('nobody'), '');
  assert.equal(companyFromDomains(device('jane.doe@initech.example', 'me@gmail.com'), '', domains), 'INITECH', 'a personal address says nothing');
  assert.equal(companyFromDomains(device('a@initech.example', 'b@globex.example'), '', domains), null, 'two companies: no guess');
  assert.equal(companyFromDomains(device('a@initech.example', 'b@globex.example'), 'me@globex.example', domains), 'GLOBEX', 'the reported address decides');
  assert.equal(companyFromDomains(device('me@gmail.com'), '', domains), null);
  assert.equal(companyFromDomains({}, '', domains), null);
  const rules = new Map([['shared@initech.example', { other: true }]]);
  assert.equal(companyFromDomains(device('shared@initech.example'), '', domains, rules), null, 'an address an admin marked other points nowhere');
  assert.equal(companyFromDomains(device('shared@initech.example', 'b@globex.example'), '', domains, rules), 'GLOBEX');
});

test('unit ids stay a sane length and companies come from the file name', () => {
  const long = unitId(['INITECH', 'A'.repeat(140), 'B'.repeat(140)]);
  assert.equal(long.length, 255);
  assert.match(long, /^INITECH\/A{140}\/B+~[0-9a-f]{8}$/, 'the prefix is kept, the rest becomes a hash');
  assert.notEqual(long, unitId(['INITECH', 'A'.repeat(140), 'C'.repeat(140)]));
  assert.equal(unitId(['ACME', 'GM Office']), 'ACME/GM Office');
  assert.equal(companyFromFileName('INITECH Announcement 20260921.xlsx'), 'INITECH');
  assert.equal(companyFromFileName('C:\\hr\\acme list.xlsx'), 'ACME');
  assert.equal(companyFromFileName('名單.xlsx'), '');
});

for (const backend of BACKENDS) {
  test(`${backend.name}: a company's list is imported, devices get owners from the evidence, and the dashboard can filter by unit`, { skip: backend.skip }, async () => {
    const env = await backend.setup();
    const hub = await startOverlayHub({ persistenceConfig: env.persistenceConfig, publicDashboard: true });
    try {
      // A reports its user; B's only AI account is Bo's; C holds two people's
      // accounts; D will be assigned by hand; E is someone nobody knows.
      await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-a', ...aiAccounts('bo@example.test'), extra: { ownerEmail: ' ANN@example.test ' } }), CLIENT);
      // The HR list says Bo@Example.TEST and the AI account BO@example.test: the
      // same address, whatever the case.
      await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-b', ...aiAccounts('BO@example.test') }), CLIENT);
      await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-c', ...aiAccounts('cy@example.test', 'di@example.test') }), CLIENT);
      await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-d', ...aiAccounts('ed@example.test') }), CLIENT);
      await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-e', extra: { ownerEmail: 'not an email' } }), CLIENT);
      await hub.settle();
      const store = hub.overlay.persistence.store;
      assert.deepEqual(plain(await store.query('SELECT device_id, email FROM device_claims ORDER BY device_id')), [{ device_id: 'dev-a', email: 'ann@example.test' }], 'the reported email is kept, lower-cased; a malformed one is dropped');
      // dev-b was first seen well before the import.
      await store.execute('UPDATE devices SET first_seen_at = $1 WHERE device_id = $2', ['2026-09-01T08:00:00.000Z', 'dev-b']);

      assert.equal((await importXlsx(hub.base, 'ACME', announcement(ACME), CLIENT)).status, 403, 'only an admin imports');
      const bad = await importXlsx(hub.base, 'ACME', Buffer.from('plain text'));
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, 'bad_workbook');
      assert.equal((await importXlsx(hub.base, 'A_T', announcement(ACME))).body.error, 'bad_company');

      const imported = await importXlsx(hub.base, 'ACME', announcement(ACME));
      assert.equal(imported.status, 200, JSON.stringify(imported.body));
      assert.deepEqual(
        { employees: imported.body.employees, bus: imported.body.bus, departments: imported.body.departments, teams: imported.body.teams },
        { employees: 5, bus: 1, departments: 2, teams: 2 }
      );
      assert.deepEqual(
        { assigned: imported.body.reconciled.assigned, unmatched: imported.body.reconciled.unmatched, companyOnly: imported.body.reconciled.companyOnly },
        { assigned: 3, unmatched: 2, companyOnly: 2 },
        'a, b and d get owners; c is ambiguous and e unknown, but both use a domain only ACME\'s list has'
      );

      const owners = new Map((await store.query('SELECT device_id, valid_from, employee_id, unit_id, updated_by FROM device_owners WHERE valid_to IS NULL')).map((r) => [r.device_id, r]));
      assert.deepEqual([owners.get('dev-a').employee_id, owners.get('dev-a').updated_by], ['ACME-1', 'auto:reported'], 'the reported email beats the AI account');
      assert.deepEqual([owners.get('dev-b').employee_id, owners.get('dev-b').unit_id, owners.get('dev-b').updated_by], ['ACME-2', 'ACME/Games/Aurora/3D Team', 'auto:ai-email']);
      assert.equal(owners.get('dev-b').valid_from, '2026-09-01', 'a first owner is charged from the day the hub first saw the device');
      assert.equal(owners.has('dev-c'), false, 'two people\'s accounts: no guess');

      // An admin moves dev-d to Di by hand, naming only the employee: the unit
      // is Di's own. No evidence ever moves it back.
      const manual = await call(hub.base, '/api/admin/owners', { method: 'POST', body: JSON.stringify({ deviceId: 'dev-d', employeeId: 'ACME-4' }) });
      assert.equal(manual.status, 200, JSON.stringify(manual.body));
      assert.deepEqual(plain(await store.query('SELECT unit_id FROM device_owners WHERE device_id = $1 AND valid_to IS NULL', ['dev-d'])), [{ unit_id: 'ACME/-/GM Office' }]);
      await call(hub.base, '/api/admin/employees/X-1', { method: 'PUT', body: JSON.stringify({ name: 'No placement' }) });
      const unplaced = await call(hub.base, '/api/admin/owners', { method: 'POST', body: JSON.stringify({ deviceId: 'dev-e', employeeId: 'X-1' }) });
      assert.equal(unplaced.status, 400);
      assert.match(unplaced.body.message, /no unit from an HR import/);
      // dev-b's user now reports Cy's address: a stronger claim, a new range.
      await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-b', ...aiAccounts('bo@example.test'), extra: { ownerEmail: 'cy@example.test' } }), CLIENT);
      await hub.settle();
      const again = await call(hub.base, '/api/admin/org/reconcile', { method: 'POST' });
      assert.equal(again.status, 200);
      assert.equal(again.body.changed, 1);
      assert.equal(again.body.manual, 1);
      const bRanges = await store.query('SELECT valid_from, valid_to, employee_id FROM device_owners WHERE device_id = $1 ORDER BY valid_from', ['dev-b']);
      assert.deepEqual(bRanges.map((r) => r.employee_id), ['ACME-2', 'ACME-3'], 'the old owner keeps the days before the change');
      assert.equal(bRanges[0].valid_to, bRanges[1].valid_from);
      assert.equal((await store.query('SELECT employee_id, updated_by FROM device_owners WHERE device_id = $1 AND valid_to IS NULL', ['dev-d']))[0].employee_id, 'ACME-4');

      // The tree: names and counts only, for anyone the dashboard serves.
      const tree = await call(hub.base, '/api/custom/org', { headers: {} });
      assert.equal(tree.status, 200);
      assert.equal(tree.headers.get('access-control-allow-origin'), null, 'keyless: this site only');
      const byId = new Map(tree.body.units.map((u) => [u.id, u]));
      assert.deepEqual(
        [...byId.values()].map((u) => [u.id, u.level, u.devices]).sort(),
        [
          ['ACME', 'company', 5],
          ['ACME/-/GM Office', 'department', 1],
          ['ACME/Games', 'bu', 2],
          ['ACME/Games/Aurora', 'department', 2],
          ['ACME/Games/Aurora/3D Team', 'team', 0],
          ['ACME/Games/Aurora/Ember Team', 'team', 1]
        ]
      );
      assert.doesNotMatch(JSON.stringify(tree.body), /@|李安|Ann|ACME-\d/, 'no people in the tree');
      assert.equal((await call(hub.base, '/api/custom/org', { headers: CLIENT })).status, 200, 'widgets may read it too');

      // Stats for one unit hold only its devices, for a keyless reader as well.
      const at = await call(hub.base, '/api/stats?org=ACME', { headers: {} });
      assert.equal(at.status, 200);
      assert.equal(at.headers.get('access-control-allow-origin'), null);
      assert.deepEqual(at.body.devices.map((d) => d.deviceId), ['dev-a', 'dev-b', 'dev-c', 'dev-d', 'dev-e'], 'c and e count in ACME by their email domain');
      const aurora = await call(hub.base, `/api/stats?org=${encodeURIComponent('ACME/Games/Aurora')}`, { headers: CLIENT });
      assert.deepEqual(aurora.body.devices.map((d) => d.deviceId), ['dev-a', 'dev-b']);
      assert.equal(aurora.headers.get('access-control-allow-origin'), '*');
      assert.equal(aurora.body.periods.today.totalTokens, 2000, 'totals are the unit\'s own');
      assert.equal((await call(hub.base, '/api/stats?org=NOPE', { headers: {} })).status, 404);
      assert.equal((await call(hub.base, '/api/stats', { headers: {} })).body.devices.length, 5, 'without ?org the whole hub, as before');

      // The next list drops Bo and the 3D team: retired, not deleted.
      const next = await importXlsx(hub.base, 'ACME', announcement(ACME.filter((p) => p.no !== 'ACME-2')));
      assert.equal(next.body.employeesDeactivated, 1);
      assert.equal(next.body.unitsDeactivated, 1);
      assert.deepEqual((await store.query('SELECT is_active FROM employees WHERE employee_id = $1', ['ACME-2'])).map((r) => r.is_active), [false]);
      const after = await call(hub.base, '/api/custom/org', { headers: {} });
      assert.equal(after.body.units.some((u) => u.id === 'ACME/Games/Aurora/3D Team'), false, 'an inactive unit without devices leaves the tree');

      const owners2 = await call(hub.base, '/api/admin/owners?deviceId=dev-a');
      assert.equal(owners2.body.owners[0].updatedBy, 'auto:reported', 'the dashboard can show where an owner came from');
      const placed = new Map((await call(hub.base, '/api/admin/org/devices')).body.devices.map((p) => [p.deviceId, [p.unitId, p.source]]));
      assert.deepEqual(placed.get('dev-c'), ['ACME', 'domain']);
      assert.deepEqual(placed.get('dev-a'), ['ACME/Games/Aurora/Ember Team', 'owner']);
      assert.equal((await call(hub.base, '/api/admin/org/devices', { headers: {} })).status, 401, 'which device is whose is for admins');
      assert.equal(plain(await store.query('SELECT device_id FROM device_owners WHERE device_id = ANY($1)', [['dev-c', 'dev-e']])).length, 0, 'the domain writes no ownership: the reports keep them unassigned');

      // Once a second company's list uses the same domain, it no longer says
      // which company. A list of mostly another company's addresses waits for
      // a confirmation first: it may be that company's file under a wrong code.
      const nf = announcement([{ no: 'GLOBEX-1', en: 'Fay', department: 'Genome', email: 'fay@example.test' }]);
      const unsure = await importXlsx(hub.base, 'GLOBEX', nf);
      assert.equal(unsure.status, 409);
      assert.equal(unsure.body.error, 'needs_confirm');
      assert.deepEqual(unsure.body.preview.diff.warnings, [{ code: 'domain_mismatch', domain: 'example.test', company: 'ACME' }]);
      assert.equal((await call(hub.base, '/api/admin/org/import?company=GLOBEX&confirm=1', { method: 'POST', body: nf, type: 'application/octet-stream' })).status, 200);
      const shared = await call(hub.base, '/api/stats?org=ACME', { headers: {} });
      assert.deepEqual(shared.body.devices.map((d) => d.deviceId), ['dev-a', 'dev-b', 'dev-d']);
    } finally {
      await hub.stop();
      removeAll(hub.dataFile);
      await env.cleanup();
    }
  });
}

for (const backend of BACKENDS) {
  test(`${backend.name}: an admin classifies the addresses of unowned devices, and the rules decide whose the devices are`, { skip: backend.skip }, async () => {
    const env = await backend.setup();
    const hub = await startOverlayHub({ persistenceConfig: env.persistenceConfig });
    const email = (address) => `/api/admin/emails/${encodeURIComponent(address)}`;
    const rule = (address, body) => call(hub.base, email(address), { method: 'PUT', body: JSON.stringify(body) });
    const today = new Date().toISOString().slice(0, 10);
    try {
      const store = hub.overlay.persistence.store;
      const owner = async (deviceId) => (await store.query('SELECT employee_id, updated_by, valid_from, valid_to FROM device_owners WHERE device_id = $1 ORDER BY valid_from DESC LIMIT 1', [deviceId]))[0] || null;
      // P uses only Ann's personal account, Q only a vendor's; S reports Bo's
      // company address but also uses Ann's personal account.
      const withClaim = (claim, ...emails) => { const accounts = aiAccounts(...emails); return { ...accounts, extra: { ...accounts.extra, ownerEmail: claim } }; };
      await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-p', ...aiAccounts('Ann.Home@gmail.test') }), CLIENT);
      await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-q', ...aiAccounts('someone@vendor.test') }), CLIENT);
      await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-s', ...withClaim('bo@example.test', 'ann.home@gmail.test') }), CLIENT);
      await hub.settle();
      assert.equal((await importXlsx(hub.base, 'ACME', announcement(ACME))).status, 200);
      assert.equal((await owner('dev-s')).employee_id, 'ACME-2', 'the reported address: Bo');

      const unclassified = await call(hub.base, '/api/admin/emails/unclassified');
      assert.equal(unclassified.status, 200);
      assert.deepEqual(unclassified.body.emails.map((e) => [e.email, e.devices.map((d) => d.deviceId), e.recentTokens, e.employee, e.company]), [
        ['ann.home@gmail.test', ['dev-p'], 1000, null, null],
        ['someone@vendor.test', ['dev-q'], 1000, null, null]
      ], 'only addresses on devices without an owner; dev-s is owned');
      assert.equal((await call(hub.base, '/api/admin/emails/unclassified', { headers: CLIENT })).status, 403);
      assert.equal((await call(hub.base, '/api/admin/emails/unclassified', { headers: {} })).status, 401);

      // Ann's personal address is Ann's: dev-p is hers from its first day. The
      // HR list still comes first: dev-s reports Bo's listed address and stays Bo's.
      const ann = await rule('ann.home@gmail.test', { employeeId: 'ACME-1', note: 'personal account' });
      assert.equal(ann.status, 200, JSON.stringify(ann.body));
      assert.deepEqual([ann.body.email, ann.body.employeeId, ann.body.other], ['ann.home@gmail.test', 'ACME-1', false]);
      assert.deepEqual([ann.body.reconciled.assigned, ann.body.reconciled.changed], [1, 0]);
      assert.deepEqual([(await owner('dev-p')).employee_id, (await owner('dev-p')).updated_by], ['ACME-1', 'auto:email-assigned']);
      assert.equal((await owner('dev-s')).employee_id, 'ACME-2');
      assert.equal((await rule('bo@example.test', { other: true })).body.error, 'listed_in_hr', 'an address on the HR list gets no rule');

      // The vendor's address is nobody's on the list: dev-q stays other, and
      // the address leaves the list to classify.
      assert.equal((await rule('someone@vendor.test', { other: true })).status, 200);
      assert.equal(await owner('dev-q'), null);
      assert.deepEqual((await call(hub.base, '/api/admin/emails/unclassified')).body.emails, []);
      // A device assigned by hand stays where the admin put it.
      assert.equal((await call(hub.base, '/api/admin/owners', { method: 'POST', body: JSON.stringify({ deviceId: 'dev-q', employeeId: 'ACME-5' }) })).status, 200);
      assert.equal((await rule('someone@vendor.test', { employeeId: 'ACME-2' })).body.reconciled.manual, 1);
      assert.equal((await owner('dev-q')).employee_id, 'ACME-5');

      // Ann's address was a mistake after all: the owner it made ends today.
      const undone = await rule('ann.home@gmail.test', { other: true });
      assert.deepEqual([undone.body.reconciled.withdrawn, undone.body.reconciled.changed], [1, 0]);
      const p = await owner('dev-p');
      assert.deepEqual([p.employee_id, p.valid_to], ['ACME-1', today > p.valid_from ? today : p.valid_from], 'Ann keeps the days before today');
      assert.equal((await owner('dev-s')).employee_id, 'ACME-2');

      assert.deepEqual((await call(hub.base, '/api/admin/emails')).body.emails.map((e) => [e.email, e.employeeId, e.employeeName, e.other, e.updatedBy]), [
        ['ann.home@gmail.test', null, null, true, 'admin'],
        ['someone@vendor.test', 'ACME-2', 'Bo', false, 'admin']
      ]);
      assert.equal((await call(hub.base, email('someone@vendor.test'), { method: 'DELETE' })).status, 200);
      assert.equal((await call(hub.base, email('someone@vendor.test'), { method: 'DELETE' })).status, 404);

      assert.equal((await rule('x@vendor.test', {})).status, 400, 'an employee or other');
      assert.equal((await rule('x@vendor.test', { employeeId: 'ACME-1', other: true })).status, 400);
      assert.equal((await rule('x@vendor.test', { employeeId: 'NOPE' })).body.error, 'unknown_employee');
      assert.equal((await rule('not-an-address', { other: true })).body.error, 'bad_email');
    } finally {
      await hub.stop();
      removeAll(hub.dataFile);
      await env.cleanup();
    }
  });
}

test('an upload\'s ownerEmail is kept lower-cased, and a bad one dropped without refusing the upload', () => {
  const check = (ownerEmail) => checkIngestPayload(devicePayload({ extra: { ownerEmail } }), { receivedAtMs: Date.now() }).payload.ownerEmail;
  assert.equal(check(' Jane.Doe@Initech.EXAMPLE '), 'jane.doe@initech.example');
  assert.equal(check('jane.doe'), undefined);
  assert.equal(check(`${'a'.repeat(250)}@x.test`), undefined, 'longer than an address can be');
  assert.equal(check(42), undefined);
  assert.equal(normalizeOwnerEmail('a@b.c'), 'a@b.c');
  assert.equal(normalizeOwnerEmail('a b@c.d'), '');
});

test('a hub without a database has no org tree and no filtered stats', async () => {
  const hub = await startOverlayHub({ publicDashboard: true });
  try {
    const tree = await call(hub.base, '/api/custom/org', { headers: {} });
    assert.deepEqual(tree.body, { ok: true, units: [] });
    assert.equal((await call(hub.base, '/api/stats?org=ACME', { headers: {} })).status, 404);
    assert.equal((await importXlsx(hub.base, 'ACME', announcement(ACME))).status, 503);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});
