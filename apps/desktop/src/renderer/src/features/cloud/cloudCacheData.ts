/**
 * What the window keeps of a computer it shows, so switching to it puts its bots and chats on screen at once (Grok
 * Bot's way: the saved copy first, the computer's own word merged in when it answers). A cloud computer's copy goes to
 * disk through this Mac's core (`cloudAccount.cacheSet`, sealed with the keychain: services/cloudCache.ts); this Mac's
 * own is only kept in memory while another computer is on screen (its hello is a local round trip away).
 *
 * The copy is what a paired device's hello carries (bots, threads, agents, devices, settings, routines, channels,
 * skills, characters, voice, plan limits, the computer's status without its live parts), the files list, the screens'
 * last answers (`remembered`: Usage, Storage; lib/remembered.ts), the place
 * (the bot on screen, each bot's open thread), the latest `CACHE_MESSAGES` messages of the `CACHE_THREADS` most
 * recently active chats loaded here, and the messages still on their way (`QueuedSend`, cloudOutbox.ts). Never
 * approvals, pairing codes, screenshots, or big inline pictures. Pure, so it is tested without a window.
 *
 * Chats are kept light: a tool call's long outputs are cut to `TOOL_TEXT_MAX` and its `rawOutput` (the same output
 * again) left out, since the copy only has to show the chat while the computer's own newest page comes (it replaces
 * every message, same `updatedAt` or newer). Each chat keeps its newest messages within `CACHE_CHAT_MAX_CHARS`, so
 * one computer-use chat of several megabytes (80 messages of snapshots ran to 8 M characters, twice the whole copy's
 * budget, and stopped every chat from being saved: every bot then opened to a spinner) never keeps the rest out.
 */
import type { ComputerStatus, Message, Part, ToolContent, Thread } from '@appubot/protocol';
import type { ToolCallPart } from '@appubot/chat-core';
import type { AppState, Conversation } from '../../lib/store';
import { LOCAL_PREFIX, isLocalId, type QueuedSend } from './cloudOutbox';

const VERSION = 1;
/** recent chats whose messages are kept, and how many of each */
export const CACHE_THREADS = 30;
export const CACHE_MESSAGES = 80;
/** a copy bigger than this keeps fewer chats' messages (the core takes up to 8 M characters) */
export const CACHE_MAX_CHARS = 4_000_000;
/** inline strings longer than this (base64 pictures) don't go in the copy */
const MAX_INLINE = 50_000;
/** one chat's kept messages are at most this long (its newest ones; the chat on screen too) */
export const CACHE_CHAT_MAX_CHARS = 400_000;
/** a tool call's output, diff or terminal text is cut to this many characters in the copy */
export const TOOL_TEXT_MAX = 2_000;
/** a tool call's input is left out of the copy past this (the sentence falls back to its title) */
const TOOL_INPUT_MAX = 4_000;
/** a thought is cut to this */
const THOUGHT_MAX = 8_000;
/** a queued message older than this comes back "Not sent" rather than going out by itself */
export const QUEUED_MAX_AGE_MS = 12 * 60 * 60_000;

/** The slices a computer's hello fills (the copy keeps them, a switch empties them). */
export const COMPUTER_LISTS = [
  'bots', 'threads', 'providers', 'devices', 'settings', 'computer', 'skills', 'routines', 'channels', 'system',
  'voice', 'characters', 'charactersSupported', 'limits', 'limitsSupported', 'files', 'remembered',
  'groups', 'groupsSupported',
] as const;
type ListKey = (typeof COMPUTER_LISTS)[number];
export type ComputerLists = Pick<AppState, ListKey>;

export interface CachedComputer {
  v: number;
  savedAt: number;
  lists: ComputerLists;
  place: Pick<AppState, 'selectedBotId' | 'threadPick'>;
  convo: Record<string, { messages: Message[]; hasMore: boolean }>;
  outbox: QueuedSend[];
}

/** What a restored copy puts in the store, and the messages it had on their way. */
export interface RestoredComputer {
  state: Partial<AppState>;
  outbox: QueuedSend[];
  savedAt: number;
}

/** The computer's status without what only holds while it is up (a bot on the screen, someone in control, waits). */
export function quietComputer(c: ComputerStatus | null): ComputerStatus | null {
  if (!c) return c;
  const { activeThreadId: _a, waiting: _w, control: _c, waits: _ws, screenThreadId: _s, ...rest } = c;
  return { ...rest, busy: false };
}

/** A chat's working state as the copy keeps it: a turn running when it was saved may long be over. */
const restThread = (t: Thread): Thread => (t.status === 'running' ? { ...t, status: 'idle' } : t);

