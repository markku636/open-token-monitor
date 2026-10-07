'use strict';

// scripts/build-hub-image.js: the version it picks, the CHANGELOG it rewrites
// and the release document it writes. Building and tagging need Docker and a
// remote, and are run by hand (docs/packaging.zh-TW.md).

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  EMPTY_NOTE, IMAGE_PATHS, TRIAL_NOTE, ciVersion, nextVersion, parseCli, rebaseLinks, releaseChangelog, renderDistRelease,
  renderReleaseDoc, settingNames, sourceUrl, tarName
} = require('../scripts/build-hub-image');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'build-hub-image.js');

const CHANGELOG = `# 功能異動紀錄

說明。

## 未發行

還沒有發行過正式的公司版。

### Hub

- 用量存進 PostgreSQL（[postgres.zh-TW.md](docs/postgres.zh-TW.md)）。
- 報表 API。
`;

function info(overrides = {}) {
  return {
    version: '0.63.1-corp.2',
    date: '2026-10-01',
    commit: 'abcdef012345',
    upstream: { version: '0.63.1', split: 'e38f60a0123456789' },
    previousTag: 'corp/v0.63.1-corp.1',
    notes: '### Hub\n\n- 報表新增週報（[reports-api.zh-TW.md](docs/reports-api.zh-TW.md)）。',
    commits: ['1234567 feat(hub): weekly reports', '89abcde fix(org): BU names'],
    migrations: { all: ['0001_init.sql', '0002_email_assignments.sql'], added: [] },
    settings: { added: [], removed: [] },
    image: 'token-monitor-hub',
    ...overrides
  };
}

test('the command line: flags, values and mistakes', () => {
  const cli = parseCli([]);
  assert.deepEqual([...cli.flags], []);
  assert.equal(cli.image, 'token-monitor-hub');
  assert.equal(cli.remote, 'origin');
  assert.equal(cli.version, '');
  const trial = parseCli(['--no-tag', '--skip-smoke', '--version', '0.63.1-corp.4', '--remote', 'mirror']);
  assert.deepEqual([...trial.flags].sort(), ['no-tag', 'skip-smoke']);
  assert.equal(trial.version, '0.63.1-corp.4');
  assert.equal(trial.remote, 'mirror');
  assert.deepEqual([...parseCli(['--build', '--no-push']).flags].sort(), ['build', 'no-push']);
  assert.deepEqual([...parseCli(['--ci', '--skip-smoke']).flags].sort(), ['ci', 'skip-smoke']);
  // --ci builds the tag checked out: no trial, no second build, no dry run.
  for (const flag of ['--no-tag', '--build', '--dry-run']) {
    assert.throws(() => parseCli(['--ci', flag]), new RegExp(`--ci builds the release of the tag checked out, and takes no ${flag}`));
  }
  assert.throws(() => parseCli(['--tag']), /unknown argument --tag/);
  assert.throws(() => parseCli(['release']), /unknown argument release/);
  assert.throws(() => parseCli(['--version']), /--version needs a value/);
  assert.throws(() => parseCli(['--version', '--dry-run']), /--version needs a value/);
  assert.throws(() => parseCli(['--version', '0.63.1']), /expected <upstream version>-corp\.<N>/);
  assert.throws(() => parseCli(['--image', 'Token Monitor']), /not an image name/);
});

test('--ci builds the corp/v tag the pipeline runs for', () => {
  const cli = parseCli(['--ci']);
  assert.equal(ciVersion(cli, { CI_COMMIT_TAG: 'corp/v0.63.1-corp.2' }), '0.63.1-corp.2');
  assert.equal(ciVersion(parseCli(['--ci', '--version', '0.63.1-corp.3']), {}), '0.63.1-corp.3');
  assert.throws(() => ciVersion(cli, {}), /CI_COMMIT_TAG is not set/);
  assert.throws(() => ciVersion(cli, { CI_COMMIT_TAG: 'client-v0.63.1-corp.2' }), /builds a corp\/v<version> tag, and CI_COMMIT_TAG is "client-v0\.63\.1-corp\.2"/);
  assert.throws(() => ciVersion(cli, { CI_COMMIT_TAG: 'corp/v0.63.1' }), /CI_COMMIT_TAG is "corp\/v0\.63\.1"/);
});

