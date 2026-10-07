'use strict';

// hub/sessions.js: the dashboard signs an admin in once with the admin key and
// then works with an HttpOnly cookie, so the key never stays in the browser.

const assert = require('node:assert/strict');
const test = require('node:test');

const { cookieValue, sameSiteWrite } = require('../hub/sessions');
const { bearer, post, removeAll, startOverlayHub, tempPath } = require('./helpers/overlayHub');
const { devicePayload, provider } = require('./helpers/fixtures');

const PAGE = { 'x-tm-request': '1', 'sec-fetch-site': 'same-origin' };

async function call(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', ...headers }, body });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

const login = (base, key, headers = PAGE) => call(base, '/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ key }) });
const cookieOf = (response) => /tm_admin=([^;]*)/.exec(response.headers.get('set-cookie') || '')?.[1] || '';

test('the cookie is read by name, and a write counts as the page\'s own only with its header and no cross-site label', () => {
  assert.equal(cookieValue({ headers: { cookie: 'a=1; tm_admin=xyz; b=2' } }, 'tm_admin'), 'xyz');
  assert.equal(cookieValue({ headers: {} }, 'tm_admin'), '');
  assert.equal(sameSiteWrite({ headers: { 'x-tm-request': '1' } }), true, 'curl and scripts send no Sec-Fetch-Site');
  assert.equal(sameSiteWrite({ headers: { 'x-tm-request': '1', 'sec-fetch-site': 'same-origin' } }), true);
  assert.equal(sameSiteWrite({ headers: { 'x-tm-request': '1', 'sec-fetch-site': 'cross-site' } }), false);
  assert.equal(sameSiteWrite({ headers: { 'x-tm-request': '1', 'sec-fetch-site': 'same-site' } }), false);
  assert.equal(sameSiteWrite({ headers: { 'sec-fetch-site': 'same-origin' } }), false);
});

test('an admin signs in with the key once and works with an HttpOnly cookie; sessions outlive a restart but not a new secret', async () => {
  const hub = await startOverlayHub({ database: true, publicDashboard: true });
  let restarted = null;
  let rotated = null;
  try {
    assert.equal((await call(hub.base, '/api/auth/me')).body.role, 'viewer', 'no key: the company-wide view');
    assert.equal((await call(hub.base, '/api/auth/me', { headers: bearer('admin-secret') })).body.via, 'key');

    assert.equal((await login(hub.base, 'admin-secret', {})).status, 403, 'only the page itself signs in');
    assert.equal((await login(hub.base, 'client-secret')).status, 401, 'the client key is no admin key');
    const signedIn = await login(hub.base, ' admin-secret ');
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    const setCookie = signedIn.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, /Max-Age=43200/);
    assert.doesNotMatch(setCookie, /Secure/, 'plain http: a Secure cookie would never come back');
    assert.doesNotMatch(JSON.stringify(signedIn.body), /admin-secret/);
    const cookie = { cookie: `tm_admin=${cookieOf(signedIn)}` };

    const me = await call(hub.base, '/api/auth/me', { headers: cookie });
    assert.deepEqual([me.body.role, me.body.via], ['admin', 'session']);
    assert.equal((await call(hub.base, '/api/admin/units', { headers: cookie })).status, 200, 'the cookie opens the admin routes');
    assert.equal((await call(hub.base, '/api/custom/health', { headers: cookie })).status, 200);

    const write = (headers) => call(hub.base, '/api/admin/units/ACME', { method: 'PUT', headers: { ...cookie, ...headers }, body: JSON.stringify({ name: 'ACME' }) });
    assert.equal((await write({})).status, 403, 'the cookie alone never authorizes a write');
    assert.equal((await write({ 'x-tm-request': '1', 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await write(PAGE)).status, 200);
    const [unit] = await hub.overlay.persistence.store.query('SELECT unit_id FROM org_units');
    assert.equal(unit.unit_id, 'ACME');

    assert.equal((await call(hub.base, '/api/admin/units', { headers: { ...cookie, ...bearer('wrong') } })).status, 401, 'a wrong key is a 401 whatever cookie comes with it');
    assert.equal((await call(hub.base, '/api/admin/units', { headers: { cookie: 'tm_admin=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })).status, 401, 'a made-up session is no session');
    const [stored] = await hub.overlay.persistence.store.query('SELECT token_hash FROM admin_sessions');
    assert.equal(Buffer.from(stored.token_hash).length, 32, 'only a hash is kept');
    assert.notEqual(Buffer.from(stored.token_hash).toString('base64url'), cookieOf(signedIn));

    // The same database after a restart: still signed in.
    await hub.stop();
    restarted = await startOverlayHub({ database: hub.schema, dataFile: tempPath('devices.json'), publicDashboard: true });
    assert.equal((await call(restarted.base, '/api/auth/me', { headers: cookie })).body.via, 'session');

    // Signing out ends it here and in the database.
    const out = await call(restarted.base, '/api/auth/logout', { method: 'POST', headers: { ...cookie, ...PAGE } });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie'), /tm_admin=;.*Max-Age=0/);
    assert.equal((await call(restarted.base, '/api/admin/units', { headers: cookie })).status, 401);

    // A new admin secret ends every session opened with the old one.
    const again = cookieOf(await login(restarted.base, 'admin-secret'));
    await restarted.stop();
    rotated = await startOverlayHub({ database: hub.schema, dataFile: tempPath('devices.json'), secret: 'new-admin-secret' });
    assert.equal((await call(rotated.base, '/api/admin/units', { headers: { cookie: `tm_admin=${again}` } })).status, 401);
    assert.equal((await rotated.overlay.persistence.store.query('SELECT token_hash FROM admin_sessions')).length, 0, 'and forgets them');
  } finally {
    if (!restarted) await hub.stop();
    else if (!rotated) await restarted.stop();
    if (rotated) await rotated.stop();
    removeAll(hub.dataFile);
  }
});

test('failed sign-ins are limited per address', async () => {
  const hub = await startOverlayHub();
  try {
    for (let i = 0; i < 5; i += 1) assert.equal((await login(hub.base, `wrong-${i}`)).status, 401);
    const blocked = await login(hub.base, 'admin-secret');
    assert.equal(blocked.status, 429, 'even the right key waits out the minute');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

test('a keyless viewer gets stats with AI account emails but no account keys', async () => {
  const hub = await startOverlayHub({ publicDashboard: true });
  try {
    const accounts = { limits: false, extra: { limits: { updatedAt: new Date().toISOString(), refreshMs: 300000, providers: [provider({ email: 'ann@example.test' })] } } };
    await post(hub.base, '/api/ingest', devicePayload({ deviceId: 'dev-a', ...accounts }), bearer('client-secret'));
    const admin = await call(hub.base, '/api/stats', { headers: bearer('admin-secret') });
    assert.match(JSON.stringify(admin.body), /ann@example\.test/, 'an admin sees whose accounts they are');
    assert.match(JSON.stringify(admin.body), /accountKey/);
    const viewer = await call(hub.base, '/api/stats');
    assert.equal(viewer.status, 200);
    assert.equal(viewer.body.devices.length, 1);
    assert.match(JSON.stringify(viewer.body), /"accountEmail":"ann@example\.test"/, 'everyone sees whose accounts they are');
    assert.doesNotMatch(JSON.stringify(viewer.body), /accountKey|ownerEmail/);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});
