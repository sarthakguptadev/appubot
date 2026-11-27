import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

const GAP = 6;
const EDGE = 8;

/**
 * A panel anchored to its trigger (the pickers'): in a portal, on its preferred side of the anchor unless the other
 * side has more room, shifted to stay inside the window and placed again as it grows or the page scrolls. Closes on a
 * click outside or Esc (which then goes no further, so a dialog behind it stays open; focus returns to the trigger).
 */
export function Popover({ open, onClose, anchor, side = 'bottom', align = 'start', className, children, label }: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  className?: string;
  children: ReactNode;
  label?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // the place is forgotten once the panel closes, so it opens measured afresh
  useEffect(() => { if (!open) setPos(null); }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = panel.current;
    const place = () => {
      const a = anchor.current;
      if (!a || !el) return;
      const r = a.getBoundingClientRect();
      const w = el.offsetWidth, h = el.offsetHeight;
      const vw = window.innerWidth, vh = window.innerHeight;
      const above = r.top - GAP - EDGE, below = vh - r.bottom - GAP - EDGE;
      const up = side === 'top' ? h <= above || above >= below : h > below && above > below;
      const top = up ? r.top - GAP - h : r.bottom + GAP;
      const left = align === 'end' ? r.right - w : r.left;
      setPos({
        top: Math.min(Math.max(top, EDGE), Math.max(EDGE, vh - EDGE - h)),
        left: Math.min(Math.max(left, EDGE), Math.max(EDGE, vw - EDGE - w)),
      });
    };
    place();
    const ro = new ResizeObserver(place);
    if (el) ro.observe(el);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { ro.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, side, align, anchor]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor.current?.contains(t)) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      close.current();
      anchor.current?.querySelector<HTMLElement>('button')?.focus();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true); };
  }, [open, anchor]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      // placed off-screen until measured (not hidden: its search field takes focus as it opens)
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
      className={cn('glass-popover no-drag fixed z-[70] flex max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] flex-col overflow-hidden', className)}
    >
      {children}
    </div>,
    document.body,
  );
}
