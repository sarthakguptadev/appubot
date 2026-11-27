import { describe, expect, it } from 'vitest';
import { BotShape, type Part } from '@appubot/protocol';
import {
  BOT_BASE, BOT_CHEER, BOT_DOT_LOOP, BOT_DOTS, BOT_EASE_CSS, BOT_LOOPS, BOT_LOOPS_FROM_START, BOT_MIDDLE, BOT_MORPH, BOT_MOTION, BOT_POSES, BOT_TURN, BOT_WORK_MOODS, botGaze, botHandoff,
  botShown, botTurn, botWorkMood, cheersAt, motionEase, poseEase, sampleTrack, squash, type BotMood, type BotTrack,
} from './botMotion';

const all: [string, BotTrack][] = [
  ...Object.entries(BOT_LOOPS).flatMap(([m, ts]) => ts!.map((t, i): [string, BotTrack] => [`${m}#${i}`, t])),
  ...BOT_CHEER.map((t, i): [string, BotTrack] => [`cheer#${i}`, t]),
  ...BOT_DOT_LOOP.tracks.map((t, i): [string, BotTrack] => [`dot#${i}`, t]),
];
const moods = Object.keys(BOT_POSES) as BotMood[];
const over = (t: BotTrack, c: 0 | 1 = 0, step = 10) => Array.from({ length: t.ms / step + 1 }, (_, i) => sampleTrack(t, i * step, false, c));

/** A CSS cubic-bezier(x1, y1, x2, y2) at x. */
function bezier(css: string, x: number): number {
  const [x1, y1, x2, y2] = css.slice(13, -1).split(',').map(Number) as [number, number, number, number];
  let t = x;
  for (let i = 0; i < 40; i++) {
    const bx = 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
    const dx = 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;
    t = Math.min(1, Math.max(0, t - (bx - x) / Math.max(dx, 1e-6)));
  }
  return 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
}

const text = (t: string, said?: boolean): Part => ({ type: 'text', text: t, ...(said ? { said } : {}) });
const call = (status: 'pending' | 'in_progress' | 'completed'): Part => ({ type: 'tool_call', toolCallId: 'c', title: 'weather', kind: 'fetch', status, content: [], locations: [] });

describe('bot motion: tracks', () => {
  it('squashes and stretches without changing the volume', () => {
    for (const k of [-0.14, -0.02, 0, 0.06, 0.16]) {
      const [sx, sy] = squash(k);
      expect(sx * sy).toBeCloseTo(1, 2);
    }
    expect(squash(0.2)[1]).toBe(0.8);
  });

  it('keeps every track a clean timeline: from 0 to its length, in order, values of the right kind', () => {
    for (const [name, t] of all) {
      expect(t.keys[0]![0], name).toBe(0);
      expect(t.keys.at(-1)![0], name).toBe(t.ms);
      for (let i = 1; i < t.keys.length; i++) expect(t.keys[i]![0], name).toBeGreaterThan(t.keys[i - 1]![0]);
      const pair = t.prop === 'translate' || t.prop === 'scale';
      for (const k of t.keys) expect(typeof k[1] === 'number', name).toBe(!pair);
    }
  });

  it('loops seamlessly and ends the cheer at rest', () => {
    for (const [name, t] of all) expect(t.keys[0]![1], name).toEqual(t.keys.at(-1)![1]);
    for (const t of BOT_CHEER) {
      const rest = t.prop === 'scale' ? 1 : 0;
      expect(sampleTrack(t, t.ms, false, 0)).toBe(rest);
      expect(sampleTrack(t, t.ms + 500, false, 1)).toBe(rest);
    }
  });

  it('never animates one layer property twice in a mood, and keeps each kind of motion to its own layers', () => {
    for (const [mood, ts] of Object.entries(BOT_LOOPS)) {
      const seen = ts!.map((t) => `${t.layer}.${t.prop}`);
      expect(new Set(seen).size, mood).toBe(seen.length);
      for (const t of ts!) expect(['body', 'tilt', 'face', 'look', 'eyeL', 'eyeR']).toContain(t.layer);
    }
    for (const t of BOT_CHEER) expect(t.layer).toBe('joy');
    for (const t of BOT_DOT_LOOP.tracks) expect(t.layer).toBe('dot');
  });

  it('samples tracks with the CSS-like curves', () => {
    expect(motionEase('inOut', 0.5)).toBeCloseTo(0.5);
    expect(motionEase('out', 0.5)).toBeGreaterThan(0.5);
    expect(motionEase('in', 0.5)).toBeLessThan(0.5);
    const t: BotTrack = { layer: 'tilt', prop: 'rotate', ms: 100, ease: 'linear', keys: [[0, 0], [50, 10], [100, 0]] };
    expect(sampleTrack(t, 25, true)).toBe(5);
    expect(sampleTrack(t, 125, true)).toBe(5);
    expect(sampleTrack(t, -25, true)).toBe(5);
    expect(sampleTrack(t, 50, true)).toBe(10);
  });
});

