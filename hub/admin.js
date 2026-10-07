'use strict';

// Organisation data behind the reports (組織管理 API). Admin key only.
//
//   GET  /api/admin/units                PUT /api/admin/units/:id
//   GET  /api/admin/employees            PUT /api/admin/employees/:id
//        (with a database: each one's unit, devices and last 30 days too)
//   GET  /api/admin/owners[?deviceId=]   POST /api/admin/owners
//   DELETE /api/admin/owners/:deviceId/:validFrom
//   POST /api/admin/owners/:deviceId/release  (a hand-made owner back to automatic)
//   POST /api/admin/org/import/preview?company=ACME&fileName=  (what an import would change)
//   POST /api/admin/org/import?company=ACME&fileName=&effectiveFrom=&confirm=1
//        &dropSupersededRules=1&keepOldEmails=1  (an HR announcement .xlsx, org.js)
//   POST /api/admin/org/reconcile           (assign devices to employees now)
//   GET  /api/admin/org/devices             (where each device counts, and why,
//                                            and its first day)
//   GET  /api/admin/org/imports[?company=]  (each company's last HR import, its history)
//   GET  /api/admin/org/units               (every unit with headcount, devices, 30 days)
//   GET  /api/admin/org/issues              (conflicts, departed owners, stale rules, hand-made owners)
//   GET  /api/admin/emails                  (the email rules an admin wrote)
//   GET  /api/admin/emails/unclassified     (addresses on unowned devices, no rule yet)
//   PUT  /api/admin/emails/:email           { unitId }, { employeeId } or { other: true }, note
//   DELETE /api/admin/emails/:email
//   GET  /api/admin/api-tokens               POST /api/admin/api-tokens { name, expiresAt? }
//   DELETE /api/admin/api-tokens/:id         (revoke)
//   GET  /api/admin/backups                  POST /api/admin/backups  (backups.js)
//   GET  /api/admin/backups/:name            (the file)   DELETE /api/admin/backups/:name
//   GET  /api/admin/usage-purge              GET /api/admin/usage-purge/preview?month=YYYY-MM
//   POST /api/admin/usage-purge { month, confirm }  (delete all usage before a month, purge.js)
//
// Device ownership is kept as date ranges (SCD-2): assigning a device from a
// date closes the range that was open and starts a new one, so the reports can
// charge each day to whoever held the device then. Ranges of one device never
// overlap; the report views rely on it, and this module is what enforces it.

const { upstream } = require('../upstream');
const { readJsonBody, sendJson } = require(upstream('src/shared/http'));
const { fromDbTime, toDbTime } = require('./persistence/util');
const { LEVELS, levelBelow, levelIndex } = require('./units');
const { BackupError } = require('./backups');
const { PurgeError } = require('./purge');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// `details` are extra fields of the error answer (an import's preview when it
// needs confirming).
class AdminError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function validDay(value) {
  if (!DAY_RE.test(String(value || ''))) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : null;
}

function requireText(value, name, max) {
  const text = String(value ?? '').trim();
  if (!text) throw new AdminError(400, 'bad_request', `${name} is required`);
  if (text.length > max) throw new AdminError(400, 'bad_request', `${name} is longer than ${max} characters`);
  return text;
}

function isFalse(value) {
  return value === false || value === 0 || ['0', 'false', 'no', 'off'].includes(String(value ?? '').trim().toLowerCase());
}

function optionalText(value, max) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

