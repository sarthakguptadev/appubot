/**
 * EmojiReaction: a pill of emoji that pop in one after another, lift under the pointer, and send a small flock of
 * themselves drifting up when one is picked; two dots trail from the pill to what opened it.
 *
 * Ported from Rare UI's `components/ui/emoji-reaction.tsx` (https://rareui.com).
 * Copyright (c) 2026 Swami Malode. MIT + Commons Clause + Attribution (apps/desktop/scripts/licenses/RareUI.txt).
 *
 * The pill, its tail, the springs and the burst's numbers are Rare UI's. Changed for AppuBot's chat
 * (features/chat/Reactions.tsx): emoji are the system's own glyphs (Rare UI fetches Apple's pictures from a CDN; the
 * app loads nothing from the network); the caller places the pill (a portal kept inside the window) and owns its
 * trigger, so this exports the pill (`EmojiBar`) and the burst (`useEmojiBurst`) rather than one component; the burst
 * flies in a layer of its own, so it finishes after the pill has closed; `trailing` puts a button after the emoji.
 */
import { memo, useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '../ui/cn';

export const EMOJI_SURFACE = 'bg-[#F4F4F9] dark:bg-[#262626]';

const BURST_COUNT = 5;
const MAX_PARTICLES = 60;
const RISE = 450;
const LAUNCH_SPREAD = 6;
const CLIMB_SPREAD = 78;
// soft ease out, roughly 65% of the distance by the halfway point so it keeps moving
const EASE = [0.4, 0.3, 0.5, 1] as const;
const SWAY = [0, 0.3, 0.65, 1];

export const EMOJI_SIZES = {
  sm: { emoji: 26, pill: 'gap-0.5 p-1', burst: 26 },
  md: { emoji: 34, pill: 'gap-1 p-1.5', burst: 34 },
  lg: { emoji: 42, pill: 'gap-1.5 p-2', burst: 42 },
} as const;
export type EmojiSize = keyof typeof EMOJI_SIZES;

type Particle = {
  id: number;
  emoji: string;
  originX: number;
  originY: number;
  x: number;
  drift: number;
  tilt: number;
  travel: number;
  scale: number;
  blurRatio: number;
  fadeAt: number;
  duration: number;
  delay: number;
};

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** an emoji as text, at a picture's size (the glyph fills its line box) */
function Glyph({ emoji, size }: { emoji: string; size: number }) {
  return (
    <span aria-hidden className="block select-none text-center leading-none" style={{ width: size, height: size, fontSize: size * 0.82, lineHeight: `${size}px` }}>
      {emoji}
    </span>
  );
}

function makeParticles(emoji: string, seed: number, from: DOMRect): Particle[] {
  const originX = from.left + from.width / 2;
  const originY = from.top + from.height / 2;
  return Array.from({ length: BURST_COUNT }, (_, i) => {
    const lane = rand(-1, 1);
    const dir = lane < 0 ? -1 : 1;
    return {
      id: seed + i,
      emoji,
      originX,
      originY,
      x: lane * LAUNCH_SPREAD,
      drift: lane * CLIMB_SPREAD,
      tilt: rand(1, 4) * dir,
      travel: RISE * rand(0.86, 1),
      scale: rand(0.78, 1.05),
      blurRatio: rand(0.18, 0.3),
      fadeAt: rand(0.55, 0.88),
      duration: rand(1.4, 1.8),
      delay: i * 0.25,
    };
  });
}

// memo, a parent render restarts the flight and replays its delay
const BurstEmoji = memo(function BurstEmoji({ particle, size, onDone }: { particle: Particle; size: number; onDone: (id: number) => void }) {
  return (
    <motion.span
      className="pointer-events-none fixed will-change-transform"
      style={{ left: particle.originX, top: particle.originY, marginLeft: -size / 2, marginTop: -size / 2 }}
      initial={{ x: particle.x, y: 0, scale: 0.6, opacity: 0, rotate: 0, filter: 'blur(0px)' }}
      animate={{
        // shares the parent ease with y, any override here bends the path sideways
        x: particle.x + particle.drift,
        y: -particle.travel,
        scale: [0.6, particle.scale * 1.15, particle.scale, particle.scale * 0.75],
        rotate: [0, particle.tilt, -particle.tilt * 0.65, particle.tilt * 0.35],
        opacity: [0, 1, 1, 0],
        filter: ['blur(0px)', 'blur(0px)', `blur(${particle.blurRatio * size}px)`],
      }}
      transition={{
        duration: particle.duration,
        delay: particle.delay,
        ease: EASE,
        // inherit, a per value transition replaces the parent one without it
        rotate: { inherit: true, times: SWAY, ease: 'easeInOut' },
        scale: { inherit: true, times: [0, 0.1, 0.22, 1], ease: 'easeOut' },
        opacity: { inherit: true, times: [0, 0.03, particle.fadeAt, 1], ease: 'linear' },
        // no ease override, blur has to track the climb curve or it lags the rise
        filter: { inherit: true, times: [0, 0.12, 1] },
      }}
      onAnimationComplete={() => onDone(particle.id)}
    >
      <Glyph emoji={particle.emoji} size={size} />
    </motion.span>
  );
});

/**
 * The flock that rises from a picked emoji. `burst(emoji, from)` starts one from a rectangle on screen; `layer` goes
 * anywhere in the tree (it portals to the page and is empty while nothing flies). Nothing under Reduce motion.
 */
export function useEmojiBurst(size: EmojiSize = 'md'): { burst: (emoji: string, from: DOMRect) => void; layer: ReactNode } {
  const reduced = useReducedMotion();
  const [particles, setParticles] = useState<Particle[]>([]);
  const seed = useRef(0);
  const burst = useCallback((emoji: string, from: DOMRect) => {
    if (reduced) return;
    seed.current += BURST_COUNT;
    setParticles((prev) => [...prev, ...makeParticles(emoji, seed.current, from)].slice(-MAX_PARTICLES));
  }, [reduced]);
  const settle = useCallback((id: number) => setParticles((prev) => prev.filter((p) => p.id !== id)), []);
  const layer = particles.length && typeof document !== 'undefined'
    ? createPortal(
      <div aria-hidden data-slot="emoji-burst" className="pointer-events-none fixed inset-0 z-[80] overflow-hidden">
        {particles.map((p) => <BurstEmoji key={p.id} particle={p} size={EMOJI_SIZES[size].burst} onDone={settle} />)}
      </div>,
      document.body,
    )
    : null;
  return { burst, layer };
}

export interface EmojiBarProps {
  emojis: readonly string[];
  /** the one already picked: drawn on a fill */
  active?: string | null;
  size?: EmojiSize;
  /** picked: the emoji and where its button is on screen (the burst's start) */
  onPick: (emoji: string, from: DOMRect) => void;
  /** where the tail's dots sit: the pill is above what opened it (`top`) or below it */
  side?: 'top' | 'bottom';
  /** the tail's place from the pill's left edge; no tail when left out */
  tailX?: number;
  /** after the emoji, inside the pill (a "more" button) */
  trailing?: ReactNode;
  className?: string;
}

/** The pill of emoji: each pops in a beat after the one before, lifts under the pointer and dips when pressed. */
export function EmojiBar({ emojis, active, size = 'md', onPick, side = 'top', tailX, trailing, className }: EmojiBarProps) {
  const s = EMOJI_SIZES[size];
  const reduced = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const top = side === 'top';

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = emojis.length;
    let next = activeIndex;
    if (event.key === 'ArrowRight') next = (activeIndex + 1) % count;
    else if (event.key === 'ArrowLeft') next = (activeIndex - 1 + count) % count;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else return;
    event.preventDefault();
    setActiveIndex(next);
    itemRefs.current[next]?.focus();
  };

  return (
    <div data-slot="emoji-reaction" className={cn('relative w-fit', className)}>
      <div role="menu" aria-label="Pick a reaction" aria-orientation="horizontal" onKeyDown={onKeyDown} className={cn('relative flex items-center rounded-full', EMOJI_SURFACE, s.pill)}>
        {emojis.map((emoji, i) => (
          <motion.button
            key={`${emoji}-${i}`}
            ref={(node) => { itemRefs.current[i] = node; }}
            type="button"
            role="menuitem"
            tabIndex={i === activeIndex ? 0 : -1}
            data-emoji={emoji}
            aria-label={`React ${emoji}`}
            onFocus={() => setActiveIndex(i)}
            onClick={(event) => onPick(emoji, event.currentTarget.getBoundingClientRect())}
            className={cn(
              'relative z-10 rounded-full p-1 outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]',
              emoji === active && 'bg-black/10 dark:bg-white/15',
            )}
            initial={reduced ? false : { scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 800, damping: 25, delay: reduced ? 0 : 0.04 + i * 0.035 }}
            whileHover={reduced ? undefined : { scale: 1.28, y: -4 }}
            whileTap={{ scale: 0.92 }}
          >
            <Glyph emoji={emoji} size={s.emoji} />
          </motion.button>
        ))}
        {trailing}
      </div>
      {tailX !== undefined ? (
        <>
          <span className={cn('absolute size-3 -translate-x-1/2 rounded-full', EMOJI_SURFACE, top ? '-bottom-1' : '-top-1')} style={{ left: tailX }} />
          <span className={cn('absolute size-1.5 -translate-x-1/2 rounded-full', EMOJI_SURFACE, top ? '-bottom-4' : '-top-4')} style={{ left: tailX + 6 }} />
        </>
      ) : null}
    </div>
  );
}
