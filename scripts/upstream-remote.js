'use strict';

// Where upstream token-monitor is published, and its release tags. upstream/
// is pulled straight from GitHub; set UPSTREAM_URL to pull from a mirror. With
// a mirror, GitHub itself is only asked which tags the mirror still lacks
// (scripts/upstream-status.js).

const { execFileSync } = require('node:child_process');

const DEFAULT_UPSTREAM_URL = 'https://github.com/Javis603/token-monitor.git';
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const LS_REMOTE_TIMEOUT_MS = 30000;

function upstreamUrl(env = process.env) {
  return String(env.UPSTREAM_URL || '').trim() || DEFAULT_UPSTREAM_URL;
}

function compareVersions(a, b) {
  const pa = TAG_RE.exec(a).slice(1).map(Number);
  const pb = TAG_RE.exec(b).slice(1).map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// `git ls-remote --tags` output → [{ tag, commit }] for the release tags,
// oldest first. An annotated tag is listed twice; its peeled line (^{}) names
// the commit.
function parseLsRemoteTags(text) {
  const commits = new Map();
  for (const line of String(text).split('\n')) {
    const match = /^([0-9a-f]{40})\s+refs\/tags\/(\S+?)(\^\{\})?$/.exec(line.trim());
    if (!match || !TAG_RE.test(match[2])) continue;
    if (match[3] || !commits.has(match[2])) commits.set(match[2], match[1]);
  }
  return [...commits].map(([tag, commit]) => ({ tag, commit })).sort((a, b) => compareVersions(a.tag, b.tag));
}

function remoteTags(url = upstreamUrl()) {
  return parseLsRemoteTags(execFileSync('git', ['ls-remote', '--tags', url], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: LS_REMOTE_TIMEOUT_MS
  }));
}

// GitHub's release tags, or null when GitHub cannot be reached.
function githubTags(list = remoteTags) {
  try {
    return list(DEFAULT_UPSTREAM_URL);
  } catch (_) {
    return null;
  }
}

module.exports = { DEFAULT_UPSTREAM_URL, TAG_RE, compareVersions, githubTags, parseLsRemoteTags, remoteTags, upstreamUrl };
