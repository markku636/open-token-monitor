'use strict';

// The build values of the company client (docs/client-build.zh-TW.md): the hub
// URL and client key the installer starts with, the upload interval, launch at
// login, the GitLab project the app updates from, and the version. They come
// from the real environment first (GitLab CI/CD variables), then from
// .env.client in the repository root for a local build. Validation follows the
// checks of the earlier company installer.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env.client');

// upstream/src/shared/syncUploadInterval.js accepts only these (0 = live).
const UPLOAD_INTERVALS = new Set([0, 600000, 1200000, 1800000]);
const DEFAULT_UPLOAD_INTERVAL_MS = 1800000;
// Characters that survive JSON and a Windows path without escaping. Keys from
// `openssl rand -hex 32` or base64url fit.
const SECRET_RE = /^[A-Za-z0-9._~+=/-]{16,256}$/;
const VERSION_RE = /^(\d+\.\d+\.\d+)-corp\.(0|[1-9]\d*)$/;
const TAG_PREFIX = 'client-v';

function normalizeHubUrl(value, { allowHttp = false } = {}) {
  const text = String(value || '').trim();
  if (!text) throw new Error('TM_CLIENT_HUB_URL is required');
  let url;
  try {
    url = new URL(text);
  } catch (error) {
    throw new Error(`TM_CLIENT_HUB_URL is not a valid URL: ${text}`, { cause: error });
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new Error('TM_CLIENT_HUB_URL must use https (set TM_CLIENT_ALLOW_HTTP=1 for an http hub)');
  }
  if (url.username || url.password) throw new Error('TM_CLIENT_HUB_URL must not carry credentials');
  if (url.search || url.hash) throw new Error('TM_CLIENT_HUB_URL must not have a query or fragment');
  return url.toString().replace(/\/+$/, '');
}

function normalizeSecret(value) {
  const key = String(value || '').trim();
  if (!SECRET_RE.test(key)) {
    throw new Error('TM_CLIENT_SECRET must be 16-256 characters of A-Z a-z 0-9 . _ ~ + = / - (a client key from TOKEN_MONITOR_CLIENT_SECRETS)');
  }
  return key;
}

function normalizeInterval(value) {
  if (value === undefined || String(value).trim() === '') return DEFAULT_UPLOAD_INTERVAL_MS;
  const interval = Number(value);
  if (!UPLOAD_INTERVALS.has(interval)) {
    throw new Error('TM_CLIENT_SYNC_UPLOAD_INTERVAL_MS must be 0, 600000, 1200000 or 1800000');
  }
  return interval;
}

