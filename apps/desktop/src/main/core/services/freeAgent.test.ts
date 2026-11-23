/**
 * The free agent on every computer (`freeAgent.ts`): OpenCode is installed where it is missing (through a fake
 * downloader), reads as ready with nothing signed in, is switched on once, and becomes the default where the owner's
 * rule says: an AppuBot Cloud computer and a computer not set up yet start on it, a computer in use only when its own
 * agent can't run, and someone signed in keeps everything.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FREE_MODELS_ACCOUNT } from '@appubot/protocol';
import { providerLogin } from '@appubot/chat-core';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { FreeAgentService } from './freeAgent';

interface Rig { core: Core; runtime: FakeRuntime; installs: number; results: boolean[]; root: string }
const rigs: Rig[] = [];

async function rig(o: { cloud?: boolean; missing?: boolean; results?: boolean[]; claude?: 'logged_in' | 'logged_out'; onboarded?: boolean; savedOff?: boolean } = {}): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), 'appubot-free-agent-'));
  const r = { installs: 0, results: o.results ?? [true], root } as Rig;
  r.core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => {
      const rt = new FakeRuntime(hooks);
      r.runtime = rt;
      const get = rt.getProviders.bind(rt);
      // the real list has OpenCode as a built-in that is on; a saved switch (`custom`) wins over it
      rt.getProviders = () => {
        const list = get();
        return list.some((p) => p.id === 'opencode') ? list : [...list, { id: 'opencode', name: 'OpenCode', command: 'fake-opencode', args: ['acp'], env: {}, builtin: true, enabled: true }];
      };
      // its own login check finds nothing: no account
      rt.logins.set('opencode', 'logged_out');
      rt.logins.set('claude-code', o.claude ?? 'logged_in');
      if (o.missing !== false) rt.notInstalled.add('opencode');
      rt.reply = () => 'Hi!';
      return rt;
    },
    openExternal: () => undefined, openTerminal: () => { throw new Error('nothing opens a terminal for OpenCode'); }, nativeNotify: async () => ({ shown: false }),
    freeAgentInstall: async () => {
      const ok = r.results[Math.min(r.installs, r.results.length - 1)]!;
      r.installs++;
      if (ok) r.runtime.notInstalled.delete('opencode');
      return ok ? { ok: true, output: 'OpenCode 2.3.0 is installed.', version: '2.3.0' } : { ok: false, output: 'The OpenCode download failed (503).' };
    },
    version: '2026.11.14', hostName: 'Test', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    ...(o.cloud ? { cloud: { publicUrl: '', controlToken: 'c', backendUrl: 'https://cloud.test', backendToken: 'b', maxLiveSessions: 3 } } : {}),
  });
  r.core.services.freeAgent = new FreeAgentService(r.core.ctx, { retryDelaysMs: [5, 5], laterMs: 60_000 });
  await r.core.start();
  if (o.savedOff) {
    r.core.ctx.store.providers.update((l) => [...l, { id: 'opencode', name: 'OpenCode', description: '', command: 'fake-opencode', args: ['acp'], env: {}, icon: 'terminal', builtin: true, enabled: false }]);
    r.core.services.providers.applyCustom();
  }
  if (o.onboarded) r.core.services.settings.update({ onboarded: true });
  await r.core.services.providers.refresh();
  rigs.push(r);
  return r;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) { await r.core.stop(); rmSync(r.root, { recursive: true, force: true }); }
});

const openCode = (r: Rig) => r.core.services.providers.list().find((p) => p.id === 'opencode')!;
const firstBot = (r: Rig) => r.core.services.bots.list()[0]!;

describe('OpenCode with nothing signed in', () => {
  it('reads as ready, not as logged out', async () => {
    const r = await rig({ missing: false, onboarded: true });
    const p = openCode(r);
    expect(p.auth).toMatchObject({ state: 'logged_in', account: FREE_MODELS_ACCOUNT });
    expect(providerLogin(p)).toMatchObject({ kind: 'logged_in', label: 'Ready', detail: 'Free models · No account needed' });
  });

  it('is installed by AppuBot itself where it is missing, with no terminal', async () => {
    const r = await rig({ onboarded: true });
    expect(openCode(r).installed).toBe(false);
    expect(await r.core.services.freeAgent.ensure('test')).toBe(true);
    expect(r.installs).toBe(1);
    expect(openCode(r).installed).toBe(true);
    // the Install button takes the same road
    r.runtime.notInstalled.add('opencode');
    const res = await r.core.services.providers.install('opencode');
    expect(res.ok).toBe(true);
    expect(r.installs).toBe(2);
  });

  it('tries again when the download fails, and a chat on it waits for the install', async () => {
    const r = await rig({ onboarded: true, results: [false, true] });
    const ready = r.core.services.freeAgent.ready('opencode');
    expect(await ready).toBe(true);
    expect(r.installs).toBe(2);
    expect(openCode(r).installed).toBe(true);
    // other agents never wait for it
    expect(await r.core.services.freeAgent.ready('claude-code')).toBe(true);
  });

  it('is switched on once for people who had it off; a switch off after that stays', async () => {
    const r = await rig({ missing: false, onboarded: true, savedOff: true });
    expect(openCode(r).enabled).toBe(false);
    await r.core.services.freeAgent.ensure('test');
    expect(openCode(r).enabled).toBe(true);
    r.core.ctx.store.providers.update((l) => l.map((p) => (p.id === 'opencode' ? { ...p, enabled: false } : p)));
    r.core.services.providers.applyCustom();
    r.core.services.freeAgent = new FreeAgentService(r.core.ctx, { retryDelaysMs: [5], laterMs: 60_000 });
    await r.core.services.freeAgent.ensure('again');
    expect(openCode(r).enabled).toBe(false);
  });
});

describe('who starts on OpenCode', () => {
  it('an AppuBot Cloud computer: the default for new bots, and bots never talked to move; one in use stays', async () => {
    const r = await rig({ cloud: true });
    const s = r.core.services;
    const used = s.bots.create({ name: 'Busy', providerId: 'claude-code' });
    s.threads.update(s.threads.chatFor(used.id).id, { lastMessagePreview: 'hello' }, false);
    await s.freeAgent.ensure('test');
    expect(s.settings.get().defaultProviderId).toBe('opencode');
    expect(firstBot(r).providerId).toBe('opencode');
    expect(s.bots.get(used.id)!.providerId).toBe('claude-code');
    expect(s.freeAgent.adopted()).toBe(true);
    // a new bot starts on it
    expect(s.bots.create({ name: 'New', providerId: '' }).providerId).toBe('opencode');
  });

  it('a computer not set up yet starts on it', async () => {
    const r = await rig({});
    await r.core.services.freeAgent.ensure('test');
    expect(r.core.services.settings.get().defaultProviderId).toBe('opencode');
    expect(firstBot(r).providerId).toBe('opencode');
  });

  it('someone signed in to their own agent keeps everything, with OpenCode added beside it', async () => {
    const r = await rig({ onboarded: true });
    await r.core.services.freeAgent.ensure('test');
    expect(r.core.services.settings.get().defaultProviderId).toBe('claude-code');
    expect(firstBot(r).providerId).toBe('claude-code');
    expect(openCode(r)).toMatchObject({ installed: true, enabled: true });
    expect(r.core.services.freeAgent.adopted()).toBe(true);
  });

  it('someone whose agent can’t run is moved onto it', async () => {
    const r = await rig({ onboarded: true, claude: 'logged_out' });
    const s = r.core.services;
    const onCodex = s.bots.create({ name: 'Works', providerId: 'codex' });
    await s.freeAgent.ensure('test');
    expect(s.settings.get().defaultProviderId).toBe('opencode');
    expect(firstBot(r).providerId).toBe('opencode');
    // a bot on an agent that does run is left alone
    expect(s.bots.get(onCodex.id)!.providerId).toBe('codex');
  });

  it('happens once: a default the person picks afterwards is theirs', async () => {
    const r = await rig({ cloud: true });
    const s = r.core.services;
    await s.freeAgent.ensure('test');
    s.settings.update({ defaultProviderId: 'claude-code' });
    s.freeAgent = new FreeAgentService(r.core.ctx, { retryDelaysMs: [5], laterMs: 60_000 });
    await s.freeAgent.ensure('again');
    expect(s.settings.get().defaultProviderId).toBe('claude-code');
  });
});
