import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(join(__dirname, '../..', f), 'utf8').replace(/\r\n/g, '\n');

describe('the voice orb', () => {
  it('is never missing: the CSS orb stands in while the canvas loads, and it keeps a size of its own', () => {
    expect(read('features/voice/VoiceOrb.tsx')).toContain('<Suspense fallback={fallback}>');
    expect(read('features/voice/VoiceView.tsx')).toContain("'--orb': 'max(120px, min(320px, 50cqh, 76cqw))'");
  });

  it('has the bottom of the window to itself: there is no support bubble, only the panel the account menu opens', () => {
    const widget = read('features/support/SupportWidget.tsx');
    expect(widget).not.toContain('<button');
    expect(widget).toContain('<AnimatePresence>\n      {open ? (');
  });
});
