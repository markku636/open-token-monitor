'use strict';

// Main entry of the company Electron build. packaging/build-client.js copies
// this file to corp/main.js inside the packaged app, next to the
// corp-defaults.json it generates, and points package.json's `main` here.
//
// On the first launch (no settings.json yet) it writes the settings the company
// wants: connected to the hub, the client key, the upload interval. Where
// settings.json already exists (an upgrade, an earlier install) it connects it
// to the hub once instead, leaving the rest of the file alone. A build without
// a hub (TM_CLIENT_NO_HUB=1, the one on a public Release) writes the rest and
// leaves the hub URL and client key to the user's Settings. Launch at login,
// "Keep above taskbar" and the logo-only tray icon are turned on once per
// machine too. Each is recorded in corp-state.json and never done a second
// time, so whatever the user changes later (autostart off, another hub) stays.
// On Windows launch at login passes an argument, and that launch minimizes the
// widget to the taskbar. The release page of an update is pointed at the company
// Releases (GitLab or GitHub), an update upstream found elsewhere is forgotten, and on
// Linux launch at login follows an updated AppImage. The widget shows this
// machine's usage only, not every device on the hub (ownDeviceView.js). With a
// title-logo.png next to this file (client/README.md), the Σ at the top left of
// the widget is drawn as that logo. Then it runs upstream's src/electron/main.js
// unchanged.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Upstream's product name: the folder of settings.json, credentials.json and
// agent.pid (src/shared/config.js sharedDataDir()).
const PRODUCT_DIR = 'Token Monitor';

function writeFileAtomic(fsApi, filePath, text) {
  const tempPath = `${filePath}.tmp`;
  fsApi.writeFileSync(tempPath, text, { encoding: 'utf8', mode: 0o600 });
  fsApi.renameSync(tempPath, filePath);
}

