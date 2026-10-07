'use strict';

// Everything the fork adds to a running hub, attached as one request layer in
// front of the dashboard layer and upstream's handler (see router.js):
//
//   public      OPTIONS, /api/health, the dashboard, the reports API's docs
//               (/llms.txt, /llms-full.txt, its OpenAPI document; apiDocs.js)
//   access      admin / client keys, API tokens (access.js, apiTokens.js),
//               the dashboard's admin sessions at /api/auth/* (sessions.js)
//   stream      /api/stats and /api/stats/stream from a windowed cache (stream.js)
//   writes      /api/ingest, DELETE /api/devices/:id, PUT /api/subscriptions,
//               persisted to PostgreSQL when a store is configured
//   core        with a store, the device state itself (core.js): upstream's
//               whole-file JSON rewrite on every upload is never run, and the
//               data routes upstream would answer from its closure are
//               answered here from the core instead
//   reports     /api/reports/v1/*, /api/admin/* (reports.js, admin.js); of
//               the reports API, the org tree, employees, quota windows and
//               the usage analysis for analytics:read (analytics.js)
//   org         company → department → team: the tree at /api/custom/org and
//               /api/stats?org=<unit>, device owners from HR imports (org.js)
//   usage       /api/custom/usage: a unit's or one person's trend, units and
//               comparisons for the dashboard (usage.js)
//   backups     the database's daily and on-demand pg_dump, behind
//               /api/admin/backups (backups.js)
//   purge       刪除歷史資料: every device's usage before a month, at
//               /api/admin/usage-purge (purge.js)
//
// Every other request goes to upstream unchanged, with its credential swapped
// for the admin secret once the overlay has authorized it.

const fs = require('node:fs');
const zlib = require('node:zlib');
const { URL } = require('node:url');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { upstream } = require('../upstream');
const { readJsonBody, sendJson } = require(upstream('src/shared/http'));
const { acceptsEncoding } = require(upstream('src/shared/hubProtocol'));
const { createAccessControl, sourceAddress } = require('./access');
const { createStatsBroadcaster } = require('./stream');
const { createIngestPipeline } = require('./ingest');
const { createPersistenceRuntime } = require('./persistence');
const { createReports } = require('./reports');
const { createAnalytics } = require('./analytics');
const { createApiDocs } = require('./apiDocs');
const { createAdmin } = require('./admin');
const { createApiTokens } = require('./apiTokens');
const { createAdminSessions, sameSiteWrite } = require('./sessions');
const { createOrg } = require('./org');
const { createUsage } = require('./usage');
const { createBackups } = require('./backups');
const { createPurge } = require('./purge');
const { createHubCore } = require('./core');
const { wrapRequestListeners } = require('./router');

// Scaling thresholds: past any of them the overlay's capture approach has
// to give way to a store seam or a rewritten route layer.
// The upstream release this hub runs, which is the client version it was
// built for (docs/client-setup.zh-TW.md): the dashboard compares every
// device's client against it.
const UPSTREAM_VERSION = (() => {
  try {
    return String(require(upstream('package.json')).version || '') || null;
  } catch (_) {
    return null;
  }
})();

const THRESHOLDS = Object.freeze({ ingestMsP95: 150, eventLoopMsP99: 250, cacheFileBytes: 60 * 1024 * 1024 });
const THRESHOLD_CHECK_MS = 60 * 1000;
const THRESHOLD_WARN_EVERY_MS = 10 * 60 * 1000;

function mapBodyError(res, error) {
  if (error.code === 'payload_too_large') {
    res.shouldKeepAlive = false;
    return sendJson(res, 413, { error: 'payload_too_large', message: error.message }, { connection: 'close' });
  }
  return sendJson(res, 400, { error: 'bad_request', message: error.message });
}

