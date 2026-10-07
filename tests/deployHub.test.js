'use strict';

// The hub's deploys: deploy/server-deploy.sh, run on the server by
// deploy/3.deploy-ubuntu.ps1 and by the deploy:hub job (.gitlab-ci.yml).
// Running them needs the server; these check how they are wired together.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// A top-level job of .gitlab-ci.yml, up to the next top-level key.
function jobBlock(ci, name) {
  const start = ci.indexOf(`\n${name}:\n`);
  assert.ok(start >= 0, `.gitlab-ci.yml has ${name}`);
  const rest = ci.slice(start + 1);
  const end = rest.slice(name.length + 2).search(/^[^\s#]/m);
  return end < 0 ? rest : rest.slice(0, name.length + 2 + end);
}

test('the hub jobs run on the hub-deploy runner and create no Release', () => {
  const ci = read('.gitlab-ci.yml');
  assert.match(jobBlock(ci, '.hub'), /^ {2}tags: \[hub-deploy\]$/m);
  for (const name of ['build:hub', 'deploy:hub']) {
    const job = jobBlock(ci, name);
    assert.match(job, /^ {2}extends: \.hub$/m, `${name} runs on the hub-deploy runner`);
    assert.doesNotMatch(job, /^ {2}tags:/m, `${name} names no other runner`);
    // Only client-v… tags create Releases: the newest one must carry latest.yml.
    assert.doesNotMatch(job, /^ {2}release:/m, `${name} creates no Release`);
    assert.doesNotMatch(job, /set -x/);
  }
  // build-hub-image.js names its tags corp/v<version>, and the pipeline's
  // pattern has to match them.
  assert.ok(ci.includes(`HUB_TAG_RE: '/^corp\\/v\\d+\\.\\d+\\.\\d+-corp\\.\\d+$/'`));
  assert.equal(require('../scripts/build-hub-image').TAG_PREFIX, 'corp/v');
});

test('a hub tag is verified and built; deploys are by hand, on main or a hub tag', () => {
  const ci = read('.gitlab-ci.yml');
  const verify = jobBlock(ci, 'verify');
  assert.match(verify, /- if: \$CI_COMMIT_TAG =~ \$CLIENT_TAG_RE\n {6}when: never\n {4}- when: on_success\n/);
  // A hub tag that is not protected never reaches the Protected hub-deploy
  // runner: verify fails first, with what to change, instead of build:hub
  // waiting in pending.
  const check = verify.indexOf('[ "${CI_COMMIT_REF_PROTECTED:-}" != "true" ]');
  assert.ok(check > 0 && check < verify.indexOf('- npm ci'), 'verify checks the tag is protected before anything else');
  assert.ok(verify.includes('Protected tags: protect corp/v*'));
  const build = jobBlock(ci, 'build:hub');
  assert.match(build, / {2}rules:\n {4}- if: \$CI_COMMIT_TAG =~ \$HUB_TAG_RE\n {2}script:/);
  assert.match(build, /node scripts\/build-hub-image\.js --ci\n/);
  assert.match(build, /--upload-file "\$file" "\$\{PACKAGE_URL\}\/\$\(basename "\$file"\)"/);
  const deploy = jobBlock(ci, 'deploy:hub');
  assert.match(deploy, / {2}rules:\n {4}- if: \$CI_COMMIT_TAG =~ \$HUB_TAG_RE\n {6}when: manual\n {4}- if: \$CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH\n {6}when: manual\n/);
  assert.match(deploy, /- job: build:hub\n {6}optional: true\n/);
  assert.match(deploy, /^ {2}resource_group: hub-production$/m);
  assert.match(deploy, /^ {4}name: hub\/production$/m);
  // The tar the tag's build:hub uploaded, under the name the script gives it.
  const { tarName } = require('../scripts/build-hub-image');
  assert.equal(tarName('token-monitor-hub', '${version}'), 'token-monitor-hub-${version}.tar');
  assert.ok(deploy.includes('tar="token-monitor-hub-${version}.tar"'));
  assert.ok(deploy.includes('mv "$tar" "$stage.image.tar"'), 'handed to server-deploy.sh, which loads it');
  // A CI/CD variable cannot reset the database or skip its backup.
  assert.match(deploy, /- >\n {6}RESET_DATABASE=0 SKIP_BACKUP=0 bash deploy\/server-deploy\.sh /);
  // The server's .env is a secret: copied with a private umask, never shown.
  assert.match(deploy, /\(umask 077; cp "\$TM_HUB_ENV" /);
  assert.doesNotMatch(deploy, /echo[^\n]*TM_HUB_ENV|cat "\$TM_HUB_ENV"/);
});

// A runner that briefly cannot resolve the GitLab host must not fail a release
// halfway through its uploads.
test('every curl the jobs make to GitLab retries a passing network failure', () => {
  const calls = read('.gitlab-ci.yml').split('\n').filter((line) => /^\s+curl /.test(line));
  assert.equal(calls.length, 3, 'release:client and build:hub upload, deploy:hub downloads');
  for (const call of calls) assert.match(call, / --retry 5 --retry-delay 10 /, call.trim());
});

test('the release folder deploy:hub uploads leaves out what 1.token-monitor-release.ps1 does', () => {
  const job = jobBlock(read('.gitlab-ci.yml'), 'deploy:hub');
  const excluded = read('deploy/common.ps1').match(/^\$ReleaseExclude = @\((.*)\)$/m)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  assert.ok(excluded.length > 0);
  for (const name of excluded) assert.ok(job.includes(`':(exclude)${name}'`), `${name} is left out`);
});

test('3.deploy-ubuntu.ps1 uploads deploy/server-deploy.sh instead of a copy of its own', () => {
  const ps1 = read('deploy/3.deploy-ubuntu.ps1');
  assert.match(ps1, /Join-Path \$PSScriptRoot 'server-deploy\.sh'/);
  assert.doesNotMatch(ps1, /@'\nset -euo pipefail/, 'no embedded server script');
  const sh = read('deploy/server-deploy.sh');
  // The arguments both callers pass, in this order.
  assert.match(sh, /^commit=\$1; ref=\$2; upstream_version=\$3; tag=\$4; stage=\$5; target=\$6; server=\$7; source=\$8$/m);
  assert.match(sh, /^STAGE_DIR=\$\{STAGE_DIR:-\$HOME\}$/m);
});

test('deploy/server-deploy.sh removes the database volume and no other', () => {
  const sh = read('deploy/server-deploy.sh');
  assert.match(sh, /^POSTGRES_VOLUME=token-monitor_postgres-data$/m);
  const removals = sh.split('\n').filter((line) => /\bvolume\s+(rm|prune)\b|\bdown\b[^\n]*(-v\b|--volumes)/.test(line));
  assert.deepEqual(removals.map((line) => line.trim()), ['dk volume rm "$POSTGRES_VOLUME" >/dev/null']);
  // Only behind RESET_DATABASE=1, which deploy:hub pins to 0.
  assert.match(sh, /^if \[ "\$\{RESET_DATABASE:-0\}" = 1 \] && /m);
});

test('deploy/server-deploy.sh is valid bash', { skip: spawnSync('bash', ['--version']).status !== 0 && 'no bash' }, () => {
  // Relative: on Windows the bash found may be WSL's, which reads no D:\ paths.
  const result = spawnSync('bash', ['-n', 'deploy/server-deploy.sh'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
