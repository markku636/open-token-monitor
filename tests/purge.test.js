'use strict';

// hub/purge.js and the store's floor: 刪除歷史資料 deletes every device's
// usage before a month, after its own backup, and the usage devices keep
// re-sending from their own history never comes back.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { bearer, post, removeAll, startOverlayHub } = require('./helpers/overlayHub');
const { dayKey, devicePayload, historyDay, historyMonth } = require('./helpers/fixtures');

const ADMIN = bearer('admin-secret');
const CLIENT = bearer('client-secret');
const DATABASE_URL = 'postgres://token_monitor:pw@db:5432/token_monitor';

// YYYY-MM n months before this one.
function monthsAgo(n) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1)).toISOString().slice(0, 7);
}

const M1 = monthsAgo(1);
const M2 = monthsAgo(2);
const M3 = monthsAgo(3);
const M4 = monthsAgo(4);

// Daily history on the 15th of the three months before this one, monthly
// history for the four before it.
function oldHistory({ tokens = 800 } = {}) {
  return {
    daily: [M3, M2, M1].map((month) => historyDay(`${month}-15`, { tokens })),
    monthly: [M4, M3, M2, M1].map((month) => historyMonth(month)),
    summary: {}
  };
}

function backupStub() {
  const made = [];
  let fail = false;
  return {
    made,
    failNext() { fail = true; },
    options: (dir) => ({
      dir,
      databaseUrl: DATABASE_URL,
      probe: async () => ({ ok: true }),
      runDump: async (command) => {
        if (fail) {
          fail = false;
          throw new Error('pg_dump: connection refused');
        }
        const file = command.args.find((arg) => arg.startsWith('--file=')).slice('--file='.length);
        fs.writeFileSync(file, 'PGDMP');
        made.push(path.basename(file).replace(/\.partial$/, ''));
      }
    })
  };
}

