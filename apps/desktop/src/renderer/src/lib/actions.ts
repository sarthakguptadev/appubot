// What the UI does over the gateway. A bot has threads, each its own agent session; the transcript shows one at a
// time (the bot's pick, else its current thread). "New thread" starts a fresh session that knows only the bot's
// memory; sending in an older thread makes it the current one again.
import { BotSchema, type Bot, type FormValue, type Message, type MethodName, type MethodParams, type MethodResult, type Thread } from '@appubot/protocol';
import { NEW_THREAD_TITLE, TRANSIENT_CODES, chatsToPrefetch, openQuestion } from '@appubot/chat-core';
import { create } from 'zustand';
import { GatewayError, activeComputer, errorMessage, rpc, type ComputerId } from './gateway';
import {
  byId, dropLocalReply, getState, keepConversationLast, upsertBy, mergeConversation, moveConversation, pushToast, replaceLocal, setState, settleSent, touchConversation, ui, upsertThreads,
} from './store';
import { absorbSent, enqueueSend, isLocalId, localCopies, newLocalId, rethreadSends, setOutboxChat, useOutbox, whenCloudReady, type QueuedSend } from './outbox';
import { optimistic, settleChange, showChanges } from './optimistic';
import { drafts } from '../features/chat/attachments';

/** Messages in the newest page of a thread (older ones page in as you scroll up). */
export const FIRST_PAGE = 100;

/** RPC with error toasts. Resolves to `undefined` on failure. */
export async function call<M extends MethodName>(
  method: M,
  params?: MethodParams<M>,
  opts: { success?: string; errorTitle?: string; timeoutMs?: number } = {},
): Promise<MethodResult<M> | undefined> {
  const on = activeComputer();
  try {
    const res = await rpc(method, params, opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : undefined);
    if (opts.success) pushToast({ title: opts.success, level: 'success' });
    return res;
  } catch (e) {
    toastCallError(e, opts.errorTitle, on);
    return undefined;
  }
}

/** The small error toast a failed call shows (none for errors something else on screen already explains). */
export function toastCallError(e: unknown, title?: string, on: ComputerId = activeComputer()): void {
  // a stopped version refuses everything but updating: the Update required screen already says so
  if (e instanceof GatewayError && e.code === 'update_required') return;
  // the connection, not the computer, failed (closed on a switch or a hidden window, dropped, not up yet): what was on
  // screen reloads when it's back, and a long outage has its own notice (quiet connecting), so no toast per call
  if (connectionDropped(e)) return;
  // the cloud computer still waking (or gone back to sleep): its pane and notices say so, not a toast per call
  if (e instanceof GatewayError && e.code === 'not_connected' && activeComputer() === 'cloud') return;
  // a call to the computer you've since switched away from (or onto, mid-switch): nothing to tell about it any more
  if (e instanceof GatewayError && e.code === 'not_connected' && (on === 'cloud' || on !== activeComputer())) return;
  pushToast({ title: title ?? 'Something went wrong', body: errorMessage(e), level: 'error' });
}

/** The connection failed under a call (closed, dropped, not up yet), not the computer: retrying later is the fix. */
export function connectionDropped(e: unknown): boolean {
  return e instanceof GatewayError && e.code !== 'timeout' && TRANSIENT_CODES.includes(e.code);
}

/** a thread load that timed out while the connection stayed up is asked again this many times before it's said */
const LOAD_RETRIES = 2;
const LOAD_RETRY_MS = 2000;
const loadTries = new Map<string, number>();

/**
 * Load the newest page of a thread (again after a reconnect: MainLayout asks whenever the connection comes back and the
 * thread on screen isn't loaded). A load the connection cut off says nothing (the reconnect loads it); one that timed
 * out is asked again quietly; only a refusal, or timeouts past the retries, is said.
 */
