/**
 * "Composio for You", the user's own Composio account as Claude.ai and Codex use it: one MCP server
 * (`connect.composio.dev/mcp`) behind standard MCP OAuth (dynamic client registration, PKCE, public client, refresh
 * tokens). This is the slice the apps service uses, behind an interface so tests can stand in for it.
 * `composioConnect()` is the real one, a minimal MCP client over fetch (JSON or SSE answers).
 */
import { createHash, randomBytes } from 'node:crypto';

export const MCP_URL = 'https://connect.composio.dev/mcp';
const AUTHORIZE_URL = 'https://connect.composio.dev/oauth/authorize';
const TOKEN_URL = 'https://login.composio.dev/oauth2/token';
const REGISTER_URL = 'https://login.composio.dev/oauth2/register';
const SCOPES = 'openid profile email offline_access';
const PROTOCOL_VERSION = '2025-06-18';
/** a tool may run up to 3 minutes on Composio's side (its workbench limit), plus the apps' own latency */
const TOOL_TIMEOUT_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 30_000;

export interface ComposioTokens {
  accessToken: string;
  refreshToken?: string;
  /** ms since the epoch */
  expiresAt: number;
  /** who signed in (the id token's email), when Composio says */
  account?: string;
}

/** A tool's answer: its text content (Composio's JSON) and whether it reported an error. */
export interface ComposioToolResult { text: string; isError: boolean }

/** An HTTP failure with its status (401: the access token is no good; 400 from the token URL: sign in again). */
export class ComposioHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface ComposioConnect {
  /** registers AppuBot as an OAuth client sending the browser back to `redirectUri` */
  register(redirectUri: string): Promise<{ clientId: string }>;
  authorizeUrl(p: { clientId: string; redirectUri: string; challenge: string; state: string }): string;
  exchange(p: { clientId: string; redirectUri: string; code: string; verifier: string }): Promise<ComposioTokens>;
  refresh(p: { clientId: string; refreshToken: string }): Promise<ComposioTokens>;
  /** one MCP tool call with this access token */
  callTool(accessToken: string, name: string, args: Record<string, unknown>): Promise<ComposioToolResult>;
}

/** PKCE: a verifier and its S256 challenge. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** The email (else name) in an OpenID id token; the token is only read, never trusted for anything else. */
export function accountOf(idToken: unknown): string | undefined {
  if (typeof idToken !== 'string') return undefined;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: unknown; name?: unknown };
    const v = typeof claims.email === 'string' && claims.email ? claims.email : typeof claims.name === 'string' && claims.name ? claims.name : undefined;
    return v?.slice(0, 200);
  } catch { return undefined; }
}

function tokensOf(j: Record<string, unknown>): ComposioTokens {
  if (typeof j.access_token !== 'string') throw new Error('Composio sent no access token');
  const expiresIn = typeof j.expires_in === 'number' ? j.expires_in : 3600;
  return {
    accessToken: j.access_token,
    refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : undefined,
    expiresAt: Date.now() + expiresIn * 1000,
    account: accountOf(j.id_token),
  };
}

async function failure(r: Response, what: string): Promise<ComposioHttpError> {
  const body = (await r.text().catch(() => '')).replace(/\s+/g, ' ').trim();
  let msg = body;
  try {
    const j = JSON.parse(body) as { error_description?: unknown; error?: unknown; message?: unknown };
    const m = j.error_description ?? j.message ?? j.error;
    if (typeof m === 'string' && m) msg = m;
  } catch { /* not JSON */ }
  return new ComposioHttpError(r.status, `${what} (HTTP ${r.status})${msg ? `: ${msg.slice(0, 200)}` : ''}`);
}

