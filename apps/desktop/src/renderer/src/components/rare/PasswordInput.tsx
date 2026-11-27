/**
 * PasswordInput: a secret typed as dots that cross-fade into its characters when the eye opens (the eye's lid closes
 * with lashes when it hides them again), a caret and selection drawn to match, and a strength meter that slides in.
 *
 * Ported from Rare UI's `components/ui/password-input.tsx` (https://rareui.com).
 * Copyright (c) 2026 Swami Malode. MIT + Commons Clause + Attribution (apps/desktop/scripts/licenses/RareUI.txt).
 *
 * The field, the glyphs, the eye, the meter, their colours and springs are Rare UI's. Changed for AppuBot's cards
 * (features/chat/FormCard.tsx): a `sm` size beside a form's other fields; `meter="flow"` puts the strength meter in
 * the layout (Rare UI floats it under the field, which would sit on the next field of a form); `invalid` rings the
 * field; the meter is off unless asked for (a card number or an API key has no strength); autofill defaults to
 * "new-password" so the browser engine never offers to fill or save what goes into the Vault.
 */
import { useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'motion/react';
import { cn } from '../ui/cn';

const LEVELS = [
  { label: 'Weak', color: '#FF3B30' },
  { label: 'Fair', color: '#FF9500' },
  { label: 'Good', color: '#FFCC00' },
  { label: 'Strong', color: '#34C759' },
] as const;

const LID_OPEN = { top: 5.5, bottom: 18.5 };
const LID_CLOSED = { top: 17, bottom: 17 };
const LASHES = ['M4.4 14.6 3 16.4', 'M9 16.6 8.5 19', 'M15 16.6l.5 2.4', 'M19.6 14.6l1.4 1.8'];

const INSTANT: Transition = { duration: 0 };
const SPRING: Transition = { type: 'spring', stiffness: 520, damping: 32 };
const LID_SPRING: Transition = { type: 'spring', stiffness: 500, damping: 34 };
const SWAP: Transition = { duration: 0.12, ease: 'easeOut' };
const REVEAL: Transition = { duration: 0.32, ease: [0.22, 1, 0.36, 1] };
const BLINK: Transition = { duration: 1.1, times: [0, 0.5, 0.5, 1], repeat: Infinity, ease: 'linear' };

const SIZES = {
  md: { field: 'ab-pill h-12 rounded-xl', text: 'text-base', pad: 'pl-4', left: 'left-4', toggle: 'mr-1.5 size-9', eye: 'size-5', caret: 'h-5', mark: 'h-6' },
  sm: { field: 'ab-pill h-9 rounded-[10px]', text: 'text-[13px]', pad: 'pl-3', left: 'left-3', toggle: 'mr-1 size-7', eye: 'size-4', caret: 'h-4', mark: 'h-5' },
} as const;

const corner = (y: number) => 12 + (y - 12) * 0.64;

const eyePath = ({ top, bottom }: { top: number; bottom: number }) =>
  `M2 12C4 ${corner(top)} 7.5 ${top} 12 ${top}C16.5 ${top} 20 ${corner(top)} 22 12C20 ${corner(bottom)} 16.5 ${bottom} 12 ${bottom}C7.5 ${bottom} 4 ${corner(bottom)} 2 12Z`;

export function passwordStrength(value: string) {
  if (!value) return 0;
  const score = [value.length >= 8, value.length >= 12, /[a-z]/.test(value) && /[A-Z]/.test(value), /\d/.test(value), /[^a-zA-Z0-9]/.test(value)].filter(Boolean).length;
  return Math.min(Math.max(score, 1), LEVELS.length);
}

function Glyph({ char, visible, reduceMotion }: { char: string; visible: boolean; reduceMotion: boolean }) {
  const transition = reduceMotion ? INSTANT : SWAP;

  return (
    <span className="relative grid h-full w-[1ch] shrink-0 place-items-center">
      <motion.span data-slot="password-input-dot" initial={false} animate={{ opacity: visible ? 0 : 1 }} transition={transition} className="absolute size-[0.36em] rounded-full bg-current" />
      <motion.span data-slot="password-input-char" initial={false} animate={{ opacity: visible ? 1 : 0 }} transition={transition} className="whitespace-pre">
        {char}
      </motion.span>
    </span>
  );
}

function Eye({ open, reduceMotion, className }: { open: boolean; reduceMotion: boolean; className: string }) {
  const clipId = useId();
  const lid = { d: eyePath(open ? LID_OPEN : LID_CLOSED) };
  const transition = reduceMotion ? INSTANT : LID_SPRING;

  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={cn('overflow-visible', className)}>
      <clipPath id={clipId}>
        <motion.path initial={false} animate={lid} transition={transition} />
      </clipPath>
      <circle cx={12} cy={12} r={3} clipPath={`url(#${clipId})`} />
      <motion.path initial={false} animate={lid} transition={transition} />
      {LASHES.map((d) => (
        <motion.path
          key={d}
          d={d}
          initial={false}
          animate={{ pathLength: open ? 0 : 1, opacity: open ? 0 : 1 }}
          transition={reduceMotion ? INSTANT : { duration: 0.2, delay: open ? 0 : 0.08 }}
        />
      ))}
    </svg>
  );
}

