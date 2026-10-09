#!/usr/bin/env node
// 組 Tauri updater 的 latest.json（`tauri build` 只產生安裝檔的 .sig，feed 由我們自己組）。
//
//   node scripts/make-latest-json.mjs --version 0.2.0 --installer release/v0.2.0/TokenMonitor_0.2.0_x64-setup.exe \
//     --hub-url https://tokens.example.internal [--notes-file notes.md] --out release/v0.2.0/latest.json
//
//   GitHub 發行改用 --download-base（Release 的下載位置），安裝檔網址是 `<download-base>/<檔名>`：
//   node scripts/make-latest-json.mjs --version 0.2.0 --installer … //     --download-base https://github.com/<owner>/<repo>/releases/download/<tag> --out …/latest.json
//
// 簽章讀 `<installer>.sig`。安裝檔網址是 `<hub>/updates/<檔名>`：hub 的 hub/releases.js（monorepo 根目錄的 overlay）
// 從同一個目錄提供 feed 與安裝檔，而且只接受 SAFE_NAME 形式的檔名（沒有空白比較保險）。
// 寫完會讀回來自檢：版本、檔名與 .sig 內容都要對得上。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// 與 monorepo 根目錄 overlay 的 hub/releases.js 的 SAFE_NAME 相同，但不允許空白。
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Tauri updater 先找 `<os>-<arch>-<installer>`，再找 `<os>-<arch>`；兩個都給，hub 兩個都認。
export const PLATFORM_KEYS = ["windows-x86_64-nsis", "windows-x86_64"];

export function normalizeHubUrl(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`--hub-url 不是有效的網址：${text}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`--hub-url 必須是 http(s)：${text}`);
  if (url.search || url.hash || url.username || url.password) throw new Error(`--hub-url 不能帶查詢字串、錨點或帳密：${text}`);
  return text;
}

// GitHub Release 的下載位置：只接受 https，不帶查詢字串、錨點或帳密。
export function normalizeDownloadBase(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`--download-base 不是有效的網址：${text}`);
  }
  if (url.protocol !== "https:") throw new Error(`--download-base 必須是 https：${text}`);
  if (url.search || url.hash || url.username || url.password) throw new Error(`--download-base 不能帶查詢字串、錨點或帳密：${text}`);
  return text;
}

export function buildLatestJson({ version, installerName, signature, hubUrl, downloadBase, notes = "", pubDate = new Date() }) {
  if (!SEMVER.test(String(version))) throw new Error(`版本號不是 semver：${version}`);
  if (!SAFE_NAME.test(String(installerName))) throw new Error(`安裝檔名只能有英數、點、底線與連字號：${installerName}`);
  const sig = String(signature || "").trim();
  if (!sig) throw new Error("簽章是空的");
  if (!hubUrl === !downloadBase) throw new Error("--hub-url 與 --download-base 要給一個（只能一個）");
  const url = hubUrl
    ? `${normalizeHubUrl(hubUrl)}/updates/${installerName}`
    : `${normalizeDownloadBase(downloadBase)}/${installerName}`;
  const entry = { signature: sig, url };
  return {
    version: String(version),
    notes: String(notes || "").trim(),
    pub_date: new Date(pubDate).toISOString(),
    platforms: Object.fromEntries(PLATFORM_KEYS.map((k) => [k, { ...entry }])),
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`多餘的參數：${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} 需要一個值`);
    out[arg.slice(2)] = value;
    i += 1;
  }
  for (const k of ["version", "installer", "out"]) {
    if (!out[k]) throw new Error(`缺少 --${k}`);
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const installer = path.resolve(args.installer);
  if (!fs.existsSync(installer)) throw new Error(`找不到安裝檔：${installer}`);
  const sigFile = `${installer}.sig`;
  if (!fs.existsSync(sigFile)) throw new Error(`找不到簽章：${sigFile}（打包時要提供 TAURI_SIGNING_PRIVATE_KEY）`);
  const signature = fs.readFileSync(sigFile, "utf8");
  const notes = args["notes-file"] ? fs.readFileSync(args["notes-file"], "utf8") : "";
  const feed = buildLatestJson({
    version: args.version,
    installerName: path.basename(installer),
    signature,
    hubUrl: args["hub-url"],
    downloadBase: args["download-base"],
    notes,
  });
  fs.writeFileSync(args.out, `${JSON.stringify(feed, null, 2)}\n`);

  // 自檢：讀回來比對，確保發佈到 hub 的 feed 指向這個安裝檔、簽章就是這份 .sig。
  const back = JSON.parse(fs.readFileSync(args.out, "utf8"));
  for (const key of PLATFORM_KEYS) {
    const p = back.platforms?.[key];
    const tail = args["hub-url"] ? `/updates/${path.basename(installer)}` : `/${path.basename(installer)}`;
    if (!p || p.signature !== signature.trim() || !p.url.endsWith(tail)) {
      throw new Error(`latest.json 自檢失敗（${key}）`);
    }
  }
  if (back.version !== args.version) throw new Error("latest.json 自檢失敗（version）");
  console.log(`latest.json：v${back.version} → ${back.platforms[PLATFORM_KEYS[0]].url}`);
  return back;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`make-latest-json：${e.message}`);
    process.exit(1);
  }
}
