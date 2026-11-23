/**
 * Messages go without waiting, to whichever computer is on screen (this Mac, your AppuBot computer, a team's): a send
 * shows in the chat at once as a local copy (`local:` id, its `clientId` on the computer; chat-core sendQueue.ts), with
 * the bot's working row under it when the bot was idle, and the composer is free again. It goes out in order, one at a
 * time per computer, once that computer is connected (a cloud computer may first have to wake: the copy is kept
 * meanwhile, in memory and in its saved copy, features/cloud/cloudCacheData.ts). Files for a remote computer are
 * uploaded first, in the background (`uploaded` counts them). The computer's own message then takes the copy's place
 * (by `clientId`: the `message.created` event, `chat.send`'s answer or a history page, whichever comes first), keeping
 * the copy's transcript row. One that can't go (refused, or no answer within its computer's wait) stays as "Not sent"
 * with Try again, Edit (back into the composer) and Delete; its words are never lost.
 *
 * A dropped connection mid-send sends it again with the same `clientId`: the computer takes one once
 * (`<dataDir>/sent-ids.json` there), so nothing arrives twice.
 */
import { create } from 'zustand';
import { CLOUD_READY_TIMEOUT_MS } from '@appubot/client';
import { LOCAL_PREFIX, TRANSIENT_CODES, isLocalId, localMessages, localTime, newLocalId, type LocalFile } from '@appubot/chat-core';
import type { Message } from '@appubot/protocol';
import { GatewayError, errorMessage, uploadTo, type GatewayLike } from './gateway';

export { LOCAL_PREFIX, isLocalId, newLocalId };

/** how long a message waits for a cloud computer to answer (a long sleep takes minutes to wake) before "Not sent" */
export const SEND_WAIT_MS = CLOUD_READY_TIMEOUT_MS + 30_000;
/** the same for this Mac (its gateway is a local socket: a minute without it is something wrong) */
export const LOCAL_SEND_WAIT_MS = 60_000;
/** this Mac's key in the queue (a cloud computer's is its `cloudCacheKey`: `own`, `team:<id>`) */
export const MAC_KEY = 'mac';

export type SendState = 'queued' | 'uploading' | 'sending' | 'failed';

export interface QueuedSend {
  localId: string;
  /** which computer it was written to: `mac`, or a cloud computer's `cloudCacheKey` */
  key: string;
  botId: string;
  threadId: string;
  text: string;
  images: { mimeType: string; data: string }[];
  /** files sent with it (a remote computer: their bytes go first), as their chips show */
  files?: LocalFile[];
  /** those files' bytes (memory only: never in a saved copy) */
  blobs?: File[];
  /** once its files are uploaded */
  attachments?: { id: string }[];
  /** files uploaded so far (the chips' progress) */
  uploaded?: number;
  /** a spoken message (voice mode: shown, never queued): its recording on the computer */
  voice?: { recordingId: string; durationMs: number };
  /** the bot was idle when it was sent: its working row goes under the copy */
  withReply?: boolean;
  /** when it was sent (or tried again): it looks pending only a second after this */
  sentAt: number;
  state: SendState;
  error?: string;
}

/* ---------- pure ---------- */

/** The local copies shown for a queued message (and its working row), after everything in its chat (`after`). */
export function localMessage(q: QueuedSend, after = 0): Message {
  return localCopies(q, after)[0]!;
}
export function localCopies(q: QueuedSend, after = 0): Message[] {
  return localMessages({
    localId: q.localId, threadId: q.threadId, text: q.text, images: q.images, files: q.files, ...(q.voice ? { voice: q.voice } : {}),
    at: localTime(q.sentAt, after), withReply: !!q.withReply && q.state !== 'failed', via: 'desktop',
  });
}

/** The connection, not the computer, failed: the message may or may not have reached it, so it goes again. */
export const transient = (e: unknown): boolean =>
  e instanceof GatewayError ? TRANSIENT_CODES.includes(e.code) : e instanceof TypeError;

