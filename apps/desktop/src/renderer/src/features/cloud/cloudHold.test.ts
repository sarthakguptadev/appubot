import { describe, expect, it } from 'vitest';
import { AWAY_MS, IDLE_CLOSE_MS, holdLeftMs, holdsCloud } from './cloudHold';

const M = 60_000;

describe('cloudHold: when the desktop keeps the cloud computer connected', () => {
  it('holds while the window is in front and touched within AWAY_MS', () => {
    expect(holdsCloud({ visible: true, focused: true, sinceLookMs: 0 })).toBe(true);
    expect(holdsCloud({ visible: true, focused: true, sinceLookMs: 20 * M })).toBe(true);
    expect(holdsCloud({ visible: true, focused: true, sinceLookMs: AWAY_MS })).toBe(false);
    expect(holdLeftMs({ visible: true, focused: true, sinceLookMs: 10 * M })).toBe(AWAY_MS - 10 * M);
  });
  it('visible behind another app: only IDLE_CLOSE_MS after the last look', () => {
    expect(holdsCloud({ visible: true, focused: false, sinceLookMs: 4 * M })).toBe(true);
    expect(holdsCloud({ visible: true, focused: false, sinceLookMs: IDLE_CLOSE_MS })).toBe(false);
    expect(holdLeftMs({ visible: true, focused: false, sinceLookMs: 4 * M })).toBe(M);
  });
  it('hidden: never', () => {
    expect(holdsCloud({ visible: false, focused: true, sinceLookMs: 0 })).toBe(false);
    expect(holdLeftMs({ visible: false, focused: true, sinceLookMs: 0 })).toBe(0);
  });
  it('the values: 5 min behind, 30 min in front', () => {
    expect(IDLE_CLOSE_MS).toBe(5 * M);
    expect(AWAY_MS).toBe(30 * M);
  });
});
