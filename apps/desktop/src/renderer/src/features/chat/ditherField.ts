// The empty chat's dithered field, its pure parts: value noise, the drifting looks it cycles through and how much ink a
// spot of it carries (Synara's, below), then how that ink becomes 1-bit dots (AppuBot's: an 8×8 ordered dither) and
// how a click's ripple rings out through them. DitherBackground.tsx draws it.
//
// The noise, the looks and the ink are ported from Synara's AsciiWaveBackground
// (apps/web/src/components/chat/AsciiWaveBackground.tsx, https://github.com/emanuele-web04/synara, MIT, (c) 2026 T3
// Tools Inc. and Emanuele Di Pietro), their numbers unchanged; there the ink was each letter's alpha, here it is how
// many of a spot's dots are on.

/** ink only shows inside drifting noise blotches; the rest of the field stays empty */
const PATCH_THRESHOLD_LOW = 0.4;
const PATCH_THRESHOLD_HIGH = 0.78;

export interface FieldPattern {
  /** blotch size (px) per axis; unequal values stretch blotches into streaks */
  scaleX: number;
  scaleY: number;
  /** blotch drift in noise cells per second */
  driftX: number;
  driftY: number;
  /** band direction and spacing; `radial` bands ring out from the centre instead */
  waveX: number;
  waveY: number;
  waveLength: number;
  waveSpeed: number;
  radial: boolean;
}

export const FIELD_PATTERNS: readonly FieldPattern[] = [
  // blotches: round patches drifting diagonally, crossed by diagonal bands
  { scaleX: 190, scaleY: 150, driftX: 0.1, driftY: -0.06, waveX: 0.8, waveY: 0.6, waveLength: 70, waveSpeed: 1.3, radial: false },
  // currents: long horizontal streaks flowing sideways
  { scaleX: 360, scaleY: 80, driftX: 0.16, driftY: 0.01, waveX: 0.25, waveY: 1, waveLength: 38, waveSpeed: 1.8, radial: false },
  // rings: patches with waves pulsing out from the centre
  { scaleX: 150, scaleY: 150, driftX: -0.06, driftY: 0.09, waveX: 0, waveY: 0, waveLength: 55, waveSpeed: 1.5, radial: true },
];

export function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function noisePlane(x0: number, y0: number, z: number, fx: number, fy: number): number {
  return lerp(lerp(hash3(x0, y0, z), hash3(x0 + 1, y0, z), fx), lerp(hash3(x0, y0 + 1, z), hash3(x0 + 1, y0 + 1, z), fx), fy);
}

/** Smooth 3D value noise in [0, 1); z is time, so blotches drift and reshape. */
export function valueNoise3(x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = smoothstep(0, 1, x - x0);
  const fy = smoothstep(0, 1, y - y0);
  return lerp(noisePlane(x0, y0, z0, fx, fy), noisePlane(x0, y0, z0 + 1, fx, fy), smoothstep(0, 1, z - z0));
}

/** Blotch coverage (`patch`) and band brightness (`wave`) of one look at a point, both 0..1; `t` in seconds. */
export function sampleField(p: FieldPattern, x: number, y: number, centerX: number, centerY: number, t: number): { patch: number; wave: number } {
  const noise =
    0.68 * valueNoise3(x / p.scaleX + t * p.driftX, y / p.scaleY + t * p.driftY, t * 0.18)
    + 0.32 * valueNoise3(x / 70 - t * 0.08, y / 52, t * 0.35 + 17);
  const band = p.radial ? Math.hypot(x - centerX, y - centerY) : x * p.waveX + y * p.waveY;
  const wave = 0.5 + 0.5 * Math.sin(band / p.waveLength - t * p.waveSpeed + noise * 5);
  const patch = smoothstep(PATCH_THRESHOLD_LOW, PATCH_THRESHOLD_HIGH, noise + 0.1 * (wave - 0.5));
  return { patch, wave };
}

/**
 * How much ink a spot at (x, y) carries in a field `width` × `height` px, 0..1: most where the wave crosses a blotch,
 * the middle dimmed to 45% so the greeting stays readable (Synara's `inkAlpha` over its maximum).
 */
export function inkLevel(patch: number, wave: number, x: number, y: number, width: number, height: number): number {
  const dx = (x - width / 2) / (width * 0.3);
  const dy = (y - height / 2) / (height * 0.3);
  const centerFade = Math.min(1, 0.45 + 0.55 * Math.sqrt(dx * dx + dy * dy));
  return patch * patch * (0.4 + 0.6 * wave) * centerFade;
}