describe('bot motion: Grok Bot, measured', () => {
  it('eases every pose change with one first-order curve, and the CSS curve follows it', () => {
    expect(BOT_MOTION.snap).toBe(50);
    expect(BOT_MOTION.settle).toBe(125);
    expect(poseEase(0, 125)).toBe(0);
    expect(poseEase(125, 125)).toBeCloseTo(0.644, 2);
    expect(poseEase(500, 125)).toBe(1);
    for (let i = 0; i <= 100; i++) expect(Math.abs(bezier(BOT_EASE_CSS, i / 100) - poseEase((i / 100) * 500, 125))).toBeLessThan(0.01);
  });

  it('rests still, upright and facing you with its eyes in the middle: no loop at all and no blinks', () => {
    expect(BOT_LOOPS.rest).toBeUndefined();
    expect(BOT_POSES.rest).toEqual({ rotate: 0, turn: 0, gaze: [0, 0], eye: [1, 1], face: 'open', form: 'bot' });
  });

  it('turns its face like Grok Bot: sliding 0.17 of the body sideways and narrowing to cos 35° at a 35° turn', () => {
    expect(botTurn(0)).toEqual({ x: 0, sx: 1 });
    expect(botTurn(35).x / 88).toBeCloseTo(0.17, 2);
    expect(botTurn(35).sx).toBeCloseTo(0.82, 2);
    expect(botTurn(-39).x).toBeCloseTo(-botTurn(39).x, 5);
    expect(botTurn(90).x).toBe(BOT_TURN);
    // the eyes drew to 0.36 of their spacing as it turned away to think, to 0.78 while typing
    expect(botTurn(BOT_POSES.thinking.turn).sx).toBeCloseTo(0.36, 2);
    expect(botTurn(BOT_POSES.typing.turn).sx).toBeCloseTo(0.78, 2);
  });

  it('gives each mood its pose: big eyes listening, the resting pose on a tool (its routine moves it), bigger eyes typing, ^ ^ happy', () => {
    expect(BOT_POSES.listening).toMatchObject({ rotate: 0, gaze: [0, 0], eye: [1.63, 1.52], face: 'open', form: 'bot' });
    expect(BOT_POSES.tool).toEqual(BOT_POSES.rest);
    expect(BOT_POSES.typing).toMatchObject({ rotate: 0, turn: 39, eye: [1.53, 1.53] });
    expect(BOT_POSES.typing.gaze[1]).toBeLessThan(0);
    expect(BOT_POSES.thinking.turn).toBe(69);
    expect(BOT_POSES.happy).toMatchObject({ rotate: 0, face: 'happy' });
    expect(BOT_POSES.thinking.form).toBe('dots');
    expect(BOT_POSES.working).toEqual(BOT_POSES.thinking);
    for (const m of moods) if (m !== 'thinking' && m !== 'working') expect(BOT_POSES[m].form, m).toBe('bot');
  });

  it('thinks in three dots lit left to right, each for a third of 1.38 s, swelling to 1.21 and rising', () => {
    expect(BOT_DOTS.ms).toBe(1380);
    const [opacity, scale, lift] = BOT_DOT_LOOP.tracks as [BotTrack, BotTrack, BotTrack];
    const litFrom = (offset: number) => Array.from({ length: 1380 }, (_, t) => sampleTrack(opacity, t + offset, true)).findIndex((o) => o > 0.99);
    const starts = BOT_DOT_LOOP.offsets.map(litFrom);
    expect(starts[0]).toBeLessThan(starts[1]!);
    expect(starts[1]).toBeLessThan(starts[2]!);
    expect(starts[1]! - starts[0]!).toBeCloseTo(460, -1);
    const lit = Array.from({ length: 1380 }, (_, t) => sampleTrack(opacity, t, true)).filter((o) => o > BOT_DOTS.dim).length;
    expect(lit).toBeGreaterThan(440);
    expect(lit).toBeLessThan(480);
    expect(Math.max(...over(scale))).toBeCloseTo(1.21, 2);
    expect(Math.min(...over(lift, 1))).toBeCloseTo(-2.1, 2);
    expect(BOT_DOTS.dim).toBe(0.55);
  });

  it('collapses into the dots and grows back on the measured timeline', () => {
    expect(BOT_MORPH.collapse + 4 * BOT_MOTION.settle).toBeGreaterThan(BOT_MORPH.lit);
    expect(BOT_MORPH.sides[0]).toBeGreaterThan(BOT_MORPH.collapse);
    expect(BOT_MORPH.fadeBack[0] + BOT_MORPH.fadeBack[1]).toBeLessThan(4 * BOT_MOTION.settle);
    expect(BOT_DOTS.r * 2).toBeCloseTo(88 * BOT_DOTS.scale, 0);
  });

  it("runs Grok Bot's working routine on a tool, on the measured timeline, from a still start", () => {
    const tool = BOT_LOOPS.tool!;
    const find = (layer: string, prop: string) => tool.find((t) => t.layer === layer && t.prop === prop)!;
    const rotate = find('body', 'rotate');
    const move = find('body', 'translate');
    const size = find('body', 'scale');
    const slide = find('face', 'translate');
    const [eyeL, eyeR] = [find('eyeL', 'scale'), find('eyeR', 'scale')];
    const at = (t: BotTrack, ms: number, c: 0 | 1 = 0) => sampleTrack(t, ms, true, c);
    const area = (t: BotTrack, ms: number) => at(t, ms, 0) * at(t, ms, 1);
    for (const t of tool) expect(t.ms, `${t.layer}.${t.prop}`).toBe(30500);
    expect(BOT_LOOPS_FROM_START).toEqual(['tool']);
    // still and facing you for its first 1.5 s (within a viewBox unit, a third of a pixel in a sidebar row), and at the end
    for (const t of tool) {
      const rest = t.prop === 'scale' ? 1 : 0;
      for (let ms = 0; ms <= 1500; ms += 50) for (const c of [0, 1] as const) expect(Math.abs(at(t, ms, c) - rest), `${t.layer}.${t.prop} ${ms}`).toBeLessThan(1);
      expect(at(t, 30500, 0)).toBe(rest);
    }
    // glances left at 2.9 s: the near (left) eye 1.5× the far one, the body sliding 12.6 after its eyes
    expect(Math.sqrt(area(eyeL, 2900) / area(eyeR, 2900))).toBeGreaterThan(1.35);
    expect(at(move, 2917)).toBeCloseTo(-12.6, 0);
    // blinks at 5.5 s with its head tilted 9.6°
    expect(at(eyeL, 5517, 1)).toBeLessThan(0.3);
    expect(at(eyeR, 5517, 1)).toBeLessThan(0.3);
    expect(at(rotate, 5450)).toBe(9.6);
    // crouches 10.8 by 7.83 s, then flips head over heels: upside down at 8.23–8.25 s, landing by 8.42 s
    expect(at(move, 7833, 1)).toBeCloseTo(10.77, 2);
    expect(at(size, 8200, 1)).toBeCloseTo(0.47, 2);
    expect(at(size, 8233, 1)).toBeCloseTo(-0.91, 2);
    expect(at(size, 8250, 1)).toBeCloseTo(-0.91, 2);
    expect(at(size, 8417, 1)).toBe(1);
    // shrinks to 0.71 rolling 36° to the right, grows back leaning 21–23° to the left
    expect(at(size, 16483)).toBeCloseTo(0.71, 2);
    expect(at(rotate, 16417)).toBeCloseTo(36.4, 1);
    expect(at(rotate, 18533)).toBe(-23);
    // spins round: turned away to the left at 18.867 s, back from the right, facing you by 19.6 s
    expect(at(slide, 18867)).toBeCloseTo(botTurn(-90).x, 2);
    expect(at(slide, 18868)).toBeCloseTo(botTurn(90).x, 2);
    expect(at(size, 18867)).toBeCloseTo(0.48, 2);
    expect(at(slide, 19600)).toBe(0);
    // wobbles: 37° right, then sweeps to 48° left in 1.3 s and snaps back in 0.2–0.35 s
    const wobble = Array.from({ length: 560 }, (_, i) => at(rotate, 24200 + i * 10));
    expect(Math.max(...wobble)).toBeCloseTo(37.7, 1);
    expect(Math.min(...wobble)).toBeCloseTo(-48.1, 1);
    expect(at(rotate, 27600)).toBe(-48.1);
    expect(at(rotate, 27917)).toBe(36.7);
  });

  it('cheers: a jelly squash at 630 ms, then a three-hop dance from 2.87 s, all within the happy face', () => {
    const [scale, lift, rotate] = BOT_CHEER as [BotTrack, BotTrack, BotTrack];
    expect(sampleTrack(scale, 629, false, 0)).toBe(1);
    expect(sampleTrack(scale, 810, false, 0)).toBeCloseTo(1.1, 2);
    expect(sampleTrack(scale, 810, false, 1)).toBeCloseTo(0.88, 2);
    expect(sampleTrack(scale, 1030, false, 1)).toBeCloseTo(1.1, 2);
    const ys = over(lift, 1);
    const hops = ys.filter((y, i) => i > 0 && i < ys.length - 1 && y < ys[i - 1]! && y <= ys[i + 1]!).length;
    expect(hops).toBe(3);
    expect(Math.min(...ys)).toBeCloseTo(-15 * (88 / 126), 1);
    expect(ys.slice(0, 287).every((y) => y === 0)).toBe(true);
    expect(Math.min(...over(rotate))).toBe(-14.5);
    expect(Math.max(...over(rotate))).toBe(25);
    expect(BOT_MOTION.cheer).toBeLessThan(BOT_MOTION.happy);
  });
});

