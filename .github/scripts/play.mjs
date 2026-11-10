// Sends an Android App Bundle to Google Play through the Play Developer API as a Google Cloud service account (no
// dependencies): with an access token the workflow got for it without any key (PLAY_ACCESS_TOKEN: GitHub's own
// identity, exchanged through Workload Identity Federation), else with the account's JSON key (PLAY_SERVICE_ACCOUNT).
//   node play.mjs check    before the build: the key works, the app and the track are there, and VERSION_CODE is above
//                          every one Play already has (Play refuses a version code it has seen)
//   node play.mjs upload   uploads AAB, puts it on TRACK as a release for ROLLOUT percent of users (100: everyone) with
//                          WHATS_NEW in the store listing's default language, and sends it for review
// A release sent to production goes live by itself once Google has reviewed it (unless Managed publishing is on in Play
// Console). When Play won't send changes for review by itself (an earlier rejection waits there), the release is
// saved and the run says to press "Send for review" in Play Console › Publishing overview.
// Env: PLAY_ACCESS_TOKEN or PLAY_SERVICE_ACCOUNT (the JSON key's text), PACKAGE, TRACK (production | beta = open testing | alpha = closed
// testing | internal), VERSION_CODE; upload also AAB, ROLLOUT, WHATS_NEW. PLAY_API_URL / PLAY_UPLOAD_URL point tests
// at a stand-in.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const env = process.env;
const API = env.PLAY_API_URL || 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const UPLOAD = env.PLAY_UPLOAD_URL || 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const NOTES_MAX = 500;
const TRIES = 3;
const TRACK_WORDS = { production: 'production', beta: 'open testing', alpha: 'closed testing', internal: 'internal testing' };

const fail = (msg) => { console.log(`::error::${msg}`); process.exit(1); };
const warn = (msg) => console.log(`::warning::${msg}`);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const mode = process.argv[2];
if (mode !== 'check' && mode !== 'upload') fail('usage: play.mjs check | upload');

let account;
if (!env.PLAY_ACCESS_TOKEN) {
  try {
    account = JSON.parse(env.PLAY_SERVICE_ACCOUNT ?? '');
    if (!account.client_email || !account.private_key) throw new Error('not a key');
  } catch {
    fail('PLAY_SERVICE_ACCOUNT_JSON isn’t a service account’s JSON key (the whole file Google Cloud gave you, as it is)');
  }
}
const PACKAGE = env.PACKAGE || fail('PACKAGE isn’t set');
const TRACK = env.TRACK || 'production';
const CODE = Number(env.VERSION_CODE);
if (!Number.isInteger(CODE) || CODE <= 0) fail('VERSION_CODE isn’t a number');
const trackWords = TRACK_WORDS[TRACK] ?? `the “${TRACK}” track`;
const percent = Number(env.ROLLOUT || 100);
if (!(percent > 0 && percent <= 100)) fail('ROLLOUT is a percentage from 1 to 100');

let cached;
async function token() {
  if (env.PLAY_ACCESS_TOKEN) return env.PLAY_ACCESS_TOKEN;
  if (cached && cached.until > Date.now()) return cached.value;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const uri = account.token_uri || 'https://oauth2.googleapis.com/token';
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const body = b64({ iss: account.client_email, scope: SCOPE, aud: uri, iat: now, exp: now + 3600 });
  let sig;
  try {
    sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), account.private_key).toString('base64url');
  } catch {
    fail('The service account key’s private key can’t be read: paste the JSON file as it is into PLAY_SERVICE_ACCOUNT_JSON');
  }
  const r = await fetch(uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.access_token) {
    fail(`Google refused the service account key (${json.error_description || json.error || r.status}): is the key still there in Google Cloud › Service accounts › Keys?`);
  }
  cached = { value: json.access_token, until: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 300) * 1000 };
  return cached.value;
}

class PlayError extends Error {
  constructor(what, status, why) {
    super(`${what}: ${status} ${why}`);
    this.status = status;
    this.why = why;
  }
  get passing() { return this.status === 0 || this.status === 429 || this.status >= 500; }
}

