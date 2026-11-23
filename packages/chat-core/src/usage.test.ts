import { describe, expect, it } from 'vitest';
import { cacheHitRate, formatTokens, formatUsd, usageSourceNames } from './usage';

describe('usage words', () => {
  it('names the agents read, a profile as its agent', () => {
    expect(usageSourceNames([])).toBe('');
    expect(usageSourceNames([{ name: 'Grok' }])).toBe('Grok');
    expect(usageSourceNames([{ name: 'Claude Code · Main' }, { name: 'Claude Code · Work' }, { name: 'Codex' }, { name: 'Gemini CLI' }])).toBe('Claude Code, Codex and Gemini CLI');
  });
  it('formats money, tokens and the cache share', () => {
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(1234.5)).toBe('$1,235');
    expect(formatTokens(12_345)).toBe('12.3K');
    expect(cacheHitRate({ input: 10, cacheRead: 90, cacheWrite: 0 })).toBe('90%');
  });
});
