import { describe, expect, it } from 'vitest';
import { ACTIVITY_KEEP_DAYS, activityDays, dayKey, mergeDays, readLedger, type DayLedger } from '@appubot/chat-core';

const DAY = 86_400_000;
// a Saturday at noon, local time
const NOW = new Date(2026, 10, 14, 12).getTime();
const bucket = (daysAgo: number, tokens: number, costUsd = tokens / 1000) => ({ start: new Date(2026, 10, 14 - daysAgo).getTime(), tokens, costUsd });

describe('the day tally', () => {
  it('lays a summary over what was kept, the fresh count winning', () => {
    const kept: DayLedger = { '2026-11-13': [5, 0.005], '2026-10-01': [9, 0.009] };
    const next = mergeDays(kept, [bucket(1, 50), bucket(0, 7)], NOW);
    expect(next).toEqual({ '2026-11-13': [50, 0.05], '2026-11-14': [7, 0.007], '2026-10-01': [9, 0.009] });
    expect(kept['2026-11-13']).toEqual([5, 0.005]);
  });

  it('hands the same tally back when nothing changed', () => {
    const kept = mergeDays({}, [bucket(1, 50), bucket(0, 0)], NOW);
    expect(mergeDays(kept, [bucket(1, 50), bucket(0, 0)], NOW)).toBe(kept);
  });

  it('drops days past the keep', () => {
    const old = dayKey(NOW - (ACTIVITY_KEEP_DAYS + 5) * DAY);
    expect(mergeDays({ [old]: [1, 0] }, [bucket(0, 3)], NOW)).toEqual({ '2026-11-14': [3, 0.003] });
  });

  it('reads back only well-formed days', () => {
    expect(readLedger({ '2026-11-14': [3, 0.1], nope: [1, 1], '2026-11-13': [1], '2026-11-12': [-1, 0], '2026-11-11': ['1', 0] })).toEqual({ '2026-11-14': [3, 0.1] });
    expect(readLedger(null)).toEqual({});
    expect(readLedger([1, 2])).toEqual({});
  });
});

describe('the grid', () => {
  it('starts on a Sunday and ends today', () => {
    const a = activityDays({}, NOW, 4);
    expect(a.days[0]!.date).toBe('2026-10-18');
    expect(new Date(2026, 9, 18).getDay()).toBe(0);
    expect(a.days.at(-1)!.date).toBe('2026-11-14');
    expect(a.days).toHaveLength(28);
    expect(a.days.every((d) => d.unknown && d.level === 0)).toBe(true);
    expect(a.since).toBeUndefined();
  });

  it('marks days with no tally unknown, and a counted day with no use as level 0', () => {
    const ledger = mergeDays({}, [bucket(2, 0), bucket(1, 400), bucket(0, 100)], NOW);
    const a = activityDays(ledger, NOW, 2);
    const by = Object.fromEntries(a.days.map((d) => [d.date, d]));
    expect(by['2026-11-11']!.unknown).toBe(true);
    expect(by['2026-11-12']).toEqual({ date: '2026-11-12', count: 0, level: 0 });
    expect(by['2026-11-13']!.level).toBeGreaterThan(by['2026-11-14']!.level);
    expect(a.since).toBe('2026-11-12');
    expect(a.tokens).toBe(500);
    expect(a.active).toBe(2);
  });

  it('spreads levels 1 to 4 over the days that had any use', () => {
    const ledger = mergeDays({}, [1, 2, 3, 4, 5, 6, 7, 8].map((n, i) => bucket(i, n * 100)), NOW);
    const levels = activityDays(ledger, NOW, 3).days.filter((d) => d.count > 0).map((d) => d.level);
    expect(Math.min(...levels)).toBe(1);
    expect(Math.max(...levels)).toBe(4);
    expect(new Set(levels).size).toBe(4);
  });

  it('gives one used day a level that shows', () => {
    const a = activityDays(mergeDays({}, [bucket(0, 10)], NOW), NOW, 1);
    expect(a.days.at(-1)!.level).toBeGreaterThan(0);
  });
});
