import { useEffect, useState } from 'react';

/**
 * How long the app keeps quiet about a connection that isn't up. Opening the app, switching computer, a dropped
 * socket or a cloud computer waking all reconnect, and meanwhile the window shows what it has (a cloud computer's saved
 * copy, this Mac's last state) and loads behind it: no "Waking…", "Reconnecting…" or spinner. Only a connection down
 * for `CONNECT_QUIET_MS` (30 s) is said, with Try again. Refusals retrying can't fix (signed out, too old) and states
 * that stop a cloud computer (payment on hold, plan ended) are still said at once. The phone app does the
 * same.
 */
export const CONNECT_QUIET_MS = 30_000;

/** `on` has held for `ms` (false again as soon as it stops) */
export function useHeldFor(on: boolean, ms = CONNECT_QUIET_MS): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!on) { setHeld(false); return; }
    const t = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return held;
}
