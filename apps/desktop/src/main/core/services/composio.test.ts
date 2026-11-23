import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { GatewayClient, GatewayError } from '@appubot/client';
import type { EventName, EventPayload } from '@appubot/protocol';
import type { CreateSessionOptions, McpServerStdio } from '@appubot/agent-runtime';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { accountsIn, cantConnectText, fileLinkCode, fileLinkIn, toolkitOfTool } from './composio';
import { accountOf, ComposioHttpError, rpcAnswer, type ComposioConnect, type ComposioTokens } from './composioConnect';
import { authKindOf, categoryName, listedDirectory, unavailableReason, type AppsDirectory } from './composioDirectory';
import { DIRECT_APPS } from './directApps';
import directory from './composioDirectory.json';
import shippedUnavailable from './composioUnavailable.json';

const UNAVAILABLE = shippedUnavailable.unavailable as Record<string, string>;
/** What Composio answers for an app it runs no sign-in for. */
const NO_MANAGED_AUTH = (slug: string) => `Composio does not have managed auth for '${slug}', so the user must set up their own auth config before connecting. Show the user this link and ask them to complete the setup there: [Set up ${slug}](https://dashboard.composio.dev/~/org/connect/apps/${slug}?open=true). Once they have finished, call COMPOSIO_MANAGE_CONNECTIONS again with '${slug}' to connect.`;
const FILE_LINK = 'https://backend.composio.dev/api/v3/sl/abc123';
const WHOLE_ANSWER = JSON.stringify({ success: true, results: [{ response: { successful: true, data: { messages: Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, text: 'x'.repeat(200) })) } } }] });

const WS = WebSocket as unknown as typeof globalThis.WebSocket;

const idToken = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

interface Account { id: string; slug: string; status: string }

