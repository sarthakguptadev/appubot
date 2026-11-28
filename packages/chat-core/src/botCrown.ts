/**
 * The chief's crown: a bot marked chief (`Bot.chief`: it messages every bot at once and leads its groups) wears one
 * on its head. A gold ring of `BOT_CROWN.panels` flat panels round the top of the head, each a band with a point, a
 * jewel on the tip and one on the band, leaning out a little like a real crown. Pure geometry and colours in the
 * avatar's 100×100 box: the desktop builds it as a solid in CSS 3D that turns with the head (components/ui/BotAvatar.tsx),
 * and the still drawings (Telegram's photo, the agent cursor) draw its front view, with the panels behind the head
 * drawn under the body (`botCrownSvg`). Softly shaded by one light from the upper left, flat, no gloss.
 */
import type { BotShape } from '@appubot/protocol';
import { characterBox, type CharacterFigure } from './characters';
import { BOT_MIDDLE } from './botMotion';

export const BOT_CROWN = {
  panels: 8,
  /** how far each panel leans out at the top, and how far the whole crown tips its top toward you, degrees */
  flare: 6,
  tilt: 14,
  /** the panel's height and its band's, and where the tip and jewels sit, as parts of the ring's radius */
  height: 0.98, bandHeight: 0.34, tip: 0.17, jewelSize: 0.085, gemSize: 0.062,
  gold: '#FEB12B',
  band: '#F09F1C',
  inner: '#C88E2C',
  jewel: '#FFF3D6',
  /** the light: a unit vector toward it, y down and z toward you (upper left, in front) */
  light: [-0.45, -0.55, 0.7],
  /** a panel's shade: `max` × (`lit` − how much it faces the light), from 0 to `max` */
  shade: { max: 0.3, lit: 0.72 },
} as const;

/** Where the crown sits on each body: `y` the bottom of its band, `r` its ring's radius (the round bot's head top is 6). */
const SEAT: Readonly<Record<BotShape, { y: number; r: number }>> = {
  circle: { y: 17, r: 23 },
  squircle: { y: 18, r: 20 },
  square: { y: 12, r: 21 },
  pill: { y: 22, r: 19 },
  triangle: { y: 34, r: 12 },
  hex: { y: 17, r: 18 },
  cloud: { y: 24, r: 16 },
  drop: { y: 28, r: 12 },
  egg: { y: 16, r: 15 },
  ghost: { y: 18, r: 19 },
  flower: { y: 14, r: 19 },
  shield: { y: 15, r: 19 },
  octagon: { y: 12, r: 18 },
  heart: { y: 28, r: 15 },
  diamond: { y: 24, r: 14 },
  bell: { y: 15, r: 17 },
  mushroom: { y: 22, r: 21 },
  bear: { y: 25, r: 14 },
};

export interface BotCrownFace {
  /** the panel's place round the ring, degrees (0 faces you) */
  theta: number;
  /** the panel's inside (seen across the ring when it is at the back) */
  inner: boolean;
  /** CSS 3D: from the panel's middle, out to its place on the ring (each plane's own origin is its centre) */
  at: string;
  /** the face's middle from the head's middle, and the way it faces, with the head at rest (y down, z toward you) */
  p: readonly [number, number, number];
  n: readonly [number, number, number];
  /** its own x and y axes on the page at rest (for the front view) */
  u: readonly [number, number, number];
  v: readonly [number, number, number];
}

export interface BotCrown {
  /** the ring's middle line, the bottom of its band, its radius, and the head's middle it turns round */
  cx: number;
  y: number;
  r: number;
  middle: number;
  /** one panel's box (each panel is drawn in `0 0 w h`) and how far its middle is from the ring's axis */
  w: number;
  h: number;
  apothem: number;
  /** the panel: its point (above the band), its band, the jewel on its tip and the gem on its band */
  point: string;
  band: { x: number; y: number; w: number; h: number };
  jewel: { cx: number; cy: number; r: number };
  gem: { cx: number; cy: number; r: number };
  faces: readonly BotCrownFace[];
}

type V3 = readonly [number, number, number];
const f = (n: number) => +n.toFixed(3);
const rad = (deg: number) => (deg * Math.PI) / 180;
/** CSS's rotateX and rotateY on a point (y down, z toward you) */
const rx = (d: number, [x, y, z]: V3): V3 => { const c = Math.cos(rad(d)), s = Math.sin(rad(d)); return [x, y * c - z * s, y * s + z * c]; };
const ry = (d: number, [x, y, z]: V3): V3 => { const c = Math.cos(rad(d)), s = Math.sin(rad(d)); return [x * c + z * s, y, -x * s + z * c]; };

function seatOf(figure: BotShape | CharacterFigure): { y: number; r: number } {
  if (figure && typeof figure === 'object') {
    const box = characterBox(figure.body);
    if (box) {
      const w = box.x1 - box.x0;
      return { y: box.y0 + Math.min(10, 0.12 * (box.y1 - box.y0)), r: Math.max(10, Math.min(21, 0.24 * w)) };
    }
    return SEAT.circle;
  }
  return SEAT[figure] ?? SEAT.circle;
}

