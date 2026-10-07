'use strict';

// Who may do what on the hub ("寫入權限分級", write permission tiers).
//
// Upstream knows one secret that opens everything. The client secret is
// handed to every user, who types it into the upstream client, which makes it
// effectively public inside the company network, so the callers are told
// apart here:
//
//   admin   TOKEN_MONITOR_SECRET          everything (upstream's own secret), or
//           a dashboard session (sessions.js): the tm_admin cookie the page
//           got by sending the secret once to /api/auth/login
//   client  TOKEN_MONITOR_CLIENT_SECRETS  upload, and read what the widget reads
//   api     an API token (apiTokens.js)   GET /api/reports/v1/* only, and of
//                                         those the paths its scopes open
//                                         (scopeFor): other systems, one token
//                                         each, made and revoked on the
//                                         dashboard
//   viewer  no key at all, only with TOKEN_MONITOR_PUBLIC_DASHBOARD
//           GET /api/stats (also ?org=), /api/custom/org and
//           /api/custom/usage, so the dashboard, its org tabs and the usage
//           page open without a key
//
// A viewer request must carry no credential at all (a wrong key is still a
// 401) and must not come from another site: browsers label a cross-site fetch
// with Sec-Fetch-Site, and the stats answer to a viewer carries no CORS
// header, so a page elsewhere cannot read company data through an employee's
// browser. Callers that send no Sec-Fetch-Site (curl, scripts) are let in:
// they could open the dashboard page anyway.
//
// Clients may read every GET route upstream serves — the "everyone sees
// everything" decision — but the only write they may make is an
// upload. A write route upstream adds later is therefore closed to clients until
// someone decides otherwise, while a new read route keeps working for widgets.
// Of the fork's own /api/custom/* routes they read only the listed ones.
//
// When a client request is handed on to upstream, its credential is swapped for
// the admin secret, because upstream checks exactly one secret.

const { upstream } = require('../upstream');
const { isAuthorized } = require(upstream('src/shared/http'));
const { ANALYTICS_PATHS } = require('./analytics');

const REPORTS_PREFIX = '/api/reports/v1/';
const CLIENT_READ_DENIED_PREFIXES = ['/api/admin/', '/api/reports/', '/api/custom/'];
// The org tree (org.js) carries unit names and device counts, never people, and
// the usage page's figures (usage.js) leave people out for anyone but an
// admin, so every key and the keyless dashboard may read them.
const OPEN_CUSTOM_READS = new Set(['/api/custom/org', '/api/custom/usage']);
const VIEWER_READ_PATHS = new Set(['/api/stats', ...OPEN_CUSTOM_READS]);
const SAME_SITE_FETCHES = new Set(['same-origin', 'none']);

// The scope an API token needs for a path (apiTokens.js), or null outside the
// reports API: the analytics routes need analytics:read, every other route
// there reports:read, including any added later.
function scopeFor(pathname) {
  if (!String(pathname).startsWith(REPORTS_PREFIX)) return null;
  return ANALYTICS_PATHS.has(pathname) ? 'analytics:read' : 'reports:read';
}

function carriesCredential(req) {
  return Boolean(req.headers.authorization || req.headers['x-token-monitor-secret']);
}

function sameSiteOrUnlabelled(req) {
  const site = req.headers['sec-fetch-site'];
  return site === undefined || SAME_SITE_FETCHES.has(String(site).toLowerCase());
}

function parseSecretList(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

// apiTokens: the hub's API tokens (apiTokens.js), when it has a database.
// sessions: the dashboard's admin sessions (sessions.js).
function createAccessControl({ adminSecret = '', clientSecrets = [], apiTokens = null, sessions = null, anonymousRead = false } = {}) {
  const admin = String(adminSecret || '').trim();
  const clients = clientSecrets.map((s) => String(s).trim()).filter(Boolean);
  if (!admin && clients.length) {
    throw new Error('TOKEN_MONITOR_CLIENT_SECRETS needs TOKEN_MONITOR_SECRET (the admin secret) to be set as well');
  }
  // A key shared by two roles resolves to the stronger one, so a client secret
  // equal to the admin secret would make every user an admin.
  const all = [admin, ...clients].filter(Boolean);
  if (new Set(all).size !== all.length) {
    throw new Error('TOKEN_MONITOR_SECRET and TOKEN_MONITOR_CLIENT_SECRETS must all be different');
  }
  const open = !admin;

  function identify(req) {
    // No secret at all is upstream's single-machine mode: the hub is bound to
    // loopback and every caller is trusted, so every caller is an admin.
    if (open) return { role: 'admin', keyIndex: null };
    if (isAuthorized(req, admin)) return { role: 'admin', keyIndex: null };
    for (let index = 0; index < clients.length; index += 1) {
      if (isAuthorized(req, clients[index])) return { role: 'client', keyIndex: index };
    }
    const token = apiTokens?.identify(req);
    if (token) return { role: 'api', keyIndex: null, token };
    // The cookie counts only on a request that sends no key: a wrong key is a
    // 401 whatever cookie comes with it.
    const session = carriesCredential(req) ? null : sessions?.identify(req);
    if (session) return { role: 'admin', keyIndex: null, via: 'session', session };
    if (anonymousRead && !carriesCredential(req) && sameSiteOrUnlabelled(req)) return { role: 'viewer', keyIndex: null };
    return { role: null, keyIndex: null };
  }

  // scopes: an API token's (identify() → token.scopes); no other role has any.
  function permits(role, method, pathname, scopes = []) {
    if (role === 'admin') return true;
    const read = method === 'GET' || method === 'HEAD';
    if (role === 'client') {
      if (read) {
        return OPEN_CUSTOM_READS.has(pathname)
          || !CLIENT_READ_DENIED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
      }
      return method === 'POST' && pathname === '/api/ingest';
    }
    if (role === 'api') {
      const scope = scopeFor(pathname);
      return read && scope !== null && Array.isArray(scopes) && scopes.includes(scope);
    }
    if (role === 'viewer') return method === 'GET' && VIEWER_READ_PATHS.has(pathname);
    return false;
  }

  // Makes a request that the overlay has already authorized pass upstream's
  // single-secret gate.
  function authorizeUpstream(req) {
    if (open) return;
    req.headers.authorization = `Bearer ${admin}`;
    delete req.headers['x-token-monitor-secret'];
  }

  return {
    open,
    roles: { admin: Boolean(admin), sessions: Boolean(admin && sessions), clients: clients.length, apiTokens: Boolean(apiTokens), viewer: Boolean(admin && anonymousRead) },
    identify,
    permits,
    authorizeUpstream
  };
}

function accessConfigFromEnv(env = process.env, adminSecret = '') {
  return {
    adminSecret,
    clientSecrets: parseSecretList(env.TOKEN_MONITOR_CLIENT_SECRETS)
  };
}

// The address an upload came from, for the audit trail. X-Forwarded-For is only
// believed when the operator says a reverse proxy sits in front of the hub, and
// then only its last entry: that is the one the proxy appended, while everything
// to its left is whatever the client chose to send.
function sourceAddress(req, trustProxy) {
  let address = '';
  if (trustProxy) {
    const entries = String(req.headers['x-forwarded-for'] || '').split(',').map((part) => part.trim()).filter(Boolean);
    if (entries.length) address = entries[entries.length - 1];
  }
  if (!address) address = String(req.socket?.remoteAddress || '');
  if (address.startsWith('::ffff:')) address = address.slice(7);
  return address.slice(0, 45);
}

module.exports = { accessConfigFromEnv, createAccessControl, parseSecretList, scopeFor, sourceAddress };
