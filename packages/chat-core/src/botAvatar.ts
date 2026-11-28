/**
 * The bot avatar, AppuBot's own: a body in the bot's colour wearing a dark visor with two glowing eyes tinted from
 * that colour. Flat since 2026-11-11 (`BOT_FLAT`, the owner's trial: one colour, no highlight, a one-tone visor, like
 * the app icon's flat tile); before, glossy (lighter at the top, deeper at the bottom, a soft highlight, a glass
 * visor), which `BOT_FLAT = false` brings back everywhere it is drawn. Pure geometry and colours in a
 * 100×100 box; desktop (components/ui/BotAvatar.tsx) and mobile (src/ui/BotAvatar.tsx) only draw it. How it moves:
 * botMotion.ts.
 */
import type { BotShape } from '@appubot/protocol';
import { BOT_BASE } from './botMotion';
import { characterBox, type CharacterFigure } from './characters';
import { botCrownSvg } from './botCrown';

type Pt = readonly [number, number];
const f = (n: number) => +n.toFixed(2);

/** A polygon with every corner rounded by `r` (quadratic corners, so it stays a plain path). */
function roundedPolygon(pts: Pt[], r: number): string {
  const n = pts.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[(i - 1 + n) % n]!;
    const [x, y] = pts[i]!;
    const [nx, ny] = pts[(i + 1) % n]!;
    const toward = (ax: number, ay: number): Pt => {
      const len = Math.hypot(ax - x, ay - y);
      const k = Math.min(r, len / 2) / len;
      return [x + (ax - x) * k, y + (ay - y) * k];
    };
    const a = toward(px, py);
    const b = toward(nx, ny);
    d += `${i ? 'L' : 'M'}${f(a[0])} ${f(a[1])}Q${f(x)} ${f(y)} ${f(b[0])} ${f(b[1])}`;
  }
  return `${d}Z`;
}

/** A soft organic blob: a circle whose radius ripples with a few slow waves, traced as a closed polyline. */
function blob(cx: number, cy: number, r: number, steps = 72): string {
  let d = '';
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const rr = r + 4.2 * Math.sin(3 * t + 0.5) + 2.6 * Math.cos(2 * t - 0.4);
    d += `${i ? 'L' : 'M'}${f(cx + rr * Math.cos(t))} ${f(cy + rr * Math.sin(t))}`;
  }
  return `${d}Z`;
}

/** A flower: a circle with `petals` round bumps on its edge. */
function scallop(cx: number, cy: number, r: number, petals: number, depth: number, steps = 96): string {
  let d = '';
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const rr = r + depth * Math.cos(petals * t);
    d += `${i ? 'L' : 'M'}${f(cx + rr * Math.cos(t))} ${f(cy + rr * Math.sin(t))}`;
  }
  return `${d}Z`;
}

const hexagon: Pt[] = Array.from({ length: 6 }, (_, i) => {
  const t = (Math.PI / 3) * i - Math.PI / 2;
  return [50 + 45 * Math.cos(t), 50 + 45 * Math.sin(t)] as const;
});
const octagon: Pt[] = Array.from({ length: 8 }, (_, i) => {
  const t = (Math.PI / 4) * i + Math.PI / 8;
  return [50 + 46 * Math.cos(t), 50 + 46 * Math.sin(t)] as const;
});

