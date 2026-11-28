import { loadMacRemembered, type RememberedMap } from './rememberedData';
import { create } from 'zustand';
import type {
  AppsStatus, Bot, Channel, Character, ComputerFrame, ComputerStatus, Device, EventPayload, FileAttachment, Message, NotificationAccess, PairingInfo,
  PermissionRequest, Provider, Routine, Settings, Skill, Snapshot, SystemInfo, TeachSession, Thread, VoiceStatus, ProviderLimits, Group, GroupMessage,
} from '@appubot/protocol';
import { currentChat, currentGroupChat } from '@appubot/protocol';
import { absorbLocals, compareMessages, copyOfReply, dropReply, settleLocal } from '@appubot/chat-core';
import { activeComputer, type ConnectionState } from './gateway';
import { markOnce } from './perfMarks';

/** `computer`: your AppuBot computer's screen (only while the app is on a remote computer) */
export type RightTab = 'threads' | 'bot' | 'skills' | 'memory' | 'routines' | 'files' | 'computer';
/** The sidebar's width as it opens, and what a double-click on its edge returns it to (the owner's own, 2026-11-14; 288 before). */
export const SIDEBAR_WIDTH = 308;
/** The Connect apps popup's two views. */
export type AppsView = 'browse' | 'connected';
export type SettingsSection = 'general' | 'vault' | 'appearance' | 'providers' | 'instructions' | 'apps' | 'devices' | 'computer' | 'channels' | 'voice' | 'usage' | 'storage' | 'about' | 'whats-new' | 'permissions' | 'account' | 'billing' | 'team' | 'transfer' | 'import';
/** an old name main still sends (`appubot:navigate {id: 'cloud'}` after a sign-in or checkout): opens Billing */
export type LegacySettingsSection = 'cloud';
export type ComputerActionEvent = EventPayload<'computer.action'>;

export type Modal =
  /** the New bot dialog: a look and a name (features/bots/NewBotDialog.tsx); a bot is changed in its side panel */
  | { kind: 'new-bot' }
  | { kind: 'teach' }
  | { kind: 'pair' }
  /** the first time an AppuBot computer is on screen here (CloudWelcome: the full-window first visit) */
  | { kind: 'cloud-welcome'; teamName?: string }
  /** a cloud computer refused this one as a device too many: its devices, to remove one (CloudDevicesDialog) */
  | { kind: 'cloud-devices'; team?: string; teamName?: string; message: string }
  | { kind: 'quick' }
  | { kind: 'skill'; botId: string; name?: string }
  | { kind: 'routine'; routineId?: string }
  /** a group of bots: new, or one to edit (features/groups) */
  | { kind: 'group'; groupId?: string; /** a new group made from this bot's menu: it starts as the one member */ withBotId?: string }
  | { kind: 'confirm'; title: string; body: string; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void> };

export interface Toast {
  id: string;
  title: string;
  body?: string;
  level: 'info' | 'success' | 'warning' | 'error';
  threadId?: string;
  /** a group's room to open on click (features/groups), and which of its threads */
  groupId?: string;
  groupChatId?: string;
  ts: number;
  /** stays until acted on or closed (no timer) */
  sticky?: boolean;
  /** an agent's notice (its update): its logo leads instead of the level's icon */
  agentId?: string;
  /** something is running for it: a spinner in place of its buttons */
  busy?: boolean;
  /** buttons under the words; the primary one filled */
  actions?: { label: string; onClick: () => void; primary?: boolean }[];
  /** the user closed it (✕ or a swipe), as opposed to it timing out or being replaced */
  onClose?: () => void;
}

/**
 * One thread's messages as far as they are loaded: the newest page first (`threads.history`), older pages as you
 * scroll up, live messages as they come.
 */
export interface Conversation {
  ids: string[];
  byId: Record<string, Message>;
  /** the newest page is in */
  loaded: boolean;
  loading: boolean;
  /** the Mac has messages older than the first one here */
  hasMore: boolean;
}

/** chats kept whole in memory, the most recently opened first */
export const MAX_CONVERSATIONS_IN_MEMORY = 12;
/** past those, chats keep only their newest messages (shown at once when opened again, refreshed behind), up to this many */
export const MAX_CONVERSATIONS_KEPT = 40;
/** what such a chat keeps */
export const KEPT_MESSAGES = 80;

