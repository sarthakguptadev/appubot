import { useT } from '../../lib/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { botThreads, type Bot, type Group, type Thread } from '@appubot/protocol';
import { GROUP_TILE_MAX, GROUP_TILE_TURN_S, buildRoster, groupTileLayout, rosterPreview, threadTitle } from '@appubot/chat-core';
import { ChevronRight, FolderOpen, Pencil, Pin, Plus, Search, Settings, SquarePen, Trash2, Users } from '../ui/icons';
import gmailLogo from '../../assets/app-logos/gmail.svg';
import slackLogo from '../../assets/app-logos/slack.svg';
import notionLogo from '../../assets/app-logos/notion.svg';
import githubLogo from '../../assets/app-logos/github.svg';
import { BotAvatar, Button, Icon, Menu, Spinner, Tooltip, cn, type BotPresence } from '../ui';
import { call, deleteBot, deleteThread, openBot, openBotDetails, openThread, renameThread, setPinned, startThread } from '../../lib/actions';
import { rpc } from '../../lib/gateway';
import { shortcut } from '../../lib/platform';
import { useHeldFor } from '../../lib/connectionQuiet';
import { SIDEBAR_WIDTH, setState, ui, upsertThreads, useStore } from '../../lib/store';
import { WhatsNewCard } from '../../features/whatsNew/WhatsNew';
import { CloudPromoCard } from '../../features/cloud/CloudPromoCard';
import { UpdateRow } from '../../features/update/UpdateRow';
import { ComputerMenu } from '../../features/cloud/ComputerMenu';
import { useCloudLink } from '../../features/cloud/cloudClient';
import { ResizeHandle } from './ResizeHandle';
import { deleteGroup, updateGroup } from '../../features/groups/groups';

/**
 * The roster's type and fills, one set for bots and groups. A row's two lines are as tall as its picture (18 + 17 + 1 =
 * 36), so the name starts level with the avatar's top; the second line sits a step back from the name (dimmer than
 * `text-muted`), so the list reads by its names. No row says when it was last active (the owner's call, 2026-11-11).
 */
const AVATAR = 36;
/** a pinned bot's picture: well over a row's, so the pinned ones lead the roster (three still fit the narrowest sidebar) */
const PINNED_AVATAR = 64;
const ROW_ON = 'bg-[color-mix(in_srgb,var(--ab-fg)_7.5%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ab-fg)_4%,transparent)]';
const ROW_HOVER = 'hover:bg-[color-mix(in_srgb,var(--ab-fg)_4%,transparent)]';
const ROW_BUTTON = 'ab-press squircle no-drag relative flex min-w-0 flex-1 items-center gap-2.5 rounded-row p-2 text-left outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ab-ring)]';
const ROW_NAME = 'min-w-0 truncate text-copy leading-[18px] font-semibold tracking-ui text-fg';
const ROW_PREVIEW = 'truncate text-ui leading-[17px]';
const PREVIEW_INK = 'text-[color-mix(in_srgb,var(--ab-fg)_52%,transparent)]';
/** the sidebar's round buttons, one size: search and + in the top strip, Settings at the bottom (Connect apps is as tall) */
const STRIP_BUTTON = 'ab-press ab-pill squircle no-drag relative grid size-9 shrink-0 place-items-center rounded-control text-fg-2 hover:text-fg focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]';

/** The chosen row's wash, in place (T3 Code's sidebar: nothing slides between rows). */
function RowWash({ tile }: { tile?: boolean }) {
  return <span aria-hidden className={cn('squircle pointer-events-none absolute inset-0', tile ? 'rounded-[14px]' : 'rounded-row', ROW_ON)} />;
}

/**
 * A group's picture. In the sidebar its members sit on the corners of a shape that slowly turns, each bot upright
 * (Reduce motion holds it still); an empty group shows the people icon. The room's header (`bare`, a breadcrumb's
 * size, too small for a shape) lays every member in a row, each next one over the one before.
 */
