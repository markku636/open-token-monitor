'use strict';

// What an upstream update touches: the upstream files that changed between two
// subtree squashes of upstream/, and for each one the files of this repository
// that build on it, as a Markdown checklist for whoever finishes the update, a
// person or an agent (docs/upstream-upgrade.zh-TW.md).
//
//   npm run upstream:impact                             the latest pull against the one before it
//   npm run upstream:impact -- --from <rev> --to <rev>  any two revisions holding an upstream tree at their root
//   npm run upstream:impact -- --out tmp/upstream-impact.md
//
// Three sources say what builds on an upstream file:
//   - upstream-touchpoints.json: seams that copy, patch, load or port upstream
//     code in ways a scan cannot see; a touchpoint's `watch` strings are
//     counted in its upstream files at both releases
//   - every upstream('…') in the overlay, the company entry's require('../src/…')
//     and the Dockerfile's COPY upstream/…
//   - the tauri/ files that name the upstream file (tauri/AGENTS.md: comments
//     cite the upstream file they port)
// and upstream's tokscale pin must equal the copy in tauri/scripts/vendor/.
// It also lists the hub routes and TOKEN_MONITOR_* settings upstream added or
// removed, which need a decision before the overlay passes them through.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { PREFIX } = require('./check-upstream');

const ROOT = path.join(__dirname, '..');
const IMPACT_FILE = 'tmp/upstream-impact.md';
const TOUCHPOINTS_FILE = 'upstream-touchpoints.json';
const TOKSCALE_PIN = 'scripts/vendor/tokscale.json';
const OVERLAY_DIRS = ['hub', 'client', 'packaging', 'scripts', 'docker', 'tests'];
const TAURI_DIRS = ['tauri/src', 'tauri/src-tauri/src', 'tauri/src-tauri/build.rs', 'tauri/tests', 'tauri/scripts'];
const SOURCE_RE = /\.(js|mjs|cjs|ts|tsx|rs)$|(^|\/)Dockerfile$/;
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'tmp', 'gen', 'binaries']);
// '/api/x' in a string, and \/api\/x in a regular expression literal.
const ROUTE_LITERAL_RE = /['"`](\/api\/[A-Za-z0-9_/:.-]*)/g;
const ROUTE_REGEX_RE = /\\\/api\\\/[^\s'"`$]*/g;
const ENV_RE = /TOKEN_MONITOR_[A-Z0-9_]+/g;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
}

// The lines of `rev` under the pathspecs that contain `text`; none is no error.
function grepLines(cwd, rev, text, pathspecs) {
  try {
    return git(['grep', '-h', '-F', '-e', text, rev, '--', ...pathspecs], cwd).split('\n').filter(Boolean);
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
}

// Newest first.
function squashCommits(cwd, prefix = PREFIX) {
  const out = git(['log', '--format=%H', `--grep=^git-subtree-dir: ${prefix}$`, 'HEAD'], cwd);
  return out ? out.split('\n') : [];
}

// The one-line upstream commits a squash message lists (git subtree pull
// --squash writes them between its title and the git-subtree-* lines).
function squashSubjects(message) {
  return String(message).split('\n')
    .map((line) => /^\s*([0-9a-f]{7,40})\s+(.+)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ commit: m[1], subject: m[2].trim() }));
}

function versionAt(cwd, rev) {
  try {
    return JSON.parse(git(['show', `${rev}:package.json`], cwd)).version || null;
  } catch (_) {
    return null;
  }
}

// Status letter and upstream-relative path of every changed file.
function changedFiles(cwd, from, to) {
  const out = git(['diff', '--name-status', '--no-renames', from, to], cwd);
  return out ? out.split('\n').map((line) => {
    const [status, file] = line.split('\t');
    return { status: status[0], file };
  }) : [];
}