/** A chat pushed out of memory: its newest messages (and what's still on its way from here), to be read again when opened. */
function trimConversation(c: Conversation): Conversation {
  if (!c.loaded && c.ids.length <= KEPT_MESSAGES) return c;
  const keep = new Set(c.ids.slice(-KEPT_MESSAGES));
  for (const id of c.ids) if (isLocalCopy(id)) keep.add(id);
  const ids = c.ids.filter((id) => keep.has(id));
  return { ids, byId: Object.fromEntries(ids.map((id) => [id, c.byId[id]!])), loaded: false, loading: false, hasMore: c.hasMore || ids.length < c.ids.length };
}

/** The LRU's rule: the first chats whole, the next ones trimmed, the rest dropped (the chat on screen always whole). */
function evictConversations(lru: string[], convo: Record<string, Conversation>, selected: string | null): string[] {
  const kept: string[] = [];
  for (const id of lru) {
    if (!convo[id]) continue;
    const at = kept.length;
    if (id !== selected && at >= MAX_CONVERSATIONS_KEPT) { delete convo[id]; continue; }
    if (id !== selected && at >= MAX_CONVERSATIONS_IN_MEMORY && !convo[id]!.loading) convo[id] = trimConversation(convo[id]!);
    kept.push(id);
  }
  return kept;
}
export const FRAME_RING = 30;

export interface AppState {
  /* connection */
  conn: ConnectionState;
  connError?: string;
  hydrated: boolean;

  /* snapshot slices */
  bots: Bot[];
  threads: Thread[];
  providers: Provider[];
  devices: Device[];
  settings: Settings | null;
  computer: ComputerStatus | null;
  /**
   * whether the OS shows AppuBot's notifications (null until read; re-read when the window comes back): always this
   * Mac's own answer, whichever computer is on screen (features/notifications/access.ts asks this Mac's gateway)
   */
  notificationAccess: NotificationAccess | null;
  /**
   * This Mac's own settings and system info, followed from its own gateway whichever computer is on screen
   * (lib/thisMac.ts). `settings` and `system` are the screen computer's: what belongs to this app (its updates, its
   * colour scheme, its notifications, opening at login) is read through `macSettingsOf` / `macSystemOf`.
   */
  macSettings: Settings | null;
  macSystem: SystemInfo | null;
  skills: Skill[];
  routines: Routine[];
  /** groups of bots talking with each other (features/groups) */
  groups: Group[];
  /** the computer has groups (`groups.*`; one that predates them sends none in the snapshot) */
  groupsSupported: boolean;
  /** each group's room, newest last, once read (`groups.history`) */
  groupMessages: Record<string, GroupMessage[]>;
  groupLoaded: Record<string, boolean>;
  channels: Channel[];
  system: SystemInfo | null;
  pendingPermissions: PermissionRequest[];
  pairing: PairingInfo | null;
  teach: TeachSession | null;
  files: FileAttachment[];
  /** the Apps directory's Composio status (fetched when Apps opens, then kept by `apps.updated`) */
  apps: AppsStatus | null;
  /** speech on this computer: which models are downloaded or downloading (null from a server that predates it) */
  voice: VoiceStatus | null;
  /** the custom characters bots can wear (the computer's library) */
  characters: Character[];
  /** the computer has characters (`characters.*`; one that predates them sends none in the snapshot) */
  charactersSupported: boolean;
  /** the agents' plan limits as the computer last read them (`providers.limits`; features/providers/useLimits.ts) */
  limits: ProviderLimits[];
  /** the computer reads plan limits (one that predates them sends none in the snapshot) */
  limitsSupported: boolean;
  /** screens' last answers from this computer (lib/remembered.ts), shown at once while they ask again */
  remembered: RememberedMap;

  /* computer use */
  frame: ComputerFrame | null;
  actionFrames: ComputerFrame[];
  actions: ComputerActionEvent[];
  lastAction: ComputerActionEvent | null;

  /* conversations by thread id (LRU of ≤ 12 threads; the one on screen is never evicted) */
  convo: Record<string, Conversation>;
  convoLru: string[];

