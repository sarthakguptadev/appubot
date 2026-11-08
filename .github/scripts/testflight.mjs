// Gives an uploaded iOS build to TestFlight groups: waits until App Store Connect has processed it, adds it to each group
// (an internal group that already gets every build is left alone), and for external groups sets What to Test and
// sends it to Beta App Review if it isn't there yet. GROUPS: names split by commas; empty uses the app's only group.
// Env: KEY_P8, KEY_ID, ISSUER (the App Store Connect API key), APP_ID, VERSION, BUILD, GROUPS, WHATS_NEW.
import crypto from 'node:crypto';

const env = process.env;
const API = 'https://api.appstoreconnect.apple.com/v1';
const WAIT_MS = 50 * 60_000;
const POLL_MS = 30_000;

function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', kid: env.KEY_ID, typ: 'JWT' });
  const body = b64({ iss: env.ISSUER, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: env.KEY_P8, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}

async function asc(method, path, data) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(data ? { 'content-type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  if (!r.ok) {
    const why = (json.errors ?? []).map((e) => e.detail || e.title).join('; ') || r.statusText;
    const err = new Error(`${method} ${path.split('?')[0]}: ${r.status} ${why}`);
    err.status = r.status;
    throw err;
  }
  return json;
}

const fail = (msg) => { console.log(`::error::${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const groups = (await asc('GET', `/apps/${env.APP_ID}/betaGroups?limit=200&fields[betaGroups]=name,isInternalGroup,hasAccessToAllBuilds`)).data;
console.log(`TestFlight groups: ${groups.map((g) => `${g.attributes.name} (${g.attributes.isInternalGroup ? 'internal' : 'external'})`).join(', ') || 'none'}`);
const wanted = (env.GROUPS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
let chosen;
if (wanted.length) {
  chosen = wanted.map((name) => groups.find((g) => g.attributes.name.toLowerCase() === name.toLowerCase()) ?? fail(`No TestFlight group named “${name}”`));
} else if (groups.length === 1) {
  chosen = groups;
} else {
  fail(groups.length ? 'Several TestFlight groups: name the ones to use (the TESTFLIGHT_GROUPS variable, or the group box)' : 'This app has no TestFlight group yet: make one in App Store Connect › TestFlight');
}

// the build, once Apple has processed it
const q = new URLSearchParams({ 'filter[app]': env.APP_ID, 'filter[version]': env.BUILD, 'filter[preReleaseVersion.version]': env.VERSION, limit: '1' });
const until = Date.now() + WAIT_MS;
let build;
for (;;) {
  build = (await asc('GET', `/builds?${q}`)).data[0];
  const state = build?.attributes?.processingState;
  if (state === 'VALID') break;
  if (state === 'FAILED' || state === 'INVALID') fail(`Apple couldn’t process build ${env.BUILD} (${state})`);
  if (Date.now() > until) fail(`Build ${env.BUILD} still isn’t processed after ${WAIT_MS / 60_000} minutes; run TestFlight group again later`);
  console.log(build ? `Apple is processing build ${env.BUILD}…` : `Waiting for build ${env.BUILD} to show up…`);
  await sleep(POLL_MS);
}
console.log(`Build ${env.VERSION} (${env.BUILD}) is processed`);

let external = false;
for (const g of chosen) {
  const { name, isInternalGroup, hasAccessToAllBuilds } = g.attributes;
  if (isInternalGroup && hasAccessToAllBuilds) { console.log(`${name}: gets every build already`); continue; }
  await asc('POST', `/betaGroups/${g.id}/relationships/builds`, { data: [{ type: 'builds', id: build.id }] });
  console.log(`${name}: build added`);
  if (!isInternalGroup) external = true;
}

if (external) {
  const whatsNew = (env.WHATS_NEW || 'Fixes and improvements.').slice(0, 4000);
  const locs = (await asc('GET', `/builds/${build.id}/betaBuildLocalizations`)).data;
  const loc = locs.find((l) => l.attributes.locale === 'en-US') ?? locs[0];
  if (loc) await asc('PATCH', `/betaBuildLocalizations/${loc.id}`, { data: { type: 'betaBuildLocalizations', id: loc.id, attributes: { whatsNew } } });
  else await asc('POST', '/betaBuildLocalizations', { data: { type: 'betaBuildLocalizations', attributes: { locale: 'en-US', whatsNew }, relationships: { build: { data: { type: 'builds', id: build.id } } } } });
  try {
    await asc('POST', '/betaAppReviewSubmissions', { data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: build.id } } } } });
    console.log('Sent to Beta App Review: external testers get it once Apple approves it');
  } catch (e) {
    if (e.status === 409) console.log('Already with Beta App Review (or approved)');
    else throw e;
  }
}
console.log('Done');
