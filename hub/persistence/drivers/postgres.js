'use strict';

// PostgreSQL driver (node-postgres). The store (../store.js) runs every
// statement through it:
//
//   run(sql, params)   → { changes }        all(sql, params) → rows
//   allBounded(sql, params, ms)  all(), cancelled by the server after ms
//   exec(sql)          several statements, no parameters (migrations)
//   transaction(fn)    fn(runner) on one connection, BEGIN … COMMIT
//   acquireWriterLock(), assertWriter(), checkLock(), withMigrationLock(fn)
//
// Every connection starts with the hub's schema on its search_path and the
// session time zone at UTC, so SQL never names the schema and timestamps come
// back in one shape (./types.js).
//
// One hub per schema: the hub keeps its device state in memory, so a second
// hub writing the same tables would fork it. A session-level advisory lock on
// its own connection says who the writer is; PostgreSQL drops it the moment
// that session ends, and it is re-checked every 30 s. While the lock is not
// ours, assertWriter() refuses every write.

const LOCK_CLASS = 0x544d4842; // 'TMHB': the first key of every lock the hub takes
const LOCK_CHECK_MS = 30 * 1000;
const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

function assertSchemaName(schema) {
  if (!SCHEMA_RE.test(String(schema || ''))) {
    throw new Error(`database schema must be a lowercase identifier ([a-z_][a-z0-9_]*, at most 63 characters), got "${schema}"`);
  }
  return schema;
}

function openPostgres(url, { schema = 'token_monitor', poolSize = 4, logger = console, pg, lockCheckMs = LOCK_CHECK_MS } = {}) {
  assertSchemaName(schema);
  const lib = pg || require('pg');
  const { pgTypes } = require('./types');
  const config = {
    connectionString: url,
    options: `-c search_path=${schema} -c TimeZone=UTC`,
    types: pgTypes(lib.types),
    application_name: 'token-monitor-hub'
  };
  const pool = new lib.Pool({ ...config, max: Math.max(1, Number(poolSize) || 4) });
  // An idle client that loses its connection must not take the process down.
  pool.on('error', (error) => (logger.warn || console.warn)(`[persistence] idle database connection failed: ${error.message}`));
  const writerKey = `token_monitor.writer.${schema}`;
  const migrationKey = `token_monitor.migrate.${schema}`;
  let lockClient = null;
  let lockWanted = false;
  let lockLost = false;
  let checkTimer = null;

  const runner = (target) => ({
    async run(sql, params = []) {
      const result = await target.query(sql, params);
      return { changes: Number(result?.rowCount || 0) };
    },
    async all(sql, params = []) {
      return (await target.query(sql, params)).rows;
    },
    async exec(sql) {
      await target.query(sql);
    }
  });

  async function takeLock() {
    const client = new lib.Client(config);
    client.on('error', (error) => {
      lockLost = true;
      (logger.error || console.error)(`[persistence] lost the writer-lock connection, writes paused: ${error.message}`);
    });
    try {
      await client.connect();
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1, hashtext($2)) AS got', [LOCK_CLASS, writerKey]);
      if (rows[0]?.got !== true) throw new Error(`another hub already holds the writer lock for schema ${schema}; run exactly one hub per schema`);
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
    return client;
  }

  async function holdsLock(client) {
    const { rows } = await client.query(
      `SELECT count(*) AS n FROM pg_locks
       WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
         AND classid = $1::int4::oid AND objid = hashtext($2)::oid AND objsubid = 2`,
      [LOCK_CLASS, writerKey]
    );
    return Number(rows[0]?.n) > 0;
  }

  // Confirms the lock is still ours; if its connection died, tries to take it
  // back.
  async function checkLock() {
    if (!lockWanted) return;
    if (lockClient && !lockLost) {
      try {
        if (await holdsLock(lockClient)) return;
      } catch (_) {
        // A failed query means the lock connection is gone: handled as lost below.
      }
      lockLost = true;
      (logger.error || console.error)('[persistence] the writer lock is no longer held by this hub; writes paused');
    }
    try {
      if (lockClient) await lockClient.end().catch(() => {});
      lockClient = await takeLock();
      lockLost = false;
      (logger.warn || console.warn)('[persistence] took the writer lock back; writes resume');
    } catch (error) {
      lockClient = null;
      (logger.error || console.error)(`[persistence] cannot take the writer lock back: ${error.message}`);
    }
  }

  return {
    dialect: 'postgres',
    schema,
    ...runner(pool),
    async transaction(fn) {
      const client = await pool.connect();
      let broken = null;
      try {
        await client.query('BEGIN');
        const result = await fn(runner(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          broken = rollbackError;
        }
        throw error;
      } finally {
        // A connection that cannot even roll back is not handed out again.
        client.release(broken || undefined);
      }
    },
    // One read the server cancels after timeoutMs (57014 query_canceled).
    // SET LOCAL lasts as long as its transaction, so nothing of it stays on
    // the pooled connection for the uploads' writes.
    async allBounded(sql, params = [], timeoutMs = 0) {
      const ms = Math.max(1, Math.floor(Number(timeoutMs) || 0));
      const client = await pool.connect();
      let broken = null;
      try {
        await client.query('BEGIN READ ONLY');
        await client.query(`SET LOCAL statement_timeout = ${ms}`);
        const { rows } = await client.query(sql, params);
        await client.query('COMMIT');
        return rows;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          broken = rollbackError;
        }
        throw error;
      } finally {
        client.release(broken || undefined);
      }
    },
    async acquireWriterLock() {
      if (lockClient) return;
      lockClient = await takeLock();
      lockWanted = true;
      lockLost = false;
      checkTimer = setInterval(() => { checkLock().catch(() => {}); }, lockCheckMs);
      checkTimer.unref?.();
    },
    assertWriter() {
      if (lockWanted && (lockLost || !lockClient)) {
        throw new Error('this hub does not hold the writer lock; writes are paused until it is taken back');
      }
    },
    checkLock,
    // Two hubs starting at once must not both apply a migration. The lock has
    // its own connection: the migrations run on the pool, which may hold just
    // one.
    async withMigrationLock(fn) {
      const client = new lib.Client(config);
      client.on('error', () => {});
      await client.connect();
      try {
        await client.query('SELECT pg_advisory_lock($1, hashtext($2))', [LOCK_CLASS, migrationKey]);
        return await fn();
      } finally {
        await client.end().catch(() => {});
      }
    },
    async close() {
      if (checkTimer) clearInterval(checkTimer);
      checkTimer = null;
      lockWanted = false;
      if (lockClient) {
        await lockClient.query('SELECT pg_advisory_unlock($1, hashtext($2))', [LOCK_CLASS, writerKey]).catch(() => {});
        await lockClient.end().catch(() => {});
        lockClient = null;
      }
      await pool.end();
    }
  };
}

module.exports = { LOCK_CLASS, SCHEMA_RE, assertSchemaName, openPostgres };
