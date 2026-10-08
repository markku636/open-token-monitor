'use strict';

// The roster an admin keeps without HR announcements: the Excel template
// (員工編號, 姓名, Email, 部門) and the rows edited on the dashboard, both
// imported the way an announcement is (hub/org.js importRoster, admin.js).

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseAnnouncement } = require('../hub/org');
const { readWorkbook } = require('../hub/xlsx');
const { bearer, removeAll, startOverlayHub } = require('./helpers/overlayHub');
const { announcement, buildXlsx } = require('./helpers/xlsx');
const { BACKENDS } = require('./helpers/pg');

const ADMIN = bearer('admin-secret');
const CLIENT = bearer('client-secret');

async function call(base, pathname, { method = 'GET', headers = ADMIN, body, type = 'application/json' } = {}) {
  const response = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': type, ...headers }, body });
  const buffer = Buffer.from(await response.arrayBuffer());
  let json;
  try { json = JSON.parse(buffer.toString('utf8')); } catch (_) { json = null; }
  return { status: response.status, headers: response.headers, body: json, buffer };
}

const rosterJson = (rows) => JSON.stringify({ rows });

test('the template\'s columns are read in Chinese, with one name column', () => {
  const sheets = readWorkbook(buildXlsx([{ name: '名單', rows: [
    ['員工編號', '姓名', 'Email', '部門'],
    ['0012', '王小明', 'ming@example.test', '研發部'],
    ['0013', '陳小華', 'hua@example.test', ''],
    ['', '', '', '']
  ] }]));
  const parsed = parseAnnouncement(sheets, { company: 'ACME' });
  assert.deepEqual(parsed.employees, [
    { employeeId: '0012', name: '王小明', email: 'ming@example.test', unitId: 'ACME/-/研發部' },
    { employeeId: '0013', name: '陳小華', email: 'hua@example.test', unitId: 'ACME' }
  ], 'no department: directly under the company');
  assert.deepEqual(parsed.units.map((u) => [u.id, u.level]), [['ACME', 'company'], ['ACME/-/研發部', 'department']]);
});

