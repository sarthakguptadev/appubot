/**
 * CodeBlock: code in a rounded frame, its language in a quiet header, line numbers in a gutter, and a copy button
 * whose glyph swaps to a tick that draws itself; the whole colour theme is made from shades of one accent.
 *
 * Ported from Rare UI's `components/ui/code-block.tsx` (https://rareui.com).
 * Copyright (c) 2026 Swami Malode. MIT + Commons Clause + Attribution (apps/desktop/scripts/licenses/RareUI.txt).
 *
 * The frame, header, gutter, sizes, springs and the theme's sums are Rare UI's. Changed for AppuBot's chat
 * (features/chat/Markdown.tsx): the tokens come from Shiki, which the app already loads (bash, SQL, diff and the rest
 * that Rare UI's Prism bundle lacks; highlighted off the main path and kept), so this is the frame around a body the
 * caller gives it, and the theme is CSS (`codeBlock.css`) so one highlighted block follows any accent and both colour
 * schemes; `actions` puts more header buttons beside Copy (soft wrap, a diagram's source), in the copy button's look.
 */
import { memo, useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Copy } from '../ui/icons';
import { cn } from '../ui/cn';
import './codeBlock.css';

const TAP_SPRING = { type: 'spring', stiffness: 500, damping: 30 } as const;
const SWAP_SPRING = { type: 'spring', duration: 0.3, bounce: 0 } as const;
const CHECK_SPRING = { type: 'spring', duration: 0.4, bounce: 0.35 } as const;
const COPY_RESET_MS = 1800;

const HEADER_BUTTON =
  'relative grid size-7 place-items-center rounded-lg text-(--cb-gutter) outline-none transition-[background-color,color] duration-150 ease-out hover:bg-(--cb-hover-wash) hover:text-(--cb-plain) focus-visible:ring-2 focus-visible:ring-(--cb-accent)/60';

/** A header button in the copy button's look (soft wrap, show source): pressed, it takes the accent. */
export function CodeHeaderButton({ pressed, className, children, ...props }: ComponentProps<'button'> & { pressed?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      {...props}
      className={cn(HEADER_BUTTON, pressed && 'bg-(--cb-accent)/12 text-(--cb-accent) hover:bg-(--cb-accent)/12 hover:text-(--cb-accent)', className)}
    >
      {children}
    </button>
  );
}

/**
 * A memo that reads the code when pressed (`code` is a ref the frame keeps current): a block streaming in changes its
 * code with every token, and the button's springs and presence would be drawn again each time for nothing.
 */
export const CodeCopyButton = memo(function CodeCopyButton({ code: codeRef, floating }: { code: { readonly current: string }; floating?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(codeRef.current);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPY_RESET_MS);
  }, [codeRef]);

  const reduceMotion = useReducedMotion();
  const swap = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, scale: 0.5, filter: 'blur(4px)' },
        animate: { opacity: 1, scale: 1, filter: 'blur(0px)' },
        exit: { opacity: 0, scale: 0.5, filter: 'blur(4px)' },
      };

  return (
    <motion.button
      type="button"
      data-slot="code-block-copy"
      aria-label={copied ? 'Copied' : 'Copy code'}
      onClick={() => void copy()}
      whileTap={reduceMotion ? undefined : { scale: 0.9 }}
      transition={TAP_SPRING}
      className={cn(
        HEADER_BUTTON,
        copied && 'bg-(--cb-accent)/12 text-(--cb-accent) hover:bg-(--cb-accent)/12 hover:text-(--cb-accent)',
        floating && 'absolute top-2.5 right-2.5 z-10 border border-(--cb-border) bg-(--cb-float-bg) backdrop-blur-md',
      )}
    >
      <AnimatePresence initial={false}>
        {copied ? (
          <motion.span key="check" className="col-start-1 row-start-1" {...swap} transition={reduceMotion ? { duration: 0.15 } : CHECK_SPRING}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="size-3.5" aria-hidden>
              <motion.path d="M4 12.5l5 5L20 6.5" initial={reduceMotion ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.2, ease: 'easeOut', delay: 0.05 }} />
            </svg>
          </motion.span>
        ) : (
          <motion.span key="copy" className="col-start-1 row-start-1" {...swap} transition={reduceMotion ? { duration: 0.15 } : SWAP_SPRING}>
            <Copy className="size-3.5" />
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
});

export type CodeFrameProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** what Copy copies */
  code: string;
  /** the header's label: a filename, else the language */
  label: string;
  /** line numbers in a gutter (only with more than one line: a one-liner has nothing to count) */
  showLineNumbers?: boolean;
  /** soft wrap: long lines break inside the block */
  wrap?: boolean;
  /** more header buttons, before Copy */
  actions?: ReactNode;
  /** under the code, inside the frame (a note) */
  footer?: ReactNode;
  /** the body: a `<pre>` whose lines are `<span class="line">` (Shiki's shape), or anything else to frame */
  children: ReactNode;
};

/** The frame: border, background, the header with its label and buttons, and the scrolling viewport. */
export function CodeFrame({ code, label, showLineNumbers = true, wrap = false, actions, footer, className, style, children, ...props }: CodeFrameProps) {
  const lines = code ? code.split('\n').length : 1;
  const codeRef = useRef(code);
  codeRef.current = code;
  return (
    <div
      data-slot="code-block"
      data-lines={showLineNumbers && lines > 1}
      data-wrap={wrap}
      className={cn('rare-code group relative flex flex-col overflow-hidden rounded-2xl border border-(--cb-border) bg-(--cb-bg) text-left', className)}
      style={{ '--cb-gutter-width': `${String(lines).length}ch`, ...style } as React.CSSProperties}
      {...props}
    >
      {/* (no backdrop blur: the frame under the header is a flat colour, and a filter per block costs every scroll) */}
      <div data-slot="code-block-header" className="flex h-10 shrink-0 items-center gap-1 border-b border-(--cb-border) bg-(--cb-header-bg) pr-1.5 pl-3.5">
        <span className="mr-2 min-w-0 flex-1 truncate font-mono text-xs text-(--cb-muted) select-none">{label}</span>
        {actions}
        <CodeCopyButton code={codeRef} />
      </div>
      <div
        data-slot="code-block-viewport"
        role="region"
        aria-label={`${label} code`}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto py-3 outline-none focus-visible:ring-2 focus-visible:ring-(--cb-accent)/40"
      >
        {children}
      </div>
      {footer}
    </div>
  );
}
