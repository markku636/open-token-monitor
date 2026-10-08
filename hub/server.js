'use strict';

// Overlay entry point for the Node hub: `node hub/server.js` is what
// `npm run hub` runs, plus the dashboard page served at `/` and a SIGTERM
// handler for containers. It composes upstream's
// createHub() rather than editing src/hub/server.js, so pulling upstream never
// conflicts here. The only seams it relies on are public: the `createHub`
// export, the `hub.server` handle it returns, and the shared modules imported
// below (http, config, the DEFAULT_STALE_AFTER_MS constant and the two label
// catalogs). See docs/hub.zh-TW.md.

const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { URL } = require('node:url');

const { ROOT, upstream } = require('../upstream');
const { createHub } = require(upstream('src/hub/server'));
const { sendJson } = require(upstream('src/shared/http'));
const { loadDotEnv, parseArgs, projectRoot } = require(upstream('src/shared/config'));
const { DEFAULT_STALE_AFTER_MS } = require(upstream('src/shared/syncUploadInterval'));
const { CLIENT_IDS, CLIENT_LABELS } = require(upstream('src/shared/clientCatalog'));
const { LIMIT_PROVIDER_LABELS, limitProviderForClient } = require(upstream('src/shared/limits/providers'));
const { wrapRequestListeners } = require('./router');
const { attachOverlay } = require('./overlay');
const { parseSecretList } = require('./access');
const { openPersistence, persistenceConfigFromEnv } = require('./persistence');
const { backupConfigFromEnv } = require('./backups');

// Where .env and data/ live: the root of this repository, in a checkout and in
// the hub image alike (docker/Dockerfile keeps the layout). One .env serves
// `npm run hub` and `docker compose --env-file .env`, and nothing is ever
// written into upstream/.
const RUNTIME_ROOT = ROOT;

// Runs before upstream's loadDotEnv(), which looks in upstream/ (there is no
// .env there). dotenv never overrides a variable that is already set, so the
// real environment wins over the file. dotenv is upstream's dependency, loaded
// the way upstream's config.js loads it.
function loadOverlayDotEnv() {
  createRequire(upstream('src/shared/config.js'))('dotenv').config({ path: path.join(RUNTIME_ROOT, '.env'), quiet: true });
  if (!process.env.TOKEN_MONITOR_DATA_FILE) process.env.TOKEN_MONITOR_DATA_FILE = path.join(RUNTIME_ROOT, 'data', 'devices.json');
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DASHBOARD_PATHS = new Set(['/', '/dashboard', '/index.html']);
// The usage page the dashboard used to link to is part of the dashboard now;
// an old link or bookmark lands there.
const USAGE_PATHS = new Set(['/usage']);
// The admins' page is the dashboard's file too: there it shows only its 管理
// part, and everywhere else only the usage. Like every page it is public; what
// it shows comes from the admin routes.
const ADMIN_PATHS = new Set(['/admin']);
// How to install the company client on Windows, macOS and Linux.
const INSTALL_PATHS = new Set(['/install']);
// Every page the hub serves, as path → file. All of them are public.
const PAGE_FILES = new Map([
  ...[...DASHBOARD_PATHS].map((pathname) => [pathname, 'dashboard.html']),
  ...[...ADMIN_PATHS].map((pathname) => [pathname, 'dashboard.html']),
  ...[...INSTALL_PATHS].map((pathname) => [pathname, 'install.html'])
]);
// The platforms' fixed download names on a GitLab Release: the link filepaths
// .gitlab-ci.yml gives the installers (tests/clientBuild.test.js).
const DOWNLOAD_NAMES = Object.freeze(['windows', 'macos', 'linux']);
const PAGE_PATHS = new Set([...PAGE_FILES.keys(), ...USAGE_PATHS]);

// Read once and keep it: a page is a single small file that cannot change
// while the process runs, and a hub on a Pi should not hit the disk for every
// browser refresh. A missing file is remembered too, so a hub packaged without
// the dashboard does not stat it on every request.
const pages = new Map();
function page(file) {
  if (!pages.has(file)) {
    try {
      const html = fs.readFileSync(path.join(__dirname, file), 'utf8');
      pages.set(file, html.replace('</head>', () => `${settingsScript()}${catalogScript()}</head>`));
    } catch (_) {
      pages.set(file, null);
    }
  }
  return pages.get(file);
}

function dashboardPage() {
  return page('dashboard.html');
}

// The page cannot require src/shared/, so the hub hands it the live client and
// provider catalogs instead: labels then follow upstream renames and additions
// with the next hub restart, without an edit to dashboard.html, whose literal
// maps are only the fallback for a file:// copy. limitProviders is each tool's
// limits provider (limitProviderForClient), for the tools that have one.
// Placed before </head> so it runs ahead of the page's own script. The
// catalogs are our own source, but `<` is escaped anyway so no label could
// ever close the script element.
function catalogScript() {
  const limitProviders = Object.fromEntries(CLIENT_IDS.map((id) => [id, limitProviderForClient(id)]).filter(([, provider]) => provider));
  const json = JSON.stringify({ clients: CLIENT_LABELS, providers: LIMIT_PROVIDER_LABELS, limitProviders })
    .replace(/</g, '\\u003c');
  return `<script>window.TM_CATALOG = ${json};</script>\n`;
}

// What the page shows from the hub's own settings (docs/hub.zh-TW.md), handed over
// the same way. Anyone who can reach the hub gets the page, so only settings
// meant for every viewer belong here. Read when the page is first built, so a
// change takes effect with the next hub restart.
function pageSettings(env = process.env) {
  const downloadUrl = webUrl(env.TOKEN_MONITOR_CLIENT_DOWNLOAD_URL);
  return { downloadUrl, downloads: latestDownloads(downloadUrl), keyless: isGitHubReleases(downloadUrl) };
}

// Whether the download link is a GitHub repository's Releases page. Installers
// there are public, so they carry no hub URL or key
// (.github/workflows/client-release.yml, TM_CLIENT_NO_HUB=1), and the install
// page adds the step that connects the app to this hub.
function isGitHubReleases(downloadUrl) {
  if (!downloadUrl) return false;
  const url = new URL(downloadUrl);
  return url.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/releases(?:\/latest)?\/?$/.test(url.pathname);
}

// Each platform's newest installer, when the download link is a GitLab
// project's Releases page: GitLab keeps a fixed link to the latest Release's
// files (/-/releases/permalink/latest/downloads/<filepath>). Null for any
// other page, which the install page then links as it is.
function latestDownloads(downloadUrl) {
  if (!downloadUrl) return null;
  const url = new URL(downloadUrl);
  if (!/\/-\/releases\/?$/.test(url.pathname) || url.search || url.hash) return null;
  const base = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  return Object.fromEntries(DOWNLOAD_NAMES.map((name) => [name, `${base}/permalink/latest/downloads/${name}`]));
}

function settingsScript() {
  const json = JSON.stringify(pageSettings()).replace(/</g, '\\u003c');
  return `<script>window.TM_SETTINGS = ${json};</script>\n`;
}

// An absolute http(s) URL, or null. The page puts it in a link's href, where a
// javascript: URL would run.
function webUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch (_) {
    return null;
  }
}

