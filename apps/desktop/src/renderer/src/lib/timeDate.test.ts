import { describe, expect, it } from 'vitest';
import { dateOrder, daysIn, formatDate, formatTime, is12Hour, parseDate, parseTime, to12, to24 } from './timeDate';

describe('time of day', () => {
  it('reads and writes HH:MM', () => {
    expect(parseTime('09:05')).toEqual({ hour: 9, minute: 5 });
    expect(parseTime('9:05:30')).toEqual({ hour: 9, minute: 5 });
    expect(parseTime('24:00')).toEqual({});
    expect(parseTime('')).toEqual({});
    expect(formatTime(9, 5)).toBe('09:05');
    expect(formatTime(0, 0)).toBe('00:00');
    expect(formatTime(9, undefined)).toBe('');
    expect(formatTime(undefined, 5)).toBe('');
  });

  it('goes to a 12-hour clock and back for every hour', () => {
    expect(to12(0)).toEqual({ hour: 12, pm: 0 });
    expect(to12(12)).toEqual({ hour: 12, pm: 1 });
    expect(to12(15)).toEqual({ hour: 3, pm: 1 });
    for (let h = 0; h < 24; h++) {
      const t = to12(h);
      expect(to24(t.hour, t.pm)).toBe(h);
    }
  });

  it('knows a 12-hour clock from the style, else the locale', () => {
    expect(is12Hour('en-GB', { hourCycle: 'h12' })).toBe(true);
    expect(is12Hour('en-US', { hourCycle: 'h23' })).toBe(false);
    expect(is12Hour('en-US', {})).toBe(true);
    expect(is12Hour('de-DE', {})).toBe(false);
  });
});

describe('dates', () => {
  it('reads and writes YYYY-MM-DD', () => {
    expect(parseDate('2026-11-14')).toEqual({ year: 2026, month: 11, day: 14 });
    expect(parseDate('2026-02-30')).toEqual({});
    expect(parseDate('14/11/2026')).toEqual({});
    expect(formatDate(2026, 11, 4)).toBe('2026-11-04');
    expect(formatDate(2026, 11, undefined)).toBe('');
    expect(formatDate(26, 11, 4)).toBe('');
  });

  it('keeps a day inside its month', () => {
    expect(daysIn(2024, 2)).toBe(29);
    expect(daysIn(2026, 2)).toBe(28);
    expect(formatDate(2026, 2, 31)).toBe('2026-02-28');
    expect(formatDate(2026, 4, 31)).toBe('2026-04-30');
  });

  it('orders the parts as the locale writes them', () => {
    expect(dateOrder('en-US')).toEqual(['month', 'day', 'year']);
    expect(dateOrder('en-GB')).toEqual(['day', 'month', 'year']);
    expect(dateOrder('ja-JP')).toEqual(['year', 'month', 'day']);
  });
});
