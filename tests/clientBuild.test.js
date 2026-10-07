'use strict';

// The company client build (docs/client-build.zh-TW.md): the build values, the
// first-run settings the company entry writes, the electron-builder overrides,
// and the upstream seams all of it relies on.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { ROOT, upstream } = require('../upstream');
const {
  normalizeHubUrl,
  normalizeInterval,
  normalizeSecret,
  normalizeUpdateSource,
  normalizeVersion,
  readEnv,
  redacted,
  resolveClientConfig
} = require('../packaging/clientConfig');
const {
  ASSETS_SOURCE,
  CORP_MAIN,
  MAC_AFTER_SIGN,
  NETWORK_ERROR,
  NETWORK_RETRY_DELAYS_MS,
  UPSTREAM_PATCHES,
  WIN_ICON,
  brandWinIcon,
  createBuilderConfig,
  installerFileName,
  overlayAssets,
  parseCli,
  patchUpstream,
  retryOnNetworkError,
  runTee,
  targetPlatformPackages,
  updatePublishConfig,
  writeCorpFiles
} = require('../packaging/build-client');
const macAfterSign = require('../packaging/macAfterSign');
const {
  LOGIN_LAUNCH_ARG,
  SETTINGS_ONCE,
  applyHubOnce,
  applySettingsOnce,
  autostartExecPath,
  claimStartAtLogin,
  corpReleasePageUrl,
  dropUpstreamUpdateCache,
  followAppImageAutostart,
  installLoginLaunchArg,
  installReleasePageRedirect,
  installTitleLogo,
  launchedAtLogin,
  minimizeAtLogin,
  seedFirstRun,
  startsInTray,
  tagLoginItem,
  titleLogoCss
} = require('../client/electron/main');
const { CredentialStore, CREDENTIAL_SETTING_PATHS } = require(upstream('src/shared/credentialStore.js'));

const UPSTREAM_PKG = JSON.parse(fs.readFileSync(upstream('package.json'), 'utf8'));
const SECRET = 'a'.repeat(48);
const NO_FILE = path.join(os.tmpdir(), 'tm-no-such-env-client');

function tempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-client-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the hub URL must be https unless http is allowed, without credentials, query or fragment', () => {
  assert.equal(normalizeHubUrl('https://tokens.example.internal/'), 'https://tokens.example.internal');
  assert.throws(() => normalizeHubUrl(''), /required/);
  assert.throws(() => normalizeHubUrl('not a url'), /not a valid URL/);
  assert.throws(() => normalizeHubUrl('http://192.0.2.10'), /must use https/);
  assert.equal(normalizeHubUrl('http://192.0.2.10', { allowHttp: true }), 'http://192.0.2.10');
  assert.throws(() => normalizeHubUrl('https://u:p@hub.example'), /credentials/);
  assert.throws(() => normalizeHubUrl('https://hub.example/?a=1'), /query or fragment/);
});

test('the client key and the upload interval are validated', () => {
  assert.equal(normalizeSecret(` ${SECRET} `), SECRET);
  assert.throws(() => normalizeSecret('short'), /TM_CLIENT_SECRET/);
  assert.throws(() => normalizeSecret(`${SECRET}"$x`), /TM_CLIENT_SECRET/);
  assert.equal(normalizeInterval(undefined), 1800000);
  assert.equal(normalizeInterval('600000'), 600000);
  assert.equal(normalizeInterval('0'), 0);
  assert.throws(() => normalizeInterval('900000'), /must be 0, 600000, 1200000 or 1800000/);
});

test('the version is X.Y.Z-corp.N on the upstream version, from a value or a CI tag', () => {
  assert.equal(normalizeVersion('', '0.63.1'), '0.63.1-corp.0');
  assert.equal(normalizeVersion('0.63.1-corp.2', '0.63.1'), '0.63.1-corp.2');
  assert.equal(normalizeVersion('client-v0.63.1-corp.3', '0.63.1'), '0.63.1-corp.3');
  assert.throws(() => normalizeVersion('0.63.1', '0.63.1'), /X\.Y\.Z-corp\.N/);
  assert.throws(() => normalizeVersion('0.64.0-corp.1', '0.63.1'), /upstream version/);
});

test('real environment variables win over .env.client', () => {
  tempDir((dir) => {
    const envFile = path.join(dir, '.env.client');
    fs.writeFileSync(envFile, `TM_CLIENT_HUB_URL=https://file.example\nTM_CLIENT_SECRET=${SECRET}\n`);
    const values = readEnv({ env: { TM_CLIENT_HUB_URL: 'https://ci.example', PATH: '/bin' }, envFile });
    assert.equal(values.TM_CLIENT_HUB_URL, 'https://ci.example');
    assert.equal(values.TM_CLIENT_SECRET, SECRET);
    assert.equal(values.PATH, undefined, 'only TM_CLIENT_* is read from the environment');
  });
});

test('resolveClientConfig defaults to a 30-minute upload, launch at login minimized and this device only', () => {
  const { version, defaults } = resolveClientConfig({
    upstreamVersion: '0.63.1',
    env: { TM_CLIENT_HUB_URL: 'http://192.0.2.10', TM_CLIENT_ALLOW_HTTP: '1', TM_CLIENT_SECRET: SECRET },
    envFile: NO_FILE
  });
  assert.equal(version, '0.63.1-corp.0');
  assert.deepEqual(defaults, {
    hubUrl: 'http://192.0.2.10',
    secret: SECRET,
    syncUploadIntervalMs: 1800000,
    startAtLogin: true,
    startMinimizedAtLogin: true,
    ownDeviceOnly: true
  });
  assert.equal(redacted(defaults).secret, '***');
  assert.throws(() => resolveClientConfig({ upstreamVersion: '0.63.1', env: { TM_CLIENT_SECRET: SECRET }, envFile: NO_FILE }), /TM_CLIENT_HUB_URL is required/);
});

test('TM_CLIENT_OWN_DEVICE_ONLY=0 brings back every device; a bad value names the variable', () => {
  const base = { TM_CLIENT_HUB_URL: 'https://hub.example', TM_CLIENT_SECRET: SECRET };
  const resolve = (value) => resolveClientConfig({ upstreamVersion: '0.63.1', env: { ...base, TM_CLIENT_OWN_DEVICE_ONLY: value }, envFile: NO_FILE });
  assert.equal(resolve('0').defaults.ownDeviceOnly, false);
  assert.equal(resolve('1').defaults.ownDeviceOnly, true);
  assert.equal(resolve('').defaults.ownDeviceOnly, true);
  assert.throws(() => resolve('maybe'), /TM_CLIENT_OWN_DEVICE_ONLY: expected 1 or 0/);
});

test('TM_CLIENT_START_MINIMIZED=0 leaves the widget shown at login; a bad value names the variable', () => {
  const base = { TM_CLIENT_HUB_URL: 'https://hub.example', TM_CLIENT_SECRET: SECRET };
  const resolve = (value) => resolveClientConfig({ upstreamVersion: '0.63.1', env: { ...base, TM_CLIENT_START_MINIMIZED: value }, envFile: NO_FILE });
  assert.equal(resolve('0').defaults.startMinimizedAtLogin, false);
  assert.equal(resolve('1').defaults.startMinimizedAtLogin, true);
  assert.throws(() => resolve('maybe'), /TM_CLIENT_START_MINIMIZED: expected 1 or 0/);
});

test('the update source is a GitLab project page with its numeric id, or nothing', () => {
  assert.equal(normalizeUpdateSource('', ''), null);
  assert.equal(normalizeUpdateSource(undefined, undefined), null);
  assert.deepEqual(normalizeUpdateSource(' https://gitlab.example.com/tools/token-monitor/ ', '42'), {
    host: 'gitlab.example.com',
    projectId: 42,
    releasesUrl: 'https://gitlab.example.com/tools/token-monitor/-/releases'
  });
  assert.equal(normalizeUpdateSource('https://git.example:8443/a/b', '7').host, 'git.example:8443');
  assert.throws(() => normalizeUpdateSource('https://git.example/a/b', ''), /set both or neither/);
  assert.throws(() => normalizeUpdateSource('', '42'), /set both or neither/);
  assert.throws(() => normalizeUpdateSource('not a url', '42'), /not a valid URL/);
  assert.throws(() => normalizeUpdateSource('http://git.example/a/b', '42'), /must use https/);
  assert.throws(() => normalizeUpdateSource('https://u:p@git.example/a/b', '42'), /credentials/);
  assert.throws(() => normalizeUpdateSource('https://git.example/a/b?x=1', '42'), /query or fragment/);
  assert.throws(() => normalizeUpdateSource('https://git.example/', '42'), /project page/);
  assert.throws(() => normalizeUpdateSource('https://git.example/a/b/-/releases', '42'), /project page/);
  assert.throws(() => normalizeUpdateSource('https://git.example/a/b', 'a%2Fb'), /numeric project ID/);
  assert.throws(() => normalizeUpdateSource('https://git.example/a/b', '0'), /numeric project ID/);
});