export async function loadConversation(threadId: string): Promise<void> {
  const entry = touchConversation(threadId);
  if (entry.loaded || entry.loading) return;
  setState((s) => ({ convo: { ...s.convo, [threadId]: { ...s.convo[threadId]!, loading: true } } }));
  try {
    const page = await rpc('threads.history', { id: threadId, limit: FIRST_PAGE });
    mergeConversation(threadId, page.messages, { newest: true, hasMore: page.hasMore });
    loadTries.delete(threadId);
    // messages from here the computer already has: nothing more goes out for them
    for (const m of page.messages) if (m.clientId && isLocalId(m.clientId)) absorbSent(m.clientId);
  } catch (e) {
    setState((s) => {
      const cur = s.convo[threadId];
      return cur ? { convo: { ...s.convo, [threadId]: { ...cur, loading: false } } } : {};
    });
    if (connectionDropped(e)) return;
    const tries = (loadTries.get(threadId) ?? 0) + 1;
    if (e instanceof GatewayError && e.code === 'timeout' && tries <= LOAD_RETRIES) {
      loadTries.set(threadId, tries);
      setTimeout(() => { if (getState().selectedThreadId === threadId) void loadConversation(threadId); }, LOAD_RETRY_MS * tries);
      return;
    }
    loadTries.delete(threadId);
    pushToast({ title: 'Could not load the thread', body: errorMessage(e), level: 'error' });
  }
}

/** fetched ahead after this long connected, so the chat on screen goes first */
export const PREFETCH_DELAY_MS = 1500;
let prefetching = false;
/** asked again while one ran (a switch of computer mid-prefetch): runs once more when it ends */
let prefetchAgain = false;

/**
 * Fetch ahead the newest page of the chats opening a bot would show (chat-core `chatsToPrefetch`: each bot's current
 * chat, most recent first, none already here), one at a time and quietly, so they open at once with no spinner. Each
 * goes at the end of what's kept in memory, never pushing out a chat opened here; stops when the computer on screen
 * changes or the connection goes.
 */
export async function prefetchChats(): Promise<void> {
  if (prefetching) { prefetchAgain = true; return; }
  prefetching = true;
  const from = activeComputer();
  const has = (id: string) => { const c = getState().convo[id]; return !!c && (c.ids.length > 0 || c.loading); };
  try {
    for (const id of chatsToPrefetch(getState().threads, has)) {
      if (activeComputer() !== from || getState().conn !== 'connected') return;
      if (has(id)) continue;
      try {
        const page = await rpc('threads.history', { id, limit: FIRST_PAGE });
        if (activeComputer() !== from) return;
        if (has(id)) continue;
        keepConversationLast(id);
        mergeConversation(id, page.messages, { newest: true, hasMore: page.hasMore });
      } catch {
        // quiet: opening it loads it
      }
    }
  } finally {
    prefetching = false;
    if (prefetchAgain) { prefetchAgain = false; void prefetchChats(); }
  }
}

/**
 * Run `send` once the computer on screen can take it: at once on this Mac; on a cloud computer once it has woken (the
 * change already shows meanwhile). Throws when it can't.
 */
async function whenUp<R>(send: () => Promise<R>): Promise<R> {
  if (activeComputer() === 'cloud' && !(await whenCloudReady())) {
    throw new GatewayError('not_connected', 'Your AppuBot computer didn’t answer in time. Try again in a minute.');
  }
  return send();
}

/** Pin a bot to the top of the roster (a tile), or back into the list: at once, put back if the computer refuses. */
export async function setPinned(bot: { id: string; name: string }, pinned: boolean): Promise<void> {
  await optimistic(
    [{ kind: 'patch', coll: 'bots', id: bot.id, fields: { pinned } }],
    () => whenUp(() => rpc('bots.update', { id: bot.id, patch: { pinned } })),
    { errorTitle: pinned ? `Could not pin ${bot.name}` : `Could not unpin ${bot.name}`, answered: (b) => ({ coll: 'bots', entity: b }) },
  );
}

/** Open a bot: the thread you had open there, else its current one. */
export function openBot(botId: string): void {
  ui.selectBot(botId);
  const id = getState().selectedThreadId;
  if (id && !isLocalId(id)) void loadConversation(id);
}

/** A bot's settings: its chat with the side panel open on Details, where everything about it is changed. */
export function openBotDetails(botId: string): void {
  openBot(botId);
  ui.openRight('bot');
}

/**
 * Open what a thread link points at (a toast, a routine run, a teach session, the thread switcher): that exact
 * thread. Telegram chats open their bot. A thread older than the snapshot's is fetched first.
 */
export async function openThread(threadId: string): Promise<void> {
  let t = getState().threads.find((x) => x.id === threadId);
  if (!t) {
    const res = await call('threads.get', { id: threadId }, { errorTitle: 'Could not open the thread' });
    if (!res) return;
    upsertThreads([res.thread]);
    t = res.thread;
  }
  ui.openThread(t.id);
  if (!isLocalId(t.id)) void loadConversation(t.id);
}

