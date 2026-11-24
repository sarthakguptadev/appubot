/**
 * DurationPicker: numbers in a row of squircle segments ("9 Hr. 30 Min.") that read as one pill until the pen is
 * pressed; then the segments spring apart, the numbers become fields, and the pen morphs into a tick that saves.
 *
 * Ported from Rare UI's `components/ui/duration-picker.tsx` (https://rareui.com).
 * Copyright (c) 2026 Swami Malode. MIT + Commons Clause + Attribution (apps/desktop/scripts/licenses/RareUI.txt).
 *
 * The segments, their squircle clip, the gap, sway and error springs, the pen that morphs into a tick and the
 * colours are Rare UI's. Changed for AppuBot: the row takes any segments (`SegmentPicker`), so the same design picks
 * a time of day and a date as well as a duration (components/ui/TimeDate.tsx): a number segment has a `min`, zero
 * padding and a placeholder, and a word segment flips between its options (AM / PM); a `sm` size sits in a form's
 * row; pressing a number opens the editor on it, a full field moves on to the next, Enter saves, and leaving the row
 * saves too; fields are text inputs that take digits only (a number input drops a leading zero's place). Rare UI's
 * radix Slot and react-use-measure are replaced by a motion.button and a ResizeObserver; the row's ends are round in
 * the Round look (Settings › Appearance), like the app's other fields.
 */
import { getSvgPath } from 'figma-squircle';
import { interpolate } from 'flubber';
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, useVelocity, type MotionStyle, type MotionValue } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useAppearancePrefs } from '../../lib/appearance';
import { cn } from '../ui/cn';

const PEN_PATH = 'M3.78181 16.3092L3 21L7.69086 20.2182C8.50544 20.0825 9.25725 19.6956 9.84119 19.1116L20.4198 8.53288C21.1934 7.75922 21.1934 6.5049 20.4197 5.73126L18.2687 3.58024C17.495 2.80658 16.2406 2.80659 15.4669 3.58027L4.88841 14.159C4.30447 14.7429 3.91757 15.4947 3.78181 16.3092Z';
const TICK_PATH = 'M7.959 20.513L1.592 12.872L3.128 11.592L8.041 17.487L20.947 3.587L22.413 4.948L7.959 20.513Z';

const GAP_SPRING = { stiffness: 200, damping: 28, mass: 1 };
const ICON_SPRING = { stiffness: 200, damping: 28 };
const WIDTH_SPRING = { stiffness: 250, damping: 31 };
const SWAY_SPRING = { stiffness: 200, damping: 24 };
const ERROR_SPRING = { stiffness: 700, damping: 9 };

const SIZES = {
  md: { gap: 8, radius: 12, pill: 24, box: 'h-12', toggle: 'size-12', text: 'text-base', icon: 18, field: 44 },
  sm: { gap: 6, radius: 10, pill: 18, box: 'h-9', toggle: 'size-9', text: 'text-[13.5px]', icon: 15, field: 34 },
} as const;
export type PickerSize = keyof typeof SIZES;

const SURFACE = 'bg-[#F4F4F9] dark:bg-[#262626]';

/** A number with a label after it, or a word that flips between its options. */
export type PickerSegment =
  | { id: string; label: string; max: number; min?: number; pad?: number; placeholder?: string; blankZero?: boolean; name?: string }
  | { id: string; options: readonly string[]; name?: string };

/** each segment's number (a word segment's is its option's place); undefined while a number is blank */
export type PickerValues = Record<string, number | undefined>;

export type SegmentPickerProps = Omit<ComponentProps<'div'>, 'onChange' | 'defaultValue'> & {
  segments: readonly PickerSegment[];
  values: PickerValues;
  onChange?: (values: PickerValues) => void;
  /** the tick, Enter, or focus leaving the row */
  onConfirm?: (values: PickerValues) => void;
  onEditingChange?: (editing: boolean) => void;
  defaultEditing?: boolean;
  disabled?: boolean;
  size?: PickerSize;
  editLabel?: string;
  saveLabel?: string;
};

