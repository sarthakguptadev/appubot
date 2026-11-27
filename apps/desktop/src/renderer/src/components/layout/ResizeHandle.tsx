import { useRef, type PointerEvent } from 'react';
import { cn } from '../ui';

/** Vertical drag handle. `side` = which edge of the resized pane it sits on. */
export function ResizeHandle({ width, onWidth, min, max, side, onReset, label = 'Resize' }: {
  width: number; onWidth: (w: number) => void; min: number; max: number; side: 'left' | 'right'; onReset?: () => void;
  /** what it resizes, for screen readers ("Resize sidebar") */
  label?: string;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: width };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    const next = side === 'right' ? start.current.w + dx : start.current.w - dx;
    onWidth(Math.min(max, Math.max(min, next)));
  };
  const onUp = () => { start.current = null; };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      // the system took the pointer (a gesture, a window switch): end the drag, or the next hover would resize
      onPointerCancel={onUp}
      onLostPointerCapture={onUp}
      onDoubleClick={onReset}
      className={cn('no-drag group absolute top-0 bottom-0 z-10 w-2 cursor-col-resize', side === 'right' ? '-right-1' : '-left-1')}
    >
      {/* the hover line: the app's ink, a step stronger than a hairline (it was an indigo no other control used) */}
      <div className="mx-auto h-full w-px bg-transparent group-hover:bg-[color-mix(in_srgb,var(--ab-fg)_20%,transparent)] group-active:bg-[color-mix(in_srgb,var(--ab-fg)_32%,transparent)]" />
    </div>
  );
}
