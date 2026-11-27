import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUIET_ROUND } from '../voice/Dictation';

const SRC = join(__dirname, '../..');
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

describe('the composer', () => {
  it('is 43px on one line: 28px buttons with 6.5px around them inside its 1px edge', () => {
    const composer = read('features/chat/Composer.tsx');
    expect(composer).toMatch(/const ADD = 'chat-round [^']*\bsize-7\b/);
    expect(composer).toMatch(/const ROUND = cn\(SEND, 'size-7\b/);
    expect(composer).toContain('p-[6.5px]');
    expect(composer).toContain("'chat-composer-field min-w-0 py-[3.5px]");
    expect(QUIET_ROUND.split(' ')).toContain('size-7');
    expect(composer + read('features/voice/Dictation.tsx')).not.toMatch(/\bsize-8\b/);
  });

  it('drops + and its buttons to a row under the draft once it is tall, except in the Messages theme', () => {
    const css = read('index.css');
    expect(css).toContain('.chat-composer { grid-template-areas: "add field actions"; }');
    expect(css).toContain('html:not([data-theme="messages"]) .chat-composer[data-tall] { grid-template-areas: "field field field" "add . actions"; }');
    expect(read('features/chat/Composer.tsx')).toContain("data-tall={tall ? '' : undefined}");
  });
});