/** Big inline strings never go in the copy. */
const dropBig = (k: string, v: unknown) => (k === 'data' && typeof v === 'string' && v.length > MAX_INLINE ? undefined : v);

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A tool call's content entry as the copy keeps it: long texts cut, pictures out (null), links and small ones as is. */
function lightContent(c: ToolContent): ToolContent | null {
  switch (c.type) {
    case 'text': return c.text.length > TOOL_TEXT_MAX ? { ...c, text: cut(c.text, TOOL_TEXT_MAX) } : c;
    case 'terminal': return (c.output?.length ?? 0) > TOOL_TEXT_MAX ? { ...c, output: cut(c.output!, TOOL_TEXT_MAX) } : c;
    case 'diff': return (c.oldText?.length ?? 0) > TOOL_TEXT_MAX || c.newText.length > TOOL_TEXT_MAX
      ? { ...c, oldText: c.oldText === null ? null : cut(c.oldText, TOOL_TEXT_MAX), newText: cut(c.newText, TOOL_TEXT_MAX) }
      : c;
    case 'image': return c.data.length > MAX_INLINE ? null : c;
    default: return c;
  }
}

/** A tool call without its long outputs and its raw output (what the transcript shows comes from `content`). */
function lightTool(p: ToolCallPart): ToolCallPart {
  const content = p.content.map(lightContent).filter((c): c is ToolContent => c !== null);
  const { rawOutput: _out, rawInput, ...rest } = p;
  const keepInput = rawInput !== undefined && JSON.stringify(rawInput).length <= TOOL_INPUT_MAX;
  return { ...rest, content, ...(keepInput ? { rawInput } : {}) };
}

/** Whether a part is kept as it is (most are: text, files, questions, small tool calls). */
function isLight(p: Part): boolean {
  switch (p.type) {
    case 'image': return (p.data?.length ?? 0) <= MAX_INLINE;
    case 'thought': return p.text.length <= THOUGHT_MAX;
    case 'tool_call': return p.rawOutput === undefined && (p.rawInput === undefined || JSON.stringify(p.rawInput).length <= TOOL_INPUT_MAX)
      && p.content.every((c) => lightContent(c) === c);
    default: return true;
  }
}

/** A part as the copy keeps it. */
function lightPart(p: Part): Part {
  if (isLight(p)) return p;
  switch (p.type) {
    case 'image': return { type: 'image', mimeType: p.mimeType, ...(p.url ? { url: p.url } : {}) };
    case 'thought': return { ...p, text: cut(p.text, THOUGHT_MAX) };
    case 'tool_call': return lightTool(p);
    default: return p;
  }
}

/**
 * A message as the copy keeps it: big inline pictures out (the computer's link stays; the bytes load again), long
 * tool outputs and thoughts cut, raw tool outputs out. The computer's own copy replaces it on the newest page.
 */
export function lighten(m: Message): Message {
  const streaming = m.status === 'streaming';
  if (!streaming && m.parts.every(isLight)) return m;
  return {
    ...m,
    // a reply cut off by the save shows as it was, not as a turn still running
    ...(streaming ? { status: 'complete' as const } : {}),
    parts: m.parts.map(lightPart),
  };
}

/** The `n` most recently active chats with messages loaded here, newest first (the one on screen always among them). */
export function recentChats(s: Pick<AppState, 'threads' | 'convo' | 'selectedThreadId'>, n = CACHE_THREADS): string[] {
  const active = (t: Thread) => t.lastActiveAt ?? t.updatedAt ?? t.createdAt ?? 0;
  const ids = [...s.threads].sort((a, b) => active(b) - active(a)).map((t) => t.id).filter((id) => s.convo[id]?.ids.length);
  const sel = s.selectedThreadId;
  const ordered = sel && ids.includes(sel) ? [sel, ...ids.filter((id) => id !== sel)] : ids;
  return ordered.slice(0, n);
}

/**
 * One chat's kept messages: the computer's own (local copies travel in the outbox), the latest CACHE_MESSAGES that fit
 * `maxChars` together, lightened (the newest one always, so a chat is never saved empty).
 */
export function keptMessages(c: Conversation, maxChars = CACHE_CHAT_MAX_CHARS): { messages: Message[]; hasMore: boolean } {
  const sent = c.ids.map((id) => c.byId[id]).filter((m): m is Message => !!m && !isLocalId(m.id));
  const newest = sent.slice(-CACHE_MESSAGES).map(lighten);
  const messages: Message[] = [];
  let size = 0;
  for (let i = newest.length - 1; i >= 0; i--) {
    const m = newest[i]!;
    const len = JSON.stringify(m, dropBig).length + 1;
    if (messages.length && size + len > maxChars) break;
    size += len;
    messages.unshift(m);
  }
  return { messages, hasMore: c.hasMore || messages.length < sent.length };
}

/** A chat's kept messages as JSON, remembered while it is the same conversation (a save re-encodes only what changed). */
const chatJsonOf = new WeakMap<Conversation, string>();
function chatJson(c: Conversation): string {
  let j = chatJsonOf.get(c);
  if (j === undefined) chatJsonOf.set(c, (j = JSON.stringify(keptMessages(c), dropBig)));
  return j;
}

