import { describe, expect, it } from 'vitest';
import { clockTime, formatClockDuration, formatDuration, setClockStyle } from './format';

describe('formatClockDuration (live clocks)', () => {
  it('floors to whole units and drops zero parts', () => {
    expect(formatClockDuration(0)).toBe('0s');
    expect(formatClockDuration(12_999)).toBe('12s');
    expect(formatClockDuration(64_000)).toBe('1m 4s');
    expect(formatClockDuration(60_000)).toBe('1m');
    expect(formatClockDuration(3_900_000)).toBe('1h 5m');
    expect(formatClockDuration(3_600_000)).toBe('1h');
    expect(formatClockDuration(93_600_000)).toBe('1d 2h');
    expect(formatClockDuration(86_400_000)).toBe('1d');
  });

  it('never goes negative', () => {
    expect(formatClockDuration(-5_000)).toBe('0s');
  });
});

describe('formatDuration (settled spans)', () => {
  it('reads milliseconds, tenths, then seconds', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(0)).toBe('1ms');
    expect(formatDuration(4_240)).toBe('4.2s');
    expect(formatDuration(23_400)).toBe('23s');
  });

  it('rounds into the clock format past a minute', () => {
    expect(formatDuration(64_600)).toBe('1m 5s');
    expect(formatDuration(3_599_600)).toBe('1h');
  });

  it('guards bad input', () => {
    expect(formatDuration(-1)).toBe('0ms');
    expect(formatDuration(Number.NaN)).toBe('0ms');
  });
});

describe('clock style', () => {
  it('writes times in 12 or 24 hours when asked', () => {
    const t = new Date(2026, 9, 27, 19, 28).getTime();
    setClockStyle('24h');
    expect(clockTime(t)).toMatch(/19:28/);
    setClockStyle('12h');
    expect(clockTime(t)).toMatch(/7:28/);
    setClockStyle('auto');
  });
});
