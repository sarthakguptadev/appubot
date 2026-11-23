/**
 * Apps on their own servers: the ones Composio has no sign-in for (or doesn't list at all) whose makers run an MCP
 * server of their own. The person signs in to the app itself, with their own account, in the browser (the standard
 * MCP sign-in, `mcpRemote.ts`); AppuBot keeps the tokens in apps.json and runs the app's tools for the bots through
 * the same three apps tools (`apps_search`, `apps_tool_schemas`, `apps_execute`), so a bot never sees a token and
 * needs nothing new. No Composio sign-in is needed for them.
 *
 * Their slugs end in `_direct` (protocol `isDirectApp`), their tools are `<SLUG>__<the server's tool name>`.
 * The list is ours: each address was checked against the live server (it answers, and says where to sign in).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIRECT_APP_SUFFIX, type AppConnection, type AppToolkit, type MethodParams } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import type { JsonFile, StoredApps, StoredDirectApp } from '../store';
import { errMsg, RpcError } from '../util';
import { pkce } from './composioConnect';
import { RemoteHttpError, remoteMcp, type RemoteMcp, type RemoteSignIn, type RemoteTool } from './mcpRemote';

export interface DirectAppDef {
  slug: string;
  name: string;
  /** the app's own MCP server */
  url: string;
  /** `none`: it answers anyone (public documentation and the like) */
  auth: 'oauth' | 'none';
  description: string;
  categories: string[];
  /** the name its logo goes by */
  logo: string;
  /** the Composio app it stands in for (one Composio can't connect), so a bot asking for that one gets this one */
  insteadOf?: string;
}

const app = (id: string, name: string, url: string, description: string, categories: string[], more: Partial<DirectAppDef> = {}): DirectAppDef =>
  ({ slug: `${id}${DIRECT_APP_SUFFIX}`, name, url, auth: 'oauth', description, categories, logo: id, ...more });

export const DIRECT_APPS: readonly DirectAppDef[] = [
  app('paypal', 'PayPal', 'https://mcp.paypal.com/mcp', 'Invoices, orders, payments, refunds and disputes in your PayPal account.', ['payment-processing'], { insteadOf: 'paypal' }),
  app('wordpress', 'WordPress.com', 'https://public-api.wordpress.com/wpcom/v2/mcp/v1', 'Posts, pages, comments and stats of your WordPress.com sites.', ['content-&-files', 'website-&-app-building'], { insteadOf: 'wordpress_com', logo: 'wordpress_com' }),
  app('helpscout', 'Help Scout', 'https://mcp.helpscout.net/mcp', 'Conversations, customers and help articles in your Help Scout inbox.', ['customer-support', 'communication'], { insteadOf: 'help_scout', logo: 'help_scout' }),
  app('zapier', 'Zapier', 'https://mcp.zapier.com/api/mcp/mcp', 'The actions you have set up in Zapier, across the apps Zapier connects.', ['productivity']),
  app('krisp', 'Krisp', 'https://mcp.krisp.ai/mcp', 'Your meetings in Krisp: notes, transcripts and action items.', ['transcription']),
  app('fastmail', 'Fastmail', 'https://api.fastmail.com/mcp', 'Mail, calendars and contacts in your Fastmail account.', ['email']),
  app('axiom', 'Axiom', 'https://mcp.axiom.co/mcp', 'Logs, traces and queries over your Axiom datasets.', ['server-monitoring', 'developer-tools']),
  app('upstash', 'Upstash', 'https://mcp.upstash.com/mcp', 'Your Upstash Redis, QStash and vector databases.', ['databases', 'developer-tools']),
  app('clerk', 'Clerk', 'https://mcp.clerk.com/mcp', 'Users, organizations and applications in your Clerk account.', ['security-&-identity-tools', 'developer-tools']),
  app('dodopayments', 'Dodo Payments', 'https://mcp.dodopayments.com/mcp', 'Payments, subscriptions, refunds and customers in Dodo Payments.', ['payment-processing']),
  app('morningstar', 'Morningstar', 'https://mcp.morningstar.com/mcp', 'Fund, stock and market research from your Morningstar account.', ['business-intelligence']),
  app('microsoftlearn', 'Microsoft Learn', 'https://learn.microsoft.com/api/mcp', "Search Microsoft's official documentation and code samples.", ['developer-tools'], { auth: 'none', logo: 'microsoft' }),
  app('cloudflaredocs', 'Cloudflare Docs', 'https://docs.mcp.cloudflare.com/mcp', "Search Cloudflare's developer documentation.", ['developer-tools'], { auth: 'none', logo: 'cloudflare' }),
];