/** The ones to send now for the computer on screen, oldest first (not ones whose chat is still being made). */
export function dueSends(sends: Record<string, QueuedSend>, key: string | null): QueuedSend[] {
  if (!key) return [];
  return Object.values(sends).filter((q) => q.key === key && q.state === 'queued' && !isLocalId(q.threadId)).sort((a, b) => a.sentAt - b.sentAt);
}

/** Whether a computer has messages still on their way (it stays connected for them). */
export const hasPending = (sends: Record<string, QueuedSend>, key: string | null): boolean =>
  !!key && Object.values(sends).some((q) => q.key === key && q.state !== 'failed');

/* ---------- the queue ---------- */

export const useOutbox = create<{ sends: Record<string, QueuedSend> }>()(() => ({ sends: {} }));

/** What the queue needs of a computer's connection (cloudClient.ts for the cloud, boot.ts for this Mac). */
export interface OutboxLink {
  /** its key while it is the computer on screen, else null */
  onScreen(): string | null;
  /** its client once it is connected and has said hello, else null */
  ready(): GatewayLike | null;
  /** open its connection (a send is the person's intent: it may wake the computer) */
  wake(): void;
  /** how long a message waits for it before "Not sent" (default SEND_WAIT_MS) */
  waitMs?: number;
}

/** What the queue does to the chat (actions.ts gives it). */
export interface OutboxChat {
  /** put the local copy in its chat (again: a retry moves it to the end) */
  place(q: QueuedSend): void;
  /** the computer's message took the copy's place (`agentMessageId`: its reply, for the working row) */
  settle(q: QueuedSend, real: Message, agentMessageId?: string): void;
  /** it shows "Not sent" (its working row goes) */
  fail?(q: QueuedSend): void;
  /** take the copy out (deleted, or put back into the composer) */
  remove(q: QueuedSend): void;
}

let cloudLink: OutboxLink | null = null;
let macLink: OutboxLink | null = null;
let chat: OutboxChat | null = null;
/** The cloud computers' link (features/cloud/cloudClient.ts). */
export function setOutboxLink(l: OutboxLink | null): void { cloudLink = l; }
/** This Mac's link (lib/boot.ts). */
export function setMacOutboxLink(l: OutboxLink | null): void { macLink = l; }
export function setOutboxChat(c: OutboxChat | null): void { chat = c; }

/** The computer on screen: its key and link. */
function onScreen(): { key: string; link: OutboxLink } | null {
  for (const link of [cloudLink, macLink]) {
    const key = link?.onScreen() ?? null;
    if (link && key) return { key, link };
  }
  return null;
}
const screenKey = (): string | null => onScreen()?.key ?? null;

const patch = (localId: string, p: Partial<QueuedSend> | null): void =>
  useOutbox.setState((s) => {
    const cur = s.sends[localId];
    if (!cur) return s;
    const sends = { ...s.sends };
    if (p === null) delete sends[localId]; else sends[localId] = { ...cur, ...p };
    return { sends };
  });

/** when each queued message started waiting for its computer (this run) */
const waitingSince = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let pumping = false;

export interface SendInput {
  botId: string;
  threadId: string;
  text: string;
  images: { mimeType: string; data: string }[];
  /** a remote computer: the files' bytes, uploaded before the message goes */
  blobs?: File[];
  /** the bot is idle: a working row goes under the copy */
  withReply?: boolean;
}

/** Queue a message to the computer on screen: its copy shows at once, it goes once the computer answers. */
export function enqueueSend(input: SendInput, now = Date.now()): QueuedSend | null {
  const at = onScreen();
  if (!at) return null;
  const { blobs, ...rest } = input;
  const q: QueuedSend = {
    localId: newLocalId(now), key: at.key, ...rest, sentAt: now, state: 'queued',
    ...(blobs?.length ? { blobs, files: blobs.map((f) => ({ name: f.name, mimeType: f.type || 'application/octet-stream', size: f.size })), uploaded: 0 } : {}),
  };
  useOutbox.setState((s) => ({ sends: { ...s.sends, [q.localId]: q } }));
  chat?.place(q);
  at.link.wake();
  pumpOutbox(now);
  return q;
}

