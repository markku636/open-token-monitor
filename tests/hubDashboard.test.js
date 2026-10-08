'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const { ADMIN_PATHS, DASHBOARD_PATHS, INSTALL_PATHS, USAGE_PATHS, createDashboardHub, latestDownloads, pageSettings } = require('../hub/server');
const { upstream } = require('../upstream');
const { CLIENT_IDS } = require(upstream('src/shared/clientCatalog'));
const { LIMIT_PROVIDER_IDS, limitProviderForClient } = require(upstream('src/shared/limits/providers'));

const quiet = { error() {}, warn() {} };

// The hub builds the page once per process, with the settings it finds then,
// so every page this file fetches carries this download link.
const DOWNLOAD_URL = 'https://git.example.test/tools/token-monitor/-/releases';
process.env.TOKEN_MONITOR_CLIENT_DOWNLOAD_URL = DOWNLOAD_URL;

function tempDataFile() {
  return path.join(os.tmpdir(), `tm-custom-hub-test-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
}

async function withHub(secret, run) {
  const dataFile = tempDataFile();
  const hub = createDashboardHub({ port: 0, host: '127.0.0.1', secret, dataFile, logger: quiet });
  await hub.start();
  try {
    await run(hub, `http://127.0.0.1:${hub.server.address().port}`);
  } finally {
    await hub.stop();
    fs.rmSync(dataFile, { force: true });
  }
}

test('the dashboard is served without authentication and carries no secret', async () => {
  await withHub('dashboard-secret', async (hub, base) => {
    assert.ok(DASHBOARD_PATHS.size >= 3);
    // /admin is the same file, showing only its 管理 part.
    assert.deepEqual([...ADMIN_PATHS], ['/admin']);
    for (const pathname of [...DASHBOARD_PATHS, ...ADMIN_PATHS, '/?period=today', '/admin?lang=en']) {
      // A browser cannot send the Authorization header on a navigation, so the
      // page itself has to be reachable with none.
      const response = await fetch(`${base}${pathname}`);
      const html = await response.text();
      assert.equal(response.status, 200, pathname);
      assert.match(response.headers.get('content-type'), /^text\/html/);
      assert.match(html, /<title>Token Monitor Hub<\/title>/);
      // The served file is committed, so a secret baked into it would be a
      // published credential rather than a local convenience. Both shapes the
      // project hands out — a hex string and generateHubSecret()'s base64url —
      // are long unbroken runs that nothing else on this page produces.
      assert.doesNotMatch(html, /[A-Za-z0-9_-]{32,}/);
    }
    // Serving the page must not have opened the data routes it calls.
    const stats = await fetch(`${base}/api/stats`);
    assert.equal(stats.status, 401);
  });
});

test('the page may not be framed, sniffed or named in a Referer', async () => {
  await withHub('dashboard-secret', async (hub, base) => {
    for (const pathname of [...DASHBOARD_PATHS, ...ADMIN_PATHS, '/?employee=ACME-1']) {
      const response = await fetch(`${base}${pathname}`);
      await response.text();
      assert.equal(response.status, 200, pathname);
      assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'", pathname);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', pathname);
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer', pathname);
      assert.equal(response.headers.get('cache-control'), 'no-store', pathname);
    }
  });
});

test('the install page is served without authentication, with the same headers and no secret', async () => {
  await withHub('dashboard-secret', async (hub, base) => {
    assert.deepEqual([...INSTALL_PATHS], ['/install']);
    for (const pathname of ['/install', '/install#macos', '/install?lang=en#windows']) {
      const response = await fetch(base + pathname);
      const html = await response.text();
      assert.equal(response.status, 200, pathname);
      assert.match(response.headers.get('content-type'), /^text\/html/);
      for (const [name, value] of [['content-security-policy', "frame-ancestors 'none'"], ['x-content-type-options', 'nosniff'], ['referrer-policy', 'no-referrer'], ['cache-control', 'no-store']]) {
        assert.equal(response.headers.get(name), value, name);
      }
      assert.match(html, /<title>安裝 Token Monitor<\/title>/);
      // The links are the only long runs: a secret would be another one.
      assert.doesNotMatch(html.replace(/https:\/\/[^"]+/g, ''), /[A-Za-z0-9_-]{32,}/);
      assert.ok(!html.includes('dashboard-secret'));
      const settings = JSON.parse(html.match(/<script>window\.TM_SETTINGS = (\{.*?\});<\/script>\n/)[1]);
      assert.deepEqual(settings.downloads, {
        windows: DOWNLOAD_URL + '/permalink/latest/downloads/windows',
        macos: DOWNLOAD_URL + '/permalink/latest/downloads/macos',
        linux: DOWNLOAD_URL + '/permalink/latest/downloads/linux'
      });
    }
    assert.equal((await fetch(base + '/api/stats')).status, 401);
    // The dashboard links it next to the download button, shown with it.
    const dashboard = await (await fetch(base + '/')).text();
    assert.match(dashboard, /<a id="installGuide" class="ghost" href="install" hidden data-en="How to install">安裝說明<\/a>/);
    assert.ok(pageScript().includes("$('installGuide').hidden = false;"));
    // The title goes home: the default view, which a link with no query opens.
    assert.ok(dashboard.includes('<h1><a id="home" href="./" title="回到首頁" data-en-title="Home">Token Monitor <small id="pageName" data-en="Usage dashboard">用量儀表板</small></a></h1>'));
  });
});

function installScript() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'hub', 'install.html'), 'utf8');
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((x, y) => y.length - x.length)[0];
}

test('the install page picks the visitor\'s system and builds nothing from markup', () => {
  const script = installScript();
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|outerHTML\s*=|document\.write|createContextualFragment|DOMParser|srcdoc|\beval\(|new Function|new RegExp\(|\bfunction esc\(/);
  assert.doesNotMatch(script, /setAttribute\(\s*['"](on\w+|href|src|xlink:href|style)['"]/);
  assert.doesNotMatch(script, /querySelector(All)?\([^)]*\+/);
  const page = new Function('return { detectOs, pickInitial };\n' + script)();
  const ua = {
    windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    ubuntu: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0',
    android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  };
  assert.equal(page.detectOs({ userAgent: ua.windows, platform: 'Win32' }), 'windows');
  assert.equal(page.detectOs({ userAgent: ua.mac, platform: 'MacIntel', maxTouchPoints: 0 }), 'macos');
  assert.equal(page.detectOs({ userAgent: ua.ubuntu, platform: 'Linux x86_64' }), 'linux');
  assert.equal(page.detectOs({ userAgent: ua.android, platform: 'Linux armv8l' }), 'mobile', 'Android says Linux too');
  assert.equal(page.detectOs({ userAgent: ua.iphone, platform: 'iPhone' }), 'mobile');
  assert.equal(page.detectOs({ userAgent: ua.mac, platform: 'MacIntel', maxTouchPoints: 5 }), 'mobile', 'an iPad asking for the desktop site');
  assert.equal(page.detectOs({ userAgentData: { platform: 'macOS' }, userAgent: '' }), 'macos');
  assert.equal(page.detectOs({ userAgent: 'curl/8.0' }), null);
  assert.equal(page.detectOs(undefined), null);
  assert.equal(page.pickInitial('#linux', 'windows'), 'linux', 'the link wins');
  assert.equal(page.pickInitial('', 'macos'), 'macos');
  assert.equal(page.pickInitial('#nope', 'mobile'), 'windows');
  assert.equal(page.pickInitial(undefined, null), 'windows');
  // Every system's steps are there without the script; the script shows one.
  const html = fs.readFileSync(path.join(__dirname, '..', 'hub', 'install.html'), 'utf8');
  for (const os of ['windows', 'macos', 'linux']) {
    assert.match(html, new RegExp('<section id="os-' + os + '" role="tabpanel" aria-labelledby="tab-' + os + '">'), os);
    assert.match(html, new RegExp('<a class="button" id="dl-' + os + '" hidden>'), os);
  }
  assert.match(html, /<div class="tabs" role="tablist" id="osTabs" aria-label="作業系統" hidden>/);
  assert.equal(html.split('</head>').length, 2, 'exactly one </head>');
  // Every Windows and macOS step with a window to click in sits next to a
  // drawing of it, in each language, labelled for screen readers, with the one
  // thing to click ringed.
  for (const [os, count] of [['windows', 5], ['macos', 6]]) {
    const section = html.match(new RegExp(`<section id="os-${os}"[\\s\\S]*?</section>`))[0];
    const shots = section.split('<div class="shot ').slice(1);
    for (const lang of ['zh-Hant', 'en']) {
      assert.equal(shots.filter((shot) => shot.match(/^[\w ]+" lang="([^"]+)"/)?.[1] === lang).length, count, `${os} ${lang}`);
    }
    assert.equal(shots.length, count * 2, `${os}: every drawing is in one of the languages`);
    for (const shot of shots) {
      assert.match(shot, /^[\w ]+" lang="[^"]+" role="img" aria-label="[^"]+">/);
      assert.equal(shot.split(/class="[^"]*\bhit\b/).length, 2, shot.slice(0, 40));
    }
  }
  assert.doesNotMatch(html, /C:\\Users\\(?!&lt;)/, 'no one\'s own user folder');
});

// The install page's markup by language: the text and labels inside each
// element marked lang="zh-Hant" or lang="en", and what is in neither. An .alt
// span is the other language's name for a button, so it may be in either.
function installTexts(html) {
  const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.lastIndexOf('<script>'));
  const VOID = new Set(['br', 'hr', 'img', 'input', 'wbr']);
  const stack = [];
  const texts = { 'zh-Hant': [], en: [], none: [], alt: [] };
  const marked = { 'zh-Hant': 0, en: 0 };
  const here = () => stack.findLast((tag) => tag.lang)?.lang || 'none';
  for (const [, close, name, attrs, text] of body.matchAll(/<(\/?)(\w+)([^>]*)>|([^<]+)/g)) {
    if (text !== undefined) {
      if (text.trim()) texts[here()].push(text.trim());
    } else if (close) {
      const at = stack.map((tag) => tag.name).lastIndexOf(name);
      assert.ok(at >= 0, `</${name}> closes an open element`);
      stack.length = at;
    } else if (!VOID.has(name)) {
      const lang = attrs.match(/\blang="([^"]+)"/)?.[1] || (/\bclass="alt"/.test(attrs) ? 'alt' : null);
      if (Object.hasOwn(marked, lang)) marked[lang] += 1;
      stack.push({ name, lang });
      for (const [, label] of attrs.matchAll(/\b(?:aria-label|title)="([^"]*)"/g)) texts[here()].push(label);
    }
  }
  assert.equal(stack.length, 0, 'every element is closed');
  return { texts, marked };
}

test('the install page says everything in Chinese and in English, and opens in the visitor\'s language', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'hub', 'install.html'), 'utf8');
  const chinese = /[\p{Script=Han}\p{Script=Bopomofo}]/u;
  const { texts, marked } = installTexts(html);
  assert.ok(marked.en > 50, 'the page is marked by language');
  assert.equal(marked.en, marked['zh-Hant'], 'every Chinese block has an English one');
  assert.deepEqual(texts.en.filter((text) => chinese.test(text)), [], 'no Chinese in the English blocks');
  // The tab list's label is the one the script sets in each language.
  assert.deepEqual(texts.none.filter((text) => chinese.test(text) && text !== '作業系統'), [], 'all Chinese is marked as Chinese');
  assert.ok(texts['zh-Hant'].some((text) => text.includes('仍要執行')) && texts.en.some((text) => text.includes('Run anyway')));
  assert.ok(html.includes('html:not([lang="en"]) [lang="en"],html[lang="en"] [lang="zh-Hant"]{display:none !important}'), 'one language shows at a time');
  // The script in <head> sets <html lang> before anything is drawn.
  const head = html.slice(0, html.indexOf('</head>'));
  const scripts = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotMatch(scripts[0], /innerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  assert.ok(scripts[0].includes('document.documentElement.lang = pickLanguage(location.search, savedLanguage(), navigator.language);'));
  const { pickLanguage } = new Function('return { pickLanguage };\n' + scripts[0])();
  assert.equal(pickLanguage('?lang=en', 'zh-Hant', 'zh-TW'), 'en', 'the link wins');
  assert.equal(pickLanguage('?lang=zh-TW', 'en', 'en-US'), 'zh-Hant');
  assert.equal(pickLanguage('?lang=fr', 'en', 'zh-TW'), 'en', 'an unknown ?lang= is passed over');
  assert.equal(pickLanguage('', 'en', 'zh-TW'), 'en', 'then what the visitor picked before');
  assert.equal(pickLanguage('', null, 'zh-TW'), 'zh-Hant');
  assert.equal(pickLanguage('', null, 'zh-CN'), 'zh-Hant');
  assert.equal(pickLanguage('', null, 'en-US'), 'en');
  assert.equal(pickLanguage('', null, 'ja'), 'en', 'English for any browser not in Chinese');
  assert.equal(pickLanguage('', null, ''), 'zh-Hant');
  // The words the script writes come in both languages, and a visitor's pick
  // is kept for the next visit and in the link.
  const script = installScript();
  for (const part of ["title: '安裝 Token Monitor'", "title: 'Install Token Monitor'", "systems: 'Operating system'", "localStorage.setItem('tm.lang', shown)", "url.searchParams.set('lang', shown === 'en' ? 'en' : 'zh-TW')"]) {
    assert.ok(script.includes(part), part);
  }
});

test('the old usage page sends its links to the dashboard', async () => {
  await withHub('dashboard-secret', async (hub, base) => {
    assert.ok(USAGE_PATHS.has('/usage'));
    for (const [pathname, location] of [['/usage', './'], ['/usage?company=ACME&period=week', './?company=ACME&period=week']]) {
      const response = await fetch(`${base}${pathname}`, { redirect: 'manual' });
      assert.equal(response.status, 302, pathname);
      assert.equal(response.headers.get('location'), location);
    }
    const dashboard = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(dashboard, /href="usage"/, 'nothing links to the old page');
    // Day, week and month; company and department, no BU or team; the admin
    // tools.
    for (const period of ['day', 'week', 'month']) assert.match(dashboard, new RegExp(`data-period="${period}"`));
    for (const id of ['levelTabs', 'unitChart', 'userChart', 'trend', 'selCompany', 'selDepartment', 'dropZone', 'emails', 'tokenForm', 'versions']) {
      assert.match(dashboard, new RegExp(`id="${id}"`), id);
    }
    for (const id of ['selBu', 'selTeam']) assert.doesNotMatch(dashboard, new RegExp(`id="${id}"`), id);
    for (const route of ['/api/custom/usage?', '/api/admin/emails/unclassified', '/api/admin/api-tokens', '/api/admin/org/imports']) assert.ok(dashboard.includes(route), route);
  });
});

// The page's own period arithmetic, run without a browser: `return` ahead of
// the script body sees the hoisted top-level functions, and none of them
// touches the DOM.
test('the dashboard finds the day, week or month of a date, and the trend before it', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'hub', 'dashboard.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((x, y) => y.length - x.length)[0];
  const page = new Function(`return { periodRange, shiftPeriod, mondayOf, compareVersions, validDayKey };
${script}`)();
  assert.deepEqual(page.periodRange('day', '2026-09-30'), { granularity: 'day', focusFrom: '2026-09-30', focusTo: '2026-09-30', from: '2026-09-17', to: '2026-09-30' });
  assert.deepEqual(page.periodRange('week', '2026-09-30'), { granularity: 'week', focusFrom: '2026-09-28', focusTo: '2026-10-04', from: '2026-07-13', to: '2026-10-04' }, 'ISO weeks from Monday, twelve of them');
  assert.deepEqual(page.periodRange('month', '2026-02-10'), { granularity: 'month', focusFrom: '2026-02-01', focusTo: '2026-02-28', from: '2025-03-01', to: '2026-02-28' });
  assert.equal(page.mondayOf('2026-10-04'), '2026-09-28', 'a Sunday belongs to the week before it');
  assert.equal(page.shiftPeriod('month', '2026-01-31', -1), '2025-12-01');
  assert.equal(page.shiftPeriod('week', '2026-09-30', 1), '2026-10-07');
  // A year by month, the whole of it the focus.
  assert.deepEqual(page.periodRange('year', '2024-06-15'), { granularity: 'month', focus: 'range', focusFrom: '2024-01-01', focusTo: '2024-12-31', from: '2024-01-01', to: '2024-12-31' });
  assert.deepEqual([page.shiftPeriod('year', '2026-09-30', -1), page.shiftPeriod('year', '2025-01-01', 1)], ['2025-01-01', '2026-01-01']);
  assert.deepEqual([page.compareVersions('0.64.0', '0.63.1'), page.compareVersions('0.63.1', '0.63.1'), page.compareVersions('0.9.0', '0.10.0')], [1, 0, -1]);
  assert.equal(page.validDayKey('2026-02-30'), '');
});

// The page's main script: the longest plain <script>.
function pageScript() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'hub', 'dashboard.html'), 'utf8');
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((x, y) => y.length - x.length)[0];
}

