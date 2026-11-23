/**
 * Claude Code at an AppuBot Cloud computer's first start (`agentSetup.ts`): a computer with a plan installs it by itself
 * where it is missing (the Settings › Agents installer, through a fake runner), says so on `SystemInfo.cloud.agentSetup`
 * meanwhile, tries again when the install fails, and a turn on Claude (AppuBot AI included) waits for it instead of
 * failing with "claude was not found". Already there, on a Mac, or on a plan that ended: nothing runs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudAgentSetup } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { AgentSetupService } from './agentSetup';

const until = async (test: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); }
};

interface Rig {
  core: Core;
  runtime: FakeRuntime;
  ran: string[];
  /** what each install answers, in turn (the last one repeats) */
  results: { ok: boolean; output: string }[];
  /** set: installs wait for it */
  gate: Promise<void> | null;
  setups: (CloudAgentSetup | undefined)[];
  root: string;
}
const rigs: Rig[] = [];

async function rig(o: { cloud?: boolean; missing?: boolean; results?: Rig['results']; gated?: boolean } = {}): Promise<Rig & { open: () => void }> {
  const root = mkdtempSync(join(tmpdir(), 'appubot-agent-setup-'));
  let open = () => {};
  const r = {
    ran: [] as string[], results: o.results ?? [{ ok: true, output: 'Claude Code installed' }], setups: [] as (CloudAgentSetup | undefined)[], root,
    gate: o.gated ? new Promise<void>((res) => { open = res; }) : null,
  } as Rig;
  r.core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => {
      const rt = new FakeRuntime(hooks);
      r.runtime = rt;
      const get = rt.getProviders.bind(rt);
      rt.getProviders = () => get().map((p) => (p.id === 'claude-code' ? { ...p, installHint: 'curl -fsSL https://claude.ai/install.sh | bash' } : p));
      if (o.missing !== false) rt.notInstalled.add('claude-code');
      // like the real runtime: a CLI that isn't there can't start
      const create = rt.createSession.bind(rt);
      rt.createSession = async (opts) => {
        if (rt.notInstalled.has(opts.providerId.split('@')[0]!)) throw new Error('Provider "claude-code" is not installed: "claude" was not found on PATH');
        return create(opts);
      };
      rt.reply = () => 'Hi!';
      return rt;
    },
    openExternal: () => undefined, openTerminal: () => { throw new Error('no terminal on a cloud computer'); }, nativeNotify: async () => ({ shown: false }),
    updateIo: {
      run: async (_command, args) => {
        r.ran.push(args.join(' '));
        if (r.gate) await r.gate;
        const res = r.results[Math.min(r.ran.length - 1, r.results.length - 1)]!;
        if (res.ok) r.runtime.notInstalled.delete('claude-code');
        return res;
      },
    },
    version: '2026.11.06', hostName: 'My Cloud Computer', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    ...(o.cloud === false ? {} : { cloud: { publicUrl: '', controlToken: 'c', backendUrl: 'https://cloud.test', backendToken: 'b', maxLiveSessions: 3 } }),
  });
  // quick retries for the test
  r.core.services.agentSetup = new AgentSetupService(r.core.ctx, { retryDelaysMs: [10, 10], laterMs: 60_000 });
  await r.core.start();
  r.core.ctx.bus.on((e) => { if (e.event === 'system.updated') r.setups.push((e.payload as { cloud?: { agentSetup?: CloudAgentSetup } }).cloud?.agentSetup); });
  rigs.push(r);
  return Object.assign(r, { open: () => open() });
}

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.core.services.agentSetup.stop();
    await r.core.stop();
    rmSync(r.root, { recursive: true, force: true });
  }
});

const claude = (r: Rig) => r.core.services.providers.list().find((p) => p.id === 'claude-code')!;

