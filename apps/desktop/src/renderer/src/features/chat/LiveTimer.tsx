import { useEffect, useRef } from 'react';
import { formatClockDuration } from '@appubot/chat-core';
import { startVisibleInterval } from '../../lib/visibleInterval';

/**
 * Elapsed time ("12s", "1m 4s") that writes its own text node every second, so ticking never re-renders React
 * (Synara's LiveElapsedTimer, MIT). Stops ticking while the window is hidden.
 */
export function LiveElapsed({ since, className }: { since: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const tick = () => { if (ref.current) ref.current.textContent = formatClockDuration(Date.now() - since); };
    tick();
    return startVisibleInterval(tick, 1000);
  }, [since]);
  return <span ref={ref} className={className}>{formatClockDuration(Date.now() - since)}</span>;
}
