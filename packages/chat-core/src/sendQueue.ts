/**
 * Sending without waiting (the desktop's outbox, after the phone app's): a message shows in the
 * chat the moment it is sent, as a local copy (`local:` id, also its `clientId` on the computer), with the bot's working
 * row under it when the bot was idle. The computer's own messages then take the copies' places: its user message by
 * `clientId` (the event, `chat.send`'s answer or a history page, whichever comes first) and its reply the working row,
 * each real id keeping the copy's transcript row (`aliases`), so nothing remounts, animates twice or jumps.
 *
 * Pure: the apps keep the messages and call these.
 */
import type { Message, Part } from '@appubot/protocol';

export const LOCAL_PREFIX = 'local:';
export const isLocalId = (id: string): boolean => id.startsWith(LOCAL_PREFIX);

/** a send still on its way shows as plain sent this long; only after it does it look pending (a small clock) */
export const SENDING_QUIET_MS = 1000;

let seq = 0;
/** A message's id here: the local copy's, and its `clientId` on the computer. */
export const newLocalId = (now = Date.now()): string =>
  `${LOCAL_PREFIX}${now.toString(36)}-${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The working row placed under a local message. */
export const replyIdOf = (localId: string): string => `${localId}:reply`;
/** A local working row's own message (null for anything else). */
export const copyOfReply = (id: string): string | null => (isLocalId(id) && id.endsWith(':reply') ? id.slice(0, -':reply'.length) : null);

/** What a picked file shows as before it is uploaded (no link yet: its tile has no actions). */
export interface LocalFile { name: string; mimeType: string; size?: number }

export interface LocalSend {
  localId: string;
  threadId: string;
  text: string;
  images: { mimeType: string; data: string }[];
  files?: LocalFile[];
  /** a spoken message: its recording (already stored on the computer) and length */
  voice?: { recordingId: string; durationMs: number; mimeType?: string };
  /** where it was written (`desktop`, `mobile`) */
  via?: Message['via'];
  /** its time: after everything already in its chat */
  at: number;
  /** the bot was idle: its working row goes under it */
  withReply: boolean;
}

/** The local copy of a message being sent, and the bot's working row under it (`withReply`). */
export function localMessages(o: LocalSend): Message[] {
  const parts: Part[] = [
    ...(o.voice ? [{
      type: 'voice', kind: 'recording', durationMs: o.voice.durationMs, transcript: o.text,
      file: { id: o.voice.recordingId, name: 'Voice message', mimeType: o.voice.mimeType ?? 'audio/ogg', size: 0, url: `/files/${o.voice.recordingId}` },
    } as Part] : []),
    ...(o.files ?? []).map((f, i): Part => ({ type: 'file', file: { id: `${o.localId}:file${i}`, name: f.name, mimeType: f.mimeType, size: f.size ?? 0, url: '' } })),
    ...o.images.map((im): Part => ({ type: 'image', mimeType: im.mimeType, data: im.data })),
    ...(o.text ? [{ type: 'text', text: o.text } as Part] : []),
  ];
  const via = o.via ?? 'desktop';
  const user: Message = { id: o.localId, threadId: o.threadId, role: 'user', parts, status: 'complete', via, clientId: o.localId, createdAt: o.at, updatedAt: o.at };
  if (!o.withReply) return [user];
  const reply: Message = { id: replyIdOf(o.localId), threadId: o.threadId, role: 'agent', parts: [], status: 'streaming', via: 'desktop', createdAt: o.at + 1, updatedAt: o.at + 1 };
  return [user, reply];
}

/** The time a copy placed now gets: its own clock, but never before the last message already in its chat. */
export const localTime = (now: number, lastInChat: number): number => Math.max(now, lastInChat + 1);

/**
 * The computer's messages that just appeared in a chat (`before` → `after`) take the places of the local copies they
 * stand for: a user message the copy its `clientId` names; an agent message (not a system notice) the working row under
 * a copy already confirmed. Returns the list without those copies and which real id took which copy's place.
 */
export function absorbLocals(before: Message[], after: Message[]): { list: Message[]; aliases: [string, string][] } {
  if (!after.some((m) => isLocalId(m.id))) return { list: after, aliases: [] };
  const had = new Set(before.map((m) => m.id));
  const fresh = after.filter((m) => !had.has(m.id) && !isLocalId(m.id));
  if (!fresh.length) return { list: after, aliases: [] };
  const drop = new Set<string>();
  const aliases: [string, string][] = [];
  const ids = new Set(after.map((m) => m.id));
  // a working row's copy is confirmed once the computer's message took its place (now or before)
  const confirmedCopy = (rowId: string) => { const copy = copyOfReply(rowId); return !!copy && (drop.has(copy) || !ids.has(copy)); };
  for (const real of fresh) {
    if (real.role === 'user') {
      const copy = real.clientId && real.clientId !== real.id ? after.find((m) => m.id === real.clientId && !drop.has(m.id)) : undefined;
      if (copy) { drop.add(copy.id); aliases.push([real.id, copy.id]); }
    } else if (real.via !== 'system') {
      const row = after.find((m) => m.role === 'agent' && copyOfReply(m.id) && !drop.has(m.id) && confirmedCopy(m.id));
      if (row) { drop.add(row.id); aliases.push([real.id, row.id]); }
    }
  }
  if (!drop.size) return { list: after, aliases: [] };
  return { list: keepRowsBelow(after.filter((m) => !drop.has(m.id)), fresh, aliases), aliases };
}

/**
 * A working row still waiting for its reply stays under the message the computer just confirmed (its time is the
 * computer's, which may run ahead of this one's guess), so it never jumps above it.
 */
function keepRowsBelow(list: Message[], fresh: Message[], aliases: [string, string][]): Message[] {
  const confirmed = Math.max(0, ...fresh.filter((m) => m.role === 'user' && aliases.some(([r]) => r === m.id)).map((m) => m.createdAt));
  return list.map((m) => (copyOfReply(m.id) && m.createdAt <= confirmed ? { ...m, createdAt: confirmed + 1, updatedAt: confirmed + 1 } : m));
}

/**
 * `chat.send` answered: its user message replaces the local copy (unless an event brought it already). The working
 * row is renamed to the reply's id (`agentMessageId`) so the reply's first events land on it, unless the reply is here.
 */
export function settleLocal(list: Message[], localId: string, real: Message, agentMessageId?: string): { list: Message[]; aliases: [string, string][] } {
  const aliases: [string, string][] = [];
  const hasReal = list.some((m) => m.id === real.id);
  const hasAgent = !!agentMessageId && list.some((m) => m.id === agentMessageId);
  const rowId = replyIdOf(localId);
  const out: Message[] = [];
  for (const m of list) {
    if (m.id === localId) {
      if (!hasReal) { out.push(real); aliases.push([real.id, localId]); }
    } else if (m.id === rowId) {
      const at = Math.max(m.createdAt, real.createdAt + 1);
      if (agentMessageId && !hasAgent) { out.push({ ...m, id: agentMessageId, createdAt: at, updatedAt: at }); aliases.push([agentMessageId, rowId]); }
      else if (!agentMessageId) out.push(m);
    } else out.push(m);
  }
  return { list: out, aliases };
}

/** A failed send: its working row goes (the copy stays, marked). */
export function dropReply(list: Message[], localId: string): Message[] {
  const rowId = replyIdOf(localId);
  return list.some((m) => m.id === rowId) ? list.filter((m) => m.id !== rowId) : list;
}

/** The connection, not the computer, failed: the message may or may not have reached it, so it goes again (same id). */
export const TRANSIENT_CODES: readonly string[] = ['disconnected', 'timeout', 'not_connected', 'closed'];

/**
 * How a message on its way looks: `quiet` (sent, as far as the eye can tell: the first `SENDING_QUIET_MS`), `pending`
 * (a small clock: still waiting after that), `failed` (Not sent, with Try again).
 */
export function sendLook(state: 'queued' | 'uploading' | 'sending' | 'failed', since: number, now: number): 'quiet' | 'pending' | 'failed' {
  if (state === 'failed') return 'failed';
  return now - since < SENDING_QUIET_MS ? 'quiet' : 'pending';
}

/** a message waiting for the bot to finish says so only after this long: one going into the running turn has its reply under it by then */
export const WAITING_QUIET_MS = 1200;

/**
 * Your messages the bot hasn't read yet because it is still on the job before them: the ones the computer has (not a
 * copy still on its way) that came after the reply now being written, with no reply of their own under them. An agent
 * that takes a message into its running turn (Claude Code, Codex, OpenCode) starts a reply under yours at once, so
 * these are the ones sent to an agent that can't (Cursor, Grok, Copilot: the message runs when the turn ends), or
 * while another of yours was still waiting. A routine's prompt and another bot's message wait without saying so.
 */
export function waitingSends(messages: readonly Message[]): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') {
      if (!isLocalId(m.id) && m.via !== 'routine' && m.via !== 'bot') out.unshift(m.id);
      continue;
    }
    // another bot's answer to a task handed to it from this chat is not this bot's turn
    if (m.from) continue;
    return m.status === 'streaming' && !isLocalId(m.id) ? out : [];
  }
  return [];
}
