'use strict';

// The hub's own database backups: pg_dump of its schema, once a day and
// whenever an admin asks (the dashboard's 資料庫備份, admin.js), kept in a
// folder of their own (/backups in the image, a volume of its own in
// compose.yml, so resetting the database leaves them).
//
//   token-monitor-<YYYYMMDDTHHMMSSZ>-daily.dump    made by the hub every day
//   token-monitor-<…>-manual.dump                  an admin's 立即備份
//   token-monitor-<…>-purge.dump                   right before 刪除歷史資料 (purge.js)
//
// Every file is `pg_dump --format=custom --schema=<schema>`, the same kind as
// the dumps deploy/server-deploy.sh makes before a deploy, so one restore
// procedure serves both (docs/postgres.zh-TW.md). Only the newest `keep` daily
// files are kept; manual and purge dumps are never deleted by the hub, since a
// purge dump is the one copy of the history it deleted.
//
// pg_dump connects as the hub's own role, from TOKEN_MONITOR_DATABASE_URL: the
// password goes in PGPASSWORD, never on the command line, and the child gets
// no other variable of the hub's (no TOKEN_MONITOR_SECRET). Its major version
// must be at least the server's; when it is missing or older, backups say
// they are unavailable and why, and a purge refuses to run.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

const NAME_RE = /^token-monitor-(\d{8}T\d{6}Z)-(daily|manual|purge)\.dump$/;
const KINDS = Object.freeze(['daily', 'manual', 'purge']);
const PARTIAL = '.partial';
const DEFAULT_KEEP = 14;
// 03:00 in Taipei. UTC, so it does not hang on the container's TZ.
const DEFAULT_HOUR_UTC = 19;
const TICK_MS = 10 * 60 * 1000;
const FIRST_TICK_MS = 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
const PROBE_CACHE_MS = 10 * 60 * 1000;
const DUMP_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_FREE_BYTES = 64 * 1024 * 1024;
// What pg_dump may see of the hub's environment besides its own variables.
const CHILD_ENV = Object.freeze(['PATH', 'HOME', 'SystemRoot', 'TEMP', 'TMP', 'TZ', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY', 'PGPASSFILE']);

class BackupError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function backupConfigFromEnv(env = process.env, { defaultDir = '' } = {}) {
  const int = (value, fallback, max) => {
    const n = Number(value);
    return value !== undefined && String(value).trim() !== '' && Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
  };
  return {
    dir: String(env.TOKEN_MONITOR_BACKUP_DIR || '').trim() || defaultDir,
    keep: int(env.TOKEN_MONITOR_BACKUP_KEEP, DEFAULT_KEEP, 10000),
    hourUtc: int(env.TOKEN_MONITOR_BACKUP_HOUR, DEFAULT_HOUR_UTC, 23),
    pgDump: String(env.TOKEN_MONITOR_PG_DUMP || '').trim() || 'pg_dump'
  };
}

// 2026-10-02T19:00:05.123Z → 20261002T190005Z.
function stampOf(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function timeOfStamp(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

function backupName(ms, kind) {
  return `token-monitor-${stampOf(ms)}-${kind}.dump`;
}

function parseName(name) {
  const m = NAME_RE.exec(String(name || ''));
  return m ? { name: m[0], kind: m[2], createdAt: timeOfStamp(m[1]) } : null;
}

// The command line and environment of one dump, built from the hub's database
// URL: query parameters (sslmode=…) stay in the URL, the password moves to
// PGPASSWORD.
function pgDumpCommand({ pgDump = 'pg_dump', databaseUrl, schema, file, env = process.env }) {
  const url = new URL(databaseUrl);
  const password = url.password ? decodeURIComponent(url.password) : '';
  url.password = '';
  const childEnv = { PGAPPNAME: 'token-monitor-backup' };
  for (const name of CHILD_ENV) if (env[name] !== undefined) childEnv[name] = env[name];
  if (password) childEnv.PGPASSWORD = password;
  return {
    command: pgDump,
    args: ['--format=custom', `--schema=${schema}`, '--no-password', '--lock-wait-timeout=60s', `--file=${file}`, `--dbname=${url.href}`],
    env: childEnv
  };
}

// The major version in `pg_dump (PostgreSQL) 18.6` or a server_version_num
// such as 180006.
function majorOf(text) {
  const value = String(text || '').trim();
  if (/^\d{5,6}$/.test(value)) return Math.floor(Number(value) / 10000);
  const m = /(\d+)(?:\.\d+)?/.exec(value.replace(/^[^)]*\)/, ''));
  return m ? Number(m[1]) : null;
}

function execFileText(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { windowsHide: true, maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = String(stderr || '');
        return reject(error);
      }
      return resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    options?.onChild?.(child);
  });
}

