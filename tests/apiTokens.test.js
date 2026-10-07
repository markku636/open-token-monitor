'use strict';

// hub/apiTokens.js: tokens an admin makes on the dashboard for other systems,
// read-only on /api/reports/v1/*, stored as a hash, revocable.

const assert = require('node:assert/strict');
const test = require('node:test');

const { TOKEN_RE, createApiTokens } = require('../hub/apiTokens');
const { createStore } = require('../hub/persistence/store');
const { bearer, removeAll, startOverlayHub } = require('./helpers/overlayHub');
const { openPglite } = require('./helpers/pg');

const ADMIN = bearer('admin-secret');
const CLIENT = bearer('client-secret');

async function call(base, pathname, { method = 'GET', headers = ADMIN, body } = {}) {
  const response = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { status: response.status, body: parsed };
}

test('an admin makes a token, another system reads the reports with it, and a revoked token is refused', async () => {
  const hub = await startOverlayHub({ database: true });
  try {
    const made = await call(hub.base, '/api/admin/api-tokens', { method: 'POST', body: { name: 'Ledger', expiresAt: '2099-12-31' } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.match(made.body.token, TOKEN_RE);
    assert.deepEqual([made.body.name, made.body.scopes, made.body.createdBy, made.body.expiresAt], ['Ledger', ['reports:read'], 'admin', '2099-12-31T23:59:59.999Z']);
    assert.equal(made.body.token.slice(4, 12), made.body.prefix);
    const TOKEN = bearer(made.body.token);

    // The token is shown once: the list has its prefix, never the token or its hash.
    const listed = await call(hub.base, '/api/admin/api-tokens');
    assert.deepEqual(listed.body.tokens.map((t) => [t.id, t.name, t.prefix, t.revokedAt]), [[made.body.id, 'Ledger', made.body.prefix, null]]);
    assert.doesNotMatch(JSON.stringify(listed.body), new RegExp(made.body.token.slice(13)));
    const [row] = await hub.overlay.persistence.store.query('SELECT token_hash FROM api_tokens');
    assert.equal(Buffer.from(row.token_hash).length, 32, 'SHA-256 only');

    assert.equal((await call(hub.base, '/api/reports/v1/devices', { headers: TOKEN })).status, 200);
    assert.equal((await call(hub.base, '/api/reports/v1/devices', { headers: { 'x-token-monitor-secret': made.body.token } })).status, 200, 'the header form works too');
    for (const [method, pathname] of [['GET', '/api/admin/api-tokens'], ['GET', '/api/stats'], ['GET', '/api/custom/usage'], ['POST', '/api/ingest']]) {
      assert.equal((await call(hub.base, pathname, { method, headers: TOKEN, body: method === 'POST' ? {} : undefined })).status, 403, `${method} ${pathname}`);
    }
    // Right prefix, wrong secret.
    const forged = `tmk_${made.body.prefix}_${'0'.repeat(40)}`;
    assert.equal((await call(hub.base, '/api/reports/v1/devices', { headers: bearer(forged) })).status, 401);

    await hub.settle();
    const [used] = await hub.overlay.persistence.store.query('SELECT last_used_at FROM api_tokens');
    assert.ok(used.last_used_at, 'using a token stamps it');
    assert.equal((await call(hub.base, '/api/custom/health')).body.apiTokens.active, 1);

    const revoked = await call(hub.base, `/api/admin/api-tokens/${made.body.id}`, { method: 'DELETE', headers: { ...ADMIN, 'x-token-monitor-actor': 'mark' } });
    assert.equal(revoked.status, 200);
    assert.ok(revoked.body.revokedAt);
    assert.equal(revoked.body.revokedBy, 'admin:mark');
    assert.equal((await call(hub.base, '/api/reports/v1/devices', { headers: TOKEN })).status, 401, 'revoked at once');
    assert.equal((await call(hub.base, `/api/admin/api-tokens/${made.body.id}`, { method: 'DELETE' })).body.revokedAt, revoked.body.revokedAt, 'revoking again changes nothing');
    assert.equal((await call(hub.base, '/api/admin/api-tokens/999', { method: 'DELETE' })).status, 404);
    assert.equal((await call(hub.base, '/api/admin/api-tokens/abc', { method: 'DELETE' })).status, 404);

    for (const body of [{}, { name: ' ' }, { name: 'x'.repeat(101) }, { name: 'Old', expiresAt: '2020-01-01' }, { name: 'Bad', expiresAt: 'soon' }, { name: 'Wide', scopes: ['admin'] }, { name: 'None', scopes: [] }]) {
      assert.equal((await call(hub.base, '/api/admin/api-tokens', { method: 'POST', body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await call(hub.base, '/api/admin/api-tokens', { method: 'POST', headers: CLIENT, body: { name: 'Mine' } })).status, 403, 'only an admin makes tokens');
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});

test('a token stops working when it expires', async () => {
  let clock = Date.parse('2026-09-29T00:00:00.000Z');
  const store = createStore(await openPglite(), { now: () => clock });
  try {
    await store.migrate();
    const tokens = createApiTokens({ store, now: () => clock, logger: { warn() {} } });
    await tokens.start();
    const { token } = await tokens.create({ name: 'BI', expiresAt: '2026-09-30T00:00:00Z' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    assert.equal(tokens.identify(req).name, 'BI');
    clock = Date.parse('2026-09-30T00:00:00.000Z');
    assert.equal(tokens.identify(req), null);
    assert.deepEqual(tokens.status(), { tokens: 1, active: 0 });
    assert.equal(tokens.identify({ headers: { authorization: 'Bearer client-secret' } }), null, 'not a token at all');
  } finally {
    await store.close();
  }
});

test('a hub without a database has no API tokens', async () => {
  const hub = await startOverlayHub();
  try {
    assert.equal((await call(hub.base, '/api/admin/api-tokens', { method: 'POST', body: { name: 'Ledger' } })).status, 503);
    assert.equal((await call(hub.base, '/api/reports/v1/devices', { headers: bearer(`tmk_${'a'.repeat(8)}_${'b'.repeat(40)}`) })).status, 401);
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});
