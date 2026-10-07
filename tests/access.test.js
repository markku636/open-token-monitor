'use strict';

// 寫入權限分級 (write permission tiers): what each key may do on the overlay hub.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAccessControl, scopeFor, sourceAddress } = require('../hub/access');
const { apiToken, bearer, post, removeAll, startOverlayHub } = require('./helpers/overlayHub');
const { devicePayload } = require('./helpers/fixtures');

const CLIENT = bearer('client-secret');
const ADMIN = bearer('admin-secret');

async function status(base, pathname, headers, method = 'GET', body) {
  const response = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', ...headers }, body });
  await response.arrayBuffer();
  return response.status;
}

test('each key opens exactly its own routes', async () => {
  const hub = await startOverlayHub({ clientSecrets: ['client-secret', 'client-secret-next'], database: true });
  try {
    const API = await apiToken(hub.base);
    assert.equal((await post(hub.base, '/api/ingest', devicePayload(), CLIENT)).status, 200);
    // A second client secret, for rotation, is just as valid.
    assert.equal((await post(hub.base, '/api/ingest', devicePayload(), bearer('client-secret-next'))).status, 200);
    // The legacy header form upstream accepts works for the overlay too.
    assert.equal((await post(hub.base, '/api/ingest', devicePayload(), { 'x-token-monitor-secret': 'client-secret' })).status, 200);

    const matrix = [
      // [path, method, client, API token, admin]
      ['/api/stats', 'GET', 200, 403, 200],
      ['/api/devices', 'GET', 200, 403, 200],
      ['/api/history', 'GET', 200, 403, 200],
      ['/api/subscriptions', 'GET', 200, 403, 200],
      ['/api/custom/health', 'GET', 403, 403, 200],
      ['/api/custom/usage', 'GET', 200, 403, 200],
      // One person's view: names are the admin's, who learns the id is unknown.
      ['/api/custom/usage?employee=nobody', 'GET', 403, 403, 404],
      ['/api/admin/employees', 'GET', 403, 403, 200],
      ['/api/admin/api-tokens', 'GET', 403, 403, 200],
      ['/api/admin/backups', 'GET', 403, 403, 200],
      ['/api/admin/usage-purge', 'GET', 403, 403, 200],
      ['/api/reports/v1/devices', 'GET', 403, 200, 200],
      ['/api/devices/dev-a', 'DELETE', 403, 403, 200],
      ['/api/subscriptions', 'PUT', 403, 403, 200],
      ['/api/ingest', 'POST', 200, 403, 200],
      ['/api/some-future-write', 'POST', 403, 403, 404]
    ];
    for (const [pathname, method, client, api, admin] of matrix) {
      const body = method === 'PUT' ? JSON.stringify({ subscriptions: [], baseUpdatedAt: '' }) : pathname === '/api/ingest' ? JSON.stringify(devicePayload()) : undefined;
      assert.equal(await status(hub.base, pathname, CLIENT, method, body), client, `client ${method} ${pathname}`);
      assert.equal(await status(hub.base, pathname, API, method, body), api, `API token ${method} ${pathname}`);
      assert.equal(await status(hub.base, pathname, ADMIN, method, body), admin, `admin ${method} ${pathname}`);
    }
    assert.equal(await status(hub.base, '/api/stats', {}), 401);
    assert.equal(await status(hub.base, '/api/stats', bearer('wrong')), 401);
    assert.equal(await status(hub.base, '/api/health', {}), 200, 'health stays public');
    assert.equal(await status(hub.base, '/', {}), 200, 'the dashboard stays public');
    assert.equal(await status(hub.base, '/install', {}), 200, 'so does the install page');
    assert.equal(await status(hub.base, '/admin', {}), 200, 'and the admins\' page: its data stays behind the admin routes');
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

test('a hub without any secret keeps upstream single-machine behaviour', async () => {
  const hub = await startOverlayHub({ secret: '', clientSecrets: [] });
  try {
    assert.equal((await post(hub.base, '/api/ingest', devicePayload(), {})).status, 200);
    assert.equal(await status(hub.base, '/api/devices/dev-a', {}, 'DELETE'), 200);
    assert.equal(await status(hub.base, '/api/custom/health', {}), 200);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

test('client keys without an admin secret are a configuration error', () => {
  assert.throws(() => createAccessControl({ adminSecret: '', clientSecrets: ['c'] }), /needs TOKEN_MONITOR_SECRET/);
});

test('a client request passed on to upstream carries the admin secret instead', () => {
  const access = createAccessControl({ adminSecret: 'admin', clientSecrets: ['client'] });
  const req = { headers: { 'x-token-monitor-secret': 'client' } };
  assert.deepEqual(access.identify(req), { role: 'client', keyIndex: 0 });
  access.authorizeUpstream(req);
  assert.deepEqual(req.headers, { authorization: 'Bearer admin' });
});

test('X-Forwarded-For is believed only behind a declared proxy, and only its last entry', () => {
  // The client wrote "1.1.1.1"; the proxy appended the address it saw.
  const req = { headers: { 'x-forwarded-for': '1.1.1.1, 10.1.2.3' }, socket: { remoteAddress: '::ffff:172.16.0.1' } };
  assert.equal(sourceAddress(req, false), '172.16.0.1');
  assert.equal(sourceAddress(req, true), '10.1.2.3');
  assert.equal(sourceAddress({ headers: { 'x-forwarded-for': `x${'1'.repeat(100)}` }, socket: {} }, true).length, 45);
});

test('the same key in two roles is refused at start', () => {
  assert.throws(() => createAccessControl({ adminSecret: 'same', clientSecrets: ['same'] }), /must all be different/);
  assert.throws(() => createAccessControl({ adminSecret: 'a', clientSecrets: ['c', 'c'] }), /must all be different/);
});

test('a keyless viewer exists only when enabled, only same-site, and may only read /api/stats', () => {
  const request = (headers = {}) => ({ headers });
  const keyless = createAccessControl({ adminSecret: 'a', clientSecrets: ['c'], anonymousRead: true });
  assert.equal(keyless.identify(request()).role, 'viewer', 'curl and scripts send no Sec-Fetch-Site');
  assert.equal(keyless.identify(request({ 'sec-fetch-site': 'same-origin' })).role, 'viewer');
  assert.equal(keyless.identify(request({ 'sec-fetch-site': 'none' })).role, 'viewer', 'typed into the address bar');
  assert.equal(keyless.identify(request({ 'sec-fetch-site': 'cross-site' })).role, null, 'another site cannot read through a browser');
  assert.equal(keyless.identify(request({ 'sec-fetch-site': 'same-site' })).role, null);
  assert.equal(keyless.identify(request({ authorization: 'Bearer wrong' })).role, null, 'a wrong key stays a 401');
  assert.equal(keyless.identify(request({ 'x-token-monitor-secret': 'wrong' })).role, null);
  assert.equal(keyless.identify(request({ authorization: 'Bearer c' })).role, 'client', 'a real key keeps its role');
  assert.equal(keyless.roles.viewer, true);

  const closed = createAccessControl({ adminSecret: 'a', clientSecrets: ['c'] });
  assert.equal(closed.identify(request()).role, null, 'off unless TOKEN_MONITOR_PUBLIC_DASHBOARD');
  assert.equal(closed.roles.viewer, false);
  const open = createAccessControl({ anonymousRead: true });
  assert.equal(open.identify(request()).role, 'admin', 'a hub without any secret is unchanged');

  assert.equal(keyless.permits('viewer', 'GET', '/api/stats'), true);
  // The usage page's figures leave people out for anyone but an admin (usage.js).
  assert.equal(keyless.permits('viewer', 'GET', '/api/custom/usage'), true);
  assert.equal(keyless.permits('client', 'GET', '/api/custom/usage'), true);
  assert.equal(keyless.permits('api', 'GET', '/api/custom/usage'), false);
  for (const [method, pathname] of [['HEAD', '/api/stats'], ['GET', '/api/stats/stream'], ['GET', '/api/devices'], ['GET', '/api/history'], ['GET', '/api/subscriptions'], ['POST', '/api/ingest'], ['GET', '/api/custom/health']]) {
    assert.equal(keyless.permits('viewer', method, pathname), false, `${method} ${pathname}`);
  }
});

test('the client key reads only the listed /api/custom/* routes', () => {
  const access = createAccessControl({ adminSecret: 'a', clientSecrets: ['c'], anonymousRead: true });
  for (const pathname of ['/api/custom/org', '/api/custom/usage']) assert.equal(access.permits('client', 'GET', pathname), true, pathname);
  for (const pathname of ['/api/custom/health', '/api/custom/orgx', '/api/custom/usage/x']) {
    assert.equal(access.permits('client', 'GET', pathname), false, pathname);
  }
  assert.equal(access.permits('client', 'POST', '/api/custom/usage'), false);
});

test('an API token reads the reports API routes its scopes open, and nothing else', () => {
  const access = createAccessControl({ adminSecret: 'a', clientSecrets: ['c'] });
  const analytics = ['/api/reports/v1/units', '/api/reports/v1/employees', '/api/reports/v1/limits', '/api/reports/v1/usage/analysis'];
  const reports = ['/api/reports/v1/usage/monthly', '/api/reports/v1/usage/daily', '/api/reports/v1/usage/weekly', '/api/reports/v1/devices', '/api/reports/v1/accounts', '/api/reports/v1/added-later'];
  for (const pathname of analytics) assert.equal(scopeFor(pathname), 'analytics:read', pathname);
  for (const pathname of reports) assert.equal(scopeFor(pathname), 'reports:read', pathname);
  for (const pathname of ['/api/reports/v2/units', '/api/custom/usage', '/api/admin/employees']) assert.equal(scopeFor(pathname), null, pathname);
  for (const pathname of reports) {
    assert.equal(access.permits('api', 'GET', pathname, ['reports:read']), true, pathname);
    assert.equal(access.permits('api', 'GET', pathname, ['analytics:read']), false, pathname);
  }
  for (const pathname of analytics) {
    assert.equal(access.permits('api', 'GET', pathname, ['analytics:read']), true, pathname);
    assert.equal(access.permits('api', 'HEAD', pathname, ['reports:read', 'analytics:read']), true, pathname);
    assert.equal(access.permits('api', 'GET', pathname, ['reports:read']), false, pathname);
    assert.equal(access.permits('api', 'GET', pathname), false, `no scopes: ${pathname}`);
    assert.equal(access.permits('api', 'POST', pathname, ['analytics:read']), false, `a read scope never writes: ${pathname}`);
  }
  assert.equal(access.permits('api', 'GET', '/api/custom/usage', ['reports:read', 'analytics:read']), false);
  assert.equal(access.permits('admin', 'GET', '/api/reports/v1/units'), true, 'the admin needs no scope');
});

test('with TOKEN_MONITOR_PUBLIC_DASHBOARD the dashboard reads stats without a key, and nothing else opens', async () => {
  const hub = await startOverlayHub({ publicDashboard: true });
  try {
    await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-a' }), CLIENT);
    const stats = await fetch(`${hub.base}/api/stats`);
    assert.equal(stats.status, 200);
    assert.equal(stats.headers.get('access-control-allow-origin'), null, 'a keyless answer is for this site only');
    assert.deepEqual((await stats.json()).devices.map((d) => d.deviceId), ['dev-a']);

    assert.equal(await status(hub.base, '/api/stats', { 'sec-fetch-site': 'cross-site' }), 401);
    assert.equal(await status(hub.base, '/api/stats', bearer('wrong')), 401);
    // Every other route answers a keyless caller exactly as before.
    assert.equal(await status(hub.base, '/api/devices', {}), 401);
    assert.equal(await status(hub.base, '/api/custom/health', {}), 401);
    assert.equal(await status(hub.base, '/api/ingest', {}, 'POST', JSON.stringify(devicePayload())), 401, 'no keyless uploads');

    const keyed = await fetch(`${hub.base}/api/stats`, { headers: ADMIN });
    assert.equal(keyed.status, 200);
    assert.equal(keyed.headers.get('access-control-allow-origin'), '*', 'widgets with a key see upstream headers unchanged');
    await keyed.arrayBuffer();
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

test('without TOKEN_MONITOR_PUBLIC_DASHBOARD a keyless stats read is still a 401', async () => {
  const hub = await startOverlayHub();
  try {
    assert.equal(await status(hub.base, '/api/stats', {}), 401);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});
