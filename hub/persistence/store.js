'use strict';

// The database behind the hub overlay: migrations, the writer lock, and every
// write the overlay makes. The driver (drivers/postgres.js) only runs SQL; the
// SQL is PostgreSQL's own, with $1…$n parameters.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { fromDbTime, parseJsonColumn, toDbTime } = require('./util');

const SQL_DIR = path.join(__dirname, 'sql');
const CHUNK_ROWS = 200;
const MAX_INT = 2147483647;

// sql/NNNN_name.sql, each applied whole, in one transaction.
function loadMigrations(dir = SQL_DIR) {
  return fs.readdirSync(dir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => ({
      version: Number(name.slice(0, 4)),
      name: name.replace(/\.sql$/, ''),
      sql: fs.readFileSync(path.join(dir, name), 'utf8')
    }));
}

// PostgreSQL text cannot hold U+0000, and the hub has no use for it: dropped,
// so one odd string cannot make a device's writes fail for good.
function withoutNul(text) {
  return text.includes('\u0000') ? text.replaceAll('\u0000', '') : text;
}

function jsonText(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === 'string' ? withoutNul(v) : v));
}

// A value for a jsonb column: always serialized here, so a string, a number or
// a boolean is stored as that JSON value rather than parsed as JSON text.
function json(value) {
  return value === undefined || value === null ? null : jsonText(value);
}

function bind(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return withoutNul(value);
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value) || Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (typeof value === 'object') return jsonText(value);
  return value;
}

// An address for an inet column, or null: the audit trail must never fail on
// a source address it cannot parse.
function inet(value) {
  const text = String(value || '').trim();
  return net.isIP(text) ? text : null;
}

function placeholders(count, from = 1) {
  return Array.from({ length: count }, (_, index) => `$${from + index}`).join(', ');
}

