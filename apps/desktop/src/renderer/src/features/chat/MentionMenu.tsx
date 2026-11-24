// The composer's @ menu in a bot's chat: the user's other bots, to hand one a task (chat-core handoff.ts). It looks
// like a group room's "Ask Ada" rows (the + menu there, GroupView) but follows the typing, like a messaging app's
// mention list: ↑↓ pick, Enter or Tab puts "@Name " in, Esc closes it. A menu: it shows at once, with no motion
// (lib/motion.ts).
import { memo } from 'react';
import type { Bot } from '@appubot/protocol';
import { BotAvatar, MENU_ITEM, cn } from '../../components/ui';

/** The bots that fit what was typed after @, floating above the composer. */
export const MentionMenu = memo(function MentionMenu({ items, active, onPick, onHover }: { items: Bot[]; active: number; onPick: (b: Bot) => void; onHover: (i: number) => void }) {
  if (!items.length) return null;
  return (
    <div role="listbox" aria-label="Hand to a bot" className="glass-popover absolute bottom-full left-0 z-20 mb-2 max-h-[min(318px,50vh)] min-w-[210px] overflow-y-auto overscroll-contain rounded-pop p-1.5">
      {items.map((b, i) => (
        <button
          key={b.id}
          type="button"
          role="option"
          aria-selected={i === active}
          ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => { e.preventDefault(); onPick(b); }}
          className={cn(MENU_ITEM, 'text-fg', i === active && 'bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)]')}
        >
          <BotAvatar bot={b} size={16} still />
          <span className="flex-1 truncate">Ask {b.name}</span>
        </button>
      ))}
    </div>
  );
});
