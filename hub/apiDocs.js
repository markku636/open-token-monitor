'use strict';

// The reports API's documentation, for the people and the AI agents that
// connect other systems to the hub. No key needed, like the dashboard: it is
// prose and a schema, never data or a secret.
//
//   GET /llms.txt                       the index (llmstxt.org), Markdown
//   GET /llms-full.txt                  the whole reference in one file
//   GET /api/reports/v1/openapi.json    OpenAPI 3.1 (openapi.js)
//
// The files say {{origin}} where the hub's own address belongs; it is filled
// in from the request (Host, and behind TOKEN_MONITOR_TRUST_PROXY the
// proxy's X-Forwarded-Proto and X-Forwarded-Host), so the links an agent
// follows are the ones it reached the hub by. A Host that is not a plain host
// name or address leaves the placeholder http://<hub>.

const fs = require('node:fs');
const path = require('node:path');
const { upstream } = require('../upstream');
const { sendJson } = require(upstream('src/shared/http'));
const { openApiDocument } = require('./openapi');

const TEXT_FILES = Object.freeze({ '/llms.txt': 'llms.txt', '/llms-full.txt': 'llms-full.txt' });
const OPENAPI_PATH = '/api/reports/v1/openapi.json';
const DOC_PATHS = new Set([...Object.keys(TEXT_FILES), OPENAPI_PATH]);
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
const UNKNOWN_ORIGIN = 'http://<hub>';
const HEADERS = Object.freeze({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' });

const first = (value) => String(value || '').split(',')[0].trim();

// The hub as the caller reached it, or null.
function originOf(req, trustProxy = false) {
  const host = (trustProxy && first(req.headers['x-forwarded-host'])) || String(req.headers.host || '');
  if (!HOST_RE.test(host)) return null;
  const https = req.socket?.encrypted || (trustProxy && first(req.headers['x-forwarded-proto']).toLowerCase() === 'https');
  return `${https ? 'https' : 'http'}://${host}`;
}

function createApiDocs({ trustProxy = false } = {}) {
  // Read once, like the pages (server.js): small files that cannot change
  // while the process runs.
  const texts = new Map(Object.entries(TEXT_FILES).map(([pathname, file]) => [pathname, fs.readFileSync(path.join(__dirname, file), 'utf8')]));

  function handle(req, res, pathname) {
    const origin = originOf(req, trustProxy);
    if (pathname === OPENAPI_PATH) return sendJson(res, 200, openApiDocument({ origin }), HEADERS);
    const body = texts.get(pathname).replaceAll('{{origin}}', origin || UNKNOWN_ORIGIN);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...HEADERS });
    return res.end(body);
  }

  return { handles: (method, pathname) => (method === 'GET' || method === 'HEAD') && DOC_PATHS.has(pathname), handle };
}

module.exports = { DOC_PATHS, OPENAPI_PATH, createApiDocs, originOf };
