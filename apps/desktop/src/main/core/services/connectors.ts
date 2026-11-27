/**
 * Custom connectors (Settings › Apps › Custom connectors): MCP servers the person adds themselves. A remote one is
 * reached at its address over streamable HTTP or SSE, with the headers they gave and, when the server asks for one,
 * the standard MCP sign-in (`mcpRemote.ts`: the server names its authorization server, AppuBot registers itself,
 * PKCE, refresh tokens). A local one is a command AppuBot starts on this computer and talks to over stdio.
 *
 * AppuBot is the MCP client here, not the agents: the bridge every agent already loads offers each connector's tools
 * that are switched on, to the bots allowed to use it (`agent.connectors.tools`, named `<connector>__<tool>`), and runs
 * them through this service (`agent.connectors.call`). So every agent gets them the same way, a switched-off tool or a
 * bot that isn't allowed never sees it, and no header, variable or token reaches an agent, its config files or a log.
 *
 * Kept in `<dataDir>/connectors.json` (0600). Header values, environment values and sign-in tokens are sealed with the
 * OS keychain (`deps.secretBox`, as the Vault's are) where there is one; the wire only names them.
 */
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { getPathString, resolveExecutable } from '@appubot/agent-runtime';
import {
  newId, type Connector, type ConnectorBots, type ConnectorStatus, type MethodParams, type MethodResult,
} from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { JsonFile } from '../store';
import { errMsg, notFound, RpcError } from '../util';
import { pkce } from './composioConnect';
import { remoteMcp, type RemoteClient, type RemoteMcp, type RemoteSignIn } from './mcpRemote';

const FILE = 'connectors.json';
/** a local server started with npx may first download its package */
const CONNECT_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 30_000;
/** a tool may take its time (a search over a large account, a report) */
const CALL_TIMEOUT_MS = 3 * 60_000;
const TOOL_PAGES_MAX = 10;
const TOOLS_MAX = 500;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const REFRESH_EARLY_MS = 60_000;
/** the most of a local server's own complaints kept, for the reason it stopped */
const STDERR_KEPT = 2_000;
/** a tool's whole name as an agent sees it stays within what model APIs take (64), with `mcp__appubot__` before it */
const AGENT_NAME_MAX = 50;
const DESCRIPTION_MAX = 1_000;
const ANSWER_MAX_CHARS = 200_000;

/** A saved secret: sealed by the keychain (`enc`), else as typed (the file is this user's only). */
interface Sealed { v: string; enc?: boolean }

interface StoredTool { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown> }

interface StoredConnector {
  id: string;
  name: string;
  transport: Connector['transport'];
  url?: string;
  command?: string;
  args: string[];
  headers: { name: string; value?: Sealed }[];
  env: { name: string; value?: Sealed }[];
  bots: ConnectorBots;
  /** tools switched off, by name */
  off: string[];
  /** its tools as it last listed them (the bridge offers these, so a bot's tools don't wait on the server) */
  tools: StoredTool[];
  server?: { name: string; version?: string };
  /** the standard MCP sign-in, when the server asked for one */
  oauth?: {
    at: RemoteSignIn;
    client: Omit<RemoteClient, 'clientSecret'> & { clientSecret?: Sealed; redirectUri: string };
    tokens?: { accessToken: Sealed; refreshToken?: Sealed; expiresAt?: number };
    account?: string;
  };
  createdAt: number;
}

interface StoredConnectors { connectors: StoredConnector[] }

/** A live connection to a connector's server. */
interface Link { client: Client; close: () => Promise<void> }

interface Live {
  status: ConnectorStatus;
  error?: string;
  link?: Promise<Link>;
  /** what a local server said on stderr lately */
  stderr: string;
}

interface SignIn { id: string; verifier: string; at: RemoteSignIn; client: NonNullable<StoredConnector['oauth']>['client']; timer: ReturnType<typeof setTimeout> }

/** A name as a bot's tool names use it: lowercase letters, digits and single underscores. */
export function connectorSlug(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20).replace(/_+$/, '') || 'connector';
}

/** A tool's name as an agent is offered it: `<connector>__<tool>`, within AGENT_NAME_MAX (a short hash keeps long ones apart). */
export function agentToolName(slug: string, tool: string): string {
  const full = `${slug}__${tool.replace(/[^A-Za-z0-9_-]+/g, '_')}`;
  if (full.length <= AGENT_NAME_MAX) return full;
  const hash = createHash('sha256').update(tool).digest('hex').slice(0, 6);
  return `${full.slice(0, AGENT_NAME_MAX - 7)}_${hash}`;
}