function globToRegExp(glob) {
  const source = glob.split('**').map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${source}$`);
}

// An upstream('x') reference names a file with or without .js, or a directory.
function refMatches(ref, file) {
  const clean = ref.replace(/\/+$/, '');
  return file === clean || file === `${clean}.js` || file.startsWith(`${clean}/`);
}

function walk(cwd, rel, out = []) {
  const full = path.join(cwd, rel);
  if (!fs.existsSync(full)) return out;
  if (fs.statSync(full).isFile()) {
    if (SOURCE_RE.test(rel)) out.push(rel);
    return out;
  }
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    walk(cwd, `${rel}/${entry.name}`, out);
  }
  return out;
}

// Overlay file → the upstream paths it loads.
function overlayReferences(cwd) {
  const refs = [];
  for (const file of OVERLAY_DIRS.flatMap((dir) => walk(cwd, dir))) {
    const text = fs.readFileSync(path.join(cwd, file), 'utf8');
    for (const m of text.matchAll(/upstream\(\s*['"]([^'"]+)['"]\s*\)/g)) refs.push({ file, ref: m[1] });
    if (file.startsWith('client/')) {
      for (const m of text.matchAll(/require\(\s*['"]\.\.\/(src\/[^'"]+)['"]\s*\)/g)) refs.push({ file, ref: m[1] });
    }
    if (/Dockerfile$/.test(file)) {
      for (const m of text.matchAll(/^COPY (?!--from)upstream\/(\S+) /gm)) refs.push({ file, ref: m[1] });
    }
  }
  return refs;
}

// The words a tauri/ file would use to name an upstream file: its file name,
// or parent/name when several upstream files share the name (index.js, auth.js).
function citationNeedle(file, nameCounts) {
  const parts = file.split('/');
  const name = parts.at(-1);
  return nameCounts.get(name) > 1 && parts.length > 1 ? parts.slice(-2).join('/') : name;
}

function nameCountsAt(cwd, rev) {
  const counts = new Map();
  for (const file of git(['ls-tree', '-r', '--name-only', rev], cwd).split('\n')) {
    const name = file.split('/').at(-1);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

function tauriCitations(cwd, files, nameCounts) {
  const sources = TAURI_DIRS.flatMap((dir) => walk(cwd, dir)).map((file) => ({ file, text: fs.readFileSync(path.join(cwd, file), 'utf8') }));
  const hits = new Map();
  for (const changed of files) {
    if (!/^src\/.+\.js$/.test(changed)) continue;
    const needle = citationNeedle(changed, nameCounts);
    const re = new RegExp(`(^|[^A-Za-z0-9_])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_])`);
    for (const { file, text } of sources) {
      if (!re.test(text)) continue;
      if (!hits.has(file)) hits.set(file, new Set());
      hits.get(file).add(changed);
    }
  }
  return hits;
}

// \/api\/sync\/titles\/([^/]+) as written in a regex literal → /api/sync/titles/([^/]+).
// An unescaped slash followed by what can follow a literal ends it.
function regexRoute(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '\\') {
      out += raw[i + 1] === '/' ? '/' : raw.slice(i, i + 2);
      i += 1;
    } else if (raw[i] === '/' && /^[),.;:gimsuy]?$/.test(raw.slice(i + 1, i + 2))) {
      break;
    } else {
      out += raw[i];
    }
  }
  return out;
}

// The /api/… paths upstream's hub code names at `rev`.
function hubRoutes(cwd, rev) {
  const routes = new Set();
  for (const line of grepLines(cwd, rev, 'api', ['src/hub'])) {
    for (const m of line.matchAll(ROUTE_LITERAL_RE)) routes.add(m[1]);
    for (const m of line.matchAll(ROUTE_REGEX_RE)) routes.add(regexRoute(m[0]));
  }
  return routes;
}

// The TOKEN_MONITOR_* names upstream's code and .env.example use at `rev`.
function envNames(cwd, rev) {
  const names = new Set();
  for (const line of grepLines(cwd, rev, 'TOKEN_MONITOR_', ['src', '.env.example'])) {
    for (const m of line.matchAll(ENV_RE)) names.add(m[0]);
  }
  return names;
}

// How often `text` appears in the files matching the globs at `rev`.
function countAt(cwd, rev, text, globs) {
  return grepLines(cwd, rev, text, globs.map((glob) => `:(glob)${glob}`))
    .reduce((n, line) => n + line.split(text).length - 1, 0);
}

function setChanges(before, after) {
  return {
    added: [...after].filter((x) => !before.has(x)).sort(),
    removed: [...before].filter((x) => !after.has(x)).sort()
  };
}

function readTouchpoints(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, TOUCHPOINTS_FILE), 'utf8')).touchpoints;
}

function tokscalePinDiffers(cwd) {
  const ours = path.join(cwd, 'tauri', TOKSCALE_PIN);
  const theirs = path.join(cwd, PREFIX, TOKSCALE_PIN);
  if (!fs.existsSync(ours) || !fs.existsSync(theirs)) return false;
  return fs.readFileSync(ours, 'utf8').replace(/\r\n/g, '\n') !== fs.readFileSync(theirs, 'utf8').replace(/\r\n/g, '\n');
}

function list(items) {
  return [...items].sort().map((item) => `\`${item}\``).join(', ');
}

