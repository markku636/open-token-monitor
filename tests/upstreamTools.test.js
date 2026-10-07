'use strict';

// The upstream update tools (docs/upstream-upgrade.zh-TW.md): finding the
// release tags, one release at a time, and the checklist of what an update
// touches.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ROOT, upstream } = require('../upstream');
const { DEFAULT_UPSTREAM_URL, compareVersions, githubTags, parseLsRemoteTags, upstreamUrl } = require('../scripts/upstream-remote');
const { parseCli, resolveTag } = require('../scripts/update-upstream');
const { describe, tagsAfter, upstreamStatus } = require('../scripts/upstream-status');
const { citationNeedle, globToRegExp, parseCli: parseImpactCli, refMatches, regexRoute, squashSubjects, upstreamImpact } = require('../scripts/upstream-impact');
const { parseCli: parseSmokeCli } = require('../scripts/smoke-hub');

const SHA = (n) => String(n).repeat(40).slice(0, 40);
const MIRROR = 'https://mirror.example/tm.git';

test('release tags come from ls-remote, peeled, in version order', () => {
  const text = [
    `${SHA(1)}\trefs/tags/v0.10.0`,
    `${SHA(2)}\trefs/tags/v0.9.1`,
    `${SHA(3)}\trefs/tags/v0.9.1^{}`,
    `${SHA(4)}\trefs/tags/nightly`,
    `${SHA(5)}\trefs/tags/v1.0.0-rc.1`
  ].join('\n');
  assert.deepEqual(parseLsRemoteTags(text), [{ tag: 'v0.9.1', commit: SHA(3) }, { tag: 'v0.10.0', commit: SHA(1) }]);
  assert.ok(compareVersions('v0.10.0', 'v0.9.9') > 0);
  assert.equal(compareVersions('v1.2.3', 'v1.2.3'), 0);
  // Without knowing the release upstream/ holds, any existing tag goes.
  const tags = parseLsRemoteTags(text);
  assert.equal(resolveTag('latest', tags), 'v0.10.0');
  assert.equal(resolveTag('v0.9.1', tags), 'v0.9.1');
});

test('upstream is GitHub unless UPSTREAM_URL names a mirror', () => {
  assert.equal(DEFAULT_UPSTREAM_URL, 'https://github.com/Javis603/token-monitor.git');
  assert.equal(upstreamUrl({}), DEFAULT_UPSTREAM_URL);
  assert.equal(upstreamUrl({ UPSTREAM_URL: '  ' }), DEFAULT_UPSTREAM_URL);
  assert.equal(upstreamUrl({ UPSTREAM_URL: ` ${MIRROR} ` }), MIRROR);
  assert.deepEqual(githubTags((url) => [{ tag: 'v1.0.0', commit: SHA(1), url }]), [{ tag: 'v1.0.0', commit: SHA(1), url: DEFAULT_UPSTREAM_URL }]);
  assert.equal(githubTags(() => { throw new Error('offline'); }), null);
});

test('an update moves one release at a time unless told to skip', () => {
  const tags = ['v0.63.1', 'v0.64.0', 'v0.65.0', 'v0.66.0'].map((tag, i) => ({ tag, commit: SHA(i + 1) }));
  assert.deepEqual(tagsAfter('v0.64.0', tags).map((t) => t.tag), ['v0.65.0', 'v0.66.0']);
  assert.deepEqual(tagsAfter('main', tags), []);
  assert.equal(resolveTag('next', tags, 'v0.63.1'), 'v0.64.0');
  assert.equal(resolveTag('v0.64.0', tags, 'v0.63.1'), 'v0.64.0');
  assert.equal(resolveTag('next', tags, 'v0.66.0'), 'v0.66.0');
  assert.equal(resolveTag('latest', tags, 'v0.65.0'), 'v0.66.0');
  assert.throws(() => resolveTag('v0.66.0', tags, 'v0.63.1'), /skips v0\.64\.0, v0\.65\.0/);
  assert.throws(() => resolveTag('latest', tags, 'v0.63.1'), /skips/);
  assert.equal(resolveTag('latest', tags, 'v0.63.1', { allowSkip: true }), 'v0.66.0');
  assert.equal(resolveTag('v0.65.0', tags, 'v0.63.1', { allowSkip: true }), 'v0.65.0');
  assert.throws(() => resolveTag('v0.63.1', tags, 'v0.64.0'), /older than v0\.64\.0/);
  assert.throws(() => resolveTag('v9.9.9', tags, 'v0.63.1'), /no tag v9\.9\.9/);
  assert.throws(() => resolveTag('main', tags, 'v0.63.1'), /usage/);
  assert.throws(() => resolveTag('next', tags, null), /cannot tell/);
  assert.throws(() => resolveTag('latest', [], 'v0.63.1'), /no release tags/);
  assert.deepEqual(parseCli(['next']), { requested: 'next', allowSkip: false });
  assert.deepEqual(parseCli(['latest', '--allow-skip']), { requested: 'latest', allowSkip: true });
  assert.deepEqual(parseCli(['--allow-skip', 'v0.66.0']), { requested: 'v0.66.0', allowSkip: true });
  assert.throws(() => parseCli([]), /usage/);
  assert.throws(() => parseCli(['next', '--force']), /unexpected argument --force/);
  assert.throws(() => parseCli(['next', 'latest']), /unexpected argument latest/);
});

