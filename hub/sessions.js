'use strict';

// Signed-in dashboard admins, so the admin secret never has to stay in a
// browser. The dashboard sends the secret once, to POST /api/auth/login, and
// gets back a random session token in an HttpOnly cookie that no script on the
// page can read; every later request is recognised by that cookie.
//
//   POST /api/auth/login   { key }  → Set-Cookie tm_admin=…; HttpOnly; SameSite=Strict
//   POST /api/auth/logout            ends the session, clears the cookie
//   GET  /api/auth/me                { role, via } of the caller (anyone may ask)
//
// Only a SHA-256 of each token is stored (admin_sessions), with a fingerprint
// of the admin secret it was opened with: changing TOKEN_MONITOR_SECRET ends
// every session. Sessions last 12 hours from sign-in. A hub without a database
// keeps them in memory only, so a restart signs everyone out.
//
// Cross-site requests. SameSite=Strict already keeps the cookie off requests
// another site starts; on top of that a write made with the cookie must carry
// the X-TM-Request header (which a cross-site form cannot set, and a
// cross-site fetch cannot set without a preflight) and must not be labelled
// cross-site by Sec-Fetch-Site (overlay.js checks it with sameSiteWrite()).
//
// Failed sign-ins are limited per address: past 5 in a minute the address gets
// 429 until the minute is over.

const crypto = require('node:crypto');
const { upstream } = require('../upstream');
const { readJsonBody, sendJson, timingSafeEqualText } = require(upstream('src/shared/http'));
const { toDbTime } = require('./persistence/util');

const COOKIE = 'tm_admin';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SESSION_MS = 12 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 60 * 1000;
const MAX_FAILURES = 5;
const REQUEST_HEADER = 'x-tm-request';
const MAX_LOGIN_BODY = 4096;

