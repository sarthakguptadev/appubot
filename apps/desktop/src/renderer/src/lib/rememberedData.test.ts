import { describe, expect, it } from 'vitest';
import { MAX_CHARS, MAX_KEYS, readRemembered, withAnswer } from './rememberedData';

describe('remembered answers', () => {
  it('a miss is nothing; an answer is a hit with when it was read; a newer one replaces it', () => {
    let m = {};
    expect((m as Record<string, unknown>)['usage:7d']).toBeUndefined();
    m = withAnswer(m, 'usage:7d', { cost: 1 }, 100);
    expect(m).toEqual({ 'usage:7d': { at: 100, value: { cost: 1 } } });
    m = withAnswer(m, 'usage:7d', { cost: 2 }, 200);
    expect(m).toEqual({ 'usage:7d': { at: 200, value: { cost: 2 } } });
  });

  it('keeps the newest MAX_KEYS answers and stays under MAX_CHARS, dropping the oldest', () => {
    let m = {};
    for (let i = 0; i < MAX_KEYS + 5; i++) m = withAnswer(m, `k${i}`, i, i);
    expect(Object.keys(m)).toHaveLength(MAX_KEYS);
    expect(m).not.toHaveProperty('k0');
    expect(m).toHaveProperty(`k${MAX_KEYS + 4}`);
    const big = 'x'.repeat(Math.floor(MAX_CHARS / 3));
    let n = {};
    for (let i = 0; i < 4; i++) n = withAnswer(n, `b${i}`, big, i);
    expect(JSON.stringify(n).length).toBeLessThanOrEqual(MAX_CHARS);
    expect(n).toHaveProperty('b3');
    expect(n).not.toHaveProperty('b0');
  });

  it('reads back only well-formed entries', () => {
    expect(readRemembered(null)).toEqual({});
    expect(readRemembered([1])).toEqual({});
    expect(readRemembered({ a: { at: 1, value: 2 }, b: { at: 'x', value: 1 }, c: { at: 1 }, d: null })).toEqual({ a: { at: 1, value: 2 } });
  });
});