test('resolveClientConfig passes the update source on, and its Release pages to the entry', () => {
  const env = {
    TM_CLIENT_HUB_URL: 'https://hub.example',
    TM_CLIENT_SECRET: SECRET,
    TM_CLIENT_UPDATE_PROJECT_URL: 'https://gitlab.example.com/tools/token-monitor',
    TM_CLIENT_UPDATE_PROJECT_ID: '42'
  };
  const { defaults, update } = resolveClientConfig({ upstreamVersion: '0.63.1', env, envFile: NO_FILE });
  assert.deepEqual(update, {
    host: 'gitlab.example.com',
    projectId: 42,
    releasesUrl: 'https://gitlab.example.com/tools/token-monitor/-/releases'
  });
  assert.equal(defaults.releasesUrl, update.releasesUrl);

  const none = resolveClientConfig({ upstreamVersion: '0.63.1', env: { TM_CLIENT_HUB_URL: 'https://hub.example', TM_CLIENT_SECRET: SECRET }, envFile: NO_FILE });
  assert.equal(none.update, null);
  assert.equal('releasesUrl' in none.defaults, false);
});

test('the first launch writes connected settings; an existing settings.json is left alone', () => {
  tempDir((root) => {
    const dir = path.join(root, 'Token Monitor');
    const defaults = { hubUrl: 'https://hub.example', secret: SECRET, syncUploadIntervalMs: 1800000, startAtLogin: true };
    assert.equal(seedFirstRun({ dir, defaults, randomUUID: () => '11111111-2222-3333-4444-555555555555' }), true);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings, {
      deviceId: '11111111-2222-3333-4444-555555555555',
      hubMode: 'client',
      hubUrl: 'https://hub.example',
      secret: SECRET,
      syncUploadIntervalMs: 1800000,
      automaticAppUpdates: false,
      startAtLogin: true
    });
    assert.equal(fs.existsSync(path.join(dir, 'settings.json.tmp')), false);

    fs.writeFileSync(path.join(dir, 'settings.json'), '{"hubMode":"local"}\n');
    assert.equal(seedFirstRun({ dir, defaults }), false);
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{"hubMode":"local"}\n');
  });
});

