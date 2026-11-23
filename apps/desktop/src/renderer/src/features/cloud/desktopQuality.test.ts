import { describe, expect, it } from 'vitest';
import { AUTO_START, HEAVY_BPS, LIGHT_BPS, RECONNECT_GIVE_UP, STEP_MS, STEP_UP_MS, autoStart, rateOver, rateText, reconnectDelayMs, stepQuality } from './desktopQuality';

describe('the desktop viewer’s auto quality', () => {
  it('goes a step cheaper while the stream is heavy, no faster than every couple of seconds', () => {
    let s = autoStart(1000);
    s = stepQuality(s, HEAVY_BPS, 1000);
    expect(s.quality).toBe(AUTO_START.quality - 1);
    expect(s.compression).toBe(AUTO_START.compression + 1);
    // too soon for another step
    s = stepQuality(s, HEAVY_BPS * 2, 1000 + STEP_MS / 2);
    expect(s.quality).toBe(AUTO_START.quality - 1);
    s = stepQuality(s, HEAVY_BPS * 2, 1000 + STEP_MS);
    expect(s.quality).toBe(AUTO_START.quality - 2);
    // never below the floor
    for (let i = 0; i < 20; i++) s = stepQuality(s, HEAVY_BPS, 1000 + STEP_MS * (i + 2));
    expect(s.quality).toBe(2);
  });

  it('comes back up only after the stream has been light for a while, and never above the best', () => {
    let s = { quality: 3, compression: 5, lightSince: 0, steppedAt: 0 };
    s = stepQuality(s, 0, 1000);
    expect(s.quality).toBe(3);
    s = stepQuality(s, 0, STEP_UP_MS + 1);
    expect(s.quality).toBe(4);
    // a middling stream holds where it is
    const held = stepQuality(s, (HEAVY_BPS + LIGHT_BPS) / 2, STEP_UP_MS * 3);
    expect(held.quality).toBe(4);
    expect(held.lightSince).toBe(STEP_UP_MS * 3);
    let t = STEP_UP_MS * 3;
    for (let i = 0; i < 20; i++) { t += STEP_UP_MS + 1; s = stepQuality(s, 0, t); }
    expect(s.quality).toBe(8);
  });

  it('measures the rate over a window and words it', () => {
    const samples = [{ at: 0, bytes: 500 }, { at: 1500, bytes: 1000 }, { at: 2900, bytes: 1000 }];
    expect(rateOver(samples, 3000, 2000)).toBe(1000);
    expect(rateText(1_234_567)).toBe('1.2 MB/s');
    expect(rateText(340_000)).toBe('340 KB/s');
  });

  it('reconnects with a growing wait and gives up after a while', () => {
    expect([1, 2, 3, 4, 5].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(RECONNECT_GIVE_UP).toBeGreaterThan(4);
  });
});
