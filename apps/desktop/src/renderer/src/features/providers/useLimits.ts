/**
 * The agents' plan limits for the pickers and Settings › Usage: what the computer last read (the snapshot, then
 * `providers.limits` events), read again when a picker or Usage opens (`refreshLimits('stale')`: the computer only
 * reads what's over 5 min old) or the Refresh button is pressed (`'force'`). A computer from before plan limits
 * (`limitsSupported` false) is never asked.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ProviderLimits } from '@appubot/protocol';
import { call } from '../../lib/actions';
import { getState, setState, useStore } from '../../lib/store';

let inflight: Promise<void> | null = null;
let lastStaleAt = 0;
/** a stale read is asked at most this often from the window (the computer has its own, longer gap) */
const STALE_ASK_MS = 30_000;

/** Ask the computer to read the limits again; resolves once the store has the answer. */
export function refreshLimits(mode: 'stale' | 'force' = 'stale', ids?: string[]): Promise<void> {
  if (!getState().limitsSupported) return Promise.resolve();
  if (mode === 'stale' && Date.now() - lastStaleAt < STALE_ASK_MS) return inflight ?? Promise.resolve();
  if (inflight && mode === 'stale') return inflight;
  lastStaleAt = Date.now();
  const p = call('providers.limits', { refresh: mode, ...(ids ? { ids } : {}) }, { timeoutMs: 90_000, ...(mode === 'force' ? { errorTitle: 'Could not read the plan limits' } : {}) })
    .then((res) => {
      if (!res) return;
      if (ids) {
        const rest = getState().limits.filter((l) => !ids.includes(l.providerId));
        setState({ limits: [...rest, ...res.limits] });
      } else setState({ limits: res.limits });
    })
    .finally(() => { if (inflight === p) inflight = null; });
  inflight = p;
  return p;
}

/** One agent's limits from the store (undefined for an agent without any, or a computer from before). */
export function useLimits(providerId: string | undefined): ProviderLimits | undefined {
  const limits = useStore((s) => s.limits);
  return useMemo(() => (providerId ? limits.find((l) => l.providerId === providerId) : undefined), [limits, providerId]);
}

/** Every agent's limits, and a stale read asked once when the caller mounts (`on`). */
export function useAllLimits(on = true): ProviderLimits[] {
  const limits = useStore((s) => s.limits);
  useEffect(() => { if (on) void refreshLimits('stale'); }, [on]);
  return limits;
}

/** A clock that ticks every `ms` (countdowns to a reset), only while mounted. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
