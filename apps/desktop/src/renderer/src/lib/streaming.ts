/**
 * Streaming hooks ported from Synara (apps/web/src/hooks/useSmoothStreamedText.ts and
 * useThrottledStreamingValue.ts, MIT © T3 Tools Inc., Emanuele Di Pietro).
 *
 * Deltas land in the store in network clumps (the gateway coalesces them every ~30ms, the agent sends them in
 * bursts), so rendering each clump verbatim looks choppy. `useSmoothStreamedText` drains the already-delivered
 * text on requestAnimationFrame at a velocity that adapts to the backlog, low-pass smooths that velocity so there
 * are no speed jumps, and sleeps once it catches up. React commits are capped at ~25/s; the reveal itself still
 * advances every frame. `useThrottledStreamingValue` rate-limits consumers whose cost grows with the value
 * (re-highlighting a growing code block) without ever dropping the final value.
 */
import { useEffect, useRef, useState } from 'react';
import { createSmoothRevealState, isAppendOnly, stepSmoothReveal, type SmoothRevealState } from '@appubot/chat-core';

/* ---------- smooth reveal (the stepper lives in @appubot/chat-core, shared with the phone) ---------- */

function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduce, setReduce] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setReduce(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduce;
}

/**
 * Smoothly reveal `text` while `isStreaming`. Returns `text` unchanged when not streaming or under reduced motion;
 * snaps to the full text the moment streaming ends; text already present on mount shows immediately.
 */
export function useSmoothStreamedText(text: string, isStreaming: boolean): string {
  const reduceMotion = usePrefersReducedMotion();
  const animate = isStreaming && !reduceMotion && typeof requestAnimationFrame === 'function';

  const [revealed, setRevealed] = useState(text);
  const targetRef = useRef(text);
  const stateRef = useRef<SmoothRevealState>(createSmoothRevealState(text.length));
  const emittedRef = useRef(text.length);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const tick = (now: number) => {
      rafRef.current = null;
      const target = targetRef.current;
      const step = stepSmoothReveal(stateRef.current, now, target.length, emittedRef.current);
      if (step.emitCount !== null) {
        emittedRef.current = step.emitCount;
        setRevealed(step.emitCount >= target.length ? target : target.slice(0, step.emitCount));
      }
      if (!step.done) rafRef.current = requestAnimationFrame(tick);
      // when done the loop sleeps; the next text change wakes it
    };

    const prev = targetRef.current;
    const appendOnly = isAppendOnly(prev, text);
    targetRef.current = text;

    if (!animate || !appendOnly) {
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      stateRef.current = createSmoothRevealState(text.length);
      emittedRef.current = text.length;
      setRevealed(text);
      return;
    }
    if (text.length > stateRef.current.shown && rafRef.current == null) rafRef.current = requestAnimationFrame(tick);
  }, [animate, text]);

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  return animate ? revealed : text;
}

/* ---------- throttled consumers ---------- */

/** First change passes immediately, later ones coalesce to one per `intervalMs` (trailing edge always lands). */
export function useThrottledStreamingValue<T>(value: T, active: boolean, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastCommitAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);

  useEffect(() => {
    latest.current = value;
    if (!active) {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      lastCommitAt.current = 0;
      setThrottled(value);
      return;
    }
    const elapsed = lastCommitAt.current === 0 ? Infinity : performance.now() - lastCommitAt.current;
    if (elapsed >= intervalMs) {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      lastCommitAt.current = performance.now();
      setThrottled(value);
      return;
    }
    if (timer.current) return; // a trailing commit is scheduled; it reads the latest value
    timer.current = setTimeout(() => {
      timer.current = null;
      lastCommitAt.current = performance.now();
      setThrottled(latest.current);
    }, Math.max(0, intervalMs - elapsed));
  }, [active, intervalMs, value]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return active ? throttled : value;
}
