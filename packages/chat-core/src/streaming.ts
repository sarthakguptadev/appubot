/**
 * The pure parts of the streaming text reveal, ported from Synara (apps/web/src/hooks/useSmoothStreamedText.ts and
 * useThrottledStreamingValue.ts, MIT © T3 Tools Inc., Emanuele Di Pietro). Each client drives the stepper from its
 * own frame loop (the desktop renderer and the phone both use requestAnimationFrame).
 *
 * Deltas land in the store in network clumps (the gateway coalesces them every ~30ms, the agent sends them in
 * bursts), so rendering each clump verbatim looks choppy. The stepper drains the already-delivered text at a
 * velocity that adapts to the backlog, low-pass smooths that velocity so there are no speed jumps, and sleeps once
 * it catches up. Commits are capped at ~25/s; the reveal itself still advances every frame.
 */

// Drain the current backlog over this window: a small cushion remains so the reveal tracks inflow without running dry.
const DRAIN_WINDOW_SECONDS = 0.16;
// A single huge flush (a pasted code block) reveals fast but bounded instead of snapping in.
const MAX_CHARS_PER_SECOND = 2000;
// How aggressively the live velocity chases the target each frame (~110ms time constant at 60fps).
const VELOCITY_LERP = 0.15;
// Returning from a backgrounded window (rAF paused) must not dump the whole backlog in one frame.
const MAX_FRAME_SECONDS = 0.05;
// Minimum spacing between commits.
export const MIN_EMIT_INTERVAL_MS = 40;

export interface SmoothRevealState {
  /** revealed character count, accumulated as a float across frames */
  shown: number;
  /** smoothed reveal velocity (chars/second) */
  velocity: number;
  /** previous frame timestamp (ms); 0 marks the start of a fresh burst */
  lastFrameAt: number;
  /** last commit timestamp (ms); 0 forces the next commit immediately */
  lastEmitAt: number;
}

export function createSmoothRevealState(shown: number): SmoothRevealState {
  return { shown, velocity: 0, lastFrameAt: 0, lastEmitAt: 0 };
}

/** Advance the reveal by one animation frame (mutates `state`). Pure apart from that, so it is unit-testable. */
export function stepSmoothReveal(state: SmoothRevealState, nowMs: number, targetLength: number, emittedCount: number): { emitCount: number | null; done: boolean } {
  const dt = state.lastFrameAt ? Math.min((nowMs - state.lastFrameAt) / 1000, MAX_FRAME_SECONDS) : 0;
  state.lastFrameAt = nowMs;
  if (state.shown > targetLength) state.shown = targetLength;

  const backlog = targetLength - state.shown;
  if (backlog <= 0) {
    state.velocity = 0;
    state.lastFrameAt = 0;
    return { emitCount: null, done: true };
  }

  const targetVelocity = Math.min(MAX_CHARS_PER_SECOND, backlog / DRAIN_WINDOW_SECONDS);
  state.velocity += (targetVelocity - state.velocity) * VELOCITY_LERP;
  state.shown = Math.min(targetLength, state.shown + state.velocity * dt);
  // the damped tail can approach the target without ever reaching it at high refresh rates
  if (targetLength - state.shown < 0.001) state.shown = targetLength;

  const nextCount = Math.floor(state.shown);
  const caughtUp = nextCount >= targetLength;
  const emitDue = nextCount !== emittedCount && (caughtUp || state.lastEmitAt === 0 || nowMs - state.lastEmitAt >= MIN_EMIT_INTERVAL_MS);
  if (emitDue) state.lastEmitAt = nowMs;

  const done = targetLength - state.shown <= 0;
  if (done) {
    state.velocity = 0;
    state.lastFrameAt = 0;
  }
  return { emitCount: emitDue ? nextCount : null, done };
}

/** Whether `next` only appends to `prev` (a reveal can continue); anything else snaps to the new text. */
export const isAppendOnly = (prev: string, next: string): boolean => next.length >= prev.length && next.startsWith(prev);

/* ---------- throttled consumers ---------- */

// Re-highlighting a growing code block costs roughly linearly in its length: small blocks re-highlight every
// 160ms while streaming, an 80k-char block at most once a second.
const CODE_HIGHLIGHT_INTERVAL_MS = 160;
const CODE_HIGHLIGHT_MAX_INTERVAL_MS = 1000;
const CODE_HIGHLIGHT_BASE_CHARS = 8000;
const CODE_HIGHLIGHT_SLOW_CHARS = 80000;

export function streamingCodeHighlightIntervalMs(codeLength: number): number {
  if (codeLength <= CODE_HIGHLIGHT_BASE_CHARS) return CODE_HIGHLIGHT_INTERVAL_MS;
  const progress = Math.min(1, (codeLength - CODE_HIGHLIGHT_BASE_CHARS) / (CODE_HIGHLIGHT_SLOW_CHARS - CODE_HIGHLIGHT_BASE_CHARS));
  return Math.round(CODE_HIGHLIGHT_INTERVAL_MS + progress * (CODE_HIGHLIGHT_MAX_INTERVAL_MS - CODE_HIGHLIGHT_INTERVAL_MS));
}
