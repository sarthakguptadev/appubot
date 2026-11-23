import { describe, expect, it } from 'vitest';
import { BARGE_IN_MS, VOICE_DB_MARGIN } from './bargeIn';
import { LEVEL_INTERVAL_MS } from './levels';
import { Segmenter } from './segmenter';
import { TurnDetector, type TurnSignal } from './turnDetector';
import { MIN_SPEECH_MS, VAD_BACKLOG, VAD_FRAME, VAD_FRAME_MS, VadFeed, VoiceActivity, type VadModel } from './vad';

describe('VoiceActivity', () => {
  it('goes into speech at 0.5 and out below 0.35', () => {
    const a = new VoiceActivity();
    a.frame(0.45);
    expect(a.speaking).toBe(false);
    a.frame(0.6);
    expect(a.speaking).toBe(true);
    a.frame(0.4);
    expect(a.speaking).toBe(true);
    a.frame(0.3);
    expect(a.speaking).toBe(false);
    a.frame(0.4);
    expect(a.speaking).toBe(false);
  });

  it('reports the frames since the last look', () => {
    const a = new VoiceActivity();
    a.frame(0.9);
    a.frame(0.1);
    expect(a.take()).toEqual({ voiced: true, voicedMs: VAD_FRAME_MS, prob: 0.9 });
    a.frame(0.1);
    expect(a.take()).toEqual({ voiced: false, voicedMs: 0, prob: 0.1 });
  });
});

/** One step of a scene: the mic's level and the VAD's probability for `ms`, the bot playing at `output`. */
interface Step { ms: number; level: number; prob: number; output?: number; db?: number }

/** Runs a scene as voice mode does: a VAD frame every 32 ms, a meter tick every 80 ms. */
function scene(d: TurnDetector, steps: Step[], clock = { now: 0 }): [number, TurnSignal][] {
  const a = new VoiceActivity();
  const out: [number, TurnSignal][] = [];
  for (const s of steps) {
    for (let t = 0; t < s.ms; t += 16) {
      clock.now += 16;
      if (clock.now % VAD_FRAME_MS === 0) a.frame(s.prob);
      if (clock.now % LEVEL_INTERVAL_MS === 0) {
        const sig = d.feed(s.level, clock.now, s.output ?? 0, s.db, a.take());
        if (sig) out.push([clock.now, sig]);
      }
    }
  }
  return out;
}
const sigs = (r: [number, TurnSignal][]) => r.map(([, s]) => s).filter((s) => s !== 'restart');