  /* ui */
  selectedBotId: string | null;
  /** the group on screen (its room replaces the chat); null: a bot's chat */
  selectedGroupId: string | null;
  /** the thread on screen: the bot's pick (`threadPick`), else its current thread; null before its first message */
  selectedThreadId: string | null;
  /** the thread the user opened per bot (in memory): selecting the bot again shows it, not the current one */
  threadPick: Record<string, string>;
  /**
   * threads with an agent reply the user hasn't seen (device-local, persisted): the first such reply's message id, where
   * the chat's "NEW" line goes (`true` from before 2026-11-27, or a reply with no id: unread, no line)
   */
  unread: Record<string, Unread>;
  rightOpen: boolean;
  rightTab: RightTab;
  rightWidth: number;
  sidebarWidth: number;
  /** the settings page replacing the chat (null: settings closed) */
  settingsSection: SettingsSection | null;
  /** the Connect apps popup (the sidebar's "Connect apps"), a dialog of its own so a confirm can open over it */
  appsOpen: boolean;
  /** what it shows: the directory, or the apps already connected */
  appsView: AppsView;
  /** a setting row/group anchor to scroll to once the section shows (settings search) */
  settingsTarget: string | null;
  modal: Modal | null;
  /** main's "Quit AppuBot?" (its own dialog, so it stacks over an open editor instead of replacing it) */
  quitPrompt: { id: number; working: number } | null;
  toasts: Toast[];
  nativeDark: boolean;
  /** the support chat widget is open (features/support: its bubble at the bottom right expands into Crisp's chat) */
  supportOpen: boolean;
  /** replies waiting in the collapsed support chat (main reads them from Crisp's page) */
  supportUnread: number;
  /**
   * Voice mode is on for this bot's chat (features/voice): its panel sits above the composer. `threadId` is null until
   * the bot's first spoken message makes its thread. Showing another bot or thread, settings or Apps ends it.
   */
  voiceMode: { botId: string; threadId: string | null } | null;
}

/** A thread's unread mark: the id of the first reply not seen yet, or `true` when that isn't known. */
export type Unread = string | true;
const UNREAD_KEY = 'appubot:unread:v1';
function loadUnread(): Record<string, Unread> {
  try { return JSON.parse(localStorage.getItem(UNREAD_KEY) ?? '{}') as Record<string, Unread>; } catch { return {}; }
}
/** The menu bar's call window (`?view=voicebar`): it shares this origin's storage, so it leaves the main window's marks alone. */
export const isVoiceBarView = (): boolean =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('view') === 'voicebar';

function saveUnread(u: Record<string, Unread>): void {
  if (isVoiceBarView()) return;
  try { localStorage.setItem(UNREAD_KEY, JSON.stringify(u)); } catch { /* storage unavailable */ }
}

/** A bot's current thread: where turns that name no thread go, and what a bot opens on without a pick. */
export function chatThreadFor(s: Pick<AppState, 'threads'>, botId: string | null): string | null {
  return botId ? (currentChat(s.threads, botId)?.id ?? null) : null;
}

/** The thread a bot shows: its pick while that still is one of its threads (a Telegram chat too), else its current one. */
export function threadFor(s: Pick<AppState, 'threads' | 'threadPick'>, botId: string | null): string | null {
  if (!botId) return null;
  const pick = s.threadPick[botId];
  const t = pick ? s.threads.find((x) => x.id === pick) : undefined;
  return t && t.botId === botId ? t.id : chatThreadFor(s, botId);
}

/** Whether a thread is a Telegram chat (read in Telegram: its replies don't turn unread; its approvals dock with its bot). */
export function isChannelThread(s: Pick<AppState, 'threads'>, threadId: string): boolean {
  return s.threads.find((x) => x.id === threadId)?.source === 'channel';
}
/** Whether a thread is a bot's own for a group (the room shows what it says; nothing of it turns up on the bot). */
export function isGroupThread(s: Pick<AppState, 'threads'>, threadId: string): boolean {
  return s.threads.find((x) => x.id === threadId)?.source === 'group';
}

/** A bot's group thread: the group and which of its threads it answers (its first: the group's own id). */
export function groupThreadOf(s: Pick<AppState, 'threads'>, threadId: string): { groupId: string; chatId: string } | undefined {
  const t = s.threads.find((x) => x.id === threadId);
  return t?.source === 'group' && t.groupId ? { groupId: t.groupId, chatId: t.groupChatId ?? t.groupId } : undefined;
}

/** Whether a group's room is on screen showing that thread. */
export function roomOnScreen(s: Pick<AppState, 'groups' | 'selectedGroupId' | 'settingsSection'>, groupId: string, chatId: string): boolean {
  if (s.selectedGroupId !== groupId || s.settingsSection !== null) return false;
  const g = s.groups.find((x) => x.id === groupId);
  return !g || currentGroupChat(g).id === chatId;
}

type ScreenFields = 'threads' | 'groups' | 'selectedBotId' | 'selectedThreadId' | 'selectedGroupId' | 'settingsSection';
/** Whether a thread is the one on screen (settings or a group's room aren't covering the chat). */
export function threadOnScreen(s: Pick<AppState, ScreenFields>, threadId: string): boolean {
  return s.selectedThreadId === threadId && s.selectedGroupId === null && s.settingsSection === null;
}

