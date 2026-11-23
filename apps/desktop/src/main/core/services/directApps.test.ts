import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { GatewayClient, GatewayError } from '@appubot/client';
import { isDirectApp } from '@appubot/protocol';
import type { CreateSessionOptions, McpServerStdio } from '@appubot/agent-runtime';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import type { ComposioConnect } from './composioConnect';
import { DIRECT_APPS, directToolSlug, taskWords, toolScore } from './directApps';
import { challengeParams, issuerMetadataUrls, remoteMcp, resourceMetadataUrls } from './mcpRemote';

const WS = WebSocket as unknown as typeof globalThis.WebSocket;

/** An app's own server as the service meets it: the MCP sign-in (who to ask, registering, tokens) and a few tools. */
class FakeVendor {
  server!: Server;
  base = '';
  registered: { redirect_uris: string[]; client_name: string }[] = [];
  tokens = new Set<string>();
  refreshTokens = new Set<string>();
  refreshes = 0;
  /** the refresh token is no longer taken */
  dead = false;
  calls: { name: string; args: unknown; open: boolean }[] = [];
  lists = 0;
  private n = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => { void this.handle(req, res).catch(() => { res.statusCode = 500; res.end(); }); });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> { return new Promise((resolve) => this.server.close(() => resolve())); }

  private issue() {
    const n = ++this.n;
    this.tokens.add(`at_${n}`);
    this.refreshTokens.add(`rt_${n}`);
    return { access_token: `at_${n}`, refresh_token: `rt_${n}`, expires_in: 3600, token_type: 'Bearer' };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.base);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const json = (status: number, v: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(v)); };

    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json(200, { resource: `${this.base}/mcp`, authorization_servers: [this.base], scopes_supported: ['things'] });
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, { issuer: this.base, authorization_endpoint: `${this.base}/authorize?tenant=t1`, token_endpoint: `${this.base}/token`, registration_endpoint: `${this.base}/register`, scopes_supported: ['things', 'offline_access'], code_challenge_methods_supported: ['S256'] });
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      this.registered.push(JSON.parse(body) as { redirect_uris: string[]; client_name: string });
      return json(201, { client_id: `client_${this.registered.length}`, token_endpoint_auth_method: 'none' });
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const p = new URLSearchParams(body);
      if (p.get('resource') !== `${this.base}/mcp` || !p.get('client_id')) return json(400, { error: 'invalid_request' });
      if (p.get('grant_type') === 'authorization_code') {
        if (p.get('code') !== 'good-code' || !p.get('code_verifier')) return json(400, { error: 'invalid_grant' });
        return json(200, this.issue());
      }
      this.refreshes++;
      if (this.dead || !this.refreshTokens.has(p.get('refresh_token') ?? '')) return json(400, { error: 'invalid_grant', error_description: 'The sign-in has ended' });
      return json(200, this.issue());
    }
    if (req.method === 'POST' && (url.pathname === '/mcp' || url.pathname === '/open')) {
      const open = url.pathname === '/open';
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!open && (!token || !this.tokens.has(token))) {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${this.base}/.well-known/oauth-protected-resource/mcp"` });
        res.end();
        return;
      }
      const msg = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: unknown } };
      const answer = (result: unknown) => json(200, { jsonrpc: '2.0', id: msg.id, result }, { 'mcp-session-id': 'session-1' });
      switch (msg.method) {
        case 'initialize': return answer({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
        case 'notifications/initialized': res.writeHead(202); res.end(); return;
        case 'tools/list':
          this.lists++;
          return answer({ tools: open
            ? [{ name: 'docs_search', description: 'Search the documentation', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }]
            : [
              { name: 'create_invoice', description: 'Create and send an invoice to a customer', inputSchema: { type: 'object', properties: { amount: { type: 'number' }, email: { type: 'string' } }, required: ['amount'] } },
              { name: 'list_transactions', description: 'List the latest transactions of the account', inputSchema: { type: 'object', properties: {} } },
              { name: 'big_report', description: 'A long yearly report', inputSchema: { type: 'object', properties: {} } },
              { name: 'broken', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
            ] });
        case 'tools/call': {
          this.calls.push({ name: msg.params?.name ?? '', args: msg.params?.arguments, open });
          if (msg.params?.name === 'broken') return answer({ content: [{ type: 'text', text: 'The account is frozen' }], isError: true });
          if (msg.params?.name === 'big_report') return answer({ content: [{ type: 'text', text: 'row '.repeat(30_000) }] });
          return answer({ content: [{ type: 'text', text: JSON.stringify({ ok: true, ran: msg.params?.name, with: msg.params?.arguments }) }] });
        }
        default: return json(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method' } });
      }
    }
    res.statusCode = 404;
    res.end();
  }
}

const PAYPAL = 'paypal_direct';
const LEARN = 'microsoftlearn_direct';

let core: Core;
let runtime: FakeRuntime;
let root: string;
let owner: GatewayClient;
const vendor = new FakeVendor();
const opened: string[] = [];
let shown = 0;

/** Composio is never reached here: nobody signs in to it. */
const noComposio = new Proxy({}, { get: () => () => { throw new Error('Composio is not part of this test'); } }) as ComposioConnect;

async function connectAs(token: string): Promise<GatewayClient> {
  const c = new GatewayClient({ baseUrl: `http://127.0.0.1:${core.gateway.port}`, token, device: { id: `direct-${token.slice(0, 6)}`, name: 'direct-test', platform: 'cli' }, WebSocketImpl: WS, callTimeoutMs: 10_000 });
  await new Promise<void>((resolve, reject) => {
    const off = c.onState((s, err) => { if (s === 'connected') { off(); resolve(); } if (s === 'unauthorized') { off(); reject(new Error(err)); } });
    c.connect();
  });
  return c;
}

async function failure(p: Promise<unknown>): Promise<GatewayError> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(GatewayError);
  return e as GatewayError;
}

