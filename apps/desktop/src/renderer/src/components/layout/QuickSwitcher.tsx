import { Fragment, useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { botThreads, offeredModels, shownPreview, stripMarkdown, type Bot, type Thread } from '@appubot/protocol';
import { ArrowDown, ArrowLeft, ArrowUp, AudioLines, Brain, Check, ChevronRight, GraduationCap, Mail, MessageCircle, MessageSquare, Monitor, Moon, MousePointerClick, Plug, Plus, QrCode, RefreshCw, Search, Settings, SlidersHorizontal, Sparkles, SquarePen, Sun, Users, Zap, type LucideIcon } from '../ui/icons';
import { BotAvatar, Dialog, Icon, Kbd, cn } from '../ui';
import { openBot, openThread, startThread, updateBot } from '../../lib/actions';
import { buildRoster, effortsFor, messageRawText, threadTitle, timeAgo } from '@appubot/chat-core';
import { COMPUTER_USE, TEACH, shortcut } from '../../lib/platform';
import { getState, macSettingsOf, ui, useStore } from '../../lib/store';
import { setThreadEffort, setThreadModel } from '../../lib/choices';
import { macCall, updateMacSettings } from '../../lib/thisMac';
import { SETTINGS_PAGES, SETTINGS_SEARCH_ENTRIES, settingAnchorId, settingsNavItem, settingsTrail } from '../../features/settings/nav';
import { updateSettings } from '../../features/settings/sections/shared';
import { openFind } from '../../features/chat/ThreadSearch';
import { emailSupport, openSupport } from '../../features/support/support';
import { startVoice } from '../../features/voice/useVoiceConversation';
import { currentVoiceRoute } from '../../features/voice/macVoice';
import { cloudLacks } from '../../features/cloud/cloudView';
import { openWhatsNew } from '../../features/whatsNew/WhatsNew';
import { foldQuery, matchFields, messageMatcher, pickedFor, rankGroups, splitByRanges, type PalettePick, type SearchField, type SearchRange } from './paletteSearch';
import { loadPicks, recentKeys, savePick } from './paletteRecent';

/** a sub-page of the palette: a list to pick from, which the root search reaches too ("Theme: Dark") */
type PageId = 'theme' | 'model' | 'effort' | 'new-thread' | 'settings';

interface Row {
  /** what a pick remembers it by: `bot:<id>`, `thread:<id>`, `action:<id>`, `theme:dark`… */
  key: string;
  label: string;
  /** a muted line beside the name: a bot's latest message, where a setting is */
  sub?: string;
  bot?: Bot;
  icon?: LucideIcon;
  time?: number;
  /** its shortcut, shown at the row's end (and run from inside the palette) */
  hint?: string;
  /** the value a sub-page has now */
  checked?: boolean;
  /** what else finds it, weaker than the name (paletteSearch `SearchField`) */
  find?: SearchField[];
  /** chats' names only: a long word may match inside a word */
  midWord?: boolean;
  /** a message it was found by (In messages): who said it, a line of it, the words matched */
  hit?: { who: string; text: string; ranges: SearchRange[] };
  /** the name's matched words, set while searching */
  ranges?: SearchRange[];
  /** opens this sub-page instead of running */
  page?: PageId;
  run?: () => void;
  /** what Enter does to it, for the footer */
  verb: 'Open' | 'Run' | 'Select';
}

interface Group {
  id: string;
  label: string;
  rows: Row[];
}

interface Page {
  title: string;
  icon: LucideIcon;
  placeholder: string;
  /** what one of its rows is called in the root search: "Theme: Dark", "New thread with Ledger" */
  nested?: (label: string) => string;
  rows: Row[];
}

/** the selected bot's threads listed without a query */
const RECENT_THREADS = 5;
/** rows picked lately, listed without a query */
const RECENT_PICKS = 5;
/** threads listed for a query (T3 lists 20; AppuBot's rows are taller) */
const THREAD_LIMIT = 12;
const SETTINGS_LIMIT = 6;
/** chats found by their messages, under the rest */
const MESSAGE_LIMIT = 8;

const keywords = (value: string, weight = 0.6): SearchField => ({ value, weight, keyword: true });

/** The sub-pages, built from what is on screen now (null: nothing to pick there). */
function pages(botId: string | null): Record<PageId, Page | null> {
  const s = getState();
  const theme = macSettingsOf(s)?.theme;
  const thread = s.threads.find((t) => t.id === s.selectedThreadId);
  const bot = s.bots.find((b) => b.id === thread?.botId);
  const models = thread ? offeredModels(thread.providerId, thread.models) : [];
  const efforts = thread ? effortsFor(thread, s.threads) : [];
  const pick = (key: string, label: string, run: () => void, extra: Partial<Row> = {}): Row => ({ key, label, run, verb: 'Select', ...extra });
  return {
    theme: {
      title: 'Theme', icon: Sun, placeholder: 'Pick a theme…', nested: (x) => `Theme: ${x}`,
      rows: [
        pick('theme:light', 'Light', () => void updateMacSettings({ theme: 'light' }), { icon: Sun, checked: theme === 'light' }),
        pick('theme:dark', 'Dark', () => void updateMacSettings({ theme: 'dark' }), { icon: Moon, checked: theme === 'dark' }),
        pick('theme:system', 'Match the system', () => void updateMacSettings({ theme: 'system' }), { icon: Monitor, checked: theme === 'system', find: [keywords('auto os system')] }),
      ],
    },
    // the chat's model, and the bot's own from then on (as the side panel's model picker does)
    model: thread && bot && models.length > 1 ? {
      title: 'Model', icon: Brain, placeholder: `Pick ${bot.name}’s model…`, nested: (x) => `Model: ${x}`,
      rows: models.map((m) => pick(`model:${m.id}`, m.name, () => {
        void setThreadModel(thread, m.id);
        void updateBot(bot, { modelId: m.id }, { errorTitle: 'Could not save bot' });
      }, { icon: Brain, checked: thread.modelId === m.id, ...(m.description ? { sub: m.description } : {}) })),
    } : null,
    effort: thread && efforts.length > 1 ? {
      title: 'Reasoning effort', icon: Zap, placeholder: 'Pick how hard it thinks…', nested: (x) => `Reasoning effort: ${x}`,
      rows: efforts.map((e) => pick(`effort:${e.id}`, e.name, () => void setThreadEffort(thread, e.id), { icon: Zap, checked: thread.effortId === e.id })),
    } : null,
    // T3's "New thread in…" a project, in AppuBot's terms: with any bot
    'new-thread': s.bots.length > 1 ? {
      title: 'New thread with', icon: SquarePen, placeholder: 'Pick a bot…', nested: (x) => `New thread with ${x}`,
      rows: s.bots.map((b) => pick(`new-thread:${b.id}`, b.name, () => void startThread(b.id), { bot: b, sub: b.job, checked: b.id === botId })),
    } : null,
    settings: {
      title: 'Settings', icon: Settings, placeholder: 'Pick a settings page…',
      rows: SETTINGS_PAGES.map((t) => pick(`tab:${t.id}`, t.label, () => ui.openSettings(t.id), { icon: t.icon, sub: settingsTrail(t.id) === t.label ? '' : settingsNavItem(t.id).label, verb: 'Open' })),
    },
  };
}

/** Everything the palette can do (T3 Code's command palette, in AppuBot's terms). */
function actions(botId: string | null, sub: Record<PageId, Page | null>): Row[] {
  const s = getState();
  // the cloud computer has no voice or teach recording (SystemInfo.cloud)
  const lacks = cloudLacks(s.system);
  // voice with an AppuBot computer on screen is heard by this Mac's own model (voice/voiceRoute.ts)
  const voice = currentVoiceRoute().hear !== null;
  const background = !!s.settings?.computer.background;
  const a = (id: string, icon: LucideIcon, label: string, run: () => void, hint?: string, words?: string): Row =>
    ({ key: `action:${id}`, icon, label, run, verb: 'Run', ...(hint ? { hint } : {}), ...(words ? { find: [keywords(words)] } : {}) });
  const page = (id: PageId, label: string, words?: string): Row[] => {
    const p = sub[id];
    return p ? [{ key: `page:${id}`, icon: p.icon, label, page: id, verb: 'Open', ...(words ? { find: [keywords(words)] } : {}) }] : [];
  };
  return [
    ...(botId ? [a('new-thread', SquarePen, 'New thread', () => void startThread(botId), shortcut('N'))] : []),
    ...page('new-thread', 'New thread with…', 'chat start'),
    a('new-bot', Plus, 'New bot', () => ui.openModal({ kind: 'new-bot' }), undefined, 'create add agent'),
    ...(botId && voice ? [a('voice', AudioLines, 'Talk to this bot', () => startVoice(botId, s.selectedThreadId), undefined, 'voice speak call')] : []),
    ...(s.selectedThreadId ? [a('find', Search, 'Find in chat', openFind, shortcut('F'), 'search')] : []),
    ...page('model', 'Switch model…', 'agent llm'),
    ...page('effort', 'Reasoning effort…', 'thinking think'),
    a('apps', Plug, 'Connect apps', () => ui.openApps(), undefined, 'integrations gmail slack composio'),
    a('pair', QrCode, 'Pair a phone', () => ui.openModal({ kind: 'pair' }), undefined, 'phone iphone android mobile qr devices'),
    // teach mode records the user's clicks and keys: where computer use runs
    ...(TEACH && !lacks.teach ? [a('teach', GraduationCap, 'Teach a task', () => ui.openModal({ kind: 'teach' }), undefined, 'record skill')] : []),
    // a remote computer's screen is the bots' own: no background mode there
    ...(COMPUTER_USE && s.settings && !lacks.background ? [a('background', MousePointerClick, background ? 'Work on screen' : 'Work in the background', () => {
      const cur = getState().settings;
      if (cur) void updateSettings({ computer: { ...cur.computer, background: !cur.computer.background } });
    }, undefined, 'computer use mode')] : []),
    ...page('theme', 'Theme…', 'appearance dark light mode colour color'),
    // found by what people type when they need help, not only by the label
    a('support', MessageCircle, 'Support: chat with Sarthak', () => openSupport(), undefined, 'help contact feedback bug problem question'),
    a('email-support', Mail, 'Support: email sarthak@appubot.com', emailSupport, undefined, 'help contact feedback bug problem mail'),
    a('whats-new', Sparkles, 'What’s new', openWhatsNew, undefined, 'changelog release notes'),
    a('update', RefreshCw, 'Check for updates', () => void macCall('system.checkForUpdate', {}, { errorTitle: 'Could not check for updates' }), undefined, 'upgrade version'),
    a('settings', Settings, 'Settings', () => ui.openSettings(), shortcut(','), 'preferences options'),
    ...page('settings', 'Open a settings page…', 'preferences options'),
  ];
}

/** Settings' pages and the settings on them, as rows the search finds (the list without a query shows none). */
function settingRows(): Row[] {
  const tabs: Row[] = SETTINGS_PAGES.map((t) => {
    const trail = settingsTrail(t.id);
    return { key: `tab:${t.id}`, icon: t.icon, label: t.label, sub: trail === t.label ? 'Settings' : `Settings › ${settingsNavItem(t.id).label}`, run: () => ui.openSettings(t.id), verb: 'Open', find: [keywords(t.description, 0.4)] };
  });
  const rows: Row[] = SETTINGS_SEARCH_ENTRIES.filter((e) => !tabs.some((t) => t.label === e.title)).map((e) => ({
    key: `setting:${e.section}:${e.title}`, icon: settingsNavItem(e.section).icon, label: e.title, sub: `Settings › ${settingsTrail(e.section)}`,
    run: () => ui.openSettings(e.section, settingAnchorId(e.title)), verb: 'Open',
    find: [...(e.keywords ? [keywords(e.keywords)] : []), keywords(settingsTrail(e.section), 0.25)],
  }));
  return [...tabs, ...rows];
}

const preview = (t: Pick<Thread, 'lastMessagePreview'> | undefined): string => {
  const p = shownPreview(t?.lastMessagePreview);
  return p ? stripMarkdown(p) : '';
};

/** A thread's row: its bot named when `withBot` (a search across bots), else its latest message. */
function threadRow(t: Thread, botName: string, withBot: boolean): Row {
  const last = preview(t);
  return {
    key: `thread:${t.id}`, icon: MessageSquare, label: threadTitle(t), sub: withBot ? botName : last, time: t.updatedAt, midWord: true,
    find: [keywords(botName, 0.25), keywords(last, 0.4)], run: () => void openThread(t.id), verb: 'Open',
  };
}

/** The name with what matched in semibold, as T3's palette marks it. */
function Marked({ text, ranges }: { text: string; ranges?: SearchRange[] }): ReactNode {
  if (!ranges?.length) return text;
  return splitByRanges(text, ranges).map((p, i) => (p.hit ? <mark key={i} className="bg-transparent font-semibold text-fg">{p.text}</mark> : p.text));
}

const FOOTER_KEY = 'h-[18px] min-w-[18px] bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)] text-fg';

/**
 * ⌘K, the command palette (T3 Code's; the sidebar's search button opens it too): jump to a bot (its latest message
 * shows), a group or a chat (the selected bot's latest; with a query any bot's, and chats whose messages say it), run
 * an action (voice, find, background mode…), open a setting, or pick from a sub-page (theme, the chat's model and
 * effort, a new thread with another bot, a settings page).
 *
 * Brought up to T3's on 2026-11-24: its sizes (576 wide, 420 at most, rows of 36, a footer of keys), its matching
 * and ranking (paletteSearch.ts) with the matched words in semibold, its Recent rows (paletteRecent.ts), its
 * sub-pages (Backspace on an empty field or Escape goes back, Tab or Enter goes in) and its shortcuts inside the
 * palette (⌘1…⌘9 a bot, ⌘N, ⌘F, ⌘, as everywhere).
 */
export function QuickSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const bots = useStore((s) => s.bots);
  const threads = useStore((s) => s.threads);
  const selectedBotId = useStore((s) => s.selectedBotId);
  const selectedThreadId = useStore((s) => s.selectedThreadId);
  const groups = useStore((s) => (s.groupsSupported ? s.groups : null));
  const convo = useStore((s) => s.convo);
  const theme = useStore((s) => macSettingsOf(s)?.theme);
  const [q, setQ] = useState('');
  // the sub-pages gone into, each with the query it left behind (back restores it, as T3's does)
  const [stack, setStack] = useState<{ id: PageId; parentQuery: string }[]>([]);
  const [active, setActive] = useState(0);
  const [picks, setPicks] = useState<PalettePick[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // a combobox over a listbox: focus stays in the field, the highlighted row is its active descendant
  const listId = `qs-${useId().replace(/:/g, '')}`;
  // typing stays quick while a long list (or the messages) is searched
  const query = useDeferredValue(q);
  const pageId = stack[stack.length - 1]?.id ?? null;

  useEffect(() => { if (open) { setQ(''); setStack([]); setActive(0); setPicks(loadPicks()); } }, [open]);

  const sub = useMemo(() => pages(selectedBotId), [selectedBotId, selectedThreadId, threads, bots, theme, open]);
  const page = pageId ? sub[pageId] : null;

  const view = useMemo<Group[]>(() => {
    const n = foldQuery(query);
    const botName = (id: string) => bots.find((x) => x.id === id)?.name ?? '';
    // a sub-page: its rows, the search narrowing them
    if (page) {
      if (!n) return [{ id: 'page', label: '', rows: page.rows }];
      const ranked = rankGroups([{ group: 'page', items: page.rows }], (r, typos) => matchFields(n, [{ value: r.label, weight: 1 }, ...(r.find ?? [])], { typos }));
      return ranked.map(({ ranked: rows }) => ({ id: 'page', label: '', rows: rows.map(({ item, match }) => ({ ...item, ranges: match.ranges })) }));
    }

    // ⌘1…⌘9 open the n-th bot (MainLayout): its row says so
    const botRows: Row[] = buildRoster(bots, threads, { unread: {}, waiting: new Set() }).map(({ bot: x, latest }) => {
      const last = preview(latest);
      const at = bots.findIndex((y) => y.id === x.id);
      return {
        key: `bot:${x.id}`, bot: x, label: x.name, sub: last || x.job, time: last ? latest?.updatedAt : undefined,
        find: [keywords(x.job), keywords(last, 0.4)], run: () => openBot(x.id), verb: 'Open',
        ...(at >= 0 && at < 9 ? { hint: shortcut(String(at + 1)) } : {}),
      };
    });
    // rooms by name or a member's, newest activity first
    const groupRows: Row[] = [...(groups ?? [])]
      .sort((x, y) => (y.lastActiveAt ?? y.createdAt) - (x.lastActiveAt ?? x.createdAt))
      .map((x) => {
        const members = x.botIds.map(botName).filter(Boolean).join(', ');
        return { key: `group:${x.id}`, icon: Users, label: x.name, sub: x.lastMessagePreview ? stripMarkdown(x.lastMessagePreview) : members, time: x.lastActiveAt, find: [keywords(members, 0.4)], run: () => ui.selectGroup(x.id), verb: 'Open' };
      });
    const actionRows = actions(selectedBotId, sub);
    // every option of a sub-page as a row of its own, found from here: "dark" lists "Theme: Dark"
    const nestedRows: Row[] = (Object.keys(sub) as PageId[]).flatMap((id) => {
      const p = sub[id];
      if (!p?.nested) return [];
      // a query that only names the sub-page ("them", "new thread") wants its row, not every option in it
      if (n && foldQuery(p.title).startsWith(n)) return [];
      return p.rows.map((r) => ({ ...r, label: p.nested!(r.label), sub: undefined, find: r.find, verb: 'Run' as const }));
    });

    if (!n) {
      // Recent: what was picked here lately, still there to pick (T3's Recent threads, any kind of row)
      const byKey = new Map<string, Row>();
      for (const r of [...botRows, ...groupRows, ...actionRows, ...nestedRows, ...settingRows()]) byKey.set(r.key, r);
      for (const t of threads) byKey.set(`thread:${t.id}`, threadRow(t, botName(t.botId), t.botId !== selectedBotId));
      const recent = recentKeys(picks, Date.now()).flatMap((k) => byKey.get(k) ?? []).filter((r) => r.key !== `thread:${selectedThreadId}`).slice(0, RECENT_PICKS);
      const shown = new Set(recent.map((r) => r.key));
      const fresh = (rows: Row[]) => rows.filter((r) => !shown.has(r.key));
      const mine = selectedBotId ? botThreads(threads, selectedBotId).slice(0, RECENT_THREADS).map((t) => threadRow(t, botName(t.botId), false)) : [];
      return [
        { id: 'recent', label: 'Recent', rows: recent },
        { id: 'bots', label: 'Bots', rows: fresh(botRows) },
        { id: 'groups', label: 'Groups', rows: fresh(groupRows) },
        { id: 'threads', label: 'Threads', rows: fresh(mine) },
        { id: 'actions', label: 'Actions', rows: fresh(actionRows) },
      ].filter((g) => g.rows.length);
    }

    // any bot's threads, newest first (the search keeps that order among equal matches)
    const threadRows = [...threads].sort((x, y) => (y.updatedAt ?? 0) - (x.updatedAt ?? 0)).map((t) => threadRow(t, botName(t.botId), t.botId !== selectedBotId));
    const ranked = rankGroups(
      [
        { group: { id: 'bots', label: 'Bots', limit: Infinity }, items: botRows },
        { group: { id: 'groups', label: 'Groups', limit: Infinity }, items: groupRows },
        { group: { id: 'threads', label: 'Threads', limit: THREAD_LIMIT }, items: threadRows },
        { group: { id: 'actions', label: 'Actions', limit: Infinity }, items: [...actionRows, ...nestedRows] },
        { group: { id: 'settings', label: 'Settings', limit: SETTINGS_LIMIT }, items: settingRows() },
      ],
      (r, typos) => matchFields(n, [{ value: r.label, weight: 1, midWord: !!r.midWord }, ...(r.find ?? [])], { typos }),
      (r) => ({ pickedAt: pickedFor(picks, r.key, n), usedAt: r.time ?? 0 }),
    );
    const out: Group[] = ranked.map(({ group, ranked: rows }) => ({
      id: group.id, label: group.label,
      rows: rows.slice(0, group.limit).map(({ item, match }) => ({ ...item, ranges: match.ranges })),
    }));

    // In messages (T3's message search, over what this app holds: the chats opened or fetched ahead, ≤ 40): the
    // chats whose messages say it that aren't listed already, the best match of each, the closest and newest first
    const matcher = open ? messageMatcher(query) : null;
    if (!matcher) return out;
    const listed = new Set(out.flatMap((g) => g.rows.map((r) => r.key)));
    const found: { t: Thread; who: string; quality: number; at: number; text: string; ranges: SearchRange[] }[] = [];
    for (const [threadId, c] of Object.entries(convo)) {
      const t = threads.find((x) => x.id === threadId);
      if (!t || listed.has(`thread:${t.id}`)) continue;
      let best: (typeof found)[number] | undefined;
      for (let i = c.ids.length - 1; i >= 0; i--) {
        const m = c.byId[c.ids[i]!];
        if (!m) continue;
        const hit = matcher(messageRawText(m));
        if (hit && (!best || hit.quality > best.quality)) {
          best = { t, who: m.role === 'user' ? 'You' : (m.from?.name ?? botName(t.botId)), quality: hit.quality, at: m.createdAt, text: hit.snippet, ranges: hit.ranges };
          if (hit.quality === 1) break;
        }
      }
      if (best) found.push(best);
    }
    found.sort((a, b) => b.quality - a.quality || b.at - a.at);
    const messageRows: Row[] = found.slice(0, MESSAGE_LIMIT).map((f) => ({
      ...threadRow(f.t, botName(f.t.botId), true), time: f.at, hit: { who: f.who, text: f.text, ranges: f.ranges },
    }));
    return messageRows.length ? [...out, { id: 'messages', label: 'In messages', rows: messageRows }] : out;
  }, [query, page, sub, bots, threads, groups, selectedBotId, selectedThreadId, convo, picks, open]);

  const rows = useMemo(() => view.flatMap((g) => g.rows), [view]);
  // the list changes under the highlight as chats move: it stays in range
  const at = Math.min(active, Math.max(0, rows.length - 1));
  const current = rows[at];

  // another query or page highlights its first row (a sub-page its current value)
  useEffect(() => {
    setActive(page && !query ? Math.max(0, page.rows.findIndex((r) => r.checked)) : 0);
  }, [query, pageId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const enter = (id: PageId) => {
    setStack((s) => [...s, { id, parentQuery: q }]);
    setQ('');
    input.current?.focus();
  };
  const back = () => {
    const top = stack[stack.length - 1];
    if (!top) return;
    setStack((s) => s.slice(0, -1));
    setQ(top.parentQuery);
    input.current?.focus();
  };
  const choose = (r: Row | undefined) => {
    if (!r) return;
    if (r.page) { enter(r.page); return; }
    savePick(r.key, foldQuery(q));
    onClose();
    r.run?.();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter that confirms an IME candidate is part of typing
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const cmd = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
    // ⌘1…⌘9: the n-th bot, as outside the palette
    if (cmd && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      const bot = getState().bots[Number(e.key) - 1];
      if (bot) choose({ key: `bot:${bot.id}`, label: bot.name, run: () => openBot(bot.id), verb: 'Open' });
      return;
    }
    // an action's own shortcut (⌘N, ⌘F, ⌘,) runs it from here too, whatever the list shows
    if (cmd && e.key.length === 1) {
      const hit = actions(selectedBotId, sub).find((r) => r.hint && r.hint.slice(-1).toLowerCase() === e.key.toLowerCase());
      if (hit) { e.preventDefault(); choose(hit); return; }
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      // round the ends, as T3's list does
      setActive((at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(current);
    } else if (e.key === 'Tab' && !e.shiftKey && current?.page) {
      e.preventDefault();
      enter(current.page);
    } else if ((e.key === 'Backspace' && q === '' && stack.length) || (e.key === 'Escape' && stack.length)) {
      // the dialog would close on Escape: a sub-page goes back instead
      e.preventDefault();
      back();
    }
  };

  let index = -1;
  const empty = page ? 'Nothing to pick matches that.' : 'No bots, chats, actions or settings match that.';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      hideClose
      label="Search AppuBot"
      className="mt-[10vh] max-h-[min(420px,calc(100vh-48px))] w-[min(576px,calc(100vw-48px))] self-start"
      bodyClassName="flex flex-col overflow-hidden p-0!"
    >
      <div className="hairline-b flex shrink-0 items-center gap-2.5 px-4">
        {page ? (
          <button type="button" aria-label="Back" onClick={back} className="ab-pill squircle -ml-1 flex size-6 items-center justify-center rounded-control-sm text-muted outline-none hover:text-fg">
            <Icon icon={ArrowLeft} size={17} />
          </button>
        ) : (
          <Icon icon={Search} size={17} className="text-muted" />
        )}
        {page ? <span className="ab-pill squircle shrink-0 rounded-[6px] bg-[color-mix(in_srgb,var(--ab-fg)_6%,transparent)] px-1.5 py-0.5 text-note font-medium text-fg-2">{page.title}</span> : null}
        <input
          ref={input}
          autoFocus
          data-autofocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder={page ? page.placeholder : 'Search bots, chats, actions and settings…'}
          aria-label="Search"
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current ? `${listId}-${at}` : undefined}
          className="h-12 min-w-0 flex-1 bg-transparent text-copy text-fg outline-none placeholder:text-muted"
        />
      </div>
      <div ref={list} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {view.map((g) => (
          <Fragment key={g.id}>
            {g.label ? <div role="presentation" className="px-2 pt-1.5 pb-1 text-note font-medium text-muted/80 first:pt-0.5">{g.label}</div> : null}
            {g.rows.map((r) => {
              const i = ++index;
              return (
                <button
                  key={r.key}
                  type="button"
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === at}
                  {...(r.checked !== undefined ? { 'aria-checked': r.checked } : {})}
                  tabIndex={-1}
                  data-index={i}
                  onMouseMove={() => { if (i !== at) setActive(i); }}
                  // the field keeps the focus (and its caret)
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(r)}
                  className={cn('ab-pill squircle flex min-h-9 w-full items-center gap-2.5 rounded-control-sm px-2 py-1.5 text-left outline-none', i === at && 'bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)]')}
                >
                  {r.bot ? <BotAvatar bot={r.bot} size={20} /> : <span className="flex size-5 shrink-0 items-center justify-center text-fg-2"><Icon icon={r.icon ?? SlidersHorizontal} size={16} /></span>}
                  {r.hit ? (
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate text-copy text-fg">{r.label}</span>
                        {r.sub ? <span className="max-w-[45%] shrink-0 truncate text-note text-muted/80">{r.sub}</span> : null}
                      </span>
                      <span className="truncate text-note text-muted">
                        <span className="font-medium text-fg-2">{r.hit.who}:</span> <Marked text={r.hit.text} ranges={r.hit.ranges} />
                      </span>
                    </span>
                  ) : (
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="max-w-[65%] shrink-0 truncate text-copy text-fg"><Marked text={r.label} ranges={r.ranges} /></span>
                      {r.sub ? <span className="min-w-0 truncate text-note text-muted">{r.sub}</span> : null}
                    </span>
                  )}
                  {r.time ? <span className="shrink-0 text-note tabular-nums text-muted">{timeAgo(r.time)}</span> : null}
                  {r.hint ? <Kbd>{r.hint}</Kbd> : null}
                  {r.checked ? <Icon icon={Check} size={16} className="shrink-0 text-fg-2" /> : null}
                  {r.page ? <Icon icon={ChevronRight} size={16} className="-mr-0.5 shrink-0 text-muted/80" /> : null}
                </button>
              );
            })}
          </Fragment>
        ))}
        {!rows.length ? <div role="presentation" className="px-3 py-10 text-center text-copy text-muted">{empty}</div> : null}
      </div>
      {/* T3's footer: the keys the list answers to */}
      <div className="flex shrink-0 items-center gap-3 border-t border-[color-mix(in_srgb,var(--ab-fg)_7%,transparent)] bg-[color-mix(in_srgb,var(--ab-fg)_2.5%,transparent)] px-4 py-2.5 text-note font-medium text-muted">
        <span className="flex items-center gap-1.5">
          <Kbd className={FOOTER_KEY}><Icon icon={ArrowUp} size={11} /></Kbd>
          <Kbd className={FOOTER_KEY}><Icon icon={ArrowDown} size={11} /></Kbd>
          Navigate
        </span>
        {current ? <span className="flex items-center gap-1.5"><Kbd className={FOOTER_KEY}>↵</Kbd>{current.verb}</span> : null}
        {page ? (
          <span className="flex items-center gap-1.5"><Kbd className={FOOTER_KEY}>⌫</Kbd><Kbd className={FOOTER_KEY}>esc</Kbd>Back</span>
        ) : (
          <span className="flex items-center gap-1.5"><Kbd className={FOOTER_KEY}>esc</Kbd>Close</span>
        )}
      </div>
    </Dialog>
  );
}