/** On screen for toasts: the thread itself, or a Telegram chat of the bot on screen (its approvals dock there). */
export function seenOnScreen(s: Pick<AppState, ScreenFields>, threadId: string): boolean {
  if (threadOnScreen(s, threadId)) return true;
  // a member's group thread: what it asks shows in the room
  const room = groupThreadOf(s, threadId);
  if (room) return roomOnScreen(s, room.groupId, room.chatId);
  const t = s.threads.find((x) => x.id === threadId);
  return !!t && t.source === 'channel' && t.botId === s.selectedBotId && s.selectedGroupId === null && s.settingsSection === null;
}

/**
 * Whether a notice is a toast here: the app is in front of the user, or the OS notification can't go out instead
 * (AppuBot's switch is off, or the OS hides them). Otherwise it is only an OS notification, sent by main
 * (`NotificationsService.notify`, the same rule).
 */
export function toastHere(s: Pick<AppState, 'settings' | 'macSettings' | 'notificationAccess'>): boolean {
  if (document.visibilityState === 'visible' && document.hasFocus()) return true;
  // main decides by this Mac's own switch and OS access, also for a cloud computer's notices
  return !macSettingsOf(s)?.notifications.desktop || s.notificationAccess === 'off';
}

/**
 * This Mac's own settings: the store's while this Mac is on screen (they carry what was just picked), else what its
 * own gateway last said. Null until either is known.
 */
export function macSettingsOf(s: Pick<AppState, 'settings' | 'macSettings'>): Settings | null {
  return activeComputer() === 'local' ? s.settings ?? s.macSettings : s.macSettings;
}
/** This Mac's own system info (its version, its update, its power), whichever computer is on screen. */
export function macSystemOf(s: Pick<AppState, 'system' | 'macSystem'>): SystemInfo | null {
  return activeComputer() === 'local' ? s.system ?? s.macSystem : s.macSystem;
}

const initial: AppState = {
  conn: 'idle', hydrated: false,
  bots: [], threads: [], providers: [], devices: [], settings: null, computer: null, notificationAccess: null, macSettings: null, macSystem: null, skills: [], routines: [], groups: [], groupsSupported: true, groupMessages: {}, groupLoaded: {}, channels: [],
  system: null, pendingPermissions: [], pairing: null, teach: null, files: [], apps: null, voice: null, characters: [], charactersSupported: false, limits: [], limitsSupported: false, remembered: loadMacRemembered(),
  frame: null, actionFrames: [], actions: [], lastAction: null,
  convo: {}, convoLru: [],
  selectedBotId: null, selectedGroupId: null, selectedThreadId: null, threadPick: {}, unread: loadUnread(),
  rightOpen: false, rightTab: 'threads', rightWidth: 380, sidebarWidth: SIDEBAR_WIDTH,
  settingsSection: null, settingsTarget: null, appsOpen: false, appsView: 'browse', modal: null, quitPrompt: null, toasts: [], nativeDark: false,
  supportOpen: false, supportUnread: 0, voiceMode: null,
};

export const useStore = create<AppState>()(() => initial);
export const getState = useStore.getState;
export const setState = useStore.setState;

/* ---------- small immutable helpers ---------- */
export function upsertBy<T>(list: T[], item: T, key: (t: T) => string): T[] {
  const k = key(item);
  const i = list.findIndex((x) => key(x) === k);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}
export const byId = (x: { id: string }) => x.id;

/**
 * A thread as the store keeps it. A computer's gateway sends a paired device's threads without their slash commands
 * (protocol `leanThread`: hello, `threads.list`, `thread.updated`), and to the cloud computer this Mac is a paired
 * device, so its threads come without `commands`; they keep the ones read before (`threads.commands`), else none.
 * Everything that reads `thread.commands` can rely on an array.
 */
export function fullThread(t: Thread, prev?: Thread): Thread {
  return Array.isArray(t.commands) ? t : { ...t, commands: prev?.commands ?? [] };
}
const fullThreads = (list: Thread[], prev: Thread[]): Thread[] => {
  if (list.every((t) => Array.isArray(t.commands))) return list;
  const before = new Map(prev.map((t) => [t.id, t]));
  return list.map((t) => fullThread(t, before.get(t.id)));
};

/** Puts one thread (a `thread.updated`) into the store. */
export function upsertThread(t: Thread): void {
  setState((s) => ({ threads: upsertBy(s.threads, fullThread(t, s.threads.find((x) => x.id === t.id)), byId) }));
}

