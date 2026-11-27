/**
 * The app's motion in one place (the 2026-11-14 overhaul, in Rare UI's manner: rareui.com): the curves, the springs
 * and the entrances its parts share, for `motion/react`. CSS has the same curves as tokens (packages/theme
 * tokens.css: `ease-rare`, `ease-spring`…) and the press as `.ab-press` (index.css). Reduced motion is the root's
 * `MotionConfig reducedMotion="user"` (App.tsx) plus index.css's global rule, so nothing here checks it.
 *
 * Springs are named for what they move, not how they feel: pick by the job.
 *
 * The app's surfaces are instant (2026-11-27): the command palette, dialogs, menus, popovers and tooltips open and close
 * in one frame, with no fade, scale or blur, and a hover changes colour in the frame the pointer arrives. Settings,
 * tabs, panels and toasts keep short tweens on `EASE_T3_OUT`, no springs, no blur, no sliding indicators.
 */
import type { Transition } from 'motion/react';

/** ease-out for anything that isn't a spring (fades, colour) */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
export const EASE_IN = [0.4, 0, 1, 1] as const;
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
