import { useCallback, useEffect, useRef, useState } from 'react';

/** Re-render on an interval (for relative timestamps). */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Global keyboard shortcut (Cmd on mac / Ctrl elsewhere). */
export function useHotkey(
  match: (e: KeyboardEvent) => boolean,
  handler: (e: KeyboardEvent) => void,
  enabled = true,
): void {
  const h = useLatest(handler);
  const m = useLatest(match);
  useEffect(() => {
    if (!enabled) return;
    const fn = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (m.current(e)) { e.preventDefault(); h.current(e); }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [enabled, h, m]);
}

export const mod = (e: KeyboardEvent | React.KeyboardEvent): boolean => e.metaKey || e.ctrlKey;

/**
 * Saves as edits are made, with no Save button: `queue(run)` keeps the latest save and runs it `delay` ms after the
 * last edit, `flush()` runs it now (leaving the field, another bot on screen, the view going away, which also flushes
 * by itself). Saves run one at a time in the order made, so an older one never lands over a newer one. `busy` is true
 * from an edit until its save has come back. `run` carries what it saves (the id and the text as they were then).
 */
export function useAutoSave(delay = 700): { queue: (run: () => Promise<unknown>) => void; flush: () => void; busy: boolean } {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const next = useRef<(() => Promise<unknown>) | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const alive = useRef(true);
  const [busy, setBusy] = useState(false);
  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const run = next.current;
    next.current = null;
    if (!run) return;
    chain.current = chain.current.then(run).catch(() => undefined).then(() => {
      if (alive.current && !next.current && !timer.current) setBusy(false);
    });
  }, []);
  const queue = useCallback((run: () => Promise<unknown>) => {
    next.current = run;
    setBusy(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, delay);
  }, [flush, delay]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; flush(); };
  }, [flush]);
  return { queue, flush, busy };
}