/* ---------- hydrate from hello snapshot ---------- */
export function hydrate(snap: Snapshot): void {
  markOnce('appubot:hydrated');
  setState((s) => {
    // a chat or bot shown here before the computer has made it (lib/actions.ts) stays until its own id comes
    const bots = [...snap.bots, ...s.bots.filter((b) => isLocalCopy(b.id))];
    const botIds = new Set(bots.map((b) => b.id));
    const selectedBotId = s.selectedBotId && botIds.has(s.selectedBotId) ? s.selectedBotId : (snap.bots[0]?.id ?? null);
    const threads = [...fullThreads(snap.threads, s.threads), ...s.threads.filter((t) => isLocalCopy(t.id))];
    const selectedThreadId = threadFor({ threads, threadPick: s.threadPick }, selectedBotId);
    const selectedGroupId = s.selectedGroupId && (snap.groups ?? []).some((g) => g.id === s.selectedGroupId) ? s.selectedGroupId : null;
    return {
      ...panelFor(s, selectedBotId, selectedGroupId),
      hydrated: true,
      bots, threads, providers: snap.providers, devices: snap.devices, settings: snap.settings,
      computer: snap.computer, skills: snap.skills, routines: snap.routines, channels: snap.channels, system: snap.system,
      groups: snap.groups ?? [], groupsSupported: snap.groups !== undefined,
      // a (re)connect reads every room again: what was posted while away (the computer restarted, a goal went on)
      groupLoaded: {},
      // a group on screen that this computer doesn't have (another computer's) goes
      selectedGroupId,
      pendingPermissions: snap.pendingPermissions.filter((p) => !p.resolvedAt),
      voice: snap.voice ?? null,
      characters: snap.characters ?? [], charactersSupported: snap.characters !== undefined,
      limits: snap.limits ?? [], limitsSupported: snap.limits !== undefined,
      selectedBotId, selectedThreadId,
    };
  });
}

/* ---------- messages ---------- */
const sortIds = (byIdMap: Record<string, Message>): string[] => Object.values(byIdMap).sort(compareMessages).map((m) => m.id);
const emptyConversation = (): Conversation => ({ ids: [], byId: {}, loaded: false, loading: false, hasMore: false });

/**
 * Merge messages into a thread's conversation (keeps newer live copies). `page` comes with what `threads.history`
 * said: the newest page marks it loaded; `hasMore` is set by the newest page and by older pages.
 */
export function mergeConversation(threadId: string, messages: Message[], page?: { newest?: boolean; hasMore?: boolean }): void {
  setState((s) => {
    let cur = s.convo[threadId] ?? emptyConversation();
    // a newest page that doesn't reach what we had (reconnected after a long gap, an old saved copy): start over from
    // it, keeping only the messages still on their way from here (outbox.ts)
    const lastHad = [...cur.ids].reverse().map((id) => cur.byId[id]!).find((m) => m && !isLocalCopy(m.id));
    if (page?.newest && lastHad && messages.length && page.hasMore && compareMessages(messages[0]!, lastHad) > 0) {
      const locals = Object.fromEntries(Object.entries(cur.byId).filter(([id]) => isLocalCopy(id)));
      cur = { ...emptyConversation(), byId: locals, ids: Object.keys(locals) };
    }
    const fresh = !cur.loaded;
    const nextById = { ...cur.byId };
    for (const m of messages) {
      // the computer's own copy of a message sent from here (a page read after the event was missed): it takes the
      // copy's place and row
      if (m.clientId && m.clientId !== m.id && isLocalCopy(m.clientId) && nextById[m.clientId]) {
        delete nextById[m.clientId];
        rowAliases.set(m.id, rowKeyOf(m.clientId));
      }
      const live = nextById[m.id];
      if (!live || live.updatedAt <= m.updatedAt) nextById[m.id] = m;
    }
    // a working row placed under a message sent from here gives way to the reply a page brought
    let finalById = nextById;
    if (Object.keys(nextById).some((id) => copyOfReply(id))) {
      const { list, aliases } = absorbLocals(listOf(cur), Object.values(nextById).sort(compareMessages));
      if (aliases.length) { noteAliases(aliases); finalById = Object.fromEntries(list.map((m) => [m.id, m])); }
    }
    // what lies before the oldest message here: an older page says; the newest page only when it is all we have
    const hasMore = page?.hasMore === undefined || (page.newest && !fresh) ? cur.hasMore : page.hasMore;
    return {
      convo: { ...s.convo, [threadId]: { ids: sortIds(finalById), byId: finalById, loaded: cur.loaded || !!page?.newest, loading: page?.newest ? false : cur.loading, hasMore } },
    };
  });
}