export function GroupTile({ members, size = AVATAR, bare = false }: { members: Bot[]; size?: number; bare?: boolean }) {
  if (!members.length) return <span className="grid shrink-0 place-items-center text-muted" style={{ width: size, height: size }}><Icon icon={Users} size={Math.round(size * 0.5)} /></span>;
  if (!bare) {
    const shown = members.slice(0, GROUP_TILE_MAX);
    const { avatar, points } = groupTileLayout(shown.length, size);
    const spin = shown.length > 1;
    const turn = `${GROUP_TILE_TURN_S}s linear infinite`;
    return (
      <span aria-hidden className={cn('relative block shrink-0', spin && 'motion-reduce:!animate-none')} style={{ width: size, height: size, ...(spin ? { animation: `ab-orbit ${turn}` } : {}) }}>
        {shown.map((b, k) => (
          <span key={b.id} className="absolute grid place-items-center" style={{ left: points[k]!.x - avatar / 2, top: points[k]!.y - avatar / 2, width: avatar, height: avatar }}>
            <span className={cn('grid place-items-center', spin && 'motion-reduce:!animate-none')} style={spin ? { animation: `ab-orbit-upright ${turn}` } : undefined}>
              <BotAvatar bot={b} size={avatar} still />
            </span>
          </span>
        ))}
      </span>
    );
  }
  // the room's header: every member in a row, each next one laid over the one before it
  const shown = members.slice(0, GROUP_TILE_MAX);
  return (
    <span aria-hidden className="flex shrink-0 items-center">
      {shown.map((b, k) => (
        <span key={b.id} className="grid shrink-0 place-items-center" style={{ marginLeft: k ? -Math.round(size * 0.38) : 0, zIndex: k + 1 }}>
          <BotAvatar bot={b} size={size} still />
        </span>
      ))}
    </span>
  );
}

/** A group of bots in the roster: its members on a turning shape, its name, the room's last line, who is working. */
function GroupRow({ group, selected }: { group: Group; selected: boolean }) {
  const bots = useStore((s) => s.bots);
  const members = group.botIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
  const working = group.working.map((id) => bots.find((b) => b.id === id)?.name).filter(Boolean) as string[];
  return (
    <div
      onContextMenu={(e) => { e.preventDefault(); e.currentTarget.querySelector<HTMLButtonElement>('[data-group-actions]')?.click(); }}
      className={cn('group/row squircle relative flex w-full items-center rounded-row', !selected && ROW_HOVER)}
    >
      {selected ? <RowWash /> : null}
      <button type="button" aria-current={selected || undefined} onClick={() => ui.selectGroup(group.id)} className={ROW_BUTTON}>
        <span className="relative grid size-9 shrink-0 place-items-center">
          <GroupTile members={members} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="flex min-w-0 items-center gap-2">
            <span className={ROW_NAME}>{group.name}</span>
          </span>
          <span className={cn(ROW_PREVIEW, PREVIEW_INK)}>
            {working.length ? `${working.join(', ')} working…` : group.lastMessagePreview || `${members.map((b) => b.name).join(', ') || 'No bots yet'}`}
          </span>
        </span>
      </button>
      <GroupRowMenu group={group} />
    </div>
  );
}

/** A group's actions, from a right-click on its row or tile (the button only shows for keyboard focus). */
function GroupRowMenu({ group, className }: { group: Group; className?: string }) {
  const t = useT();
  // a computer from before groups could be pinned: no Pin there (it would never stick)
  const pins = useStore((s) => !!s.system?.groupPins);
  return (
    <span className={cn('pointer-events-none absolute opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100', className ?? 'top-1/2 right-1.5 -translate-y-1/2')}>
      <Menu
        trigger={(p) => <Button {...p} size="icon-xs" variant="ghost" icon={ChevronRight} aria-label={`Actions for ${group.name}`} data-group-actions className="bg-[var(--ab-popover)] shadow-[0_1px_3px_rgba(0,0,0,.12)]" />}
        items={[
          ...(pins ? [{ label: group.pinned ? t('sidebar.unpin') : t('sidebar.pin'), icon: Pin, onSelect: () => void updateGroup(group.id, { pinned: !group.pinned }) }, 'separator' as const] : []),
          { label: 'Edit group', icon: Pencil, onSelect: () => ui.openModal({ kind: 'group', groupId: group.id }) },
          'separator',
          { label: 'Delete group', icon: Trash2, danger: true, onSelect: () => deleteGroup(group) },
        ]}
      />
    </span>
  );
}

