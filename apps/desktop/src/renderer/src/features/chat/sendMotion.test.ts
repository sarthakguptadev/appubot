import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEND_GLIDE_MS } from './Transcript';

const SRC = join(__dirname, '../..');
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

describe('sending a message', () => {
  it('paints the bubble in the frame it lands, with no fade or rise', () => {
    expect(read('index.css')).not.toContain('chat-message-send-enter');
    expect(read('features/chat/Transcript.tsx')).not.toContain('chat-message-send-enter');
  });

  it('glides the scroll to it over 150-170 ms, eased out, and jumps with Reduce motion on', () => {
    expect(SEND_GLIDE_MS).toBeGreaterThanOrEqual(150);
    expect(SEND_GLIDE_MS).toBeLessThanOrEqual(170);
    const src = read('features/chat/Transcript.tsx');
    expect(src).toContain('(1 - (1 - p) ** 3)');
    expect(src).toContain("matchMedia('(prefers-reduced-motion: reduce)').matches");
    expect(src).not.toContain("behavior: smooth ? 'smooth'");
  });
});
