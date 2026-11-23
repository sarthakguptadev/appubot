import { describe, expect, it } from 'vitest';
import { CREDITS, creditByline, creditGroups, creditLinkText, modelCredits } from './credits';

describe('credits', () => {
  it('names everyone once, in plain words, with addresses that open', () => {
    const names = CREDITS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of CREDITS) {
      expect(c.used.length, c.name).toBeGreaterThan(8);
      expect(`${c.name} ${c.used}`, c.name).not.toMatch(/—/);
      if (c.url) expect(c.url, c.name).toMatch(/^https:\/\//);
      // ported code says under which licence, and an MIT one whose copyright it is
      if (c.kind === 'code' && c.license === 'MIT') expect(c.holders?.length, c.name).toBeGreaterThan(0);
    }
  });

  it('lists only what is in the apps, never a product that was merely studied', () => {
    expect(CREDITS.every((c) => ['code', 'asset', 'service'].includes(c.kind))).toBe(true);
    for (const name of ['OpenBot', 'Grok Bot', 'ChatGPT', 'Amphetamine']) expect(CREDITS.some((c) => c.name === name), name).toBe(false);
  });

  it('carries the ports the source names', () => {
    for (const name of ['Synara', 'T3 Code', 'Akeru Bot', 'MonoCode', 'shadcn/ui', 'Silero VAD', 'Rare UI']) {
      expect(CREDITS.find((c) => c.name === name)?.kind, name).toBe('code');
    }
    // Rare UI's licence asks for a credit with a link people can find
    expect(CREDITS.find((c) => c.name === 'Rare UI')?.url).toBe('https://rareui.com');
  });

  it('groups them for the page, the models from the voice list', () => {
    const groups = creditGroups();
    expect(groups.map((g) => g.title)).toEqual(['Built on', 'Runs on', 'Fonts and icons', 'Speech models']);
    expect(groups.flatMap((g) => g.credits).length).toBe(CREDITS.length + modelCredits().length);
    expect(modelCredits().every((m) => m.by && m.license && m.url)).toBe(true);
  });

  it('words a credit’s small lines', () => {
    expect(creditByline({ kind: 'code', name: 'x', used: '', by: 'Nick', license: 'MIT' })).toBe('Nick · MIT');
    expect(creditByline({ kind: 'service', name: 'x', used: '' })).toBe('');
    expect(creditLinkText('https://www.sarvam.ai/')).toBe('sarvam.ai');
    expect(creditLinkText('https://github.com/hardbeat920/monocode')).toBe('github.com/hardbeat920/monocode');
  });
});
