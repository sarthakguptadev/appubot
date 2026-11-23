import { describe, expect, it } from 'vitest';
import { MIN_EMIT_INTERVAL_MS, createSmoothRevealState, stepSmoothReveal, streamingCodeHighlightIntervalMs } from './streaming';

/** Drive the stepper like rAF at `fps` until it reports done; returns the committed counts. */
function run(target: number, fps = 60, from = 0) {
  const s = createSmoothRevealState(from);
  const commits: { at: number; count: number }[] = [];
  let emitted = from;
  for (let frame = 0, now = 1000; frame < 2000; frame++, now += 1000 / fps) {
    const step = stepSmoothReveal(s, now, target, emitted);
    if (step.emitCount !== null) { emitted = step.emitCount; commits.push({ at: now, count: step.emitCount }); }
    if (step.done) break;
  }
  return commits;
}

describe('smooth streamed text', () => {
  it('reveals a clump over several frames instead of all at once, and lands exactly on the end', () => {
    const commits = run(400);
    expect(commits.length).toBeGreaterThan(4);
    expect(commits[0]!.count).toBeLessThan(400);
    expect(commits.at(-1)!.count).toBe(400);
    for (let i = 1; i < commits.length; i++) expect(commits[i]!.count).toBeGreaterThan(commits[i - 1]!.count);
  });

  it('commits at most ~25 times a second (except the final catch-up)', () => {
    const commits = run(3000, 120);
    for (let i = 1; i < commits.length - 1; i++) expect(commits[i]!.at - commits[i - 1]!.at).toBeGreaterThanOrEqual(MIN_EMIT_INTERVAL_MS - 1e-6);
  });

  it('is done immediately when nothing is behind', () => {
    const s = createSmoothRevealState(50);
    expect(stepSmoothReveal(s, 1000, 50, 50)).toEqual({ emitCount: null, done: true });
  });

  it('stretches code re-highlighting with block size', () => {
    expect(streamingCodeHighlightIntervalMs(500)).toBe(160);
    expect(streamingCodeHighlightIntervalMs(44_000)).toBeGreaterThan(160);
    expect(streamingCodeHighlightIntervalMs(200_000)).toBe(1000);
  });
});
