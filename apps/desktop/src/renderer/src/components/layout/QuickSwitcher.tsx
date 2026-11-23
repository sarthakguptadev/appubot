import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { botThreads, shownPreview, stripMarkdown, type Bot } from '@appubot/protocol';
import { AudioLines, GraduationCap, Mail, MessageCircle, MessageSquare, Monitor, Moon, MousePointerClick, Plug, Plus, QrCode, RefreshCw, Search, Settings, Sparkles, SquarePen, Sun, Users, type LucideIcon } from '../ui/icons';
import { BotAvatar, Dialog, Icon, Kbd, cn } from '../ui';
import { openBot, openThread, startThread } from '../../lib/actions';
import { buildRoster, threadTitle, timeAgo } from '@appubot/chat-core';
import { COMPUTER_USE, TEACH, shortcut } from '../../lib/platform';
import { getState, macSettingsOf, ui, useStore } from '../../lib/store';
import { macCall, updateMacSettings } from '../../lib/thisMac';
import { SETTINGS_PAGES, rankSettingsSearch, settingAnchorId, settingsNavItem, settingsTrail } from '../../features/settings/nav';
import { updateSettings } from '../../features/settings/sections/shared';
import { openFind } from '../../features/chat/ThreadSearch';
import { emailSupport, openSupport } from '../../features/support/support';
import { startVoice } from '../../features/voice/useVoiceConversation';
import { currentVoiceRoute } from '../../features/voice/macVoice';
import { cloudLacks } from '../../features/cloud/cloudView';
import { openWhatsNew } from '../../features/whatsNew/WhatsNew';

type Item =
  | { kind: 'bot'; id: string; bot: Bot; label: string; sub: string; time?: number }
  | { kind: 'group'; id: string; label: string; sub: string; time?: number }
  | { kind: 'thread'; id: string; label: string; sub: string; time?: number }
  | { kind: 'action'; id: string; icon: LucideIcon; label: string; hint?: string; keywords?: string; run: () => void }
  | { kind: 'setting'; id: string; icon: LucideIcon; label: string; sub: string; run: () => void };

const GROUP: Record<Item['kind'], string> = { bot: 'Bots', group: 'Groups', thread: 'Threads', action: 'Actions', setting: 'Settings' };
/** the selected bot's threads listed without a query (all that match with one) */
const RECENT_THREADS = 5;

/** Everything the palette can do (T3 Code's command palette, in AppuBot's terms). */
function actions(botId: string | null): Item[] {
  const s = getState();
  // the cloud computer has no voice or teach recording (SystemInfo.cloud)
  const lacks = cloudLacks(s.system);
  // voice with an AppuBot computer on screen is heard by this Mac's own model (voice/voiceRoute.ts)
  const voice = currentVoiceRoute().hear !== null;
  const background = !!s.settings?.computer.background;
  // the colour scheme and the update are this app's own (this Mac's), whichever computer is on screen
  const theme = macSettingsOf(s)?.theme;
  const a = (id: string, icon: LucideIcon, label: string, run: () => void, hint?: string, keywords?: string): Item => ({ kind: 'action', id, icon, label, run, ...(hint ? { hint } : {}), ...(keywords ? { keywords } : {}) });
  return [
    ...(botId ? [a('new-thread', SquarePen, 'New thread', () => void startThread(botId), shortcut('N'))] : []),
    a('new-bot', Plus, 'New bot', () => ui.openModal({ kind: 'new-bot' })),
    ...(botId && voice ? [a('voice', AudioLines, 'Talk to this bot', () => startVoice(botId, s.selectedThreadId))] : []),
    ...(s.selectedThreadId ? [a('find', Search, 'Find in chat', openFind, shortcut('F'))] : []),
    a('apps', Plug, 'Connect apps', () => ui.openApps()),
    a('pair', QrCode, 'Pair a phone', () => ui.openModal({ kind: 'pair' }), undefined, 'phone iphone android mobile qr devices'),
    // teach mode records the user's clicks and keys: where computer use runs
    ...(TEACH && !lacks.teach ? [a('teach', GraduationCap, 'Teach a task', () => ui.openModal({ kind: 'teach' }))] : []),
    // a remote computer's screen is the bots' own: no background mode there
    ...(COMPUTER_USE && s.settings && !lacks.background ? [a('background', MousePointerClick, background ? 'Work on screen' : 'Work in the background', () => {
      const cur = getState().settings;
      if (cur) void updateSettings({ computer: { ...cur.computer, background: !cur.computer.background } });
    })] : []),
    ...(theme !== 'light' ? [a('light', Sun, 'Light mode', () => void updateMacSettings({ theme: 'light' }))] : []),
    ...(theme !== 'dark' ? [a('dark', Moon, 'Dark mode', () => void updateMacSettings({ theme: 'dark' }))] : []),
    ...(theme !== 'system' ? [a('system', Monitor, 'Match the system theme', () => void updateMacSettings({ theme: 'system' }))] : []),
    // found by what people type when they need help, not only by the label
    a('support', MessageCircle, 'Support: chat with Sarthak', () => openSupport(), undefined, 'help contact feedback bug problem question'),
    a('email-support', Mail, 'Support: email sarthak@appubot.com', emailSupport, undefined, 'help contact feedback bug problem mail'),
    a('whats-new', Sparkles, 'What’s new', openWhatsNew),
    a('update', RefreshCw, 'Check for updates', () => void macCall('system.checkForUpdate', {}, { errorTitle: 'Could not check for updates' })),
    a('settings', Settings, 'Settings', () => ui.openSettings(), shortcut(',')),
  ];
}

