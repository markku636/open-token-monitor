'use strict';

// API tokens: how other systems (cost reports, BI) read the hub,
// instead of one report key everybody shares. An admin makes one per system on
// the dashboard (/api/admin/api-tokens), with an optional expiry, and revokes
// it when it is no longer needed or has leaked.
//
//   tmk_<8 hex prefix>_<40 hex secret>
//
// Only the prefix and a SHA-256 of the whole token are stored (api_tokens); the
// token itself is shown once, in the answer that made it. A request is matched
// by its prefix and then compared in constant time, against a copy of the
// table in memory that every change here refreshes, so checking a token costs
// no query. Using a token stamps last_used_at at most once a minute.
//
// Scopes (access.js scopeFor): 'reports:read' is the usage reports, devices and
// accounts under GET /api/reports/v1/*; 'analytics:read' is the org tree, the
// employee list, the quota windows and the usage analysis there
// (analytics.js). A token made without naming any gets reports:read alone, so
// one made the way it always was reads no more than it used to.

const crypto = require('node:crypto');
const { AdminError } = require('./admin');
const { toDbTime } = require('./persistence/util');

const TOKEN_RE = /^tmk_([0-9a-f]{8})_[0-9a-f]{40}$/;
const SCOPES = Object.freeze(['reports:read', 'analytics:read']);
const DEFAULT_SCOPES = Object.freeze(['reports:read']);
const TOUCH_EVERY_MS = 60 * 1000;
const MAX_NAME = 100;

function hashOf(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

function newToken() {
  const prefix = crypto.randomBytes(4).toString('hex');
  return { prefix, token: `tmk_${prefix}_${crypto.randomBytes(20).toString('hex')}` };
}

// The credential a request carries, the way upstream reads it.
function presented(req) {
  const header = String(req.headers.authorization || '');
  const bearer = /^Bearer\s+(\S+)$/i.exec(header);
  return bearer ? bearer[1] : String(req.headers['x-token-monitor-secret'] || '').trim();
}

// An expiry from the request: a day (valid through its end, UTC) or an instant.
function expiryOf(value, nowMs) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T23:59:59.999Z`) : Date.parse(text);
  if (!Number.isFinite(ms)) throw new AdminError(400, 'bad_request', 'expiresAt must be YYYY-MM-DD or an ISO 8601 time');
  if (ms <= nowMs) throw new AdminError(400, 'bad_request', 'expiresAt must be in the future');
  return toDbTime(ms);
}

function publicView(row) {
  return {
    id: String(row.id),
    name: row.name,
    prefix: row.token_prefix,
    scopes: row.scopes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by
  };
}

function createApiTokens({ store, now = () => Date.now(), logger = console } = {}) {
  let byPrefix = new Map();
  let ready = null;
  const touched = new Map();
  const warn = (message) => (logger.warn || console.warn)(`[api-tokens] ${message}`);

  async function refresh() {
    const rows = await store.query('SELECT id, name, token_prefix, token_hash, scopes, expires_at, revoked_at FROM api_tokens');
    byPrefix = new Map(rows.map((row) => [row.token_prefix, {
      id: String(row.id),
      name: row.name,
      hash: Buffer.from(row.token_hash),
      scopes: row.scopes,
      expiresMs: row.expires_at ? Date.parse(row.expires_at) : null,
      revoked: Boolean(row.revoked_at)
    }]));
  }

  function start() {
    ready = refresh().catch((error) => warn(`could not load the tokens: ${error.message}`));
    return ready;
  }

  function touch(entry) {
    const at = now();
    if (at - (touched.get(entry.id) || 0) < TOUCH_EVERY_MS) return;
    touched.set(entry.id, at);
    store.execute('UPDATE api_tokens SET last_used_at = $1 WHERE id = $2', [toDbTime(at), entry.id])
      .catch((error) => warn(`could not record the use of token ${entry.id}: ${error.message}`));
  }

  // The token a request carries, if it is a live one: { id, name, scopes }.
  function identify(req) {
    const token = presented(req);
    const match = TOKEN_RE.exec(token);
    if (!match) return null;
    const entry = byPrefix.get(match[1]);
    if (!entry || entry.revoked || (entry.expiresMs !== null && entry.expiresMs <= now())) return null;
    if (!crypto.timingSafeEqual(hashOf(token), entry.hash)) return null;
    touch(entry);
    return { id: entry.id, name: entry.name, scopes: entry.scopes };
  }

  async function create({ name, expiresAt, scopes } = {}, actor = 'admin') {
    const label = String(name ?? '').trim();
    if (!label) throw new AdminError(400, 'bad_request', 'name is required');
    if (label.length > MAX_NAME) throw new AdminError(400, 'bad_request', `name is longer than ${MAX_NAME} characters`);
    const wanted = scopes === undefined ? [...DEFAULT_SCOPES] : [...new Set(Array.isArray(scopes) ? scopes.map(String) : [])];
    if (!wanted.length || wanted.some((scope) => !SCOPES.includes(scope))) {
      throw new AdminError(400, 'bad_request', `scopes must be a list of ${SCOPES.join(', ')}`);
    }
    const expires = expiryOf(expiresAt, now());
    const { prefix, token } = newToken();
    const [row] = await store.transaction((tx) => tx.all(
      `INSERT INTO api_tokens (name, token_prefix, token_hash, scopes, created_by, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, token_prefix, scopes, created_by, created_at, expires_at, last_used_at, revoked_at, revoked_by`,
      [label, prefix, hashOf(token), wanted, actor, toDbTime(now()), expires]
    ));
    await refresh();
    return { token, ...publicView(row) };
  }

  async function list() {
    const rows = await store.query(
      'SELECT id, name, token_prefix, scopes, created_by, created_at, expires_at, last_used_at, revoked_at, revoked_by FROM api_tokens ORDER BY created_at DESC, id DESC'
    );
    return rows.map(publicView);
  }

  async function revoke(id, actor = 'admin') {
    if (!/^\d{1,18}$/.test(String(id))) throw new AdminError(404, 'not_found', `no token ${id}`);
    const [row] = await store.transaction((tx) => tx.all(
      `UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, $1), revoked_by = COALESCE(revoked_by, $2) WHERE id = $3
       RETURNING id, name, token_prefix, scopes, created_by, created_at, expires_at, last_used_at, revoked_at, revoked_by`,
      [toDbTime(now()), actor, id]
    ));
    if (!row) throw new AdminError(404, 'not_found', `no token ${id}`);
    await refresh();
    return publicView(row);
  }

  return {
    start,
    whenReady: () => ready || Promise.resolve(),
    identify,
    create,
    list,
    revoke,
    status() {
      const at = now();
      const live = [...byPrefix.values()].filter((entry) => !entry.revoked && (entry.expiresMs === null || entry.expiresMs > at));
      return { tokens: byPrefix.size, active: live.length };
    }
  };
}

module.exports = { DEFAULT_SCOPES, SCOPES, TOKEN_RE, createApiTokens };
