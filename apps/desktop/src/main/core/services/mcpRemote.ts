/**
 * An app's own MCP server, reached with the person's own account: the standard MCP sign-in (the server names its
 * authorization server, AppuBot registers itself there as a public client, PKCE, refresh tokens) and a minimal MCP
 * client over fetch (JSON or SSE answers). `composioConnect.ts` is the same thing for the one server Composio runs;
 * this one takes any server's address, and reads everything else off the server.
 *
 * Every address a server names must be https (a loopback http one only where `loopback` says so: tests).
 */
import { accountOf, rpcAnswer } from './composioConnect';

const PROTOCOL_VERSION = '2025-06-18';
const CALL_TIMEOUT_MS = 30_000;
/** a tool may take its time (a search over a large account, a report) */
const TOOL_TIMEOUT_MS = 3 * 60_000;
/** the most of an answer that is read */
const ANSWER_MAX_CHARS = 4_000_000;
/** pages of `tools/list` */
const TOOL_PAGES_MAX = 10;

/** Where and how to sign in to a server, as the server says. */
export interface RemoteSignIn {
  /** what the tokens are for (the server's own name for itself) */
  resource: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** where a client registers itself; none: the server takes no client it hasn't been told of */
  registerUrl?: string;
  scopes: string[];
}

export interface RemoteClient {
  clientId: string;
  clientSecret?: string;
  /** how the client names itself at the token address: `none`, `client_secret_post` or `client_secret_basic` */
  authMethod: string;
}

export interface RemoteTokens {
  accessToken: string;
  refreshToken?: string;
  /** ms since the epoch; absent when the server didn't say */
  expiresAt?: number;
  account?: string;
}

export interface RemoteTool { name: string; description?: string; inputSchema?: unknown }

export interface RemoteToolResult { text: string; isError: boolean }

/** An HTTP failure with its status (401: the access token is no good; 400/401 from the token address: sign in again). */
export class RemoteHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface RemoteMcp {
  /** `null`: the server needs no sign-in */
  signIn(url: string): Promise<RemoteSignIn | null>;
  register(at: RemoteSignIn, redirectUri: string): Promise<RemoteClient>;
  authorizeUrl(p: { at: RemoteSignIn; client: RemoteClient; redirectUri: string; challenge: string; state: string }): string;
  exchange(p: { at: RemoteSignIn; client: RemoteClient; redirectUri: string; code: string; verifier: string }): Promise<RemoteTokens>;
  refresh(p: { at: RemoteSignIn; client: RemoteClient; refreshToken: string }): Promise<RemoteTokens>;
  listTools(url: string, accessToken?: string): Promise<RemoteTool[]>;
  callTool(url: string, accessToken: string | undefined, name: string, args: Record<string, unknown>): Promise<RemoteToolResult>;
  /** the server's sessions are dropped (signed out, or its address is no longer used) */
  forget(url: string): void;
}

/** The `name="value"` parameters of a `WWW-Authenticate` header. */
export function challengeParams(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (header ?? '').matchAll(/([a-z_]+)="([^"]*)"/gi)) out[m[1]!.toLowerCase()] = m[2]!;
  return out;
}

/** Where a server's own description of its sign-in may be, most specific first. */
export function resourceMetadataUrls(url: string, named?: string): string[] {
  const u = new URL(url);
  const path = u.pathname.replace(/\/$/, '');
  return [...new Set([named, `${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`].filter((x): x is string => !!x))];
}

/** Where an authorization server's metadata may be (RFC 8414 and OpenID's two spellings). */
export function issuerMetadataUrls(issuer: string): string[] {
  const i = new URL(issuer);
  const path = i.pathname.replace(/\/$/, '');
  const base = `${i.origin}${path}`;
  return [...new Set([
    `${i.origin}/.well-known/oauth-authorization-server${path}`,
    `${i.origin}/.well-known/openid-configuration${path}`,
    `${base}/.well-known/openid-configuration`,
    `${base}/.well-known/oauth-authorization-server`,
  ])];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);