/** The JSON-RPC message answering `id` in a response that is JSON or a server-sent event stream. */
export function rpcAnswer(body: string, contentType: string | null, id: number): { result?: unknown; error?: { message?: string } } | undefined {
  const messages: unknown[] = [];
  if (contentType?.includes('text/event-stream')) {
    // events are separated by blank lines; a `data:` field may span several lines
    for (const ev of body.split(/\r?\n\r?\n/)) {
      const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try { messages.push(JSON.parse(data)); } catch { /* a partial or foreign event */ }
    }
  } else if (body.trim()) {
    try { const j = JSON.parse(body) as unknown; messages.push(...(Array.isArray(j) ? j : [j])); } catch { /* fall through */ }
  }
  return messages.find((m): m is { id: number; result?: unknown; error?: { message?: string } } => !!m && typeof m === 'object' && (m as { id?: unknown }).id === id);
}

export function composioConnect(fetchImpl: typeof fetch = fetch): ComposioConnect {
  /** MCP sessions per access token (a new token starts a new one) */
  const sessions = new Map<string, Promise<string | undefined>>();
  let nextId = 1;

  const post = (token: string, body: unknown, sid: string | undefined, ms: number): Promise<Response> => fetchImpl(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'mcp-protocol-version': PROTOCOL_VERSION,
      ...(sid ? { 'mcp-session-id': sid } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });

  const open = (token: string): Promise<string | undefined> => {
    let s = sessions.get(token);
    if (!s) {
      s = (async () => {
        const id = nextId++;
        const r = await post(token, { jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'AppuBot', version: '1' } } }, undefined, CALL_TIMEOUT_MS);
        if (!r.ok) throw await failure(r, "Couldn't reach Composio");
        const sid = r.headers.get('mcp-session-id') ?? undefined;
        await r.text().catch(() => '');
        const n = await post(token, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid, CALL_TIMEOUT_MS);
        await n.text().catch(() => '');
        return sid;
      })();
      // old tokens' sessions go (a token lives an hour)
      if (sessions.size > 4) sessions.delete(sessions.keys().next().value!);
      sessions.set(token, s);
      s.catch(() => { if (sessions.get(token) === s) sessions.delete(token); });
    }
    return s;
  };

  const form = async (url: string, params: Record<string, string>, what: string): Promise<ComposioTokens> => {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    if (!r.ok) throw await failure(r, what);
    return tokensOf(await r.json() as Record<string, unknown>);
  };

  return {
    async register(redirectUri) {
      const r = await fetchImpl(REGISTER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_name: 'AppuBot', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!r.ok) throw await failure(r, "Composio didn't register AppuBot");
      const j = await r.json() as { client_id?: unknown };
      if (typeof j.client_id !== 'string') throw new Error('Composio sent no client id');
      return { clientId: j.client_id };
    },

    authorizeUrl({ clientId, redirectUri, challenge, state }) {
      const q = new URLSearchParams({
        response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
        code_challenge_method: 'S256', state, scope: SCOPES, resource: MCP_URL,
      });
      return `${AUTHORIZE_URL}?${q}`;
    },

    exchange({ clientId, redirectUri, code, verifier }) {
      return form(TOKEN_URL, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }, "Composio didn't finish the sign-in");
    },

    refresh({ clientId, refreshToken }) {
      return form(TOKEN_URL, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }, "Composio didn't renew the sign-in");
    },

    async callTool(token, name, args) {
      for (let attempt = 0; ; attempt++) {
        const sid = await open(token);
        const id = nextId++;
        const r = await post(token, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, sid, TOOL_TIMEOUT_MS);
        // the MCP session ended on Composio's side: start another once
        if ((r.status === 404 || r.status === 400) && sid && attempt === 0) { await r.text().catch(() => ''); sessions.delete(token); continue; }
        if (!r.ok) throw await failure(r, "Couldn't reach Composio");
        const msg = rpcAnswer(await r.text(), r.headers.get('content-type'), id);
        if (!msg) throw new Error('Composio sent no answer');
        if (msg.error) throw new Error(`Composio: ${msg.error.message ?? 'the call failed'}`);
        const res = (msg.result ?? {}) as { content?: { type?: string; text?: string }[]; isError?: boolean };
        const text = (res.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text!).join('\n');
        return { text, isError: !!res.isError };
      }
    },
  };
}
