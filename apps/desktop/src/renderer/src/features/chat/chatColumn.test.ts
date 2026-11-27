import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUBBLE_CORNERS, REPLY_BUBBLE } from './AgentTurn';

const SRC = join(__dirname, '../..');
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

describe('the chat column', () => {
  it('is one column for the messages and the composer, in a bot chat and a group, up to 960px wide', () => {
    expect(read('index.css')).toMatch(/\.chat-column \{[^}]*max-width: min\(960px,/);
    for (const f of ['features/chat/Transcript.tsx', 'features/chat/ThreadView.tsx', 'features/groups/GroupView.tsx', 'features/chat/EmptyThread.tsx']) {
      expect(read(f), f).toContain('chat-column');
      expect(read(f), f).not.toContain('max-w-[46rem]');
    }
  });

  it("keeps a bot's bubble of words to 58% of it, rounded 16px, joined at 4px on the bot's side in a run", () => {
    expect(REPLY_BUBBLE).toContain('max-w-[58%]');
    expect(BUBBLE_CORNERS.only).toBe('squircle rounded-[16px]');
    expect(BUBBLE_CORNERS.first).toContain('rounded-bl-[4px]');
    expect(BUBBLE_CORNERS.middle).toContain('rounded-l-[4px]');
    expect(BUBBLE_CORNERS.last).toContain('rounded-tl-[4px]');
  });

  it('sets chat text in the system face', () => {
    expect(read('index.css')).toMatch(/\.chat-markdown \{ font-family: var\(--font-chat\); \}/);
  });
});