/** Whether a bot may use a connector. */
export function botMayUse(bots: ConnectorBots, botId: string): boolean {
  return bots === 'all' || bots.includes(botId);
}

/** Why a connector can't be used, in plain words, from what went wrong while reaching it. */
export function plainReason(e: unknown, c: Pick<StoredConnector, 'transport' | 'url' | 'command'>, stderr = ''): string {
  const msg = errMsg(e);
  const code = (e as { code?: unknown })?.code;
  // what it says and what it was caused by (fetch's `cause`, a connection's several tries)
  const parts: string[] = [];
  const walk = (x: unknown, depth: number) => {
    if (!x || typeof x !== 'object' || depth > 4) return;
    parts.push(`${errMsg(x)} ${String((x as { code?: unknown }).code ?? '')}`);
    walk((x as { cause?: unknown }).cause, depth + 1);
    for (const y of (x as { errors?: unknown[] }).errors ?? []) walk(y, depth + 1);
  };
  walk(e, 0);
  const all = parts.join(' ') || msg;
  const where = c.url ? (() => { try { return new URL(c.url).host; } catch { return c.url; } })() : '';
  const lastSaid = stderr.trim().split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0];
  if (c.transport === 'stdio') {
    // Windows starts a command through cmd.exe, which says so itself instead of failing with ENOENT
    if (/ENOENT/.test(all) || /is not recognized as an internal or external command/i.test(stderr)) return `Couldn't start “${c.command}”: there's no such command on this computer.`;
    if (/EACCES/.test(all)) return `Couldn't start “${c.command}”: it isn't allowed to run.`;
    if (/timed out|timeout/i.test(all)) return 'It started but didn’t answer within a minute.';
    if (/closed|exited|EPIPE/i.test(all)) return lastSaid ? `It stopped before answering: ${lastSaid.slice(0, 200)}` : 'It stopped before answering.';
    return lastSaid ? `${msg.slice(0, 160)} (${lastSaid.slice(0, 160)})` : msg.slice(0, 300);
  }
  const status = typeof code === 'number' ? code : Number(/HTTP (\d{3})/.exec(all)?.[1] ?? /\b(40[0-9]|50[0-9])\b/.exec(all)?.[1] ?? NaN);
  if (/Unauthorized/i.test(all) || status === 401) return 'It refused the request (HTTP 401): it needs a sign-in, or a token in its headers.';
  if (status === 403) return 'It refused the request (HTTP 403): the token or account isn’t allowed to use it.';
  if (status === 404 || status === 405) return `Nothing at that address speaks MCP (HTTP ${status}). Check the address, or try ${c.transport === 'http' ? 'SSE' : 'streamable HTTP'}.`;
  if (status >= 500) return `The server had a problem (HTTP ${status}). Try again later.`;
  if (/ECONNREFUSED|ECONNRESET/.test(all)) return `Nothing answered at ${where}.`;
  if (/ENOTFOUND|EAI_AGAIN/.test(all)) return `Couldn't find ${where}: check the address and your connection.`;
  if (/CERT|certificate|self.signed/i.test(all)) return `${where}'s certificate isn't trusted.`;
  if (/timed out|timeout|aborted/i.test(all)) return `${where} didn’t answer in time.`;
  if (/fetch failed/i.test(all)) return `Couldn't reach ${where}.`;
  return msg.slice(0, 300);
}

