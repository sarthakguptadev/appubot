import { describe, expect, it } from 'vitest';
import { BOT_NAMES, randomBotName } from './botNames';
import { hasPlaceholderName } from './threads';

describe('a new bot’s random name', () => {
  it('is never a placeholder or one already here', () => {
    expect(new Set(BOT_NAMES.map((n) => n.toLowerCase())).size).toBe(BOT_NAMES.length);
    for (const n of BOT_NAMES) expect(hasPlaceholderName(n)).toBe(false);
    for (let i = 0; i < 50; i++) expect(['Pip', 'juno']).not.toContain(randomBotName(['Pip', 'juno']));
  });

  it('changes on a reroll, and numbers one when every name is taken', () => {
    for (let i = 0; i < 50; i++) expect(randomBotName([], 'Pip')).not.toBe('Pip');
    expect(randomBotName(BOT_NAMES, undefined, () => 0)).toBe(`${BOT_NAMES[0]} 2`);
  });
});
