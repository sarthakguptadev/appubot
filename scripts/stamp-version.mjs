#!/usr/bin/env node
/**
 * Stamp a release's version (year.MMDD.n, 2026.1107.2: the day in India and that day's release counted from 1; the
 * Release workflow picks it) into apps/desktop/package.json, which the app reads as its
 * version and electron-builder writes into the update files, and, where it is checked out, into the phone app: apps/mobile/package.json and
 * app.json's `expo.version`, plus build numbers the stores need to grow even for two builds the same day
 * (`expo.ios.buildNumber` = YYYYMMDD.HHMM in UTC without leading zeros, `expo.android.versionCode` = minutes since
 * 2026-01-01 UTC). The Release workflow (in the public releases repo, sarthakguptadev/appubot) runs it before building;
 * it's never bumped by hand.
 * Usage: node scripts/stamp-version.mjs <version>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: stamp-version.mjs <version> (versions look like 2026.1107.1)');
  process.exit(1);
}

const root = new URL('../', import.meta.url);
/** a JSON file of the repo, changed by `edit` and written back as it was laid out (2 spaces, a newline at the end) */
function stamp(path, edit) {
  const file = fileURLToPath(new URL(path, root));
  if (!existsSync(file)) return false;
  const json = JSON.parse(readFileSync(file, 'utf8'));
  edit(json);
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  return true;
}

// STAMP_NOW (ms) pins the clock for tests
const now = new Date(Number(process.env.STAMP_NOW) || Date.now());
const ymd = now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
const buildNumber = `${ymd}.${now.getUTCHours() * 100 + now.getUTCMinutes()}`;
const versionCode = Math.floor((now.getTime() - Date.UTC(2026, 0, 1)) / 60_000);

stamp('apps/desktop/package.json', (pkg) => { pkg.version = version; });
console.log(`apps/desktop is ${version}`);
if (stamp('apps/mobile/package.json', (pkg) => { pkg.version = version; })) console.log(`apps/mobile is ${version}`);
stamp('apps/mobile/app.json', (app) => {
  const expo = app.expo;
  expo.version = version;
  expo.ios = { ...expo.ios, buildNumber };
  if (expo.android) expo.android.versionCode = versionCode;
  console.log(`apps/mobile/app.json is ${version}, iOS build ${buildNumber}${expo.android ? `, Android versionCode ${versionCode}` : ''}`);
});
