/**
 * Stale-while-revalidate for screens that ask the computer for something (Settings › Usage, Storage): the last answer
 * shows at once, from the store, and the screen asks again in the background, swapping the new answer in when it
 * comes. Per computer: the store's `remembered` slice belongs to the computer on screen like its bots and chats, so a
 * cloud computer's goes into its sealed saved copy (features/cloud/cloudCacheData.ts) and comes back with it, asleep
 * or not; this Mac's is also kept in localStorage (lib/rememberedData.ts) for the next launch. An answer that arrives
 * after a switch to another computer is dropped. Asking a sleeping cloud computer fails quietly (`not_connected`), so
 * the remembered answer stays and nothing is woken.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { activeComputer } from './gateway';
import { MAC_KEY, withAnswer, type RememberedMap } from './rememberedData';
import { getState, setState, useStore } from './store';

let macTimer: ReturnType<typeof setTimeout> | null = null;
let macPending: RememberedMap | null = null;

function saveMac(m: RememberedMap): void {
  macPending = m;
  if (macTimer) return;
  macTimer = setTimeout(() => {
    macTimer = null;
    try { localStorage.setItem(MAC_KEY, JSON.stringify(macPending)); } catch { /* full: kept in memory */ }
  }, 1000);
}

/** Keep an answer for the computer it came from (dropped if another one is on screen now). */
export function remember(key: string, value: unknown, from = activeComputer()): void {
  if (from !== activeComputer()) return;
  const next = withAnswer(getState().remembered, key, value);
  setState({ remembered: next });
  if (from === 'local') saveMac(next);
}

/** Forget this Mac's remembered answers (and the window's). */
export function forgetMacRemembered(): void {
  try { localStorage.removeItem(MAC_KEY); } catch { /* fine */ }
}

/**
 * The screen's data: the remembered answer at once (with when it was read), a fresh one asked for on mount and when
 * `key` changes, and `reload` for a Read again button. `loading` is true while an ask runs.
 */
export function useRemembered<T>(key: string, load: () => Promise<T | undefined>): { data: T | null; at: number | null; loading: boolean; reload: () => Promise<void> } {
  const kept = useStore((s) => s.remembered[key]);
  const [loading, setLoading] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  // the latest ask wins (a range changed again before an answer)
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const n = ++seq.current;
    const from = activeComputer();
    setLoading(true);
    try {
      const v = await loadRef.current();
      if (n === seq.current && v !== undefined) remember(key, v, from);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [key]);
  useEffect(() => { void reload(); }, [reload]);
  return { data: (kept?.value as T | undefined) ?? null, at: kept?.at ?? null, loading, reload };
}
