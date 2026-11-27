/**
 * How bot avatars move, for both apps: keyframe tracks in ms over the avatar's 100×100 box. The desktop turns them into
 * CSS keyframes (components/ui/botAvatarMotion.ts, also used by the agent cursor's overlay), the phone samples them
 * on the UI thread (src/ui/BotAvatar.tsx). Change the motion here, never in one app.
 *
 * Layers, outside in (each a transform layer of its own, so tracks on different layers or properties compose):
 *   joy   the one-shot cheer (a happy double hop when a reply is done)       translate, scale, rotate
 *   body  the mood's vertical motion: hops and bobs, squashing and stretching translate, scale
 *   tilt  sway, lean and wobble; the resting breath                          rotate, scale
 *   look  both eyes: glance, scan, think (looking up), squeeze/swell, glow    translate, scale, opacity
 *   eye   each eye: blink, the cheer's happy squint                          blink (scaleY), scale, translate
 * Body, joy and tilt scale from the body's bottom (it squashes onto the ground), look and eye from their centre.
 * Squash and stretch keep the volume: `squash(k)` is (1/(1-k), 1-k).
 */
import type { BotShape } from '@appubot/protocol';

/**
 * What an avatar is doing: `rest` breathes (stretching up a little), tilts its head now and then, blinks (sometimes
 * twice), glances about and every so often hops (crouch, stretch, land with a squash and a jiggle, eyes squeezing and
 * widening with it); `working` bobs fast with a squash at each landing, scans the visor with its eyes and leans with
 * them, now and then stops to think (eyes up, head tilted), pulses its eyes' glow and sweeps light over the glass, and
 * every 2.5s gives a 300ms beat (squash to 0.92 tall, stretch to 1.08 with a small lift and a roll, eyes squeezing and
 * widening with it: Grok Bot's mascot at work, 2026-11-27);
 * `needs-you` hops for attention (anticipation, stretch, a squashy landing, a small second bounce), wobbles and swells
 * its eyes, looking up at you.
 */
export type BotMood = 'rest' | 'working' | 'needs-you';

export type MotionEase = 'inOut' | 'in' | 'out' | 'linear';
export type BotLayer = 'joy' | 'body' | 'tilt' | 'look' | 'eye';
export type MotionValue = number | readonly [number, number];
/** [ms into the track, value, easing of the segment that starts here (default: the track's, else inOut)] */
export type MotionKey = readonly [number, MotionValue, MotionEase?];

/**
 * One property of one layer over `ms`. Values: `translate` [x, y] in viewBox units, `scale` [sx, sy], `rotate`
 * degrees, `opacity`, `blink` an eye's scaleY. Looping tracks start at a per-avatar point (`motionSeed` × ms).
 */
