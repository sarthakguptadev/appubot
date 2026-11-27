/**
 * How bot avatars move, for both apps: one state machine, the poses it eases between, and keyframe tracks in ms over
 * the avatar's 100×100 box. The desktop turns them into CSS (components/ui/botAvatarMotion.ts, also used by the agent
 * cursor's overlay); the phone samples them on the UI thread. Change the motion here, never in one app.
 *
 * Measured frame by frame from a reference recording of a mascot (2026-11-27, 2085 frames): how it moves, drawn as our
 * own character. It is drawn flat but moves like a solid (botHead): its head turns (yaw), nods (pitch) and rolls, and as
 * it turns the face slides across the body, the eyes narrow and crowd toward the turning edge, the near eye bigger than
 * the far one, and the outline narrows; turned past a quarter the face goes round the back, so it can spin right round.
 * What it does:
 *   rest       still, upright and facing you. No breathing, no blinks, no hops.
 *              The reference's own rest is turned 39° to the right and looking up; ours faces you, centred in its place.
 *   look       the pointer near a resting avatar: the head turns toward it (35° at the side, nodding up or down 16°),
 *              the eyes follow it and the body leans a little (botGaze).
 *   listening  you sent something and the turn has started: facing you, eyes centred and big.
 *   thinking   the face turns away (69° in 70 ms) and the avatar collapses into the middle of three dots, which then
 *              light up left to right (a typing indicator made of the bot). `working` (busy, step unknown) shows the
 *              same. In small places (`compact`: a sidebar row, the chat header, a pinned tile) it never collapses: it
 *              stays itself, its eyes just as they are at rest, and ponders, turning its head to look up to one side,
 *              then the other (BOT_COMPACT_LOOPS).
 *   tool       a tool is running: the reference's working routine, 30.5 s measured frame by frame from a busy bot's sidebar
 *              row (its chat's working row moved in step with it): turns its head to glance about, the near eye bigger;
 *              blinks with its head tilted; crouches and flips head over heels; looks about round-eyed;
 *              shrinks rolling away and grows back leaning the other way; spins round; tilts and holds; wobbles from
 *              one side to the other. Then it starts again (BOT_LOOPS.tool).
 *   typing     the reply is coming in: turned 39° toward the text, looking up, eyes half as big again (the dots stay
 *              if it was thinking).
 *   happy      the reply is done: the dots grow back into the bot with happy eyes (^ ^), a jelly squash at 630 ms, a
 *              three-hop dance at 2.9 s; the happy face stays for BOT_MOTION.happy ms, then it rests.
 *   needs-you  hops for attention and looks up at you (not in the recording: ours from before).
 * Every change of pose is the same first-order ease the reference uses everywhere: the eyes' shape and the head's lean
 * settle with a 50 ms time constant, where the eyes look, the face's turn and how big the body is with 125 ms
 * (BOT_MOTION.snap/settle).
 *
 * Layers, outside in (each a transform layer of its own, so tracks on different layers or properties compose):
 *   joy    the one-shot happy cheer (jelly, then the dance)                         translate, scale, rotate
 *   body   a mood's loop (the attention hop, the tool wander)                       translate, scale, rotate
 *   tilt   the pose's lean (eases); the attention wobble                             rotate
 *   morph  collapsing into the middle dot and growing back (eases)                  scale
 *   head   the outline narrowing as the head turns (botHead)                        scale
 *   face   where the face is on the turned head (visor and eyes; botHead), clipped  translate, scale
 *          to the body
 *   deepL/deepR  each eye on the turned head: crowding toward the turning edge and   translate, scale
 *          its own width, the near one wider (botHead)
 *   look   where both eyes look within the visor (eases)                            translate, scale
 *   eye    each eye's shape (eases); eyeL/eyeR the same eye in the tool routine      scale
 *          (the left and right eye as you look at it, each its own size: the near one bigger)
 *   dot    each of the three dots, while thinking (beside the body, or in the visor) translate, scale, opacity
 * Joy, body, tilt and head turn and scale round the avatar's middle, so it stays centred in its place whatever it does; the
 * others round their own centre.
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
export type BotLayer = 'joy' | 'body' | 'tilt' | 'head' | 'turn' | 'face' | 'deepL' | 'deepR' | 'look' | 'eye' | 'eyeL' | 'eyeR' | 'dot';
export type MotionValue = number | readonly [number, number];
/** [ms into the track, value, easing of the segment that starts here (default: the track's, else inOut)] */
export type MotionKey = readonly [number, MotionValue, MotionEase?];

/**
 * One property of one layer over `ms`. Values: `translate` [x, y] in viewBox units, `scale` [sx, sy], `rotate`
 * degrees, `opacity`; `yaw` and `pitch` the head's turn and nod in degrees (botHead's), for drawing it as a real
 * solid that turns.
 */