// { markdown, items, changed }
function upstreamImpact({ cwd = ROOT, from, to, verify } = {}) {
  let toRev = to;
  let fromRev = from;
  if (!toRev || !fromRev) {
    const squashes = squashCommits(cwd);
    toRev ||= squashes[0];
    if (!fromRev && toRev) {
      // The pull before `to`: the squash after it in the newest-first list.
      const at = squashes.indexOf(git(['rev-parse', `${toRev}^{commit}`], cwd));
      fromRev = at >= 0 ? squashes[at + 1] : undefined;
    }
  }
  if (!toRev) throw new Error(`no "git-subtree-dir: ${PREFIX}" commit in the history`);
  const head = [`# Upstream update: ${fromRev ? `v${versionAt(cwd, fromRev)}` : '(none)'} → v${versionAt(cwd, toRev)}`, ''];
  if (verify) head.push(`\`npm run verify\` after the pull: **${verify}**.`, '');
  if (!fromRev) {
    const markdown = [...head, 'There is no earlier subtree pull to compare against.', ''].join('\n');
    return { markdown, items: 0, changed: [] };
  }

  const changed = changedFiles(cwd, fromRev, toRev);
  const files = changed.map((c) => c.file);
  const items = [];

  for (const point of readTouchpoints(cwd)) {
    const patterns = point.upstream.map(globToRegExp);
    const hit = files.filter((file) => patterns.some((re) => re.test(file)));
    if (!hit.length) continue;
    const lines = [
      `- [ ] **${point.check.join(', ')}** — ${point.why}`,
      `  - upstream: ${list(hit.slice(0, 8))}${hit.length > 8 ? ` and ${hit.length - 8} more` : ''}`
    ];
    for (const text of point.watch || []) {
      const [before, after] = [countAt(cwd, fromRev, text, point.upstream), countAt(cwd, toRev, text, point.upstream)];
      if (before !== after) lines.push(`  - \`${text}\` now appears ${after} time(s), was ${before}: check that the overlay covers every one`);
    }
    lines.push(`  - verify: \`${point.verify}\``);
    items.push(lines.join('\n'));
  }

  if (tokscalePinDiffers(cwd)) {
    items.push(`- [ ] **tauri/${TOKSCALE_PIN}** — upstream changed its tokscale pin: copy \`${PREFIX}/${TOKSCALE_PIN}\` over it verbatim\n  - verify: \`npm --prefix tauri run test:scripts\``);
  }

  const byOverlayFile = new Map();
  for (const { file, ref } of overlayReferences(cwd)) {
    const hit = files.filter((changedFile) => refMatches(ref, changedFile));
    if (!hit.length) continue;
    if (!byOverlayFile.has(file)) byOverlayFile.set(file, new Set());
    for (const h of hit) byOverlayFile.get(file).add(h);
  }
  const overlayItems = [...byOverlayFile].sort(([a], [b]) => a.localeCompare(b))
    .map(([file, hit]) => `- [ ] \`${file}\` loads ${list([...hit].slice(0, 6))}${hit.size > 6 ? ` and ${hit.size - 6} more` : ''}`);

  const tauriItems = [...tauriCitations(cwd, files, nameCountsAt(cwd, toRev))].sort(([a], [b]) => a.localeCompare(b))
    .map(([file, hit]) => `- [ ] \`${file}\` ports ${list(hit)}`);

  const routes = setChanges(hubRoutes(cwd, fromRev), hubRoutes(cwd, toRev));
  const routeItems = [
    ...routes.added.map((route) => `- [ ] added \`${route}\``),
    ...routes.removed.map((route) => `- [ ] removed \`${route}\``)
  ];
  const env = setChanges(envNames(cwd, fromRev), envNames(cwd, toRev));
  const envItems = [
    ...env.added.map((name) => `- [ ] added \`${name}\``),
    ...env.removed.map((name) => `- [ ] removed \`${name}\``)
  ];

  const counts = changed.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] || 0) + 1 }), {});
  const subjects = squashSubjects(git(['log', '-1', '--format=%B', toRev], cwd));
  const covered = new Set([...byOverlayFile.values()].flatMap((s) => [...s]));
  const other = files.filter((file) => /^(src|docs)\//.test(file) && !covered.has(file));

  const markdown = [
    ...head,
    `${changed.length} upstream files changed (${Object.entries(counts).map(([k, v]) => `${v} ${{ A: 'added', M: 'modified', D: 'deleted' }[k] || k}`).join(', ') || 'none'}).`,
    '',
    '## Seams to check',
    '',
    ...(items.length ? items : ['None of the seams in upstream-touchpoints.json changed.']),
    '',
    '## Overlay files that load changed upstream code',
    '',
    ...(overlayItems.length ? overlayItems : ['None.']),
    '',
    '## tauri/ files that port changed upstream code',
    '',
    'Read the upstream diff for each and port it to Rust/TS where it changes behaviour (`git diff <from> <to> -- <file>` on the two squash commits below).',
    '',
    ...(tauriItems.length ? tauriItems : ['None.']),
    '',
    '## Hub routes upstream added or removed',
    '',
    'hub/overlay.js hands every route it does not own to upstream, with the admin key. Client keys may GET any of them (hub/access.js), so what a new GET route returns every installed client can read; other methods stay admin-only until hub/access.js says otherwise. Decide for each new one: may everyone read its data, may clients write it (then through hub/ingestGuard.js), and in database mode does what it writes reach PostgreSQL — upstream keeps it in its own state only.',
    '',
    ...(routeItems.length ? routeItems : ['None.']),
    '',
    '## TOKEN_MONITOR_* settings upstream added or removed',
    '',
    'A setting the hub reads (src/hub, src/shared) goes into .env.example and docs/hub.zh-TW.md, "設定", with the value your hub should use. One only the client or agent reads needs nothing in the hub; check whether the Rust agent (tauri/) reads the same name, and whether the client build (packaging/) should set it.',
    '',
    ...(envItems.length ? envItems : ['None.']),
    '',
    '## Upstream commits in this update',
    '',
    ...(subjects.length ? subjects.map((s) => `- ${s.commit} ${s.subject}`) : ['(not listed in the squash message)']),
    '',
    '<details><summary>Other changed upstream files under src/ and docs/</summary>',
    '',
    ...(other.length ? other.map((file) => `- \`${file}\``) : ['None.']),
    '',
    '</details>',
    '',
    `Squash commits: from \`${fromRev.slice(0, 12)}\` to \`${toRev.slice(0, 12)}\` (\`git diff ${fromRev.slice(0, 12)} ${toRev.slice(0, 12)} -- <upstream path>\`).`,
    ''
  ].join('\n');
  return { markdown, items: items.length + overlayItems.length + tauriItems.length + routeItems.length + envItems.length, changed };
}

function parseCli(argv) {
  const usage = 'usage: npm run upstream:impact -- [--from <rev>] [--to <rev>] [--out <file>]';
  const keys = { '--from': 'from', '--to': 'to', '--out': 'out' };
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    if (!keys[flag]) throw new Error(`unexpected argument ${argv[i]}; ${usage}`);
    const value = inline ?? argv[++i];
    if (!value) throw new Error(`${flag} needs a value; ${usage}`);
    out[keys[flag]] = value;
  }
  return out;
}

if (require.main === module) {
  try {
    const cli = parseCli(process.argv.slice(2));
    const { markdown } = upstreamImpact({ from: cli.from, to: cli.to });
    if (cli.out) {
      fs.mkdirSync(path.dirname(path.resolve(ROOT, cli.out)), { recursive: true });
      fs.writeFileSync(path.resolve(ROOT, cli.out), markdown);
      console.log(`Wrote ${cli.out}`);
    } else {
      process.stdout.write(markdown);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { IMPACT_FILE, citationNeedle, envNames, globToRegExp, hubRoutes, overlayReferences, parseCli, refMatches, regexRoute, squashSubjects, upstreamImpact };