async function api(method, path, { query, body } = {}) {
  const url = `${API}/applications/${PACKAGE}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const what = `${method} ${path.replace(/\/edits\/[^/:]+/, '/edits/…')}`;
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${await token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new PlayError(what, 0, e.cause?.code || e.message);
  }
  const text = await r.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON: the status says it */ }
  if (!r.ok) throw new PlayError(what, r.status, json.error?.message || r.statusText);
  return json;
}

function explain(e) {
  if (!(e instanceof PlayError)) return e.message;
  const why = e.why ?? '';
  if (/has not been used in project|is disabled|accessNotConfigured/i.test(why)) {
    return 'The Google Play Android Developer API isn’t switched on in the service account’s Google Cloud project: enable it there (APIs & Services › Library), wait a few minutes and run this again';
  }
  if (e.status === 401 || e.status === 403) {
    return `Play refused the service account (${why}). Invite its email in Play Console › Users and permissions with this app’s release permissions; a new invite can take a few hours, sometimes a day, to work`;
  }
  if (e.status === 404) return `Play has no app ${PACKAGE} that this service account can see (${why})`;
  if (/draft app/i.test(why)) return `This app has never been published on Play, so the API only takes drafts: publish its first release in Play Console by hand (${why})`;
  if (/already been used|already exists/i.test(why)) return `Play already has version code ${CODE} (${why})`;
  return e.message;
}

/** every version code Play holds on any track, and the tracks' names */
async function tracksOf(editId) {
  const tracks = (await api('GET', `/edits/${editId}/tracks`)).tracks ?? [];
  const codes = tracks.flatMap((t) => (t.releases ?? []).flatMap((r) => (r.versionCodes ?? []).map(Number)));
  return { tracks, highest: codes.length ? Math.max(...codes) : 0 };
}

const dropEdit = (id) => api('DELETE', `/edits/${id}`).catch(() => {});

async function check() {
  const edit = await api('POST', '/edits');
  try {
    const { tracks, highest } = await tracksOf(edit.id);
    const names = tracks.map((t) => t.track);
    if (!names.includes(TRACK)) throw new Error(`Play has no “${TRACK}” track for ${PACKAGE}. Its tracks: ${names.join(', ') || 'none'}`);
    if (CODE <= highest) throw new Error(`Version code ${CODE} isn’t above ${highest}, the highest Play has: build again (the code is the minute it was built)`);
    console.log(`Google Play is ready: ${PACKAGE}, ${trackWords}, version code ${CODE} (Play’s highest: ${highest || 'none'})`);
  } finally {
    await dropEdit(edit.id);
  }
}

/** one request with a body of any size and no client timeout (Play checks a bundle before it answers) */
function send(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'http:' ? http : https).request(u, { method, headers: { ...headers, 'content-length': body ? body.length : 0 } }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(parts).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function uploadBundle(editId, file) {
  const what = 'Uploading the bundle';
  let res;
  try {
    const start = await send('POST', `${UPLOAD}/applications/${PACKAGE}/edits/${editId}/bundles?uploadType=resumable`, {
      authorization: `Bearer ${await token()}`,
      'x-upload-content-type': 'application/octet-stream',
      'x-upload-content-length': String(file.length),
    });
    if (start.status >= 300 || !start.headers.location) res = start;
    else res = await send('PUT', start.headers.location, { authorization: `Bearer ${await token()}`, 'content-type': 'application/octet-stream' }, file);
  } catch (e) {
    throw new PlayError(what, 0, e.code || e.message);
  }
  let json = {};
  try { json = res.text ? JSON.parse(res.text) : {}; } catch { /* not JSON */ }
  if (res.status >= 300) throw new PlayError(what, res.status, json.error?.message || `HTTP ${res.status}`);
  return json;
}

function releaseOf(language) {
  let notes = (env.WHATS_NEW ?? '').trim();
  if (notes.length > NOTES_MAX) {
    warn(`What’s new is cut to ${NOTES_MAX} characters, Play’s limit`);
    notes = `${notes.slice(0, NOTES_MAX - 1).trimEnd()}…`;
  }
  return {
    release: {
      versionCodes: [String(CODE)],
      ...(percent < 100 ? { status: 'inProgress', userFraction: percent / 100 } : { status: 'completed' }),
      ...(notes ? { releaseNotes: [{ language, text: notes }] } : {}),
    },
  };
}

async function upload() {
  const file = readFileSync(env.AAB || fail('AAB isn’t set'));
  for (let attempt = 1; ; attempt++) {
    const edit = await api('POST', '/edits');
    try {
      const { tracks } = await tracksOf(edit.id);
      const there = tracks.find((t) => t.track === TRACK)?.releases?.some((r) => (r.versionCodes ?? []).includes(String(CODE)));
      if (there) {
        console.log(`Version code ${CODE} is already on ${trackWords}`);
        await dropEdit(edit.id);
        return;
      }
      const bundle = await uploadBundle(edit.id, file);
      if (Number(bundle.versionCode) !== CODE) throw new Error(`The bundle’s version code is ${bundle.versionCode}, not ${CODE}`);
      const language = (await api('GET', `/edits/${edit.id}/details`).catch(() => ({}))).defaultLanguage || 'en-US';
      const { release } = releaseOf(language);
      await api('PUT', `/edits/${edit.id}/tracks/${TRACK}`, { body: { track: TRACK, releases: [release] } });
      let sent = true;
      try {
        await api('POST', `/edits/${edit.id}:commit`);
      } catch (e) {
        if (!(e instanceof PlayError) || !/changesNotSentForReview/i.test(e.why ?? '')) throw e;
        await api('POST', `/edits/${edit.id}:commit`, { query: { changesNotSentForReview: 'true' } });
        sent = false;
      }
      const whom = percent < 100 ? `${percent}% of users` : 'everyone';
      if (sent) console.log(`Sent version code ${CODE} to Google Play: ${trackWords}, for ${whom}. It goes out once Google has reviewed it`);
      else warn(`Version code ${CODE} is saved on ${trackWords} for ${whom}, but Play won’t send it for review by itself: press “Send for review” in Play Console › Publishing overview`);
      return;
    } catch (e) {
      await dropEdit(edit.id);
      if (!(e instanceof PlayError) || !e.passing || attempt >= TRIES) throw e;
      warn(`${e.message}; trying again in ${attempt * 20} s`);
      await sleep(attempt * 20_000);
    }
  }
}

try {
  await (mode === 'check' ? check() : upload());
} catch (e) {
  fail(explain(e));
}
