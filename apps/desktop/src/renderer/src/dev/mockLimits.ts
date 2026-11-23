/**
 * Dev-only: the agents' plan limits in the browser preview (`?limits=low|out|apikey|none`, default a healthy set).
 * Claude Code on Max with a tight Opus week and a low Fable week; Codex on Plus running low with Codex-Spark used
 * up; OpenCode without a Go plan; a `?profile=` Claude profile on Pro with its 5-hour window used up; Grok on
 * SuperGrok, Cursor on Premium (one weekly window each) and Antigravity's two quota groups, where those agents are on.
 */
import type { Provider, ProviderLimits } from '@appubot/protocol';
import { HOUR, MIN, ago } from './mockIds';

export const MOCK_LIMITS_STATES = ['low', 'out', 'apikey', 'none'] as const;
export type MockLimitsState = (typeof MOCK_LIMITS_STATES)[number];

const DAY = 24 * HOUR;
/** next Thursday 09:00 local */
function nextThursday(): number {
  const d = new Date();
  d.setDate(d.getDate() + ((4 - d.getDay() + 7) % 7 || 7));
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

export function mockLimits(state: MockLimitsState | undefined, providers: readonly Provider[]): ProviderLimits[] {
  const now = Date.now();
  const week = nextThursday();
  const updatedAt = ago(2 * MIN);
  const claude = (providerId: string): ProviderLimits => {
    if (state === 'apikey') return { providerId, status: 'unavailable', message: 'Your own API key: pay as you go, no plan limits', windows: [], updatedAt, source: 'claude' };
    const used5h = state === 'out' ? 100 : state === 'low' ? 85 : 38;
    return {
      providerId, plan: 'Max', status: 'ok', updatedAt, source: 'claude',
      windows: [
        { id: 'five_hour', label: '5-hour', minutes: 300, usedPercent: used5h, resetsAt: now + 3 * HOUR + 10 * MIN, scope: { kind: 'all' }, ...(state === 'out' ? { status: 'rejected' as const } : {}) },
        { id: 'seven_day', label: 'Week', minutes: 10080, usedPercent: 19, resetsAt: week, scope: { kind: 'all' } },
        { id: 'model:opus', label: 'Week · Opus', minutes: 10080, usedPercent: 66, resetsAt: week, scope: { kind: 'family', families: ['opus'] } },
        { id: 'model:fable', label: 'Week · Fable', minutes: 10080, usedPercent: 88, resetsAt: week, scope: { kind: 'family', families: ['fable'] } },
      ],
      extra: { enabled: state !== 'out', usedUsd: 12.4, limitUsd: 50, currency: 'USD' },
    };
  };
  const out: ProviderLimits[] = [];
  for (const p of providers) {
    if (!p.installed || p.enabled === false) continue;
    if (p.id === 'claude-code') out.push(claude(p.id));
    else if (p.profile?.of === 'claude-code' && p.profile.source !== 'credit') {
      out.push({
        providerId: p.id, plan: 'Pro', status: 'ok', updatedAt, source: 'claude',
        windows: [
          { id: 'five_hour', label: '5-hour', minutes: 300, usedPercent: 100, resetsAt: now + 47 * MIN, scope: { kind: 'all' }, status: 'rejected' },
          { id: 'seven_day', label: 'Week', minutes: 10080, usedPercent: 30, resetsAt: now + 4 * DAY + 2 * HOUR, scope: { kind: 'all' } },
        ],
      });
    } else if (p.id === 'codex') {
      out.push({
        providerId: p.id, plan: 'ChatGPT Plus', status: 'ok', updatedAt, source: 'codex',
        windows: [
          { id: 'codex:primary', label: '5-hour', minutes: 300, usedPercent: 82, resetsAt: now + HOUR + 5 * MIN, scope: { kind: 'rest' } },
          { id: 'codex:secondary', label: 'Week', minutes: 10080, usedPercent: 45, resetsAt: now + 2 * DAY + 6 * HOUR, scope: { kind: 'rest' } },
          { id: 'codex-spark:primary', label: '5-hour · GPT-5.5-Codex-Spark', minutes: 300, usedPercent: 100, resetsAt: now + HOUR + 20 * MIN, scope: { kind: 'models', slugs: ['gpt-5.5-codex-spark'] }, models: 'GPT-5.5-Codex-Spark' },
          { id: 'codex-spark:secondary', label: 'Week · GPT-5.5-Codex-Spark', minutes: 10080, usedPercent: 60, resetsAt: now + 2 * DAY + 6 * HOUR, scope: { kind: 'models', slugs: ['gpt-5.5-codex-spark'] }, models: 'GPT-5.5-Codex-Spark' },
        ],
      });
    } else if (p.id === 'opencode') {
      out.push({ providerId: p.id, status: 'unavailable', message: 'Your own providers: no plan limits', windows: [], updatedAt, source: 'opencode-go' });
    } else if (p.id === 'grok') {
      out.push({ providerId: p.id, plan: 'SuperGrok', status: 'ok', updatedAt, source: 'grok', windows: [{ id: 'grok:period', label: 'Week', minutes: 10080, usedPercent: 6, resetsAt: now + 5 * DAY + 6 * HOUR, scope: { kind: 'all' } }] });
    } else if (p.id === 'cursor') {
      out.push({ providerId: p.id, plan: 'Premium', status: 'ok', updatedAt, source: 'cursor', windows: [{ id: 'cursor:total', label: 'Week', minutes: 10080, usedPercent: 7, resetsAt: now + 4 * DAY + 20 * HOUR, scope: { kind: 'all' } }] });
    } else if (p.id === 'antigravity-acp' || p.registry?.id === 'antigravity-acp') {
      const gemini = { kind: 'names' as const, names: ['Gemini Flash', 'Gemini Pro'] };
      const others = { kind: 'names' as const, names: ['Claude Opus', 'Claude Sonnet', 'GPT-OSS'] };
      out.push({
        providerId: p.id, status: 'ok', updatedAt, source: 'antigravity',
        windows: [
          { id: 'agy:gemini-models:5h', label: '5-hour · Gemini Models', minutes: 300, usedPercent: 0, resetsAt: now + 4 * HOUR, scope: gemini, models: 'Gemini Flash, Gemini Pro' },
          { id: 'agy:gemini-models:week', label: 'Week · Gemini Models', minutes: 10080, usedPercent: 4, resetsAt: week, scope: gemini, models: 'Gemini Flash, Gemini Pro' },
          { id: 'agy:claude-and-gpt-models:5h', label: '5-hour · Claude and GPT models', minutes: 300, usedPercent: 0, resetsAt: now + 4 * HOUR, scope: others, models: 'Claude Opus, Claude Sonnet, GPT-OSS' },
          { id: 'agy:claude-and-gpt-models:week', label: 'Week · Claude and GPT models', minutes: 10080, usedPercent: state === 'low' ? 88 : 12, resetsAt: week, scope: others, models: 'Claude Opus, Claude Sonnet, GPT-OSS' },
        ],
      });
    }
  }
  return out;
}
