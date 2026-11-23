import { useEffect, useState } from 'react';

/** How long a menu or popover takes to leave (index.css `.ab-leaving`), in ms. */
export const LEAVE_MS = 130;

/**
 * Keeps something that closes on screen while it leaves: `mounted` stays true for `ms` after `open` turns false, and
 * `leaving` is true for that stretch (give the element `ab-leaving`, which plays the way out and takes no clicks).
 * Reopened meanwhile, it is simply open again.
 */
export function useLeaving(open: boolean, ms = LEAVE_MS): { mounted: boolean; leaving: boolean } {
  const [late, setLate] = useState(open);
  useEffect(() => {
    if (open) { setLate(true); return; }
    const t = setTimeout(() => setLate(false), ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return { mounted: open || late, leaving: !open && late };
}
