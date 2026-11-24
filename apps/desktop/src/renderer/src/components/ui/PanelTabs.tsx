// The side panel's tab switcher, shared (2026-11-18): the panel's own rows (Threads / Computer / Advanced and the row
// under it) and the look pickers' Shapes / Generate / Image (New bot, the side panel's avatar).
import { cn } from './cn';
import { SegmentChip, type TabItem } from './Tabs';


/**
 * The panel's tabs: words in a centred row under the bot's name, the open one on a quiet chip. Lighter than the app's segmented `Tabs` (medium weight, no track), and they wrap where the panel is narrow.
 * `small`: Advanced's own row under the top one, quieter still.
 */
export function PanelTabs<T extends string>({ items, value, onChange, small }: { items: TabItem<T>[]; value: T; onChange: (t: T) => void; small?: boolean }) {
  return (
    <div role="tablist" className="no-drag flex flex-wrap items-center justify-center gap-y-1">
      {items.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cn(
              'ab-pill squircle relative inline-flex items-center rounded-control-sm px-2 whitespace-nowrap transition-colors duration-150 ease-rare',
              small ? 'h-6 text-note font-medium' : 'h-7 text-ui font-medium',
              'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--ab-fg)_35%,transparent)]',
              active ? 'text-fg' : 'text-muted hover:text-fg',
            )}
          >
            {active ? <SegmentChip raised={false} /> : null}
            <span className="relative">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