test('the image\'s source label carries no credentials', () => {
  assert.equal(sourceUrl('https://gitlab-ci-token:secret@git.example/tm/hub.git', ''), 'https://git.example/tm/hub.git');
  assert.equal(sourceUrl('https://gitlab-ci-token:secret@git.example/tm/hub.git', 'https://git.example/tm/hub'), 'https://git.example/tm/hub');
  assert.equal(sourceUrl('git@git.example:tm/hub.git', undefined), 'git@git.example:tm/hub.git');
  assert.equal(sourceUrl(null, undefined), '');
});

test('a mistake on the command line fails before anything runs', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--bogus'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /build-hub-image: unknown argument --bogus/);
});

test('the version is one past the highest corp tag of the same upstream release', () => {
  assert.equal(nextVersion('0.63.1', []), '0.63.1-corp.1');
  assert.equal(nextVersion('0.63.1', ['corp/v0.63.1-corp.1', 'corp/v0.63.1-corp.3', 'corp/v0.63.1-corp.2']), '0.63.1-corp.4');
  // Another upstream release starts again at 1; anything else is not a release.
  assert.equal(nextVersion('0.64.0', ['corp/v0.63.1-corp.7']), '0.64.0-corp.1');
  assert.equal(nextVersion('0.63.1', ['v0.63.1', 'corp/v0.63.1-corp.x', 'corp/v0.63.10-corp.9', 'other/v0.63.1-corp.5']), '0.63.1-corp.1');
  // Numeric, not by the text.
  assert.equal(nextVersion('0.63.1', ['corp/v0.63.1-corp.9', 'corp/v0.63.1-corp.10']), '0.63.1-corp.11');
});

test('the release takes over 未發行, and a new empty 未發行 goes above it', () => {
  const { text, notes } = releaseChangelog(CHANGELOG, { version: '0.63.1-corp.1', date: '2026-10-01' });
  assert.equal(text, `# 功能異動紀錄

說明。

## 未發行

${EMPTY_NOTE}

## corp/v0.63.1-corp.1（2026-10-01）

### Hub

- 用量存進 PostgreSQL（[postgres.zh-TW.md](docs/postgres.zh-TW.md)）。
- 報表 API。
`);
  assert.equal(notes, '### Hub\n\n- 用量存進 PostgreSQL（[postgres.zh-TW.md](docs/postgres.zh-TW.md)）。\n- 報表 API。');
  // Nothing new since: no release.
  assert.throws(() => releaseChangelog(text, { version: '0.63.1-corp.2', date: '2026-10-02' }), /nothing under 未發行/);

  const next = text.replace(EMPTY_NOTE, '- 週報。');
  const second = releaseChangelog(next, { version: '0.63.1-corp.2', date: '2026-10-08' });
  assert.equal(second.notes, '- 週報。');
  assert.match(second.text, /## 未發行\n\n（還沒有新的異動。）\n\n## corp\/v0\.63\.1-corp\.2（2026-10-08）\n\n- 週報。\n\n## corp\/v0\.63\.1-corp\.1（2026-10-01）\n\n### Hub\n/);
  assert.ok(second.text.endsWith('- 報表 API。\n'), 'the older releases are kept as they were');

  assert.throws(() => releaseChangelog('# 功能異動紀錄\n', { version: '0.63.1-corp.1', date: '2026-10-01' }), /no "## 未發行" section/);
});

test('the repository\'s CHANGELOG has an 未發行 section the script can release', () => {
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes('\n## 未發行\n'), 'CHANGELOG.md has an 未發行 section');
  assert.ok(changelog.slice(0, changelog.indexOf('\n## ')).includes('npm run build:image'), 'the preamble says the script writes the release sections');
});

test('links relative to the repository root still work from docs/releases', () => {
  assert.equal(rebaseLinks('[a](docs/postgres.zh-TW.md) [b](README.md) [c](docs/x.md#part)', 'docs/releases'),
    '[a](../postgres.zh-TW.md) [b](../../README.md) [c](../x.md#part)');
  assert.equal(rebaseLinks('[a](https://example.com/x) [b](#here) [c](/abs) [d](mailto:a@b.c)', 'docs/releases'),
    '[a](https://example.com/x) [b](#here) [c](/abs) [d](mailto:a@b.c)');
});

