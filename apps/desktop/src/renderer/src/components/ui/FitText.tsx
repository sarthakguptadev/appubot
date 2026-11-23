import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from './cn';

/**
 * One line of text that shows the longest of `steps` that fits its room, and truncates the last ("Sarthak’s Cloud
 * Computer" → "Sarthak’s Cloud", chat-core `computerNameSteps`). It shrinks like a `truncate` span (`min-w-0`); when
 * the closest `[data-fit-root]` (else the parent) changes size, it starts again from the longest. `title` keeps the
 * full name for hover and screen readers.
 */
export function FitText({ steps, className }: { steps: string[]; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const key = steps.join('\n');
  const [i, setI] = useState(0);
  // new names: from the longest again
  useLayoutEffect(() => setI(0), [key]);
  // after each render: this one doesn't fit and a shorter one exists → the next (before paint, so no flash)
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && i < steps.length - 1 && el.scrollWidth > el.clientWidth + 0.5) setI(i + 1);
  });
  // the room changed: try the longest again (the effect above steps down from there)
  useEffect(() => {
    const el = ref.current;
    const root = (el?.closest('[data-fit-root]') as HTMLElement | null) ?? el?.parentElement;
    if (!root) return;
    let last = root.clientWidth;
    const ro = new ResizeObserver(() => {
      if (root.clientWidth === last) return;
      last = root.clientWidth;
      setI(0);
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, []);
  const text = steps[Math.min(i, steps.length - 1)] ?? '';
  return <span ref={ref} title={steps[0]} className={cn('min-w-0 truncate', className)}>{text}</span>;
}
