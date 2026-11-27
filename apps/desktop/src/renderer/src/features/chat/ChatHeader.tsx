// The bot chat header: no bar, a clear drag strip with one capsule in its middle and nothing but the thread's state at
// its right. The capsule is the bot alone (its avatar and name; no thread beside it since 2026-11-17, the owner's "no
// threads display on top"): it opens and closes the side panel, whose first tab lists the bot's threads, and a dot on
// it says a reply waits in another of them. New thread is ⌘N, the palette and that tab. The group room's header is
// the same strip and capsule (GroupView).
import type { Bot, Thread } from '@appubot/protocol';
import { BotAvatar, Tooltip, cn } from '../../components/ui';
import { setState, ui, useStore } from '../../lib/store';
import { useWorkMood } from '../../lib/workMood';

/**
 * the capsule's one crumb is the capsule's whole face: the raised fill of the sidebar's own controls, a shade deeper
 * under the pointer edge to edge (no ring of the capsule left around it), 40px tall, a pill in the Round look
 */
export const CRUMB = 'ab-edge ab-pill no-drag squircle flex h-10 min-w-0 items-center gap-2 rounded-control-lg bg-surface-2 hover:bg-surface-3 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]';
/**
 * The header's strip: three columns, so the capsule sits in the chat's middle whatever is at its right. 64px tall (main's `TOP_STRIP`: the capsule keeps 12px above it, as from the sides) and
 * a drag region like the sidebar's strip beside it; at the window's right edge (no side panel) the buttons keep clear
 * of Windows' and Linux's window buttons (`--wco-right`, set by the caller).
 */
export const HEADER_STRIP = 'app-header drag grid h-16 shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)] items-center gap-2 pr-3 pl-3';
/** The breadcrumb's capsule: the strip's middle column, holding its one crumb. */
export const CRUMB_CAPSULE = 'no-drag flex min-w-0 max-w-full items-center';
/** the crumb's content: an avatar of 24px (the bot, a group's members) and the name in 14px medium, 7.5px before the avatar and 13.5 after the name */
export const CRUMB_LEAD = 'shrink-0 pr-[13.5px] pl-[7.5px]';
/** the name in it */
export const CRUMB_TEXT = 'truncate text-copy font-medium leading-5 text-fg';
export function ChatHeader({ bot, thread }: { bot: Bot; thread: Thread | undefined }) {
  const panelOpen = useStore((s) => s.rightOpen);
  // the thread on screen's state
  const needsYou = useStore((s) => !!thread && (thread.status === 'waiting' || s.pendingPermissions.some((p) => p.threadId === thread.id)));
  const work = useWorkMood(bot.id, thread?.id);
  const othersUnread = useStore((s) => s.threads.some((t) => t.botId === bot.id && t.id !== thread?.id && !!s.unread[t.id]));
  /** a reply waits in one of the bot's other threads */
  const unreadDot = othersUnread ? <span role="img" aria-label="Unread in another thread" className="size-1.5 shrink-0 rounded-full bg-unread" /> : null;

  // no "Working…" up here (the owner's call, 2026-11-17): the working row under the last message and the avatar's
  // motion already say it
  const status = needsYou ? <span className="text-warning">Needs you</span>
    : thread?.status === 'error' ? <span className="text-danger">Something went wrong</span>
        : null;

  return (
    <header className={HEADER_STRIP} style={panelOpen ? undefined : { paddingRight: 'calc(12px + var(--wco-right))' }}>
      {/* the left third stays empty: room to drag the window by */}
      <span aria-hidden />
      <div className={CRUMB_CAPSULE}>
      {/* the bot opens the side panel on its first tab (its threads; its settings are the next one) and closes it again */}
      <Tooltip label={panelOpen ? 'Hide details' : 'Bot details'}>
        <button
          type="button"
          onClick={() => (panelOpen ? setState({ rightOpen: false }) : ui.openRight('threads'))}
          aria-label={`${bot.name} details`}
          aria-expanded={panelOpen}
          className={cn(CRUMB, CRUMB_LEAD)}
        >
          <BotAvatar bot={bot} size={24} mood={needsYou ? 'needs-you' : work ?? 'rest'} className="ab-bot-calm" />
          <span className={cn(CRUMB_TEXT, 'max-w-[16rem]')}>{bot.name}</span>
          {unreadDot}
        </button>
      </Tooltip>
      </div>
      <div className="flex min-w-0 items-center justify-end">
        {status ? <span className="min-w-0 shrink truncate text-note text-muted">{status}</span> : null}
      </div>
    </header>
  );
}