/* ---------- things made here, shown before the computer has them (`local:` ids) ---------- */

/** a chat or bot shown at once, and the computer's own id for it once it answers (null: it refused) */
const madeIds = new Map<string, Promise<string | null>>();
/** The computer's id for something made here (as is for anything else). */
export async function realId(id: string): Promise<string | null> {
  return isLocalId(id) ? (madeIds.get(id) ?? null) : id;
}
function track(localId: string): (real: string | null) => void {
  let done!: (real: string | null) => void;
  madeIds.set(localId, new Promise((resolve) => { done = resolve; }));
  return (real) => { done(real); setTimeout(() => madeIds.delete(localId), 60_000); };
}

/**
 * A new thread for the bot (a fresh agent session; its memory comes along), on screen at once: an empty chat you can
 * type in, which the computer's thread takes over when it answers (the Mac hands back its current thread instead
 * while that has no messages yet, so either way it starts empty). Messages sent meanwhile go once it's there.
 */
export async function startThread(botId: string): Promise<Thread | undefined> {
  const s = getState();
  const bot = s.bots.find((b) => b.id === botId);
  const before = s.selectedThreadId;
  const now = Date.now();
  const local: Thread = {
    id: newLocalId(now), botId, title: NEW_THREAD_TITLE, providerId: bot?.providerId ?? '', cwd: '', status: 'idle',
    ...(bot?.modelId ? { modelId: bot.modelId } : {}), ...(bot?.modeId ? { modeId: bot.modeId } : {}),
    modes: [], models: [], efforts: [], fastAvailable: false, fast: bot?.fast ?? false, commands: [], source: 'desktop',
    lastMessagePreview: '', createdAt: now, updatedAt: now, lastActiveAt: now,
  };
  const resolve = track(local.id);
  setState((st) => ({ threads: [...st.threads, local] }));
  ui.openThread(local.id);
  touchConversation(local.id);
  mergeConversation(local.id, [], { newest: true, hasMore: false });
  let t: Thread;
  try {
    const real = await realId(botId);
    if (!real) throw new Error('The bot wasn’t made.');
    t = await whenUp(() => rpc('threads.start', { botId: real }));
  } catch (e) {
    resolve(null);
    dropStartedThread(local.id, before);
    toastCallError(e, 'Could not start a new thread');
    return undefined;
  }
  // the computer's thread takes the shown one's place: on screen, with what was typed into it meanwhile
  setState((st) => ({
    threads: st.threads.filter((x) => x.id !== local.id),
    threadPick: Object.fromEntries(Object.entries(st.threadPick).map(([b, id]) => [b, id === local.id ? t.id : id])),
    selectedThreadId: st.selectedThreadId === local.id ? t.id : st.selectedThreadId,
  }));
  upsertThreads([t]);
  moveConversation(local.id, t.id);
  const d = drafts.get(`thread:${local.id}`);
  if (d) { drafts.set(`thread:${t.id}`, d); drafts.delete(`thread:${local.id}`); }
  resolve(t.id);
  rethreadSends(local.id, t.id);
  void loadConversation(t.id);
  return t;
}

/** A new chat the computer refused: it goes, the one before it is back on screen, and what was typed in it isn't lost. */
function dropStartedThread(localId: string, before: string | null): void {
  const words = Object.values(useOutbox.getState().sends).filter((q) => q.threadId === localId).sort((a, b) => a.sentAt - b.sentAt);
  for (const q of words) discardQueued(q.localId);
  const typed = [drafts.get(`thread:${localId}`) ?? '', ...words.map((q) => q.text)].filter((x) => x.trim()).join('\n\n');
  drafts.delete(`thread:${localId}`);
  const back = before && !isLocalId(before) ? before : null;
  if (typed && back && !drafts.get(`thread:${back}`)) drafts.set(`thread:${back}`, typed);
  setState((st) => {
    const convo = { ...st.convo };
    delete convo[localId];
    const pickFor = Object.entries(st.threadPick).filter(([, id]) => id !== localId);
    return {
      threads: st.threads.filter((x) => x.id !== localId), convo, convoLru: st.convoLru.filter((id) => id !== localId),
      threadPick: Object.fromEntries(pickFor),
      ...(st.selectedThreadId === localId ? { selectedThreadId: back } : {}),
    };
  });
  ui.syncSelection();
}

