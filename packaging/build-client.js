#!/usr/bin/env node
'use strict';

// Builds the company Token Monitor client (docs/client-build.zh-TW.md):
//
//   npm run build:client -- --platform win [--dry-run] [--keep-work]
//   npm run build:client -- --platform mac
//   npm run build:client -- --platform linux
//
// upstream/ is never touched. It is copied to tmp/client-build/app, your own
// logo, if client/assets/ has one, replaces upstream's icons
// (client/README.md), the lines in UPSTREAM_PATCHES are changed in the copy,
// the company entry
// (client/electron/) and the generated corp-defaults.json are added under
// corp/, and electron-builder packages that copy with
// upstream's own `build` block plus the overrides in createBuilderConfig().
// The installers land in dist/client/.
//
// Build values come from TM_CLIENT_* environment variables (GitLab CI/CD
// variables) or .env.client; see packaging/clientConfig.js.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { ROOT, UPSTREAM_ROOT } = require('../upstream');
const { redacted, resolveClientConfig } = require('./clientConfig');

const WORK_DIR = path.join(ROOT, 'tmp', 'client-build');
const APP_DIR = path.join(WORK_DIR, 'app');
const OUTPUT_DIR = path.join(ROOT, 'dist', 'client');
// The company entry and the files it reads next to it (an optional
// title-logo.png, ownDeviceView.js).
const ENTRY_DIR = path.join(ROOT, 'client', 'electron');
// Optional: your logo, file for file over upstream's assets/ (client/README.md).
const ASSETS_SOURCE = path.join(ROOT, 'client', 'assets');
// Optional: the Windows program, installer and taskbar icon. electron-builder's
// .ico made from icon-win.png has 16, 24, 32, 48, 64, 128 and 256 px only, so
// at 125% or 150% scaling Windows shrinks the 48 px image and the taskbar icon
// blurs; an .ico of your own can have every size up to 256 px. Without one the
// build keeps upstream's icon.
const WIN_ICON = path.join(ROOT, 'client', 'build', 'icon-win.ico');
const CORP_MAIN = 'corp/main.js';
// Gives the ad-hoc signed mac app a designated requirement an update can meet.
const MAC_AFTER_SIGN = path.join(ROOT, 'packaging', 'macAfterSign.js');
// Left out of the copy: installed or generated trees, and parts of upstream the
// Electron app never packages.
const COPY_EXCLUDES = new Set(['node_modules', 'dist', 'tmp', '.github', 'docs', 'site', 'tests', 'worker']);

// artifactName names the installer the way Tauri apps name their GitHub Release
// assets, <name>_<version>_<arch>[-setup].<ext>, each OS with its own word for
// the CPU. .gitlab-ci.yml links the Release to these names and
// packaging/client-release-notes.md lists them.
const TARGETS = {
  win: { tokscaleKey: 'win32-x64', hostPlatform: 'win32', packages: { os: 'win32', cpu: 'x64' }, builderArgs: ['--win', 'nsis', '--x64'], artifactName: 'Token-Monitor_${version}_x64-setup.${ext}', ext: 'exe' },
  mac: { tokscaleKey: 'darwin-arm64', hostPlatform: 'darwin', packages: { os: 'darwin', cpu: 'arm64' }, builderArgs: ['--mac', 'dmg', 'zip', '--arm64'], artifactName: 'Token-Monitor_${version}_aarch64.${ext}', ext: 'dmg' },
  linux: { tokscaleKey: 'linux-x64', hostPlatform: 'linux', packages: { os: 'linux', cpu: 'x64' }, builderArgs: ['--linux', 'AppImage', '--x64'], artifactName: 'Token-Monitor_${version}_amd64.${ext}', ext: 'AppImage' }
};

function installerFileName(platform, version) {
  const { artifactName, ext } = TARGETS[platform];
  return artifactName.replace('${version}', version).replace('${ext}', ext);
}

// Builds that only their own OS can make; the Windows build is the cross-OS one.
const HOST_ONLY = {
  mac: 'the macOS build needs a macOS host (the GitLab runner tagged macos)',
  linux: 'the Linux build needs a Linux host (the GitLab runner tagged ubuntu)'
};

