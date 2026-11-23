import { describe, expect, it } from 'vitest';
import { Hearing } from './hearing';

const RATE = 16_000;

/** `parts` phrases of `sayMs` with `gapMs` of near-silence after each */
function speech(parts: number, sayMs = 1200, gapMs = 450): Int16Array {
  const say = (sayMs / 1000) * RATE;
  const gap = (gapMs / 1000) * RATE;
  const out = new Int16Array(parts * (say + gap));
  for (let p = 0; p < parts; p++) {
    for (let i = 0; i < say; i++) out[p * (say + gap) + i] = Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / RATE));
    for (let i = 0; i < gap; i++) out[p * (say + gap) + say + i] = (i % 7) - 3;
  }
  return out;
}

const feed = (h: Hearing, pcm: Int16Array) => { for (let i = 0; i < pcm.length; i += 800) h.push(pcm.subarray(i, i + 800)); };

/** a fake hearing: names each segment by its order; `slow` ones answer later than the ones after them */
function fakeHear(o: { slow?: number[]; fail?: number[] } = {}) {
  const asked: number[] = [];
  let n = 0;
  const hear = (pcm: Int16Array) => {
    const k = n++;
    asked.push(pcm.length);
    if (o.fail?.includes(k)) return Promise.reject(new Error('host exited'));
    const wait = o.slow?.includes(k) ? 30 : 1;
    return new Promise<string>((r) => setTimeout(() => r(pcm.length > RATE * 3 ? 'All of it.' : `Part ${k + 1}.`), wait));
  };
  return { hear, asked };
}

describe('Hearing', () => {
  it('hears each phrase as it is cut, and puts the words in order', async () => {
    const f = fakeHear({ slow: [0] });
    const captions: string[] = [];
    const h = new Hearing(f.hear, (t) => captions.push(t));
    h.accept();
    feed(h, speech(3));
    // all three were cut at their pauses and sent before the turn ended
    expect(f.asked).toHaveLength(3);
    const heard = await h.finish();
    expect(heard.text).toBe('Part 1. Part 2. Part 3.');
    expect(heard.segments).toBe(3);
    expect(heard.durationMs).toBe(3 * 1650);
    // the caption only shows words in order: nothing until the slow first part is in
    expect(captions[0]).toBe('Part 1. Part 2. Part 3.');
  });

  it('hears the rest when the turn ends mid-phrase', async () => {
    const f = fakeHear();
    const h = new Hearing(f.hear);
    h.accept();
    feed(h, speech(1, 1200, 450));
    feed(h, speech(1, 800, 0));
    const heard = await h.finish();
    expect(f.asked).toHaveLength(2);
    expect(heard.text).toBe('Part 1. Part 2.');
  });

  it('holds what was cut until speech is heard; a cut-in drops it as the bot’s echo', async () => {
    const f = fakeHear();
    const held = new Hearing(f.hear);
    feed(held, speech(1));
    expect(f.asked).toHaveLength(0);
    held.accept();
    expect(f.asked).toHaveLength(1);

    const g = fakeHear();
    const echo = new Hearing(g.hear);
    feed(echo, speech(1));
    echo.cutIn();
    feed(echo, speech(1, 900, 0));
    expect((await echo.finish()).text).toBe('Part 1.');
    expect(g.asked).toHaveLength(1);
  });

  it('a cut-in keeps what was cut after the user began', async () => {
    const f = fakeHear();
    const h = new Hearing(f.hear);
    // the bot's echo, cut at its pause, then the user's first phrase, cut at theirs
    feed(h, speech(1));
    feed(h, speech(1));
    expect(f.asked).toHaveLength(0);
    // the user began a second and a half ago: the first part was echo, the second is theirs
    h.cutIn(1500);
    expect(f.asked).toHaveLength(1);
    expect(f.asked[0]).toBeGreaterThan(RATE);
    expect((await h.finish()).text).toBe('Part 1.');
  });

  it('hands out the last moment of the recording', () => {
    const h = new Hearing(fakeHear().hear);
    const pcm = new Int16Array(7 * RATE);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i % 30_000;
    feed(h, pcm);
    const last = h.tail(1000);
    expect(last).toHaveLength(RATE);
    expect(Array.from(last.subarray(-3))).toEqual(Array.from(pcm.subarray(-3)));
    expect(last[0]).toBe(pcm[pcm.length - RATE]);
    // a few seconds at most
    const most = h.tail(60_000);
    expect(most.length).toBeGreaterThanOrEqual(5 * RATE);
    expect(most.length).toBeLessThan(5 * RATE + 800);
    expect(most.at(-1)).toBe(pcm.at(-1));
  });

  it('hears the whole recording again when a part fails', async () => {
    const f = fakeHear({ fail: [1] });
    const h = new Hearing(f.hear);
    h.accept();
    feed(h, speech(3));
    const heard = await h.finish();
    expect(heard).toMatchObject({ text: 'All of it.', segments: 1 });
    expect(f.asked.at(-1)).toBe(Math.round(3 * 1.65 * RATE));
  });

  it('whole: hears the whole turn once at its end (Whisper), the segments only for the captions', async () => {
    const f = fakeHear();
    const captions: string[] = [];
    const h = new Hearing(f.hear, (t) => captions.push(t), { whole: true });
    h.accept();
    feed(h, speech(3));
    await new Promise((r) => setTimeout(r, 10));
    expect(captions.at(-1)).toBe('Part 1. Part 2. Part 3.');
    expect(h.lastText).toBe('Part 3.');
    const heard = await h.finish();
    expect(heard).toMatchObject({ text: 'All of it.', segments: 1 });
    expect(f.asked.at(-1)).toBe(Math.round(3 * 1.65 * RATE));
  });

  it('whole after a cut-in leaves out the bot’s echo before it', async () => {
    const f = fakeHear();
    const h = new Hearing(f.hear, undefined, { whole: true });
    feed(h, speech(1));
    feed(h, speech(1));
    h.cutIn(1500);
    feed(h, speech(1, 900, 0));
    await h.finish();
    expect(f.asked.at(-1)).toBe(Math.round(1.5 * RATE + 0.9 * RATE));
  });

  it('skips segments too quiet to be speech, and drops silence hallucinations', async () => {
    const quietOnes: number[] = [];
    const f = fakeHear();
    const h = new Hearing(f.hear, undefined, { quiet: (p) => { quietOnes.push(p); return p < -50; }, junk: (t) => t === 'Part 2.' });
    h.accept();
    feed(h, speech(3));
    const heard = await h.finish();
    expect(heard.text).toBe('Part 1. Part 3.');
    expect(Math.max(...quietOnes)).toBeGreaterThan(-20);

    const g = fakeHear();
    const silent = new Hearing(g.hear, undefined, { quiet: () => true });
    silent.accept();
    feed(silent, speech(2));
    expect((await silent.finish()).text).toBe('');
    expect(g.asked).toHaveLength(0);
  });

  it('lastText waits for every segment sent', async () => {
    const f = fakeHear({ slow: [1] });
    const h = new Hearing(f.hear);
    expect(h.lastText).toBeNull();
    h.accept();
    feed(h, speech(2));
    expect(h.lastText).toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.lastText).toBeNull();
    await h.finish();
    expect(h.lastText).toBe('Part 2.');
  });
});