/** a browser sign-in may sit open while the person finds their password */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** renew an access token this long before it runs out */
const REFRESH_EARLY_MS = 60_000;
/** how long an app's list of tools is kept before it is read again */
const TOOLS_TTL_MS = 6 * 60 * 60_000;
/** tools named per task in a search, and the room their input schemas may take in one answer */
const SEARCH_TOOLS = 6;
const SCHEMAS_CHARS = 30_000;
const DESCRIPTION_CHARS = 300;
/** an answer over this is kept as a file in the bot's folder, with a preview here */
const INLINE_CHARS = 60_000;
const PREVIEW_CHARS = 2_000;
const ANSWERS_DIR = join('inbox', 'apps');
const ANSWERS_KEPT = 20;
/** words that say nothing about which tool a task needs */
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'all', 'any', 'get', 'use', 'using', 'please', 'want', 'need', 'about', 'user', 'users', 'their', 'what', 'which', 'when', 'how']);

/** A tool as the bots name it. */
export function directToolSlug(slug: string, tool: string): string { return `${slug.toUpperCase()}__${tool}`; }

/** The meaningful words of a task. */
export function taskWords(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
}

/** How well a tool fits a task: its name counts three times its description. */
export function toolScore(words: readonly string[], tool: RemoteTool, appWords: readonly string[]): number {
  const name = tool.name.toLowerCase();
  const about = (tool.description ?? '').toLowerCase();
  let score = 0;
  for (const w of words) {
    if (appWords.includes(w)) continue;
    if (name.includes(w)) score += 3;
    else if (about.includes(w)) score += 1;
  }
  return score;
}

interface SignIn { slug: string; verifier: string; at: RemoteSignIn; client: NonNullable<StoredDirectApp['client']>; timer: ReturnType<typeof setTimeout> }

export class DirectApps {
  private api: RemoteMcp;
  private bySlug: Map<string, DirectAppDef>;
  /** browser sign-ins under way, by their `state` */
  private signIns = new Map<string, SignIn>();
  private tools = new Map<string, { at: number; list: RemoteTool[] }>();
  private listing = new Map<string, Promise<RemoteTool[]>>();
  private refreshing = new Map<string, Promise<string | undefined>>();

  /** `changed`: an app was connected, disconnected or its sign-in ended (the service tells the bots and the apps). */
  constructor(private ctx: CoreCtx, private file: JsonFile<StoredApps>, private changed: () => void) {
    this.api = ctx.deps.remoteMcp?.() ?? remoteMcp(ctx.deps.fetch ?? fetch);
    // an AppuBot Cloud computer has no browser of the person's for the sign-in to come back to: none there yet
    this.bySlug = new Map((ctx.deps.cloud ? [] : DIRECT_APPS).map((d) => [d.slug, d]));
  }

  /** Whether this computer connects apps on their own servers at all. */
  get offered(): boolean { return this.bySlug.size > 0; }

  has(slug: string): boolean { return this.bySlug.has(slug); }

  /** The app that stands in for a Composio one that can't be connected. */
  insteadOf(composioSlug: string): string | undefined {
    for (const d of this.bySlug.values()) if (d.insteadOf === composioSlug) return d.slug;
    return undefined;
  }

  toolkits(): AppToolkit[] {
    return [...this.bySlug.values()].map((d) => ({
      slug: d.slug, name: d.name, logo: `https://logos.composio.dev/api/${d.logo}`, description: d.description, categories: d.categories, authKind: d.auth,
    }));
  }

  private stored(slug: string): StoredDirectApp | undefined { return this.file.get().direct?.[slug]; }

  private save(slug: string, next: StoredDirectApp | undefined): void {
    this.file.update((f) => {
      const { [slug]: _old, ...rest } = f.direct ?? {};
      return { ...f, direct: next ? { ...rest, [slug]: next } : rest };
    });
  }

