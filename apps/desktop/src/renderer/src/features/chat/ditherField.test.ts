import { describe, expect, it } from 'vitest';
import {
  BAYER8, DOT_DENSITY_MAX, DOT_FLOOR, FIELD_PATTERNS, RIPPLE_BAND_PX, RIPPLE_LIFETIME_MS, RIPPLE_SHOWS, RIPPLE_SPEED_PX_PER_MS,
  bayerThreshold, ditherOn, dotDensity, inkLevel, rippleAt, rippleDensity, sampleField, valueNoise3,
} from './ditherField';

/** how many of an 8×8 tile's dots are on for a level */
const lit = (level: number, dx = 0, dy = 0) => {
  let n = 0;
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) if (ditherOn(level, col + dx, row + dy)) n++;
  return n;
};

describe('the field (Synara’s)', () => {
  it('value noise stays in 0..1 and is smooth', () => {
    for (let i = 0; i < 500; i++) {
      const v = valueNoise3(i * 0.37, i * 0.11, i * 0.05);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(Math.abs(valueNoise3(3.2, 4.1, 0.5) - valueNoise3(3.201, 4.1, 0.5))).toBeLessThan(0.01);
  });

  it('every look samples within 0..1', () => {
    for (const p of FIELD_PATTERNS) {
      for (let i = 0; i < 200; i++) {
        const { patch, wave } = sampleField(p, i * 13, i * 7, 400, 300, 1000 + i * 0.3);
        expect(patch).toBeGreaterThanOrEqual(0);
        expect(patch).toBeLessThanOrEqual(1);
        expect(wave).toBeGreaterThanOrEqual(0);
        expect(wave).toBeLessThanOrEqual(1);
      }
    }
  });

  it('dims the middle to 45% and reaches full ink away from it, as Synara does', () => {
    expect(inkLevel(1, 1, 400, 300, 800, 600)).toBeCloseTo(0.45);
    expect(inkLevel(1, 1, 20, 20, 800, 600)).toBeCloseTo(1);
    expect(inkLevel(0, 1, 20, 20, 800, 600)).toBe(0);
    // the wave sets 40..100% of a blotch's ink
    expect(inkLevel(1, 0, 20, 20, 800, 600)).toBeCloseTo(0.4);
  });
});

describe('the dither', () => {
  it('the Bayer matrix holds every threshold once', () => {
    expect(BAYER8).toHaveLength(64);
    expect([...BAYER8].sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, i) => i));
    // the classic corner: 0 then 32 across, 48 down
    expect([BAYER8[0], BAYER8[1], BAYER8[8], BAYER8[9]]).toEqual([0, 32, 48, 16]);
    for (let i = 0; i < 64; i++) {
      const th = bayerThreshold(i % 8, i >> 3);
      expect(th).toBeGreaterThan(0);
      expect(th).toBeLessThan(1);
    }
  });

  it('lights k of every 64 dots for a level of k/64, wherever the tile falls', () => {
    expect(lit(0)).toBe(0);
    expect(lit(1)).toBe(64);
    for (let k = 0; k <= 64; k++) {
      expect(lit(k / 64)).toBe(k);
      expect(lit(k / 64, 13, 5)).toBe(k);
    }
  });

  it('a dot that is on stays on as the level rises (no flicker in a still or brightening field)', () => {
    for (let i = 0; i < 64; i++) {
      const col = i % 8;
      const row = i >> 3;
      let wasOn = false;
      for (let level = 0; level <= 1; level += 1 / 256) {
        const on = ditherOn(level, col, row);
        if (wasOn) expect(on).toBe(true);
        wasOn = on;
      }
      // and the same level always gives the same answer
      expect(ditherOn(0.3, col, row)).toBe(ditherOn(0.3, col + 8, row + 16));
    }
  });

  it('half the dots of a half-lit tile make a checkerboard', () => {
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) expect(ditherOn(0.5, col, row)).toBe((col + row) % 2 === 0);
    }
  });

  it('never fills a spot solid: the strongest blotch is a loose half-tone', () => {
    expect(dotDensity(0)).toBe(0);
    // the faintest ink lights nothing (no lone dots strewn over the empty field)
    expect(dotDensity(DOT_FLOOR)).toBe(0);
    expect(dotDensity(DOT_FLOOR + 0.1)).toBeGreaterThan(0);
    expect(dotDensity(1)).toBe(DOT_DENSITY_MAX);
    expect(dotDensity(3)).toBe(DOT_DENSITY_MAX);
    expect(dotDensity(-1)).toBe(0);
    expect(DOT_DENSITY_MAX).toBeLessThan(0.75);
  });
});

describe('ripples', () => {
  const shape = { ageMs: 1000, phaseA: 0, phaseB: 0 };
  const radius = 1000 * RIPPLE_SPEED_PX_PER_MS;

  it('rings out as a band that travels with its age and fades away', () => {
    // straight on the ring (the lobes are 0 at this angle and phase) it's strongest; well inside and outside, nothing
    const at = (r: number) => rippleAt(shape, r, 0, 0, 0);
    expect(at(radius + 0.0001)).toBeGreaterThan(0.3);
    expect(at(radius)).toBeGreaterThan(at(radius + RIPPLE_BAND_PX));
    expect(at(radius - 3 * RIPPLE_BAND_PX)).toBe(0);
    expect(at(radius + 3 * RIPPLE_BAND_PX)).toBe(0);
    expect(at(20)).toBe(0);
    // older, the band is farther out and fainter; gone at the end of its life
    const older = { ...shape, ageMs: 2000 };
    expect(rippleAt(older, 2000 * RIPPLE_SPEED_PX_PER_MS, 0, 0, 0)).toBeLessThan(at(radius));
    expect(rippleAt({ ...shape, ageMs: RIPPLE_LIFETIME_MS }, RIPPLE_LIFETIME_MS * RIPPLE_SPEED_PX_PER_MS, 0, 0, 0)).toBe(0);
  });

  it('draws the band denser than the field around it, densest across a blotch', () => {
    expect(rippleDensity(RIPPLE_SHOWS / 2, 0.5, 1)).toBe(0);
    expect(rippleDensity(0.8, 0.2, 0)).toBeGreaterThan(dotDensity(0.2));
    expect(rippleDensity(0.8, 0.2, 1)).toBeGreaterThan(rippleDensity(0.8, 0.2, 0));
    expect(rippleDensity(1, 1, 1)).toBe(1);
  });
});