export function remoteMcp(fetchImpl: typeof fetch = fetch, opts: { loopback?: boolean } = {}): RemoteMcp {
  /** MCP sessions per server and token */
  const sessions = new Map<string, Promise<{ sid?: string; version: string }>>();
  let nextId = 1;

  /** An address a server named: https, or loopback http where allowed. */
  const safe = (raw: unknown, what: string): string => {
    let u: URL;
    try { u = new URL(String(raw)); } catch { throw new Error(`${what} isn't an address`); }
    const loop = opts.loopback && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    if (u.protocol !== 'https:' && !loop) throw new Error(`${what} isn't an https address`);
    return u.toString();
  };

  const failure = async (r: Response, what: string): Promise<RemoteHttpError> => {
    const body = (await r.text().catch(() => '')).replace(/\s+/g, ' ').trim();
    let msg = body;
    try {
      const j = JSON.parse(body) as { error_description?: unknown; error?: unknown; message?: unknown };
      const m = j.error_description ?? j.message ?? j.error;
      if (typeof m === 'string' && m) msg = m;
    } catch { /* not JSON */ }
    return new RemoteHttpError(r.status, `${what} (HTTP ${r.status})${msg ? `: ${msg.slice(0, 200)}` : ''}`);
  };

  const getJson = async (url: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const r = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (!r.ok) { await r.text().catch(() => ''); return undefined; }
      const j = await r.json() as unknown;
      return j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : undefined;
    } catch { return undefined; }
  };

  const post = (url: string, token: string | undefined, body: unknown, s: { sid?: string; version: string } | undefined, ms: number): Promise<Response> => fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': s?.version ?? PROTOCOL_VERSION,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(s?.sid ? { 'mcp-session-id': s.sid } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });

  const initialize = (url: string, token: string | undefined): Promise<Response> =>
    post(url, token, { jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'AppuBot', version: '1' } } }, undefined, CALL_TIMEOUT_MS);

  const key = (url: string, token: string | undefined) => `${url}\n${token ?? ''}`;

  const open = (url: string, token: string | undefined): Promise<{ sid?: string; version: string }> => {
    const k = key(url, token);
    let s = sessions.get(k);
    if (!s) {
      s = (async () => {
        const r = await initialize(url, token);
        if (!r.ok) throw await failure(r, "The app's server didn't answer");
        const sid = r.headers.get('mcp-session-id') ?? undefined;
        const text = await r.text().catch(() => '');
        // the version the server settled on is the one every later request names
        const said = /"protocolVersion"\s*:\s*"(\d{4}-\d{2}-\d{2})"/.exec(text)?.[1];
        const session = { sid, version: said ?? PROTOCOL_VERSION };
        const n = await post(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, session, CALL_TIMEOUT_MS);
        await n.text().catch(() => '');
        return session;
      })();
      if (sessions.size > 32) sessions.delete(sessions.keys().next().value!);
      sessions.set(k, s);
      s.catch(() => { if (sessions.get(k) === s) sessions.delete(k); });
    }
    return s;
  };

  /** One request in a session; a session the server has ended is started again once. */
  const rpc = async (url: string, token: string | undefined, method: string, params: unknown, ms: number): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      const s = await open(url, token);
      const id = nextId++;
      const r = await post(url, token, { jsonrpc: '2.0', id, method, params }, s, ms);
      if ((r.status === 404 || r.status === 400) && s.sid && attempt === 0) { await r.text().catch(() => ''); sessions.delete(key(url, token)); continue; }
      if (!r.ok) throw await failure(r, "The app's server didn't answer");
      const body = await r.text();
      const msg = rpcAnswer(body.length > ANSWER_MAX_CHARS * 2 ? body.slice(0, ANSWER_MAX_CHARS * 2) : body, r.headers.get('content-type'), id);
      if (!msg) throw new Error("The app's server sent no answer");
      if (msg.error) throw new Error(msg.error.message ?? 'the call failed');
      return msg.result ?? {};
    }
  };

  const tokensOf = (j: Record<string, unknown>): RemoteTokens => {
    if (typeof j.access_token !== 'string' || !j.access_token) throw new Error('the app sent no access token');
    const expiresIn = typeof j.expires_in === 'number' ? j.expires_in : Number(j.expires_in);
    return {
      accessToken: j.access_token,
      refreshToken: typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : undefined,
      ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
      account: accountOf(j.id_token),
    };
  };

  /** A token request, with the client naming itself the way it was registered. */
  const tokenRequest = async (at: RemoteSignIn, client: RemoteClient, params: Record<string, string>, what: string): Promise<RemoteTokens> => {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const body = new URLSearchParams({ ...params, client_id: client.clientId, resource: at.resource });
    if (client.clientSecret && client.authMethod === 'client_secret_basic') {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')}`;
    } else if (client.clientSecret) body.set('client_secret', client.clientSecret);
    const r = await fetchImpl(safe(at.tokenUrl, 'The token address'), { method: 'POST', headers, body, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    if (!r.ok) throw await failure(r, what);
    return tokensOf(await r.json() as Record<string, unknown>);
  };

  return {
    async signIn(url) {
      const r = await initialize(safe(url, "The app's address"), undefined);
      await r.text().catch(() => '');
      if (r.ok) return null;
      if (r.status !== 401 && r.status !== 403) throw new RemoteHttpError(r.status, `The app's server didn't answer (HTTP ${r.status})`);
      const said = challengeParams(r.headers.get('www-authenticate'));
      let meta: Record<string, unknown> | undefined;
      for (const u of resourceMetadataUrls(url, said.resource_metadata)) {
        try { meta = await getJson(safe(u, "The app's description")); } catch { meta = undefined; }
        if (meta) break;
      }
      const issuer = strings(meta?.authorization_servers)[0] ?? new URL(url).origin;
      let as: Record<string, unknown> | undefined;
      for (const u of issuerMetadataUrls(safe(issuer, "The app's sign-in"))) {
        const j = await getJson(u);
        if (j && typeof j.authorization_endpoint === 'string' && typeof j.token_endpoint === 'string') { as = j; break; }
      }
      if (!as) throw new Error("the app's server doesn't say where to sign in");
      // what to ask for: what the refusal named, else what the server lists for itself; a refresh token where one is offered
      const asked = said.scope ? said.scope.split(/\s+/).filter(Boolean) : strings(meta?.scopes_supported);
      const scopes = strings(as.scopes_supported).includes('offline_access') && !asked.includes('offline_access') ? [...asked, 'offline_access'] : asked;
      return {
        resource: typeof meta?.resource === 'string' && meta.resource ? meta.resource : url,
        authorizeUrl: safe(as.authorization_endpoint, 'The sign-in page'),
        tokenUrl: safe(as.token_endpoint, 'The token address'),
        ...(typeof as.registration_endpoint === 'string' && as.registration_endpoint ? { registerUrl: safe(as.registration_endpoint, 'The registration address') } : {}),
        scopes,
      };
    },

    async register(at, redirectUri) {
      if (!at.registerUrl) throw new Error("the app doesn't take apps that register themselves");
      const r = await fetchImpl(at.registerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_name: 'AppuBot', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
          token_endpoint_auth_method: 'none', ...(at.scopes.length ? { scope: at.scopes.join(' ') } : {}),
        }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!r.ok) throw await failure(r, "The app didn't register AppuBot");
      const j = await r.json() as { client_id?: unknown; client_secret?: unknown; token_endpoint_auth_method?: unknown };
      if (typeof j.client_id !== 'string' || !j.client_id) throw new Error('the app sent no client id');
      const clientSecret = typeof j.client_secret === 'string' && j.client_secret ? j.client_secret : undefined;
      const said = typeof j.token_endpoint_auth_method === 'string' ? j.token_endpoint_auth_method : '';
      return { clientId: j.client_id, ...(clientSecret ? { clientSecret } : {}), authMethod: !clientSecret ? 'none' : said === 'client_secret_basic' ? said : 'client_secret_post' };
    },

    authorizeUrl({ at, client, redirectUri, challenge, state }) {
      // the address may carry a query of its own
      const u = new URL(at.authorizeUrl);
      const q: Record<string, string> = {
        response_type: 'code', client_id: client.clientId, redirect_uri: redirectUri, code_challenge: challenge,
        code_challenge_method: 'S256', state, resource: at.resource, ...(at.scopes.length ? { scope: at.scopes.join(' ') } : {}),
      };
      for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
      return u.toString();
    },

    exchange({ at, client, redirectUri, code, verifier }) {
      return tokenRequest(at, client, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }, "The app didn't finish the sign-in");
    },

    refresh({ at, client, refreshToken }) {
      return tokenRequest(at, client, { grant_type: 'refresh_token', refresh_token: refreshToken }, "The app didn't renew the sign-in");
    },

    async listTools(url, token) {
      const tools: RemoteTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < TOOL_PAGES_MAX; page++) {
        const res = await rpc(url, token, 'tools/list', cursor ? { cursor } : {}, CALL_TIMEOUT_MS) as { tools?: unknown; nextCursor?: unknown };
        for (const t of Array.isArray(res.tools) ? res.tools as Record<string, unknown>[] : []) {
          if (typeof t?.name !== 'string' || !t.name) continue;
          tools.push({ name: t.name, ...(typeof t.description === 'string' ? { description: t.description } : {}), ...(t.inputSchema && typeof t.inputSchema === 'object' ? { inputSchema: t.inputSchema } : {}) });
        }
        cursor = typeof res.nextCursor === 'string' && res.nextCursor ? res.nextCursor : undefined;
        if (!cursor) break;
      }
      return tools;
    },

    async callTool(url, token, name, args) {
      const res = await rpc(url, token, 'tools/call', { name, arguments: args }, TOOL_TIMEOUT_MS) as { content?: { type?: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
      let text = (res.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text!).join('\n');
      // a tool that answers with structured data alone
      if (!text && res.structuredContent !== undefined) text = JSON.stringify(res.structuredContent);
      return { text: text.length > ANSWER_MAX_CHARS ? text.slice(0, ANSWER_MAX_CHARS) : text, isError: !!res.isError };
    },

    forget(url) {
      for (const k of [...sessions.keys()]) if (k.startsWith(`${url}\n`)) sessions.delete(k);
    },
  };
}