function createBackups({
  dir = '',
  keep = DEFAULT_KEEP,
  hourUtc = DEFAULT_HOUR_UTC,
  pgDump = 'pg_dump',
  databaseUrl = '',
  schema = 'token_monitor',
  store = null,
  runDump = null,
  probe = null,
  // What `pg_dump --version` prints (the default probe asks it).
  readVersion = async (command) => (await execFileText(command, ['--version'], { timeout: 30 * 1000 })).stdout.trim(),
  statfs = (target) => fs.promises.statfs(target),
  now = () => Date.now(),
  logger = console
} = {}) {
  const log = (message) => (logger.log || console.log)(`[backups] ${message}`);
  const warn = (message) => (logger.warn || console.warn)(`[backups] ${message}`);
  let child = null;
  let running = null;
  // Dumps asked for and not started yet.
  let queued = 0;
  let chain = Promise.resolve();
  let lastBackupAt = null;
  let lastError = null;
  let lastFailureAt = 0;
  let checked = null;
  let timer = null;
  let firstTick = null;

  // pg_dump's and the server's versions, as runDump will meet them.
  async function defaultProbe() {
    let pgDumpVersion;
    try {
      pgDumpVersion = await readVersion(pgDump);
    } catch (error) {
      return { ok: false, reason: error.code === 'ENOENT' ? 'pg_dump_missing' : 'pg_dump_failed', message: String(error.stderr || error.message).slice(0, 300) };
    }
    const [row] = store ? await store.query('SHOW server_version_num') : [];
    const serverVersion = row ? String(row.server_version_num) : null;
    const client = majorOf(pgDumpVersion);
    const server = majorOf(serverVersion);
    if (client && server && client < server) return { ok: false, reason: 'pg_dump_too_old', pgDumpVersion, serverVersion };
    return { ok: true, pgDumpVersion, serverVersion };
  }

  async function dirWritable() {
    try {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.promises.access(dir, fs.constants.W_OK);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Whether a dump can be made now, and why not, re-checked every 10 minutes.
  async function availability({ fresh = false } = {}) {
    if (!dir) return { ok: false, reason: 'no_dir' };
    if (!databaseUrl) return { ok: false, reason: 'no_database_url' };
    if (!fresh && checked && now() - checked.at < PROBE_CACHE_MS) return checked.result;
    let result;
    if (!(await dirWritable())) result = { ok: false, reason: 'dir_not_writable' };
    else {
      try {
        result = await (probe || defaultProbe)();
      } catch (error) {
        result = { ok: false, reason: 'pg_dump_failed', message: String(error.message).slice(0, 300) };
      }
    }
    checked = { at: now(), result };
    return result;
  }

  async function list() {
    if (!dir) return [];
    let names;
    try {
      names = await fs.promises.readdir(dir);
    } catch (_) {
      return [];
    }
    const out = [];
    for (const name of names) {
      const parsed = parseName(name);
      if (!parsed) continue;
      try {
        const stat = await fs.promises.lstat(path.join(dir, name));
        if (stat.isFile()) out.push({ ...parsed, bytes: stat.size });
      } catch (_) {
        // Deleted meanwhile.
      }
    }
    return out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  }

  // A file of this folder by its name: anything else is refused before the
  // disk is touched.
  function resolve(name) {
    const parsed = parseName(name);
    const file = parsed ? path.resolve(dir, parsed.name) : null;
    if (!dir || !parsed || path.dirname(file) !== path.resolve(dir)) {
      throw new BackupError(400, 'bad_backup_name', 'not the name of a backup file');
    }
    return file;
  }

  async function freeBytes() {
    try {
      const s = await statfs(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch (_) {
      return null;
    }
  }

  async function dumpOnce(kind, actor) {
    const free = await freeBytes();
    const existing = await list();
    const needed = Math.max(MIN_FREE_BYTES, 2 * (existing[0]?.bytes || 0));
    if (free !== null && free < needed) {
      throw new BackupError(507, 'insufficient_storage', `${free} bytes free in the backup folder, ${needed} needed`);
    }
    let at = now();
    while (existing.some((b) => b.name === backupName(at, kind))) at += 1000;
    const name = backupName(at, kind);
    const file = path.join(dir, name);
    const partial = `${file}${PARTIAL}`;
    const command = pgDumpCommand({ pgDump, databaseUrl, schema, file: partial });
    try {
      if (runDump) await runDump(command);
      else await execFileText(command.command, command.args, { env: command.env, timeout: DUMP_TIMEOUT_MS, onChild: (c) => { child = c; } });
      child = null;
      try {
        await fs.promises.chmod(partial, 0o600);
      } catch (_) {
        // Windows has no such modes.
      }
      const { size } = await fs.promises.stat(partial);
      if (!size) throw new Error('pg_dump wrote an empty file');
      await fs.promises.rename(partial, file);
      lastBackupAt = new Date(at).toISOString();
      lastError = null;
      log(`${actor} made ${name} (${size} bytes)`);
      if (kind === 'daily') await rotate();
      return { ...parseName(name), bytes: size };
    } catch (error) {
      child = null;
      await fs.promises.rm(partial, { force: true }).catch(() => {});
      const message = String(error.stderr || error.message || error).trim().slice(0, 300);
      lastError = { at: new Date(now()).toISOString(), message };
      lastFailureAt = now();
      warn(`${kind} backup failed: ${message}`);
      throw new BackupError(500, 'backup_failed', message);
    }
  }

  // One dump at a time. An admin's request while one runs is turned down; a
  // purge (wait) queues behind it, since it must not delete before its own
  // dump exists.
  async function create(kind, actor = 'admin', { wait = false } = {}) {
    if (!KINDS.includes(kind)) throw new BackupError(400, 'bad_request', `kind must be one of ${KINDS.join(', ')}`);
    // The place in line is taken before anything is awaited, so of two
    // requests at once the first one is the one made.
    if ((running || queued) && !wait) throw new BackupError(409, 'backup_running', 'a backup is being made; try again when it is done');
    queued += 1;
    let state;
    try {
      state = await availability();
    } catch (error) {
      queued -= 1;
      throw error;
    }
    if (!state.ok) {
      queued -= 1;
      throw new BackupError(503, 'backup_unavailable', `backups are unavailable: ${state.reason}`, { reason: state.reason });
    }
    const job = chain.then(async () => {
      queued -= 1;
      running = { kind, actor, startedAt: new Date(now()).toISOString() };
      try {
        return await dumpOnce(kind, actor);
      } finally {
        running = null;
      }
    });
    chain = job.catch(() => {});
    return job;
  }

  // Only the newest `keep` daily dumps stay.
  async function rotate() {
    if (!(keep > 0)) return [];
    const removed = [];
    for (const old of (await list()).filter((b) => b.kind === 'daily').slice(keep)) {
      try {
        await fs.promises.unlink(path.join(dir, old.name));
        removed.push(old.name);
      } catch (_) {
        // Gone already.
      }
    }
    if (removed.length) log(`rotated out ${removed.length} daily backup(s)`);
    return removed;
  }

  async function remove(name, actor = 'admin') {
    const file = resolve(name);
    try {
      await fs.promises.unlink(file);
    } catch (error) {
      if (error.code === 'ENOENT') throw new BackupError(404, 'not_found', 'no such backup');
      throw error;
    }
    log(`${actor} deleted ${path.basename(file)}`);
    return { name: path.basename(file) };
  }

  // The file itself, as a download. No CORS header: only the hub's own page,
  // signed in, may fetch it.
  async function send(res, name, actor = 'admin') {
    const file = resolve(name);
    let stat;
    try {
      stat = await fs.promises.lstat(file);
    } catch (_) {
      stat = null;
    }
    if (!stat || !stat.isFile()) throw new BackupError(404, 'not_found', 'no such backup');
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${path.basename(file)}"`,
      'content-length': String(stat.size),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    log(`${actor} downloaded ${path.basename(file)}`);
    try {
      await pipeline(fs.createReadStream(file), res);
    } catch (_) {
      // The headers are out: all that is left is to cut the download short.
      res.destroy();
    }
  }

  function nextDailyAt(backups) {
    if (!(keep > 0) || !dir) return null;
    const current = new Date(now());
    const today = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate(), hourUtc);
    const day = stampOf(now()).slice(0, 8);
    const doneToday = backups.some((b) => b.kind === 'daily' && b.name.startsWith(`token-monitor-${day}T`));
    if (doneToday) return new Date(today + 24 * 60 * 60 * 1000).toISOString();
    return new Date(Math.max(today, now())).toISOString();
  }

  // For /api/custom/health, which answers at once: what is known without a
  // probe or a look at the folder.
  function summary() {
    return {
      available: checked ? checked.result.ok : null,
      reason: checked && !checked.result.ok ? checked.result.reason : null,
      keep,
      hourUtc,
      running: running ? { ...running } : null,
      lastBackupAt,
      lastError
    };
  }

  async function status() {
    const state = await availability();
    const backups = await list();
    return {
      ...summary(),
      available: state.ok,
      reason: state.ok ? null : state.reason,
      pgDumpVersion: state.pgDumpVersion || null,
      serverVersion: state.serverVersion || null,
      nextDailyAt: state.ok ? nextDailyAt(backups) : null,
      freeBytes: dir ? await freeBytes() : null,
      count: backups.length,
      bytes: backups.reduce((sum, b) => sum + b.bytes, 0)
    };
  }

  // The day's backup once its hour has come, and later that day if the hub
  // was down at the hour; after a failure, an hour's wait before the next try.
  async function tick() {
    if (!(keep > 0) || !dir || running || queued) return null;
    const current = new Date(now());
    if (current.getUTCHours() < hourUtc) return null;
    if (lastFailureAt && now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return null;
    const day = stampOf(now()).slice(0, 8);
    if ((await list()).some((b) => b.kind === 'daily' && b.name.startsWith(`token-monitor-${day}T`))) return null;
    const state = await availability();
    if (!state.ok) return null;
    try {
      return await create('daily', 'auto:daily');
    } catch (_) {
      return null;
    }
  }

  async function start() {
    if (!dir) return;
    if (await dirWritable()) {
      // A dump the hub was stopped in the middle of.
      for (const name of await fs.promises.readdir(dir).catch(() => [])) {
        if (name.endsWith(PARTIAL) && parseName(name.slice(0, -PARTIAL.length))) {
          await fs.promises.rm(path.join(dir, name), { force: true }).catch(() => {});
        }
      }
    }
    const [newest] = await list();
    lastBackupAt = newest?.createdAt || null;
    const state = await availability({ fresh: true });
    if (state.ok) {
      log(keep > 0
        ? `daily at ${String(hourUtc).padStart(2, '0')}:00 UTC, keeping ${keep} in ${dir}${state.pgDumpVersion ? ` (${state.pgDumpVersion})` : ''}`
        : `daily backups off (TOKEN_MONITOR_BACKUP_KEEP=0); manual ones go to ${dir}`);
    } else {
      warn(`unavailable: ${state.reason}`);
    }
    firstTick = setTimeout(() => { tick().catch(() => {}); }, FIRST_TICK_MS);
    firstTick.unref?.();
    timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
    timer.unref?.();
  }

  async function stop() {
    clearTimeout(firstTick);
    clearInterval(timer);
    if (child) child.kill('SIGTERM');
    await chain;
  }

  return { dir, keep, hourUtc, availability, create, list, remove, resolve, rotate, send, start, status, stop, summary, tick };
}

module.exports = { BackupError, KINDS, NAME_RE, backupConfigFromEnv, backupName, createBackups, majorOf, parseName, pgDumpCommand };
