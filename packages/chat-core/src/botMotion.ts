/**
 * How bot avatars move, for both apps: one state machine, the poses it eases between, and keyframe tracks in ms over
 * the avatar's 100×100 box. The desktop turns them into CSS (components/ui/botAvatarMotion.ts, also used by the agent
 * cursor's overlay); the phone samples them on the UI thread. Change the motion here, never in one app.
 *
 * Copied from a frame-by-frame measurement of Grok Bot's mascot (2026-11-27, 2085 frames): how it moves, drawn as our
 * own character. What it does:
 *   rest       still: head tilted 15° to the left, eyes looking up and to the right, leaning with it. No breathing, no
 *              blinks, no hops (Grok Bot's sat still for 41 seconds).
 *   look       the pointer near a resting avatar: the head straightens and the eyes follow the pointer (botGaze).
 *   listening  you sent something and the turn has started: upright, eyes centred and big.
 *   thinking   the face turns away and the avatar collapses into the middle of three dots, which then light up left
 *              to right (a typing indicator made of the bot). `working` (busy, step unknown) shows the same.
 *   tool       a tool is running: round eyes, wandering: a glance down-left, then shrinking and turning away, then back.
 *   typing     the reply is coming in: the resting pose with eyes half as big again (the dots stay if it was thinking).
 *   happy      the reply is done: the dots grow back into the bot with happy eyes (^ ^), a jelly squash at 630 ms, a
 *              three-hop dance at 2.9 s; the happy face stays for BOT_MOTION.happy ms, then it rests.
 *   needs-you  hops for attention and looks up at you (not in the recording: ours from before).
 * Every change of pose is the same first-order ease Grok Bot uses everywhere: the eyes' shape and the head's lean
 * settle with a 50 ms time constant, where the eyes look and how big the body is with 125 ms (BOT_MOTION.snap/settle).
 *
 * Layers, outside in (each a transform layer of its own, so tracks on different layers or properties compose):
 *   joy    the one-shot happy cheer (jelly, then the dance)                         translate, scale, rotate
 *   body   a mood's loop (the attention hop, the tool wander)                       translate, scale, rotate
 *   tilt   the pose's lean (eases); the attention wobble                             rotate
 *   morph  collapsing into the middle dot and growing back (eases)                  scale
 *   look   where both eyes look (eases); the tool wander's glances                  translate, scale
 *   eye    each eye's shape and lean (eases)                                         scale, rotate
 *   dot    each of the three dots, while thinking                                    translate, scale, opacity
 * Joy, body and tilt scale from the body's bottom (it squashes onto the ground), the others from their centre.
 * Squash and stretch keep the volume: `squash(k)` is (1/(1-k), 1-k).
 */
import type { BotShape, Part } from '@appubot/protocol';

/**
 * What an avatar is doing (above). `working` is busy with the step unknown (a presence badge alone): it shows as
 * `thinking`. `happy` is what `rest` shows for a while after work ends (botShown); asking for it shows it at once.
 */
export type BotMood = 'rest' | 'happy' | 'listening' | 'thinking' | 'tool' | 'typing' | 'working' | 'needs-you';

/** The moods of a turn at work. */
export const BOT_WORK_MOODS: readonly BotMood[] = ['listening', 'thinking', 'tool', 'typing', 'working'];

export type MotionEase = 'inOut' | 'in' | 'out' | 'linear';
export type BotLayer = 'joy' | 'body' | 'tilt' | 'look' | 'eye' | 'dot';
export type MotionValue = number | readonly [number, number];
/** [ms into the track, value, easing of the segment that starts here (default: the track's, else inOut)] */
export type MotionKey = readonly [number, MotionValue, MotionEase?];

/**
 * One property of one layer over `ms`. Values: `translate` [x, y] in viewBox units, `scale` [sx, sy], `rotate`
 * degrees, `opacity`.
 */
