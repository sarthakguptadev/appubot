import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../..');
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

describe('the question card', () => {
  const css = read('index.css');
  const card = read('features/chat/QuestionCard.tsx');

  it("is a #1f1f1f card rounded 20, with rows filled #2a2a2a under the pointer and no fade", () => {
    expect(css).toMatch(/\.gen-q \{[^}]*border-radius: 20px/);
    expect(css).toMatch(/\.dark \.gen-q \{ background: #1f1f1f; \}/);
    expect(css).toMatch(/\.dark button\.gen-q-row:enabled:hover[^{]*\{ background: #2a2a2a; \}/);
    expect(css).not.toMatch(/\.gen-q[^{]*\{[^}]*transition/);
  });

  it('letters its rows with a 22px #414141 chip that turns the accent on the chosen one', () => {
    expect(css).toMatch(/\.gen-q-key \{[^}]*width: 22px; height: 22px/);
    expect(css).toMatch(/\.dark \.gen-q-key \{ background: #414141;/);
    expect(css).toMatch(/\.gen-q-key\[data-chosen\][^{]*\{ background: var\(--ab-accent\)/);
    expect(card).toContain('String.fromCharCode(65 + i)');
  });

  it('folds to the chosen row over 200 ms and dims the question once answered', () => {
    expect(card).toMatch(/const FOLD = \{ duration: 0\.2,/);
    expect(card).toContain("answer ? 'text-muted' : 'text-fg'");
    expect(card).toContain('!answer || i === chosen');
  });

  it('turns the composer into an answer prompt while a question waits', () => {
    expect(read('features/chat/Composer.tsx')).toContain("asking ? t('composer.answer')");
  });
});