test('the first launch makes a random device id and does nothing without build defaults', () => {
  tempDir((dir) => {
    assert.equal(seedFirstRun({ dir, defaults: null }), false);
    assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false);
    seedFirstRun({ dir, defaults: { hubUrl: 'https://hub.example', secret: SECRET, syncUploadIntervalMs: 0 } });
    const { deviceId } = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.match(deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

test('launch at login is turned on once per machine, also over an existing settings.json', () => {
  tempDir((dir) => {
    const stateFile = path.join(dir, 'corp-state.json');
    assert.equal(claimStartAtLogin({ dir, defaults: null }), false);
    assert.equal(claimStartAtLogin({ dir, defaults: { startAtLogin: false } }), false);
    assert.equal(fs.existsSync(stateFile), false);

    fs.writeFileSync(path.join(dir, 'settings.json'), '{"hubMode":"local"}\n');
    assert.equal(claimStartAtLogin({ dir, defaults: { startAtLogin: true } }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { startAtLoginApplied: true });
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{"hubMode":"local"}\n');
    // The user may turn it off afterwards; later launches leave it alone.
    assert.equal(claimStartAtLogin({ dir, defaults: { startAtLogin: true } }), false);
  });
});

// Electron's login item on Windows: one Run key value for the app, and
// openAtLogin only for exactly the path and args asked about.
function fakeWindowsLoginItem(runKey = null, enabled = true) {
  const calls = [];
  const app = {
    runKey,
    enabled,
    getLoginItemSettings(options = {}) {
      return {
        openAtLogin: this.runKey === ['app.exe', ...(options.args || [])].join(' '),
        executableWillLaunchAtLogin: this.runKey !== null && this.enabled
      };
    },
    setLoginItemSettings(settings) {
      calls.push(settings);
      this.runKey = settings.openAtLogin ? ['app.exe', ...(settings.args || [])].join(' ') : null;
      this.enabled = settings.enabled !== false;
    }
  };
  return { app, calls };
}

test('on Windows launch at login passes an argument the app reads back; elsewhere nothing is wrapped', () => {
  const { app } = fakeWindowsLoginItem();
  const { get } = installLoginLaunchArg({ app, platform: 'win32' });
  // Upstream's applyLoginItem() and currentLoginItemState().
  app.setLoginItemSettings({ openAtLogin: true });
  assert.equal(app.runKey, `app.exe ${LOGIN_LAUNCH_ARG}`);
  assert.equal(app.getLoginItemSettings().openAtLogin, true);
  assert.equal(get().openAtLogin, false);
  // A caller's own args are kept.
  app.setLoginItemSettings({ openAtLogin: true, args: ['--other'] });
  assert.equal(app.runKey, 'app.exe --other');
  app.setLoginItemSettings({ openAtLogin: false });
  assert.equal(app.runKey, null);

  for (const platform of ['darwin', 'linux']) {
    const other = fakeWindowsLoginItem().app;
    const { getLoginItemSettings, setLoginItemSettings } = other;
    assert.equal(installLoginLaunchArg({ app: other, platform }), null);
    assert.equal(other.getLoginItemSettings, getLoginItemSettings);
    assert.equal(other.setLoginItemSettings, setLoginItemSettings);
  }
});

test('a Run key from before the argument gets it, still turned off in Task Manager if it was', () => {
  const { app, calls } = fakeWindowsLoginItem('app.exe', false);
  const loginItem = installLoginLaunchArg({ app, platform: 'win32' });
  assert.equal(app.getLoginItemSettings().openAtLogin, false);
  assert.equal(tagLoginItem(loginItem), true);
  assert.equal(app.runKey, `app.exe ${LOGIN_LAUNCH_ARG}`);
  assert.equal(calls.at(-1).enabled, false);
  assert.equal(app.getLoginItemSettings().openAtLogin, true);
  // Already marked: nothing to do.
  assert.equal(tagLoginItem(loginItem), false);
  assert.equal(calls.length, 1);

  const on = fakeWindowsLoginItem('app.exe', true);
  assert.equal(tagLoginItem(installLoginLaunchArg({ app: on.app, platform: 'win32' })), true);
  assert.equal(on.calls.at(-1).enabled, true);

  // Launch at login off: no Run key is written.
  const off = fakeWindowsLoginItem();
  assert.equal(tagLoginItem(installLoginLaunchArg({ app: off.app, platform: 'win32' })), false);
  assert.deepEqual(off.calls, []);
});

test('the launch at login is told by the argument on Windows, by Electron on macOS, never on Linux', () => {
  const mac = (wasOpenedAtLogin) => ({ getLoginItemSettings: () => ({ wasOpenedAtLogin }) });
  assert.equal(launchedAtLogin({ app: null, argv: ['app.exe', LOGIN_LAUNCH_ARG], platform: 'win32' }), true);
  assert.equal(launchedAtLogin({ app: null, argv: ['app.exe'], platform: 'win32' }), false);
  assert.equal(launchedAtLogin({ app: mac(true), argv: [], platform: 'darwin' }), true);
  assert.equal(launchedAtLogin({ app: mac(false), argv: [], platform: 'darwin' }), false);
  assert.equal(launchedAtLogin({ app: mac(true), argv: [LOGIN_LAUNCH_ARG], platform: 'linux' }), false);
});

function fakeWindow() {
  const win = new EventEmitter();
  win.minimized = 0;
  win.isDestroyed = () => false;
  win.minimize = () => { win.minimized += 1; };
  return win;
}

test('the launch at login minimizes the first window after upstream shows it, once', () => {
  const app = new EventEmitter();
  const deferred = [];
  const runDeferred = () => deferred.splice(0).forEach((fn) => fn());
  assert.equal(minimizeAtLogin({ app, shouldMinimize: () => true, defer: (fn) => deferred.push(fn) }), true);
  const widget = fakeWindow();
  app.emit('browser-window-created', {}, widget);
  const later = fakeWindow();
  app.emit('browser-window-created', {}, later);
  // Not while upstream is still showing it: show() restores a minimized window.
  widget.emit('show');
  assert.equal(widget.minimized, 0);
  runDeferred();
  assert.equal(widget.minimized, 1);
  // Shown again by the user, or another window: left alone.
  widget.emit('show');
  later.emit('show');
  runDeferred();
  assert.equal(widget.minimized, 1);
  assert.equal(later.minimized, 0);

  for (const shouldMinimize of [() => false, () => { throw new Error('unreadable'); }]) {
    const other = new EventEmitter();
    minimizeAtLogin({ app: other, shouldMinimize, defer: (fn) => fn() });
    const win = fakeWindow();
    other.emit('browser-window-created', {}, win);
    win.emit('show');
    assert.equal(win.minimized, 0);
  }
});

test('tray-only mode, which keeps the widget hidden already, is told from settings.json', () => {
  const { normalizeTrayModeSettings } = require(upstream('src/electron/trayModeSettings.js'));
  tempDir((dir) => {
    const file = path.join(dir, 'settings.json');
    const inTray = () => startsInTray({ dir, normalize: normalizeTrayModeSettings });
    assert.equal(inTray(), false);
    fs.writeFileSync(file, JSON.stringify({ trayMode: true }));
    assert.equal(inTray(), true);
    // Upstream drops tray mode without a tray icon; the widget then shows.
    fs.writeFileSync(file, JSON.stringify({ trayMode: true, showTrayIcon: false }));
    assert.equal(inTray(), false);
    fs.writeFileSync(file, JSON.stringify({ hubMode: 'client' }));
    assert.equal(inTray(), false);
    fs.writeFileSync(file, '{');
    assert.equal(inTray(), false);
  });
});

test('an existing settings.json is connected to the hub once, the key going into credentials.json', () => {
  tempDir((dir) => {
    const defaults = { hubUrl: 'https://hub.example', secret: SECRET, syncUploadIntervalMs: 1800000 };
    const store = new CredentialStore(dir);
    const settingsFile = path.join(dir, 'settings.json');
    // Nothing to connect before upstream has written settings.json.
    assert.equal(applyHubOnce({ dir, defaults, store }), false);

    fs.writeFileSync(settingsFile, JSON.stringify({ hubMode: 'client', hubUrl: '', deviceId: 'pc-1', syncUploadIntervalMs: 0, secret: 'stale-secret-000000' }));
    store.writeDocument({ version: 1, credentials: { hub: { hostSecret: 'host-secret-0000000' } }, migrations: { settings: 1 } });
    assert.equal(applyHubOnce({ dir, defaults, store }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), {
      hubMode: 'client', hubUrl: 'https://hub.example', deviceId: 'pc-1', syncUploadIntervalMs: 1800000
    });
    assert.deepEqual(store.readDocument().credentials.hub, { hostSecret: 'host-secret-0000000', clientSecret: SECRET });
    assert.equal(store.settingsCredentials().secret, SECRET);

    // The user may point it elsewhere afterwards; later launches leave it alone.
    fs.writeFileSync(settingsFile, '{"hubMode":"local"}\n');
    assert.equal(applyHubOnce({ dir, defaults, store }), false);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{"hubMode":"local"}\n');
  });
});

test('a machine hosting the hub, or one just seeded, is only recorded', () => {
  const defaults = { hubUrl: 'https://hub.example', secret: SECRET, syncUploadIntervalMs: 1800000 };
  tempDir((dir) => {
    const store = new CredentialStore(dir);
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"hubMode":"host"}\n');
    assert.equal(applyHubOnce({ dir, defaults, store }), false);
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{"hubMode":"host"}\n');
    assert.equal(fs.existsSync(path.join(dir, 'credentials.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'corp-state.json'), 'utf8')).hubApplied, true);
  });
  tempDir((dir) => {
    seedFirstRun({ dir, defaults });
    const seeded = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
    assert.equal(applyHubOnce({ dir, defaults, store: new CredentialStore(dir), seeded: true }), false);
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), seeded);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'corp-state.json'), 'utf8')).hubApplied, true);
  });
});

test('keep above taskbar and the logo-only tray are set once per machine, also over an existing settings.json', () => {
  const BOTH = ['keepAboveTaskbarApplied', 'trayLogoApplied'];
  assert.deepEqual(SETTINGS_ONCE.map((step) => step.key), BOTH);
  tempDir((dir) => {
    const settingsFile = path.join(dir, 'settings.json');
    const stateFile = path.join(dir, 'corp-state.json');
    // Nothing to change before settings.json exists; the next launch tries again.
    assert.deepEqual(applySettingsOnce({ dir }), []);
    assert.equal(fs.existsSync(stateFile), false);

    fs.writeFileSync(settingsFile, JSON.stringify({ hubMode: 'client', keepAboveTaskbar: false, trayContent: 'tokens' }));
    fs.writeFileSync(stateFile, JSON.stringify({ hubApplied: true }));
    assert.deepEqual(applySettingsOnce({ dir }), BOTH);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), {
      hubMode: 'client', keepAboveTaskbar: true, trayContent: 'custom'
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), {
      hubApplied: true, keepAboveTaskbarApplied: true, trayLogoApplied: true
    });

    // The user may change them back afterwards; later launches leave them alone.
    fs.writeFileSync(settingsFile, '{"keepAboveTaskbar":false,"trayContent":"tokens"}\n');
    assert.deepEqual(applySettingsOnce({ dir }), []);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{"keepAboveTaskbar":false,"trayContent":"tokens"}\n');
  });
  tempDir((dir) => {
    // A first launch: the seeded settings get both.
    seedFirstRun({ dir, defaults: { hubUrl: 'https://hub.example', secret: SECRET, syncUploadIntervalMs: 1800000 } });
    assert.deepEqual(applySettingsOnce({ dir }), BOTH);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.equal(settings.keepAboveTaskbar, true);
    assert.equal(settings.trayContent, 'custom');
  });
  tempDir((dir) => {
    // Already on, or a tray text the user picked: only recorded.
    const kept = '{"keepAboveTaskbar":true,"trayContent":"limitsAllSessions"}\n';
    fs.writeFileSync(path.join(dir, 'settings.json'), kept);
    assert.deepEqual(applySettingsOnce({ dir }), []);
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), kept);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'corp-state.json'), 'utf8'));
    assert.deepEqual(BOTH.map((key) => state[key]), [true, true]);
  });
  tempDir((dir) => {
    // A step added in a later build runs once on a machine that had the others.
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"keepAboveTaskbar":false}\n');
    fs.writeFileSync(path.join(dir, 'corp-state.json'), '{"keepAboveTaskbarApplied":true}\n');
    assert.deepEqual(applySettingsOnce({ dir }), ['trayLogoApplied']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), {
      keepAboveTaskbar: false, trayContent: 'custom'
    });
  });
});

