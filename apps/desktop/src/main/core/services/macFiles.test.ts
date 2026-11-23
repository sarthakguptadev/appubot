/**
 * A person's own computer lending folders to the bots on another (`macLink.ts` lends, `macFiles.ts` reads; protocol
 * `carry.ts`): two cores and an in-process relay. The reader dials the lender through the relay with the token it was
 * handed, over the end-to-end channel, and gets only what was lent: the rules are checked where the files are.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { basename, join } from 'node:path';
import { WebSocket } from 'ws';
import { GatewayClient } from '@appubot/client';
import { MAC_FILE_MAX_BYTES } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import type { CoreDeps } from '../context';
import { FakeRelay } from '../testing/fakeRelay';
import { FakeRuntime } from '../testing/fakeRuntime';
import { RpcError, silentLogger } from '../util';
import { inside, refusal, REPLACED_DIR } from './macLink';

const cores: Core[] = [];
const relays: FakeRelay[] = [];
const roots: string[] = [];
const newRoot = (name: string) => { const r = realpathSync(mkdtempSync(join(tmpdir(), `appubot-${name}-`))); roots.push(r); return r; };
afterEach(async () => {
  for (const c of cores.splice(0)) await c.stop();
  for (const r of relays.splice(0)) await r.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const until = async (test: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

function makeCore(root: string, relay: FakeRelay, hostName: string, extra: Partial<CoreDeps> = {}): Core {
  const core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName, log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    connect: { relayUrl: relay.url, spreadMs: 0 },
    ...extra,
  });
  cores.push(core);
  return core;
}

/** a home folder with things to lend and things never to */
function makeHome(): string {
  const home = newRoot('home');
  mkdirSync(join(home, 'Documents', 'Invoices'), { recursive: true });
  writeFileSync(join(home, 'Documents', 'plan.md'), '# The plan\n');
  writeFileSync(join(home, 'Documents', 'Invoices', 'invoice-042.pdf'), Buffer.from('%PDF-1.7 not really'));
  mkdirSync(join(home, 'Desktop'));
  writeFileSync(join(home, 'Desktop', 'notes.txt'), 'private notes');
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
  mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true });
  writeFileSync(join(home, 'Library', 'prefs.plist'), 'x');
  mkdirSync(join(home, '.config'));
  writeFileSync(join(home, '.config', 'settings.json'), '{}');
  // a link inside a lent folder that points out of it
  symlinkSync(join(home, 'Desktop', 'notes.txt'), join(home, 'Documents', 'shortcut.txt'));
  return home;
}

async function pair(macDeps: Partial<CoreDeps> = {}): Promise<{ mac: Core; cloud: Core; home: string; relay: FakeRelay; ctx: { threadId: string; botId: string } }> {
  const relay = new FakeRelay();
  relays.push(relay);
  await relay.listening;
  const home = makeHome();
  const mac = makeCore(newRoot('mac'), relay, 'Ada’s MacBook Pro', { homeDir: home, ...macDeps });
  const cloud = makeCore(newRoot('cloud'), relay, 'Ada’s Cloud Computer');
  await mac.start();
  await cloud.start();
  const bot = cloud.services.bots.list()[0]!;
  return { mac, cloud, home, relay, ctx: { threadId: 'th_test', botId: bot.id } };
}

async function linkUp(mac: Core, cloud: Core, relay: FakeRelay): Promise<string> {
  const grant = await mac.services.macLink.create('Ada’s Cloud Computer');
  await until(() => relay.hosts.size === 1);
  cloud.services.macFiles.link({ linkId: grant.id, token: grant.token, connectId: grant.connectId, connectKey: grant.connectKey, name: 'Ada’s MacBook Pro' });
  return grant.id;
}

