#!/usr/bin/env node
// verify 的一部分：確認沒有 secret 或簽章私鑰被加進版本庫。
// 掃描所有會進版控的檔案（已追蹤 + 未被 .gitignore 排除的新檔）。
//
// 抓的東西：
// - Tauri updater 的 minisign 私鑰（`tauri signer generate` 產生，base64 或明文表頭）
// - PEM 私鑰
// - 寫死值的 TM_CLIENT_SECRET / TAURI_SIGNING_PRIVATE_KEY 指派
// - .env、*.key 這類本來就不該進版控的檔名

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONTENT_RULES = [
  ["minisign secret key", /untrusted comment: (?:rsign|minisign) encrypted secret key/i],
  // "untrusted comment: rsign encrypted secret key" 的 base64（tauri signer 的預設輸出）
  ["minisign secret key (base64)", /dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5/],
  ["PEM private key", /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ["hard-coded client secret", /\bTM_CLIENT_SECRET\s*[:=]\s*["']?[A-Za-z0-9+/_\-]{12,}/],
  ["hard-coded signing key", /\bTAURI_SIGNING_PRIVATE_KEY\s*[:=]\s*["']?[A-Za-z0-9+/=]{40,}/],
];
const NAME_RULES = [
  ["env file", /(^|\/)\.env(\..+)?$/],
  ["key file", /\.(key|pem|p12|pfx)$/i],
];
// 這支腳本本身與文件裡的說明會提到上面的樣式。
const ALLOW = new Set(["scripts/check-secrets.mjs"]);

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
})
  .split(/\r?\n/)
  .filter(Boolean)
  .map((f) => f.replace(/\\/g, "/"));

const problems = [];
for (const file of files) {
  if (ALLOW.has(file)) continue;
  for (const [label, re] of NAME_RULES) if (re.test(file)) problems.push(`${file}: ${label}`);
  const full = path.join(root, file);
  let text;
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
    text = fs.readFileSync(full, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue; // binary
  for (const [label, re] of CONTENT_RULES) if (re.test(text)) problems.push(`${file}: ${label}`);
}

if (problems.length) {
  console.error("check-secrets: possible secrets in files that would be committed:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-secrets: ${files.length} files clean`);