describe('TurnDetector with the VAD', () => {
  it('a loud noise that isn’t speech is no turn, however long', () => {
    const d = new TurnDetector();
    d.reset(0);
    // a fan, a TV in another language far off, typing: loud, but the VAD says no
    const r = scene(d, [{ ms: 10_000, level: 0.95, prob: 0.12 }]);
    expect(sigs(r)).toEqual([]);
    expect(d.heard).toBe(false);
    // and the idle recording still starts over (the noise doesn't hold it open)
    expect(r.some(([, s]) => s === 'restart')).toBe(true);
  });

  it('quiet speech is a turn: the VAD, not loudness, decides', () => {
    const d = new TurnDetector();
    d.reset(0);
    const r = scene(d, [{ ms: 200, level: 0.1, prob: 0.9 }, { ms: 200, level: 0.1, prob: 0.9 }]);
    expect(sigs(r)).toEqual(['speech']);
    expect(r[0]![0]).toBeGreaterThanOrEqual(MIN_SPEECH_MS);
    expect(r[0]![0]).toBeLessThan(MIN_SPEECH_MS + 2 * LEVEL_INTERVAL_MS);
  });

  it('a short blip of speech isn’t a turn, but short pauses inside speech don’t start the count over', () => {
    const d = new TurnDetector();
    d.reset(0);
    expect(sigs(scene(d, [{ ms: 160, level: 0.6, prob: 0.9 }, { ms: 1000, level: 0.05, prob: 0.02 }]))).toEqual([]);
    const e = new TurnDetector();
    e.reset(0);
    // 160 + 160 ms of speech around a 300 ms pause: one run of 320 ms
    expect(sigs(scene(e, [{ ms: 160, level: 0.6, prob: 0.9 }, { ms: 320, level: 0.05, prob: 0.05 }, { ms: 160, level: 0.6, prob: 0.9 }]))).toEqual(['speech']);
  });

  it('a pause inside speech doesn’t end the turn; noise after it doesn’t keep it open', () => {
    const d = new TurnDetector();
    d.reset(0);
    d.endQuietMs = 700;
    const r = scene(d, [
      { ms: 800, level: 0.6, prob: 0.95 },
      { ms: 400, level: 0.05, prob: 0.05 },
      { ms: 800, level: 0.6, prob: 0.95 },
    ]);
    expect(sigs(r)).toEqual(['speech']);
    // the room is loud after you stop (traffic): the turn ends anyway, on time
    const clock = { now: 2000 };
    const end = scene(d, [{ ms: 2000, level: 0.9, prob: 0.08 }], clock).find(([, s]) => s === 'end');
    expect(end).toBeDefined();
    expect(end![0] - 2000).toBeGreaterThanOrEqual(700);
    expect(end![0] - 2000).toBeLessThan(700 + 2 * LEVEL_INTERVAL_MS);
  });

  it('while the bot thinks, noise never makes a candidate; 500 ms of speech does', () => {
    const d = new TurnDetector();
    d.reset(0, true);
    expect(sigs(scene(d, [{ ms: 5000, level: 0.95, prob: 0.2 }]))).toEqual([]);
    const e = new TurnDetector();
    e.reset(0, true);
    const r = scene(e, [{ ms: 1000, level: 0.8, prob: 0.95 }]);
    expect(sigs(r)).toEqual(['candidate']);
    expect(r[0]![0]).toBeGreaterThanOrEqual(BARGE_IN_MS);
    expect(e.candidate?.vad).toBeCloseTo(0.95);
  });

  it('speech under 500 ms never cuts in', () => {
    const d = new TurnDetector();
    d.reset(0, true);
    // "mm-hm", a cough the VAD calls speech: short runs with gaps
    const steps: Step[] = [];
    for (let i = 0; i < 6; i++) steps.push({ ms: 320, level: 0.8, prob: 0.9 }, { ms: 400, level: 0.05, prob: 0.05 });
    expect(sigs(scene(d, steps))).toEqual([]);
  });

  it('the bot’s echo is speech to the VAD, but not louder than the echo: no candidate', () => {
    const d = new TurnDetector();
    d.reset(0, true);
    expect(sigs(scene(d, [{ ms: 4000, level: 0.65, prob: 0.97, output: 0.7 }]))).toEqual([]);
    // your voice over it, well above the echo
    expect(sigs(scene(d, [{ ms: 1000, level: 0.95, prob: 0.97, output: 0.7 }], { now: 4000 }))).toEqual(['candidate']);
  });

  it('loud noise while the bot speaks never makes a candidate, even above its echo', () => {
    const d = new TurnDetector();
    d.voiceDb = -20;
    d.reset(0, true);
    // a door, a blender: louder than anything, near your voice's level, not speech
    expect(sigs(scene(d, [{ ms: 6000, level: 1, prob: 0.3, output: 0.6, db: -15 }]))).toEqual([]);
  });

  it('speech far fainter than your voice is faint, not a candidate', () => {
    const d = new TurnDetector();
    d.voiceDb = -20;
    d.reset(0, true);
    expect(sigs(scene(d, [{ ms: 2000, level: 0.8, prob: 0.9, db: -20 - VOICE_DB_MARGIN - 10 }]))).toEqual(['faint']);
  });
});

