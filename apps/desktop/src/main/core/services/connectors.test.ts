/**
 * Custom connectors: MCP servers the person adds, reached by AppuBot itself (a local command over stdio, a remote one
 * over streamable HTTP or SSE, with headers or the standard sign-in), their values sealed and never on the wire, and
 * their tools offered to the bots that may use them through the bridge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { GatewayClient } from '@appubot/client';
import type { Connector } from '@appubot/protocol';
import type { CreateSessionOptions, McpServerStdio } from '@appubot/agent-runtime';
import { createCore, type Core } from '../app';
import { checkRole } from '../handlers';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { agentToolName, answerContent, botMayUse, connectorSlug, plainReason } from './connectors';

const WS = WebSocket as unknown as typeof globalThis.WebSocket;
const LOCAL = join(__dirname, 'fixtures', 'mcp-local.mjs');

/** a keychain stand-in: sealed text never holds the plain text */
const box = {
  encrypt: (s: string) => `sealed:${Buffer.from(s).toString('base64').split('').reverse().join('')}`,
  decrypt: (s: string) => Buffer.from(s.slice(7).split('').reverse().join(''), 'base64').toString(),
};

/** A remote MCP server: one path that wants a key header, one behind the standard sign-in, one over SSE. */
class Remote {
  server!: Server;
  base = '';
  tokens = new Set<string>();
  registered = 0;
  calls: string[] = [];
  private sse = new Map<string, SSEServerTransport>();

  private mcp(): McpServer {
    const s = new McpServer({ name: 'test-remote', version: '9' });
    s.registerTool('lookup', { description: 'Looks a word up', inputSchema: { word: z.string() } }, async ({ word }) => { this.calls.push(word); return { content: [{ type: 'text', text: `${word}: a word` }] }; });
    s.registerTool('weather', { description: 'Weather for a city', inputSchema: { city: z.string() } }, async ({ city }) => ({ content: [{ type: 'text', text: `Sunny in ${city}` }] }));
    return s;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) res.statusCode = 500; res.end(); }); });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> { this.server.closeAllConnections(); return new Promise((r) => this.server.close(() => r())); }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.base);
    const json = (status: number, v: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    const body = async () => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); return Buffer.concat(chunks).toString('utf8'); };
    const streamable = async () => {
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await this.mcp().connect(t);
      await t.handleRequest(req, res, JSON.parse(await body()) as unknown);
    };
    if (url.pathname === '/keyed') {
      if (req.headers['x-api-key'] !== 'k1') return json(401, { error: 'bad key' });
      return streamable();
    }
    if (url.pathname === '/signed') {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token || !this.tokens.has(token)) {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${this.base}/.well-known/oauth-protected-resource/signed"` });
        return void res.end();
      }
      return streamable();
    }
    if (url.pathname === '/.well-known/oauth-protected-resource/signed') return json(200, { resource: `${this.base}/signed`, authorization_servers: [`${this.base}/auth`] });
    if (url.pathname === '/.well-known/oauth-authorization-server/auth') {
      return json(200, { issuer: `${this.base}/auth`, authorization_endpoint: `${this.base}/authorize`, token_endpoint: `${this.base}/token`, registration_endpoint: `${this.base}/register`, code_challenge_methods_supported: ['S256'] });
    }
    if (url.pathname === '/register') { await body(); this.registered++; return json(201, { client_id: `client_${this.registered}`, token_endpoint_auth_method: 'none' }); }
    if (url.pathname === '/token') {
      const p = new URLSearchParams(await body());
      if (p.get('code') !== 'good-code' || !p.get('code_verifier')) return json(400, { error: 'invalid_grant' });
      this.tokens.add('at_1');
      return json(200, { access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.pathname === '/sse' && req.method === 'GET') {
      const t = new SSEServerTransport('/messages', res);
      this.sse.set(t.sessionId, t);
      res.on('close', () => this.sse.delete(t.sessionId));
      await this.mcp().connect(t);
      return;
    }
    if (url.pathname === '/messages' && req.method === 'POST') {
      const t = this.sse.get(url.searchParams.get('sessionId') ?? '');
      if (!t) return json(404, { error: 'no session' });
      return t.handlePostMessage(req, res, JSON.parse(await body()) as unknown);
    }
    res.statusCode = 404;
    res.end();
  }
}