test('the builder config overrides only what the company build needs', () => {
  const config = createBuilderConfig({ base: UPSTREAM_PKG.build, version: '0.63.1-corp.1', platform: 'win', outputDir: '/out', crossBuild: true });
  assert.equal(config.extraMetadata.version, '0.63.1-corp.1');
  assert.equal(config.extraMetadata.main, CORP_MAIN);
  assert.ok(config.files.includes('corp/**/*'));
  for (const file of UPSTREAM_PKG.build.files) assert.ok(config.files.includes(file));
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(config.win.signtoolOptions.publisherName, null);
  assert.equal(config.win.verifyUpdateCodeSignature, false);
  assert.equal(config.publish, null);
  assert.equal(config.npmRebuild, false);
  assert.equal(config.mac, undefined);
  assert.equal(config.afterSign, undefined);
  assert.equal(config.appId, UPSTREAM_PKG.build.appId);
  assert.equal(config.nsis.include, UPSTREAM_PKG.build.nsis.include);
  assert.equal(config.nsis.artifactName, 'Token-Monitor_${version}_x64-setup.${ext}');
  assert.equal(config.directories.output, '/out');

  const mac = createBuilderConfig({ base: UPSTREAM_PKG.build, version: '0.63.1-corp.1', platform: 'mac', outputDir: '/out', crossBuild: false });
  assert.equal(mac.mac.forceCodeSigning, false);
  assert.equal(mac.mac.identity, '-');
  assert.equal(mac.mac.hardenedRuntime, false);
  assert.deepEqual(mac.mac.target, [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }]);
  assert.equal(mac.mac.artifactName, 'Token-Monitor_${version}_aarch64.${ext}');
  assert.equal(mac.mac.minimumSystemVersion, UPSTREAM_PKG.build.mac.minimumSystemVersion);
  assert.equal(mac.afterSign, MAC_AFTER_SIGN);
  assert.ok(fs.existsSync(MAC_AFTER_SIGN));
  assert.equal(mac.npmRebuild, undefined);

  const linux = createBuilderConfig({ base: UPSTREAM_PKG.build, version: '0.63.1-corp.1', platform: 'linux', outputDir: '/out', crossBuild: false });
  assert.deepEqual(linux.linux.target, [{ target: 'AppImage', arch: ['x64'] }]);
  assert.equal(linux.linux.artifactName, 'Token-Monitor_${version}_amd64.${ext}');
  assert.equal(linux.linux.category, UPSTREAM_PKG.build.linux.category);
  assert.equal(linux.mac, undefined);
  assert.equal(linux.afterSign, undefined);
  assert.equal(linux.npmRebuild, undefined);
});

// Squirrel.Mac installs an update only if it meets the running app's designated
// requirement, which for a plain ad-hoc signature is the build's own cdhash.
test('the mac app is signed again ad-hoc, with a designated requirement any later build meets', async () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === '--display') return { status: 0, stdout: 'designated => identifier "com.javis.tokenmonitor"\n', stderr: 'Executable=/out/mac-arm64/Token Monitor.app/Contents/MacOS/Token Monitor\n' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const context = { electronPlatformName: 'darwin', appOutDir: '/out/mac-arm64', packager: { appInfo: { id: UPSTREAM_PKG.build.appId, productFilename: 'Token Monitor' } } };
  const app = path.join('/out/mac-arm64', 'Token Monitor.app');
  assert.equal(await macAfterSign(context, { spawn }), true);
  assert.deepEqual(calls, [
    ['codesign', '--force', '--sign', '-', '--preserve-metadata=identifier,entitlements,flags', '--requirements', '=designated => identifier "com.javis.tokenmonitor"', app],
    ['codesign', '--verify', '--deep', '--strict', '--test-requirement', '=identifier "com.javis.tokenmonitor"', app],
    ['codesign', '--display', '--requirements', '-', app]
  ]);
  // electron-builder takes the default export, or a function named afterSign.
  assert.equal(macAfterSign.default, macAfterSign);

  // Still the cdhash (codesign shows an implicit requirement as a comment), or
  // codesign failing: the build stops rather than ship a Mac that never updates.
  const implicit = () => ({ status: 0, stdout: '# designated => cdhash H"0123abcd"\n', stderr: '' });
  await assert.rejects(macAfterSign(context, { spawn: implicit }), /kept another designated requirement/);
  const failing = () => ({ status: 1, stdout: '', stderr: 'invalid signature' });
  await assert.rejects(macAfterSign(context, { spawn: failing }), /codesign --force .* failed with exit code 1: invalid signature/);
  assert.throws(() => macAfterSign.designatedRequirement('com.x" or anchor apple'), /cannot go into a code requirement/);

  assert.equal(await macAfterSign({ ...context, electronPlatformName: 'win32' }, { spawn: failing }), false);
});

test('a logo of your own replaces upstream icons file for file, and only files upstream still has', () => {
  // Upstream's build block reads the app and installer icons from these paths.
  assert.equal(UPSTREAM_PKG.build.win.icon, 'assets/icon-win.png');
  assert.equal(UPSTREAM_PKG.build.mac.icon, 'assets/icon.png');
  assert.equal(UPSTREAM_PKG.build.linux.icon, 'assets/icon.png');
  assert.equal(ASSETS_SOURCE, path.join(ROOT, 'client', 'assets'));
  tempDir((dir) => {
    const app = path.join(dir, 'app');
    const brand = path.join(dir, 'brand');
    fs.cpSync(upstream('assets'), path.join(app, 'assets'), { recursive: true });
    // No logo of your own: upstream's icons stay.
    assert.deepEqual(overlayAssets(app, brand), []);

    const logo = { 'icon-win.png': 'win', 'icon.png': 'app', 'icons/token-monitor.svg': '<svg/>', 'icons/tray-token-monitor.png': 'tray' };
    for (const [file, text] of Object.entries(logo)) {
      fs.mkdirSync(path.dirname(path.join(brand, file)), { recursive: true });
      fs.writeFileSync(path.join(brand, file), text);
    }
    const files = overlayAssets(app, brand);
    assert.deepEqual(files, Object.keys(logo));
    for (const file of files) assert.equal(fs.readFileSync(path.join(app, 'assets', file), 'utf8'), logo[file], file);
    fs.rmSync(path.join(app, 'assets', 'icon-win.png'));
    assert.throws(() => overlayAssets(app, brand), /upstream has no assets\/icon-win\.png/);
  });
});

// When this fails after an upstream update, re-read deviceLabel() in upstream's
// renderer app.js and update UPSTREAM_PATCHES in packaging/build-client.js.
test('the devices list names a device by its hostname before its id', () => {
  const file = 'src/electron/renderer/app.js';
  const patches = UPSTREAM_PATCHES.filter((patch) => patch.file === file);
  tempDir((dir) => {
    const target = path.join(dir, ...file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(upstream(file), target);
    assert.deepEqual(patchUpstream(dir, patches), [file]);
    const source = fs.readFileSync(target, 'utf8');
    const body = source.slice(source.indexOf('function deviceLabel('), source.indexOf('function deviceColor('));
    const deviceLabel = new Function(`${body}\nreturn deviceLabel;`)();
    assert.equal(deviceLabel({ deviceId: '6f1c0d2e-uuid', hostname: 'MARK-PC' }), 'MARK-PC');
    assert.equal(deviceLabel({ deviceId: '6f1c0d2e-uuid', hostname: '' }), '6f1c0d2e-uuid');
    assert.equal(deviceLabel({}), 'device');
    // Patched once: the line it looks for is gone now.
    assert.throws(() => patchUpstream(dir, patches), /app\.js has 0 copies of .*UPSTREAM_PATCHES/);
  });
});

// When this fails after an upstream update, re-read the App Updates header in
// upstream's renderer (index.html, i18n.js, app.js) and update UPSTREAM_PATCHES.
test('the App Updates header names the GitLab Release as the update source and links to it', () => {
  const files = ['src/electron/renderer/app.js', 'src/electron/renderer/index.html', 'src/electron/renderer/i18n.js'];
  const read = (dir, file) => fs.readFileSync(path.join(dir, ...file.split('/')), 'utf8');
  tempDir((dir) => {
    for (const file of files) {
      const target = path.join(dir, ...file.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(upstream(file), target);
    }
    assert.deepEqual(patchUpstream(dir, UPSTREAM_PATCHES), files);
    const text = files.map((file) => read(dir, file)).join('\n');
    assert.doesNotMatch(text, /GitHub releases/);
    // The page's text and each language's.
    assert.equal(text.split('GitLab releases').length - 1, 6);
    // A link inside the header's own span, so it keeps the header's styling.
    assert.match(
      read(dir, 'src/electron/renderer/index.html'),
      /<span data-i18n="settings\.appUpdate\.title">App Updates<\/span><span><button id="appUpdateSourceLink" type="button" class="inline-link" data-i18n="settings\.appUpdate\.source">GitLab releases<\/button><\/span><\/div>/
    );

    // Clicked, it opens upstream's Releases page: on main.js's allowlist, and
    // swapped for the GitLab Releases by the company entry.
    const app = read(dir, 'src/electron/renderer/app.js');
    const lines = app.split('\n');
    const body = [
      lines.find((line) => line.startsWith('const TOKEN_MONITOR_REPOSITORY_URL = ')),
      lines.find((line) => line.includes("getElementById('appUpdateSourceLink')"))
    ].join('\n');
    let onClick;
    const opened = [];
    const document = { getElementById: (id) => (id === 'appUpdateSourceLink' ? { addEventListener: (type, fn) => { if (type === 'click') onClick = fn; } } : null) };
    const window = { tokenMonitor: { openExternal: (url) => opened.push(url) } };
    new Function('document', 'window', body)(document, window);
    onClick();
    assert.deepEqual(opened, ['https://github.com/Javis603/token-monitor/releases']);
    const releases = 'https://gitlab.example.com/tools/token-monitor/-/releases';
    assert.equal(corpReleasePageUrl(opened[0], releases), releases);
    assert.match(
      fs.readFileSync(upstream('src/electron/main.js'), 'utf8'),
      /if \(parsed\.hostname === 'github\.com' && parsed\.pathname\.startsWith\('\/Javis603\/token-monitor'\)\) return true;/
    );

    assert.throws(() => patchUpstream(dir, UPSTREAM_PATCHES), /has 0 copies of .*; UPSTREAM_PATCHES/);
  });
  // Found more or fewer times than the patch says: the build stops.
  tempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'x.js'), 'a\na\n');
    assert.throws(() => patchUpstream(dir, [{ file: 'x.js', from: 'a', to: 'b' }]), /x\.js has 2 copies of "a", not 1/);
    assert.throws(() => patchUpstream(dir, [{ file: 'x.js', from: 'a', to: 'b', count: 3 }]), /x\.js has 2 copies of "a", not 3/);
    assert.deepEqual(patchUpstream(dir, [{ file: 'x.js', from: 'a', to: '$&b', count: 2 }]), ['x.js']);
    assert.equal(fs.readFileSync(path.join(dir, 'x.js'), 'utf8'), '$&b\n$&b\n');
  });
});

