'use strict';

// The reports API's documentation (apiDocs.js): served to anyone, with the
// hub's own address in its links, and naming every route, scope and error the
// code has, in /llms.txt, /llms-full.txt, the OpenAPI document and
// docs/reports-api.zh-TW.md alike.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ANALYTICS_PATHS } = require('../hub/analytics');
const { scopeFor } = require('../hub/access');
const { SCOPES } = require('../hub/apiTokens');
const { originOf } = require('../hub/apiDocs');
const { openApiDocument } = require('../hub/openapi');
const { removeAll, startOverlayHub } = require('./helpers/overlayHub');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const LLMS = read('hub/llms.txt');
const LLMS_FULL = read('hub/llms-full.txt');
const ZH = read('docs/reports-api.zh-TW.md');
const DOC = openApiDocument({ origin: 'http://hub.example' });

// The routes the code answers: reports.js's table and analytics.js's.
function codeRoutes() {
  const reports = [...read('hub/reports.js').matchAll(/^\s*'(\/api\/reports\/v1\/[a-z/]+)': \w+,?$/gm)].map((m) => m[1]);
  assert.ok(reports.length >= 5, 'reports.js routes were not recognised');
  return new Set([...reports, ...ANALYTICS_PATHS]);
}

// The error codes the code can answer the reports API with.
function codeErrors() {
  const codes = new Set();
  for (const file of ['hub/reports.js', 'hub/analytics.js']) {
    for (const [, code] of read(file).matchAll(/new RequestError\(\d+, '([a-z_]+)'/g)) codes.add(code);
  }
  // usage.js answers usage/analysis; unknown_org is renamed, other=,
  // unowned= and the admin-only check cannot happen there.
  for (const [, code] of read('hub/usage.js').matchAll(/new UsageError\(\d+, '([a-z_]+)'/g)) {
    if (!['unknown_org', 'bad_other', 'bad_unowned'].includes(code)) codes.add(code);
  }
  for (const code of ['unauthorized', 'forbidden', 'not_found', 'store_unavailable', 'usage_slow']) codes.add(code);
  return codes;
}

test('every route the reports API has is in the OpenAPI document, llms.txt, llms-full.txt and the Chinese reference', () => {
  const routes = codeRoutes();
  assert.deepEqual(new Set(Object.keys(DOC.paths)), routes);
  for (const route of routes) {
    assert.ok(LLMS.includes(`GET ${route}]`), `llms.txt: ${route}`);
    assert.match(LLMS_FULL, new RegExp(`^## GET ${route.replace(/\//g, '\\/')}$`, 'm'), `llms-full.txt: ${route}`);
    assert.match(ZH, new RegExp(`^### \`GET ${route.replace(/\//g, '\\/')}\`$`, 'm'), `reports-api.zh-TW.md: ${route}`);
    // Each operation names the scope access.js asks of it.
    const operation = DOC.paths[route].get;
    assert.deepEqual(operation.security, [{ bearerAuth: [scopeFor(route)] }], route);
    assert.equal(operation['x-required-scope'], scopeFor(route), route);
  }
  for (const scope of SCOPES) {
    for (const [name, text] of [['llms.txt', LLMS], ['llms-full.txt', LLMS_FULL], ['reports-api.zh-TW.md', ZH]]) assert.ok(text.includes(`\`${scope}\``), `${name}: ${scope}`);
  }
});

test('every error code of the reports API is documented', () => {
  for (const code of codeErrors()) {
    assert.ok(LLMS_FULL.includes(`\`${code}\``), `llms-full.txt: ${code}`);
    assert.ok(ZH.includes(`\`${code}\``), `reports-api.zh-TW.md: ${code}`);
  }
});

test('the OpenAPI document is 3.1 and every reference in it resolves', () => {
  assert.equal(DOC.openapi, '3.1.0');
  assert.deepEqual(DOC.servers, [{ url: 'http://hub.example', description: 'This hub' }]);
  assert.deepEqual(openApiDocument().servers[0].url, '/');
  const refs = JSON.stringify(DOC).match(/"\$ref":"[^"]+"/g);
  assert.ok(refs.length > 20);
  for (const ref of new Set(refs)) {
    const [, kind, name] = /#\/components\/(\w+)\/(\w+)/.exec(ref);
    assert.ok(DOC.components[kind]?.[name], ref);
  }
  const ids = Object.values(DOC.paths).map((item) => item.get.operationId);
  assert.equal(new Set(ids).size, ids.length, 'operationIds are unique');
});

test('the hub address is the one the caller reached, and only a plain host name or address', () => {
  const req = (headers, encrypted = false) => ({ headers, socket: { encrypted } });
  assert.equal(originOf(req({ host: 'hub.example:17321' })), 'http://hub.example:17321');
  assert.equal(originOf(req({ host: '192.0.2.10' }, true)), 'https://192.0.2.10');
  assert.equal(originOf(req({ host: '[::1]:17321' })), 'http://[::1]:17321');
  for (const host of ['', 'evil.example/path', 'a b', 'hub.example:x', '"><script>', 'user@hub.example']) assert.equal(originOf(req({ host })), null, host);
  // A proxy's headers count only when the operator trusts it.
  const proxied = req({ host: '10.0.0.5:17321', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'tm.example, inner' });
  assert.equal(originOf(proxied), 'http://10.0.0.5:17321');
  assert.equal(originOf(proxied, true), 'https://tm.example');
});

test('the docs need no key, carry no secret and point at this hub', async () => {
  const hub = await startOverlayHub({ secret: 'admin-secret', clientSecrets: ['client-secret'] });
  try {
    const host = new URL(hub.base).host;
    for (const pathname of ['/llms.txt', '/llms-full.txt']) {
      const response = await fetch(`${hub.base}${pathname}`);
      assert.equal(response.status, 200, pathname);
      assert.match(response.headers.get('content-type'), /^text\/plain; charset=utf-8/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.text();
      assert.ok(!body.includes('{{origin}}'), `${pathname}: every placeholder filled in`);
      assert.ok(body.includes(`http://${host}/api/reports/v1/openapi.json`), pathname);
      for (const secret of ['admin-secret', 'client-secret']) assert.ok(!body.includes(secret), `${pathname} must not carry ${secret}`);
    }
    const head = await fetch(`${hub.base}/llms.txt`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    const openapi = await fetch(`${hub.base}/api/reports/v1/openapi.json`);
    assert.equal(openapi.status, 200);
    assert.equal(openapi.headers.get('access-control-allow-origin'), '*');
    const spec = await openapi.json();
    assert.equal(spec.servers[0].url, `http://${host}`);
    assert.deepEqual(Object.keys(spec.paths), Object.keys(DOC.paths));
    // The routes the docs describe still want a token.
    assert.equal((await fetch(`${hub.base}/api/reports/v1/units`)).status, 401);
    assert.equal((await fetch(`${hub.base}/llms.txt`, { method: 'POST' })).status, 401, 'only reads are public');
  } finally {
    await hub.stop();
    removeAll(hub.dataFile);
  }
});
