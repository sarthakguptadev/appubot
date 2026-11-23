import { describe, expect, it } from 'vitest';
import { createLoudness, playbackLevel, rmsDb, stepLoudness } from './levels';

describe('loudness', () => {
  it('measures RMS in dBFS', () => {
    expect(rmsDb(new Float32Array(512).fill(1))).toBeCloseTo(0, 5);
    expect(rmsDb(new Float32Array(512).fill(0.1))).toBeCloseTo(-20, 5);
    expect(rmsDb(new Float32Array(512))).toBeLessThan(-150);
  });

  it('reads speech over a quiet room as loud, the room itself as silence', () => {
    const s = createLoudness();
    for (let i = 0; i < 20; i++) stepLoudness(s, -65);
    expect(s.level).toBe(0);
    let level = 0;
    for (let i = 0; i < 4; i++) level = stepLoudness(s, -25);
    expect(level).toBeGreaterThan(0.5);
  });

  it('lets the floor fall at once but rise slowly, so steady noise fades out', () => {
    const s = createLoudness();
    stepLoudness(s, -80);
    expect(s.floor).toBe(-80);
    stepLoudness(s, -40);
    expect(s.floor).toBeCloseTo(-79.92, 5);
    let level = 0;
    for (let i = 0; i < 600; i++) level = stepLoudness(s, -40);
    expect(level).toBe(0);
  });

  it('maps playback to 0..1', () => {
    expect(playbackLevel(-80)).toBe(0);
    expect(playbackLevel(0)).toBe(1);
    expect(playbackLevel(-30)).toBeGreaterThan(0);
  });
});
