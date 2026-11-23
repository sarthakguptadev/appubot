/**
 * A bot's visual reply (`show_page`) on a remote computer (your AppuBot computer, a team's), shown in this window from
 * this Mac's own copy, at once and whether the computer is awake or not.
 *
 * The chat frames a page from a gateway URL under the page's own policy (inline scripts allowed, nothing else), and a
 * document the window makes itself (srcdoc, a blob: or data: URL) inherits the window's policy instead, which forbids
 * inline scripts: so the HTML brought through the channel is framed from this Mac's gateway. This Mac's core keeps it
 * (`cloudAccount.pageGet` / `pageSet`, core services/cloudPages.ts: per computer, sealed with the keychain, the least
 * recently shown dropped past Settings › Storage's cap, gone with the computer's saved chats on sign-out or losing
 * access) and frames it at `/cloud-pages/…`. Stale-while-revalidate: the kept copy shows first; while the computer is
 * connected a page not checked for `RECHECK_MS` is fetched again in the background and swapped in only if it changed.
 * Nothing here wakes a computer: a page with no copy yet waits for it to be connected.
 *
 * A core from before kept pages (an older main until it restarts) answers `unknown_method`: then the page is kept as
 * one of this Mac's chat files, as before (localStorage `appubot.remotePages` maps `<computer>:<id>` to it).
 */
import { GatewayClient, GatewayError, uploadFile } from '@appubot/client';
import { cloudGateway, localGateway } from '../../lib/gateway';
import { cloudFileBlob } from './cloudClient';

/** a kept page is fetched again (while connected, at most once a run) when its last check is older than this */
export const RECHECK_MS = 30 * 60_000;

export interface PageCopy { path: string; id: string }

/* ---------- the core's copies ---------- */

/** the core keeps pages (null: not asked yet; false: an older core) */
let coreKeeps: boolean | null = null;
const checked = new Set<string>();
/** one fetch per page however many cards show it (the chat and its Expand dialog) */
const flights = new Map<string, Promise<PageCopy | null>>();

const isUnknown = (e: unknown) => e instanceof GatewayError && e.code === 'unknown_method';

async function bringHtml(file: { id: string; name: string }): Promise<string> {
  const client = cloudGateway();
  if (!client) throw new Error('Your AppuBot computer isn’t connected');
  return (await cloudFileBlob(client, file)).text();
}

async function keep(team: string | undefined, file: { id: string; name: string }): Promise<PageCopy & { changed: boolean }> {
  const html = await bringHtml(file);
  const r = await localGateway().call('cloudAccount.pageSet', { ...(team ? { team } : {}), id: file.id, html }, { timeoutMs: 30_000 });
  return { path: r.path, id: file.id, changed: r.changed };
}

/**
 * This Mac's copy of a remote computer's page: its gateway path and the id it reports its height under. Null when
 * there is no copy yet and `fetch` is false (the computer isn't connected): ask again once it is. `onChanged` hears of
 * a newer copy a background check found.
 */
export async function remotePagePath(
  computer: string, team: string | undefined, file: { id: string; name: string },
  opts: { fetch: boolean; onChanged?: (copy: PageCopy) => void },
): Promise<PageCopy | null> {
  if (coreKeeps === false) return legacyPagePath(computer, file, opts);
  const key = `${computer}:${file.id}`;
  let kept: { path: string; checkedAt: number } | null;
  try {
    kept = await localGateway().call('cloudAccount.pageGet', { ...(team ? { team } : {}), id: file.id }, { timeoutMs: 10_000 });
    coreKeeps = true;
  } catch (e) {
    if (isUnknown(e)) { coreKeeps = false; return legacyPagePath(computer, file, opts); }
    throw e;
  }
  if (kept) {
    // shown now; checked again in the background while the computer is up (never woken for it)
    if (opts.fetch && !checked.has(key) && Date.now() - kept.checkedAt > RECHECK_MS && !flights.has(key)) {
      checked.add(key);
      const flight = keep(team, file).then((r) => {
        if (r.changed) opts.onChanged?.({ path: r.path, id: r.id });
        return { path: r.path, id: r.id };
      }).catch(() => null).finally(() => flights.delete(key));
      flights.set(key, flight);
    }
    return { path: kept.path, id: file.id };
  }
  const going = flights.get(key);
  if (going) {
    const r = await going;
    if (r) return r;
  }
  if (!opts.fetch) return null;
  checked.add(key);
  const flight = keep(team, file).then((r) => ({ path: r.path, id: r.id })).finally(() => flights.delete(key));
  flights.set(key, flight);
  return flight;
}

/* ---------- an older core: a chat file of this Mac's ---------- */

const STORE_KEY = 'appubot.remotePages';
const REMEMBER_MAX = 300;
type Known = Record<string, string>;

function known(): Known {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Known) : {};
  } catch {
    return {};
  }
}
function remember(key: string, id: string): void {
  const m = known();
  delete m[key];
  m[key] = id;
  const keys = Object.keys(m);
  for (const k of keys.slice(0, Math.max(0, keys.length - REMEMBER_MAX))) delete m[k];
  try { localStorage.setItem(STORE_KEY, JSON.stringify(m)); } catch { /* full: made again next time */ }
}
function forget(key: string): void {
  const m = known();
  if (!(key in m)) return;
  delete m[key];
  try { localStorage.setItem(STORE_KEY, JSON.stringify(m)); } catch { /* fine */ }
}
/** Signed out or off a team: the old way's map forgets that computer's pages. */
export function forgetLegacyPages(computer?: string): void {
  if (!computer) { try { localStorage.removeItem(STORE_KEY); } catch { /* fine */ } return; }
  const m = known();
  for (const k of Object.keys(m)) if (k.startsWith(`${computer}:`)) delete m[k];
  try { localStorage.setItem(STORE_KEY, JSON.stringify(m)); } catch { /* fine */ }
}

const legacyFlights = new Map<string, Promise<string>>();

async function pathOfCopy(id: string): Promise<string | null> {
  try { return (await localGateway().call('files.pageView', { id })).path; } catch { return null; }
}

const copyName = (name: string): string => (/\.html?$/i.test(name) ? name : `${name || 'page'}.html`);

async function legacyBring(key: string, file: { id: string; name: string }): Promise<string> {
  const local = localGateway();
  if (!(local instanceof GatewayClient)) throw new Error('No gateway on this computer');
  const html = await bringHtml(file);
  const copy = await uploadFile(local.baseUrl, local.token, new Blob([html], { type: 'text/html' }), copyName(file.name));
  remember(key, copy.id);
  return copy.id;
}

async function legacyPagePath(computer: string, file: { id: string; name: string }, opts: { fetch: boolean }): Promise<PageCopy | null> {
  const key = `${computer}:${file.id}`;
  const have = known()[key];
  if (have) {
    const path = await pathOfCopy(have);
    if (path) return { path, id: have };
    forget(key);
  }
  if (!opts.fetch && !legacyFlights.has(key)) return null;
  let flight = legacyFlights.get(key);
  if (!flight) {
    flight = legacyBring(key, file).finally(() => legacyFlights.delete(key));
    legacyFlights.set(key, flight);
  }
  const id = await flight;
  const path = await pathOfCopy(id);
  if (!path) throw new Error('The page couldn’t be kept on this computer');
  return { path, id };
}