/** A message still on its way from this window (its local copy: outbox.ts `local:` ids). */
const isLocalCopy = (id: string): boolean => id.startsWith('local:');

/**
 * Transcript rows by message: the computer's message that took a local copy's place keeps the copy's row (its key),
 * so the row neither remounts nor animates in a second time.
 */
const rowAliases = new Map<string, string>();
export const rowKeyOf = (id: string): string => rowAliases.get(id) ?? id;

/** Swap a local copy for the computer's message (`real`; none: just take the copy out). */
export function replaceLocal(threadId: string, localId: string, real?: Message): void {
  if (real && real.id !== localId) rowAliases.set(real.id, rowKeyOf(localId));
  setState((s) => {
    const cur = s.convo[threadId];
    if (!cur || (!cur.byId[localId] && !real)) return {};
    const byIdMap = { ...cur.byId };
    delete byIdMap[localId];
    if (real) {
      const live = byIdMap[real.id];
      if (!live || live.updatedAt <= real.updatedAt) byIdMap[real.id] = real;
    }
    return { convo: { ...s.convo, [threadId]: { ...cur, ids: sortIds(byIdMap), byId: byIdMap } } };
  });
}

/** A thread's messages in conversation order. */
const listOf = (c: Conversation): Message[] => c.ids.map((id) => c.byId[id]!).filter(Boolean);
const withList = (c: Conversation, list: Message[]): Conversation => {
  const byIdMap = Object.fromEntries(list.map((m) => [m.id, m]));
  return { ...c, ids: sortIds(byIdMap), byId: byIdMap };
};
const noteAliases = (aliases: [string, string][]): void => {
  for (const [real, copy] of aliases) if (real !== copy) rowAliases.set(real, rowKeyOf(copy));
};

/**
 * A message the computer just reported (`message.created`, or the first word of a reply): it goes in, taking the place
 * (and transcript row) of the local copy it stands for: your message its copy (by `clientId`), the bot's reply the
 * working row under a copy already confirmed (chat-core `absorbLocals`). A reply taking a working row keeps counting
 * from when the row appeared, so "Working · 3s" carries on instead of starting over.
 */
export function arriveMessage(threadId: string, m: Message): void {
  setState((s) => {
    const cur = s.convo[threadId];
    if (!cur) return {};
    const live = cur.byId[m.id];
    if (live) {
      if (live.updatedAt > m.updatedAt) return {};
      return { convo: { ...s.convo, [threadId]: { ...cur, byId: { ...cur.byId, [m.id]: m } } } };
    }
    const before = listOf(cur);
    const { list, aliases } = absorbLocals(before, [...before, m]);
    if (!aliases.length) return { convo: { ...s.convo, [threadId]: withList(cur, list) } };
    noteAliases(aliases);
    const row = aliases.find(([real, copy]) => real === m.id && copyOfReply(copy));
    const rowAt = row ? cur.byId[row[1]]?.createdAt : undefined;
    let next = list;
    if (rowAt !== undefined && m.status === 'streaming' && rowAt < m.createdAt) {
      const lastUser = Math.max(0, ...list.filter((x) => x.role === 'user' && x.createdAt < m.createdAt).map((x) => x.createdAt));
      const at = Math.max(rowAt, lastUser + 1);
      if (at < m.createdAt) next = list.map((x) => (x.id === m.id ? { ...x, createdAt: at } : x));
    }
    return { convo: { ...s.convo, [threadId]: withList(cur, next) } };
  });
}

/** `chat.send` answered: its message replaces the local copy, the working row becomes the reply's (`agentMessageId`). */
export function settleSent(threadId: string, localId: string, real: Message, agentMessageId?: string): void {
  if (real.id !== localId) rowAliases.set(real.id, rowKeyOf(localId));
  setState((s) => {
    const cur = s.convo[threadId];
    if (!cur) return {};
    const { list, aliases } = settleLocal(listOf(cur), localId, real, agentMessageId);
    noteAliases(aliases);
    return { convo: { ...s.convo, [threadId]: withList(cur, list) } };
  });
}

/** A send that failed: its working row goes (the copy stays, marked "Not sent"). */
export function dropLocalReply(threadId: string, localId: string): void {
  setState((s) => {
    const cur = s.convo[threadId];
    if (!cur) return {};
    const before = listOf(cur);
    const list = dropReply(before, localId);
    return list === before ? {} : { convo: { ...s.convo, [threadId]: withList(cur, list) } };
  });
}