function parseCli(argv) {
  const out = { platform: '', dryRun: false, keepWork: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--keep-work') out.keepWork = true;
    else if (arg === '--platform') {
      out.platform = String(argv[i + 1] || '');
      i += 1;
    } else if (arg.startsWith('--platform=')) out.platform = arg.slice('--platform='.length);
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!TARGETS[out.platform]) throw new Error('usage: npm run build:client -- --platform win|mac|linux [--dry-run] [--keep-work]');
  return out;
}

// Where the packaged app looks for updates: the newest Release of the company
// GitLab project (packaging/clientConfig.js normalizeUpdateSource()). From this
// electron-builder writes resources/app-update.yml into the app and
// latest.yml / latest-mac.yml / latest-linux.yml next to the installer;
// .gitlab-ci.yml attaches those to the Release. electron-updater reads
// /api/v4/projects/<id>/releases/permalink/latest and picks the assets by link
// name, so the Release names its links after the files.
//
// `channel` is fixed: from an X.Y.Z-corp.N version electron-builder would
// infer the channel `corp` and write corp.yml instead.
//
// On macOS electron-updater installs from the zip, not the dmg, and Squirrel.Mac
// takes it only if it meets the running app's designated requirement
// (packaging/macAfterSign.js).
//
// None without a configured project; the app then has no update source, as
// before. Downloading stays the user's choice: the entry seeds
// automaticAppUpdates off.
function updatePublishConfig(update) {
  if (!update) return null;
  return [{ provider: 'gitlab', host: update.host, projectId: update.projectId, channel: 'latest' }];
}

function brandWinIcon(file = WIN_ICON) {
  return fs.existsSync(file) ? file : null;
}

// electron-builder's --config replaces package.json's `build` block rather than
// merging with it, so this starts from upstream's block and overrides only what
// the company build needs.
function createBuilderConfig({ base, version, platform, outputDir, crossBuild, update = null, winIcon = brandWinIcon() }) {
  if (!base?.win || !base?.nsis || !base?.mac || !base?.linux) throw new Error('upstream/package.json build.win / build.nsis / build.mac / build.linux are missing; packaging/build-client.js needs updating');
  if (!Array.isArray(base.files) || !base.files.includes('src/electron/**/*')) {
    throw new Error('upstream/package.json build.files no longer packages src/electron/; packaging/build-client.js needs updating');
  }
  const config = {
    ...base,
    // app.getVersion() and the installer name carry the company version; the
    // packaged package.json's main is the company entry.
    extraMetadata: { ...(base.extraMetadata || {}), version, main: CORP_MAIN },
    files: [...base.files, 'corp/**/*'],
    directories: { ...(base.directories || {}), output: outputDir },
    win: {
      ...base.win,
      icon: winIcon || base.win.icon,
      target: [{ target: 'nsis', arch: ['x64'] }],
      // Unsigned until the company has a code-signing certificate. Upstream's
      // "SignPath Foundation" would make every update fail verification.
      verifyUpdateCodeSignature: false,
      signtoolOptions: { ...(base.win.signtoolOptions || {}), publisherName: null }
    },
    nsis: { ...base.nsis, artifactName: TARGETS.win.artifactName },
    // Ad-hoc signed until the company has an Apple Developer ID. A downloaded
    // app with no valid signature gets "is damaged and can't be opened", which
    // no button gets past; ad-hoc signed, it gets the usual "cannot verify the
    // developer" and Privacy & Security → Open Anyway. Hardened runtime only
    // serves notarization, and with an ad-hoc signature its library validation
    // can stop the app from loading its own frameworks.
    //
    // The dmg installs; the zip is what the installed app updates from.
    mac: {
      ...base.mac,
      artifactName: TARGETS.mac.artifactName,
      target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
      forceCodeSigning: false,
      identity: '-',
      hardenedRuntime: false
    },
    // AppImage only: upstream's launch at login on Linux works for an AppImage
    // alone (src/electron/linuxAutostart.js).
    linux: { ...base.linux, artifactName: TARGETS.linux.artifactName, target: [{ target: 'AppImage', arch: ['x64'] }] },
    publish: updatePublishConfig(update)
  };
  delete config.releaseInfo;
  // Cross-OS (the Linux runner building Windows): native modules cannot be
  // rebuilt for another OS. They are all prebuilt; installTargetPlatformPackages()
  // puts the target OS's packages in place instead.
  if (crossBuild) config.npmRebuild = false;
  if (platform === 'mac') config.afterSign = MAC_AFTER_SIGN;
  else delete config.mac;
  return config;
}

