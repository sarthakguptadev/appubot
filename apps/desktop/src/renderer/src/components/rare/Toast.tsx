/**
 * Toast: a notice as a squircle card: a coloured tile whose glyph pops in and draws itself (a tick, a cross, an
 * exclamation mark, an "i", or a spinner), a title, a line under it, an action button and a close button on its corner.
 *
 * Ported from Rare UI's `components/ui/toast.tsx` (https://rareui.com).
 * Copyright (c) 2026 Swami Malode. MIT + Commons Clause + Attribution (apps/desktop/scripts/licenses/RareUI.txt).
 *
 * The card, its tile, glyphs, sizes, colours and springs are Rare UI's. Rare UI stacks its toasts with sonner; AppuBot
 * has a deck of its own (features/notifications/Toaster.tsx: timers held on hover, a bot's avatar in the tile's place,
 * a notice that opens its chat), so the card's parts are exported for that deck instead of a `toast()` call:
 * `ToastSurface` (the clipped card with its hairline and shadow), `ToastIcon`, `ToastClose`, and the text and button
 * styles.
 */
import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { getSvgPath } from 'figma-squircle';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '../ui/cn';

export type ToastType = 'default' | 'success' | 'error' | 'warning' | 'info' | 'loading';

// card radius = tile radius + padding, so the corners stay concentric
export const TOAST_PADDING = 10;
export const TOAST_TILE = 36;
export const TOAST_TILE_RADIUS = 11;
export const TOAST_CARD_RADIUS = TOAST_TILE_RADIUS + TOAST_PADDING;

export const squircle = (width: number, height: number, radius: number) =>
  getSvgPath({ width, height, cornerRadius: radius, cornerSmoothing: 1 });

const TILE_CLIP = `path('${squircle(TOAST_TILE, TOAST_TILE, TOAST_TILE_RADIUS)}')`;

const TONES: Record<Exclude<ToastType, 'default'>, string> = {
  success: 'bg-[#34C759] text-white dark:bg-[#30D158]',
  error: 'bg-[#FF3B30] text-white dark:bg-[#FF453A]',
  warning: 'bg-[#FF9500] text-white dark:bg-[#FF9F0A]',
  info: 'bg-[#007AFF] text-white dark:bg-[#0A84FF]',
  loading: 'bg-[#F4F4F9] text-[#868593] dark:bg-[#2C2C2E] dark:text-[#9B9AA7]',
};

const POP = { type: 'spring', stiffness: 520, damping: 30 } as const;
// critically damped, so the tile eases in without the glyph's bounce
const SETTLE = { type: 'spring', stiffness: 320, damping: 36 } as const;
const DRAW = { duration: 0.3, delay: 0.1, ease: 'easeOut' } as const;
// the card's own entrance takes about this long, so the icon waits for most of it before popping in
const ARRIVAL = 0.32;
const INSTANT = { duration: 0 } as const;
// a result waits for the spinner to leave, then the tile gives one small bump
const LEAVE = { duration: 0.14, ease: 'easeIn' } as const;
const BUMP = { duration: 0.4, delay: LEAVE.duration, ease: 'easeOut' as const, times: [0, 0.4, 1] };

function Glyph({ type, reduced, delay }: { type: ToastType; reduced: boolean; delay: number }) {
  const stroke = {
    initial: reduced ? false : { pathLength: 0 },
    animate: { pathLength: 1 },
    transition: reduced ? INSTANT : { ...DRAW, delay: DRAW.delay + delay },
  } as const;

  if (type === 'loading') {
    return (
      <svg viewBox="0 0 24 24" className="size-[18px] animate-spin motion-reduce:animate-none" fill="none" stroke="currentColor" strokeWidth={2.75} strokeLinecap="round">
        <circle cx="12" cy="12" r="8" strokeOpacity={0.25} />
        <path d="M12 4a8 8 0 0 1 8 8" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
      {type === 'success' && <motion.path d="M6 12.5l4 4 8-9" {...stroke} />}
      {type === 'error' && (
        <>
          <motion.path d="M7.5 7.5l9 9" {...stroke} />
          <motion.path d="M16.5 7.5l-9 9" {...stroke} />
        </>
      )}
      {type === 'warning' && (
        <>
          <motion.path d="M12 6v7" {...stroke} />
          <circle cx="12" cy="18" r="1.6" fill="currentColor" stroke="none" />
        </>
      )}
      {type === 'info' && (
        <>
          <circle cx="12" cy="6.25" r="1.6" fill="currentColor" stroke="none" />
          <motion.path d="M12 11v7" {...stroke} />
        </>
      )}
    </svg>
  );
}

/** The coloured tile and its glyph. A change of `type` (a spinner turning into a tick) swaps the glyph in place. */
export function ToastIcon({ type }: { type: Exclude<ToastType, 'default'> }) {
  const reduced = useReducedMotion() ?? false;
  // only the first icon waits for the toast to land; a later swap animates right away
  const [arrivingType] = useState(type);
  const settled = type !== arrivingType;
  const delay = settled ? 0 : ARRIVAL;

  return (
    <motion.span
      aria-hidden
      data-slot="toast-icon"
      initial={reduced ? false : { scale: 0.85, opacity: 0 }}
      animate={{ scale: settled ? [1, 1.08, 1] : 1, opacity: 1 }}
      transition={reduced ? INSTANT : settled ? { scale: BUMP } : { ...SETTLE, delay: ARRIVAL - 0.08 }}
      style={{ width: TOAST_TILE, height: TOAST_TILE, clipPath: TILE_CLIP }}
      className={cn('relative shrink-0 transition-colors duration-200 motion-reduce:transition-none', TONES[type])}
    >
      <AnimatePresence initial={!reduced} mode="wait">
        <motion.span
          key={type}
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.5, opacity: 0, transition: reduced ? INSTANT : LEAVE }}
          transition={reduced ? INSTANT : { ...POP, delay }}
          className="absolute inset-0 grid place-items-center"
        >
          <Glyph type={type} reduced={reduced} delay={delay} />
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
}