/** Move a chat's messages to another id (a new chat the computer made for one shown at once). */
export function moveConversation(from: string, to: string): void {
  setState((s) => {
    const cur = s.convo[from];
    if (!cur) return {};
    const convo = { ...s.convo };
    delete convo[from];
    const into = convo[to];
    const moved = listOf(cur).map((m) => ({ ...m, threadId: to }));
    const merged = into ? [...listOf(into).filter((m) => !moved.some((x) => x.id === m.id)), ...moved] : moved;
    convo[to] = withList(into ?? { ...cur, loaded: false, loading: false }, merged);
    return { convo, convoLru: s.convoLru.map((id) => (id === from ? to : id)).filter((id, i, a) => a.indexOf(id) === i) };
  });
}

/** Ensure a cache entry exists for a thread, touch it in the LRU and evict the oldest beyond the cap (never the one on screen). */
export function touchConversation(threadId: string): Conversation {
  setState((s) => {
    const convo = { ...s.convo };
    if (!convo[threadId]) convo[threadId] = emptyConversation();
    return { convoLru: evictConversations([threadId, ...s.convoLru.filter((id) => id !== threadId)], convo, s.selectedThreadId), convo };
  });
  return getState().convo[threadId]!;
}

/**
 * A chat fetched ahead (lib/actions.ts `prefetchChats`): kept at the end of the LRU, so it never pushes out one opened
 * here. Its page goes in with `mergeConversation`.
 */
export function keepConversationLast(threadId: string): void {
  setState((s) => {
    if (s.convoLru.includes(threadId)) return {};
    const convo = { ...s.convo };
    if (!convo[threadId]) convo[threadId] = emptyConversation();
    return { convoLru: evictConversations([...s.convoLru, threadId], convo, s.selectedThreadId), convo };
  });
}

/**
 * Immutable update of one message of a thread (ignored for threads not loaded here).
 * `fn` receives a shallow clone (parts array copied).
 */
export function updateMessage(threadId: string, messageId: string, fn: (m: Message) => Message | void, create?: () => Message): void {
  setState((s) => {
    const cur = s.convo[threadId];
    if (!cur) return {};
    const existing = cur.byId[messageId];
    if (!existing && !create) return {};
    const base = existing ?? create!();
    const clone: Message = { ...base, parts: base.parts.slice() };
    const next = fn(clone) ?? clone;
    const byIdMap = { ...cur.byId, [messageId]: next };
    const ids = existing ? cur.ids : sortIds(byIdMap);
    return { convo: { ...s.convo, [threadId]: { ...cur, ids, byId: byIdMap } } };
  });
}

/** Forget threads here (deleted, or their bot was): their conversations, picks, approvals and unread marks. */
export function dropThreads(ids: string[]): void {
  if (!ids.length) return;
  const gone = new Set(ids);
  setState((s) => {
    const convo = Object.fromEntries(Object.entries(s.convo).filter(([id]) => !gone.has(id)));
    const threadPick = Object.fromEntries(Object.entries(s.threadPick).filter(([, id]) => !gone.has(id)));
    let unread = s.unread;
    if (ids.some((id) => s.unread[id])) {
      unread = Object.fromEntries(Object.entries(s.unread).filter(([id]) => !gone.has(id))) as Record<string, Unread>;
      saveUnread(unread);
    }
    return {
      convo, threadPick, unread,
      convoLru: s.convoLru.filter((id) => !gone.has(id)),
      threads: s.threads.filter((t) => !gone.has(t.id)),
      pendingPermissions: s.pendingPermissions.filter((p) => !gone.has(p.threadId)),
    };
  });
}

/** Run after the computer's lists land in the store outside events (lib/optimistic.ts lays pending changes on top). */
let afterServerWrite: (() => void) | null = null;
export function setAfterServerWrite(fn: (() => void) | null): void { afterServerWrite = fn; }

/** Put threads the Mac sent (a `threads.list` page, `threads.start`) into the store, newer copies winning. */
export function upsertThreads(list: Thread[]): void {
  if (!list.length) return;
  upsertThreadsRaw(list);
  afterServerWrite?.();
}
function upsertThreadsRaw(list: Thread[]): void {
  setState((s) => {
    const byIdMap = new Map(s.threads.map((t) => [t.id, t]));
    for (const t of list) {
      const cur = byIdMap.get(t.id);
      if (!cur || cur.updatedAt <= t.updatedAt) byIdMap.set(t.id, fullThread(t, cur));
    }
    return { threads: [...byIdMap.values()] };
  });
}