const appsFile = () => { core.ctx.store.flush(); return JSON.parse(readFileSync(join(root, 'data', 'apps.json'), 'utf8')) as { direct?: Record<string, { tokens?: { accessToken: string }; client?: { clientId: string }; expired?: boolean; open?: boolean }> }; };

async function comeBack(query: Record<string, string>): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${core.gateway.port}/apps/signed-in?${new URLSearchParams(query)}`);
  expect(res.status).toBe(200);
  return res.text();
}

const bridgeApps = (o: CreateSessionOptions | undefined): string | undefined => (o?.mcpServers?.find((s) => s.name === 'appubot') as McpServerStdio | undefined)?.env?.APPUBOT_APPS;

async function agentFor(): Promise<{ agent: GatewayClient; botId: string; threadId: string }> {
  const [appu] = await owner.call('bots.list');
  const t = (await owner.call('threads.list', {})).find((x) => x.botId === appu!.id) ?? await owner.call('threads.start', { botId: appu!.id });
  return { agent: await connectAs(core.ctx.auth.issueAgentToken({ threadId: t.id, botId: appu!.id })), botId: appu!.id, threadId: t.id };
}

beforeAll(async () => {
  await vendor.start();
  root = mkdtempSync(join(tmpdir(), 'appubot-direct-'));
  // the apps' real addresses lead to the stand-in; nothing else leaves the machine
  const mapped = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let u = String(input);
    if (u.startsWith('https://mcp.paypal.com/')) u = u.replace('https://mcp.paypal.com', vendor.base);
    else if (u.startsWith('https://learn.microsoft.com/api/mcp')) u = `${vendor.base}/open`;
    else if (u.startsWith('https://')) return Promise.reject(new Error(`no network in tests: ${u}`));
    return fetch(u, init);
  }) as typeof fetch;
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: (url) => { opened.push(url); },
    showApp: () => { shown++; },
    composioConnect: () => noComposio,
    remoteMcp: () => remoteMcp(mapped, { loopback: true }),
    openTerminal: () => undefined,
    nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, host: '127.0.0.1', quiet: true,
    computerBackends: () => [], helperTransport: () => null,
  });
  await core.start();
  await core.services.providers.refresh();
  owner = await connectAs(core.ownerToken);
});

afterAll(async () => {
  owner?.close();
  await core?.stop();
  await vendor.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('apps on their own servers', () => {
  it('lists them in the catalog beside Composio’s, with no Composio sign-in', async () => {
    const status = await owner.call('apps.status');
    expect(status).toMatchObject({ configured: false, direct: true, pending: [] });
    // signed out of Composio, the connections still answer
    expect(await owner.call('apps.connections')).toEqual([]);
    const found = await owner.call('apps.catalog', { search: 'paypal' });
    // Composio's own PayPal can't be connected, so the one that can is the PayPal the page shows
    expect(found.toolkits.filter((t) => t.name === 'PayPal').map((t) => t.slug)).toEqual([PAYPAL]);
    expect(found.toolkits[0]!.slug).toBe(PAYPAL);
    expect(found.toolkits[0]).toMatchObject({ name: 'PayPal', authKind: 'oauth', logo: 'https://logos.composio.dev/api/paypal' });
    expect((await owner.call('apps.catalog', { slugs: [LEARN] })).toolkits[0]).toMatchObject({ name: 'Microsoft Learn', authKind: 'none' });
    expect((await owner.call('apps.catalog', { category: 'payment-processing', limit: 200 })).toolkits.map((t) => t.slug)).toEqual(expect.arrayContaining([PAYPAL, 'dodopayments_direct']));
    for (const d of DIRECT_APPS) {
      expect(isDirectApp(d.slug)).toBe(true);
      expect(d.url.startsWith('https://')).toBe(true);
    }
    expect(new Set(DIRECT_APPS.map((d) => d.slug)).size).toBe(DIRECT_APPS.length);
  });

  it('signs in on the app’s own page: registers once, PKCE, and only the return it started', async () => {
    const started = await owner.call('apps.connect', { slug: PAYPAL });
    const url = new URL(opened.at(-1)!);
    expect(started.redirectUrl).toBe(url.toString());
    // the page the app named, its own query kept
    expect(url.origin + url.pathname).toBe(`${vendor.base}/authorize`);
    expect(url.searchParams.get('tenant')).toBe('t1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(`${vendor.base}/mcp`);
    expect(url.searchParams.get('scope')).toBe('things offline_access');
    expect(url.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${core.gateway.port}/apps/signed-in`);
    expect(vendor.registered).toHaveLength(1);
    expect(vendor.registered[0]).toMatchObject({ client_name: 'AppuBot', redirect_uris: [`http://127.0.0.1:${core.gateway.port}/apps/signed-in`] });
    expect((await owner.call('apps.status')).pending).toEqual([PAYPAL]);

    // a return nobody started changes nothing
    expect(await comeBack({ code: 'good-code', state: 'not-ours' })).toContain('Not signed in');
    expect(core.services.composio.connectedSlugs()).toEqual([]);

    // a second click starts over with the same registration; the first page's return is then nobody's
    await owner.call('apps.connect', { slug: PAYPAL });
    expect(vendor.registered).toHaveLength(1);
    expect(await comeBack({ code: 'good-code', state: url.searchParams.get('state')! })).toContain('Not signed in');

    const again = new URL(opened.at(-1)!);
    expect(await comeBack({ code: 'good-code', state: again.searchParams.get('state')! })).toContain('PayPal is connected');
    expect(shown).toBe(1);
    expect(core.services.composio.connectedSlugs()).toEqual([PAYPAL]);
    expect(await owner.call('apps.connections')).toEqual([{ slug: PAYPAL, connectedAccountId: `direct:${PAYPAL}`, status: 'ACTIVE' }]);
    expect((await owner.call('apps.status')).pending).toEqual([]);
    // the tokens stay in the owner-only file, never on the wire
    expect(appsFile().direct?.[PAYPAL]?.tokens?.accessToken).toMatch(/^at_/);
    expect(JSON.stringify(await owner.call('apps.status'))).not.toContain('at_');
  });

  it('refuses a sign-in the app turns down, and one asked for from another device', async () => {
    await owner.call('apps.connect', { slug: PAYPAL });
    const url = new URL(opened.at(-1)!);
    const before = appsFile().direct?.[PAYPAL]?.tokens?.accessToken;
    expect(await comeBack({ code: 'bad-code', state: url.searchParams.get('state')! })).toContain('PayPal isn’t connected');
    // the connection made before is still the one in use
    expect(appsFile().direct?.[PAYPAL]?.tokens?.accessToken).toBe(before);
    const e = await failure(owner.call('apps.connect', { slug: PAYPAL, open: 'caller' }));
    expect(e.code).toBe('unsupported');
    expect(e.message).toMatch(/on the computer itself/);
  });

  it('adds an app that needs no sign-in once its server answers', async () => {
    expect(await owner.call('apps.connect', { slug: LEARN })).toEqual({});
    expect(core.services.composio.connectedSlugs()).toEqual([PAYPAL, LEARN]);
    expect(appsFile().direct?.[LEARN]).toMatchObject({ open: true });
  });

  it('gives a bot their tools through the apps tools, and only while the app is its own', async () => {
    const { agent, botId, threadId } = await agentFor();
    try {
      // a bot with a connected app gets the apps tools at its next turn
      const done = new Promise<void>((resolve) => { const off = owner.on('message.completed', (p) => { if (p.threadId === threadId) { off(); resolve(); } }); });
      await owner.call('chat.send', { threadId, text: 'fail fast' });
      await done;
      expect(bridgeApps(runtime.created.filter((o) => o.env?.APPUBOT_THREAD_ID === threadId).at(-1))).toBe('1');

      const found = await agent.call('agent.apps.search', { queries: [{ use_case: 'send an invoice to a customer' }, { use_case: 'search the documentation for azure functions' }] });
      expect(found.text).toMatch(/^Your apps: Microsoft Learn \(microsoftlearn_direct\), PayPal \(paypal_direct\)\./);
      const data = JSON.parse(found.text.split('\n\n')[1]!).own_server_apps as { results: { tools: { tool_slug: string; app: string }[] }[]; tool_schemas: Record<string, { input_schema: unknown }> };
      expect(data.results[0]!.tools[0]).toMatchObject({ tool_slug: 'PAYPAL_DIRECT__create_invoice', app: PAYPAL });
      expect(data.results[1]!.tools[0]).toMatchObject({ tool_slug: 'MICROSOFTLEARN_DIRECT__docs_search', app: LEARN });
      expect(data.tool_schemas['PAYPAL_DIRECT__create_invoice']!.input_schema).toMatchObject({ required: ['amount'] });
      // a task that names the app finds that app's tools, whatever they are called
      const named = JSON.parse((await agent.call('agent.apps.search', { queries: [{ use_case: 'what can PayPal do' }] })).text.split('\n\n')[1]!).own_server_apps as { results: { tools: { app: string }[] }[] };
      expect(named.results[0]!.tools.length).toBeGreaterThan(1);
      expect(named.results[0]!.tools.every((t) => t.app === PAYPAL)).toBe(true);

      const schemas = JSON.parse((await agent.call('agent.apps.schemas', { tool_slugs: ['PAYPAL_DIRECT__list_transactions', 'PAYPAL_DIRECT__nope'] })).text) as { tool_schemas: Record<string, { toolkit?: string; error?: string }> };
      expect(schemas.tool_schemas['PAYPAL_DIRECT__list_transactions']).toMatchObject({ toolkit: PAYPAL });
      expect(schemas.tool_schemas['PAYPAL_DIRECT__nope']!.error).toMatch(/no tool called nope/);

      const ran = await agent.call('agent.apps.execute', { tools: [
        { tool_slug: 'PAYPAL_DIRECT__create_invoice', arguments: { amount: 12 } },
        { tool_slug: 'paypal_direct__list_transactions', arguments: {} },
        { tool_slug: 'MICROSOFTLEARN_DIRECT__docs_search', arguments: { query: 'functions' } },
        { tool_slug: 'PAYPAL_DIRECT__broken', arguments: {} },
      ] });
      expect(ran.isError).toBe(false);
      const results = (JSON.parse(ran.text) as { results: { tool_slug: string; response: { successful: boolean; data?: { ran?: string; with?: unknown }; error?: string } }[] }).results;
      expect(results[0]!.response).toMatchObject({ successful: true, data: { ran: 'create_invoice', with: { amount: 12 } } });
      expect(results[1]!.response).toMatchObject({ successful: true, data: { ran: 'list_transactions' } });
      expect(results[2]!.response).toMatchObject({ successful: true, data: { ran: 'docs_search' } });
      expect(results[3]!.response).toMatchObject({ successful: false, error: 'The account is frozen' });
      // the open server was reached without a token, the other with one
      expect(vendor.calls.find((c) => c.name === 'docs_search')!.open).toBe(true);
      // the tools were listed once per app, not once per call
      expect(vendor.lists).toBe(2);

      // an answer too large to return is kept in the bot's folder
      const big = JSON.parse((await agent.call('agent.apps.execute', { tools: [{ tool_slug: 'PAYPAL_DIRECT__big_report', arguments: {} }] })).text) as { results: { response: { data: string; full_answer: { path: string; bytes: number } } }[] };
      const kept = big.results[0]!.response.full_answer;
      expect(kept.bytes).toBe(120_000);
      expect(existsSync(kept.path)).toBe(true);
      expect(kept.path).toContain(join('inbox', 'apps'));
      expect(big.results[0]!.response.data.length).toBeLessThan(2100);

      // turned off for this bot: its tools are no longer the bot's
      await owner.call('bots.update', { id: botId, patch: { appsOff: [PAYPAL] } });
      expect((await failure(agent.call('agent.apps.execute', { tools: [{ tool_slug: 'PAYPAL_DIRECT__create_invoice', arguments: {} }] }))).message).toMatch(/PayPal isn't one of your apps/);
      expect((await agent.call('agent.apps.search', { queries: [{ use_case: 'invoice' }] })).text).toMatch(/^Your apps: Microsoft Learn \(microsoftlearn_direct\)\./);
      await owner.call('bots.update', { id: botId, patch: { appsOff: [] } });
    } finally { agent.close(); }
  }, 30_000);

  it('renews a token the app refuses, and reads as needing a new sign-in once it can’t', async () => {
    const { agent } = await agentFor();
    try {
      const first = appsFile().direct![PAYPAL]!.tokens!.accessToken;
      vendor.tokens.delete(first);
      const ran = await agent.call('agent.apps.execute', { tools: [{ tool_slug: 'PAYPAL_DIRECT__list_transactions', arguments: {} }] });
      expect(ran.isError).toBe(false);
      expect(vendor.refreshes).toBe(1);
      expect(appsFile().direct![PAYPAL]!.tokens!.accessToken).not.toBe(first);

      vendor.dead = true;
      vendor.tokens.clear();
      const gone = await agent.call('agent.apps.execute', { tools: [{ tool_slug: 'PAYPAL_DIRECT__list_transactions', arguments: {} }] });
      expect(gone.isError).toBe(true);
      expect(gone.text).toMatch(/PayPal's sign-in ended/);
      expect(appsFile().direct![PAYPAL]).toMatchObject({ expired: true });
      expect(core.services.composio.connectedSlugs()).toEqual([LEARN]);
      expect(await owner.call('apps.connections')).toEqual(expect.arrayContaining([{ slug: PAYPAL, connectedAccountId: `direct:${PAYPAL}`, status: 'EXPIRED' }]));
    } finally { agent.close(); }
  }, 20_000);

  it('disconnects, keeping the registration for the next sign-in', async () => {
    expect(await owner.call('apps.disconnect', { connectedAccountId: `direct:${PAYPAL}`, slug: PAYPAL })).toEqual({ ok: true });
    expect(appsFile().direct![PAYPAL]).toMatchObject({ client: { clientId: 'client_1' } });
    expect(appsFile().direct![PAYPAL]!.tokens).toBeUndefined();
    await owner.call('apps.disconnect', { connectedAccountId: `direct:${LEARN}`, slug: LEARN });
    expect(appsFile().direct![LEARN]).toBeUndefined();
    expect(await owner.call('apps.connections')).toEqual([]);
    expect(core.services.composio.connectedSlugs()).toEqual([]);
    vendor.dead = false;
    await owner.call('apps.connect', { slug: PAYPAL });
    expect(vendor.registered).toHaveLength(1);
    const url = new URL(opened.at(-1)!);
    expect(await comeBack({ code: 'good-code', state: url.searchParams.get('state')! })).toContain('PayPal is connected');
    await vi.waitFor(() => expect(core.services.composio.connectedSlugs()).toEqual([PAYPAL]));
  });

  it('offers a bot the app that can be connected when it asks for Composio’s that can’t', async () => {
    const { agent } = await agentFor();
    try {
      await owner.call('apps.disconnect', { connectedAccountId: `direct:${PAYPAL}`, slug: PAYPAL });
      const card = new Promise<{ form?: { app?: { slug: string; state: string } } }>((resolve) => {
        const off = owner.on('question.asked', (q) => { off(); resolve(q); });
      });
      const asked = agent.call('agent.apps.request', { slug: 'paypal', reason: 'To send the invoice', timeoutSec: 30 });
      // no Composio sign-in is asked of anyone: the card is straight at Connect
      expect((await card).form!.app).toMatchObject({ slug: PAYPAL, state: 'connect' });
      await owner.call('apps.connect', { slug: PAYPAL });
      const url = new URL(opened.at(-1)!);
      await comeBack({ code: 'good-code', state: url.searchParams.get('state')! });
      expect(await asked).toMatchObject({ slug: PAYPAL, name: 'PayPal', connected: true, on: true });
    } finally { agent.close(); }
  }, 20_000);
});

