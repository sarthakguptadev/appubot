import { memo } from 'react';
import type { SlashCommand } from '@appubot/protocol';
import { cn } from '../../components/ui';

const NONE: SlashCommand[] = [];

export function filterCommands(commands: SlashCommand[], text: string): SlashCommand[] {
  // the same empty list each time: the menu (a memo) stays put while ordinary text is typed
  if (!text.startsWith('/') || /\s/.test(text)) return NONE;
  const q = text.slice(1).toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(q) || (q.length > 1 && c.name.toLowerCase().includes(q))).slice(0, 8);
}

/** Slash-command suggestions floating above the composer. */
export const SlashMenu = memo(function SlashMenu({ items, active, onPick, onHover }: { items: SlashCommand[]; active: number; onPick: (c: SlashCommand) => void; onHover: (i: number) => void }) {
  if (!items.length) return null;
  return (
    // past 8 commands it scrolls (half of the 9th shows), following the one picked with the arrow keys
    <div role="listbox" aria-label="Commands" className="glass-popover absolute right-0 bottom-full left-0 z-20 mb-2 max-h-[280px] animate-[pop-in_.3s_var(--ease-spring-soft)] overflow-y-auto overscroll-contain rounded-pop p-1.5">
      {items.map((c, i) => (
        <button
          key={c.name}
          type="button"
          role="option"
          aria-selected={i === active}
          ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => { e.preventDefault(); onPick(c); }}
          className={cn('ab-pill squircle flex h-9 w-full items-center gap-3 rounded-control-sm px-3 text-left', i === active && 'bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)]')}
        >
          <span className="font-mono text-ui text-fg">/{c.name}</span>
          {c.hint ? <span className="font-mono text-note text-muted">{c.hint}</span> : null}
          <span className="min-w-0 flex-1 truncate text-right text-ui text-muted">{c.description}</span>
        </button>
      ))}
    </div>
  );
});
