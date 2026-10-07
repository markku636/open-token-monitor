'use strict';

// hub/backups.js: the hub's own pg_dump backups, daily and on demand, and the
// admin routes that list, make, hand out and delete them. pg_dump cannot run
// against PGlite, so the dump itself is stubbed: the stub writes the file the
// command line names.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { NAME_RE, backupConfigFromEnv, backupName, createBackups, majorOf, parseName, pgDumpCommand } = require('../hub/backups');
const { bearer, quiet, removeAll, startOverlayHub } = require('./helpers/overlayHub');

const ADMIN = bearer('admin-secret');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// 2026-10-02 12:00 UTC.
const NOON = Date.parse('2026-10-02T12:00:00Z');
// PGlite has no URL; the stubbed dump never connects.
const DATABASE_URL = 'postgres://token_monitor:pw@db:5432/token_monitor';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tm-backups-${process.pid}-`));
}

const fileArg = (command) => command.args.find((arg) => arg.startsWith('--file=')).slice('--file='.length);

// A runDump that writes `bytes` into the file it is told to, and remembers
// every command it was given.
function stubDump(bytes = 'PGDMP fake dump') {
  const commands = [];
  const run = async (command) => {
    commands.push(command);
    fs.writeFileSync(fileArg(command), bytes);
  };
  run.commands = commands;
  return run;
}

const ok = async () => ({ ok: true, pgDumpVersion: 'pg_dump (PostgreSQL) 18.6', serverVersion: '180006' });

function make(dir, extra = {}) {
  let clock = extra.at ?? NOON;
  const backups = createBackups({
    dir,
    databaseUrl: DATABASE_URL,
    runDump: stubDump(),
    probe: ok,
    statfs: async () => ({ bavail: 1e9, bsize: 4096 }),
    now: () => clock,
    logger: quiet,
    ...extra
  });
  backups.setNow = (ms) => { clock = ms; };
  return backups;
}

test('pg_dump gets the password in PGPASSWORD only, and none of the hub\'s other variables', () => {
  const command = pgDumpCommand({
    pgDump: '/usr/bin/pg_dump',
    databaseUrl: 'postgres://token_monitor:p%40ss@db:5432/token_monitor?sslmode=require',
    schema: 'token_monitor',
    file: '/backups/x.partial',
    env: { PATH: '/bin', TOKEN_MONITOR_SECRET: 'admin-secret', TOKEN_MONITOR_DATABASE_URL: 'postgres://x:p%40ss@db/x', PGSSLROOTCERT: '/ca.pem' }
  });
  assert.equal(command.command, '/usr/bin/pg_dump');
  assert.equal(command.env.PGPASSWORD, 'p@ss');
  assert.equal(command.env.PATH, '/bin');
  assert.equal(command.env.PGSSLROOTCERT, '/ca.pem');
  assert.equal(command.env.TOKEN_MONITOR_SECRET, undefined);
  assert.equal(command.env.TOKEN_MONITOR_DATABASE_URL, undefined);
  for (const arg of command.args) assert.doesNotMatch(arg, /p@ss|p%40ss/);
  assert.deepEqual(command.args, [
    '--format=custom', '--schema=token_monitor', '--no-password', '--lock-wait-timeout=60s', '--file=/backups/x.partial',
    '--dbname=postgres://token_monitor@db:5432/token_monitor?sslmode=require'
  ]);
  // Without a password nothing is set.
  assert.equal(pgDumpCommand({ databaseUrl: 'postgres://u@db/x', schema: 's', file: 'f', env: {} }).env.PGPASSWORD, undefined);
});

test('settings, names and versions', () => {
  assert.deepEqual(backupConfigFromEnv({}, { defaultDir: '/data/backups' }), { dir: '/data/backups', keep: 14, hourUtc: 19, pgDump: 'pg_dump' });
  assert.deepEqual(backupConfigFromEnv({ TOKEN_MONITOR_BACKUP_DIR: '/backups', TOKEN_MONITOR_BACKUP_KEEP: '0', TOKEN_MONITOR_BACKUP_HOUR: '3', TOKEN_MONITOR_PG_DUMP: 'C:\\pg\\pg_dump.exe' }), {
    dir: '/backups', keep: 0, hourUtc: 3, pgDump: 'C:\\pg\\pg_dump.exe'
  });
  // Out of range: the default.
  assert.equal(backupConfigFromEnv({ TOKEN_MONITOR_BACKUP_HOUR: '24' }).hourUtc, 19);
  assert.equal(backupConfigFromEnv({ TOKEN_MONITOR_BACKUP_KEEP: '-1' }).keep, 14);

  assert.equal(backupName(Date.parse('2026-10-02T19:00:05.123Z'), 'daily'), 'token-monitor-20261002T190005Z-daily.dump');
  assert.deepEqual(parseName('token-monitor-20261002T190005Z-purge.dump'), { name: 'token-monitor-20261002T190005Z-purge.dump', kind: 'purge', createdAt: '2026-10-02T19:00:05Z' });
  for (const bad of ['', '../token-monitor-20261002T190005Z-daily.dump', 'token-monitor-20261002T190005Z-daily.dump.partial', 'x-20261002T190005Z-daily.dump', 'token-monitor-20261002T190005Z-other.dump']) {
    assert.equal(parseName(bad), null, bad);
    assert.doesNotMatch(bad, NAME_RE);
  }

  assert.equal(majorOf('pg_dump (PostgreSQL) 18.6'), 18);
  assert.equal(majorOf('pg_dump (PostgreSQL) 17.2 (Debian 17.2-1)'), 17);
  assert.equal(majorOf('180006'), 18);
  assert.equal(majorOf('170004'), 17);
});

test('a backup is written whole, private, and listed newest first', async () => {
  const dir = tempDir();
  try {
    const backups = make(dir);
    const first = await backups.create('manual', 'admin:session-ab');
    assert.equal(first.name, 'token-monitor-20261002T120000Z-manual.dump');
    assert.equal(first.kind, 'manual');
    assert.equal(first.bytes, 'PGDMP fake dump'.length);
    backups.setNow(NOON + 60 * 1000);
    await backups.create('manual');
    // The same second twice: the second one moves on a second.
    await backups.create('manual');
    const names = (await backups.list()).map((b) => b.name);
    assert.deepEqual(names, [
      'token-monitor-20261002T120101Z-manual.dump',
      'token-monitor-20261002T120100Z-manual.dump',
      'token-monitor-20261002T120000Z-manual.dump'
    ]);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.partial')), [], 'no partial file is left');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, names[0])).mode & 0o777, 0o600);
    const status = await backups.status();
    assert.equal(status.available, true);
    assert.equal(status.count, 3);
    assert.equal(status.lastBackupAt, '2026-10-02T12:01:01.000Z');
    assert.equal(status.lastError, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the dump is made under a partial name, which a failure removes', async () => {
  const dir = tempDir();
  try {
    const run = stubDump();
    let failing = true;
    const backups = make(dir, {
      runDump: async (command) => {
        await run(command);
        if (failing) throw Object.assign(new Error('pg_dump exited 1'), { stderr: 'pg_dump: error: connection to server failed' });
      }
    });
    await assert.rejects(backups.create('manual'), (error) => error.status === 500 && error.code === 'backup_failed' && /connection to server failed/.test(error.message));
    assert.match(fileArg(run.commands[0]), /token-monitor-20261002T120000Z-manual\.dump\.partial$/);
    assert.deepEqual(fs.readdirSync(dir), [], 'the partial file is gone');
    assert.match(backups.summary().lastError.message, /connection to server failed/);
    failing = false;
    await backups.create('manual');
    assert.equal(backups.summary().lastError, null);
    // An empty file is a failed dump too.
    const empty = make(dir, { runDump: stubDump(''), at: NOON + HOUR });
    await assert.rejects(empty.create('manual'), { code: 'backup_failed' });
    assert.equal((await backups.list()).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one dump at a time: an admin is turned down, a purge waits its turn', async () => {
  const dir = tempDir();
  try {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const run = stubDump();
    const backups = make(dir, { runDump: async (command) => { await gate; await run(command); } });
    const first = backups.create('manual');
    await assert.rejects(backups.create('manual'), (error) => error.status === 409 && error.code === 'backup_running');
    const purge = backups.create('purge', 'admin', { wait: true });
    assert.equal((await backups.tick()), null, 'the daily one does not pile on either');
    release();
    const [a, b] = await Promise.all([first, purge]);
    assert.equal(a.kind, 'manual');
    assert.equal(b.kind, 'purge');
    assert.equal(run.commands.length, 2);
    assert.equal(backups.summary().running, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rotation keeps the newest daily dumps and never touches manual or purge ones', async () => {
  const dir = tempDir();
  try {
    const backups = make(dir, { keep: 2 });
    for (const [offset, kind] of [[0, 'manual'], [1, 'purge'], [2, 'daily'], [3, 'daily'], [4, 'daily']]) {
      backups.setNow(NOON + offset * DAY);
      await backups.create(kind);
    }
    assert.deepEqual((await backups.list()).map((b) => `${b.createdAt.slice(0, 10)} ${b.kind}`), [
      '2026-10-06 daily', '2026-10-05 daily', '2026-10-03 purge', '2026-10-02 manual'
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the daily backup runs once a day, from its hour on, and waits an hour after a failure', async () => {
  const dir = tempDir();
  try {
    let fail = false;
    const run = stubDump();
    const backups = make(dir, {
      hourUtc: 19,
      at: Date.parse('2026-10-02T18:59:00Z'),
      runDump: async (command) => {
        if (fail) throw new Error('down');
        await run(command);
      }
    });
    assert.equal(await backups.tick(), null, 'before the hour');
    backups.setNow(Date.parse('2026-10-02T19:00:00Z'));
    assert.equal((await backups.tick()).name, 'token-monitor-20261002T190000Z-daily.dump');
    backups.setNow(Date.parse('2026-10-02T23:50:00Z'));
    assert.equal(await backups.tick(), null, 'once a day');
    // The next day, past its hour: the hub was down at 19:00 and catches up.
    backups.setNow(Date.parse('2026-10-03T21:10:00Z'));
    fail = true;
    assert.equal(await backups.tick(), null, 'a failure is logged, not thrown');
    fail = false;
    backups.setNow(Date.parse('2026-10-03T21:40:00Z'));
    assert.equal(await backups.tick(), null, 'within the hour after a failure');
    backups.setNow(Date.parse('2026-10-03T22:11:00Z'));
    assert.equal((await backups.tick()).name, 'token-monitor-20261003T221100Z-daily.dump');
    const status = await backups.status();
    assert.equal(status.nextDailyAt, '2026-10-04T19:00:00.000Z');
    // keep 0: no daily backups at all.
    const off = make(dir, { keep: 0, at: Date.parse('2026-10-05T20:00:00Z') });
    assert.equal(await off.tick(), null);
    assert.equal((await off.status()).nextDailyAt, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('names outside the folder\'s own pattern are refused before the disk is touched', async () => {
  const dir = tempDir();
  try {
    const backups = make(dir);
    for (const bad of ['../package.json', '..\\x', 'token-monitor-20261002T120000Z-manual.dump.partial', '', 'token-monitor-20261002T120000Z-manual.dump/../../x']) {
      assert.throws(() => backups.resolve(bad), { status: 400, code: 'bad_backup_name' }, bad);
    }
    assert.equal(backups.resolve('token-monitor-20261002T120000Z-manual.dump'), path.join(path.resolve(dir), 'token-monitor-20261002T120000Z-manual.dump'));
    await assert.rejects(backups.remove('token-monitor-20261002T120000Z-manual.dump'), { status: 404 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backups say why they are unavailable, and too little disk stops a dump', async () => {
  const dir = tempDir();
  try {
    await assert.rejects(make(dir, { probe: async () => ({ ok: false, reason: 'pg_dump_missing' }) }).create('manual'), (error) => error.status === 503 && error.details.reason === 'pg_dump_missing');
    await assert.rejects(make('', {}).create('manual'), (error) => error.details.reason === 'no_dir');
    // The real probe: pg_dump not found, no database URL, a client older than the server.
    const missing = createBackups({ dir, databaseUrl: 'postgres://u:p@db/x', pgDump: path.join(dir, 'no-such-pg_dump'), logger: quiet });
    assert.equal((await missing.status()).reason, 'pg_dump_missing');
    assert.equal((await createBackups({ dir, logger: quiet }).status()).reason, 'no_database_url');
    // pg_dump 17 against a server of 18 is too old; 18 against 18 will do.
    const store = (num) => ({ query: async () => [{ server_version_num: num }] });
    const probed = (version, num) => createBackups({ dir, databaseUrl: 'postgres://u@db/x', store: store(num), readVersion: async () => version, logger: quiet }).status();
    assert.equal((await probed('pg_dump (PostgreSQL) 17.6', '180006')).reason, 'pg_dump_too_old');
    const fine = await probed('pg_dump (PostgreSQL) 18.6', '180006');
    assert.deepEqual([fine.available, fine.pgDumpVersion, fine.serverVersion], [true, 'pg_dump (PostgreSQL) 18.6', '180006']);

    const full = make(dir, { statfs: async () => ({ bavail: 10, bsize: 4096 }) });
    await assert.rejects(full.create('manual'), (error) => error.status === 507 && error.code === 'insufficient_storage');
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an admin makes, lists, downloads and deletes backups through /api/admin/backups', async () => {
  const dir = tempDir();
  const hub = await startOverlayHub({ database: true, backup: { dir, databaseUrl: DATABASE_URL, runDump: stubDump('PGDMP over http'), probe: ok } });
  try {
    const call = async (pathname, method = 'GET', headers = ADMIN) => {
      const response = await fetch(`${hub.base}${pathname}`, { method, headers });
      return { status: response.status, headers: response.headers, text: await response.text() };
    };
    const empty = JSON.parse((await call('/api/admin/backups')).text);
    assert.equal(empty.available, true);
    assert.deepEqual(empty.backups, []);

    const made = await call('/api/admin/backups', 'POST');
    assert.equal(made.status, 201, made.text);
    const { backup } = JSON.parse(made.text);
    assert.match(backup.name, /^token-monitor-\d{8}T\d{6}Z-manual\.dump$/);

    const listed = JSON.parse((await call('/api/admin/backups')).text);
    assert.deepEqual(listed.backups.map((b) => b.name), [backup.name]);
    assert.equal(listed.count, 1);

    const file = await call(`/api/admin/backups/${backup.name}`);
    assert.equal(file.status, 200);
    assert.equal(file.text, 'PGDMP over http');
    assert.equal(file.headers.get('content-disposition'), `attachment; filename="${backup.name}"`);
    assert.equal(file.headers.get('content-type'), 'application/octet-stream');
    assert.equal(file.headers.get('cache-control'), 'no-store');
    assert.equal(file.headers.get('access-control-allow-origin'), null, 'no other site may read it');

    // Only the admin: the client key is handed to every user.
    assert.equal((await call('/api/admin/backups', 'GET', bearer('client-secret'))).status, 403);
    assert.equal((await call(`/api/admin/backups/${backup.name}`, 'GET', {})).status, 401);
    assert.equal((await call('/api/admin/backups/..%2F..%2Fpackage.json')).status, 400);
    assert.equal((await call('/api/admin/backups/%E0%A4%A')).status, 400, 'a malformed escape is a bad request, not a crash');

    const health = JSON.parse((await call('/api/custom/health')).text);
    assert.equal(health.backups.available, true);
    assert.equal(health.backups.keep, 14);

    assert.equal((await call(`/api/admin/backups/${backup.name}`, 'DELETE')).status, 200);
    assert.equal((await call(`/api/admin/backups/${backup.name}`)).status, 404);
    assert.equal((await call(`/api/admin/backups/${backup.name}`, 'DELETE')).status, 404);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a backup made with the session cookie needs the page\'s header; a hub without a database has none', async () => {
  const dir = tempDir();
  const hub = await startOverlayHub({ database: true, backup: { dir, databaseUrl: DATABASE_URL, runDump: stubDump(), probe: ok } });
  const plain = await startOverlayHub();
  try {
    const signedIn = await fetch(`${hub.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tm-request': '1', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ key: 'admin-secret' })
    });
    const cookie = { cookie: `tm_admin=${/tm_admin=([^;]*)/.exec(signedIn.headers.get('set-cookie'))[1]}` };
    assert.equal((await fetch(`${hub.base}/api/admin/backups`, { method: 'POST', headers: cookie })).status, 403);
    assert.equal((await fetch(`${hub.base}/api/admin/backups`, { method: 'POST', headers: { ...cookie, 'x-tm-request': '1' } })).status, 201);
    assert.equal((await fetch(`${hub.base}/api/admin/backups`, { headers: cookie })).status, 200, 'a read needs only the cookie');

    const none = await fetch(`${plain.base}/api/admin/backups`, { headers: ADMIN });
    assert.equal(none.status, 503);
    // Without a dir (the tests' default), the hub makes no backups.
    const noDir = await startOverlayHub({ database: true });
    try {
      const answer = await (await fetch(`${noDir.base}/api/admin/backups`, { headers: ADMIN })).json();
      assert.deepEqual([answer.available, answer.reason], [false, 'no_dir']);
    } finally {
      await noDir.stop();
      removeAll(noDir.dataFile);
    }
  } finally {
    await hub.stop();
    await plain.stop();
    removeAll(hub.dataFile, plain.dataFile);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
