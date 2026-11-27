import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { IconComponent } from './icons';
import { cn } from './cn';
import { Icon } from './Icon';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger' | 'outline';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'icon' | 'icon-sm' | 'icon-xs';

/*
 * Rare UI's controls at desktop density (the 2026-11-14 overhaul): filled, no border, a semibold label, and T3 Code's
 * press, to 97% and back (`.ab-press`). Pills, and circles for icon buttons, in the Round look (the
 * default: `ab-pill`, index.css); the squircles below in the Squircle look. Heights
 * 28 / 32 / 36 / 40 / 44 (Rare UI's are 40 / 48 / 56). An outline is a ring, never a border, so every variant is
 * the same size. Double focus ring as before.
 */
const variants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-[color-mix(in_srgb,var(--ab-primary)_84%,var(--ab-bg))] active:bg-primary',
  accent: 'bg-accent text-white hover:bg-[color-mix(in_srgb,var(--ab-accent)_88%,black)] active:bg-accent-strong',
  secondary: 'ab-edge bg-surface-2 text-fg hover:bg-surface-3 active:bg-[color-mix(in_srgb,var(--ab-fg)_12%,transparent)]',
  outline: 'bg-transparent text-fg shadow-[inset_0_0_0_1px_var(--ab-border)] hover:bg-surface-2 active:bg-surface-3',
  ghost: 'text-fg-2 hover:bg-surface-2 hover:text-fg active:bg-surface-3',
  danger: 'bg-danger-soft text-danger hover:bg-[color-mix(in_srgb,var(--ab-danger)_15%,transparent)]',
};
const sizes: Record<ButtonSize, string> = {
  xs: 'h-7 px-2.5 text-note gap-1 rounded-control-sm',
  sm: 'h-8 px-3 text-ui gap-1.5 rounded-[9px]',
  md: 'h-9 px-3.5 text-copy gap-1.5 rounded-control',
  lg: 'h-10 px-4 text-copy gap-2 rounded-control-lg',
  xl: 'h-11 px-5 text-lead gap-2 rounded-control-lg',
  icon: 'size-9 justify-center rounded-control',
  'icon-sm': 'size-8 justify-center rounded-[9px]',
  'icon-xs': 'size-7 justify-center rounded-control-sm',
};
const iconSizes: Record<ButtonSize, number> = { xs: 13, sm: 15, md: 16, lg: 17, xl: 18, icon: 18, 'icon-sm': 16, 'icon-xs': 14 };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconComponent;
  iconRight?: IconComponent;
  loading?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, iconRight, loading, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const iconSize = iconSizes[size];
  return (
    <button
      ref={ref}
      type={type}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      disabled={disabled || loading}
      className={cn(
        'group/btn ab-press ab-pill squircle no-drag inline-flex shrink-0 items-center justify-center font-semibold leading-none tracking-ui whitespace-nowrap select-none',
        'focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-bg),0_0_0_4px_var(--ab-ring)]',
        'disabled:pointer-events-none disabled:opacity-40',
        variants[variant], sizes[size], className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={iconSize - 1} /> : icon ? <Icon icon={icon} size={iconSize} /> : null}
      {children}
      {iconRight && !loading ? <Icon icon={iconRight} size={iconSize} className="transition-transform duration-200 group-hover/btn:translate-x-0.5" /> : null}
    </button>
  );
});