/** Settings' tabs, and with a query its matching settings too (Settings › Voice, "Send shortcut"…). */
function settingItems(q: string): Item[] {
  const n = q.trim().toLowerCase();
  // every page, tabs included (Usage, Vault, Storage…), named where it sits
  const tabs: Item[] = SETTINGS_PAGES
    .filter((t) => !n || t.label.toLowerCase().includes(n))
    .map((t) => {
      const trail = settingsTrail(t.id);
      return { kind: 'setting', id: `tab:${t.id}`, icon: t.icon, label: t.label, sub: trail === t.label ? 'Settings' : `Settings › ${settingsNavItem(t.id).label}`, run: () => ui.openSettings(t.id) };
    });
  if (!n) return [];
  const rows: Item[] = rankSettingsSearch(q, 6).map((e) => {
    const tab = settingsNavItem(e.section);
    return { kind: 'setting', id: `row:${e.section}:${e.title}`, icon: tab.icon, label: e.title, sub: `Settings › ${settingsTrail(e.section)}`, run: () => ui.openSettings(e.section, settingAnchorId(e.title)) };
  });
  return [...tabs, ...rows.filter((r) => !tabs.some((t) => t.label === r.label))];
}

/**
 * ⌘K, the command palette (T3 Code's; the sidebar's search button opens it too): jump to a bot (its latest message
 * shows), a group or a chat (the selected bot's
 * latest; with a query any bot's), run an action (voice, find, theme, background mode…) or open a setting.
 */