describe('the pieces', () => {
  it('names tools, reads a task’s words and ranks tools by them', () => {
    expect(directToolSlug('paypal_direct', 'create_invoice')).toBe('PAYPAL_DIRECT__create_invoice');
    expect(taskWords('Send the invoice to a customer, please')).toEqual(['send', 'invoice', 'customer']);
    const words = taskWords('send an invoice');
    expect(toolScore(words, { name: 'create_invoice', description: 'Create and send an invoice' }, [])).toBeGreaterThan(toolScore(words, { name: 'list_transactions', description: 'Send nothing' }, []));
    expect(toolScore(taskWords('paypal'), { name: 'paypal_balance' }, ['paypal'])).toBe(0);
  });

  it('finds where a server says to sign in', () => {
    expect(challengeParams('Bearer realm="x", resource_metadata="https://a.example/.well-known/oauth-protected-resource/mcp", scope="read write"')).toEqual({ realm: 'x', resource_metadata: 'https://a.example/.well-known/oauth-protected-resource/mcp', scope: 'read write' });
    expect(challengeParams(null)).toEqual({});
    expect(resourceMetadataUrls('https://a.example/mcp')).toEqual(['https://a.example/.well-known/oauth-protected-resource/mcp', 'https://a.example/.well-known/oauth-protected-resource']);
    expect(resourceMetadataUrls('https://a.example/mcp', 'https://a.example/meta')[0]).toBe('https://a.example/meta');
    expect(issuerMetadataUrls('https://auth.example/t/1')).toEqual([
      'https://auth.example/.well-known/oauth-authorization-server/t/1', 'https://auth.example/.well-known/openid-configuration/t/1',
      'https://auth.example/t/1/.well-known/openid-configuration', 'https://auth.example/t/1/.well-known/oauth-authorization-server',
    ]);
  });

  it('takes only https addresses from a server', async () => {
    const plain = remoteMcp((() => Promise.resolve(new Response('', { status: 401 }))) as typeof fetch);
    await expect(plain.signIn('http://127.0.0.1:1/mcp')).rejects.toThrow(/https/);
  });
});
