import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ChevronDown } from './icons';
import { cn } from './cn';
import { Icon } from './Icon';

/*
 * Rare UI's fields: a filled squircle with no border; the pointer deepens the fill, focus is a quiet ink ring (never a
 * border colour, never the accent: an orange outline read as a stray border, the owner's call 2026-11-18), a wrong
 * value a red one. `FIELD_SHAPE` is the one-line field's size and shape (a pill in the Round look, `ab-pill`), for
 * callers that draw their own; a textarea keeps its corners.
 */
export const FIELD_CLASS =
  'squircle w-full border-0 bg-surface-2 text-fg text-copy placeholder:text-muted outline-none ' +
  'transition-[box-shadow,background-color] duration-150 ease-rare hover:bg-surface-3 ' +
  'focus:bg-surface-2 focus:shadow-[0_0_0_1.5px_color-mix(in_srgb,var(--ab-fg)_26%,transparent)] ' +
  'disabled:opacity-50 aria-[invalid=true]:shadow-[0_0_0_2px_color-mix(in_srgb,var(--ab-danger)_70%,transparent)]';
export const FIELD_SHAPE = 'ab-pill h-9 rounded-control px-3';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} data-slot="input" className={cn(FIELD_CLASS, FIELD_SHAPE, className)} {...rest} />;
});

/** Autosizing textarea (CSS field-sizing, supported by Electron's Chromium). */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number; maxHeight?: number }>(
  function Textarea({ className, minRows = 3, maxHeight = 320, style, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        data-slot="textarea"
        rows={minRows}
        className={cn(FIELD_CLASS, 'resize-none rounded-control-lg px-3 py-2.5 leading-relaxed [field-sizing:content]', className)}
        style={{ maxHeight, ...style }}
        {...rest}
      />
    );
  },
);

/** `fit`: as wide as the chosen option (no gap before the arrow), instead of filling its box. */
export function Select({ className, children, fit, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode; fit?: boolean }) {
  return (
    <div className={cn('relative', fit && 'inline-flex', className)}>
      <select data-slot="select" className={cn(FIELD_CLASS, FIELD_SHAPE, 'appearance-none pr-8', fit && 'w-auto [field-sizing:content]')} {...rest}>
        {children}
      </select>
      <Icon icon={ChevronDown} size={14} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted" />
    </div>
  );
}

/** A field's label: Settings' row title, a step smaller (dialogs stack many). Also for groups that aren't one field. */
export const FIELD_LABEL = 'text-ui font-semibold tracking-ui text-fg';
/** The line under a field: Settings' row description. */
export const FIELD_HINT = 'text-note leading-normal text-muted';

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className={FIELD_LABEL}>{label}</span>
      {children}
      {hint ? <span className={FIELD_HINT}>{hint}</span> : null}
    </label>
  );
}
