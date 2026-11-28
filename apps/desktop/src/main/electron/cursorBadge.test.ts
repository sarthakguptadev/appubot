// The agent cursor's avatar wears the chief's badge when its bot is a chief (chat-core chiefBadgeSvg), and only then.
import { describe, expect, it } from 'vitest';
import { CHIEF_BADGE } from '@appubot/chat-core';
import { cursorLook } from './agentCursorPage';

describe("the agent cursor's avatar", () => {
  it('wears the badge for a chief, over the face and outside the layers that move the head', () => {
    const look = cursorLook({ figure: 'circle', color: '#FF7A1F', seed: 0.3, chief: true });
    const gold = look.svg.indexOf(`fill="${CHIEF_BADGE.gold}"`);
    expect(gold).toBeGreaterThan(look.svg.indexOf('fill="url(#cb-body)"'));
    expect(gold).toBeGreaterThan(look.svg.lastIndexOf('</g></g></g>'));
    expect(look.key).toMatch(/chief$/);
  });

  it('wears none for any other bot', () => {
    const look = cursorLook({ figure: 'circle', color: '#FF7A1F', seed: 0.3 });
    expect(look.svg).not.toContain(CHIEF_BADGE.gold);
    expect(look.key).not.toMatch(/chief/);
  });
});