// INSERT … ON CONFLICT … DO UPDATE for the key columns; `preserve` columns
// keep the value of the row that was already there (first_seen_at).
function upsertSql(table, columns, keyColumns, preserve = []) {
  const updates = columns.filter((column) => !keyColumns.includes(column) && !preserve.includes(column));
  const action = updates.length
    ? `DO UPDATE SET ${updates.map((column) => `${column} = EXCLUDED.${column}`).join(', ')}`
    : 'DO NOTHING';
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders(columns.length)}) ON CONFLICT (${keyColumns.join(', ')}) ${action}`;
}

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function createMutex() {
  let tail = Promise.resolve();
  return function withLock(fn) {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}

const DEVICE_COLUMNS = [
  'device_id', 'hostname', 'platform', 'os_name', 'os_version', 'agent_version', 'agent_runtime',
  'time_zone', 'today_key', 'month_key', 'sync_upload_interval_ms', 'projects_enabled',
  'session_details_omitted', 'updated_at', 'received_at', 'last_source_ip', 'record_json',
  'record_bytes', 'first_seen_at', 'deleted_at'
];

const USAGE_COLUMNS = [
  'tokens', 'cost_usd', 'messages', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens',
  'unclassified_tokens', 'has_token_components', 'active_time_ms', 'source',
  'source_received_at', 'first_seen_at', 'last_written_at'
];

const CLIENT_COLUMNS = ['client', 'tokens', 'cost_usd', 'messages', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'unclassified_tokens'];
const MODEL_COLUMNS = ['model', 'tokens', 'cost_usd', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'unclassified_tokens'];
const PROJECT_COLUMNS = ['project_key', 'label', 'tokens', 'cost_usd', 'clients'];

const SESSION_COLUMNS = [
  'device_id', 'usage_month', 'session_key', 'client', 'session_id', 'session_kind', 'project_id',
  'project_label', 'total_tokens', 'cost_usd', 'message_count', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'started_at', 'last_used_at',
  'models', 'model_costs', 'providers', 'source_received_at'
];

const LIMIT_COLUMNS = [
  'device_id', 'provider', 'account_key', 'account_label', 'plan_label', 'account_name',
  'account_email', 'workspace_kind', 'status', 'source', 'provider_updated_at', 'balance_usd',
  'balance', 'windows', 'provider_json', 'source_received_at'
];

const EVENT_COLUMNS = [
  'device_id', 'received_at', 'source_ip', 'auth_role', 'auth_key_index', 'agent_version',
  'payload_bytes', 'had_history', 'outcome'
];

// Both grains share one shape; only the key column and table names differ.
const GRAINS = Object.freeze({
  daily: {
    keyColumn: 'usage_date',
    main: 'device_daily_usage',
    clients: 'device_daily_client_usage',
    models: 'device_daily_model_usage',
    projects: 'device_daily_project_usage'
  },
  monthly: {
    keyColumn: 'usage_month',
    main: 'device_monthly_usage',
    clients: 'device_monthly_client_usage',
    models: 'device_monthly_model_usage',
    projects: 'device_monthly_project_usage'
  }
});

// The tables 刪除歷史資料 empties below its floor (../purge.js): every usage
// table of both grains, and the session details, with the column of their key
// and whether it is a day (YYYY-MM-DD) or a month (YYYY-MM).
const PURGE_TARGETS = Object.freeze([
  ...['daily', 'monthly'].flatMap((grain) => {
    const g = GRAINS[grain];
    return [g.main, g.clients, g.models, g.projects].map((table) => ({ table, column: g.keyColumn, unit: grain === 'daily' ? 'day' : 'month' }));
  }),
  { table: 'device_session_monthly_usage', column: 'usage_month', unit: 'month' }
]);

// A row of SUM()s as numbers; PostgreSQL sends bigint and numeric as text.
function sums(row) {
  return {
    first: row?.first ? String(row.first).slice(0, 10) : null,
    devices: Number(row?.devices || 0),
    tokens: Number(row?.tokens || 0),
    costUsd: Number(Number(row?.cost_usd || 0).toFixed(6))
  };
}

const PURGE_DAILY_SQL = 'SELECT MIN(usage_date) AS first, COUNT(DISTINCT device_id) AS devices, COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost_usd FROM device_daily_usage WHERE usage_date < $1';
const PURGE_MONTHLY_SQL = 'SELECT MIN(usage_month) AS first, COUNT(DISTINCT device_id) AS devices, COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost_usd FROM device_monthly_usage WHERE usage_month < $1';

function createStore(driver, { now = () => Date.now(), migrationsDir = SQL_DIR } = {}) {
  const mutex = createMutex();
  // Every write first confirms this process still holds the writer lock; a hub
  // that lost it must stop writing rather than race the one that took it over.
  // Reads are unaffected.
  const withLock = (fn) => mutex(fn);
  const withWriteLock = (fn) => mutex(() => {
    driver.assertWriter?.();
    return fn();
  });
  const migrations = loadMigrations(migrationsDir);
  // The day below which no usage is written (usage_purges), and how many rows
  // an upload carried below it.
  let floor = null;
  let belowFloor = 0;

  async function insertMany(runner, table, columns, rows) {
    for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
      const chunk = rows.slice(start, start + CHUNK_ROWS);
      const tuples = chunk.map((_, index) => `(${placeholders(columns.length, index * columns.length + 1)})`);
      await runner.run(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`,
        chunk.flatMap((row) => row.map(bind))
      );
    }
  }

  async function upsert(runner, table, columns, keyColumns, values, preserve) {
    await runner.run(upsertSql(table, columns, keyColumns, preserve), values.map(bind));
  }

  async function writeUsageRows(runner, grain, deviceId, rows, stamp) {
    const g = GRAINS[grain];
    for (const row of rows) {
      // Once a day or month has its final history row, a live row for the same
      // key (a snapshot that queued up before midnight and arrived after it) is
      // older news and must not replace it.
      if (row.source === 'live') {
        const [existing] = await runner.all(`SELECT source FROM ${g.main} WHERE device_id = $1 AND ${g.keyColumn} = $2`, [deviceId, row.key]);
        if (existing?.source === 'history') continue;
      }
      const t = row.totals;
      await upsert(runner, g.main, ['device_id', g.keyColumn, ...USAGE_COLUMNS], ['device_id', g.keyColumn], [
        deviceId, row.key, t.tokens, t.costUsd, t.messages, t.cacheReadTokens, t.cacheWriteTokens,
        t.outputTokens, t.unclassifiedTokens, t.tokenComponentsAvailable === true, t.activeTimeMs, row.source,
        stamp.receivedAt, stamp.writtenAt, stamp.writtenAt
      ], ['first_seen_at']);
      await runner.run(`DELETE FROM ${g.clients} WHERE device_id = $1 AND ${g.keyColumn} = $2`, [deviceId, row.key]);
      await insertMany(runner, g.clients, ['device_id', g.keyColumn, ...CLIENT_COLUMNS], row.clients.map((c) => [
        deviceId, row.key, c.key, c.tokens, c.costUsd, c.messages ?? null, c.cacheReadTokens,
        c.cacheWriteTokens, c.outputTokens, c.unclassifiedTokens
      ]));
      await runner.run(`DELETE FROM ${g.models} WHERE device_id = $1 AND ${g.keyColumn} = $2`, [deviceId, row.key]);
      await insertMany(runner, g.models, ['device_id', g.keyColumn, ...MODEL_COLUMNS], row.models.map((m) => [
        deviceId, row.key, m.key, m.tokens, m.costUsd, m.cacheReadTokens, m.cacheWriteTokens,
        m.outputTokens, m.unclassifiedTokens
      ]));
      // History rows carry no project attribution (projects === null), so they
      // leave the live project breakdown of the same day or month in place.
      if (Array.isArray(row.projects)) {
        await runner.run(`DELETE FROM ${g.projects} WHERE device_id = $1 AND ${g.keyColumn} = $2`, [deviceId, row.key]);
        await insertMany(runner, g.projects, ['device_id', g.keyColumn, ...PROJECT_COLUMNS], row.projects.map((p) => [
          deviceId, row.key, p.key, p.label, p.tokens, p.costUsd, json(p.clients ?? {})
        ]));
      }
    }
  }

  // One device record and its rows, in one transaction. 'stale' without
  // writing when the database already holds a newer record for the device.
  function writeRecord(d, stamp, daily, monthly, sessions, limits) {
    return driver.transaction(async (tx) => {
      const [existing] = await tx.all('SELECT received_at FROM devices WHERE device_id = $1 FOR UPDATE', [d.deviceId]);
      if (existing && Date.parse(existing.received_at) > Date.parse(d.receivedAt)) return 'stale';
      await upsert(tx, 'devices', DEVICE_COLUMNS, ['device_id'], [
        d.deviceId, d.hostname, d.platform, d.osName, d.osVersion, d.agentVersion, d.agentRuntime,
        d.timeZone, d.todayKey, d.monthKey, d.syncUploadIntervalMs, d.projectsEnabled,
        json(d.sessionDetailsOmitted), d.updatedAt, d.receivedAt, inet(d.lastSourceIp), d.recordJson,
        Buffer.byteLength(d.recordJson, 'utf8'), stamp.writtenAt, null
      ], ['first_seen_at']);
      await writeUsageRows(tx, 'daily', d.deviceId, daily, stamp);
      await writeUsageRows(tx, 'monthly', d.deviceId, monthly, stamp);
      for (const s of sessions) {
        await upsert(tx, 'device_session_monthly_usage', SESSION_COLUMNS, ['device_id', 'usage_month', 'session_key'], [
          d.deviceId, s.month, s.sessionKey, s.client, s.sessionId, s.sessionKind, s.projectId,
          s.projectLabel, s.totalTokens, s.costUsd, s.messageCount, s.inputTokens, s.outputTokens,
          s.cacheReadTokens, s.cacheWriteTokens, s.reasoningTokens, s.startedAt, s.lastUsedAt,
          json(s.models ?? {}), json(s.modelCosts ?? {}), json(s.providers ?? {}), stamp.receivedAt
        ]);
      }
      for (const l of limits) {
        await upsert(tx, 'device_limits', LIMIT_COLUMNS, ['device_id', 'provider', 'account_key'], [
          d.deviceId, l.provider, l.accountKey, l.accountLabel, l.planLabel, l.accountName,
          l.accountEmail, l.workspaceKind, l.status, l.source, l.providerUpdatedAt, l.balanceUsd,
          json(l.balance), json(l.windows), json(l.providerJson ?? {}), stamp.receivedAt
        ]);
      }
      return 'applied';
    });
  }

  // The hub's schema, created when it is missing. Checked first: an account
  // that may not create schemas can still run against one made for it.
  async function ensureSchema() {
    const schema = driver.schema;
    if (!schema) return;
    const [exists] = await driver.all('SELECT 1 AS present FROM pg_namespace WHERE nspname = $1', [schema]);
    if (!exists) await driver.exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
  }

  return {
    dialect: driver.dialect,
    latestSchemaVersion: migrations.length ? migrations[migrations.length - 1].version : 0,

    async migrate() {
      return withLock(() => driver.withMigrationLock(async () => {
        await ensureSchema();
        await driver.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL)');
        const rows = await driver.all('SELECT version FROM schema_migrations');
        const applied = new Set(rows.map((row) => Number(row.version)));
        const newest = Math.max(0, ...applied);
        const known = migrations.length ? migrations[migrations.length - 1].version : 0;
        if (newest > known) {
          throw new Error(`database schema version ${newest} is newer than this hub understands (${known}); upgrade the hub instead of downgrading the schema`);
        }
        const ran = [];
        for (const migration of migrations) {
          if (applied.has(migration.version)) continue;
          await driver.transaction(async (tx) => {
            await tx.exec(migration.sql);
            await tx.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)', [
              migration.version, migration.name, toDbTime(now())
            ]);
          });
          ran.push(migration.name);
        }
        return ran;
      }));
    },

    acquireWriterLock() {
      return driver.acquireWriterLock();
    },

    // Everything the hub's JSON cache needs to be rebuilt after a restart.
    async loadSnapshot() {
      return withLock(async () => {
        const devices = {};
        for (const row of await driver.all('SELECT device_id, record_json FROM devices WHERE deleted_at IS NULL')) {
          const record = parseJsonColumn(row.record_json, null);
          if (record && typeof record === 'object') devices[row.device_id] = record;
        }
        const [subs] = await driver.all('SELECT document FROM hub_subscriptions WHERE id');
        return { devices, subscriptions: subs ? parseJsonColumn(subs.document, null) : null };
      });
    },

    // One transaction per device record. Returns 'stale' without writing when
    // the database already holds a newer record for the device (ordering is by
    // the hub's receivedAt, never the device clock).
    async writeCapture(capture) {
      const d = capture.device;
      const stamp = { receivedAt: d.receivedAt, writtenAt: toDbTime(now()) };
      return withWriteLock(() => {
        // Below the floor an admin deleted to, nothing comes back: the device's
        // own history still carries those days and months. Read inside the lock,
        // so a write queued behind a purge sees its floor.
        const f = floor;
        const daily = f ? capture.daily.filter((row) => row.key >= f.day) : capture.daily;
        const monthly = f ? capture.monthly.filter((row) => row.key >= f.month) : capture.monthly;
        const sessions = f ? capture.sessions.filter((row) => row.month >= f.month) : capture.sessions;
        belowFloor += capture.daily.length - daily.length + capture.monthly.length - monthly.length + capture.sessions.length - sessions.length;
        return writeRecord(d, stamp, daily, monthly, sessions, capture.limits);
      });
    },

    // The floor of the last purge, read once the schema is migrated.
    async loadPurgeFloor() {
      const [row] = await withLock(() => driver.all('SELECT MAX(before_date) AS day FROM usage_purges'));
      const day = row?.day ? String(row.day).slice(0, 10) : null;
      floor = day ? { day, month: day.slice(0, 7) } : null;
      return floor;
    },

    purgeState() {
      return { floor: floor ? { ...floor } : null, belowFloorSkipped: belowFloor };
    },

    // The first day and month any device has usage for.
    async earliestUsage() {
      const [row] = await withLock(() => driver.all('SELECT (SELECT MIN(usage_date) FROM device_daily_usage) AS day, (SELECT MIN(usage_month) FROM device_monthly_usage) AS month'));
      return { day: row?.day ? String(row.day).slice(0, 10) : null, month: row?.month || null };
    },

    // What purgeUsage(beforeDate) would delete: rows per table, and the days'
    // and months' totals.
    async previewPurge(beforeDate) {
      const month = beforeDate.slice(0, 7);
      return withLock(async () => {
        const tables = {};
        for (const t of PURGE_TARGETS) {
          const [row] = await driver.all(`SELECT COUNT(*) AS n FROM ${t.table} WHERE ${t.column} < $1`, [t.unit === 'day' ? beforeDate : month]);
          tables[t.table] = Number(row?.n || 0);
        }
        const [daily] = await driver.all(PURGE_DAILY_SQL, [beforeDate]);
        const [monthly] = await driver.all(PURGE_MONTHLY_SQL, [month]);
        return { beforeDate, tables, daily: sums(daily), monthly: sums(monthly) };
      });
    },

    // Deletes every device's usage before beforeDate (the 1st of a month) in
    // one transaction and records it; the floor moves up once it is committed,
    // still inside the write lock, so no upload is written in between.
    async purgeUsage({ beforeDate, actor, backupFile = null }) {
      const month = beforeDate.slice(0, 7);
      return withWriteLock(async () => {
        const result = await driver.transaction(async (tx) => {
          const totals = { daily: sums((await tx.all(PURGE_DAILY_SQL, [beforeDate]))[0]), monthly: sums((await tx.all(PURGE_MONTHLY_SQL, [month]))[0]) };
          const deleted = {};
          for (const t of PURGE_TARGETS) {
            deleted[t.table] = (await tx.run(`DELETE FROM ${t.table} WHERE ${t.column} < $1`, [t.unit === 'day' ? beforeDate : month])).changes;
          }
          const purgedAt = toDbTime(now());
          const [row] = await tx.all(
            'INSERT INTO usage_purges (before_date, purged_by, purged_at, deleted_rows, totals, backup_file) VALUES ($1, $2, $3, $4, $5, $6) RETURNING purge_id',
            [beforeDate, actor, purgedAt, jsonText(deleted), jsonText(totals), backupFile]
          );
          return { purgeId: Number(row.purge_id), beforeDate, purgedAt: fromDbTime(purgedAt), deleted, totals, backupFile };
        });
        if (!floor || beforeDate > floor.day) floor = { day: beforeDate, month };
        return result;
      });
    },

    async listPurges(limit = 50) {
      const rows = await withLock(() => driver.all('SELECT purge_id, before_date, purged_by, purged_at, deleted_rows, totals, backup_file FROM usage_purges ORDER BY purge_id DESC LIMIT $1', [limit]));
      return rows.map((row) => ({
        purgeId: Number(row.purge_id),
        beforeDate: String(row.before_date).slice(0, 10),
        purgedBy: row.purged_by,
        purgedAt: fromDbTime(row.purged_at),
        deleted: parseJsonColumn(row.deleted_rows, {}),
        totals: parseJsonColumn(row.totals, {}),
        backupFile: row.backup_file || null
      }));
    },

    // A delete keeps the device's history for reporting; the row just stops
    // being rehydrated. An ingest from the same device id clears the mark.
    async softDeleteDevice(deviceId) {
      return withWriteLock(() => driver.run('UPDATE devices SET deleted_at = $1 WHERE device_id = $2', [toDbTime(now()), deviceId]));
    },

    async writeSubscriptions(document) {
      return withWriteLock(() => upsert(driver, 'hub_subscriptions', ['id', 'updated_at_token', 'document', 'written_at'], ['id'], [
        true, String(document?.updatedAt || ''), jsonText(document), toDbTime(now())
      ]));
    },

    // One transaction for the whole batch, so a failure part-way cannot leave
    // some chunks written and the retry write them twice; every value is kept
    // inside its column's rules so one odd row cannot wedge the buffer.
    async insertIngestEvents(events) {
      if (!events.length) return;
      const clip = (value, max) => String(value ?? '').slice(0, max);
      const rows = events.map((e) => [
        clip(e.deviceId, 191), toDbTime(e.receivedAt) || toDbTime(now()), inet(e.sourceIp),
        e.authRole === 'admin' ? 'admin' : 'client',
        Number.isInteger(e.authKeyIndex) && e.authKeyIndex >= 0 && e.authKeyIndex <= 255 ? e.authKeyIndex : null,
        clip(e.agentVersion, 64), Math.min(MAX_INT, Math.max(0, Math.floor(Number(e.payloadBytes) || 0))),
        Boolean(e.hadHistory), ['applied', 'coalesced', 'rejected'].includes(e.outcome) ? e.outcome : 'rejected'
      ]);
      return withWriteLock(() => driver.transaction((tx) => insertMany(tx, 'ingest_events', EVENT_COLUMNS, rows)));
    },

    async prune({ sessionRetentionMonths, auditRetentionDays } = {}) {
      const result = { sessions: 0, events: 0 };
      const current = new Date(now());
      if (sessionRetentionMonths > 0) {
        const cutoff = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - sessionRetentionMonths, 1));
        const month = cutoff.toISOString().slice(0, 7);
        result.sessions = (await withWriteLock(() => driver.run('DELETE FROM device_session_monthly_usage WHERE usage_month < $1', [month]))).changes;
      }
      if (auditRetentionDays > 0) {
        const cutoff = toDbTime(now() - auditRetentionDays * 24 * 60 * 60 * 1000);
        for (;;) {
          const { changes } = await withWriteLock(() => driver.run(
            'DELETE FROM ingest_events WHERE id IN (SELECT id FROM ingest_events WHERE received_at < $1 ORDER BY id LIMIT 5000)',
            [cutoff]
          ));
          result.events += changes;
          if (changes < 5000) break;
        }
      }
      return result;
    },

    // Serialized access for the reporting and admin modules, so their reads and
    // writes queue behind the ingest writes like everything else. With
    // timeoutMs, a driver that can (PostgreSQL) has the server cancel the read
    // past it, so one slow question cannot hold the lock the uploads wait on.
    query(statement, params = [], { timeoutMs = 0 } = {}) {
      return withLock(() => (timeoutMs > 0 && driver.allBounded
        ? driver.allBounded(statement, params.map(bind), timeoutMs)
        : driver.all(statement, params.map(bind))));
    },
    execute(statement, params = []) {
      return withWriteLock(() => driver.run(statement, params.map(bind)));
    },
    transaction(fn) {
      return withWriteLock(() => driver.transaction((tx) => fn({
        all: (statement, params = []) => tx.all(statement, params.map(bind)),
        run: (statement, params = []) => tx.run(statement, params.map(bind))
      })));
    },
    upsertSql,

    async close() {
      await withLock(() => driver.close());
    }
  };
}

module.exports = { createStore, fromDbTime, json, loadMigrations, upsertSql };