export interface BotTrack {
  layer: BotLayer;
  prop: 'translate' | 'scale' | 'rotate' | 'opacity' | 'yaw' | 'pitch';
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
 * How far the eyes can look from the visor's middle, in viewBox units: the reference's reach (18% of its body's width
 * sideways, 17.5% up, 12.6% down) mapped onto the room our eyes have inside the visor.
 */
export const BOT_GAZE = { x: 7, up: 4.5, down: 3.3 } as const;

/**
 * How far the face slides at a quarter turn, viewBox units: the reference's face moved 0.17 of its body's width sideways
 * at a 35° turn (and its eyes drew together to cos 35°), 15 of our units.
 */
export const BOT_TURN = 26;

/** The face turned `deg` (positive: to the right as you look at it): where it slides and how much it narrows. */
export function botTurn(deg: number): { x: number; sx: number } {
  const a = (deg * Math.PI) / 180;
  return { x: r3(Math.sin(a) * BOT_TURN) || 0, sx: r3(Math.cos(a)) };
}

/**
 * The head as a solid, for drawing a flat avatar that turns like the reference's: the face sits on the front of a ball
 * BOT_TURN units round (so a quarter turn slides it BOT_TURN), each eye `eye` degrees round from the face's middle,
 * seen through a lens `lens` units in front (the near side a little bigger), on a body `depth` as deep as it is wide.
 */
export const BOT_HEAD = { eye: 25, depth: 0.75, lens: 180 } as const;

/** What a head turned `yaw` and nodded `pitch` degrees looks like, flat (botHead). */
export interface BotHeadView {
  /** the outline's width and height: narrower turned sideways (the body is less deep than wide) */
  body: readonly [number, number];
  /**
   * the face (visor and eyes) on the narrowed body: where its middle moves and how it narrows (to nothing once it goes
   * round the back), in the body's own units, so the outline's narrowing isn't counted twice
   */
  face: { x: number; y: number; sx: number; sy: number };
  /**
   * each eye (left, right as you look) within the face: how far it moves from where the face's narrowing puts it
   * (toward the turning edge) and how much wider it is than the face's scale makes it (the near one wider); `w` its
   * width on screen, 1 facing you
   */
  eyes: readonly [{ x: number; s: number; w: number }, { x: number; s: number; w: number }];
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The head turned `yaw` degrees (positive: to the right as you look at it) and nodded `pitch` (positive: up), its
 * outline narrowed by `bodyPitch` (the pitch unless a measured squash already draws it).
 */
export function botHead(yaw: number, pitch = 0, bodyPitch = pitch): BotHeadView {
  const { eye, depth, lens } = BOT_HEAD;
  const r = BOT_TURN;
  const cp = Math.cos(rad(pitch));
  const at = (a: number) => {
    const z = r * cp * Math.cos(rad(yaw + a));
    const k = lens / (lens + r - z);
    return { x: r * cp * Math.sin(rad(yaw + a)) * k, k, w: Math.max(0, Math.cos(rad(yaw + a))) * k };
  };
  const c = at(0);
  const bx = Math.hypot(Math.cos(rad(yaw)), depth * Math.sin(rad(yaw)));
  const by = Math.hypot(Math.cos(rad(bodyPitch)), depth * Math.sin(rad(bodyPitch)));
  const sx = c.w;
  const div = Math.max(sx, 0.05);
  // facing you an eye is already a little round the ball: its place and width there are where it starts from
  const front = (a: number) => {
    const z = r * Math.cos(rad(a));
    const k = lens / (lens + r - z);
    return { x: r * Math.sin(rad(a)) * k, w: Math.cos(rad(a)) * k };
  };
  const eyes = [-eye, eye].map((a) => {
    const e = at(a);
    const f = front(a);
    return { x: r3(clamp((e.x - c.x) / div - f.x, -BOT_TURN, BOT_TURN)) || 0, s: r3(Math.min(3, e.w / f.w / div)), w: r3((e.w / f.w) * Math.max(0, cp)) };
  });
  return {
    body: [r3(bx), r3(by)],
    face: { x: r3(c.x / bx) || 0, y: r3((-r * Math.sin(rad(pitch)) * c.k) / by) || 0, sx: r3(sx / bx), sy: r3((Math.max(0, cp) * c.k) / by) },
    eyes: eyes as unknown as BotHeadView['eyes'],
  };
}

/** A pose: what the avatar eases to in a mood. */
export interface BotPose {
  /** the head's lean, degrees (negative: to the left, counter-clockwise) */
  rotate: number;
  /** the head's turn, degrees (positive: to the right as you look at it; botHead) */
  turn: number;
  /** the head's nod, degrees (positive: up; botHead) */
  pitch: number;
  /** where the eyes look, viewBox units from the visor's middle */
  gaze: readonly [number, number];
  /** each eye's scale */
  eye: readonly [number, number];
  /** the eyes' shape: our pill, a round dot (tool), or the happy ^ (happy) */
  face: 'open' | 'round' | 'happy';
  /** the bot, or the three dots it collapses into */
  form: 'bot' | 'dots';
}

const pose = (p: Partial<BotPose>): BotPose => ({ rotate: 0, turn: 0, pitch: 0, gaze: O, eye: ONE, face: 'open', form: 'bot', ...p });

/** Every mood's pose (botAvatarMotion.ts turns them into the CSS each mood eases to). */
export const BOT_POSES: Readonly<Record<BotMood, BotPose>> = {
  // upright, facing you, eyes in the middle
  rest: pose({}),
  // eyes 1.63× wide and 1.52× tall, upright, looking straight out
  listening: pose({ eye: [1.63, 1.52] }),
  // the face's last look before it collapses: turned away to the right (its eyes 0.36 as far apart: 69°)
  thinking: pose({ turn: 69, form: 'dots' }),
  working: pose({ turn: 69, form: 'dots' }),
  // facing you, eyes as at rest: the routine (BOT_LOOPS.tool) shapes them itself
  tool: pose({}),
  // turned 39° to the right (toward the text), looking up, eyes 1.53× (up only a little: bigger eyes would leave the visor)
  typing: pose({ turn: 39, gaze: [0, -1.5], eye: [1.53, 1.53] }),
  happy: pose({ face: 'happy' }),
  'needs-you': pose({}),
};

/* thinking: the dots light up left to right, each for a third of DOTS ms */
const DOTS = 1380;
const LIT = DOTS / 3;
/* tool: the working routine */
const TOOL = 30500;

/**
 * The three dots (thinking), in viewBox units: each `r` round, `gap` apart, on the visor's line; the middle one is
 * the body itself shrunk to `scale`. A dot not lit is `dim` opaque.
 */
export const BOT_DOTS = { r: 9.8, gap: 31.4, scale: 0.223, dim: 0.55, ms: DOTS } as const;

/**
 * The collapse into the dots and the growing back, ms from the change of mood (the reference, frames 9235–9855 and
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

/** The most the head turns between two keys of its tracks: between keys the drawing moves in a straight line. */
const HEAD_STEP = 6;

/** Where the head points `ms` into a loop (botHead's yaw, pitch and the pitch its outline narrows by). */
type HeadAt = (ms: number) => { yaw: number; pitch: number; bodyPitch?: number };

const same = (a: MotionValue, b: MotionValue) => (typeof a === 'number' ? a === b : typeof b !== 'number' && a[0] === b[0] && a[1] === b[1]);
/** Keys without those inside a run of one value (they draw nothing new). */
const trim = (keys: MotionKey[]): MotionKey[] =>
  keys.filter((k, i) => i === 0 || i === keys.length - 1 || !(same(keys[i - 1]![1], k[1]) && same(k[1], keys[i + 1]![1])));

/**
 * A head turning over `ms` (`at`, read at `times`) as the tracks that draw it: flat (botHead), the outline's
 * narrowing, the face's place and size, each eye's; as a solid (`turn`), its yaw and pitch, from `solid` where a
 * solid head moves otherwise than the flat drawing shows (a flip is a nod right round). Between two times it may turn up to HEAD_STEP degrees per key; an `eased` `at`
 * (not straight between its times) gets a key every 60 ms while it moves.
 */
function headTracks(ms: number, times: readonly number[], at: HeadAt, eased = false, solid: HeadAt = at): BotTrack[] {
  const ts = [...new Set([0, ms, ...times.filter((t) => t > 0 && t < ms)])].sort((a, b) => a - b);
  const dense: number[] = [];
  ts.forEach((t0, i) => {
    dense.push(t0);
    const t1 = ts[i + 1];
    if (t1 === undefined) return;
    const turned = (h: HeadAt) => {
      const a = h(t0);
      const b = h(t1);
      return Math.max(Math.abs(b.yaw - a.yaw), Math.abs(b.pitch - a.pitch));
    };
    const turn = Math.max(turned(at), turned(solid));
    const n = Math.ceil(Math.max(1, turn / HEAD_STEP, eased && turn > 0 ? (t1 - t0) / 60 : 1));
    for (let k = 1; k < n; k++) dense.push(Math.round(t0 + ((t1 - t0) * k) / n));
  });
  const keyed = [...new Set(dense)];
  const views = keyed.map((t) => {
    const p = at(t);
    return [t, botHead(p.yaw, p.pitch, p.bodyPitch ?? p.pitch)] as const;
  });
  const angle = (prop: 'yaw' | 'pitch'): BotTrack => (
    { layer: 'turn', prop, ms, ease: 'linear', keys: trim(keyed.map((t): MotionKey => [t, solid(t)[prop]])) }
  );
  const track = (layer: BotLayer, prop: 'translate' | 'scale', value: (h: BotHeadView) => MotionValue): BotTrack => (
    { layer, prop, ms, ease: 'linear', keys: trim(views.map(([t, h]): MotionKey => [t, value(h)])) }
  );
  return [
    track('head', 'scale', (h) => h.body),
    track('face', 'translate', (h) => [h.face.x, h.face.y]),
    track('face', 'scale', (h) => [h.face.sx, h.face.sy]),
    track('deepL', 'translate', (h) => [h.eyes[0].x, 0]),
    track('deepL', 'scale', (h) => [h.eyes[0].s, 1]),
    track('deepR', 'translate', (h) => [h.eyes[1].x, 0]),
    track('deepR', 'scale', (h) => [h.eyes[1].s, 1]),
    angle('yaw'),
    angle('pitch'),
  ];
}

/**
 * The reference's working routine as it moved, frame by frame (a busy bot's sidebar row, 1751 frames over 30.5 s), kept
 * wherever the motion strays from a straight line by more than 1.5°, 0.025 of its size, 0.75 of a viewBox unit of its
 * place, 0.7 of where its eyes look or 0.1 of an eye's size. Runs of [ms, value…]: `rotate` its roll (degrees), `move`
 * where its middle is and `look` where its eyes look (viewBox units, BOT_GAZE's reach), `size` its scale (negative:
 * upside down, flipping), `eyeL`/`eyeR` each eye's scale, `turn` its face's turn (degrees, botTurn).
 */
const WORK = {
  rotate: [
    0, 0, 1767, 0.1, 2183, 2.4, 4883, -0.5, 5017, 1.1, 5150, 6.6, 5450, 9.6, 6017, 6.4, 6317, -2.5, 6767, -5.5,
    7133, -3.4, 7200, -0.3, 7367, 0.8, 9300, -0.4, 9383, 1.7, 9600, 1.6, 9617, -1.6, 9833, -6.2, 9967, -12.6,
    10183, -15.4, 10800, -1.7, 11267, -2.4, 11600, -8.3, 11950, -8.7, 12033, -6.1, 12183, 11.9, 12250, 13.8,
    12550, 10.6, 13150, -1.1, 13533, -11.9, 13900, -13.8, 14133, -10.1, 14450, -1.3, 15467, 1.2, 15633, 6.1,
    15683, 12.7, 15767, 28.6, 15783, 29.3, 15983, 35.3, 16417, 36.4, 16700, 31.5, 16850, 19.7, 16883, 14.1, 16933, 0.6,
    17000, -7.9, 17067, -10.6, 17117, -15.4, 17367, -20.8, 18533, -23, 18683, -20.5, 18817, -9.1, 18950, -2.7,
    19317, -0.1, 19833, -0.8, 19933, -13, 20083, -15.6, 21017, -15.7, 21150, -13.6, 21200, -8.1, 21317, -0.5,
    21533, 2.9, 21867, -5.2, 21933, -9.2, 22083, -24.2, 22433, -26.5, 22483, -25.5, 22617, -12.5, 22750, -4.4,
    23033, -4.7, 23317, 0.6, 23517, 0.7, 23817, -15.7, 24033, -17.2, 24183, -15.5, 24250, -5.6, 24317, 18.9,
    24383, 31.1, 24483, 37.7, 24700, 37.7, 24817, 35.9, 25200, 16.4, 25533, -10.7, 25900, -45, 26000, -47.5,
    26017, -45.4, 26050, -22.5, 26083, -8, 26167, 17.4, 26267, 34.9, 26350, 37, 26433, 35.9, 26617, 28.1, 26817, 16.7,
    26950, 5.4, 27000, 3.2, 27500, -43.2, 27600, -48.1, 27700, -47, 27717, -38.8, 27733, -3.7, 27750, 3.1, 27833, 24.4,
    27900, 35.9, 27917, 36.7, 28067, 35.7, 28267, 27.9, 28450, 17.4, 28800, -9.9, 28850, -16.6, 28900, -19.2,
    29150, -42.8, 29250, -47.8, 29300, -45.6, 29333, -18.5, 29350, -9.1, 29383, 4.1, 29433, 21, 29500, 35.7,
    29517, 37.3, 29583, 34.9, 29617, 29.2, 29700, 8.6, 29767, 1.8, 30500, 0
  ],
  move: [
    0, 0, 0, 800, -0.21, -0.34, 2167, 1.57, 0.54, 2300, 0.68, 0.6, 2367, -2.06, 0.62, 2450, -8.31, 0.43,
    2550, -10.95, 0.14, 2900, -12.7, 0.09, 3217, -10.65, -0.03, 3300, -8.64, -0.06, 3433, -2.42, -0.24,
    3600, -0.12, -0.24, 4900, 0.22, -0.23, 5050, -1.71, -0.46, 5200, -6.86, -1.46, 5367, -8.45, -1.69,
    5733, -8.98, -1.82, 6017, -8.91, -1.77, 6233, 0.1, -1.89, 6483, 3.1, -1.97, 6950, 3.82, -2.21, 7350, -1.37, -4.37,
    7450, -1.35, -3.66, 7517, -1.25, -0.91, 7633, -1.15, 9.33, 7833, -1.02, 10.77, 8117, -1.12, 8.53,
    8183, -0.99, 4.26, 8233, -0.24, -3.44, 8267, -0.17, -3.44, 8283, -0.17, -1.11, 8367, -0.16, 0.9,
    9600, -0.59, -0.51, 9950, 2.27, -0.65, 10183, 2.71, -0.93, 10350, 2.19, -0.58, 10667, -1.07, -0.15,
    11183, -1.39, -0.35, 11333, -0.56, -0.48, 11500, 2.94, -1.51, 11650, 7.18, -4, 11833, 8.62, -4.78,
    11950, 7.94, -4.55, 12000, 5.98, -3.68, 12067, 1.09, -1.17, 12183, -0.88, -0.52, 13717, 0.63, -0.29,
    13733, 0.63, 4.02, 13767, 2.65, 4.02, 13800, 2.65, 1.76, 13867, 2.65, 0.44, 14033, 1.36, -0.6, 14267, 2.6, -2.37,
    14333, 0.49, -0.83, 14450, -0.04, -0.68, 15317, 0.26, -0.23, 15633, -1.49, -0.64, 15783, -5.35, -2.26,
    16067, -5.96, -2.85, 16817, -4.2, -2.23, 16883, -2.33, -1.56, 16950, 1.2, -1.19, 17133, 4.15, -1.14,
    18017, 7.24, -0.66, 18617, 6.56, -0.56, 18817, 3.35, -1.26, 18850, 2.6, -3.75, 18883, 2.06, -3.75,
    18967, 1.45, -1.15, 19067, 0.59, -0.53, 19800, -0.06, -0.26, 20017, 2.58, -1.03, 20850, 2.7, -1.18,
    21100, -0.41, -0.73, 21283, -7.11, -0.34, 21517, -8.34, -0.64, 21883, -8.03, -1.08, 22067, -6.27, -2.7,
    22350, -5.87, -4.17, 22617, -5.97, -3.55, 22750, -2.19, -1.6, 22917, -0.58, -1.13, 23500, -1.27, -0.38,
    23700, 1.2, -0.36, 24083, 2.67, -1.03, 24200, 2.28, -0.97, 24300, -4.17, -0.59, 24383, -6.18, -1.29,
    24833, -6.39, -1.32, 25283, -2.9, -0.67, 25950, 5.36, -2.04, 26017, 5.06, -1.89, 26067, 0.87, -0.79,
    26150, -3.24, -0.86, 26317, -6.61, -1.35, 26717, -4.7, -0.95, 27133, 0.03, -0.61, 27583, 5.36, -2.04,
    27700, 5.3, -2.12, 27717, 4.24, -1.41, 27733, -0.72, -0.64, 27783, -3.17, -0.82, 27883, -6.06, -1.32,
    27950, -6.53, -1.39, 28433, -3.96, -0.95, 28783, -0.03, -0.66, 29233, 5.36, -2.05, 29300, 5.07, -1.91,
    29350, 0.16, -0.7, 29400, -2.88, -0.76, 29517, -6.5, -1.34, 29600, -6.02, -1.26, 29700, -1.97, -0.29,
    29833, -0.2, -0.27, 30500, 0, 0
  ],
  size: [
    0, 1, 1, 83, 1, 1, 1867, 1.02, 1.02, 8050, 1.01, 1.01, 8100, 1, 0.98, 8133, 1, 0.91, 8167, 1, 0.79, 8183, 1, 0.65,
    8200, 1, 0.47, 8217, 1, -0.5, 8233, 1, -0.91, 8250, 1, -0.91, 8267, 1, -0.51, 8283, 1, 0.52, 8300, 1, 0.68,
    8333, 1, 0.85, 8350, 1, 0.91, 8417, 1, 1, 13433, 1.01, 1.01, 13717, 1.01, 1.01, 13733, 0.95, 0.95,
    13767, 0.94, 0.94, 14050, 1, 1, 14250, 0.98, 0.98, 14350, 1.01, 1.01, 15333, 1, 1, 15633, 0.97, 0.97,
    15750, 0.82, 0.82, 15883, 0.76, 0.76, 16483, 0.71, 0.71, 16750, 0.74, 0.74, 17017, 0.88, 0.88, 17667, 0.94, 0.94,
    17850, 1.03, 1.03, 18600, 1.04, 1.04, 18683, 1.02, 1.02, 18717, 0.95, 0.95, 18783, 0.99, 0.99, 18817, 0.95, 1,
    18850, 0.55, 1, 18867, 0.48, 1, 18900, 0.71, 1, 18950, 0.89, 1, 19067, 1, 1, 30500, 1, 1
  ],
  look: [
    0, 0, 0, 317, 0.1, -0.31, 1350, -0.16, -0.19, 1667, 1.84, -0.5, 2183, 2.47, -0.67, 2333, 1.68, -0.73,
    2517, -1.94, -0.84, 2900, -2.72, -0.91, 3217, -2.35, -0.77, 3550, 0.25, -0.29, 4983, 0.14, -0.3, 5200, -1.9, -1,
    5517, -2.43, -1.25, 6017, -1.98, -1.95, 6200, 0.7, -1.62, 6583, 2.13, -1.62, 6883, 2.31, -1.53, 7467, 0.24, -2.43,
    7633, 0.27, -1.97, 7750, 0.15, 0.61, 7867, 0.13, 0.79, 8033, 0.2, -0.76, 8183, 0.25, -6, 8233, -0.02, 1.96,
    8250, 0.07, -4.98, 8300, -0.05, 4.71, 8400, 0.07, 1.83, 8633, 0.11, -0.23, 9267, 0.1, -0.21, 9417, -2.42, 0.14,
    9550, -3.1, -0.47, 10200, -1.82, 1.56, 10700, -2.06, -1.91, 11150, -2.04, -2.3, 11717, 2.71, -2.59,
    11933, 2.55, -2.27, 12150, -2.9, 0.24, 12233, -3.55, 0.69, 13717, 3.39, 0.61, 13733, 3.69, -0.57,
    14033, 2.41, 0.56, 14250, -1.54, 0.92, 14517, -2.8, 0.13, 14683, -2.62, 0.58, 14767, -0.95, 0.03,
    14933, 0.01, -0.23, 15433, 0.05, -0.24, 15633, -0.42, -0.1, 15850, -2.64, 0.04, 16233, -2.94, 0.19,
    16767, -2.16, -0.04, 17083, 1.95, -0.49, 17933, 2.92, -0.42, 18383, 4.82, 0.03, 18583, 2.15, -0.11,
    18667, -1.48, -0.1, 18717, -5.51, 0.32, 18767, 5.14, 0.16, 18783, 1.64, -0.24, 19650, -0.01, -0.24,
    19817, 0.05, -0.24, 19950, 3.37, -1.35, 20083, 4.29, -1.79, 21017, 4.03, -1.63, 21150, 2.28, -1.28,
    21283, -2.11, -0.68, 21483, -3.23, -0.38, 21817, -2.56, -0.8, 22233, 0.54, -2.92, 22983, 0.36, -2.61,
    23300, -1.51, -2.17, 23517, -1.55, -2.02, 23767, 1.55, -1.22, 24000, 2.24, -1.09, 24117, 4.43, -1.85,
    24217, 3.82, -1.31, 24333, -0.2, 1.07, 24483, -1.41, 1.72, 25050, -0.96, 1.74, 26000, 2.23, 2.32,
    26133, -0.18, 1.74, 26300, -1.36, 1.72, 27567, 2.23, 2.32, 27700, 2.22, 2.32, 27767, -0.08, 1.7,
    27917, -1.38, 1.76, 29217, 2.22, 2.3, 29300, 2.23, 2.28, 29517, -1.37, 1.71, 29800, 0.13, -0.23, 30500, 0, 0
  ],
  eyeL: [
    0, 1, 1, 250, 1, 1.04, 1517, 0.99, 0.99, 1667, 0.58, 0.66, 1800, 0.64, 0.65, 2067, 0.45, 0.61, 2133, 0.45, 0.61,
    2317, 0.89, 0.44, 2450, 1.13, 0.57, 2983, 1.22, 0.61, 3167, 1.13, 0.61, 3317, 0.66, 0.66, 3417, 0.57, 0.66,
    3867, 0.59, 0.67, 3917, 0.67, 0.67, 4033, 1, 1.01, 5050, 0.92, 1.02, 5400, 0.88, 0.89, 5433, 0.88, 0.81,
    5483, 0.93, 0.26, 5533, 0.95, 0.18, 5650, 0.89, 0.94, 5833, 1.07, 0.91, 6217, 0.97, 0.99, 9167, 1, 1.01,
    9183, 0.83, 0.96, 9267, 0.75, 0.75, 9383, 1.29, 0.52, 10200, 1.14, 0.45, 10800, 1.31, 0.52, 11867, 1.25, 0.43,
    12100, 1.33, 0.54, 12217, 0.97, 0.48, 12283, 0.97, 0.48, 12450, 1.16, 0.48, 13117, 1.4, 0.57, 13617, 1.06, 0.48,
    14033, 1.08, 0.48, 14233, 1.36, 0.53, 14667, 1.13, 0.6, 14850, 1.24, 0.66, 14883, 1.08, 0.5, 15567, 0.96, 0.53,
    15667, 0.83, 0.6, 15717, 0.55, 0.61, 15783, 0.73, 0.79, 16617, 0.76, 0.83, 16750, 0.74, 0.8, 16767, 0.76, 0.5,
    16800, 0.82, 0.42, 16967, 0.91, 0.46, 17117, 0.69, 0.35, 17350, 0.77, 0.31, 17367, 0.65, 0.33, 17550, 0.64, 0.32,
    17667, 0.73, 0.77, 17800, 0.79, 0.9, 18283, 0.55, 0.95, 18617, 0.78, 0.89, 18717, 0.45, 0.99, 18767, 0.56, 0.97,
    18783, 0.73, 0.88, 19983, 0.59, 0.53, 21667, 0.58, 0.66, 22067, 0.36, 0.56, 22183, 0.45, 0.5, 22417, 0.41, 0.57,
    22483, 0.54, 0.68, 22517, 0.79, 0.7, 22733, 0.96, 0.84, 23117, 0.89, 0.89, 23333, 1.07, 0.95, 23933, 0.77, 0.88,
    24183, 0.94, 0.84, 24350, 0.78, 0.92, 24367, 0.78, 1.25, 24400, 0.78, 1.26, 24983, 0.77, 1.24, 25000, 0.77, 0.87,
    25100, 0.77, 0.83, 25233, 0.77, 0.85, 25367, 0.98, 0.9, 25700, 0.67, 0.86, 25717, 0.67, 0.89, 25733, 0.78, 1.2,
    25767, 0.79, 1.22, 26033, 0.78, 1.2, 26050, 0.78, 0.91, 26150, 0.87, 0.84, 26217, 0.79, 0.85, 26233, 0.88, 1.09,
    26417, 0.89, 1.1, 26617, 0.87, 1.08, 26633, 0.69, 0.87, 26683, 0.69, 0.85, 27067, 0.98, 0.89, 27283, 0.67, 0.85,
    27333, 0.68, 0.89, 27350, 0.78, 1.2, 27417, 0.79, 1.21, 27717, 0.79, 1.19, 27733, 0.89, 0.93, 27783, 0.89, 0.84,
    27850, 0.81, 0.85, 27867, 0.91, 1.08, 27883, 0.91, 1.08, 28250, 0.89, 1.06, 28267, 0.79, 0.88, 28300, 0.7, 0.84,
    28500, 0.76, 0.86, 28633, 0.98, 0.9, 28950, 0.69, 0.85, 28983, 0.89, 1.04, 29300, 0.89, 1.04, 29417, 0.79, 0.85,
    29450, 0.79, 0.85, 29467, 0.86, 1.08, 29483, 0.88, 1.09, 29617, 0.89, 1.1, 29633, 0.89, 0.9, 30500, 1, 1
  ],
  eyeR: [
    0, 1, 1, 283, 0.99, 1.04, 1467, 0.99, 1, 1533, 0.9, 0.99, 1650, 0.66, 0.66, 2083, 0.44, 0.65, 2150, 0.44, 0.65,
    2300, 1.04, 0.61, 2633, 0.73, 0.41, 3183, 0.8, 0.41, 3383, 0.57, 0.65, 3917, 0.58, 0.67, 3950, 0.82, 0.83,
    4017, 0.91, 1, 4150, 1, 1, 4967, 0.99, 1, 5400, 0.81, 0.93, 5433, 0.86, 0.81, 5467, 0.81, 0.4, 5500, 0.78, 0.19,
    5533, 0.78, 0.19, 5633, 0.88, 0.89, 6183, 0.97, 0.98, 7500, 0.98, 0.91, 8933, 0.99, 1.04, 9167, 0.92, 1,
    9267, 0.75, 0.75, 9383, 1.28, 0.56, 10183, 1.19, 0.36, 10800, 1.29, 0.56, 11633, 1.23, 0.42, 12083, 1.34, 0.54,
    12183, 1.06, 0.49, 12350, 1.06, 0.47, 13067, 1.38, 0.57, 13567, 1.15, 0.47, 13683, 0.97, 0.48, 13917, 0.96, 0.54,
    14167, 1.28, 0.5, 14400, 1.28, 0.56, 14650, 1.2, 0.56, 14767, 0.82, 0.45, 14867, 0.83, 0.41, 14883, 0.99, 0.49,
    15483, 0.99, 0.49, 15650, 0.83, 0.56, 15700, 0.52, 0.57, 15767, 0.68, 0.61, 16717, 0.62, 0.56, 16867, 0.73, 0.37,
    16983, 0.99, 0.52, 17550, 0.91, 0.46, 17617, 0.86, 0.6, 17633, 0.8, 0.77, 17750, 0.74, 0.9, 18000, 0.75, 0.89,
    18300, 0.54, 0.95, 18633, 0.76, 0.89, 18683, 0.71, 0.91, 18717, 0.44, 0.99, 18783, 0.73, 0.88, 19933, 0.48, 0.59,
    19983, 0.58, 0.53, 21617, 0.55, 0.66, 21967, 0.36, 0.63, 22400, 0.45, 0.5, 22567, 0.78, 0.81, 22717, 0.94, 0.84,
    23117, 0.89, 0.89, 23317, 1.06, 0.95, 23933, 0.74, 0.92, 24117, 0.97, 0.79, 24350, 0.8, 0.93, 24383, 0.87, 1.12,
    24983, 0.86, 1.1, 25000, 0.74, 0.86, 25033, 0.7, 0.85, 25433, 0.96, 0.91, 25683, 0.65, 0.86, 25717, 0.67, 0.89,
    25733, 0.77, 1.2, 25767, 0.78, 1.21, 26033, 0.77, 1.2, 26050, 0.78, 0.86, 26117, 0.91, 0.87, 26183, 0.71, 0.84,
    26217, 0.71, 0.85, 26233, 0.89, 1.05, 26350, 0.9, 1.07, 26617, 0.9, 1.06, 26633, 0.77, 0.84, 26717, 0.7, 0.84,
    27000, 0.93, 0.89, 27300, 0.66, 0.85, 27333, 0.68, 0.88, 27350, 0.77, 1.19, 27383, 0.78, 1.2, 27717, 0.78, 1.19,
    27733, 0.88, 0.93, 27783, 0.9, 0.84, 27817, 0.71, 0.84, 27850, 0.71, 0.85, 27867, 0.89, 1.07, 27883, 0.9, 1.07,
    28250, 0.89, 1.06, 28267, 0.77, 0.85, 28333, 0.67, 0.85, 28650, 0.95, 0.91, 28950, 0.75, 0.85, 28967, 0.77, 0.87,
    28983, 0.82, 1.13, 29050, 0.83, 1.14, 29300, 0.82, 1.13, 29333, 0.83, 0.89, 29417, 0.8, 0.85, 29450, 0.8, 0.85,
    29467, 0.87, 1.09, 29483, 0.87, 1.09, 29617, 0.87, 1.1, 29633, 0.88, 0.92, 30500, 1, 1
  ],
  turn: [
    0, 0, 18800, 0, 18817, -43, 18833, -66, 18850, -80, 18867, -90, 18868, 90, 18883, 76, 18900, 66, 18917, 58,
    18933, 54, 18967, 45, 19017, 35, 19067, 28, 19117, 20, 19183, 16, 19300, 8, 19450, 3, 19600, 0, 30500, 0
  ],
} as const;

/** Runs of [ms, value] (`n` 1) or [ms, x, y] (`n` 2) as keys. */
function runKeys(run: readonly number[], n: 1 | 2): MotionKey[] {
  const keys: MotionKey[] = [];
  for (let i = 0; i < run.length; i += n + 1) keys.push([run[i]!, n === 1 ? run[i + 1]! : [run[i + 1]!, run[i + 2]!]]);
  return keys;
}
const work = (layer: BotLayer, prop: BotTrack['prop'], run: readonly number[], n: 1 | 2): BotTrack => ({ layer, prop, ms: TOOL, ease: 'linear', keys: runKeys(run, n) });

/*
 * The routine on a solid head. The reference's glances are its head turning: where its eyes went (WORK.look, BOT_GAZE's reach)
 * is now where the head points, up to WORK_TURN degrees round and WORK_NOD up or down at the eyes' full reach, and the
 * eyes keep a part of it within the visor (WORK_GAZE). The spin (WORK.turn) goes right round, 360°, its back half
 * unseen as the reference's was. While it spins and flips, the head follows those alone (their eyes' frames are mid-turn).
 * The measured eye widths had the turn's narrowing in them; the head now draws that, so each eye keeps its own shape.
 */
const WORK_TURN = 45;
const WORK_NOD = 18;
const WORK_GAZE = [2 / 7, 0.5] as const;
const SPIN = [18700, 19650] as const;
const FLIP = [8100, 8450] as const;
const inside = (t: number, [a, b]: readonly [number, number]) => t > a && t < b;
const lookKeys = runKeys(WORK.look, 2).filter(([t]) => !inside(t, SPIN) && !inside(t, FLIP));
const lookAt: BotTrack = { layer: 'look', prop: 'translate', ms: TOOL, ease: 'linear', keys: lookKeys };
/* the spin unwound: turned away to the left to −90°, round the back, back from the right to −360° */
const spinAt: BotTrack = { layer: 'face', prop: 'rotate', ms: TOOL, ease: 'linear', keys: runKeys(WORK.turn, 1).map(([t, v]): MotionKey => [t, t > 18867 ? (v as number) - 360 : v]) };
const workHead: HeadAt = (t) => {
  const x = sampleTrack(lookAt, t, false, 0);
  const y = sampleTrack(lookAt, t, false, 1);
  return {
    yaw: r3(clamp(x / BOT_GAZE.x, -1, 1) * WORK_TURN + sampleTrack(spinAt, t, false)),
    pitch: r3(-clamp(y / (y < 0 ? BOT_GAZE.up : BOT_GAZE.down), -1, 1) * WORK_NOD),
  };
};
/** An eye's measured run without the narrowing the turned head now draws (botHead's `w`), kept within 0.55–1.45 wide. */
function ownEye(run: readonly number[], i: 0 | 1): number[] {
  return runKeys(run, 2).flatMap(([t, v]) => {
    const [sx, sy] = v as readonly [number, number];
    const h = workHead(t);
    return [t, r3(clamp(sx / Math.max(0.35, botHead(h.yaw, h.pitch).eyes[i].w), 0.55, 1.45)), sy];
  });
}
const sizeAt = work('body', 'scale', WORK.size, 2);
/*
 * Drawn flat, the flip is the body's height going through nothing to upside down and back, and the spin its width
 * narrowing (WORK.size). A solid does both as turns, its outline staying its own shape: the flip is the head nodding
 * forward right round (the height's fall and return read as the turn's cosine, −360° once over), and the body's
 * scale keeps only the squash that isn't a turn.
 */
const flipAt = (t: number): number => {
  if (t <= FLIP[0]) return 0;
  if (t >= FLIP[1]) return -360;
  const y = clamp(sampleTrack(sizeAt, t, false, 1), -1, 1);
  const a = (Math.acos(y) * 180) / Math.PI;
  return -(t < 8242 ? a : 360 - a);
};
const solidHead: HeadAt = (t) => {
  const h = workHead(t);
  return { ...h, pitch: r3(h.pitch + flipAt(t)) };
};
const solidSize: BotTrack = {
  ...sizeAt,
  keys: sizeAt.keys.map(([t, v]): MotionKey => {
    const [x, y] = v as readonly [number, number];
    return [t, inside(t, SPIN) ? [y, y] : inside(t, FLIP) ? [x, x] : [x, y]];
  }),
};
const WORK_TIMES = [...lookKeys.map(([t]) => t), ...spinAt.keys.map(([t]) => t), ...sizeAt.keys.map(([t]) => t).filter((t) => inside(t, FLIP))];

/** Every mood's loops. Two tracks never share a layer and property within one mood (CSS runs one animation per
 *  property). Moods without any hold their pose. They start at a per-avatar point (`motionSeed` × ms), except those in
 *  BOT_LOOPS_FROM_START, which start from their beginning when the mood does. */
export const BOT_LOOPS: Readonly<Partial<Record<BotMood, readonly BotTrack[]>>> = {
  // The reference's working routine (WORK), ms from its start: still for 1.6 s; glances about (1.6–4 s: its head turns right,
  // then left, the near eye bigger than the far one, the body sliding 13 units after it);
  // tilts 10° and blinks (5–6.3 s, the blink 5.45–5.6 s); crouches 11 units and flips head over heels (7.5–8.42 s,
  // upside down at 8.22–8.27 s); looks about round-eyed, turning its head and rolling up to 15° either way (9.3–15.6 s); shrinks to 0.71
  // rolling 36° to the right (15.6–16.8 s) and grows back leaning 21–23° to the left (16.9–18.7 s); spins right round
  // (18.8–18.87 s turning away to the left, round the back, back from the right by 19.6 s); tilts 16° left and holds (19.9–21.2 s), then
  // 26° (21.9–22.6 s); wobbles (24.2–29.8 s): swings 37° to the right, then three times sweeps to 45–48° on the left in
  // 1.3 s and snaps back in 0.2–0.35 s
  tool: [
    work('body', 'rotate', WORK.rotate, 1),
    work('body', 'translate', WORK.move, 2),
    sizeAt,
    { ...lookAt, keys: lookKeys.map(([t, v]): MotionKey => [t, [r3((v as readonly number[])[0]! * WORK_GAZE[0]), r3((v as readonly number[])[1]! * WORK_GAZE[1])]]) },
    work('eyeL', 'scale', ownEye(WORK.eyeL, 0), 2),
    work('eyeR', 'scale', ownEye(WORK.eyeR, 1), 2),
    ...headTracks(TOOL, WORK_TIMES, workHead, false, solidHead),
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

/* thinking in a small place: PONDER ms round, from facing you to looking up to the left, then up to the right */
const PONDER = 4000;
const PONDER_KEYS: readonly (readonly [number, number, number])[] = [[0, 0, 0], [700, -30, 12], [1700, -30, 12], [2400, 30, 12], [3400, 30, 12], [PONDER, 0, 0]];
const ponderAt: HeadAt = (t) => {
  const next = PONDER_KEYS.findIndex(([at]) => at > t);
  const i = Math.max(1, next < 0 ? PONDER_KEYS.length - 1 : next) - 1;
  const [t0, y0, p0] = PONDER_KEYS[i]!;
  const [t1, y1, p1] = PONDER_KEYS[i + 1]!;
  const e = t1 > t0 ? motionEase('inOut', clamp((t - t0) / (t1 - t0), 0, 1)) : 1;
  return { yaw: r3(y0 + (y1 - y0) * e), pitch: r3(p0 + (p1 - p0) * e) };
};

/**
 * Loops for a small place (`compact`) that replace the mood's own there. Thinking, the avatar stays itself (never the
 * three dots, never dots in its visor) with its eyes exactly as they are at rest, and the motion alone says it is
 * busy: its head turns to look up to the left, holds, turns to look up to the right, holds, and comes back, the eyes
 * glancing the same way within the visor.
 */
const PONDER_TRACKS: readonly BotTrack[] = [
  ...headTracks(PONDER, PONDER_KEYS.map(([t]) => t), ponderAt, true),
  { layer: 'look', prop: 'translate', ms: PONDER, keys: PONDER_KEYS.map(([t, yaw, pitch]): MotionKey => [t, [r3((yaw / 30) * 1.5), r3(-(pitch / 12) * 1.5)]]) },
];
/**
 * Tracks a solid drawing (the desktop's 3D avatar, `turn` tracks) runs in place of a mood's own of the same layer and
 * property: the routine's body scale without the flip and the spin, which its head turns instead.
 */
export const BOT_SOLID_LOOPS: Readonly<Partial<Record<BotMood, readonly BotTrack[]>>> = { tool: [solidSize] };

export const BOT_COMPACT_LOOPS: Readonly<Partial<Record<BotMood, readonly BotTrack[]>>> = { thinking: PONDER_TRACKS, working: PONDER_TRACKS };

/** Moods whose loop starts from its beginning (the tool routine starts still, facing you, as the reference's did). */
export const BOT_LOOPS_FROM_START: readonly BotMood[] = ['tool'];

/* the happy cheer: the jelly at JELLY, the dance at DANCE (the reference: 630 ms and 2870 ms after its reply was done) */
const JELLY = 630;
const DANCE = 2870;
const CHEER = 4800;
/** a reference pixel in our viewBox (its body is 126px wide, ours 88) */
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
   * `settle` for where the eyes look and the body's size (the reference: 40–90 ms and 120–130 ms, fitted over 13 changes).
   */
  snap: 50,
  settle: 125,
  /** the cheer's length */
  cheer: CHEER,
  /** how long the happy face stays after work ends before it rests (the reference: at least 5.2 s; the rest not seen) */
  happy: 10000,
  /** how near the pointer makes a resting avatar look at it, from its middle, in avatar sizes */
  lookRadius: 1.05,
  /** the head's lean when looking at the pointer, degrees per unit of looking sideways */
  lookLean: -7.3,
  /** the face's turn toward the pointer, degrees per unit of looking sideways */
  lookTurn: 35,
  /** the head's nod toward the pointer, degrees per unit of looking up or down */
  lookPitch: 16,
  /** how far the eyes look sideways within the visor on top of the turn */
  lookX: 2,
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

/**
 * Where each body's middle is (viewBox y: the centroid of its area). A bot is drawn with it on the box's middle, and
 * every whole-body motion turns round it, so a drop or a triangle (heavy at the bottom) sits centred in its place, on the
 * middle of the text beside it, instead of low.
 */
export const BOT_MIDDLE: Readonly<Record<BotShape, number>> = {
  circle: 50, squircle: 51.2, square: 50, pill: 50, triangle: 61.3, hex: 50, cloud: 57.6, drop: 57.6,
  egg: 51.5, ghost: 51.1, flower: 50, shield: 43.4, octagon: 50, heart: 45.3, diamond: 50, bell: 51.5, mushroom: 50.6, bear: 55.4,
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
 * dots, `working` shows as `thinking`.
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
 * BOT_MOTION.lookRadius sizes, else the face's turn toward it (degrees, botTurn), the eyes' place within the visor
 * (viewBox units: BOT_GAZE's reach up and down, BOT_MOTION.lookX sideways, all of it from a third of a size out) and
 * the body's lean. The head nods toward it too (`pitch`, botHead).
 */
export function botGaze(dx: number, dy: number, size: number): { turn: number; pitch: number; x: number; y: number; rotate: number } | null {
  const dist = Math.hypot(dx, dy);
  if (!(size > 0) || dist > BOT_MOTION.lookRadius * size) return null;
  const k = 1 / Math.max(dist, size / 3);
  const ux = dx * k;
  const uy = dy * k;
  return {
    turn: r3(ux * BOT_MOTION.lookTurn) || 0,
    pitch: r3(-uy * BOT_MOTION.lookPitch) || 0,
    x: r3(ux * BOT_MOTION.lookX) || 0,
    y: r3(uy * (uy < 0 ? BOT_GAZE.up : BOT_GAZE.down)) || 0,
    rotate: r3(ux * BOT_MOTION.lookLean) || 0,
  };
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