// The page signs an admin in (a session cookie, hub/sessions.js) and has admin
// buttons that change things: no other site may frame it (clickjacking), a
// browser takes it as nothing but HTML, and a link out never carries its URL
// (?employee=) along.
const PAGE_HEADERS = Object.freeze({
  'content-security-policy': "frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
});

// Answers a page navigation and says whether it did; anything else is left for
// upstream. This runs in front of upstream's secret gate on purpose: a browser
// cannot send the Authorization header for its first navigation, so a gated
// page could never be opened. It is safe to serve because the files are pure
// markup — every number on them arrives from the authenticated routes, and an
// admin's key is typed by the visitor, sent once to /api/auth/login, and never
// kept, in the file or in the browser.
function serveDashboard(req, res) {
  if (req.method !== 'GET') return false;
  // A malformed absolute-form target (`GET http://[::1 HTTP/1.1`) passes Node's
  // parser but not the URL constructor. This runs synchronously inside the
  // 'request' listener, so a throw here would be an uncaught exception that
  // takes the whole hub down — with no secret needed. Upstream parses the same
  // target inside its async handler and answers 500, so leave it to upstream.
  let pathname;
  let search;
  try {
    ({ pathname, search } = new URL(req.url || '/', 'http://localhost'));
  } catch (_) {
    return false;
  }
  if (USAGE_PATHS.has(pathname)) {
    // Relative, so a hub behind a proxy under a path prefix stays on it.
    res.writeHead(302, { location: `./${search}`, 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  if (!PAGE_FILES.has(pathname)) return false;
  const html = page(PAGE_FILES.get(pathname));
  if (html === null) {
    sendJson(res, 404, { error: 'dashboard_unavailable' });
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...PAGE_HEADERS });
    res.end(html);
  }
  return true;
}

// createHub() with the dashboard routes in front of upstream's handler. The
// dashboard has to answer before upstream's secret gate, so it sits in its own
// listener layer (see router.js).
function createDashboardHub(options) {
  const hub = createHub(options);
  wrapRequestListeners(hub.server, (req, res, forward) => {
    if (!serveDashboard(req, res)) forward(req, res);
  }, { logger: options?.logger });
  return hub;
}

// Settings only the overlay reads (docs/hub.zh-TW.md lists them). Upstream's own
// flags and env vars stay in the bootstrap below, untouched.
function overlayConfigFromEnv(env = process.env) {
  const int = (value, fallback) => {
    const n = Number(value);
    return value !== undefined && String(value).trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  const flag = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
  return {
    clientSecrets: parseSecretList(env.TOKEN_MONITOR_CLIENT_SECRETS),
    trustProxy: flag(env.TOKEN_MONITOR_TRUST_PROXY),
    publicDashboard: flag(env.TOKEN_MONITOR_PUBLIC_DASHBOARD),
    streamWindowMs: int(env.TOKEN_MONITOR_STREAM_WINDOW_MS, 60 * 1000),
    ingestMinIntervalMs: int(env.TOKEN_MONITOR_INGEST_MIN_INTERVAL_MS, 60 * 1000),
    persistence: persistenceConfigFromEnv(env),
    // npm run hub keeps them next to its data; the image sets /backups.
    backup: backupConfigFromEnv(env, { defaultDir: path.join(RUNTIME_ROOT, 'data', 'backups') })
  };
}

// Mirrors the `require.main === module` block of src/hub/server.js, which calls
// its local createHub() directly and so cannot be reused. Keep the two in step:
// tests/hubOverlayBootstrap.test.js fails unless every upstream line is
// still here, in order. The overlay's own steps are the lines in between: the
// database is opened and written into dataFile *before* the hub is created,
// because createHub() reads that file once while it is constructed.
if (require.main === module) {
  loadOverlayDotEnv();
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port || process.env.TOKEN_MONITOR_PORT || 17321);
  const host = String(args.host || process.env.TOKEN_MONITOR_HOST || '0.0.0.0');
  const secret = String(args.secret || process.env.TOKEN_MONITOR_SECRET || '').trim();
  const staleAfterMs = Number(args.staleAfterMs || process.env.TOKEN_MONITOR_STALE_AFTER_MS || DEFAULT_STALE_AFTER_MS);
  const dataFile = String(args.dataFile || process.env.TOKEN_MONITOR_DATA_FILE || path.join(projectRoot(), 'data', 'devices.json'));
  const overlay = overlayConfigFromEnv(process.env);

  (async () => {
    const persistence = await openPersistence(overlay.persistence, { dataFile });

    const hub = createDashboardHub({ port, host, secret, staleAfterMs, dataFile });
    const custom = attachOverlay(hub, { ...overlay, secret, staleAfterMs, dataFile, persistence, publicPaths: PAGE_PATHS });

    // Without this the hub ignores SIGTERM as PID 1 in a container and every
    // `docker stop` spends its full grace period waiting before the kill.
    // hub.stop() also flushes uploads still waiting and the database queue.
    let stopping = false;
    const shutdown = (signal) => {
      if (stopping) return;
      stopping = true;
      console.log(`Received ${signal}, stopping the hub.`);
      // An open SSE stream must not be able to hold the process past the grace
      // period, so the close races a deadline rather than being trusted.
      const deadline = setTimeout(() => process.exit(0), 5000);
      deadline.unref();
      hub.stop().then(() => process.exit(0), () => process.exit(0));
    };
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(signal));

    hub.start().then(() => {
      console.log(`Token Monitor hub listening on http://${hub.bindHost}:${port}`);
      console.log(`Dashboard: http://${LOOPBACK_HOSTS.has(hub.bindHost) ? hub.bindHost : 'localhost'}:${port}/`);
      console.log(`Data file: ${dataFile}`);
      console.log(`Store: ${custom.persistence ? custom.persistence.kind : 'none (JSON file only)'}; keys: admin=${Boolean(secret)}, client=${custom.access.roles.clients}, API tokens=${custom.access.roles.apiTokens ? 'on' : 'off (no database)'}, keyless dashboard=${custom.access.roles.viewer}`);
      if (!secret) {
        console.warn(`Warning: TOKEN_MONITOR_SECRET is not set, so the hub is bound to ${hub.bindHost} (localhost only) to keep account identity off the network. Set a secret to accept connections from other devices.`);
      }
      if (String(process.env.TOKEN_MONITOR_CLIENT_DOWNLOAD_URL || '').trim() && !pageSettings().downloadUrl) {
        console.warn('Warning: TOKEN_MONITOR_CLIENT_DOWNLOAD_URL is not an http(s) URL, so the dashboard shows no download button.');
      }
    }).catch((err) => {
      console.error(`Hub failed to start: ${err.message}`);
      process.exit(1);
    });
  })().catch((err) => {
    console.error(`Hub failed to start: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { ADMIN_PATHS, DASHBOARD_PATHS, DOWNLOAD_NAMES, INSTALL_PATHS, PAGE_PATHS, USAGE_PATHS, createDashboardHub, dashboardPage, latestDownloads, overlayConfigFromEnv, pageSettings };