function readBody(req, maxBytes, what) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new AdminError(413, 'payload_too_large', `${what} larger than ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Who made a change, for updated_by: the actor a script names, else the
// dashboard session it was made in, else the role.
function actorOf(req, meta) {
  const actor = String(req.headers['x-token-monitor-actor'] || '').trim().slice(0, 200);
  if (actor) return `${meta?.role || 'admin'}:${actor}`;
  if (meta?.session) return `${meta.role || 'admin'}:session-${meta.session}`;
  return meta?.role || 'admin';
}

// Starts a device's ownership range at validFrom (today by default), closing
// the range that was open. Shared with the automatic assignment in org.js, so
// both keep ranges from overlapping the same way.
async function assignOwner(runner, body, actor, now = () => Date.now()) {
  const deviceId = requireText(body.deviceId ?? body.device_id, 'deviceId', 191);
  let unitId = optionalText(body.unitId ?? body.unit_id, 255);
  // A unit alone charges the device to that unit with no employee (an email
  // rule for a department or team, org.js).
  const employeeId = unitId && !(body.employeeId ?? body.employee_id) ? null : requireText(body.employeeId ?? body.employee_id, 'employeeId', 64);
  const validFrom = validDay(body.validFrom ?? body.valid_from ?? new Date(now()).toISOString().slice(0, 10));
  if (!validFrom) throw new AdminError(400, 'bad_request', 'validFrom must be YYYY-MM-DD');
  if (employeeId) {
    const [employee] = await runner.all('SELECT employee_id FROM employees WHERE employee_id = $1', [employeeId]);
    if (!employee) throw new AdminError(400, 'unknown_employee', `employee ${employeeId} does not exist`);
  }
  // Without a unit, the one the employee's HR announcement placed them in
  // (org.js), so an admin assigning a device only needs the employee no.
  if (!unitId) {
    const [placement] = await runner.all('SELECT unit_id FROM employee_placements WHERE employee_id = $1', [employeeId]);
    if (!placement) {
      throw new AdminError(400, 'bad_request', `unitId is required: employee ${employeeId} has no unit from an HR import`);
    }
    unitId = placement.unit_id;
  }
  const [unit] = await runner.all('SELECT unit_id FROM org_units WHERE unit_id = $1', [unitId]);
  if (!unit) throw new AdminError(400, 'unknown_unit', `unit ${unitId} does not exist`);

  const ranges = await runner.all('SELECT valid_from, valid_to FROM device_owners WHERE device_id = $1 ORDER BY valid_from', [deviceId]);
  const latest = ranges[ranges.length - 1];
  const note = optionalText(body.note, 255);
  const stamp = toDbTime(now());
  if (latest && validFrom < latest.valid_from) {
    throw new AdminError(409, 'overlap', `validFrom must be on or after ${latest.valid_from}, the start of the device's latest ownership range`);
  }
  if (latest && validFrom === latest.valid_from) {
    await runner.run('UPDATE device_owners SET employee_id = $1, unit_id = $2, note = $3, updated_by = $4, updated_at = $5 WHERE device_id = $6 AND valid_from = $7', [
      employeeId, unitId, note, actor, stamp, deviceId, validFrom
    ]);
    return { deviceId, validFrom, replaced: true };
  }
  if (latest && (latest.valid_to === null || latest.valid_to > validFrom)) {
    await runner.run('UPDATE device_owners SET valid_to = $1, updated_by = $2, updated_at = $3 WHERE device_id = $4 AND valid_from = $5', [
      validFrom, actor, stamp, deviceId, latest.valid_from
    ]);
  }
  await runner.run('INSERT INTO device_owners (device_id, valid_from, valid_to, employee_id, unit_id, note, updated_by, updated_at) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)', [
    deviceId, validFrom, employeeId, unitId, note, actor, stamp
  ]);
  return { deviceId, validFrom, replaced: false };
}

