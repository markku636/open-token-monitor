#!/usr/bin/env node
'use strict';

// Makes a release of the hub and writes the release's documents while it does
// (docs/packaging.zh-TW.md):
//
//   npm run build:image                  a release: documents and tag; GitLab's
//                                        build:hub builds the image from the tag
//   npm run build:image -- --build       a release with the image built here too
//   npm run build:image -- --no-tag      a trial: the image and dist/, but no
//                                        commit, no tag and `latest` untouched
//   npm run build:image -- --dry-run     prints what it would do, changes nothing
//   node scripts/build-hub-image.js --ci build:hub (.gitlab-ci.yml): the image of
//                                        the corp/v tag checked out
//
//   1. checks: a clean working tree, upstream/ as pulled (check:upstream) and
//      `npm run verify`
//   2. the version: <upstream version>-corp.<N>, N one past the highest corp/v
//      tag for that upstream version (--version names one)
//   3. the documents, committed as `docs(release): corp/v<version>`:
//      CHANGELOG.md's 未發行 becomes the release's section, and
//      docs/releases/<version>.md records what the release is — the upstream
//      release and the client version it goes with, the changes, the commits,
//      database migrations, settings added or dropped, how to deploy and roll
//      back, and the risks to check
//   4. the image, built from that commit only (git archive: committed files,
//      LF line ends), tagged <image>:<version> and <image>:latest and labelled
//      with the version, the commit and the upstream release
//   5. a smoke test: a throwaway PostgreSQL and the image on a network of their
//      own; the hub has to migrate the database and answer
//   6. dist/hub/<version>/: the image as a tar (docker save), RELEASE.md (the
//      document plus the image id and the tar's checksum) and SHA256SUMS
//   7. the annotated tag corp/v<version>, pushed to the origin remote
//
// A release does 1-3 and 7, and 4-6 with --build. A trial does 1, 2 and 4-6.
// --ci does 4-6 for the tag CI_COMMIT_TAG names, which has to be HEAD: the
// documents come from the tag, verify is the verify job's, the image is tagged
// <image>:<version> only (the deploy moves `latest`) and nothing is tagged.
//
// Other flags: --no-push, --skip-verify, --skip-smoke, --no-save,
// --version <X.Y.Z-corp.N>, --image <name>, --remote <name>.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkUpstream } = require('./check-upstream');

const ROOT = path.join(__dirname, '..');
const TAG_PREFIX = 'corp/v';
const VERSION_RE = /^(\d+\.\d+\.\d+)-corp\.(\d+)$/;
const UNRELEASED = '## 未發行';
// What an empty 未發行 says, and what it said before the first release.
const EMPTY_NOTE = '（還沒有新的異動。）';
const PLACEHOLDERS = new Set([EMPTY_NOTE, '還沒有發行過正式的公司版。']);
const RELEASES_DIR = 'docs/releases';
// Everything docker/Dockerfile copies, and the Dockerfile with its ignore file.
const IMAGE_PATHS = ['package.json', 'package-lock.json', 'upstream.js', 'hub', 'docker', 'upstream/package.json', 'upstream/src/shared', 'upstream/src/hub'];
const FLAGS = new Set(['dry-run', 'no-tag', 'build', 'ci', 'no-push', 'skip-verify', 'skip-smoke', 'no-save']);
const OPTIONS = { version: '', image: 'token-monitor-hub', remote: 'origin' };
const POSTGRES_IMAGE = 'postgres:18-alpine';
const TRIAL_NOTE = '> **試跑**（`--no-tag`）：沒有寫進 CHANGELOG、沒有打 tag，也沒有更新 `latest`。';

class BuildError extends Error {}

function parseCli(argv) {
  const cli = { ...OPTIONS, flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (FLAGS.has(name)) {
      cli.flags.add(name);
    } else if (Object.hasOwn(OPTIONS, name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new BuildError(`--${name} needs a value`);
      cli[name] = value;
      i += 1;
    } else {
      throw new BuildError(`unknown argument ${argv[i]}`);
    }
  }
  if (cli.version && !VERSION_RE.test(cli.version)) throw new BuildError(`--version ${cli.version}: expected <upstream version>-corp.<N>, such as 0.63.1-corp.2`);
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(cli.image)) throw new BuildError(`--image ${cli.image} is not an image name`);
  if (cli.flags.has('ci')) {
    const other = ['no-tag', 'build', 'dry-run'].find((flag) => cli.flags.has(flag));
    if (other) throw new BuildError(`--ci builds the release of the tag checked out, and takes no --${other}`);
  }
  return cli;
}