let core: Core;
let runtime: FakeRuntime;
let root: string;
let owner: GatewayClient;
const remote = new Remote();
const opened: string[] = [];

async function connectAs(token: string): Promise<GatewayClient> {
  const c = new GatewayClient({ baseUrl: `http://127.0.0.1:${core.gateway.port}`, token, device: { id: `con-${token.slice(0, 6)}`, name: 'connectors-test', platform: 'cli' }, WebSocketImpl: WS, callTimeoutMs: 90_000 });
  await new Promise<void>((resolve, reject) => {
    const off = c.onState((s, err) => { if (s === 'connected') { off(); resolve(); } if (s === 'unauthorized') { off(); reject(new Error(err)); } });
    c.connect();
  });
  return c;
}

async function agentFor(botId: string): Promise<GatewayClient> {
  const t = core.services.threads.chatFor(botId);
  return connectAs(core.ctx.auth.issueAgentToken({ threadId: t.id, botId }));
}

const file = () => { core.ctx.store.flush(); (core.services.connectors as unknown as { file: { flush(): void } }).file.flush(); return readFileSync(join(root, 'data', 'connectors.json'), 'utf8'); };
const bridgeConnectors = (o: CreateSessionOptions | undefined): string | undefined => (o?.mcpServers?.find((s) => s.name === 'appubot') as McpServerStdio | undefined)?.env?.APPUBOT_CONNECTORS;

beforeAll(async () => {
  await remote.start();
  root = mkdtempSync(join(tmpdir(), 'appubot-connectors-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: (url) => { opened.push(url); },
    openTerminal: () => undefined, nativeNotify: () => undefined, secretBox: box,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, host: '127.0.0.1', quiet: true,
    computerBackends: () => [], helperTransport: () => null,
  });
  await core.start();
  await core.services.providers.refresh();
  owner = await connectAs(core.ownerToken);
}, 30_000);