async function call(base, pathname, { method = 'GET', headers = ADMIN, body } = {}) {
  const response = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function counts(store) {
  const one = async (sql) => Number((await store.query(sql))[0].n);
  return {
    days: (await store.query('SELECT usage_date FROM device_daily_usage ORDER BY usage_date')).map((r) => String(r.usage_date).slice(0, 10)),
    months: (await store.query('SELECT usage_month FROM device_monthly_usage ORDER BY usage_month')).map((r) => r.usage_month),
    dayClients: await one('SELECT COUNT(*) AS n FROM device_daily_client_usage'),
    monthModels: await one('SELECT COUNT(*) AS n FROM device_monthly_model_usage')
  };
}

test('刪除歷史資料 previews, backs up, deletes before the month, and the floor holds against every re-upload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tm-purge-${process.pid}-`));
  const backups = backupStub();
  let hub = await startOverlayHub({ database: true, streamWindowMs: 60 * 1000, backup: backups.options(dir) });
  try {
    assert.equal((await post(hub.base, '/api/ingest', devicePayload({ history: oldHistory() }), CLIENT)).status, 200);
    await hub.settle();
    const store = () => hub.overlay.persistence.store;
    const before = await counts(store());
    assert.deepEqual(before.days, [`${M3}-15`, `${M2}-15`, `${M1}-15`, dayKey(0)].sort());
    assert.deepEqual(before.months, [M4, M3, M2, M1, dayKey(0).slice(0, 7)]);

    const usagePath = `/api/custom/usage?from=${M3}-01&to=${dayKey(0)}&granularity=month&focus=range`;
    const usageBefore = (await call(hub.base, usagePath)).body;

    const state = (await call(hub.base, '/api/admin/usage-purge')).body;
    assert.equal(state.floor, null);
    assert.deepEqual(state.earliest, { day: `${M3}-15`, month: M4 });
    assert.deepEqual(state.purges, []);

    // What would go: the days and months before M1.
    const preview = await call(hub.base, `/api/admin/usage-purge/preview?month=${M1}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.beforeDate, `${M1}-01`);
    assert.equal(preview.body.tables.device_daily_usage, 2);
    assert.equal(preview.body.tables.device_monthly_usage, 3);
    assert.equal(preview.body.tables.device_daily_client_usage, Number((await store().query('SELECT COUNT(*) AS n FROM device_daily_client_usage WHERE usage_date < $1', [`${M1}-01`]))[0].n));
    assert.deepEqual([preview.body.daily.first, preview.body.daily.devices, preview.body.daily.tokens], [`${M3}-15`, 1, 1600]);
    assert.equal(preview.body.monthly.first, M4);

    // Refused: no confirmation, a wrong one, a month in the future or not a month.
    for (const [body, code] of [[{ month: M1 }, 'confirm_mismatch'], [{ month: M1, confirm: M2 }, 'confirm_mismatch'],
      [{ month: '2999-01', confirm: '2999-01' }, 'bad_month'], [{ month: '2026-13', confirm: '2026-13' }, 'bad_month'], [{ month: 'abc', confirm: 'abc' }, 'bad_month']]) {
      const refused = await call(hub.base, '/api/admin/usage-purge', { method: 'POST', body });
      assert.deepEqual([refused.status, refused.body.error], [400, code], JSON.stringify(body));
    }
    // A failed backup deletes nothing.
    backups.failNext();
    const failed = await call(hub.base, '/api/admin/usage-purge', { method: 'POST', body: { month: M1, confirm: M1 } });
    assert.deepEqual([failed.status, failed.body.error], [500, 'backup_failed']);
    assert.deepEqual(await counts(store()), before);
    assert.deepEqual(backups.made, []);
    // Only the admin.
    assert.equal((await call(hub.base, '/api/admin/usage-purge', { method: 'POST', headers: CLIENT, body: { month: M1, confirm: M1 } })).status, 403);

    const done = await call(hub.base, '/api/admin/usage-purge', { method: 'POST', body: { month: M1, confirm: M1 } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.match(done.body.backup.name, /^token-monitor-\d{8}T\d{6}Z-purge\.dump$/);
    assert.deepEqual(backups.made, [done.body.backup.name], 'the backup came first');
    assert.equal(done.body.deleted.device_daily_usage, 2);
    assert.equal(done.body.deleted.device_monthly_usage, 3);
    const after = await counts(store());
    assert.deepEqual(after.days, [`${M1}-15`, dayKey(0)].sort());
    assert.deepEqual(after.months, [M1, dayKey(0).slice(0, 7)]);

    const [logged] = (await call(hub.base, '/api/admin/usage-purge')).body.purges;
    assert.deepEqual([logged.beforeDate, logged.purgedBy, logged.backupFile], [`${M1}-01`, 'admin', done.body.backup.name]);
    assert.equal(logged.deleted.device_daily_usage, 2);

    // The usage answer changes at once, its 60 s cache notwithstanding.
    const usageAfter = (await call(hub.base, usagePath)).body;
    assert.ok(usageAfter.totals.tokens < usageBefore.totals.tokens, `${usageAfter.totals.tokens} < ${usageBefore.totals.tokens}`);
    assert.equal(usageAfter.purgedBefore, `${M1}-01`);
    // A month the purge deleted reports nothing.
    const report = await call(hub.base, `/api/reports/v1/usage/monthly?month=${M3}`);
    assert.equal(report.body.totals.tokens, 0);

    // The floor only moves up.
    const again = await call(hub.base, '/api/admin/usage-purge', { method: 'POST', body: { month: M2, confirm: M2 } });
    assert.deepEqual([again.status, again.body.error], [409, 'already_purged']);
    assert.equal((await call(hub.base, `/api/admin/usage-purge/preview?month=${M1}`)).status, 409);

    // The device sends its old history again, with changed numbers: nothing
    // below the floor is written, everything above it is.
    const changed = oldHistory({ tokens: 999 });
    assert.equal((await post(hub.base, '/api/ingest', devicePayload({ history: changed }), CLIENT)).status, 200);
    await hub.settle();
    assert.deepEqual((await counts(store())).days, after.days);
    const [kept] = await store().query('SELECT tokens FROM device_daily_usage WHERE usage_date = $1', [`${M1}-15`]);
    assert.equal(Number(kept.tokens), 999, 'a day above the floor is updated as usual');
    // Deleted and uploaded whole, as a new device would be.
    assert.equal((await call(hub.base, '/api/devices/dev-a', { method: 'DELETE' })).status, 200);
    assert.equal((await post(hub.base, '/api/ingest', devicePayload({ history: oldHistory({ tokens: 700 }) }), CLIENT)).status, 200);
    // A device the hub has never seen, with all of its history.
    assert.equal((await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-b', hostname: 'host-b', history: oldHistory() }), CLIENT)).status, 200);
    await hub.settle();
    let now = await counts(store());
    assert.deepEqual(now.days, [`${M1}-15`, `${M1}-15`, dayKey(0), dayKey(0)].sort());
    assert.deepEqual(now.months, [M1, M1, dayKey(0).slice(0, 7), dayKey(0).slice(0, 7)].sort());
    assert.ok(hub.overlay.persistence.status().purge.belowFloorSkipped > 0);

    // A restart reads the floor back from usage_purges.
    const schema = hub.schema;
    await hub.stop();
    removeAll(hub.dataFile);
    hub = await startOverlayHub({ database: schema, backup: backups.options(dir) });
    assert.deepEqual(hub.overlay.persistence.store.purgeState().floor, { day: `${M1}-01`, month: M1 });
    assert.equal((await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-c', hostname: 'host-c', history: oldHistory() }), CLIENT)).status, 200);
    await hub.settle();
    now = await counts(hub.overlay.persistence.store);
    assert.ok(now.days.every((day) => day >= `${M1}-01`), now.days.join());
    assert.ok(now.months.every((month) => month >= M1), now.months.join());
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one purge at a time, and none without backups', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tm-purge-${process.pid}-`));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const hub = await startOverlayHub({
    database: true,
    backup: {
      dir,
      databaseUrl: DATABASE_URL,
      probe: async () => ({ ok: true }),
      runDump: async (command) => {
        await gate;
        fs.writeFileSync(command.args.find((arg) => arg.startsWith('--file=')).slice('--file='.length), 'PGDMP');
      }
    }
  });
  const noBackups = await startOverlayHub({ database: true });
  try {
    assert.equal((await post(hub.base, '/api/ingest', devicePayload({ history: oldHistory() }), CLIENT)).status, 200);
    await hub.settle();
    const first = call(hub.base, '/api/admin/usage-purge', { method: 'POST', body: { month: M1, confirm: M1 } });
    // Let the first one reach its backup.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await call(hub.base, '/api/admin/usage-purge', { method: 'POST', body: { month: M1, confirm: M1 } });
    assert.deepEqual([second.status, second.body.error], [409, 'purge_running']);
    release();
    assert.equal((await first).status, 200);

    // No backup folder: nothing is deleted, and the answer says why.
    const refused = await call(noBackups.base, '/api/admin/usage-purge', { method: 'POST', body: { month: M1, confirm: M1 } });
    assert.deepEqual([refused.status, refused.body.error, refused.body.reason], [503, 'backup_unavailable', 'no_dir']);
  } finally {
    release();
    await hub.stop();
    await noBackups.stop();
    removeAll(hub.dataFile, noBackups.dataFile);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the store deletes below the floor only, records it, and writes nothing below it afterwards', async () => {
  const hub = await startOverlayHub({ database: true });
  try {
    assert.equal((await post(hub.base, '/api/ingest', devicePayload({ history: oldHistory() }), CLIENT)).status, 200);
    await hub.settle();
    const store = hub.overlay.persistence.store;
    const result = await store.purgeUsage({ beforeDate: `${M2}-01`, actor: 'admin:test' });
    assert.equal(result.deleted.device_daily_usage, 1);
    assert.equal(result.deleted.device_monthly_usage, 2);
    assert.equal(result.totals.daily.tokens, 800);
    assert.deepEqual(store.purgeState().floor, { day: `${M2}-01`, month: M2 });
    // An earlier floor never lowers it.
    await store.purgeUsage({ beforeDate: `${M3}-01`, actor: 'admin:test' });
    assert.deepEqual(store.purgeState().floor, { day: `${M2}-01`, month: M2 });
    assert.deepEqual(await store.loadPurgeFloor(), { day: `${M2}-01`, month: M2 });
    const rows = await store.listPurges();
    assert.deepEqual(rows.map((r) => r.beforeDate), [`${M3}-01`, `${M2}-01`]);
    assert.equal(rows[1].purgedBy, 'admin:test');
    // A floor must be the first of a month.
    await assert.rejects(store.purgeUsage({ beforeDate: `${M2}-15`, actor: 'admin:test' }));
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