describe('bot motion: the state machine', () => {
  it('reads a live turn: listening, then thinking, a tool, typing', () => {
    expect(botWorkMood(undefined)).toBe('listening');
    expect(botWorkMood([])).toBe('listening');
    expect(botWorkMood([{ type: 'thought', text: 'hm' }])).toBe('thinking');
    expect(botWorkMood([{ type: 'thought', text: 'hm' }, call('in_progress')])).toBe('tool');
    expect(botWorkMood([call('completed')])).toBe('tool');
    expect(botWorkMood([call('completed'), text('Checking now.', true)])).toBe('tool');
    expect(botWorkMood([call('completed'), text('It is 12°C')])).toBe('typing');
    expect(botWorkMood([text('  ')])).toBe('listening');
  });

  it('cheers only when work is done', () => {
    for (const m of BOT_WORK_MOODS) expect(cheersAt(m, 'rest'), m).toBe(true);
    expect(cheersAt('needs-you', 'rest')).toBe(false);
    expect(cheersAt(undefined, 'rest')).toBe(false);
    expect(cheersAt('rest', 'thinking')).toBe(false);
    expect(cheersAt('happy', 'rest')).toBe(false);
  });

  it('shows happy after work, keeps the dots through typing, and shows working as thinking', () => {
    const run = (asked: BotMood[]) => asked.reduce<BotMood[]>((shown, m) => [...shown, botShown(shown.at(-1), m)], []);
    expect(run(['rest', 'listening', 'thinking', 'typing', 'rest'])).toEqual(['rest', 'listening', 'thinking', 'thinking', 'happy']);
    expect(run(['rest', 'listening', 'tool', 'typing', 'rest'])).toEqual(['rest', 'listening', 'tool', 'typing', 'happy']);
    expect(run(['working', 'typing', 'rest'])).toEqual(['thinking', 'thinking', 'happy']);
    expect(run(['happy', 'rest', 'listening'])).toEqual(['happy', 'happy', 'listening']);
    expect(run(['needs-you', 'rest'])).toEqual(['needs-you', 'rest']);
  });

  it('hands off by collapsing into the dots, growing out of them, or easing between poses', () => {
    expect(botHandoff('listening', 'thinking')).toBe('collapse');
    expect(botHandoff('thinking', 'happy')).toBe('grow');
    expect(botHandoff('thinking', 'tool')).toBe('grow');
    expect(botHandoff('rest', 'listening')).toBe('ease');
    expect(botHandoff('thinking', 'working')).toBe('ease');
  });

  it('looks at a pointer within reach: turning its face toward it, eyes following, leaning a little', () => {
    expect(botGaze(200, 0, 100)).toBeNull();
    expect(botGaze(0, 0, 0)).toBeNull();
    expect(botGaze(80, 0, 100)).toEqual({ turn: 35, x: 2, y: 0, rotate: -7.3 });
    expect(botGaze(-80, 0, 100)).toEqual({ turn: -35, x: -2, y: 0, rotate: 7.3 });
    expect(botGaze(0, -60, 100)).toEqual({ turn: 0, x: 0, y: -4.5, rotate: 0 });
    expect(botGaze(0, 60, 100)!.y).toBe(3.3);
    expect(botGaze(10, 0, 90)!.turn).toBeCloseTo(35 / 3, 2);
    expect(botGaze(0, 104, 100)).not.toBeNull();
  });

  it('knows where every body stands and where its middle is', () => {
    for (const s of BotShape.options) expect(BOT_BASE[s]).toBeGreaterThan(70);
    for (const s of BotShape.options) expect(Math.abs(BOT_MIDDLE[s] - 50), s).toBeLessThan(12);
    expect(BOT_MIDDLE.circle).toBe(50);
    expect(BOT_MIDDLE.drop).toBeGreaterThan(55);
  });
});