// The version --ci builds: --version, or else the corp/v tag the pipeline runs for.
function ciVersion(cli, env) {
  if (cli.version) return cli.version;
  const tag = String(env.CI_COMMIT_TAG || '');
  const version = tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : '';
  if (!VERSION_RE.test(version)) throw new BuildError(`--ci builds a ${TAG_PREFIX}<version> tag, and CI_COMMIT_TAG is ${tag ? `"${tag}"` : 'not set'}`);
  return version;
}

// The next corp version of an upstream release, from the corp/v tags there are.
function nextVersion(upstreamVersion, tags) {
  let n = 0;
  for (const tag of tags) {
    const match = String(tag).startsWith(TAG_PREFIX) && VERSION_RE.exec(String(tag).slice(TAG_PREFIX.length));
    if (match && match[1] === upstreamVersion) n = Math.max(n, Number(match[2]));
  }
  return `${upstreamVersion}-corp.${n + 1}`;
}

// CHANGELOG.md with its 未發行 section turned into the release's, and a new,
// empty 未發行 above it. `notes` is what the section said.
function releaseChangelog(text, { version, date }) {
  const start = text.indexOf(`${UNRELEASED}\n`);
  if (start < 0) throw new BuildError(`CHANGELOG.md has no "${UNRELEASED}" section`);
  const bodyStart = start + UNRELEASED.length + 1;
  const next = text.slice(bodyStart).search(/^## /m);
  const end = next < 0 ? text.length : bodyStart + next;
  const notes = text.slice(bodyStart, end).split('\n').filter((line) => !PLACEHOLDERS.has(line.trim())).join('\n').trim();
  if (!notes) throw new BuildError('CHANGELOG.md has nothing under 未發行: write down what this release changes first');
  const rest = text.slice(end).replace(/^\n+/, '');
  const released = [UNRELEASED, EMPTY_NOTE, `## ${TAG_PREFIX}${version}（${date}）`, notes].join('\n\n');
  return { text: `${text.slice(0, start)}${released}\n${rest ? `\n${rest}` : ''}`, notes };
}

// The CHANGELOG's links are relative to the repository root, and the release
// document sits in docs/releases.
function rebaseLinks(markdown, dir) {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (whole, target) => (
    /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target) ? whole : `](${path.posix.relative(dir, target)})`
  ));
}

// The settings a tree names: the hub's TOKEN_MONITOR_* and the database's.
function settingNames(text) {
  return new Set(String(text).match(/\b(?:TOKEN_MONITOR|POSTGRES)_[A-Z0-9_]+\b/g) || []);
}

function difference(a, b) {
  return [...a].filter((name) => !b.has(name)).sort();
}

function tarName(image, version) {
  return `${image.replace(/[/:]/g, '-')}-${version}.tar`;
}