  private usable(d: DirectAppDef, s: StoredDirectApp | undefined): boolean {
    return !!s && (s.open === true || d.auth === 'none' || (!!s.tokens && !s.expired));
  }

  /** The apps a bot could use now. */
  connectedSlugs(): string[] {
    return [...this.bySlug.values()].filter((d) => this.usable(d, this.stored(d.slug))).map((d) => d.slug);
  }

  connections(): AppConnection[] {
    const out: AppConnection[] = [];
    for (const d of this.bySlug.values()) {
      const s = this.stored(d.slug);
      if (!s || !(s.open || d.auth === 'none' || s.tokens)) continue;
      out.push({ slug: d.slug, connectedAccountId: `direct:${d.slug}`, status: this.usable(d, s) ? 'ACTIVE' : 'EXPIRED' });
    }
    return out;
  }

  /** The app whose sign-in carries this `state`, if it is one of these. */
  signingIn(state: string | undefined): string | undefined { return state ? this.signIns.get(state)?.slug : undefined; }

  /** The apps whose sign-in page is open in the browser. */
  pendingSlugs(): string[] { return [...new Set([...this.signIns.values()].map((s) => s.slug))]; }

  private def(slug: string): DirectAppDef {
    const d = this.bySlug.get(slug);
    if (!d) throw new RpcError('not_found', `No app called “${slug}”.`);
    return d;
  }

  /* -------------------------------------------------------------- sign-in */

  private redirectUri(): string { return `http://127.0.0.1:${this.ctx.gateway.port}/apps/signed-in`; }

  private dropSignIns(slug: string): void {
    for (const [state, s] of this.signIns) if (s.slug === slug) { clearTimeout(s.timer); this.signIns.delete(state); }
  }

  /**
   * Connect an app: one that needs no sign-in is added once its server answers; the others open the app's own
   * sign-in page in this computer's browser, which comes back to the gateway's `/apps/signed-in` page.
   */
  async connect(slug: string, onCaller: boolean): Promise<{ redirectUrl?: string }> {
    const d = this.def(slug);
    let at: RemoteSignIn | null = null;
    if (d.auth !== 'none') {
      // the page returns to this computer's own address, which another device's browser can't reach
      if (onCaller) throw new RpcError('unsupported', `Add ${d.name} in AppuBot on the computer itself: its sign-in page comes back to that computer.`);
      try { at = await this.api.signIn(d.url); }
      catch (e) { throw new RpcError('apps_unavailable', `Couldn't reach ${d.name}: ${errMsg(e)}`); }
    }
    if (!at) {
      try { this.tools.set(slug, { at: Date.now(), list: await this.api.listTools(d.url) }); }
      catch (e) { throw new RpcError('apps_unavailable', `Couldn't reach ${d.name}: ${errMsg(e)}`); }
      this.save(slug, { addedAt: Date.now(), open: true });
      this.ctx.s.notifications.notify({ title: `${d.name} added`, body: 'Your bots can use it now.', level: 'success', native: false });
      this.changed();
      return {};
    }
    const redirectUri = this.redirectUri();
    const before = this.stored(slug);
    let client = before?.client?.redirectUri === redirectUri && before.at?.tokenUrl === at.tokenUrl ? before.client : undefined;
    if (!client) {
      try { client = { ...await this.api.register(at, redirectUri), redirectUri }; }
      catch (e) { throw new RpcError('apps_unavailable', `${d.name} didn't let AppuBot sign in: ${errMsg(e)}`); }
      this.save(slug, { ...before, addedAt: before?.addedAt ?? Date.now(), client, at });
    }
    // a second click starts the sign-in over
    this.dropSignIns(slug);
    const { verifier, challenge } = pkce();
    const state = randomBytes(16).toString('hex');
    const timer = setTimeout(() => {
      if (!this.signIns.delete(state)) return;
      this.ctx.s.notifications.notify({ title: `${d.name} wasn't connected`, body: 'The sign-in page was left unfinished. Add it again to try once more.', level: 'info', native: false });
      this.changed();
    }, SIGN_IN_TIMEOUT_MS);
    timer.unref?.();
    this.signIns.set(state, { slug, verifier, at, client, timer });
    const url = this.api.authorizeUrl({ at, client, redirectUri, challenge, state });
    await Promise.resolve(this.ctx.deps.openExternal(url)).catch((e: unknown) => this.ctx.log.warn('apps: could not open the sign-in page', errMsg(e)));
    this.changed();
    return { redirectUrl: url };
  }