describe('what is lent', () => {
  it('is only inside a lent folder, never what holds sign-ins, and not the home folder’s own Library or dot-folders', () => {
    const home = '/Users/ada';
    const rules = { home, folders: [home], never: ['/Users/ada/.appubot'] };
    expect(inside('/Users/ada/Documents/a', '/Users/ada')).toBe(true);
    expect(inside('/Users/adam', '/Users/ada')).toBe(false);
    expect(refusal('/Users/ada/Documents/a.txt', rules)).toBeNull();
    expect(refusal('/Users/ada', rules)).toBeNull();
    expect(refusal('/Users/bob/a.txt', rules)).toMatch(/outside/);
    expect(refusal('/Users/ada/.ssh/id_ed25519', rules)).toMatch(/never lent/);
    expect(refusal('/Users/ada/Library/Keychains/login.keychain-db', rules)).toMatch(/never lent/);
    expect(refusal('/Users/ada/.appubot/vault.json', rules)).toMatch(/never lent/);
    expect(refusal('/Users/ada/Library/Application Support/Google/Chrome/Default/Cookies', rules)).toMatch(/isn’t lent/);
    expect(refusal('/Users/ada/.config/app/settings.json', rules)).toMatch(/isn’t lent/);
    // picked by name, a folder in there is lent; what holds sign-ins still never is
    const icloud = { home, folders: ['/Users/ada/Library/Mobile Documents'], never: [] };
    expect(refusal('/Users/ada/Library/Mobile Documents/com~apple~CloudDocs/a.txt', icloud)).toBeNull();
    expect(refusal('/Users/ada/Library/Keychains/x', { home, folders: ['/Users/ada/Library'], never: [] })).toMatch(/never lent/);
  });
});