function bullets(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

function code(text) {
  return `\`${text}\``;
}

function commitsSection(previousTag, commits) {
  if (!previousTag) return '這是第一版，見 `git log`。';
  if (!commits.length) return '沒有。';
  return bullets(commits.map((line) => line.replace(/^(\S+)/, '`$1`')));
}

function settingsSection(settings) {
  if (!settings) return '這是第一版。設定見 docs/hub.zh-TW.md 的「設定」與 `.env.example`。';
  const parts = [];
  if (settings.added.length) parts.push(`新增：\n\n${bullets(settings.added.map(code))}`);
  if (settings.removed.length) parts.push(`移除（\`.env\` 裡還有的話可以刪掉）：\n\n${bullets(settings.removed.map(code))}`);
  return parts.length ? parts.join('\n\n') : '沒有新增或移除的設定。';
}

function rollbackSection({ image, previousTag, newMigrations, date }) {
  if (!previousTag) return '這是第一版，沒有上一版可以換回。要停用 hub，執行 `docker compose -f docker/compose.yml --env-file .env stop hub`。';
  const previous = previousTag.slice(TAG_PREFIX.length);
  const swap = `docker tag ${image}:${previous} ${image}:latest\ndocker compose -f docker/compose.yml --env-file .env up -d`;
  if (!newMigrations) return `這一版沒有新的 migration，換回上一版的映像即可：\n\n\`\`\`bash\n${swap}\n\`\`\``;
  return `migration 只會往前：舊版 hub 看到比它新的 schema 會拒絕啟動。所以要先停掉 hub，用部署前的備份還原資料庫，再換回上一版的映像：

\`\`\`bash
docker compose -f docker/compose.yml --env-file .env stop hub
docker cp token-monitor-${date}.dump token-monitor-postgres:/tmp/restore.dump
docker exec token-monitor-postgres psql -U postgres -d token_monitor -c "DROP SCHEMA IF EXISTS token_monitor CASCADE"
docker exec token-monitor-postgres pg_restore -U postgres -d token_monitor /tmp/restore.dump
${swap}
\`\`\`

先整個刪掉 schema 再還原，這一版的 migration 新增的資料表才不會留下來，下次升級時才能重新套用。備份之後才進來的用量，各裝置下一次上傳時會補回來（用戶端保留 370 天的 history）。`;
}

function databaseRow({ previousTag, migrations }) {
  if (!previousTag) return `${migrations.all.length} 個 migration，第一次部署時建立整個資料庫`;
  if (migrations.added.length) return `**${migrations.added.length} 個新的 migration**，部署前一定要備份`;
  return '沒有新的 migration';
}

function backupStep({ previousTag, newMigrations, date }) {
  if (!previousTag) return '1. **第一次部署**：資料庫還不存在，不用備份。之後每一版部署前都要先備份（[postgres.zh-TW.md](../postgres.zh-TW.md)「備份與還原」）。';
  return `1. **備份資料庫**${newMigrations ? '（這一版有新的 migration，一定要做）' : ''}。在 PowerShell 與 Linux 的 bash 都能照打；Windows 的 Git Bash 會改寫 \`/tmp/…\` 這種路徑，要先 \`export MSYS_NO_PATHCONV=1\`：

   \`\`\`bash
   docker exec token-monitor-postgres pg_dump -U postgres -d token_monitor -n token_monitor -Fc -f /tmp/backup.dump
   docker cp token-monitor-postgres:/tmp/backup.dump token-monitor-${date}.dump
   \`\`\``;
}

function databaseCheck({ previousTag, newMigrations }) {
  if (!previousTag) return '- [ ] **資料庫**：`.env` 設好了 `POSTGRES_PASSWORD` 與 `TOKEN_MONITOR_DB_PASSWORD`（[docker.md](../docker.md)），之後的備份也排好了。';
  return `- [ ] **資料庫**：部署前已經備份${newMigrations ? '，也知道這一版的 migration 回不去' : ''}。`;
}

// docs/releases/<version>.md.
function renderReleaseDoc(info) {
  const { version, date, commit, upstream, previousTag, notes, commits, migrations, settings, image } = info;
  const tag = `${TAG_PREFIX}${version}`;
  const newMigrations = migrations.added.length > 0;
  const migrationItem = (name) => (previousTag && migrations.added.includes(name) ? `${code(name)}（這一版新增）` : code(name));
  return `# Token Monitor hub 公司版 ${version}

| 項目 | 內容 |
|---|---|
| 版本 | ${code(tag)}，${date} |
| 原始碼 | tag ${code(tag)}：commit ${code(commit)}，加上這份文件 |
| 上游 | token-monitor v${upstream.version}（上游 commit ${code(String(upstream.split || '').slice(0, 12))}），放在 \`upstream/\`，沒有修改 |
| 相容的用戶端 | 上游官方用戶端 **v${upstream.version}** |
| 映像 | ${code(`${image}:${version}`)} |
| 上一版 | ${previousTag ? code(previousTag) : '沒有，這是第一版'} |
| 資料庫 | ${databaseRow({ previousTag, migrations })} |

## 這一版的異動

${rebaseLinks(notes, RELEASES_DIR)}

## 自上一版以來的 commit

${commitsSection(previousTag, commits)}

## 資料庫 migration

hub 開機時會依序套用還沒套用的 migration，一個 migration 一個 transaction。這一版一共有 ${migrations.all.length} 個：

${bullets(migrations.all.map(migrationItem))}

## 設定的變化

${settingsSection(settings)}

## 從 GitLab 部署

\`${tag}\` 推上 GitLab 之後，它的 pipeline 會建映像、做冒煙測試，並把映像檔、這份文件與 \`SHA256SUMS\` 存到 Package Registry 的 \`token-monitor-hub/${version}\`。在那條 pipeline 按 \`deploy:hub\` 就部署這一版：備份、載入、啟動與確認都由它做（docs/hub.zh-TW.md「從 GitLab 部署」）。下面「部署」是不經過 GitLab 的手動做法。

## 部署

${backupStep({ previousTag, newMigrations, date })}
2. 部署的主機上要有這一版的 \`docker/\`（compose 檔與 PostgreSQL 的初始化腳本）：\`git fetch origin --tags\`，再 \`git checkout ${tag}\`。\`.env\` 放在 repo 的根目錄，不在版控裡。
3. 從 Package Registry 的 \`token-monitor-hub/${version}\` 下載這一版的三個檔案：映像檔、\`RELEASE.md\` 與 \`SHA256SUMS\`。映像不是在這台主機上打包的，先核對檔案、載入，再標成 \`latest\`：

   \`\`\`bash
   sha256sum -c SHA256SUMS
   docker load -i ${tarName(image, version)}
   docker tag ${image}:${version} ${image}:latest
   \`\`\`

4. 在 repo 的根目錄：\`docker compose -f docker/compose.yml --env-file .env up -d\`。
5. 確認：
   - \`http://<hub>/api/health\` 回 200。
   - \`docker logs token-monitor-hub\` 有 \`postgres store ready\`。
   - dashboard 的「用戶端版本」沒有比 v${upstream.version} 新的用戶端。

## 回滾

${rollbackSection({ image, previousTag, newMigrations, date })}

## 風險檢查

- [ ] **用戶端比伺服器新**：這一版的 hub 以上游 v${upstream.version} 建置，使用者要裝 v${upstream.version} 的官方用戶端。有人自己更新到比較新的版本時，可能送出 hub 還不認得的資料。上游有新版本時，先更新 \`upstream/\` 並發行新的 hub，再讓用戶端跟上。
- [ ] **外部更新被汙染**：用戶端只從上游官方的 GitHub release 下載。IT 核對簽章與雜湊；需要時關掉用戶端的自動更新，只推核准過的版本。見 [client-setup.zh-TW.md](../client-setup.zh-TW.md)。
${databaseCheck({ previousTag, newMigrations })}
- [ ] **金鑰**：\`.env\` 沒有進版控；client 金鑰外洩時依 [client-setup.zh-TW.md](../client-setup.zh-TW.md) 輪替。
`;
}

// RELEASE.md in dist/: the release document and what this build produced.
function renderDistRelease(doc, { trial, produced }) {
  const rows = produced.map(([item, value]) => `| ${item} | ${value} |`).join('\n');
  return `${trial ? `${TRIAL_NOTE}\n\n` : ''}${doc}\n## 這次打包的產出\n\n| 項目 | 內容 |\n|---|---|\n${rows}\n`;
}

function git(args, { allowFail = false, raw = false } = {}) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: raw ? 'buffer' : 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (result.status !== 0) {
    if (allowFail) return null;
    throw new BuildError(`git ${args.join(' ')} failed: ${String(result.stderr || result.error?.message || '').trim()}`);
  }
  return raw ? result.stdout : result.stdout.trim();
}