const isWord = (s: PickerSegment): s is Extract<PickerSegment, { options: readonly string[] }> => 'options' in s;
const clampTo = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.trunc(n) || 0));

function textOf(seg: PickerSegment, v: number | undefined): string {
  if (isWord(seg)) return String(clampTo(v ?? 0, 0, seg.options.length - 1));
  return v === undefined || (seg.blankZero && v === 0) ? '' : String(clampTo(v, 0, seg.max));
}

function numberOf(seg: PickerSegment, text: string): number | undefined {
  if (isWord(seg)) return clampTo(Number(text), 0, seg.options.length - 1);
  if (text === '') return seg.blankZero ? 0 : undefined;
  return clampTo(Number(text), 0, seg.max);
}

const sameValue = (seg: PickerSegment, a: number | undefined, b: number | undefined) =>
  a === b || (!isWord(seg) && !!seg.blankZero && (a ?? 0) === (b ?? 0));

type SquircleSegmentProps = {
  as?: 'div' | 'button';
  leftRadius: number | MotionValue<number>;
  rightRadius: number | MotionValue<number>;
  className?: string;
  style?: MotionStyle;
  children: ReactNode;
  button?: Omit<ComponentProps<typeof motion.button>, 'ref' | 'style' | 'className' | 'children'>;
};

const radiusValue = (radius: number | MotionValue<number>) => (typeof radius === 'number' ? radius : radius.get());