/** The crown for a figure: where it sits, its panel's drawing, and each face's place round the ring. */
export function botCrown(figure: BotShape | CharacterFigure, cx = 50): BotCrown {
  const C = BOT_CROWN;
  const { y, r } = seatOf(figure);
  const middle = typeof figure === 'string' ? BOT_MIDDLE[figure] ?? 50 : 50;
  const n = C.panels;
  const w = 2 * r * Math.sin(Math.PI / n);
  const apothem = r * Math.cos(Math.PI / n);
  const h = C.height * r;
  const bandTop = h - C.bandHeight * r;
  const tipY = C.tip * r;
  const neck = 0.035 * r;
  const sag = 0.05 * r;
  const point = `M0 ${f(bandTop + 0.5)}V${f(bandTop)}Q${f(w * 0.32)} ${f(bandTop - sag)} ${f(w / 2 - neck)} ${f(tipY)}H${f(w / 2 + neck)}Q${f(w * 0.68)} ${f(bandTop - sag)} ${f(w)} ${f(bandTop)}V${f(bandTop + 0.5)}Z`;
  // the crown tips round its own middle (the panels' middles, half way up), which sits this far from the head's
  const pivot: V3 = [0, y - h / 2 - middle, 0];
  const place = (theta: number, q: V3): V3 => rx(-C.tilt, ry(theta, q));
  const faces: BotCrownFace[] = [];
  for (let i = 0; i < n; i++) {
    const theta = (360 / n) * i;
    const lean = (q: V3) => place(theta, rx(-C.flare, q));
    const c = place(theta, [0, 0, apothem]);
    const p: V3 = [f(c[0] + pivot[0]), f(c[1] + pivot[1]), f(c[2])];
    const out = lean([0, 0, 1]).map(f) as unknown as V3;
    const u = lean([1, 0, 0]).map(f) as unknown as V3;
    const v = lean([0, 1, 0]).map(f) as unknown as V3;
    const tip = `rotateX(${-C.tilt}deg) rotateY(${theta}deg)`;
    faces.push({ theta, inner: false, at: `${tip} translateZ(${f(apothem)}px) rotateX(${-C.flare}deg)`, p, n: out, u, v });
    faces.push({
      theta, inner: true, at: `${tip} translateZ(${f(apothem - 0.15)}px) rotateX(${-C.flare}deg) rotateY(180deg)`,
      p, n: out.map((x) => -x) as unknown as V3, u: u.map((x) => -x) as unknown as V3, v,
    });
  }
  return {
    cx, y, r, middle, w: f(w), h: f(h), apothem: f(apothem), point,
    // a hair wider than the panel, so neighbouring bands meet with no seam
    band: { x: -0.25, y: f(bandTop), w: f(w + 0.5), h: f(h - bandTop) },
    jewel: { cx: f(w / 2), cy: f(tipY), r: f(C.jewelSize * r) },
    gem: { cx: f(w / 2), cy: f((bandTop + h) / 2), r: f(C.gemSize * r) },
    faces,
  };
}

/** A vector of the head at rest, the head turned by yaw and nodded by pitch (the avatar's own rotateX(pitch) rotateY(yaw)). */
export function crownTurn(q: V3, yaw = 0, pitch = 0): V3 {
  return rx(pitch, ry(yaw, q));
}

/** How much a face catches the light (−1..1), turned as the head is. */
export function crownLight(face: Pick<BotCrownFace, 'n'>, yaw = 0, pitch = 0): number {
  const [x, y, z] = crownTurn(face.n, yaw, pitch);
  const [lx, ly, lz] = BOT_CROWN.light;
  return lx * x + ly * y + lz * z;
}

/** The shade over a face, 0..BOT_CROWN.shade.max, from how much it catches the light. */
export function crownShade(light: number): number {
  const { max, lit } = BOT_CROWN.shade;
  return Math.max(0, Math.min(max, max * (lit - light)));
}

/**
 * The crown seen from the front at rest, as SVG for a 100×100 drawing: `back` (what is behind the head's middle,
 * drawn before the body so the head hides it where it covers it) and `front` (drawn over the face).
 */
export function botCrownSvg(figure: BotShape | CharacterFigure, cx = 50): { back: string; front: string } {
  const c = botCrown(figure, cx);
  const C = BOT_CROWN;
  const back: { z: number; svg: string }[] = [];
  const front: { z: number; svg: string }[] = [];
  for (const face of c.faces) {
    // facing away, or edge on (a sliver at most): left out
    if (face.n[2] <= 0.15) continue;
    // the panel's own box onto the page: its middle, plus its x and y axes as they lie at rest
    const e = c.cx + face.p[0] - face.u[0] * (c.w / 2) - face.v[0] * (c.h / 2);
    const g = c.middle + face.p[1] - face.u[1] * (c.w / 2) - face.v[1] * (c.h / 2);
    const shade = crownShade(crownLight(face));
    const ink = (hex: string) => mix(hex, shade);
    const svg = `<g transform="matrix(${f(face.u[0])} ${f(face.u[1])} ${f(face.v[0])} ${f(face.v[1])} ${f(e)} ${f(g)})">`
      + `<path d="${c.point}" fill="${ink(face.inner ? C.inner : C.gold)}"/>`
      + `<rect x="${c.band.x}" y="${c.band.y}" width="${c.band.w}" height="${c.band.h}" fill="${ink(face.inner ? C.inner : C.band)}"/>`
      + (face.inner ? '' : `<circle cx="${c.jewel.cx}" cy="${c.jewel.cy}" r="${c.jewel.r}" fill="${ink(C.jewel)}"/><circle cx="${c.gem.cx}" cy="${c.gem.cy}" r="${c.gem.r}" fill="${ink(C.jewel)}"/>`)
      + '</g>';
    (face.p[2] >= 0 ? front : back).push({ z: face.p[2] + (face.inner ? -0.01 : 0), svg });
  }
  const join = (list: { z: number; svg: string }[]) => list.sort((a, b) => a.z - b.z).map((x) => x.svg).join('');
  return { back: `<g>${join(back)}</g>`, front: `<g>${join(front)}</g>` };
}

/** `hex` darkened by `t` (0..1) toward black. */
function mix(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * (1 - t)).toString(16).padStart(2, '0'));
  return `#${ch.join('')}`;
}
