'use strict';

// /api/stats and /api/stats/stream for a hub with hundreds of widgets
// connected ("頻寬控制", bandwidth control).
//
// Upstream recomputes getStats() and serializes the complete stats once per
// connection on every ingest that changed anything. stats.devices[] carries
// each device's full periods and limits: measured at 300 devices one frame is
// ~16.6 MB, and upstream's per-connection JSON.stringify held the event loop
// for seconds. Here the stats are computed at most once per window, serialized
// once, and each frame is compressed once and written to every connection;
// polls and connection snapshots are served from the same cache.
//
// The wire format is upstream's: `snapshot` on connect, `stats` when content
// changed, `freshness` instead for clients that sent `x-token-monitor-stream: 2`
// when only timestamps moved, `: hb` every 30 s. A widget's own usage is
// overlaid locally and still moves every few seconds; only the other devices'
// numbers can lag by up to one window.
//
// Compression: a connection that accepts gzip gets every frame as a complete
// gzip member of its own. A gzip stream may be a concatenation of members, and
// Node's fetch (the widget's main process) decodes each as it arrives, so one
// compressed copy of a frame serves every connection (~24x smaller at 300
// devices).

const zlib = require('node:zlib');
const { upstream } = require('../upstream');
const { acceptsEncoding, freshnessEvent, hubStatsContentKey, wantsFreshnessEvents } = require(upstream('src/shared/hubProtocol'));

const HEARTBEAT_MS = 30 * 1000;
const JSON_COMPRESSION_MIN_BYTES = 1024;
// A connection that cannot take its frames (a sleeping laptop's socket) is cut
// once this much is waiting for it; the widget reconnects when it wakes.
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

// Kept identical to corsHeaders() in src/shared/http.js, which is not exported.
// tests/stream.test.js compares the two responses header for header.
const CORS_HEADERS = Object.freeze({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,x-token-monitor-secret,x-token-monitor-response,x-token-monitor-stream'
});

function gzip(text) {
  return zlib.gzipSync(Buffer.from(text, 'utf8'), { level: zlib.constants.Z_BEST_SPEED });
}

// A frame, with its compressed form made on first use and then shared.
function frame(text) {
  let compressed = null;
  return {
    text,
    get gzip() {
      if (!compressed) compressed = gzip(text);
      return compressed;
    }
  };
}

const HEARTBEAT = frame(': hb\n\n');

function statsFrame(event, reason, statsJson, at) {
  return frame(`event: ${event}\ndata: {"type":"stats","reason":${JSON.stringify(reason)},"stats":${statsJson},"at":${JSON.stringify(at)}}\n\n`);
}

// At most this many filtered variants (one per org unit asked for) are cached.
const MAX_VARIANTS = 256;

// Left out of what a keyless viewer gets (access.js): an AI account's key and
// the company email a device's user reported. The account's email and name
// are shown to everyone in AI 工具額度.
const IDENTITY_KEYS = new Set(['accountKey', 'email', 'ownerEmail']);

function withoutIdentity(value) {
  if (Array.isArray(value)) return value.map(withoutIdentity);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) if (!IDENTITY_KEYS.has(key)) out[key] = withoutIdentity(item);
  return out;
}