function quoteArg(arg) {
  return /^[A-Za-z0-9_.:=\\/-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

// quiet: capture the output instead of showing it, and don't echo the command
// (the smoke test's carry a password).
function run(command, args, { cwd = ROOT, quiet = false, allowFail = false } = {}) {
  const line = [command, ...args].map(quoteArg).join(' ');
  if (!quiet) console.log(`\n> ${line}`);
  const options = { cwd, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  // npm is a .cmd shim on Windows, which only a shell can start.
  const result = process.platform === 'win32' && command === 'npm'
    ? spawnSync(line, { ...options, shell: true })
    : spawnSync(command, args, options);
  if (allowFail) return result;
  if (result.error) throw new BuildError(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new BuildError(`${command} ${args[0] || ''} failed with exit code ${result.status}${quiet ? `: ${String(result.stderr || '').trim()}` : ''}`);
  return result;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// The release before this one: the newest corp/v tag reachable from HEAD.
function previousRelease() {
  return git(['describe', '--tags', '--abbrev=0', '--match', `${TAG_PREFIX}*`, 'HEAD'], { allowFail: true }) || null;
}

function migrationsAt(ref) {
  const names = git(['ls-tree', '--name-only', `${ref}:hub/persistence/sql`], { allowFail: true });
  return (names || '').split('\n').filter((name) => name.endsWith('.sql')).sort();
}

function settingsAt(ref) {
  return settingNames(git(['grep', '-h', '-o', '-E', '(TOKEN_MONITOR|POSTGRES)_[A-Z0-9_]+', ref, '--', 'hub', 'docker', '.env.example'], { allowFail: true }) || '');
}

function releaseInfo({ version, image, date, upstream, notes }) {
  const previousTag = previousRelease();
  const all = migrationsAt('HEAD');
  const before = new Set(previousTag ? migrationsAt(previousTag) : []);
  let settings = null;
  if (previousTag) {
    const now = settingsAt('HEAD');
    const then = settingsAt(previousTag);
    settings = { added: difference(now, then), removed: difference(then, now) };
  }
  return {
    version,
    date,
    commit: git(['rev-parse', '--short=12', 'HEAD']),
    upstream,
    previousTag,
    notes,
    commits: previousTag ? git(['log', '--no-merges', '--format=%h %s', `${previousTag}..HEAD`]).split('\n').filter(Boolean) : [],
    migrations: { all, added: all.filter((name) => !before.has(name)) },
    settings,
    image
  };
}

function exportTree(commit, into) {
  fs.rmSync(into, { recursive: true, force: true });
  fs.mkdirSync(into, { recursive: true });
  const archive = git(['archive', '--format=tar', commit, '--', ...IMAGE_PATHS], { raw: true });
  // tar runs inside the target instead of taking -C: GNU tar (Git Bash) would
  // read the drive letter of a Windows path as a remote host.
  const result = spawnSync('tar', ['-x', '-f', '-'], { cwd: into, input: archive });
  if (result.status !== 0) throw new BuildError(`tar -x into ${into} failed: ${String(result.stderr || result.error?.message || '').trim()}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A PostgreSQL set up by the repository's initdb script, and the new image on a
// network of their own: the hub has to connect as its own role, migrate the
// database and answer. Everything is removed afterwards, volumes included.
async function smokeTest(image, contextDir) {
  const id = crypto.randomBytes(4).toString('hex');
  const network = `tm-smoke-${id}`;
  const db = `tm-smoke-db-${id}`;
  const hub = `tm-smoke-hub-${id}`;
  const secret = crypto.randomBytes(16).toString('hex');
  const password = crypto.randomBytes(12).toString('hex');
  const docker = (args, options) => run('docker', args, { quiet: true, ...options });
  const logsOf = (name) => {
    const result = docker(['logs', name], { allowFail: true });
    return `${result.stdout || ''}${result.stderr || ''}`.trim();
  };
  const running = (name) => docker(['inspect', '--format', '{{.State.Running}}', name], { allowFail: true }).stdout?.trim() === 'true';
  async function waitFor(name, what, check) {
    for (let i = 0; i < 90; i += 1) {
      if (check()) return;
      if (!running(name)) throw new BuildError(`smoke test: ${what} stopped:\n${logsOf(name)}`);
      await sleep(1000);
    }
    throw new BuildError(`smoke test: ${what} did not come up in 90 seconds:\n${logsOf(name)}`);
  }
  console.log(`\nSmoke test of ${image} against ${POSTGRES_IMAGE}`);
  try {
    docker(['network', 'create', network]);
    docker(['run', '-d', '--name', db, '--network', network,
      '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=token_monitor', '-e', `TOKEN_MONITOR_DB_PASSWORD=${password}`,
      '--mount', `type=bind,source=${path.join(contextDir, 'docker', 'postgres', 'initdb')},target=/docker-entrypoint-initdb.d,readonly`,
      POSTGRES_IMAGE]);
    // Over TCP, as compose.yml checks: the first start's temporary server
    // listens on its socket only.
    await waitFor(db, 'PostgreSQL', () => docker(['exec', db, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'token_monitor'], { allowFail: true }).status === 0);
    docker(['run', '-d', '--name', hub, '--network', network, '-e', `TOKEN_MONITOR_SECRET=${secret}`,
      '-e', `TOKEN_MONITOR_DATABASE_URL=postgres://token_monitor:${password}@${db}:5432/token_monitor`, image]);
    const probe = `(async()=>{const base='http://127.0.0.1:17321';const h=await fetch(base+'/api/health');`
      + `const c=await (await fetch(base+'/api/custom/health',{headers:{authorization:'Bearer ${secret}'}})).json();`
      + `process.exit(h.ok&&c.persistence&&c.persistence.kind==='postgres'?0:1)})().catch(()=>process.exit(1))`;
    await waitFor(hub, 'the hub', () => docker(['exec', hub, 'node', '-e', probe], { allowFail: true }).status === 0);
    const logs = logsOf(hub);
    if (!/postgres store ready/.test(logs)) throw new BuildError(`smoke test: the hub answers but did not report its store:\n${logs}`);
    console.log('  the hub connected as token_monitor, migrated the database and answers /api/health.');
    // The image's pg_dump, as the hub's own role, into its /backups: the one
    // place all three meet before a deploy.
    const backup = `(async()=>{const r=await fetch('http://127.0.0.1:17321/api/admin/backups',{method:'POST',headers:{authorization:'Bearer ${secret}'}});`
      + `const b=await r.json();if(r.status!==201||!(b.backup&&b.backup.bytes>0)){console.error(r.status,JSON.stringify(b));process.exit(1)}})().catch((e)=>{console.error(e.message);process.exit(1)})`;
    const made = docker(['exec', hub, 'node', '-e', backup], { allowFail: true });
    if (made.status !== 0) throw new BuildError(`smoke test: the hub could not back up its database:\n${`${made.stdout || ''}${made.stderr || ''}`.trim()}\n${logsOf(hub)}`);
    console.log('  the hub backed up its database with the image\'s pg_dump.');
    const install = docker(['exec', hub, 'node', '-e', "fetch('http://127.0.0.1:17321/install').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { allowFail: true });
    if (install.status !== 0) throw new BuildError(`smoke test: the hub does not serve /install:\n${logsOf(hub)}`);
  } finally {
    docker(['rm', '--force', '--volumes', hub, db], { allowFail: true });
    docker(['network', 'rm', network], { allowFail: true });
  }
}

// Steps 1 and 2: what is being released, or why it cannot be.
function planRelease(cli) {
  const dry = cli.flags.has('dry-run');
  const trial = cli.flags.has('no-tag');
  const ci = cli.flags.has('ci');
  // Steps 4-6 run here: a trial, --build, and the CI build of a tag.
  const build = trial || ci || cli.flags.has('build');
  const upstream = checkUpstream({ cwd: ROOT });
  if (!upstream.ok) throw new BuildError(`upstream/ has been modified:\n  ${upstream.problems.join('\n  ')}`);
  if (!upstream.version) throw new BuildError('upstream/package.json has no version');
  const dirty = git(['status', '--porcelain']);
  if (dirty && !dry) throw new BuildError(`the working tree has uncommitted changes, and the image is built from commits only:\n${dirty}`);
  if (dirty) console.warn('Note: the working tree has uncommitted changes; a real run refuses to start.');
  if (ci) {
    const version = ciVersion(cli, process.env);
    if (!version.startsWith(`${upstream.version}-corp.`)) throw new BuildError(`version ${version} is not a release of upstream ${upstream.version}`);
    const tag = `${TAG_PREFIX}${version}`;
    if (git(['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], { allowFail: true }) !== git(['rev-parse', 'HEAD'])) {
      throw new BuildError(`--ci builds the release checked out, and HEAD is not ${tag}`);
    }
    return { ...cli, dry, trial, ci, build, upstream, version, tag, images: [`${cli.image}:${version}`], date: today(), docFile: `${RELEASES_DIR}/${version}.md` };
  }
  // The remote's tags as well, so that two machines never number a release alike.
  if (!dry && !trial && git(['fetch', '--quiet', '--tags', cli.remote], { allowFail: true }) === null) {
    console.warn(`Note: could not fetch the tags of ${cli.remote}; numbering from the local tags only.`);
  }
  const tags = (git(['tag', '--list', `${TAG_PREFIX}*`]) || '').split('\n').filter(Boolean);
  const version = cli.version || nextVersion(upstream.version, tags);
  if (!version.startsWith(`${upstream.version}-corp.`)) throw new BuildError(`version ${version} is not a release of upstream ${upstream.version}`);
  const tag = `${TAG_PREFIX}${version}`;
  if (tags.includes(tag)) throw new BuildError(`${tag} already exists: that version has been released`);
  const images = [`${cli.image}:${version}`, ...(trial ? [] : [`${cli.image}:latest`])];
  return { ...cli, dry, trial, ci, build, upstream, version, tag, images, date: today(), docFile: `${RELEASES_DIR}/${version}.md` };
}

// Step 3. A release that failed after committing its documents picks them up
// again; a trial and a dry run write nothing into the repository.
function writeDocuments(release) {
  const { version, tag, date, docFile, image, upstream, dry, trial, ci } = release;
  if (ci) {
    if (!fs.existsSync(path.join(ROOT, docFile))) throw new BuildError(`${tag} has no ${docFile}: tag releases with npm run build:image`);
    return fs.readFileSync(path.join(ROOT, docFile), 'utf8');
  }
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  if (fs.existsSync(path.join(ROOT, docFile)) && changelog.includes(`## ${tag}（`)) {
    console.log(`\nThe release documents are committed already: ${docFile}`);
    return fs.readFileSync(path.join(ROOT, docFile), 'utf8');
  }
  const { text, notes } = releaseChangelog(changelog, { version, date });
  const doc = renderReleaseDoc(releaseInfo({ version, image, date, upstream: { version: upstream.version, split: upstream.split }, notes }));
  if (dry) {
    console.log(`\nWould write CHANGELOG.md (未發行 → ${tag}) and ${docFile}:\n\n${doc}`);
  } else if (trial) {
    console.log(`\nA trial leaves CHANGELOG.md alone and writes no ${docFile}: the document goes to dist/ only.`);
  } else {
    fs.writeFileSync(path.join(ROOT, 'CHANGELOG.md'), text);
    fs.mkdirSync(path.join(ROOT, RELEASES_DIR), { recursive: true });
    fs.writeFileSync(path.join(ROOT, docFile), doc);
    git(['add', 'CHANGELOG.md', docFile]);
    git(['commit', '--quiet', '-m', `docs(release): ${tag}`]);
    console.log(`\nCommitted the release documents: ${git(['log', '-1', '--format=%h %s'])}`);
  }
  return doc;
}

// The repository's address for the image's label, without the credentials a
// remote URL can carry (a CI checkout's has the job token).
function sourceUrl(remoteUrl, projectUrl) {
  return projectUrl || String(remoteUrl || '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

// Step 4's docker build, labelled with what the image is.
function buildArgsFor({ version, upstream, remote, images }, commit) {
  const labels = {
    'org.opencontainers.image.title': 'Token Monitor hub, company edition',
    'org.opencontainers.image.version': version,
    'org.opencontainers.image.revision': commit,
    'org.opencontainers.image.created': new Date().toISOString(),
    'org.opencontainers.image.source': sourceUrl(git(['remote', 'get-url', remote], { allowFail: true }), process.env.CI_PROJECT_URL),
    'io.token-monitor.upstream.version': upstream.version,
    'io.token-monitor.upstream.commit': String(upstream.split || '')
  };
  return ['build', '-f', 'docker/Dockerfile',
    ...Object.entries(labels).flatMap(([name, value]) => ['--label', `${name}=${value}`]),
    ...images.flatMap((name) => ['-t', name]), '.'];
}

// Step 6.
function writeDist(release, { doc, commit, imageId, outDir }) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const sums = [];
  const produced = [['映像 ID', code(imageId)], ['commit', code(commit)]];
  if (!release.flags.has('no-save')) {
    const name = tarName(release.image, release.version);
    run('docker', ['save', '-o', path.join(outDir, name), release.images[0]]);
    const digest = sha256(path.join(outDir, name));
    sums.push(`${digest}  ${name}`);
    produced.push(['映像檔', `${code(name)}，SHA-256 ${code(digest)}`]);
  }
  fs.writeFileSync(path.join(outDir, 'RELEASE.md'), renderDistRelease(doc, { trial: release.trial, produced }));
  sums.push(`${sha256(path.join(outDir, 'RELEASE.md'))}  RELEASE.md`);
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
}

// Step 7.
function tagRelease({ tag, version, upstream, remote, flags, images }, commit, imageId) {
  const built = imageId ? `image ${images[0]} ${imageId}` : 'image built from this tag by GitLab (build:hub)';
  git(['tag', '--annotate', tag, commit, '--message', `Token Monitor hub ${version}\n\nupstream v${upstream.version} (${upstream.split})\n${built}`]);
  if (flags.has('no-push')) return;
  const pushed = spawnSync('git', ['push', remote, `refs/tags/${tag}`], { cwd: ROOT, stdio: 'inherit' });
  if (pushed.status !== 0) console.warn(`\nWARNING: ${tag} is tagged here but not pushed. Push it with: git push ${remote} ${tag}`);
}

function printDryRun(release, { buildArgs, commit, contextDir, outDir }) {
  const { flags, images, tag, remote } = release;
  if (release.build) {
    console.log(`Would export ${IMAGE_PATHS.join(' ')} at ${commit.slice(0, 12)} into ${path.relative(ROOT, contextDir)}`);
    console.log(`Would run there: docker ${buildArgs.map(quoteArg).join(' ')}`);
    if (!flags.has('skip-smoke')) console.log(`Would smoke-test ${images[0]} against a throwaway ${POSTGRES_IMAGE}`);
    const files = [...(flags.has('no-save') ? [] : [tarName(release.image, release.version)]), 'RELEASE.md', 'SHA256SUMS'];
    console.log(`Would write ${path.relative(ROOT, outDir)}: ${files.join(', ')}`);
  }
  if (!release.trial) console.log(`Would tag ${tag}${flags.has('no-push') ? '' : ` and push it to ${remote}`}`);
  if (!release.build) console.log(`GitLab's build:hub would then build and smoke-test ${images[0]} from ${tag} (--build: here as well)`);
}

async function main(argv = process.argv.slice(2)) {
  const release = planRelease(parseCli(argv));
  const { dry, trial, ci, build, version, flags, images } = release;
  const kind = ci ? 'CI build of' : trial ? 'Trial build' : 'Release';
  console.log(`${kind} ${version} of upstream v${release.upstream.version}${dry ? ' (dry run)' : ''}`);
  // The CI build comes after the pipeline's verify job.
  if (!flags.has('skip-verify') && !dry && !ci) run('npm', ['run', 'verify']);
  const doc = writeDocuments(release);

  const commit = git(['rev-parse', 'HEAD']);
  const buildArgs = buildArgsFor(release, commit);
  const contextDir = path.join(ROOT, 'tmp', 'hub-image', version);
  const outDir = path.join(ROOT, 'dist', 'hub', version);
  if (dry) {
    printDryRun(release, { buildArgs, commit, contextDir, outDir });
    return;
  }
  let imageId = null;
  if (build) {
    exportTree(commit, contextDir);
    run('docker', buildArgs, { cwd: contextDir });
    if (!flags.has('skip-smoke')) await smokeTest(images[0], contextDir);
    fs.rmSync(contextDir, { recursive: true, force: true });
    imageId = run('docker', ['image', 'inspect', '--format', '{{.Id}}', images[0]], { quiet: true }).stdout.trim();
    writeDist(release, { doc, commit, imageId, outDir });
  }
  if (!trial && !ci) tagRelease(release, commit, imageId);

  console.log(`\n${ci ? 'Built' : trial ? 'Trial build' : 'Released'} ${version}`);
  if (build) {
    console.log(`  image   ${images.join(', ')} (${imageId.slice(0, 19)})`);
    console.log(`  output  ${path.relative(ROOT, outDir)}`);
  }
  if (ci) return;
  console.log(`  tag     ${trial ? '(none: a trial)' : release.tag}`);
  if (trial) return;
  console.log(`Push the release commit as well: git push ${release.remote} HEAD`);
  console.log(`Then, in GitLab, the pipeline of ${release.tag}: build:hub builds and smoke-tests the image, and deploy:hub deploys it.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`build-hub-image: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { EMPTY_NOTE, IMAGE_PATHS, TAG_PREFIX, TRIAL_NOTE, ciVersion, nextVersion, parseCli, rebaseLinks, releaseChangelog, renderDistRelease, renderReleaseDoc, settingNames, sourceUrl, tarName };