export interface BotTrack {
  layer: BotLayer;
  prop: 'translate' | 'scale' | 'rotate' | 'opacity' | 'blink';
  ms: number;
  ease?: MotionEase;
  keys: readonly MotionKey[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** Volume-preserving squash (k > 0: wider and shorter) or stretch (k < 0), as [sx, sy]. */
export function squash(k: number): readonly [number, number] {
  return [r3(1 / (1 - k)), r3(1 - k)];
}
const sq = squash;
const ONE = [1, 1] as const;
const O = [0, 0] as const;
const up = (y: number) => [0, -y] as const;

/* rest: a hop every HOP ms, near the end of the cycle */
const HOP = 13000;
const H = 11000;
/* working: four scans, then a think */
const WORK = 6400;
const R = 5.5;
/* working: a 300ms beat near the end of every BEAT ms */
const BEAT = 2500;
const B = BEAT - 400;

/** Every mood's loops. Two tracks never share a layer and property within one mood (CSS runs one animation per
 *  property). */
export const BOT_LOOPS: Readonly<Record<BotMood, readonly BotTrack[]>> = {
  rest: [
    // breathing: stretches up a little on the in-breath, settles a touch wide
    { layer: 'tilt', prop: 'scale', ms: 3600, keys: [[0, sq(0.012)], [1800, sq(-0.024)], [3600, sq(0.012)]] },
    // a curious head tilt, held, then back with a little overshoot
    { layer: 'tilt', prop: 'rotate', ms: 11000, keys: [[0, 0], [6200, 0], [6700, 6], [8300, 6], [8800, -2.5], [9300, 1], [9700, 0], [11000, 0]] },
    // the hop: crouch, launch stretched, apex, land squashed, jiggle, settle
    { layer: 'body', prop: 'translate', ms: HOP, keys: [[0, O], [H + 240, O, 'out'], [H + 500, up(8), 'in'], [H + 760, O], [HOP, O]] },
    {
      layer: 'body', prop: 'scale', ms: HOP, keys: [
        [0, ONE], [H, ONE], [H + 240, sq(0.14), 'out'], [H + 330, sq(-0.12)], [H + 500, sq(-0.02), 'in'], [H + 760, sq(0.16), 'out'],
        [H + 880, sq(-0.07)], [H + 1000, sq(0.03)], [H + 1110, sq(-0.01)], [H + 1220, ONE], [HOP, ONE],
      ],
    },
    // the eyes squeeze with the crouch and the landing and go wide at the top
    { layer: 'look', prop: 'scale', ms: HOP, keys: [[0, ONE], [H, ONE], [H + 240, [1.06, 0.7]], [H + 500, [1, 1.14]], [H + 760, [1.06, 0.7]], [H + 950, ONE], [HOP, ONE]] },
    // glances: quick looks right, then up-left, each held a moment
    {
      layer: 'look', prop: 'translate', ms: 9700, keys: [
        [0, O], [3500, O, 'out'], [3680, [3, 0]], [5100, [3, 0], 'out'], [5280, [-2.5, -1.8]], [6700, [-2.5, -1.8], 'out'], [6880, O], [9700, O],
      ],
    },
  ],
  working: [
    // the beat: squashed to 0.92 tall, popping up stretched to 1.08 and rolling, landing with a little squash, still
    // between beats
    { layer: 'body', prop: 'translate', ms: BEAT, keys: [[0, O], [B + 80, O, 'out'], [B + 170, up(3), 'in'], [B + 250, O], [BEAT, O]] },
    {
      layer: 'body', prop: 'scale', ms: BEAT, keys: [
        [0, ONE], [B, ONE], [B + 80, sq(0.08), 'out'], [B + 170, sq(-0.08), 'in'], [B + 250, sq(0.05), 'out'], [B + 300, ONE], [BEAT, ONE],
      ],
    },
    { layer: 'body', prop: 'rotate', ms: BEAT, keys: [[0, 0], [B + 80, 0], [B + 170, -8], [B + 250, 5], [B + 300, 0], [BEAT, 0]] },
    // the eyes squeeze with the crouch and go wide at the top of the beat
    { layer: 'look', prop: 'scale', ms: BEAT, keys: [[0, ONE], [B, ONE], [B + 80, [1.06, 0.75]], [B + 170, [1, 1.12]], [B + 300, ONE], [BEAT, ONE]] },
    // eyes scan the visor four times, then look up to think (up-right, then up-left), then back to scanning
    {
      layer: 'look', prop: 'translate', ms: WORK, keys: [
        [0, [-R, 0]], [750, [R, 0]], [1500, [-R, 0]], [2250, [R, 0]], [3000, [-R, 0]], [3350, [2.5, -3.2]], [4300, [2.5, -3.2], 'out'],
        [4450, [-1.5, -3.6]], [5400, [-1.5, -3.6]], [5900, [-R, 0]], [WORK, [-R, 0]],
      ],
    },
    // the body leans with the scan and tilts its head while it thinks
    {
      layer: 'tilt', prop: 'rotate', ms: WORK, keys: [
        [0, -3], [750, 3], [1500, -3], [2250, 3], [3000, -3], [3350, 5], [4300, 5], [4450, 3.5], [5400, 3.5], [5900, -3], [WORK, -3],
      ],
    },
    { layer: 'look', prop: 'opacity', ms: 900, keys: [[0, 1], [450, 0.68], [900, 1]] },
  ],
  'needs-you': [
    // hop for attention: crouch, stretch up, squashy landing, a small second bounce, a pause
    { layer: 'body', prop: 'translate', ms: 1500, keys: [[0, O], [170, O, 'out'], [430, up(7), 'in'], [690, O], [800, O, 'out'], [900, up(2), 'in'], [1000, O], [1500, O]] },
    {
      layer: 'body', prop: 'scale', ms: 1500, keys: [
        [0, ONE], [170, sq(0.15), 'out'], [260, sq(-0.12)], [430, sq(-0.02), 'in'], [690, sq(0.16), 'out'], [790, sq(-0.05)], [900, ONE, 'in'],
        [1000, sq(0.07), 'out'], [1100, sq(-0.02)], [1200, ONE], [1500, ONE],
      ],
    },
    { layer: 'tilt', prop: 'rotate', ms: 1500, keys: [[0, 0], [690, 0], [770, 7], [870, -5], [970, 3], [1070, -1.2], [1170, 0], [1500, 0]] },
    // looking up at you, eyes swelling at the top of each hop
    { layer: 'look', prop: 'translate', ms: 1500, keys: [[0, up(2.5)], [1500, up(2.5)]] },
    { layer: 'look', prop: 'scale', ms: 1500, keys: [[0, ONE], [170, [1.06, 0.78]], [430, [1.15, 1.15]], [690, [1.04, 0.8]], [900, [1.1, 1.1]], [1200, ONE], [1500, ONE]] },
  ],
};

/** Blinks, in every mood: irregular, one of them double, so they read as natural. */
export const BOT_BLINK: BotTrack = {
  layer: 'eye', prop: 'blink', ms: 12700, keys: [
    [0, 1], [3100, 1], [3170, 0.1], [3260, 1], [7400, 1], [7470, 0.1], [7560, 1], [7660, 1], [7730, 0.1], [7820, 1],
    [11000, 1], [11070, 0.1], [11160, 1], [12700, 1],
  ],
};

const CHEER = 1250;
/** The happy bounce, once, when the avatar's mood goes from `working` back to `rest` (a reply is done): a crouch, a
 *  big hop with a wiggle in the air, a smaller one, squashy landings, eyes squinting with joy throughout. */
export const BOT_CHEER: readonly BotTrack[] = [
  { layer: 'joy', prop: 'translate', ms: CHEER, keys: [[0, O], [150, O, 'out'], [410, up(11), 'in'], [660, O], [720, O, 'out'], [880, up(4), 'in'], [1040, O], [CHEER, O]] },
  {
    layer: 'joy', prop: 'scale', ms: CHEER, keys: [
      [0, ONE], [150, sq(0.16), 'out'], [240, sq(-0.14)], [410, sq(-0.02), 'in'], [660, sq(0.18), 'out'], [720, sq(0.1), 'out'], [800, sq(-0.08)],
      [880, ONE, 'in'], [1040, sq(0.08), 'out'], [1130, sq(-0.03)], [CHEER, ONE],
    ],
  },
  { layer: 'joy', prop: 'rotate', ms: CHEER, keys: [[0, 0], [240, 0], [410, -7], [560, 6], [700, 0], [880, 3], [1040, 0], [CHEER, 0]] },
  // happy eyes: squinting, pushed up as if by a grin
  { layer: 'eye', prop: 'scale', ms: CHEER, keys: [[0, ONE], [150, [1, 0.38]], [1000, [1, 0.38]], [CHEER, ONE]] },
  { layer: 'eye', prop: 'translate', ms: CHEER, keys: [[0, O], [150, up(1.4)], [1000, up(1.4)], [CHEER, O]] },
];

/** Timings outside the tracks. */
export const BOT_MOTION = {
  /** one blink (the agent cursor's own blinks) */
  blink: 160,
  /** how much the agent cursor's eyes swell when it takes a look */
  eyeSwell: 1.14,
  /** working: one sweep of light over the visor */
  sweep: 1800,
  /** hover (desktop) and the live view's click: one jelly squash and stretch */
  boing: 680,
  /** the cheer's length */
  cheer: CHEER,
} as const;

/** Where each body's bottom is (viewBox y): the ground it squashes onto. */
export const BOT_BASE: Readonly<Record<BotShape, number>> = {
  circle: 94, squircle: 86, square: 93, pill: 82, triangle: 88, hex: 92, cloud: 86, drop: 96,
  egg: 94, ghost: 90, flower: 95, shield: 91, octagon: 93, heart: 90, diamond: 92, bell: 86, mushroom: 93, bear: 96,
};

/** The mood a presence badge implies (no badge: resting). */
export function botMood(presence: 'working' | 'needs-you' | null | undefined): BotMood {
  return presence ?? 'rest';
}

/** Whether a change of mood earns the cheer: work done, back to rest. */
export function cheersAt(from: BotMood | undefined, to: BotMood): boolean {
  return from === 'working' && to === 'rest';
}

/** 0..1 from any string, so each avatar starts its loops at its own point and a row of bots never blinks together. */
export function motionSeed(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

/** The eased progress of a segment, matching the CSS curves the desktop uses (botAvatarMotion.ts). */
export function motionEase(e: MotionEase, p: number): number {
  if (e === 'in') return p * p * p;
  if (e === 'out') return 1 - (1 - p) ** 3;
  if (e === 'linear') return p;
  return 0.5 - 0.5 * Math.cos(Math.PI * p);
}

/**
 * A track's value at `t` ms (component `c` of a pair). Loops wrap; one-shots hold their ends. The phone runs a
 * worklet copy of this (src/ui/BotAvatar.tsx); this one is for tests and anything off the UI thread.
 */
export function sampleTrack(tr: BotTrack, t: number, loop: boolean, c: 0 | 1 = 0): number {
  const x = loop ? ((t % tr.ms) + tr.ms) % tr.ms : Math.max(0, Math.min(t, tr.ms));
  const k = tr.keys;
  let i = 0;
  while (i < k.length - 2 && k[i + 1]![0] <= x) i++;
  const a = k[i]!;
  const b = k[i + 1] ?? a;
  const va = typeof a[1] === 'number' ? a[1] : a[1][c];
  const vb = typeof b[1] === 'number' ? b[1] : b[1][c];
  const span = b[0] - a[0];
  const p = span > 0 ? motionEase(a[2] ?? tr.ease ?? 'inOut', Math.max(0, Math.min(1, (x - a[0]) / span))) : 1;
  return va + (vb - va) * p;
}
