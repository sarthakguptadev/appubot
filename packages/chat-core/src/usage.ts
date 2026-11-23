/** Settings › Usage's words and numbers: estimated costs and token counts as people read them. */
import type { UsageRange } from '@appubot/protocol';

/** "$1,234", "$12.34", "$0.42", "<$0.01", "$0" */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  return `$${n.toFixed(2)}`;
}

/** "950", "12.3K", "4.7M", "1.2B" */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const units: [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [v, u] of units) {
    if (n >= v) {
      const x = n / v;
      return `${x < 100 ? Number(x.toFixed(1)) : Math.round(x)}${u}`;
    }
  }
  return String(n);
}

/** the share of input tokens read from the cache, as a whole percent ("" when there was no input) */
export function cacheHitRate(t: { input: number; cacheRead: number; cacheWrite: number }): string {
  const all = t.input + t.cacheRead + t.cacheWrite;
  return all ? `${Math.round((t.cacheRead / all) * 100)}%` : '';
}

/** the range picker's choices, and how a sentence says each */
export const USAGE_RANGES: readonly { id: UsageRange; label: string; phrase: string }[] = [
  { id: 'today', label: 'Today', phrase: 'today' },
  { id: '7d', label: '7 days', phrase: 'in the last 7 days' },
  { id: '30d', label: '30 days', phrase: 'in the last 30 days' },
];

/**
 * The agents a summary read, for a sentence: "Claude Code, Codex and Grok" (a profile's "Claude Code · Work" counts as
 * its agent; "" for none).
 */
export function usageSourceNames(sources: readonly { name: string }[]): string {
  const names = [...new Set(sources.map((s) => s.name.split(' · ')[0]!.trim()).filter(Boolean))];
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
