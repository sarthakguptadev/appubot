import { describe, expect, it } from 'vitest';
import type { ProviderLimits } from '@appubot/protocol';
import { modelRowLimits } from './limits';
import {
  shortPlanName, agentLimits, applyClaudeRateLimit, applyCodexRateLimits, backInText, classifyWindowMinutes, codexModelLabel, extraUsageText, formatResetDuration, limitsForModel,
  limitsFromClaudeUsage, limitsFromCodex, limitsFromCredit, limitsFromOpenCodeGo, limitsSourcesText, modelFamily, modelLimitText, parseResetTimestamp, planLine,
  resetText, shortReset, updatedAgoText, windowLabel, windowModelsText, limitsFromGrok, limitsFromCursor, limitsFromKimi, parseAntigravityUsage, limitsFromAntigravity,
} from './limits';

const NOW = Date.UTC(2026, 10, 6, 12, 0); // 6 Nov 2026 12:00 UTC
const H = 3_600_000;

describe('ported helpers', () => {
  it('reads reset times in seconds, ms and ISO', () => {
    expect(parseResetTimestamp(1793959800)).toBe(1793959800_000);
    expect(parseResetTimestamp(1793959800_000)).toBe(1793959800_000);
    expect(parseResetTimestamp('1793959800')).toBe(1793959800_000);
    expect(parseResetTimestamp('2026-11-06T12:00:00Z')).toBe(NOW);
    expect(parseResetTimestamp('')).toBeUndefined();
    expect(parseResetTimestamp(0)).toBeUndefined();
    expect(parseResetTimestamp('soon')).toBeUndefined();
  });
  it('formats durations floored', () => {
    expect(formatResetDuration(47 * 60_000 + 59_000)).toBe('47m');
    expect(formatResetDuration(3 * H + 54 * 60_000)).toBe('3h 54m');
    expect(formatResetDuration(6 * 24 * H + 7 * H)).toBe('6d 7h');
    expect(formatResetDuration(2 * 24 * H)).toBe('2d');
    expect(formatResetDuration(0)).toBe('now');
  });
  it('classifies windows by length within a minute', () => {
    expect(classifyWindowMinutes(300)).toBe('session');
    expect(classifyWindowMinutes(10081)).toBe('weekly');
    expect(classifyWindowMinutes(43200)).toBe('monthly');
    expect(classifyWindowMinutes(1440)).toBe('daily');
    expect(classifyWindowMinutes(120)).toBeUndefined();
    expect(windowLabel(120)).toBe('2-hour');
    expect(windowLabel(undefined)).toBe('Limit');
  });
});

