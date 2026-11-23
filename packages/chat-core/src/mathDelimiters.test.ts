import { describe, expect, it } from 'vitest';
import { normalizeMathDelimiters } from './mathDelimiters';

describe('normalizeMathDelimiters', () => {
  it('turns \\( \\), $…$ and \\[ \\] into what remark-math reads', () => {
    expect(normalizeMathDelimiters('Area \\(\\pi r^2\\) here')).toBe('Area $$\\pi r^2$$ here');
    expect(normalizeMathDelimiters('Area $\\pi r^2$ here')).toBe('Area $$\\pi r^2$$ here');
    expect(normalizeMathDelimiters('So \\[x^2\\] done')).toBe('So \n$$\nx^2\n$$\n done');
  });
  it('makes a lone $$…$$ line a display block', () => {
    expect(normalizeMathDelimiters('$$\\frac{a}{b}$$')).toBe('$$\n\\frac{a}{b}\n$$');
  });
  it('leaves money, code and escaped dollars alone', () => {
    expect(normalizeMathDelimiters('Costs $5 and $10')).toBe('Costs $5 and $10');
    expect(normalizeMathDelimiters('Paid $ 5 then $ 6')).toBe('Paid $ 5 then $ 6');
    expect(normalizeMathDelimiters('```\n\\(x\\)\n```')).toBe('```\n\\(x\\)\n```');
    expect(normalizeMathDelimiters('use `$x$` here')).toBe('use `$x$` here');
  });
});