/** Put back what a computer had on its way (switching to it, a saved copy); those still queued go once it answers. */
export function restoreSends(list: QueuedSend[]): void {
  if (!list.length) return;
  useOutbox.setState((s) => {
    const sends = { ...s.sends };
    for (const q of list) if (!sends[q.localId]) sends[q.localId] = q;
    return { sends };
  });
  for (const q of list) chat?.place(useOutbox.getState().sends[q.localId] ?? q);
  if (list.some((q) => q.state === 'queued')) onScreen()?.link.wake();
  pumpOutbox();
}

/** The sends kept for one computer (a cloud computer's saved copy carries them). */
export function sendsFor(key: string): QueuedSend[] {
  return Object.values(useOutbox.getState().sends).filter((q) => q.key === key);
}

/** Forget a computer's queue (it is no longer the person's, or signed out: `null` = every cloud computer's). */
export function dropSendsFor(key: string | null): void {
  useOutbox.setState((s) => ({
    sends: Object.fromEntries(Object.entries(s.sends).filter(([, q]) => (key === null ? q.key === MAC_KEY : q.key !== key))),
  }));
}

/** A new chat was made for messages sent to it while it was being made (`local:` thread → the computer's). */
export function rethreadSends(from: string, to: string): QueuedSend[] {
  const moved: QueuedSend[] = [];
  useOutbox.setState((s) => {
    const sends = { ...s.sends };
    for (const q of Object.values(sends)) if (q.threadId === from) { sends[q.localId] = { ...q, threadId: to }; moved.push(sends[q.localId]!); }
    return moved.length ? { sends } : s;
  });
  pumpOutbox();
  return moved;
}

/** Try a "Not sent" message again: back to the end of its chat, queued. */
export function retrySend(localId: string): void {
  const q = useOutbox.getState().sends[localId];
  if (!q) return;
  waitingSince.delete(localId);
  const next: QueuedSend = { ...q, state: 'queued', error: undefined, sentAt: Date.now() };
  patch(localId, next);
  chat?.place(next);
  onScreen()?.link.wake();
  pumpOutbox();
}

/** Drop a "Not sent" message. */
export function discardSend(localId: string): void {
  const q = useOutbox.getState().sends[localId];
  if (!q) return;
  waitingSince.delete(localId);
  patch(localId, null);
  chat?.remove(q);
}

/** Take a "Not sent" message back to edit (it leaves the chat; the caller puts its words in the composer). */
export function takeBackSend(localId: string): QueuedSend | null {
  const q = useOutbox.getState().sends[localId];
  if (!q || q.state !== 'failed') return null;
  discardSend(localId);
  return q;
}

/** The computer's own message for a local copy arrived (an event, a page): the copy is done, nothing more goes out. */
export function absorbSent(localId: string): void {
  if (!useOutbox.getState().sends[localId]) return;
  waitingSince.delete(localId);
  patch(localId, null);
}

function markFailed(q: QueuedSend, error: string): void {
  waitingSince.delete(q.localId);
  patch(q.localId, { state: 'failed', error });
  const now = useOutbox.getState().sends[q.localId];
  if (now) chat?.fail?.(now);
}

/** The connection can't come up (refused, another version, gave up): everything waiting on it shows "Not sent". */
export function failWaiting(reason: string, key: string | null = screenKey()): void {
  for (const q of Object.values(useOutbox.getState().sends)) {
    if (q.key !== key || q.state === 'failed') continue;
    markFailed(q, reason);
  }
}

/** after the connection dropped mid-send, the next try (unless the computer's hello comes first) */
const RETRY_MS = 1000;

const noAnswer = (key: string): string =>
  key === MAC_KEY ? 'AppuBot didn’t answer in time. Try again.' : 'Your AppuBot computer didn’t answer in time. Try again.';

/** Upload what a message carries that isn't uploaded yet; returns the attachments, or throws. */
async function uploadFiles(c: GatewayLike, q: QueuedSend): Promise<{ id: string }[]> {
  const blobs = q.blobs ?? [];
  const done = [...(q.attachments ?? [])];
  for (let i = done.length; i < blobs.length; i++) {
    const f = blobs[i]!;
    const file = await uploadTo(c, f, f.name);
    done.push({ id: file.id });
    patch(q.localId, { attachments: [...done], uploaded: done.length });
  }
  return done;
}

