/**
 * Pin always-on CSS animations to the document timeline origin (Synara's animationTimelineSync, MIT), so every
 * shimmer steps in the same frame instead of each one repainting the glass under it on its own schedule.
 */
export function syncAnimationsToTimelineOrigin(element: Element | null): void {
  if (!element || typeof element.getAnimations !== 'function') return;
  for (const animation of element.getAnimations()) {
    try {
      animation.startTime = 0;
    } catch {
      // a detached or finished animation cannot be re-timed
    }
  }
}
