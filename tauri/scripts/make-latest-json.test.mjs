import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PLATFORM_KEYS, buildLatestJson, main, normalizeHubUrl } from "./make-latest-json.mjs";

test("feed points both platform keys at the hub's /updates/ copy", () => {
  const feed = buildLatestJson({
    version: "0.2.0",
    installerName: "TokenMonitor_0.2.0_x64-setup.exe",
    signature: "c2lnbmF0dXJl\n",
    hubUrl: "https://tokens.example.internal/",
    notes: "  修正上傳  \n",
    pubDate: "2026-09-24T01:02:03Z",
  });
  assert.equal(feed.version, "0.2.0");
  assert.equal(feed.notes, "修正上傳");
  assert.equal(feed.pub_date, "2026-09-24T01:02:03.000Z");
  for (const key of PLATFORM_KEYS) {
    assert.deepEqual(feed.platforms[key], {
      signature: "c2lnbmF0dXJl",
      url: "https://tokens.example.internal/updates/TokenMonitor_0.2.0_x64-setup.exe",
    });
  }
});

test("rejects inputs the hub or the updater would choke on", () => {
  const ok = { version: "0.2.0", installerName: "a.exe", signature: "s", hubUrl: "https://h" };
  assert.throws(() => buildLatestJson({ ...ok, version: "v0.2" }), /semver/);
  assert.throws(() => buildLatestJson({ ...ok, installerName: "Token Monitor_0.2.0.exe" }), /檔名/);
  assert.throws(() => buildLatestJson({ ...ok, signature: "  " }), /簽章/);
  assert.throws(() => normalizeHubUrl("ftp://h"), /http/);
  assert.throws(() => normalizeHubUrl("https://h/?x=1"), /查詢/);
});

test("the CLI reads the .sig next to the installer and self-checks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-latest-"));
  try {
    const exe = path.join(dir, "TokenMonitor_0.3.1_x64-setup.exe");
    fs.writeFileSync(exe, "installer");
    fs.writeFileSync(`${exe}.sig`, "dW50cnVzdGVk\n");
    const out = path.join(dir, "latest.json");
    const log = console.log;
    console.log = () => {};
    try {
      main(["--version", "0.3.1", "--installer", exe, "--hub-url", "http://127.0.0.1:17399", "--out", out]);
    } finally {
      console.log = log;
    }
    const feed = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(feed.platforms["windows-x86_64"].url, "http://127.0.0.1:17399/updates/TokenMonitor_0.3.1_x64-setup.exe");
    assert.equal(feed.platforms["windows-x86_64"].signature, "dW50cnVzdGVk");
    fs.rmSync(`${exe}.sig`);
    assert.throws(() => main(["--version", "0.3.1", "--installer", exe, "--hub-url", "https://h", "--out", out]), /簽章/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GitHub 發行：安裝檔網址是 Release 的下載位置", () => {
  const base = "https://github.com/o/r/releases/download/client-v0.63.1-corp.2/";
  const feed = buildLatestJson({ version: "0.2.0", installerName: "Token-Monitor-Rust_0.2.0_x64-setup.exe", signature: "s", downloadBase: base });
  for (const key of PLATFORM_KEYS) {
    assert.equal(feed.platforms[key].url, "https://github.com/o/r/releases/download/client-v0.63.1-corp.2/Token-Monitor-Rust_0.2.0_x64-setup.exe");
  }
  const ok = { version: "0.2.0", installerName: "a.exe", signature: "s" };
  assert.throws(() => buildLatestJson(ok), /只能一個/);
  assert.throws(() => buildLatestJson({ ...ok, hubUrl: "https://h", downloadBase: base }), /只能一個/);
  assert.throws(() => buildLatestJson({ ...ok, downloadBase: "http://github.com/o/r" }), /https/);
});
