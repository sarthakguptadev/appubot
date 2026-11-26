/**
 * Apps: the user's own Composio account ("Composio for You"), signed in with OAuth in the browser. The directory of
 * toolkits ships with the app (composioDirectory.json, built before a release with the maker's key). Connections are
 * made once for every bot, through Composio's MCP (`COMPOSIO_MANAGE_CONNECTIONS`, its link page in the browser), and each bot reaches the connected
 * apps it may use (`appsOn`: all of them unless turned off for that bot) through the bridge's apps tools, which come
 * here: search, input schemas and execute, filtered and checked against that bot's apps on every call. The tokens
 * live in apps.json (owner-only) and never leave this computer; agents never see them.
 *
 * Composio for You connects only the apps Composio runs a sign-in for: the rest (composioUnavailable.json, and any
 * that refuse here later) are left off the Apps page. Apps that need no sign-in are every bot's once Composio is
 * signed in. An answer too large for Composio to return comes back as a file in the bot's folder.
 *
 * Apps on their own servers (`directApps.ts`: ones Composio can't connect whose makers run an MCP server) sit beside
 * them in the same catalog, connections and bots' tools, and need no Composio sign-in.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appOn, appsOn, type AppConnection, type AppToolkit, type AppsStatus, type Bot, type MethodParams, type MethodResult, type QuestionForm } from '@appubot/protocol';
import { appCardState } from '@appubot/chat-core';
import type { AgentContext } from '../auth';
import type { CoreCtx } from '../context';
import type { JsonFile, StoredApps } from '../store';
import type { StoredComposioAuth } from '../store';
import { errMsg, notFound, RpcError, sleep } from '../util';
import { NEEDS_ACCOUNT, accountLabel, accountNames, accountsText, defaultAccount, pickAccount, workingAccounts } from './composioAccounts';
import { ComposioHttpError, composioConnect, pkce, type ComposioConnect } from './composioConnect';
import { listedDirectory, unavailableReason, type AppsDirectory, type UnavailableReason } from './composioDirectory';
import { DirectApps } from './directApps';
import directoryJson from './composioDirectory.json';
import unavailableJson from './composioUnavailable.json';

export const NEEDS_SIGN_IN = 'Sign in to Composio in Apps';
const SIGNED_OUT = 'Your Composio sign-in ended. Sign in again in Apps.';
const DIRECTORY = listedDirectory(directoryJson as AppsDirectory, (unavailableJson as { unavailable: Record<string, UnavailableReason> }).unavailable);
/** a browser sign-in may sit open while the user finds their password */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** renew the access token this long before it runs out */
const REFRESH_EARLY_MS = 60_000;
/** how long the listed connections count as fresh for the Apps page */
const LISTED_TTL_MS = 60_000;
/** how often the whole directory is looked through for apps connected elsewhere (Claude.ai, Codex, Composio's site) */
const SWEEP_EVERY_MS = 24 * 60 * 60_000;
/** ... and how often while someone has the Apps page open (an app connected on another computer shows up there) */
const SWEEP_ON_VIEW_MS = 10 * 60_000;
/** apps per `list` call (50 answer in ~2s) */
const LIST_BATCH = 50;
/** `list` calls at once */
const LIST_PARALLEL = 4;
/** Composio takes at most this many tasks in one search */
export const SEARCH_QUERIES_MAX = 7;
/** where in a bot's folder the answers too large to return are kept, and how many */
const ANSWERS_DIR = join('inbox', 'apps');
const ANSWERS_KEPT = 20;
const ANSWER_MAX_BYTES = 64 * 1024 * 1024;
const ANSWER_FETCH_MS = 120_000;
/** a file in Composio's sandbox, as its answers name it */
const REMOTE_PATH = /^\/[\w.\-/]{1,300}$/;
const FILE_URL_MARK = 'APPUBOT_FILE_URL=';
const FILE_ERROR_MARK = 'APPUBOT_FILE_ERROR=';
/** Composio's link pages expire after 10 minutes */
const CONNECT_TIMEOUT_MS = 10 * 60_000;
const STARTING = new Set(['INITIATED', 'INITIALIZING']);
const FAILED = new Set(['FAILED', 'EXPIRED', 'REVOKED']);

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Short queries: the very name, name prefix, slug prefix, a word of the name, anywhere in the name, then the description. */
function localSearch(items: AppToolkit[], q: string): AppToolkit[] {
  const n = q.toLowerCase();
  const rank = (t: AppToolkit): number => {
    const name = t.name.toLowerCase();
    if (name === n) return 0;
    if (name.startsWith(n)) return 1;
    if (t.slug.startsWith(n)) return 2;
    if (name.split(/\W+/).some((w) => w.startsWith(n))) return 3;
    if (name.includes(n)) return 4;
    return t.description?.toLowerCase().includes(n) ? 5 : -1;
  };
  return items.map((t, i) => ({ t, i, r: rank(t) })).filter((x) => x.r >= 0).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.t);
}

/** Composio's tool results are JSON text; anything else stays as it is. */
function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** One account as Composio lists it. */
interface ListedAccount { id?: unknown; status?: unknown; alias?: unknown; user_info?: unknown; is_default?: unknown }

/** A listed account as AppuBot keeps it; `isDefault` is still Composio's own default here (`defaultAccount` decides ours). */
function accountOf(slug: string, a: ListedAccount): AppConnection {
  const label = accountLabel(a.user_info);
  return {
    slug, connectedAccountId: a.id as string, status: String(a.status ?? '').toUpperCase(),
    ...(label ? { label } : {}),
    ...(typeof a.alias === 'string' && a.alias.trim() ? { alias: a.alias.trim().slice(0, 120) } : {}),
    ...(a.is_default === true ? { isDefault: true } : {}),
  };
}

/** The accounts per toolkit in a `COMPOSIO_MANAGE_CONNECTIONS` answer (`data.results[slug].accounts`). */
export function accountsIn(text: string): Map<string, AppConnection[]> {
  const out = new Map<string, AppConnection[]>();
  const results = (parseJson(text)?.data as { results?: Record<string, { accounts?: ListedAccount[]; redirect_url?: unknown }> } | undefined)?.results ?? {};
  for (const [slug, r] of Object.entries(results)) {
    out.set(slug, (r.accounts ?? []).filter((a) => typeof a.id === 'string').map((a) => accountOf(slug, a)));
  }
  return out;
}