// The page's pure helpers, run without a browser. `return` ahead of the body
// sees only the hoisted function declarations: every top-level const and let
// is still in its temporal dead zone, so a helper that reaches for one (nf,
// view, a label table) throws here instead of passing by luck.
function pageFns(names) {
  return new Function(`return { ${names.join(', ')} };\n${pageScript()}`)();
}

test('page C1: ranges, links, requests and comparisons', () => {
  const page = pageFns(['presetRange', 'autoGrain', 'viewRange', 'rangeLabel', 'readUrl', 'writeUrl', 'usageQuery', 'previousName', 'prevWord', 'firstDay', 'coverageText', 'fallbackText', 'toolOptions', 'deviceTokens',
    'metricOf', 'deltaInfo', 'pctText', 'compareText', 'earlyText', 'usageSig', 'tokens', 'usd', 'isCalendar', 'dayCount']);
  const today = '2026-09-30';

  // The last N days end yesterday.
  assert.deepEqual(page.presetRange('7d', today), { from: '2026-09-23', to: '2026-09-29' });
  assert.deepEqual(page.presetRange('30d', today), { from: '2026-08-31', to: '2026-09-29' });
  assert.deepEqual(page.presetRange('90d', today), { from: '2026-07-02', to: '2026-09-29' });
  assert.equal(page.presetRange('week', today), null);
  assert.deepEqual([page.dayCount('2026-09-01', '2026-09-30'), page.dayCount('2026-09-30', '2026-09-30')], [30, 1]);

  // Days up to 92, weeks up to 200, months beyond.
  assert.equal(page.autoGrain('2026-07-01', '2026-09-30'), 'day', '92 days');
  assert.equal(page.autoGrain('2026-06-30', '2026-09-30'), 'week', '93 days');
  assert.equal(page.autoGrain('2026-03-15', '2026-09-30'), 'week', '200 days');
  assert.equal(page.autoGrain('2026-03-14', '2026-09-30'), 'month', '201 days');

  const at = (period, day, extra) => page.viewRange(Object.assign({ period, date: day, from: '', to: '' }, extra), day);
  // Calendar periods are periodRange's, cut off at today.
  assert.deepEqual(at('day', '2026-02-28'), { granularity: 'day', focus: 'last', from: '2026-02-15', to: '2026-02-28', focusFrom: '2026-02-28', focusTo: '2026-02-28', days: 1, error: '' });
  assert.deepEqual(at('week', '2024-02-29'), { granularity: 'week', focus: 'last', from: '2023-12-11', to: '2024-02-29', focusFrom: '2024-02-26', focusTo: '2024-03-03', days: 4, error: '' });
  assert.deepEqual(at('month', '2026-12-31'), { granularity: 'month', focus: 'last', from: '2026-01-01', to: '2026-12-31', focusFrom: '2026-12-01', focusTo: '2026-12-31', days: 31, error: '' });
  assert.deepEqual(page.viewRange({ period: 'month', date: '2026-08-10' }, today).to, '2026-08-31', 'a past month is whole');
  // Rolling presets on month ends and a leap day.
  assert.deepEqual(at('7d', '2026-02-28'), { granularity: 'day', focus: 'range', from: '2026-02-21', to: '2026-02-27', focusFrom: '2026-02-21', focusTo: '2026-02-27', days: 7, error: '' });
  assert.deepEqual(at('30d', '2024-02-29'), { granularity: 'day', focus: 'range', from: '2024-01-30', to: '2024-02-28', focusFrom: '2024-01-30', focusTo: '2024-02-28', days: 30, error: '' });
  assert.deepEqual(at('90d', '2024-02-29'), { granularity: 'day', focus: 'range', from: '2023-12-01', to: '2024-02-28', focusFrom: '2023-12-01', focusTo: '2024-02-28', days: 90, error: '' });
  assert.deepEqual(at('30d', '2026-12-31'), { granularity: 'day', focus: 'range', from: '2026-12-01', to: '2026-12-30', focusFrom: '2026-12-01', focusTo: '2026-12-30', days: 30, error: '' });
  assert.deepEqual(at('90d', '2026-12-31'), { granularity: 'day', focus: 'range', from: '2026-10-02', to: '2026-12-30', focusFrom: '2026-10-02', focusTo: '2026-12-30', days: 90, error: '' });
  // Custom: swapped when reversed, cut off at today, 400 days inclusive at most.
  const custom = (from, to) => page.viewRange({ period: 'custom', date: today, from, to }, today);
  assert.deepEqual(custom('2026-09-20', '2026-09-01'), { granularity: 'day', focus: 'range', from: '2026-09-01', to: '2026-09-20', focusFrom: '2026-09-01', focusTo: '2026-09-20', days: 20, error: '' });
  assert.equal(custom('2026-09-01', '2027-01-01').to, today);
  assert.deepEqual([custom('2025-08-26', '2026-09-29').days, custom('2025-08-26', '2026-09-29').error, custom('2025-08-26', '2026-09-29').granularity], [400, '', 'month']);
  assert.deepEqual([custom('2025-08-25', '2026-09-29').days, custom('2025-08-25', '2026-09-29').error], [401, 'long']);
  assert.equal(custom('', '2026-09-29').error, 'order');
  assert.equal(custom('2026-02-30', '2026-03-01').error, 'order');

  assert.equal(page.rangeLabel('2026-08-31', '2026-09-29', today), '08-31 ～ 09-29');
  assert.equal(page.rangeLabel('2025-12-01', '2026-01-10', today), '2025-12-01 ～ 2026-01-10');
  assert.equal(page.rangeLabel('2026-09-23', '2026-09-23', today), '09-23');

  // Links: what writeUrl writes, readUrl reads back.
  const q = (search) => new URLSearchParams(search);
  const key = { hasKey: true };
  const defaults = { period: 'week', date: today, from: '', to: '', metric: 'tokens', level: '', sel: { company: '', department: '' }, other: '', unowned: false, employee: '', stack: 'level', layout: 'split', measure: 'total', usort: 'total', ltool: '', lsorts: new Map(),
    tool: '' };
  assert.equal(page.writeUrl(defaults, {}, today), '?period=week');
  assert.deepEqual(page.readUrl(q(''), {}, today), defaults);
  const full = { period: 'month', date: '2026-07-01', from: '', to: '', metric: 'cost', level: 'department', sel: { company: 'ACME', department: 'Aurora Dept' }, other: '', unowned: false,
    employee: 'ACME-1', stack: 'model', layout: 'stack', measure: 'rate', usort: 'change', ltool: 'claude',
    lsorts: new Map([['codex', { sort: 'usage', rev: true }], ['claude', { sort: 'left', rev: false }]]), tool: 'codex' };
  const link = page.writeUrl(full, { company: 'ACME', department: 'Aurora Dept' }, today);
  assert.equal(link, '?period=month&date=2026-07-01&company=ACME&dept=Aurora+Dept&level=department&tool=codex&metric=cost&employee=ACME-1&stack=model&layout=stack&measure=rate&usort=change&ltool=claude&lsort=claude.left&lsort=codex.usage.rev');
  assert.deepEqual(page.readUrl(q(link), key, today), full);
  // A link from when BUs and teams were shown opens at the department.
  assert.deepEqual(page.readUrl(q('?period=month&date=2026-07-01&company=ACME&bu=Games&dept=Aurora+Dept&team=Pixel&level=team&tool=codex&metric=cost&employee=ACME-1&stack=model&layout=stack&measure=rate&usort=change&ltool=claude&lsort=claude.left&lsort=codex.usage.rev'), key, today), Object.assign({}, full, { level: '' }));
  // A past year is linked by its first day; this year by nothing.
  const lastYear = Object.assign({}, defaults, { period: 'year', date: '2025-01-01' });
  assert.equal(page.writeUrl(lastYear, {}, today), '?period=year&date=2025-01-01');
  assert.deepEqual(page.readUrl(q('?period=year&date=2025-01-01'), {}, today), lastYear);
  assert.equal(page.writeUrl(Object.assign({}, defaults, { period: 'year', date: '2026-03-04' }), {}, today), '?period=year');
  // A year cut off at today, compared with the same stretch a year earlier:
  // a year's 上一期.
  const thisYear = page.viewRange({ period: 'year', date: today }, today);
  assert.deepEqual(thisYear, { granularity: 'month', focus: 'range', from: '2026-01-01', to: today, focusFrom: '2026-01-01', focusTo: '2026-12-31', days: 273, error: '' });
  assert.deepEqual(page.viewRange({ period: 'year', date: '2024-02-29' }, today).days, 366, 'a leap year is whole');
  assert.equal(page.usageQuery(Object.assign({}, defaults, { period: 'year' }), thisYear, '', false), 'from=2026-01-01&to=2026-09-30&granularity=month&focus=range&compare=year');
  assert.equal(page.previousName('year'), '去年');
  // There is no 比較 to pick: an old link that asked for 去年同期 or a window
  // of its own opens compared with 上一期.
  for (const search of ['?period=week&compare=year', '?period=week&compare=custom&cfrom=2026-09-01&cto=2026-09-10']) assert.deepEqual(page.readUrl(q(search), {}, today), defaults, search);
  const range = Object.assign({}, defaults, { period: 'custom', from: '2026-01-01', to: '2026-03-31' });
  assert.equal(page.writeUrl(range, {}, today), '?period=custom&from=2026-01-01&to=2026-03-31');
  assert.deepEqual(page.readUrl(q(page.writeUrl(range, {}, today)), {}, today), range);
  for (const period of ['day', 'week', 'month', 'year', '7d', '30d', '90d']) {
    const v = Object.assign({}, defaults, { period });
    assert.deepEqual(page.readUrl(q(page.writeUrl(v, {}, today)), {}, today), v, period);
  }
  // 其他 of a unit at one level.
  const atOther = Object.assign({}, defaults, { sel: { company: 'ACME', department: '' }, other: 'department' });
  assert.equal(page.writeUrl(atOther, { company: 'ACME' }, today), '?period=week&company=ACME&other=department');
  assert.deepEqual(page.readUrl(q('?period=week&company=ACME&other=department'), {}, today), atOther);
  // 沒有對應到員工, in a unit's 其他 too; the level stays for the way back.
  const atUnowned = Object.assign({}, atOther, { unowned: true });
  assert.equal(page.writeUrl(atUnowned, { company: 'ACME' }, today), '?period=week&company=ACME&other=department&unowned=1');
  assert.deepEqual(page.readUrl(q('?period=week&company=ACME&other=department&unowned=1'), {}, today), atUnowned);
  assert.equal(page.readUrl(q('?unowned=yes'), {}, today).unowned, false);
  // A date in the current period is not written: the link follows today.
  assert.equal(page.writeUrl(Object.assign({}, defaults, { date: '2026-09-28' }), {}, today), '?period=week');

  // Old links and old stored values.
  const read = (search, stored) => page.readUrl(q(search), stored || {}, today);
  assert.equal(read('?period=today').period, 'day');
  assert.equal(read('?period=allTime').period, 'month');
  assert.deepEqual([read('?range=month').period, read('?range=month').date], ['month', today]);
  assert.deepEqual([read('?range=lastmonth').period, read('?range=lastmonth').date], ['month', '2026-08-01']);
  assert.deepEqual(['7', '30', '90'].map((n) => read('?range=' + n).period), ['7d', '30d', '90d']);
  assert.deepEqual([read('?range=14').period, read('?range=14').from, read('?range=14').to], ['custom', '2026-09-16', '2026-09-29']);
  const oldRange = read('?range=30&from=2026-01-10&to=2026-01-01');
  assert.deepEqual([oldRange.period, oldRange.from, oldRange.to], ['custom', '2026-01-01', '2026-01-10'], 'from+to beat range, swapped');
  assert.equal(read('?period=custom').period, 'week', 'custom without dates');
  assert.equal(read('?period=custom&from=2026-09-01&to=2027-02-01').to, today);
  assert.deepEqual(read('?tab=users&period=week'), defaults);
  assert.equal(read('?date=2027-01-01').date, today);
  assert.equal(read('?date=2026-02-30').date, today);
  assert.equal(read('?period=bogus&metric=bogus&level=bogus&stack=bogus&measure=bogus&usort=bogus&asort=bogus&agroup=bogus').period, 'week');
  assert.deepEqual(read('?asort=change&agroup=provider'), defaults, 'the old 帳號比較 sort and grouping are ignored');
  assert.equal(read('?other=bogus').other, '');
  assert.deepEqual(['?ltool=Claude', '?ltool=a%3Cb', '?ltool=' + 'x'.repeat(41)].map((search) => read(search).ltool), ['', '', ''], 'a provider id or nothing');
  // Each provider's own 排序; a bare one from before, a bogus one or one that
  // asks for the default is none. The first for a provider wins.
  assert.deepEqual(read('?lsort=left&lrev=1&lsort=bogus&lsort=Claude.left&lsort=zed.reset&lsort=amp.usage&lsort=cursor.name.rev&lsort=cursor.left&lsort=a%3Cb.left').lsorts,
    new Map([['cursor', { sort: 'name', rev: true }]]));
  assert.deepEqual(read('', { period: 'today', metric: 'cost' }).period + '/' + read('', { period: 'today', metric: 'cost' }).metric, 'day/cost');
  assert.equal(read('', { period: 'allTime' }).period, 'month');
  assert.equal(read('', { period: 'month' }).period, 'month');
  assert.equal(read('', { period: '30d' }).period, '30d');
  assert.equal(read('', { period: 'custom' }).period, 'week');
  assert.equal(read('?metric=tokens', { metric: 'cost' }).metric, 'tokens', 'the link beats the browser');
  assert.equal(read('?employee=ACME-1').employee, '', 'no key, no person');
  assert.equal(read('?employee=%20ACME-1%20', key).employee, 'ACME-1');
  assert.equal(read('?employee=' + 'x'.repeat(65), key).employee, '');

  // The usage request: one person's view carries no org or level, and 其他
  // no level.
  const week = page.viewRange({ period: 'week', date: today }, today);
  assert.equal(page.usageQuery(defaults, week, '', false), 'from=2026-07-13&to=2026-09-30&granularity=week');
  assert.equal(page.usageQuery(Object.assign({}, defaults, { level: 'department' }), week, 'ACME/Games', false), 'from=2026-07-13&to=2026-09-30&granularity=week&org=ACME%2FGames&level=department');
  assert.equal(page.usageQuery(atOther, week, 'ACME', false), 'from=2026-07-13&to=2026-09-30&granularity=week&org=ACME&other=department');
  assert.equal(page.usageQuery(Object.assign({}, atOther, { level: 'department' }), week, 'ACME', false), 'from=2026-07-13&to=2026-09-30&granularity=week&org=ACME&other=department');
  assert.equal(page.usageQuery(Object.assign({}, atOther, { employee: 'ACME-1' }), week, 'ACME', true), 'from=2026-07-13&to=2026-09-30&granularity=week&employee=ACME-1');
  assert.equal(page.usageQuery(atUnowned, week, 'ACME', false), 'from=2026-07-13&to=2026-09-30&granularity=week&org=ACME&other=department&unowned=1');
  assert.equal(page.usageQuery(Object.assign({}, defaults, { unowned: true, level: 'department' }), week, 'ACME', false), 'from=2026-07-13&to=2026-09-30&granularity=week&org=ACME&unowned=1', 'no level to compare');
  assert.equal(page.usageQuery(Object.assign({}, atUnowned, { employee: 'ACME-1' }), week, 'ACME', true), 'from=2026-07-13&to=2026-09-30&granularity=week&employee=ACME-1');
  const thirty = page.viewRange({ period: '30d' }, today);
  assert.equal(page.usageQuery(defaults, thirty, '', false), 'from=2026-08-31&to=2026-09-29&granularity=day&focus=range');
  const person = Object.assign({}, defaults, { employee: 'ACME-1', level: 'department' });
  assert.equal(page.usageQuery(person, week, 'ACME', true), 'from=2026-07-13&to=2026-09-30&granularity=week&employee=ACME-1');
  assert.equal(page.usageQuery(person, week, 'ACME', false), 'from=2026-07-13&to=2026-09-30&granularity=week&org=ACME&level=department');
  // A sort by one tool goes in the link.
  const toolSorted = Object.assign({}, defaults, { measure: 'tool:claude', usort: 'tool:codex' });
  assert.equal(page.writeUrl(toolSorted, {}, today), '?period=week&measure=tool%3Aclaude&usort=tool%3Acodex');
  assert.deepEqual(page.readUrl(q(page.writeUrl(toolSorted, {}, today)), {}, today), toolSorted);
  // 工具 goes along as client=, in one person's view too.
  const codexView = Object.assign({}, defaults, { tool: 'codex' });
  assert.equal(page.usageQuery(codexView, week, 'ACME', false), 'from=2026-07-13&to=2026-09-30&granularity=week&org=ACME&client=codex');
  assert.equal(page.usageQuery(Object.assign({}, codexView, { employee: 'ACME-1' }), week, 'ACME', true), 'from=2026-07-13&to=2026-09-30&granularity=week&employee=ACME-1&client=codex');
  assert.deepEqual(['claude', 'Claude Code', 'a%0Ab', 'x'.repeat(65), ''].map((t) => page.readUrl(q('?tool=' + t), {}, today).tool), ['claude', 'Claude Code', '', '', '']);
  const labelOf = (id) => ({ claude: 'Claude Code', codex: 'Codex' })[id] || id;
  assert.deepEqual(page.toolOptions([{ client: 'claude', value: 5 }, { client: 'codex', value: 9 }, { client: 'cursor', value: 0 }], '', labelOf), [
    { value: '', label: '全部工具' }, { value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude Code' }, { value: 'cursor', label: 'cursor' }
  ]);
  assert.deepEqual(page.toolOptions([], 'kimi', labelOf).map((o) => o.label), ['全部工具', 'kimi（這段期間沒有用量）'], 'the pick stays');
  assert.deepEqual([page.deviceTokens({ totalTokens: 90, clients: { claude: 30 } }, ''), page.deviceTokens({ totalTokens: 90, clients: { claude: 30 } }, 'claude'), page.deviceTokens({ totalTokens: 90 }, 'codex'), page.deviceTokens(null, '')], [90, 30, 0, 0]);
  assert.deepEqual(['day', 'week', 'month', '7d', 'custom'].map(page.previousName), ['上週同一天', '上週', '上月', '前一段', '前一段']);
  assert.deepEqual(['previous', 'year', undefined].map(page.prevWord), ['上期', '去年同期', '上期']);

  assert.deepEqual([page.metricOf({ tokens: 5, costUsd: 1.5 }, 'tokens'), page.metricOf({ tokens: 5, costUsd: 1.5 }, 'cost'), page.metricOf(null, 'cost'), page.metricOf({}, 'tokens')], [5, 1.5, 0, 0]);

  assert.deepEqual(page.deltaInfo(118, 100), { dir: 'up', pct: 18, abs: 18 });
  assert.deepEqual(page.deltaInfo(95, 100), { dir: 'down', pct: -5, abs: -5 });
  assert.equal(page.deltaInfo(100.4, 100).dir, 'flat');
  assert.equal(page.deltaInfo(99.5, 100).dir, 'down', 'half a percent is a change');
  assert.deepEqual(page.deltaInfo(5, 0), { dir: 'new', pct: null, abs: 5 });
  assert.deepEqual(page.deltaInfo(0, 0), { dir: 'none', pct: null, abs: 0 });
  assert.deepEqual(page.deltaInfo(0, 10), { dir: 'down', pct: -100, abs: -10 });
  assert.deepEqual([page.pctText(18.2), page.pctText(-5), page.pctText(2.54), page.pctText(0.5)], ['18%', '5%', '2.5%', '0.5%']);

  // The comparison in words.
  const cmp = (granularity, focus, previous) => page.compareText({ granularity, focus, previous }, today);
  assert.equal(cmp('week', { key: '2026-09-28', from: '2026-09-28', to: '2026-09-30' }, { from: '2026-09-21', to: '2026-09-23', days: 3, partial: true }), '和上週同期（09-21 ～ 09-23）比較 · 今天還沒過完');
  assert.equal(cmp('week', { key: '2026-09-21', from: '2026-09-21', to: '2026-09-27' }, { from: '2026-09-14', to: '2026-09-20', days: 7, partial: false }), '和上週（09-14 ～ 09-20）比較');
  assert.equal(cmp('month', { key: '2026-09', from: '2026-09-01', to: '2026-09-30' }, { from: '2026-08-01', to: '2026-08-30', days: 30, partial: true }), '和上月同期（08-01 ～ 08-30）比較 · 今天還沒過完');
  assert.equal(cmp('month', { key: '2026-09', from: '2026-09-01', to: '2026-09-30' }, { from: '2026-08-01', to: '2026-08-31', days: 31, partial: false }), '和上月（8 月）比較 · 今天還沒過完');
  assert.equal(cmp('month', { key: '2026-01', from: '2026-01-01', to: '2026-01-31' }, { from: '2025-12-01', to: '2025-12-31', days: 31, partial: false }), '和上月（12 月）比較');
  assert.equal(cmp('day', { key: '2026-09-30', from: '2026-09-30', to: '2026-09-30' }, { from: '2026-09-23', to: '2026-09-23', days: 1, partial: false }), '和上週同一天（09-23，三）比較 · 今天還沒過完');
  assert.equal(cmp('day', { key: '2026-09-29', from: '2026-09-29', to: '2026-09-29' }, { from: '2026-09-22', to: '2026-09-22', days: 1, partial: false }), '和上週同一天（09-22，二）比較');
  assert.equal(cmp('day', { key: 'range', from: '2026-08-31', to: '2026-09-29', days: 30 }, { from: '2026-08-01', to: '2026-08-30', days: 30, partial: false }), '和前 30 天（08-01 ～ 08-30）比較');
  assert.equal(cmp('month', { key: 'range', from: '2025-01-01', to: '2026-02-04', days: 400 }, { from: '2023-11-28', to: '2024-12-31', days: 400, partial: false }), '和前 400 天（2023-11-28 ～ 2024-12-31）比較');
  assert.equal(page.compareText({ granularity: 'week', focus: {}, previous: null }, today), '');
  // The first day there is any usage for, and what a day or week view before
  // the first daily row cannot show.
  assert.equal(page.firstDay({ earliest: { daily: '2025-09-24', monthly: '2025-01' } }), '2025-01-01');
  assert.equal(page.firstDay({ earliest: { daily: '2025-09-24', monthly: null } }), '2025-09-24');
  assert.equal(page.firstDay(null), '');
  const early = { earliest: { daily: '2025-09-24', monthly: '2025-01' }, from: '2025-09-01', granularity: 'day' };
  assert.equal(page.coverageText(early), '2025-09-24 以前只有每月合計，看不到每天的用量，請改用「月」或「年」看。');
  assert.equal(page.coverageText(Object.assign({}, early, { granularity: 'month' })), '', 'a month view counts the month totals');
  assert.equal(page.coverageText(Object.assign({}, early, { from: '2025-10-01' })), '');
  assert.equal(page.coverageText({ earliest: { daily: '2025-09-24', monthly: '2025-09' }, from: '2025-09-01', granularity: 'day' }), '', 'no month before the first day');
  assert.equal(page.fallbackText({ monthlyFallback: ['2025-01', '2025-02', '2025-08'] }), '2025-01 ～ 2025-08 有些裝置只有每月合計（第一次上傳前的歷史）：算進用量，但不算有用量的天數，歸屬以月初為準。');
  assert.equal(page.fallbackText({ monthlyFallback: ['2025-03'] }).slice(0, 8), '2025-03 ');
  assert.equal(page.fallbackText({ monthlyFallback: [] }), '');
  // A year view: the year before, whole or as far as this one goes.
  assert.equal(cmp('month', { key: 'range', from: '2025-01-01', to: '2025-12-31', days: 365 }, { from: '2024-01-01', to: '2024-12-31', days: 366, partial: false, mode: 'year' }), '和去年（2024 年）比較');
  assert.equal(cmp('month', { key: 'range', from: '2026-01-01', to: '2026-09-30', days: 273 }, { from: '2025-01-01', to: '2025-09-30', days: 273, partial: true, mode: 'year' }), '和去年同期（2025-01-01 ～ 2025-09-30）比較 · 今天還沒過完');
  assert.equal(page.earlyText('2026-08-01', '2026-09-29', today), '比較的期間早於 hub 開始收資料的 09-29，只有裝置補傳的歷史，可能偏少。');
  assert.equal(page.earlyText('2026-09-29', '2026-09-29', today), '');
  assert.equal(page.earlyText('2026-08-01', null, today), '');
  // Usage an admin deleted is gone, not little.
  assert.equal(page.earlyText('2026-08-01', '2026-09-29', today, '2026-09-01', '2026-09-08'), '2026 年 9 月以前的用量已經由管理員刪除，那段期間沒有資料。');
  assert.equal(page.earlyText('2026-09-01', '2026-08-29', today, '2026-09-01', '2026-09-08'), '');

  // Only the time an answer was worked out does not count as a change.
  const body = { ok: true, generatedAt: '2026-09-30T02:00:00.000Z', trend: { tokens: [1, 2] } };
  assert.equal(page.usageSig(body), page.usageSig(Object.assign({}, body, { generatedAt: '2026-09-30T02:01:00.000Z' })));
  assert.notEqual(page.usageSig(body), page.usageSig(Object.assign({}, body, { trend: { tokens: [1, 3] } })));

  // tokens() and usd() are pure: they run here, where nf does not exist yet.
  assert.deepEqual([0, 500, 12.6, 1500, 10440000, 2.5e9, -1.9e6, 'x'].map(page.tokens), ['0', '500', '13', '1.5K', '10.44M', '2.50B', '-1.90M', '0']);
  assert.deepEqual([1300, 0.5, 176.366, -120, null].map(page.usd), ['$1,300.00', '$0.50', '$176.37', '-$120.00', '$0.00']);
  assert.deepEqual(['day', 'week', 'month', '7d', 'custom'].map(page.isCalendar), [true, true, true, false, false]);
});

test('page C2: trend colours, labels, partial columns and stacks', () => {
  const page = pageFns(['rankColors', 'uniqueLabels', 'bucketFlags', 'effectiveStack', 'stackOf', 'splitOf']);
  const today = '2026-09-30';

  // The seven largest over the range get --s1 … --s7, largest first; ties by
  // label; nothing with 0; the Map is in slot order.
  const items = [['a', 5], ['b', 50], ['c', 0], ['d', 20], ['e', 20], ['f', 1], ['g', 3], ['h', 2], ['i', 4], ['j', 9]]
    .map(([key, total]) => ({ key, label: key.toUpperCase(), total }));
  const colors = page.rankColors(items);
  assert.deepEqual([...colors], [['b', 'var(--s1)'], ['d', 'var(--s2)'], ['e', 'var(--s3)'], ['j', 'var(--s4)'], ['a', 'var(--s5)'], ['i', 'var(--s6)'], ['g', 'var(--s7)']]);
  assert.equal(colors.has('h'), false, 'eighth is gray');
  assert.equal(colors.has('c'), false, 'no usage, no colour');
  assert.deepEqual([...page.rankColors([{ key: '__proto__', label: 'x', total: 1 }])], [['__proto__', 'var(--s1)']]);
  assert.equal(page.rankColors([]).size, 0);

  // Equal labels get what they sit in, and a number if that is equal too.
  assert.deepEqual(page.uniqueLabels([{ label: 'Games', parent: 'ACME' }, { label: 'Games', parent: 'GLOBEX' }, { label: 'Ops', parent: 'ACME' }]), ['Games（ACME）', 'Games（GLOBEX）', 'Ops']);
  assert.deepEqual(page.uniqueLabels([{ label: 'QA', parent: 'X' }, { label: 'QA', parent: 'X' }, { label: 'QA' }]), ['QA（X） 1', 'QA（X） 2', 'QA']);
  assert.deepEqual(page.uniqueLabels([]), []);

  // Partial columns: the one under way ends today; the range cuts the others.
  const b = (from, to, days) => ({ key: from, from, to, days });
  assert.deepEqual(page.bucketFlags([b('2026-09-21', '2026-09-27', 7), b('2026-09-28', '2026-09-30', 3)], 'week', today), ['', 'live']);
  assert.deepEqual(page.bucketFlags([b('2026-08-27', '2026-08-30', 4), b('2026-08-31', '2026-09-06', 7), b('2026-09-21', '2026-09-27', 7), b('2026-09-28', '2026-09-29', 2)], 'week', today), ['part', '', '', 'part']);
  assert.deepEqual(page.bucketFlags([b('2026-02-01', '2026-02-28', 28), b('2024-02-01', '2024-02-28', 28), b('2026-09-01', '2026-09-30', 30)], 'month', today), ['', 'part', ''], 'February and a leap year');
  assert.deepEqual(page.bucketFlags([b('2026-09-15', '2026-09-30', 16)], 'month', today), ['live']);
  assert.deepEqual(page.bucketFlags([b('2026-09-29', '2026-09-29', 1), b('2026-09-30', '2026-09-30', 1)], 'day', today), ['', '']);

  // A stack the answer cannot draw falls back to the view's own default.
  const unitView = { level: 'department', people: false, person: false, devices: false };
  const admin = Object.assign({}, unitView, { people: true });
  assert.equal(page.effectiveStack('level', unitView), 'level');
  assert.equal(page.effectiveStack('person', unitView), 'level', 'people only for an admin');
  assert.equal(page.effectiveStack('device', unitView), 'level', 'devices only in a person view');
  assert.equal(page.effectiveStack('person', admin), 'person');
  assert.equal(page.effectiveStack('model', unitView), 'model');
  assert.deepEqual(['model', 'client'].map((k) => page.effectiveStack(k, Object.assign({}, unitView, { tool: true }))), ['level', 'level'], 'one tool: no stack by model or tool');
  assert.equal(page.effectiveStack('client', unitView), 'client');
  assert.equal(page.effectiveStack('bogus', unitView), 'level');
  assert.equal(page.effectiveStack('level', { level: null, people: false }), 'total', 'a leaf unit, no key');
  assert.equal(page.effectiveStack('level', { level: null, people: true }), 'person', 'a leaf unit, admin');
  const personView = { level: null, people: true, person: true, devices: true };
  assert.equal(page.effectiveStack('level', personView), 'device');
  assert.equal(page.effectiveStack('person', personView), 'device');
  assert.equal(page.effectiveStack('model', personView), 'model');
  assert.equal(page.effectiveStack('level', Object.assign({}, personView, { devices: false })), 'total');
  assert.equal(page.effectiveStack('device', { people: false }), 'total');
  // 沒有對應到員工: its devices, as in a person view, and no people.
  const unownedView = { level: null, people: true, unowned: true, devices: true };
  assert.deepEqual(['level', 'person', 'device', 'client'].map((k) => page.effectiveStack(k, unownedView)), ['device', 'device', 'device', 'client']);
  assert.equal(page.effectiveStack('level', Object.assign({}, unownedView, { people: false, devices: false })), 'total');
  assert.equal(page.effectiveStack('level', undefined), 'total');

  // The columns always add up to the scope: seven colours, the rest, the
  // extra (其他) and what nothing covers (未細分).
  const series = Array.from({ length: 9 }, (_, k) => ({ key: 'm' + k, label: 'M' + k, values: [k + 1, 0, 2] }));
  const scope = [60, 5, 30];
  const extra = [1, 1, 0];
  const stack = page.stackOf(series, scope, extra);
  assert.deepEqual(stack.shown.map((s) => s.key), ['m8', 'm7', 'm6', 'm5', 'm4', 'm3', 'm2']);
  assert.deepEqual(stack.shown.map((s) => s.color), [1, 2, 3, 4, 5, 6, 7].map((k) => 'var(--s' + k + ')'));
  assert.equal(stack.rest, 2);
  assert.deepEqual(stack.restValues, [3, 0, 4]);
  assert.deepEqual(stack.extra, [1, 1, 0]);
  assert.deepEqual(stack.residual, [14, 4, 12]);
  for (let k = 0; k < scope.length; k += 1) {
    const column = stack.shown.reduce((acc, s) => acc + s.values[k], 0) + stack.restValues[k] + stack.extra[k] + stack.residual[k];
    assert.equal(column, scope[k], 'column ' + k);
  }
  // Rounding in a cost sum is not a part of its own.
  const cost = page.stackOf([{ key: 'a', label: 'a', values: [0.1] }, { key: 'b', label: 'b', values: [0.2] }], [0.30000000000000004 + 1e-12], null);
  assert.deepEqual(cost.residual, [0]);
  assert.deepEqual(page.stackOf([], [0, 0], null), { shown: [], rest: 0, restValues: [0, 0], extra: [0, 0], residual: [0, 0] });

  // Split (分開), every series with usage is its own, largest first, in the
  // colour the stack gives it and gray past the seventh; 其他 and 未細分 as
  // in the stack.
  const split = page.splitOf(series.concat({ key: 'idle', label: 'Idle', values: [0, 0, 0] }), scope, extra);
  assert.deepEqual(split.shown.map((s) => s.key), ['m8', 'm7', 'm6', 'm5', 'm4', 'm3', 'm2', 'm1', 'm0']);
  assert.deepEqual(split.shown.map((s) => s.color), [1, 2, 3, 4, 5, 6, 7].map((k) => 'var(--s' + k + ')').concat('var(--s-other)', 'var(--s-other)'));
  assert.deepEqual(split.shown.map((s) => s.total), [11, 10, 9, 8, 7, 6, 5, 4, 3]);
  assert.deepEqual(split.extra, stack.extra);
  assert.deepEqual(split.residual, stack.residual);
  assert.deepEqual(page.splitOf([], [0, 0], null), { shown: [], extra: [0, 0], residual: [0, 0] });

  // Drawn in cost, the colours still go by tokens (rank), as everywhere else
  // on the page; split, the largest drawn still comes first.
  const byCost = [{ key: 'opus', label: 'opus', values: [9], rank: 10 }, { key: 'gpt', label: 'gpt', values: [1], rank: 40 }];
  assert.deepEqual(page.stackOf(byCost, [10], null).shown.map((s) => [s.key, s.color]), [['gpt', 'var(--s1)'], ['opus', 'var(--s2)']]);
  assert.deepEqual(page.splitOf(byCost, [10], null).shown.map((s) => [s.key, s.color]), [['opus', 'var(--s2)'], ['gpt', 'var(--s1)']]);

  // One hatch pattern for every chart, the stack toggle, and state per chart.
  const html = fs.readFileSync(path.join(__dirname, '..', 'hub', 'dashboard.html'), 'utf8');
  const script = pageScript();
  assert.equal(html.split('<pattern id="hatch"').length, 2);
  assert.match(html, /id="stackTabs" role="group" aria-label="堆疊方式"/);
  assert.match(html, /id="layoutTabs" role="group" aria-label="圖的排列"/);
  // Token｜等值成本 is 趨勢's own (not in the filter bar), and the lists
  // below 總覽 stay in tokens whatever it is.
  const trendAt = html.indexOf('id="trendSection"');
  assert.match(html.slice(trendAt, html.indexOf('</section>', trendAt)), /id="metricTabs" role="group" aria-label="指標"/);
  assert.equal(html.split('id="metricTabs"').length, 2);
  const body = (name) => {
    const at = script.indexOf('\nfunction ' + name + '(');
    assert.ok(at >= 0, name);
    return script.slice(at, script.indexOf('\n}\n', at));
  };
  for (const name of ['fmt', 'otherMetric', 'renderToolFilter', 'renderKpiDetail', 'renderUnits', 'renderUnitTable', 'otherDevices', 'renderUsers',
    'accountBar', 'renderAccounts', 'renderPersonDevices', 'renderBreakdown', 'renderComp', 'renderLimits', 'renderDevices']) {
    assert.doesNotMatch(body(name), /view\.metric/, name);
  }
  assert.doesNotMatch(script, /trendState/);
  assert.match(script, /\nfunction chartBase\(wrap, o\) \{/);
  assert.match(script, /\nfunction drawCols\(st\) \{/);
  assert.match(script, /\nfunction showTip\(st, k\) \{/);
  assert.doesNotMatch(script, /addEventListener\('resize'/);
});

test('page C2b: 總覽 draws both metrics with one set of colours, the models by cost, and the ring', () => {
  const page = pageFns(['overviewLines', 'modelSlices', 'arcPath', 'rankColors', 'rankItems', 'uniqueLabels', 'sum', 'tidy']);
  const close = (actual, expected) => actual.forEach((v, k) => assert.ok(Math.abs(v - expected[k]) < 1e-9, `${actual} ≈ ${expected}`));

  // The seven with the most tokens get a colour, the same seven in cost (where
  // the order is the other way round), and the gray holds the rest of the
  // scope, named by what is in it.
  const items = Array.from({ length: 9 }, (_, k) => ({ key: 'p' + k, label: 'P' + k, parent: 'U', tokens: [k + 1, 0, 2], cost: [0.1 * (9 - k), 0, 0] }));
  const scope = { tokens: [60, 5, 30], cost: [5, 0.5, 0] };
  const extra = { tokens: [1, 1, 0], cost: [0.1, 0, 0] };
  const lines = page.overviewLines(items, scope, extra, '人', '沒有對應到員工');
  const shown = ['p8', 'p7', 'p6', 'p5', 'p4', 'p3', 'p2'];
  assert.deepEqual(lines.tokens.map((s) => s.key), shown.concat('rest'));
  assert.deepEqual(lines.cost.map((s) => s.key), shown.concat('rest'));
  assert.deepEqual([...lines.colors.keys()], shown);
  assert.deepEqual(lines.tokens.map((s) => s.color), lines.cost.map((s) => s.color));
  assert.equal(lines.tokens[7].color, 'var(--s-other)');
  assert.deepEqual(lines.tokens[7].values, [18, 5, 16]);
  close(lines.cost[7].values, [2.2, 0.5, 0]);
  assert.equal(lines.tokens[7].label, '其餘 2 人、沒有對應到員工、未細分');
  assert.equal(lines.tokens[7].other, true);
  assert.deepEqual(lines.tokens[0], { key: 'p8', label: 'P8', color: 'var(--s1)', values: [9, 0, 2], total: 11 });
  for (let k = 0; k < 3; k += 1) {
    assert.equal(lines.tokens.reduce((acc, s) => acc + s.values[k], 0), scope.tokens[k], 'tokens add up to the scope ' + k);
  }
  // Names that read the same get their unit.
  const twins = page.overviewLines([{ key: 'a', label: 'Ann', parent: 'Ops', tokens: [2], cost: [1] }, { key: 'b', label: 'Ann', parent: 'QA', tokens: [1], cost: [1] }], { tokens: [3], cost: [2] }, null, '人', '');
  assert.deepEqual(twins.tokens.map((s) => s.label), ['Ann（Ops）', 'Ann（QA）']);
  // A scope the series cover, but for rounding, has no gray.
  const exact = page.overviewLines([{ key: 'a', label: 'a', tokens: [1], cost: [0.1] }, { key: 'b', label: 'b', tokens: [2], cost: [0.2] }], { tokens: [3], cost: [0.30000000000000004 + 1e-12] }, null, '人', '');
  assert.deepEqual(exact.cost.map((s) => s.key), ['b', 'a']);
  assert.deepEqual(page.overviewLines([], { tokens: [0], cost: [0] }, null, '人', ''), { tokens: [], cost: [], colors: new Map() });

  // Models by cost, the most first, in the scope's colours; the others and
  // what no model covers (from 1%) share the gray, and nothing without cost.
  const colors = new Map([['a', 'var(--s1)'], ['b', 'var(--s2)']]);
  const models = [{ model: 'b', tokens: 20, costUsd: 3 }, { model: 'a', tokens: 10, costUsd: 5 }, { model: 'c', tokens: 5, costUsd: 0 }, { model: 'd', tokens: 1, costUsd: 1 }];
  assert.deepEqual(page.modelSlices(models, colors, 10), [
    { key: 'a', label: 'a', value: 5, tokens: 10, color: 'var(--s1)' },
    { key: 'b', label: 'b', value: 3, tokens: 20, color: 'var(--s2)' },
    { key: 'rest', label: '其餘 1 個模型、未細分', value: 2, tokens: null, color: 'var(--s-other)', other: true }
  ]);
  assert.deepEqual(page.modelSlices(models, colors, 9.05).at(-1), { key: 'rest', label: '其餘 1 個模型', value: 1, tokens: 1, color: 'var(--s-other)', other: true }, 'under 1% is not 未細分');
  // One person's largest model the scope does not colour is gray.
  assert.deepEqual(page.modelSlices([{ model: 'z', tokens: 9, costUsd: 9 }, { model: 'a', tokens: 1, costUsd: 1 }], colors, 10).map((s) => [s.key, s.color]), [['a', 'var(--s1)'], ['rest', 'var(--s-other)']]);
  assert.deepEqual(page.modelSlices([], colors, 5), [{ key: 'rest', label: '未細分', value: 5, tokens: null, color: 'var(--s-other)', other: true }]);
  assert.deepEqual(page.modelSlices(undefined, colors, 0), []);

  // Ring slices clockwise from 12 o'clock; a whole ring stops just short.
  assert.equal(page.arcPath(90, 58, 86, 0, Math.PI / 2), 'M90.00,4.00A86,86 0 0 1 176.00,90.00L148.00,90.00A58,58 0 0 0 90.00,32.00Z');
  assert.match(page.arcPath(90, 58, 86, 0, Math.PI * 2), /^M90\.00,4\.00A86,86 0 1 1 89\.99,4\.00L/);

  // The markup: 總覽 under the cards, its cards under the group title as h3.
  const html = fs.readFileSync(path.join(__dirname, '..', 'hub', 'dashboard.html'), 'utf8');
  const block = html.slice(html.indexOf('<h2 class="group" data-en="Overview">總覽</h2>'), html.indexOf('id="unitSection"'));
  assert.ok(html.indexOf('id="kpis"') < html.indexOf('<h2 class="group" data-en="Overview">總覽</h2>'));
  for (const id of ['ovTokens', 'ovCost', 'ovModels', 'ovModelWho', 'ovPeople']) assert.match(block, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(block.replace(/<h2 class="group"[^>]*>[^<]*<\/h2>/, ''), /<h2/, 'cards under a group title are h3');
  // Signing out takes the names off 總覽 too.
  const script = pageScript();
  const signOut = script.slice(script.indexOf('\nasync function signOut('), script.indexOf('\n}\n', script.indexOf('\nasync function signOut(')));
  for (const hook of ["'ovPeople'", "'ovTokenLegend'", 'renderWhoPicker([])']) assert.ok(signOut.includes(hook), hook);
});

test('page C3: unit measures and change labels', () => {
  const page = pageFns(['sortUnits', 'measureOf', 'unitAverage', 'signedText', 'measureText', 'deltaLabel', 'sortParam', 'sortTool', 'toolValue', 'toolEntry', 'toolSegments', 'tokens', 'usd']);
  const f = (tokens, costUsd, employees) => ({ tokens, costUsd, employees, devices: employees });
  const units = [
    { id: 'a', name: 'Alpha', headcount: 10, focus: f(500, 5, 5), previous: f(400, 6, 4) },
    { id: 'b', name: 'Beta', headcount: 4, focus: f(800, 2, 4), previous: f(800, 1, 4) },
    { id: 'c', name: 'Cold', headcount: 5, focus: f(0, 0, 0), previous: f(300, 3, 2) },
    { id: 'd', name: 'Dorm', headcount: 3, focus: f(0, 0, 0), previous: f(0, 0, 0) },
    { id: 'e', name: 'Echo', headcount: 0, focus: f(100, 9, 2), previous: f(50, 1, 1) },
    { id: 'z', name: 'Zero', headcount: 0, focus: f(0, 0, 0), previous: f(0, 0, 0) },
    { id: 'other', name: '其他', other: true, headcount: 0, focus: f(200, 1, 0), previous: f(900, 4, 0) }
  ];
  const order = (measure, metric) => page.sortUnits(units, measure, metric).map((s) => s.row.id);
  const values = (measure, metric) => page.sortUnits(units, measure, metric).map((s) => s.value);
  // 總量: what has usage, largest first; idle units are left to the note.
  assert.deepEqual(order('total', 'tokens'), ['b', 'a', 'other', 'e']);
  assert.deepEqual(order('total', 'cost'), ['e', 'a', 'b', 'other']);
  // 人均: per head on the roster; 其他 is out, no roster last, idle units with
  // a roster are 0 rows.
  assert.deepEqual(order('head', 'tokens'), ['b', 'a', 'c', 'd', 'e']);
  assert.deepEqual(values('head', 'tokens'), [200, 50, 0, 0, undefined]);
  assert.deepEqual(order('head', 'cost'), ['a', 'b', 'c', 'd', 'e']);
  // 使用率: people who used it per head, the same whatever the metric.
  assert.deepEqual(order('rate', 'tokens'), ['b', 'a', 'c', 'd', 'e']);
  assert.deepEqual(values('rate', 'cost'), [1, 0.5, 0, 0, undefined]);
  // 變化: by the size of the move, drops to 0, 其他 and unchanged units (0,
  // last) included, never-used ones left out.
  assert.deepEqual(order('change', 'tokens'), ['other', 'c', 'a', 'e', 'b']);
  assert.deepEqual(values('change', 'tokens'), [-700, -300, 100, 50, 0]);
  assert.deepEqual(order('change', 'cost'), ['e', 'c', 'other', 'a', 'b'], 'equal moves by name');
  // Ties by name.
  const tie = [{ id: '2', name: 'B', headcount: 1, focus: f(5, 0, 1) }, { id: '1', name: 'A', headcount: 1, focus: f(5, 0, 1) }];
  assert.deepEqual(page.sortUnits(tie, 'total', 'tokens').map((s) => s.row.name), ['A', 'B']);
  assert.deepEqual(page.sortUnits([], 'total', 'tokens'), []);
  assert.equal(page.measureOf(units[6], 'rate', 'tokens'), undefined, '其他 has no roster');

  // The gray line: the scope's own per head and adoption.
  const totals = f(1600, 18, 11);
  assert.equal(page.unitAverage('head', 'tokens', totals, 20), 80);
  assert.equal(page.unitAverage('head', 'cost', totals, 20), 0.9);
  assert.equal(page.unitAverage('rate', 'tokens', totals, 20), 0.55);
  assert.equal(page.unitAverage('rate', 'tokens', totals, 0), undefined, 'no roster, no line');
  assert.equal(page.unitAverage('total', 'tokens', totals, 20), undefined);
  assert.equal(page.unitAverage('change', 'tokens', totals, 20), undefined);

  // Values as the measure shows them.
  assert.deepEqual([page.signedText(1.9e6, 'tokens'), page.signedText(-120, 'cost'), page.signedText(0, 'tokens'), page.signedText(0.001, 'cost')], ['+1.90M', '−$120.00', '0', '$0.00']);
  assert.deepEqual([page.measureText('head', 493000, 'tokens'), page.measureText('head', 49.38, 'cost'), page.measureText('rate', 0.72, 'tokens'),
    page.measureText('rate', 1.25, 'cost'), page.measureText('change', -5, 'cost'), page.measureText('total', 1500, 'tokens'), page.measureText('head', undefined, 'tokens')],
  ['493.0K／人', '$49.38／人', '72%', '125%', '−$5.00', '1.5K', '—']);
  assert.deepEqual([page.deltaLabel(118, 100), page.deltaLabel(0, 10), page.deltaLabel(5, 0), page.deltaLabel(100.2, 100), page.deltaLabel(0, 0)], ['▲ 18%', '▼ 100%', '新', '持平', '']);

  // The markup: controls out of the h2, the toggles, and no CSV download of
  // any kind.
  const html = fs.readFileSync(path.join(__dirname, '..', 'hub', 'dashboard.html'), 'utf8');
  const script = pageScript();
  assert.doesNotMatch(html, /<h2>[^\n]*id="levelTabs"/);
  for (const m of ['total', 'head', 'rate', 'change']) assert.ok(html.includes(`data-measure="${m}"`), m);
  for (const m of ['total', 'change']) assert.ok(html.includes(`data-usort="${m}"`), m);
  for (const id of ['measureTabs', 'usortTabs', 'userSearch', 'accountSearch', 'measureTool', 'usortTool', 'unitLegend', 'userLegend']) assert.match(html, new RegExp(`id="${id}"`), id);
  // 帳號排行: everyone's, by tokens only, the first 10 until it is opened.
  for (const id of ['asortTabs', 'agroupTabs']) assert.doesNotMatch(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<h2><span data-en="Account ranking">帳號排行<\/span>/);
  assert.match(script, /\nconst ACCOUNT_LIMIT = 10;\n/);
  const accountsAt = script.indexOf('\nfunction renderAccounts(');
  const renderAccountsBody = script.slice(accountsAt, script.indexOf('\n}\n', accountsAt));
  assert.doesNotMatch(renderAccountsBody, /usage\.people/, 'not for admins only');
  assert.match(renderAccountsBody, /limit: ACCOUNT_LIMIT, expandKey: 'accounts'/);
  assert.match(script, /\$\('accountSection'\)\.hidden = person \|\| !Array\.isArray\(usage\.accounts\);/);

  // 依工具: a sort by one tool's usage, in a link as tool:<key>.
  assert.deepEqual([page.sortParam('tool:codex', ['total', 'change']), page.sortParam('tool:', ['total']), page.sortParam('bogus', ['total', 'change']), page.sortParam('change', ['total', 'change'])],
    ['tool:codex', 'total', 'total', 'change']);
  assert.deepEqual([page.sortTool('tool:claude'), page.sortTool('total'), page.sortTool(undefined)], ['claude', '', '']);
  const byTools = [
    { id: 'a', name: 'A', headcount: 2, focus: { tokens: 100 }, previous: {}, clients: [{ client: 'claude', focus: { tokens: 70 } }, { client: 'codex', focus: { tokens: 20 } }] },
    { id: 'b', name: 'B', headcount: 1, focus: { tokens: 90 }, previous: {}, clients: [{ client: 'codex', focus: { tokens: 85 } }] },
    { id: 'c', name: 'C', headcount: 1, focus: { tokens: 50 }, previous: {}, clients: [{ client: 'claude', focus: { tokens: 50 } }] }
  ];
  assert.deepEqual(page.sortUnits(byTools, 'tool:codex', 'tokens').map((s) => [s.row.id, s.value]), [['b', 85], ['a', 20]], 'only the units that used it');
  assert.deepEqual(page.sortUnits(byTools, 'tool:claude', 'tokens').map((s) => s.row.id), ['a', 'c']);
  assert.equal(page.measureText('tool:codex', 85000, 'tokens'), '85.0K');
  assert.equal(page.toolValue({}, 'claude', 'tokens'), 0);
  assert.deepEqual(page.toolEntry(byTools[1], 'codex').focus, { tokens: 85 });
  assert.deepEqual(page.toolEntry(byTools[1], 'claude'), { client: 'claude', focus: {}, previous: {} });
  // The bar's parts: the coloured tools in slot order, the rest in gray.
  const colors = new Map([['codex', 'var(--s1)'], ['claude', 'var(--s2)']]);
  assert.deepEqual(page.toolSegments(byTools[0].clients, 100, colors, 'tokens', 1), [
    { key: 'codex', value: 20, color: 'var(--s1)' }, { key: 'claude', value: 70, color: 'var(--s2)' }, { key: 'rest', value: 10, color: 'var(--s-other)' }
  ]);
  assert.deepEqual(page.toolSegments(byTools[0].clients, 90, colors, 'tokens', 2).map((s) => s.value), [10, 35], 'per head, and nothing left over');
  assert.deepEqual(page.toolSegments([], 0, colors, 'tokens', 1), []);
  assert.deepEqual(page.toolSegments(undefined, 40, new Map(), 'tokens', 1), [{ key: 'rest', value: 40, color: 'var(--s-other)' }]);
  assert.ok(html.indexOf('id="accountSearch"') < html.indexOf('id="accountChart"'), 'the accounts search box is outside the list');
  assert.match(html, /id="userSearch" placeholder="搜尋姓名、email 或單位" aria-label="搜尋人員"/);
  assert.ok(html.indexOf('id="userSearch"') < html.indexOf('id="userChart"'), 'the search box is outside the list');
  assert.doesNotMatch(html, /csv|\/api\/reports\/v1\/usage/i);
  assert.match(script, /\nfunction renderBars\(container, rows, \{ limit, expandKey, empty, scale, noun \}\) \{/);
});

test('組織名單 sends each row with the BU of its department, and a moved person without their team', () => {
  const page = pageFns(['rosterRowOut']);
  const bus = new Map([['hub', 'Platform']]);
  const row = (more) => Object.assign({ employeeId: 'S1', name: 'Ada', email: 'ada@example.test', department: 'Hub', bu: 'Platform', team: 'Ingest', was: 'Hub' }, more);
  assert.deepEqual(page.rosterRowOut(row({}), bus), { employeeId: 'S1', name: 'Ada', email: 'ada@example.test', department: 'Hub', bu: 'Platform', team: 'Ingest' }, 'unchanged');
  assert.deepEqual(page.rosterRowOut(row({ department: ' hub ', bu: '', team: '', was: '' }), bus), { employeeId: 'S1', name: 'Ada', email: 'ada@example.test', department: 'hub', bu: 'Platform', team: '' }, 'new: the BU of its department');
  assert.deepEqual(page.rosterRowOut(row({ department: 'Sales' }), bus), { employeeId: 'S1', name: 'Ada', email: 'ada@example.test', department: 'Sales', bu: '', team: '' }, 'moved to a new department');
  assert.deepEqual(page.rosterRowOut(row({ department: '', was: '', team: '' }), bus).bu, 'Platform', 'directly under a BU stays there');
  assert.deepEqual(page.rosterRowOut(row({ department: '' }), bus).bu, '', 'moved out of the department: directly under the company');
});

test('page C4: person devices, token split, live state and the admin helpers', () => {
  const page = pageFns(['compParts', 'compNote', 'windowRemain', 'shownWindows', 'durWords', 'limitFigures', 'limitSummary', 'limitGroups', 'clientCounts', 'deviceTools',
    'limitAccounts', 'deviceAccounts', 'accountPlan', 'focusByDevice', 'viewDeviceIds', 'viewAccounts', 'accountUsage', 'deviceOrder', 'deviceStaleAfter', 'deviceStateHint', 'accountWords', 'accountRanking', 'companyOf', 'importPath', 'staffPath', 'reconcileText']);

  // Token 組成: shares of what has a split, and how much of the focus that is.
  const comp = page.compParts({ total: 200, covered: 100, input: 20, output: 10, cacheRead: 60, cacheWrite: 10, unclassified: 0 });
  assert.equal(comp.coverage, 0.5);
  assert.deepEqual(comp.parts.map((p) => [p.key, p.label, p.value, p.share]), [
    ['input', '輸入', 20, 0.2], ['output', '輸出', 10, 0.1], ['cacheRead', '快取讀取', 60, 0.6], ['cacheWrite', '快取寫入', 10, 0.1], ['unclassified', '未分類', 0, 0]]);
  assert.deepEqual([page.compParts({ total: 0, covered: 0 }).coverage, page.compParts(undefined).parts[0].share], [0, 0]);
  assert.equal(page.compNote(0.62), '只算有組成資料的用量，占這段期間的 62%：部分用戶端只回報總量，較早的歷史也沒有組成。');
  assert.equal(page.compNote(0.999), '只算有組成資料的用量，占這段期間的 99%：部分用戶端只回報總量，較早的歷史也沒有組成。', 'never reads 100% when some is missing');
  assert.deepEqual([page.compNote(1), page.compNote(0)], ['', '']);

  // AI 工具額度: one line per provider.
  const now = Date.parse('2026-09-30T02:00:00.000Z');
  const inH = (h) => new Date(now + h * 3600000).toISOString();
  assert.deepEqual([page.windowRemain({ remainingPercent: 12 }), page.windowRemain({ usedPercent: 70 }), page.windowRemain({ metric: 'credits', remaining: 5 }), page.windowRemain({ used: 3, limit: 9 })], [12, 30, null, null]);
  // An account lists no spend window that has spent nothing.
  const credits = (used, limit) => ({ kind: 'billing', metric: 'spend', label: 'Usage credits', used, limit, currency: 'USD' });
  const weekly = { kind: 'weekly', remainingPercent: 42 };
  assert.deepEqual(page.shownWindows({ windows: [weekly, credits(0, null), credits(0, 20)] }), [weekly]);
  assert.deepEqual(page.shownWindows({ windows: [weekly, credits(2.35, null)] }), [weekly, credits(2.35, null)]);
  assert.equal(page.shownWindows({ windows: [{ kind: 'billing', label: 'Premium', usedPercent: 0 }] }).length, 1,'a percentage billing window stays');
  assert.deepEqual([page.shownWindows({}), page.shownWindows(null)], [[], []]);
  assert.deepEqual([page.durWords(30000), page.durWords(45 * 60000), page.durWords(2.5 * 3600000), page.durWords(50 * 3600000)], ['不到 1 分鐘', '45 分鐘', '2 小時', '2 天']);
  const accounts = [
    { windows: [{ kind: 'session', remainingPercent: 60, resetsAt: inH(1) }, { kind: 'weekly', remainingPercent: 12, resetsAt: inH(5) }] },
    { windows: [{ kind: 'session', usedPercent: 90, resetsAt: inH(2) }] },
    { windows: [{ kind: 'session', remainingPercent: 80, resetsAt: inH(-1) }] },
    { windows: [] }
  ];
  assert.equal(page.limitSummary('Claude', accounts, now).join(' · '), 'Claude · 4 個帳號 · 最低剩餘 10% · 2 個低於 15% · 最快 2 小時後重置', 'the soonest reset of a low window');
  assert.equal(page.limitSummary('Codex', [accounts[0].windows.slice(0, 1)].map((windows) => ({ windows })), now).join(' · '), 'Codex · 1 個帳號 · 最低剩餘 60% · 最快 1 小時後重置');
  assert.equal(page.limitSummary('Kimi', [{ windows: [{ metric: 'credits', remaining: 4 }] }], now).join(' · '), 'Kimi · 1 個帳號');
  // A stale account is counted, its last figures only when nothing is live.
  const offline = { stale: true, windows: [{ kind: 'weekly', remainingPercent: 5, resetsAt: inH(3) }] };
  assert.equal(page.limitSummary('Claude', [accounts[0], offline], now).join(' · '), 'Claude · 2 個帳號 · 最低剩餘 12% · 1 個低於 15% · 最快 5 小時後重置');
  assert.equal(page.limitSummary('Claude', [offline], now).join(' · '), 'Claude · 1 個帳號 · 最低剩餘 5% · 1 個低於 15% · 最快 3 小時後重置');

  // The accounts listed: upstream's, plus the stale ones it dropped because
  // the provider has a live account, from the devices that last reported them.
  const win = [{ kind: 'session', remainingPercent: 50 }];
  const listed = page.limitAccounts([
    { provider: 'claude', status: 'ok', accountEmail: 'Live@x.test', sourceDeviceId: 'd1', updatedAt: inH(0), windows: win },
    { provider: 'codex', status: 'notConfigured' }
  ], [
    { deviceId: 'd1', limits: { providers: [{ provider: 'claude', status: 'ok', accountEmail: 'Live@x.test', windows: win }] } },
    { deviceId: 'd2', receivedAt: inH(-5), limits: { providers: [
      { provider: 'claude', status: 'ok', accountEmail: 'live@x.test', windows: win },
      { provider: 'claude', status: 'ok', accountEmail: 'gone@x.test', updatedAt: inH(-6), windows: win },
      { provider: 'claude', status: 'ok', windows: win },
      { provider: 'codex', status: 'notConfigured', accountEmail: 'gone@x.test' },
      { provider: 'cursor', status: 'error', accountEmail: 'gone@x.test' }
    ] } },
    { deviceId: 'd3', limits: { updatedAt: inH(-2), providers: [{ provider: 'claude', status: 'ok', accountEmail: 'gone@x.test', planLabel: 'Max', windows: win }] } },
    { deviceId: 'd4' }
  ]);
  assert.deepEqual(listed.map((a) => [a.accountEmail, !!a.stale, a.seenAt, a.deviceIds, a.planLabel || '']), [
    ['Live@x.test', false, inH(0), ['d1', 'd2'], ''],
    ['gone@x.test', true, inH(-2), ['d2', 'd3'], 'Max']
  ], 'one row per email, the newest report of a dropped one, nothing without an email or a connection');
  assert.deepEqual(page.limitAccounts(undefined, undefined), []);
  // 裝置 lists the accounts under each device, an offline one's too: one
  // line per email, with the providers it is reported for.
  assert.deepEqual(page.deviceAccounts({ stale: true, limits: { providers: [
    { provider: 'claude', status: 'ok', accountEmail: 'su@x.test', windows: win },
    { provider: 'cursor', status: 'error', accountName: 'Su', windows: win },
    { provider: 'codex', status: 'ok', accountEmail: 'su@x.test' },
    { provider: 'codex', status: 'ok', accountEmail: 'su@x.test' },
    { provider: 'kimi', status: 'notConfigured', accountEmail: 'no@x.test', windows: win },
    { provider: 'zai', status: 'error', accountEmail: 'down@x.test' },
    { provider: 'amp', status: 'ok' }
  ] } }), [{ who: 'su@x.test', providers: ['claude', 'codex'] }, { who: 'Su', providers: ['cursor'] }]);
  assert.deepEqual([page.deviceAccounts({}), page.deviceAccounts(undefined)], [[], []]);
  // Each account's plan: Claude and Codex report theirs as accountLabel,
  // Cursor and others as planLabel, which wins.
  assert.deepEqual([
    page.accountPlan({ provider: 'claude', accountLabel: 'Max 20x' }),
    page.accountPlan({ provider: 'cursor', planLabel: 'Free' }),
    page.accountPlan({ planLabel: ' Pro ', accountLabel: 'Team' }),
    page.accountPlan({ accountEmail: 'su@x.test' }),
    page.accountPlan(undefined)
  ], ['Max 20x', 'Free', 'Pro', '', '']);

  // Their usage, and 裝置's order: the focus in the metric on screen, then
  // this month's and today's tokens, then the name.
  const focus = page.focusByDevice({ active: { devices: [{ id: 'd1', focus: { tokens: 300, costUsd: 1 } }, { id: 'd2', focus: { tokens: 50, costUsd: 4 } }] } });
  assert.deepEqual([page.accountUsage(listed[0], focus, 'tokens'), page.accountUsage(listed[1], focus, 'tokens'), page.accountUsage(listed[1], focus, 'cost')], [350, 50, 4]);
  assert.deepEqual([...page.focusByDevice({ devices: [{ id: 'd9', focus: { tokens: 1 } }] }).keys(), ...page.focusByDevice(null).keys()], ['d9'], 'one person\'s view has devices instead of active');
  // 帳號與裝置 follows the filters: the devices with usage over the focus in
  // the view (active, or one person's devices), and the accounts they hold,
  // only the picked tool's provider's.
  assert.deepEqual([...page.viewDeviceIds({ active: { devices: [{ id: 'd1', focus: { tokens: 300, costUsd: 1 } }, { id: 'd3', focus: { tokens: 0, costUsd: 0.5 } }, { id: 'd4', focus: { tokens: 0, costUsd: 0 } }] } })], ['d1', 'd3'], 'cost alone is usage');
  assert.deepEqual([...page.viewDeviceIds({ devices: [{ id: 'd9', focus: { tokens: 0, costUsd: 0 } }, { id: 'd8', focus: { tokens: 2 } }] })], ['d8'], 'one person\'s devices with usage in the focus');
  assert.equal(page.viewDeviceIds(null), null, 'no usage answer: every device');
  const emails = (ids, provider) => page.viewAccounts(listed, ids, provider).map((a) => a.accountEmail);
  assert.deepEqual(emails(new Set(['d3']), null), ['gone@x.test']);
  assert.deepEqual(emails(new Set(['d2']), null), ['Live@x.test', 'gone@x.test'], 'every account a device in the view holds');
  assert.deepEqual(emails(new Set(['d4']), null), []);
  assert.deepEqual(emails(null, null), ['Live@x.test', 'gone@x.test']);
  assert.deepEqual(emails(new Set(['d1']), 'claude'), ['Live@x.test']);
  assert.deepEqual(emails(null, 'codex'), [], 'a tool: its provider\'s accounts only');
  assert.deepEqual(emails(null, ''), [], 'a tool with no limits provider has none');
  assert.deepEqual(page.viewAccounts(undefined, null, null), []);
  const devs = [
    { deviceId: 'd4', hostname: 'B', periods: { month: { totalTokens: 9 }, today: { totalTokens: 1 } } },
    { deviceId: 'd3', hostname: 'A', periods: { month: { totalTokens: 9 }, today: { totalTokens: 1 } } },
    { deviceId: 'd2', periods: {} },
    { deviceId: 'd5', periods: { month: { totalTokens: 9 }, today: { totalTokens: 2 } } },
    { deviceId: 'd1' }
  ];
  assert.deepEqual(page.deviceOrder(devs, focus, 'tokens').map((d) => d.deviceId), ['d1', 'd2', 'd5', 'd3', 'd4']);
  assert.deepEqual(page.deviceOrder(devs, focus, 'cost').map((d) => d.deviceId).slice(0, 2), ['d2', 'd1']);
  assert.deepEqual(page.deviceOrder(devs, new Map(), 'tokens').map((d) => d.deviceId), ['d5', 'd3', 'd4', 'd1', 'd2'], 'by its own month before the usage answer');
  assert.equal(devs[0].deviceId, 'd4', 'a sorted copy');
  // The 狀態 badge's hint names the device's own stale threshold: the hub's,
  // or two upload intervals (upstream staleAfterMsForSyncUpload).
  const min = 60000;
  assert.deepEqual([
    page.deviceStaleAfter({}, 10 * min),
    page.deviceStaleAfter({ syncUploadIntervalMs: 0 }, 10 * min),
    page.deviceStaleAfter({ syncUploadIntervalMs: 30 * min }, 10 * min),
    page.deviceStaleAfter({ syncUploadIntervalMs: 10 * min }, 45 * min),
    page.deviceStaleAfter({ syncUploadIntervalMs: 7 * min }, 10 * min),
    page.deviceStaleAfter({ syncUploadIntervalMs: 30 * min }, 0),
    page.deviceStaleAfter(undefined, undefined)
  ], [10 * min, 10 * min, 60 * min, 45 * min, 10 * min, 0, 0]);
  assert.equal(page.deviceStateHint({ syncUploadIntervalMs: 20 * min }, 10 * min),
    'live：40 分鐘內有回報，用量與額度是最新的。\nstale：超過 40 分鐘沒回報（關機、睡眠、斷線或用戶端沒在執行），用量與額度停在最後一次回報，下次回報後變回 live。');
  assert.match(page.deviceStateHint({ syncUploadIntervalMs: 30 * min }, 10 * min), /^live：1 小時內有回報/);
  assert.match(page.deviceStateHint({}, 90 * min), /^live：1 小時 30 分鐘內有回報/);
  assert.equal(page.deviceStateHint({}, 0), 'live：hub 沒有設定 stale 的門檻，每台裝置都算 live。');
  // The box the badge hints show in has a class of its own: .hint is the
  // muted text beside every heading, and a fixed .hint floated them all.
  const css = fs.readFileSync(path.join(__dirname, '..', 'hub', 'dashboard.html'), 'utf8');
  assert.doesNotMatch(css, /\.hint\b[^{}]*\{[^}]*position:\s*fixed/);
  assert.match(css, /\.hintbox\{position:fixed/);

  // AI 工具額度's 工具 and 排序: one provider or every one, the providers by
  // name, the accounts in each in that provider's own order.
  assert.deepEqual(page.limitFigures([offline], now), { min: 5, low: 1, soon: Date.parse(inH(3)) });
  const w = (left, h) => [{ kind: 'session', remainingPercent: left, resetsAt: inH(h) }];
  const pool = [
    { provider: 'claude', accountEmail: 'a@x.test', deviceIds: ['d2'], windows: w(60, 4) },
    { provider: 'claude', accountEmail: 'b@x.test', deviceIds: [], windows: w(10, 6) },
    { provider: 'claude', accountEmail: 'c@x.test', deviceIds: ['d2'], windows: w(30, 1) },
    { provider: 'codex', accountEmail: 'z@x.test', deviceIds: ['d1'], windows: w(80, 2) },
    { provider: 'codex', accountEmail: 'y@x.test', deviceIds: ['d1'], windows: w(90, 3) },
    { provider: 'amp', accountEmail: 'm@x.test', deviceIds: [], windows: [{ metric: 'credits', remaining: 4 }] },
    { provider: 'amp', accountEmail: 'n@x.test', deviceIds: [], windows: w(50, 5) }
  ];
  const names = { claude: 'Claude', codex: 'Codex', amp: 'Amp' };
  const grouped = (opts) => page.limitGroups(pool, Object.assign({ tool: '', focus, metric: 'tokens', label: (id) => names[id], now }, opts))
    .map((g) => [g.label, g.rows.map((r) => r.account.accountEmail).join(' ')]);
  const own = (sorts) => grouped({ sorts: new Map(sorts) });
  assert.deepEqual(grouped({}), [['Amp', 'n@x.test m@x.test'], ['Claude', 'c@x.test a@x.test b@x.test'], ['Codex', 'z@x.test y@x.test']],
    'providers by name, however much they used; equal usage goes to the least left, no percentage last');
  assert.deepEqual(grouped({ focus: new Map() }), [['Amp', 'n@x.test m@x.test'], ['Claude', 'b@x.test c@x.test a@x.test'], ['Codex', 'z@x.test y@x.test']], 'the least left before the usage answer');
  assert.deepEqual(own([['claude', { sort: 'left', rev: false }], ['codex', { sort: 'name', rev: false }], ['amp', { sort: 'name', rev: true }]]),
    [['Amp', 'n@x.test m@x.test'], ['Claude', 'b@x.test c@x.test a@x.test'], ['Codex', 'y@x.test z@x.test']], 'each provider in its own order');
  assert.deepEqual(own([['claude', { sort: 'name', rev: false }]]), [['Amp', 'n@x.test m@x.test'], ['Claude', 'a@x.test b@x.test c@x.test'], ['Codex', 'z@x.test y@x.test']],
    'one provider\'s 排序 leaves the others by 用量');
  assert.deepEqual(own([['claude', { sort: 'reset', rev: false }]]), grouped({}), 'no 重置時間 any more: 用量');
  // The picked tab again: the same order turned around, ties as they were.
  assert.deepEqual(own([['claude', { sort: 'usage', rev: true }], ['amp', { sort: 'usage', rev: true }]]).map((g) => g[1]).slice(0, 2), ['n@x.test m@x.test', 'b@x.test c@x.test a@x.test'],
    'the least used first; equal usage still goes to the least left');
  assert.deepEqual(own([['claude', { sort: 'left', rev: true }], ['amp', { sort: 'left', rev: true }]]).map((g) => g[1]).slice(0, 2), ['n@x.test m@x.test', 'a@x.test c@x.test b@x.test'],
    'no percentage still last');
  assert.deepEqual(own([['claude', { sort: 'name', rev: true }]])[1], ['Claude', 'c@x.test b@x.test a@x.test']);
  assert.deepEqual(page.limitGroups(pool, { tool: '', sorts: new Map([['codex', { sort: 'name', rev: true }]]), focus, metric: 'tokens', label: (id) => names[id], now })
    .map((g) => [g.id, g.sort, g.rev]), [['amp', 'usage', false], ['claude', 'usage', false], ['codex', 'name', true]], 'what each provider\'s tabs show');
  assert.deepEqual(grouped({ tool: 'codex' }), [['Codex', 'z@x.test y@x.test']]);
  assert.deepEqual([grouped({ tool: 'zed' }), page.limitGroups(undefined, { focus, label: String, now })], [[], []]);
  assert.deepEqual(['tokens', 'cost'].map((metric) => page.limitGroups(pool, { tool: 'claude', focus, metric, label: String, now })[0].rows.map((r) => r.used)), [[50, 50, 0], [4, 4, 0]],
    'in the metric on screen');

  // 工具狀態: the best status over the devices and how many are in it; a
  // tool no device has is left out.
  assert.deepEqual(page.clientCounts([
    { clientStatus: { claude: 'active', codex: 'waiting', zed: 'missing', amp: 'waiting' } },
    { clientStatus: { claude: 'active', codex: 'active', __proto__x: 'missing', amp: 'missing' } },
    { clientStatus: { claude: 'missing', zed: 'missing' } },
    {}
  ]), [{ id: 'claude', status: 'active', count: 2 }, { id: 'codex', status: 'active', count: 1 }, { id: 'amp', status: 'waiting', count: 1 }]);
  assert.deepEqual(page.clientCounts(undefined), []);

  // 裝置: one device's tools, in use first, then the most tokens this month.
  const tools = page.deviceTools({
    clientStatus: { claude: 'active', codex: 'active', copilot: 'waiting', zed: 'missing', amp: 'missing', kimi: 'missing' },
    periods: {
      today: { clients: { codex: 5, claude: 7 } },
      month: { clients: { claude: 40, codex: 90, gemini: 3, kimi: 2 } }
    }
  }, (id) => ({ zed: 'Alpha', amp: 'Beta' })[id] || id);
  assert.deepEqual(tools.rows, [
    { id: 'codex', status: 'active', today: 5, month: 90 },
    { id: 'claude', status: 'active', today: 7, month: 40 },
    { id: 'copilot', status: 'waiting', today: 0, month: 0 },
    { id: 'gemini', status: 'untracked', today: 0, month: 3 },
    { id: 'kimi', status: 'missing', today: 0, month: 2 }
  ], 'a tool with tokens is listed even when it is not tracked or not found now; the ones not installed are left out');
  assert.deepEqual(tools.tally, [['active', 2], ['waiting', 1], ['untracked', 1], ['missing', 1]]);
  assert.deepEqual(page.deviceTools({ clientStatus: { __proto__x: 'active' }, periods: { today: null } }).rows,
    [{ id: '__proto__x', status: 'active', today: 0, month: 0 }]);
  assert.deepEqual(page.deviceTools(undefined), { rows: [], tally: [] });

  // 帳號排行: an account's providers and unit below the scope, its devices,
  // and what a search matches.
  const account = { who: ['Su@initech.example'], providers: ['claude', 'codex'], tools: [{ client: 'claude' }], devices: [{ id: 'd1', hostname: 'PC-LAPTOP-009' }, { id: 'd2', hostname: null }],
    unit: { id: 'INITECH/CI/QA', name: 'QA', path: ['INITECH', 'CI', 'QA'] } };
  const label = { provider: (id) => ({ claude: 'Claude', codex: 'Codex' })[id], client: (id) => ({ claude: 'Claude Code' })[id] };
  const words = page.accountWords(account, 1, label);
  assert.deepEqual([words.sub, words.hosts], ['Claude、Codex · CI / QA', ['PC-LAPTOP-009', 'd2']]);
  for (const q of ['su@initech', 'claude code', 'laptop-009', 'initech / ci']) assert.ok(words.search.includes(q), q);
  assert.equal(page.accountWords(account, 3, label).sub, 'Claude、Codex', 'the scope itself is not repeated');
  assert.equal(page.accountWords({ other: true, devices: [] }, 0, label).sub, '沒有對應到帳號的工具');

  // 帳號排行: the accounts with tokens in the focus, the most first and
  // ranked, then 其他 unranked whatever its size; a search ranks what it
  // finds and leaves 其他 out.
  const ranked = [
    { id: 'su', name: 'su@x', who: ['su@x'], focus: { tokens: 140 }, previous: { tokens: 20 } },
    { id: 'amy + bob', name: 'amy、bob', who: ['amy', 'bob'], shared: true, focus: { tokens: 60 }, previous: { tokens: 90 } },
    { id: 'old', name: 'old@x', who: ['old@x'], focus: { tokens: 0 }, previous: { tokens: 30 } },
    { id: 'other', other: true, focus: { tokens: 900 }, previous: {} },
    { id: 'eve', name: 'eve@x', who: ['eve@x'], focus: { tokens: 60 }, previous: {} }
  ];
  assert.deepEqual(page.accountRanking(ranked).map((r) => [r.row.id, r.row.name, r.value, r.rank]), [
    ['su', 'su@x', 140, 1], ['amy + bob', 'amy、bob', 60, 2], ['eve', 'eve@x', 60, 3], ['other', '其他', 900, 0]
  ], 'an account with nothing this period is not listed; a tie goes by name');
  const find = (q) => page.accountRanking(ranked, { q, words: (a) => (a.who || []).join(' ') }).map((r) => [r.row.id, r.rank]);
  assert.deepEqual(find('bob'), [['amy + bob', 1]]);
  assert.deepEqual(find('nobody'), []);
  assert.deepEqual(page.accountRanking(undefined), []);

  // An HR file: its company from the name, and the import route with every
  // part encoded.
  assert.deepEqual([page.companyOf('ACME Announcement 20260801.xlsx'), page.companyOf('initech list.xlsx'), page.companyOf('名單.xlsx'), page.companyOf('名單.xlsx', 'GLOBEX'), page.companyOf('ACME 名單.xlsx', 'GLOBEX')], ['ACME', 'INITECH', '', 'GLOBEX', 'ACME'], 'a name with no code: the company typed in');
  assert.equal(page.importPath({ name: 'ACME Announcement 20260801.xlsx' }, '/preview'),
    '/api/admin/org/import/preview?company=ACME&fileName=ACME%20Announcement%2020260801.xlsx');
  assert.equal(page.importPath({ name: 'GLOBEX a&b.xlsx' }, '', '&confirm=1'), '/api/admin/org/import?company=GLOBEX&fileName=GLOBEX%20a%26b.xlsx&confirm=1');
  // 員工清單 shows a unit's path without HR's '-' for a missing BU.
  assert.equal(page.staffPath({ unitPath: ['ACME', '-', 'GM Office'] }), 'ACME / GM Office');
  assert.equal(page.staffPath({}), '');

  assert.equal(page.reconcileText({ assigned: 1, changed: 2, unchanged: 3, manual: 4, unmatched: 5, withdrawn: 0, companyOnly: 6, backdated: 7 }),
    '重新對應：新指定 1 台、改變 2 台、維持 3 台、手動 4 台、找不到員工 5 台、只到公司 6 台、往前延伸 7 台');
  assert.match(page.reconcileText({ withdrawn: 2 }), /找不到員工 0 台、結束 2 台、只到公司 0 台、往前延伸 0 台$/);

  // The markup: the person's 裝置 before the trend, pickers, the warning,
  // scroll boxes, h3 under the group titles, one header helper for tables.
  const html = fs.readFileSync(path.join(__dirname, '..', 'hub', 'dashboard.html'), 'utf8');
  const script = pageScript();
  for (const id of ['deviceSection', 'deviceChart', 'compChart', 'compNote', 'previews', 'issues', 'emailBulk', 'depts', 'staff']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.ok(html.indexOf('id="deviceSection"') < html.indexOf('id="trendSection"'));
  assert.doesNotMatch(html, /id="ownerForm"|id="ownerSection"/, 'devices are not assigned by hand any more: ownership goes by email');
  for (const id of ['depts', 'staff', 'devices']) assert.match(html, new RegExp(`class="scroll tall" id="${id}"`), id);
  const admin = html.slice(html.indexOf('id="adminArea"'), html.indexOf('<script>'));
  assert.doesNotMatch(admin.replace(/<h2 class="group">[^<]*<\/h2>/g, ''), /<h2/, 'sections under a group title are h3');
  assert.match(html, /@media \(prefers-reduced-motion:reduce\)/);
  assert.equal(script.split("el('th'").length, 2, 'tables get their header from thead() alone');
  assert.doesNotMatch(script, /\.innerHTML\s*=/, 'no innerHTML at all');
  assert.doesNotMatch(script, /\bfunction esc\(/);
  // 使用人數 and 活躍裝置 open their list right under the cards.
  assert.match(html, /id="kpis"><div class="empty" data-en="Loading…">載入中…<\/div><\/div>\s*<section id="kpiDetail" hidden><\/section>/);
  assert.match(script, /\[L\('活躍裝置', 'Active devices'\), [^\n]*, deviceSub, 'devices'\]/);
  // Its hostnames open that device in 裝置 below, and so do the devices an
  // account in AI 工具額度 is on, those 裝置 lists only.
  assert.ok(script.includes("link.addEventListener('click', () => showDevice(id, hostname));"));
  assert.ok(script.includes('host.append(deviceLink(r.id, r.hostname, hostname));'));
  assert.ok(script.includes('deviceLink(d.id, d.hostname, d.hostname || d.id)'));
  assert.ok(script.includes('devices: a.deviceIds.filter((id) => hosts.has(id) && (!shown.ids || shown.ids.has(id))).map((id) => ({ id, hostname: hosts.get(id) })),'));
  // Account names and emails in 帳號與裝置 for everyone, the plan in a badge
  // of its own.
  assert.match(script, /const who = \[p\.accountName, p\.accountEmail\]/);
  assert.match(script, /if \(plan\) head\.append\(el\('span', 'badge plan', plan\)\);/);
  // The roster (部門清單, 員工清單) is fetched only while its list is open.
  for (const [fn, box] of [['refreshDepts', 'deptBox'], ['refreshStaff', 'staffBox']]) {
    const start = script.indexOf(`\nasync function ${fn}(`);
    const body = script.slice(start, script.indexOf('\n}\n', start));
    assert.ok(body.includes(`if (!$('${box}').open) return;`), fn);
  }
});

test('page: 資料庫備份 lists, makes and deletes the hub\'s backups', () => {
  const page = pageFns(['bytesText', 'backupKindLabel', 'backupReasonText', 'backupHint', 'localStamp']);
  assert.deepEqual([0, 1023, 1536, 5 * 1024 * 1024, 3 * 1024 ** 3].map(page.bytesText), ['0 B', '1023 B', '1.5 KB', '5.0 MB', '3.00 GB']);
  assert.deepEqual(['daily', 'manual', 'purge', 'x'].map(page.backupKindLabel), ['每日', '手動', '刪除前', 'x']);
  assert.match(page.backupReasonText('pg_dump_missing'), /找不到 pg_dump/);
  assert.equal(page.backupReasonText(null), '原因不明');
  // The hub's hour is UTC; the hint is in the viewer's time.
  const local = new Date(Date.parse('2026-10-02T19:00:00Z'));
  const hhmm = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
  assert.equal(page.backupHint({ available: true, keep: 14, hourUtc: 19 }, '2026-10-02'), `每天 ${hhmm} 自動備份，保留最近 14 份每日備份`);
  assert.match(page.backupHint({ available: true, keep: 0, hourUtc: 19 }, '2026-10-02'), /只有手動備份/);
  assert.equal(page.backupHint({ available: false }, '2026-10-02'), '');
  assert.equal(page.localStamp('nope'), '—');

  const html = fs.readFileSync(path.join(__dirname, '..', 'hub', 'dashboard.html'), 'utf8');
  const script = pageScript();
  const admin = html.slice(html.indexOf('id="adminArea"'), html.indexOf('帳號與裝置</h2>'));
  for (const id of ['backupSection', 'backupNow', 'backups', 'backupNote', 'backupHint']) assert.match(admin, new RegExp(`id="${id}"`), id);
  assert.ok(script.includes("request('/api/admin/backups')"));
  // Shown with a database only, refreshed with the rest of 管理, emptied on sign-out.
  assert.match(script, /'tokenSection', 'backupSection'[^\]]*\]\) \$\(id\)\.hidden = !database;/);
  assert.match(script, /refreshTokens\(\), refreshBackups\(\)/);
  const signOut = script.slice(script.indexOf('\nasync function signOut('), script.indexOf('\n}\n', script.indexOf('\nasync function signOut(')));
  assert.ok(signOut.includes("'backups', 'backupNote', 'backupHint'"));
  // A purge dump is the only copy of what it deleted: its delete says so.
  assert.match(script, /這是刪除歷史資料之前的備份，也是那些資料唯一的一份/);
});

test('page: 刪除歷史資料 offers the months above the floor and says what a purge deletes', () => {
  const page = pageFns(['addMonths', 'monthWords', 'purgeMonths', 'purgeSummary', 'tokens', 'usd']);
  assert.deepEqual([page.addMonths('2026-01', -1), page.addMonths('2025-12', 1), page.addMonths('2024-02', 12)], ['2025-12', '2026-01', '2025-02']);
  // Keeping from the first month with usage deletes nothing, so it is not offered.
  assert.deepEqual(page.purgeMonths('2026-06', null, '2026-10'), ['2026-07', '2026-08', '2026-09', '2026-10']);
  assert.deepEqual(page.purgeMonths('2026-06', '2026-09', '2026-10'), ['2026-10'], 'above the floor only');
  assert.deepEqual(page.purgeMonths('2026-10', null, '2026-10'), []);
  assert.deepEqual(page.purgeMonths(null, null, '2026-10'), []);
  assert.equal(page.purgeSummary({ month: '2026-08', tables: { a: 0 } }), '2026 年 8 月以前沒有任何用量，不會刪除資料。');
  assert.equal(page.purgeSummary({
    month: '2026-08',
    tables: { device_daily_usage: 4, device_monthly_usage: 2 },
    daily: { first: '2026-06-15', devices: 2, tokens: 1600, costUsd: 0.8 },
    monthly: { first: '2026-05', devices: 1, tokens: 5000, costUsd: 2.5 }
  }), '會刪除2026 年 8 月以前的 6 列資料：2 台裝置從 2026-06-15 起的每日用量（1.6K tokens、$0.80），1 台裝置從 2026 年 5 月起的每月合計。');

  const html = fs.readFileSync(path.join(__dirname, '..', 'hub', 'dashboard.html'), 'utf8');
  const script = pageScript();
  const admin = html.slice(html.indexOf('id="adminArea"'), html.indexOf('帳號與裝置</h2>'));
  for (const id of ['purgeSection', 'purgeMonth', 'purgeLook', 'purgePreview', 'purgeConfirmForm', 'purgeConfirm', 'purgeRun', 'purgeNote', 'purges']) assert.match(admin, new RegExp(`id="${id}"`), id);
  // The run button stays off until the month is typed back.
  assert.ok(admin.includes('<button type="submit" id="purgeRun" disabled data-en="Back up, then delete">先備份，再刪除</button>'));
  assert.ok(script.includes("$('purgeRun').disabled = !purgePending || $('purgeConfirm').value.trim() !== purgePending;"));
  assert.ok(script.includes("'backupSection', 'purgeSection']) $(id).hidden = !database;"));
  const signOut = script.slice(script.indexOf('\nasync function signOut('), script.indexOf('\n}\n', script.indexOf('\nasync function signOut(')));
  assert.ok(signOut.includes('resetPurgeConfirm()'));
});

test('page: tables sort by any column, and the unit and device lists can be searched', () => {
  const page = pageFns(['nextSort', 'sortRows', 'searchWords', 'matchesAll', 'deviceHaystack', 'deviceSearchFor']);
  // Numbers start with the largest, text with A; the same column again turns it.
  assert.deepEqual(page.nextSort(null, 'tokens', true), { key: 'tokens', dir: 'desc' });
  assert.deepEqual(page.nextSort(null, 'name', false), { key: 'name', dir: 'asc' });
  assert.deepEqual(page.nextSort({ key: 'tokens', dir: 'desc' }, 'tokens', true), { key: 'tokens', dir: 'asc' });
  assert.deepEqual(page.nextSort({ key: 'tokens', dir: 'asc' }, 'name', false), { key: 'name', dir: 'asc' });
  const rows = [{ n: 'b', v: 2 }, { n: 'a', v: null }, { n: 'c', v: 2 }, { n: 'd', v: 9 }];
  const by = { v: (r) => r.v, n: (r) => r.n };
  assert.deepEqual(page.sortRows(rows, { key: 'v', dir: 'desc' }, by).map((r) => r.n), ['d', 'b', 'c', 'a'], 'ties keep their order, no value last');
  assert.deepEqual(page.sortRows(rows, { key: 'v', dir: 'asc' }, by).map((r) => r.n), ['b', 'c', 'd', 'a'], 'no value last both ways');
  assert.deepEqual(page.sortRows(rows, { key: 'n', dir: 'desc' }, by).map((r) => r.n), ['d', 'c', 'b', 'a']);
  assert.deepEqual(page.sortRows(rows, null, by).map((r) => r.n), ['b', 'a', 'c', 'd']);
  assert.deepEqual(page.sortRows(rows, { key: 'gone', dir: 'asc' }, by).map((r) => r.n), ['b', 'a', 'c', 'd']);
  // Every word must match, anywhere, in any case; no pattern syntax.
  assert.deepEqual(page.searchWords('  Data   Cloud '), ['data', 'cloud']);
  assert.equal(page.matchesAll('ACME / Cloud / Data', page.searchWords('cloud data')), true);
  assert.equal(page.matchesAll('ACME / Cloud / Data', page.searchWords('cloud infra')), false);
  assert.equal(page.matchesAll('a.b', page.searchWords('.*')), false);
  assert.equal(page.matchesAll('anything', []), true);
  // A device is found by its name, system, accounts, owner, unit and tools.
  const label = { provider: (id) => ({ claude: 'Claude' })[id] || id, client: (id) => ({ claude: 'Claude Code', codex: 'Codex' })[id] || id };
  const hay = page.deviceHaystack(
    { hostname: 'ACME-NB01', deviceId: 'dev-1', osName: 'Windows', osVersion: '11', agentVersion: '0.63.1-corp.4', clientStatus: { claude: 'active', codex: 'waiting', zed: 'missing' } },
    { employee: { name: 'Alice Wang' }, unit: { path: ['ACME', 'Games', 'Aurora'] } },
    [{ who: 'alice@at.test', providers: ['claude'] }], label);
  for (const q of ['nb01', 'dev-1', 'windows 11', 'corp.4', 'alice@at', 'alice wang', 'games / aurora', 'claude code', 'codex']) assert.ok(page.matchesAll(hay, page.searchWords(q)), q);
  assert.equal(page.matchesAll(hay, page.searchWords('zed')), false, 'a tool it does not have');
  assert.equal(page.deviceHaystack({ deviceId: 'x' }, null, null, label), 'x');
  // A hostname in 活躍裝置明細 searches 裝置 for that device alone: by its
  // hostname, or by its id when the hostname finds another device too.
  const devs = [{ deviceId: 'd1', hostname: 'PC-LAPTOP-036' }, { deviceId: 'd2', hostname: 'PC-LAPTOP-036.local' }, { deviceId: 'd3', hostname: 'PC-LAPTOP-053' }];
  const hostHay = (d) => [d.hostname, d.deviceId].join('\n');
  assert.equal(page.deviceSearchFor('d3', 'PC-LAPTOP-053', devs, hostHay), 'PC-LAPTOP-053');
  assert.equal(page.deviceSearchFor('d2', 'PC-LAPTOP-036.local', devs, hostHay), 'PC-LAPTOP-036.local');
  assert.equal(page.deviceSearchFor('d1', 'PC-LAPTOP-036', devs, hostHay), 'd1', 'the hostname finds d2 too');
  assert.equal(page.deviceSearchFor('d4', null, devs, hostHay), 'd4', 'no hostname');
  assert.equal(page.deviceSearchFor('d3', 'PC-LAPTOP-053', [], hostHay), 'PC-LAPTOP-053', 'before /api/stats answers');

  const html = fs.readFileSync(path.join(__dirname, '..', 'hub', 'dashboard.html'), 'utf8');
  const script = pageScript();
  for (const id of ['unitSearch', 'deviceSearch', 'userTable', 'accountTable', 'userTableBox', 'accountTableBox']) assert.match(html, new RegExp(`id="${id}"`), id);
  // A sortable column is a button that says how it is sorted.
  assert.match(script, /th\.setAttribute\('aria-sort', sort\.dir === 'asc' \? 'ascending' : 'descending'\)/);
  assert.equal(script.split("el('th'").length, 2, 'still one header helper');
  // Changing 排序 hands the unit table back to the bars' order.
  assert.equal(script.split("tableSorts.delete('unitTable');").length, 3);
});

test('page: the main script builds no markup from data and keeps its required hooks', () => {
  const script = pageScript();
  const html = fs.readFileSync(path.join(__dirname, '..', 'hub', 'dashboard.html'), 'utf8');
  const sinks = script.split('\n').filter((line) => /\.innerHTML\s*=\s*(?!''\s*;)(?=\S)/.test(line));
  assert.ok(sinks.length <= 7, `non-empty innerHTML assignments: ${sinks.length}`);
  assert.doesNotMatch(script, /insertAdjacentHTML|outerHTML\s*=|document\.write|createContextualFragment|DOMParser|srcdoc|\beval\(|new Function|new RegExp\(/);
  assert.doesNotMatch(script, /setAttribute\(\s*['"](on\w+|href|src|xlink:href|style)['"]/);
  assert.doesNotMatch(script, /querySelector(All)?\([^)]*\+/);
  assert.equal(html.split('</head>').length, 2, 'exactly one </head>');
  for (const period of ['day', 'week', 'month', 'year', '7d', '30d', '90d', 'custom']) assert.ok(html.includes(`data-period="${period}"`), period);
  assert.match(html, /<button class="ghost" id="lastYear" type="button" hidden data-en="Last year">去年<\/button>/);
  for (const id of ['selTool', 'toolChip', 'toolName', 'toolClear', 'measureTool', 'usortTool', 'customFrom', 'customTo', 'customApply', 'personChip', 'personClear', 'crumbs', 'compareText', 'live', 'notes', 'compSection', 'adminLink']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /id="live" aria-live="polite"/);
  assert.match(html, /id="theme"[^>]*aria-label="切換深淺色"/);
  assert.doesNotMatch(html, /id="error"/);
  // No 比較 to pick (always 上一期), and AI 工具額度 does not sort by 重置時間.
  assert.doesNotMatch(html, /id="compareMode"|id="compareFilter"|data-lsort="reset"/);
  for (const id of ['kpis', 'unitChart', 'trend']) assert.match(html, new RegExp(`id="${id}"><div class="empty" data-en="Loading…">載入中…</div>`), id);
  // 管理 stays above 帳號與裝置 in the markup: the tests above read its
  // sections between the two.
  assert.ok(html.indexOf('id="adminArea"') < html.indexOf('帳號與裝置</h2>'));
  // Only loads someone started say 「用量已更新。」; start() and admin actions stay silent.
  assert.match(script, /loadUsage\(\{ announce: true \}\)/);
  assert.match(script, /else if \(opts\.announce\) announce\(L\('用量已更新。', 'Usage updated\.'\)\)/);
  // Signing out empties the person view at once (4.2).
  const signOut = script.slice(script.indexOf('\nasync function signOut('), script.indexOf('\n}\n', script.indexOf('\nasync function signOut(')));
  for (const hook of ['renderPersonChip()', "'crumbs'", "$('kpis').replaceChildren(", 'setStatus(']) assert.ok(signOut.includes(hook), hook);
});

test('page: /admin has a left rail, one link per part of 管理 and one part at a time', () => {
  const { railSection } = pageFns(['railSection']);
  const shown = ['importSection', 'issueSection', 'emailSection'];
  assert.equal(railSection('#emailSection', shown), 'emailSection');
  assert.equal(railSection('emailSection', shown), 'emailSection');
  assert.equal(railSection('', shown), 'importSection');
  // A hidden part (no database) or an unknown hash falls back to the first shown.
  assert.equal(railSection('#purgeSection', ['versionSection']), 'versionSection');
  assert.equal(railSection('#nope', shown), 'importSection');
  assert.equal(railSection('#importSection', []), '');

  const html = fs.readFileSync(path.join(__dirname, '..', 'hub', 'dashboard.html'), 'utf8');
  const rail = html.slice(html.indexOf('<nav class="rail" id="adminRail"'), html.indexOf('</nav>'));
  const start = html.indexOf('<div id="adminArea"');
  const area = html.slice(start, html.indexOf('\n</div>\n', start));
  const linked = [...rail.matchAll(/<a href="#(\w+)"/g)].map((m) => m[1]);
  const parts = [...area.matchAll(/<section id="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(linked, parts);
  assert.ok(rail.includes('<a href="./" id="railUsage">'));
  for (const id of ['issueSection', 'emailSection', 'versionSection']) assert.ok(rail.includes(`id="${id}Count"`), id);

  const script = pageScript();
  const body = (name) => {
    const at = script.search(new RegExp(`\\n(async )?function ${name}\\(`));
    assert.ok(at > 0, name);
    return script.slice(at, script.indexOf('\n}\n', at));
  };
  // The rail goes and comes with 管理, and each count follows its part's hint.
  assert.equal(body('refreshAdmin').split('syncRail();').length, 4);
  assert.ok(body('signOut').includes('syncRail();'));
  assert.ok(body('refreshIssues').includes("railCount('issueSection', total);"));
  assert.ok(body('refreshEmails').includes("railCount('emailSection', list.length);"));
  assert.ok(body('renderVersions').includes("railCount('versionSection', older.length);"));
  assert.ok(script.includes("$('railUsage').href = $('usageLink').href;"));
});

test('page: / shows the usage and /admin 管理, each loading only its own part', () => {
  const page = pageFns(['isAdminPage']);
  for (const pathname of ['/admin', '/tm/admin']) assert.equal(page.isAdminPage(pathname), true, pathname);
  for (const pathname of ['/', '/dashboard', '/index.html', '/admin/', '/administration', '', undefined]) assert.equal(page.isAdminPage(pathname), false, String(pathname));

  const html = fs.readFileSync(path.join(__dirname, '..', 'hub', 'dashboard.html'), 'utf8');
  const script = pageScript();
  const body = (name) => {
    const start = script.search(new RegExp(`\\n(async )?function ${name}\\(`));
    assert.ok(start > 0, name);
    return script.slice(start, script.indexOf('\n}\n', start));
  };
  // The usage page's parts are three boxes /admin hides; 管理 is outside them.
  for (const id of ['filters', 'content', 'accountsArea', 'adminGate', 'usageLink']) assert.match(html, new RegExp(`id="${id}"`), id);
  const content = html.slice(html.indexOf('<div id="content">'), html.indexOf('<div class="notice" id="adminGate"'));
  assert.ok(content.length > 0 && !content.includes('id="adminArea"'));
  assert.ok(html.indexOf('id="adminArea"') < html.indexOf('<div id="accountsArea">'));
  assert.ok(body('showPage').includes("for (const id of ['filters', 'content', 'accountsArea']) $(id).hidden = ADMIN_PAGE;"));
  // 前往管理區 opens /admin; 回到用量 comes back.
  assert.match(html, /<a href="admin" id="adminLink" hidden data-en="Go to administration">前往管理區<\/a><a href="\.\/" id="usageLink" hidden data-en="Back to usage">回到用量<\/a>/);
  // / never asks for 管理, /admin never for the usage, nor writes a view into its link.
  assert.ok(body('refreshAdmin').includes('if (!ADMIN_PAGE) return;'));
  assert.ok(body('start').includes('if (!ADMIN_PAGE) {\n      renderFilters();\n      syncUrl(\'replace\');\n      loadUsage();\n    }'));
  assert.ok(body('syncUrl').includes('if (ADMIN_PAGE) return;'));
  // Its changes ask for the usage again, which only / reads.
  assert.ok(body('loadUsage').includes('if (ADMIN_PAGE) return;'));
  // 前往管理區 shows for a signed-in admin on /, whatever the usage answered.
  assert.ok(body('renderAdmin').includes("$('adminLink').hidden = ADMIN_PAGE || !isAdmin();"));
  assert.doesNotMatch(body('renderStatus'), /adminLink/);
  // Signed out, /admin says why and asks for the key.
  assert.ok(script.includes('if (ADMIN_PAGE && !signedIn) showAdminForm(true);'));
  assert.match(body('showAdminGate'), /管理頁只給管理員/);
  assert.match(body('showAdminGate'), /登入已過期，請重新登入。/);

  // Links across: 去歸類, 前往匯入 and 未歸類 email go to their part of
  // /admin, which scrolls there once it is drawn; a name in 員工清單 opens
  // that person on / in a new tab. Both keep an English page English.
  const zh = pageFnsIn('zh-Hant', ['adminHref', 'personHref']);
  const en = pageFnsIn('en', ['adminHref', 'personHref']);
  assert.deepEqual([zh.adminHref('emailSection'), en.adminHref('importSection')], ['admin#emailSection', 'admin?lang=en#importSection']);
  assert.deepEqual([zh.personHref('ACME 1&2'), en.personHref('ACME-1')], ['./?employee=ACME%201%262', './?employee=ACME-1&lang=en']);
  assert.doesNotMatch(script, /\.href = '#/, 'no link points into the page any more');
  assert.equal(script.split("adminHref('emailSection')").length, 3);
  assert.ok(script.includes("link.href = adminHref('importSection');"));
  assert.ok(body('refreshAdmin').includes("if (target && $('adminArea').contains(target) && !target.hidden) target.scrollIntoView({ block: 'start' });"));
  const staff = body('renderStaff');
  for (const part of ['open.href = personHref(e.employeeId);', "open.target = '_blank';", "open.rel = 'noopener';"]) assert.ok(staff.includes(part), part);
  assert.ok(!staff.includes('changeView('), '管理 has no view to change');
});

// The dashboard's markup is written in Chinese. Every Chinese text is in an
// element marked data-en (the script puts that English in its place) or
// lang="zh-Hant" (a block with more than text in it, next to its lang="en"
// twin), and every Chinese label, placeholder or title has its data-en-*.
// An element marked data-en holds text only: its children would be lost.
function dashboardMarkup(html) {
  const chinese = /[\p{Script=Han}\p{Script=Bopomofo}]/u;
  const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('<script>\nconst $ ='));
  const VOID = new Set(['br', 'hr', 'img', 'input', 'wbr']);
  const stack = [];
  const problems = [];
  const english = [];
  const marked = { 'zh-Hant': 0, en: 0 };
  let translated = 0;
  const inside = (test) => stack.some(test);
  for (const [, close, name, attrs, text] of body.matchAll(/<(\/?)(\w+)([^>]*)>|([^<]+)/g)) {
    if (text !== undefined) {
      if (!chinese.test(text)) continue;
      if (inside((t) => t.lang === 'en')) problems.push('Chinese in English: ' + text.trim());
      else if (!inside((t) => t.en || t.lang === 'zh-Hant')) problems.push('not translated: ' + text.trim());
      continue;
    }
    if (close) {
      const at = stack.map((tag) => tag.name).lastIndexOf(name);
      assert.ok(at >= 0, `</${name}> closes an open element`);
      stack.length = at;
      continue;
    }
    if (inside((t) => t.en)) problems.push(`<${name}> inside an element marked data-en`);
    const attr = (key) => {
      const found = attrs.match(new RegExp('(?:^|\\s)' + key + '="([^"]*)"'));
      return found ? found[1] : null;
    };
    const lang = attr('lang');
    if (Object.hasOwn(marked, lang)) marked[lang] += 1;
    const en = attr('data-en');
    if (en !== null) {
      translated += 1;
      english.push(en);
    }
    for (const key of ['aria-label', 'placeholder', 'title']) {
      const value = attr(key);
      const twin = attr('data-en-' + key);
      if (twin !== null) english.push(twin);
      if (value && chinese.test(value) && twin === null && lang !== 'zh-Hant') problems.push(`${key} not translated: ${value}`);
    }
    if (!VOID.has(name) && !attrs.trim().endsWith('/')) stack.push({ name, lang, en: en !== null });
  }
  assert.equal(stack.length, 0, 'every element is closed');
  for (const text of english) {
    if (!text.trim() || chinese.test(text)) problems.push('not English: ' + text);
  }
  return { problems, marked, translated };
}

// What is left of the script once every L(…) call and every comment is taken
// out: no Chinese should be.
function outsideL(script) {
  const code = script.split('\n').map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, '')).join('\n');
  let out = '';
  for (let i = 0; i < code.length;) {
    if (code.startsWith('L(', i) && !/[\w$.]/.test(code[i - 1] || '')) {
      let depth = 0;
      let quote = null;
      let j = i + 1;
      for (; j < code.length; j += 1) {
        const c = code[j];
        if (quote) {
          if (c === '\\') j += 1;
          else if (c === quote) quote = null;
        } else if (c === "'" || c === '"' || c === '`') {
          quote = c;
        } else if (c === '(') {
          depth += 1;
        } else if (c === ')') {
          depth -= 1;
          if (!depth) break;
        }
      }
      out += 'L()';
      i = j + 1;
    } else {
      out += code[i];
      i += 1;
    }
  }
  return out;
}

function pageFnsIn(lang, names) {
  return new Function('document', `return { ${names.join(', ')} };\n${pageScript()}`)({ documentElement: { lang } });
}

test('the dashboard says everything in Chinese and in English, and opens in the visitor\'s language', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'hub', 'dashboard.html'), 'utf8');
  const chinese = /[\p{Script=Han}\p{Script=Bopomofo}]/u;
  const { problems, marked, translated } = dashboardMarkup(html);
  assert.deepEqual(problems, []);
  assert.ok(translated > 100, 'the markup is translated');
  assert.equal(marked.en, marked['zh-Hant'], 'every Chinese block has an English one');
  assert.ok(html.includes('html:not([lang="en"]) [lang="en"],html[lang="en"] [lang="zh-Hant"]{display:none !important}'), 'one language shows at a time');

  // The script in <head> sets <html lang> before anything is drawn, as
  // /install does and from the same saved pick.
  const head = html.slice(0, html.indexOf('</head>'));
  const scripts = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotMatch(scripts[0], /innerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  assert.ok(scripts[0].includes('document.documentElement.lang = pickLanguage(location.search, savedLanguage(), navigator.language);'));
  assert.ok(scripts[0].includes("localStorage.getItem('tm.lang')"));
  const { pickLanguage } = new Function('return { pickLanguage };\n' + scripts[0])();
  assert.equal(pickLanguage('?period=month&lang=en', 'zh-Hant', 'zh-TW'), 'en', 'the link wins');
  assert.equal(pickLanguage('?lang=zh-TW', 'en', 'en-US'), 'zh-Hant');
  assert.equal(pickLanguage('?lang=fr', 'en', 'zh-TW'), 'en', 'an unknown ?lang= is passed over');
  assert.equal(pickLanguage('', 'en', 'zh-TW'), 'en', 'then what the visitor picked before');
  assert.equal(pickLanguage('', null, 'zh-TW'), 'zh-Hant');
  assert.equal(pickLanguage('', null, 'en-US'), 'en');
  assert.equal(pickLanguage('', null, 'ja'), 'en', 'English for any browser not in Chinese');
  assert.equal(pickLanguage('', null, ''), 'zh-Hant');

  // Every Chinese string the main script writes is the Chinese half of an L().
  const script = pageScript();
  const left = outsideL(script).split('\n').filter((line) => chinese.test(line)).map((line) => line.trim());
  assert.deepEqual(left.filter((line) => ![
    ".replace(/ ([，。、：；）」])/g, '$1')", // tidy() trims spaces next to Chinese punctuation
    "english ? '中文' : 'English'", // the language button names the other one
    "'　' + warning" // a full-width space indents an import warning
  ].some((part) => line.includes(part))), []);
  // The markup is translated before anything else runs, and the pick is kept
  // for /install too, in the link and through every change of view.
  assert.ok(script.indexOf('\ntranslateMarkup();\nwireLanguage();\nshowPage();\napplyUrl();') > 0);
  for (const part of ["store.set('tm.lang', next)", "url.searchParams.set('lang', next === 'en' ? 'en' : 'zh-TW')", "$('installGuide').href = english ? 'install?lang=en' : 'install'",
    "$('adminLink').href = english ? 'admin?lang=en' : 'admin'", "$('usageLink').href = english ? './?lang=en' : './'", "(lang ? '&lang=' + encodeURIComponent(lang) : '')"]) {
    assert.ok(script.includes(part), part);
  }
});

test('page: the helpers write English on an English page', () => {
  const names = ['L', 'plural', 'compareText', 'earlyText', 'coverageText', 'fallbackText', 'rangeLabel', 'toolOptions', 'previousName', 'prevWord', 'durWords', 'deltaLabel', 'measureText', 'monthWords', 'tokens', 'usd', 'pctText'];
  const zh = pageFnsIn('zh-Hant', names);
  const en = pageFnsIn('en', names);
  const bare = pageFns(names);
  const chinese = /[\p{Script=Han}\p{Script=Bopomofo}]/u;
  assert.equal(bare.L('中文', 'English'), '中文', 'a page with no language is Chinese');
  assert.equal(zh.L('中文', 'English'), '中文');
  assert.equal(en.L('中文', 'English'), 'English');
  assert.deepEqual([en.plural(1, 'device', 'devices'), en.plural(0, 'device', 'devices'), en.plural(2, 'device', 'devices')], ['device', 'devices', 'devices']);

  const today = '2026-09-30';
  const cmp = (page, granularity, focus, previous) => page.compareText({ granularity, focus, previous }, today);
  const week = [{ key: '2026-09-28', from: '2026-09-28', to: '2026-09-30' }, { from: '2026-09-21', to: '2026-09-23', days: 3, partial: true }];
  assert.equal(cmp(zh, 'week', ...week), '和上週同期（09-21 ～ 09-23）比較 · 今天還沒過完');
  assert.equal(cmp(en, 'week', ...week), 'Compared with the same days last week (09-21 – 09-23) · today is not over yet');
  assert.equal(cmp(en, 'month', { key: '2026-01', from: '2026-01-01', to: '2026-01-31' }, { from: '2025-12-01', to: '2025-12-31', days: 31, partial: false }), 'Compared with last month (Dec 2025)');
  assert.equal(cmp(en, 'day', { key: '2026-09-29', from: '2026-09-29', to: '2026-09-29' }, { from: '2026-09-22', to: '2026-09-22', days: 1, partial: false }), 'Compared with the same day last week (09-22, Tue)');
  assert.equal(cmp(en, 'day', { key: 'range', from: '2026-08-31', to: '2026-09-29', days: 30 }, { from: '2026-08-01', to: '2026-08-30', days: 30, partial: false }), 'Compared with the 30 days before (08-01 – 08-30)');
  assert.equal(cmp(en, 'month', { key: 'range', from: '2025-01-01', to: '2025-12-31', days: 365 }, { from: '2024-01-01', to: '2024-12-31', days: 366, partial: false, mode: 'year' }), 'Compared with last year (2024)');
  assert.equal(en.earlyText('2026-08-01', '2026-09-29', today, '2026-09-01', '2026-09-08'), 'An admin deleted the usage from before Sep 2026, so there is no data for that time.');
  assert.equal(en.rangeLabel('2026-08-31', '2026-09-29', today), '08-31 – 09-29');
  assert.equal(en.toolOptions([], 'codex', (id) => id)[1].label, 'codex (no usage in this period)');
  assert.deepEqual([en.previousName('week'), en.prevWord('year'), en.prevWord('')], ['last week', 'same period last year', 'previous period']);
  assert.deepEqual([en.durWords(30000), en.durWords(60 * 60000), en.durWords(3 * 86400000)], ['under a minute', '1 hour', '3 days']);
  assert.equal(en.deltaLabel(100, 100), 'Flat');
  assert.equal(en.monthWords('2026-08'), 'Aug 2026');
  // Nothing these write on an English page is in Chinese.
  const early = { earliest: { daily: '2025-09-24', monthly: '2025-01' }, from: '2025-09-01', granularity: 'day' };
  for (const text of [en.earlyText('2026-08-01', '2026-09-29', today), en.coverageText(early), en.fallbackText({ monthlyFallback: ['2025-01', '2025-08'] }), en.measureText('head', 493000, 'tokens'), en.deltaLabel(5, 0)]) {
    assert.ok(text && !chinese.test(text), text);
  }
});

// A function the page calls by name has to be declared at the top of its
// script: one that ends up nested (de902f2 put three inside request()) is
// undefined to every caller, and refreshCompany() swallows the TypeError. The
// check needs no DOM: `return` ahead of the script body sees the hoisted
// top-level declarations without running a single statement.
test('every function the pages declare at the start of a line is a top-level one', () => {
  for (const [file, least] of [['dashboard.html', 10], ['install.html', 5]]) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'hub', file), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const script = scripts.sort((a, b) => b.length - a.length)[0];
    const names = [...script.matchAll(/^(?:async )?function (\w+)\(/gm)].map((m) => m[1]);
    assert.ok(names.length > least, `${file}: found the page's functions`);
    const types = new Function(`return {${names.map((n) => `${n}: typeof ${n}`).join(', ')}};\n${script}`)();
    const nested = names.filter((n) => types[n] !== 'function');
    assert.deepEqual(nested, [], `${file}: declared inside another block`);
  }
});

test('the served page carries the live client and provider catalogs', async () => {
  await withHub('', async (hub, base) => {
    const html = await (await fetch(`${base}/`)).text();
    const match = html.match(/<script>window\.TM_CATALOG = (\{.*?\});<\/script>\n<\/head>/);
    assert.ok(match, 'catalog script must be injected right before </head>');
    const catalog = JSON.parse(match[1]);
    // Every id upstream knows has a label, so a rename or a new client shows up
    // on the dashboard by itself rather than as a raw id.
    for (const id of CLIENT_IDS) assert.equal(typeof catalog.clients[id], 'string', `client ${id}`);
    for (const id of LIMIT_PROVIDER_IDS) assert.equal(typeof catalog.providers[id], 'string', `provider ${id}`);
    // Each tool's limits provider, for 帳號與裝置 with one tool picked.
    for (const id of CLIENT_IDS) assert.equal(catalog.limitProviders[id], limitProviderForClient(id) || undefined, `limits provider of ${id}`);
    assert.deepEqual([catalog.limitProviders.claude, catalog.limitProviders.droid, catalog.limitProviders.hermes], ['claude', 'factory', undefined]);
  });
});

test('the served page carries the download link, and shows no button without one', async () => {
  await withHub('', async (hub, base) => {
    const html = await (await fetch(`${base}/`)).text();
    const match = html.match(/<script>window\.TM_SETTINGS = (\{.*?\});<\/script>\n/);
    assert.ok(match, 'settings script must be injected');
    assert.deepEqual(JSON.parse(match[1]), {
      downloadUrl: DOWNLOAD_URL,
      downloads: Object.fromEntries(['windows', 'macos', 'linux'].map((os) => [os, `${DOWNLOAD_URL}/permalink/latest/downloads/${os}`]))
    });
    // The page reveals the button only when the hub sent a link.
    assert.match(html, /<a id="download"[^>]* hidden data-en="Download Token Monitor">/);
  });
});

test('only an absolute http(s) URL becomes the download link', () => {
  const link = (value) => pageSettings({ TOKEN_MONITOR_CLIENT_DOWNLOAD_URL: value }).downloadUrl;
  assert.equal(link(' https://git.example.test/a/-/releases '), 'https://git.example.test/a/-/releases');
  assert.equal(link('http://hub.local/downloads'), 'http://hub.local/downloads');
  for (const value of [undefined, '', '   ', 'javascript:alert(1)', 'data:text/html,x', '/-/releases', 'git.example.test/releases']) {
    assert.equal(link(value), null, String(value));
  }
  // The newest installers, from a GitLab Releases page only.
  assert.equal(latestDownloads('https://git.example.test/g/p/-/releases/').macos, 'https://git.example.test/g/p/-/releases/permalink/latest/downloads/macos');
  for (const value of [null, 'http://hub.local/downloads', 'https://git.example.test/g/p/-/releases?sort=desc', 'https://git.example.test/g/p/-/releases/v1']) {
    assert.equal(latestDownloads(value), null, String(value));
  }
  assert.equal(pageSettings({}).downloads, null);
});

test('every other route still reaches the upstream hub unchanged', async () => {
  await withHub('s3cret', async (hub, base) => {
    const auth = { authorization: 'Bearer s3cret' };

    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.role, 'hub');
    assert.equal(health.runtime, 'node-hub');
    assert.equal(health.secretRequired, true);

    const ingest = await fetch(`${base}/api/ingest`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-a', today: { totalTokens: 5, costUsd: 0.1 } })
    });
    assert.equal(ingest.status, 200);
    assert.equal(hub.getStats().devices.length, 1);

    const stats = await fetch(`${base}/api/stats`, { headers: auth });
    assert.equal(stats.status, 200);
    assert.equal((await stats.json()).devices[0].deviceId, 'dev-a');

    // Unknown paths get upstream's answer, not a dashboard.
    const missing = await fetch(`${base}/nope`, { headers: auth });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'not_found' });
  });
});

test('only GET navigations are intercepted; other methods fall through to upstream', async () => {
  await withHub('s3cret', async (hub, base) => {
    // Upstream answers OPTIONS itself, before its secret gate.
    const preflight = await fetch(`${base}/`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    // A POST to the dashboard path is not a navigation, so it meets the gate.
    const post = await fetch(`${base}/`, { method: 'POST' });
    assert.equal(post.status, 401);
    assert.deepEqual(await post.json(), { error: 'unauthorized' });
  });
});

// fetch() refuses to send this, so it goes over a raw socket.
function rawRequest(port, requestText) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(requestText));
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('close', () => resolve(response));
    socket.on('error', reject);
    socket.setTimeout(3000, () => socket.destroy());
  });
}

test('a malformed request target is answered by upstream instead of crashing the process', async () => {
  await withHub('s3cret', async (hub, base) => {
    const { port } = hub.server.address();
    // Node's HTTP parser lets this absolute-form target through; the WHATWG URL
    // constructor rejects it. Without the guard in serveDashboard() the throw
    // escapes the 'request' listener and kills the hub before any auth check.
    const response = await rawRequest(port, 'GET http://[::1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(response, /^HTTP\/1\.1 500 /);
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
  });
});

test('an unauthenticated hub still serves the dashboard and answers its data routes', async () => {
  await withHub('', async (hub, base) => {
    const page = await fetch(`${base}/dashboard`);
    assert.equal(page.status, 200);
    const stats = await fetch(`${base}/api/stats`);
    assert.equal(stats.status, 200);
  });
});