  /** The browser came back: `undefined` when the return isn't one of these sign-ins, else whether it worked. */
  async finish(q: { code?: string; state?: string; error?: string }): Promise<boolean | undefined> {
    const s = q.state ? this.signIns.get(q.state) : undefined;
    if (!s || !q.state) return undefined;
    clearTimeout(s.timer);
    this.signIns.delete(q.state);
    const d = this.def(s.slug);
    if (q.error || !q.code) { this.changed(); return false; }
    let tokens;
    try { tokens = await this.api.exchange({ at: s.at, client: s.client, redirectUri: s.client.redirectUri, code: q.code, verifier: s.verifier }); }
    catch (e) {
      this.ctx.log.warn(`apps: the ${d.name} sign-in did not finish`, errMsg(e));
      this.ctx.s.notifications.notify({ title: `${d.name} isn't connected`, body: `The sign-in did not finish: ${errMsg(e)}`.slice(0, 240), level: 'warning' });
      this.changed();
      return false;
    }
    const { account, ...kept } = tokens;
    this.save(s.slug, { addedAt: this.stored(s.slug)?.addedAt ?? Date.now(), client: s.client, at: s.at, tokens: kept, ...(account ? { account } : {}) });
    this.tools.delete(s.slug);
    this.ctx.s.notifications.notify({ title: `${d.name} connected`, body: 'Your bots can use it now.', level: 'success', native: false });
    this.ctx.deps.showApp?.();
    this.changed();
    // its tools are read now, so the first search doesn't wait for them
    void this.toolsOf(s.slug).catch(() => undefined);
    return true;
  }

  /** Forgets the sign-in here (the registration is kept, so connecting again needs no new one). */
  disconnect(slug: string): void {
    const d = this.def(slug);
    const s = this.stored(slug);
    this.dropSignIns(slug);
    this.save(slug, s?.client && s.at ? { addedAt: s.addedAt, client: s.client, at: s.at } : undefined);
    this.tools.delete(slug);
    this.api.forget(d.url);
    this.changed();
  }

  /** The app no longer takes the sign-in: it reads as needing to be connected again. */
  private ended(d: DirectAppDef): RpcError {
    const s = this.stored(d.slug);
    if (s && !s.expired) {
      this.save(d.slug, { ...s, expired: true });
      this.ctx.log.warn(`apps: the ${d.name} sign-in ended`);
      this.ctx.s.notifications.notify({ title: `${d.name} needs connecting again`, body: 'Its sign-in ended. Connect it again in Apps.', level: 'warning', native: false });
      this.changed();
    }
    return new RpcError('apps_unavailable', `${d.name}'s sign-in ended: ask the user to connect it again in AppuBot → Apps.`);
  }

  /** A valid access token (none for an app that needs no sign-in), renewed when it is about to run out. */
  private token(d: DirectAppDef, force = false): Promise<string | undefined> {
    const s = this.stored(d.slug);
    if (!this.usable(d, s)) return Promise.reject(new RpcError('apps_unavailable', `${d.name} isn't connected: ask the user to connect it in AppuBot → Apps.`));
    const t = s!.tokens;
    if (!t) return Promise.resolve(undefined);
    if (!force && (!t.expiresAt || t.expiresAt - REFRESH_EARLY_MS > Date.now())) return Promise.resolve(t.accessToken);
    let job = this.refreshing.get(d.slug);
    if (!job) {
      job = (async () => {
        if (!t.refreshToken || !s!.client || !s!.at) throw this.ended(d);
        let next;
        try { next = await this.api.refresh({ at: s!.at, client: s!.client, refreshToken: t.refreshToken }); }
        catch (e) {
          if (e instanceof RemoteHttpError && (e.status === 400 || e.status === 401)) throw this.ended(d);
          throw new RpcError('apps_unavailable', `Couldn't reach ${d.name}: ${errMsg(e)}`);
        }
        const now = this.stored(d.slug);
        // disconnected (or connected again) meanwhile: these tokens are stale
        if (now?.tokens?.refreshToken !== t.refreshToken) throw new RpcError('apps_unavailable', `${d.name} was disconnected.`);
        const { account: _a, ...kept } = next;
        this.save(d.slug, { ...now, tokens: { ...kept, refreshToken: kept.refreshToken ?? t.refreshToken } });
        return kept.accessToken;
      })().finally(() => { this.refreshing.delete(d.slug); });
      this.refreshing.set(d.slug, job);
    }
    return job;
  }

