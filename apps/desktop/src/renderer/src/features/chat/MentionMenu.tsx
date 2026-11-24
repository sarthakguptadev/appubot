// The composer's @ menu, at the @ being typed (like Slack's or Discord's): in a bot's chat the user's other bots, to
// hand one a task (chat-core handoff.ts); in a group room its members and @everyone, who answer the message. Rows as a
// group's + menu has them ("Ask Ada"); more letters filter it, ↑↓ move, Enter or Tab puts "@Name " in, Esc closes it.
// A popover in T3 Code's manner (lib/motion.ts): a 150ms fade from 98%.
import { memo } from 'react';
import type { Bot } from '@appubot/protocol';
import { Users } from '../../components/ui/icons';
import { BotAvatar, Icon, MENU_ITEM, cn } from '../../components/ui';

/** one row: a bot, or everyone in a group room */
export type MentionItem = { kind: 'bot'; bot: Bot } | { kind: 'everyone' };

export const mentionName = (it: MentionItem): string => (it.kind === 'bot' ? it.bot.name : 'everyone');

/** The choices for what was typed after @, floating over the @ itself (`at`: from the composer's left and bottom). */
export const MentionMenu = memo(function MentionMenu({ items, active, at, onPick, onHover }: { items: MentionItem[]; active: number; at: { left: number; bottom: number }; onPick: (it: MentionItem) => void; onHover: (i: number) => void }) {
  if (!items.length) return null;
  return (
    <div
      role="listbox"
      aria-label="Mention a bot"
      style={{ left: at.left, bottom: at.bottom }}
      className="glass-popover absolute z-20 max-h-[min(318px,50vh)] w-max max-w-[280px] min-w-[200px] animate-[pop-in_150ms_var(--ease-t3)] overflow-y-auto overscroll-contain rounded-pop p-1.5"
    >
      {items.map((it, i) => (
        <button
          key={it.kind === 'bot' ? it.bot.id : 'everyone'}
          type="button"
          role="option"
          aria-selected={i === active}
          ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => { e.preventDefault(); onPick(it); }}
          className={cn(MENU_ITEM, 'text-fg', i === active && 'bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)]')}
        >
          {it.kind === 'bot' ? <BotAvatar bot={it.bot} size={16} still /> : <Icon icon={Users} size={16} className="text-muted" />}
          <span className="flex-1 truncate">Ask {mentionName(it)}</span>
        </button>
      ))}
    </div>
  );
});

/** CSS a textarea's text lays out by, copied onto its mirror so the caret falls where it does there */
const MIRRORED = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'tabSize'] as const;

/**
 * Where character `index` of a textarea sits, from the textarea's own top left (its scroll taken off): a hidden copy of
 * the text up to it, laid out the same, with a marker at its end.
 */
export function caretPoint(ta: HTMLTextAreaElement, index: number): { left: number; top: number } {
  const css = getComputedStyle(ta);
  const mirror = document.createElement('div');
  for (const k of MIRRORED) mirror.style[k] = css[k];
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden' });
  mirror.textContent = ta.value.slice(0, index);
  const mark = document.createElement('span');
  mark.textContent = '\u200b';
  mirror.appendChild(mark);
  document.body.appendChild(mirror);
  const point = { left: mark.offsetLeft - ta.scrollLeft, top: mark.offsetTop - ta.scrollTop };
  mirror.remove();
  return point;
}
