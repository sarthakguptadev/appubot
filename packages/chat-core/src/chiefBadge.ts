/**
 * The chief's badge: a bot marked chief (`Bot.chief`: it messages every bot at once and leads its groups) wears a small
 * gold disc with a white five-point star on its avatar's bottom-right edge, overlapping it a little. A thin ring in the
 * colour behind the avatar cuts it out from the body, so it reads on light and dark alike. It never moves with the head:
 * the desktop app draws it over the avatar, the agent cursor and the still picture (botAvatarSvg) draw this same markup.
 * Pure geometry and colours in a 100×100 box, the avatar's own.
 */

const f = (n: number) => +n.toFixed(2);

export const CHIEF_BADGE = {
  /** the disc's fill */
  gold: '#F0A030',
  /** the star's */
  star: '#FFFFFF',
  /** the disc's middle and radius: 32% of the avatar wide, its ring reaching the box's bottom-right corner */
  cx: 81,
  cy: 81,
  r: 16,
  /** the ring round it, in the colour behind the avatar */
  ring: 3,
  /** the star's outer radius (of the disc's), its inner one (of its outer), and how round its points are */
  outer: 0.58,
  inner: 0.46,
  round: 1.3,
  /** avatars smaller than this (px) wear none: the star would not read */
  min: 18,
} as const;

/** The star's outline: five points, one straight up, centred on the disc by its own height (a star sits high in its box). */
export function chiefStar(cx: number = CHIEF_BADGE.cx, cy: number = CHIEF_BADGE.cy, r: number = CHIEF_BADGE.r): string {
  const R = r * CHIEF_BADGE.outer;
  const k = R * CHIEF_BADGE.inner;
  const y0 = cy + (R * (1 - Math.cos(Math.PI / 5))) / 2;
  let d = '';
  for (let i = 0; i < 10; i++) {
    const t = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? k : R;
    d += `${i ? 'L' : 'M'}${f(cx + rr * Math.cos(t))} ${f(y0 + rr * Math.sin(t))}`;
  }
  return `${d}Z`;
}

/** The badge as SVG markup for the 100×100 box, `ring` the colour behind the avatar (`currentColor` takes the element's). */
export function chiefBadgeSvg(ring: string): string {
  const { cx, cy, r, gold, star, round } = CHIEF_BADGE;
  return `<circle cx="${cx}" cy="${cy}" r="${r + CHIEF_BADGE.ring}" fill="${ring}"/>`
    + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${gold}"/>`
    + `<path d="${chiefStar()}" fill="${star}" stroke="${star}" stroke-width="${round}" stroke-linejoin="round"/>`;
}