test('the Windows icon is your .ico when there is one, upstream\'s otherwise', () => {
  assert.equal(WIN_ICON, path.join(ROOT, 'client', 'build', 'icon-win.ico'));
  for (const platform of ['win', 'linux']) {
    const build = (winIcon) => createBuilderConfig({ base: UPSTREAM_PKG.build, version: '0.63.1-corp.1', platform, outputDir: '/out', crossBuild: false, winIcon });
    assert.equal(build(null).win.icon, UPSTREAM_PKG.build.win.icon);
    assert.equal(build('/brand/icon-win.ico').win.icon, '/brand/icon-win.ico');
  }
  tempDir((dir) => {
    const ico = path.join(dir, 'icon-win.ico');
    assert.equal(brandWinIcon(ico), null);
    fs.writeFileSync(ico, '');
    assert.equal(brandWinIcon(ico), ico);
  });
});

test('the company entry goes into corp/ with the files next to it', () => {
  tempDir((dir) => {
    writeCorpFiles(dir, { hubUrl: 'https://hub.example' });
    assert.deepEqual(fs.readdirSync(path.join(dir, 'corp')).sort(), [...fs.readdirSync(path.join(ROOT, 'client', 'electron')), 'corp-defaults.json'].sort());
    assert.ok(fs.existsSync(path.join(dir, 'corp', 'main.js')));
    assert.ok(fs.existsSync(path.join(dir, 'corp', 'ownDeviceView.js')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'corp', 'corp-defaults.json'), 'utf8')).hubUrl, 'https://hub.example');
  });
});