/** The toolkit a tool slug belongs to (`GOOGLECALENDAR_CREATE_EVENT` → googlecalendar): the longest known slug it starts with. */
export function toolkitOfTool(tool: string, slugs: Iterable<string>): string | undefined {
  const t = tool.toUpperCase();
  let best: string | undefined;
  for (const s of slugs) {
    const p = `${s.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
    if (t.startsWith(p) && (!best || s.length > best.length)) best = s;
  }
  return best;
}

/** Composio's meta tools as the bot knows them (the bridge's apps tools); the others aren't the bot's. */
const OUR_NAMES: Record<string, string> = { COMPOSIO_SEARCH_TOOLS: 'apps_search', COMPOSIO_GET_TOOL_SCHEMAS: 'apps_tool_schemas', COMPOSIO_MULTI_EXECUTE_TOOL: 'apps_execute' };
/** Composio's tools a bot doesn't get: connecting apps (that's AppuBot's Apps page) and the remote workbench. */
const NOT_OURS = /COMPOSIO_(?:MANAGE_CONNECTIONS|WAIT_FOR_CONNECTIONS|REMOTE_WORKBENCH|REMOTE_BASH_TOOL)/;

/** Composio's words to a person: its first sentence, without the instructions it writes for an agent. */
function plainReason(said: string): string {
  const first = said.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').split(/(?<=[.!?])\s/)[0] ?? '';
  return first.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Why an app can't be connected, in words for the person who pressed Add. */
export function cantConnectText(name: string, why: UnavailableReason): string {
  if (why === 'needs-setup') return `${name} can't be connected from AppuBot yet: Composio has no sign-in of its own for it.`;
  if (why === 'retired') return `${name} has been retired by Composio and can't be connected any more.`;
  return `${name} isn't offered through Composio for AppuBot.`;
}

/** The code AppuBot runs in Composio's sandbox to get a link to a file there (its own `upload_local_file` helper). */
export function fileLinkCode(remotePath: string): string {
  return `r, e = upload_local_file(${JSON.stringify(remotePath)})\nprint(${JSON.stringify(FILE_ERROR_MARK)} + str(e) if e else ${JSON.stringify(FILE_URL_MARK)} + str((r or {}).get("s3_url") or ""))`;
}

/** What that code printed: the link (on Composio's own site only), or why there is none. */
export function fileLinkIn(answer: string): { url?: string; error?: string } {
  const out = String((parseJson(answer)?.data as { stdout?: unknown } | undefined)?.stdout ?? answer);
  const failed = out.split(FILE_ERROR_MARK)[1]?.split('\n')[0]?.trim();
  const url = out.split(FILE_URL_MARK)[1]?.split(/\s/)[0]?.trim();
  if (!url) return { error: failed ? failed.slice(0, 160) : 'Composio gave no link to it' };
  let host = '';
  try { const u = new URL(url); if (u.protocol === 'https:') host = u.hostname; } catch { /* not a link */ }
  return /(^|\.)composio\.dev$/.test(host) ? { url } : { error: 'Composio gave an unexpected link' };
}

/** Composio's text with its tool names as the bot knows them. */
export function ourToolNames(text: string): string {
  return text.replace(/COMPOSIO_(?:SEARCH_TOOLS|GET_TOOL_SCHEMAS|MULTI_EXECUTE_TOOL)/g, (m) => OUR_NAMES[m] ?? m);
}

interface Pending { accountId: string; stop: () => void }
/** A device's own return address for the sign-in: the AppuBot app's link, or Expo Go's while developing. */
export function isDeviceRedirect(uri: string): boolean {
  return /^(appubot|exps?):\/\/[^\s]+$/i.test(uri) && !/[\s<>"']/.test(uri);
}

interface SignIn { state: string; verifier: string; clientId: string; redirectUri: string; timer: ReturnType<typeof setTimeout> }

export class ComposioService {
  private api: ComposioConnect;
  private signingIn: SignIn | null = null;
  private refreshing: Promise<string> | null = null;
  /** accounts per toolkit, as last listed */
  private accounts = new Map<string, AppConnection[]>();
  /** who an account is, by its id, where a search said and the list didn't */
  private labels = new Map<string, string>();
  private listedAt = 0;
  private listJob: Promise<void> | null = null;
  private sweepJob: Promise<void> | null = null;
  /** tool slug → toolkit, from what search and schemas said */
  private toolkits = new Map<string, string>();
  /** every app the directory names, listed or not (names and logos) */
  private bySlug = new Map([...DIRECTORY.toolkits, ...DIRECTORY.unlisted].map((t) => [t.slug, t]));
  /** apps that need no sign-in */
  private readonly noSignIn = DIRECTORY.toolkits.filter((t) => t.authKind === 'none').map((t) => t.slug);
  private pending = new Map<string, Pending>();
  private error: string | undefined;
  /** the apps that connect on their own servers */
  private direct: DirectApps;

  /** where the sign-in, tokens and connections live: the computer's `apps.json`, or a team member's own (`LoginsService`) */
  private file: JsonFile<StoredApps>;

  constructor(private ctx: CoreCtx, file?: JsonFile<StoredApps>) {
    this.file = file ?? ctx.store.apps;
    this.api = ctx.deps.composioConnect?.() ?? composioConnect();
    this.direct = new DirectApps(ctx, this.file, () => this.signedInOrOut());
    for (const t of this.direct.toolkits()) this.bySlug.set(t.slug, t);
    // what the API-key version kept (the key, its user id and sessions) has no use any more
    const f = this.file.get() as Record<string, unknown>;
    if ('apiKey' in f || 'userId' in f || 'session' in f || 'bots' in f) {
      this.file.update((v) => {
        const { apiKey: _k, userId: _u, session: _s, bots: _b, ...rest } = v as Record<string, unknown>;
        return rest as typeof v;
      });
    }
  }

  private auth(): StoredComposioAuth | undefined { return this.file.get().auth; }

  status(): AppsStatus {
    const auth = this.auth();
    const pending = [...new Set([...this.pending.keys(), ...this.direct.pendingSlugs()])];
    return { configured: !!auth, account: auth?.account, signingIn: !!this.signingIn, pending, error: this.error, ...(this.direct.offered ? { direct: true } : {}) };
  }

  private emit(): void { this.ctx.bus.emit('apps.updated', this.status()); }

  private setError(error: string | undefined): void {
    if (this.error === error) return;
    this.error = error;
    this.emit();
  }

  /**
   * Where the user connects apps, for the bots' and apps' wording: on an AppuBot Cloud computer it's the AppuBot app
   * on their phone or computer (this one has no window of theirs).
   */
  private get appsPage(): string {
    return this.ctx.deps.cloud ? 'AppuBot → Apps (on their phone or computer)' : 'AppuBot → Apps';
  }

  /** An app's name as the directory has it. */
  appName(slug: string): string {
    return this.bySlug.get(slug)?.name ?? slug.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /* -------------------------------------------------------------- sign-in */

  /** Where the browser comes back to after the sign-in (the gateway's loopback page). */
  private redirectUri(): string { return `http://127.0.0.1:${this.ctx.gateway.port}/apps/signed-in`; }

  /**
   * Starts Composio's sign-in. Here, it opens in this computer's browser and the gateway's `/apps/signed-in` page
   * finishes it; a device signing in itself names its own return address (its app's link, `deviceRedirect`), gets the
   * page to open there (`url`) and hands back what came back with `apps.finishSignIn`.
   */
  async signIn(deviceUri?: string): Promise<AppsStatus & { url?: string }> {
    if (deviceUri !== undefined && !isDeviceRedirect(deviceUri)) throw new RpcError('invalid_params', 'That return address isn’t an AppuBot app’s.');
    // an AppuBot Cloud computer has no browser of the user's and no loopback page they could reach: the device signing
    // in (the phone, or the desktop app with its own `appubot://` link) names its own return address, always
    if (deviceUri === undefined && this.ctx.deps.cloud) throw new RpcError('unsupported', 'Sign in to Composio from AppuBot on your phone or computer: it opens the sign-in there and hands the result to your cloud computer.');
    const redirectUri = deviceUri ?? this.redirectUri();
    const client = await this.clientFor(redirectUri, deviceUri !== undefined);
    if (this.signingIn) clearTimeout(this.signingIn.timer);
    const { verifier, challenge } = pkce();
    const state = randomBytes(16).toString('hex');
    const timer = setTimeout(() => { if (this.signingIn?.state === state) { this.signingIn = null; this.emit(); } }, SIGN_IN_TIMEOUT_MS);
    timer.unref?.();
    this.signingIn = { state, verifier, clientId: client.clientId, redirectUri, timer };
    const url = this.api.authorizeUrl({ clientId: client.clientId, redirectUri, challenge, state });
    if (deviceUri === undefined) await Promise.resolve(this.ctx.deps.openExternal(url)).catch((e: unknown) => this.ctx.log.warn('apps: could not open the sign-in page', errMsg(e)));
    this.emit();
    return deviceUri === undefined ? this.status() : { ...this.status(), url };
  }

  /** The OAuth client for `redirectUri`, registered with Composio once per return address. */
  private async clientFor(redirectUri: string, device: boolean): Promise<{ clientId: string }> {
    const f = this.file.get();
    const known = device ? f.deviceClients?.[redirectUri] : f.client?.redirectUri === redirectUri ? f.client.clientId : undefined;
    if (known) return { clientId: known };
    let clientId: string;
    try { ({ clientId } = await this.api.register(redirectUri)); }
    catch (e) { throw new RpcError('apps_unavailable', `Couldn't reach Composio: ${errMsg(e)}`); }
    // a computer's: another gateway port is another client; a device's: kept by address (a few at most)
    this.file.update((v) => device
      ? { ...v, deviceClients: Object.fromEntries([...Object.entries(v.deviceClients ?? {}), [redirectUri, clientId]].slice(-8)) }
      : { ...v, client: { clientId, redirectUri } });
    return { clientId };
  }

  /** The browser came back to the gateway's page: Composio's sign-in, or an app's own (`app`: its name, for the page). */
  async returned(q: { code?: string; state?: string; error?: string }): Promise<{ ok: boolean; app?: string }> {
    const slug = this.direct.signingIn(q.state);
    const ok = await this.finishSignIn(q);
    return { ok, ...(slug ? { app: this.appName(slug) } : {}) };
  }

  /** The browser came back to `/apps/signed-in`: trade the code for tokens. Whether the sign-in worked. */
  async finishSignIn(q: { code?: string; state?: string; error?: string }): Promise<boolean> {
    // an app's own sign-in comes back to the same page
    const own = await this.direct.finish(q);
    if (own !== undefined) return own;
    const s = this.signingIn;
    if (!s || !q.state || q.state !== s.state) return false;
    clearTimeout(s.timer);
    this.signingIn = null;
    if (q.error || !q.code) { this.emit(); return false; }
    let tokens;
    try { tokens = await this.api.exchange({ clientId: s.clientId, redirectUri: s.redirectUri, code: q.code, verifier: s.verifier }); }
    catch (e) {
      this.ctx.log.warn('apps: the Composio sign-in did not finish', errMsg(e));
      this.setError(`The Composio sign-in did not finish: ${errMsg(e)}`);
      this.emit();
      return false;
    }
    const auth: StoredComposioAuth = { clientId: s.clientId, ...tokens };
    // another account's connections are not this one's
    this.forgetConnections();
    this.file.update((f) => ({ ...f, auth, connected: [], watched: [], sweptAt: undefined }));
    this.error = undefined;
    this.signedInOrOut();
    this.ctx.s.notifications.notify({ title: 'Composio connected', body: 'Connect apps for your bots in Apps.', level: 'success', native: false });
    // apps connected before (here or in Claude.ai, Codex…) show up and reach the bots
    void this.sweep().catch((e: unknown) => this.ctx.log.warn('apps: could not look for connected apps', errMsg(e)));
    return true;
  }

  /** Forget the tokens on this computer; the connections stay in the Composio account. */
  signOut(): AppsStatus {
    if (this.signingIn) { clearTimeout(this.signingIn.timer); this.signingIn = null; }
    this.forgetConnections();
    this.file.update(({ auth: _a, connected: _c, watched: _w, sweptAt: _s, ...rest }) => rest);
    this.error = undefined;
    this.signedInOrOut();
    return this.status();
  }

  private forgetConnections(): void {
    for (const p of this.pending.values()) p.stop();
    this.pending.clear();
    this.accounts.clear();
    this.labels.clear();
    this.listedAt = 0;
    this.refreshing = null;
  }

  /** Bots learn whether they have apps (their agents restart with resume at their next turn when that changed). */
  private signedInOrOut(): void {
    for (const b of this.ctx.s.bots.list()) this.ctx.s.bots.scaffold(b, true);
    this.emit();
  }

  /** A valid access token, renewed when it is about to run out. */
  private token(force = false): Promise<string> {
    const auth = this.auth();
    if (!auth) return Promise.reject(new RpcError('apps_not_configured', NEEDS_SIGN_IN));
    if (!force && auth.expiresAt - REFRESH_EARLY_MS > Date.now()) return Promise.resolve(auth.accessToken);
    this.refreshing ??= (async () => {
      if (!auth.refreshToken) throw this.ended();
      let next;
      try { next = await this.api.refresh({ clientId: auth.clientId, refreshToken: auth.refreshToken }); }
      catch (e) {
        if (e instanceof ComposioHttpError && (e.status === 400 || e.status === 401)) throw this.ended();
        throw new RpcError('apps_unavailable', `Couldn't reach Composio: ${errMsg(e)}`);
      }
      // signed out (or in again) meanwhile: these tokens are stale
      if (this.auth()?.refreshToken !== auth.refreshToken) throw new RpcError('apps_not_configured', NEEDS_SIGN_IN);
      const renewed: StoredComposioAuth = { ...auth, ...next, refreshToken: next.refreshToken ?? auth.refreshToken, account: next.account ?? auth.account };
      this.file.update((f) => ({ ...f, auth: renewed }));
      return renewed.accessToken;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** Composio no longer takes the sign-in: signed out, with a note to sign in again. */
  private ended(): RpcError {
    this.ctx.log.warn('apps: the Composio sign-in ended');
    this.forgetConnections();
    this.file.update(({ auth: _a, ...rest }) => rest);
    this.error = SIGNED_OUT;
    this.signedInOrOut();
    return new RpcError('apps_not_configured', SIGNED_OUT);
  }

  /** One of Composio's tools; a rejected token is renewed once. */
  private async call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token(attempt > 0);
      try {
        const r = await this.api.callTool(token, name, args);
        if (this.error && this.error !== SIGNED_OUT) this.setError(undefined);
        return r;
      } catch (e) {
        if (e instanceof ComposioHttpError && e.status === 401 && attempt === 0) continue;
        if (e instanceof ComposioHttpError && e.status === 401) throw this.ended();
        if (e instanceof RpcError) throw e;
        const msg = `Couldn't reach Composio: ${errMsg(e)}`;
        this.setError(msg);
        throw new RpcError('apps_unavailable', msg);
      }
    }
  }

  /* -------------------------------------------------------------- catalog */

  catalog(p: NonNullable<MethodParams<'apps.catalog'>>): MethodResult<'apps.catalog'> {
    const { categories } = DIRECTORY;
    // an app that refused to connect here since the list was made is left out too
    const refused = this.file.get().unavailable;
    const toolkits = [...(refused ? DIRECTORY.toolkits.filter((t) => !(t.slug in refused)) : DIRECTORY.toolkits), ...this.direct.toolkits()];
    const limit = p.limit ?? 60;
    // by slug: the connected apps, which may be ones the page doesn't list (connected at Composio with the user's own setup)
    if (p.slugs?.length) return { categories, toolkits: p.slugs.flatMap((s) => this.bySlug.get(s) ?? []) };
    const q = p.search?.trim() ?? '';
    let list = p.category ? toolkits.filter((t) => t.categories.includes(p.category!)) : toolkits;
    if (q) list = localSearch(list, q);
    const offset = Math.max(0, Math.floor(Number(p.cursor) || 0));
    const end = offset + limit;
    return { categories, toolkits: list.slice(offset, end), nextCursor: end < list.length ? String(end) : undefined, total: list.length };
  }

  /* ---------------------------------------------------------- connections */

  /** The accounts of these toolkits, as Composio has them now (`list` has no side effects). */
  private async list(slugs: string[]): Promise<Map<string, AppConnection[]>> {
    const out = new Map<string, AppConnection[]>();
    const batches: string[][] = [];
    for (let i = 0; i < slugs.length; i += LIST_BATCH) batches.push(slugs.slice(i, i + LIST_BATCH));
    for (let i = 0; i < batches.length; i += LIST_PARALLEL) {
      await Promise.all(batches.slice(i, i + LIST_PARALLEL).map(async (batch) => {
        const r = await this.call('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: batch.map((name) => ({ name, action: 'list' })) });
        if (r.isError) throw new RpcError('apps_unavailable', `Composio couldn't list the connections: ${r.text.slice(0, 200)}`);
        const found = accountsIn(r.text);
        for (const s of batch) out.set(s, found.get(s) ?? []);
      }));
    }
    return out;
  }

  /** Takes in listed accounts: the Apps page's list, and which apps are connected (what the bots follow). */
  private note(listed: Map<string, AppConnection[]>): void {
    for (const [slug, accounts] of listed) {
      const shown = accounts.filter((a) => !STARTING.has(a.status)).map((a) => (a.label || !this.labels.has(a.connectedAccountId) ? a : { ...a, label: this.labels.get(a.connectedAccountId) }));
      if (shown.length) this.accounts.set(slug, shown); else this.accounts.delete(slug);
    }
    // a chosen default that is gone (removed here or at Composio) is no longer a choice
    const gone = Object.entries(this.file.get().defaults ?? {}).filter(([slug, id]) => listed.has(slug) && !this.accounts.get(slug)?.some((a) => a.connectedAccountId === id)).map(([slug]) => slug);
    if (gone.length) this.file.update((x) => ({ ...x, defaults: Object.fromEntries(Object.entries(x.defaults ?? {}).filter(([slug]) => !gone.includes(slug))) }));
    const f = this.file.get();
    const watched = [...new Set([...(f.watched ?? []).filter((s) => !listed.has(s) || this.accounts.has(s)), ...this.accounts.keys()])].sort();
    const connected = [...this.accounts].filter(([, a]) => a.some((x) => x.status === 'ACTIVE')).map(([s]) => s).sort();
    const before = f.connected ?? [];
    const merged = [...new Set([...before.filter((s) => !listed.has(s)), ...connected])].sort();
    if (!sameList(before, merged) || !sameList(f.watched ?? [], watched)) this.file.update((x) => ({ ...x, connected: merged, watched }));
    if (!sameList(before, merged)) this.emit();
  }

  /** The apps seen before (and those signing in) again. */
  private refresh(): Promise<void> {
    this.listJob ??= (async () => {
      const f = this.file.get();
      const slugs = [...new Set([...(f.watched ?? []), ...(f.connected ?? []), ...this.pending.keys()])];
      if (slugs.length) this.note(await this.list(slugs));
      this.listedAt = Date.now();
    })().finally(() => { this.listJob = null; });
    return this.listJob;
  }

  /** The accounts listed at least once since launch (`warm` starts it; whoever needs them first waits for it). */
  private async listedOnce(): Promise<void> {
    if (!this.auth() || this.listedAt) return;
    await this.refresh().catch((e: unknown) => this.ctx.log.warn('apps: could not check the connections', errMsg(e)));
  }

  /** `refresh` while the Apps page shows what was listed before: `apps.updated` brings it the new list if anything changed. */
  private async refreshBehind(): Promise<void> {
    const before = JSON.stringify([...this.accounts]);
    try {
      await this.refresh();
      if (JSON.stringify([...this.accounts]) !== before) this.emit();
    } catch (e) {
      this.ctx.log.warn('apps: could not check the connections', errMsg(e));
    }
  }

  /** Every app in the directory: finds the ones connected elsewhere (at sign-in, then once a day). */
  private sweep(): Promise<void> {
    this.sweepJob ??= (async () => {
      // the unlisted ones too: someone may have connected one at Composio with a setup of their own
      const slugs = [...this.bySlug.keys()];
      for (let i = 0; i < slugs.length; i += LIST_BATCH * LIST_PARALLEL) {
        if (!this.auth()) return;
        this.note(await this.list(slugs.slice(i, i + LIST_BATCH * LIST_PARALLEL)));
      }
      this.listedAt = Date.now();
      this.file.update((f) => ({ ...f, sweptAt: Date.now() }));
    })().finally(() => { this.sweepJob = null; });
    return this.sweepJob;
  }

  private sweepIfDue(every = SWEEP_EVERY_MS): void {
    const at = this.file.get().sweptAt ?? 0;
    if (this.auth() && Date.now() - at > every) void this.sweep().catch((e: unknown) => this.ctx.log.warn('apps: could not look for connected apps', errMsg(e)));
  }

  async connections(): Promise<AppConnection[]> {
    const own = this.direct.connections();
    if (!this.auth()) {
      // signed out of Composio, the apps on their own servers are still there
      if (this.direct.offered) return own;
      throw new RpcError('apps_not_configured', NEEDS_SIGN_IN);
    }
    // listed before (at launch, `warm`): answered at once, and looked at again behind the answer when it's old
    if (!this.listedAt) await this.refresh();
    else if (Date.now() - this.listedAt > LISTED_TTL_MS) void this.refreshBehind();
    // someone is looking at their apps: one connected on another computer (or at Composio) should turn up soon
    this.sweepIfDue(SWEEP_ON_VIEW_MS);
    return [...[...this.accounts].flatMap(([slug, accounts]) => {
      const first = this.defaultOf(slug);
      // `isDefault` as the clients read it: AppuBot's default, not Composio's
      return accounts.map(({ isDefault: _theirs, ...a }) => (a.connectedAccountId === first?.connectedAccountId ? { ...a, isDefault: true } : a));
    }), ...own];
  }

  /** The account an app's calls use when the bot names none (see `defaultAccount`). */
  private defaultOf(slug: string): AppConnection | undefined {
    return defaultAccount(this.accounts.get(slug), this.file.get().defaults?.[slug]);
  }

  /** The user picks which of an app's accounts the bots use when they name none. */
  async setDefault(connectedAccountId: string, slug: string): Promise<{ ok: true }> {
    const working = (list: AppConnection[] | undefined) => workingAccounts(list).some((a) => a.connectedAccountId === connectedAccountId);
    // one connected a moment ago, or on another computer, may not be listed here yet
    if (!working(this.accounts.get(slug)) && !this.direct.has(slug)) this.note(await this.list([slug]));
    if (!working(this.accounts.get(slug))) throw notFound('Connection', connectedAccountId);
    this.file.update((f) => ({ ...f, defaults: { ...f.defaults, [slug]: connectedAccountId } }));
    this.emit();
    return { ok: true };
  }

  /**
   * Start connecting an app: Composio's link page in the browser; the gateway watches the account and reports the
   * outcome. `onCaller` (a phone, or any device of a cloud computer's) opens nothing here and leaves `redirectUrl` to
   * the device that asked.
   */
  async connect(slug: string, onCaller = false): Promise<MethodResult<'apps.connect'>> {
    if (this.direct.has(slug)) return this.direct.connect(slug, onCaller);
    // an AppuBot Cloud computer's browser is on a desktop the user isn't looking at: the device that asked opens the
    // page, always
    if (this.ctx.deps.cloud) onCaller = true;
    const name = this.appName(slug);
    if (this.bySlug.get(slug)?.authKind === 'none') return {};
    const known = this.unavailable(slug);
    if (known) throw new RpcError('unsupported', cantConnectText(name, known));
    // a second click starts the sign-in over
    this.pending.get(slug)?.stop();
    // the accounts it has, even right after launch, before `warm` has listed them
    await this.listedOnce();
    // another account of an app that works (a second Gmail): Composio answers a plain `add` for it with the app's status
    // and no link, so the new account is asked for under a name of its own
    const alias = workingAccounts(this.accounts.get(slug)).length || this.file.get().connected?.includes(slug) ? this.newAlias(slug) : undefined;
    const r = await this.call('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: [{ name: slug, action: 'add', ...(alias ? { alias } : {}) }] });
    const whole = parseJson(r.text);
    const res = (whole?.data as { results?: Record<string, { status?: unknown; redirect_url?: unknown; accounts?: { id?: unknown; status?: unknown }[]; error?: unknown; error_message?: unknown }> } | undefined)?.results?.[slug];
    const redirectUrl = typeof res?.redirect_url === 'string' ? res.redirect_url : undefined;
    const account = res?.accounts?.filter((a) => typeof a.id === 'string' && STARTING.has(String(a.status).toUpperCase())).at(-1);
    if (r.isError || !redirectUrl || !account) {
      // Composio says why in `error_message` (older answers: `error`); the words are the toast's body under "Couldn't connect X"
      const said = [res?.error_message, res?.error, whole?.error].find((x): x is string => typeof x === 'string' && !!x) ?? '';
      const why = unavailableReason(said);
      if (why) {
        // it can never connect here: off the Apps page from now on
        this.file.update((f) => ({ ...f, unavailable: { ...f.unavailable, [slug]: why } }));
        this.emit();
        throw new RpcError('unsupported', cantConnectText(name, why));
      }
      if (!r.isError && !redirectUrl && String(res?.status ?? '').toLowerCase() === 'active') {
        // asked for another account and given the one there is: said, rather than nothing happening
        if (alias) throw new RpcError('apps_unavailable', `Composio didn't open a sign-in for another ${name} account. Try again in a moment.`);
        // connected already (somewhere else): nothing to sign in to, and it shows as connected
        await this.refreshSlugs([slug]);
        this.emit();
        return {};
      }
      throw new RpcError('apps_unavailable', plainReason(said) || `Composio didn't start ${name}'s sign-in. Try again in a moment.`);
    }
    // another account of an app that has one: the one in use stays the default until the user picks the new one
    const listed = accountsIn(r.text).get(slug);
    const inUse = defaultAccount(workingAccounts(listed).length ? listed : this.accounts.get(slug), this.file.get().defaults?.[slug]);
    if (inUse && this.file.get().defaults?.[slug] !== inUse.connectedAccountId) this.file.update((f) => ({ ...f, defaults: { ...f.defaults, [slug]: inUse.connectedAccountId } }));
    this.watch(slug, name, account.id as string, redirectUrl, onCaller);
    return { redirectUrl };
  }

  /**
   * Open the link page in the user's browser (where they are usually signed in to Google and the rest already) and
   * wait in the background for the account to turn ACTIVE, fail, or be abandoned (the link expires in 10 minutes).
   */
  private watch(slug: string, name: string, accountId: string, redirectUrl: string, onCaller = false): void {
    let stopped = false;
    this.pending.set(slug, { accountId, stop: () => { stopped = true; } });
    this.emit();
    if (!onCaller) void Promise.resolve(this.ctx.deps.openExternal(redirectUrl)).catch((e: unknown) => this.ctx.log.warn('apps: could not open the sign-in page', errMsg(e)));
    void (async () => {
      const started = Date.now();
      let outcome: 'active' | 'failed' | 'abandoned' = 'abandoned';
      let last: string | undefined;
      for (let delay = 1500; !stopped; delay = Math.min(4000, Math.round(delay * 1.25))) {
        await sleep(delay);
        if (stopped) break;
        try {
          const listed = await this.list([slug]);
          const a = listed.get(slug)?.find((x) => x.connectedAccountId === accountId);
          last = a?.status;
          if (a?.status === 'ACTIVE') { this.note(listed); outcome = 'active'; break; }
          if (a && FAILED.has(a.status)) { outcome = 'failed'; break; }
        } catch (e) {
          if (e instanceof RpcError && e.code === 'apps_not_configured') break;
          // offline for a moment: keep watching
        }
        if (Date.now() - started > CONNECT_TIMEOUT_MS) break;
      }
      if (this.pending.get(slug)?.accountId === accountId) this.pending.delete(slug);
      // a sign-in nobody finished leaves nothing behind in the user's Composio account
      if (outcome !== 'active' && (!last || STARTING.has(last))) void this.remove(slug, accountId).catch(() => undefined);
      // stopped: replaced by a newer sign-in or signed out, and whoever stopped it reports the state
      if (stopped) return;
      // back from the browser to AppuBot, where the app now shows as added
      if (outcome === 'active') { if (!onCaller) this.ctx.deps.showApp?.(); this.connected(slug, name, accountId); return; }
      if (outcome === 'failed') this.ctx.s.notifications.notify({ title: `${name} isn't connected`, body: 'The sign-in did not finish.', level: 'warning' });
      // nobody finished the page within its ten minutes: said quietly, in the app only
      else this.ctx.s.notifications.notify({ title: `${name} wasn't connected`, body: 'The sign-in page was left unfinished. Add it again to try once more.', level: 'info', native: false });
      this.emit();
    })();
  }

  /** A name for an app's next account, one none of its accounts has: `gmail-2`, `gmail-3`… */
  private newAlias(slug: string): string {
    const taken = new Set((this.accounts.get(slug) ?? []).map((a) => a.alias?.toLowerCase()));
    let n = (this.accounts.get(slug)?.length ?? 1) + 1;
    while (taken.has(`${slug}-${n}`)) n++;
    return `${slug}-${n}`;
  }

  private remove(slug: string, accountId: string): Promise<{ text: string; isError: boolean }> {
    return this.call('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: [{ name: slug, action: 'remove', account_id: accountId }] });
  }

  private connected(slug: string, name: string, accountId: string): void {
    const working = workingAccounts(this.accounts.get(slug));
    const kept = this.defaultOf(slug);
    if (working.length > 1 && kept && kept.connectedAccountId !== accountId) {
      // nothing is swapped: the account the bots were using is still the one they use
      this.ctx.s.notifications.notify({ title: `Another ${name} account connected`, body: `Your bots keep using ${accountNames(working).get(kept.connectedAccountId)} unless they are told to use the new one. Change the default in Apps.`, level: 'success', native: false });
    } else this.ctx.s.notifications.notify({ title: `${name} connected`, body: 'Your bots can use it now.', level: 'success', native: false });
    this.emit();
    // older broken or unfinished accounts of the same app only clutter the list
    void this.list([slug])
      .then(async (listed) => {
        const stale = (listed.get(slug) ?? []).filter((a) => a.connectedAccountId !== accountId && a.status !== 'ACTIVE');
        for (const a of stale) await this.remove(slug, a.connectedAccountId);
        this.note(stale.length ? await this.list([slug]) : listed);
      })
      .catch(() => undefined);
  }

  async disconnect(connectedAccountId: string, slug: string): Promise<{ ok: true }> {
    if (this.direct.has(slug)) { this.direct.disconnect(slug); return { ok: true }; }
    const listed = await this.list([slug]);
    if (!listed.get(slug)?.some((a) => a.connectedAccountId === connectedAccountId)) throw notFound('Connection', connectedAccountId);
    const r = await this.remove(slug, connectedAccountId);
    if (r.isError) throw new RpcError('apps_unavailable', `Couldn't disconnect ${this.appName(slug)}`);
    this.note(await this.list([slug]));
    this.emit();
    return { ok: true };
  }

  /* -------------------------------------------------------- the bots' calls */

  /**
   * A bot asks the user for an app on a card in its chat (`apps_request`): the card's buttons sign in to Composio,
   * connect the app (`apps.connect`, the browser) or turn it on for the bot (`bots.update`), and the card settles by
   * itself once the app is connected and on (`apps.updated` / `bot.updated`). Nothing is submitted but a decline;
   * an app from before, which shows the card as an empty form, is told where to connect it.
   */
  async request(a: AgentContext, p: MethodParams<'agent.apps.request'>): Promise<MethodResult<'agent.apps.request'>> {
    const bot = this.ctx.s.bots.require(a.botId);
    let slug = p.slug.trim().toLowerCase();
    // one Composio can't connect whose maker runs a server of its own: that one, which can
    if (!this.direct.has(slug) && this.unavailable(slug) && !this.connectedSlugs().includes(slug)) slug = this.direct.insteadOf(slug) ?? slug;
    const toolkit = this.bySlug.get(slug);
    if (!toolkit && !this.connectedSlugs().includes(slug)) throw new RpcError('not_found', `No app called “${p.slug}”. Use the slug apps_search names (gmail, slack, googlecalendar…).`);
    const name = this.appName(slug);
    // one that can't be connected here: no card that could never be finished
    const gone = this.unavailable(slug);
    if (gone && !this.connectedSlugs().includes(slug)) throw new RpcError('unsupported', `${cantConnectText(name, gone)} Tell the user so, and do the task another way if you can.`);
    const live = () => ({ signedIn: !!this.auth() || this.direct.has(slug), connected: this.usableSlugs().includes(slug), on: appOn(this.ctx.s.bots.get(bot.id) ?? bot, slug) });
    const hadApps = this.botApps(bot).length > 0;
    // `on` only means something once connected (a bot has every connected app on unless it turned it off)
    const done = (connected: boolean, on: boolean): MethodResult<'agent.apps.request'> => ({
      slug, name, connected, on: connected && on,
      ...(connected && on ? { note: hadApps ? `${name}'s tools are yours now: find them with apps_search.` : `Your apps_ tools (apps_search, apps_tool_schemas, apps_execute) arrive at the start of your next turn: tell the user ${name} is connected and what you'll do with it when they write next.` } : {}),
    });
    const now = appCardState(live());
    if (now === 'ready') return done(true, true);
    const form: QuestionForm = {
      kind: 'app', fields: [],
      app: { slug, name, ...(toolkit?.logo ? { logo: toolkit.logo } : {}), ...(p.reason?.trim() ? { reason: p.reason.trim() } : {}), state: now },
    };
    const question = `${bot.name} needs ${name}${now === 'turn-on' ? ` (connected, turned off for ${bot.name})` : ''}`;
    let questionId: string | undefined;
    const check = () => {
      if (!questionId || !this.ctx.s.agentBridge.isOpen(questionId)) return;
      const l = live();
      if (l.connected && l.on) this.ctx.s.agentBridge.settle(questionId, { answer: `Connected ${name}`, values: { connected: 'yes' } });
    };
    const offApps = this.ctx.bus.on((e) => { if (e.event === 'apps.updated' || e.event === 'bot.updated') check(); });
    try {
      const o = await this.ctx.s.agentBridge.open(a, { question, options: [], form }, p.timeoutSec ?? 900, {
        onOpen: (id) => { questionId = id; check(); },
        onSubmit: () => {
          const l = live();
          if (l.connected && l.on) return { answer: `Connected ${name}`, values: { connected: 'yes' } };
          throw new RpcError('invalid_params', `Connect ${name} in ${this.appsPage}${l.connected ? ` and turn it on for ${bot.name}` : ''}; this card does it by itself in the latest AppuBot.`);
        },
      });
      const l = live();
      if (!o) return done(l.connected, l.on);
      if (o.declined) return { ...done(l.connected, l.on), declined: true };
      if (!o.values && o.answer && !(l.connected && l.on)) return { ...done(l.connected, l.on), answer: o.answer };
      return done(l.connected, l.on);
    } finally { offApps(); }
  }

  /** The apps connected in the user's account, as last seen (what the bots follow). */
  connectedSlugs(): string[] {
    return [...(this.auth() ? this.file.get().connected ?? [] : []), ...this.direct.connectedSlugs()];
  }

  /** Why an app can't be connected here, if it can't: the shipped list, or Composio's refusal on this computer. */
  private unavailable(slug: string): UnavailableReason | undefined {
    return DIRECTORY.unavailable[slug] ?? this.file.get().unavailable?.[slug];
  }

  /** Apps that need no sign-in: usable as they are once Composio is signed in. */
  readySlugs(): string[] {
    if (!this.auth()) return [];
    const refused = this.file.get().unavailable;
    return refused ? this.noSignIn.filter((s) => !(s in refused)) : this.noSignIn;
  }

  /** Every app a bot could use: the connected ones and the ones that need no sign-in. */
  private usableSlugs(): string[] {
    return [...new Set([...this.connectedSlugs(), ...this.readySlugs()])];
  }

  /** The apps this bot may use: the connected ones and the ones that need no sign-in, less what is turned off for it. */
  botApps(bot: Pick<Bot, 'appsOff'>): string[] {
    return appsOn(bot, this.usableSlugs());
  }

  private allowedFor(botId: string): string[] {
    const apps = this.botApps(this.ctx.s.bots.require(botId));
    if (!this.auth() && !apps.length) throw new RpcError('apps_not_configured', `Apps aren't set up: ask the user to sign in to Composio in ${this.appsPage}.`);
    if (!apps.length) throw new RpcError('forbidden', `You have no apps: ask the user to connect one in ${this.appsPage}, or to turn one on for you there.`);
    return apps;
  }

  private toolkitOf(tool: string): string | undefined {
    return this.direct.appOfTool(tool) ?? this.toolkits.get(tool.toUpperCase()) ?? toolkitOfTool(tool, [...this.bySlug.keys(), ...this.connectedSlugs()]);
  }

  private refused(slug: string | undefined, tool: string): string {
    return slug
      ? `${tool} is a ${this.appName(slug)} tool, and ${this.appName(slug)} isn't one of your apps: ask the user to connect it in ${this.appsPage}, or to turn it on for you there.`
      : `${tool} isn't a tool of your apps.`;
  }

  /** Find tools for tasks, only among this bot's apps. */
  async search(botId: string, queries: MethodParams<'agent.apps.search'>['queries']): Promise<{ text: string }> {
    const apps = this.allowedFor(botId);
    if (queries.length > SEARCH_QUERIES_MAX) throw new RpcError('invalid_params', `At most ${SEARCH_QUERIES_MAX} tasks in one search: split them over two calls.`);
    const own = apps.filter((s) => this.direct.has(s));
    // the bot is told an app's accounts, which are listed once after launch
    await this.listedOnce();
    const parts = [this.yourApps(apps)];
    // Composio is asked only for the apps that are its own
    if (this.auth() && own.length < apps.length) {
      const r = await this.call('COMPOSIO_SEARCH_TOOLS', { queries });
      const data = parseJson(r.text)?.data as SearchData | undefined;
      if (r.isError || !data) parts.push(ourToolNames(r.text));
      else {
        this.learn(data);
        parts.push(ourToolNames(JSON.stringify(this.filterSearch(data, new Set(apps)))));
      }
    }
    if (own.length) parts.push(JSON.stringify({ own_server_apps: await this.direct.search(own, queries) }));
    return { text: parts.join('\n\n') };
  }

  private yourApps(apps: string[]): string {
    const named = (list: string[]) => list.map((s) => `${this.appName(s)} (${s})`).join(', ');
    const connected = new Set(this.connectedSlugs());
    const mine = apps.filter((s) => connected.has(s));
    // the ones that need no sign-in are many: a few by name, the rest found by searching
    const ready = apps.filter((s) => !connected.has(s));
    const also = ready.length ? ` No sign-in needed, also yours: ${named(ready.slice(0, 6))}${ready.length > 6 ? ` and ${ready.length - 6} more` : ''}.` : '';
    const several = mine.filter((s) => this.several(s)).map((s) => `${this.accountsOf(s)}.`);
    const accounts = several.length ? ` ${several.join(' ')} A tool runs on the default account unless you name another in its \`account\` (apps_execute): name it whenever the user says which account, and ask when sending or changing something and it isn't clear which they mean.` : '';
    return `Your apps: ${mine.length ? named(mine) : 'none connected'}.${also}${accounts} Run tools with apps_execute; read a tool's inputs with apps_tool_schemas when they aren't below. Only these apps' tools work for you.`;
  }

  /** Whether an app has several working accounts: only then does AppuBot name the account on its calls. */
  private several(slug: string): boolean {
    return workingAccounts(this.accounts.get(slug)).length > 1;
  }

  /** An app's accounts in words for a bot. */
  private accountsOf(slug: string): string {
    return accountsText(this.appName(slug), this.accounts.get(slug) ?? [], this.file.get().defaults?.[slug]);
  }

  /**
   * A bot's call with its account named, for an app with several: the one it asked for, or the user's default. An app
   * with one account goes through as the bot wrote it.
   */
  private withAccount<T extends { tool_slug: string; account?: string }>(t: T): T {
    const slug = this.toolkitOf(t.tool_slug);
    if (!slug || !this.several(slug)) return t;
    const working = workingAccounts(this.accounts.get(slug));
    const account = t.account?.trim() ? pickAccount(working, t.account) : this.defaultOf(slug);
    if (!account) throw new RpcError('invalid_params', `${this.appName(slug)} has no account “${t.account}”. ${this.accountsOf(slug)}. Write one of them in \`account\` as it is written here.`);
    return { ...t, account: account.connectedAccountId };
  }

  /** What search says about tools (their toolkit) and connections (an app connected or gone meanwhile). */
  private learn(data: SearchData): void {
    for (const [tool, s] of Object.entries(data.tool_schemas ?? {})) {
      if (typeof s?.toolkit === 'string') this.toolkits.set(tool.toUpperCase(), s.toolkit.toLowerCase());
    }
    // an app that needs no sign-in always reads as connected there
    const connected = this.usableSlugs();
    let learned = false;
    const changed = (data.toolkit_connection_statuses ?? []).some((c) => {
      if (typeof c.toolkit !== 'string') return false;
      const theirs = Array.isArray(c.accounts) ? (c.accounts as { id?: unknown; status?: unknown; user_info?: unknown }[]).filter((a) => typeof a?.id === 'string') : undefined;
      // who an account is, when search knows and the list didn't say
      for (const a of theirs ?? []) {
        const label = accountLabel(a.user_info);
        if (label && this.labels.get(a.id as string) !== label) { this.labels.set(a.id as string, label); learned = true; }
      }
      // an account connected or removed elsewhere since the last look (only where search says each one's state)
      const working = theirs?.every((a) => typeof a.status === 'string') ? theirs.filter((a) => String(a.status).toUpperCase() === 'ACTIVE').map((a) => a.id as string).sort() : undefined;
      const ours = workingAccounts(this.accounts.get(c.toolkit)).map((a) => a.connectedAccountId).sort();
      return !!c.has_active_connection !== connected.includes(c.toolkit) || (!!working && !this.direct.has(c.toolkit) && !sameList(working, ours));
    });
    if (learned) for (const [slug, list] of this.accounts) this.accounts.set(slug, list.map((a) => (a.label || !this.labels.has(a.connectedAccountId) ? a : { ...a, label: this.labels.get(a.connectedAccountId) })));
    if (changed) void this.refreshSlugs((data.toolkit_connection_statuses ?? []).map((c) => c.toolkit).filter((s): s is string => typeof s === 'string'));
  }

  private async refreshSlugs(slugs: string[]): Promise<void> {
    try { this.note(await this.list(slugs)); } catch (e) { this.ctx.log.warn('apps: could not check the connections', errMsg(e)); }
  }

  /** A search answer with only this bot's apps' tools, and statuses that point at AppuBot rather than Composio's tools. */
  filterSearch(data: SearchData, apps: Set<string>): SearchData {
    const ok = (tool: unknown) => typeof tool === 'string' && apps.has(this.toolkitOf(tool) ?? '');
    // plans written for Composio's own workbench (code the bot can't run) go; so do steps that send it there
    const ours = (x: unknown) => (Array.isArray(x) ? x.filter((line) => typeof line !== 'string' || !NOT_OURS.test(line)) : x);
    const results = (data.results ?? []).map(({ reference_workbench_snippets: _snippets, ...r }) => ({
      ...r,
      ...('recommended_plan_steps' in r ? { recommended_plan_steps: ours(r.recommended_plan_steps) } : {}),
      ...('known_pitfalls' in r ? { known_pitfalls: ours(r.known_pitfalls) } : {}),
      primary_tool_slugs: r.primary_tool_slugs?.filter(ok),
      related_tool_slugs: r.related_tool_slugs?.filter(ok),
      toolkits: r.toolkits?.filter((t) => apps.has(t)),
    }));
    const tool_schemas = Object.fromEntries(Object.entries(data.tool_schemas ?? {}).filter(([tool]) => ok(tool)));
    const toolkit_connection_statuses = (data.toolkit_connection_statuses ?? []).map((c) => {
      const slug = String(c.toolkit ?? '');
      const name = this.appName(slug);
      if (!apps.has(slug)) return { toolkit: slug, has_active_connection: false, status_message: `${name} isn't one of your apps: ask the user to connect it in ${this.appsPage}, or to turn it on for you there if it is connected.` };
      // several accounts: as AppuBot names them and with its default, which is not always Composio's
      if (c.has_active_connection && this.several(slug)) {
        const { accounts: _accounts, account_selection: _selection, ...rest } = c;
        const working = workingAccounts(this.accounts.get(slug));
        const names = accountNames(working);
        const first = this.defaultOf(slug);
        return { ...rest, accounts: working.map((a) => ({ account: names.get(a.connectedAccountId), ...(a === first ? { default: true } : {}) })), status_message: `${this.accountsOf(slug)}.` };
      }
      return { ...c, status_message: c.has_active_connection ? `${name} is connected.` : `${name} isn't connected right now: ask the user to reconnect it in ${this.appsPage}.` };
    });
    // its session id is for Composio's own tools (the apps tools don't take one); next steps that send the bot to
    // tools it doesn't have go
    const { session: _session, ...rest } = data;
    const next_steps_guidance = Array.isArray(data.next_steps_guidance)
      ? data.next_steps_guidance.filter((x) => typeof x !== 'string' || !NOT_OURS.test(x))
      : data.next_steps_guidance;
    return { ...rest, results, tool_schemas, toolkit_connection_statuses, next_steps_guidance };
  }

  /** Input schemas of tools, only this bot's apps' ones. */
  async schemas(botId: string, toolSlugs: string[]): Promise<{ text: string }> {
    const apps = new Set(this.allowedFor(botId));
    const mine = toolSlugs.filter((t) => apps.has(this.toolkitOf(t) ?? ''));
    const notes = toolSlugs.filter((t) => !mine.includes(t)).map((t) => this.refused(this.toolkitOf(t), t));
    if (!mine.length) throw new RpcError('forbidden', notes.join('\n'));
    const own = mine.filter((t) => this.direct.appOfTool(t));
    const theirs = mine.filter((t) => !this.direct.appOfTool(t));
    const parts = [...notes];
    if (theirs.length) parts.push(ourToolNames((await this.call('COMPOSIO_GET_TOOL_SCHEMAS', { tool_slugs: theirs })).text));
    if (own.length) parts.push(JSON.stringify(await this.direct.schemas(own)));
    return { text: parts.join('\n\n') };
  }

  /** Run tools (up to 50, in parallel), each of one of this bot's apps. */
  async execute(botId: string, p: MethodParams<'agent.apps.execute'>): Promise<{ text: string; isError: boolean }> {
    const apps = new Set(this.allowedFor(botId));
    const bad = p.tools.find((t) => !apps.has(this.toolkitOf(t.tool_slug) ?? ''));
    if (bad) throw new RpcError('forbidden', this.refused(this.toolkitOf(bad.tool_slug), bad.tool_slug));
    const own = p.tools.filter((t) => this.direct.appOfTool(t.tool_slug));
    // right after launch the accounts may not be listed yet: a call then would name none, and Composio would pick
    if (own.length < p.tools.length) await this.listedOnce();
    const theirs = p.tools.filter((t) => !this.direct.appOfTool(t.tool_slug)).map((t) => this.withAccount(t));
    const viaComposio = async (): Promise<{ text: string; isError: boolean }> => {
      // no workbench: its sandbox runs any app's tools, past this bot's apps
      const r = await this.call('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: theirs, ...(p.thought ? { thought: p.thought } : {}), sync_response_to_workbench: false });
      const text = await this.withWholeAnswer(botId, theirs.length === 1 ? theirs[0]!.tool_slug : 'answer', r.text);
      return { ...r, text: ourToolNames(text) + (NEEDS_ACCOUNT.test(r.text) ? await this.accountsNote(theirs.map((t) => this.toolkitOf(t.tool_slug)).filter((s): s is string => !!s)) : '') };
    };
    if (!own.length) return viaComposio();
    if (!theirs.length) return this.direct.execute(botId, own);
    const [a, b] = await Promise.all([viaComposio(), this.direct.execute(botId, own)]);
    return { text: `${a.text}\n\n${b.text}`, isError: a.isError && b.isError };
  }

  /**
   * Composio wouldn't run a tool because its app has several accounts and the call named none: one was connected
   * elsewhere since AppuBot last looked. It looks again and tells the bot the accounts; the next call names the default
   * itself.
   */
  private async accountsNote(slugs: string[]): Promise<string> {
    await this.refreshSlugs([...new Set(slugs)]);
    const several = [...new Set(slugs)].filter((s) => this.several(s)).map((s) => `${this.accountsOf(s)}.`);
    return several.length ? `\n\n${several.join(' ')} Run it again: it goes to the default account unless you name another in \`account\`.` : '';
  }

  /**
   * An answer too large for Composio to return comes as a preview, with the whole of it in a file in Composio's
   * sandbox and a note to read it there with the workbench, which a bot doesn't have. AppuBot fetches that file
   * itself and puts it in the bot's folder, so the bot reads it with its own tools; the answer then names that path.
   */
  private async withWholeAnswer(botId: string, label: string, text: string): Promise<string> {
    const whole = parseJson(text);
    const data = whole?.data as ({ remote_file_info?: { file_path?: unknown }; next_steps?: unknown; results?: unknown } & Record<string, unknown>) | undefined;
    const remote = data?.remote_file_info;
    if (!whole || !data || !remote) return text;
    const { remote_file_info: _info, next_steps: _next, ...rest } = data;
    // each result's own note sends the bot to the remote file too
    const results = Array.isArray(data.results)
      ? data.results.map((r: unknown) => { if (!r || typeof r !== 'object') return r; const { instruction: _i, ...kept } = r as Record<string, unknown>; return kept; })
      : data.results;
    let full: Record<string, unknown>;
    try {
      const saved = await this.bringBack(botId, label, String(remote.file_path ?? ''));
      full = {
        path: saved.path, bytes: saved.bytes,
        note: 'The whole answer was too large to return here, so AppuBot saved all of it as a JSON file at `path`. What is above is only a preview: `structure_info` is the shape of each result and `data_preview` a few samples, cut short. In the file every tool\'s full result is under results[n].response.data. Read what you need from it with your own tools (jq, a short script, or reading it in parts); never print it whole.',
      };
    } catch (e) {
      this.ctx.log.warn('apps: could not fetch a large answer', errMsg(e));
      full = { note: `The whole answer was too large to return here and AppuBot couldn't fetch it (${errMsg(e)}). What is above is only a preview, cut short. Ask again for less: fewer items, only the fields you need, or one item at a time.` };
    }
    return JSON.stringify({ ...whole, data: { ...rest, results, full_answer: full } });
  }

  /** Fetches a file out of Composio's sandbox into the bot's folder: one upload there (to a link), one download here. */
  private async bringBack(botId: string, label: string, remotePath: string): Promise<{ path: string; bytes: number }> {
    if (!REMOTE_PATH.test(remotePath) || remotePath.includes('..')) throw new Error('Composio named no file');
    // our own fixed code: nothing of the bot's runs there
    const up = await this.call('COMPOSIO_REMOTE_WORKBENCH', { code_to_execute: fileLinkCode(remotePath) });
    const { url, error } = fileLinkIn(up.text);
    if (!url) throw new Error(error);
    const res = await (this.ctx.deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(ANSWER_FETCH_MS) });
    if (!res.ok) throw new Error(`the download answered ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > ANSWER_MAX_BYTES) throw new Error('it is too large to keep');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > ANSWER_MAX_BYTES) throw new Error('it is too large to keep');
    const dir = join(this.ctx.s.bots.require(botId).workspace, ANSWERS_DIR);
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const name = `${label.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 60) || 'answer'}-${stamp}-${randomBytes(2).toString('hex')}.json`;
    const path = join(dir, name);
    writeFileSync(path, bytes);
    this.prune(dir);
    return { path, bytes: bytes.length };
  }

  /** Keeps a bot's newest large answers; the older ones go. */
  private prune(dir: string): void {
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at);
      for (const { f } of files.slice(ANSWERS_KEPT)) rmSync(join(dir, f), { force: true });
    } catch { /* nothing to tidy */ }
  }

  /* ------------------------------------------------------------ lifecycle */

  /** At launch: the connections seen before, and a look through the directory once a day. */
  warm(): Promise<void> {
    if (!this.auth()) return Promise.resolve();
    this.sweepIfDue();
    return this.refresh().catch((e: unknown) => this.ctx.log.warn('apps: could not check the connections', errMsg(e)));
  }

  shutdown(): void {
    for (const p of this.pending.values()) p.stop();
    this.pending.clear();
    if (this.signingIn) { clearTimeout(this.signingIn.timer); this.signingIn = null; }
    this.direct.shutdown();
    if (this.file !== this.ctx.store.apps) this.file.flush();
  }
}

/** The parts of `COMPOSIO_SEARCH_TOOLS`'s `data` the filter looks at (the rest passes through). */
export interface SearchData {
  results?: ({ primary_tool_slugs?: string[]; related_tool_slugs?: string[]; toolkits?: string[] } & Record<string, unknown>)[];
  toolkit_connection_statuses?: ({ toolkit?: string; has_active_connection?: boolean; status_message?: string } & Record<string, unknown>)[];
  tool_schemas?: Record<string, { toolkit?: string } & Record<string, unknown>>;
  [k: string]: unknown;
}
