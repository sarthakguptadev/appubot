/**
 * A bot's generated CLAUDE.md is part of its profile key: a byte that changes restarts every bot's agent at its next
 * turn. AppuBot Cloud adds one paragraph to cloud bots' instructions and must leave the Mac's text exactly as it was,
 * so the macOS rendering is pinned here byte for byte (`fixtures/instructions.darwin.txt`, rendered on a Mac from the
 * generator as it was before the cloud paragraph existed). Regenerate the fixture only when the text is meant to change.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOUD_PARAGRAPH, languageName, renderAgentInstructions, renderInstructionsPreface } from './bots';
import { BOTS } from './fixtures/instructionBots';

const fixture = (): string => readFileSync(join(__dirname, 'fixtures', 'instructions.darwin.txt'), 'utf8');
const rendered = (cloud: boolean): string => BOTS.map((b) => `${'='.repeat(8)} ${b.name} ${'='.repeat(8)}\n${renderAgentInstructions(b, { cloud })}`).join('');

describe('the generated instructions', () => {
  it.runIf(process.platform === 'darwin')('are byte for byte what they were on macOS', () => {
    expect(rendered(false)).toBe(fixture());
    // the option left out is the same as false
    expect(BOTS.map((b) => renderAgentInstructions(b)).join('')).toBe(BOTS.map((b) => renderAgentInstructions(b, { cloud: false })).join(''));
  });

  it('add exactly the cloud paragraph for a cloud bot, right after who it is', () => {
    for (const b of BOTS) {
      const mac = renderAgentInstructions(b);
      const cloud = renderAgentInstructions(b, { cloud: true });
      expect(cloud).not.toBe(mac);
      expect(cloud).toContain(CLOUD_PARAGRAPH);
      // the one difference is the paragraph itself: taking it out gives the Mac's text back
      expect(cloud.replace(CLOUD_PARAGRAPH, '')).toBe(mac);
      expect(cloud.indexOf(CLOUD_PARAGRAPH)).toBeLessThan(cloud.indexOf('## How you work'));
    }
    expect(CLOUD_PARAGRAPH).toMatch(/take control/);
    expect(CLOUD_PARAGRAPH).toMatch(/one bot at a time/);
    expect(CLOUD_PARAGRAPH).toMatch(/never ask for passwords/);
    const preface = renderInstructionsPreface(BOTS[0]!, false, { cloud: true });
    expect(preface).toContain('## Where you run');
    expect(renderInstructionsPreface(BOTS[0]!, false)).not.toContain('## Where you run');
  });

  it('put the instructions for every bot before the bot’s own, and nothing when there are none', () => {
    const global = 'Reply in English. Never send an email without showing the draft.';
    for (const b of BOTS) {
      const plain = renderAgentInstructions(b);
      expect(renderAgentInstructions(b, { global: '' })).toBe(plain);
      expect(renderAgentInstructions(b, { global: '  \n' })).toBe(plain);
      const withGlobal = renderAgentInstructions(b, { global });
      expect(withGlobal).toContain(`## Instructions from the user, for every bot\n${global}`);
      if (b.instructions.trim()) {
        expect(withGlobal.indexOf('for every bot')).toBeLessThan(withGlobal.indexOf('## Instructions from the user\n'));
        expect(withGlobal).toContain(b.instructions.trim());
      }
      // the bot's own section reads as it did
      expect(withGlobal.replace(`\n## Instructions from the user, for every bot\n${global}\n`, '')).toBe(plain);
    }
    expect(renderInstructionsPreface(BOTS[0]!, false, { global })).toContain(global);
  });

  it('say the device’s language when there is one, before the user’s own instructions', () => {
    const b = BOTS.find((x) => x.instructions.trim()) ?? BOTS[0]!;
    const out = renderAgentInstructions(b, { language: 'Hindi', global: 'Be brief.' });
    expect(out).toContain("## Language\nThe user's device is set to Hindi: write to them in Hindi unless they write to you in another language, then answer in theirs.");
    expect(out.indexOf('## Language')).toBeLessThan(out.indexOf('for every bot'));
    expect(renderAgentInstructions(b)).not.toContain('## Language');
    expect(languageName('hi-IN')).toBe('Hindi');
    expect(languageName('en-IN')).toBe('English');
    expect(languageName('')).toBeUndefined();
  });
});

