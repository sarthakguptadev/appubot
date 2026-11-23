/**
 * Threads: CRUD, message storage, auto titles, status transitions. A bot has many threads, each its own agent
 * session (ChatService); its current one (`chatFor`: started or sent to last) takes turns that name no thread, and
 * `history` still reads all of them as one (older phones, `read_bot_history`). Telegram chats are threads of their own.
 */
import { ThreadSchema, currentChat, messagePreview, newId, type Message, type MethodParams, type Part, type Thread } from '@appubot/protocol';
import { NEW_THREAD_TITLE, isDefaultThreadTitle } from '@appubot/chat-core';
import type { CoreCtx } from '../context';
import { notFound } from '../util';

/** The title a thread gets until its first message names it (older versions called it "New chat"). */
export const DEFAULT_TITLE = NEW_THREAD_TITLE;
export const isDefaultTitle = isDefaultThreadTitle;

export function autoTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return DEFAULT_TITLE;
  if (t.length <= 60) return t;
  const cut = t.slice(0, 59);
  const sp = cut.lastIndexOf(' ');
  return (sp > 30 ? cut.slice(0, sp) : cut) + '…';
}

export interface CreateThreadOptions {
  botId: string; title?: string; cwd?: string;
  source?: Thread['source']; routineId?: string; channel?: string; groupId?: string; groupChatId?: string;
}

export class ThreadsService {
  constructor(private ctx: CoreCtx) {}

  private get store() { return this.ctx.store.threads; }

  list(o: { botId?: string; limit?: number } = {}): Thread[] {
    return this.store.list()
      .filter((t) => !o.botId || t.botId === o.botId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, o.limit ?? 100);
  }

  /** The bot's current thread (started or sent to last, Telegram chats aside), created on first use. */
  chatFor(botId: string): Thread {
    return currentChat(this.store.list(), botId) ?? this.create({ botId });
  }

  /** All of a bot's threads but Telegram chats. */
  conversationThreads(botId: string): Thread[] {
    return this.store.list().filter((t) => t.botId === botId && t.source !== 'channel' && t.source !== 'group');
  }

  /** A page of all the bot's threads as one history, newest backwards (`bots.history`). */
  history(botId: string, o: Omit<MethodParams<'bots.history'>, 'id'>): { messages: Message[]; hasMore: boolean } {
    this.ctx.s.bots.require(botId);
    const ids = this.conversationThreads(botId).map((t) => t.id);
    return this.store.page(ids, { before: o.before, limit: o.limit ?? 100, since: o.since, max: 1000 });
  }

  /** A page of one thread, newest backwards (`threads.history`). */
  threadHistory(id: string, o: Omit<MethodParams<'threads.history'>, 'id'>): { messages: Message[]; hasMore: boolean } {
    this.require(id);
    return this.store.page([id], { before: o.before, limit: o.limit ?? 100 });
  }

  /**
   * The stretch of `thread`'s own conversation before `msg`, oldest first and at most `max` messages: what a
   * replacement agent session is primed with (nothing for a new thread: it starts fresh).
   */
  conversationBefore(thread: Thread, msg: Message, max = 400): Message[] {
    return this.store.page([thread.id], { before: msg, limit: max }).messages;
  }

  /** Whether the thread holds no message at all (its archive included). */
  isEmpty(id: string): boolean {
    return this.store.getMessages(id).length === 0 && this.store.archiveRefs(id).length === 0;
  }

  /** Whether nobody has written in the thread yet: empty, or only what the bot said to open it. */
  isUntouched(id: string): boolean {
    return this.store.archiveRefs(id).length === 0 && this.store.getMessages(id).every((m) => m.role !== 'user');
  }

  /** The thread was sent to: it becomes (or stays) its bot's current one. */
  markActive(id: string, at = Date.now()): Thread {
    const t = this.require(id);
    // a group thread never becomes current (it keeps lastActiveAt 0, so older apps never pick it either)
    if (t.source === 'group') return t;
    return this.update(id, { lastActiveAt: Math.max(at, t.lastActiveAt ?? 0) });
  }

  get(id: string): Thread | undefined { return this.store.get(id); }
  require(id: string): Thread {
    const t = this.store.get(id);
    if (!t) throw notFound('Thread', id);
    return t;
  }