test('the impact and smoke hub commands name the argument they do not take', () => {
  assert.deepEqual(parseImpactCli(['--from', 'a', '--to=b', '--out', 'tmp/x.md']), { from: 'a', to: 'b', out: 'tmp/x.md' });
  assert.throws(() => parseImpactCli(['--bogus', 'x']), /unexpected argument --bogus/);
  assert.throws(() => parseImpactCli(['--out']), /--out needs a value/);
  assert.deepEqual(parseSmokeCli([]), { port: 17399, host: '0.0.0.0', seed: true, publicDashboard: true });
  assert.deepEqual(parseSmokeCli(['--port', '18000', '--host', '127.0.0.1', '--no-seed', '--private']), { port: 18000, host: '127.0.0.1', seed: false, publicDashboard: false });
  assert.throws(() => parseSmokeCli(['--port', 'x']), /unexpected argument --port/);
});

test('globs, references, citations and routes match the way upstream writes them', () => {
  assert.ok(globToRegExp('src/shared/limits/**').test('src/shared/limits/providers/claude.js'));
  assert.ok(globToRegExp('src/hub/*.js').test('src/hub/server.js'));
  assert.ok(!globToRegExp('src/hub/*.js').test('src/hub/x/server.js'));
  assert.ok(refMatches('src/shared/http', 'src/shared/http.js'));
  assert.ok(refMatches('src/shared', 'src/shared/usage.js'));
  assert.ok(!refMatches('src/shared/http', 'src/shared/httpClient.js'));
  const counts = new Map([['index.js', 2], ['usage.js', 1]]);
  assert.equal(citationNeedle('src/shared/usage.js', counts), 'usage.js');
  assert.equal(citationNeedle('src/shared/a/index.js', counts), 'a/index.js');
  assert.equal(regexRoute('\\/api\\/sync\\/titles\\/([^/]+)'), '/api/sync/titles/([^/]+)');
  assert.equal(regexRoute('\\/api\\/devices\\/(.+)/);'), '/api/devices/(.+)');
  assert.equal(regexRoute('\\/api\\/x\\/(\\d+)/i.test(p)'), '/api/x/(\\d+)');
  assert.deepEqual(squashSubjects("Squashed 'upstream/' changes from a..b\n\nabc1234 feat: one\ndef5678 fix(x): two\n\ngit-subtree-dir: upstream\ngit-subtree-split: abc1234"), [
    { commit: 'abc1234', subject: 'feat: one' },
    { commit: 'def5678', subject: 'fix(x): two' }
  ]);
});

test('every touchpoint names upstream paths and files of this repository that exist', () => {
  const { touchpoints } = JSON.parse(fs.readFileSync(path.join(ROOT, 'upstream-touchpoints.json'), 'utf8'));
  assert.ok(touchpoints.length > 0);
  for (const point of touchpoints) {
    assert.ok(point.why && point.verify, JSON.stringify(point));
    for (const glob of point.upstream) {
      const fixed = glob.split('*')[0].replace(/\/$/, '');
      assert.ok(fs.existsSync(upstream(fixed)), `upstream/${fixed} (${glob})`);
    }
    for (const check of point.check) {
      const file = check.replace(/ \(.*\)$/, '');
      assert.ok(fs.existsSync(path.join(ROOT, file)), file);
    }
    // A watched string that upstream no longer has is a typo or a stale seam.
    for (const text of point.watch || []) {
      const files = point.upstream.filter((glob) => !glob.includes('*'));
      assert.ok(files.some((file) => fs.readFileSync(upstream(file), 'utf8').includes(text)), `watch "${text}" is in none of ${files.join(', ')}`);
    }
  }
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'core.autocrlf', 'false');
}

function writeFiles(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
}