/* ---------- the dither (AppuBot's) ---------- */

/** The 8×8 Bayer matrix, row by row: every value 0..63 once, each next one as far from the ones before as it can be. */
export const BAYER8: Uint8Array = (() => {
  let m = [[0]];
  for (let size = 1; size < 8; size *= 2) {
    const next: number[][] = Array.from({ length: size * 2 }, () => new Array<number>(size * 2).fill(0));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = 4 * m[y]![x]!;
        next[y]![x] = v;
        next[y]![x + size] = v + 2;
        next[y + size]![x] = v + 3;
        next[y + size]![x + size] = v + 1;
      }
    }
    m = next;
  }
  return Uint8Array.from(m.flat());
})();

/** The level a dot at grid cell (col, row) needs to come on, in (0, 1): the matrix tiled over the grid. */
export function bayerThreshold(col: number, row: number): number {
  return (BAYER8[((row & 7) << 3) | (col & 7)]! + 0.5) / 64;
}

/** Whether the dot at (col, row) is on for a level 0..1: a level of k/64 lights k of every 64 dots, evenly spread. */
export function ditherOn(level: number, col: number, row: number): boolean {
  return level > bayerThreshold(col, row);
}

/**
 * The share of dots a full-strength spot lights: the field is drawn up to a loose half-tone, never solid, so its
 * strongest blotches still read as shading, and as quiet as the letters were.
 */
export const DOT_DENSITY_MAX = 0.62;
/**
 * Ink below this lights nothing: the faintest edge of a blotch would otherwise be lone dots strewn across the empty
 * field, which reads as dust rather than shading.
 */
export const DOT_FLOOR = 0.05;

/** The share of a spot's dots that are on, 0..DOT_DENSITY_MAX, for its ink level. */
export function dotDensity(level: number): number {
  return DOT_DENSITY_MAX * Math.min(1, Math.max(0, (level - DOT_FLOOR) / (1 - DOT_FLOOR)));
}

/* ---------- ripples ---------- */

export const RIPPLE_SPEED_PX_PER_MS = 0.55;
export const RIPPLE_BAND_PX = 30;
export const RIPPLE_LIFETIME_MS = 2600;
/** ripple edges wobble by up to this many px so they read as water, not circles */
export const RIPPLE_WOBBLE_PX = 34;

export interface RippleShape { ageMs: number; phaseA: number; phaseB: number }

/**
 * How strongly a ripple shows at (dx, dy) from where it started, 0..1 (Synara's ring): a band `RIPPLE_BAND_PX` wide
 * travelling out at `RIPPLE_SPEED_PX_PER_MS`, its edge bent by lobes that loosen as it grows and by `warp` (the same
 * for every ripple at a spot), fading out over `RIPPLE_LIFETIME_MS`.
 */
export function rippleAt(r: RippleShape, dx: number, dy: number, warp: number, t: number): number {
  if (r.ageMs < 0 || r.ageMs >= RIPPLE_LIFETIME_MS) return 0;
  const distance = Math.hypot(dx, dy);
  const radius = r.ageMs * RIPPLE_SPEED_PX_PER_MS;
  if (Math.abs(distance - radius) > 2 * RIPPLE_BAND_PX + RIPPLE_WOBBLE_PX + 0.1 * radius) return 0;
  const angle = Math.atan2(dy, dx);
  const lobes = radius * (0.06 * Math.sin(3 * angle + r.phaseA + t) + 0.04 * Math.sin(5 * angle + r.phaseB - t * 1.3));
  const offset = (distance - radius - lobes - warp) / RIPPLE_BAND_PX;
  if (offset <= -2 || offset >= 2) return 0;
  const fade = 1 - r.ageMs / RIPPLE_LIFETIME_MS;
  return Math.exp(-offset * offset) * fade * fade;
}

/** a spot belongs to the ripple (drawn in its colour) from this strength up */
export const RIPPLE_SHOWS = 0.08;

/**
 * The share of accent dots on at a spot a ripple crosses: the spot's own dots plus a dense band that is strongest where
 * it crosses a blotch, so the ring stays patchy like the field (Synara's accent alpha, as dots).
 */
export function rippleDensity(ripple: number, level: number, patch: number): number {
  if (ripple < RIPPLE_SHOWS) return 0;
  return Math.min(1, dotDensity(level) + ripple * (0.4 + 0.55 * patch));
}
