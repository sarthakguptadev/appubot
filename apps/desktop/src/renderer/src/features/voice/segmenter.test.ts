import { describe, expect, it } from 'vitest';
import { LONG_SEGMENT_MS, PRE_ROLL_MS, Segmenter, joinSegments, splitAtPauses } from './segmenter';

const RATE = 16_000;
const ms = (n: number) => Math.round((n / 1000) * RATE);

/** a recording: speech-like bursts (a 220 Hz tone with a syllable-rate swell) over faint noise */
function recording(plan: [kind: 'say' | 'quiet', ms: number][]): { pcm: Int16Array } {
  const total = plan.reduce((n, [, d]) => n + ms(d), 0);
  const pcm = new Int16Array(total);
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff - 0.5) * 20; };
  let at = 0;
  for (const [kind, d] of plan) {
    const n = ms(d);
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const swell = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
      pcm[at + i] = Math.round(noise() + (kind === 'say' ? 6000 * swell * Math.sin(2 * Math.PI * 220 * t) : 0));
    }
    at += n;
  }
  return { pcm };
}

/** feeds it as the microphone does, 50 ms at a time; the segments' lengths in samples */
function feed(pcm: Int16Array): { cuts: Int16Array[]; seg: Segmenter } {
  const seg = new Segmenter();
  const cuts: Int16Array[] = [];
  for (let i = 0; i < pcm.length; i += 800) cuts.push(...seg.push(pcm.subarray(i, i + 800)));
  return { cuts, seg };
}

describe('Segmenter', () => {
  it('cuts in the middle of a pause between phrases, and leaves only quiet once you stop', () => {
    const { pcm } = recording([['quiet', 600], ['say', 1500], ['quiet', 400], ['say', 1200], ['quiet', 800]]);
    const { cuts, seg } = feed(pcm);
    expect(cuts).toHaveLength(2);
    // the first starts `PRE_ROLL_MS` before the speech and ends inside the pause, away from both phrases
    expect(cuts[0]!.length).toBeGreaterThan(ms(PRE_ROLL_MS + 1500 + 100));
    expect(cuts[0]!.length).toBeLessThan(ms(PRE_ROLL_MS + 1500 + 300));
    // the second holds the rest of that pause and the second phrase
    expect(cuts[1]!.length).toBeGreaterThan(ms(1200 + 100));
    expect(seg.rest().voiced).toBe(false);
    expect(seg.total).toBe(pcm.length);
  });

  it('never cuts at the short gaps between words', () => {
    const plan: ['say' | 'quiet', number][] = [];
    for (let i = 0; i < 8; i++) plan.push(['say', 400], ['quiet', 150]);
    const { cuts, seg } = feed(recording(plan).pcm);
    expect(cuts).toHaveLength(0);
    expect(seg.rest().voiced).toBe(true);
  });

  it('keeps a word alone with what follows', () => {
    const { cuts, seg } = feed(recording([['quiet', 2000], ['say', 300], ['quiet', 500]]).pcm);
    expect(cuts).toHaveLength(0);
    // the long silence before it was let go
    expect(seg.rest().pcm.length).toBeLessThan(ms(1300));
    expect(seg.rest().voiced).toBe(true);
  });

  it('lets silence before the speech go', () => {
    const { cuts } = feed(recording([['quiet', 3000], ['say', 1200], ['quiet', 400]]).pcm);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.length).toBeLessThan(ms(400 + 1200 + 300));
  });

  it('cuts a long monologue at a shorter pause', () => {
    const plan: ['say' | 'quiet', number][] = [];
    for (let i = 0; i < 24; i++) plan.push(['say', 400], ['quiet', 200]);
    const { cuts } = feed(recording(plan).pcm);
    expect(cuts.length).toBeGreaterThan(0);
    expect(cuts[0]!.length).toBeGreaterThanOrEqual(ms(LONG_SEGMENT_MS));
    expect(cuts[0]!.length).toBeLessThan(ms(LONG_SEGMENT_MS + 1500));
  });

  it('is fed any block size', () => {
    const { pcm } = recording([['say', 1500], ['quiet', 400], ['say', 1200], ['quiet', 500]]);
    const seg = new Segmenter();
    const cuts: Int16Array[] = [];
    for (let i = 0; i < pcm.length; i += 333) cuts.push(...seg.push(pcm.subarray(i, i + 333)));
    expect(cuts.map((c) => c.length)).toEqual(feed(pcm).cuts.map((c) => c.length));
  });
});

describe('splitAtPauses', () => {
  it('returns the segments and a rest with sound', () => {
    const { pcm } = recording([['say', 1500], ['quiet', 400], ['say', 1200]]);
    const parts = splitAtPauses(pcm);
    expect(parts).toHaveLength(2);
    expect(parts.reduce((n, p) => n + p.length, 0)).toBe(pcm.length);
  });
});

describe('joinSegments', () => {
  it('joins in order, dropping a full stop the next words carry on from', () => {
    expect(joinSegments(['Hey Appu, I have a quick question.', ' What is the capital of Australia? '])).toBe('Hey Appu, I have a quick question. What is the capital of Australia?');
    expect(joinSegments(['I want to.', 'go home.', ''])).toBe('I want to go home.');
    expect(joinSegments(['Wait...', 'what?'])).toBe('Wait... what?');
    expect(joinSegments(['', '  '])).toBe('');
  });
});