test('the settings a tree names', () => {
  assert.deepEqual([...settingNames('TOKEN_MONITOR_SECRET=x\n${POSTGRES_PASSWORD:?}\nNOT_TOKEN_MONITOR_X TOKEN_MONITOR_\nprocess.env.TOKEN_MONITOR_DATABASE_URL')].sort(),
    ['POSTGRES_PASSWORD', 'TOKEN_MONITOR_DATABASE_URL', 'TOKEN_MONITOR_SECRET']);
});

test('the release document: what it is, what goes with it, how to deploy and roll back', () => {
  const doc = renderReleaseDoc(info());
  assert.match(doc, /^# Token Monitor hub 公司版 0\.63\.1-corp\.2\n/);
  assert.match(doc, /\| 版本 \| `corp\/v0\.63\.1-corp\.2`，2026-10-01 \|/);
  assert.match(doc, /\| 原始碼 \| tag `corp\/v0\.63\.1-corp\.2`：commit `abcdef012345`，加上這份文件 \|/);
  assert.match(doc, /\| 上游 \| token-monitor v0\.63\.1（上游 commit `e38f60a01234`）/);
  assert.match(doc, /\| 相容的用戶端 \| 上游官方用戶端 \*\*v0\.63\.1\*\* \|/);
  assert.match(doc, /\| 上一版 \| `corp\/v0\.63\.1-corp\.1` \|/);
  assert.match(doc, /\| 資料庫 \| 沒有新的 migration \|/);
  assert.match(doc, /\(\.\.\/reports-api\.zh-TW\.md\)/, 'the notes\' links are rebased');
  assert.match(doc, /- `1234567` feat\(hub\): weekly reports\n- `89abcde` fix\(org\): BU names/);
  assert.match(doc, /- `0001_init\.sql`\n- `0002_email_assignments\.sql`/);
  assert.match(doc, /沒有新增或移除的設定。/);
  assert.match(doc, /docker load -i token-monitor-hub-0\.63\.1-corp\.2\.tar/);
  // Deployed from the tag's pipeline, by hand from the package registry.
  assert.match(doc, /## 從 GitLab 部署\n\n`corp\/v0\.63\.1-corp\.2` 推上 GitLab 之後[^\n]*`token-monitor-hub\/0\.63\.1-corp\.2`[^\n]*按 `deploy:hub`/);
  assert.match(doc, /`git fetch origin --tags`，再 `git checkout corp\/v0\.63\.1-corp\.2`/);
  // No new migration: going back is swapping the image.
  assert.match(doc, /換回上一版的映像即可：\n\n```bash\ndocker tag token-monitor-hub:0\.63\.1-corp\.1 token-monitor-hub:latest\n/);
  assert.doesNotMatch(doc, /DROP SCHEMA/);
  // The two risks the company edition takes on by using upstream's clients.
  assert.match(doc, /\*\*用戶端比伺服器新\*\*/);
  assert.match(doc, /\*\*外部更新被汙染\*\*/);
});

test('a release with new migrations says to back up, and rolls back through the backup', () => {
  const doc = renderReleaseDoc(info({
    migrations: { all: ['0001_init.sql', '0002_email_assignments.sql', '0003_api_tokens.sql'], added: ['0003_api_tokens.sql'] },
    settings: { added: ['TOKEN_MONITOR_NEW'], removed: ['TOKEN_MONITOR_REPORT_KEY'] }
  }));
  assert.match(doc, /\| 資料庫 \| \*\*1 個新的 migration\*\*，部署前一定要備份 \|/);
  assert.match(doc, /- `0003_api_tokens\.sql`（這一版新增）/);
  assert.match(doc, /新增：\n\n- `TOKEN_MONITOR_NEW`/);
  assert.match(doc, /移除（`\.env` 裡還有的話可以刪掉）：\n\n- `TOKEN_MONITOR_REPORT_KEY`/);
  assert.match(doc, /\*\*備份資料庫\*\*（這一版有新的 migration，一定要做）/);
  // Written inside the container and copied out: a shell redirect would
  // re-encode the binary dump in Windows PowerShell.
  assert.match(doc, /pg_dump -U postgres -d token_monitor -n token_monitor -Fc -f \/tmp\/backup\.dump\n {3}docker cp token-monitor-postgres:\/tmp\/backup\.dump token-monitor-2026-10-01\.dump/);
  assert.doesNotMatch(doc, /pg_dump[^\n]*>/);
  assert.match(doc, /DROP SCHEMA IF EXISTS token_monitor CASCADE"\ndocker exec token-monitor-postgres pg_restore -U postgres -d token_monitor \/tmp\/restore\.dump\ndocker tag token-monitor-hub:0\.63\.1-corp\.1 token-monitor-hub:latest/);
});

test('the first release has no previous one to compare with or go back to', () => {
  const doc = renderReleaseDoc(info({
    version: '0.63.1-corp.1',
    previousTag: null,
    commits: [],
    settings: null,
    migrations: { all: ['0001_init.sql'], added: ['0001_init.sql'] }
  }));
  assert.match(doc, /\| 上一版 \| 沒有，這是第一版 \|/);
  assert.match(doc, /\| 資料庫 \| 1 個 migration，第一次部署時建立整個資料庫 \|/);
  assert.match(doc, /## 自上一版以來的 commit\n\n這是第一版，見 `git log`。/);
  assert.match(doc, /- `0001_init\.sql`\n/, 'nothing to mark as new when everything is');
  assert.match(doc, /## 設定的變化\n\n這是第一版。設定見 docs\/hub\.zh-TW\.md 的「設定」與 `\.env\.example`。/);
  // Nothing to back up yet, and nothing to go back to.
  assert.match(doc, /## 部署\n\n1\. \*\*第一次部署\*\*：資料庫還不存在，不用備份。/);
  assert.doesNotMatch(doc, /pg_dump/);
  assert.match(doc, /## 回滾\n\n這是第一版，沒有上一版可以換回。/);
  assert.match(doc, /- \[ \] \*\*資料庫\*\*：`\.env` 設好了 `POSTGRES_PASSWORD` 與 `TOKEN_MONITOR_DB_PASSWORD`/);
});

test('every relative link of a release document resolves from docs/releases', () => {
  // Every section of CHANGELOG.md, the released ones too: a release commit
  // leaves 未發行 empty, and the tag's pipeline runs this test on that commit.
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const notes = changelog.slice(changelog.search(/^## /m));
  const doc = renderReleaseDoc(info({ notes }));
  const dir = path.join(ROOT, 'docs', 'releases');
  const links = [...doc.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((target) => !/^(?:[a-z]+:|#)/i.test(target));
  assert.ok(links.length > 2);
  for (const target of links) {
    assert.ok(fs.existsSync(path.join(dir, target.split('#')[0])), `${target} resolves from docs/releases`);
  }
});

test('the copy in dist/ adds what the build produced, and says so when it was a trial', () => {
  const produced = [['映像 ID', '`sha256:1`'], ['commit', '`abc`']];
  const release = renderDistRelease('# doc\n', { trial: false, produced });
  assert.equal(release, '# doc\n\n## 這次打包的產出\n\n| 項目 | 內容 |\n|---|---|\n| 映像 ID | `sha256:1` |\n| commit | `abc` |\n');
  assert.ok(renderDistRelease('# doc\n', { trial: true, produced }).startsWith(`${TRIAL_NOTE}\n\n# doc\n`));
});

test('the image tar is named after the image and the version', () => {
  assert.equal(tarName('token-monitor-hub', '0.63.1-corp.1'), 'token-monitor-hub-0.63.1-corp.1.tar');
  assert.equal(tarName('registry.local:5000/tm/hub', '0.63.1-corp.1'), 'registry.local-5000-tm-hub-0.63.1-corp.1.tar');
});

test('the exported tree holds everything the Dockerfile copies', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'docker', 'Dockerfile'), 'utf8');
  const sources = [...dockerfile.matchAll(/^COPY (?!--from)(.+) \S+$/gm)].flatMap((m) => m[1].split(/\s+/));
  assert.ok(sources.length >= 6);
  for (const source of sources) {
    assert.ok(IMAGE_PATHS.some((p) => source === p || source.startsWith(`${p}/`)), `${source} is exported`);
    assert.ok(fs.existsSync(path.join(ROOT, source)), `${source} exists`);
  }
  assert.ok(IMAGE_PATHS.includes('docker'), 'the Dockerfile itself, its ignore file and the initdb script of the smoke test');
});

test('npm run build:image runs the script', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['build:image'], 'node scripts/build-hub-image.js');
});
