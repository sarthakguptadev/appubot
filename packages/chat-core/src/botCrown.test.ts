import { describe, expect, it } from 'vitest';
import { BOT_CROWN, botAvatarSvg, botCrown, botCrownSvg, crownLight, crownShade, crownTurn } from './index';

describe("the chief's crown", () => {
  it('sits on top of every head, inside the drawing from side to side', () => {
    for (const shape of ['circle', 'square', 'triangle', 'heart', 'bear', 'mushroom'] as const) {
      const c = botCrown(shape);
      expect(c.cx - c.r, shape).toBeGreaterThan(0);
      expect(c.cx + c.r, shape).toBeLessThan(100);
      expect(c.y - c.h, shape).toBeGreaterThan(-12);
      expect(c.y, shape).toBeLessThan(40);
      expect(c.faces).toHaveLength(BOT_CROWN.panels * 2);
    }
  });

  it('has its front in front of the head and its back behind it, at rest', () => {
    const c = botCrown('circle');
    const outer = c.faces.filter((f) => !f.inner);
    expect(outer.find((f) => f.theta === 0)!.p[2]).toBeGreaterThan(0);
    expect(outer.find((f) => f.theta === 180)!.p[2]).toBeLessThan(0);
  });

  it('goes round the back with the head: turned half way round, its front is behind', () => {
    const front = botCrown('circle').faces.find((f) => f.theta === 0 && !f.inner)!;
    expect(crownTurn(front.p, 180)[2]).toBeLessThan(0);
    expect(crownTurn(front.p, 0)[2]).toBeGreaterThan(0);
  });

  it('is lit from the upper left: its left side brighter than its right', () => {
    const faces = botCrown('circle').faces.filter((f) => !f.inner);
    const left = faces.find((f) => f.theta === 315)!;
    const right = faces.find((f) => f.theta === 45)!;
    expect(crownShade(crownLight(left))).toBeLessThan(crownShade(crownLight(right)));
    expect(crownShade(1)).toBe(0);
    expect(crownShade(-1)).toBe(BOT_CROWN.shade.max);
  });

  it('draws its back under the body and its front over the face in the still picture, for a chief only', () => {
    const { back, front } = botCrownSvg('circle');
    expect(back).toContain('<path');
    expect(front).toContain('<circle');
    const chief = botAvatarSvg('circle', '#4C8DFF', 640, true);
    const body = chief.indexOf('fill="url(#body)"');
    expect(chief.indexOf(back)).toBeLessThan(body);
    expect(chief.indexOf(front)).toBeGreaterThan(body);
    expect(botAvatarSvg('circle', '#4C8DFF', 640)).not.toContain(front);
  });
});
