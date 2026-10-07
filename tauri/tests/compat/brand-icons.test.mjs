// 品牌圖示與版本頁錨點的相容測試：src/brandIcons.ts 的圖示表、遮罩表與 src/assets/brand/ 的圖檔必須
// 與上游 src/electron/renderer/app.js（clientsWithIcon）、styles.css（.row-icon-<id>）、
// src/shared/limitProviders.js 與 assets/icons/ 完全相同；版本說明連結的 `#v<版本>` 要對得到 hub
// 版本頁上的 `<section id>`（overlay 有 hub/releases.js 時才測）。
//
// 需要 Node 22.18+ 的 TypeScript type stripping 直接載入 .ts（沒有時略過）；上游與 overlay 的位置見
// repos.mjs。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildLatestJson } from "../../scripts/make-latest-json.mjs";
import { CUSTOM, REPO, root } from "./repos.mjs";

const RENDERER = path.join(REPO, "src", "electron", "renderer");
const BRAND_DIR = path.join(root, "src", "assets", "brand");
const hasRepo = fs.existsSync(path.join(RENDERER, "app.js")) && fs.existsSync(path.join(RENDERER, "styles.css"));
const skip = !process.features.typescript
  ? "needs Node 22.18+ with TypeScript type stripping"
  : hasRepo
    ? false
    : `upstream checkout not found at ${REPO} (set TOKEN_MONITOR_REPO)`;
const require = createRequire(import.meta.url);
// 已知差異：這裡的廠商圖示、遮罩與主題照 2026-09-24 的上游 main 移植。上游 v0.63.1 把它們重構到
// vendorPresentation 與 rowIconMasks.js，下面標 todo 的比對對 v0.63.1 不成立；移植跟上之後拿掉 todo
// （tauri/docs/architecture.md「已知差異」）。
const UPSTREAM_GAP = "ported from upstream main of 2026-09-24; upstream v0.63.1 moved vendor icons and themes (vendorPresentation, rowIconMasks.js)";

const loadOurs = () => import(pathToFileURL(path.join(root, "src", "brandIcons.ts")).href);

/**
 * 上游 styles.css 的遮罩規則：`.row-icon-<id>`（含 `.row-icon-xiaomi,\n.row-icon-mimo` 這種群組）與
 * `.limit-icon.row-icon-<id>`。回傳 id → 檔名，以及檔名 → 上游檔案的絕對路徑（相對 styles.css 解析）。
 */
function upstreamMasks() {
  const css = fs.readFileSync(path.join(RENDERER, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const row = {};
  const limit = {};
  const sources = {};
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const m = /(?:^|[\s;])mask-image:\s*url\(\s*["']?([^"')\s]+)["']?\s*\)/.exec(body);
    if (!m) continue;
    const abs = path.resolve(RENDERER, m[1]);
    const file = path.basename(abs);
    for (const selector of selectors.split(",").map((s) => s.trim())) {
      let hit = /^\.row-icon-([\w-]+)$/.exec(selector);
      if (hit) row[hit[1]] = file;
      else if ((hit = /^\.limit-icon\.row-icon-([\w-]+)$/.exec(selector))) limit[hit[1]] = file;
      else continue;
      if (sources[file] && sources[file] !== abs) assert.fail(`two upstream files are named ${file}`);
      sources[file] = abs;
    }
  }
  return { row, limit, sources };
}

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

test("brand icons: clientsWithIcon and LIMIT_PROVIDER_IDS match upstream, in order", { skip, todo: UPSTREAM_GAP }, async () => {
  const ours = await loadOurs();
  const app = fs.readFileSync(path.join(RENDERER, "app.js"), "utf8");
  // 與上游 tests/electron/clientPresentationCoverage.test.js 同一條正規式。
  const block = app.match(/const clientsWithIcon = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, "clientsWithIcon declaration should exist in app.js");
  const upstream = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual([...ours.CLIENTS_WITH_ICON], upstream);

  const { LIMIT_PROVIDER_IDS } = require(path.join(REPO, "src", "shared", "limitProviders.js"));
  assert.deepStrictEqual([...ours.UPSTREAM_LIMIT_PROVIDER_IDS], [...LIMIT_PROVIDER_IDS]);
  // 上游 limitMarksWithIcon 的組法。
  assert.deepStrictEqual([...ours.LIMIT_MARK_IDS], [...new Set([...upstream, ...LIMIT_PROVIDER_IDS, "newapi", "sub2api"])]);
});

test("brand icons: the mask table matches upstream styles.css", { skip, todo: UPSTREAM_GAP }, async () => {
  const ours = await loadOurs();
  const { row, limit } = upstreamMasks();
  assert.deepStrictEqual(sorted(ours.MASK_FILE), sorted(row));
  assert.deepStrictEqual(sorted(ours.LIMIT_MASK_OVERRIDE), sorted(limit));
  // 上游缺規則的 id 會畫成實心方塊；兩個集合裡的每個 id 都要有遮罩。
  for (const id of ours.LIMIT_MARK_IDS) assert.ok(row[id], `no upstream mask for ${id}`);
});

test("brand icons: every asset is a byte-for-byte copy of the upstream file", { skip, todo: UPSTREAM_GAP }, () => {
  const { sources } = upstreamMasks();
  const ours = fs.readdirSync(BRAND_DIR).sort();
  // 資料夾裡只放遮罩表用到的檔案，遮罩表用到的每個檔案也都在。
  assert.deepStrictEqual(ours, Object.keys(sources).sort());
  for (const file of ours) {
    assert.ok(fs.readFileSync(path.join(BRAND_DIR, file)).equals(fs.readFileSync(sources[file])), `${file} differs from ${sources[file]}`);
  }
});

test("brand icons: modelVendorFor copies upstream rule for rule", { skip }, () => {
  // 上游 widgetVendorParity.test.js 的做法：逐條比對正規式與廠商，而不是只比結果（theme-compat 比結果）。
  const rules = (source, start, end) => {
    const from = source.indexOf(start);
    assert.notEqual(from, -1, `could not find ${start}`);
    const body = source.slice(from, source.indexOf(end, from));
    return [...body.matchAll(/if \(\/(.+?)\/\.test\(name\)\) return ['"]([^'"]+)['"];/g)].map(([, pattern, vendor]) => [pattern, vendor]);
  };
  const upstream = rules(fs.readFileSync(path.join(RENDERER, "usageCharts.js"), "utf8"), "function modelVendorFor(model) {", "\n  }\n");
  const ours = rules(fs.readFileSync(path.join(root, "src", "modelVendor.ts"), "utf8"), "export function modelVendorFor(", "\n}\n");
  assert.ok(upstream.length > 10, "upstream resolver shape changed");
  assert.deepStrictEqual(ours, upstream);
});

test("release page: the #v<version> anchor matches a section on the hub's releases page", { skip }, () => {
  const releases = path.join(CUSTOM, "hub", "releases.js");
  if (!fs.existsSync(releases)) return;
  const { parseTauriFeed, releasesPage } = require(releases);
  const feed = buildLatestJson({ version: "0.2.0", installerName: "TokenMonitor_0.2.0_x64-setup.exe", signature: "sig", hubUrl: "https://h" });
  const parsed = parseTauriFeed(JSON.stringify(feed));
  const html = releasesPage({ clients: [{ label: "x", version: parsed.version, available: false, notes: null, releaseDate: null }] });
  // Rust update::release_page_url 組出 `#v0.2.0`（cargo 測試守著）。
  assert.match(html, /<section id="v0\.2\.0">/);
});
