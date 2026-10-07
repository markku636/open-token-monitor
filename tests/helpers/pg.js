'use strict';

// PostgreSQL for the tests, two ways:
//
//   PGlite       PostgreSQL compiled to WebAssembly, in this process: always
//                available. Starting it takes seconds, so one instance serves
//                a whole test file and every openPglite() gets a schema of its
//                own on it. It behaves like the real server for every
//                statement the hub runs, but it is one session, so the writer
//                lock and lost connections cannot be shown on it.
//   a server     opt-in: set TOKEN_MONITOR_TEST_DATABASE_URL to a database the
//                user may create schemas in, for example the one compose.yml
//                starts (postgres://token_monitor:pw@127.0.0.1:5432/token_monitor).
//                Each call gets its own schema and drops it afterwards.

const { PARSERS } = require('../../hub/persistence/drivers/types');

const TEST_DATABASE_URL = process.env.TOKEN_MONITOR_TEST_DATABASE_URL || '';
const SKIP_SERVER = TEST_DATABASE_URL ? false : 'set TOKEN_MONITOR_TEST_DATABASE_URL to run this against a PostgreSQL server';
const SCHEMA = 'token_monitor';

let instance = null;
let schemas = 0;
// The one session's search_path belongs to whichever schema ran last, so every
// statement of every schema goes through this queue and sets it first.
let tail = Promise.resolve();
let active = null;

function serialized(fn) {
  const run = tail.then(fn, fn);
  tail = run.then(() => {}, () => {});
  return run;
}

function shared() {
  if (!instance) {
    const { PGlite } = require('@electric-sql/pglite');
    instance = PGlite.create({ parsers: PARSERS }).then(async (db) => {
      await db.exec("SET TIME ZONE 'UTC'");
      return db;
    });
  }
  return instance;
}

// The driver interface of hub/persistence/drivers/postgres.js, over a fresh
// schema of the shared PGlite, or over one opened before (a hub restart).
// Closing it leaves the schema in place; the instance lives as long as the
// test file does.
async function openPglite({ schema: reuse = '' } = {}) {
  const db = await shared();
  if (!reuse) schemas += 1;
  const schema = reuse || `${SCHEMA}_${schemas}`;
  const use = async () => {
    if (active === schema) return;
    await db.exec(`SET search_path TO ${schema}`);
    active = schema;
  };
  const runner = (target) => ({
    async run(sql, params = []) {
      return { changes: Number((await target.query(sql, params)).affectedRows || 0) };
    },
    async all(sql, params = []) {
      return (await target.query(sql, params)).rows;
    },
    async exec(sql) {
      await target.exec(sql);
    }
  });
  const direct = runner(db);
  const inSchema = (method) => (...args) => serialized(async () => {
    await use();
    return direct[method](...args);
  });
  let closed = false;
  return {
    dialect: 'postgres',
    schema,
    run: inSchema('run'),
    all: inSchema('all'),
    exec: inSchema('exec'),
    transaction: (fn) => serialized(async () => {
      await use();
      return db.transaction((tx) => fn(runner(tx)));
    }),
    // One session: there is nobody to lock out.
    async acquireWriterLock() {},
    async withMigrationLock(fn) {
      return fn();
    },
    async close() {
      closed = true;
    },
    get closed() {
      return closed;
    }
  };
}

// A persistence config (hub/persistence/index.js) on a fresh PGlite schema,
// or on `schema` again.
async function pgliteConfig({ schema = '', ...extra } = {}) {
  const driver = await openPglite({ schema });
  return {
    kind: 'postgres',
    driver,
    schema: driver.schema,
    required: true,
    sessionRetentionMonths: 24,
    auditRetentionDays: 90,
    ...extra
  };
}

// A throwaway schema on the opt-in server.
async function createTestSchema() {
  const { Client } = require('pg');
  const schema = `tm_test_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const admin = new Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  return {
    url: TEST_DATABASE_URL,
    schema,
    admin,
    config: (extra = {}) => ({
      kind: 'postgres',
      databaseUrl: TEST_DATABASE_URL,
      schema,
      poolSize: 4,
      required: true,
      sessionRetentionMonths: 24,
      auditRetentionDays: 90,
      ...extra
    }),
    async drop() {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  };
}

// The same scenario on both: PGlite always, the server when there is one.
// setup() → { openDriver() (a driver for seeding the database directly),
// persistenceConfig (for startOverlayHub), cleanup() }.
const BACKENDS = Object.freeze([
  {
    name: 'pglite',
    skip: false,
    async setup() {
      const { schema } = await openPglite();
      return {
        openDriver: () => openPglite({ schema }),
        persistenceConfig: await pgliteConfig({ schema }),
        cleanup: async () => {}
      };
    }
  },
  {
    name: 'postgres',
    skip: SKIP_SERVER,
    async setup() {
      const { openPostgres } = require('../../hub/persistence/drivers/postgres');
      const target = await createTestSchema();
      return {
        openDriver: () => openPostgres(target.url, { schema: target.schema, poolSize: 2 }),
        persistenceConfig: target.config({ poolSize: 2 }),
        cleanup: () => target.drop()
      };
    }
  }
]);

module.exports = { BACKENDS, SCHEMA, SKIP_SERVER, TEST_DATABASE_URL, createTestSchema, openPglite, pgliteConfig };
