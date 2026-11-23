import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotSchema, ThreadSchema, type Provider } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { buildHandlers, checkRole } from '../handlers';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

let core: Core;
let runtime: FakeRuntime;
let root: string;
const terminals: string[] = [];
const emitted: Provider[] = [];

const bot = (id: string, providerId: string) => BotSchema.parse({ id, slug: id, name: id, providerId, workspace: join(root, 'bots', id), createdAt: 1, updatedAt: 1 });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-providers-'));
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  // what an older AppuBot left behind: Gemini's switch saved as a built-in, the default and a bot on it, a chat on it,
  // and a custom agent the user added under a now-retired id
  writeFileSync(join(data, 'providers.json'), JSON.stringify([
    { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--acp'], env: {}, builtin: true, enabled: true },
    { id: 'qwen', name: 'My Qwen', command: '/opt/qwen/bin/qwen', args: ['--acp'], env: {}, builtin: false, enabled: true },
  ]));
  writeFileSync(join(data, 'settings.json'), JSON.stringify({ defaultProviderId: 'gemini' }));
  writeFileSync(join(data, 'bots.json'), JSON.stringify([bot('b_gem', 'gemini'), bot('b_qwen', 'qwen')]));
  writeFileSync(join(data, 'threads.json'), JSON.stringify([
    ThreadSchema.parse({ id: 't_gem', botId: 'b_gem', title: 'Old', providerId: 'gemini', cwd: '/w', acpSessionId: 'gem-session', modelId: 'gemini-pro', createdAt: 1, updatedAt: 1 }),
  ]));
  core = createCore({
    paths: { dataDir: data, botsRoot: join(root, 'bots'), filesDir: join(data, 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined,
    openTerminal: (line) => { terminals.push(line); },
    nativeNotify: () => undefined,
    version: '0.0.0-test',
    hostName: 'test-mac',
    log: silentLogger,
    validate: true,
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    computerBackends: () => [],
    helperTransport: () => null,
  });
  core.ctx.bus.on((e) => { if (e.event === 'provider.updated') emitted.push(e.payload as Provider); });
  await core.start();
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('retired built-ins', () => {
  it('drops their saved switches but keeps a custom agent under a retired id', () => {
    core.ctx.store.flush();
    const saved = JSON.parse(readFileSync(join(root, 'data', 'providers.json'), 'utf8')) as { id: string }[];
    expect(saved.map((p) => p.id)).toEqual(['qwen']);
    expect(core.services.providers.list().map((p) => p.id)).toEqual(['claude-code', 'codex', 'qwen']);
  });

  it('moves the default agent, bots and chats to Claude Code', () => {
    const s = core.services;
    expect(s.settings.get().defaultProviderId).toBe('claude-code');
    expect(s.bots.get('b_gem')?.providerId).toBe('claude-code');
    expect(s.bots.get('b_qwen')?.providerId).toBe('qwen');
    const t = s.threads.get('t_gem')!;
    expect(t.providerId).toBe('claude-code');
    expect(t.acpSessionId).toBeUndefined();
    expect(t.modelId).toBeUndefined();
    expect(t.title).toBe('Old');
  });
});

describe('login status', () => {
  it('refresh re-checks every provider, or just the ones asked for', async () => {
    const before = runtime.detections;
    const all = await core.services.providers.refresh();
    expect(runtime.detections).toBe(before + 1);
    expect(all.find((p) => p.id === 'claude-code')?.auth).toMatchObject({ state: 'logged_in', account: 'f***@example.com' });
    runtime.logins.set('codex', 'logged_out');
    const list = await core.services.providers.refresh(['codex', 'nope']);
    expect(list).toHaveLength(3);
    expect(list.find((p) => p.id === 'codex')).toMatchObject({ authStatus: 'needs_auth', auth: { state: 'logged_out' }, canLogOut: true });
  });

  it('watches a login started from AppuBot until it lands', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const res = await core.services.providers.authenticate('codex');
      expect(res.ok).toBe(true);
      expect(terminals.at(-1)).toContain('login');
      emitted.length = 0;
      await vi.advanceTimersByTimeAsync(3000);
      expect(emitted).toHaveLength(0); // still logged out: nothing to say
      runtime.logins.set('codex', 'logged_in');
      await vi.advanceTimersByTimeAsync(3000);
      expect(emitted.map((p) => [p.id, p.auth?.state])).toEqual([['codex', 'logged_in']]);
      const n = runtime.detections;
      await vi.advanceTimersByTimeAsync(9000);
      expect(runtime.detections).toBe(n); // stopped
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a CLI out and re-checks it; a full-access phone may too, a limited one may not', async () => {
    const res = await core.services.providers.logout('claude-code');
    expect(res.ok).toBe(true);
    expect(runtime.logouts).toEqual(['claude-code']);
    expect(core.services.providers.list().find((p) => p.id === 'claude-code')?.auth?.state).toBe('logged_out');
    expect(() => checkRole('providers.logout', { id: 'codex' }, { role: 'full', deviceId: 'p1' })).not.toThrow();
    expect(() => checkRole('providers.logout', { id: 'codex' }, { role: 'limited', deviceId: 'p1' })).toThrow(/not allowed/);
    expect(() => checkRole('providers.logout', { id: 'codex' }, { role: 'owner', deviceId: 'mac' })).not.toThrow();
    // keys never come from a phone
    expect(() => checkRole('providers.setKeys', { id: 'codex', keys: {} }, { role: 'full', deviceId: 'p1' })).toThrow(/not allowed/);
    // nor any other file of the computer's; a lost phone can be removed from another one
    expect(() => checkRole('files.sendToDevices', { path: '/Users/x/.ssh/id_ed25519' }, { role: 'full', deviceId: 'p1' })).toThrow(/not allowed/);
    expect(() => checkRole('devices.revoke', { id: 'p2' }, { role: 'full', deviceId: 'p1' })).not.toThrow();
    expect(() => checkRole('devices.revoke', { id: 'p2' }, { role: 'limited', deviceId: 'p1' })).toThrow(/not allowed/);
  });

  it("a phone's providers.upsert only switches an existing agent on or off", async () => {
    const h = buildHandlers(core.ctx);
    const phone = { role: 'full' as const, deviceId: 'p1' };
    const off = await h['providers.upsert']({ id: 'qwen', name: 'Evil', command: '/bin/evil', enabled: false }, phone);
    expect(off.enabled).toBe(false);
    expect(off.command).toBe('/opt/qwen/bin/qwen');
    expect(off.name).toBe('My Qwen');
    await expect(h['providers.upsert']({ id: 'brand-new', name: 'New', command: '/bin/x' }, phone)).rejects.toThrow(/computer/);
    await h['providers.upsert']({ id: 'qwen', name: 'My Qwen', command: '/opt/qwen/bin/qwen', enabled: true }, phone);
  });
});
