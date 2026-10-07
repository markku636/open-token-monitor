'use strict';

// electron-builder's afterSign hook for the company macOS build
// (packaging/build-client.js createBuilderConfig()): it runs once the app is
// signed, before the dmg and the zip are made from it.
//
// An ad-hoc signature's designated requirement is the app's own cdhash, which
// no other build ever has. Squirrel.Mac, which installs electron-updater's mac
// updates, takes a new version only when it satisfies the running app's
// designated requirement, so with the default every update would be refused.
// So the app is signed again, still ad-hoc, with the requirement
// `identifier "<appId>"`. Only the app itself: its helpers and frameworks have
// identifiers of their own, and electron-builder's `requirements` option would
// give each of them the app's.
//
// Squirrel then checks only that the update is validly signed and has the
// app's identifier. That it is the company's build rests on the GitLab Release
// and the sha512 in latest-mac.yml, as for the unsigned Windows installer.

const path = require('node:path');
const { spawnSync } = require('node:child_process');

function designatedRequirement(appId) {
  if (!/^[A-Za-z0-9.-]+$/.test(String(appId || ''))) throw new Error(`appId ${JSON.stringify(appId)} cannot go into a code requirement`);
  return `identifier "${appId}"`;
}

function codesign(args, spawn) {
  const result = spawn('codesign', args, { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0) throw new Error(`codesign ${args.join(' ')} failed with exit code ${result.status}: ${output.trim()}`);
  return output;
}

async function macAfterSign(context, { spawn = spawnSync } = {}) {
  if (context.electronPlatformName !== 'darwin') return false;
  const requirement = designatedRequirement(context.packager.appInfo.id);
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  codesign(['--force', '--sign', '-', '--preserve-metadata=identifier,entitlements,flags', '--requirements', `=designated => ${requirement}`, app], spawn);
  // What Squirrel.Mac asks of an update: a valid signature, nested code
  // included, that satisfies the requirement.
  codesign(['--verify', '--deep', '--strict', '--test-requirement', `=${requirement}`, app], spawn);
  // And what it asks of the running app: this requirement, not the cdhash. An
  // implicit one, which codesign shows as a `#` comment, would be the cdhash.
  const shown = codesign(['--display', '--requirements', '-', app], spawn);
  const appId = context.packager.appInfo.id.replace(/\./g, '\\.');
  if (!new RegExp(`^designated => identifier "?${appId}"?$`, 'm').test(shown)) throw new Error(`${app} kept another designated requirement:\n${shown.trim()}`);
  console.log(`  • designated requirement: ${requirement}`);
  return true;
}

module.exports = macAfterSign;
module.exports.default = macAfterSign;
module.exports.designatedRequirement = designatedRequirement;