test('the title mark is drawn as the logo on the app pages only', async () => {
  const png = Buffer.from('logo');
  const css = titleLogoCss(png);
  assert.match(css, /^\.shell\.title-collapsed \.app-title-mark, \.shell\.title-icon-only \.app-title-mark \{/);
  assert.match(css, /color: transparent !important;/);
  assert.ok(css.includes(`url("data:image/png;base64,${png.toString('base64')}")`));

  const handlers = {};
  const app = { on: (name, fn) => { handlers[name] = fn; } };
  assert.equal(installTitleLogo({ app, png: null }), false);
  assert.equal(installTitleLogo({ app, png }), true);
  const page = (url) => {
    const contents = { inserted: [], getURL: () => url, insertCSS: async (text) => { contents.inserted.push(text); }, on: (name, fn) => { contents[name] = fn; } };
    handlers['web-contents-created']({}, contents);
    contents['dom-ready']();
    return contents.inserted;
  };
  assert.deepEqual(page('file:///C:/app/src/electron/renderer/index.html'), [css]);
  assert.deepEqual(page('https://claude.ai/login'), []);
});

// The title logo covers upstream's Σ mark. When this fails after an upstream
// update, re-read the titlebar in index.html and styles.css and adjust
// titleLogoCss() in client/electron/main.js.
test('upstream still draws the title mark the logo covers', () => {
  const html = fs.readFileSync(upstream('src/electron/renderer/index.html'), 'utf8');
  const css = fs.readFileSync(upstream('src/electron/renderer/styles.css'), 'utf8');
  const app = fs.readFileSync(upstream('src/electron/renderer/app.js'), 'utf8');
  assert.ok(html.includes('<span class="app-title-mark" aria-hidden="true">Σ</span>'));
  assert.ok(css.includes('.shell.title-collapsed .app-title-mark, .shell.title-icon-only .app-title-mark {\n  display: inline;'));
  // The mark, not the words "Token Monitor", is what a new install shows.
  assert.match(app, /const defaultAppearance = \{[^}]*titleIconOnly: true/);
});

test('Windows, macOS and Linux builds update from the newest GitLab Release; unconfigured builds do not', () => {
  const update = { host: 'gitlab.example.com', projectId: 42, releasesUrl: 'https://gitlab.example.com/g/p/-/releases' };
  const expected = [{ provider: 'gitlab', host: 'gitlab.example.com', projectId: 42, channel: 'latest' }];
  for (const platform of ['win', 'mac', 'linux']) {
    const config = createBuilderConfig({ base: UPSTREAM_PKG.build, version: '0.63.1-corp.3', platform, outputDir: '/out', crossBuild: false, update });
    // channel `latest`: a -corp.N version would otherwise make electron-builder
    // write corp.yml, which the Release does not link.
    assert.deepEqual(config.publish, expected, platform);
    assert.equal(config.releaseInfo, undefined, platform);
  }
  for (const platform of ['win', 'mac', 'linux']) {
    assert.equal(createBuilderConfig({ base: UPSTREAM_PKG.build, version: '0.63.1-corp.3', platform, outputDir: '/out', crossBuild: false }).publish, null, platform);
  }
  assert.equal(updatePublishConfig(null), null);
  // Unsigned installers: a publisher check would reject every update.
  const win = createBuilderConfig({ base: UPSTREAM_PKG.build, version: '0.63.1-corp.3', platform: 'win', outputDir: '/out', crossBuild: true, update });
  assert.equal(win.win.verifyUpdateCodeSignature, false);
  assert.equal(win.win.signtoolOptions.publisherName, null);
});

test('the release page of a company update and the Releases list open on GitLab; other links are left alone', () => {
  const releases = 'https://gitlab.example.com/tools/token-monitor/-/releases';
  assert.equal(
    corpReleasePageUrl('https://github.com/Javis603/token-monitor/releases/tag/v0.63.1-corp.3', releases),
    `${releases}/client-v0.63.1-corp.3`
  );
  assert.equal(corpReleasePageUrl('https://github.com/Javis603/token-monitor/releases', releases), releases);
  assert.equal(corpReleasePageUrl('https://github.com/Javis603/token-monitor/releases/', releases), releases);
  assert.equal(
    corpReleasePageUrl('https://github.com/Javis603/token-monitor/releases/tag/v0.63.1-corp.3%2B', releases),
    'https://github.com/Javis603/token-monitor/releases/tag/v0.63.1-corp.3%2B'
  );
  for (const url of [
    'https://github.com/Javis603/token-monitor/releases/tag/v0.64.0',
    'https://github.com/Javis603/token-monitor/releases/tag/v0.64.0-beta.1',
    'https://github.com/Javis603/token-monitor',
    'https://github.com/Javis603/token-monitor/releases/latest',
    'https://github.com/Javis603/token-monitor/releases?q=x',
    'https://example.com/releases/tag/v0.63.1-corp.3',
    'https://github.com/Javis603/token-monitor/releases/tag/%E0%A4%A'
  ]) assert.equal(corpReleasePageUrl(url, releases), url);

  const opened = [];
  const shell = { openExternal(url, options) { opened.push([url, options]); return Promise.resolve(); } };
  assert.equal(installReleasePageRedirect({ shell, releasesUrl: undefined }), false);
  assert.equal(installReleasePageRedirect({ shell, releasesUrl: releases }), true);
  shell.openExternal('https://github.com/Javis603/token-monitor/releases/tag/v0.63.1-corp.3', { activate: true });
  shell.openExternal('https://github.com/Javis603/token-monitor', undefined);
  assert.deepEqual(opened, [
    [`${releases}/client-v0.63.1-corp.3`, { activate: true }],
    ['https://github.com/Javis603/token-monitor', undefined]
  ]);
});

test('an update upstream found outside the company feed is forgotten', () => {
  tempDir((dir) => {
    const file = path.join(dir, 'settings.json');
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    // No settings.json, an unreadable one, or nothing cached: left alone.
    assert.equal(dropUpstreamUpdateCache({ dir }), false);
    fs.writeFileSync(file, '{not json');
    assert.equal(dropUpstreamUpdateCache({ dir }), false);
    fs.writeFileSync(file, JSON.stringify({ hubMode: 'client' }));
    assert.equal(dropUpstreamUpdateCache({ dir }), false);

    // A GitHub release: dropped with the time of its check, the rest kept.
    const github = { version: '0.64.0', tag: 'v0.64.0', htmlUrl: 'https://github.com/Javis603/token-monitor/releases/tag/v0.64.0' };
    fs.writeFileSync(file, JSON.stringify({
      hubMode: 'client',
      automaticAppUpdates: false,
      appUpdate: { lastCheckedAt: '2026-10-01T09:25:52.918Z', lastKnownLatest: github, dismissedVersion: null }
    }));
    assert.equal(dropUpstreamUpdateCache({ dir }), true);
    assert.deepEqual(read(), {
      hubMode: 'client',
      automaticAppUpdates: false,
      appUpdate: { lastCheckedAt: null, lastKnownLatest: null, dismissedVersion: null }
    });
    assert.equal(dropUpstreamUpdateCache({ dir }), false);

    // A company version is what the feed gives: kept. A dismissed upstream one goes.
    const kept = {
      lastCheckedAt: '2026-10-01T12:00:00.000Z',
      lastKnownLatest: { version: '0.63.1-corp.6', tag: 'v0.63.1-corp.6' },
      dismissedVersion: '0.63.1-corp.5'
    };
    fs.writeFileSync(file, JSON.stringify({ appUpdate: kept }));
    assert.equal(dropUpstreamUpdateCache({ dir }), false);
    assert.deepEqual(read(), { appUpdate: kept });
    fs.writeFileSync(file, JSON.stringify({ appUpdate: { ...kept, dismissedVersion: '0.64.0' } }));
    assert.equal(dropUpstreamUpdateCache({ dir }), true);
    assert.deepEqual(read(), { appUpdate: { ...kept, dismissedVersion: null } });
  });
});

test('on Linux, launch at login follows an AppImage that an update replaced', () => {
  const linuxAutostart = require(upstream('src/electron/linuxAutostart.js'));
  for (const file of ['/home/x/Applications/Token-Monitor-0.63.1-corp.3.AppImage', '/home/a "b"/$c `d` 100%\\e.AppImage', 'C:\\tmp\\x.AppImage']) {
    const exec = linuxAutostart.desktopFileContents(file).split('\n').find((line) => line.startsWith('Exec='));
    assert.equal(autostartExecPath(exec), file);
  }
  assert.equal(autostartExecPath('Exec=/usr/bin/token-monitor'), null);
  assert.equal(autostartExecPath(undefined), null);

  tempDir((dir) => {
    const oldImage = path.join(dir, 'Token-Monitor-0.63.1-corp.3.AppImage');
    const newImage = path.join(dir, 'Token-Monitor-0.63.1-corp.4.AppImage');
    fs.writeFileSync(oldImage, '');
    fs.writeFileSync(newImage, '');
    const oldEnv = { APPIMAGE: oldImage, XDG_CONFIG_HOME: dir };
    const env = { APPIMAGE: newImage, XDG_CONFIG_HOME: dir };
    // No entry, or not running as an AppImage: launch at login stays as it is.
    assert.equal(followAppImageAutostart({ linuxAutostart, env }), false);
    assert.equal(followAppImageAutostart({ linuxAutostart, env: { XDG_CONFIG_HOME: dir } }), false);
    assert.equal(linuxAutostart.isAutostartEnabled({ env }), false);

    assert.equal(linuxAutostart.setAutostartEnabled(true, { env: oldEnv }), true);
    // The entry's AppImage is still there (the user keeps two): left alone.
    assert.equal(followAppImageAutostart({ linuxAutostart, env }), false);
    assert.equal(linuxAutostart.isAutostartEnabled({ env: oldEnv }), true);
    // The update deleted it: the entry now starts the running AppImage.
    fs.rmSync(oldImage);
    assert.equal(followAppImageAutostart({ linuxAutostart, env }), true);
    assert.equal(linuxAutostart.isAutostartEnabled({ env }), true);
    assert.equal(followAppImageAutostart({ linuxAutostart, env }), false);
  });
});

test('a cross-OS Windows build adds the locked win32-x64 runtime packages', () => {
  const lock = JSON.parse(fs.readFileSync(upstream('package-lock.json'), 'utf8'));
  const names = targetPlatformPackages(lock, { os: 'win32', cpu: 'x64' }).map((pkg) => pkg.name).sort();
  // koffi's native module and the tokscale binary: without them the Windows
  // app made on Linux cannot load koffi or collect usage.
  assert.ok(names.includes('@koromix/koffi-win32-x64'), names.join(', '));
  assert.ok(names.includes('@tokscale/cli-win32-x64-msvc'), names.join(', '));
  assert.ok(names.every((name) => !/arm64|ia32/.test(name)), names.join(', '));
});

test('the build takes --platform win, mac or linux', () => {
  assert.deepEqual(parseCli(['--platform', 'win', '--dry-run']), { platform: 'win', dryRun: true, keepWork: false });
  assert.equal(parseCli(['--platform=mac']).platform, 'mac');
  assert.equal(parseCli(['--platform', 'linux']).platform, 'linux');
  assert.throws(() => parseCli([]), /usage/);
  assert.throws(() => parseCli(['--platform', 'freebsd']), /usage/);
  assert.throws(() => parseCli(['--platform', 'win', '--secret', 'x']), /unexpected argument/);
});

// The seams in upstream this build relies on. When one of these fails after an
// upstream update, re-read upstream and adjust client/ and packaging/.
test('upstream still has the seams the company client relies on', () => {
  const main = fs.readFileSync(upstream('src/electron/main.js'), 'utf8');
  // The Run key is named after this id; the company entry turns autostart on
  // after upstream sets it.
  assert.match(main, /app\.setAppUserModelId\('com\.javis\.tokenmonitor'\)/);
  // startAtLogin is read back from the OS at startup, so seeding it alone does
  // nothing; the entry calls setLoginItemSettings itself.
  assert.match(main, /function syncLoginItemSettingFromOs\(\)/);
  // Launch at login is set and read without args, through `app` at each call,
  // and nowhere else; the entry adds its argument (installLoginLaunchArg()).
  assert.match(main, /app\.setLoginItemSettings\(\{ openAtLogin: Boolean\(startAtLogin\) \}\);/);
  assert.match(main, /try \{ return Boolean\(app\.getLoginItemSettings\(\)\.openAtLogin\); \}/);
  assert.equal(main.match(/LoginItemSettings\(/g).length, 2);
  // The widget is the first window made, and the login item is read back after
  // the entry's ready handler rewrote it. A tray-mode start does not show the
  // widget; minimizing it stops the keep-above-taskbar keeper.
  assert.match(main, /applyMacActivationPolicy\(\);\n {2}createWindow\(\);\n {2}syncLoginItemSettingFromOs\(\);/);
  assert.match(main, /if \(settings\?\.trayMode\) return; \/\/ stay hidden until tray click/);
  assert.match(main, /win\.on\('minimize', stopTaskbarZOrderKeeper\);/);
  assert.equal(typeof require(upstream('src/electron/trayModeSettings.js')).normalizeTrayModeSettings, 'function');
  // A settings.json without hubMode falls back to local; the seed writes it.
  assert.match(main, /if \(saved\.hubMode === undefined\)/);
  // The seeded secret moves into credentials.json.
  assert.match(main, /store\.migrateLegacySettings\(saved\)/);
  // Keep above taskbar is off by default and read from settings.json, where
  // the entry turns it on; it acts only on Windows in floating mode.
  assert.match(main, /keepAboveTaskbar: false,/);
  assert.match(main, /if \(saved\.keepAboveTaskbar !== undefined\) \{\n {6}merged\.keepAboveTaskbar = parseBoolean\(saved\.keepAboveTaskbar, false\);/);
  const { taskbarZOrderEnabled } = require(upstream('src/electron/windowsTaskbarZOrder.js'));
  assert.equal(taskbarZOrderEnabled({ windowBehavior: 'floating', keepAboveTaskbar: true }, 'win32'), true);
  // The tray text defaults to Tokens Today; the entry picks custom, whose
  // default layout is the app mark alone, shown without a title.
  assert.match(main, /trayContent: 'tokens',\n {4}trayCustomLayout: createDefaultTrayLayout\(\),/);
  assert.match(main, /const TRAY_CONTENT_VALUES = new Set\(\[[^\]]*'custom'[^\]]*\]\);/);
  assert.match(main, /const text = trayImageMode \|\| customImageMode \? '' : limitText;/);
  const { createDefaultTrayLayout } = require(upstream('src/shared/trayLayout.js'));
  assert.deepEqual(createDefaultTrayLayout().items.map((item) => [item.style, item.icon]), [['appIcon', 'app']]);
  // credentials.json wins over settings.json, so an existing install gets its
  // key written there, at the client secret's path.
  assert.match(main, /\{ \.\.\.defaults, \.\.\.saved, \.\.\.storedCredentials \}/);
  assert.deepEqual(CREDENTIAL_SETTING_PATHS.secret, ['hub', 'clientSecret']);
  assert.equal(UPSTREAM_PKG.build.productName, 'Token Monitor');
  assert.equal(UPSTREAM_PKG.build.appId, 'com.javis.tokenmonitor');

  const { SYNC_UPLOAD_INTERVAL_OPTIONS } = require(upstream('src/shared/syncUploadInterval.js'));
  assert.deepEqual([...SYNC_UPLOAD_INTERVAL_OPTIONS], [0, 600000, 1200000, 1800000]);
  const { sharedDataDir } = require(upstream('src/shared/config.js'));
  assert.equal(path.basename(sharedDataDir({ env: {}, platform: 'win32', homeDir: 'C:\\Users\\x' })), 'Token Monitor');
  // On Linux the entry seeds app.getPath('appData') (~/.config) too.
  assert.equal(sharedDataDir({ env: {}, platform: 'linux', homeDir: '/home/x' }), path.join('/home/x', '.config', 'Token Monitor'));

  // Linux launch at login: the entry turns on upstream's XDG autostart entry,
  // which upstream reads back at startup.
  assert.match(main, /if \(process\.platform === 'linux'\) return linuxAutostart\.isAutostartEnabled\(\);/);
  const linuxAutostart = require(upstream('src/electron/linuxAutostart.js'));
  assert.equal(typeof linuxAutostart.setAutostartEnabled, 'function');
});

// The updater path the company build points at GitLab. When one of these fails
// after an upstream update, re-read upstream's updater and adjust
// packaging/build-client.js, client/electron/main.js and .gitlab-ci.yml.
test('upstream still has the updater seams the GitLab update source relies on', () => {
  const main = fs.readFileSync(upstream('src/electron/main.js'), 'utf8');
  const appUpdater = fs.readFileSync(upstream('src/shared/appUpdater.js'), 'utf8');
  // A packaged app asks electron-updater, which reads resources/app-update.yml.
  assert.match(main, /const \{ autoUpdater \} = require\('electron-updater'\);/);
  assert.match(main, /if \(!app\.isPackaged\) return checkLatestRelease\(app\.getVersion\(\)\);[\s\S]{0,200}await autoUpdater\.checkForUpdates\(\);/);
  // electron-updater's gitlab provider (releases/permalink/latest, assets by
  // link name) is there from 6.8 on; 6.8.9 is the one verified.
  const [major, minor] = UPSTREAM_PKG.dependencies['electron-updater'].replace(/^[^\d]*/, '').split('.').map(Number);
  assert.ok(major > 6 || (major === 6 && minor >= 8), UPSTREAM_PKG.dependencies['electron-updater']);
  // The release page: client-v… is not a tag upstream reads, so it builds the
  // GitHub URL of v<version>, which passes the allowlist and the entry swaps.
  assert.match(appUpdater, /const GITHUB_REPO = 'Javis603\/token-monitor';/);
  assert.match(appUpdater, /const stripped = trimmed\.replace\(\/\^v\/i, ''\);/);
  assert.match(appUpdater, /const tag = infoTag \|\| `v\$\{version\}`;/);
  assert.match(appUpdater, /htmlUrl: `https:\/\/github\.com\/\$\{GITHUB_REPO\}\/releases\/tag\/\$\{encodeURIComponent\(tag\)\}`/);
  assert.match(main, /parsed\.hostname === 'github\.com' && parsed\.pathname\.startsWith\('\/Javis603\/token-monitor'\)/);
  assert.match(main, /if \(isAllowedExternalUrl\(url\)\) shell\.openExternal\(url\);/);
  // What the entry drops (dropUpstreamUpdateCache()): settings.json appUpdate
  // keeps the newest version found and the time of that check, and without a
  // check time the next check runs at once.
  assert.match(main, /const latest = block\.lastKnownLatest \|\| null;/);
  assert.match(main, /const dismissedVersion = block\.dismissedVersion \|\| null;/);
  assert.match(main, /lastCheckedAt: block\.lastCheckedAt,/);
  assert.match(appUpdater, /if \(force \|\| !lastCheckedAt\) return false;/);
});

// latest.yml names the installer after its artifactName, and the installed app
// downloads the Release link of that name, so the Release must link every
// installer under the name the build gives it. The notes list the same files.
test('the Release links, checks and lists the installers under the names the build gives them', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.gitlab-ci.yml'), 'utf8');
  const notes = fs.readFileSync(path.join(ROOT, 'packaging', 'client-release-notes.md'), 'utf8');
  const downloads = { win: 'windows', mac: 'macos', linux: 'linux' };
  for (const [platform, filepath] of Object.entries(downloads)) {
    const file = installerFileName(platform, '${CLIENT_VERSION}');
    assert.ok(ci.includes(`- name: "${file}"\n`), `${file} is a Release link`);
    assert.ok(ci.includes(`/packages/generic/token-monitor-client/\${CLIENT_VERSION}/${file}"\n          filepath: /${filepath}\n`), `${file} links to its package file at /${filepath}`);
    assert.ok(notes.includes(`[${installerFileName(platform, '@VERSION@')}](@DOWNLOADS@/${filepath})`), `the notes list ${file}`);
  }
  assert.ok(ci.includes(`check_update_info latest.yml "${installerFileName('win', '${CLIENT_VERSION}')}"`));
  assert.ok(ci.includes(`check_update_info latest-linux.yml "${installerFileName('linux', '${CLIENT_VERSION}')}"`));
  // A Mac updates from the zip the mac build makes next to the dmg, which
  // latest-mac.yml lists under files:.
  const zip = installerFileName('mac', '${CLIENT_VERSION}').replace(/\.dmg$/, '.zip');
  assert.ok(ci.includes(`check_update_info latest-mac.yml "${zip}" "  - url"`));
  assert.ok(ci.includes(`- name: "${zip}"\n          url: "\${CI_API_V4_URL}/projects/\${CI_PROJECT_ID}/packages/generic/token-monitor-client/\${CLIENT_VERSION}/${zip}"\n`));
  for (const yml of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) {
    assert.ok(ci.includes(`- name: ${yml}\n          url: "\${CI_API_V4_URL}/projects/\${CI_PROJECT_ID}/packages/generic/token-monitor-client/\${CLIENT_VERSION}/${yml}"\n`), `${yml} is a Release link`);
  }
  assert.ok(ci.includes('- dist/client/*.zip\n'), 'the mac build keeps its zip');
  assert.match(ci, /for file in [^;]*dist\/client\/\*\.zip[^;]*; do/);
  assert.equal(installerFileName('win', '0.63.1-corp.4'), 'Token-Monitor_0.63.1-corp.4_x64-setup.exe');
});