/** The question the bot waits on in this thread, from the messages loaded here. */
function openQuestionIn(threadId: string): string | undefined {
  const c = getState().convo[threadId];
  return c ? openQuestion(c.ids.map((id) => c.byId[id]!).filter(Boolean)) : undefined;
}

/** Answers given here and still on their way (question id → answer): the question card shows them answered at once. */
export const usePendingAnswers = create<Record<string, string>>()(() => ({}));

/**
 * Answer a bot's question (its card, or words typed while it waits): shown answered at once, put back (with a small
 * error) if the computer refuses.
 */
export async function answerQuestion(questionId: string, answer: string): Promise<boolean> {
  usePendingAnswers.setState({ [questionId]: answer });
  const clear = () => usePendingAnswers.setState((s) => { const n = { ...s }; delete n[questionId]; return n; }, true);
  try {
    await whenUp(() => rpc('chat.answer', { questionId, answer, clientId: newLocalId() }));
    // the card keeps showing it until the computer's copy of the question (answered) comes back
    setTimeout(clear, 30_000);
    return true;
  } catch (e) {
    clear();
    toastCallError(e, 'Could not send your answer');
    return false;
  }
}

/** A form card's answer as the computer took it, or why not (`problems`: by field id, when it says which). */
export type FormAnswerResult = { ok: true } | { ok: false; message: string; problems?: Record<string, string> };

/**
 * Send a form card (`chat.answerForm`): its values, a Vault item picked instead (`savedId`), or a decline. Not
 * optimistic: the computer checks it (a Vault card saves it), and the card keeps what was typed when it refuses.
 */
export async function answerForm(questionId: string, values: Record<string, FormValue>, opts: { savedId?: string; decline?: boolean } = {}): Promise<FormAnswerResult> {
  try {
    await whenUp(() => rpc('chat.answerForm', { questionId, values, ...(opts.savedId ? { savedId: opts.savedId } : {}), ...(opts.decline ? { decline: true } : {}), clientId: newLocalId() }));
    return { ok: true };
  } catch (e) {
    const problems = e instanceof GatewayError && e.data && typeof e.data === 'object' ? (e.data as { problems?: Record<string, string> }).problems : undefined;
    return { ok: false, message: errorMessage(e), ...(problems ? { problems } : {}) };
  }
}

/**
 * Message a bot in the thread on screen (`threadId`, which becomes its current one). It shows at once and goes in the
 * background (lib/outbox.ts), on this Mac and a cloud computer alike, its files uploaded first on a remote one (`blobs`).
 * Without a thread (the bot's first message) a new one is started for it at once. Resolves false only when nothing was
 * queued (the composer then keeps the words). `direct`: wait for the computer's answer (onboarding's first prompt must
 * land before its next step).
 */
export async function sendMessage(
  botId: string, threadId: string | null, text: string, images: { mimeType: string; data: string }[] = [],
  opts: { blobs?: File[]; direct?: boolean } = {},
): Promise<boolean> {
  // the bot is waiting on a question (a new bot setting itself up, an ask_user): typing answers it
  const waiting = threadId && !images.length && !opts.blobs?.length && text.trim() ? openQuestionIn(threadId) : undefined;
  if (waiting) {
    void answerQuestion(waiting, text.trim());
    return true;
  }
  // the bot's first message (no thread yet: the computer picks or makes its chat, the one a new bot greets in), or a
  // bot still being made: it goes once the computer has the bot, and shows when it answers
  if (opts.direct || !threadId || isLocalId(botId)) {
    const real = await realId(botId);
    if (!real) return false;
    return sendNow(real, threadId, text, images);
  }
  return !!enqueueSend({ botId, threadId, text, images, ...(opts.blobs?.length ? { blobs: opts.blobs } : {}) });
}

/** Send and wait for the computer's answer (no local copy). */
async function sendNow(botId: string, threadId: string | null, text: string, images: { mimeType: string; data: string }[]): Promise<boolean> {
  let res: MethodResult<'chat.send'>;
  try {
    res = await whenUp(() => rpc('chat.send', { botId, threadId: threadId ?? undefined, text, images }));
  } catch (e) {
    toastCallError(e, 'Message not sent');
    return false;
  }
  const made = res.userMessage.threadId;
  if (made !== threadId) {
    setState((s) => ({ threadPick: { ...s.threadPick, [botId]: made } }));
    ui.syncSelection();
    touchConversation(made);
    void loadConversation(made);
  }
  mergeConversation(made, [res.userMessage]);
  return true;
}

