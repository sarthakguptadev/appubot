import { describe, expect, it } from 'vitest';
import { BotShape } from '@appubot/protocol';
import { BOT_BASE, BOT_BLINK, BOT_CHEER, BOT_LOOPS, cheersAt, motionEase, sampleTrack, squash, type BotTrack } from './botMotion';

const all: [string, BotTrack][] = [
  ...Object.entries(BOT_LOOPS).flatMap(([m, ts]) => ts.map((t, i): [string, BotTrack] => [`${m}#${i}`, t])),
  ['blink', BOT_BLINK],
  ...BOT_CHEER.map((t, i): [string, BotTrack] => [`cheer#${i}`, t]),
];

describe('bot motion', () => {
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
    for (const [name, t] of all) {
      const a = t.keys[0]![1];
      const b = t.keys.at(-1)![1];
      expect(a, name).toEqual(b);
    }
    for (const t of BOT_CHEER) {
      const rest = t.prop === 'translate' ? 0 : t.prop === 'rotate' ? 0 : 1;
      expect(sampleTrack(t, t.ms, false, 0)).toBe(rest);
      expect(sampleTrack(t, t.ms + 500, false, 1)).toBe(rest);
    }
  });

  it('never animates one layer property twice in a mood, and keeps the cheer and blink to their own layers', () => {
    for (const [mood, ts] of Object.entries(BOT_LOOPS)) {
      const seen = ts.map((t) => `${t.layer}.${t.prop}`);
      expect(new Set(seen).size, mood).toBe(seen.length);
      for (const t of ts) expect(['body', 'tilt', 'look']).toContain(t.layer);
    }
    for (const t of BOT_CHEER) expect(['joy', 'eye']).toContain(t.layer);
    expect(BOT_BLINK.layer).toBe('eye');
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
    const hop = BOT_LOOPS.rest.find((x) => x.layer === 'body' && x.prop === 'translate')!;
    const ys = Array.from({ length: 130 }, (_, i) => sampleTrack(hop, i * 100, true, 1));
    expect(Math.min(...ys)).toBeLessThan(-6);
    expect(Math.max(...ys)).toBeLessThanOrEqual(0);
  });

  it('cheers only when work is done, and knows where every body stands', () => {
    expect(cheersAt('working', 'rest')).toBe(true);
    expect(cheersAt('needs-you', 'rest')).toBe(false);
    expect(cheersAt(undefined, 'rest')).toBe(false);
    expect(cheersAt('rest', 'working')).toBe(false);
    for (const s of BotShape.options) expect(BOT_BASE[s]).toBeGreaterThan(70);
  });
});
