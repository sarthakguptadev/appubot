/**
 * The free Claude day on a person's own computer (`services/promo.ts`) against a fake backend: nothing without a day,
 * the offer and "Not now", Start needing the sign-in, Start getting the day's token (kept 0600, never on the wire),
 * installing Claude Code in the background where it is missing, the gift's agent offered (shown only as "Claude"
 * under "AppuBot Launch Gift") with no bot moved by itself, the person's own picks remembered, and the end (its time, a day closed early, the account's fair-use limit) putting each back
 * on what it used, with a bot made during the day on the agent for new bots; and nothing of it on a cloud computer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPUBOT_AI_PROVIDER_ID, type CloudCreditSettings, type CloudPromo } from '@appubot/protocol';
import { agentDisplayName } from '@appubot/chat-core';
import { createCore, type Core } from '../app';
import type { CloudDeps } from '../context';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

const H = 3_600_000;
const MODEL = 'claude-haiku-5-5';

interface World { core: Core; root: string; runtime: FakeRuntime; backend: { day: CloudPromo; place: CloudCreditSettings; calls: string[] }; installs: string[][] }
const worlds: World[] = [];

function make(o: { signedIn?: boolean; cloud?: CloudDeps; day?: Partial<CloudPromo>; installFails?: boolean } = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'appubot-promo-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  if (o.signedIn !== false) writeFileSync(join(dataDir, 'cloud-account.json'), JSON.stringify({ token: 'cs_test', sealed: false, email: 'you@example.com', signedInAt: 0 }));
  const endsAt = Date.now() + 24 * H;
  const backend: World['backend'] = {
    day: { id: 'free-claude-day', open: true, model: MODEL, endsAt, ...o.day },
    place: { enabled: true, promo: 'free-claude-day', baseUrl: 'https://cloud.test/v1/ai', token: 'cp_day_token', key: 'k1', budgetCents: 2500, usedCents: 0, currency: 'USD', resetsAt: endsAt, endsAt, exhausted: false, defaultModel: MODEL },
    calls: [],
  };
  const installs: string[][] = [];
  let runtime!: FakeRuntime;
  const cloudFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    backend.calls.push(`${init?.method ?? 'GET'} ${path}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/v1/promo') return json(backend.day);
    if (path === '/v1/promo/start') return json(backend.day.open ? backend.place : { enabled: false, promo: backend.day.id });
    return json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
  }) as typeof fetch;
  // Claude Code's own install line on this OS (a cloud computer is Linux)
  const installHint = process.platform === 'win32' && !o.cloud ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"' : 'curl -fsSL https://claude.ai/install.sh | bash';
  const core = createCore({
    paths: { dataDir, botsRoot: join(root, 'bots'), filesDir: join(dataDir, 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => { runtime = new FakeRuntime(hooks); const real = runtime.getProviders.bind(runtime); runtime.getProviders = () => real().map((p) => (p.id === 'claude-code' ? { ...p, installHint } : p)); return runtime; },
    openExternal: () => undefined, openTerminal: () => { throw new Error('no terminal in a quiet install'); }, nativeNotify: async () => ({ shown: false, error: 'test' }),
    version: '2026.1110.1', hostName: 'Test Mac', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null, cloudBackendUrl: 'https://cloud.test', cloudFetch,
    updateIo: { run: async (command, args) => { installs.push([command, ...args]); if (o.installFails) return { ok: false, output: 'curl: (6) Could not resolve host' }; runtime.notInstalled.delete('claude-code'); return { ok: true, output: 'installed' }; } },
    ...(o.cloud ? { cloud: o.cloud } : {}),
  });
  const w = { core, root, runtime, backend, installs };
  worlds.push(w);
  return w;
}
afterEach(async () => { for (const w of worlds.splice(0)) { await w.core.stop(); rmSync(w.root, { recursive: true, force: true }); } });

const promoOf = (w: World) => w.core.services.system.info().promo;

describe('the free Claude day on a Mac', () => {
  it('shows nothing while no day is on, and nothing kept', async () => {
    const w = make({ day: { open: false, endsAt: undefined } });
    await w.core.start();
    await w.core.services.promo.check();
    expect(promoOf(w)).toBeUndefined();
    expect(existsSync(join(w.root, 'data', 'promo.json'))).toBe(false);
  });

  it('offers a day that is on, and "Not now" puts it away for that day', async () => {
    const w = make();
    await w.core.start();
    expect(promoOf(w)).toBeUndefined();
    await w.core.services.promo.check();
    expect(promoOf(w)).toMatchObject({ id: 'free-claude-day', model: MODEL, state: 'offer', signedIn: true, endsAt: w.backend.day.endsAt });
    expect(w.core.services.promo.dismiss()).toEqual({ ok: true });
    expect(promoOf(w)).toBeUndefined();
    await w.core.services.promo.check();
    expect(promoOf(w)).toBeUndefined();
    // nothing was started: no token asked for, no agent
    expect(w.backend.calls).not.toContain('POST /v1/promo/start');
    expect(w.core.services.providers.list().some((p) => p.id === APPUBOT_AI_PROVIDER_ID)).toBe(false);
  });

  it('needs the sign-in to start', async () => {
    const w = make({ signedIn: false });
    await w.core.start();
    await w.core.services.promo.check();
    expect(promoOf(w)).toMatchObject({ state: 'offer', signedIn: false });
    expect(() => w.core.services.promo.begin()).toThrow(/Sign in/);
    expect(w.backend.calls).not.toContain('POST /v1/promo/start');
  });

  it('starts: the token kept off the wire, Claude there to pick and no bot moved; the bots the person puts on it go back when it ends', async () => {
    const w = make();
    const s = w.core.services;
    await w.core.start();
    await s.promo.check();
    const first = s.bots.list()[0]!;
    const codex = s.bots.create({ name: 'Codex bot', providerId: 'codex' } as never);
    s.bots.update(first.id, { modelId: 'claude-opus-5-5', fast: true });
    const before = Object.fromEntries(s.bots.list().map((b) => [b.id, { providerId: b.providerId, modelId: b.modelId, fast: b.fast }]));
    const defaults = { defaultProviderId: s.settings.get().defaultProviderId, defaultModelId: s.settings.get().defaultModelId };

    const on = await s.promo.begin();
    expect(on).toMatchObject({ state: 'on', bots: 0, model: MODEL });
    // nothing moved by itself: every bot and the agent for new bots are as they were
    expect(Object.fromEntries(s.bots.list().map((b) => [b.id, { providerId: b.providerId, modelId: b.modelId, fast: b.fast }]))).toEqual(before);
    expect(s.settings.get()).toMatchObject(defaults);
    expect(w.installs).toEqual([]); // Claude Code was there already
    expect(s.credit.active()).toBe(true);
    expect(s.credit.status()).toBeUndefined(); // never an amount
    const file = join(w.root, 'data', 'cloud-credit.json');
    expect(readFileSync(file, 'utf8')).toContain('cp_day_token');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(s.system.info())).not.toContain('cp_day_token');
    expect(w.runtime.hooks.secretEnv?.(APPUBOT_AI_PROVIDER_ID)).toMatchObject({ ANTHROPIC_BASE_URL: 'https://cloud.test/v1/ai', ANTHROPIC_AUTH_TOKEN: 'cp_day_token', ANTHROPIC_MODEL: MODEL });
    const gift = s.providers.list().find((p) => p.id === APPUBOT_AI_PROVIDER_ID)!;
    // "Claude" under the profile "AppuBot Launch Gift"; its one model is "Claude" too, and no alias of Claude Code's runs another
    expect(gift).toMatchObject({ name: 'Claude', authStatus: 'authenticated', auth: { account: 'AppuBot Launch Gift' }, profile: { of: 'claude-code', name: 'AppuBot Launch Gift', source: 'credit' } });
    expect(agentDisplayName(gift, s.providers.list())).toBe('Claude · AppuBot Launch Gift');
    expect(w.runtime.getProviders().find((p) => p.id === APPUBOT_AI_PROVIDER_ID)!.oneModel).toEqual({ id: MODEL, name: 'Claude' });
    expect(w.runtime.hooks.secretEnv?.(APPUBOT_AI_PROVIDER_ID)).toMatchObject({ ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL, ANTHROPIC_DEFAULT_FABLE_MODEL: MODEL, CLAUDE_CODE_SUBAGENT_MODEL: MODEL });
    expect(JSON.stringify(gift)).not.toMatch(/haiku/i);
    // the person's pick on the gift's last page: that bot alone, on the gift's model
    expect(s.promo.useBot(first.id, true)).toMatchObject({ providerId: APPUBOT_AI_PROVIDER_ID, modelId: MODEL, fast: false });
    expect(promoOf(w)).toMatchObject({ state: 'on', bots: 1 });
    expect(s.bots.get(codex.id)!.providerId).toBe('codex');
    expect(() => s.bots.update(first.id, { modelId: 'claude-sonnet-5-5' })).toThrow(/its own Claude model only/);
    // a second Start is the same day, and moves nothing
    expect(await s.promo.begin()).toMatchObject({ state: 'on', bots: 1 });
    // off again puts it back on what it used, at once
    expect(s.promo.useBot(first.id, false)).toMatchObject(before[first.id]!);
    expect(promoOf(w)).toMatchObject({ bots: 0 });
    s.promo.useBot(first.id, true);

    // picked in a bot's model picker (`bots.update`) is remembered the same way; one moved off by hand stays where it was put
    const picked = s.bots.create({ name: 'Picked in the picker', providerId: 'codex' } as never);
    s.bots.update(picked.id, { providerId: APPUBOT_AI_PROVIDER_ID, modelId: MODEL });
    s.bots.update(codex.id, { providerId: APPUBOT_AI_PROVIDER_ID, modelId: MODEL });
    s.bots.update(codex.id, { providerId: 'claude-code' });
    // a bot made on the gift has nothing of its own to go back to
    const made = s.bots.create({ name: 'Made today', providerId: APPUBOT_AI_PROVIDER_ID } as never);
    expect(made.providerId).toBe(APPUBOT_AI_PROVIDER_ID);
    expect(promoOf(w)).toMatchObject({ bots: 3 });

    s.promo.finish('ended');
    expect(promoOf(w)).toMatchObject({ state: 'over', why: 'ended' });
    expect(s.credit.active()).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(s.providers.list().some((p) => p.id === APPUBOT_AI_PROVIDER_ID)).toBe(false);
    expect(w.runtime.hooks.secretEnv?.(APPUBOT_AI_PROVIDER_ID)).toBeUndefined();
    const after = s.bots.list();
    expect(after.find((b) => b.id === first.id)).toMatchObject(before[first.id]!);
    expect(after.find((b) => b.id === picked.id)!.providerId).toBe('codex');
    // moved by hand: left where the user put it
    expect(after.find((b) => b.id === codex.id)!.providerId).toBe('claude-code');
    expect(after.find((b) => b.id === made.id)!.providerId).toBe(defaults.defaultProviderId);
    expect(after.some((b) => b.providerId === APPUBOT_AI_PROVIDER_ID)).toBe(false);
    expect(s.settings.get().defaultProviderId).toBe(defaults.defaultProviderId);
    expect(s.settings.get().defaultModelId ?? '').toBe(defaults.defaultModelId ?? '');
    // said once (the day is over at the backend too: one still open there would be offered again)
    s.promo.dismiss();
    expect(promoOf(w)).toBeUndefined();
    w.backend.day = { ...w.backend.day, open: false };
    await s.promo.check();
    expect(promoOf(w)).toBeUndefined();
  });

  it('installs Claude Code in the background where it is missing, and says why when that fails', async () => {
    const ok = make();
    ok.runtime.notInstalled.add('claude-code');
    await ok.core.start();
    await ok.core.services.promo.check();
    expect(await ok.core.services.promo.begin()).toMatchObject({ state: 'on' });
    expect(ok.installs).toHaveLength(1);
    expect(ok.installs[0]!.join(' ')).toContain('claude.ai/install');

    const bad = make({ installFails: true });
    bad.runtime.notInstalled.add('claude-code');
    await bad.core.start();
    await bad.core.services.promo.check();
    const bots = bad.core.services.bots.list().map((b) => b.providerId);
    await expect(bad.core.services.promo.begin()).rejects.toThrow(/Claude Code couldn’t be installed/);
    expect(promoOf(bad)).toMatchObject({ state: 'offer', error: expect.stringContaining('Could not resolve host') });
    // nothing moved, no agent offered
    expect(bad.core.services.bots.list().map((b) => b.providerId)).toEqual(bots);
    expect(bad.core.services.credit.active()).toBe(false);
  });

  it('ends early when the day closes or the account reaches its limit, and at the next launch after its end', async () => {
    const w = make();
    const s = w.core.services;
    await w.core.start();
    await s.promo.check();
    const was = s.bots.list().map((b) => b.providerId);
    await s.promo.begin();
    for (const b of s.bots.list()) s.promo.useBot(b.id, true);
    w.backend.place = { ...w.backend.place, exhausted: true };
    await s.promo.refresh();
    expect(promoOf(w)).toMatchObject({ state: 'over', why: 'used-up' });
    expect(s.bots.list().map((b) => b.providerId)).toEqual(was);

    const closed = make();
    await closed.core.start();
    await closed.core.services.promo.check();
    await closed.core.services.promo.begin();
    for (const b of closed.core.services.bots.list()) closed.core.services.promo.useBot(b.id, true);
    closed.backend.day = { ...closed.backend.day, open: false };
    await closed.core.services.promo.check();
    expect(promoOf(closed)).toMatchObject({ state: 'over', why: 'ended' });
    expect(closed.core.services.bots.list().some((b) => b.providerId === APPUBOT_AI_PROVIDER_ID)).toBe(false);

    // AppuBot closed over the day's end: the next launch puts everything back before anything else
    const late = make();
    await late.core.start();
    await late.core.services.promo.check();
    await late.core.services.promo.begin();
    for (const b of late.core.services.bots.list()) late.core.services.promo.useBot(b.id, true);
    const file = join(late.root, 'data', 'promo.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), endsAt: Date.now() - 1000 }));
    const again = new (late.core.services.promo.constructor as new (ctx: unknown) => typeof late.core.services.promo)((late.core.services.promo as unknown as { ctx: unknown }).ctx);
    again.start();
    again.stop();
    expect(late.core.services.bots.list().some((b) => b.providerId === APPUBOT_AI_PROVIDER_ID)).toBe(false);
    expect(late.core.services.credit.active()).toBe(false);
  });

  it('offers a gift that closed and opened again, but not one this account used up; a group on it goes back to its bots’ own agents', async () => {
    const w = make();
    const s = w.core.services;
    await w.core.start();
    await s.promo.check();
    await s.promo.begin();
    const bot = s.bots.list()[0]!;
    const was = bot.providerId;
    s.promo.useBot(bot.id, true);
    const group = s.groups.create({ name: 'Crew', botIds: [bot.id] } as never);
    s.groups.update(group.id, { providerId: APPUBOT_AI_PROVIDER_ID } as never);

    // switched off (or its pool spent): over here, the bot and the group off the gift's agent
    w.backend.day = { ...w.backend.day, open: false };
    await s.promo.check();
    expect(promoOf(w)).toMatchObject({ state: 'over', why: 'ended' });
    expect(s.bots.get(bot.id)!.providerId).toBe(was);
    expect(s.groups.list().find((g) => g.id === group.id)!.providerId).toBeUndefined();
    expect(s.credit.active()).toBe(false);

    // switched back on: an offer again, and Start works as the first time
    w.backend.day = { ...w.backend.day, open: true };
    await s.promo.check();
    expect(promoOf(w)).toMatchObject({ state: 'offer' });
    await s.promo.begin();
    expect(promoOf(w)).toMatchObject({ state: 'on', bots: 0 });
    expect(s.credit.active()).toBe(true);

    // with only minutes left it stays over (a clock a little ahead must not flap at the end)
    w.backend.day = { ...w.backend.day, open: false };
    await s.promo.check();
    w.backend.day = { ...w.backend.day, open: true, endsAt: Date.now() + 60_000 };
    await s.promo.check();
    expect(promoOf(w)).toMatchObject({ state: 'over' });

    // this account's limit reached: still over while the day stays open for others
    const used = make();
    await used.core.start();
    await used.core.services.promo.check();
    await used.core.services.promo.begin();
    used.backend.place = { ...used.backend.place, exhausted: true };
    await used.core.services.promo.refresh();
    await used.core.services.promo.check();
    expect(promoOf(used)).toMatchObject({ state: 'over', why: 'used-up' });
  });

  it('takes a gift’s token away at launch when the gift isn’t on here (its record lost)', async () => {
    const w = make();
    const s = w.core.services;
    await w.core.start();
    await s.promo.check();
    await s.promo.begin();
    const bot = s.bots.list()[0]!;
    const was = bot.providerId;
    s.promo.useBot(bot.id, true);
    rmSync(join(w.root, 'data', 'promo.json'));
    const again = new (s.promo.constructor as new (ctx: unknown) => typeof s.promo)((s.promo as unknown as { ctx: unknown }).ctx);
    again.start();
    again.stop();
    expect(s.credit.active()).toBe(false);
    expect(s.bots.get(bot.id)!.providerId).toBe(was === APPUBOT_AI_PROVIDER_ID ? 'claude-code' : was);
    expect(s.providers.list().some((x) => x.id === APPUBOT_AI_PROVIDER_ID)).toBe(false);
  });
});

describe('on an AppuBot Cloud computer', () => {
  it('there is no free day to start: its plan’s AppuBot AI is paid by the day without it', async () => {
    const w = make({ cloud: { publicUrl: 'https://abc.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 } });
    await w.core.start();
    await w.core.services.promo.check().catch(() => undefined);
    expect(promoOf(w)).toBeUndefined();
    expect(() => w.core.services.promo.begin()).toThrow(/already free/);
  });
});