/**
 * Make a bot: it shows in the roster, on screen, at once (it greets you once the computer has made it); the computer's
 * bot takes its place when it answers, and it goes again (with an error) if it refuses.
 */
export async function createBot(params: MethodParams<'bots.create'>): Promise<Bot | undefined> {
  const now = Date.now();
  const localId = newLocalId(now);
  const shown = BotSchema.safeParse({ ...params, id: localId, slug: '', workspace: '', createdAt: now, updatedAt: now });
  const before = getState().selectedBotId;
  const resolve = track(localId);
  if (shown.success) {
    setState((st) => ({ bots: [...st.bots, shown.data] }));
    ui.selectBot(localId);
  }
  let created: Bot;
  try {
    created = await whenUp(() => rpc('bots.create', params));
  } catch (e) {
    resolve(null);
    setState((st) => ({ bots: st.bots.filter((b) => b.id !== localId), ...(st.selectedBotId === localId ? { selectedBotId: before } : {}) }));
    ui.syncSelection();
    toastCallError(e, 'Could not create bot');
    return undefined;
  }
  setState((st) => ({
    bots: upsertBy(st.bots.filter((b) => b.id !== localId), created, byId),
    ...(st.selectedBotId === localId || !shown.success ? { selectedBotId: created.id } : {}),
  }));
  ui.syncSelection();
  const d = drafts.get(`bot:${localId}`);
  if (d) { drafts.set(`bot:${created.id}`, d); drafts.delete(`bot:${localId}`); }
  resolve(created.id);
  return created;
}

/** Save changes to a bot (its editor): shown at once, put back with an error if the computer refuses. */
export async function updateBot(bot: { id: string; name: string }, patch: MethodParams<'bots.update'>['patch'], opts: { errorTitle?: string } = {}): Promise<Bot | undefined> {
  const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Record<string, unknown>;
  // `''` clears these on the computer (protocol `patchOf`): the bot has none until it says otherwise
  for (const k of ['characterId', 'modelId', 'modeId']) if (fields[k] === '') fields[k] = undefined;
  return optimistic(
    [{ kind: 'patch', coll: 'bots', id: bot.id, fields }],
    () => whenUp(() => rpc('bots.update', { id: bot.id, patch })),
    { errorTitle: opts.errorTitle ?? `Could not save ${bot.name}`, answered: (b) => ({ coll: 'bots', entity: b }) },
  );
}

export async function renameThread(threadId: string, title: string): Promise<boolean> {
  const next = title.replace(/\s+/g, ' ').trim();
  const t = getState().threads.find((x) => x.id === threadId);
  if (!t || !next || next === t.title) return true;
  const res = await optimistic(
    [{ kind: 'patch', coll: 'threads', id: threadId, fields: { title: next } }],
    () => whenUp(() => rpc('threads.rename', { id: threadId, title: next })),
    { errorTitle: 'Could not rename the thread', answered: (r) => ({ coll: 'threads', entity: r }) },
  );
  return !!res;
}

/** Ask, then delete a thread (its messages; the bot's memory keeps what it saved): gone at once, back if refused. */
export function deleteThread(threadId: string): void {
  const s = getState();
  const t = s.threads.find((x) => x.id === threadId);
  if (!t) return;
  const bot = s.bots.find((b) => b.id === t.botId)?.name ?? 'the bot';
  confirm({
    title: 'Delete this thread?',
    body: `Its messages are removed from AppuBot. What ${bot} saved to memory stays.`,
    confirmLabel: 'Delete', danger: true,
    onConfirm: () => {
      void optimistic(
        [{ kind: 'remove', coll: 'threads', id: threadId }],
        () => whenUp(() => rpc('threads.delete', { id: threadId })),
        { errorTitle: 'Could not delete the thread' },
      );
    },
  });
}