test('the impact of an update lists the seams, overlay and tauri/ files, routes and settings it touches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-impact-'));
  const up = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-impact-up-'));
  try {
    // Upstream: two releases.
    initRepo(up);
    writeFiles(up, {
      'package.json': JSON.stringify({ name: 'token-monitor', version: '1.0.0' }),
      'src/hub/server.js': "if (url.pathname === '/api/stats') send();\nif (url.pathname === '/api/old') send();\n",
      'src/shared/usage.js': 'one\n',
      'src/shared/a/index.js': 'one\n',
      'src/shared/b/index.js': 'one\n',
      'src/shared/untouched.js': 'one\n',
      'src/shared/config.js': 'const secret = process.env.TOKEN_MONITOR_SECRET;\n',
      'src/electron/renderer/i18n.js': "'settings.appUpdate.source': 'GitHub releases',\n",
      'scripts/vendor/tokscale.json': '{"version":"1"}\n'
    });
    git(up, 'add', '.');
    git(up, 'commit', '-q', '-m', 'v1');
    writeFiles(up, {
      'package.json': JSON.stringify({ name: 'token-monitor', version: '1.1.0' }),
      'src/hub/server.js': [
        "if (url.pathname === '/api/stats') send();",
        "if (url.pathname === '/api/sync/content') send();",
        'const titles = url.pathname.match(/^\\/api\\/sync\\/titles\\/([^/]+)$/);',
        ''
      ].join('\n'),
      'src/shared/usage.js': 'two\n',
      'src/shared/a/index.js': 'two\n',
      'src/shared/config.js': 'const secret = process.env.TOKEN_MONITOR_SECRET;\nconst titles = process.env.TOKEN_MONITOR_SYNC_SESSION_TITLES;\n',
      'src/electron/renderer/i18n.js': "'settings.appUpdate.source': 'GitHub releases',\n'settings.appUpdate.source': 'Versões no GitHub',\n",
      'docs/API.md': 'new\n',
      'scripts/vendor/tokscale.json': '{"version":"2"}\n'
    });
    git(up, 'add', '.');
    git(up, 'commit', '-q', '-m', 'v2');

    // This repository: the overlay, then the two pulls as squash + merge.
    initRepo(root);
    writeFiles(root, {
      'upstream-touchpoints.json': JSON.stringify({ touchpoints: [
        { upstream: ['src/hub/server.js'], check: ['hub/server.js'], why: 'bootstrap copy', verify: 'node --test x' },
        { upstream: ['src/electron/renderer/i18n.js'], check: ['packaging/p.js'], why: 'patched text', watch: ['settings.appUpdate.source'], verify: 'node --test p' },
        { upstream: ['src/shared/untouched.js'], check: ['hub/other.js'], why: 'never hit', verify: 'n/a' }
      ] }),
      // Built from parts, so the impact scan of this repository does not
      // take this test for a file that loads upstream code.
      'hub/x.js': `require(${'upstream'}('src/shared/usage'));\n`,
      'hub/y.js': `require(${'upstream'}('src/shared/untouched'));\n`,
      'tauri/src-tauri/src/usage.rs': '// Port of usage.js collectUsageRows\n',
      'tauri/src/foo.ts': '// renderer a/index.js\n',
      'tauri/src/bar.ts': '// unrelated\n',
      'tauri/scripts/vendor/tokscale.json': '{"version":"1"}\n'
    });
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'overlay');
    git(root, 'fetch', '-q', up, 'main');
    const [c2, c1] = [git(root, 'rev-parse', 'FETCH_HEAD'), git(root, 'rev-parse', 'FETCH_HEAD~1')];
    const squash1 = git(root, 'commit-tree', `${c1}^{tree}`, '-m', `Squashed 'upstream/' content from commit ${c1.slice(0, 7)}\n\ngit-subtree-dir: upstream\ngit-subtree-split: ${c1}`);
    git(root, 'read-tree', '--prefix=upstream/', '-u', squash1);
    git(root, 'reset', '-q', '--hard', git(root, 'commit-tree', git(root, 'write-tree'), '-p', 'HEAD', '-p', squash1, '-m', 'add upstream'));
    const squash2 = git(root, 'commit-tree', `${c2}^{tree}`, '-p', squash1, '-m', `Squashed 'upstream/' changes from ${c1.slice(0, 7)}..${c2.slice(0, 7)}\n\n${c2.slice(0, 7)} feat: release two\n\ngit-subtree-dir: upstream\ngit-subtree-split: ${c2}`);
    git(root, 'rm', '-r', '-q', 'upstream');
    git(root, 'read-tree', '--prefix=upstream/', '-u', squash2);
    git(root, 'reset', '-q', '--hard', git(root, 'commit-tree', git(root, 'write-tree'), '-p', 'HEAD', '-p', squash2, '-m', 'update upstream'));

    const { markdown, changed, items } = upstreamImpact({ cwd: root, verify: 'failed' });
    assert.equal(changed.length, 8);
    assert.match(markdown, /^# Upstream update: v1\.0\.0 → v1\.1\.0$/m);
    assert.match(markdown, /`npm run verify` after the pull: \*\*failed\*\*/);
    // Seams, with the watched string's count.
    assert.match(markdown, /- \[ \] \*\*hub\/server\.js\*\* — bootstrap copy\n {2}- upstream: `src\/hub\/server\.js`/);
    assert.match(markdown, /`settings\.appUpdate\.source` now appears 2 time\(s\), was 1/);
    assert.doesNotMatch(markdown, /never hit|hub\/y\.js/);
    assert.match(markdown, /\*\*tauri\/scripts\/vendor\/tokscale\.json\*\* — upstream changed its tokscale pin/);
    // Overlay and tauri/ files.
    assert.match(markdown, /- \[ \] `hub\/x\.js` loads `src\/shared\/usage\.js`/);
    assert.match(markdown, /- \[ \] `tauri\/src-tauri\/src\/usage\.rs` ports `src\/shared\/usage\.js`/);
    assert.match(markdown, /- \[ \] `tauri\/src\/foo\.ts` ports `src\/shared\/a\/index\.js`/);
    assert.doesNotMatch(markdown, /bar\.ts/);
    // Routes and settings.
    assert.match(markdown, /- \[ \] added `\/api\/sync\/content`/);
    assert.match(markdown, /- \[ \] added `\/api\/sync\/titles\/\(\[\^\/\]\+\)`/);
    assert.match(markdown, /- \[ \] removed `\/api\/old`/);
    assert.doesNotMatch(markdown, /`\/api\/stats`/);
    assert.match(markdown, /- \[ \] added `TOKEN_MONITOR_SYNC_SESSION_TITLES`/);
    assert.doesNotMatch(markdown, /`TOKEN_MONITOR_SECRET`/);
    // 2 seams + the tokscale pin, 1 overlay file, 2 tauri/ files, 3 routes, 1 setting.
    assert.equal(items, 10);
    assert.match(markdown, new RegExp(`- ${c2.slice(0, 7)} feat: release two`));
    assert.match(markdown, /- `docs\/API\.md`/);

    // The first pull has nothing before it.
    assert.match(upstreamImpact({ cwd: root, to: squash1 }).markdown, /no earlier subtree pull/);

    // Status: the release upstream/ holds is the tag on the squash's split
    // commit.
    const released = [{ tag: 'v1.0.0', commit: c1 }, { tag: 'v1.1.0', commit: c2 }];
    const newer = [...released, { tag: 'v1.2.0', commit: SHA(9) }];
    // From GitHub, GitHub is not asked twice and no mirror is mentioned.
    const fromGithub = upstreamStatus({ cwd: root, url: DEFAULT_UPSTREAM_URL, tags: released });
    assert.equal(fromGithub.current.tag, 'v1.1.0');
    assert.equal(fromGithub.latest.tag, 'v1.1.0');
    assert.equal(fromGithub.behind, false);
    assert.equal(fromGithub.github, null);
    assert.match(describe(fromGithub), /^Up to date\.$/m);
    assert.doesNotMatch(describe(fromGithub), /mirror|GitHub:/);
    const behind = upstreamStatus({ cwd: root, url: DEFAULT_UPSTREAM_URL, tags: newer });
    assert.deepEqual(behind.pending, ['v1.2.0']);
    assert.equal(behind.behind, true);
    assert.match(describe(behind), /Behind by 1 release\(s\): v1\.2\.0\./);
    assert.match(describe(behind), /npm run upstream:update -- next {3}\(v1\.2\.0\)/);
    assert.doesNotMatch(describe(behind), /mirror/);

    // From a mirror (UPSTREAM_URL): GitHub's newer tag is one the mirror lacks.
    const lacking = upstreamStatus({ cwd: root, url: MIRROR, tags: released, github: newer });
    assert.equal(lacking.behind, false);
    assert.deepEqual(lacking.github, { latest: 'v1.2.0', missing: ['v1.2.0'] });
    assert.match(describe(lacking), /the mirror lacks v1\.2\.0/);
    assert.match(describe(lacking), /Up to date with the mirror/);
    const synced = upstreamStatus({ cwd: root, url: MIRROR, tags: released, github: released });
    assert.deepEqual(synced.github, { latest: 'v1.1.0', missing: [] });
    assert.match(describe(synced), /the mirror has every newer release/);
    assert.match(describe(synced), /^Up to date\.$/m);
    // GitHub asked but silent: never a plain "Up to date.".
    const silent = upstreamStatus({ cwd: root, url: MIRROR, tags: released, github: null });
    assert.deepEqual(silent.github, { unreachable: true });
    assert.match(describe(silent), /GitHub: {4}could not be reached/);
    assert.match(describe(silent), /Up to date with the mirror\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(up, { recursive: true, force: true });
  }
});