describe('Claude Code at a cloud computer’s first start', () => {
  it('installs itself where it is missing, saying so meanwhile, with Settings › Agents’ own installer', async () => {
    const r = await rig({ gated: true });
    r.core.services.agentSetup.start();
    await until(() => r.ran.length === 1);
    expect(r.ran[0]).toBe('-lc curl -fsSL https://claude.ai/install.sh | bash');
    expect(r.core.services.system.info().cloud?.agentSetup).toMatchObject({ providerId: 'claude-code', name: 'Claude Code', state: 'installing', attempt: 1 });
    expect(claude(r).installing).toBe(true);
    r.open();
    await until(() => r.core.services.system.info().cloud?.agentSetup === undefined);
    expect(claude(r)).toMatchObject({ installed: true });
    expect(r.setups.at(-1)).toBeUndefined();
    // a second start (the gateway restarting) finds it there and runs nothing
    r.core.services.agentSetup.start();
    await new Promise((res) => setTimeout(res, 30));
    expect(r.ran).toHaveLength(1);
  });

  it('runs nothing where Claude Code is already there, on a Mac, or on a plan that ended', async () => {
    const there = await rig({ missing: false });
    await there.core.services.agentSetup.ensure('test');
    expect(there.ran).toHaveLength(0);
    expect(there.core.services.system.info().cloud?.agentSetup).toBeUndefined();

    const mac = await rig({ cloud: false });
    mac.core.services.agentSetup.start();
    expect(await mac.core.services.agentSetup.ready('claude-code')).toBe(true);
    expect(mac.ran).toHaveLength(0);

    const ended = await rig();
    ended.core.services.system.setCloudState({ state: 'export-only' });
    ended.core.services.agentSetup.start();
    await new Promise((res) => setTimeout(res, 30));
    expect(ended.ran).toHaveLength(0);
    // the plan back: it sets Claude up then
    ended.core.services.system.setCloudState({ state: 'ok' });
    await until(() => ended.ran.length === 1);
  });

  it('tries again after a failed install, then gives up for now with the installer’s last words', async () => {
    const r = await rig({ results: [{ ok: false, output: 'curl: (6) Could not resolve host: claude.ai' }] });
    const ok = await r.core.services.agentSetup.ensure('test');
    expect(ok).toBe(false);
    expect(r.ran).toHaveLength(3);
    expect(r.setups.some((s) => s?.state === 'retrying' && s.attempt === 1 && !!s.retryAt)).toBe(true);
    expect(r.core.services.system.info().cloud?.agentSetup).toMatchObject({ state: 'failed', attempt: 3, error: 'curl: (6) Could not resolve host: claude.ai' });
  });

  it('succeeds on a later try', async () => {
    const r = await rig({ results: [{ ok: false, output: 'network down' }, { ok: true, output: 'done' }] });
    expect(await r.core.services.agentSetup.ensure('test')).toBe(true);
    expect(r.ran).toHaveLength(2);
    expect(r.core.services.system.info().cloud?.agentSetup).toBeUndefined();
  });

  it('a message to a Claude bot waits for the setup and is answered, instead of failing', async () => {
    const r = await rig({ gated: true });
    r.core.services.agentSetup.start();
    await until(() => r.ran.length === 1);
    const bot = r.core.services.bots.list()[0]!;
    expect(bot.providerId).toBe('claude-code');
    const sent = r.core.services.chat.send({ botId: bot.id, text: 'hello', attachments: [], images: [] });
    await new Promise((res) => setTimeout(res, 30));
    const reply = () => r.core.services.threads.messages(sent.userMessage.threadId).find((m) => m.id === sent.agentMessageId);
    expect(reply()?.status).toBe('streaming');
    r.open();
    await until(() => reply()?.status === 'complete');
    expect(reply()!.parts[0]).toMatchObject({ type: 'text', text: 'Hi!' });
  });

  it('after giving up, the next message to a Claude bot tries again and waits for it', async () => {
    const r = await rig({ results: [{ ok: false, output: 'no' }, { ok: false, output: 'no' }, { ok: false, output: 'no' }, { ok: true, output: 'yes' }] });
    await r.core.services.agentSetup.ensure('test');
    expect(r.core.services.system.info().cloud?.agentSetup?.state).toBe('failed');
    const bot = r.core.services.bots.list()[0]!;
    const sent = r.core.services.chat.send({ botId: bot.id, text: 'hello', attachments: [], images: [] });
    const reply = () => r.core.services.threads.messages(sent.userMessage.threadId).find((m) => m.id === sent.agentMessageId);
    await until(() => reply()?.status === 'complete');
    expect(r.ran).toHaveLength(4);
    expect(r.core.services.system.info().cloud?.agentSetup).toBeUndefined();
  });

  it('forgets a failure once Claude Code is installed another way (Settings › Agents)', async () => {
    const r = await rig({ results: [{ ok: false, output: 'no' }, { ok: false, output: 'no' }, { ok: false, output: 'no' }, { ok: true, output: 'yes' }] });
    r.core.services.agentSetup.start();
    await until(() => r.core.services.system.info().cloud?.agentSetup?.state === 'failed');
    await r.core.services.providers.install('claude-code');
    expect(r.core.services.system.info().cloud?.agentSetup).toBeUndefined();
  });

  it('greets a new bot once Claude Code is there rather than skipping it', async () => {
    const r = await rig({ gated: true });
    r.core.services.agentSetup.start();
    await until(() => r.ran.length === 1);
    const bot = r.core.services.bots.list()[0]!;
    r.core.services.chat.greet(bot.id);
    await new Promise((res) => setTimeout(res, 30));
    expect(r.core.services.threads.history(bot.id, { limit: 5 }).messages).toHaveLength(0);
    r.open();
    await until(() => r.core.services.threads.history(bot.id, { limit: 5 }).messages.some((m) => m.role === 'agent' && m.status === 'complete'));
  });
});