export function QuickSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const bots = useStore((s) => s.bots);
  const threads = useStore((s) => s.threads);
  const selectedBotId = useStore((s) => s.selectedBotId);
  const groups = useStore((s) => (s.groupsSupported ? s.groups : null));
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  // a combobox over a listbox: focus stays in the field, the highlighted row is its active descendant
  const listId = `qs-${useId().replace(/:/g, '')}`;

  useEffect(() => { if (open) { setQ(''); setActive(0); } }, [open]);

  const items = useMemo<Item[]>(() => {
    const n = q.trim().toLowerCase();
    const match = (...xs: string[]) => !n || xs.some((x) => x.toLowerCase().includes(n));
    const b: Item[] = buildRoster(bots, threads, { unread: {}, waiting: new Set() }).flatMap(({ bot: x, latest }) => {
      const last = shownPreview(latest?.lastMessagePreview) ? stripMarkdown(shownPreview(latest?.lastMessagePreview)) : '';
      return match(x.name, x.job, last) ? [{ kind: 'bot' as const, id: x.id, bot: x, label: x.name, sub: last || x.job, time: last ? latest?.updatedAt : undefined }] : [];
    });
    // rooms by name or a member's, newest activity first
    const g: Item[] = [...(groups ?? [])]
      .sort((x, y) => (y.lastActiveAt ?? y.createdAt) - (x.lastActiveAt ?? x.createdAt))
      .flatMap((x) => {
        const members = x.botIds.map((id) => bots.find((y) => y.id === id)?.name).filter(Boolean).join(', ');
        return match(x.name, members) ? [{ kind: 'group' as const, id: x.id, label: x.name, sub: x.lastMessagePreview ? stripMarkdown(x.lastMessagePreview) : members, time: x.lastActiveAt }] : [];
      });
    // without a query the selected bot's latest threads; with one, any bot's
    const pool = n ? [...threads].sort((x, y) => (y.updatedAt ?? 0) - (x.updatedAt ?? 0)) : selectedBotId ? botThreads(threads, selectedBotId) : [];
    const botName = (id: string) => bots.find((x) => x.id === id)?.name ?? '';
    const t: Item[] = pool
      .map((x) => ({ kind: 'thread' as const, id: x.id, label: threadTitle(x), sub: n && x.botId !== selectedBotId ? botName(x.botId) : shownPreview(x.lastMessagePreview) ? stripMarkdown(shownPreview(x.lastMessagePreview)) : '', time: x.updatedAt, preview: x.lastMessagePreview ?? '' }))
      .filter((x) => match(x.label, x.sub, x.preview))
      .slice(0, n ? 12 : RECENT_THREADS)
      .map(({ preview: _, ...x }) => x);
    const a = open ? actions(selectedBotId).filter((x) => match(x.label, x.kind === 'action' ? x.keywords ?? '' : '')) : [];
    return [...b, ...g, ...t, ...a, ...(open ? settingItems(q) : [])];
  }, [q, bots, threads, groups, selectedBotId, open]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (it: Item | undefined) => {
    if (!it) return;
    onClose();
    if (it.kind === 'bot') openBot(it.id);
    else if (it.kind === 'group') ui.selectGroup(it.id);
    else if (it.kind === 'thread') void openThread(it.id);
    else it.run();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[active]); }
  };

  return (
    <Dialog open={open} onClose={onClose} hideClose label="Search AppuBot" size="md" className="self-start mt-[12vh]" bodyClassName="p-0!">
      <div className="hairline-b flex items-center gap-2.5 px-4">
        <Icon icon={Search} size={17} className="text-muted" />
        <input
          autoFocus
          data-autofocus
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={onKey}
          placeholder="Search bots, chats, actions and settings…"
          aria-label="Search"
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
          className="h-12 flex-1 bg-transparent text-copy text-fg outline-none placeholder:text-muted"
        />
        <Kbd>esc</Kbd>
      </div>
      <div ref={list} id={listId} role="listbox" aria-label="Results" className="max-h-[400px] overflow-y-auto p-1.5">
        {items.map((it, i) => (
          <Fragment key={`${it.kind}${it.id}`}>
            {i === 0 || items[i - 1]!.kind !== it.kind ? (
              <div role="presentation" className="px-2.5 pt-2 pb-1 text-note font-medium text-muted/80">{GROUP[it.kind]}</div>
            ) : null}
            <button
              type="button"
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              data-index={i}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(it)}
              className={cn('squircle flex h-10 w-full items-center gap-2.5 rounded-control-sm px-2.5 text-left outline-none transition-colors duration-100', i === active && 'bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)]')}
            >
              {it.kind !== 'bot' ? (
                <span className="flex size-6 items-center justify-center text-fg-2"><Icon icon={it.kind === 'thread' ? MessageSquare : it.kind === 'group' ? Users : it.icon} size={16} /></span>
              ) : (
                <BotAvatar bot={it.bot} size={24} />
              )}
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="max-w-[65%] shrink-0 truncate text-copy text-fg">{it.label}</span>
                {it.kind !== 'action' && it.sub ? <span className="min-w-0 truncate text-note text-muted">{it.sub}</span> : null}
              </span>
              {(it.kind === 'bot' || it.kind === 'group' || it.kind === 'thread') && it.time ? <span className="shrink-0 text-note tabular-nums text-muted">{timeAgo(it.time)}</span> : null}
              {it.kind === 'action' && it.hint ? <Kbd>{it.hint}</Kbd> : null}
            </button>
          </Fragment>
        ))}
        {!items.length ? <div role="presentation" className="px-3 py-8 text-center text-copy text-muted">Nothing found</div> : null}
      </div>
    </Dialog>
  );
}