function copyUpstream(appDir) {
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.cpSync(UPSTREAM_ROOT, appDir, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(UPSTREAM_ROOT, source);
      if (!relative) return true;
      return !COPY_EXCLUDES.has(relative.split(path.sep)[0]);
    }
  });
}

// Your logo: every file under client/assets/ replaces upstream's file at the
// same path under assets/ (app and installer icons, tray icons, the in-app
// mark), so upstream's code and build block pick it up unchanged. A file
// upstream no longer has would be a logo nobody sees: the build stops. No
// client/assets/: upstream's icons stay.
function overlayAssets(appDir, sourceDir = ASSETS_SOURCE) {
  if (!fs.existsSync(sourceDir)) return [];
  const files = fs.readdirSync(sourceDir, { recursive: true })
    .filter((name) => fs.statSync(path.join(sourceDir, name)).isFile())
    .map((name) => name.split(path.sep).join('/'))
    .sort();
  for (const file of files) {
    const destination = path.join(appDir, 'assets', ...file.split('/'));
    if (!fs.existsSync(destination)) throw new Error(`upstream has no assets/${file} any more; client/assets/${file} needs updating`);
    fs.copyFileSync(path.join(sourceDir, ...file.split('/')), destination);
  }
  return files;
}

// Lines of upstream's code the company build changes in the copy, each found
// exactly `count` times (1 unless given) or the build stops: an upstream
// update that rewrote one needs the patch redone, not skipped.
const UPSTREAM_PATCHES = [
  {
    // The devices list names each device. The company build's device id is a
    // random UUID (client/electron/main.js seedFirstRun()), so the hostname
    // goes first.
    file: 'src/electron/renderer/app.js',
    from: "  return device.deviceId || device.hostname || 'device';",
    to: "  return device.hostname || device.deviceId || 'device';"
  },
  // The App Updates header names where updates come from. The company build
  // updates from the GitLab Release (updatePublishConfig()); upstream's text,
  // in the page and in each language, says GitHub.
  //
  // The name is a link to the Releases too. The outer span keeps the header's
  // styling. The click opens upstream's Releases page, the one URL the
  // allowlist in main.js lets through; the company entry swaps it for the
  // GitLab Releases (client/electron/main.js corpReleasePageUrl()).
  {
    file: 'src/electron/renderer/index.html',
    from: '<span data-i18n="settings.appUpdate.source">GitHub releases</span>',
    to: '<span><button id="appUpdateSourceLink" type="button" class="inline-link" data-i18n="settings.appUpdate.source">GitLab releases</button></span>'
  },
  {
    file: 'src/electron/renderer/i18n.js',
    from: "'settings.appUpdate.source': 'GitHub releases',",
    to: "'settings.appUpdate.source': 'GitLab releases',",
    count: 5
  },
  {
    file: 'src/electron/renderer/app.js',
    from: "els.reportIssueButton?.addEventListener('click', () => window.tokenMonitor.openExternal?.(TOKEN_MONITOR_ISSUES_URL));",
    to: [
      "els.reportIssueButton?.addEventListener('click', () => window.tokenMonitor.openExternal?.(TOKEN_MONITOR_ISSUES_URL));",
      "document.getElementById('appUpdateSourceLink')?.addEventListener('click', () => window.tokenMonitor.openExternal?.(`${TOKEN_MONITOR_REPOSITORY_URL}/releases`));"
    ].join('\n')
  }
];

function patchUpstream(appDir, patches = UPSTREAM_PATCHES) {
  for (const { file, from, to, count: expected = 1 } of patches) {
    const filePath = path.join(appDir, ...file.split('/'));
    const parts = fs.readFileSync(filePath, 'utf8').split(from);
    const count = parts.length - 1;
    if (count !== expected) throw new Error(`upstream's ${file} has ${count} copies of ${JSON.stringify(from)}, not ${expected}; UPSTREAM_PATCHES in packaging/build-client.js needs updating`);
    fs.writeFileSync(filePath, parts.join(to));
  }
  return [...new Set(patches.map(({ file }) => file))];
}

function writeCorpFiles(appDir, defaults) {
  const corpDir = path.join(appDir, 'corp');
  fs.cpSync(ENTRY_DIR, corpDir, { recursive: true });
  fs.writeFileSync(path.join(corpDir, 'corp-defaults.json'), `${JSON.stringify(defaults, null, 2)}\n`, { mode: 0o600 });
}