/**
 * Send what is due for the computer on screen, one at a time in order; called on every queueing, when the computer
 * says hello, and by its own timer while something waits (which marks one "Not sent" after its computer's wait).
 */
export function pumpOutbox(now = Date.now()): void {
  if (timer) { clearTimeout(timer); timer = null; }
  const at = onScreen();
  const due = dueSends(useOutbox.getState().sends, at?.key ?? null);
  if (!at || !due.length) return;
  const waitMs = at.link.waitMs ?? SEND_WAIT_MS;
  const client = at.link.ready();
  if (!client) {
    let next = Infinity;
    for (const q of due) {
      const since = waitingSince.get(q.localId) ?? now;
      waitingSince.set(q.localId, since);
      if (now - since >= waitMs) markFailed(q, noAnswer(q.key));
      else next = Math.min(next, since + waitMs - now);
    }
    if (next < Infinity) timer = setTimeout(() => pumpOutbox(), next + 50);
    return;
  }
  if (pumping) return;
  pumping = true;
  let dropped = false;
  void (async () => {
    try {
      for (const q of due) {
        const cur = useOutbox.getState().sends[q.localId];
        if (!cur || cur.state !== 'queued' || screenKey() !== cur.key) continue;
        const c = onScreen()?.link.ready();
        if (!c) break;
        try {
          let attachments = cur.attachments ?? [];
          if (cur.blobs?.length && attachments.length < cur.blobs.length) {
            patch(cur.localId, { state: 'uploading' });
            attachments = await uploadFiles(c, cur);
            if (!useOutbox.getState().sends[cur.localId]) continue;
          } else if (cur.files?.length && !cur.blobs?.length && attachments.length < cur.files.length) {
            // its files' bytes are gone (it came back from a saved copy): it can't go as it was
            markFailed(cur, 'Attach the files again to send this.');
            continue;
          }
          patch(cur.localId, { state: 'sending' });
          const res = await c.call('chat.send', { botId: cur.botId, threadId: cur.threadId, text: cur.text, images: cur.images, attachments, clientId: cur.localId });
          waitingSince.delete(cur.localId);
          const latest = useOutbox.getState().sends[cur.localId] ?? cur;
          if (useOutbox.getState().sends[cur.localId]) patch(cur.localId, null);
          chat?.settle(latest, res.userMessage, res.agentMessageId);
        } catch (e) {
          const latest = useOutbox.getState().sends[cur.localId];
          if (!latest) continue;
          if (transient(e)) { patch(cur.localId, { state: 'queued' }); dropped = true; break; }
          markFailed(latest, errorMessage(e));
        }
      }
    } finally {
      pumping = false;
    }
    // what came in meanwhile gets its turn; after a dropped connection, a moment later (its hello pumps sooner)
    if (!dueSends(useOutbox.getState().sends, screenKey()).length) return;
    if (dropped) { if (timer) clearTimeout(timer); timer = setTimeout(() => pumpOutbox(), RETRY_MS); }
    else pumpOutbox();
  })();
}

/**
 * Resolve once the cloud computer on screen is ready to take a call (opening its connection), or null after
 * `timeoutMs` / when this Mac goes on screen. For calls that can't be queued like messages (an answer, a rename).
 */
export function whenCloudReady(timeoutMs = SEND_WAIT_MS): Promise<GatewayLike | null> {
  if (!cloudLink?.onScreen()) return Promise.resolve(null);
  const now = cloudLink.ready();
  if (now) return Promise.resolve(now);
  cloudLink.wake();
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const c = cloudLink?.ready() ?? null;
      if (c || !cloudLink?.onScreen() || Date.now() - started > timeoutMs) { clearInterval(tick); resolve(c); }
    }, 250);
  });
}

/** For tests: forget everything. */
export function resetOutbox(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pumping = false;
  waitingSince.clear();
  useOutbox.setState({ sends: {} });
}