function createStatsBroadcaster(hub, {
  windowMs = 60 * 1000,
  heartbeatMs = HEARTBEAT_MS,
  compress = true,
  maxBufferedBytes = MAX_BUFFERED_BYTES,
  // Stats for one org unit's devices (org.js via core.getStatsFor), or null.
  filteredStats = () => null,
  logger = console,
  now = () => Date.now()
} = {}) {
  const clients = new Set();
  let cache = null;
  // Filtered stats for the dashboard's org tabs, polled only (the stream always
  // carries the whole hub). Each follows the same window as the main cache.
  const variants = new Map();
  // Two separate facts: the cache no longer matches the hub
  // (`stale`), and a change has not reached the streams yet (`owed`). A poll
  // that rebuilds the cache settles the first, never the second.
  let stale = true;
  let owed = false;
  let lastBroadcastKey = '';
  const counters = { broadcasts: 0, lastBroadcastAt: null, bytesWritten: 0, slowClientsCut: 0 };

  // Serialized once; the plain and gzip bodies and the SSE frame are built on
  // first use and shared by every reader of this entry.
  function snapshotOf(stats) {
    const json = JSON.stringify(stats);
    let snapshot = null;
    let body = null;
    let bodyGzip = null;
    let redacted = null;
    const entry = {
      stats,
      json,
      contentKey: hubStatsContentKey(stats),
      at: new Date(now()).toISOString(),
      computedAtMs: now(),
      get body() {
        if (!body) body = Buffer.from(json, 'utf8');
        return body;
      },
      get bodyGzip() {
        if (!bodyGzip) bodyGzip = zlib.gzipSync(this.body, { level: zlib.constants.Z_BEST_SPEED });
        return bodyGzip;
      },
      // The same stats without IDENTITY_KEYS, built once per snapshot.
      get redacted() {
        if (!redacted) redacted = snapshotOf(withoutIdentity(stats));
        return redacted;
      },
      get snapshot() {
        if (!snapshot) snapshot = statsFrame('snapshot', 'snapshot', json, entry.at);
        return snapshot;
      }
    };
    return entry;
  }

  function compute() {
    cache = snapshotOf(hub.getStats());
    stale = false;
    return cache;
  }

  function variant(org) {
    const hit = variants.get(org);
    if (hit && now() - hit.computedAtMs < windowMs) return hit;
    const stats = filteredStats(org);
    if (!stats) return null;
    const entry = snapshotOf(stats);
    variants.delete(org);
    variants.set(org, entry);
    if (variants.size > MAX_VARIANTS) variants.delete(variants.keys().next().value);
    return entry;
  }

  // The cache as a reader may see it. It is rebuilt once it is a window old
  // even if nothing was uploaded, because staleness, ageMs and the expiry of a
  // finished day or month move with the clock; `force` rebuilds a
  // cache that is known to be behind.
  function current({ force = false } = {}) {
    if (!cache || force || now() - cache.computedAtMs >= windowMs) return compute();
    return cache;
  }

  function drop(client) {
    clients.delete(client);
    try {
      client.res.destroy();
    } catch (_) {
      // Already gone; nothing left to release.
    }
  }

  function send(client, message) {
    const chunk = client.gzip ? message.gzip : message.text;
    try {
      client.res.write(chunk);
      counters.bytesWritten += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    } catch (_) {
      drop(client);
      return;
    }
    if (client.res.writableLength > maxBufferedBytes) {
      counters.slowClientsCut += 1;
      drop(client);
    }
  }

  function broadcast(reason = 'ingest') {
    if (!clients.size) {
      owed = false;
      return;
    }
    const snapshot = current({ force: stale });
    if (snapshot.contentKey !== lastBroadcastKey) {
      lastBroadcastKey = snapshot.contentKey;
      const message = statsFrame('stats', reason, snapshot.json, snapshot.at);
      for (const client of clients) send(client, message);
    } else if (owed) {
      const freshness = frame(`event: freshness\ndata: ${JSON.stringify(freshnessEvent(snapshot.stats, reason, snapshot.at))}\n\n`);
      let legacy = null;
      for (const client of clients) {
        send(client, client.freshnessEvents ? freshness : legacy || (legacy = statsFrame('stats', reason, snapshot.json, snapshot.at)));
      }
    } else {
      return;
    }
    owed = false;
    counters.broadcasts += 1;
    counters.lastBroadcastAt = snapshot.at;
  }

  const windowTimer = setInterval(() => {
    try {
      broadcast('ingest');
    } catch (error) {
      (logger.error || console.error)(`[stream] broadcast failed: ${error.message}`);
    }
  }, Math.max(50, windowMs));
  windowTimer.unref?.();

  const heartbeatTimer = setInterval(() => {
    for (const client of clients) send(client, HEARTBEAT);
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  return {
    // Something the stats are derived from changed. Deletes and subscription
    // edits are rare and expected to show at once (upstream broadcasts them
    // immediately too); uploads wait for the window.
    markDirty({ immediate = false, reason = 'ingest' } = {}) {
      stale = true;
      owed = true;
      if (immediate) {
        cache = null;
        variants.clear();
        broadcast(reason);
      }
    },

    // Which device belongs to which org unit changed: every filtered copy is
    // out of date at once.
    invalidateFilters() {
      variants.clear();
    },

    // For the legacy (non-minimal) ingest response.
    currentStats() {
      return current().stats;
    },

    // `cors: false` for a caller without a key (access.js, viewer): only the
    // hub's own dashboard may read that answer, never another site. `org`
    // narrows the stats to one org unit's devices. Returns false, having
    // written nothing, when there are no stats for that unit: the caller
    // answers, never with the whole hub in its place. `redact` leaves
    // IDENTITY_KEYS out (a viewer's answer).
    handleStats(req, res, { cors = true, org = '', redact = false } = {}) {
      const full = org ? variant(org) : current();
      if (!full) return false;
      const snapshot = redact ? full.redacted : full;
      const compressed = acceptsEncoding(req, 'gzip') && Buffer.byteLength(snapshot.json) >= JSON_COMPRESSION_MIN_BYTES;
      const body = compressed ? snapshot.bodyGzip : snapshot.body;
      res.writeHead(200, {
        ...(cors ? CORS_HEADERS : {}),
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(body.byteLength),
        ...(compressed ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {})
      });
      res.end(body);
      counters.bytesWritten += body.byteLength;
      return true;
    },

    handleStream(req, res) {
      const snapshot = current();
      const client = { res, freshnessEvents: wantsFreshnessEvents(req), gzip: compress && acceptsEncoding(req, 'gzip') };
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
        ...(client.gzip ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {})
      });
      if (!clients.size) lastBroadcastKey = snapshot.contentKey;
      clients.add(client);
      send(client, snapshot.snapshot);
      const cleanup = () => {
        clients.delete(client);
        if (!clients.size) lastBroadcastKey = '';
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
    },

    status() {
      return {
        clients: clients.size,
        gzipClients: [...clients].filter((client) => client.gzip).length,
        windowMs,
        ...counters,
        statsBytes: cache ? Buffer.byteLength(cache.json) : null,
        filteredVariants: variants.size
      };
    },

    stop() {
      clearInterval(windowTimer);
      clearInterval(heartbeatTimer);
      for (const client of clients) {
        try { client.res.end(); } catch (_) {}
      }
      clients.clear();
    }
  };
}

module.exports = { CORS_HEADERS, createStatsBroadcaster, withoutIdentity };
