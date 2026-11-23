import type { CSSProperties } from 'react';
import { cn } from '../../components/ui';

/**
 * Settings-row slider: a thin 4px line (ink up to the knob, a faint tint after it) and a small 16px white knob with a
 * hairline edge and a soft shadow, a touch bigger on hover and while dragged; focus ring on the knob.
 * A native range input underneath so keyboard / a11y come for free.
 */
export function Slider({ value, min, max, step = 1, onChange, onCommit, label, disabled, className }: {
  value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void;
  /** fired on release (pointer up / key up) - use it to persist */
  onCommit?: (v: number) => void;
  label: string; disabled?: boolean; className?: string;
}) {
  const frac = max === min ? 0 : (value - min) / (max - min);
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={(e) => onCommit?.(Number(e.currentTarget.value))}
      onKeyUp={(e) => onCommit?.(Number(e.currentTarget.value))}
      // the fill ends under the knob's centre, which travels from 8px to (width - 8px)
      style={{ '--fill': `calc(8px + (100% - 16px) * ${frac})` } as CSSProperties}
      className={cn(
        'group/slider no-drag h-5 w-44 cursor-pointer appearance-none bg-transparent outline-none disabled:cursor-not-allowed disabled:opacity-50',
        // a thin line: ink up to the knob, a faint tint after it
        '[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full',
        '[&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--ab-fg-2)_var(--fill),color-mix(in_srgb,var(--ab-fg)_12%,transparent)_var(--fill))]',
        // a small white knob with a hairline edge and a soft shadow, a touch bigger on hover and while dragged
        '[&::-webkit-slider-thumb]:-mt-1.5 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white',
        '[&::-webkit-slider-thumb]:shadow-[0_0_0_0.5px_rgba(0,0,0,0.18),0_1px_3px_rgba(0,0,0,0.22)]',
        '[&::-webkit-slider-thumb]:transition-[scale,box-shadow] [&::-webkit-slider-thumb]:duration-150 [&::-webkit-slider-thumb]:ease-out',
        'hover:[&::-webkit-slider-thumb]:scale-110 active:[&::-webkit-slider-thumb]:scale-125',
        'active:[&::-webkit-slider-thumb]:shadow-[0_0_0_0.5px_rgba(0,0,0,0.18),0_2px_6px_rgba(0,0,0,0.28)]',
        'focus-visible:[&::-webkit-slider-thumb]:shadow-[0_0_0_0.5px_rgba(0,0,0,0.18),0_0_0_3px_var(--ab-ring)]',
        className,
      )}
    />
  );
}
