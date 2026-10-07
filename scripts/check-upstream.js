'use strict';

// Fails when upstream/ is no longer exactly the upstream release it was pulled
// from. upstream/ is a squashed git subtree: every `git subtree add|pull
// --squash` commits the upstream tree as is, in a commit whose message carries
// `git-subtree-dir: upstream` and `git-subtree-split: <upstream commit>`. So the
// rule "never edit upstream, fix the overlay instead" (AGENTS.md) is checkable:
// the upstream/ tree at HEAD must be the tree of the latest such commit, and the
// working tree must have no change under upstream/.
//
//   node scripts/check-upstream.js      (npm run check:upstream, part of verify)
//
// Outside a git checkout (an exported tree, the hub image) there is nothing to
// compare against, so the check reports that and passes.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PREFIX = 'upstream';
const ROOT = path.join(__dirname, '..');

function gitRaw(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function git(args, cwd) {
  return gitRaw(args, cwd).trim();
}

function isGitCheckout(cwd) {
  try {
    return git(['rev-parse', '--is-inside-work-tree'], cwd) === 'true';
  } catch (_) {
    return false;
  }
}

// The latest squash commit for the prefix, and the upstream commit it holds.
function latestSquash(cwd, prefix = PREFIX) {
  const out = git(['log', '--format=%H%x00%B%x01', `--grep=^git-subtree-dir: ${prefix}$`, '-1', 'HEAD'], cwd);
  if (!out) return null;
  const [commit, body = ''] = out.replace(/\x01$/, '').split('\x00');
  const split = /^git-subtree-split: ([0-9a-f]{7,40})$/m.exec(body);
  return { commit, split: split ? split[1] : null };
}

function upstreamVersion(cwd, prefix = PREFIX) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, prefix, 'package.json'), 'utf8')).version || null;
  } catch (_) {
    return null;
  }
}

// { ok, skipped?, version, split, squash, problems[] }
function checkUpstream({ cwd = ROOT, prefix = PREFIX } = {}) {
  const version = upstreamVersion(cwd, prefix);
  if (!isGitCheckout(cwd)) return { ok: true, skipped: 'not a git checkout', version, split: null, squash: null, problems: [] };
  const problems = [];
  const squash = latestSquash(cwd, prefix);
  if (!squash) {
    problems.push(`no "git-subtree-dir: ${prefix}" commit in the history: ${prefix}/ was not added with git subtree --squash`);
    return { ok: false, version, split: null, squash: null, problems };
  }
  let headTree = '';
  try {
    headTree = git(['rev-parse', `HEAD:${prefix}`], cwd);
  } catch (_) {
    problems.push(`${prefix}/ is missing at HEAD`);
  }
  const squashTree = git(['rev-parse', `${squash.commit}^{tree}`], cwd);
  if (headTree && headTree !== squashTree) {
    const changed = git(['diff', '--name-only', squash.commit, 'HEAD', '--', `${prefix}/`], cwd)
      .split('\n').filter(Boolean);
    const files = changed.length ? changed : [`${prefix}/`];
    problems.push(`committed changes under ${prefix}/ since the subtree pull (${squash.commit.slice(0, 12)}): ${files.slice(0, 10).join(', ')}${files.length > 10 ? ', …' : ''}`);
  }
  // Not trimmed: a porcelain line starts with its two status columns, the first
  // of which is often a space.
  const dirty = gitRaw(['status', '--porcelain', '--untracked-files=all', '--', `${prefix}/`], cwd)
    .split('\n').filter(Boolean);
  if (dirty.length) problems.push(`uncommitted changes under ${prefix}/: ${dirty.slice(0, 10).map((line) => line.slice(3)).join(', ')}${dirty.length > 10 ? ', …' : ''}`);
  return { ok: problems.length === 0, version, split: squash.split, squash: squash.commit, problems };
}

if (require.main === module) {
  const result = checkUpstream();
  if (result.skipped) {
    console.log(`upstream check skipped: ${result.skipped}`);
  } else if (result.ok) {
    console.log(`upstream/ is upstream ${result.version || '(unknown version)'} as pulled (commit ${String(result.split).slice(0, 12)}).`);
  } else {
    console.error('upstream/ has been modified. Never edit upstream code: change the overlay instead, and pull new upstream releases with `npm run upstream:update -- <tag>`.');
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}

module.exports = { PREFIX, checkUpstream, latestSquash, upstreamVersion };
