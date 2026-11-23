// The hover actions beside a message bubble: react (bot replies only) and copy, with when it was sent under ⋯ (a
// reply) or (i) (your own message: where it was sent from, the exact time and what it carried, `messageInfo.ts`; the
// chat shows no "from your phone" line under the bubble). ⋯ and (i) open the same menu (`DetailsMenu`), so both read
// alike in either theme. They sit on the bubble's open side: right of the bot's reply, left of your own message,
// mirrored so react stays nearest the bubble. Each of a reply's bubbles has its own (copy copies that bubble).
import type { ReactNode } from 'react';
import { clockHours } from '@appubot/chat-core';
import type { Message } from '@appubot/protocol';
import { Clock, Info, Mic, MoreHorizontal, Paperclip, Repeat, Smartphone, Telegram, Laptop, Bot, type IconComponent } from '../../components/ui/icons';
import { Icon, Menu, Tooltip, cn } from '../../components/ui';
import { MACHINE } from '../../lib/platform';
import { CopyButton } from './Markdown';
import { ReactionButton } from './Reactions';
import { messageInfo, type InfoSource } from '@appubot/chat-core';

/** shows while its group is hovered, one of its buttons has focus, or a picker/menu of it is open */
export const HOVER_ACTIONS = 'opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100';

const fullTime = (t: number) =>
  new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...clockHours() });

const ACTION_BUTTON = 'inline-flex size-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-fg/5 hover:text-fg focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]';

const SOURCE_ICONS: Record<InfoSource, IconComponent> = { computer: Laptop, phone: Smartphone, telegram: Telegram, routine: Repeat, appubot: Bot, bot: Bot };
const ROW_ICONS: Record<string, IconComponent> = { Sent: Clock, Spoken: Mic, Attached: Paperclip };

interface DetailRow { label: string; icon: IconComponent; hint?: ReactNode }

/** ⋯ / (i): a message's details as rows of a menu that only reads (Esc, a click outside or the button again closes it) */
function DetailsMenu({ label, icon, rows, side }: { label: string; icon: IconComponent; rows: DetailRow[]; side: 'left' | 'right' }) {
  return (
    <Menu
      align={side === 'right' ? 'start' : 'end'}
      items={rows.map((r) => ({ ...r, disabled: true, onSelect: () => undefined }))}
      trigger={(p) => (
        <Tooltip label={label}>
          <button type="button" aria-label={label} {...p} className={ACTION_BUTTON}>
            <Icon icon={icon} size={14} />
          </button>
        </Tooltip>
      )}
    />
  );
}

/** your message's rows: where it came from (with its note), the exact time, a spoken length, what it carried */
function sentRows(msg: Message): DetailRow[] {
  const info = messageInfo(msg, MACHINE);
  return info.rows.map((r, i) => ({
    label: r.text,
    icon: i === 0 ? SOURCE_ICONS[info.source] : ROW_ICONS[r.label] ?? Info,
    hint: r.note ? <span className="pl-3 text-muted">{r.note}</span> : undefined,
  }));
}

export function MessageActions({ text, msg, sent, at, side, sentLabel = 'Sent', className }: {
  /** what copy copies (no copy button without it) */
  text?: string;
  /** the bot's reply, to react to */
  msg?: Message;
  /** your own message: (i) with its details takes ⋯'s place */
  sent?: Message;
  /** when it was sent (shown in the ⋯ menu) */
  at: number;
  /** which side of the bubble the actions sit on: the order mirrors so react stays nearest the bubble */
  side: 'left' | 'right';
  sentLabel?: string;
  className?: string;
}) {
  const more = sent
    ? <DetailsMenu label="Message info" icon={Info} rows={sentRows(sent)} side={side} />
    : <DetailsMenu label="More" icon={MoreHorizontal} rows={[{ label: `${sentLabel} ${fullTime(at)}`, icon: Clock }]} side={side} />;
  const copy = text?.trim() ? <CopyButton text={text} label={msg ? 'Copy reply' : 'Copy message'} iconOnly className="hover:bg-fg/5" /> : null;
  const react = msg ? <ReactionButton msg={msg} /> : null;
  return (
    <div className={cn('flex shrink-0 items-center gap-0.5', HOVER_ACTIONS, className)}>
      {side === 'right' ? <>{react}{copy}{more}</> : <>{more}{copy}{react}</>}
    </div>
  );
}