/**
 * The copy of the computer on screen as JSON: the lists, the place, the messages still on their way, then the most
 * recent chats' messages, each chat within its own budget, leaving out any that wouldn't fit under `maxChars`.
 */
export function serializeComputer(s: AppState, outbox: QueuedSend[], now = Date.now(), maxChars = CACHE_MAX_CHARS): string {
  const lists = Object.fromEntries(COMPUTER_LISTS.map((k) => [k, s[k]])) as ComputerLists;
  lists.computer = quietComputer(s.computer);
  lists.threads = s.threads.map(restThread);
  const place = { selectedBotId: s.selectedBotId, threadPick: s.threadPick };
  const head = `"v":${VERSION},"savedAt":${now},"lists":${JSON.stringify(lists, dropBig)},"place":${JSON.stringify(place)},"outbox":${JSON.stringify(outbox.map(({ blobs: _bytes, ...q }) => q))}`;
  let size = head.length + 16;
  const chats: string[] = [];
  for (const id of recentChats(s)) {
    const entry = `${JSON.stringify(id)}:${chatJson(s.convo[id]!)}`;
    if (size + entry.length > maxChars) continue;
    size += entry.length + 1;
    chats.push(entry);
  }
  return `{${head},"convo":{${chats.join(',')}}}`;
}

/** The copy as the store takes it; null when it isn't one this version reads. */
export function restoreComputer(json: string, now = Date.now()): RestoredComputer | null {
  let d: CachedComputer;
  try { d = JSON.parse(json) as CachedComputer; } catch { return null; }
  if (!d || d.v !== VERSION || !d.lists || !Array.isArray(d.lists.bots) || !Array.isArray(d.lists.threads)) return null;
  const outbox = (Array.isArray(d.outbox) ? d.outbox : [])
    .filter((q) => q && typeof q.localId === 'string' && q.localId.startsWith(LOCAL_PREFIX) && typeof q.threadId === 'string')
    // one older than QUEUED_MAX_AGE_MS waits for the person's Try again; the rest go out once the computer answers
    .map((q): QueuedSend => (q.state === 'failed' || now - q.sentAt > QUEUED_MAX_AGE_MS ? { ...q, state: 'failed', error: q.error ?? 'Not sent' } : { ...q, state: 'queued', error: undefined }));
  return { state: { ...stateOf(d), hydrated: true }, outbox, savedAt: d.savedAt };
}

/** The lists, the place and the conversations of a copy (`loaded: false`: the newest page is still asked for). */
function stateOf(d: CachedComputer): Partial<AppState> {
  const convo: Record<string, Conversation> = {};
  for (const [id, c] of Object.entries(d.convo ?? {})) {
    if (!Array.isArray(c?.messages)) continue;
    const byId = Object.fromEntries(c.messages.map((m) => [m.id, m]));
    convo[id] = { ids: c.messages.map((m) => m.id), byId, loaded: false, loading: false, hasMore: !!c.hasMore };
  }
  const lists: Partial<AppState> = { ...d.lists };
  // a copy from a version that kept fewer lists: those stay as the store has them
  for (const k of COMPUTER_LISTS) if ((d.lists as Partial<ComputerLists>)[k] === undefined) delete (lists as Record<string, unknown>)[k];
  return {
    ...lists,
    convo, convoLru: Object.keys(convo),
    selectedBotId: d.place?.selectedBotId ?? null,
    threadPick: d.place?.threadPick ?? {},
  };
}

/**
 * This Mac's own slices kept in memory while another computer is on screen (no disk: its hello is a local round trip
 * away). Its conversations are marked to load again: its events were left out meanwhile.
 */
export function keepInMemory(s: AppState): Partial<AppState> {
  const lists = Object.fromEntries(COMPUTER_LISTS.map((k) => [k, s[k]])) as ComputerLists;
  const convo = Object.fromEntries(Object.entries(s.convo).map(([id, c]) => [id, { ...c, loaded: false, loading: false }]));
  return { ...lists, computer: quietComputer(s.computer), convo, convoLru: s.convoLru, hydrated: true };
}

/**
 * The slim line over a cloud computer's saved copy once it has gone `CONNECT_QUIET_MS` (30 s, `late`) without its word
 * (with Try again). Before that nothing says it is waking or connecting: the copy shows and fills in behind. A refusal
 * retrying can't fix (signed out, too old) says so at once. Null: nothing shows.
 */
export function syncStripView(l: { computer: 'local' | 'cloud'; cached: boolean; ready: boolean; conn: string; error?: string; late?: boolean }): { text: string } | null {
  if (l.computer !== 'cloud' || !l.cached || l.ready) return null;
  if (!l.late && l.conn !== 'unauthorized' && l.conn !== 'incompatible') return null;
  return { text: l.error ? `Can’t reach your AppuBot computer: ${l.error}` : 'Can’t reach your AppuBot computer yet. Still trying; this is what it showed last.' };
}