/**
 * A pinned group at the top of the roster, beside the pinned bots: its members' tile large, its name under it; the
 * open one filled like a selected row. Right-click for its actions (Unpin…).
 */
function GroupPinTile({ group, selected }: { group: Group; selected: boolean }) {
  const bots = useStore((s) => s.bots);
  const members = group.botIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
  return (
    <div
      onContextMenu={(e) => { e.preventDefault(); e.currentTarget.querySelector<HTMLButtonElement>('[data-group-actions]')?.click(); }}
      className={cn('group/tile squircle relative min-w-0 rounded-[14px]', !selected && ROW_HOVER)}
    >
      {selected ? <RowWash tile /> : null}
      <button
        type="button"
        aria-current={selected || undefined}
        onClick={() => ui.selectGroup(group.id)}
        className="ab-press squircle no-drag relative flex w-full min-w-0 flex-col items-center gap-1.5 rounded-[14px] px-1 pt-2.5 pb-2 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ab-ring)]"
      >
        <span className="grid place-items-center" style={{ width: PINNED_AVATAR, height: PINNED_AVATAR }}><GroupTile members={members} size={PINNED_AVATAR} /></span>
        <span className="max-w-full min-w-0 truncate text-ui leading-[17px] font-medium text-fg">{group.name}</span>
      </button>
      <GroupRowMenu group={group} className="top-1.5 right-1.5" />
    </div>
  );
}

/** threads an expanded bot shows at first, and how many more each "Show more" adds */
const THREADS_SHOWN = 5;
const THREADS_MORE = 10;

/** A bot: its latest message (from whichever of its threads), an unread dot for any of them, its presence. */
function BotRow({ bot, latest, selected, unread, presence, expanded, onToggle }: {
  bot: Bot; latest: Thread | undefined; selected: boolean; unread: boolean; presence: BotPresence;
  /** its threads are listed under it; clicking the bot that is already open shows or hides them */
  expanded: boolean; onToggle: () => void;
}) {
  return (
    <div
      // right-click opens the bot's actions (the menu button only shows for keyboard focus)
      onContextMenu={(e) => { e.preventDefault(); e.currentTarget.querySelector<HTMLButtonElement>('[data-bot-actions]')?.click(); }}
      className={cn(
        'group/row squircle relative flex w-full items-center rounded-row',
        !selected && ROW_HOVER,
      )}
    >
      {selected ? <RowWash /> : null}
      <button
        type="button"
        aria-current={selected || undefined}
        aria-expanded={selected ? expanded : undefined}
        onClick={() => (selected ? onToggle() : openBot(bot.id))}
        className={ROW_BUTTON}
      >
        <BotAvatar bot={bot} size={AVATAR} presence={presence} />
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="flex min-w-0 items-center gap-2">
            <span className={ROW_NAME}>{bot.name}</span>
            <span className="min-w-1 flex-1" />
            {unread ? <span role="img" aria-label="Unread" className="size-[7px] shrink-0 rounded-full bg-unread" /> : null}
          </span>
          <span className={cn(ROW_PREVIEW, unread ? 'text-fg-2' : PREVIEW_INK)}>
            {rosterPreview(bot, latest, presence)}
          </span>
        </span>
      </button>
      <BotRowMenu bot={bot} />
    </div>
  );
}