function parseFlag(value, fallback, name = 'flag') {
  if (value === undefined || String(value).trim() === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw new Error(`${name}: expected 1 or 0, got "${value}"`);
}

// The GitLab project whose newest Release the installed app updates from
// (electron-updater's gitlab provider). CI passes $CI_PROJECT_URL and
// $CI_PROJECT_ID. The feed uses the numeric id, which survives a rename or a
// move of the project; the URL gives the host and the Release pages. Neither
// set: the app has no update source, as before.
function normalizeUpdateSource(projectUrl, projectId) {
  const urlText = String(projectUrl || '').trim();
  const idText = String(projectId || '').trim();
  if (!urlText && !idText) return null;
  if (!urlText || !idText) {
    throw new Error('TM_CLIENT_UPDATE_PROJECT_URL and TM_CLIENT_UPDATE_PROJECT_ID go together: set both or neither');
  }
  let url;
  try {
    url = new URL(urlText);
  } catch (error) {
    throw new Error(`TM_CLIENT_UPDATE_PROJECT_URL is not a valid URL: ${urlText}`, { cause: error });
  }
  if (url.protocol !== 'https:') throw new Error('TM_CLIENT_UPDATE_PROJECT_URL must use https');
  if (url.username || url.password) throw new Error('TM_CLIENT_UPDATE_PROJECT_URL must not carry credentials');
  if (url.search || url.hash) throw new Error('TM_CLIENT_UPDATE_PROJECT_URL must not have a query or fragment');
  const projectPath = url.pathname.replace(/\/+$/, '');
  if (!projectPath || projectPath.includes('/-/')) {
    throw new Error('TM_CLIENT_UPDATE_PROJECT_URL must be the project page, e.g. https://git.example/group/project');
  }
  if (!/^[1-9]\d*$/.test(idText)) {
    throw new Error('TM_CLIENT_UPDATE_PROJECT_ID must be the numeric project ID (Settings → General)');
  }
  return { host: url.host, projectId: Number(idText), releasesUrl: `${url.origin}${projectPath}/-/releases` };
}

// X.Y.Z-corp.N, where X.Y.Z is the upstream version the build is made from. A
// CI tag `client-vX.Y.Z-corp.N` is accepted too. Without one, a local build is
// X.Y.Z-corp.0.
function normalizeVersion(value, upstreamVersion) {
  const text = String(value || '').trim().replace(new RegExp(`^${TAG_PREFIX}`), '');
  if (!text) return `${upstreamVersion}-corp.0`;
  const match = VERSION_RE.exec(text);
  if (!match) throw new Error(`TM_CLIENT_VERSION must be X.Y.Z-corp.N (got "${value}")`);
  if (match[1] !== upstreamVersion) {
    throw new Error(`TM_CLIENT_VERSION ${text} must be based on the upstream version in upstream/package.json (${upstreamVersion})`);
  }
  return text;
}

// Real environment variables win over .env.client, as dotenv's override:false.
function readEnv({ env = process.env, envFile = ENV_FILE } = {}) {
  const merged = {};
  if (envFile && fs.existsSync(envFile)) Object.assign(merged, require('dotenv').parse(fs.readFileSync(envFile)));
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('TM_CLIENT_') && value !== undefined) merged[key] = value;
  }
  return merged;
}

function resolveClientConfig({ upstreamVersion, env = process.env, envFile = ENV_FILE } = {}) {
  const values = readEnv({ env, envFile });
  const allowHttp = parseFlag(values.TM_CLIENT_ALLOW_HTTP, false, 'TM_CLIENT_ALLOW_HTTP');
  const update = normalizeUpdateSource(values.TM_CLIENT_UPDATE_PROJECT_URL, values.TM_CLIENT_UPDATE_PROJECT_ID);
  return {
    version: normalizeVersion(values.TM_CLIENT_VERSION, upstreamVersion),
    defaults: {
      hubUrl: normalizeHubUrl(values.TM_CLIENT_HUB_URL, { allowHttp }),
      secret: normalizeSecret(values.TM_CLIENT_SECRET),
      syncUploadIntervalMs: normalizeInterval(values.TM_CLIENT_SYNC_UPLOAD_INTERVAL_MS),
      startAtLogin: parseFlag(values.TM_CLIENT_START_AT_LOGIN, true, 'TM_CLIENT_START_AT_LOGIN'),
      // A launch at login minimizes the widget to the taskbar.
      startMinimizedAtLogin: parseFlag(values.TM_CLIENT_START_MINIMIZED, true, 'TM_CLIENT_START_MINIMIZED'),
      // The widget shows this machine only, not every device on the hub.
      ownDeviceOnly: parseFlag(values.TM_CLIENT_OWN_DEVICE_ONLY, true, 'TM_CLIENT_OWN_DEVICE_ONLY'),
      // For the company entry: where "the release page" of an update goes.
      ...(update ? { releasesUrl: update.releasesUrl } : {})
    },
    update
  };
}

// For logs and --dry-run: never print the key.
function redacted(defaults) {
  return { ...defaults, secret: defaults.secret ? '***' : '' };
}

module.exports = {
  DEFAULT_UPLOAD_INTERVAL_MS,
  ENV_FILE,
  UPLOAD_INTERVALS,
  normalizeHubUrl,
  normalizeInterval,
  normalizeSecret,
  normalizeUpdateSource,
  normalizeVersion,
  parseFlag,
  readEnv,
  redacted,
  resolveClientConfig
};