/** Composio for You as the service sees it: one signed-in user, connections made through link pages. */
class FakeConnect implements ComposioConnect {
  clients: string[] = [];
  /** access token → still good */
  tokens = new Set<string>();
  refreshTokens = new Set<string>();
  refreshes = 0;
  /** the refresh token is no longer taken (the sign-in ended) */
  refreshDead = false;
  accounts: Account[] = [{ id: 'slack_elsewhere', slug: 'slack', status: 'active' }];
  calls: { name: string; args: Record<string, unknown> }[] = [];
  /** apps Composio runs no sign-in for: `add` is refused */
  refused = new Set<string>();
  /** the file in its sandbox can't be read */
  fileGone = false;
  private n = 0;
  async register(redirectUri: string) {
    expect(redirectUri).toMatch(/^(http:\/\/127\.0\.0\.1:\d+\/apps\/signed-in|appubot:\/\/apps\/signed-in)$/);
    const id = `client_${this.clients.length + 1}`;
    this.clients.push(id);
    return { clientId: id };
  }
  authorizeUrl(p: { clientId: string; redirectUri: string; challenge: string; state: string }) {
    return `https://connect.composio.dev/oauth/authorize?${new URLSearchParams({ client_id: p.clientId, redirect_uri: p.redirectUri, code_challenge: p.challenge, state: p.state })}`;
  }
  private issue(): ComposioTokens {
    const n = ++this.n;
    this.tokens.add(`at_${n}`);
    this.refreshTokens.add(`rt_${n}`);
    return { accessToken: `at_${n}`, refreshToken: `rt_${n}`, expiresAt: Date.now() + 3600_000, account: accountOf(idToken({ email: 'me@example.com' })) };
  }
  async exchange(p: { code: string; verifier: string }) {
    if (p.code !== 'good-code' || !p.verifier) throw new ComposioHttpError(400, 'invalid_grant');
    return this.issue();
  }
  async refresh(p: { refreshToken: string }) {
    this.refreshes++;
    if (this.refreshDead || !this.refreshTokens.has(p.refreshToken)) throw new ComposioHttpError(400, 'invalid_grant');
    return this.issue();
  }
  async callTool(token: string, name: string, args: Record<string, unknown>) {
    if (!this.tokens.has(token)) throw new ComposioHttpError(401, 'expired');
    this.calls.push({ name, args });
    const ok = (data: unknown) => ({ text: JSON.stringify({ successful: true, data, error: null }), isError: false });
    switch (name) {
      case 'COMPOSIO_MANAGE_CONNECTIONS': {
        const results: Record<string, unknown> = {};
        for (const t of args.toolkits as { name: string; action: string; account_id?: string }[]) {
          if (t.action === 'add' && this.refused.has(t.name)) {
            results[t.name] = { toolkit: t.name, status: 'failed', error_message: NO_MANAGED_AUTH(t.name) };
          } else if (t.action === 'add') {
            const id = `${t.name}_${++this.n}`;
            this.accounts.push({ id, slug: t.name, status: 'initiated' });
            results[t.name] = { toolkit: t.name, status: 'initiated', redirect_url: `https://connect.composio.dev/link/lk_${id}`, accounts: this.accounts.filter((a) => a.slug === t.name).map((a) => ({ id: a.id, status: a.status })) };
          } else {
            if (t.action === 'remove') this.accounts = this.accounts.filter((a) => a.id !== t.account_id);
            results[t.name] = { toolkit: t.name, accounts: this.accounts.filter((a) => a.slug === t.name).map((a) => ({ id: a.id, status: a.status })) };
          }
        }
        return ok({ results });
      }
      case 'COMPOSIO_SEARCH_TOOLS':
        return ok({
          results: [{
            use_case: 'post and email', primary_tool_slugs: ['GMAIL_SEND_EMAIL', 'SLACK_SEND_MESSAGE'], related_tool_slugs: ['GITHUB_CREATE_AN_ISSUE', 'OSV_GET_VULNERABILITY'], toolkits: ['gmail', 'slack', 'github', 'osv'],
            recommended_plan_steps: ['[Required] Send with GMAIL_SEND_EMAIL', '[Optional] Batch the rest in COMPOSIO_REMOTE_WORKBENCH'],
            reference_workbench_snippets: ['run_composio_tool("GMAIL_SEND_EMAIL", {})'],
          }],
          toolkit_connection_statuses: [
            ...['gmail', 'slack', 'github'].map((t) => ({ toolkit: t, has_active_connection: this.accounts.some((a) => a.slug === t && a.status === 'active'), status_message: `call COMPOSIO_MANAGE_CONNECTIONS for ${t}` })),
            // an app that needs no sign-in reads as connected, with no account
            { toolkit: 'osv', has_active_connection: true, status_message: 'This toolkit does not require authentication. Tools are ready to use.' },
          ],
          tool_schemas: { GMAIL_SEND_EMAIL: { toolkit: 'GMAIL' }, SLACK_SEND_MESSAGE: { toolkit: 'SLACK' }, GITHUB_CREATE_AN_ISSUE: { toolkit: 'GITHUB' }, OSV_GET_VULNERABILITY: { toolkit: 'OSV' } },
          next_steps_guidance: ['1) CALL COMPOSIO_MANAGE_CONNECTIONS for toolkits that are not active', '2) Read inputs with COMPOSIO_GET_TOOL_SCHEMAS, then run COMPOSIO_MULTI_EXECUTE_TOOL'],
          session: { id: 'park', instructions: 'Pass session_id "park" in ALL subsequent meta tool calls' },
        });
      case 'COMPOSIO_GET_TOOL_SCHEMAS':
        return ok({ schemas: args.tool_slugs });
      case 'COMPOSIO_MULTI_EXECUTE_TOOL': {
        const tools = (args.tools as { tool_slug: string }[]).map((t) => t.tool_slug);
        // too large to return: a preview, the whole of it in a file in the sandbox
        if (tools[0] === 'GMAIL_FETCH_EMAILS') {
          return ok({
            results: [{ response: { successful: true, data_preview: { messages: [{ id: 'm0', text: 'xxx' }] } }, tool_slug: tools[0], index: 0, structure_info: { type: 'object' }, instruction: 'Use structure_info and data_preview to understand the result, then process the remote response file.' }],
            total_count: 1, success_count: 1, error_count: 0,
            remote_file_info: { message: 'Complete response was large (102323 tokens). Full data saved to sandbox in /mnt/files/mex/foot.json.', file_path: '/mnt/files/mex/foot.json', filename: 'foot.json' },
            next_steps: 'First review the inline structure. Only after confirming it, write code to parse the saved response in COMPOSIO_REMOTE_WORKBENCH.',
          });
        }
        return ok({ ran: tools });
      }
      case 'COMPOSIO_REMOTE_WORKBENCH':
        return ok({ results: '', stdout: this.fileGone ? 'APPUBOT_FILE_ERROR=File not found: /mnt/files/mex/foot.json\n' : `Uploading file to S3...\nS3 URL: ${FILE_LINK}\nAPPUBOT_FILE_URL=${FILE_LINK}\n` });
      default:
        return { text: 'unknown tool', isError: true };
    }
  }
  activate(slug: string): void { for (const a of this.accounts) if (a.slug === slug) a.status = 'active'; }
}

let core: Core;
let runtime: FakeRuntime;
let root: string;
let owner: GatewayClient;
const fake = new FakeConnect();
const opened: string[] = [];
let shown = 0;