export interface BotTrack {
  layer: BotLayer;
  prop: 'translate' | 'scale' | 'rotate' | 'opacity';
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

/**
 * How far the eyes can look from the visor's middle, in viewBox units: Grok Bot's reach (18% of its body's width
 * sideways, 17.5% up, 12.6% down) mapped onto the room our eyes have inside the visor.
 */
export const BOT_GAZE = { x: 7, up: 4.5, down: 3.3 } as const;

/** A pose: what the avatar eases to in a mood. */
export interface BotPose {
  /** the head's lean, degrees (negative: to the left, counter-clockwise) */
  rotate: number;
  /** where the eyes look, viewBox units from the visor's middle */
  gaze: readonly [number, number];
  /** each eye's scale */
  eye: readonly [number, number];
  /** each eye's own lean, degrees, on top of the head's */
  eyeRotate: number;
  /** the eyes' shape: our pill, a round dot (tool), or the happy ^ (happy) */
  face: 'open' | 'round' | 'happy';
  /** the bot, or the three dots it collapses into */
  form: 'bot' | 'dots';
}

const pose = (p: Partial<BotPose>): BotPose => ({ rotate: 0, gaze: O, eye: ONE, eyeRotate: 0, face: 'open', form: 'bot', ...p });
/** Grok Bot at rest: rotated 15° to the left, eyes at the right edge and three quarters of the way up, leaning 12° more. */
const REST = pose({ rotate: -15, gaze: [7, -3.4], eyeRotate: -12 });

/** Every mood's pose (botAvatarMotion.ts turns them into the CSS each mood eases to). */
export const BOT_POSES: Readonly<Record<BotMood, BotPose>> = {
  rest: REST,
  // eyes 1.63× wide and 1.52× tall, upright, looking straight out
  listening: pose({ eye: [1.63, 1.52] }),
  // the face's last look before it collapses: turned to the right, eyes thinned
  thinking: pose({ gaze: [7, 0], eye: [0.45, 1], form: 'dots' }),
  working: pose({ gaze: [7, 0], eye: [0.45, 1], form: 'dots' }),
  // round eyes 0.79 of an eye's height across
  tool: pose({ eye: [1.27, 0.79], face: 'round' }),
  // the resting pose, eyes 1.53× (looking a little less far: bigger eyes would leave the visor)
  typing: { ...REST, gaze: [4.5, -1.5], eye: [1.53, 1.53] },
  happy: pose({ face: 'happy' }),
  'needs-you': pose({}),
};

/* thinking: the dots light up left to right, each for a third of DOTS ms */
const DOTS = 1380;
const LIT = DOTS / 3;
/* tool: the wander */
const TOOL = 4400;

/**
 * The three dots (thinking), in viewBox units: each `r` round, `gap` apart, on the visor's line; the middle one is
 * the body itself shrunk to `scale` (Grok Bot's 28px dots beside its 126px body). A dot not lit is `dim` opaque.
 */
export const BOT_DOTS = { r: 9.8, gap: 31.4, scale: 0.223, dim: 0.55, ms: DOTS } as const;

/**
 * The collapse into the dots and the growing back, ms from the change of mood (Grok Bot, frames 9235–9855 and
 * 14362–14800). Collapsing: the eyes turn and thin (the thinking pose), the body shrinks into the middle dot from
 * `collapse` ms (eased with BOT_MOTION.settle) and gives way to a plain dot over `fade` ms, the side dots grow in
 * (`sides`: from, for), the dots start lighting up at `lit`. Growing back: the side dots go (`sidesBack` ms), the
 * dot grows back into the body and gives way to it, face and all (`fadeBack`: from, for).
 */
export const BOT_MORPH = {
  collapse: 200,
  fade: 90,
  sides: [270, 70],
  lit: 620,
  sidesBack: 100,
  fadeBack: [70, 100],
} as const;

/** One dot's loop: dim, then lit for its last third (swelling to 1.21 and rising), dim again. */
const DOT: BotTrack[] = [
  { layer: 'dot', prop: 'opacity', ms: DOTS, ease: 'linear', keys: [[0, BOT_DOTS.dim], [DOTS - LIT, BOT_DOTS.dim], [DOTS - LIT + 20, 1], [DOTS - 20, 1], [DOTS, BOT_DOTS.dim]] },
  {
    layer: 'dot', prop: 'scale', ms: DOTS, keys: [
      [0, ONE], [DOTS - LIT, ONE], [DOTS - LIT + 20, [1.07, 1.07]], [DOTS - LIT + 190, [1.21, 1.21]], [DOTS - LIT + 320, [1.21, 1.21]], [DOTS - 20, [1.07, 1.07]], [DOTS, ONE],
    ],
  },
  { layer: 'dot', prop: 'translate', ms: DOTS, keys: [[0, O], [DOTS - LIT, O], [DOTS - LIT + 190, up(2.1)], [DOTS - LIT + 320, up(2.1)], [DOTS, O]] },
];
/** The dots' tracks, and how far into them each dot starts (left lit first, then the middle, then the right). */
export const BOT_DOT_LOOP = { tracks: DOT, offsets: [LIT * 2, LIT, 0] as const };

/** Every mood's loops. Two tracks never share a layer and property within one mood (CSS runs one animation per
 *  property). Moods without any hold their pose. They start at a per-avatar point (`motionSeed` × ms), except those in
 *  BOT_LOOPS_FROM_START, which start from their beginning when the mood does. */
export const BOT_LOOPS: Readonly<Partial<Record<BotMood, readonly BotTrack[]>>> = {
  // round-eyed, wandering (Grok Bot, 27.6–32.2 s): looks left, leans and looks down-left, back to the middle, then
  // shrinks to 0.67 turning 36° and looking up and away, holds, grows back leaning the other way and looking right
  tool: [
    { layer: 'body', prop: 'scale', ms: TOOL, keys: [[0, ONE], [2000, ONE], [2500, [0.67, 0.67], 'out'], [3100, [0.67, 0.67]], [3800, ONE, 'out'], [TOOL, ONE]] },
    { layer: 'body', prop: 'rotate', ms: TOOL, keys: [[0, 0], [300, 0], [700, -15, 'out'], [1100, -15], [1500, 0], [2000, 0], [2500, 36, 'out'], [3100, 36], [3800, -21, 'out'], [TOOL, 0]] },
    {
      layer: 'look', prop: 'translate', ms: TOOL, keys: [
        [0, [-5.5, 0]], [300, [-5.5, 0]], [700, [-4, 3.3], 'out'], [1100, [-4, 3.3]], [1500, O], [2000, O], [2500, [-6.5, -3.4], 'out'],
        [3100, [-6.5, -3.4]], [3800, [3, -1.7], 'out'], [4100, [3, -1.7]], [TOOL, [-5.5, 0]],
      ],
    },
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

/** Moods whose loop starts from its beginning (the tool wander starts centred, as Grok Bot's did). */
export const BOT_LOOPS_FROM_START: readonly BotMood[] = ['tool'];

/* the happy cheer: the jelly at JELLY, the dance at DANCE (Grok Bot: 630 ms and 2870 ms after its reply was done) */
const JELLY = 630;
const DANCE = 2870;
const CHEER = 4800;
/** a Grok Bot pixel in our viewBox (its body is 126px wide, ours 88) */
const PX = 88 / 126;
const j = (ms: number) => JELLY + ms;
const d = (ms: number) => DANCE + ms;

/**
 * The happy cheer, once, when work ends (or `cheerKey` changes): growing back from the dots it waits, wobbles like
 * jelly (squashed 1.10×0.88, stretched 0.92×1.10, a small squash, settled in 820 ms), smiles a while, then dances:
 * three hops, leaning left (−15°), then right (+25°), then a small one back upright.
 */
export const BOT_CHEER: readonly BotTrack[] = [
  {
    layer: 'joy', prop: 'scale', ms: CHEER, keys: [
      [0, ONE], [j(0), ONE], [j(180), [1.1, 0.88]], [j(220), [1.1, 0.88]], [j(400), [0.92, 1.1]], [j(450), [0.92, 1.1]], [j(570), ONE],
      [j(650), [1.03, 0.97]], [j(710), [1.03, 0.97]], [j(820), ONE],
      [d(0), ONE], [d(60), [1.095, 0.95], 'out'], [d(160), [0.98, 1.09]], [d(330), [0.98, 1.03]], [d(620), ONE, 'out'], [d(660), [1.07, 0.95], 'out'],
      [d(760), [1.03, 1]], [d(850), [1, 1.07]], [d(1100), ONE, 'out'], [d(1150), [1.04, 0.97]], [d(1250), ONE], [CHEER, ONE],
    ],
  },
  {
    layer: 'joy', prop: 'translate', ms: CHEER, keys: [
      [0, O], [d(100), O, 'out'], [d(330), up(r3(15 * PX)), 'in'], [d(620), O], [d(680), O, 'out'], [d(850), up(r3(15 * PX)), 'in'], [d(1100), O],
      [d(1150), O, 'out'], [d(1400), up(r3(9 * PX)), 'in'], [d(1610), O], [CHEER, O],
    ],
  },
  {
    layer: 'joy', prop: 'rotate', ms: CHEER, keys: [
      [0, 0], [d(0), 0], [d(100), -1.3], [d(330), -12, 'out'], [d(620), -14.5], [d(680), -10.5], [d(760), -3.6], [d(850), 13], [d(1000), 24, 'out'],
      [d(1100), 25], [d(1150), 25], [d(1360), 18], [d(1500), 6], [d(1570), 3], [d(1750), 1], [d(1900), 0], [CHEER, 0],
    ],
  },
];

/** Timings outside the tracks. */
export const BOT_MOTION = {
  /**
   * The ease every pose change uses: `x(t) = 1 − e^(−t/τ)`. `snap` is τ for the eyes' shape and the head's lean,
   * `settle` for where the eyes look and the body's size (Grok Bot: 40–90 ms and 120–130 ms, fitted over 13 changes).
   */
  snap: 50,
  settle: 125,
  /** the cheer's length */
  cheer: CHEER,
  /** how long the happy face stays after work ends before it rests (Grok Bot: at least 5.2 s; the rest not seen) */
  happy: 10000,
  /** how near the pointer makes a resting avatar look at it, from its middle, in avatar sizes */
  lookRadius: 1.05,
  /** the head's lean when looking at the pointer, degrees per unit of looking sideways */
  lookLean: -7.3,
  /** one blink (the agent cursor's own blinks) */
  blink: 160,
  /** how much the agent cursor's eyes swell when it takes a look */
  eyeSwell: 1.14,
  /** the agent cursor's sweep of light over the visor */
  sweep: 1800,
  /** the agent cursor's click squash */
  boing: 680,
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

/**
 * A live turn's mood from what it holds so far: `listening` before anything, `typing` once its reply comes in after
 * its last call, `thinking` over a thought, `tool` over a call (running or just done).
 */
export function botWorkMood(parts: readonly Part[] | undefined): BotMood {
  for (let i = (parts?.length ?? 0) - 1; i >= 0; i--) {
    const p = parts![i]!;
    if (p.type === 'text') {
      // a message the bot sent on its own (`said`) is a bubble along the way, not its reply
      if (p.said || !p.text.trim()) continue;
      return 'typing';
    }
    if (p.type === 'thought') return 'thinking';
    if (p.type === 'tool_call') return 'tool';
  }
  return 'listening';
}

/** Whether a change of mood earns the cheer and the happy face: work done, back to rest. */
export function cheersAt(from: BotMood | undefined, to: BotMood): boolean {
  return !!from && BOT_WORK_MOODS.includes(from) && to === 'rest';
}

/**
 * The mood an avatar shows next, from the one it shows (`shown`) and the one it is asked for: work ending in rest
 * shows `happy` (rest again after BOT_MOTION.happy ms: the app's timer), `typing` straight after the dots keeps the
 * dots (Grok Bot's run on through "Typing…"), `working` shows as `thinking`.
 */
export function botShown(shown: BotMood | undefined, asked: BotMood): BotMood {
  if (asked === 'working') return 'thinking';
  if (asked === 'typing' && (shown === 'thinking' || shown === 'working')) return 'thinking';
  if (cheersAt(shown, asked)) return 'happy';
  if (asked === 'rest' && shown === 'happy') return 'happy';
  return asked;
}

/**
 * How a change of shown mood plays (BOT_MORPH): `collapse` into the dots, `grow` back out of them, or `ease` from
 * one pose to the next.
 */
export function botHandoff(from: BotMood, to: BotMood): 'collapse' | 'grow' | 'ease' {
  const a = BOT_POSES[from].form;
  const b = BOT_POSES[to].form;
  return a === b ? 'ease' : b === 'dots' ? 'collapse' : 'grow';
}

/**
 * Where a resting avatar looks with the pointer `dx`, `dy` px from its middle (`size` px across): null beyond
 * BOT_MOTION.lookRadius sizes, else the eyes' place (viewBox units: BOT_GAZE's reach, all of it from a third of a size
 * out) and the head's lean (it straightens, leaning a little toward the pointer).
 */
export function botGaze(dx: number, dy: number, size: number): { x: number; y: number; rotate: number } | null {
  const dist = Math.hypot(dx, dy);
  if (!(size > 0) || dist > BOT_MOTION.lookRadius * size) return null;
  const k = 1 / Math.max(dist, size / 3);
  const ux = dx * k;
  const uy = dy * k;
  return { x: r3(ux * BOT_GAZE.x), y: r3(uy * (uy < 0 ? BOT_GAZE.up : BOT_GAZE.down)), rotate: r3(ux * BOT_MOTION.lookLean) || 0 };
}

/** 0..1 from any string, so each avatar starts its loops at its own point and a row of bots never moves together. */
export function motionSeed(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

/** The CSS curve for the pose ease over 4τ (where it is 98% of the way): within 0.008 of it everywhere. */
export const BOT_EASE_CSS = 'cubic-bezier(.125,.5,.3,1)';

/** The pose ease's progress `t` ms into a change with time constant `tau`: 0..1, reaching 1 at 4τ like the CSS. */
export function poseEase(t: number, tau: number): number {
  if (t <= 0) return 0;
  if (t >= 4 * tau) return 1;
  return (1 - Math.exp(-t / tau)) / (1 - Math.exp(-4));
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
 * worklet copy of this; this one is for tests and anything off the UI thread.
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
