import { describe, expect, it } from 'vitest';
import { CHIEF_BADGE, botAvatarSvg, chiefBadgeSvg, chiefStar } from './index';

describe("the chief's badge", () => {
  it('is a gold disc about a third of the avatar wide on its bottom-right edge, its ring inside the box', () => {
    const { cx, cy, r, ring } = CHIEF_BADGE;
    expect((2 * r) / 100).toBeGreaterThanOrEqual(0.3);
    expect((2 * r) / 100).toBeLessThanOrEqual(0.34);
    expect(cx).toBe(cy);
    expect(cx + r + ring).toBeLessThanOrEqual(100);
    // it overlaps the round bot's edge (radius 44 round the middle) without covering its middle
    const fromMiddle = Math.hypot(cx - 50, cy - 50);
    expect(fromMiddle - r).toBeLessThan(44);
    expect(fromMiddle + r).toBeGreaterThan(44);
  });

  it('draws a five-point star inside the disc, point up', () => {
    const pts = [...chiefStar().matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => [+m[1]!, +m[2]!] as const);
    expect(pts).toHaveLength(10);
    for (const [x, y] of pts) expect(Math.hypot(x - CHIEF_BADGE.cx, y - CHIEF_BADGE.cy)).toBeLessThan(CHIEF_BADGE.r);
    expect(pts[0]![0]).toBeCloseTo(CHIEF_BADGE.cx, 1);
    expect(Math.min(...pts.map(([, y]) => y))).toBe(pts[0]![1]);
  });

  it('rings itself in the colour behind it, then gold, then the white star', () => {
    const svg = chiefBadgeSvg('currentColor');
    expect(svg.indexOf('fill="currentColor"')).toBeLessThan(svg.indexOf(`fill="${CHIEF_BADGE.gold}"`));
    expect(svg.indexOf(`fill="${CHIEF_BADGE.gold}"`)).toBeLessThan(svg.indexOf(`fill="${CHIEF_BADGE.star}"`));
  });

  it('is on the still picture over the face, for a chief only', () => {
    const chief = botAvatarSvg('circle', '#4C8DFF', 640, true);
    expect(chief.indexOf(`fill="${CHIEF_BADGE.gold}"`)).toBeGreaterThan(chief.indexOf('fill="url(#glass)"'));
    expect(chief).toContain(chiefStar());
    expect(botAvatarSvg('circle', '#4C8DFF', 640)).not.toContain(CHIEF_BADGE.gold);
  });
});