for (const backend of BACKENDS) {
  test(`${backend.name}: an admin keeps a roster on the dashboard and in the Excel template`, { skip: backend.skip }, async () => {
    const env = await backend.setup();
    const hub = await startOverlayHub({ persistenceConfig: env.persistenceConfig });
    try {
      // A new company: an empty template, and an empty roster.
      const empty = await call(hub.base, '/api/admin/org/roster.xlsx?company=ACME');
      assert.equal(empty.status, 200);
      assert.equal(empty.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      assert.match(empty.headers.get('content-disposition'), /^attachment; filename="ACME-roster\.xlsx"; filename\*=UTF-8''ACME%20%E5%90%8D%E5%96%AE\.xlsx$/);
      const blank = readWorkbook(empty.buffer);
      assert.deepEqual(blank.map((s) => s.name), ['名單', '說明']);
      assert.deepEqual(blank[0].rows.map((r) => r.cells), [{ A: '員工編號', B: '姓名', C: 'Email', D: '部門' }]);
      assert.deepEqual((await call(hub.base, '/api/admin/org/roster?company=ACME')).body.rows, []);

      // Rows from the dashboard: previewed, then imported.
      const rows = [
        { employeeId: 'A1', name: 'Ann', email: 'ann@example.test', department: 'Sales' },
        { employeeId: 'A2', name: 'Bo', email: 'BO@example.test', department: 'sales' },
        { employeeId: 'A3', name: 'Cy', email: 'cy@example.test', department: '' },
        { employeeId: 'A4', name: 'No mail', email: '', department: 'Sales' }
      ];
      const preview = await call(hub.base, '/api/admin/org/roster/preview?company=ACME', { method: 'POST', body: rosterJson(rows) });
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.deepEqual([preview.body.dryRun, preview.body.employees, preview.body.departments, preview.body.diff.joined.length], [true, 3, 1, 3]);
      assert.deepEqual(preview.body.skipped, [{ line: 4, reason: 'email' }], 'line numbers are the rows\' own');
      assert.equal((await call(hub.base, '/api/admin/org/roster?company=ACME')).body.rows.length, 0, 'a preview writes nothing');
      const done = await call(hub.base, '/api/admin/org/roster?company=ACME', { method: 'POST', body: rosterJson(rows) });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      const after = (await call(hub.base, '/api/admin/org/roster?company=ACME')).body;
      assert.deepEqual(after, { ok: true, company: 'ACME', rows: [
        { employeeId: 'A1', name: 'Ann', email: 'ann@example.test', department: 'Sales', bu: '', team: '' },
        { employeeId: 'A2', name: 'Bo', email: 'bo@example.test', department: 'Sales', bu: '', team: '' },
        { employeeId: 'A3', name: 'Cy', email: 'cy@example.test', department: '', bu: '', team: '' }
      ] });

      // The same roster back unchanged changes nothing; dropping a row retires
      // that person.
      const same = await call(hub.base, '/api/admin/org/roster/preview?company=ACME', { method: 'POST', body: rosterJson(after.rows) });
      assert.deepEqual([same.body.diff.unchanged, same.body.diff.joined.length, same.body.diff.departed.length], [3, 0, 0]);
      const fewer = await call(hub.base, '/api/admin/org/roster?company=ACME', { method: 'POST', body: rosterJson(after.rows.slice(0, 2)) });
      assert.equal(fewer.status, 200, JSON.stringify(fewer.body));
      assert.equal(fewer.body.employeesDeactivated, 1);

      // The template now lists the roster, as text, and imports as it is.
      const filled = await call(hub.base, '/api/admin/org/roster.xlsx?company=ACME&lang=en');
      const sheets = readWorkbook(filled.buffer);
      assert.deepEqual(sheets.map((s) => s.name), ['Roster', 'Notes']);
      assert.deepEqual(sheets[0].rows.map((r) => Object.values(r.cells)), [
        ['Employee No.', 'Name', 'Email', 'Department'], ['A1', 'Ann', 'ann@example.test', 'Sales'], ['A2', 'Bo', 'bo@example.test', 'Sales']
      ]);
      const back = await call(hub.base, '/api/admin/org/import/preview?company=ACME&fileName=ACME-roster.xlsx', { method: 'POST', body: filled.buffer, type: 'application/octet-stream' });
      assert.deepEqual([back.status, back.body.diff.unchanged], [200, 2]);

      // A company that had BUs and teams keeps them: they are in its roster
      // and template, so saving it back moves nobody.
      const hr = await call(hub.base, '/api/admin/org/import?company=GLOBEX&fileName=GLOBEX.xlsx', {
        method: 'POST', type: 'application/octet-stream',
        body: announcement([{ no: 'G1', en: 'Gil', bu: 'Labs', department: 'Genome', team: 'Seq Team', email: 'gil@globex.test' }])
      });
      assert.equal(hr.status, 200, JSON.stringify(hr.body));
      const globex = (await call(hub.base, '/api/admin/org/roster?company=GLOBEX')).body.rows;
      assert.deepEqual(globex, [{ employeeId: 'G1', name: 'Gil', email: 'gil@globex.test', department: 'Genome', bu: 'Labs', team: 'Seq Team' }]);
      const kept = await call(hub.base, '/api/admin/org/roster/preview?company=GLOBEX', { method: 'POST', body: rosterJson(globex) });
      assert.deepEqual([kept.body.diff.unchanged, kept.body.diff.unitsAdded.length, kept.body.diff.unitsDeactivated.length], [1, 0, 0]);
      const template = readWorkbook((await call(hub.base, '/api/admin/org/roster.xlsx?company=GLOBEX')).buffer);
      assert.deepEqual(Object.values(template[0].rows[0].cells), ['員工編號', '姓名', 'Email', '部門', 'BU', '團隊']);

      // Bad input, and the client key.
      assert.equal((await call(hub.base, '/api/admin/org/roster?company=ACME', { method: 'POST', body: '{"rows":"no"}' })).status, 400);
      assert.equal((await call(hub.base, '/api/admin/org/roster?company=acme corp')).body.error, 'bad_company');
      assert.equal((await call(hub.base, '/api/admin/org/roster?company=ACME', { method: 'POST', body: rosterJson([]) })).body.error, 'bad_workbook');
      assert.equal((await call(hub.base, '/api/admin/org/roster?company=ACME', { headers: CLIENT })).status, 403);
    } finally {
      await hub.stop();
      removeAll(hub.dataFile);
      await env.cleanup();
    }
  });
}
