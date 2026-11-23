/**
 * The Usage page's activity grid in both apps (the desktop's is Rare UI's GitHubActivity): days as a grid, a column a
 * week. The computer only reads the agents' last month of history (`usage.summary`), so each summary of whole days is
 * added to a small tally of days kept with the page's other remembered answers (per computer: `usage:days`), and the
 * grid grows from the first look on. A day with no tally is unknown (the page wasn't opened within a month of it),
 * never a day with no use. Pure: each app's page wires it to its store.
 */
import type { UsageBucket } from '@appubot/protocol';

export type ActivityLevel = 0 | 1 | 2 | 3 | 4;

export interface ActivityDay {
  /** YYYY-MM-DD; the first day is a Sunday, so every column is a week */
  date: string;
  count: number;
  level: ActivityLevel;
  /** nothing was counted that day (before the count began) */
  unknown?: boolean;
}

/** tokens and estimated cost */
export type DayTally = [tokens: number, costUsd: number];
export type DayLedger = Record<string, DayTally>;

export const ACTIVITY_KEY = 'usage:days';
export const ACTIVITY_WEEKS = 53;
/** days of tally kept (a little over the grid's year) */
export const ACTIVITY_KEEP_DAYS = 400;

const two = (n: number) => String(n).padStart(2, '0');
const keyOf = (d: Date): string => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
/** The local day a moment falls on, as YYYY-MM-DD. */
export const dayKey = (ts: number): string => keyOf(new Date(ts));

const isTally = (v: unknown): v is DayTally => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);

/** A tally read back from the store: only well-formed days. */
export function readLedger(v: unknown): DayLedger {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: DayLedger = {};
  for (const [k, t] of Object.entries(v as Record<string, unknown>)) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && isTally(t)) out[k] = t;
  return out;
}

/** The tally with a summary's days laid over it (the fresh count wins), days past the keep dropped. The same object back when nothing changed. */
export function mergeDays(ledger: DayLedger, series: readonly UsageBucket[], now: number): DayLedger {
  const floor = dayKey(now - ACTIVITY_KEEP_DAYS * 86_400_000);
  let next = ledger;
  const write = () => { if (next === ledger) next = { ...ledger }; return next; };
  for (const b of series) {
    const k = dayKey(b.start);
    const had = ledger[k];
    if (had && had[0] === b.tokens && had[1] === b.costUsd) continue;
    write()[k] = [b.tokens, b.costUsd];
  }
  for (const k of Object.keys(next)) if (k < floor) delete write()[k];
  return next;
}

export interface UsageActivity {
  /** from a Sunday `weeks` columns back to today */
  days: ActivityDay[];
  tokens: number;
  costUsd: number;
  /** days with any use */
  active: number;
  /** the first day of the tally inside the grid */
  since?: string;
}

/** The grid's days from the tally: levels by quartile of the days that had any use. */
export function activityDays(ledger: DayLedger, now: number, weeks = ACTIVITY_WEEKS): UsageActivity {
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay() - (weeks - 1) * 7);
  const raw: { date: string; tally: DayTally | undefined }[] = [];
  for (let d = new Date(start); keyOf(d) <= keyOf(today); d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const date = keyOf(d);
    raw.push({ date, tally: ledger[date] });
  }
  const used = raw.map((r) => r.tally?.[0] ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  const cut = (q: number) => used[Math.min(used.length - 1, Math.floor(q * used.length))] ?? 0;
  const cuts = [cut(0.25), cut(0.5), cut(0.75)];
  const levelOf = (n: number): ActivityLevel => (n <= 0 ? 0 : ((1 + cuts.filter((c) => n > c).length) as ActivityLevel));
  let tokens = 0;
  let costUsd = 0;
  let since: string | undefined;
  const days = raw.map(({ date, tally }): ActivityDay => {
    if (!tally) return { date, count: 0, level: 0, unknown: true };
    since ??= date;
    tokens += tally[0];
    costUsd += tally[1];
    return { date, count: tally[0], level: levelOf(tally[0]) };
  });
  return { days, tokens, costUsd, active: used.length, ...(since ? { since } : {}) };
}