/* ---------- toasts ---------- */
let toastSeq = 0;
export function pushToast(t: Omit<Toast, 'id' | 'ts'> & { id?: string }): string {
  const id = t.id ?? `t${Date.now().toString(36)}${(toastSeq++).toString(36)}`;
  setState((s) => ({ toasts: [...s.toasts.filter((x) => x.id !== id), { ...t, id, ts: Date.now() }].slice(-5) }));
  return id;
}
export function dismissToast(id: string): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
/** Change a notice where it is (no new card, no reordering); false when it's gone. */
export function updateToast(id: string, patch: Partial<Omit<Toast, 'id' | 'ts'>>): boolean {
  let found = false;
  setState((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? ((found = true), { ...t, ...patch }) : t)) }));
  return found;
}

/* ---------- ui actions ---------- */
/**
 * The side panel belongs to the chat on screen: showing another bot, or a group's room, closes it, and coming back
 * finds it closed too. It only opens when asked, for the chat on screen.
 */
function panelFor(s: Pick<AppState, 'selectedBotId' | 'selectedGroupId'>, botId: string | null, groupId: string | null): Partial<AppState> {
  return botId === s.selectedBotId && groupId === s.selectedGroupId ? {} : { rightOpen: false };
}

export const ui = {
  selectBot(botId: string | null): void {
    // picking a bot is navigation: it leaves settings and the Connect apps popup (and a group's room); it shows the thread you had open there
    setState((s) => ({ ...panelFor(s, botId, null), selectedBotId: botId, selectedGroupId: null, selectedThreadId: threadFor(s, botId), settingsSection: null, settingsTarget: null, appsOpen: false }));
  },
  /** Show a group's room in place of the chat (null: back to the bot's chat). */
  selectGroup(groupId: string | null): void {
    setState((s) => ({ ...panelFor(s, s.selectedBotId, groupId), selectedGroupId: groupId, settingsSection: null, settingsTarget: null, appsOpen: false }));
  },
  /** Show one thread of a bot (a Telegram chat too): selects its bot and remembers it as the bot's pick. */
  openThread(threadId: string): void {
    setState((s) => {
      const t = s.threads.find((x) => x.id === threadId);
      if (!t) return {};
      return {
        ...panelFor(s, t.botId, null),
        selectedBotId: t.botId, selectedGroupId: null, selectedThreadId: t.id, threadPick: { ...s.threadPick, [t.botId]: t.id },
        settingsSection: null, settingsTarget: null, appsOpen: false,
      };
    });
  },
  /** Re-derive the thread on screen after threads change (a first message made one, the picked one was deleted). */
  syncSelection(): void {
    setState((s) => {
      const next = threadFor(s, s.selectedBotId);
      return next === s.selectedThreadId ? {} : { selectedThreadId: next };
    });
  },
  /** a reply the user hasn't seen: the thread's first one keeps the mark (the chat's "NEW" line goes above it) */
  markUnread(threadId: string, messageId?: string): void {
    setState((s) => {
      if (s.unread[threadId]) return {};
      const unread: Record<string, Unread> = { ...s.unread, [threadId]: messageId ?? true };
      saveUnread(unread);
      return { unread };
    });
  },
  markRead(threadId: string): void {
    setState((s) => {
      if (!s.unread[threadId]) return {};
      const unread = { ...s.unread };
      delete unread[threadId];
      saveUnread(unread);
      return { unread };
    });
  },
  openRight(tab: RightTab): void { setState({ rightOpen: true, rightTab: tab }); },
  /** The Connect apps popup (a dialog over whatever is on screen), on the directory or on the connected apps. */
  openApps(view: AppsView = 'browse'): void { setState({ appsOpen: true, appsView: view }); },
  closeApps(): void { setState({ appsOpen: false }); },
  openSettings(section: SettingsSection | LegacySettingsSection = 'general', target?: string): void { setState({ settingsSection: section === 'cloud' ? 'billing' : section, settingsTarget: target ?? null, appsOpen: false }); },
  closeSettings(): void { setState({ settingsSection: null, settingsTarget: null }); },
  openModal(modal: Modal): void { setState({ modal }); },
  closeModal(): void { setState({ modal: null }); },
};

/* ---------- selectors ---------- */
export const selectSelectedBot = (s: AppState): Bot | undefined => s.bots.find((b) => b.id === s.selectedBotId);
export const selectSelectedThread = (s: AppState): Thread | undefined => s.threads.find((t) => t.id === s.selectedThreadId);