function waitEvent<E extends EventName>(event: E, pred: (p: EventPayload<E>) => boolean, ms = 15_000): Promise<EventPayload<E>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${event}`)); }, ms);
    const off = owner.on(event, (p) => { if (pred(p)) { clearTimeout(t); off(); resolve(p); } });
  });
}

async function connectAs(token: string): Promise<GatewayClient> {
  const c = new GatewayClient({ baseUrl: `http://127.0.0.1:${core.gateway.port}`, token, device: { id: `apps-${token.slice(0, 6)}`, name: 'apps-test', platform: 'cli' }, WebSocketImpl: WS, callTimeoutMs: 10_000 });
  await new Promise<void>((resolve, reject) => {
    const off = c.onState((s, err) => { if (s === 'connected') { off(); resolve(); } if (s === 'unauthorized') { off(); reject(new Error(err)); } });
    c.connect();
  });
  return c;
}

/** The agent sessions a thread's turns started, oldest first, and what its bridge was told. */
const createdFor = (threadId: string): CreateSessionOptions[] => runtime.created.filter((o) => o.env?.APPUBOT_THREAD_ID === threadId);
const bridgeApps = (o: CreateSessionOptions | undefined): string | undefined => (o?.mcpServers?.find((s) => s.name === 'appubot') as McpServerStdio | undefined)?.env?.APPUBOT_APPS;

async function turn(threadId: string): Promise<void> {
  const done = waitEvent('message.completed', (p) => p.threadId === threadId);
  await owner.call('chat.send', { threadId, text: 'fail fast' });
  await done;
}

async function failure(p: Promise<unknown>): Promise<GatewayError> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(GatewayError);
  return e as GatewayError;
}

const appsFile = () => JSON.parse(readFileSync(join(root, 'data', 'apps.json'), 'utf8')) as Record<string, unknown>;

