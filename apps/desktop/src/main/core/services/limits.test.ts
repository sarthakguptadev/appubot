import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ProviderLimitsSchema } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { checkRole } from '../handlers';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { lastRateLimitsLine, newestRollout } from './limits';
import type { LimitsFetch } from './limits/probes';
import { codexRateLimitsOf } from './usageLogs';

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

/** what Antigravity 1.4.3 answers `/usage` with on this Mac */
const AGY_USAGE = [
  '### Session Usage', '- **Session total:** data not available yet', '', '### Quota Limits',
  '- **Gemini Models**', '  *(Models within this group: Gemini Flash, Gemini Pro)*',
  '  - **Weekly Limit Remaining:** 100% remaining (resets Nov 13, 2026, 11:48 UTC)', '  - **Five Hour Limit Remaining:** 100% remaining (resets Nov 06, 2026, 16:48 UTC)',
  '- **Claude and GPT models**', '  *(Models within this group: Claude Opus, Claude Sonnet, GPT-OSS)*',
  '  - **Weekly Limit Remaining:** 40% remaining (resets Nov 13, 2026, 11:48 UTC)', '  - **Five Hour Limit Remaining:** 100% remaining (resets Nov 06, 2026, 16:48 UTC)',
].join('\n');

describe('LimitsService', () => {
  let core: Core; let root: string; let home: string; let fake: FakeRuntime;
  const calls = { claude: 0, codex: 0, go: 0, cursor: 0, kimi: 0 };
  let kimiAnswer: () => Awaited<ReturnType<LimitsFetch['kimi']>> = () => ({ ok: false, reason: 'none' });
  let claudeAnswer = () => ({ subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: 38, resets_at: iso(NOW + 3 * 3_600_000) }, seven_day: { utilization: 19, resets_at: iso(NOW + 2 * 86_400_000) }, seven_day_opus: { utilization: 66, resets_at: iso(NOW + 2 * 86_400_000) } } });
  // the reads through Claude Code's and Codex's CLIs are faked below: stand-in `claude` and `codex` on PATH, so neither
  // needs to be installed
  const pathBefore = process.env.PATH;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appubot-limits-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const cli of ['claude', 'codex']) {
      if (process.platform === 'win32') writeFileSync(join(bin, `${cli}.cmd`), '@exit /b 0\r\n');
      else writeFileSync(join(bin, cli), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    process.env.PATH = `${bin}${delimiter}${pathBefore ?? ''}`;
    home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    core = createCore({
      paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
      runtime: (hooks) => { fake = new FakeRuntime(hooks); return fake; },
      openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: async () => ({ shown: false, error: 'test' }),
      version: '2026.11.06', hostName: 'Test Mac', log: silentLogger, validate: true, port: 0, quiet: true, homeDir: home,
      computerBackends: () => [], helperTransport: () => null,
      limitsFetch: {
        claude: async (o) => { calls.claude++; expect(o.cli).toBeTruthy(); return claudeAnswer(); },
        codex: async () => { calls.codex++; return { rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.round((NOW + 3_600_000) / 1000) }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: Math.round((NOW + 86_400_000) / 1000) }, planType: 'plus', credits: { hasCredits: false, unlimited: false } } }; },
        opencodeGo: async () => { calls.go++; return null; },
        cursor: async (o) => { calls.cursor++; expect(o.keychain).toBe(true); return { ok: true, value: { usage: { billingCycleStart: String(NOW - 2 * 86_400_000), billingCycleEnd: String(NOW + 5 * 86_400_000), planUsage: { autoPercentUsed: 6.67, totalPercentUsed: 6.67 } }, planInfo: { planInfo: { planName: 'Premium' }, isMerged: true } } }; },
        kimi: async () => { calls.kimi++; return kimiAnswer(); },
      },
    });
    await core.start();
    // the other agents with plan limits, as added agents (Antigravity's version gates its read)
    for (const id of ['grok', 'cursor', 'kimi', 'antigravity-acp']) await core.services.providers.upsert({ id, name: id, command: `fake-${id}`, args: [], env: {} });
    fake.versions.set('antigravity-acp', '1.4.3');
    fake.extAnswers.set('grok _x.ai/billing', { config: { creditUsagePercent: 6, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: iso(NOW - 2 * 86_400_000), end: iso(NOW + 5 * 86_400_000) }, prepaidBalance: { val: 0 } }, subscription_tier: 'SuperGrok' });
    fake.reply = async (text) => (text === '/usage' ? AGY_USAGE : undefined);
    await core.services.providers.refresh();
  });
  afterAll(async () => {
    await core.stop();
    rmSync(root, { recursive: true, force: true });
    process.env.PATH = pathBefore;
  });
  const s = () => core.services;

  it('knows nothing before a read, and reads every agent with plan limits on a forced request', async () => {
    expect(s().limits.list()).toEqual([]);
    const { limits } = await s().limits.request('', undefined, 'force');
    for (const l of limits) ProviderLimitsSchema.parse(l);
    const claude = limits.find((l) => l.providerId === 'claude-code')!;
    expect(claude).toMatchObject({ plan: 'Max', status: 'ok', source: 'claude' });
    expect(claude.windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day', 'seven_day_opus']);
    expect(limits.find((l) => l.providerId === 'codex')).toMatchObject({ plan: 'ChatGPT Plus', status: 'ok' });
    // the fake computer has no OpenCode
    expect(limits.some((l) => l.providerId === 'opencode')).toBe(false);
    expect(calls).toEqual({ claude: 1, codex: 1, go: 0, cursor: 1, kimi: 1 });
    // kept for the next launch, readable by this user alone
    const file = join(root, 'data', 'provider-limits.json');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('"five_hour"');
  });

  it('reads Grok through its billing method in a process of its own, Cursor and Kimi with their CLIs’ tokens, Antigravity through /usage', async () => {
    const limits = s().limits.list();
    const grok = limits.find((l) => l.providerId === 'grok')!;
    expect(grok).toMatchObject({ plan: 'SuperGrok', status: 'ok', source: 'grok' });
    expect(grok.windows).toEqual([expect.objectContaining({ id: 'grok:period', label: 'Week', usedPercent: 6, scope: { kind: 'all' } })]);
    expect(fake.extCalls).toEqual([{ providerId: 'grok', method: '_x.ai/billing', params: {} }]);
    expect(limits.find((l) => l.providerId === 'cursor')).toMatchObject({ plan: 'Premium', status: 'ok', source: 'cursor', windows: [expect.objectContaining({ id: 'cursor:total', label: 'Week', usedPercent: 6.7 })] });
    // no Kimi sign-in on this computer: nothing to show, not an error
    expect(limits.find((l) => l.providerId === 'kimi')).toMatchObject({ status: 'unavailable', source: 'kimi', message: 'Not signed in to Kimi Code here' });
    const agy = limits.find((l) => l.providerId === 'antigravity-acp')!;
    expect(agy).toMatchObject({ status: 'ok', source: 'antigravity' });
    expect(agy.windows.map((w) => [w.id, w.usedPercent])).toEqual([['agy:gemini-models:5h', 0], ['agy:gemini-models:week', 0], ['agy:claude-and-gpt-models:5h', 0], ['agy:claude-and-gpt-models:week', 60]]);
    // its /usage went to a session of its own in agent-probe, closed after the answer; nothing reached a chat
    const usagePrompts = fake.prompts.filter((p) => p.blocks.some((b) => b.type === 'text' && b.text === '/usage'));
    expect(usagePrompts).toHaveLength(1);
    expect(fake.sessions.has(usagePrompts[0]!.sessionId)).toBe(false);
    expect(s().threads.list().every((t) => t.providerId !== 'antigravity-acp')).toBe(true);
  });

  it('an Antigravity older than 1.4.1 isn’t asked (it would run a model turn on /usage)', async () => {
    fake.versions.set('antigravity-acp', '1.3.9');
    await core.services.providers.refresh();
    const entry = (s().limits as unknown as { entries: Map<string, { fetchedAt?: number }> }).entries.get('antigravity-acp')!;
    entry.fetchedAt = NOW - 60_000;
    const before = fake.prompts.length;
    await s().limits.request('', ['antigravity-acp'], 'force');
    expect(fake.prompts.length).toBe(before);
    expect(s().limits.list().find((l) => l.providerId === 'antigravity-acp')).toMatchObject({ status: 'unavailable', message: expect.stringContaining('1.4.1') });
    fake.versions.set('antigravity-acp', '1.4.3');
    await core.services.providers.refresh();
  });

  it('a Kimi sign-in the service refuses, and a Grok that answers nothing, read as no plan', async () => {
    kimiAnswer = () => ({ ok: false, reason: 'refused' });
    const entries = (s().limits as unknown as { entries: Map<string, { fetchedAt?: number; failedAt?: number }> }).entries;
    entries.get('kimi')!.fetchedAt = NOW - 60_000;
    await s().limits.request('', ['kimi'], 'force');
    expect(s().limits.list().find((l) => l.providerId === 'kimi')).toMatchObject({ status: 'unavailable', message: 'No Kimi Code plan for this sign-in' });
    fake.extAnswers.set('grok _x.ai/billing', {});
    entries.get('grok')!.fetchedAt = NOW - 60_000;
    await s().limits.request('', ['grok'], 'force');
    expect(s().limits.list().find((l) => l.providerId === 'grok')).toMatchObject({ status: 'unavailable', message: 'No plan limits for this sign-in' });
    // a Grok that refuses the method keeps the last numbers it gave, as an error
    fake.extAnswers.set('grok _x.ai/billing', new Error('Method not found: _x.ai/billing'));
    entries.get('grok')!.fetchedAt = NOW - 60_000; entries.get('grok')!.failedAt = undefined;
    await s().limits.request('', ['grok'], 'force');
    expect(s().limits.list().find((l) => l.providerId === 'grok')).toMatchObject({ status: 'error', message: 'Method not found: _x.ai/billing' });
  });

  it('a stale request within a minute of a read reads nothing again; a limited phone gets no plan name', async () => {
    const before = { ...calls };
    const { limits } = await s().limits.request('', ['claude-code'], 'stale', true);
    expect(calls).toEqual(before);
    expect(limits).toHaveLength(1);
    expect(limits[0]!.plan).toBeUndefined();
    expect(limits[0]!.windows.length).toBe(3);
    expect(() => checkRole('providers.limits', {}, { role: 'limited', deviceId: 'd' })).not.toThrow();
  });

  it('lays a session’s rate_limit_event over the snapshot and tells the window', async () => {
    const heard: unknown[] = [];
    const off = core.ctx.bus.on((ev) => { if (ev.event === 'providers.limits') heard.push(ev.payload); });
    s().limits.noteRateLimit('claude-code', '', { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: Math.round((NOW + 3_600_000) / 1000) } } }, 'claude-opus-5-5');
    off();
    const claude = s().limits.list().find((l) => l.providerId === 'claude-code')!;
    expect(claude.status).toBe('ok');
    expect(claude.windows.find((w) => w.id === 'five_hour')!.usedPercent).toBe(90);
    expect(claude.windows.find((w) => w.id === 'seven_day_opus')!.usedPercent).toBe(66);
    expect(heard).toHaveLength(1);
  });

  it('keeps the last good numbers when a read fails, marked error', async () => {
    const good = claudeAnswer;
    claudeAnswer = () => { throw new Error('no network'); };
    try {
      // forced reads are at least 10 s apart: pretend the last was long ago
      const entry = (s().limits as unknown as { entries: Map<string, { fetchedAt?: number }> }).entries.get('claude-code')!;
      entry.fetchedAt = NOW - 60_000;
      await s().limits.request('', ['claude-code'], 'force');
      const claude = s().limits.list().find((l) => l.providerId === 'claude-code')!;
      expect(claude.status).toBe('error');
      expect(claude.message).toBe('no network');
      expect(claude.windows.length).toBe(3);
    } finally { claudeAnswer = good; }
  });

  it('a Claude sign-in that can’t read the plan keeps what its sessions said, as live', async () => {
    claudeAnswer = () => ({ subscription_type: null, rate_limits_available: false, rate_limits: null }) as never;
    const entry = (s().limits as unknown as { entries: Map<string, { fetchedAt?: number; failedAt?: number }> }).entries.get('claude-code')!;
    entry.fetchedAt = NOW - 60_000; entry.failedAt = undefined;
    await s().limits.request('', ['claude-code'], 'force');
    expect(s().limits.list().find((l) => l.providerId === 'claude-code')).toMatchObject({ status: 'unavailable', windows: [] });
    // its sessions still tell: that's all there is then
    s().limits.noteRateLimit('claude-code', '', { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: Math.round((NOW + 3_600_000) / 1000) } } });
    expect(s().limits.list().find((l) => l.providerId === 'claude-code')).toMatchObject({ status: 'live', source: 'live' });
    entry.fetchedAt = NOW - 60_000;
    await s().limits.request('', ['claude-code'], 'force');
    expect(s().limits.list().find((l) => l.providerId === 'claude-code')).toMatchObject({ status: 'live' });
    expect(s().limits.list().find((l) => l.providerId === 'claude-code')!.windows[0]!.usedPercent).toBe(50);
  });

  it('reads the bucket a Codex turn used from its newest rollout', async () => {
    const dir = join(home, '.codex', 'sessions', '2026', '11', '06');
    mkdirSync(dir, { recursive: true });
    const line = (used: number) => JSON.stringify({ timestamp: iso(NOW), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', limit_name: null, primary: { used_percent: used, window_minutes: 300, resets_at: Math.round((NOW + 3_600_000) / 1000) }, secondary: null, credits: { has_credits: false, unlimited: false }, plan_type: 'plus', rate_limit_reached_type: null } } });
    writeFileSync(join(dir, 'rollout-a.jsonl'), `${line(55)}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } })}\n`);
    expect(await newestRollout(join(home, '.codex', 'sessions'))).toBe(join(dir, 'rollout-a.jsonl'));
    expect(await lastRateLimitsLine(join(dir, 'rollout-a.jsonl'))).toMatchObject({ limit_id: 'codex' });
    expect(codexRateLimitsOf('{"type":"event_msg","payload":{"type":"token_count","info":{}}}')).toBeNull();
    s().limits.noteTurnEnd('codex', '');
    await new Promise((r) => setTimeout(r, 100));
    const codex = s().limits.list().find((l) => l.providerId === 'codex')!;
    expect(codex.windows.find((w) => w.id === 'codex:primary')!.usedPercent).toBe(55);
    expect(codex.windows.find((w) => w.id === 'codex:secondary')!.usedPercent).toBe(40);
  });
});