/** A bot's actions, from a right-click on its row or tile (the button only shows for keyboard focus). */
function BotRowMenu({ bot, className }: { bot: Bot; className?: string }) {
  // a remote computer's workspace folder can't open in this Mac's Finder
  const remote = useCloudLink((s) => s.computer === 'cloud');
  const groups = useStore((s) => s.groupsSupported);
  const t = useT();
  return (
    <span className={cn('pointer-events-none absolute opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100', className ?? 'top-1/2 right-1.5 -translate-y-1/2')}>
      <Menu
        trigger={(p) => <Button {...p} size="icon-xs" variant="ghost" icon={ChevronRight} aria-label={t('sidebar.actions', { name: bot.name })} data-bot-actions className="bg-[var(--ab-popover)] shadow-[0_1px_3px_rgba(0,0,0,.12)]" />}
        items={[
          { label: bot.pinned ? t('sidebar.unpin') : t('sidebar.pin'), icon: Pin, onSelect: () => setPinned(bot, !bot.pinned) },
          'separator',
          { label: t('sidebar.botSettings'), icon: Settings, onSelect: () => openBotDetails(bot.id) },
          // a group starts here (the + makes bots only): this bot in it, the others picked in the editor
          ...(groups ? [{ label: t('sidebar.makeGroup'), icon: Users, onSelect: () => ui.openModal({ kind: 'group', withBotId: bot.id }) }] : []),
          ...(remote ? [] : [{ label: t('sidebar.openWorkspace'), icon: FolderOpen, onSelect: () => void call('system.openPath', { path: bot.workspace }) }]),
          'separator',
          {
            label: t('sidebar.deleteBot'), icon: Trash2, danger: true,
            onSelect: () => deleteBot(bot, { body: t('sidebar.deleteBot.body'), confirmLabel: t('common.delete') }),
          },
        ]}
      />
    </span>
  );
}

/**
 * A pinned bot at the top of the roster: its avatar large with its presence, its name under it, an unread dot; the
 * open one filled like a selected row. Right-click for its actions (Unpin…).
 */
