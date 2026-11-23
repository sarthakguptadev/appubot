/**
 * The included Claude credit on a cloud computer (`services/credit.ts`): the backend's word
 * kept (the token on disk 0600, never in `SystemInfo`), the AppuBot AI agent offered as a Claude Code profile with
 * the gateway environment, the defaults applied once (the default agent and the bots on plain Claude Code), a
 * status-only answer keeping the token, a rotated token restarting its chats, the credit going away moving the bots
 * back, and nothing of it on a Mac.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPUBOT_AI_PROVIDER_ID, type CloudCreditSettings } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import type { CloudDeps } from '../context';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

const cloud: CloudDeps = { publicUrl: 'https://abc.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 };
const credit = (over: Partial<CloudCreditSettings> = {}): CloudCreditSettings => ({ enabled: true, budgetCents: 1200, usedCents: 740, currency: 'USD', resetsAt: Date.now() + 86_400_000, exhausted: false, defaultModel: 'claude-haiku-5-5', baseUrl: 'https://cloud.test/v1/ai', token: 'ck_first', key: 'k1', ...over });

function make(deps: { cloud?: CloudDeps }) {
  const root = mkdtempSync(join(tmpdir(), 'appubot-credit-'));
  let runtime!: FakeRuntime;
  const core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: async () => ({ shown: false, error: 'test' }),
    version: '2026.11.05', hostName: deps.cloud ? 'AppuBot Cloud' : 'Test Mac', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null, ...deps,
  });
  return { root, core, runtime: () => runtime };
}

describe('the included credit on a cloud computer', () => {
  let core: Core; let root: string; let runtime: () => FakeRuntime;
  beforeAll(async () => { ({ core, root, runtime } = make({ cloud })); await core.start(); });
  afterAll(async () => { await core.stop(); rmSync(root, { recursive: true, force: true }); });
  const s = () => core.services;

  it('starts with nothing: no agent, no status, an empty key for the heartbeat', () => {
    expect(s().credit.active()).toBe(false);
    expect(s().credit.key()).toBe('');
    expect(s().system.cloudInfo()?.credit).toBeUndefined();
    expect(s().providers.list().some((p) => p.id === APPUBOT_AI_PROVIDER_ID)).toBe(false);
    expect(s().settings.get().defaultProviderId).toBe('claude-code');
  });

  it('takes the backend’s word: the agent appears signed in, the defaults move to it, the token stays off the wire', async () => {
    const bots = s().bots.list();
    expect(bots.length).toBeGreaterThan(0);
    expect(bots.every((b) => b.providerId === 'claude-code')).toBe(true);
    s().system.setCloudState({ state: 'ok', credit: credit() });
    expect(s().credit.active()).toBe(true);
    expect(s().credit.key()).toBe('k1');
    expect(s().system.cloudInfo()?.credit).toEqual({ budgetCents: 1200, usedCents: 740, currency: 'USD', resetsAt: expect.any(Number), exhausted: false, defaultModel: 'claude-haiku-5-5' });
    expect(JSON.stringify(s().system.info())).not.toContain('ck_first');
    const file = join(root, 'data', 'cloud-credit.json');
    expect(readFileSync(file, 'utf8')).toContain('ck_first');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await s().providers.refresh([APPUBOT_AI_PROVIDER_ID]);
    const ai = s().providers.list().find((p) => p.id === APPUBOT_AI_PROVIDER_ID)!;
    expect(ai).toMatchObject({ name: 'AppuBot AI', authStatus: 'authenticated', auth: { state: 'logged_in', account: 'Claude launch bonus' }, profile: { of: 'claude-code', source: 'credit' } });
    expect(ai.profile!.home).toBe(join(root, 'data', 'profiles', 'claude-code', 'appubot-ai'));
    expect(existsSync(ai.profile!.home)).toBe(true);
    expect(s().settings.get()).toMatchObject({ defaultProviderId: APPUBOT_AI_PROVIDER_ID, defaultModelId: 'claude-haiku-5-5' });
    expect(s().bots.list().every((b) => b.providerId === APPUBOT_AI_PROVIDER_ID && b.modelId === 'claude-haiku-5-5')).toBe(true);
    // the runtime's hook: the gateway environment for AppuBot AI alone
    expect(runtime().hooks.secretEnv?.(APPUBOT_AI_PROVIDER_ID)).toEqual({ ANTHROPIC_BASE_URL: 'https://cloud.test/v1/ai', ANTHROPIC_AUTH_TOKEN: 'ck_first', CLAUDE_CODE_DISABLE_FAST_MODE: '1', ANTHROPIC_MODEL: 'claude-haiku-5-5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-sonnet-5-5', ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-sonnet-5-5' });
    expect(runtime().hooks.secretEnv?.('claude-code')).toBeUndefined();
  });

  it('keeps AppuBot AI to Sonnet and Haiku with no fast mode: other picks refused with words, old ones dropped', async () => {
    const bot = s().bots.create({ name: 'Picky', providerId: APPUBOT_AI_PROVIDER_ID } as never);
    expect(bot).toMatchObject({ providerId: APPUBOT_AI_PROVIDER_ID, modelId: 'claude-haiku-5-5', fast: false });
    expect(() => s().bots.update(bot.id, { modelId: 'claude-opus-5-5' })).toThrow(/Sonnet and Haiku only.*Opus 5\.5/);
    expect(() => s().bots.update(bot.id, { fast: true })).toThrow(/no fast mode/);
    expect(s().bots.update(bot.id, { modelId: 'claude-sonnet-5-5' }).modelId).toBe('claude-sonnet-5-5');
    expect(() => s().bots.create({ name: 'Big', providerId: APPUBOT_AI_PROVIDER_ID, modelId: 'claude-fable-5-1' } as never)).toThrow(/Sonnet and Haiku only/);
    // moving a bot onto AppuBot AI: its Opus and fast mode stay behind
    const own = s().bots.create({ name: 'Own', providerId: 'claude-code', modelId: 'claude-opus-5-5', fast: true } as never);
    expect(s().bots.update(own.id, { providerId: APPUBOT_AI_PROVIDER_ID })).toMatchObject({ providerId: APPUBOT_AI_PROVIDER_ID, fast: false });
    expect(s().bots.get(own.id)!.modelId).toBeUndefined();
    // a thread's pickers
    const t = s().threads.chatFor(bot.id);
    await expect(s().chat.setModel(t.id, 'opus')).rejects.toThrow(/Sonnet and Haiku only/);
    await expect(s().chat.setFast(t.id, true)).rejects.toThrow(/no fast mode/);
    // the model for new bots
    expect(() => s().settings.update({ defaultModelId: 'claude-opus-5-5' })).toThrow(/Sonnet and Haiku only/);
    expect(s().settings.update({ defaultModelId: 'claude-sonnet-5-5' }).defaultModelId).toBe('claude-sonnet-5-5');
    s().settings.update({ defaultModelId: 'claude-haiku-5-5' });
    // plain Claude Code keeps every model and fast mode
    expect(s().bots.update(own.id, { providerId: 'claude-code', modelId: 'claude-opus-5-5', fast: true })).toMatchObject({ modelId: 'claude-opus-5-5', fast: true });
    for (const b of [bot, own]) await s().bots.delete(b.id, true);
  });

  it('a status-only answer updates the amounts and keeps the token; a new token restarts the agent’s chats', () => {
    s().credit.apply(credit({ token: undefined, usedCents: 900, exhausted: false }));
    expect(s().system.cloudInfo()?.credit?.usedCents).toBe(900);
    expect(s().credit.env(APPUBOT_AI_PROVIDER_ID)?.ANTHROPIC_AUTH_TOKEN).toBe('ck_first');
    s().credit.apply(credit({ token: 'ck_second', key: 'k2' }));
    expect(s().credit.key()).toBe('k2');
    expect(s().credit.env(APPUBOT_AI_PROVIDER_ID)?.ANTHROPIC_AUTH_TOKEN).toBe('ck_second');
    // a key the backend knows that isn't ours, with no token: the token is forgotten until the next answer brings one
    s().credit.apply(credit({ token: undefined, key: 'k3' }));
    expect(s().credit.key()).toBe('');
    expect(s().credit.active()).toBe(false);
    expect(s().credit.offered()).toBe(false);
    s().credit.apply(credit({ token: 'ck_third', key: 'k3' }));
    expect(s().credit.active()).toBe(true);
  });

  it('the credit used up shows in the status; the user’s own choice of agent is kept across answers', () => {
    const bot = s().bots.list()[0]!;
    s().bots.update(bot.id, { providerId: 'claude-code' });
    s().credit.apply(credit({ token: 'ck_third', key: 'k3', usedCents: 1201, exhausted: true }));
    expect(s().system.cloudInfo()?.credit).toMatchObject({ exhausted: true, usedCents: 1201 });
    expect(s().bots.get(bot.id)!.providerId).toBe('claude-code');
    expect(s().credit.active()).toBe(true);
  });

  it('payment on hold or the plan ended: the agent stays, paused and signed out; nothing of the user’s moves', async () => {
    const other = s().bots.list().find((b) => b.providerId === APPUBOT_AI_PROVIDER_ID) ?? s().bots.create({ name: 'Ada', providerId: APPUBOT_AI_PROVIDER_ID } as never);
    s().credit.apply({ enabled: false });
    expect(s().credit.active()).toBe(false);
    expect(s().credit.offered()).toBe(true);
    expect(s().system.cloudInfo()?.credit).toBeUndefined();
    await s().providers.refresh([APPUBOT_AI_PROVIDER_ID]);
    expect(s().providers.list().find((p) => p.id === APPUBOT_AI_PROVIDER_ID)).toMatchObject({ authStatus: 'needs_auth', auth: { state: 'logged_out', account: 'Launch bonus paused' } });
    expect(s().bots.get(other.id)!.providerId).toBe(APPUBOT_AI_PROVIDER_ID);
    expect(s().settings.get().defaultProviderId).toBe(APPUBOT_AI_PROVIDER_ID);
    // the token still goes to its sessions (the backend answers them with why), the environment stays
    expect(s().credit.env(APPUBOT_AI_PROVIDER_ID)?.ANTHROPIC_AUTH_TOKEN).toBe('ck_third');
    // it comes back (payment recovered): signed in again; the defaults aren't applied a second time (the user's choices stand)
    s().credit.apply(credit({ token: 'ck_fourth', key: 'k4' }));
    await s().providers.refresh([APPUBOT_AI_PROVIDER_ID]);
    expect(s().providers.list().find((p) => p.id === APPUBOT_AI_PROVIDER_ID)).toMatchObject({ authStatus: 'authenticated' });
    expect(s().settings.get().defaultProviderId).toBe(APPUBOT_AI_PROVIDER_ID);
  });

  it('the launch bonus ended for everyone: still listed and signed in, shown as ended; bots aren’t moved', async () => {
    const bot = s().bots.list().find((b) => b.providerId === APPUBOT_AI_PROVIDER_ID)!;
    s().credit.apply(credit({ token: 'ck_fourth', key: 'k4', exhausted: true, ended: true }));
    expect(s().credit.ended()).toBe(true);
    expect(s().system.cloudInfo()?.credit).toMatchObject({ exhausted: true, ended: true });
    await s().providers.refresh([APPUBOT_AI_PROVIDER_ID]);
    expect(s().providers.list().find((p) => p.id === APPUBOT_AI_PROVIDER_ID)).toMatchObject({ authStatus: 'authenticated', auth: { account: 'Launch bonus ended' } });
    expect(s().bots.get(bot.id)!.providerId).toBe(APPUBOT_AI_PROVIDER_ID);
    s().credit.apply(credit({ token: 'ck_fourth', key: 'k4' }));
    expect(s().credit.ended()).toBe(false);
  });
});

describe('a computer whose first credit comes after the launch bonus ended', () => {
  it('offers the agent but moves nothing onto it, then or later', async () => {
    const { core, root } = make({ cloud });
    await core.start();
    const s = core.services;
    try {
      s.credit.apply(credit({ exhausted: true, ended: true }));
      expect(s.credit.offered()).toBe(true);
      expect(s.settings.get().defaultProviderId).toBe('claude-code');
      expect(s.bots.list().every((b) => b.providerId === 'claude-code')).toBe(true);
      s.credit.apply(credit());
      expect(s.settings.get().defaultProviderId).toBe('claude-code');
    } finally { await core.stop(); rmSync(root, { recursive: true, force: true }); }
  });
});

describe('on a Mac', () => {
  it('there is no credit, whatever is applied', async () => {
    const { core, root } = make({});
    await core.start();
    try {
      core.services.credit.apply(credit());
      expect(core.services.credit.active()).toBe(false);
      expect(core.services.credit.env(APPUBOT_AI_PROVIDER_ID)).toBeUndefined();
      expect(core.services.providers.list().some((p) => p.id === APPUBOT_AI_PROVIDER_ID)).toBe(false);
      expect(existsSync(join(root, 'data', 'cloud-credit.json'))).toBe(false);
    } finally { await core.stop(); rmSync(root, { recursive: true, force: true }); }
  });
});