function hashOf(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

function fingerprintOf(secret) {
  return crypto.createHash('sha256').update(`token-monitor-session:${secret}`, 'utf8').digest();
}

// The value of one cookie in a Cookie header, or ''.
function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

// A write the page made itself: it carries the page's header and the browser
// did not label it cross-site. Callers that send no Sec-Fetch-Site (curl,
// scripts) only need the header.
function sameSiteWrite(req) {
  if (req.headers[REQUEST_HEADER] !== '1') return false;
  const site = req.headers['sec-fetch-site'];
  return site === undefined || String(site).toLowerCase() === 'same-origin';
}

function createAdminSessions({ secret = '', store = null, trustProxy = false, now = () => Date.now(), logger = console } = {}) {
  const admin = String(secret || '').trim();
  const fingerprint = admin ? fingerprintOf(admin) : null;
  // SHA-256 hex → { hash, expiresMs }
  const sessions = new Map();
  const failures = new Map();
  let pruneTimer = null;
  const warn = (message) => (logger.warn || console.warn)(`[sessions] ${message}`);

  async function load() {
    if (!store) return;
    await store.execute('DELETE FROM admin_sessions WHERE expires_at <= $1 OR secret_fingerprint <> $2', [toDbTime(now()), fingerprint]);
    const rows = await store.query('SELECT token_hash, expires_at FROM admin_sessions');
    for (const row of rows) {
      const hash = Buffer.from(row.token_hash);
      sessions.set(hash.toString('hex'), { hash, expiresMs: Date.parse(row.expires_at) });
    }
  }

  function prune() {
    const at = now();
    for (const [key, entry] of sessions) if (entry.expiresMs <= at) sessions.delete(key);
    for (const [address, entry] of failures) if (at - entry.since >= FAILURE_WINDOW_MS) failures.delete(address);
    if (store) {
      store.execute('DELETE FROM admin_sessions WHERE expires_at <= $1', [toDbTime(at)])
        .catch((error) => warn(`could not remove expired sessions: ${error.message}`));
    }
  }

  function start() {
    if (!admin) return Promise.resolve();
    pruneTimer = setInterval(prune, PRUNE_EVERY_MS);
    pruneTimer.unref?.();
    return load().catch((error) => warn(`could not load the sessions: ${error.message}`));
  }

  // The live session a request's cookie names: { id } (the first 8 hex digits
  // of its hash, for the audit trail), or null.
  function identify(req) {
    if (!admin) return null;
    const token = cookieValue(req, COOKIE);
    if (!TOKEN_RE.test(token)) return null;
    const hash = hashOf(token);
    const entry = sessions.get(hash.toString('hex'));
    if (!entry || entry.expiresMs <= now()) return null;
    if (!crypto.timingSafeEqual(hash, entry.hash)) return null;
    return { id: hash.toString('hex').slice(0, 8) };
  }

  function secureRequest(req) {
    if (req.socket?.encrypted) return true;
    return trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
  }

  function cookie(req, value, maxAgeSeconds) {
    return [`${COOKIE}=${value}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSeconds}`, ...(secureRequest(req) ? ['Secure'] : [])].join('; ');
  }

  function blocked(address) {
    const entry = failures.get(address);
    if (!entry || now() - entry.since >= FAILURE_WINDOW_MS) return 0;
    return entry.count >= MAX_FAILURES ? Math.ceil((entry.since + FAILURE_WINDOW_MS - now()) / 1000) : 0;
  }

  function failed(address) {
    const entry = failures.get(address);
    if (!entry || now() - entry.since >= FAILURE_WINDOW_MS) failures.set(address, { since: now(), count: 1 });
    else entry.count += 1;
  }

  async function login(req, res, sourceIp) {
    if (!sameSiteWrite(req)) return sendJson(res, 403, { error: 'forbidden', message: 'sign in from the dashboard' });
    // No admin secret: upstream's loopback-only mode, where everyone is admin.
    if (!admin) return sendJson(res, 200, { ok: true, role: 'admin', via: 'open' });
    const wait = blocked(sourceIp);
    if (wait) return sendJson(res, 429, { error: 'too_many_attempts', message: 'too many failed sign-ins, try again later' }, { 'retry-after': String(wait) });
    let body;
    try {
      body = await readJsonBody(req, MAX_LOGIN_BODY);
    } catch (error) {
      return sendJson(res, error.code === 'payload_too_large' ? 413 : 400, { error: 'bad_request', message: error.message });
    }
    const key = String(body?.key ?? '').trim();
    if (!key || !timingSafeEqualText(key, admin)) {
      failed(sourceIp);
      return sendJson(res, 401, { error: 'unauthorized', message: 'wrong admin key' });
    }
    failures.delete(sourceIp);
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = hashOf(token);
    const at = now();
    const expiresMs = at + SESSION_MS;
    if (store) {
      try {
        await store.execute(
          'INSERT INTO admin_sessions (token_hash, secret_fingerprint, source_ip, created_at, last_seen_at, expires_at) VALUES ($1, $2, $3, $4, $4, $5)',
          [hash, fingerprint, sourceIp || null, toDbTime(at), toDbTime(expiresMs)]
        );
      } catch (error) {
        return sendJson(res, 503, { error: 'storage_unavailable', message: error.message });
      }
    }
    sessions.set(hash.toString('hex'), { hash, expiresMs });
    return sendJson(res, 200, { ok: true, role: 'admin', via: 'session', expiresAt: new Date(expiresMs).toISOString() }, {
      'set-cookie': cookie(req, token, Math.floor(SESSION_MS / 1000))
    });
  }

  async function logout(req, res) {
    if (!sameSiteWrite(req)) return sendJson(res, 403, { error: 'forbidden' });
    const token = cookieValue(req, COOKIE);
    if (TOKEN_RE.test(token)) {
      const hash = hashOf(token);
      sessions.delete(hash.toString('hex'));
      if (store) {
        try {
          await store.execute('DELETE FROM admin_sessions WHERE token_hash = $1', [hash]);
        } catch (error) {
          warn(`could not remove a session: ${error.message}`);
        }
      }
    }
    return sendJson(res, 200, { ok: true }, { 'set-cookie': cookie(req, '', 0) });
  }

  return {
    start,
    identify,
    login,
    logout,
    status: () => ({ active: [...sessions.values()].filter((entry) => entry.expiresMs > now()).length }),
    stop() {
      clearInterval(pruneTimer);
    }
  };
}

module.exports = { COOKIE, REQUEST_HEADER, SESSION_MS, cookieValue, createAdminSessions, sameSiteWrite };