export const BOT_BODY: Readonly<Record<BotShape, string>> = {
  circle: 'M6 50A44 44 0 1 1 94 50A44 44 0 1 1 6 50Z',
  // stored as `squircle` (older bots); drawn as a blob so it reads apart from `square`
  squircle: blob(50, 51, 40),
  square: 'M28 7H72A21 21 0 0 1 93 28V72A21 21 0 0 1 72 93H28A21 21 0 0 1 7 72V28A21 21 0 0 1 28 7Z',
  pill: 'M36 18H64A32 32 0 0 1 64 82H36A32 32 0 0 1 36 18Z',
  triangle: roundedPolygon([[50, 8], [94, 88], [6, 88]], 16),
  hex: roundedPolygon(hexagon, 12),
  cloud: 'M27 86A21 21 0 0 1 20 45A27 27 0 0 1 70 34A24 24 0 0 1 76 86Z',
  drop: 'M45.5 12Q50 6 54.5 12C67 28 84 45 84 62A34 34 0 0 1 16 62C16 45 33 28 45.5 12Z',
  // 2026-11-18: four more
  egg: 'M50 6C72 6 86 36 86 58A36 36 0 0 1 14 58C14 36 28 6 50 6Z',
  ghost: 'M12 48A38 38 0 0 1 88 48V84Q82 93 75.5 85Q69 77 62.5 85Q56 93 50 85Q44 77 37.5 85Q31 93 24.5 85Q18 77 12 84Z',
  flower: scallop(50, 50, 40, 8, 5),
  shield: roundedPolygon([[50, 6], [88, 17], [88, 50], [50, 95], [12, 50], [12, 17]], 14),
  octagon: roundedPolygon(octagon, 10),
  heart: 'M50 28A21 21 0 0 1 92 36C92 58 72 76 50 92C28 76 8 58 8 36A21 21 0 0 1 50 28Z',
  diamond: roundedPolygon([[50, 4], [96, 50], [50, 96], [4, 50]], 16),
  bell: 'M50 8C70 8 79 24 79 44V64Q79 73 89 79V86H11V79Q21 73 21 64V44C21 24 30 8 50 8Z',
  mushroom: 'M8 54A42 38 0 0 1 92 54Q92 62 84 62H67V84A9 9 0 0 1 58 93H42A9 9 0 0 1 33 84V62H16Q8 62 8 54Z',
  // a round face with two round ears, traced as one outline: left ear, the crown, right ear, then round the face
  bear: 'M15 39A14 14 0 1 1 37 22.5Q50 19 63 22.5A14 14 0 1 1 85 39A42 38 0 1 1 15 39Z',
};

/** Where the visor sits on each body (its centre) and how big it is there. */
const FACE: Readonly<Record<BotShape, { x?: number; y: number; s: number }>> = {
  circle: { y: 48, s: 1 },
  squircle: { y: 49, s: 1 },
  square: { y: 48, s: 1 },
  pill: { y: 50, s: 0.92 },
  triangle: { y: 66, s: 0.74 },
  hex: { y: 50, s: 0.98 },
  cloud: { y: 61, s: 0.92 },
  drop: { y: 63, s: 0.92 },
  egg: { y: 56, s: 0.9 },
  ghost: { y: 48, s: 0.94 },
  flower: { y: 50, s: 0.94 },
  shield: { y: 42, s: 0.88 },
  octagon: { y: 50, s: 0.98 },
  heart: { y: 48, s: 0.86 },
  diamond: { y: 50, s: 0.76 },
  bell: { y: 50, s: 0.84 },
  mushroom: { y: 44, s: 0.94 },
  bear: { y: 61, s: 0.94 },
};

function rgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `a` moved toward `b` by `t` (0..1), as #rrggbb. */
export function mixHex(a: string, b: string, t: number): string {
  const x = rgb(a) ?? [142, 142, 147];
  const y = rgb(b) ?? [142, 142, 147];
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

function hsl(hex: string): [number, number, number] {
  const [r, g, b] = (rgb(hex) ?? [142, 142, 147]).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function hslHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Voice mode's orb in a bot's own colour, drawn the way ChatGPT's orb is: an airy light tone over a vivid deep one
 * (ChatGPT's blue sky is #b8e1ff over #1f7cf2), the bot's hue at that saturation and lightness, so every bot's orb is
 * its own colour in the same style. A grey or muted bot keeps its quietness (saturation follows its own).
 */
export function orbTones(color: string): [string, string] {
  const [h, s] = hsl(color);
  const vivid = Math.min(1, s / 0.45);
  return [hslHex((h - 8 + 360) % 360, 1 * vivid, 0.86), hslHex(h, 0.89 * vivid, 0.53)];
}

function luminance(hex: string): number {
  const c = rgb(hex);
  if (!c) return 0.4;
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Bodies lighter than this get an outline (and a dark-edged pointer), or they vanish on light surfaces. */
const LIGHT = 0.7;

/**
 * The flat look: the body one colour, no highlight, the visor one dark tone. Every drawing reads `botAvatarLook`, so
 * this one switch flattens them all (both apps, the cursor, the site, Telegram's photo: bump `photoKey` when it
 * changes, so connected Telegram bots get the new picture).
 */
export const BOT_FLAT = true;
/** the flat visor's tone (the app icon's visor ink) */
const FLAT_VISOR = '#16171A';

export interface RoundRect { x: number; y: number; w: number; h: number; r: number }

export interface BotAvatarLook {
  body: string;
  /** where the body's bottom is (viewBox y): the ground it squashes onto */
  base: number;
  /** body gradient, top → middle → bottom */
  fill: readonly [string, string, string];
  /** a hairline round very light bodies so they don't vanish on light surfaces */
  outline?: string;
  /** the soft highlight on the upper left (clipped to the body) */
  gloss: { cx: number; cy: number; rx: number; ry: number; rotate: number; opacity: number };
  visor: RoundRect;
  /** visor glass gradient, top → bottom */
  glass: readonly [string, string];
  eyes: readonly [RoundRect, RoundRect];
  eye: string;
}

/**
 * What a bot wears: one of the built-in shapes, or a custom character (chat-core characters.ts: its own silhouette,
 * the same glossy body, visor, eyes and motion on it).
 */
export type BotFigure = BotShape | CharacterFigure;

/** The figure's body, its visor's place and size, its box and its ground; a character that won't read: the round bot. */
function figureGeometry(figure: BotFigure): { body: string; face: { x: number; y: number; s: number }; box: { x0: number; y0: number; x1: number; y1: number }; base: number } {
  if (figure && typeof figure === 'object') {
    const box = characterBox(figure.body);
    if (box) return { body: figure.body, face: { x: figure.face.x ?? 50, y: figure.face.y, s: figure.face.s }, box, base: box.y1 };
    figure = 'circle';
  }
  const shape = BOT_BODY[figure] ? figure : 'circle';
  const f = FACE[shape];
  return { body: BOT_BODY[shape], face: { x: f.x ?? 50, y: f.y, s: f.s }, box: { x0: 6, y0: 6, x1: 94, y1: 94 }, base: BOT_BASE[shape] ?? 94 };
}

export function botAvatarLook(figure: BotFigure, color: string): BotAvatarLook {
  const { body, face, box, base } = figureGeometry(figure);
  const s = face.s;
  const vw = 56 * s;
  const vh = 26 * s;
  const ew = 7.5 * s;
  const eh = 12 * s;
  const eye = (dx: number): RoundRect => ({ x: face.x + dx * s - ew / 2, y: face.y - eh / 2, w: ew, h: eh, r: ew / 2 });
  // the highlight on the upper left: where the round bot has it, or the same place on a character's own box
  const custom = typeof figure === 'object' && body !== BOT_BODY.circle;
  const gw = (box.x1 - box.x0) / 88;
  const gh = (box.y1 - box.y0) / 88;
  const gloss = custom
    ? { cx: box.x0 + 0.34 * (box.x1 - box.x0), cy: box.y0 + 0.2 * (box.y1 - box.y0), rx: 20 * Math.max(0.5, gw), ry: 10 * Math.max(0.5, gh), rotate: -18, opacity: 0.26 }
    : { cx: 36, cy: face.y - 26 * s, rx: 20 * s, ry: 10 * s, rotate: -18, opacity: 0.26 };
  if (BOT_FLAT) gloss.opacity = 0;
  return {
    body,
    base,
    fill: BOT_FLAT ? [color, color, color] : [mixHex(color, '#ffffff', 0.24), color, mixHex(color, '#000000', 0.2)],
    ...(luminance(color) > LIGHT ? { outline: 'rgba(0,0,0,0.14)' } : {}),
    gloss,
    visor: { x: face.x - vw / 2, y: face.y - vh / 2, w: vw, h: vh, r: vh / 2 },
    glass: BOT_FLAT ? [FLAT_VISOR, FLAT_VISOR] : ['#2B2D34', '#0D0E11'],
    eyes: [eye(-11), eye(11)],
    eye: mixHex(color, '#ffffff', 0.62),
  };
}

/**
 * The agent cursor's arrow (filled with the body gradient) and click ripple: a white edge and a ripple in the bot's
 * colour, but a very light bot gets a dark edge and a darker ripple, or the one exact mark of where it clicks
 * vanishes on a white window.
 */
export function botPointerInk(color: string): { edge: string; ripple: string } {
  return luminance(color) > LIGHT
    ? { edge: mixHex(color, '#000000', 0.62), ripple: mixHex(color, '#000000', 0.5) }
    : { edge: '#ffffff', ripple: color };
}

/**
 * Your own message's bubble: a darkened, softened shade of the bot's colour (a text-message chat with that bot), so
 * white text reads on it: first a fifth of the way to a dark grey, then darker still, step by step, until white reads
 * at least 3.4:1 (a yellow or very light bot ends up an olive or a deep tone of itself). `ink` (always white) is also
 * what links and code take.
 */
export function sentBubble(color: string): { fill: string; ink: string } {
  let fill = mixHex(rgb(color) ? color : '#8e8e93', '#262626', 0.2);
  for (let i = 0; i < 12 && 1.05 / (luminance(fill) + 0.05) < 3.4; i++) fill = mixHex(fill, '#000000', 0.08);
  return { fill, ink: '#ffffff' };
}

/**
 * The avatar at rest as a standalone SVG (`size`px square): the bot centred on a soft tint of its colour with room
 * all round, so a round crop (Telegram's profile photo) never cuts into it. No motion, no ids that could clash. A chief
 * wears its crown (botCrown.ts), seen from the front.
 */
export function botAvatarSvg(figure: BotFigure, color: string, size = 640, chief = false): string {
  const look = botAvatarLook(figure, color);
  const crown = chief ? botCrownSvg(figure) : null;
  const g = look.gloss;
  const rr = (r: RoundRect, fill: string) => `<rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" rx="${f(r.r)}" fill="${fill}"/>`;
  const bg: readonly [string, string] = [mixHex(color, '#ffffff', 0.86), mixHex(color, '#ffffff', 0.7)];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">`
    + '<defs>'
    + `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg[0]}"/><stop offset="1" stop-color="${bg[1]}"/></linearGradient>`
    + `<linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${look.fill[0]}"/><stop offset="0.55" stop-color="${look.fill[1]}"/><stop offset="1" stop-color="${look.fill[2]}"/></linearGradient>`
    + `<linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${look.glass[0]}"/><stop offset="1" stop-color="${look.glass[1]}"/></linearGradient>`
    + `<clipPath id="clip"><path d="${look.body}"/></clipPath>`
    + '</defs>'
    + '<rect width="100" height="100" fill="url(#bg)"/>'
    + '<g transform="translate(15 15) scale(0.7)">'
    + (crown?.back ?? '')
    + (look.outline ? `<path d="${look.body}" fill="none" stroke="${look.outline}" stroke-width="3"/>` : '')
    + `<path d="${look.body}" fill="url(#body)"/>`
    + (g.opacity <= 0 ? '' : `<g clip-path="url(#clip)"><ellipse cx="${f(g.cx)}" cy="${f(g.cy)}" rx="${f(g.rx)}" ry="${f(g.ry)}" transform="rotate(${g.rotate} ${f(g.cx)} ${f(g.cy)})" fill="#fff" opacity="${g.opacity}"/></g>`)
    + rr(look.visor, 'url(#glass)')
    + look.eyes.map((e) => rr(e, look.eye)).join('')
    + (crown?.front ?? '')
    + '</g></svg>';
}