/** Ask, then delete a bot (its chats; its workspace folder stays): gone from the roster at once, back if refused. */
export function deleteBot(bot: { id: string; name: string }, opts: { body: string; confirmLabel: string; deleteWorkspace?: boolean }): void {
  confirm({
    title: `Delete ${bot.name}?`, body: opts.body, confirmLabel: opts.confirmLabel, danger: true,
    onConfirm: () => {
      const s = getState();
      // another bot on screen meanwhile (the next one in the roster)
      if (s.selectedBotId === bot.id) {
        const next = s.bots.find((b) => b.id !== bot.id);
        if (next) ui.selectBot(next.id); else setState({ selectedBotId: null, selectedThreadId: null });
      }
      void optimistic(
        [{ kind: 'remove', coll: 'bots', id: bot.id }],
        () => whenUp(() => rpc('bots.delete', { id: bot.id, ...(opts.deleteWorkspace !== undefined ? { deleteWorkspace: opts.deleteWorkspace } : {}) })),
        { errorTitle: `Could not delete ${bot.name}` },
      );
    },
  });
}

export function confirm(opts: { title: string; body: string; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void> }): void {
  ui.openModal({ kind: 'confirm', ...opts });
}

/* ---------- messages on their way (lib/outbox.ts) ---------- */

/** The last message in a chat that isn't one of `skip`'s copies (a copy placed again goes after everything else). */
function lastTimeIn(threadId: string, skip: string): number {
  const c = getState().convo[threadId];
  if (!c) return 0;
  for (let i = c.ids.length - 1; i >= 0; i--) {
    const id = c.ids[i]!;
    if (!id.startsWith(skip)) return c.byId[id]?.createdAt ?? 0;
  }
  return 0;
}

/** a message's prediction that its chat is now working (settled with the send) */
const working = new Map<string, number>();
function endWorking(localId: string, ok: boolean): void {
  const seq = working.get(localId);
  if (seq === undefined) return;
  working.delete(localId);
  settleChange(seq, ok);
}

/** Take a queued message out of its chat and the queue (a new chat that wasn't made). */
function discardQueued(localId: string): void {
  const q = useOutbox.getState().sends[localId];
  if (!q) return;
  useOutbox.setState((st) => { const sends = { ...st.sends }; delete sends[localId]; return { sends }; });
  replaceLocal(q.threadId, q.localId);
  dropLocalReply(q.threadId, q.localId);
  endWorking(localId, false);
}

const outboxChat = {
  place(q: QueuedSend) {
    touchConversation(q.threadId);
    const s = getState();
    const t = s.threads.find((x) => x.id === q.threadId);
    const hadRow = !!s.convo[q.threadId]?.byId[`${q.localId}:reply`];
    // the bot was idle: its working row goes under the message, and the chat shows working at once
    const busy = t?.status === 'running' || t?.status === 'waiting';
    const withReply = q.state !== 'failed' && (hadRow || !busy);
    mergeConversation(q.threadId, localCopies({ ...q, withReply }, lastTimeIn(q.threadId, q.localId)) as Message[]);
    if (withReply && t && !working.has(q.localId)) {
      working.set(q.localId, showChanges([{ kind: 'patch', coll: 'threads', id: t.id, fields: { status: 'running', lastActiveAt: Date.now() } }]));
    }
  },
  settle(q: QueuedSend, real, agentMessageId) {
    settleSent(q.threadId, q.localId, real, agentMessageId);
    absorbSent(q.localId);
    endWorking(q.localId, true);
  },
  fail(q: QueuedSend) {
    dropLocalReply(q.threadId, q.localId);
    endWorking(q.localId, false);
  },
  remove(q: QueuedSend) {
    replaceLocal(q.threadId, q.localId);
    dropLocalReply(q.threadId, q.localId);
    endWorking(q.localId, false);
  },
} satisfies Parameters<typeof setOutboxChat>[0];
setOutboxChat(outboxChat);

/**
 * A message sent by a caller that waits for the computer itself (voice mode: its reading follows the reply's id), shown
 * at once all the same: its copy (and recording) and the bot's working row now, the computer's message in their place
 * when `chat.send` answers (`sentShown`), gone again if it fails (`unsentShown`). Its `localId` is the send's `clientId`.
 */
export function showSending(p: { botId: string; threadId: string; text: string; voice?: { recordingId: string; durationMs: number } }): QueuedSend {
  const q: QueuedSend = { localId: newLocalId(), key: '', botId: p.botId, threadId: p.threadId, text: p.text, images: [], ...(p.voice ? { voice: p.voice } : {}), sentAt: Date.now(), state: 'sending' };
  outboxChat.place(q);
  return q;
}
export function sentShown(q: QueuedSend, res: MethodResult<'chat.send'>): void {
  outboxChat.settle(q, res.userMessage, res.agentMessageId);
}
export function unsentShown(q: QueuedSend): void {
  outboxChat.remove(q);
}