function SquircleSegment({ as = 'div', leftRadius, rightRadius, className, style, children, button }: SquircleSegmentProps) {
  const ref = useRef<HTMLElement | null>(null);
  const width = useMotionValue(0);
  const height = useMotionValue(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = (w: number, h: number) => {
      width.set(w);
      height.set(h);
    };
    read(el.offsetWidth, el.offsetHeight);
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.borderBoxSize?.[0];
      read(box?.inlineSize ?? el.offsetWidth, box?.blockSize ?? el.offsetHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [width, height]);

  const clipPath = useTransform(() => {
    const w = width.get();
    const h = height.get();
    if (w <= 0 || h <= 0) return 'none';
    const left = radiusValue(leftRadius);
    const right = radiusValue(rightRadius);
    const path = getSvgPath({ width: w, height: h, topLeftCornerRadius: left, bottomLeftCornerRadius: left, topRightCornerRadius: right, bottomRightCornerRadius: right, cornerSmoothing: 1 });
    return `path('${path}')`;
  });

  if (as === 'button') {
    return (
      <motion.button data-slot="duration-picker-segment" ref={(el) => { ref.current = el; }} className={className} style={{ ...style, clipPath }} {...button}>
        {children}
      </motion.button>
    );
  }
  return (
    <motion.div data-slot="duration-picker-segment" ref={(el) => { ref.current = el; }} className={className} style={{ ...style, clipPath }}>
      {children}
    </motion.div>
  );
}

type NumberFieldProps = {
  seg: Extract<PickerSegment, { max: number }>;
  text: string;
  onText: (text: string, full: boolean) => void;
  isEditing: boolean;
  reduce: boolean;
  disabled: boolean;
  swayX: MotionValue<number>;
  size: PickerSize;
  setRef: (el: HTMLInputElement | null) => void;
  onBegin: () => void;
  onEnter: () => void;
};

function NumberField({ seg, text, onText, isEditing, reduce, disabled, swayX, size, setRef, onBegin, onEnter }: NumberFieldProps) {
  const measureRef = useRef<HTMLSpanElement>(null);
  const [textWidth, setTextWidth] = useState(0);
  const errorX = useSpring(0, ERROR_SPRING);
  const x = useTransform(() => swayX.get() + errorX.get());
  const scale = SIZES[size];
  const digits = String(seg.max).length;
  const placeholder = seg.placeholder ?? '0';
  // closed, a time reads 09 and 05; open, the field holds what was typed
  const shown = !isEditing && text && seg.pad ? text.padStart(seg.pad, '0') : text;

  useLayoutEffect(() => {
    if (measureRef.current) setTextWidth(measureRef.current.offsetWidth);
  }, [shown, placeholder]);

  const change = (raw: string) => {
    let next = raw.replace(/\D/g, '');
    // typing after a leading zero ("0" then "45") keeps the number, not the zero
    if (next.length > digits) next = next.replace(/^0+/, '').slice(0, digits + 1);
    if (next !== '' && Number(next) > seg.max) {
      onText(String(seg.max), true);
      if (!reduce) {
        errorX.jump(6);
        errorX.set(0);
      }
      return;
    }
    onText(next, next.length >= digits);
  };

  const collapsedWidth = Math.max(textWidth + 12, 22);
  const openWidth = Math.max(scale.field, digits * 10 + 18);

  return (
    <>
      <motion.input
        data-slot="duration-picker-input"
        ref={setRef}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        aria-label={seg.name ?? seg.label}
        value={shown}
        onChange={(e) => change(e.target.value)}
        onFocus={(e) => {
          onBegin();
          e.target.select();
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          onEnter();
        }}
        placeholder={isEditing ? '' : placeholder}
        readOnly={!isEditing}
        disabled={disabled}
        style={{ x, width: isEditing ? openWidth : collapsedWidth }}
        animate={{ width: isEditing ? openWidth : collapsedWidth }}
        transition={reduce ? { duration: 0 } : { type: 'spring', ...WIDTH_SPRING }}
        className={cn('h-full bg-transparent text-center font-semibold tabular-nums text-black outline-none placeholder:text-[#868593]/60 dark:text-white', !isEditing && 'cursor-pointer', scale.text)}
      />
      <span ref={measureRef} aria-hidden className={cn('invisible absolute whitespace-pre font-semibold tabular-nums', scale.text)}>{shown || placeholder}</span>
    </>
  );
}

/** A row of segments with the pen that opens them: the engine under DurationPicker, the time and the date pickers. */
export function SegmentPicker({
  segments,
  values,
  onChange,
  onConfirm,
  onEditingChange,
  defaultEditing = false,
  disabled = false,
  size = 'md',
  editLabel = 'Edit',
  saveLabel = 'Save',
  className,
  ...props
}: SegmentPickerProps) {
  const scale = SIZES[size];
  const open = scale.gap;
  const corner = useAppearancePrefs().shape === 'round' ? scale.pill : scale.radius;
  const [isEditing, setIsEditing] = useState(defaultEditing);
  const [texts, setTexts] = useState<Record<string, string>>(() => Object.fromEntries(segments.map((s) => [s.id, textOf(s, values[s.id])])));
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef(defaultEditing);

  // the caller's values win whenever they aren't what the fields already say
  const key = segments.map((s) => `${s.id}:${values[s.id] ?? ''}`).join('|');
  useEffect(() => {
    setTexts((now) => {
      let next = now;
      for (const s of segments) {
        if (sameValue(s, numberOf(s, now[s.id] ?? ''), values[s.id])) continue;
        if (next === now) next = { ...now };
        next[s.id] = textOf(s, values[s.id]);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const toValues = (from: Record<string, string>): PickerValues => Object.fromEntries(segments.map((s) => [s.id, numberOf(s, from[s.id] ?? '')]));

  const setText = (id: string, text: string) => {
    const next = { ...texts, [id]: text };
    setTexts(next);
    onChange?.(toValues(next));
  };

  const reduce = !!useReducedMotion();
  const gap = useSpring(defaultEditing ? open : 0, GAP_SPRING);
  const openness = (v: number) => Math.min(open, Math.max(0, v)) / open;
  const segmentSpacing = useTransform(gap, (v) => `${Math.min(open, Math.max(0, v)) - (1 - openness(v))}px`);
  const innerRadius = useTransform(gap, (v) => corner * openness(v));
  const innerPadRight = useTransform(gap, (v) => `${3 + 9 * openness(v)}px`);
  const innerPadLeft = useTransform(gap, (v) => `${9 * openness(v)}px`);
  const gapVelocity = useVelocity(gap);
  const swayXRaw = useTransform(gapVelocity, [-70, 0, 70], [-3, 0, 3], { clamp: true });
  const swayX = useSpring(swayXRaw, SWAY_SPRING);
  const iconProgress = useSpring(defaultEditing ? 1 : 0, ICON_SPRING);
  const iconPath = useTransform(iconProgress, [0, 1], [PEN_PATH, TICK_PATH], {
    clamp: true,
    mixer: (from: string, to: string) => interpolate(from, to, { maxSegmentLength: 1 }),
  });
  const iconStrokeWidth = useTransform(iconProgress, [0, 1], [0, 2.5], { clamp: true });
  const iconStrokeOpacity = useTransform(iconProgress, [0, 1], [0, 1], { clamp: true });
  const iconDashOpacity = useTransform(iconProgress, [0, 0.4], [1, 0], { clamp: true });

  const numberIds = segments.filter((s) => !isWord(s)).map((s) => s.id);

  const setEditing = (next: boolean) => {
    if (disabled || next === editingRef.current) return;
    editingRef.current = next;
    const targetGap = next ? open : 0;
    const targetIcon = next ? 1 : 0;
    if (reduce) {
      gap.jump(targetGap);
      iconProgress.jump(targetIcon);
    } else {
      gap.set(targetGap);
      iconProgress.set(targetIcon);
    }
    setIsEditing(next);
    onEditingChange?.(next);
    if (next) return;
    // saved: a number under its smallest takes it
    let saved = texts;
    for (const s of segments) {
      if (isWord(s) || !s.min) continue;
      const t = texts[s.id] ?? '';
      if (t === '' || Number(t) >= s.min) continue;
      if (saved === texts) saved = { ...texts };
      saved[s.id] = String(s.min);
    }
    if (saved !== texts) {
      setTexts(saved);
      onChange?.(toValues(saved));
    }
    onConfirm?.(toValues(saved));
  };

  const toggleEdit = () => {
    const next = !editingRef.current;
    setEditing(next);
    const first = numberIds[0];
    if (next && first) inputs.current[first]?.focus();
  };

  const focusAfter = (id: string) => {
    const at = numberIds.indexOf(id);
    const next = numberIds[at + 1];
    if (!next) return;
    const el = inputs.current[next];
    el?.focus();
    el?.select();
  };

  const left = (i: number) => (i === 0 ? corner : innerRadius);

  return (
    <motion.div
      ref={rootRef}
      data-slot="duration-picker"
      data-editing={isEditing || undefined}
      data-disabled={disabled || undefined}
      onBlur={(e: FocusEvent<HTMLDivElement>) => {
        // focus left the row: what was typed is saved
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setEditing(false);
      }}
      className={cn('inline-flex flex-row items-center', disabled && 'opacity-50', className)}
      {...(props as ComponentProps<typeof motion.div>)}
    >
      {segments.map((seg, i) => {
        const style: MotionStyle = i === 0 ? { paddingRight: innerPadRight } : { marginLeft: segmentSpacing, paddingLeft: innerPadLeft, paddingRight: innerPadRight };
        if (isWord(seg)) {
          const at = clampTo(Number(texts[seg.id]), 0, seg.options.length - 1);
          return (
            <SquircleSegment key={seg.id} leftRadius={left(i)} rightRadius={innerRadius} style={style} className={cn(SURFACE, scale.box, 'flex items-center', i === 0 && 'pl-2')}>
              <motion.button
                type="button"
                data-slot="duration-picker-word"
                aria-label={seg.name}
                disabled={disabled}
                style={{ x: swayX }}
                onClick={() => {
                  setEditing(true);
                  setText(seg.id, String((at + 1) % seg.options.length));
                }}
                onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
                  if (e.key !== 'Enter' || !isEditing) return;
                  e.preventDefault();
                  setEditing(false);
                }}
                className={cn('h-full px-1.5 font-semibold text-black outline-none dark:text-white', scale.text)}
              >
                {seg.options[at]}
              </motion.button>
            </SquircleSegment>
          );
        }
        return (
          <SquircleSegment key={seg.id} leftRadius={left(i)} rightRadius={innerRadius} style={style} className={cn(SURFACE, scale.box, 'relative flex items-center gap-1', i === 0 && 'pl-2')}>
            <NumberField
              seg={seg}
              text={texts[seg.id] ?? ''}
              onText={(text, full) => {
                setText(seg.id, text);
                if (full) focusAfter(seg.id);
              }}
              isEditing={isEditing}
              reduce={reduce}
              disabled={disabled}
              swayX={swayX}
              size={size}
              setRef={(el) => { inputs.current[seg.id] = el; }}
              onBegin={() => setEditing(true)}
              onEnter={() => setEditing(false)}
            />
            <motion.span style={{ x: swayX }} className={cn('font-semibold text-[#868593]/70', scale.text)}>{seg.label}</motion.span>
          </SquircleSegment>
        );
      })}
      <SquircleSegment
        as="button"
        leftRadius={innerRadius}
        rightRadius={corner}
        style={{ marginLeft: segmentSpacing }}
        className={cn(SURFACE, scale.toggle, 'flex shrink-0 items-center justify-center outline-none transition-transform active:scale-90 disabled:active:scale-100')}
        button={{ type: 'button', onClick: toggleEdit, disabled, 'aria-label': isEditing ? saveLabel : editLabel, 'data-slot': 'duration-picker-toggle' } as SquircleSegmentProps['button']}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={scale.icon} height={scale.icon}>
          <motion.path fill="#868593" stroke="#868593" strokeWidth={0} strokeLinejoin="round" strokeLinecap="round" style={{ strokeWidth: iconStrokeWidth, strokeOpacity: iconStrokeOpacity }} d={iconPath} />
          <motion.path d="M14 6L18 10" fill="none" strokeWidth={1.5} strokeLinecap="round" className="stroke-[#F4F4F9] dark:stroke-[#262626]" style={{ opacity: iconDashOpacity }} />
        </svg>
      </SquircleSegment>
    </motion.div>
  );
}

export type DurationValue = { hours: number; minutes: number };

export type DurationPickerProps = Omit<SegmentPickerProps, 'segments' | 'values' | 'onChange' | 'onConfirm' | 'editLabel' | 'saveLabel'> & {
  value: DurationValue;
  onChange?: (value: DurationValue) => void;
  onConfirm?: (value: DurationValue) => void;
  maxHours?: number;
  maxMinutes?: number;
  hoursLabel?: string;
  minutesLabel?: string;
};

/** Rare UI's own picker: hours and minutes. */
export function DurationPicker({ value, onChange, onConfirm, maxHours = 24, maxMinutes = 60, hoursLabel = 'Hr.', minutesLabel = 'Min.', ...rest }: DurationPickerProps) {
  const read = (v: PickerValues): DurationValue => ({ hours: v.hours ?? 0, minutes: v.minutes ?? 0 });
  return (
    <SegmentPicker
      segments={[
        { id: 'hours', label: hoursLabel, max: maxHours, blankZero: true, name: 'Hours' },
        { id: 'minutes', label: minutesLabel, max: maxMinutes, blankZero: true, name: 'Minutes' },
      ]}
      values={{ hours: value.hours, minutes: value.minutes }}
      onChange={onChange ? (v) => onChange(read(v)) : undefined}
      onConfirm={onConfirm ? (v) => onConfirm(read(v)) : undefined}
      editLabel="Edit duration"
      saveLabel="Save duration"
      {...rest}
    />
  );
}

export default DurationPicker;
