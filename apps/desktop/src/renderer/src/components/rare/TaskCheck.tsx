/**
 * A round check that fills and draws its tick, and a label that strikes itself through: the two moving parts of
 * Rare UI's task list, for read-only lists (the agent's plan) and for choices that tick (setup's permissions, the
 * agent cards, the cloud's first-visit picks).
 *
 * From Rare UI (rareui.com), `components/ui/task-list.tsx`.
 * Copyright (c) 2026 Swami Malode. MIT + Commons Clause + Attribution: see apps/desktop/scripts/licenses/RareUI.txt.
 *
 * Changed for AppuBot: the check and the label are exported on their own (upstream wraps them in a clickable card
 * and a list that reorders, which the app's rows already are); the check takes a size in px, an accent and the idle
 * ring's look (`dashed` as upstream, or a plain ring), and can show `busy` (the ring turns) for the step in progress;
 * the label follows `struck` a beat after the tick instead of through upstream's stage machine; the app's colours.
 */
import type { CSSProperties, ReactNode } from 'react';
import { motion, useReducedMotion, type Transition } from 'motion/react';
import { cn } from '../ui/cn';

const EASE_OUT = [0.22, 1, 0.36, 1] as const;
const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;

const POP_SCALE = [1, 1.08, 1];
const FILL: Transition = { duration: 0.24, ease: EASE_OUT };
const POP: Transition = { duration: 0.34, ease: EASE_OUT, times: [0, 0.4, 1] };
const TICK: Transition = { duration: 0.22, ease: EASE_OUT, delay: 0.06 };
const STRIKE: Transition = { duration: 0.38, ease: EASE_IN_OUT };
const INSTANT: Transition = { duration: 0 };

// dashes divide the circumference, so the ring closes without a seam
const RING_R = 11;
const RING_DASH = `1 ${(2 * Math.PI * RING_R) / 13 - 1}`;

// the strike rides on the text itself, so a label that wraps gets a line per row
const STRIKE_STYLE: CSSProperties = {
  backgroundImage: 'linear-gradient(currentColor, currentColor)',
  backgroundRepeat: 'no-repeat',
  backgroundPosition: '0 52%',
  boxDecorationBreak: 'clone',
  WebkitBoxDecorationBreak: 'clone',
};

function useTiming() {
  const reduced = useReducedMotion() ?? false;
  return (transition: Transition) => (reduced ? INSTANT : transition);
}

export function TaskCheck({ checked, size = 20, accent = 'var(--ab-accent)', dashed = false, busy = false, className }: {
  checked: boolean;
  /** px */
  size?: number;
  accent?: string;
  /** the idle ring as upstream draws it, in dashes; else a plain ring (a choice, not a task) */
  dashed?: boolean;
  /** the step being worked on: the dashed ring turns */
  busy?: boolean;
  className?: string;
}) {
  const timing = useTiming();
  const reduced = useReducedMotion() ?? false;
  return (
    <motion.svg
      viewBox="0 0 24 24"
      aria-hidden
      width={size}
      height={size}
      className={cn('shrink-0 text-[color-mix(in_srgb,var(--ab-fg)_26%,transparent)]', className)}
      initial={false}
      animate={{ scale: checked ? POP_SCALE : 1 }}
      transition={checked ? timing(POP) : INSTANT}
    >
      <motion.circle
        cx="12" cy="12" r={RING_R} fill="none" stroke="currentColor" strokeWidth={dashed || busy ? 2 : 1.75} strokeLinecap="round"
        strokeDasharray={dashed || busy ? RING_DASH : undefined}
        style={{ transformBox: 'view-box', transformOrigin: '12px 12px' }}
        initial={false}
        animate={{ opacity: checked ? 0 : 1, rotate: busy && !checked && !reduced ? 360 : 0 }}
        transition={{ opacity: timing(FILL), rotate: busy && !checked && !reduced ? { duration: 2.4, ease: 'linear', repeat: Infinity } : INSTANT }}
      />
      <motion.circle
        cx="12" cy="12" r="12" fill={accent}
        style={{ transformBox: 'view-box', transformOrigin: '12px 12px' }}
        initial={false}
        animate={{ scale: checked ? 1 : 0 }}
        transition={timing(FILL)}
      />
      <motion.path
        d="M7.4 12.4 10.6 15.5 16.6 8.9"
        fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
        initial={false}
        animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
        transition={timing(TICK)}
      />
    </motion.svg>
  );
}

/** A label that is struck through once `struck`, a beat after its check has drawn. */
export function TaskLabel({ struck, line = '1.5px', className, children }: { struck: boolean; line?: string; className?: string; children: ReactNode }) {
  const timing = useTiming();
  return (
    <motion.span
      style={STRIKE_STYLE}
      className={cn('transition-colors duration-300', className)}
      initial={false}
      animate={{ backgroundSize: `${struck ? 100 : 0}% ${line}` }}
      transition={timing(struck ? { ...STRIKE, delay: 0.28 } : STRIKE)}
    >
      {children}
    </motion.span>
  );
}
