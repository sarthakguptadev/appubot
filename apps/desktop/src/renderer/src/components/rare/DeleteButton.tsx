/**
 * A delete button that asks in place: pressing the bin opens its lid and the tile widens to a tick and a cross
 * beside it; the tick deletes (the bin gives way to a drawn tick), the cross or Escape closes it again. For rows
 * where a whole dialog is more than the question deserves.
 *
 * From Rare UI (rareui.com), `components/ui/delete-button.tsx`.
 * Copyright (c) 2026 Swami Malode. MIT + Commons Clause + Attribution: see apps/desktop/scripts/licenses/RareUI.txt.
 *
 * Changed for AppuBot: sized by `size` (the tile's edge, 32 by default to sit in a settings row; upstream is 48)
 * with the panel, circles and glyphs scaled from it; `label` names what is deleted for screen readers, `busy`
 * holds it while the delete is under way; a click outside closes it like the cross; the app's colours (the tick
 * in the danger red) and squircle corners.
 */
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { animate, AnimatePresence, motion, useMotionTemplate, useMotionValue, useReducedMotion, useTransform, type Transition } from 'motion/react';
import { cn } from '../ui/cn';

const HINGE = '3px 6px';
const LID_OPEN = -35;
const WALL_TOP = 6;
const WALL_TOP_OPEN = 13.5;
const WALL_BASE = 20;

const HOLD = { deleted: 1400, kept: 600 };

const EASE = [0.32, 0.72, 0, 1] as const;
const EASE_LID = [0.34, 1.1, 0.64, 1] as const;

const WIDTH = { duration: 0.62, ease: EASE } as const;
const LID = { duration: 0.6, ease: EASE_LID } as const;
const WALL = { duration: 0.56, ease: EASE } as const;
const IN = { duration: 0.44, ease: EASE, delay: 0.14 } as const;
const OUT = { duration: 0.3, ease: EASE } as const;
const TAP = { duration: 0.2, ease: EASE } as const;
const SWAP = { duration: 0.22, ease: EASE } as const;
const SETTLE = { duration: 0.45, ease: EASE } as const;
const PRESS = { type: 'spring', stiffness: 520, damping: 18, mass: 0.5 } as const;
const INSTANT = { duration: 0 } as const;

const SURFACE = 'bg-surface-2';
const RECESS = 'bg-surface-3';
const GLYPH = 'text-muted';
const FOCUS = 'outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]';
const ACCENT = 'var(--ab-danger)';

