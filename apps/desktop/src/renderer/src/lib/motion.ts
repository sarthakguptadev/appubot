/**
 * The app's motion in one place (the 2026-11-14 overhaul, in Rare UI's manner: rareui.com): the curves, the springs
 * and the entrances its parts share, for `motion/react`. CSS has the same curves as tokens (packages/theme
 * tokens.css: `ease-rare`, `ease-spring`…) and the press as `.ab-press` (index.css). Reduced motion is the root's
 * `MotionConfig reducedMotion="user"` (App.tsx) plus index.css's global rule, so nothing here checks it.
 *
 * Springs are named for what they move, not how they feel: pick by the job.
 *
 * The app's chrome (menus, popovers, tooltips, dialogs, Settings, tabs, panels, toasts) moves like T3 Code's instead
 * (2026-11-24, the owner's call): short tweens on `EASE_T3`, a fade from 98%, no springs, no blur, no sliding
 * indicators, menus and panels with no motion at all.
 */
import type { Transition } from 'motion/react';

/** ease-out for anything that isn't a spring (fades, colour) */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
export const EASE_IN = [0.4, 0, 1, 1] as const;
export const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;
/** iOS's sheet curve */
export const EASE_SHEET = [0.32, 0.72, 0, 1] as const;
/** T3 Code's curve (Tailwind's default and `ease-in-out`), for the chrome; index.css has it as `--ease-t3` */
export const EASE_T3 = [0.4, 0, 0.2, 1] as const;
/** Tailwind's `ease-out`, T3 Code's for Settings */
export const EASE_T3_OUT = [0, 0, 0.2, 1] as const;

export const SPRING = {
  /** a control under the pointer and back */
  press: { type: 'spring', stiffness: 520, damping: 30 },
  /** a card, menu or sheet arriving */
  pop: { type: 'spring', duration: 0.4, bounce: 0.14 },
  /** text or an icon swapping for another */
  swap: { type: 'spring', duration: 0.45, bounce: 0.12 },
  /** a width or height following its content */
  size: { type: 'spring', duration: 0.45, bounce: 0.1 },
  /** rows changing places */
  reorder: { type: 'spring', stiffness: 320, damping: 30 },
  /** a digit or character rolling in */
  roll: { type: 'spring', stiffness: 500, damping: 34 },
} as const satisfies Record<string, Transition>;

/** how something leaves: quicker than it came, no travel */
export const EXIT: Transition = { duration: 0.16, ease: EASE_IN };

/** A card, menu or dialog arriving and leaving: `<motion.div {...POP}>` inside `AnimatePresence`. */
export const POP = {
  initial: { opacity: 0, y: 8, scale: 0.97, filter: 'blur(6px)' },
  animate: { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)', transition: SPRING.pop },
  exit: { opacity: 0, scale: 0.98, filter: 'blur(3px)', transition: EXIT },
} as const;

/** One word or icon taking another's place (`AnimatePresence mode="popLayout"`); `dir` -1 comes from above. */
export const swap = (dir: 1 | -1 = 1) => ({
  initial: { opacity: 0, y: 7 * dir, filter: 'blur(4px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: SPRING.swap },
  exit: { opacity: 0, y: -7 * dir, filter: 'blur(4px)', transition: EXIT },
}) as const;

/** A row of a list arriving after the ones before it. */
export const reveal = (index: number, step = 0.035) => ({
  initial: { opacity: 0, y: 6, filter: 'blur(4px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { ...SPRING.pop, delay: Math.min(index, 12) * step } },
}) as const;