describe('Claude Code', () => {
  const usage = {
    subscription_type: 'max', rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 38, resets_at: new Date(NOW + 3 * H + 10 * 60_000).toISOString() },
      seven_day: { utilization: 19, resets_at: new Date(NOW + 2 * 24 * H).toISOString() },
      seven_day_opus: { utilization: 66, resets_at: new Date(NOW + 2 * 24 * H).toISOString() },
      model_scoped: [{ display_name: 'Fable', utilization: 88, resets_at: new Date(NOW + 2 * 24 * H).toISOString() }, { display_name: 'Opus', utilization: 66, resets_at: null }],
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1240, utilization: 24.8, currency: 'usd' },
    },
  };
  it('reads the snapshot: shared windows, per-model weeklies (model_scoped wins over the Opus key), extra usage', () => {
    const l = limitsFromClaudeUsage('claude-code', usage, NOW);
    expect(l.plan).toBe('Max');
    expect(l.status).toBe('ok');
    expect(l.windows.map((w) => [w.id, w.label, w.usedPercent, w.scope])).toEqual([
      ['five_hour', '5-hour', 38, { kind: 'all' }],
      ['seven_day', 'Week', 19, { kind: 'all' }],
      ['model:fable', 'Week · Fable', 88, { kind: 'family', families: ['fable'] }],
      ['model:opus', 'Week · Opus', 66, { kind: 'family', families: ['opus'] }],
    ]);
    expect(l.extra).toEqual({ enabled: true, usedUsd: 12.4, limitUsd: 50, currency: 'USD' });
    expect(extraUsageText(l.extra!)).toBe('$12.40 of $50 this month');
  });
  it('an API key or a token without the profile scope has no limits', () => {
    const l = limitsFromClaudeUsage('claude-code', { subscription_type: null, rate_limits_available: false, rate_limits: null }, NOW);
    expect(l).toMatchObject({ status: 'unavailable', windows: [] });
    expect(limitsForModel(l, { id: 'claude-opus-5-5' }, NOW)).toBeUndefined();
  });
  it('maps models to their windows: the tightest binds, Default by its description', () => {
    const l = limitsFromClaudeUsage('claude-code', usage, NOW);
    const opus = limitsForModel(l, { id: 'claude-opus-5-5', name: 'Opus 5.5' }, NOW)!;
    expect(opus.windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day', 'model:opus']);
    expect(opus.left).toBe(34);
    expect(opus.binding.id).toBe('model:opus');
    expect(opus.tone).toBe('ok');
    const fable = limitsForModel(l, { id: 'claude-fable-5-1', name: 'Fable 5.1' }, NOW)!;
    expect(fable.left).toBe(12);
    expect(fable.tone).toBe('low');
    expect(modelLimitText(fable, NOW)).toBe('12%');
    const dflt = limitsForModel(l, { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5 · Use the latest Opus' }, NOW)!;
    expect(dflt.left).toBe(34);
    const haiku = limitsForModel(l, { id: 'claude-haiku-5-5', name: 'Haiku 5.5' }, NOW)!;
    expect(haiku.windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day']);
    expect(haiku.left).toBe(62);
  });
  it('lays live rate_limit_events over the snapshot (fractions, epoch seconds), and stands alone as live', () => {
    const info = {
      status: 'allowed', resetsAt: Math.round((NOW + H) / 1000), rateLimitType: 'five_hour', overageStatus: 'rejected', isUsingOverage: false,
      unifiedWindows: { five_hour: { utilization: 0.7, resetsAt: Math.round((NOW + H) / 1000), status: 'allowed' }, seven_day: { utilization: 0.04, resetsAt: Math.round((NOW + 3 * 24 * H) / 1000), status: 'allowed' }, seven_day_overage_included: { utilization: 0.95, resetsAt: Math.round((NOW + 3 * 24 * H) / 1000), status: 'allowed_warning' } },
    };
    const live = applyClaudeRateLimit(undefined, 'claude-code', info, 'claude-opus-5-5', NOW);
    expect(live.status).toBe('live');
    expect(live.source).toBe('live');
    expect(live.windows.map((w) => [w.id, w.usedPercent, w.resetsAt, w.status])).toEqual([
      ['five_hour', 70, NOW + H, 'ok'], ['seven_day', 4, NOW + 3 * 24 * H, 'ok'], ['model:opus', 95, NOW + 3 * 24 * H, 'warning'],
    ]);
    expect(live.extra).toEqual({ enabled: false, inUse: false });
    const snap = limitsFromClaudeUsage('claude-code', usage, NOW - 60_000);
    const merged = applyClaudeRateLimit(snap, 'claude-code', info, undefined, NOW);
    expect(merged.status).toBe('ok');
    expect(merged.plan).toBe('Max');
    expect(merged.windows.find((w) => w.id === 'five_hour')!.usedPercent).toBe(70);
    expect(merged.windows.find((w) => w.id === 'model:fable')!.usedPercent).toBe(88);
    // without a model, the per-model window can't be placed
    expect(merged.windows.some((w) => w.id === 'model:undefined')).toBe(false);
    expect(merged.extra).toMatchObject({ enabled: false, usedUsd: 12.4 });
  });
  it('a rejected window is used up until its reset, and extra usage turns "out" into "extra"', () => {
    const rejected = applyClaudeRateLimit(undefined, 'claude-code', { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: Math.round((NOW + 47 * 60_000) / 1000) }, undefined, NOW);
    const m = limitsForModel(rejected, { id: 'claude-sonnet-5-5' }, NOW)!;
    expect(m.tone).toBe('out');
    expect(m.left).toBe(0);
    expect(modelLimitText(m, NOW)).toBe('Back in 47m');
    const billed = applyClaudeRateLimit(rejected, 'claude-code', { status: 'allowed', isUsingOverage: true, overageStatus: 'allowed' }, undefined, NOW);
    expect(limitsForModel(billed, { id: 'claude-sonnet-5-5' }, NOW)!.tone).toBe('extra');
    // once the reset passes the window counts as full
    expect(limitsForModel(rejected, { id: 'claude-sonnet-5-5' }, NOW + H)!.left).toBe(100);
  });
  it('an older CLI without unifiedWindows gives one window per event', () => {
    const l = applyClaudeRateLimit(undefined, 'claude-code', { status: 'allowed_warning', rateLimitType: 'seven_day_opus', utilization: 0.82, resetsAt: Math.round((NOW + 24 * H) / 1000) }, undefined, NOW);
    expect(l.windows).toEqual([{ id: 'seven_day_opus', label: 'Week · Opus', minutes: 10080, usedPercent: 82, resetsAt: NOW + 24 * H, scope: { kind: 'family', families: ['opus'] }, status: 'warning' }]);
  });
  it('knows model families', () => {
    expect(modelFamily('claude-opus-5-5')).toBe('opus');
    expect(modelFamily('default', 'Default', 'Fable 5.1 · the newest')).toBe('fable');
    expect(modelFamily('gpt-5.5')).toBeUndefined();
    expect(modelFamily('claude-sonnet-4-5-20250929[1m]')).toBe('sonnet');
  });
});

describe('Codex', () => {
  const resetsAt = Math.round((NOW + 65 * 60_000) / 1000);
  const bucket = (limitId: string, slug: string | null, used: number, extra: Record<string, unknown> = {}) => ({
    limitId, limitName: null, normalModelSlug: slug, primary: { usedPercent: used, windowDurationMins: 300, resetsAt }, secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: resetsAt + 86_400 },
    credits: { hasCredits: false, unlimited: false, balance: null }, individualLimit: null, spendControlReached: false, planType: 'plus', rateLimitReachedType: null, ...extra,
  });
  const read = { rateLimits: bucket('codex', null, 82), rateLimitsByLimitId: { codex: bucket('codex', null, 82), 'codex-spark': bucket('codex-spark', 'gpt-5.5-codex-spark', 100) }, rateLimitResetCredits: { availableCount: 0, credits: [] } };
  it('reads app-server buckets: the plain one covers the rest, a model bucket its model', () => {
    const l = limitsFromCodex('codex', read, NOW);
    expect(l.plan).toBe('ChatGPT Plus');
    expect(l.windows.map((w) => [w.id, w.label, w.scope.kind])).toEqual([
      ['codex:primary', '5-hour', 'rest'], ['codex:secondary', 'Week', 'rest'],
      ['codex-spark:primary', '5-hour · GPT-5.5-Codex-Spark', 'models'], ['codex-spark:secondary', 'Week · GPT-5.5-Codex-Spark', 'models'],
    ]);
    const gpt = limitsForModel(l, { id: 'gpt-5.5', name: 'GPT-5.5' }, NOW)!;
    expect(gpt.windows.map((w) => w.id)).toEqual(['codex:primary', 'codex:secondary']);
    expect(gpt.left).toBe(18);
    expect(gpt.tone).toBe('low');
    const spark = limitsForModel(l, { id: 'gpt-5.5-codex-spark', name: 'GPT-5.5-Codex-Spark' }, NOW)!;
    expect(spark.windows.map((w) => w.id)).toEqual(['codex-spark:primary', 'codex-spark:secondary']);
    expect(spark.tone).toBe('out');
    expect(modelLimitText(spark, NOW)).toBe('Back in 1h 5m');
    // the plan line only shows the shared windows
    expect(planLine(l, NOW)).toEqual({ plan: 'ChatGPT Plus', items: [{ label: '5h', left: 18, tone: 'low', resetsAt: resetsAt * 1000 }, { label: 'Week', left: 55, tone: 'ok', resetsAt: (resetsAt + 86_400) * 1000 }], resetIn: '1h 5m' });
  });
  it('reads the free plan’s single 30-day window from the legacy shape, and a rollout line', () => {
    const free = { rateLimits: { limitId: 'codex', limitName: null, normalModelSlug: null, primary: { usedPercent: 1, windowDurationMins: 43200, resetsAt }, secondary: null, credits: { hasCredits: false, unlimited: false, balance: null }, planType: 'free' } };
    const l = limitsFromCodex('codex', free, NOW);
    expect(l.plan).toBe('Free');
    expect(l.windows).toEqual([{ id: 'codex:primary', label: 'Month', minutes: 43200, usedPercent: 1, resetsAt: resetsAt * 1000, scope: { kind: 'rest' } }]);
    const line = { limit_id: 'codex', limit_name: null, primary: { used_percent: 7.5, window_minutes: 43200, resets_at: resetsAt }, secondary: null, credits: { has_credits: true, unlimited: false, balance: null }, plan_type: 'free', rate_limit_reached_type: null };
    const live = applyCodexRateLimits(l, 'codex', line, NOW + 1000);
    expect(live.windows[0]!.usedPercent).toBe(7.5);
    expect(live.credits).toBe(true);
    expect(live.status).toBe('ok');
    expect(applyCodexRateLimits(undefined, 'codex', line, NOW).status).toBe('live');
  });
  it('a workspace spend limit reached is "out" whatever the windows say', () => {
    const l = limitsFromCodex('codex', { rateLimits: bucket('codex', null, 10, { rateLimitReachedType: 'workspace_member_usage_limit_reached' }) }, NOW);
    expect(l.spendLimitReached).toBe(true);
    expect(limitsForModel(l, { id: 'gpt-5.5' }, NOW)!.tone).toBe('out');
  });
  it('names models and plans', () => {
    expect(shortPlanName('ChatGPT Plus')).toBe('Plus');
    expect(shortPlanName('Max')).toBe('Max');
    expect(shortPlanName('OpenCode Go')).toBe('Go');
    expect(codexModelLabel('gpt-5.5-codex-spark')).toBe('GPT-5.5-Codex-Spark');
    expect(codexModelLabel('o3-mini')).toBe('O3-Mini');
  });
});

describe('OpenCode Go and the credit', () => {
  it('reads Go windows for its models only', () => {
    const l = limitsFromOpenCodeGo('opencode', { usage: { rolling: { status: 'ok', percent: 30, resetsAt: NOW + H }, weekly: { status: 'rate-limited', percent: 100, resetsAt: NOW + 24 * H }, monthly: { status: 'nope', percent: 1 } } }, NOW);
    expect(l.windows.map((w) => [w.id, w.usedPercent, w.status])).toEqual([['go:rolling', 30, undefined], ['go:weekly', 100, 'rejected']]);
    expect(limitsForModel(l, { id: 'opencode-go/gpt-5.5' }, NOW)!.tone).toBe('out');
    expect(limitsForModel(l, { id: 'anthropic/claude-opus-5-5' }, NOW)).toBeUndefined();
  });
  it('turns the included credit into a month window', () => {
    const l = limitsFromCredit('claude-code@appubot-ai', { budgetCents: 1200, usedCents: 700, currency: 'USD', resetsAt: NOW + 9 * 24 * H, exhausted: false, defaultModel: 'claude-haiku-5-5' }, NOW);
    expect(l.plan).toBe('Launch bonus');
    expect(l.windows[0]).toMatchObject({ label: 'Month', usedPercent: 58.3, scope: { kind: 'all' } });
    expect(limitsForModel(l, { id: 'claude-haiku-5-5' }, NOW)!.left).toBe(42);
    const out = limitsFromCredit('x', { budgetCents: 1200, usedCents: 1200, currency: 'USD', resetsAt: NOW + 9 * 24 * H, exhausted: true, defaultModel: 'm' }, NOW);
    expect(limitsForModel(out, { id: 'claude-haiku-5-5' }, NOW)!.tone).toBe('out');
  });
});

describe('model rows', () => {
  const rows = (l: ProviderLimits, ids: string[]) => ids.map((id) => modelRowLimits(l, limitsForModel(l, { id }, NOW), NOW)?.left);
  it('says a shared window once, in the plan line: no row repeats the launch bonus’s Month', () => {
    const l = limitsFromCredit('claude-code@appubot-ai', { budgetCents: 1200, usedCents: 12, currency: 'USD', resetsAt: NOW + 29 * 24 * H, exhausted: false, defaultModel: 'claude-haiku-5-5' }, NOW);
    expect(planLine(l, NOW)!.items).toEqual([expect.objectContaining({ label: 'Month', left: 99 })]);
    expect(rows(l, ['default', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-haiku-5-5'])).toEqual([undefined, undefined, undefined, undefined]);
    const out = limitsFromCredit('x', { budgetCents: 1200, usedCents: 1200, currency: 'USD', resetsAt: NOW + 9 * 24 * H, exhausted: true, defaultModel: 'm' }, NOW);
    expect(rows(out, ['claude-opus-5-5'])).toEqual([undefined]);
  });
  it('shows a model’s own window when its value differs from the plan line’s', () => {
    const usage = {
      subscription_type: 'max', rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 10, resets_at: new Date(NOW + 3 * H).toISOString() },
        seven_day: { utilization: 19, resets_at: new Date(NOW + 2 * 24 * H).toISOString() },
        model_scoped: [{ display_name: 'Opus', utilization: 66, resets_at: null }, { display_name: 'Fable', utilization: 19, resets_at: null }, { display_name: 'Haiku', utilization: 5, resets_at: null }],
      },
    };
    const l = limitsFromClaudeUsage('claude-code', usage, NOW);
    // Opus: its week (34% left) is tighter than the plan line's; Fable's week matches the shared Week (81%); Haiku's own week
    // is looser, so the shared 5-hour binds; Sonnet has no window of its own
    expect(rows(l, ['claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-5-5', 'claude-sonnet-5-5'])).toEqual([34, undefined, undefined, undefined]);
  });
  it('a Codex model’s own bucket shows; the rest share the plan line', () => {
    const l: ProviderLimits = {
      providerId: 'codex', status: 'ok', updatedAt: NOW, source: 'codex', windows: [
        { id: 'primary', label: '5-hour', minutes: 300, usedPercent: 40, resetsAt: NOW + H, scope: { kind: 'rest' } },
        { id: 'spark', label: '5-hour · Spark', minutes: 300, usedPercent: 90, resetsAt: NOW + H, scope: { kind: 'models', slugs: ['gpt-5.3-codex-spark'] } },
      ],
    };
    expect(rows(l, ['gpt-5.3-codex-spark', 'gpt-5.5'])).toEqual([10, undefined]);
    expect(modelRowLimits(l, undefined, NOW)).toBeUndefined();
    expect(modelRowLimits(undefined, limitsForModel(l, { id: 'gpt-5.5' }, NOW), NOW)).toBeUndefined();
  });
});

describe('words', () => {
  it('reset and back-in texts', () => {
    expect(resetText(NOW + 3 * H + 10 * 60_000, NOW)).toMatch(/^Resets in 3h 10m · /);
    expect(resetText(NOW + 2 * 24 * H, NOW)).toMatch(/^Resets \w{3} /);
    expect(resetText(NOW + 9 * 24 * H, NOW)).toMatch(/^Resets (\d+ \w{3}|\w{3} \d+)$/);
    expect(resetText(NOW - 1, NOW)).toBe('Resets soon');
    expect(resetText(undefined, NOW)).toBe('');
    expect(shortReset(NOW + 90 * 60_000, NOW)).toBe('1h 30m');
    expect(backInText(NOW + 47 * 60_000, NOW)).toBe('Back in 47m');
    expect(backInText(undefined, NOW)).toBe('Used up');
    expect(updatedAgoText(NOW - 2 * 60_000, NOW)).toBe('updated 2 min ago');
    expect(updatedAgoText(NOW - 10_000, NOW)).toBe('updated just now');
    expect(updatedAgoText(NOW - 5 * H, NOW)).toBe('updated 5 h ago');
  });
  it('names a window’s models and the sources', () => {
    const l = limitsFromClaudeUsage('claude-code', { subscription_type: 'pro', rate_limits_available: true, rate_limits: { five_hour: { utilization: 1, resets_at: null }, seven_day_opus: { utilization: 2, resets_at: null } } }, NOW);
    const models = [{ id: 'default', name: 'Default (recommended)', description: 'Opus 5.5' }, { id: 'claude-opus-5-5', name: 'Opus 5.5' }, { id: 'claude-opus-4-8', name: 'Opus 4.8' }, { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }];
    expect(windowModelsText(l.windows[0]!, models)).toBe('Every model');
    expect(windowModelsText(l.windows[1]!, models)).toBe('Opus 5.5, Opus 4.8');
    expect(windowModelsText(l.windows[1]!)).toBe('Opus');
    const codex = limitsFromCodex('codex', { rateLimits: { limitId: 'codex', primary: { usedPercent: 3 }, planType: 'plus' } }, NOW);
    expect(windowModelsText(codex.windows[0]!, [{ id: 'gpt-5.5' }])).toBe('Other models');
    expect(limitsSourcesText([l, codex])).toBe('Read from Claude and ChatGPT with your own sign-in.');
    expect(limitsSourcesText([{ providerId: 'x', status: 'unavailable', windows: [], updatedAt: NOW, source: 'claude' } as ProviderLimits])).toBe('Read from the agents with your own sign-in.');
  });
  it('the agent as a whole takes its tightest window', () => {
    const l = limitsFromCodex('codex', { rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 300 } }, spark: { limitId: 'spark', normalModelSlug: 'gpt-5.5-codex-spark', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.round((NOW + H) / 1000) } } } }, NOW);
    const a = agentLimits(l, NOW)!;
    expect(a.tone).toBe('out');
    expect(a.backAt).toBe(NOW + H);
    expect(agentLimits(undefined)).toBeUndefined();
  });
});

