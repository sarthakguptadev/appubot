import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../..');
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

describe('the working row', () => {
  it('sweeps its label with a CSS animation every 1.1s, linear, a bright band over a dim grey', () => {
    expect(read('components/rare/AiStatus.tsx')).toContain('className="ai-status-sweep bg-clip-text text-transparent"');
    const css = read('index.css');
    expect(css).toMatch(/\.ai-status-sweep \{[^}]*animation: ai-status-sweep 1\.1s linear infinite;/);
    expect(css).toMatch(/\.ai-status-sweep \{[^}]*background-size: 300% 100%;/);
  });

  it('says "Working" from the moment you send, then what the bot is doing in plain words, with its own clock', () => {
    const turn = read('features/chat/AgentTurn.tsx');
    expect(turn).toContain('liveStepLabel(msg.parts)');
    expect(turn).toContain("(step ?? WORKING_STATES.working.label)");
    expect(turn).toContain('time={<LiveElapsed since={since} />}');
    expect(turn).not.toContain('LABEL_AFTER_MS');
  });
});