export type PasswordInputProps = Omit<ComponentProps<'input'>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'size'> & {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  defaultVisible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
  strength?: boolean;
  /** `float`: the meter hangs under the field, out of the layout (Rare UI's); `flow`: it takes its own room */
  meter?: 'float' | 'flow';
  size?: keyof typeof SIZES;
  invalid?: boolean;
  inputClassName?: string;
};

export function PasswordInput({
  value,
  defaultValue = '',
  onChange,
  defaultVisible = false,
  onVisibleChange,
  strength = false,
  meter = 'float',
  size = 'md',
  invalid,
  placeholder,
  disabled,
  autoComplete = 'new-password',
  className,
  inputClassName,
  onFocus,
  onBlur,
  ...props
}: PasswordInputProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const [visible, setVisible] = useState(defaultVisible);
  const [focused, setFocused] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0, scroll: 0 });
  const input = useRef<HTMLInputElement>(null);
  const frame = useRef(0);
  const reduceMotion = useReducedMotion() ?? false;
  const scale = SIZES[size];

  const password = value ?? uncontrolled;
  const chars = Array.from(password);
  const level = passwordStrength(password);
  const shownLevel = LEVELS[Math.max(level, 1) - 1] ?? LEVELS[0];
  const animated = (transition: Transition) => (reduceMotion ? INSTANT : transition);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const read = () => {
    const el = input.current;
    if (!el) return;
    // selection offsets count utf-16 units, the glyphs count code points
    const start = Array.from(el.value.slice(0, el.selectionStart ?? 0)).length;
    const end = Array.from(el.value.slice(0, el.selectionEnd ?? 0)).length;
    const scroll = el.scrollLeft;
    setSelection((current) => (current.start === start && current.end === end && current.scroll === scroll ? current : { start, end, scroll }));
  };

  // read now so the caret moves with the keystroke, then again once scrollLeft settles
  const sync = () => {
    read();
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(read);
  };

  const toggle = () => {
    const el = input.current;
    const start = el?.selectionStart ?? null;
    const end = el?.selectionEnd ?? null;
    setVisible(!visible);
    onVisibleChange?.(!visible);
    // switching the input type drops the selection in some browsers
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      if (el && start !== null && end !== null && document.activeElement === el) el.setSelectionRange(start, end);
      read();
    });
  };

  const bars = (
    <div className={cn('flex flex-col gap-2 px-1', meter === 'flow' ? 'pt-2' : 'pt-3')}>
      <div className="flex gap-1.5">
        {LEVELS.map((entry, index) => (
          <span key={entry.label} className="h-1 flex-1 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/10">
            <motion.span
              initial={{ scaleX: 0 }}
              animate={{ scaleX: index < level ? 1 : 0, backgroundColor: shownLevel.color }}
              transition={animated({ ...SPRING, delay: index * 0.04 })}
              className="block h-full origin-left rounded-full"
            />
          </span>
        ))}
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-black/40 dark:text-white/40">Password strength</span>
        <span aria-live="polite" className="relative flex h-4 justify-end overflow-hidden font-medium text-black/70 dark:text-white/70">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span key={level} initial={{ y: '100%', opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: '-100%', opacity: 0 }} transition={animated(SPRING)}>
              {shownLevel.label}
            </motion.span>
          </AnimatePresence>
        </span>
      </div>
    </div>
  );

  return (
    <div data-slot="password-input" data-visible={visible} className={cn('relative flex w-full flex-col', disabled && 'pointer-events-none opacity-50', className)}>
      <div
        data-slot="password-input-field"
        className={cn(
          'relative flex items-center bg-[#F4F4F9] text-black shadow-[0_1px_2px_rgba(0,0,0,0.04),0_2px_8px_rgba(0,0,0,0.05)] dark:bg-[#262626] dark:text-white dark:shadow-none',
          scale.field,
          invalid && 'ring-2 ring-[#FF3B30]/70',
        )}
      >
        <div className="relative h-full min-w-0 flex-1">
          <input
            ref={input}
            {...props}
            type={visible ? 'text' : 'password'}
            value={password}
            placeholder={placeholder}
            disabled={disabled}
            autoComplete={autoComplete}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={invalid || undefined}
            data-slot="password-input-control"
            onChange={(event) => {
              if (value === undefined) setUncontrolled(event.target.value);
              onChange?.(event.target.value);
              sync();
            }}
            onSelect={sync}
            onScroll={sync}
            onFocus={(event) => {
              setFocused(true);
              sync();
              onFocus?.(event);
            }}
            onBlur={(event) => {
              setFocused(false);
              onBlur?.(event);
            }}
            className={cn(
              'absolute inset-0 size-full bg-transparent pr-2 font-mono text-transparent caret-transparent outline-none [-webkit-text-fill-color:transparent] selection:bg-transparent placeholder:text-transparent autofill:shadow-[inset_0_0_0_100px_#F4F4F9] dark:autofill:shadow-[inset_0_0_0_100px_#262626]',
              scale.text,
              scale.pad,
              inputClassName,
            )}
          />

          <div aria-hidden data-slot="password-input-display" className={cn('pointer-events-none absolute inset-y-0 right-2 overflow-hidden font-mono', scale.text, scale.left)}>
            {!password && placeholder && <span className="absolute inset-y-0 left-0 flex items-center whitespace-nowrap font-sans text-black/40 dark:text-white/40">{placeholder}</span>}

            <div className="relative flex h-full items-center" style={{ transform: `translateX(${-selection.scroll}px)` }}>
              {focused && selection.end > selection.start && (
                <span
                  className={cn('absolute top-1/2 -translate-y-1/2 rounded bg-[#FC4C01]/25', scale.mark)}
                  style={{ left: `${selection.start}ch`, width: `${selection.end - selection.start}ch` }}
                />
              )}

              {chars.map((char, index) => (
                <Glyph key={index} char={char} visible={visible} reduceMotion={reduceMotion} />
              ))}

              {focused && selection.start === selection.end && (
                <motion.span
                  // remounting restarts the blink, so the caret stays solid while typing
                  key={`${selection.end}:${chars.length}`}
                  data-slot="password-input-caret"
                  animate={{ opacity: [1, 1, 0, 0] }}
                  transition={BLINK}
                  style={{ left: `${selection.end}ch` }}
                  className={cn('absolute top-1/2 -ml-px w-0.5 -translate-y-1/2 rounded-full bg-black dark:bg-white', scale.caret)}
                />
              )}
            </div>
          </div>
        </div>

        <button
          type="button"
          data-slot="password-input-toggle"
          aria-label={visible ? 'Hide' : 'Show'}
          aria-pressed={visible}
          disabled={disabled}
          onPointerDown={(event) => event.preventDefault()}
          onClick={toggle}
          className={cn(
            'ab-pill grid shrink-0 place-items-center rounded-lg text-black/50 outline-none hover:text-black focus-visible:ring-2 focus-visible:ring-[#FC4C01]/50 dark:text-white/50 dark:hover:text-white',
            scale.toggle,
          )}
        >
          <Eye open={visible} reduceMotion={reduceMotion} className={scale.eye} />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {strength && level > 0 && (meter === 'flow' ? (
          <motion.div
            key="meter"
            data-slot="password-input-strength"
            data-level={level}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={animated(REVEAL)}
            className="overflow-hidden"
          >
            {bars}
          </motion.div>
        ) : (
          <motion.div
            key="meter"
            data-slot="password-input-strength"
            data-level={level}
            initial={{ opacity: 0, y: -4, filter: 'blur(2px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -4, filter: 'blur(2px)' }}
            transition={animated(REVEAL)}
            // out of flow so the field stays put when the meter appears
            className="absolute inset-x-0 top-full"
          >
            {bars}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export default PasswordInput;