afterAll(async () => {
  owner?.close();
  await core?.stop();
  await remote.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('connector names and words', () => {
  it('names a tool for the agents within what model APIs take, apart from the bridge’s own', () => {
    expect(connectorSlug('My Notes (work)')).toBe('my_notes_work');
    expect(connectorSlug('Ünïcode 😀')).toBe('unicode');
    expect(connectorSlug('!!!')).toBe('connector');
    expect(agentToolName('notes', 'search.pages')).toBe('notes__search_pages');
    const long = agentToolName('a_rather_long_name_x', 'an_even_longer_tool_name_that_goes_on_and_on');
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long).not.toBe(agentToolName('a_rather_long_name_x', 'an_even_longer_tool_name_that_goes_on_and_on_2'));
    expect(botMayUse('all', 'b1')).toBe(true);
    expect(botMayUse(['b2'], 'b1')).toBe(false);
  });

  it('says why a server can’t be used in plain words', () => {
    const local = { transport: 'stdio' as const, command: 'nopex' };
    expect(plainReason(Object.assign(new Error('spawn nopex ENOENT'), { code: 'ENOENT' }), local)).toBe('Couldn\'t start “nopex”: there\'s no such command on this computer.');
    expect(plainReason(new Error('Connection closed'), local, 'npm ERR! 404 Not Found: @x/nope\n')).toBe('It stopped before answering: npm ERR! 404 Not Found: @x/nope');
    const web = { transport: 'http' as const, url: 'https://mcp.example.com/mcp' };
    expect(plainReason(Object.assign(new Error('Error POSTing to endpoint: nope'), { code: 404 }), web)).toContain('HTTP 404');
    expect(plainReason(Object.assign(new Error('x'), { code: 403 }), web)).toContain('HTTP 403');
    expect(plainReason(new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:1') }), web)).toBe('Nothing answered at mcp.example.com.');
    expect(plainReason(new Error('getaddrinfo ENOTFOUND mcp.example.com'), web)).toContain('Couldn\'t find mcp.example.com');
  });

  it('hands on text and pictures, and says the rest in words', () => {
    expect(answerContent({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }, { type: 'resource_link', uri: 'file:///x', name: 'x.txt' }, { type: 'audio', data: '', mimeType: 'audio/wav' }] })).toEqual([
      { type: 'text', text: 'a' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }, { type: 'text', text: '[link: x.txt (file:///x)]' }, { type: 'text', text: '[audio the tool returned]' },
    ]);
    expect(answerContent({ content: [], structuredContent: { n: 1 } })).toEqual([{ type: 'text', text: '{"n":1}' }]);
  });
});

describe('custom connectors', () => {
  let local: Connector;

  it('starts a local server with its environment, lists its tools, and keeps the values sealed and off the wire', async () => {
    local = await owner.call('connectors.save', { name: 'Local tools', transport: 'stdio', command: process.execPath, args: [LOCAL], env: [{ name: 'GREETING', value: 'hello from the vault' }] });
    expect(local).toMatchObject({ status: 'connected', transport: 'stdio', bots: 'all', env: [{ name: 'GREETING', saved: true }], server: { name: 'test-local', version: '1.2.3' } });
    expect(local.tools.map((t) => [t.name, t.on])).toEqual([['echo', true], ['add', true], ['greeting', true], ['picture', true], ['fail', true]]);
    const listed = await owner.call('connectors.list');
    expect(listed.encrypted).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('hello from the vault');
    const raw = file();
    expect(raw).not.toContain('hello from the vault');
    expect(raw).toContain('sealed:');
    if (process.platform !== 'win32') expect(statSync(join(root, 'data', 'connectors.json')).mode & 0o777).toBe(0o600);
  }, 60_000);

  it('offers its tools to a bot’s agent through the bridge, and runs them there', async () => {
    const bot = core.services.bots.list()[0]!;
    const agent = await agentFor(bot.id);
    try {
      const { tools } = await agent.call('agent.connectors.tools');
      expect(tools.map((t) => t.name)).toEqual(['local_tools__echo', 'local_tools__add', 'local_tools__greeting', 'local_tools__picture', 'local_tools__fail']);
      expect(tools[0]).toMatchObject({ description: 'Local tools (custom connector): Says back what it is given', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } });
      expect(await agent.call('agent.connectors.call', { name: 'local_tools__echo', arguments: { text: 'hi' } })).toEqual({ content: [{ type: 'text', text: 'echo: hi' }], isError: false });
      expect(await agent.call('agent.connectors.call', { name: 'local_tools__add', arguments: { a: 2, b: 3 } })).toEqual({ content: [{ type: 'text', text: '5' }], isError: false });
      // the value saved for its environment reached the server, and only there
      expect((await agent.call('agent.connectors.call', { name: 'local_tools__greeting', arguments: {} })).content).toEqual([{ type: 'text', text: 'hello from the vault' }]);
      expect((await agent.call('agent.connectors.call', { name: 'local_tools__picture', arguments: {} })).content).toEqual([{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }]);
      expect(await agent.call('agent.connectors.call', { name: 'local_tools__fail', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'it went wrong' }], isError: true });
      expect((await agent.call('agent.connectors.call', { name: 'nobody__echo', arguments: {} })).isError).toBe(true);
    } finally { agent.close(); }
  }, 60_000);

  it('keeps a tool that is switched off, or a connector kept to other bots, from a bot', async () => {
    const [first] = core.services.bots.list();
    const other = core.services.bots.create({ name: 'Other' } as never);
    const agent = await agentFor(first!.id);
    try {
      await owner.call('connectors.setTool', { id: local.id, tool: 'add', on: false });
      expect((await agent.call('agent.connectors.tools')).tools.map((t) => t.name)).not.toContain('local_tools__add');
      expect(await agent.call('agent.connectors.call', { name: 'local_tools__add', arguments: { a: 1, b: 1 } })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('switched off') }] });
      await owner.call('connectors.setTool', { id: local.id, tool: 'add', on: true });

      const kept = await owner.call('connectors.setBots', { id: local.id, bots: [other.id, 'gone-bot'] });
      expect(kept.bots).toEqual([other.id]);
      expect((await agent.call('agent.connectors.tools')).tools).toEqual([]);
      expect((await agent.call('agent.connectors.call', { name: 'local_tools__echo', arguments: { text: 'x' } })).content[0]).toMatchObject({ text: expect.stringContaining('isn\'t allowed') });
      expect(core.services.connectors.toolsFor(other.id).length).toBe(5);
      await owner.call('connectors.setBots', { id: local.id, bots: 'all' });
    } finally { agent.close(); }
  }, 60_000);

  it('hands the bridge its connector tools when a chat starts, and restarts the agent when they change', async () => {
    const bot = core.services.bots.list()[0]!;
    const threadId = core.services.threads.chatFor(bot.id).id;
    await owner.call('chat.send', { threadId, text: 'hello' });
    const first = runtime.created.filter((o) => o.env?.APPUBOT_THREAD_ID === threadId).at(-1);
    expect(bridgeConnectors(first)).toBe('1');
    // nothing about a connector's values in what the agent is started with
    expect(JSON.stringify(first)).not.toContain('hello from the vault');
    const before = runtime.created.length;
    await owner.call('connectors.setBots', { id: local.id, bots: [] });
    await owner.call('chat.send', { threadId, text: 'again' });
    const after = runtime.created.filter((o) => o.env?.APPUBOT_THREAD_ID === threadId).at(-1);
    expect(runtime.created.length).toBeGreaterThan(before);
    expect(bridgeConnectors(after)).toBeUndefined();
    await owner.call('connectors.setBots', { id: local.id, bots: 'all' });
  }, 60_000);

  it('reaches a remote server with the headers given, and says why when they are wrong', async () => {
    const wrong = await owner.call('connectors.save', { name: 'Keyed', transport: 'http', url: `${remote.base}/keyed`, headers: [{ name: 'X-Api-Key', value: 'nope' }] });
    expect(wrong).toMatchObject({ status: 'error', headers: [{ name: 'X-Api-Key', saved: true }] });
    expect(wrong.error).toContain('HTTP 401');
    // a value left out keeps the saved one; a new one replaces it
    const same = await owner.call('connectors.save', { id: wrong.id, name: 'Keyed', transport: 'http', url: `${remote.base}/keyed`, headers: [{ name: 'X-Api-Key' }] });
    expect(same.status).toBe('error');
    const right = await owner.call('connectors.save', { id: wrong.id, name: 'Keyed', transport: 'http', url: `${remote.base}/keyed`, headers: [{ name: 'X-Api-Key', value: 'k1' }] });
    expect(right).toMatchObject({ status: 'connected', server: { name: 'test-remote' } });
    expect(right.tools.map((t) => t.name)).toEqual(['lookup', 'weather']);
    expect(right.error).toBeUndefined();
    expect(file()).not.toContain('"k1"');
    const r = await core.services.connectors.call(core.services.bots.list()[0]!.id, 'keyed__lookup', { word: 'pill' });
    expect(r).toEqual({ content: [{ type: 'text', text: 'pill: a word' }], isError: false });
  }, 60_000);

  it('reaches a server over SSE', async () => {
    const c = await owner.call('connectors.save', { name: 'Old style', transport: 'sse', url: `${remote.base}/sse` });
    expect(c).toMatchObject({ status: 'connected' });
    const r = await core.services.connectors.call(core.services.bots.list()[0]!.id, 'old_style__weather', { city: 'Pune' });
    expect(r.content).toEqual([{ type: 'text', text: 'Sunny in Pune' }]);
  }, 60_000);

  it('signs in on the server’s own page when it asks, and keeps the tokens sealed', async () => {
    const c = await owner.call('connectors.save', { name: 'Signed', transport: 'http', url: `${remote.base}/signed` });
    expect(c).toMatchObject({ status: 'signIn', signedIn: false, tools: [] });
    expect(core.services.connectors.toolsFor(core.services.bots.list()[0]!.id).some((t) => t.name.startsWith('signed__'))).toBe(false);
    const { redirectUrl } = await owner.call('connectors.signIn', { id: c.id });
    const url = new URL(opened.at(-1)!);
    expect(redirectUrl).toBe(url.toString());
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${core.gateway.port}/connectors/signed-in`);
    // a return nobody started changes nothing
    const stray = await fetch(`http://127.0.0.1:${core.gateway.port}/connectors/signed-in?code=good-code&state=not-ours`);
    expect(await stray.text()).toContain('isn’t connected');
    const back = await fetch(`http://127.0.0.1:${core.gateway.port}/connectors/signed-in?code=good-code&state=${url.searchParams.get('state')}`);
    expect(await back.text()).toContain('Signed is connected');
    const now = core.services.connectors.get(c.id);
    expect(now).toMatchObject({ status: 'connected', signedIn: true });
    expect(now.tools.map((t) => t.name)).toEqual(['lookup', 'weather']);
    expect(file()).not.toContain('at_1');
    expect(file()).not.toContain('rt_1');
    expect((await core.services.connectors.call(core.services.bots.list()[0]!.id, 'signed__lookup', { word: 'token' })).content).toEqual([{ type: 'text', text: 'token: a word' }]);
    const out = await owner.call('connectors.signOut', { id: c.id });
    expect(out).toMatchObject({ status: 'signIn', signedIn: false });
  }, 60_000);

  it('says plainly when a server can’t be reached or started', async () => {
    // a port nothing listens on
    const gone = createServer();
    await new Promise<void>((r) => gone.listen(0, '127.0.0.1', r));
    const port = (gone.address() as AddressInfo).port;
    await new Promise<void>((r) => gone.close(() => r()));
    const down = await owner.call('connectors.save', { name: 'Down', transport: 'http', url: `http://127.0.0.1:${port}/mcp` });
    expect(down).toMatchObject({ status: 'error', error: `Nothing answered at 127.0.0.1:${port}.` });
    const missing = await owner.call('connectors.save', { name: 'Missing', transport: 'stdio', command: 'appubot-no-such-command-x' });
    expect(missing).toMatchObject({ status: 'error', error: 'Couldn\'t start “appubot-no-such-command-x”: there\'s no such command on this computer.' });
    await expect(owner.call('connectors.save', { name: 'No address', transport: 'http', url: 'mcp.example.com' })).rejects.toThrow('Enter the server’s address');
    await expect(owner.call('connectors.save', { name: 'Twice', transport: 'stdio', command: 'x', env: [{ name: 'A', value: '1' }, { name: 'A', value: '2' }] })).rejects.toThrow('twice');
    await owner.call('connectors.remove', { id: down.id });
    await owner.call('connectors.remove', { id: missing.id });
    expect((await owner.call('connectors.list')).connectors.map((c) => c.name)).toEqual(['Local tools', 'Keyed', 'Old style', 'Signed']);
  }, 60_000);

  it('is managed from the computer’s own window only', () => {
    expect(() => checkRole('connectors.list', {}, { role: 'full', deviceId: 'phone' })).toThrow();
    expect(() => checkRole('connectors.save', { name: 'x', transport: 'stdio', command: 'sh' }, { role: 'full', deviceId: 'phone' })).toThrow();
    expect(() => checkRole('connectors.list', {}, { role: 'limited', deviceId: 'phone' })).toThrow();
    expect(() => checkRole('connectors.list', {}, { role: 'agent', deviceId: 'agent' })).toThrow();
    expect(() => checkRole('agent.connectors.call', { name: 'x' }, { role: 'agent', deviceId: 'agent' })).not.toThrow();
    expect(() => checkRole('connectors.save', {}, { role: 'owner', deviceId: 'mac' })).not.toThrow();
  });

  it('stops the local server when it is removed', async () => {
    await owner.call('connectors.remove', { id: local.id });
    expect(core.services.connectors.toolsFor(core.services.bots.list()[0]!.id).some((t) => t.name.startsWith('local_tools__'))).toBe(false);
    expect(file()).not.toContain('Local tools');
  }, 30_000);
});