/** A tool's answer as the bridge hands it on: text and pictures, anything else said in words. */
export function answerContent(res: { content?: unknown; structuredContent?: unknown; toolResult?: unknown }): MethodResult<'agent.connectors.call'>['content'] {
  const out: MethodResult<'agent.connectors.call'>['content'] = [];
  for (const raw of Array.isArray(res.content) ? res.content : []) {
    const c = raw as Record<string, unknown>;
    if (c.type === 'text' && typeof c.text === 'string') out.push({ type: 'text', text: c.text });
    else if (c.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string') out.push({ type: 'image', data: c.data, mimeType: c.mimeType });
    else if (c.type === 'resource' && c.resource && typeof (c.resource as { text?: unknown }).text === 'string') out.push({ type: 'text', text: (c.resource as { text: string }).text });
    else if (c.type === 'resource' || c.type === 'resource_link') {
      const r = (c.type === 'resource' ? c.resource : c) as { uri?: unknown; name?: unknown };
      out.push({ type: 'text', text: `[${c.type === 'resource' ? 'resource' : 'link'}: ${String(r.name ?? r.uri ?? '')}${r.uri && r.name ? ` (${String(r.uri)})` : ''}]` });
    } else if (c.type === 'audio') out.push({ type: 'text', text: '[audio the tool returned]' });
  }
  if (!out.length && res.structuredContent !== undefined) out.push({ type: 'text', text: JSON.stringify(res.structuredContent) });
  if (!out.length && res.toolResult !== undefined) out.push({ type: 'text', text: JSON.stringify(res.toolResult) });
  let room = ANSWER_MAX_CHARS;
  return out.map((c) => {
    if (c.type !== 'text') return c;
    const text = c.text.length > room ? `${c.text.slice(0, Math.max(0, room))}… (cut: the answer was longer)` : c.text;
    room = Math.max(0, room - c.text.length);
    return { type: 'text' as const, text };
  });
}

/** `http(s)://…` or an error worded for people. */
function cleanUrl(raw: string | undefined): string {
  let u: URL;
  try { u = new URL((raw ?? '').trim()); } catch { throw new RpcError('invalid_params', 'Enter the server’s address, like https://example.com/mcp.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new RpcError('invalid_params', 'The address should start with https:// or http://.');
  u.hash = '';
  return u.toString();
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => new Promise<T>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  t.unref?.();
  p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
});

export class ConnectorsService {
  private file: JsonFile<StoredConnectors>;
  private live = new Map<string, Live>();
  private signIns = new Map<string, SignIn>();
  private refreshing = new Map<string, Promise<void>>();
  private api: RemoteMcp;

  constructor(private ctx: CoreCtx) {
    this.file = new JsonFile<StoredConnectors>(join(ctx.paths.dataDir, FILE), () => ({ connectors: [] }), 150, ctx.log, (raw) => ({
      connectors: Array.isArray((raw as StoredConnectors)?.connectors) ? (raw as StoredConnectors).connectors : [],
    }), 0o600);
    // a server on this computer may have its sign-in on this computer too (http://localhost)
    this.api = ctx.deps.remoteMcp?.() ?? remoteMcp(ctx.deps.fetch ?? fetch, { loopback: true });
  }

  /** Reaches every connector in the background (app start). */
  start(): void {
    for (const c of this.all()) void this.reach(c.id).catch(() => undefined);
  }

  /* ------------------------------------------------------------ the store */

  private all(): StoredConnector[] { return this.file.get().connectors; }

  private stored(id: string): StoredConnector {
    const c = this.all().find((x) => x.id === id);
    if (!c) throw notFound('Connector', id);
    return c;
  }

  private put(next: StoredConnector): void {
    this.file.update((f) => ({ connectors: f.connectors.some((c) => c.id === next.id) ? f.connectors.map((c) => (c.id === next.id ? next : c)) : [...f.connectors, next] }));
  }

  private patch(id: string, fn: (c: StoredConnector) => StoredConnector): StoredConnector | undefined {
    const c = this.all().find((x) => x.id === id);
    if (!c) return undefined;
    const next = fn(c);
    this.put(next);
    return next;
  }

  private seal(plain: string): Sealed {
    const box = this.ctx.deps.secretBox;
    return box ? { v: box.encrypt(plain), enc: true } : { v: plain };
  }

  private open(s: Sealed): string {
    if (!s.enc) return s.v;
    const box = this.ctx.deps.secretBox;
    if (!box) throw new Error('the keychain that sealed it is not available');
    return box.decrypt(s.v);
  }

  private liveOf(id: string): Live {
    let l = this.live.get(id);
    if (!l) { l = { status: 'connecting', stderr: '' }; this.live.set(id, l); }
    return l;
  }

  /** Bot-facing slugs, unique among the connectors (two named alike get `_2`). */
  private slugs(): Map<string, string> {
    const out = new Map<string, string>();
    const taken = new Set<string>();
    for (const c of [...this.all()].sort((a, b) => a.createdAt - b.createdAt)) {
      const base = connectorSlug(c.name);
      let s = base;
      for (let n = 2; taken.has(s); n++) s = `${base}_${n}`;
      taken.add(s);
      out.set(c.id, s);
    }
    return out;
  }

  private toWire(c: StoredConnector): Connector {
    const l = this.live.get(c.id);
    const tokens = !!c.oauth?.tokens;
    let status: ConnectorStatus = l?.status ?? (c.tools.length ? 'connected' : 'connecting');
    if (!l && c.oauth && !tokens) status = 'signIn';
    return {
      id: c.id, name: c.name, transport: c.transport,
      ...(c.url ? { url: c.url } : {}), ...(c.command ? { command: c.command } : {}), args: c.args,
      headers: c.headers.map((h) => ({ name: h.name, saved: !!h.value })),
      env: c.env.map((v) => ({ name: v.name, saved: !!v.value })),
      bots: c.bots, status,
      ...(l?.error && status !== 'connected' ? { error: l.error } : {}),
      ...(c.oauth ? { signedIn: tokens } : {}),
      ...(c.oauth?.account ? { account: c.oauth.account } : {}),
      ...(c.server ? { server: c.server } : {}),
      tools: c.tools.map((t) => ({ name: t.name, ...(t.title ? { title: t.title } : {}), ...(t.description ? { description: t.description } : {}), on: !c.off.includes(t.name) })),
      createdAt: c.createdAt,
    };
  }

  private emit(): void { this.ctx.bus.emit('connectors.updated', { connectors: this.all().map((c) => this.toWire(c)) }); }

  /* ------------------------------------------------------ the owner's editor */

  list(): MethodResult<'connectors.list'> {
    return { connectors: this.all().map((c) => this.toWire(c)), encrypted: !!this.ctx.deps.secretBox };
  }

  get(id: string): Connector { return this.toWire(this.stored(id)); }

  async save(p: MethodParams<'connectors.save'>): Promise<Connector> {
    const prev = p.id ? this.stored(p.id) : undefined;
    const inHeaders = p.headers ?? [];
    const inEnv = p.env ?? [];
    const remote = p.transport !== 'stdio';
    const url = remote ? cleanUrl(p.url) : undefined;
    const command = remote ? undefined : (p.command ?? '').trim();
    if (!remote && !command) throw new RpcError('invalid_params', 'Enter the command that starts the server, like npx.');
    const keep = <T extends { name: string; value?: Sealed }>(list: T[] | undefined, name: string) => list?.find((x) => x.name === name)?.value;
    const dupe = (names: string[], what: string) => {
      const seen = new Set<string>();
      for (const n of names) { const k = what === 'header' ? n.toLowerCase() : n; if (seen.has(k)) throw new RpcError('invalid_params', `The ${what} ${n} is there twice.`); seen.add(k); }
    };
    dupe(inHeaders.map((h) => h.name), 'header');
    dupe(inEnv.map((v) => v.name), 'variable');
    const headers = remote ? inHeaders.map((h) => {
      const value = h.value !== undefined ? h.value.trim() : undefined;
      const sealed = value !== undefined ? (value ? this.seal(value) : undefined) : keep(prev?.headers, h.name);
      return { name: h.name, ...(sealed ? { value: sealed } : {}) };
    }) : [];
    const env = remote ? [] : inEnv.map((v) => {
      const sealed = v.value !== undefined ? (v.value ? this.seal(v.value) : undefined) : keep(prev?.env, v.name);
      return { name: v.name, ...(sealed ? { value: sealed } : {}) };
    });
    const bots = p.bots === undefined ? prev?.bots ?? 'all' : p.bots === 'all' ? 'all' : p.bots.filter((id) => !!this.ctx.s.bots.get(id));
    // another server: its tools, switches and sign-in were the old one's
    const sameServer = !!prev && prev.transport === p.transport && prev.url === url && prev.command === command;
    const next: StoredConnector = {
      id: prev?.id ?? newId('con'), name: p.name.trim(), transport: p.transport,
      ...(url ? { url } : {}), ...(command ? { command } : {}), args: remote ? [] : (p.args ?? []).filter((a) => a.trim() !== ''),
      headers, env, bots,
      off: sameServer ? prev.off : [], tools: sameServer ? prev.tools : [],
      ...(sameServer && prev.server ? { server: prev.server } : {}),
      ...(sameServer && prev.oauth ? { oauth: prev.oauth } : {}),
      createdAt: prev?.createdAt ?? Date.now(),
    };
    this.put(next);
    await this.drop(next.id);
    this.ctx.log.info(`connectors: ${prev ? 'changed' : 'added'} ${next.name} (${next.transport})`);
    await this.reach(next.id).catch(() => undefined);
    return this.get(next.id);
  }

  async remove(id: string): Promise<{ ok: true }> {
    const c = this.stored(id);
    await this.drop(id);
    this.live.delete(id);
    for (const [state, s] of this.signIns) if (s.id === id) { clearTimeout(s.timer); this.signIns.delete(state); }
    this.file.update((f) => ({ connectors: f.connectors.filter((x) => x.id !== id) }));
    this.ctx.log.info(`connectors: removed ${c.name}`);
    this.emit();
    return { ok: true };
  }

  async check(id: string): Promise<Connector> {
    this.stored(id);
    await this.drop(id);
    await this.reach(id).catch(() => undefined);
    return this.get(id);
  }

  setTool(id: string, tool: string, on: boolean): Connector {
    const c = this.stored(id);
    if (!c.tools.some((t) => t.name === tool)) throw new RpcError('not_found', `${c.name} has no tool called ${tool}.`);
    this.put({ ...c, off: on ? c.off.filter((t) => t !== tool) : [...new Set([...c.off, tool])] });
    this.emit();
    return this.get(id);
  }

  setBots(id: string, bots: ConnectorBots): Connector {
    const c = this.stored(id);
    this.put({ ...c, bots: bots === 'all' ? 'all' : [...new Set(bots)].filter((b) => !!this.ctx.s.bots.get(b)) });
    this.emit();
    return this.get(id);
  }

  /* ----------------------------------------------------------- the sign-in */

  private redirectUri(): string { return `http://127.0.0.1:${this.ctx.gateway.port}/connectors/signed-in`; }

  /** Opens the server's own sign-in page in this computer's browser; it comes back to `/connectors/signed-in`. */
  async signIn(id: string): Promise<{ redirectUrl: string }> {
    const c = this.stored(id);
    if (c.transport === 'stdio' || !c.url) throw new RpcError('invalid_params', 'A local server has no sign-in: give it what it needs in its environment.');
    // an AppuBot Cloud computer has no browser of the person's for the sign-in to come back to
    if (this.ctx.deps.cloud) throw new RpcError('unsupported', 'Sign in to this connector from AppuBot on your own computer: the sign-in page comes back to the computer it runs on.');
    let at: RemoteSignIn | null;
    try { at = await this.api.signIn(c.url); }
    catch (e) { throw new RpcError('unavailable', `Couldn't start the sign-in: ${plainReason(e, c)}`); }
    if (!at) throw new RpcError('invalid_params', `${c.name} doesn't ask for a sign-in. If it wants a token, add it as a header.`);
    const redirectUri = this.redirectUri();
    let client = c.oauth?.client.redirectUri === redirectUri && c.oauth.at.tokenUrl === at.tokenUrl ? c.oauth.client : undefined;
    if (!client) {
      let made: RemoteClient;
      try { made = await this.api.register(at, redirectUri); }
      catch (e) { throw new RpcError('unavailable', `${c.name} didn't let AppuBot sign in: ${errMsg(e)}`); }
      client = { clientId: made.clientId, authMethod: made.authMethod, redirectUri, ...(made.clientSecret ? { clientSecret: this.seal(made.clientSecret) } : {}) };
      this.put({ ...this.stored(id), oauth: { at, client } });
    }
    for (const [state, s] of this.signIns) if (s.id === id) { clearTimeout(s.timer); this.signIns.delete(state); }
    const { verifier, challenge } = pkce();
    const state = randomBytes(16).toString('hex');
    const timer = setTimeout(() => { if (this.signIns.delete(state)) this.emit(); }, SIGN_IN_TIMEOUT_MS);
    timer.unref?.();
    this.signIns.set(state, { id, verifier, at, client, timer });
    const url = this.api.authorizeUrl({ at, client: this.openClient(client), redirectUri, challenge, state });
    await Promise.resolve(this.ctx.deps.openExternal(url)).catch((e: unknown) => this.ctx.log.warn('connectors: could not open the sign-in page', errMsg(e)));
    return { redirectUrl: url };
  }

  private openClient(c: NonNullable<StoredConnector['oauth']>['client']): RemoteClient {
    return { clientId: c.clientId, authMethod: c.authMethod, ...(c.clientSecret ? { clientSecret: this.open(c.clientSecret) } : {}) };
  }

  /** The connector whose sign-in carries this `state`, if one does. */
  signingIn(state: string | undefined): string | undefined {
    const s = state ? this.signIns.get(state) : undefined;
    return s ? this.all().find((c) => c.id === s.id)?.name : undefined;
  }

  /** The browser came back: `undefined` when the return isn't one of these sign-ins, else whether it worked. */
  async finish(q: { code?: string; state?: string; error?: string }): Promise<boolean | undefined> {
    const s = q.state ? this.signIns.get(q.state) : undefined;
    if (!s || !q.state) return undefined;
    clearTimeout(s.timer);
    this.signIns.delete(q.state);
    const c = this.all().find((x) => x.id === s.id);
    if (!c) return false;
    if (q.error || !q.code) { this.emit(); return false; }
    let tokens;
    try { tokens = await this.api.exchange({ at: s.at, client: this.openClient(s.client), redirectUri: s.client.redirectUri, code: q.code, verifier: s.verifier }); }
    catch (e) {
      this.ctx.log.warn(`connectors: the ${c.name} sign-in did not finish`, errMsg(e));
      const l = this.liveOf(c.id);
      l.status = 'signIn';
      l.error = `The sign-in didn't finish: ${errMsg(e)}`.slice(0, 300);
      this.emit();
      return false;
    }
    this.put({
      ...c,
      oauth: {
        at: s.at, client: s.client,
        tokens: { accessToken: this.seal(tokens.accessToken), ...(tokens.refreshToken ? { refreshToken: this.seal(tokens.refreshToken) } : {}), ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}) },
        ...(tokens.account ? { account: tokens.account } : {}),
      },
    });
    this.ctx.deps.showApp?.();
    await this.drop(c.id);
    await this.reach(c.id).catch(() => undefined);
    return this.liveOf(c.id).status === 'connected';
  }

  async signOut(id: string): Promise<Connector> {
    const c = this.stored(id);
    if (c.oauth) this.put({ ...c, oauth: { at: c.oauth.at, client: c.oauth.client } });
    await this.drop(id);
    const l = this.liveOf(id);
    l.status = 'signIn';
    l.error = undefined;
    this.emit();
    return this.get(id);
  }

  /** A valid access token, renewed when it is about to run out (none without a sign-in). */
  private async accessToken(id: string, force = false): Promise<string | undefined> {
    const c = this.stored(id);
    const t = c.oauth?.tokens;
    if (!t) return undefined;
    if (!force && (!t.expiresAt || t.expiresAt - REFRESH_EARLY_MS > Date.now())) return this.open(t.accessToken);
    let job = this.refreshing.get(id);
    if (!job) {
      job = (async () => {
        if (!t.refreshToken || !c.oauth) throw new Error('its sign-in ended');
        const next = await this.api.refresh({ at: c.oauth.at, client: this.openClient(c.oauth.client), refreshToken: this.open(t.refreshToken) });
        this.patch(id, (now) => (now.oauth ? {
          ...now,
          oauth: {
            ...now.oauth,
            tokens: {
              accessToken: this.seal(next.accessToken),
              ...(next.refreshToken ? { refreshToken: this.seal(next.refreshToken) } : t.refreshToken ? { refreshToken: t.refreshToken } : {}),
              ...(next.expiresAt ? { expiresAt: next.expiresAt } : {}),
            },
          },
        } : now));
      })().finally(() => this.refreshing.delete(id));
      this.refreshing.set(id, job);
    }
    try { await job; }
    catch (e) {
      this.ctx.log.warn(`connectors: renewing the ${c.name} sign-in failed`, errMsg(e));
      this.patch(id, (now) => (now.oauth ? { ...now, oauth: { at: now.oauth.at, client: now.oauth.client } } : now));
      throw Object.assign(new Error('its sign-in ended'), { signIn: true });
    }
    const after = this.stored(id).oauth?.tokens;
    return after ? this.open(after.accessToken) : undefined;
  }

  /* ---------------------------------------------------------- connections */

  /** Closes the connection (a local server stops). */
  private async drop(id: string): Promise<void> {
    const l = this.live.get(id);
    const link = l?.link;
    if (l) l.link = undefined;
    if (link) await link.then((k) => k.close()).catch(() => undefined);
  }

  private async transportFor(c: StoredConnector, live: Live): Promise<Transport> {
    if (c.transport === 'stdio') {
      const env: Record<string, string> = { ...getDefaultEnvironment(), PATH: await getPathString().catch(() => process.env.PATH ?? '') };
      for (const v of c.env) if (v.value) env[v.name] = this.open(v.value);
      const command = (await resolveExecutable(c.command!).catch(() => undefined)) ?? c.command!;
      const t = new StdioClientTransport({ command, args: c.args, env, cwd: homedir(), stderr: 'pipe' });
      t.stderr?.on('data', (d: Buffer) => { live.stderr = (live.stderr + d.toString('utf8')).slice(-STDERR_KEPT); });
      return t;
    }
    const headers: Record<string, string> = {};
    for (const h of c.headers) if (h.value) headers[h.name] = this.open(h.value);
    const token = await this.accessToken(c.id);
    if (token) headers.Authorization = `Bearer ${token}`;
    const url = new URL(c.url!);
    const fetchImpl = this.ctx.deps.fetch ?? fetch;
    if (c.transport === 'sse') {
      return new SSEClientTransport(url, {
        requestInit: { headers },
        eventSourceInit: {
          fetch: (u, init) => {
            const all = new Headers(init?.headers);
            for (const [k, v] of Object.entries(headers)) all.set(k, v);
            return fetchImpl(u, { ...init, headers: all });
          },
        },
        fetch: fetchImpl,
      });
    }
    return new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: fetchImpl });
  }

  /** The connection to a connector's server, made when there is none. */
  private link(id: string): Promise<Link> {
    const live = this.liveOf(id);
    if (live.link) return live.link;
    const c = this.stored(id);
    const job = (async (): Promise<Link> => {
      const client = new Client({ name: 'AppuBot', version: this.ctx.deps.version }, { capabilities: {} });
      live.stderr = '';
      const transport = await this.transportFor(c, live);
      try { await withTimeout(client.connect(transport, { timeout: CONNECT_TIMEOUT_MS }), CONNECT_TIMEOUT_MS + 1_000, 'connecting'); }
      catch (e) { await transport.close().catch(() => undefined); throw e; }
      client.onclose = () => {
        // a local server that stopped, or a remote session that ended: the next use reaches it again
        if (live.link !== job) return;
        live.link = undefined;
        if (live.status === 'connected' && c.transport === 'stdio') {
          live.status = 'error';
          live.error = plainReason(new Error('closed'), c, live.stderr);
          this.emit();
        }
      };
      return { client, close: () => client.close() };
    })();
    live.link = job;
    job.catch(() => { if (live.link === job) live.link = undefined; });
    return job;
  }

  /** Reaches a connector and reads its tools; its status says how that went. */
  async reach(id: string): Promise<void> {
    const live = this.liveOf(id);
    const c = this.stored(id);
    if (c.oauth && !c.oauth.tokens) { live.status = 'signIn'; live.error = undefined; this.emit(); return; }
    live.status = 'connecting';
    live.error = undefined;
    this.emit();
    try {
      const link = await this.link(id);
      const tools: StoredTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < TOOL_PAGES_MAX && tools.length < TOOLS_MAX; page++) {
        const res = await link.client.listTools(cursor ? { cursor } : {}, { timeout: LIST_TIMEOUT_MS });
        for (const t of res.tools) {
          tools.push({
            name: t.name, ...(t.title ? { title: t.title } : t.annotations?.title ? { title: t.annotations.title } : {}),
            ...(t.description ? { description: t.description.slice(0, 4_000) } : {}),
            inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
          });
        }
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      const info = link.client.getServerVersion();
      this.patch(id, (now) => ({ ...now, tools, ...(info?.name ? { server: { name: info.name, ...(info.version ? { version: info.version } : {}) } } : {}) }));
      live.status = 'connected';
      live.error = undefined;
    } catch (e) {
      await this.drop(id);
      const now = this.all().find((x) => x.id === id);
      if (!now) return;
      // a server that wants a sign-in AppuBot can do: say so, rather than an error
      if (now.transport !== 'stdio' && /401|Unauthorized|sign-in ended/i.test(`${errMsg(e)} ${String((e as { code?: unknown }).code ?? '')}`) && !now.headers.some((h) => /^authorization$/i.test(h.name))) {
        const at = await this.api.signIn(now.url!).catch(() => null);
        if (at) {
          live.status = 'signIn';
          live.error = now.oauth?.tokens ? 'Its sign-in ended. Sign in again.' : undefined;
          if (now.oauth?.tokens) this.put({ ...now, oauth: { at: now.oauth.at, client: now.oauth.client } });
          else if (!now.oauth) this.put({ ...now, oauth: { at, client: { clientId: '', authMethod: 'none', redirectUri: '' } } });
          this.emit();
          return;
        }
      }
      live.status = 'error';
      live.error = plainReason(e, now, live.stderr);
      this.ctx.log.warn(`connectors: ${now.name} can't be reached`, live.error);
    }
    this.emit();
  }

  /* ------------------------------------------------------------- the bots */

  /** The tools of the connectors this bot may use that are switched on, as its agent is offered them. */
  toolsFor(botId: string): MethodResult<'agent.connectors.tools'>['tools'] {
    const slugs = this.slugs();
    const out: MethodResult<'agent.connectors.tools'>['tools'] = [];
    const taken = new Set<string>();
    for (const c of this.all()) {
      if (!botMayUse(c.bots, botId)) continue;
      if (c.oauth && !c.oauth.tokens) continue;
      for (const t of c.tools) {
        if (c.off.includes(t.name)) continue;
        const name = agentToolName(slugs.get(c.id)!, t.name);
        if (taken.has(name)) continue;
        taken.add(name);
        const about = (t.description ?? t.title ?? '').replace(/\s+/g, ' ').trim();
        out.push({ name, description: `${c.name} (custom connector): ${about || t.name}`.slice(0, DESCRIPTION_MAX), inputSchema: t.inputSchema ?? { type: 'object' } });
      }
    }
    return out;
  }

  /** What changes this bot's tools: a new one restarts its agent (resuming the chat), as apps do. */
  signature(botId: string): string {
    const tools = this.toolsFor(botId);
    return tools.length ? createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 16) : '';
  }

  /** Runs one of a bot's connector tools on its server. */
  async call(botId: string, name: string, args: Record<string, unknown>): Promise<MethodResult<'agent.connectors.call'>> {
    const slugs = this.slugs();
    let found: { c: StoredConnector; tool: string } | undefined;
    for (const c of this.all()) {
      const t = c.tools.find((x) => agentToolName(slugs.get(c.id)!, x.name) === name);
      if (t) { found = { c, tool: t.name }; break; }
    }
    const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
    if (!found) return fail(`There's no connector tool called ${name}. It may have been removed: the tools you have are the ones listed now.`);
    const { c, tool } = found;
    if (!botMayUse(c.bots, botId)) return fail(`This bot isn't allowed to use ${c.name}. The user can allow it in AppuBot → Settings → Apps.`);
    if (c.off.includes(tool)) return fail(`${tool} is switched off for ${c.name}. The user can switch it on in AppuBot → Settings → Apps.`);
    for (let attempt = 0; ; attempt++) {
      let link: Link;
      try { link = await this.link(c.id); }
      catch (e) {
        const live = this.liveOf(c.id);
        if ((e as { signIn?: boolean }).signIn) { live.status = 'signIn'; this.emit(); return fail(`${c.name}'s sign-in ended: ask the user to sign in again in AppuBot → Settings → Apps.`); }
        live.status = 'error';
        live.error = plainReason(e, c, live.stderr);
        this.emit();
        return fail(`${c.name} can't be reached: ${live.error}`);
      }
      try {
        const res = await link.client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true });
        if (this.liveOf(c.id).status !== 'connected') { this.liveOf(c.id).status = 'connected'; this.liveOf(c.id).error = undefined; this.emit(); }
        const content = answerContent(res as Parameters<typeof answerContent>[0]);
        return { content: content.length ? content : [{ type: 'text', text: res.isError ? 'The tool reported an error.' : 'Done (the tool returned nothing).' }], isError: !!res.isError };
      } catch (e) {
        // a session the server ended, or a token that ran out: once more, afresh
        const msg = `${errMsg(e)} ${String((e as { code?: unknown }).code ?? '')}`;
        await this.drop(c.id);
        if (attempt === 0 && /401|404|Unauthorized|session|closed|Not connected/i.test(msg)) {
          if (/401|Unauthorized/.test(msg) && c.oauth?.tokens) await this.accessToken(c.id, true).catch(() => undefined);
          continue;
        }
        return fail(`${c.name}: ${plainReason(e, c, this.liveOf(c.id).stderr)}`);
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const s of this.signIns.values()) clearTimeout(s.timer);
    this.signIns.clear();
    await Promise.all([...this.live.keys()].map((id) => this.drop(id)));
    this.file.flush();
  }
}
