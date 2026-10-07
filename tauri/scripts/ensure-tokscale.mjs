#!/usr/bin/env node
// 下載並驗證 tokscale（隨附的 Rust 掃描程式），放到 Tauri externalBin 的位置：
//   src-tauri/binaries/tokscale-<target-triple>[.exe]
//
// 釘選的版本與 sha256 在 scripts/vendor/tokscale.json（與上游 token-monitor 的 pin 相同，
// 上游換 pin 時照抄這個檔）。只有 app / 打包入口（tauri dev、tauri build、build-installer.ps1）
// 會呼叫這支腳本；install / lint / test / verify 必須保持離線（沿用上游的 tripwire）。
//
// 用法：
//   node scripts/ensure-tokscale.mjs                      # 目前平台
//   node scripts/ensure-tokscale.mjs --platform=win32-x64
//   node scripts/ensure-tokscale.mjs --from <path>        # 從本機檔案複製（離線），仍驗 sha256
//   node scripts/ensure-tokscale.mjs --check              # 只檢查，不下載（CI 用）

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

const TRIPLES = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

function parseArgs(argv) {
  const out = { platform: `${process.platform}-${process.arch}`, check: false, from: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a.startsWith("--platform=")) out.platform = a.slice("--platform=".length);
    else if (a === "--platform") out.platform = argv[++i];
    else if (a.startsWith("--from=")) out.from = a.slice("--from=".length);
    else if (a === "--from") out.from = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function download(url) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${url}`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) throw new Error(`download too large: ${declared} bytes`);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_BYTES) throw new Error(`download exceeded ${MAX_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "scripts", "vendor", "tokscale.json"), "utf8"));
  const pin = manifest.platforms?.[args.platform];
  const triple = TRIPLES[args.platform];
  if (!pin || !triple) throw new Error(`no tokscale pin for platform ${args.platform}`);
  const exe = args.platform.startsWith("win32") ? ".exe" : "";
  const target = path.join(root, "src-tauri", "binaries", `tokscale-${triple}${exe}`);

  if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === pin.sha256) {
    console.log(`tokscale ok: ${path.relative(root, target)} (${manifest.releaseTag})`);
    return;
  }
  if (args.check) {
    throw new Error(`tokscale missing or mismatched: ${path.relative(root, target)} (run npm run ensure:tokscale)`);
  }

  let bytes;
  if (args.from) {
    bytes = fs.readFileSync(args.from);
    console.log(`tokscale: copying ${args.from}`);
  } else {
    const url = `https://github.com/${manifest.releaseRepo}/releases/download/${manifest.releaseTag}/${pin.asset}`;
    console.log(`tokscale: downloading ${url}`);
    bytes = await download(url);
  }
  const actual = sha256(bytes);
  if (actual !== pin.sha256) {
    throw new Error(`tokscale sha256 mismatch: expected ${pin.sha256}, got ${actual}`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, bytes);
  if (!exe) fs.chmodSync(tmp, 0o755);
  try {
    if (args.platform === `${process.platform}-${process.arch}`) {
      const smoke = spawnSync(tmp, ["--version"], { encoding: "utf8", timeout: 10_000 });
      if (smoke.status !== 0) throw new Error(`tokscale --version failed: ${smoke.stderr || smoke.error}`);
      console.log(`tokscale: ${smoke.stdout.trim()}`);
    }
    fs.renameSync(tmp, target);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  console.log(`tokscale installed: ${path.relative(root, target)}`);
}

main().catch((error) => {
  console.error(`ensure-tokscale: ${error.message}`);
  process.exit(1);
});
