// Sends an uploaded iOS build to the App Store: waits until App Store Connect has processed it, puts it on the App Store
// version for its version number (made if there is none being prepared; one being prepared is renamed to it), writes
// What's New in every language of the listing, and submits it to App Review. Once Apple approves it, it goes out by
// itself (RELEASE=MANUAL: it waits for "Release this version" in App Store Connect instead).
// SUBMIT=false stops before submitting: the version is prepared and the run says where things stand.
// Needs a key with the App Manager role (the Developer key that uploads builds gets a 403 here).
// Env: KEY_P8, KEY_ID, ISSUER (the App Store Connect API key), APP_ID, VERSION, BUILD, WHATS_NEW, SUBMIT, RELEASE.
import crypto from 'node:crypto';

const env = process.env;
const API = 'https://api.appstoreconnect.apple.com/v1';
const WAIT_MS = 50 * 60_000;
const POLL_MS = 30_000;
const SUBMIT = env.SUBMIT !== 'false';
const RELEASE = env.RELEASE === 'MANUAL' ? 'MANUAL' : 'AFTER_APPROVAL';

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
const stateOf = (v) => v.attributes.appVersionState ?? v.attributes.appStoreState;

const EDITABLE = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];
const WITH_REVIEW = ['READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'IN_REVIEW'];

// the build, once Apple has processed it
const q = new URLSearchParams({ 'filter[app]': env.APP_ID, 'filter[version]': env.BUILD, 'filter[preReleaseVersion.version]': env.VERSION, limit: '1' });
const until = Date.now() + WAIT_MS;
let build;
for (;;) {
  build = (await asc('GET', `/builds?${q}`)).data[0];
  const state = build?.attributes?.processingState;
  if (state === 'VALID') break;
  if (state === 'FAILED' || state === 'INVALID') fail(`Apple couldn’t process build ${env.BUILD} (${state})`);
  if (Date.now() > until) fail(`Build ${env.BUILD} still isn’t processed after ${WAIT_MS / 60_000} minutes; run App Store again later`);
  console.log(build ? `Apple is processing build ${env.BUILD}…` : `Waiting for build ${env.BUILD} to show up…`);
  await sleep(POLL_MS);
}
console.log(`Build ${env.VERSION} (${env.BUILD}) is processed`);

// the App Store versions as they stand
const versions = (await asc('GET', `/apps/${env.APP_ID}/appStoreVersions?filter[platform]=IOS&limit=20`)).data;
console.log(`App Store versions: ${versions.map((v) => `${v.attributes.versionString} ${stateOf(v)}`).join(', ') || 'none'}`);

const busy = versions.find((v) => WITH_REVIEW.includes(stateOf(v)));
if (busy) {
  const itsBuild = (await asc('GET', `/appStoreVersions/${busy.id}/build`).catch(() => ({ data: null }))).data;
  if (busy.attributes.versionString === env.VERSION && itsBuild?.id === build.id) {
    console.log(`Version ${env.VERSION} (${env.BUILD}) is already with App Review (${stateOf(busy)})`);
    process.exit(0);
  }
  fail(`Version ${busy.attributes.versionString} is with App Review (${stateOf(busy)}). Take it back in App Store Connect (Remove from Review) to send ${env.VERSION} instead`);
}

let version = versions.find((v) => EDITABLE.includes(stateOf(v)));
if (version) {
  const patch = {};
  if (version.attributes.versionString !== env.VERSION) patch.versionString = env.VERSION;
  if (version.attributes.releaseType !== RELEASE) patch.releaseType = RELEASE;
  if (Object.keys(patch).length) {
    await asc('PATCH', `/appStoreVersions/${version.id}`, { data: { type: 'appStoreVersions', id: version.id, attributes: patch } });
    console.log(`The version being prepared (${version.attributes.versionString}, ${stateOf(version)}) is now ${env.VERSION}`);
  } else {
    console.log(`Version ${env.VERSION} is being prepared (${stateOf(version)})`);
  }
} else {
  version = (await asc('POST', '/appStoreVersions', {
    data: {
      type: 'appStoreVersions',
      attributes: { platform: 'IOS', versionString: env.VERSION, releaseType: RELEASE },
      relationships: { app: { data: { type: 'apps', id: env.APP_ID } } },
    },
  })).data;
  console.log(`Made App Store version ${env.VERSION}`);
}

await asc('PATCH', `/appStoreVersions/${version.id}/relationships/build`, { data: { type: 'builds', id: build.id } });
console.log(`Build ${env.BUILD} is on version ${env.VERSION}`);

// What's New, in every language the listing has (a first version has none to write)
const whatsNew = (env.WHATS_NEW || 'Fixes and improvements.').slice(0, 4000);
const locs = (await asc('GET', `/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`)).data;
let wrote = 0;
for (const loc of locs) {
  try {
    await asc('PATCH', `/appStoreVersionLocalizations/${loc.id}`, { data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: { whatsNew } } });
    wrote += 1;
  } catch (e) {
    if (e.status !== 409) throw e;
    console.log(`${loc.attributes.locale}: What’s New can’t be written (${e.message.split(': ').slice(1).join(': ')})`);
  }
}
console.log(`What’s New written in ${wrote} of ${locs.length} language(s): ${locs.map((l) => l.attributes.locale).join(', ') || 'none'}`);

if (!SUBMIT) {
  console.log(`Version ${env.VERSION} is prepared with build ${env.BUILD}. Nothing was submitted (Submit was unticked)`);
  process.exit(0);
}

// one submission that isn't sent yet is reused; else a new one
const open = (await asc('GET', `/reviewSubmissions?filter[app]=${env.APP_ID}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW&limit=5`)).data[0];
const submission = open ?? (await asc('POST', '/reviewSubmissions', {
  data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: env.APP_ID } } } },
})).data;
try {
  await asc('POST', '/reviewSubmissionItems', {
    data: {
      type: 'reviewSubmissionItems',
      relationships: {
        reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
        appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
      },
    },
  });
} catch (e) {
  if (e.status !== 409 || !open) throw e;
  console.log('The version was already in the submission');
}
await asc('PATCH', `/reviewSubmissions/${submission.id}`, { data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } } });
console.log(`Sent ${env.VERSION} (${env.BUILD}) to App Review. ${RELEASE === 'MANUAL' ? 'Once approved it waits for Release this version in App Store Connect' : 'Once approved it goes out on the App Store by itself'}`);
