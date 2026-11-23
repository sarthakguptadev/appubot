import type { InputHTMLAttributes } from 'react';
import { TaskCheck } from '../rare/TaskCheck';
import { cn } from './cn';

/**
 * A checkbox drawn as Rare UI's round check (a ring that fills and draws its tick) over a real, invisible
 * `<input type="checkbox">`, so labels, the keyboard and screen readers work as with the native one.
 */
export function Checkbox({ checked, disabled, className, size = 18, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'checked'> & {
  checked: boolean;
  /** px */
  size?: number;
}) {
  return (
    <span className={cn('relative inline-flex shrink-0 align-middle', disabled && 'opacity-50', className)} style={{ width: size, height: size }}>
      <input type="checkbox" checked={checked} disabled={disabled} className="peer absolute inset-0 m-0 size-full cursor-pointer opacity-0 disabled:cursor-default" {...rest} />
      <TaskCheck checked={checked} size={size} className="pointer-events-none rounded-full peer-focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]" />
    </span>
  );
}
