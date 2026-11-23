/**
 * Presentation-only ticking (Synara's startVisibleInterval, MIT): pauses while the window is hidden and
 * re-reads wall time on resume instead of replaying missed ticks. Not for anything but labels.
 */
export function startVisibleInterval(onTick: () => void, intervalMs: number): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;
  let refresh: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    if (refresh !== null) { clearTimeout(refresh); refresh = null; }
    if (interval !== null) { clearInterval(interval); interval = null; }
  };

  const sync = () => {
    if (document.visibilityState !== 'visible') { stop(); return; }
    if (interval !== null) return;
    // refresh right away (asynchronously) so the label is current after resuming
    refresh = setTimeout(() => { refresh = null; onTick(); }, 0);
    interval = setInterval(onTick, intervalMs);
  };

  document.addEventListener('visibilitychange', sync);
  sync();
  return () => {
    document.removeEventListener('visibilitychange', sync);
    stop();
  };
}