describe('OpenBot-style readers (Grok, Cursor, Kimi, Antigravity)', () => {
  it('reads Grok’s billing period as one window of every model, zero when proto3 left the use out', () => {
    const l = limitsFromGrok('grok', { config: { creditUsagePercent: 37.5, currentPeriod: { start: '2026-11-02T00:00:00Z', end: '2026-11-09T00:00:00Z', type: 'USAGE_PERIOD_TYPE_WEEKLY' }, prepaidBalance: { val: 0 }, isUnifiedBillingUser: true }, subscription_tier: 'SuperGrok' }, NOW);
    expect(l).toMatchObject({ status: 'ok', source: 'grok', plan: 'SuperGrok' });
    expect(l.windows).toEqual([{ id: 'grok:period', label: 'Week', minutes: 10080, usedPercent: 37.5, resetsAt: Date.UTC(2026, 10, 9), scope: { kind: 'all' } }]);
    const fresh = limitsFromGrok('grok', { config: { currentPeriod: { start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' } } }, NOW);
    expect(fresh.windows[0]).toMatchObject({ usedPercent: 0, label: 'Month' });
    const cents = limitsFromGrok('grok', { config: { monthlyLimit: { val: 2000 }, used: { val: 500 }, currentPeriod: { start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' } } }, NOW);
    expect(cents.windows[0]!.usedPercent).toBe(25);
    expect(limitsFromGrok('grok', {}, NOW).windows).toEqual([]);
  });

  it('reads Cursor’s cycle as the included models and the rest, or one total on a merged plan', () => {
    const usage = { billingCycleStart: String(NOW - 20 * 24 * H), billingCycleEnd: String(NOW + 10 * 24 * H), planUsage: { autoPercentUsed: 12, apiPercentUsed: 64, totalPercentUsed: 40 }, autoBucketModels: ['default', 'composer-2.5', 'grok-4.7'] };
    const l = limitsFromCursor('cursor', usage, { planInfo: { planName: 'Premium' }, isMerged: false }, NOW);
    expect(l.plan).toBe('Premium');
    expect(l.windows.map((w) => [w.id, w.label, w.usedPercent, w.scope.kind, w.minutes])).toEqual([['cursor:auto', 'Month · Included models', 12, 'models', 30 * 24 * 60], ['cursor:api', 'Month · Other models', 64, 'rest', 30 * 24 * 60]]);
    expect(l.windows[0]!.resetsAt).toBe(NOW + 10 * 24 * H);
    expect(limitsForModel(l, { id: 'grok-4.7', name: 'Grok 4.7' }, NOW)!.binding.id).toBe('cursor:auto');
    expect(limitsForModel(l, { id: 'claude-4.5-sonnet', name: 'Claude 4.5 Sonnet' }, NOW)!.binding.id).toBe('cursor:api');
    // without the list, Cursor's own ids
    const unlisted = limitsFromCursor('cursor', { ...usage, autoBucketModels: undefined }, { isMerged: false }, NOW);
    expect(limitsForModel(unlisted, { id: 'auto', name: 'Auto' }, NOW)!.binding.id).toBe('cursor:auto');
    // what this Mac's Premium plan answers: a weekly cycle, merged, so one window of every model
    const week = { billingCycleStart: String(NOW - 2 * 24 * H), billingCycleEnd: String(NOW + 5 * 24 * H), planUsage: { autoPercentUsed: 6.67, totalPercentUsed: 6.67 } };
    const merged = limitsFromCursor('cursor', week, { planInfo: { planName: 'Premium', includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY' }, isMerged: true }, NOW);
    expect(merged.windows.map((w) => [w.id, w.label, w.usedPercent, w.scope.kind])).toEqual([['cursor:total', 'Week', 6.7, 'all']]);
    expect(limitsFromCursor('cursor', {}, null, NOW).windows).toEqual([]);
  });

  it('reads Kimi’s older and newer answers', () => {
    const older = {
      usage: { limit: '1000', used: '250', resetTime: '2026-11-10T00:00:00Z' },
      limits: [
        { window: { duration: '5', timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: '100', remaining: '30', resetTime: '2026-11-06T15:00:00Z' } },
        { window: { duration: '1', timeUnit: 'TIME_UNIT_DAY' }, detail: { limit: '400', used: '10' } },
      ],
    };
    const l = limitsFromKimi('kimi', older, NOW);
    expect(l.windows.map((w) => [w.id, w.label, w.usedPercent, w.resetsAt])).toEqual([['kimi:rolling', '5-hour', 70, Date.UTC(2026, 10, 6, 15)], ['kimi:weekly', 'Week', 25, Date.UTC(2026, 10, 10)]]);
    const newer = { usages: { limit_5h: { used_ratio: 0.42, reset_time: '2026-11-06T16:00:00Z' }, limit_7d: { used_ratio: '0.1' } } };
    expect(limitsFromKimi('kimi', newer, NOW).windows.map((w) => [w.id, w.usedPercent])).toEqual([['kimi:rolling', 42], ['kimi:weekly', 10]]);
    expect(limitsFromKimi('kimi', { usage: { limit: '0' } }, NOW).windows).toEqual([]);
  });

  const AGY = [
    '## Usage', '', 'Some lines about tokens.', '', '### Quota Limits',
    '- **Gemini Models**', '  *(Models within this group: Gemini Flash, Gemini Pro)*',
    '  - **Weekly Limit Remaining:** 96% remaining (resets Nov 12, 2026, 10:12 UTC)', '  - **5-Hour Limit Remaining:** 100% remaining',
    '- **Claude and GPT models**', '  *(Models within this group: Claude Opus, Claude Sonnet, GPT-OSS)*',
    '  - **Weekly Limit Remaining:** 12% remaining (resets Nov 8, 2026, 09:00 UTC)', '  - **Five Hour Limit Remaining:** 100% remaining (resets Nov 06, 2026, 16:48 UTC)',
    '', '### Something else', '- **Not a group**',
  ].join('\n');

  it('parses Antigravity’s /usage answer into groups with their models and windows', () => {
    const groups = parseAntigravityUsage(AGY)!;
    expect(groups.map((g) => g.name)).toEqual(['Gemini Models', 'Claude and GPT models']);
    expect(groups[0]).toMatchObject({ models: ['Gemini Flash', 'Gemini Pro'], weekly: { usedPercent: 4, resetsAt: Date.UTC(2026, 10, 12, 10, 12) }, fiveHour: { usedPercent: 0 } });
    expect(groups[1]!.weekly).toEqual({ usedPercent: 88, resetsAt: Date.UTC(2026, 10, 8, 9) });
    expect(groups[1]!.fiveHour).toEqual({ usedPercent: 0, resetsAt: Date.UTC(2026, 10, 6, 16, 48) });
    expect(parseAntigravityUsage('nothing here')).toBeNull();
    expect(parseAntigravityUsage('### Quota Limits\nNot applicable for current authentication method')).toEqual([]);
  });

  it('maps Antigravity’s groups to windows that count models by name', () => {
    const l = limitsFromAntigravity('antigravity-acp', AGY, NOW);
    expect(l.windows.map((w) => w.id)).toEqual(['agy:gemini-models:5h', 'agy:gemini-models:week', 'agy:claude-and-gpt-models:5h', 'agy:claude-and-gpt-models:week']);
    expect(l.windows[3]).toMatchObject({ label: 'Week · Claude and GPT models', usedPercent: 88, scope: { kind: 'names', names: ['Claude Opus', 'Claude Sonnet', 'GPT-OSS'] }, models: 'Claude Opus, Claude Sonnet, GPT-OSS' });
    const flash = limitsForModel(l, { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, NOW)!;
    expect(flash.windows.map((w) => w.id)).toEqual(['agy:gemini-models:5h', 'agy:gemini-models:week']);
    expect(flash.left).toBe(96);
    const opus = limitsForModel(l, { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' }, NOW)!;
    expect(opus).toMatchObject({ left: 12, tone: 'low' });
    expect(limitsForModel(l, { id: 'mystery-model', name: 'Mystery' }, NOW)).toBeUndefined();
    expect(windowModelsText(l.windows[3]!)).toBe('Claude Opus, Claude Sonnet, GPT-OSS');
    expect(limitsFromAntigravity('antigravity-acp', '### Quota Limits\nNot applicable for current authentication method', NOW)).toMatchObject({ status: 'unavailable' });
    expect(limitsFromAntigravity('antigravity-acp', 'no section', NOW)).toMatchObject({ status: 'error' });
    // a group that lists no models counts every model when it is the Gemini one
    const one = limitsFromAntigravity('antigravity-acp', '### Quota Limits\n- **Gemini Models**\n  - **Weekly Limit Remaining:** 50% remaining', NOW);
    expect(one.windows[0]!.scope).toEqual({ kind: 'all' });
  });

  it('names every source', () => {
    const at = (providerId: string, source: ProviderLimits['source']): ProviderLimits => ({ providerId, status: 'ok', windows: [{ id: 'w', label: 'Week', usedPercent: 1, scope: { kind: 'all' } }], updatedAt: NOW, source });
    expect(limitsSourcesText([at('grok', 'grok'), at('cursor', 'cursor'), at('kimi', 'kimi'), at('antigravity-acp', 'antigravity')])).toBe('Read from Grok, Cursor, Kimi and Google with your own sign-in.');
  });
});
