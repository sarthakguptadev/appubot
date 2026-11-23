/** Dev-only: Settings › Usage in the browser preview, with made-up but plausible numbers (`?settings=usage`). */
import type { MethodParams, MethodResult, UsageBucket, UsageRange, UsageTotals } from '@appubot/protocol';

type Summary = MethodResult<'usage.summary'>;

/** a steady pseudo-random 0..1 per bucket, so the chart doesn't jump on every read */
const noise = (n: number): number => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

const totals = (o: Partial<UsageTotals>): UsageTotals => {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, cacheSavingsUsd: 0, unpricedTokens: 0, requests: 0, ...o };
  return { ...t, tokens: t.input + t.output + t.cacheRead + t.cacheWrite };
};

/** the share of the range each model and agent had */
const MODELS = [
  { model: 'claude-opus-5-5', name: 'Claude Opus 5.5', share: 0.58, perM: 0.45 },
  { model: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', share: 0.24, perM: 0.22 },
  { model: 'gpt-5.5', name: 'GPT-5.5', share: 0.11, perM: 0.6 },
  // its cost as Grok logged it
  { model: 'grok-4.7-build', name: 'Grok 4.7 Build', share: 0.04, perM: 0.23 },
  { model: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', share: 0.025, perM: 0.02 },
  { model: 'codex-auto-review', name: 'codex-auto-review', share: 0.005, perM: 0 },
];
const AGENTS = [
  { id: 'claude-code', name: 'Claude Code · Main', share: 0.54 },
  { id: 'claude-code@work', name: 'Claude Code · Work', share: 0.31 },
  { id: 'codex', name: 'Codex', share: 0.11 },
  { id: 'grok', name: 'Grok', share: 0.04 },
];

export function mockUsageSummary(p: MethodParams<'usage.summary'>): Summary {
  const range: UsageRange = p.range ?? '7d';
  const scope = p.scope ?? 'all';
  // only the bots' part: about a third of it
  const k = scope === 'bots' ? 0.34 : 1;
  const now = Date.now();
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const series: UsageBucket[] = range === 'today'
    ? Array.from({ length: 24 }, (_, h) => {
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime();
      const busy = start > now ? 0 : h >= 9 && h <= 23 ? 0.4 + noise(h) : noise(h) * 0.1;
      return { start, tokens: Math.round(busy * k * 9_000_000), costUsd: busy * k * 4.1 };
    })
    : Array.from({ length: range === '7d' ? 7 : 30 }, (_, i) => {
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((range === '7d' ? 7 : 30) - 1 - i)).getTime();
      const busy = 0.25 + noise(start / 86_400_000) * (new Date(start).getDay() % 6 === 0 ? 0.4 : 1);
      return { start, tokens: Math.round(busy * k * 140_000_000), costUsd: busy * k * 64 };
    });
  const tokens = series.reduce((s, b) => s + b.tokens, 0);
  const cost = series.reduce((s, b) => s + b.costUsd, 0);
  const split = (share: number, perM = cost / Math.max(1, tokens / 1e6)) => {
    const n = tokens * share;
    return totals({
      input: Math.round(n * 0.002), output: Math.round(n * 0.006), cacheRead: Math.round(n * 0.962), cacheWrite: Math.round(n * 0.03),
      costUsd: (n / 1e6) * perM, cacheSavingsUsd: (n / 1e6) * perM * 6.5, requests: Math.round(n / 210_000),
    });
  };
  const models = MODELS.map((m) => ({ model: m.model, name: m.name, priced: m.perM > 0, ...split(m.share, m.perM) }))
    .map((m) => (m.priced ? m : { ...m, costUsd: 0, cacheSavingsUsd: 0, unpricedTokens: m.tokens }));
  const sum = models.reduce((s, m) => s + m.costUsd, 0);
  return {
    range, scope, from: range === 'today' ? midnight : series[0]!.start, to: now,
    totals: { ...split(1), costUsd: sum, cacheSavingsUsd: models.reduce((s, m) => s + m.cacheSavingsUsd, 0), unpricedTokens: models.reduce((s, m) => s + m.unpricedTokens, 0) },
    byBots: { tokens: Math.round(tokens * (k === 1 ? 0.34 : 1)), costUsd: sum * (k === 1 ? 0.34 : 1) },
    bucket: range === 'today' ? 'hour' : 'day',
    series: series.map((b) => ({ ...b, costUsd: (b.costUsd / Math.max(cost, 1e-9)) * sum })),
    models: models.sort((a, b) => b.costUsd - a.costUsd),
    agents: AGENTS.map((a) => ({ id: a.id, name: a.name, ...split(a.share), costUsd: sum * a.share })),
    sources: AGENTS.map((a) => ({ id: a.id, name: a.name })),
    pricesAsOf: '2026-10-28',
  };
}