function attachOverlay(hub, options = {}) {
  const {
    secret = '',
    clientSecrets = [],
    trustProxy = false,
    publicDashboard = false,
    streamWindowMs = 60 * 1000,
    staleAfterMs,
    ingestMinIntervalMs = 0,
    persistence = null,
    backup = {},
    dataFile = '',
    publicPaths = new Set(),
    maxConnections = 2000,
    logger = console,
    now = () => Date.now()
  } = options;

  // Node's defaults let one slow sender hold a socket for 300 s and put no cap on
  // sockets at all (defect A9). Uploads are at most 1 MiB, so a minute is ample;
  // the cap leaves room for every widget's stream plus its uploads and polls.
  // Streams are unaffected: requestTimeout only bounds receiving the request.
  hub.server.requestTimeout = 60 * 1000;
  hub.server.headersTimeout = 20 * 1000;
  hub.server.maxConnections = Math.max(100, Number(maxConnections) || 2000);
  const runtime = persistence ? createPersistenceRuntime(persistence, { logger, now }) : null;
  // API tokens live in the database; a hub without one has none.
  const apiTokens = runtime ? createApiTokens({ store: runtime.store, now, logger }) : null;
  apiTokens?.start();
  // The dashboard signs admins in with a cookie instead of keeping the admin
  // secret in the browser; with a database the sessions survive a restart.
  const sessions = createAdminSessions({ secret, store: runtime?.store || null, trustProxy, now, logger });
  sessions.start();
  const access = createAccessControl({ adminSecret: secret, clientSecrets, apiTokens, sessions, anonymousRead: publicDashboard });
  // With a store the overlay owns the device state (core.js). The hub object's
  // data methods are pointed at the core, so everything that reads the hub —
  // the stream, the widget-facing routes below — sees the live state.
  const core = runtime
    ? createHubCore({ staleAfterMs, secret, devices: persistence.snapshot?.devices, subscriptions: persistence.snapshot?.subscriptions })
    : null;
  if (core) {
    Object.assign(hub, {
      getStats: core.getStats,
      getHistory: core.getHistory,
      getDevices: core.getDevices,
      ingest: core.ingest,
      deleteDevice: core.deleteDevice,
      getSubscriptions: core.getSubscriptions,
      setSubscriptions: core.setSubscriptions
    });
    runtime.queue.seed(core.getDevices());
  }
  // Org charts need the database; without one the org tabs simply stay empty.
  const org = core
  ? createOrg({ store: runtime.store, hub, onChange: () => { stream.invalidateFilters(); usage.invalidate(); }, logger, now })
  : null;
  const stream = createStatsBroadcaster(hub, {
    windowMs: streamWindowMs,
    filteredStats: (unit) => {
      const devices = org?.devicesUnder(unit);
      return devices ? core.getStatsFor(devices) : null;
    },
    logger,
    now
  });
  const ingest = createIngestPipeline(hub, {
    minIntervalMs: ingestMinIntervalMs,
    persistence: runtime?.queue || null,
    audit: runtime?.events || null,
    onApplied: () => stream.markDirty(),
    onOwnerEmail: (deviceId, email) => org?.recordClaim(deviceId, email),
    lookup: core ? core.getDevice : undefined,
    statsProvider: () => stream.currentStats(),
    logger,
    now
  });
  const reports = createReports({ store: runtime?.store || null });
  // Dumps of the database: without one there is nothing to back up.
  const backups = runtime
    ? createBackups({ databaseUrl: persistence.config?.databaseUrl || '', schema: persistence.config?.schema || 'token_monitor', ...backup, store: runtime.store, logger, now })
    : null;
  backups?.start().catch((error) => (logger.warn || console.warn)(`[backups] start failed: ${error.message}`));
  // 刪除歷史資料: once usage is gone, no cached answer may still show it.
  const purge = runtime ? createPurge({ store: runtime.store, backups, onPurged: () => usage.invalidate(), now, logger }) : null;
  const admin = createAdmin({ store: runtime?.store || null, now, org, apiTokens, backups, purge });
  const usage = createUsage({ store: runtime?.store || null, org, cacheMs: streamWindowMs, now });
  const analytics = createAnalytics({ store: runtime?.store || null, org, usage });
  const docs = createApiDocs({ trustProxy });
  org?.start().catch((error) => (logger.warn || console.warn)(`[org] start failed: ${error.message}`));

  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let lastThresholdWarning = 0;
  const thresholdTimer = setInterval(() => {
    const status = health();
    const breaches = [];
    if (status.ingest.ingestMsP95 > THRESHOLDS.ingestMsP95) breaches.push(`ingest p95 ${status.ingest.ingestMsP95} ms`);
    if (status.eventLoop.p99Ms > THRESHOLDS.eventLoopMsP99) breaches.push(`event loop p99 ${status.eventLoop.p99Ms} ms`);
    if (status.cacheFile.bytes > THRESHOLDS.cacheFileBytes) breaches.push(`cache file ${status.cacheFile.bytes} bytes`);
    if (breaches.length && now() - lastThresholdWarning >= THRESHOLD_WARN_EVERY_MS) {
      lastThresholdWarning = now();
      (logger.warn || console.warn)(`[overlay] past the scaling thresholds: ${breaches.join(', ')}`);
    }
    loop.reset();
  }, THRESHOLD_CHECK_MS);
  thresholdTimer.unref?.();

  function cacheFileBytes() {
    try {
      return dataFile ? fs.statSync(dataFile).size : null;
    } catch (_) {
      return null;
    }
  }

  function health() {
    return {
      ok: true,
      hub: { upstreamVersion: UPSTREAM_VERSION },
      access: access.roles,
      sessions: sessions.status(),
      apiTokens: apiTokens ? apiTokens.status() : null,
      ingest: ingest.status(),
      stream: stream.status(),
      persistence: runtime ? { ...runtime.status(), core: 'overlay' } : { kind: 'none', core: 'upstream' },
      org: org ? org.status() : null,
      backups: backups ? backups.summary() : null,
      eventLoop: { p99Ms: Number((loop.percentile(99) / 1e6).toFixed(1)) },
      cacheFile: { path: dataFile, bytes: cacheFileBytes() },
      thresholds: THRESHOLDS
    };
  }

  // Like /api/stats, an answer to a keyless caller carries no CORS header, so
  // only the hub's own page can read it.
  function sendReadable(req, res, status, payload, cors, headers = {}) {
    if (cors) return sendJson(res, status, payload, headers);
    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    const compressed = acceptsEncoding(req, 'gzip') && json.byteLength >= 1024;
    const body = compressed ? zlib.gzipSync(json, { level: zlib.constants.Z_BEST_SPEED }) : json;
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(body.byteLength),
      ...(compressed ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}),
      ...headers
    });
    return res.end(body);
  }

  // Names only for the admin key: the client key is handed to every user.
  // A 503 usage_busy carries Retry-After, which the page waits out.
  async function handleUsage(req, res, url, role) {
    const { status, payload, headers } = await usage.read(url, { people: role === 'admin' });
    return sendReadable(req, res, status, payload, role !== 'viewer', headers);
  }

  async function handleDelete(req, res, pathname) {
    let deviceId;
    try {
      deviceId = decodeURIComponent(pathname.slice('/api/devices/'.length));
    } catch (error) {
      // Upstream answers a malformed escape with a 500 (defect A9).
      return sendJson(res, 400, { error: 'bad_request', message: error.message });
    }
    // Forget queued work first: a write still waiting would otherwise clear the
    // delete mark again right after it was set.
    ingest.forget(deviceId);
    runtime?.queue.forget(deviceId);
    if (runtime) {
      try {
        await runtime.store.softDeleteDevice(deviceId);
      } catch (error) {
        return sendJson(res, 503, { error: 'storage_unavailable', message: error.message });
      }
    }
    hub.deleteDevice(deviceId);
    stream.markDirty({ immediate: true, reason: 'delete' });
    return sendJson(res, 200, { ok: true, deviceId });
  }

  async function handleSubscriptions(req, res) {
    let payload;
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      return mapBodyError(res, error);
    }
    let stored;
    try {
      if (core) {
        // Upstream's order: validate, persist, and only then move the list, so
        // a database that refuses the write leaves every reader on the old one.
        const next = core.prepareSubscriptions(payload?.subscriptions, payload?.baseUpdatedAt);
        try {
          await runtime.store.writeSubscriptions(next);
        } catch (error) {
          return sendJson(res, 503, { error: 'storage_unavailable', message: error.message });
        }
        stored = core.commitSubscriptions(next);
      } else {
        stored = hub.setSubscriptions(payload?.subscriptions, payload?.baseUpdatedAt);
      }
    } catch (error) {
      if (error.code === 'stale_write') return sendJson(res, 409, { error: 'stale_write', ...error.current });
      return sendJson(res, 400, { error: 'bad_request', message: error.message });
    }
    stream.markDirty({ immediate: true, reason: 'subscriptions' });
    return sendJson(res, 200, { ok: true, ...stored });
  }

  wrapRequestListeners(hub.server, async (req, res, forward) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch (_) {
      return forward(req, res);
    }
    const { pathname } = url;
    const method = req.method;

    if (method === 'OPTIONS') return forward(req, res);
    if (pathname === '/api/health') return core ? sendJson(res, 200, core.health()) : forward(req, res);
    if (method === 'GET' && publicPaths.has(pathname)) return forward(req, res);
    if (docs.handles(method, pathname)) return docs.handle(req, res, pathname);
    if (method === 'POST' && pathname === '/api/auth/login') return sessions.login(req, res, sourceAddress(req, trustProxy));
    if (method === 'POST' && pathname === '/api/auth/logout') return sessions.logout(req, res);

    const identity = access.identify(req);
    // Who the page is talking as, so it can show the admin view or the
    // company-wide one. Anyone may ask; a caller with no role is told so.
    if (method === 'GET' && pathname === '/api/auth/me') {
      return sendReadable(req, res, 200, { ok: true, role: identity.role, via: identity.via || (identity.role ? 'key' : null) }, false);
    }
    if (!identity.role) return sendJson(res, 401, { error: 'unauthorized' });
    if (!access.permits(identity.role, method, pathname, identity.token?.scopes)) {
      // A keyless caller outside /api/stats is answered as before the viewer
      // existed: it simply sent no key.
      return identity.role === 'viewer'
        ? sendJson(res, 401, { error: 'unauthorized' })
        : sendJson(res, 403, { error: 'forbidden' });
    }
    // A write made with the session cookie must come from the page itself
    // (sessions.js): the cookie alone never authorizes one.
    if (identity.via === 'session' && method !== 'GET' && method !== 'HEAD' && !sameSiteWrite(req)) {
      return sendJson(res, 403, { error: 'forbidden', message: 'a signed-in write needs the X-TM-Request header' });
    }
    const meta = { role: identity.role, keyIndex: identity.keyIndex, session: identity.session?.id || null, sourceIp: sourceAddress(req, trustProxy) };

    if (method === 'GET' && pathname === '/api/stats') {
      const cors = identity.role !== 'viewer';
      const unit = url.searchParams.get('org');
      const redact = identity.role === 'viewer';
      if (!unit) return stream.handleStats(req, res, { cors, redact });
      if (org?.has(unit) && stream.handleStats(req, res, { cors, org: unit, redact })) return undefined;
      return sendJson(res, 404, { error: 'unknown_org' });
    }
    if (method === 'GET' && pathname === '/api/custom/org') return sendReadable(req, res, 200, { ok: true, units: org ? org.tree() : [] }, identity.role !== 'viewer');
    if (method === 'GET' && pathname === '/api/custom/usage') return handleUsage(req, res, url, identity.role);
    if (method === 'GET' && pathname === '/api/stats/stream') return stream.handleStream(req, res);
    if (method === 'POST' && pathname === '/api/ingest') return ingest.handle(req, res, meta);
    if (method === 'DELETE' && pathname.startsWith('/api/devices/')) return handleDelete(req, res, pathname);
    if (method === 'PUT' && pathname === '/api/subscriptions') return handleSubscriptions(req, res);
    if (core && method === 'GET') {
      if (pathname === '/api/devices') return sendJson(res, 200, { devices: core.getDevices() });
      if (pathname === '/api/history') return sendJson(res, 200, core.getHistory());
      if (pathname === '/api/subscriptions') return sendJson(res, 200, { ok: true, ...core.getSubscriptions() });
    }
    if (method === 'GET' && pathname === '/api/custom/health') return sendJson(res, 200, health());
    if (analytics.handles(pathname)) return analytics.handle(req, res, url);
    if (pathname.startsWith('/api/reports/')) return reports.handle(req, res, url);
    if (pathname.startsWith('/api/admin/')) return admin.handle(req, res, url, meta);

    access.authorizeUpstream(req);
    return forward(req, res);
  }, { logger });

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(thresholdTimer);
    loop.disable();
    ingest.stop();
    stream.stop();
    sessions.stop();
    await org?.stop();
    await backups?.stop();
    if (runtime) await runtime.stop();
  }

  // hub.stop() has to end the overlay's own streams first: server.close() waits
  // for every open connection, and upstream only knows about its own streams.
  const upstreamStop = hub.stop;
  hub.stop = async () => {
    await stop();
    return upstreamStop();
  };

  return { access, apiTokens, sessions, stream, ingest, persistence: runtime, org, usage, backups, health, stop };
}

module.exports = { THRESHOLDS, UPSTREAM_VERSION, attachOverlay };
