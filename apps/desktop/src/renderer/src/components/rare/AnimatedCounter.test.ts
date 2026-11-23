import { describe, expect, it } from 'vitest';
import { numberParts } from './AnimatedCounter';

describe('a written number’s parts', () => {
  it('splits money, short counts and percentages', () => {
    expect(numberParts('$55.99')).toEqual({ prefix: '$', value: 55.99, decimals: 2, suffix: '' });
    expect(numberParts('124M')).toEqual({ prefix: '', value: 124, decimals: 0, suffix: 'M' });
    expect(numberParts('23.6M')).toEqual({ prefix: '', value: 23.6, decimals: 1, suffix: 'M' });
    expect(numberParts('62% left')).toEqual({ prefix: '', value: 62, decimals: 0, suffix: '% left' });
    expect(numberParts('$1,234.50')).toEqual({ prefix: '$', value: 1234.5, decimals: 2, suffix: '' });
    expect(numberParts('<$0.01')).toEqual({ prefix: '<$', value: 0.01, decimals: 2, suffix: '' });
  });

  it('answers null for text with no number', () => {
    expect(numberParts('No price')).toBeNull();
    expect(numberParts('')).toBeNull();
  });
});