/** a fake model: probabilities in order; `fail` throws at that frame */
function fakeModel(probs: number[], o: { fail?: number; slow?: boolean } = {}): VadModel & { asked: number; resets: number } {
  const m = {
    asked: 0,
    resets: 0,
    async prob(frame: Float32Array) {
      expect(frame.length).toBe(VAD_FRAME);
      const k = m.asked++;
      if (k === o.fail) throw new Error('wasm trap');
      if (o.slow) await new Promise((r) => setTimeout(r, 1));
      return probs[k % probs.length]!;
    },
    reset() { m.resets++; },
  };
  return m;
}

describe('VadFeed', () => {
  it('cuts the samples into 512-sample frames, in order, each with its probability', async () => {
    const got: [number, number | null][] = [];
    const f = new VadFeed((pcm, p) => got.push([pcm[0]!, p]));
    const m = fakeModel([0.1, 0.9, 0.2]);
    f.use(m);
    expect(m.resets).toBe(1);
    const pcm = Int16Array.from({ length: VAD_FRAME * 3 + 100 }, (_, i) => Math.floor(i / VAD_FRAME));
    // as the mic hands them out: 800 at a time
    for (let i = 0; i < pcm.length; i += 800) f.push(pcm.subarray(i, i + 800));
    await f.drain();
    expect(got).toEqual([[0, 0.1], [1, 0.9], [2, 0.2]]);
  });

  it('hands frames on without a probability before the model is there and after it fails', async () => {
    const got: (number | null)[] = [];
    const failed: unknown[] = [];
    const f = new VadFeed((_, p) => got.push(p), (e) => failed.push(e));
    f.push(new Int16Array(VAD_FRAME));
    f.use(fakeModel([0.7], { fail: 1 }));
    f.push(new Int16Array(VAD_FRAME * 3));
    await f.drain();
    expect(got).toEqual([null, 0.7, null, null]);
    expect(failed).toHaveLength(1);
    expect(f.active).toBe(false);
  });

  it('too far behind, frames go on without the model rather than wait', async () => {
    const got: (number | null)[] = [];
    let behind = 0;
    const f = new VadFeed((_, p) => got.push(p), undefined, () => behind++);
    f.use(fakeModel([0.9], { slow: true }));
    f.push(new Int16Array(VAD_FRAME * (VAD_BACKLOG + 4)));
    await f.drain();
    expect(got).toHaveLength(VAD_BACKLOG + 4);
    expect(got.slice(0, VAD_BACKLOG).every((p) => p === 0.9)).toBe(true);
    expect(got.slice(VAD_BACKLOG).every((p) => p === null)).toBe(true);
    expect(behind).toBe(1);
  });
});

describe('Segmenter with the VAD', () => {
  const RATE = 16_000;
  /** loud noise (white, -10 dBFS) or a tone, `ms` long, pushed in VAD frames with `prob` */
  function push(seg: Segmenter, ms: number, prob: number, loud = true): Int16Array[] {
    const out: Int16Array[] = [];
    const n = Math.round((ms / 1000) * RATE / VAD_FRAME);
    let seed = 3;
    for (let k = 0; k < n; k++) {
      const f = Int16Array.from({ length: VAD_FRAME }, () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return loud ? Math.round((seed / 0x7fffffff - 0.5) * 20000) : 0;
      });
      out.push(...seg.push(f, prob));
    }
    return out;
  }

  it('noise the VAD calls no speech is a pause: no segment, nothing to hear', () => {
    const seg = new Segmenter();
    expect(push(seg, 4000, 0.1)).toEqual([]);
    expect(seg.rest().voiced).toBe(false);
  });

  it('cuts at a pause full of noise between two phrases', () => {
    const seg = new Segmenter();
    const cuts = [...push(seg, 1500, 0.95), ...push(seg, 500, 0.1), ...push(seg, 1200, 0.95)];
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.length / RATE * 1000).toBeGreaterThan(1500);
    expect(seg.rest().voiced).toBe(true);
  });

  it('keeps speech through a dip above 0.35', () => {
    const seg = new Segmenter();
    const cuts = [...push(seg, 1500, 0.95), ...push(seg, 600, 0.4), ...push(seg, 600, 0.95)];
    expect(cuts).toEqual([]);
  });
});