// `org` (org.js) answers /api/admin/org/*, and hears about every ownership
// change so its dashboard index follows manual assignments at once.
function createAdmin({ store = null, now = () => Date.now(), org = null, apiTokens = null, backups = null, purge = null } = {}) {
  const ownersChanged = () => org?.refresh().catch(() => {});
  // A root is a company. Under a parent a unit is one level further down
  // unless the body names a deeper one (a department right under a company,
  // for one with no BU).
  async function upsertUnit(runner, id, body) {
    const unitId = requireText(id, 'unitId', 255);
    const parent = optionalText(body.parentUnitId ?? body.parent_unit_id, 255);
    if (parent === unitId) throw new AdminError(400, 'bad_request', 'a unit cannot be its own parent');
    const asked = optionalText(body.level, 32);
    if (asked && levelIndex(asked) < 0) throw new AdminError(400, 'bad_request', `level must be one of ${LEVELS.join(', ')}`);
    let level = LEVELS[0];
    if (parent) {
      const [row] = await runner.all('SELECT level FROM org_units WHERE unit_id = $1', [parent]);
      if (!row) throw new AdminError(400, 'unknown_unit', `unit ${parent} does not exist`);
      level = asked || levelBelow(row.level);
      if (!level || levelIndex(level) <= levelIndex(row.level)) {
        throw new AdminError(400, 'bad_request', `a unit under a ${row.level} must be of a level below it`);
      }
    } else if (asked && asked !== LEVELS[0]) {
      throw new AdminError(400, 'bad_request', 'a unit without a parent is a company');
    }
    await runner.run(store.upsertSql('org_units', ['unit_id', 'name', 'cost_center', 'parent_unit_id', 'level', 'is_active', 'updated_at'], ['unit_id']), [
      unitId,
      requireText(body.name, 'name', 255),
      optionalText(body.costCenter ?? body.cost_center, 64),
      parent,
      level,
      !isFalse(body.active),
      toDbTime(now())
    ]);
  }

  async function upsertEmployee(runner, id, body) {
    const email = optionalText(body.email, 255);
    await runner.run(store.upsertSql('employees', ['employee_id', 'name', 'email', 'is_active', 'updated_at'], ['employee_id']), [
      requireText(id, 'employeeId', 64),
      requireText(body.name, 'name', 255),
      email ? email.toLowerCase() : null,
      !isFalse(body.active),
      toDbTime(now())
    ]);
  }

  // Removing the latest range reopens the one before it, so the device is
  // charged as it was before the mistaken assignment.
  async function removeOwner(runner, deviceId, validFrom, actor) {
    const ranges = await runner.all('SELECT valid_from, valid_to FROM device_owners WHERE device_id = $1 ORDER BY valid_from', [deviceId]);
    const latest = ranges[ranges.length - 1];
    if (!latest || latest.valid_from !== validFrom) {
      throw new AdminError(409, 'not_latest', 'only the latest ownership range of a device can be removed');
    }
    await runner.run('DELETE FROM device_owners WHERE device_id = $1 AND valid_from = $2', [deviceId, validFrom]);
    const previous = ranges[ranges.length - 2];
    if (previous && previous.valid_to === validFrom) {
      await runner.run('UPDATE device_owners SET valid_to = NULL, updated_by = $1, updated_at = $2 WHERE device_id = $3 AND valid_from = $4', [
        actor, toDbTime(now()), deviceId, previous.valid_from
      ]);
    }
  }

  async function listOwners(url) {
    const deviceId = url.searchParams.get('deviceId');
    const rows = await store.query(
      `SELECT o.device_id, o.valid_from, o.valid_to, o.employee_id, e.name AS employee_name, o.unit_id, u.name AS unit_name, u.level AS unit_level,
              o.note, o.updated_by, o.updated_at, dev.hostname
       FROM device_owners o
       LEFT JOIN employees e ON e.employee_id = o.employee_id
       LEFT JOIN org_units u ON u.unit_id = o.unit_id
       LEFT JOIN devices dev ON dev.device_id = o.device_id
       ${deviceId ? 'WHERE o.device_id = $1' : ''}
       ORDER BY o.device_id, o.valid_from`,
      deviceId ? [deviceId] : []
    );
    return rows.map((row) => ({
      deviceId: row.device_id,
      hostname: row.hostname || null,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      unitId: row.unit_id,
      unitName: row.unit_name,
      unitLevel: row.unit_level,
      note: row.note,
      updatedBy: row.updated_by,
      updatedAt: fromDbTime(row.updated_at)
    }));
  }

  async function route(req, res, url, meta) {
    const parts = url.pathname.split('/').slice(3).map((part) => decodeURIComponent(part));
    const [resource, id, extra] = parts;
    const method = req.method;
    const actor = actorOf(req, meta);

    if (resource === 'units' && !id && method === 'GET') {
      const rows = await store.query('SELECT unit_id, name, cost_center, parent_unit_id, level, is_active, updated_at FROM org_units ORDER BY unit_id');
      return sendJson(res, 200, { ok: true, units: rows.map((r) => ({ unitId: r.unit_id, name: r.name, level: r.level, parentUnitId: r.parent_unit_id, costCenter: r.cost_center, active: r.is_active === true, updatedAt: fromDbTime(r.updated_at) })) });
    }
    if (resource === 'units' && id && method === 'PUT') {
      const body = await readJsonBody(req);
      await store.transaction((tx) => upsertUnit(tx, id, body || {}));
      ownersChanged();
      return sendJson(res, 200, { ok: true, unitId: id });
    }
    if (resource === 'employees' && !id && method === 'GET' && org) {
      return sendJson(res, 200, { ok: true, employees: (await org.employeeList()).map((e) => ({ ...e, updatedAt: fromDbTime(e.updatedAt) })) });
    }
    if (resource === 'employees' && !id && method === 'GET') {
      const rows = await store.query('SELECT employee_id, name, email, is_active, updated_at FROM employees ORDER BY employee_id');
      return sendJson(res, 200, { ok: true, employees: rows.map((r) => ({ employeeId: r.employee_id, name: r.name, email: r.email, active: r.is_active === true, updatedAt: fromDbTime(r.updated_at) })) });
    }
    if (resource === 'employees' && id && method === 'PUT') {
      const body = await readJsonBody(req);
      await store.transaction((tx) => upsertEmployee(tx, id, body || {}));
      return sendJson(res, 200, { ok: true, employeeId: id });
    }
    if (resource === 'owners' && !id && method === 'GET') {
      return sendJson(res, 200, { ok: true, owners: await listOwners(url) });
    }
    if (resource === 'owners' && !id && method === 'POST') {
      const body = await readJsonBody(req);
      const result = await store.transaction((tx) => assignOwner(tx, body || {}, actor, now));
      ownersChanged();
      return sendJson(res, 200, { ok: true, ...result });
    }
    if (resource === 'owners' && id && extra === 'release' && method === 'POST') {
      if (!org) throw new AdminError(503, 'store_unavailable', 'org data needs a database');
      return sendJson(res, 200, { ok: true, ...(await org.releaseManualOwner(id)) });
    }
    if (resource === 'owners' && id && extra && method === 'DELETE') {
      await store.transaction((tx) => removeOwner(tx, id, extra, actor));
      ownersChanged();
      return sendJson(res, 200, { ok: true, deviceId: id, validFrom: extra });
    }
    // One company's HR announcement workbook, as that company's latest list.
    // With /preview, only what importing it would change.
    if (resource === 'org' && id === 'import' && (!extra || extra === 'preview') && method === 'POST') {
      if (!org) throw new AdminError(503, 'store_unavailable', 'org import needs a database');
      const workbook = await readBody(req, org.maxWorkbookBytes, 'workbook');
      const q = url.searchParams;
      const yes = (name) => ['1', 'true', 'yes'].includes(String(q.get(name) || '').toLowerCase());
      return sendJson(res, 200, { ok: true, ...(await org.importCompany(workbook, {
        company: q.get('company'),
        fileName: q.get('fileName'),
        effectiveFrom: q.get('effectiveFrom'),
        dryRun: extra === 'preview',
        confirm: yes('confirm'),
        dropSupersededRules: yes('dropSupersededRules'),
        keepOldEmails: yes('keepOldEmails'),
        actor
      })) });
    }
    if (resource === 'org' && org && method === 'GET') {
      if (id === 'units' && !extra) return sendJson(res, 200, { ok: true, units: await org.unitStats() });
      if (id === 'issues' && !extra) return sendJson(res, 200, { ok: true, ...(await org.issues()) });
    }
    // Where each current device counts in the org tree, and why (owner or
    // domain), and its first day: the default start of a first owner.
    if (resource === 'org' && id === 'devices' && method === 'GET') {
      return sendJson(res, 200, { ok: true, devices: org ? await org.placements() : [] });
    }
    // Tokens for other systems (apiTokens.js). The token itself is in the
    // answer to the POST only.
    if (resource === 'api-tokens') {
      if (!apiTokens) throw new AdminError(503, 'store_unavailable', 'API tokens need a database');
      if (!id && method === 'GET') return sendJson(res, 200, { ok: true, tokens: await apiTokens.list() });
      if (!id && method === 'POST') return sendJson(res, 201, { ok: true, ...(await apiTokens.create((await readJsonBody(req)) || {}, actor)) });
      if (id && !extra && method === 'DELETE') return sendJson(res, 200, { ok: true, ...(await apiTokens.revoke(id, actor)) });
    }
    // The database's dumps (backups.js): the file itself answers a GET by name.
    if (resource === 'backups' && !extra) {
      if (!backups) throw new AdminError(503, 'backup_unavailable', 'backups need a database', { reason: 'no_database' });
      if (!id && method === 'GET') return sendJson(res, 200, { ok: true, ...(await backups.status()), backups: await backups.list() });
      if (!id && method === 'POST') return sendJson(res, 201, { ok: true, backup: await backups.create('manual', actor) });
      if (id && method === 'GET') return backups.send(res, id, actor);
      if (id && method === 'DELETE') return sendJson(res, 200, { ok: true, ...(await backups.remove(id, actor)) });
    }
    // 刪除歷史資料 (purge.js): what is there, what a purge would delete, and
    // the purge itself, which backs up first.
    if (resource === 'usage-purge' && !extra && purge) {
      if (!id && method === 'GET') return sendJson(res, 200, { ok: true, ...(await purge.state()) });
      if (id === 'preview' && method === 'GET') return sendJson(res, 200, { ok: true, ...(await purge.preview(url.searchParams.get('month'))) });
      if (!id && method === 'POST') return sendJson(res, 200, { ok: true, ...(await purge.run((await readJsonBody(req)) || {}, actor)) });
    }
    // An admin's rule for an email address (org.js): whose its devices are.
    if (resource === 'emails') {
      if (!org) throw new AdminError(503, 'store_unavailable', 'email rules need a database');
      if (!id && method === 'GET') return sendJson(res, 200, { ok: true, emails: await org.emailRuleList() });
      if (id === 'unclassified' && !extra && method === 'GET') return sendJson(res, 200, { ok: true, emails: await org.unclassifiedEmails() });
      if (id && !extra && method === 'PUT') {
        const body = (await readJsonBody(req)) || {};
        return sendJson(res, 200, { ok: true, ...(await org.setEmailRule(id, { employeeId: body.employeeId, unitId: body.unitId, other: body.other === true, note: body.note }, actor)) });
      }
      if (id && !extra && method === 'DELETE') return sendJson(res, 200, { ok: true, ...(await org.removeEmailRule(id)) });
    }
    if (resource === 'org' && id === 'imports' && method === 'GET') {
      if (!org) throw new AdminError(503, 'store_unavailable', 'org import needs a database');
      return sendJson(res, 200, { ok: true, ...(await org.importHistory({ company: url.searchParams.get('company') || '' })) });
    }
    if (resource === 'org' && id === 'reconcile' && method === 'POST') {
      if (!org) throw new AdminError(503, 'store_unavailable', 'org reconcile needs a database');
      return sendJson(res, 200, { ok: true, ...(await org.reconcile()) });
    }
    return sendJson(res, 404, { error: 'not_found' });
  }

  return {
    async handle(req, res, url, meta) {
      if (!store) {
        return sendJson(res, 503, { error: 'store_unavailable', message: 'organisation data needs a database: set TOKEN_MONITOR_DATABASE_URL' });
      }
      try {
        return await route(req, res, url, meta);
      } catch (error) {
        if (error instanceof AdminError || error instanceof BackupError || error instanceof PurgeError) return sendJson(res, error.status, { ...(error.details || {}), error: error.code, message: error.message });
        // A malformed %-escape in the path (decodeURIComponent).
        if (error instanceof URIError) return sendJson(res, 400, { error: 'bad_request', message: error.message });
        if (error.code === 'payload_too_large') return sendJson(res, 413, { error: 'payload_too_large', message: error.message });
        if (/Invalid JSON body/.test(error.message)) return sendJson(res, 400, { error: 'bad_request', message: error.message });
        // SQLSTATE 23: a foreign key, unique or check constraint said no.
        if (/^23/.test(String(error.code || ''))) return sendJson(res, 409, { error: 'constraint', message: error.message });
        if (/^22/.test(String(error.code || ''))) return sendJson(res, 400, { error: 'bad_request', message: error.message });
        throw error;
      }
    }
  };
}

module.exports = { AdminError, assignOwner, createAdmin, validDay };
