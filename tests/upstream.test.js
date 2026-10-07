'use strict';

// upstream/: where the overlay finds upstream token-monitor, and the check that
// keeps upstream/ exactly the upstream release it was pulled from.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ROOT, UPSTREAM_ROOT, upstream } = require('../upstream');
const { checkUpstream, latestSquash } = require('../scripts/check-upstream');

test('upstream code resolves inside upstream/ of this repository', () => {
  assert.equal(UPSTREAM_ROOT, path.join(ROOT, 'upstream'));
  assert.equal(upstream('src/hub/server.js'), path.join(ROOT, 'upstream', 'src', 'hub', 'server.js'));
  assert.ok(fs.existsSync(upstream('src/hub/server.js')), 'upstream/ holds the upstream tree');
  assert.equal(JSON.parse(fs.readFileSync(upstream('package.json'), 'utf8')).name, 'token-monitor');
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A repository shaped like this one: an overlay commit, then a squashed
// subtree commit of the upstream tree merged in under upstream/.
function subtreeRepo(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-subtree-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'test');
    git(root, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(root, 'README.md'), 'overlay\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'overlay');
    // The squash commit is an orphan holding the upstream tree at its root.
    const upstreamRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upstream-'));
    try {
      git(upstreamRoot, 'init', '-q', '-b', 'main');
      git(upstreamRoot, 'config', 'user.email', 'test@example.com');
      git(upstreamRoot, 'config', 'user.name', 'test');
      git(upstreamRoot, 'config', 'core.autocrlf', 'false');
      fs.writeFileSync(path.join(upstreamRoot, 'package.json'), JSON.stringify({ name: 'token-monitor', version: '9.9.9' }));
      fs.mkdirSync(path.join(upstreamRoot, 'src'));
      fs.writeFileSync(path.join(upstreamRoot, 'src', 'hub.js'), 'module.exports = 1;\n');
      git(upstreamRoot, 'add', '.');
      git(upstreamRoot, 'commit', '-q', '-m', 'upstream');
      git(root, 'fetch', '-q', upstreamRoot, 'main');
    } finally {
      fs.rmSync(upstreamRoot, { recursive: true, force: true });
    }
    const tree = git(root, 'rev-parse', 'FETCH_HEAD^{tree}');
    const squash = git(root, 'commit-tree', tree, '-m', "Squashed 'upstream/' content from commit abc1234\n\ngit-subtree-dir: upstream\ngit-subtree-split: abc1234def5678abc1234def5678abc1234def56");
    git(root, 'read-tree', '--prefix=upstream/', '-u', squash);
    const merged = git(root, 'write-tree');
    const merge = git(root, 'commit-tree', merged, '-p', 'HEAD', '-p', squash, '-m', 'chore(upstream): add');
    git(root, 'reset', '-q', '--hard', merge);
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('check-upstream: an untouched subtree passes and names the upstream release', () => {
  subtreeRepo((root) => {
    const result = checkUpstream({ cwd: root });
    assert.equal(result.ok, true, result.problems.join('; '));
    assert.equal(result.version, '9.9.9');
    assert.equal(result.split, 'abc1234def5678abc1234def5678abc1234def56');
    assert.equal(latestSquash(root).commit, result.squash);
  });
});

test('check-upstream: a committed or uncommitted edit under upstream/ fails, one outside does not', () => {
  subtreeRepo((root) => {
    fs.writeFileSync(path.join(root, 'README.md'), 'overlay, edited\n');
    git(root, 'commit', '-q', '-am', 'overlay change');
    assert.equal(checkUpstream({ cwd: root }).ok, true, 'overlay commits are fine');

    fs.writeFileSync(path.join(root, 'upstream', 'src', 'hub.js'), 'module.exports = 2;\n');
    const dirty = checkUpstream({ cwd: root });
    assert.equal(dirty.ok, false);
    assert.match(dirty.problems.join('\n'), /uncommitted changes under upstream\/: upstream\/src\/hub\.js/);

    git(root, 'commit', '-q', '-am', 'edit upstream');
    const committed = checkUpstream({ cwd: root });
    assert.equal(committed.ok, false);
    assert.match(committed.problems.join('\n'), /committed changes under upstream\/ .*upstream\/src\/hub\.js/);
  });
});

test('check-upstream: no subtree commit at all fails; outside git it is skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-nogit-'));
  try {
    assert.equal(checkUpstream({ cwd: root }).skipped, 'not a git checkout');
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'a');
    const result = checkUpstream({ cwd: root });
    assert.equal(result.ok, false);
    assert.match(result.problems[0], /not added with git subtree --squash/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the hub image copies from upstream/ only what the hub runs', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'docker', 'Dockerfile'), 'utf8');
  const fromUpstream = [...dockerfile.matchAll(/^COPY (?!--from)(upstream\/\S+) /gm)].map((m) => m[1]);
  assert.deepEqual(fromUpstream.sort(), ['upstream/package.json', 'upstream/src/hub', 'upstream/src/shared']);
  assert.match(dockerfile, /^CMD \["node", "hub\/server\.js"\]$/m);
});