  /** Something done with the app's server; a refused token is renewed once. */
  private async withToken<T>(d: DirectAppDef, run: (token: string | undefined) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token(d, attempt > 0);
      try { return await run(token); }
      catch (e) {
        if (e instanceof RemoteHttpError && e.status === 401 && token && attempt === 0) continue;
        if (e instanceof RemoteHttpError && e.status === 401 && token) throw this.ended(d);
        if (e instanceof RpcError) throw e;
        throw new RpcError('apps_unavailable', `${d.name}: ${errMsg(e)}`);
      }
    }
  }

  /* -------------------------------------------------------- the bots' calls */

  private toolsOf(slug: string): Promise<RemoteTool[]> {
    const kept = this.tools.get(slug);
    if (kept && Date.now() - kept.at < TOOLS_TTL_MS) return Promise.resolve(kept.list);
    let job = this.listing.get(slug);
    if (!job) {
      const d = this.def(slug);
      job = this.withToken(d, (token) => this.api.listTools(d.url, token))
        .then((list) => { this.tools.set(slug, { at: Date.now(), list }); return list; })
        .finally(() => { this.listing.delete(slug); });
      this.listing.set(slug, job);
    }
    return job;
  }

  /** The app a tool slug names (`PAYPAL_DIRECT__create_invoice` → `paypal_direct`), whether or not it is connected. */
  appOfTool(tool: string): string | undefined {
    const t = tool.toUpperCase();
    for (const slug of this.bySlug.keys()) if (t.startsWith(`${slug.toUpperCase()}__`)) return slug;
    return undefined;
  }

  private async find(tool: string): Promise<{ d: DirectAppDef; tool: RemoteTool }> {
    const slug = this.appOfTool(tool);
    if (!slug) throw new RpcError('not_found', `${tool} isn't a tool of your apps.`);
    const d = this.def(slug);
    const name = tool.slice(slug.length + 2);
    const list = await this.toolsOf(slug);
    const found = list.find((x) => x.name === name) ?? list.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!found) throw new RpcError('not_found', `${d.name} has no tool called ${name}. Find its tools with apps_search.`);
    return { d, tool: found };
  }

  private described(d: DirectAppDef, t: RemoteTool) {
    return { tool_slug: directToolSlug(d.slug, t.name), app: d.slug, ...(t.description ? { description: t.description.replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_CHARS) } : {}) };
  }

  /** The tools of these apps that fit each task, with their input schemas while there is room. */
  async search(slugs: readonly string[], queries: MethodParams<'agent.apps.search'>['queries']): Promise<Record<string, unknown>> {
    const lists: { d: DirectAppDef; tools: RemoteTool[] }[] = [];
    const unreachable: { app: string; problem: string }[] = [];
    await Promise.all(slugs.map(async (slug) => {
      const d = this.def(slug);
      try { lists.push({ d, tools: await this.toolsOf(slug) }); }
      catch (e) { unreachable.push({ app: slug, problem: errMsg(e) }); }
    }));
    lists.sort((a, b) => slugs.indexOf(a.d.slug) - slugs.indexOf(b.d.slug));
    const schemas: Record<string, unknown> = {};
    let room = SCHEMAS_CHARS;
    const results = queries.map((q) => {
      const words = taskWords(`${q.use_case} ${q.known_fields ?? ''}`);
      const ranked: { d: DirectAppDef; t: RemoteTool; score: number; i: number }[] = [];
      let i = 0;
      for (const { d, tools } of lists) {
        const appWords = taskWords(`${d.name} ${d.slug.slice(0, -DIRECT_APP_SUFFIX.length)}`);
        // a task that names the app is about that app, whatever its tools are called
        const named = appWords.some((w) => words.includes(w)) ? 1 : 0;
        for (const t of tools) ranked.push({ d, t, score: toolScore(words, t, appWords) + named, i: i++ });
      }
      const best = ranked.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, SEARCH_TOOLS);
      for (const { d, t } of best) {
        const slug = directToolSlug(d.slug, t.name);
        if (slug in schemas) continue;
        const text = JSON.stringify(t.inputSchema ?? {});
        if (text.length > room) continue;
        room -= text.length;
        schemas[slug] = { toolkit: d.slug, input_schema: t.inputSchema ?? {} };
      }
      return { use_case: q.use_case, tools: best.map(({ d, t }) => this.described(d, t)) };
    });
    return {
      note: 'Tools of the apps that run on their own servers. Run one with apps_execute, giving its tool_slug exactly as written and arguments that fit its input_schema (apps_tool_schemas has the schema of any tool not under tool_schemas).',
      results, tool_schemas: schemas, ...(unreachable.length ? { unreachable } : {}),
    };
  }

  async schemas(toolSlugs: readonly string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    await Promise.all(toolSlugs.map(async (slug) => {
      try {
        const { d, tool } = await this.find(slug);
        out[directToolSlug(d.slug, tool.name)] = { toolkit: d.slug, ...(tool.description ? { description: tool.description } : {}), input_schema: tool.inputSchema ?? {} };
      } catch (e) { out[slug] = { error: errMsg(e) }; }
    }));
    return { tool_schemas: out };
  }

  /** Runs tools on the apps' own servers, in parallel; each answers for itself. */
  async execute(botId: string, calls: MethodParams<'agent.apps.execute'>['tools']): Promise<{ text: string; isError: boolean }> {
    const results = await Promise.all(calls.map(async (c) => {
      try {
        const { d, tool } = await this.find(c.tool_slug);
        const r = await this.withToken(d, (token) => this.api.callTool(d.url, token, tool.name, c.arguments));
        if (r.isError) return { tool_slug: c.tool_slug, response: { successful: false, error: r.text.slice(0, 4000) || 'the tool reported an error' } };
        return { tool_slug: c.tool_slug, response: { successful: true, ...this.answer(botId, c.tool_slug, r.text) } };
      } catch (e) { return { tool_slug: c.tool_slug, response: { successful: false, error: errMsg(e) } }; }
    }));
    return { text: JSON.stringify({ results }), isError: results.every((r) => !r.response.successful) };
  }

  /** An answer as data; one too large to return goes to a file in the bot's folder, with a preview here. */
  private answer(botId: string, label: string, text: string): { data: unknown; full_answer?: Record<string, unknown> } {
    if (text.length <= INLINE_CHARS) {
      try { return { data: JSON.parse(text) as unknown }; } catch { return { data: text }; }
    }
    try {
      const dir = join(this.ctx.s.bots.require(botId).workspace, ANSWERS_DIR);
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const path = join(dir, `${label.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 60) || 'answer'}-${stamp}-${randomBytes(2).toString('hex')}.txt`);
      writeFileSync(path, text);
      try {
        const files = readdirSync(dir).map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at);
        for (const { f } of files.slice(ANSWERS_KEPT)) rmSync(join(dir, f), { force: true });
      } catch { /* nothing to tidy */ }
      return {
        data: `${text.slice(0, PREVIEW_CHARS)}…`,
        full_answer: { path, bytes: Buffer.byteLength(text), note: 'The whole answer was too large to return here, so AppuBot saved all of it at `path`; `data` above is only its beginning. Read what you need from the file with your own tools; never print it whole.' },
      };
    } catch (e) {
      this.ctx.log.warn('apps: could not keep a large answer', errMsg(e));
      return { data: `${text.slice(0, PREVIEW_CHARS)}…`, full_answer: { note: 'The whole answer was too large to return here and could not be saved. Ask again for less: fewer items, or only the fields you need.' } };
    }
  }

  shutdown(): void {
    for (const s of this.signIns.values()) clearTimeout(s.timer);
    this.signIns.clear();
  }
}