// offset size, not getBoundingClientRect: a deck scales the cards behind and that would skew the path
function useBoxSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.width === el.offsetWidth && s.height === el.offsetHeight ? s : { width: el.offsetWidth, height: el.offsetHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, size] as const;
}

export const TOAST_TITLE = 'text-sm font-semibold leading-5 tracking-[-0.01em] text-black dark:text-white';
export const TOAST_DESCRIPTION = 'text-[13px] font-medium leading-[18px] text-[#868593]';
/** the card's button (its radius is the tile's: `style={{ borderRadius: TOAST_TILE_RADIUS }}`) */
export const TOAST_ACTION =
  'h-9 shrink-0 cursor-pointer bg-[#F4F4F9] px-3.5 text-[13px] font-semibold text-black outline-none transition-[background-color,transform] hover:bg-[#EDEDF3] focus-visible:ring-2 focus-visible:ring-[#FC4C01]/60 active:scale-95 motion-reduce:transition-none dark:bg-[#2C2C2E] dark:text-white dark:hover:bg-[#3A3A3C]';
export const TOAST_ACTION_PRIMARY =
  'h-9 shrink-0 cursor-pointer bg-black px-3.5 text-[13px] font-semibold text-white outline-none transition-[background-color,transform] hover:bg-[#1c1c1e] focus-visible:ring-2 focus-visible:ring-[#FC4C01]/60 active:scale-95 motion-reduce:transition-none dark:bg-white dark:text-black dark:hover:bg-[#e9e9ee]';

/** The card: clipped to a squircle, a 1px hairline inside it, a soft drop shadow under it. */
export function ToastSurface({ type = 'default', className, bodyClassName, children, ...props }: ComponentProps<'div'> & { type?: ToastType; bodyClassName?: string; children: ReactNode }) {
  const [cardRef, { width, height }] = useBoxSize<HTMLDivElement>();
  const outline = width > 0 && height > 0 ? squircle(width, height, TOAST_CARD_RADIUS) : null;

  return (
    <div
      data-slot="toast"
      data-type={type}
      {...props}
      // drop-shadow, since a box-shadow would be cut off by the squircle clip; its blur reads about twice a box-shadow's
      className={cn(
        'relative h-full w-full [filter:drop-shadow(0_1px_1px_rgba(0,0,0,0.05))_drop-shadow(0_2px_5px_rgba(0,0,0,0.06))] dark:[filter:drop-shadow(0_1px_1px_rgba(0,0,0,0.3))_drop-shadow(0_2px_5px_rgba(0,0,0,0.3))]',
        className,
      )}
    >
      <div
        ref={cardRef}
        style={{ padding: TOAST_PADDING, borderRadius: TOAST_CARD_RADIUS, clipPath: outline ? `path('${outline}')` : undefined }}
        className={cn('relative flex h-full items-center bg-white dark:bg-[#1C1C1E]', bodyClassName)}
      >
        {outline && (
          <svg aria-hidden width={width} height={height} className="pointer-events-none absolute inset-0">
            {/* half the stroke is clipped away, leaving a 1px inner hairline */}
            <path d={outline} fill="none" strokeWidth={2} className="stroke-black/[0.07] dark:stroke-white/10" />
          </svg>
        )}
        {children}
      </div>
    </div>
  );
}

/** The close button on the card's corner: outside the clipped card, so it never pushes the content around. */
export function ToastClose({ className, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      aria-label="Dismiss"
      data-slot="toast-close"
      {...props}
      className={cn(
        'absolute -left-1.5 -top-1.5 grid size-5 cursor-pointer place-items-center rounded-full bg-white text-[#868593] opacity-0 shadow-[0_0_0_1px_rgba(0,0,0,0.08)] outline-none transition-[opacity,color] hover:text-black focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[#FC4C01]/60 group-hover/toast:opacity-100 motion-reduce:transition-none dark:bg-[#2C2C2E] dark:text-[#9B9AA7] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.1)] dark:hover:text-white',
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="size-2.5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" aria-hidden>
        <path d="M7 7l10 10M17 7L7 17" />
      </svg>
    </button>
  );
}