describe('a computer’s folders, read from another', () => {
  it('lists, finds and brings over what was lent, through the relay', async () => {
    const { mac, cloud, home, relay, ctx } = await pair();
    mac.services.macLink.setFolders([join(home, 'Documents')]);
    await linkUp(mac, cloud, relay);
    const files = cloud.services.macFiles;
    expect(files.status().linked?.name).toBe('Ada’s MacBook Pro');
    expect(cloud.services.bots.instructionsOptions().mac).toBe('Ada’s MacBook Pro');

    const top = await files.agentList(ctx);
    expect(top).toEqual({ mac: 'Ada’s MacBook Pro', folders: [{ name: 'Documents', path: join(home, 'Documents') }] });

    const docs = await files.agentList(ctx, join(home, 'Documents'));
    // folders first; the link that points out of the lent folder isn't there
    expect(docs.entries!.map((e) => [e.name, e.dir])).toEqual([['Invoices', true], ['plan.md', false]]);
    expect(docs.entries![1]).toMatchObject({ size: 11, path: join(home, 'Documents', 'plan.md') });

    const found = await files.agentFind(ctx, 'INVOICE-0');
    expect(found.entries.map((e) => e.path)).toEqual([join(home, 'Documents', 'Invoices', 'invoice-042.pdf')]);

    const got = await files.agentFetch(ctx, join(home, 'Documents', 'Invoices', 'invoice-042.pdf'));
    expect(got).toMatchObject({ name: 'invoice-042.pdf', bytes: 19 });
    expect(got.path).toBe(join(cloud.services.bots.list()[0]!.workspace, 'inbox', 'mac', 'invoice-042.pdf'));
    expect(readFileSync(got.path, 'utf8')).toBe('%PDF-1.7 not really');
    // the same file again keeps both copies
    expect((await files.agentFetch(ctx, join(home, 'Documents', 'Invoices', 'invoice-042.pdf'))).path).toMatch(/invoice-042 \(2\)\.pdf$/);

    expect(await files.check()).toMatchObject({ ok: true, folders: [{ name: 'Documents' }] });
    expect(mac.services.macLink.status().links[0]!.lastUsedAt).toBeGreaterThan(0);
  });

  it('refuses what wasn’t lent, in the lending computer’s own words', async () => {
    const { mac, cloud, home, relay, ctx } = await pair();
    // the whole home folder lent: Documents and Desktop, never its keys, Library or dot-folders
    mac.services.macLink.setFolders([home]);
    await linkUp(mac, cloud, relay);
    const files = cloud.services.macFiles;
    const names = (await files.agentList(ctx, home)).entries!.map((e) => e.name);
    expect(names).toEqual(['Desktop', 'Documents']);
    await expect(files.agentFetch(ctx, join(home, '.ssh', 'id_ed25519'))).rejects.toThrow(/never lent/);
    await expect(files.agentList(ctx, join(home, 'Library'))).rejects.toThrow(/isn’t lent/);
    await expect(files.agentFetch(ctx, join(home, '.config', 'settings.json'))).rejects.toThrow(/isn’t lent/);
    await expect(files.agentFetch(ctx, join(mac.ctx.paths.dataDir, 'mac-link.json'))).rejects.toThrow(/outside|never lent/);
    await expect(files.agentFetch(ctx, '/etc/hosts')).rejects.toThrow(/outside/);
    await expect(files.agentFetch(ctx, join(home, 'Documents', 'nope.txt'))).rejects.toThrow(/Nothing is at/);
    await expect(files.agentFetch(ctx, join(home, 'Documents'))).rejects.toThrow(/is a folder/);
    // a search never surfaces them either
    expect((await files.agentFind(ctx, 'id_ed25519')).entries).toEqual([]);
    expect((await files.agentFind(ctx, 'prefs')).entries).toEqual([]);

    // folders that hold sign-ins can't be picked at all
    expect(() => mac.services.macLink.setFolders([join(home, '.ssh')])).toThrow(/sign-ins or keys/);
    expect(() => mac.services.macLink.setFolders(['/'])).toThrow(/whole disk/);
    expect(() => mac.services.macLink.setFolders([join(home, 'Nope')])).toThrow(/isn’t there/);
    // one inside another adds nothing
    expect(mac.services.macLink.setFolders([join(home, 'Documents', 'Invoices'), join(home, 'Documents')]).folders).toEqual([join(home, 'Documents')]);
  });

  it('stops answering once the link is taken back, and says when the other computer is off', async () => {
    const { mac, cloud, home, relay, ctx } = await pair();
    mac.services.macLink.setFolders([join(home, 'Documents')]);
    const id = await linkUp(mac, cloud, relay);
    const files = cloud.services.macFiles;
    expect((await files.agentList(ctx)).folders).toHaveLength(1);

    // a second computer linked keeps the relay up after the first is taken back
    const other = await mac.services.macLink.create('Another computer');
    mac.services.macLink.revoke(id);
    await expect(files.agentList(ctx)).rejects.toThrow(/no longer lends its files/);
    // a token never opens anything else on the gateway
    const port = mac.gateway.port;
    const asLink = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${other.token}` } });
    expect((await asLink('/api/link/roots')).status).toBe(200);
    expect((await asLink('/files/anything')).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/api/link/roots?token=${other.token}`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/api/link/roots`, { headers: { authorization: `Bearer ${mac.ownerToken}` } })).status).toBe(401);

    // the last link gone: the computer leaves the relay, and the reader says it can't be reached
    mac.services.macLink.revoke(other.id);
    await until(() => relay.hosts.size === 0);
    cloud.services.macFiles.link({ linkId: other.id, token: other.token, connectId: other.connectId, connectKey: other.connectKey, name: 'Ada’s MacBook Pro' });
    const err = await files.agentList(ctx).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).message).toMatch(/isn’t reachable right now/);

    // unlinked: the bots are told there is nothing to read, and their instructions no longer name it
    cloud.services.macFiles.unlink();
    await expect(files.agentList(ctx)).rejects.toThrow(/None of the user’s own computers is linked/);
    expect(cloud.services.bots.instructionsOptions().mac).toBeUndefined();
  });
});

describe('saving back to a computer’s folders', () => {
  /** a Trash that takes files the way the OS's does: moved out of the folder, kept */
  const fakeTrash = () => {
    const dir = newRoot('trash');
    return { dir, trashItem: async (p: string) => { renameSync(p, join(dir, basename(p))); } };
  };
  const workspaceOf = (cloud: Core) => cloud.services.bots.list()[0]!.workspace;

  it('saves only where the folder was switched to take changes, and a replaced file goes to the Trash', async () => {
    const trash = fakeTrash();
    const { mac, cloud, home, relay, ctx } = await pair({ trashItem: trash.trashItem });
    const docs = join(home, 'Documents');
    mac.services.macLink.setFolders([docs, join(home, 'Desktop')]);
    await linkUp(mac, cloud, relay);
    const files = cloud.services.macFiles;
    const plan = join(docs, 'plan.md');

    // lent folders start read-only, and say so
    expect((await files.agentList(ctx)).folders!.every((f) => !f.writable)).toBe(true);
    await expect(files.agentPut(ctx, { path: plan, text: 'nope' })).rejects.toThrow(/read-only/);
    expect(readFileSync(plan, 'utf8')).toBe('# The plan\n');

    expect(mac.services.macLink.setWritable(docs, true).writable).toEqual([docs]);
    expect((await files.agentList(ctx)).folders).toEqual([{ name: 'Desktop', path: join(home, 'Desktop') }, { name: 'Documents', path: docs, writable: true }]);
    expect(await files.check()).toMatchObject({ ok: true, folders: [{ name: 'Desktop' }, { name: 'Documents', writable: true }] });

    // a new file, with the folders it needs
    const made = await files.agentPut(ctx, { path: join(docs, 'Drafts', '2026', 'article.md'), text: '# Draft\n' });
    expect(made).toEqual({ mac: 'Ada’s MacBook Pro', path: join(docs, 'Drafts', '2026', 'article.md'), bytes: 8, replaced: false });
    expect(readFileSync(join(docs, 'Drafts', '2026', 'article.md'), 'utf8')).toBe('# Draft\n');

    // a file the bot fetched, edited in its folder, put back: the old version is in the Trash, the mode kept
    const fetched = await files.agentFetch(ctx, plan);
    writeFileSync(fetched.path, '# The plan, fixed\n');
    const before = statSync(plan).mode & 0o777;
    const put = await files.agentPut(ctx, { path: plan, from: fetched.path });
    expect(put).toMatchObject({ path: plan, bytes: 18, replaced: true, oldVersion: 'trash' });
    expect(readFileSync(plan, 'utf8')).toBe('# The plan, fixed\n');
    expect(statSync(plan).mode & 0o777).toBe(before);
    expect(readFileSync(join(trash.dir, 'plan.md'), 'utf8')).toBe('# The plan\n');
    // relative to the bot's own folder works too, and nothing half written is left beside it
    await files.agentPut(ctx, { path: plan, from: join('inbox', 'mac', basename(fetched.path)) });
    expect(readdirSync(docs).filter((n) => n.includes('.appubot-'))).toEqual([]);

    // what the person sees: when a bot last saved, and which file
    const l = mac.services.macLink.status().links[0]!;
    expect(l.lastSavedName).toBe('plan.md');
    expect(l.lastSavedAt).toBeGreaterThan(0);

    // switched back off: read-only again, and lending the folders anew keeps only the switches still lent
    mac.services.macLink.setWritable(docs, false);
    await expect(files.agentPut(ctx, { path: plan, text: 'x' })).rejects.toThrow(/read-only/);
    mac.services.macLink.setWritable(docs, true);
    expect(mac.services.macLink.setFolders([join(home, 'Desktop')]).writable).toEqual([]);
    expect(mac.services.macLink.setFolders([join(home, 'Desktop'), docs]).writable).toEqual([]);
    expect(() => mac.services.macLink.setWritable(join(home, 'Nope'), true)).toThrow(/isn’t one of the folders/);
  });

  it('is the bot’s own tool: its call through the computer’s gateway saves the file', async () => {
    const { mac, cloud, home, relay } = await pair();
    const docs = join(home, 'Documents');
    mac.services.macLink.setFolders([docs]);
    mac.services.macLink.setWritable(docs, true);
    await linkUp(mac, cloud, relay);
    const bot = cloud.services.bots.list()[0]!;
    const thread = cloud.services.threads.chatFor(bot.id);
    const token = cloud.ctx.auth.issueAgentToken({ threadId: thread.id, botId: bot.id });
    const agent = new GatewayClient({ baseUrl: `http://127.0.0.1:${cloud.gateway.port}`, token, device: { id: 'mac-put-test', name: 'bridge', platform: 'cli' }, WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket, callTimeoutMs: 10_000 });
    await new Promise<void>((resolve, reject) => {
      const off = agent.onState((st, err) => { if (st === 'connected') { off(); resolve(); } if (st === 'unauthorized') { off(); reject(new Error(err)); } });
      agent.connect();
    });
    try {
      expect(await agent.call('agent.mac.put', { path: join(docs, 'notes', 'todo.md'), text: '- fix two phrases\n' })).toMatchObject({ mac: 'Ada’s MacBook Pro', replaced: false, bytes: 18 });
      expect(readFileSync(join(docs, 'notes', 'todo.md'), 'utf8')).toBe('- fix two phrases\n');
      await expect(agent.call('agent.mac.put', { path: join(docs, 'x.md'), text: 'a', from: 'b' })).rejects.toThrow(/either from/);
    } finally { agent.close(); }
  });

  it('keeps the old version in AppuBot’s own folder where there is no Trash', async () => {
    const { mac, cloud, home, relay, ctx } = await pair();
    const docs = join(home, 'Documents');
    mac.services.macLink.setFolders([docs]);
    mac.services.macLink.setWritable(docs, true);
    await linkUp(mac, cloud, relay);
    const r = await cloud.services.macFiles.agentPut(ctx, { path: join(docs, 'plan.md'), text: 'v2' });
    expect(r).toMatchObject({ replaced: true, oldVersion: 'kept' });
    const kept = join(mac.ctx.paths.dataDir, REPLACED_DIR);
    const names = readdirSync(kept);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/-plan\.md$/);
    expect(readFileSync(join(kept, names[0]!), 'utf8')).toBe('# The plan\n');
    expect(readFileSync(join(docs, 'plan.md'), 'utf8')).toBe('v2');
  });

  it('refuses what isn’t a changeable file in a folder switched on, in the lending computer’s own words', async () => {
    const { mac, cloud, home, relay, ctx } = await pair();
    // the whole home folder lent and switched on: still never its keys, Library, dot-folders or hidden files
    mac.services.macLink.setFolders([home]);
    mac.services.macLink.setWritable(home, true);
    await linkUp(mac, cloud, relay);
    const files = cloud.services.macFiles;
    const put = (path: string, text = 'x') => files.agentPut(ctx, { path, text });
    await expect(put(join(home, '.ssh', 'authorized_keys'))).rejects.toThrow(/never lent/);
    await expect(put(join(home, '.netrc'))).rejects.toThrow(/never lent|isn’t lent/);
    await expect(put(join(home, 'Library', 'LaunchAgents', 'x.plist'))).rejects.toThrow(/isn’t lent/);
    await expect(put(join(home, 'Documents', '.git', 'hooks', 'post-checkout'))).rejects.toThrow(/Hidden files/);
    await expect(put(join(home, 'Documents', '.env'))).rejects.toThrow(/Hidden files/);
    await expect(put(join(mac.ctx.paths.dataDir, 'mac-link.json'))).rejects.toThrow(/outside|never lent/);
    await expect(put('/etc/hosts-appubot')).rejects.toThrow(/outside/);
    await expect(put(join(home, 'Documents'))).rejects.toThrow(/is a folder/);
    await expect(put('Documents/plan.md')).rejects.toThrow(/full path/);
    expect(existsSync(join(home, 'Documents', '.env'))).toBe(false);
    expect(readFileSync(join(home, '.ssh', 'id_ed25519'), 'utf8')).toBe('PRIVATE KEY');

    // a link out of a folder that takes changes leads nowhere: Documents switched on, Desktop read-only
    mac.services.macLink.setFolders([join(home, 'Documents'), join(home, 'Desktop')]);
    mac.services.macLink.setWritable(join(home, 'Documents'), true);
    await expect(put(join(home, 'Documents', 'shortcut.txt'))).rejects.toThrow(/read-only/);
    // and with Desktop not lent at all, outside
    mac.services.macLink.setFolders([join(home, 'Documents')]);
    mac.services.macLink.setWritable(join(home, 'Documents'), true);
    await expect(put(join(home, 'Documents', 'shortcut.txt'))).rejects.toThrow(/outside/);
    // a folder made of a link out: the file would land outside, so nothing is made
    symlinkSync(join(home, 'Desktop'), join(home, 'Documents', 'desk'));
    await expect(put(join(home, 'Documents', 'desk', 'new', 'a.txt'))).rejects.toThrow(/outside/);
    expect(existsSync(join(home, 'Desktop', 'new'))).toBe(false);
    expect(readFileSync(join(home, 'Desktop', 'notes.txt'), 'utf8')).toBe('private notes');

    // only a file of the bot's own, and none too big
    await expect(files.agentPut(ctx, { path: join(home, 'Documents', 'a.txt'), from: join(cloud.ctx.paths.dataDir, 'settings.json') })).rejects.toThrow(/your own folder|Nothing is at/);
    const big = join(workspaceOf(cloud), 'big.bin');
    writeFileSync(big, '');
    truncateSync(big, MAC_FILE_MAX_BYTES + 1);
    await expect(files.agentPut(ctx, { path: join(home, 'Documents', 'big.bin'), from: big })).rejects.toThrow(/larger than/);
    expect(existsSync(join(home, 'Documents', 'big.bin'))).toBe(false);
  });

  it('takes a save only with the link’s token, and refuses one declared too big before reading it', async () => {
    const { mac, cloud, home, relay } = await pair();
    const docs = join(home, 'Documents');
    mac.services.macLink.setFolders([docs]);
    mac.services.macLink.setWritable(docs, true);
    const grant = await mac.services.macLink.create('Ada’s Cloud Computer');
    await until(() => relay.hosts.size === 1);
    void cloud;
    const port = mac.gateway.port;
    const target = encodeURIComponent(join(docs, 'plan.md'));
    const post = (auth: string | undefined, body: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}/api/link/put?path=${target}`, {
      method: 'POST', body, headers: { ...(auth ? { authorization: auth } : {}), ...headers },
    });
    expect((await post(undefined, 'x')).status).toBe(401);
    expect((await post(`Bearer ${mac.ownerToken}`, 'x')).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/api/link/put?path=${target}&token=${grant.token}`, { method: 'POST', body: 'x' })).status).toBe(401);
    // a body said to be too big is refused before any of it is read
    const declared = await new Promise<number>((done, fail) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: `/api/link/put?path=${target}`, headers: { authorization: `Bearer ${grant.token}`, 'content-length': String(MAC_FILE_MAX_BYTES + 1) } }, (res) => { done(res.statusCode ?? 0); res.resume(); req.destroy(); });
      req.on('error', fail);
      req.write('x');
    });
    expect(declared).toBe(413);
    expect(readFileSync(join(docs, 'plan.md'), 'utf8')).toBe('# The plan\n');
    const ok = await post(`Bearer ${grant.token}`, 'hello');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ bytes: 5, replaced: true, oldVersion: 'kept' });
    // taken back: the token saves nothing
    mac.services.macLink.revoke(grant.id);
    expect((await post(`Bearer ${grant.token}`, 'again')).status).toBe(401);
    expect(readFileSync(join(docs, 'plan.md'), 'utf8')).toBe('hello');
  });

  it('tells the bot to update a computer from before, which has no way to save', async () => {
    const { mac, cloud, home, relay, ctx } = await pair();
    mac.services.macLink.setFolders([join(home, 'Documents')]);
    await linkUp(mac, cloud, relay);
    // its folders answer without `saves`: nothing is sent, and the bot is told what to do
    const roots = mac.services.macLink.roots.bind(mac.services.macLink);
    mac.services.macLink.roots = () => { const { saves: _s, ...old } = roots(); return old as ReturnType<typeof roots>; };
    await expect(cloud.services.macFiles.agentPut(ctx, { path: join(home, 'Documents', 'plan.md'), text: 'x' })).rejects.toThrow(/too old to take changes from bots/);
    expect(readFileSync(join(home, 'Documents', 'plan.md'), 'utf8')).toBe('# The plan\n');
    const files = cloud.services.macFiles as unknown as { refused(res: { status: number; body: Uint8Array; headers: Record<string, string> }, l: { name: string }, tooOld?: string): Error };
    const notFound = { status: 404, body: Buffer.from(JSON.stringify({ error: 'Not found' })), headers: {} };
    expect(files.refused(notFound, { name: 'Ada’s MacBook Pro' }, 'too old to take changes').message).toBe('too old to take changes');
    // a file that isn't there is the lending computer's own answer, never "too old"
    const missing = { status: 404, body: Buffer.from(JSON.stringify({ error: 'Nothing is at /x.', code: 'not_found' })), headers: {} };
    expect(files.refused(missing, { name: 'Ada’s MacBook Pro' }, 'too old').message).toBe('Nothing is at /x.');
  });
});
