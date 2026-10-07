'use strict';

// Moves upstream/ to another upstream release:
//
//   npm run upstream:update -- next                    the release after the one upstream/ holds
//   npm run upstream:update -- v0.64.0
//   npm run upstream:update -- latest --allow-skip
//
// One release at a time: a target that skips a release is refused unless
// --allow-skip is given, so a broken seam points at the release that broke it
// (docs/upstream-upgrade.zh-TW.md). Pulls the tag straight from upstream on
// GitHub (UPSTREAM_URL for a mirror) into upstream/ as one squashed commit plus
// its merge, runs `npm run verify`, and writes what the update touches to
// tmp/upstream-impact.md (scripts/upstream-impact.js). A failing verify means
// upstream moved a seam the overlay relies on: fix the overlay (never
// upstream/) and commit the fix on top.
//
// Exit code: 0 when verify passed (or there was nothing to pull), 3 when the
// pull is committed but verify failed, 1 on an error. Only `git subtree pull`
// failing halfway errs after the pull has begun (see `git status`); a report
// that cannot be written after it is a warning.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { PREFIX, latestSquash } = require('./check-upstream');
const { DEFAULT_UPSTREAM_URL, TAG_RE, compareVersions, remoteTags, upstreamUrl } = require('./upstream-remote');
const { currentTag, tagsAfter } = require('./upstream-status');
const { IMPACT_FILE, upstreamImpact } = require('./upstream-impact');

const ROOT = path.join(__dirname, '..');
const USAGE = 'usage: npm run upstream:update -- next|vX.Y.Z|latest [--allow-skip]';

function run(command, args) {
  console.log(`> ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
}

function parseCli(argv) {
  const out = { requested: '', allowSkip: false };
  for (const arg of argv) {
    if (arg === '--allow-skip') out.allowSkip = true;
    else if (!arg.startsWith('-') && !out.requested) out.requested = arg;
    else throw new Error(`unexpected argument ${arg}; ${USAGE}`);
  }
  if (!out.requested) throw new Error(USAGE);
  return out;
}

// The release tag to pull. `current` is the tag upstream/ holds; `next` with
// nothing newer resolves to it.
function resolveTag(requested, tags, current, { allowSkip = false } = {}) {
  const text = String(requested || '').trim();
  let tag;
  if (text === 'next') {
    if (!current || !TAG_RE.test(current)) throw new Error('cannot tell which release upstream/ holds; name the tag instead of next');
    tag = tagsAfter(current, tags)[0]?.tag || current;
  } else if (text === 'latest') {
    if (!tags.length) throw new Error('upstream has no release tags');
    tag = tags.at(-1).tag;
  } else {
    if (!TAG_RE.test(text)) throw new Error(USAGE);
    if (!tags.some((t) => t.tag === text)) throw new Error(`upstream has no tag ${text}`);
    tag = text;
  }
  if (current && TAG_RE.test(current)) {
    if (compareVersions(tag, current) < 0) throw new Error(`${tag} is older than ${current}, the release upstream/ holds`);
    const skipped = tagsAfter(current, tags).filter((t) => compareVersions(t.tag, tag) < 0).map((t) => t.tag);
    if (skipped.length && !allowSkip) {
      throw new Error(`${tag} skips ${skipped.join(', ')}. Pull one release at a time (npm run upstream:update -- next), or add --allow-skip.`);
    }
  }
  return tag;
}

function main(argv) {
  const cli = parseCli(argv);
  const url = upstreamUrl();
  const tags = remoteTags(url);
  const current = currentTag(ROOT, tags);
  const tag = resolveTag(cli.requested, tags, current, cli);
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (status) throw new Error('the working tree has uncommitted changes; commit or set them aside first');

  const before = latestSquash(ROOT);
  const target = tags.find((t) => t.tag === tag);
  // The same release: by its tag, or by the commit when upstream/ holds one
  // that is no tag's (`current` then comes from package.json's version).
  if (tag === current || (before?.split && target && target.commit.startsWith(before.split))) {
    console.log(`upstream/ is already ${tag}.`);
    if (cli.requested === 'next') {
      console.log(`No newer release at ${url}.${url === DEFAULT_UPSTREAM_URL ? '' : ' npm run upstream:status shows whether GitHub has one the mirror lacks.'}`);
    }
    return 0;
  }
  run('git', ['subtree', 'pull', `--prefix=${PREFIX}`, url, tag, '--squash', '-m', `chore(upstream): update upstream to ${tag}`]);

  console.log('> npm run verify');
  // npm is a .cmd shim on Windows, which only a shell starts.
  const verify = process.platform === 'win32'
    ? spawnSync('npm run verify', { cwd: ROOT, stdio: 'inherit', shell: true })
    : spawnSync('npm', ['run', 'verify'], { cwd: ROOT, stdio: 'inherit' });
  const passed = verify.status === 0;

  console.log(`\nupstream/ is now ${tag}. verify ${passed ? 'passed' : 'FAILED'}.`);
  try {
    const impact = upstreamImpact({ cwd: ROOT, verify: passed ? 'passed' : 'failed' });
    fs.mkdirSync(path.dirname(path.join(ROOT, IMPACT_FILE)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, IMPACT_FILE), impact.markdown);
    console.log(`What the update touches: ${IMPACT_FILE} (${impact.items} item(s) to check).`);
  } catch (err) {
    console.warn(`The pull is committed, but the impact report failed: ${err.message}`);
    console.warn(`Fix that, then: npm run upstream:impact -- --out ${IMPACT_FILE}`);
  }
  console.log('Next: docs/upstream-upgrade.zh-TW.md — or run the /upstream-update skill in Claude Code.');
  return passed ? 0 : 3;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { parseCli, resolveTag };
