// The agent cursor's avatar wears the chief's crown when its bot is a chief (chat-core botCrownSvg), and only then.
import { describe, expect, it } from 'vitest';
import { cursorLook } from './agentCursorPage';

describe("the agent cursor's avatar", () => {
  it("wears the crown for a chief, its back under the body and its front over the face", () => {
    const look = cursorLook({ figure: 'circle', color: '#FF7A1F', seed: 0.3, chief: true });
    const body = look.svg.indexOf('fill="url(#cb-body)"');
    // the jewels on its front, over the face
    expect(look.svg.lastIndexOf('<circle')).toBeGreaterThan(body);
    expect(look.svg.indexOf('<g transform="matrix(')).toBeLessThan(body);
    expect(look.key).toMatch(/chief$/);
  });

  it('wears none for any other bot', () => {
    const look = cursorLook({ figure: 'circle', color: '#FF7A1F', seed: 0.3 });
    expect(look.svg).not.toContain('matrix(');
    expect(look.key).not.toMatch(/chief/);
  });
});
