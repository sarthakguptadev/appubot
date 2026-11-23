import type { ReactNode } from 'react';
import { cn } from '../ui';

/** Row hover/selection tint shared with the sidebar's bot rows. */
export const ROW_HOVER = 'hover:bg-[color-mix(in_srgb,var(--ab-fg)_4.5%,transparent)]';
export const ROW_ACTIVE = 'bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)]';

/**
 * What a right-panel tab can do, in a row at its top right (New, Refresh, Save). No title: the tab under the bot's name
 * already says which one it is. Nothing where the tab has no actions.
 */
export function PanelHeader({ actions, className }: { actions?: ReactNode; className?: string }) {
  if (!actions) return null;
  return <div className={cn('flex min-h-7 shrink-0 items-center justify-end gap-1 px-4 pb-2.5', className)}>{actions}</div>;
}

/** Small muted heading over a group of rows. */
export function PanelSectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-2 px-2 text-note font-medium text-muted">
      <span className="flex-1">{children}</span>
      {action}
    </div>
  );
}
