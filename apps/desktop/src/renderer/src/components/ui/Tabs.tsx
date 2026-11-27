import type { LucideIcon } from './icons';
import { cn } from './cn';
import { Icon } from './Icon';

export interface TabItem<T extends string> { id: T; label: string; icon?: LucideIcon; badge?: number }

/** The track a row of segments sits on, and one segment: shared by `Tabs` and Settings' `SettingsSegmented`. */
export const SEGMENT_TRACK = 'ab-pill squircle no-drag inline-flex items-center gap-0.5 rounded-[11px] bg-surface-2 p-[3px]';
export const SEGMENT =
  'ab-pill squircle relative inline-flex items-center justify-center gap-1.5 rounded-control-sm font-semibold tracking-ui whitespace-nowrap ' +
  // keyboard focus: a quiet ring inside the segment instead of the global offset outline
  'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--ab-fg)_35%,transparent)]';
export const SEGMENT_SIZE = { sm: 'h-6 px-2.5 text-note', md: 'h-7 px-3 text-ui' } as const;

/**
 * The chosen segment's chip, in place: picking another moves it there at once (T3 Code's tabs: nothing slides).
 * `raised`: a lifted chip on a track; else a flat fill, for a row with no track.
 */
export function SegmentChip({ raised = true }: { raised?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn('ab-pill squircle absolute inset-0 rounded-control-sm', raised ? 'bg-surface shadow-lift dark:bg-[rgba(255,255,255,.12)]' : 'bg-surface-2')}
    />
  );
}

/**
 * Segmented tabs. `track` (default): the choices on a grey track, the current one a raised chip. `plain`: no track,
 * the current one a flat fill, the rest muted.
 */
export function Tabs<T extends string>({ items, value, onChange, className, size = 'md', iconOnly, variant = 'track' }: {
  items: TabItem<T>[]; value: T; onChange: (v: T) => void; className?: string; size?: 'sm' | 'md';
  /** render icons only (labels stay as title / aria-label) */
  iconOnly?: boolean;
  variant?: 'track' | 'plain';
}) {
  const plain = variant === 'plain';
  return (
    <div role="tablist" className={cn(plain ? 'no-drag inline-flex items-center gap-1' : SEGMENT_TRACK, className)}>
      {items.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            title={t.label}
            aria-label={iconOnly ? t.label : undefined}
            onClick={() => onChange(t.id)}
            className={cn(SEGMENT, SEGMENT_SIZE[size], active ? 'text-fg' : plain ? 'text-muted hover:bg-surface-2 hover:text-fg' : 'text-muted hover:text-fg')}
          >
            {active ? <SegmentChip raised={!plain} /> : null}
            <span className="relative inline-flex items-center gap-1.5">
              {t.icon ? <Icon icon={t.icon} size={16} /> : null}
              {t.label && !iconOnly ? <span>{t.label}</span> : null}
              {t.badge ? <span className="ml-0.5 rounded-full bg-accent px-1.5 text-[10px] leading-4 text-white tabular-nums">{t.badge}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