function BotTile({ bot, selected, unread, presence }: { bot: Bot; selected: boolean; unread: boolean; presence: BotPresence }) {
  return (
    <div
      onContextMenu={(e) => { e.preventDefault(); e.currentTarget.querySelector<HTMLButtonElement>('[data-bot-actions]')?.click(); }}
      className={cn(
        'group/tile squircle relative min-w-0 rounded-[14px]',
        !selected && ROW_HOVER,
      )}
    >
      {selected ? <RowWash tile /> : null}
      <button
        type="button"
        aria-current={selected || undefined}
        onClick={() => openBot(bot.id)}
        className="ab-press squircle no-drag relative flex w-full min-w-0 flex-col items-center gap-1.5 rounded-[14px] px-1 pt-2.5 pb-2 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ab-ring)]"
      >
        <BotAvatar bot={bot} size={PINNED_AVATAR} presence={presence} />
        <span className="flex max-w-full min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-ui leading-[17px] font-medium text-fg">{bot.name}</span>
          {unread ? <span role="img" aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-unread" /> : null}
        </span>
      </button>
      <BotRowMenu bot={bot} className="top-1.5 right-1.5" />
    </div>
  );
}

/** A thread under its bot: opens on click; right-click for its actions (Rename edits the title in place). */
function ThreadRow({ t, rowClass, onScreen, unread, waiting, renaming, onRename, onRenamed }: {
  t: Thread; rowClass: string; onScreen: boolean; unread: boolean; waiting: boolean;
  renaming: boolean; onRename: () => void; onRenamed: () => void;
}) {
  const tr = useT();
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  /** the edit ended (saved or cancelled): the blur of the input going away must not save it again */
  const ended = useRef(false);
  useEffect(() => {
    if (!renaming) return;
    ended.current = false;
    setDraft(threadTitle(t));
    requestAnimationFrame(() => input.current?.select());
  }, [renaming]);
  const save = () => { if (ended.current) return; ended.current = true; const v = draft; onRenamed(); void renameThread(t.id, v); };
  const cancel = () => { ended.current = true; onRenamed(); };

  if (renaming) {
    return (
      <li className="ml-1.5 flex h-7 w-[calc(100%-6px)] items-center pl-[15px]">
        <input
          ref={input}
          value={draft}
          maxLength={120}
          aria-label="Thread name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); save(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
          className="ab-pill squircle no-drag h-6 w-full rounded-md bg-surface-2 px-2 text-ui text-fg outline-none shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ab-fg)_22%,transparent)]"
        />
      </li>
    );
  }
  return (
    <li
      className="relative"
      // right-click opens the thread's actions (the menu button only shows for keyboard focus)
      onContextMenu={(e) => { e.preventDefault(); e.currentTarget.querySelector<HTMLButtonElement>('[data-thread-actions]')?.click(); }}
    >
      <button
        type="button"
        aria-current={onScreen || undefined}
        onClick={() => void openThread(t.id)}
        title={threadTitle(t)}
        className={cn(rowClass, onScreen ? 'font-medium text-fg' : unread ? 'text-fg-2 hover:text-fg' : 'text-muted hover:text-fg-2')}
      >
        {/* the thread on screen is the one in full ink (unread ones have their dot) */}
        <span className="min-w-0 flex-1 truncate">{threadTitle(t)}</span>
        {t.status === 'running' ? <Spinner size={11} className="shrink-0 text-muted" /> : null}
        {waiting ? <span role="img" aria-label="Needs you" className="size-1.5 shrink-0 rounded-full bg-attention" /> : null}
        {unread ? <span role="img" aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-unread" /> : null}
      </button>
      <span className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100">
        <Menu
          trigger={(p) => <Button {...p} size="icon-xs" variant="ghost" icon={ChevronRight} aria-label={tr('sidebar.actions', { name: threadTitle(t) })} data-thread-actions className="bg-[var(--ab-popover)] shadow-[0_1px_3px_rgba(0,0,0,.12)]" />}
          items={[
            { label: tr('common.rename'), icon: Pencil, onSelect: onRename },
            { label: tr('sidebar.newThread'), icon: SquarePen, onSelect: () => void startThread(t.botId) },
            'separator',
            { label: tr('sidebar.deleteThread'), icon: Trash2, danger: true, onSelect: () => deleteThread(t.id) },
          ]}
        />
      </span>
    </li>
  );
}

/**
 * An expanded bot's threads under its row (Synara's sidebar threads under a project): the latest activity first, each
 * with its state, the one on screen in bold; then "Show more" while there are more. Expanding brings
 * the bot's whole list in (the snapshot carries 200 threads in all).
 */
function BotThreads({ bot }: { bot: Bot }) {
  const all = useStore((s) => s.threads);
  const onScreenId = useStore((s) => s.selectedThreadId);
  const unread = useStore((s) => s.unread);
  const pending = useStore((s) => s.pendingPermissions);
  const threads = useMemo(() => botThreads(all, bot.id), [all, bot.id]);
  const [shown, setShown] = useState(THREADS_SHOWN);
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    void rpc('threads.list', { botId: bot.id, limit: 200 }).then((l) => upsertThreads(l)).catch(() => undefined);
  }, [bot.id]);

  // a hairline drops from the bot's avatar (its centre: the row's 8px inset + half the 36px avatar) and the titles
  // line up with the bot's name (54px in); rows hover inside the line, quieter than the bot row's own fill
  const ROW = 'no-drag ml-1.5 flex h-7 w-[calc(100%-6px)] min-w-0 items-center gap-2 squircle rounded-row pr-2 pl-[21px] text-left text-ui leading-normal outline-none hover:bg-[color-mix(in_srgb,var(--ab-fg)_3.5%,transparent)] focus-visible:shadow-[inset_0_0_0_2px_var(--ab-ring)]';
  return (
    <ul className="mt-0.5 mb-2 ml-[26px] flex flex-col border-l border-[color-mix(in_srgb,var(--ab-fg)_10%,transparent)]" aria-label={`${bot.name}'s threads`}>
      {threads.slice(0, shown).map((t) => {
        const onScreen = t.id === onScreenId;
        const isUnread = !!unread[t.id];
        const waiting = t.status === 'waiting' || pending.some((p) => p.threadId === t.id);
        return (
          <ThreadRow
            key={t.id} t={t} rowClass={ROW} onScreen={onScreen} unread={isUnread} waiting={waiting}
            renaming={renaming === t.id} onRename={() => setRenaming(t.id)} onRenamed={() => setRenaming(null)}
          />
        );
      })}
      {threads.length > shown ? (
        <li>
          <button type="button" onClick={() => setShown((n) => n + THREADS_MORE)} className={cn(ROW, 'text-muted/80 hover:text-fg-2')}>
            Show {Math.min(THREADS_MORE, threads.length - shown)} more
          </button>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * The sidebar's buttons (search, +, Settings, Connect apps) are the app's secondary button (components/ui/Button.tsx):
 * an ink fill with no outline, a light step deeper under the pointer, and a dark one while pressed or while what they
 * open is open.
 */
const RAISED = 'ab-edge bg-surface-2 hover:bg-[color-mix(in_srgb,var(--ab-fg)_7.5%,transparent)] active:bg-[color-mix(in_srgb,var(--ab-fg)_12%,transparent)]';
const RAISED_ON = 'bg-[color-mix(in_srgb,var(--ab-fg)_12%,transparent)] hover:bg-[color-mix(in_srgb,var(--ab-fg)_12%,transparent)]';

/** Opens the Connect apps popup. */
function ConnectApps() {
  const open = useStore((s) => s.appsOpen);
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={() => ui.openApps()}
      className={cn(
        'ab-press ab-pill squircle no-drag flex h-9 min-w-0 flex-1 items-center justify-center gap-2 rounded-control px-3 text-ui font-semibold tracking-ui text-fg focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-bg),0_0_0_4px_var(--ab-ring)]',
        RAISED, open && RAISED_ON,
      )}
    >
      <span className="truncate">Connect apps</span>
      <AppStack />
    </button>
  );
}

/** a few of the apps that connect, shown on the Connect apps button: their logos ship with the app, so the button is whole from the first frame and offline */
const STACK_APPS = [gmailLogo, slackLogo, notionLogo, githubLogo];
const STACK_TILE = 18;
const STACK_STEP = 12;

/** Those apps' logos as a row of small tiles, each lying over the one before it. */
function AppStack() {
  return (
    <span aria-hidden className="flex shrink-0 items-center" style={{ width: STACK_TILE + STACK_STEP * (STACK_APPS.length - 1), height: STACK_TILE }}>
      {STACK_APPS.map((logo, i) => (
        <span
          key={logo}
          className="ab-pill grid shrink-0 place-items-center overflow-hidden rounded-[6px] bg-white shadow-[0_0_0_2px_var(--ab-surface)]"
          style={{ width: STACK_TILE, height: STACK_TILE, marginLeft: i ? STACK_STEP - STACK_TILE : 0, zIndex: i }}
        >
          <img src={logo} alt="" draggable={false} className="size-[68%] object-contain" />
        </span>
      ))}
    </span>
  );
}

export function Sidebar() {
  const t = useT();
  const bots = useStore((s) => s.bots);
  const threads = useStore((s) => s.threads);
  const selectedBotId = useStore((s) => s.selectedBotId);
  const unread = useStore((s) => s.unread);
  const pending = useStore((s) => s.pendingPermissions);
  const width = useStore((s) => s.sidebarWidth);
  // the cloud computer on screen, its bots not here yet (waking): the roster waits rather than saying "No bots yet"
  const cloudLoading = useCloudLink((s) => s.computer === 'cloud' && !s.ready);
  const conn = useStore((s) => s.conn);
  // opening the app, a switch or a cloud computer waking say nothing (lib/connectionQuiet.ts): the gear's dot shows
  // only once the connection has been down a while, or at once for a refusal that waiting can't fix
  const down = useHeldFor(conn !== 'connected') || conn === 'unauthorized' || conn === 'incompatible';
  /** bots whose threads are listed under them */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const rows = useMemo(
    () => buildRoster(bots, threads, { unread, waiting: new Set(pending.map((p) => p.threadId)) }),
    [bots, threads, unread, pending],
  );
  // pinned bots sit on top as tiles, in the order they were made
  const pinned = bots.flatMap((b) => (b.pinned ? rows.filter((r) => r.bot.id === b.id) : []));
  const listed = rows.filter((r) => !r.bot.pinned);
  // groups of bots, newest activity first
  const allGroups = useStore((s) => s.groups);
  const groupsSupported = useStore((s) => s.groupsSupported);
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const sortedGroups = useMemo(() => (groupsSupported ? [...allGroups] : []).sort((a, b) => (b.lastActiveAt ?? b.createdAt) - (a.lastActiveAt ?? a.createdAt)), [allGroups, groupsSupported]);
  // pinned groups sit on top as tiles, after the pinned bots; the rest in the list
  const pinnedGroups = useMemo(() => (groupsSupported ? allGroups.filter((g) => g.pinned) : []), [allGroups, groupsSupported]);
  const groups = useMemo(() => sortedGroups.filter((g) => !g.pinned), [sortedGroups]);

  return (
    <aside className="relative flex h-full shrink-0 flex-col" style={{ width }}>
      <>
        {/* top strip: traffic lights at its left, and at its right three round buttons: the computer picker (its icon
            alone; with AppuBot Cloud), search (it opens the ⌘K palette: bots, groups, chats, actions, settings; the
            roster has no field) and +, which makes a bot (a group starts from a bot's menu). The room between drags the window. */}
        <div className="drag flex h-16 shrink-0 items-center justify-end gap-2 pr-2.5 pl-[84px]">
          <ComputerMenu />
          <Tooltip label={`${t('common.search')} ${shortcut('K')}`}>
            <button type="button" aria-label={t('common.search')} onClick={() => ui.openModal({ kind: 'quick' })} className={cn(STRIP_BUTTON, RAISED)}>
              <Icon icon={Search} size={15} />
            </button>
          </Tooltip>
          {/* + makes a bot, nothing else (the owner's call, 2026-11-18): a group starts from a bot's menu, Make a group */}
          <Tooltip label={t('sidebar.newBot')}>
            <button type="button" aria-label={t('sidebar.newBot')} onClick={() => ui.openModal({ kind: 'new-bot' })} className={cn(STRIP_BUTTON, RAISED)}>
              <Icon icon={Plus} size={16} />
            </button>
          </Tooltip>
        </div>

        {/* one rail, no headings: the pinned bots as tiles, every other bot, then the groups */}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-2" aria-label={t('sidebar.bots')}>
          {pinned.length || pinnedGroups.length ? (
            <ul className="mb-2 grid grid-cols-3 gap-1" aria-label={t('sidebar.pinned')}>
              {pinned.map((r) => (
                <li key={r.bot.id} className="min-w-0">
                  <BotTile bot={r.bot} selected={selectedGroupId === null && r.bot.id === selectedBotId} unread={r.unread} presence={r.presence} />
                </li>
              ))}
              {pinnedGroups.map((g) => (
                <li key={g.id} className="min-w-0"><GroupPinTile group={g} selected={g.id === selectedGroupId} /></li>
              ))}
            </ul>
          ) : null}
          <ul className="flex flex-col gap-px">
            {listed.map((r) => (
              <li key={r.bot.id}>
                <BotRow
                  bot={r.bot} latest={r.latest} selected={selectedGroupId === null && r.bot.id === selectedBotId} unread={r.unread} presence={r.presence}
                  expanded={expanded.has(r.bot.id)} onToggle={() => toggle(r.bot.id)}
                />
                {expanded.has(r.bot.id) ? <BotThreads bot={r.bot} /> : null}
              </li>
            ))}
            {groups.map((g) => <li key={g.id}><GroupRow group={g} selected={g.id === selectedGroupId} /></li>)}
          </ul>
          {!rows.length && !groups.length && !pinnedGroups.length ? (
            cloudLoading ? <div className="flex justify-center px-3 py-8"><Spinner size={14} className="text-muted" /></div>
              : <div className="px-3 py-8 text-center text-ui text-muted">{t('sidebar.noBots')}</div>
          ) : null}
        </nav>

        <WhatsNewCard />
        <CloudPromoCard />
        <UpdateRow />
        <div className="flex shrink-0 items-center gap-2 px-2 pt-1.5 pb-2">
          {/* the gear says what it is: only a lost connection (its dot) gets a word */}
          <Tooltip label={down ? t('common.reconnecting') : null} side="top">
            <button
              type="button"
              aria-label={t('common.settings')}
              onClick={() => ui.openSettings()}
              className={cn(STRIP_BUTTON, RAISED)}
            >
              <Icon icon={Settings} size={16} />
              {/* only a lost connection gets a dot */}
              {down ? <span className="absolute right-0 bottom-0 size-2.5 rounded-full bg-attention ring-2 ring-[var(--ab-coat-solid,var(--ab-bg))]" /> : null}
            </button>
          </Tooltip>
          <ConnectApps />
        </div>
      </>

      <ResizeHandle side="right" label={t('sidebar.resize')} width={width} min={240} max={380} onWidth={(w) => setState({ sidebarWidth: w })} onReset={() => setState({ sidebarWidth: SIDEBAR_WIDTH })} />
    </aside>
  );
}
