import { describe, expect, it } from 'vitest';
import { cronToSpec, specToCron } from './schedule';
import { cronToHuman } from './format';

describe('routine schedules', () => {
  it('reads cron back into what the editor picks, and writes it again unchanged', () => {
    for (const cron of ['15 * * * *', '0 9 * * *', '30 8 * * 1-5', '0 18 * * 1,3,5', '0 7 1 * *']) expect(specToCron(cronToSpec(cron))).toBe(cron);
    expect(cronToSpec('0 9 * * 1-5')).toEqual({ kind: 'weekdays', hour: 9, minute: 0 });
    expect(cronToSpec('0 18 * * MON,WED,FRI')).toEqual({ kind: 'days', days: [1, 3, 5], hour: 18, minute: 0 });
    expect(cronToSpec('*/15 9-17 * * *')).toEqual({ kind: 'custom', cron: '*/15 9-17 * * *' });
  });
  it('says a list of days in words', () => {
    expect(cronToHuman('0 18 * * 1,3,5')).toMatch(/^Mon, Wed and Fri at /);
  });
});
