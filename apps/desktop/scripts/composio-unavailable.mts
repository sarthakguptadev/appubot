/**
 * Finds the apps in the directory that can't be connected through AppuBot and writes them to
 * src/main/core/services/composioUnavailable.json, which the app hides (composio.ts) and the directory build leaves
 * out of the list (composioDirectory.ts). Composio's platform lists every toolkit, but the account type AppuBot uses
 * ("Composio for You") only connects the ones Composio runs a sign-in for; the rest answer "no managed auth",
 * "not available" or "retired" when someone presses Add. The only way to know is to ask, so this starts a connection
 * for each app as the Add button does, notes the answer and removes what it started.
 *   pnpm -C apps/desktop apps-unavailable            apps that sign in or need nothing (OAuth, other, none)
 *   pnpm -C apps/desktop apps-unavailable --all      API-key apps too (about 1,300 more, slower)
 * It uses this Mac's own AppuBot sign-in to Composio (Apps, signed in; quit AppuBot first: it renews the sign-in and
 * saves it the way the app does). APPUBOT_DATA_DIR points it at another data folder.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composioConnect } from '../src/main/core/services/composioConnect';
import { unavailableReason, type UnavailableReason } from '../src/main/core/services/composioDirectory';
import { writeFileAtomic, type StoredApps } from '../src/main/core/store';

const here = dirname(fileURLToPath(import.meta.url));
const services = join(here, '../src/main/core/services');
const out = join(services, 'composioUnavailable.json');
const all = process.argv.includes('--all');
const BATCH = 10;

function dataDir(): string {
  if (process.env.APPUBOT_DATA_DIR) return process.env.APPUBOT_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support/AppuBot');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'AppuBot');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'AppuBot');
}

const appsFile = join(dataDir(), 'apps.json');
const api = composioConnect();

/** A valid access token: the saved one, renewed and saved back (as the app does) when it is about to run out. */
async function token(): Promise<string> {
  let stored: StoredApps;
  try { stored = JSON.parse(readFileSync(appsFile, 'utf8')) as StoredApps; }
  catch { throw new Error(`No AppuBot data at ${appsFile}. Open AppuBot, sign in to Composio in Apps, quit it, and run this again.`); }
  const auth = stored.auth;
  if (!auth) throw new Error('AppuBot is not signed in to Composio on this computer: sign in in Apps, quit AppuBot, and run this again.');
  if (auth.expiresAt - 120_000 > Date.now()) return auth.accessToken;
  if (!auth.refreshToken) throw new Error('The Composio sign-in has run out: sign in again in Apps.');
  const next = await api.refresh({ clientId: auth.clientId, refreshToken: auth.refreshToken });
  const renewed = { ...auth, ...next, refreshToken: next.refreshToken ?? auth.refreshToken, account: next.account ?? auth.account };
  writeFileAtomic(appsFile, JSON.stringify({ ...stored, auth: renewed }, null, 2), 0o600);
  return renewed.accessToken;
}

interface Result { status?: string; redirect_url?: string; error_message?: string; accounts?: { id?: string; status?: string }[] }
async function manage(toolkits: unknown[]): Promise<Record<string, Result>> {
  const r = await api.callTool(await token(), 'COMPOSIO_MANAGE_CONNECTIONS', { toolkits });
  const j = JSON.parse(r.text) as { data?: { results?: Record<string, Result> }; error?: string };
  if (!j.data?.results) throw new Error(`Composio: ${j.error ?? r.text.slice(0, 200)}`);
  return j.data.results;
}

const directory = JSON.parse(readFileSync(join(services, 'composioDirectory.json'), 'utf8')) as { toolkits: { slug: string; name: string; authKind: string }[]; unlisted?: { slug: string; name: string; authKind: string }[] };
const everyone = [...directory.toolkits, ...(directory.unlisted ?? [])];
const candidates = everyone.filter((t) => all || t.authKind !== 'api_key');
console.log(`${candidates.length} of ${everyone.length} apps to ask about${all ? '' : ' (API-key apps left out: --all includes them)'}`);

const unavailable: Record<string, UnavailableReason> = {};
const unknown: Record<string, string> = {};
const started: { slug: string; id: string }[] = [];
let asked = 0;
let stopped: string | undefined;
try {
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    // an app with an account already is connectable, and asking again would add a second account to it
    const listed = await manage(batch.map((t) => ({ name: t.slug, action: 'list' })));
    const fresh = batch.filter((t) => !(listed[t.slug]?.accounts ?? []).length);
    if (fresh.length) {
      const res = await manage(fresh.map((t) => ({ name: t.slug, action: 'add' })));
      for (const t of fresh) {
        const r = res[t.slug];
        for (const a of r?.accounts ?? []) if (a.id && String(a.status).toLowerCase() !== 'active') started.push({ slug: t.slug, id: a.id });
        if (!r || r.redirect_url || String(r.status).toLowerCase() === 'active') continue;
        const why = unavailableReason(r.error_message ?? '');
        if (why) unavailable[t.slug] = why; else unknown[t.slug] = (r.error_message ?? `status ${r.status}`).slice(0, 160);
      }
    }
    asked += batch.length;
    if (asked % 100 < BATCH) console.log(`  ${asked} asked, ${Object.keys(unavailable).length} can't connect`);
  }
} catch (e) {
  stopped = e instanceof Error ? e.message : String(e);
} finally {
  let removed = 0;
  for (let i = 0; i < started.length; i += BATCH) {
    try { await manage(started.slice(i, i + BATCH).map((m) => ({ name: m.slug, action: 'remove', account_id: m.id }))); removed += Math.min(BATCH, started.length - i); }
    catch (e) { console.error(`  could not remove ${started.slice(i, i + BATCH).map((m) => m.slug).join(', ')}: ${e instanceof Error ? e.message : e}`); }
  }
  console.log(`started ${started.length} connections, removed ${removed}`);
}

if (stopped) {
  console.error(`Stopped after ${asked} apps: ${stopped}\nNothing written.`);
  process.exit(1);
}
// a run without --all keeps what an earlier --all run found among the API-key apps
let kept: Record<string, UnavailableReason> = {};
if (!all) {
  try {
    const before = JSON.parse(readFileSync(out, 'utf8')) as { unavailable?: Record<string, UnavailableReason> };
    const askedNow = new Set(candidates.map((t) => t.slug));
    kept = Object.fromEntries(Object.entries(before.unavailable ?? {}).filter(([slug]) => !askedNow.has(slug)));
  } catch { /* no earlier list */ }
}
const merged = { ...kept, ...unavailable };
const sorted = Object.fromEntries(Object.keys(merged).sort().map((s) => [s, merged[s]!]));
writeFileSync(out, `${JSON.stringify({ checkedAt: new Date().toISOString(), unavailable: sorted }, null, 1)}\n`);
const by = (r: UnavailableReason) => Object.values(sorted).filter((x) => x === r).length;
console.log(`${Object.keys(sorted).length} apps can't connect (${by('needs-setup')} need their own setup at Composio, ${by('not-offered')} not offered, ${by('retired')} retired) → ${out}`);
if (Object.keys(unknown).length) console.log(`Not understood, left listed:\n${Object.entries(unknown).map(([s, w]) => `  ${s}: ${w}`).join('\n')}`);