/** The browser coming back from Composio's sign-in. */
async function comeBack(query: Record<string, string>): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${core.gateway.port}/apps/signed-in?${new URLSearchParams(query)}`);
  expect(res.status).toBe(200);
  return res.text();
}

async function signIn(): Promise<void> {
  await owner.call('apps.signIn');
  const url = new URL(opened.at(-1)!);
  expect(url.origin + url.pathname).toBe('https://connect.composio.dev/oauth/authorize');
  expect(await comeBack({ code: 'good-code', state: url.searchParams.get('state')! })).toContain('Signed in to Composio');
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-apps-'));
  // what the API-key version left behind
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'apps.json'), JSON.stringify({ apiKey: 'ak_old', userId: 'appubot-1', session: { id: 's' }, bots: {} }));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: (url) => { opened.push(url); },
    showApp: () => { shown++; },
    composioConnect: () => fake,
    // the link Composio gives to a large answer's file; anything else is the real fetch
    fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => (String(input) === FILE_LINK ? Promise.resolve(new Response(WHOLE_ANSWER, { status: 200, headers: { 'content-type': 'application/json' } })) : fetch(input, init))) as typeof fetch,
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
  rmSync(root, { recursive: true, force: true });
});

describe('apps (Composio for You)', () => {
  it('drops the old API key and starts signed out; the directory ships with the app', async () => {
    core.ctx.store.flush();
    expect(appsFile()).toEqual({});
    expect(await owner.call('apps.status')).toMatchObject({ configured: false, signingIn: false, pending: [] });
    // signed out of Composio, the apps on their own servers are still this computer's to list (none connected yet)
    expect(await owner.call('apps.connections')).toEqual([]);

    const all = await owner.call('apps.catalog', {});
    // without the hidden ones and the apps Composio can't connect for AppuBot, plus the ones on their own servers
    expect(all.total).toBe(directory.toolkits.filter((t) => t.slug !== 'composio' && t.slug !== 'test_app' && !(t.slug in UNAVAILABLE)).length + DIRECT_APPS.length);
    expect(all.toolkits.map((t) => t.slug)).not.toContain('test_app');
    expect(all.toolkits.map((t) => t.slug)).not.toContain('composio');
    expect((await owner.call('apps.catalog', { search: 'gma' })).toolkits[0]!.slug).toBe('gmail');
    expect((await owner.call('apps.catalog', { slugs: ['slack', 'gmail', 'nope'] })).toolkits.map((t) => t.slug)).toEqual(['slack', 'gmail']);
    const cat = all.categories[0]!;
    expect((await owner.call('apps.catalog', { category: cat.id, limit: 200 })).toolkits.every((t) => t.categories.includes(cat.id))).toBe(true);
  });

  it('signs in in the browser with PKCE, and only the sign-in it started', async () => {
    const s = await owner.call('apps.signIn');
    expect(s.signingIn).toBe(true);
    const url = new URL(opened.at(-1)!);
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    const state = url.searchParams.get('state')!;
    // another state, a refused sign-in or a bad code: not signed in
    expect(await comeBack({ code: 'good-code', state: 'forged' })).toContain('Not signed in');
    expect((await owner.call('apps.status')).configured).toBe(false);

    const found = waitEvent('apps.updated', (p) => p.configured);
    expect(await comeBack({ code: 'good-code', state })).toContain('Signed in to Composio');
    expect(await found).toMatchObject({ configured: true, account: 'me@example.com', signingIn: false });
    // the state was used up
    expect(await comeBack({ code: 'good-code', state })).toContain('Not signed in');

    core.ctx.store.flush();
    const f = appsFile();
    expect(f.client).toMatchObject({ clientId: 'client_1' });
    expect(f.auth).toMatchObject({ clientId: 'client_1', accessToken: expect.stringMatching(/^at_/) });
    if (process.platform !== 'win32') expect(statSync(join(root, 'data', 'apps.json')).mode & 0o777).toBe(0o600);
    // never on the wire
    expect(JSON.stringify(await owner.call('apps.status'))).not.toMatch(/at_|rt_|client_/);

    // apps connected elsewhere (Claude.ai, Codex…) are found by looking through the directory
    await vi.waitFor(() => expect(core.services.composio.connectedSlugs()).toEqual(['slack']), { timeout: 10_000 });
    expect((await owner.call('apps.connections')).map((c) => [c.slug, c.status])).toEqual([['slack', 'ACTIVE']]);
  });

  it('connects an app through Composio\'s link page and hands it to every bot', async () => {
    const res = await owner.call('apps.connect', { slug: 'gmail' });
    expect(res.redirectUrl).toMatch(/^https:\/\/connect\.composio\.dev\/link\//);
    // in the user's browser, where they are signed in already
    expect(opened.at(-1)).toBe(res.redirectUrl);
    expect((await owner.call('apps.status')).pending).toEqual(['gmail']);
    const done = waitEvent('apps.updated', (p) => !p.pending.includes('gmail'));
    fake.activate('gmail');
    await done;
    // AppuBot comes back to the front
    expect(shown).toBe(1);
    expect(core.services.composio.connectedSlugs()).toEqual(['gmail', 'slack']);

    const [appu] = await owner.call('bots.list');
    const t = await owner.call('threads.create', { botId: appu!.id });
    await turn(t.id);
    expect(bridgeApps(createdFor(t.id).at(-1))).toBe('1');
    const md = readFileSync(join(appu!.workspace, 'CLAUDE.md'), 'utf8');
    expect(md).toContain('apps_search');
  });

  it('cleans up a sign-in started over', async () => {
    await owner.call('apps.connect', { slug: 'notion' });
    const first = fake.accounts.find((a) => a.slug === 'notion')!.id;
    await owner.call('apps.connect', { slug: 'notion' });
    await vi.waitFor(() => expect(fake.accounts.some((a) => a.id === first)).toBe(false), { timeout: 10_000 });
    expect(fake.accounts.filter((a) => a.slug === 'notion')).toHaveLength(1);
    expect((await owner.call('apps.status')).pending).toEqual(['notion']);
    expect(core.services.composio.connectedSlugs()).not.toContain('notion');
  }, 20_000);

  it('gives a bot only its own apps, checked on every call', async () => {
    const [appu] = await owner.call('bots.list');
    const t = (await owner.call('threads.list', {})).find((x) => x.botId === appu!.id)!;
    const agent = await connectAs(core.ctx.auth.issueAgentToken({ threadId: t.id, botId: appu!.id }));
    try {
      const found = await agent.call('agent.apps.search', { queries: [{ use_case: 'post and email' }] });
      expect(found.text).toMatch(/^Your apps: Gmail \(gmail\), Slack \(slack\)\./);
      const data = JSON.parse(found.text.slice(found.text.indexOf('\n\n') + 2)) as { results: { primary_tool_slugs: string[]; related_tool_slugs: string[] }[]; tool_schemas: object; toolkit_connection_statuses: { toolkit: string; status_message: string }[] };
      expect(data.results[0]!.primary_tool_slugs).toEqual(['GMAIL_SEND_EMAIL', 'SLACK_SEND_MESSAGE']);
      // an app that needs no sign-in is the bot's too, with nothing connected
      expect(found.text).toMatch(/No sign-in needed, also yours: .+ and \d+ more\./);
      expect(data.results[0]!.related_tool_slugs).toEqual(['OSV_GET_VULNERABILITY']);
      expect(Object.keys(data.tool_schemas)).toEqual(['GMAIL_SEND_EMAIL', 'SLACK_SEND_MESSAGE', 'OSV_GET_VULNERABILITY']);
      expect(JSON.parse((await agent.call('agent.apps.execute', { tools: [{ tool_slug: 'OSV_GET_VULNERABILITY', arguments: { vulnerability_id: 'x' } }] })).text).data.ran).toEqual(['OSV_GET_VULNERABILITY']);
      // nothing points the bot at Composio's own tools: it knows them by the bridge's names, and has no workbench
      expect(found.text).not.toMatch(/COMPOSIO_|session_id|workbench|run_composio_tool/);
      expect(found.text).toContain('[Required] Send with GMAIL_SEND_EMAIL');
      // Composio takes seven tasks a search
      expect((await failure(agent.call('agent.apps.search', { queries: Array.from({ length: 8 }, () => ({ use_case: 'x' })) }))).message).toMatch(/At most 7/);
      expect(found.text).toContain('2) Read inputs with apps_tool_schemas, then run apps_execute');
      expect(data.toolkit_connection_statuses.find((s) => s.toolkit === 'github')!.status_message).toMatch(/AppuBot → Apps/);

      const ran = await agent.call('agent.apps.execute', { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'a@b.c' } }] });
      expect(JSON.parse(ran.text).data.ran).toEqual(['GMAIL_SEND_EMAIL']);
      expect(fake.calls.at(-1)!.args).toMatchObject({ sync_response_to_workbench: false });
      // a tool of an app the bot doesn't have, even in a batch with its own
      const refused = await failure(agent.call('agent.apps.execute', { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} }, { tool_slug: 'GITHUB_CREATE_AN_ISSUE', arguments: {} }] }));
      expect(refused.message).toMatch(/GitHub isn't one of your apps/);
      expect((await failure(agent.call('agent.apps.execute', { tools: [{ tool_slug: 'MADE_UP_TOOL', arguments: {} }] }))).message).toMatch(/isn't a tool of your apps/);
      const schemas = await agent.call('agent.apps.schemas', { tool_slugs: ['SLACK_SEND_MESSAGE', 'GITHUB_CREATE_AN_ISSUE'] });
      expect(fake.calls.at(-1)!.args).toEqual({ tool_slugs: ['SLACK_SEND_MESSAGE'] });
      expect(schemas.text).toMatch(/GITHUB_CREATE_AN_ISSUE is a GitHub tool/);

      // turned off for this bot: refused at once, no restart needed
      const created = runtime.created.length;
      await owner.call('bots.update', { id: appu!.id, patch: { appsOff: ['gmail'] } });
      expect((await failure(agent.call('agent.apps.execute', { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} }] }))).message).toMatch(/Gmail isn't one of your apps/);
      expect((await agent.call('agent.apps.search', { queries: [{ use_case: 'x' }] })).text).toMatch(/^Your apps: Slack \(slack\)\./);
      await turn(t.id);
      expect(runtime.created.length).toBe(created);

      // every connected app off: the ones that need no sign-in are still its own, so its agent keeps the apps tools
      await owner.call('bots.update', { id: appu!.id, patch: { appsOff: ['gmail', 'slack'] } });
      expect((await agent.call('agent.apps.search', { queries: [{ use_case: 'x' }] })).text).toMatch(/^Your apps: none connected\. No sign-in needed, also yours: /);
      expect((await failure(agent.call('agent.apps.execute', { tools: [{ tool_slug: 'SLACK_SEND_MESSAGE', arguments: {} }] }))).message).toMatch(/Slack isn't one of your apps/);
      await turn(t.id);
      expect(runtime.created.length).toBe(created);
      // one of those turned off for it is refused like any other
      await owner.call('bots.update', { id: appu!.id, patch: { appsOff: ['osv'] } });
      expect((await failure(agent.call('agent.apps.execute', { tools: [{ tool_slug: 'OSV_GET_VULNERABILITY', arguments: {} }] }))).message).toMatch(/OSV isn't one of your apps/);
      await owner.call('bots.update', { id: appu!.id, patch: { appsOff: [] } });

      // the owner's window can't make these calls, nor an agent the owner's
      expect((await failure(owner.call('agent.apps.search', { queries: [{ use_case: 'x' }] }))).code).toBe('forbidden');
      expect((await failure(agent.call('apps.connect', { slug: 'github' }))).code).toBe('forbidden');
    } finally { agent.close(); }
  });

  it('brings an answer too large to return back as a file in the bot\'s folder', async () => {
    const [appu] = await owner.call('bots.list');
    const t = (await owner.call('threads.list', {})).find((x) => x.botId === appu!.id)!;
    const agent = await connectAs(core.ctx.auth.issueAgentToken({ threadId: t.id, botId: appu!.id }));
    try {
      const ran = await agent.call('agent.apps.execute', { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { max_results: 40 } }] });
      const data = JSON.parse(ran.text).data as { results: Record<string, unknown>[]; full_answer: { path: string; bytes: number; note: string } };
      // AppuBot ran its own fixed code in Composio's sandbox for a link, and nothing else
      expect(fake.calls.at(-1)).toEqual({ name: 'COMPOSIO_REMOTE_WORKBENCH', args: { code_to_execute: fileLinkCode('/mnt/files/mex/foot.json') } });
      expect(data.full_answer.path.startsWith(join(appu!.workspace, 'inbox', 'apps'))).toBe(true);
      expect(data.full_answer.path).toMatch(/gmail_fetch_emails-\d{8}-\d{6}-[0-9a-f]{4}\.json$/);
      expect(readFileSync(data.full_answer.path, 'utf8')).toBe(WHOLE_ANSWER);
      expect(data.full_answer.bytes).toBe(WHOLE_ANSWER.length);
      // the preview stays; what sent the bot to a file and a tool it hasn't got is gone
      expect(data.results[0]).toMatchObject({ tool_slug: 'GMAIL_FETCH_EMAILS', structure_info: { type: 'object' } });
      expect(ran.text).not.toMatch(/remote_file_info|next_steps|remote response file|COMPOSIO_|\/mnt\/files/);

      // the file can't be had: said plainly, with what to do instead
      fake.fileGone = true;
      const lost = await agent.call('agent.apps.execute', { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} }] });
      const note = (JSON.parse(lost.text).data as { full_answer: { path?: string; note: string } }).full_answer;
      expect(note.path).toBeUndefined();
      expect(note.note).toMatch(/couldn't fetch it \(File not found.*Ask again for less/);
      expect(lost.text).not.toMatch(/remote_file_info|next_steps/);
    } finally { fake.fileGone = false; agent.close(); }
  });

  it('says why an app can\'t be connected, and takes it off the list', async () => {
    fake.refused.add('airtable');
    expect((await owner.call('apps.catalog', { search: 'airtable' })).toolkits.map((x) => x.slug)).toContain('airtable');
    const e = await failure(owner.call('apps.connect', { slug: 'airtable' }));
    expect(e.code).toBe('unsupported');
    // Composio's words to an agent ("show the user this link…") are not the person's
    expect(e.message).toBe('Airtable can\'t be connected from AppuBot yet: Composio has no sign-in of its own for it.');
    expect((await owner.call('apps.status')).pending).not.toContain('airtable');
    core.ctx.store.flush();
    expect(appsFile().unavailable).toEqual({ airtable: 'needs-setup' });
    expect((await owner.call('apps.catalog', { search: 'airtable' })).toolkits.map((x) => x.slug)).not.toContain('airtable');
    // still named when asked for by slug (a connection made at Composio would show)
    expect((await owner.call('apps.catalog', { slugs: ['airtable'] })).toolkits.map((x) => x.name)).toEqual(['Airtable']);
    // asked again, Composio isn't: the answer is known
    const calls = fake.calls.length;
    expect((await failure(owner.call('apps.connect', { slug: 'airtable' }))).code).toBe('unsupported');
    expect(fake.calls.length).toBe(calls);

    // a bot asking for it gets no card that could never be finished
    const [appu] = await owner.call('bots.list');
    const t = (await owner.call('threads.list', {})).find((x) => x.botId === appu!.id)!;
    const agent = await connectAs(core.ctx.auth.issueAgentToken({ threadId: t.id, botId: appu!.id }));
    try {
      const refused = await failure(agent.call('agent.apps.request', { slug: 'airtable' }));
      expect(refused.code).toBe('unsupported');
      expect(refused.message).toMatch(/Composio has no sign-in of its own for it\. Tell the user so/);
      // one that needs no sign-in is the bot's already
      expect(await agent.call('agent.apps.request', { slug: 'osv' })).toMatchObject({ slug: 'osv', connected: true, on: true });
    } finally { agent.close(); }
  });

  it('disconnects an app of the account', async () => {
    const gmail = (await owner.call('apps.connections')).find((c) => c.slug === 'gmail')!;
    expect((await failure(owner.call('apps.disconnect', { connectedAccountId: 'not-mine', slug: 'gmail' }))).code).toBe('not_found');
    await owner.call('apps.disconnect', { connectedAccountId: gmail.connectedAccountId, slug: 'gmail' });
    expect(core.services.composio.connectedSlugs()).toEqual(['slack']);
    expect((await owner.call('apps.connections')).map((c) => c.slug)).toEqual(['slack']);
  });

  it('renews the access token, and signs out when Composio no longer takes the sign-in', async () => {
    const [appu] = await owner.call('bots.list');
    const t = (await owner.call('threads.list', {})).find((x) => x.botId === appu!.id)!;
    const agent = await connectAs(core.ctx.auth.issueAgentToken({ threadId: t.id, botId: appu!.id }));
    try {
      // the token was refused (expired early): renewed once, the call goes through
      fake.tokens.clear();
      await agent.call('agent.apps.search', { queries: [{ use_case: 'x' }] });
      expect(fake.refreshes).toBe(1);
      // about to run out: renewed before the call
      core.ctx.store.apps.update((f) => ({ ...f, auth: { ...f.auth!, expiresAt: Date.now() } }));
      await agent.call('agent.apps.search', { queries: [{ use_case: 'x' }] });
      expect(fake.refreshes).toBe(2);

      fake.refreshDead = true;
      core.ctx.store.apps.update((f) => ({ ...f, auth: { ...f.auth!, expiresAt: Date.now() } }));
      const out = waitEvent('apps.updated', (p) => !p.configured);
      expect((await failure(agent.call('agent.apps.search', { queries: [{ use_case: 'x' }] }))).code).toBe('apps_not_configured');
      expect((await out).error).toMatch(/Sign in again/);
      expect(core.services.composio.connectedSlugs()).toEqual([]);
      const before = (await owner.call('threads.get', { id: t.id })).thread.acpSessionId;
      await turn(t.id);
      expect(bridgeApps(runtime.created.at(-1))).toBe('0');
      expect(runtime.created.at(-1)!.resumeSessionId).toBe(before);
    } finally { agent.close(); fake.refreshDead = false; }
  });

  it('signs in again and out; the connections stay in the account', async () => {
    await signIn();
    // the client registered for this port is reused
    expect(fake.clients).toEqual(['client_1']);
    await vi.waitFor(() => expect(core.services.composio.connectedSlugs()).toEqual(['slack']), { timeout: 10_000 });
    const s = await owner.call('apps.signOut');
    expect(s).toMatchObject({ configured: false });
    core.ctx.store.flush();
    expect(appsFile().auth).toBeUndefined();
    expect(fake.accounts.some((a) => a.slug === 'slack')).toBe(true);
    expect(core.services.composio.connectedSlugs()).toEqual([]);
  });

  it('signs in from a phone, in the phone\'s browser, back to its app', async () => {
    // only the app's own link: never a web page, where the code could be read by someone else
    expect((await failure(owner.call('apps.signIn', { redirectUri: 'https://evil.example/cb' }))).message).toMatch(/return address/);
    const before = opened.length;
    const s = await owner.call('apps.signIn', { redirectUri: 'appubot://apps/signed-in' });
    // nothing opens on the computer: the phone opens `url`
    expect(opened.length).toBe(before);
    expect(s.signingIn).toBe(true);
    const url = new URL(s.url!);
    expect(url.searchParams.get('redirect_uri')).toBe('appubot://apps/signed-in');
    expect(url.searchParams.get('client_id')).toBe('client_2');
    const state = url.searchParams.get('state')!;
    expect((await owner.call('apps.finishSignIn', { code: 'good-code', state: 'forged' })).ok).toBe(false);
    const r = await owner.call('apps.finishSignIn', { code: 'good-code', state });
    expect(r).toMatchObject({ ok: true, status: { configured: true, account: 'me@example.com' } });
    core.ctx.store.flush();
    // its own client, kept for next time; the computer's stays
    expect(appsFile().deviceClients).toEqual({ 'appubot://apps/signed-in': 'client_2' });
    expect(appsFile().client).toMatchObject({ clientId: 'client_1' });
    expect(appsFile().auth).toMatchObject({ clientId: 'client_2' });
    await owner.call('apps.signIn', { redirectUri: 'appubot://apps/signed-in' });
    expect(fake.clients).toEqual(['client_1', 'client_2']);
    await owner.call('apps.signOut');
  });
});

describe('Composio helpers', () => {
  it('reads accounts out of a manage-connections answer', () => {
    const m = accountsIn(JSON.stringify({ data: { results: { gmail: { accounts: [{ id: 'gmail_a', status: 'active' }, { status: 'x' }] }, slack: { accounts: [] } } } }));
    expect(m.get('gmail')).toEqual([{ slug: 'gmail', connectedAccountId: 'gmail_a', status: 'ACTIVE' }]);
    expect(m.get('slack')).toEqual([]);
    expect(accountsIn('not json').size).toBe(0);
  });

  it('tells a tool\'s app by the longest slug it starts with', () => {
    const slugs = ['google', 'googlecalendar', 'microsoft_teams', 'gmail'];
    expect(toolkitOfTool('GOOGLECALENDAR_CREATE_EVENT', slugs)).toBe('googlecalendar');
    expect(toolkitOfTool('MICROSOFT_TEAMS_SEND', slugs)).toBe('microsoft_teams');
    expect(toolkitOfTool('gmail_send_email', slugs)).toBe('gmail');
    expect(toolkitOfTool('GMAILX_SEND', slugs)).toBeUndefined();
  });

  it('finds the answer in JSON or an event stream', () => {
    expect(rpcAnswer('{"jsonrpc":"2.0","id":3,"result":{"ok":1}}', 'application/json', 3)).toMatchObject({ result: { ok: 1 } });
    const sse = ': connected\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"content":[]}}\n\n';
    expect(rpcAnswer(sse, 'text/event-stream', 7)).toMatchObject({ id: 7, result: { content: [] } });
    expect(rpcAnswer(sse, 'text/event-stream', 8)).toBeUndefined();
  });

  it('reads who signed in from the id token', () => {
    expect(accountOf(idToken({ email: 'me@example.com', name: 'Me' }))).toBe('me@example.com');
    expect(accountOf(idToken({ name: 'Me' }))).toBe('Me');
    expect(accountOf('garbage')).toBeUndefined();
    expect(accountOf(undefined)).toBeUndefined();
  });

  it('reads how a toolkit signs in', () => {
    expect(authKindOf({ authSchemes: ['OAUTH2'], managedSchemes: ['OAUTH2'], noAuth: false })).toBe('oauth');
    expect(authKindOf({ authSchemes: ['OAUTH2', 'API_KEY'], managedSchemes: [], noAuth: false })).toBe('api_key');
    expect(authKindOf({ authSchemes: ['BEARER_TOKEN'], managedSchemes: [], noAuth: false })).toBe('api_key');
    expect(authKindOf({ authSchemes: ['OAUTH2'], managedSchemes: [], noAuth: false })).toBe('oauth');
    expect(authKindOf({ authSchemes: ['SAML'], managedSchemes: [], noAuth: false })).toBe('other');
    expect(authKindOf({ authSchemes: [], managedSchemes: [], noAuth: true })).toBe('none');
  });

  it('reads why Composio won\'t connect an app', () => {
    expect(unavailableReason(NO_MANAGED_AUTH('twitter'))).toBe('needs-setup');
    expect(unavailableReason("The 'composio_search' toolkit is not available in Composio For You.")).toBe('not-offered');
    expect(unavailableReason('Toolkit weathermap is retired and can no longer be connected or used.')).toBe('retired');
    expect(unavailableReason('Rate limited, try again')).toBeUndefined();
    expect(cantConnectText('Twitter', 'needs-setup')).toMatch(/^Twitter can't be connected from AppuBot yet/);
  });

  it('lists only the apps that can be connected, and counts categories from them', () => {
    const d: AppsDirectory = {
      generatedAt: '',
      categories: [{ id: 'email', name: 'Email', count: 2 }, { id: 'social', name: 'Social', count: 2 }, { id: 'old', name: 'Old', count: 1 }],
      toolkits: [
        { slug: 'gmail', name: 'Gmail', categories: ['email'], authKind: 'oauth' },
        { slug: 'outlook', name: 'Outlook', categories: ['email', 'social'], authKind: 'oauth' },
        { slug: 'twitter', name: 'Twitter', categories: ['social'], authKind: 'oauth' },
        { slug: 'weathermap', name: 'OpenWeatherMap', categories: ['old'], authKind: 'none' },
        { slug: 'composio', name: 'Composio', categories: ['email'], authKind: 'none' },
      ],
    };
    const l = listedDirectory(d, { twitter: 'needs-setup', weathermap: 'retired' });
    expect(l.toolkits.map((t) => t.slug)).toEqual(['gmail', 'outlook']);
    expect(l.unlisted.map((t) => t.slug)).toEqual(['twitter', 'weathermap']);
    expect(l.categories).toEqual([{ id: 'email', name: 'Email', count: 2 }, { id: 'social', name: 'Social', count: 1 }]);
  });

  it('reads the link to a file in Composio\'s sandbox, and takes no other site\'s', () => {
    expect(fileLinkCode('/mnt/files/mex/foot.json')).toBe('r, e = upload_local_file("/mnt/files/mex/foot.json")\nprint("APPUBOT_FILE_ERROR=" + str(e) if e else "APPUBOT_FILE_URL=" + str((r or {}).get("s3_url") or ""))');
    expect(fileLinkIn(JSON.stringify({ data: { stdout: `S3 URL: ${FILE_LINK}\nAPPUBOT_FILE_URL=${FILE_LINK}\n` } }))).toEqual({ url: FILE_LINK });
    expect(fileLinkIn(JSON.stringify({ data: { stdout: 'APPUBOT_FILE_ERROR=File not found: /x\n' } }))).toEqual({ error: 'File not found: /x' });
    expect(fileLinkIn(JSON.stringify({ data: { stdout: 'APPUBOT_FILE_URL=https://evil.example/f\n' } })).error).toMatch(/unexpected link/);
    expect(fileLinkIn(JSON.stringify({ data: { stdout: 'APPUBOT_FILE_URL=http://backend.composio.dev/f\n' } })).error).toMatch(/unexpected link/);
    expect(fileLinkIn('nothing').error).toMatch(/no link/);
  });

  it('capitalises Composio\'s lowercase category names', () => {
    expect(categoryName('productivity')).toBe('Productivity');
    expect(categoryName('developer tools & devops')).toBe('Developer Tools & DevOps');
    expect(categoryName('crm')).toBe('CRM');
    expect(categoryName('ai-and-machine-learning')).toBe('AI and Machine Learning');
    expect(categoryName('Developer Tools')).toBe('Developer Tools');
  });
});