const ICON = { viewBox: '0 0 24 24', fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

const panelMotion = {
  hidden: { opacity: 0, x: -6, transition: OUT },
  shown: { opacity: 1, x: 0, transition: { ...IN, staggerChildren: 0.07 } },
};

const circleMotion = {
  hidden: { opacity: 0, scale: 0.9, transition: OUT },
  shown: { opacity: 1, scale: 1, transition: IN },
};

function Circle({ label, onClick, edge, children }: { label: string; onClick: () => void; edge: number; children: ReactNode }) {
  const reduced = useReducedMotion() ?? false;
  return (
    <motion.div className="flex" variants={reduced ? undefined : circleMotion}>
      <motion.button
        type="button"
        aria-label={label}
        onClick={onClick}
        whileHover={reduced ? undefined : { scale: 1.03 }}
        whileTap={reduced ? undefined : { scale: 0.84 }}
        transition={PRESS}
        style={{ width: edge, height: edge }}
        className={cn('grid place-items-center rounded-full bg-surface text-fg-2 shadow-lift transition-colors duration-200 hover:text-fg dark:bg-[rgba(255,255,255,.12)]', FOCUS)}
      >
        <svg {...ICON} width={edge / 2} height={edge / 2} stroke="currentColor" strokeWidth="3.5">{children}</svg>
      </motion.button>
    </motion.div>
  );
}

type Status = 'idle' | 'deleted' | 'kept';

export type DeleteButtonProps = Omit<ComponentProps<'div'>, 'onAnimationStart' | 'onDrag' | 'onDragStart' | 'onDragEnd'> & {
  onConfirm?: () => void;
  onCancel?: () => void;
  /** the tile's edge, px */
  size?: number;
  /** what the bin deletes, for screen readers ("Remove GitHub") */
  label?: string;
  busy?: boolean;
};

export function DeleteButton({ className, onConfirm, onCancel, size = 32, label = 'Delete', busy = false, ...props }: DeleteButtonProps) {
  const reduced = useReducedMotion() ?? false;
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const timing = (transition: Transition) => (reduced ? INSTANT : transition);

  const tile = size;
  const panel = size * 2;
  const circle = Math.round(size * 0.66);
  const glyph = Math.round(size * 0.42) + 3;
  const radius = Math.round(size / 3);

  const top = useMotionValue(WALL_TOP);
  const wall = useTransform(top, (y) => WALL_BASE - y);
  const bin = useMotionTemplate`M19 ${top}v${wall}a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V${top}`;
  const settle = useMotionValue(1);

  useEffect(() => {
    const walls = animate(top, open ? WALL_TOP_OPEN : WALL_TOP, reduced ? INSTANT : WALL);
    return () => walls.stop();
  }, [open, reduced, top]);

  useEffect(() => {
    if (status === 'idle') return;
    const nudge = status === 'kept' && !reduced ? animate(settle, [1, 0.86, 1], SETTLE) : null;
    const done = setTimeout(() => setStatus('idle'), HOLD[status]);
    return () => { nudge?.stop(); clearTimeout(done); };
  }, [status, reduced, settle]);

  const resolve = (next: Exclude<Status, 'idle'>, refocus = true) => {
    setOpen(false);
    setStatus(next);
    if (refocus) trigger.current?.focus();
    (next === 'deleted' ? onConfirm : onCancel)?.();
  };

  // a click anywhere else is a no
  const keep = useRef(resolve);
  keep.current = resolve;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) keep.current('kept', false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <motion.div
      ref={root}
      data-slot="delete-button"
      data-state={open ? 'open' : 'closed'}
      data-status={status}
      style={{ height: tile, borderRadius: radius }}
      className={cn('squircle relative shrink-0', SURFACE, GLYPH, busy && 'pointer-events-none opacity-60', className)}
      initial={false}
      animate={{ width: open ? tile + panel : tile }}
      transition={timing(WIDTH)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) { event.stopPropagation(); resolve('kept'); }
      }}
      {...props}
    >
      <motion.button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-expanded={open}
        disabled={busy}
        onClick={() => {
          if (open) return resolve('kept');
          setStatus('idle');
          setOpen(true);
        }}
        whileTap={reduced ? undefined : { scale: 0.94 }}
        transition={TAP}
        style={{ width: tile, height: tile, borderRadius: radius }}
        className={cn('squircle relative z-10 grid place-items-center transition-colors duration-150 hover:text-danger', open && 'text-danger', FOCUS)}
      >
        <AnimatePresence mode="wait" initial={false}>
          {status === 'deleted' ? (
            <motion.svg
              key="done" {...ICON} width={glyph} height={glyph} stroke={ACCENT} strokeWidth="2.5"
              initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }}
              transition={timing(SWAP)}
            >
              <motion.path d="M4 12.5 9.5 18 20 7" initial={reduced ? undefined : { pathLength: 0 }} animate={reduced ? undefined : { pathLength: 1 }} transition={SETTLE} />
            </motion.svg>
          ) : (
            <motion.svg
              key="bin" {...ICON} width={glyph} height={glyph} stroke="currentColor" strokeWidth="2"
              className="overflow-visible"
              style={{ scale: settle }}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={timing(SWAP)}
            >
              <motion.path d={bin} />
              <motion.g style={{ transformBox: 'view-box', transformOrigin: HINGE }} animate={{ rotate: open ? LID_OPEN : 0 }} transition={timing(LID)}>
                <path d="M3 6h18" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </motion.g>
            </motion.svg>
          )}
        </AnimatePresence>
      </motion.button>

      <span role="status" aria-live="polite" className="sr-only">{status === 'deleted' ? 'Deleted' : status === 'kept' ? 'Kept' : ''}</span>

      <AnimatePresence>
        {open && (
          <motion.div
            key="panel"
            style={{ width: panel, borderRadius: radius }}
            className={cn('squircle absolute inset-y-0 right-0 flex items-center justify-center gap-1.5', RECESS)}
            variants={reduced ? undefined : panelMotion}
            initial="hidden" animate="shown" exit="hidden"
          >
            <span aria-hidden className={cn('absolute -left-1 top-1/2 z-20 h-2 w-1 -translate-y-1/2 [clip-path:polygon(100%_0,0_50%,100%_100%)]', RECESS)} />
            <Circle label={`${label}: yes`} edge={circle} onClick={() => resolve('deleted')}>
              <path d="M4 12.5 9.5 18 20 7" stroke={ACCENT} />
            </Circle>
            <Circle label="Cancel" edge={circle} onClick={() => resolve('kept')}>
              <path d="M6 6 18 18M18 6 6 18" />
            </Circle>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