// npm and npx are .cmd shims on Windows, which only a shell can start. A shell
// gets one command line, so the arguments are quoted here.
function quoteArg(arg) {
  return /^[A-Za-z0-9_.:=\\/-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

function run(command, args, { cwd, env = process.env } = {}) {
  const line = [command, ...args].map(quoteArg).join(' ');
  console.log(`\n> ${line}`);
  const result = process.platform === 'win32'
    ? spawnSync(line, { cwd, env, stdio: 'inherit', shell: true })
    : spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args[0] || ''} failed with exit code ${result.status}`);
}

// electron-builder fetches Electron from github.com on every build, so a
// runner whose DNS is gone for a few minutes fails the build (getaddrinfo
// ENOTFOUND github.com). A failure whose output names
// a network error is tried again after each of these waits; any other failure
// stops the build at once.
const NETWORK_ERROR = /\b(?:ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b|socket hang up/;
const NETWORK_RETRY_DELAYS_MS = [30_000, 60_000, 120_000];
// How much of the end of the output is kept to look for the error.
const OUTPUT_TAIL = 64 * 1024;

// Like run(), but the output also comes back, to see why it failed.
function runTee(command, args, { cwd, env = process.env } = {}) {
  const line = [command, ...args].map(quoteArg).join(' ');
  console.log(`\n> ${line}`);
  return new Promise((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn(line, { cwd, env, stdio: ['inherit', 'pipe', 'pipe'], shell: true })
      : spawn(command, args, { cwd, env, stdio: ['inherit', 'pipe', 'pipe'] });
    let output = '';
    const keep = (stream) => (chunk) => {
      stream.write(chunk);
      output = (output + chunk).slice(-OUTPUT_TAIL);
    };
    child.stdout.on('data', keep(process.stdout));
    child.stderr.on('data', keep(process.stderr));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, output }));
  });
}

async function retryOnNetworkError(attempt, { label, delays = NETWORK_RETRY_DELAYS_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  for (let tries = 0; ; tries += 1) {
    const { status, output } = await attempt();
    if (status === 0) return;
    if (tries >= delays.length || !NETWORK_ERROR.test(output)) throw new Error(`${label} failed with exit code ${status}`);
    console.log(`\n${label} failed on a network error; trying again in ${delays[tries] / 1000} s (${tries + 1}/${delays.length})`);
    await sleep(delays[tries]);
  }
}

// The optional runtime packages upstream's lockfile pins for the target OS and
// CPU: the Windows tokscale binary and koffi's native module
// (@koromix/koffi-win32-x64).
function targetPlatformPackages(lock, { os, cpu }) {
  return Object.entries(lock.packages || {})
    .filter(([key, entry]) => key && entry.optional && !entry.dev
      && Array.isArray(entry.os) && entry.os.includes(os)
      && (!Array.isArray(entry.cpu) || entry.cpu.includes(cpu)))
    .map(([key, entry]) => ({ location: key, name: key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length), version: entry.version }));
}

// npm ci on Linux skips the packages that are optional dependencies for
// another OS, so a Windows build made there would lack them. Unpack the locked
// version of each by hand, where npm would have put it.
function installTargetPlatformPackages(appDir, target) {
  const lock = JSON.parse(fs.readFileSync(path.join(appDir, 'package-lock.json'), 'utf8'));
  const tar = require(require.resolve('tar', { paths: [appDir] }));
  for (const pkg of targetPlatformPackages(lock, target)) {
    const destination = path.join(appDir, ...pkg.location.split('/'));
    if (fs.existsSync(path.join(destination, 'package.json'))) continue;
    const packDir = path.join(WORK_DIR, 'pack', pkg.name.replace('/', '__'));
    fs.mkdirSync(packDir, { recursive: true });
    run('npm', ['pack', `${pkg.name}@${pkg.version}`, '--pack-destination', packDir, '--silent'], { cwd: appDir });
    const tarball = fs.readdirSync(packDir).find((name) => name.endsWith('.tgz'));
    if (!tarball) throw new Error(`npm pack produced no tarball for ${pkg.name}`);
    fs.mkdirSync(destination, { recursive: true });
    tar.x({ file: path.join(packDir, tarball), cwd: destination, strip: 1, sync: true });
  }
}

// Upstream's ensure-vendored-tokscale.js, called in-process so a cross-OS
// build can replace its smoke test (running the binary) with nothing: the
// sha256 of the pinned download is still verified.
async function ensureTokscale(appDir, key, crossBuild) {
  const previous = process.cwd();
  process.chdir(appDir);
  try {
    const { ensureVendoredTokscale } = require(path.join(appDir, 'scripts', 'ensure-vendored-tokscale.js'));
    const smoke = crossBuild ? () => 'not run: cross-OS build, sha256 verified' : undefined;
    await ensureVendoredTokscale({ requestedKey: key, ...(smoke ? { smoke } : {}) });
  } finally {
    process.chdir(previous);
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const cli = parseCli(argv);
  const target = TARGETS[cli.platform];
  const crossBuild = process.platform !== target.hostPlatform;
  if (HOST_ONLY[cli.platform] && crossBuild) throw new Error(HOST_ONLY[cli.platform]);

  const pkg = JSON.parse(fs.readFileSync(path.join(UPSTREAM_ROOT, 'package.json'), 'utf8'));
  const { version, defaults, update } = resolveClientConfig({ upstreamVersion: pkg.version, env });
  const config = createBuilderConfig({ base: pkg.build, version, platform: cli.platform, outputDir: OUTPUT_DIR, crossBuild, update });

  console.log(`Company client ${version} for ${cli.platform}${crossBuild ? ' (cross-OS build)' : ''}`);
  console.log(`First-run settings: ${JSON.stringify(redacted(defaults))}`);
  console.log(config.publish
    ? `Updates: the newest Release of GitLab project ${update.projectId} on ${update.host}`
    : 'Updates: none (TM_CLIENT_UPDATE_PROJECT_URL / _ID not set)');
  if (cli.dryRun) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  try {
    copyUpstream(APP_DIR);
    const logo = overlayAssets(APP_DIR);
    console.log(`Logo: ${logo.length ? logo.map((file) => `assets/${file}`).join(', ') : "upstream's (no client/assets/)"}`);
    console.log(`Patched: ${patchUpstream(APP_DIR).join(', ')}`);
    writeCorpFiles(APP_DIR, defaults);
    const configFile = path.join(WORK_DIR, 'electron-builder.json');
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

    run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: APP_DIR });
    if (crossBuild) installTargetPlatformPackages(APP_DIR, target.packages);
    await ensureTokscale(APP_DIR, target.tokscaleKey, crossBuild);

    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
    const builderArgs = ['electron-builder', ...target.builderArgs, '--publish', 'never', '--config', configFile];
    await retryOnNetworkError(() => runTee('npx', builderArgs, { cwd: APP_DIR }), { label: 'npx electron-builder' });
    const files = fs.readdirSync(OUTPUT_DIR);
    if (!files.some((name) => /\.(exe|dmg|AppImage)$/.test(name))) throw new Error(`electron-builder produced no installer in ${OUTPUT_DIR}`);
    if (config.publish && !files.some((name) => /^latest.*\.yml$/.test(name))) {
      throw new Error(`electron-builder produced no latest*.yml in ${OUTPUT_DIR}; the Release could not offer this version as an update`);
    }
    if (cli.platform === 'mac' && !files.some((name) => name.endsWith('.zip'))) {
      throw new Error(`electron-builder produced no zip in ${OUTPUT_DIR}; installed Macs could not update to this version`);
    }
    const built = files.filter((name) => /\.(exe|dmg|zip|AppImage)$|^latest.*\.yml$/.test(name));
    console.log(`\nBuilt ${built.map((name) => path.join('dist', 'client', name)).join(', ')}`);
  } finally {
    // corp-defaults.json carries the client key; never leave it behind.
    if (cli.keepWork) fs.rmSync(path.join(APP_DIR, 'corp', 'corp-defaults.json'), { force: true });
    else fs.rmSync(WORK_DIR, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`build-client: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { ASSETS_SOURCE, CORP_MAIN, COPY_EXCLUDES, MAC_AFTER_SIGN, NETWORK_ERROR, NETWORK_RETRY_DELAYS_MS, TARGETS, UPSTREAM_PATCHES, WIN_ICON, brandWinIcon, createBuilderConfig, installerFileName, main, overlayAssets, parseCli, patchUpstream, retryOnNetworkError, runTee, targetPlatformPackages, updatePublishConfig, writeCorpFiles };
