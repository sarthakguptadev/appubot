import type { ReactNode } from 'react';
import { cn } from './cn';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'indigo';
/* flat tinted chips, no border: pills in the Round look (`ab-pill`), small rounded rectangles in the Squircle one */
const tones: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-fg-2',
  accent: 'bg-accent-soft text-accent-strong',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  indigo: 'bg-[color-mix(in_srgb,#556adc_14%,transparent)] text-[#4250d5] dark:text-[#a7c0f1]',
};

export function Badge({ tone = 'neutral', children, className, dot }: { tone?: BadgeTone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn('ab-pill inline-flex h-5 items-center gap-1.5 rounded-[6px] px-2 text-note font-semibold leading-none tracking-ui whitespace-nowrap tabular-nums', tones[tone], className)}>
      {dot ? <span className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export function StatusDot({ tone, className, title }: { tone: 'online' | 'busy' | 'idle' | 'error' | 'warn'; className?: string; title?: string }) {
  const c = { online: 'bg-success', busy: 'bg-accent', idle: 'bg-[color-mix(in_srgb,var(--ab-fg)_25%,transparent)]', error: 'bg-danger', warn: 'bg-attention' }[tone];
  return <span title={title} className={cn('inline-block size-2 shrink-0 rounded-full', c, className)} />;
}
