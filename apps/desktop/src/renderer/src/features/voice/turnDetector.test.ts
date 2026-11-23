import { describe, expect, it } from 'vitest';
import { BARGE_IN_MS, ECHO_WINDOW_MS, VOICE_DB_MARGIN } from './bargeIn';
import { LEVEL_INTERVAL_MS } from './levels';
import { END_QUIET_MS, IDLE_RESTART_MS, MAX_TURN_MS, TurnDetector, type TurnSignal } from './turnDetector';

/** Feeds `level` for `ms` (the bot playing at `output`), one tick every 80 ms; returns the signals with their time. */
function run(d: TurnDetector, clock: { now: number }, level: number, ms: number, output = 0): [number, TurnSignal][] {
  const out: [number, TurnSignal][] = [];
  for (let t = 0; t < ms; t += LEVEL_INTERVAL_MS) {
    clock.now += LEVEL_INTERVAL_MS;
    const s = d.feed(level, clock.now, output);
    if (s) out.push([clock.now, s]);
  }
  return out;
}

const signals = (r: [number, TurnSignal][]) => r.map(([, s]) => s).filter((s) => s !== 'restart');

describe('TurnDetector', () => {
  it('hears speech after 240 ms and ends the turn after 0.7 s of quiet', () => {
    const d = new TurnDetector();
    const clock = { now: 0 };
    d.reset(0);
    expect(run(d, clock, 0.6, 160)).toEqual([]);
    expect(run(d, clock, 0.6, 80)).toEqual([[240, 'speech']]);
    run(d, clock, 0.6, 800);
    const quietFrom = clock.now;
    const end = run(d, clock, 0.05, 2000).find(([, s]) => s === 'end');
    expect(end).toBeDefined();
    expect(end![0] - quietFrom).toBeGreaterThanOrEqual(END_QUIET_MS);
    expect(end![0] - quietFrom).toBeLessThan(END_QUIET_MS + 2 * LEVEL_INTERVAL_MS);
    expect(END_QUIET_MS).toBe(700);
  });

  it('a pause shorter than the end’s doesn’t end the turn', () => {
    const d = new TurnDetector();
    const clock = { now: 0 };
    d.reset(0);
    run(d, clock, 0.6, 400);
    expect(run(d, clock, 0.05, END_QUIET_MS - 2 * LEVEL_INTERVAL_MS).map(([, s]) => s)).toEqual([]);
    run(d, clock, 0.6, 400);
    expect(run(d, clock, 0.05, END_QUIET_MS + LEVEL_INTERVAL_MS)[0]?.[1]).toBe('end');
  });

  it('ignores a short sound, and a quiet recording starts over every few seconds', () => {
    const d = new TurnDetector();
    const clock = { now: 0 };
    d.reset(0);
    expect(run(d, clock, 0.6, 160)).toEqual([]);
    const restart = run(d, clock, 0, IDLE_RESTART_MS).find(([, s]) => s === 'restart');
    expect(restart?.[0]).toBe(IDLE_RESTART_MS);
    expect(d.heard).toBe(false);
  });

  it('while the bot thinks, only a louder, longer voice makes a candidate', () => {
    const d = new TurnDetector();
    const clock = { now: 0 };
    d.reset(0, true);
    expect(signals(run(d, clock, 0.4, 1000))).toEqual([]);
    expect(run(d, clock, 0.7, BARGE_IN_MS - LEVEL_INTERVAL_MS)).toEqual([]);
    expect(signals(run(d, clock, 0.7, LEVEL_INTERVAL_MS))).toEqual(['candidate']);
    expect(d.candidate).toMatchObject({ level: 0.7, echo: 0, need: 0.5 });
    expect(d.candidate!.runMs).toBeGreaterThanOrEqual(BARGE_IN_MS);
    // what follows is a turn like any other
    expect(d.guard).toBe(false);
    expect(signals(run(d, clock, 0, 1400))).toContain('end');
  });

  it('while the bot speaks, the voice must beat its echo', () => {
    const d = new TurnDetector();
    const clock = { now: 0 };
    d.reset(0, true);
    // the bot plays at 0.7: its echo at 0.65 never makes a candidate, however long
    expect(signals(run(d, clock, 0.65, 3000, 0.7))).toEqual([]);
    // the same loudness with nothing playing would
    expect(signals(run(d, clock, 0.65, 1000, 0))).toEqual(['candidate']);

    const e = new TurnDetector();
    const c = { now: 0 };
    e.reset(0, true);
    // a voice well above the echo
    expect(signals(run(e, c, 0.9, 1000, 0.7))).toEqual(['candidate']);
    expect(e.candidate).toMatchObject({ echo: 0.7 });
    expect(e.candidate!.need).toBeCloseTo(0.71);
  });

  it('the echo still counts for a moment after the output stops', () => {
    const d = new TurnDetector();
    const clock = { now: 0 };
    d.reset(0, true);
    run(d, clock, 0.1, 400, 0.8);
    const stopped = clock.now;
    // a voice as loud as the echo could be: the run only starts once the bot's last sound is out of the window
    const at = run(d, clock, 0.7, 2000, 0).find(([, s]) => s === 'candidate')![0] - stopped;
    expect(at).toBeGreaterThanOrEqual(ECHO_WINDOW_MS + BARGE_IN_MS);
    expect(at).toBeLessThan(ECHO_WINDOW_MS + BARGE_IN_MS + 2 * LEVEL_INTERVAL_MS);
  });

  it('a short dip doesn’t break a cut-in, a longer one starts it over', () => {
    const d = new TurnDetector();
    const clock = { now: 0 };
    d.reset(0, true);
    run(d, clock, 0.8, 320);
    run(d, clock, 0.2, 80);
    expect(signals(run(d, clock, 0.8, 240))).toEqual(['candidate']);

    const e = new TurnDetector();
    const c = { now: 0 };
    e.reset(0, true);
    run(e, c, 0.8, 320);
    run(e, c, 0.2, 240);
    expect(signals(run(e, c, 0.8, 320))).toEqual([]);
    expect(signals(run(e, c, 0.8, 240))).toEqual(['candidate']);
  });

  it('ends a turn that runs too long', () => {
    const d = new TurnDetector();
    const clock = { now: 0 };
    d.reset(0);
    const signals = run(d, clock, 0.8, MAX_TURN_MS + 200);
    expect(signals[0]![1]).toBe('speech');
    expect(signals.find(([, s]) => s === 'end')?.[0]).toBe(MAX_TURN_MS);
  });

  it('takes no candidate far fainter than your learned voice: says faint once', () => {
    const d = new TurnDetector();
    d.voiceDb = -20;
    d.reset(0, true);
    const got: TurnSignal[] = [];
    for (let now = 80; now <= 2000; now += LEVEL_INTERVAL_MS) {
      const s = d.feed(0.7, now, 0, -20 - VOICE_DB_MARGIN - 10);
      if (s) got.push(s);
    }
    expect(got).toEqual(['faint']);
    const e = new TurnDetector();
    e.voiceDb = -20;
    e.reset(0, true);
    let cand: TurnSignal = null;
    for (let now = 80; now <= 2000 && !cand; now += LEVEL_INTERVAL_MS) cand = e.feed(0.7, now, 0, -22) === 'candidate' ? 'candidate' : null;
    expect(cand).toBe('candidate');
  });

  it('ends after `endQuietMs`, asked again every tick (a shorter one ends a long quiet at once)', () => {
    const d = new TurnDetector();
    const clock = { now: 0 };
    d.reset(0);
    d.endQuietMs = 1800;
    run(d, clock, 0.6, 800);
    expect(run(d, clock, 0.05, 1200).map(([, s]) => s)).toEqual([]);
    d.endQuietMs = 900;
    clock.now += LEVEL_INTERVAL_MS;
    expect(d.feed(0.05, clock.now)).toBe('end');
  });
});