function writeJsonAtomic(fsApi, filePath, value) {
  writeFileAtomic(fsApi, filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// What this entry has already done on this machine. It lives in its own
// corp-state.json because upstream rewrites settings.json from its own fields.
function readState(dir, fsApi) {
  try {
    const state = JSON.parse(fsApi.readFileSync(path.join(dir, 'corp-state.json'), 'utf8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  } catch (_) {
    return {};
  }
}

function markState(dir, fsApi, key) {
  fsApi.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(fsApi, path.join(dir, 'corp-state.json'), { ...readState(dir, fsApi), [key]: true });
}

// Returns true when it wrote settings.json, i.e. this is the first launch.
// `secret` goes into settings.json on purpose: upstream moves it into
// credentials.json on the next readSettings() (migrateLegacySettings()). A
// build without a hub writes no hub fields: upstream starts unconnected.
function seedFirstRun({ dir, defaults, fsApi = fs, randomUUID = crypto.randomUUID }) {
  if (!defaults) return false;
  const settingsFile = path.join(dir, 'settings.json');
  if (fsApi.existsSync(settingsFile)) return false;
  const settings = {
    deviceId: randomUUID(),
    ...(defaults.hubUrl ? { hubMode: 'client', hubUrl: defaults.hubUrl, secret: defaults.secret } : {}),
    syncUploadIntervalMs: defaults.syncUploadIntervalMs,
    automaticAppUpdates: false,
    startAtLogin: Boolean(defaults.startAtLogin)
  };
  fsApi.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(fsApi, settingsFile, settings);
  return true;
}

// Connects an existing settings.json to the hub, once per machine; returns true
// when it did. A machine that hosts the hub itself is left alone. The key goes
// straight into credentials.json (`store`, upstream's CredentialStore): a
// secret put in an existing settings.json would be dropped, because upstream
// moves it from there only once and reads credentials.json over it. `seeded`:
// seedFirstRun() has just written the connection, so this only records it.
function applyHubOnce({ dir, defaults, store, seeded = false, fsApi = fs }) {
  if (!defaults || !defaults.hubUrl) return false;
  if (readState(dir, fsApi).hubApplied) return false;
  if (seeded) {
    markState(dir, fsApi, 'hubApplied');
    return false;
  }
  const settingsFile = path.join(dir, 'settings.json');
  let settings;
  try {
    settings = JSON.parse(fsApi.readFileSync(settingsFile, 'utf8'));
  } catch (_) {
    // Missing or unreadable: upstream starts from its defaults; try again next launch.
    return false;
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  if (settings.hubMode === 'host') {
    markState(dir, fsApi, 'hubApplied');
    return false;
  }
  const document = store.readDocument();
  document.credentials.hub = { ...document.credentials.hub, clientSecret: defaults.secret };
  store.writeDocument(document);
  const { secret: _secret, ...rest } = settings;
  writeJsonAtomic(fsApi, settingsFile, {
    ...rest,
    hubMode: 'client',
    hubUrl: defaults.hubUrl,
    syncUploadIntervalMs: defaults.syncUploadIntervalMs
  });
  markState(dir, fsApi, 'hubApplied');
  return true;
}

// Returns true when launch at login should be turned on now: the build asks for
// it and this machine has not had it turned on before.
function claimStartAtLogin({ dir, defaults, fsApi = fs }) {
  if (!defaults || !defaults.startAtLogin) return false;
  if (readState(dir, fsApi).startAtLoginApplied) return false;
  markState(dir, fsApi, 'startAtLoginApplied');
  return true;
}

// Upstream registers launch at login without arguments (applyLoginItem()), so
// on Windows a launch at login looks like any other. The company build adds
// this one: app.setLoginItemSettings and app.getLoginItemSettings are wrapped
// in place to pass it whenever the caller passes no args of its own. Both,
// because Electron reports openAtLogin only for a Run key holding exactly the
// path and the args asked about; with set alone upstream would read launch at
// login back as off (syncLoginItemSettingFromOs()) and save that. main.js reads
// both at every call. Returns the unwrapped pair, or null where it did nothing.
const LOGIN_LAUNCH_ARG = '--launched-at-login';

function installLoginLaunchArg({ app, platform = process.platform }) {
  if (platform !== 'win32' || !app) return null;
  if (typeof app.getLoginItemSettings !== 'function' || typeof app.setLoginItemSettings !== 'function') return null;
  const get = app.getLoginItemSettings.bind(app);
  const set = app.setLoginItemSettings.bind(app);
  const withArg = (options) => (Array.isArray(options?.args) ? options : { ...options, args: [LOGIN_LAUNCH_ARG] });
  app.getLoginItemSettings = (options) => get(withArg(options));
  app.setLoginItemSettings = (settings) => set(withArg(settings));
  return { get, set };
}

// A machine set up before the argument has a Run key without it, which the
// wrapped getLoginItemSettings no longer counts as launch at login. That key is
// written again with the argument, before upstream reads it back. `enabled` is
// carried over: Electron's default, true, would undo the app being turned off
// in Task Manager's startup apps. `get` and `set` are the unwrapped pair from
// installLoginLaunchArg(). Returns true when it rewrote the Run key.
function tagLoginItem({ get, set }) {
  const bare = get();
  if (!bare || !bare.openAtLogin) return false;
  set({ openAtLogin: true, args: [LOGIN_LAUNCH_ARG], enabled: Boolean(bare.executableWillLaunchAtLogin) });
  return true;
}

// Whether this is the launch at login. Windows: the argument above. macOS:
// Electron's wasOpenedAtLogin, read once the app is ready. Linux: upstream's
// XDG autostart entry starts the AppImage without arguments, so never.
function launchedAtLogin({ app, argv = process.argv, platform = process.platform }) {
  if (platform === 'win32') return argv.includes(LOGIN_LAUNCH_ARG);
  if (platform === 'darwin') return Boolean(app.getLoginItemSettings().wasOpenedAtLogin);
  return false;
}

// Tray-only mode keeps the widget hidden at every launch: upstream does not
// show it at startup, so its first show is a click on the tray, which is left
// alone. `normalize` is upstream's normalizeTrayModeSettings().
function startsInTray({ dir, normalize, fsApi = fs }) {
  let settings;
  try {
    settings = JSON.parse(fsApi.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  } catch (_) {
    // Missing or unreadable: upstream starts from its defaults, tray mode off.
    return false;
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  return normalize(settings).trayMode === true;
}

// The launch at login minimizes the widget to the taskbar (the Dock on macOS),
// where a click brings it back, as does the tray icon. The widget is the first
// window upstream makes (createWindow() in its ready handler). It is minimized
// after upstream shows it, since show() restores a minimized window.
// `shouldMinimize` is asked when that window is made, after the app is ready.
// Returns whether it hooked in.
function minimizeAtLogin({ app, shouldMinimize, defer = setImmediate }) {
  if (!app || typeof app.once !== 'function') return false;
  app.once('browser-window-created', (_event, win) => {
    let minimize = false;
    try {
      minimize = shouldMinimize();
    } catch (error) {
      console.log(`[corp] could not tell whether this is the launch at login: ${error.message}`);
    }
    if (!minimize) return;
    win.once('show', () => defer(() => {
      if (!win.isDestroyed()) win.minimize();
    }));
  });
  return true;
}

// Upstream settings the company build changes once per machine, on a new or an
// existing settings.json. `change` gets the settings and returns the fields to
// write, or null to leave them; either way the step is recorded under `key` in
// corp-state.json and not run again, so a user who changes it back keeps that.
const SETTINGS_ONCE = [
  // "Keep above taskbar (Experimental)", off upstream. Upstream acts on it only
  // on Windows in floating mode (taskbarZOrderEnabled()).
  {
    key: 'keepAboveTaskbarApplied',
    change: (settings) => (settings.keepAboveTaskbar === true ? null : { keepAboveTaskbar: true })
  },
  // The tray (Windows) and the menu bar (macOS) show the logo alone, without
  // text: upstream's custom tray text, whose default layout is just the app
  // mark (createDefaultTrayLayout()), drawn in the system's ink. Only over
  // upstream's default, Tokens Today; another choice is the user's.
  {
    key: 'trayLogoApplied',
    change: (settings) => (settings.trayContent === undefined || settings.trayContent === 'tokens'
      ? { trayContent: 'custom' }
      : null)
  }
];

// Runs the SETTINGS_ONCE steps this machine has not had; returns the keys of
// those that changed settings.json. It runs after seedFirstRun(), so on a first
// launch settings.json is already there.
function applySettingsOnce({ dir, steps = SETTINGS_ONCE, fsApi = fs }) {
  const state = readState(dir, fsApi);
  const pending = steps.filter((step) => !state[step.key]);
  if (!pending.length) return [];
  const settingsFile = path.join(dir, 'settings.json');
  let settings;
  try {
    settings = JSON.parse(fsApi.readFileSync(settingsFile, 'utf8'));
  } catch (_) {
    // Missing or unreadable: upstream starts from its defaults; try again next launch.
    return [];
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return [];
  const changed = [];
  for (const step of pending) {
    const fields = step.change(settings);
    if (!fields) continue;
    settings = { ...settings, ...fields };
    changed.push(step.key);
  }
  if (changed.length) writeJsonAtomic(fsApi, settingsFile, settings);
  for (const step of pending) markState(dir, fsApi, step.key);
  return changed;
}

// The widget shows this machine's usage only, not every device on the hub
// (ownDeviceView.js), unless the build turned it off. Returns true when it did.
// `load` resolves an upstream module under src/ in the packaged app.
function limitToThisDevice({ dir, defaults, load = (id) => require(`../src/${id}`) }) {
  if (!defaults || defaults.ownDeviceOnly !== true) return false;
  const { createSettingsReader, installOwnDeviceView } = require('./ownDeviceView');
  installOwnDeviceView({
    syncDisplayStats: load('electron/syncDisplayStats'),
    historySource: load('electron/historySource'),
    macWidgetHistory: load('electron/macWidget/history'),
    usage: load('shared/usage'),
    history: load('shared/history'),
    defaultDeviceId: load('shared/config').defaultDeviceId,
    readSettings: createSettingsReader(path.join(dir, 'settings.json'))
  });
  return true;
}

// The path in an Exec= line upstream's linuxAutostart writes
// (quoteExecArgument()), or null for any other shape.
function autostartExecPath(execLine) {
  const match = /^Exec="(.*)"$/.exec(execLine || '');
  if (!match) return null;
  return match[1].replace(/\\\\/g, '\\').replace(/\\([\\"`$])/g, '$1').replace(/%%/g, '%');
}

// An updated AppImage is a new file: electron-updater names it after the new
// version and deletes the old one, and a user replacing it by hand does much
// the same. The autostart entry then still starts the deleted file, and
// upstream, finding Exec= on another path, reads launch at login as off. So an
// entry whose AppImage is gone is pointed at the running one. An entry on a
// file that still exists is left alone. Returns true when it rewrote the entry.
function followAppImageAutostart({ linuxAutostart, env = process.env, fsApi = fs }) {
  if (!env.APPIMAGE || linuxAutostart.isAutostartEnabled({ env })) return false;
  let contents;
  try {
    contents = fsApi.readFileSync(linuxAutostart.desktopFilePath({ env }), 'utf8');
  } catch (_) {
    // No entry: launch at login is off.
    return false;
  }
  const previous = autostartExecPath(contents.split(/\r?\n/).find((line) => line.startsWith('Exec=')));
  if (!previous || fsApi.existsSync(previous)) return false;
  return linuxAutostart.setAutostartEnabled(true, { env });
}

// Upstream links every update it reports to a GitHub tag page
// (latestFromUpdaterInfo() in src/shared/appUpdater.js). It cannot read the
// company's tag client-vX.Y.Z-corp.N, so it falls back to vX.Y.Z-corp.N, a page
// GitHub does not have. main.js opens only allowlisted URLs, and the company
// GitLab or GitHub repository is not on the list, so upstream's URL is left to
// pass the allowlist and is swapped for the company Release at the last step,
// in shell.openExternal. Only -corp.N tags are swapped: upstream never
// publishes one, so no real upstream page is hidden. A GitLab Release page is
// <project>/-/releases/<tag>, a GitHub one <repo>/releases/tag/<tag>.
//
// The Releases list itself is swapped too: upstream never opens it, only the
// "GitLab releases" (or "GitHub releases") link the company build adds to the
// App Updates header (UPSTREAM_PATCHES in packaging/build-client.js).
const CORP_TAG_URL = /^https:\/\/github\.com\/Javis603\/token-monitor\/releases\/tag\/v(\d+\.\d+\.\d+-corp\.\d+)$/;
const RELEASES_URL = /^https:\/\/github\.com\/Javis603\/token-monitor\/releases\/?$/;
const GITLAB_RELEASES = /\/-\/releases$/;

function corpReleasePageUrl(url, releasesUrl) {
  let text;
  try {
    text = decodeURIComponent(String(url || ''));
  } catch (_) {
    return url;
  }
  if (RELEASES_URL.test(text)) return releasesUrl;
  const match = CORP_TAG_URL.exec(text);
  if (!match) return url;
  return `${releasesUrl}${GITLAB_RELEASES.test(releasesUrl) ? '' : '/tag'}/client-v${match[1]}`;
}

// Wraps shell.openExternal in place. main.js reads `shell.openExternal` at every
// call, so this has to run before main.js is required. Returns whether it did.
function installReleasePageRedirect({ shell, releasesUrl }) {
  if (!releasesUrl || !shell || typeof shell.openExternal !== 'function') return false;
  const open = shell.openExternal.bind(shell);
  shell.openExternal = (url, options) => open(corpReleasePageUrl(url, releasesUrl), options);
  return true;
}

// The versions the company feed offers (packaging/clientConfig.js).
const CORP_VERSION = /^\d+\.\d+\.\d+-corp\.\d+$/;

// Upstream shows the newest version it last found (settings.json
// appUpdate.lastKnownLatest) until a check succeeds. One found on GitHub, by
// upstream's own app or a run from source on this machine, is a version the
// company feed never offers and this app cannot install, and it stays the
// "latest" for as long as checks fail: always in a build with no update source
// (any Mac build before 0.63.1-corp.9). So a version that is not -corp.N is
// dropped, with the time of that check, which makes the next launch check at
// once; so is a dismissed one.
// The company feed gives only -corp.N versions, so this acts once. Returns
// true when it rewrote settings.json.
function dropUpstreamUpdateCache({ dir, fsApi = fs }) {
  const settingsFile = path.join(dir, 'settings.json');
  let settings;
  try {
    settings = JSON.parse(fsApi.readFileSync(settingsFile, 'utf8'));
  } catch (_) {
    // Missing or unreadable: nothing cached.
    return false;
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const block = settings.appUpdate;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
  const staleLatest = Boolean(block.lastKnownLatest) && !CORP_VERSION.test(String(block.lastKnownLatest.version || ''));
  const staleDismissed = Boolean(block.dismissedVersion) && !CORP_VERSION.test(String(block.dismissedVersion));
  if (!staleLatest && !staleDismissed) return false;
  writeJsonAtomic(fsApi, settingsFile, {
    ...settings,
    appUpdate: {
      ...block,
      ...(staleLatest ? { lastKnownLatest: null, lastCheckedAt: null } : {}),
      ...(staleDismissed ? { dismissedVersion: null } : {})
    }
  });
  return true;
}

// The mark at the top left of the widget. Upstream draws it as the text Σ
// (<span class="app-title-mark">), shown while the title is collapsed to its
// icon, which is the default. With an optional title-logo.png next to this file
// the glyph is made transparent and the logo (white, like the title text) drawn
// as the element's background, so upstream's hover and click handling on the
// mark stay as they are. Without one, upstream's Σ stays.
const TITLE_LOGO_FILE = 'title-logo.png';

function titleLogoCss(png) {
  const url = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  return [
    '.shell.title-collapsed .app-title-mark, .shell.title-icon-only .app-title-mark {',
    '  display: inline-block !important;',
    '  width: 0.84em;',
    '  height: 1em;',
    '  color: transparent !important;',
    '  text-shadow: none !important;',
    `  background: url("${url}") center / contain no-repeat;`,
    '}'
  ].join('\n');
}

// Every page of the app (file:) gets the style when it loads; pages from the
// network (provider sign-ins) are left alone. Returns whether it hooked in.
function installTitleLogo({ app, png }) {
  if (!app || !png) return false;
  const css = titleLogoCss(png);
  app.on('web-contents-created', (_event, contents) => {
    contents.on('dom-ready', () => {
      if (!String(contents.getURL()).startsWith('file:')) return;
      contents.insertCSS(css).catch(() => {});
    });
  });
  return true;
}

function readDefaults(fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(path.join(__dirname, 'corp-defaults.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function start() {
  const { app } = require('electron');
  if (app.isPackaged) {
    const defaults = readDefaults();
    const dir = path.join(app.getPath('appData'), PRODUCT_DIR);
    let seeded = false;
    try {
      seeded = seedFirstRun({ dir, defaults });
    } catch (error) {
      console.log(`[corp] could not write the first-run settings: ${error.message}`);
    }
    try {
      const { CredentialStore } = require('../src/shared/credentialStore');
      applyHubOnce({ dir, defaults, seeded, store: new CredentialStore(dir) });
    } catch (error) {
      console.log(`[corp] could not connect the existing settings to the hub: ${error.message}`);
    }
    try {
      applySettingsOnce({ dir });
    } catch (error) {
      console.log(`[corp] could not apply the company display settings: ${error.message}`);
    }
    // Before upstream's main.js, which takes these exports when it loads.
    try {
      limitToThisDevice({ dir, defaults });
    } catch (error) {
      console.log(`[corp] could not limit the widget to this device: ${error.message}`);
    }
    prepareLoginLaunch({ app, dir, defaults });
    let startAtLogin = false;
    try {
      startAtLogin = claimStartAtLogin({ dir, defaults });
    } catch (error) {
      console.log(`[corp] could not record launch at login: ${error.message}`);
    }
    // Registered before upstream's own ready handler, but it runs after
    // upstream's module body, which sets the AppUserModelId the Windows Run
    // key is named after. Upstream then reads the login item back from the OS
    // (syncLoginItemSettingFromOs) and saves startAtLogin to match.
    // Electron's login items do nothing on Linux: there upstream keeps an XDG
    // autostart entry for the AppImage, and reads that back instead.
    if (startAtLogin && process.platform === 'linux') {
      require('../src/electron/linuxAutostart').setAutostartEnabled(true);
    } else if (startAtLogin) {
      app.whenReady().then(() => app.setLoginItemSettings({ openAtLogin: true })).catch(() => {});
    }
    prepareForUpdates({ dir, defaults });
  }
  const titleLogo = path.join(__dirname, TITLE_LOGO_FILE);
  if (fs.existsSync(titleLogo)) {
    try {
      installTitleLogo({ app, png: fs.readFileSync(titleLogo) });
    } catch (error) {
      console.log(`[corp] could not show the title logo: ${error.message}`);
    }
  }
  require('../src/electron/main');
}

// The launch at login, marked and minimized, before upstream runs. Its own
// ready handler is registered before upstream's, so the Run key is rewritten
// before upstream reads it back.
function prepareLoginLaunch({ app, dir, defaults }) {
  // Whatever the build says about minimizing: a Run key written with the
  // argument is read back as off without the wrapper.
  let loginItem = null;
  try {
    loginItem = installLoginLaunchArg({ app });
  } catch (error) {
    console.log(`[corp] could not mark the launch at login: ${error.message}`);
  }
  if (loginItem) {
    app.whenReady().then(() => {
      if (tagLoginItem(loginItem)) console.log('[corp] launch at login now marks its launch');
    }).catch((error) => console.log(`[corp] could not mark the launch at login: ${error.message}`));
  }
  if (!defaults?.startMinimizedAtLogin) return;
  try {
    const { normalizeTrayModeSettings } = require('../src/electron/trayModeSettings');
    minimizeAtLogin({
      app,
      shouldMinimize: () => launchedAtLogin({ app }) && !startsInTray({ dir, normalize: normalizeTrayModeSettings })
    });
  } catch (error) {
    console.log(`[corp] could not minimize the widget at login: ${error.message}`);
  }
}

// What the company updates (from the GitLab or GitHub Release) need before upstream runs.
function prepareForUpdates({ dir, defaults }) {
  try {
    installReleasePageRedirect({ shell: require('electron').shell, releasesUrl: defaults?.releasesUrl });
  } catch (error) {
    console.log(`[corp] could not point the release page at the company Releases: ${error.message}`);
  }
  try {
    if (dropUpstreamUpdateCache({ dir })) console.log('[corp] dropped an update found outside the company feed');
  } catch (error) {
    console.log(`[corp] could not drop an update found outside the company feed: ${error.message}`);
  }
  if (process.platform !== 'linux') return;
  try {
    followAppImageAutostart({ linuxAutostart: require('../src/electron/linuxAutostart') });
  } catch (error) {
    console.log(`[corp] could not point launch at login at this AppImage: ${error.message}`);
  }
}

// Under Electron this file is the app's main entry; tests require it from Node.
if (process.versions.electron) start();

module.exports = {
  LOGIN_LAUNCH_ARG,
  PRODUCT_DIR,
  SETTINGS_ONCE,
  applyHubOnce,
  applySettingsOnce,
  claimStartAtLogin,
  autostartExecPath,
  corpReleasePageUrl,
  dropUpstreamUpdateCache,
  followAppImageAutostart,
  installLoginLaunchArg,
  installReleasePageRedirect,
  installTitleLogo,
  launchedAtLogin,
  limitToThisDevice,
  minimizeAtLogin,
  readDefaults,
  seedFirstRun,
  startsInTray,
  tagLoginItem,
  titleLogoCss
};