  create(o: CreateThreadOptions): Thread {
    const bot = this.ctx.s.bots.require(o.botId);
    const now = Date.now();
    // The agent only reports its models/modes once a session starts (the first message). Until then a new chat
    // borrows them from the latest chat on the same provider, so the composer's pickers show from the start and a
    // pick made now is applied when the session starts.
    const known = this.list()
      .filter((t) => t.providerId === bot.providerId && (t.models.length || t.modes.length))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const fromBot = known?.botId === bot.id;
    const thread = ThreadSchema.parse({
      id: newId('thr'),
      botId: bot.id,
      title: o.title?.trim() || DEFAULT_TITLE,
      providerId: bot.providerId,
      cwd: o.cwd || bot.workspace,
      status: 'idle',
      modeId: bot.modeId ?? (fromBot ? known.modeId : undefined),
      modelId: bot.modelId ?? (fromBot ? known.modelId : undefined),
      modes: known?.modes ?? [],
      models: known?.models ?? [],
      effortId: bot.effort,
      efforts: known?.efforts ?? [],
      fast: bot.fast,
      fastAvailable: known?.fastAvailable ?? false,
      commands: known?.commands ?? [],
      source: o.source ?? 'desktop',
      routineId: o.routineId,
      channel: o.channel,
      groupId: o.groupId,
      ...(o.groupChatId ? { groupChatId: o.groupChatId } : {}),
      createdAt: now,
      updatedAt: now,
      // a thread started now is its bot's current one; a group thread never is: 0, which older apps (whose
      // currentChat doesn't know group threads) sort last, so they never open one as the bot's chat
      lastActiveAt: o.source === 'group' ? 0 : now,
    });
    this.store.put(thread);
    this.ctx.bus.emit('thread.updated', thread);
    return thread;
  }

  /** Patch + persist + emit `thread.updated`. */
  update(id: string, patch: Partial<Thread>, touch = true): Thread {
    const prev = this.require(id);
    const next: Thread = { ...prev, ...patch, id, updatedAt: touch ? Date.now() : prev.updatedAt };
    this.store.put(next);
    this.ctx.bus.emit('thread.updated', next);
    return next;
  }

  /** A rename isn't activity: the thread keeps its place in the lists. */
  rename(id: string, title: string): Thread { return this.update(id, { title: title.replace(/\s+/g, ' ').trim().slice(0, 120) || DEFAULT_TITLE }, false); }

  async delete(id: string): Promise<{ ok: true }> {
    this.require(id);
    await this.ctx.s.chat.closeThread(id);
    this.store.delete(id);
    this.ctx.bus.emit('thread.deleted', { id });
    return { ok: true };
  }

  /** One thread's messages, a page from the newest backwards (`threads.messages`, for phones on older builds). */
  messages(id: string, o: { before?: number; limit?: number } = {}): Message[] {
    this.require(id);
    // a cursor that sorts before every message stamped `before`: strictly older ones only
    const before = o.before === undefined ? undefined : { createdAt: o.before, role: 'user' as const, id: '' };
    return this.store.page([id], { before, limit: o.limit ?? 200 }).messages;
  }

  getWithMessages(id: string): { thread: Thread; messages: Message[] } {
    return { thread: this.require(id), messages: this.messages(id, { limit: 500 }) };
  }

  findMessage(threadId: string, messageId: string): Message | undefined {
    return this.store.getMessages(threadId).find((m) => m.id === messageId);
  }

  /** Append a message, persist, emit `message.created`, refresh the preview. */
  addMessage(msg: Message): Message {
    const list = this.store.getMessages(msg.threadId);
    list.push(msg);
    this.store.scheduleSave(msg.threadId);
    this.ctx.bus.emit('message.created', structuredClone(msg));
    this.refreshPreview(msg.threadId, msg);
    return msg;
  }

  /** Adds a part to a message already in the thread (a reply's reading, `voice`): persisted, sent as `message.part`. */
  appendPart(threadId: string, messageId: string, part: Part): { partIndex: number } {
    const msg = this.findMessage(threadId, messageId);
    if (!msg) throw notFound('Message', messageId);
    msg.parts.push(part);
    msg.updatedAt = Date.now();
    this.store.scheduleSave(threadId);
    const partIndex = msg.parts.length - 1;
    this.ctx.bus.emit('message.part', { threadId, messageId, partIndex, part: structuredClone(part) });
    return { partIndex };
  }

  touchMessage(threadId: string): void { this.store.scheduleSave(threadId); }
  flush(threadId: string): void { this.store.flushThread(threadId); }

  refreshPreview(threadId: string, msg: Message): void {
    // a routine's prompt never is the preview: its reply becomes it, unless that had nothing to say (ChatService.finish)
    if (msg.role === 'user' && msg.via === 'routine') return;
    const preview = messagePreview(msg);
    if (!preview) return;
    const t = this.get(threadId);
    if (t && t.lastMessagePreview !== preview) this.update(threadId, { lastMessagePreview: preview });
  }
}
