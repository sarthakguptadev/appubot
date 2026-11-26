import { describe, expect, it } from 'vitest';
import { chipsThatFit } from './chips';

describe('the category chips that fit on one line', () => {
  it('shows every chip when the line holds them all, with no room kept for More', () => {
    expect(chipsThatFit([40, 100, 100], 248, 4, 80)).toEqual({ count: 3, width: 248 });
    expect(chipsThatFit([], 300, 4, 80)).toEqual({ count: 0, width: 0 });
  });

  it('keeps room for More once one chip has to go', () => {
    // 40 + 4 + 100 = 144 fits in 247 - 80; a third chip would not
    expect(chipsThatFit([40, 100, 100], 247, 4, 80)).toEqual({ count: 2, width: 144 });
    expect(chipsThatFit([40, 100, 100, 100], 340, 4, 80)).toEqual({ count: 3, width: 248 });
  });

  it('always shows the first chip, however narrow the line', () => {
    expect(chipsThatFit([40, 100], 60, 4, 80)).toEqual({ count: 1, width: 40 });
  });
});
