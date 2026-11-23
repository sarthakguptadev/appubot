import { describe, expect, it } from 'vitest';
import { CLEAN_RUN, SKIP_BACKLOG, SLOW_BACKLOG, addRtt, newLink, nextTier } from './liveFrames';

describe('live-view tiers', () => {
  it('gives this Mac the best tier and fixed modes their tier', () => {
    expect(nextTier(newLink(true), 0, 'auto')).toBe(0);
    expect(nextTier(newLink(false), 0, 'best')).toBe(0);
    expect(nextTier(newLink(false), 0, 'balanced')).toBe(2);
    expect(nextTier(newLink(false), 0, 'saver')).toBe(4);
  });

  it('steps up after a run of clean frames and down when frames back up', () => {
    const link = newLink(false);
    for (let i = 0; i < CLEAN_RUN; i++) nextTier(link, 0, 'auto');
    expect(link.tier).toBe(1);
    for (let i = 0; i < CLEAN_RUN; i++) nextTier(link, 0, 'auto');
    expect(link.tier).toBe(0);
    expect(nextTier(link, SLOW_BACKLOG + 1, 'auto')).toBe(1);
    expect(nextTier(link, SLOW_BACKLOG + 1, 'auto')).toBe(2);
  });

  it('skips a frame when the socket is far behind, in any mode', () => {
    const link = newLink(false);
    expect(nextTier(link, SKIP_BACKLOG + 1, 'auto')).toBeNull();
    expect(link.tier).toBe(3);
    expect(nextTier(newLink(true), SKIP_BACKLOG + 1, 'best')).toBeNull();
  });

  it('caps quality on a slow round trip', () => {
    const link = newLink(false);
    addRtt(link, 900);
    for (let i = 0; i < 10; i++) nextTier(link, 0, 'auto');
    expect(link.tier).toBe(4);
    addRtt(link, 50); addRtt(link, 50); addRtt(link, 50); addRtt(link, 50); addRtt(link, 50); addRtt(link, 50);
    for (let i = 0; i < 20; i++) nextTier(link, 0, 'auto');
    expect(link.tier).toBe(0);
  });
});