// The Release notes are in Chinese, then in English after `# English`, which
// the first line links to. Both halves give the same downloads, links and
// versions, so what changes in one half changes in the other too.
test('the Release notes say the same in Chinese and in English', () => {
  const notes = fs.readFileSync(path.join(ROOT, 'packaging', 'client-release-notes.md'), 'utf8');
  const [top, ...rest] = notes.split('\n');
  assert.equal(top, '[English version ↓](#english)');
  const halves = rest.join('\n').split('\n# English\n');
  assert.equal(halves.length, 2, 'the notes have one English half');
  const [zh, en] = halves;
  assert.doesNotMatch(en, /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/, 'the English half has no Chinese');
  // Each half opens the install page in its own language (hub/install.html).
  const installLinks = (text) => [...text.matchAll(/\(@INSTALL@([^)]*)\)/g)].map((match) => match[1]);
  assert.ok(installLinks(zh).length >= 4);
  assert.deepEqual(installLinks(zh).filter((link) => !link.startsWith('?lang=zh-TW')), []);
  assert.deepEqual(installLinks(en).filter((link) => !link.startsWith('?lang=en')), []);
  const facts = (text) => [...text.matchAll(/^ *```[\s\S]*?^ *```|`[^`\n]+`|\]\([^)]+\)|\d+\.\d+\.\d+-corp\.\d+|\*\*@VERSION@\*\*/gm)]
    .map((match) => match[0].replace(/^ +/gm, '').replace(/\?lang=[\w-]+/, '?lang='))
    .sort();
  assert.ok(facts(zh).length >= 8);
  assert.deepEqual(facts(en), facts(zh));
});

// The Release notes leave the steps to the hub's /install page
// (hub/install.html): they link to its tab for each computer, at the hub the
// build connects to. The page names the same files and has every step, in
// Chinese and in English.
test('the Release notes link to the hub\'s install page, which has the installers and steps', () => {
  const page = fs.readFileSync(path.join(ROOT, 'hub', 'install.html'), 'utf8');
  const notes = fs.readFileSync(path.join(ROOT, 'packaging', 'client-release-notes.md'), 'utf8');
  const ci = fs.readFileSync(path.join(ROOT, '.gitlab-ci.yml'), 'utf8');
  const { DOWNLOAD_NAMES, pageSettings } = require('../hub/server');
  const downloads = pageSettings({ TOKEN_MONITOR_CLIENT_DOWNLOAD_URL: 'https://git.example.test/g/p/-/releases' }).downloads;
  assert.deepEqual(Object.keys(downloads), [...DOWNLOAD_NAMES]);
  for (const [platform, filepath] of Object.entries({ win: 'windows', mac: 'macos', linux: 'linux' })) {
    assert.ok(ci.includes(`filepath: /${filepath}\n`), `${filepath} is a Release link`);
    assert.equal(downloads[filepath], `https://git.example.test/g/p/-/releases/permalink/latest/downloads/${filepath}`);
    assert.ok(page.includes(`id="dl-${filepath}"`), `the page has a ${filepath} button`);
    assert.ok(page.includes(installerFileName(platform, '&lt;版本&gt;')), `the page names ${installerFileName(platform, '<版本>')}`);
    assert.ok(page.includes(`data-os="${filepath}"`), `the page has a ${filepath} tab`);
    for (const lang of ['zh-TW', 'en']) {
      assert.ok(notes.includes(`](@INSTALL@?lang=${lang}#${filepath})`), `the notes link to the page's ${filepath} tab in ${lang}`);
    }
  }
  for (const phrase of ['「其他資訊」→「仍要執行」', '檔案總管的「下載」資料夾', '「在資料夾中顯示」', '不要在瀏覽器的下載清單直接點開它', '保持勾選「執行 Token Monitor」', '「強制打開」', '要打開『Token Monitor』嗎？', '「丟到垃圾桶」', '往下捲到最底的「安全性」', '（Open Anyway）', 'xattr -dr com.apple.quarantine "/Applications/Token Monitor.app"', 'xattr -cr "/Applications/Token Monitor.app"',
    'chmod +x', 'sudo apt install libfuse2</code>', 'sudo apt install libfuse2t64', '關於這台 Mac', '沒有設定更新來源的舊版本',
    'click "More info" → "Run anyway"', '"Show in folder"', 'keep "Run Token Monitor" checked', 'click "Done" on the left', '"Move to Trash"', 'click "Open Anyway"', '"About This Mac"', 'Older versions built without an update source']) {
    assert.ok(page.includes(phrase) || page.includes(phrase.replace(/<\/?code>/g, '')), `the page says ${phrase}`);
  }
  // Every placeholder in the notes is one the Release fills in, @INSTALL@ from
  // the hub URL each build writes to client.env.
  assert.ok(ci.includes('- echo "INSTALL_URL=${TM_CLIENT_HUB_URL%/}/install" >> client.env\n'));
  const filled = [...ci.matchAll(/-e "s\|@([A-Z]+)@\|/g)].map((match) => match[1]);
  assert.deepEqual(filled, ['VERSION', 'DOWNLOADS', 'INSTALL']);
  assert.deepEqual([...new Set([...notes.matchAll(/@([A-Z]+)@/g)].map((match) => match[1]))].sort(), [...filled].sort());
  assert.ok(ci.includes('-e "s|@INSTALL@|${INSTALL_URL}|g"'));
  assert.ok(ci.includes(`if grep -n '@[A-Z][A-Z]*@' release-notes.md; then`), 'the Release stops on a placeholder left');
});

// electron-builder fetches Electron from github.com on every build. A runner
// without DNS for a while gets more tries; any other failure gets none.
test('electron-builder is tried again on a network error, and only on one', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const runs = (...results) => () => Promise.resolve(results.shift());
  const label = 'npx electron-builder';
  const offline = { status: 1, output: '  ⨯ getaddrinfo ENOTFOUND github.com  failedTask=build stackTrace=RequestError' };

  await retryOnNetworkError(runs(offline, offline, { status: 0, output: '' }), { label, sleep });
  assert.deepEqual(waits, NETWORK_RETRY_DELAYS_MS.slice(0, 2));

  waits.length = 0;
  await assert.rejects(retryOnNetworkError(runs({ status: 1, output: '  ⨯ Cannot find module \'x\'' }), { label, sleep }), /^Error: npx electron-builder failed with exit code 1$/);
  assert.deepEqual(waits, [], 'any other failure stops at once');

  await assert.rejects(retryOnNetworkError(runs(offline, offline, offline, offline), { label, sleep }), /failed with exit code 1/);
  assert.deepEqual(waits, NETWORK_RETRY_DELAYS_MS, 'and it gives up after the last wait');

  for (const text of ['getaddrinfo EAI_AGAIN github.com', 'connect ETIMEDOUT 140.82.112.3:443', 'read ECONNRESET', 'socket hang up']) {
    assert.match(text, NETWORK_ERROR);
  }
  assert.doesNotMatch('ENOENT: no such file or directory', NETWORK_ERROR);

  const source = fs.readFileSync(path.join(ROOT, 'packaging', 'build-client.js'), 'utf8');
  assert.ok(source.includes("await retryOnNetworkError(() => runTee('npx', builderArgs, { cwd: APP_DIR }), { label: 'npx electron-builder' });"));
});

test('runTee shows the output as it comes and hands it back with the exit code', async () => {
  const code = "console.log('packaging'); console.error('getaddrinfo ENOTFOUND github.com'); process.exit(3)";
  const { status, output } = await runTee(process.execPath, ['-e', code], { cwd: ROOT });
  assert.equal(status, 3);
  assert.match(output, /packaging/);
  assert.match(output, NETWORK_ERROR);
});
