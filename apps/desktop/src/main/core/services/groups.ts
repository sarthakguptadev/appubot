/**
 * Groups: a few bots that talk with each other in a room of their own to get work done (protocol groups.ts, the rules
 * in chat-core groups.ts). The room keeps its own messages (`<dataDir>/groups/<id>.json`, the newest
 * `GROUP_MESSAGES_MAX`); the groups themselves live in `store.groups`. A message posted to the room (by the user,
 * `groups.send`; by a bot, its reply or `post_to_group`) goes to the members who answer it (the ones it names, else the
 * lead, every member or the lead by who wrote it) as a turn in each one's own thread for the group (`Thread.source:
 * 'group'`, one per bot and group, never the bot's current thread), with chat-core's `renderGroupPrompt` before it; a
 * member's reply is posted back to the room as its message (NO_REPLY posts nothing) and dispatched again, until
 * `GROUP_HOPS_MAX` bot messages follow the user's last, when AppuBot pauses the room with a note. Members take turns:
 * `GROUP_TURNS_AT_ONCE` of them answer at a time per room and the rest queue (`waiting`), so a `@everyone` to five bots
 * runs five agents one after another, never five at once; each one's prompt carries the room as it stands when its turn
 * comes. `working` on the group says who is taking a turn right now; `groups.stop` cancels them all and empties the queue.
 * Threads: a group has threads like a bot (`Group.chats`, `groups.newChat`/`useChat`); each keeps its own messages
 * (the first, whose id is the group's, in `<id>.json`, others in `<id>.<chatId>.json`) and each member answers each
 * thread in a thread of its own (`Thread.groupChatId`), so a new group thread starts every member afresh.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GROUP_GOAL_MESSAGES_DEFAULT, GROUP_HOPS_MAX, GROUP_MESSAGES_MAX, GROUP_TURNS_AT_ONCE, GroupMessageSchema, currentGroupChat, groupChatOf, groupChats, newId, type Goal, type Group, type GroupChat, type GroupAuthor, type GroupMessage, type Message, type MethodParams, type Thread } from '@appubot/protocol';
import { groupLead, groupPaused, groupPreview, groupRecipients, isNoReply, joinGroupMessages, mentionedBots, renderGroupPrompt, replyTextOf, type GroupBot } from '@appubot/chat-core';
import { permissionChoice, toOfferedMode } from '@appubot/agent-runtime';
import type { CoreCtx } from '../context';
import { JsonFile } from '../store';
import { errMsg, notFound, RpcError } from '../util';

/** how many of the room's latest messages a member sees with the one it answers */
const RECENT_FOR_PROMPT = 8;
/** how long a room with a goal on stays quiet before the lead is sent on */
const GROUP_NUDGE_MS = 2500;
/** messages a resumed group goal gets when it had used all of its own */
const GROUP_GOAL_MORE = 20;

/** a group thread's title from the user's first message in it */
function chatTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
}

interface Pending { groupId: string; chatId: string; botId: string; hop: number }
/** a member's turn on a room message, waiting its go */
interface Waiting { to: GroupBot; msg: GroupMessage }

export class GroupsService {
  private files = new Map<string, JsonFile<GroupMessage[]>>();
  /** the turns running for rooms, by the agent message that will carry the reply */
  private pending = new Map<string, Pending>();
  /** members waiting their turn, per room, in the order the messages came */
  private waiting = new Map<string, Waiting[]>();
  private off: (() => void)[] = [];

  constructor(private ctx: CoreCtx) {
    this.off.push(ctx.s.chat.onTurnCompleted((e) => {
      const p = this.pending.get(e.message.id);
      if (!p) return;
      this.pending.delete(e.message.id);
      try { this.replied(p, e.message, e.status); } catch (err) { this.ctx.log.warn('group reply failed', errMsg(err)); }
    }));
    // group threads made before they kept lastActiveAt 0: an older app would open one as its bot's chat
    for (const t of ctx.s.threads.list({ limit: 100_000 })) if (t.source === 'group' && t.lastActiveAt !== 0) ctx.s.threads.update(t.id, { lastActiveAt: 0 }, false);
    this.off.push(ctx.bus.on((ev) => {
      // a bot that is gone leaves its groups
      if (ev.event === 'bot.deleted') {
        const { id } = ev.payload as { id: string };
        for (const g of this.list()) if (g.botIds.includes(id)) this.save({ ...g, botIds: g.botIds.filter((b) => b !== id), ...(g.leadId === id ? { leadId: undefined } : {}), updatedAt: Date.now() });
        // its turns, running or waiting, go with it, so the rooms carry on
        const rooms = new Set<string>();
        for (const [k, p] of [...this.pending.entries()]) if (p.botId === id) { this.pending.delete(k); rooms.add(p.groupId); this.setWorking(p.groupId, id, false); }
        for (const [gid, queue] of this.waiting) {
          const left = queue.filter((w) => w.to.id !== id);
          if (left.length !== queue.length) { this.waiting.set(gid, left); rooms.add(gid); }
        }
        for (const gid of rooms) this.pump(gid);
      }
    }));
  }

  shutdown(): void {
    for (const t of this.nudges.values()) clearTimeout(t);
    this.nudges.clear();
    for (const f of this.off.splice(0)) f();
    for (const f of this.files.values()) f.flush();
  }

  /* ------------------------------------------------------------------ groups */

  list(): Group[] { return this.ctx.store.groups.get(); }

  require(id: string): Group {
    const g = this.list().find((x) => x.id === id);
    if (!g) throw notFound('Group', id);
    return g;
  }

  /** A group by id or name (case-insensitive), for a bot's tools. */
  find(ref: string): Group | undefined {
    const q = ref.trim().toLowerCase();
    return this.list().find((g) => g.id === ref) ?? this.list().find((g) => g.name.toLowerCase() === q);
  }

  private save(g: Group): Group {
    this.ctx.store.groups.update((l) => { const i = l.findIndex((x) => x.id === g.id); if (i < 0) l.push(g); else l[i] = g; });
    this.ctx.bus.emit('group.updated', g);
    return g;
  }

  private checkMembers(botIds: string[]): string[] {
    const ids = [...new Set(botIds)];
    for (const id of ids) this.ctx.s.bots.require(id);
    if (!ids.length) throw new RpcError('invalid_params', 'A group needs at least one bot');
    return ids;
  }

  create(p: MethodParams<'groups.create'>): Group {
    const name = p.name.trim();
    if (!name) throw new RpcError('invalid_params', 'A group needs a name');
    const botIds = this.checkMembers(p.botIds);
    if (p.leadId && !botIds.includes(p.leadId)) throw new RpcError('invalid_params', 'The lead must be one of the members');
    const now = Date.now();
    return this.save({ id: newId('grp'), name, botIds, ...(p.leadId ? { leadId: p.leadId } : {}), lastMessagePreview: '', working: [], workingIn: {}, chats: [], createdAt: now, updatedAt: now });
  }

  update(id: string, patch: MethodParams<'groups.update'>['patch']): Group {
    const g = this.require(id);
    const botIds = patch.botIds ? this.checkMembers(patch.botIds) : g.botIds;
    const leadId = patch.leadId === undefined ? g.leadId : patch.leadId || undefined;
    if (leadId && !botIds.includes(leadId)) throw new RpcError('invalid_params', 'The lead must be one of the members');
    const name = patch.name === undefined ? g.name : patch.name.trim();
    if (!name) throw new RpcError('invalid_params', 'A group needs a name');
    const next: Group = { ...g, name, botIds, leadId, updatedAt: Date.now() };
    if (!leadId) delete next.leadId;
    if (patch.pinned !== undefined) { if (patch.pinned) next.pinned = true; else delete next.pinned; }
    // the model every member answers on: another agent drops the model and effort picked for the last one
    if (patch.providerId === '') { delete next.providerId; delete next.modelId; delete next.effort; }
    else if (patch.providerId !== undefined) {
      if (!this.ctx.s.providers.list().some((p) => p.id === patch.providerId)) throw notFound('Agent', patch.providerId);
      if (patch.providerId !== g.providerId) { delete next.modelId; delete next.effort; }
      next.providerId = patch.providerId;
    }
    if (next.providerId) {
      if (patch.modelId !== undefined) { if (patch.modelId) next.modelId = patch.modelId; else delete next.modelId; }
      if (patch.effort !== undefined) { if (patch.effort) next.effort = patch.effort; else delete next.effort; }
    }
    // a bot that left keeps its thread for the group (history), but no longer works on it
    return this.save(next);
  }

  async delete(id: string): Promise<{ ok: true }> {
    const g = this.require(id);
    this.waiting.delete(id);
    await this.stop(id);
    for (const t of this.ctx.s.threads.list({ limit: 100_000 }).filter((t) => t.source === 'group' && t.groupId === id)) await this.ctx.s.threads.delete(t.id).catch(() => undefined);
    for (const c of groupChats(g)) {
      this.files.get(c.id)?.flush();
      this.files.delete(c.id);
      try { rmSync(this.path(g.id, c.id), { force: true }); } catch { /* ignore */ }
    }
    this.ctx.store.groups.update((l) => l.filter((x) => x.id !== g.id));
    this.ctx.bus.emit('group.removed', { id });
    return { ok: true };
  }

  /* ---------------------------------------------------------------- messages */

  private path(groupId: string, chatId: string): string { return join(this.ctx.paths.dataDir, 'groups', chatId === groupId ? `${groupId}.json` : `${groupId}.${chatId}.json`); }

  /** a thread's messages (its id: the group's for its first thread) */
  private file(groupId: string, chatId: string): JsonFile<GroupMessage[]> {
    let f = this.files.get(chatId);
    if (!f) {
      const dir = join(this.ctx.paths.dataDir, 'groups');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      f = new JsonFile<GroupMessage[]>(this.path(groupId, chatId), () => [], 300, this.ctx.log, (raw) => (Array.isArray(raw) ? raw : []).flatMap((m: unknown) => { const p = GroupMessageSchema.safeParse(m); return p.success ? [p.data] : []; }));
      this.files.set(chatId, f);
    }
    return f;
  }

  history(id: string, o: { chatId?: string; before?: number; limit?: number } = {}): { messages: GroupMessage[]; hasMore: boolean } {
    const g = this.require(id);
    const all = this.file(g.id, this.chatOf(g, o.chatId).id).get();
    const older = o.before === undefined ? all : all.filter((m) => m.createdAt < o.before!);
    const limit = o.limit ?? 100;
    const messages = older.slice(Math.max(0, older.length - limit));
    return { messages, hasMore: older.length > messages.length };
  }

  /** Who is in the room, for the rules and the words. */
  private members(g: Group): GroupBot[] {
    return g.botIds.map((id) => this.ctx.s.bots.get(id)).filter((b): b is NonNullable<typeof b> => !!b).map((b) => ({ id: b.id, name: b.name, chief: b.chief }));
  }

  /** The user posts to the room (`groups.send`). */
  send(p: MethodParams<'groups.send'>, via: 'desktop' | 'mobile' = 'desktop'): GroupMessage {
    this.ctx.s.appUpdate?.assertWorking();
    let g = this.require(p.id);
    const chat = this.chatOf(g, p.chatId);
    if (p.clientId) {
      const again = this.file(g.id, chat.id).get().find((m) => m.clientId === p.clientId);
      if (again) return again;
    }
    void via;
    // writing in a thread makes it the current one
    if (currentGroupChat(g).id !== chat.id) g = this.save({ ...g, chats: groupChats(g), currentChatId: chat.id });
    return this.post(g, chat.id, { kind: 'user' }, p.text, 0, p.clientId);
  }

  /** One of the group's threads by id (none: the current one). */
  private chatOf(g: Group, chatId: string | undefined): GroupChat {
    if (!chatId) return currentGroupChat(g);
    const c = groupChats(g).find((x) => x.id === chatId);
    if (!c) throw notFound('Group thread', chatId);
    return c;
  }

  /** A new thread in the group, made current (`groups.newChat`); the current one is reused while it has no messages. */
  newChat(id: string): Group {
    const g = this.require(id);
    const cur = currentGroupChat(g);
    if (!this.file(g.id, cur.id).get().length) return g;
    const now = Date.now();
    const chat: GroupChat = { id: newId('gc'), title: '', lastMessagePreview: '', createdAt: now, lastActiveAt: now };
    return this.save({ ...g, chats: [...groupChats(g), chat], currentChatId: chat.id, lastMessagePreview: '', lastActiveAt: now, updatedAt: now });
  }

  /** Make one of the group's threads current (`groups.useChat`). */
  useChat(id: string, chatId: string): Group {
    const g = this.require(id);
    const c = this.chatOf(g, chatId);
    return g.currentChatId === c.id ? g : this.save({ ...g, chats: groupChats(g), currentChatId: c.id });
  }

  /**
   * A room as another computer had it, into a group made here for it (`groups.restore`, a transfer): the first thread's
   * messages go into the group's own first thread, the others into new ones, kept as they were (no member is asked to
   * answer them). Only into a room nothing was posted to yet, so a second call (its answer lost on the way) is refused
   * with `conflict` instead of doubling it. The members' threads for the group there (`fromId`), which came with the
   * bots, are linked to this group and its threads, so each bot keeps its own side of the room.
   */
  restore(p: MethodParams<'groups.restore'>): Group {
    const g = this.require(p.id);
    if (groupChats(g).some((c) => this.file(g.id, c.id).get().length)) throw new RpcError('conflict', `${g.name} already has messages here`);
    const known = new Set(g.botIds);
    const now = Date.now();
    const chats: GroupChat[] = [];
    const chatIds = new Map<string, string>();
    p.chats.forEach((c, i) => {
      const id = i === 0 ? g.id : newId('gc');
      if (c.fromId) chatIds.set(c.fromId, id);
      const messages: GroupMessage[] = c.messages.slice(-GROUP_MESSAGES_MAX).map((m) => {
        // a bot that isn't a member here keeps its name only
        const from: GroupAuthor = m.from.kind === 'bot' && m.from.botId && !known.has(m.from.botId) ? { kind: 'bot', ...(m.from.name ? { name: m.from.name } : {}) } : m.from;
        return { id: newId('gm'), groupId: g.id, ...(id !== g.id ? { chatId: id } : {}), from, text: m.text, mentions: (m.mentions ?? []).filter((b) => known.has(b)), hop: m.hop ?? 0, createdAt: m.createdAt };
      });
      const last = messages[messages.length - 1];
      this.file(g.id, id).set(messages);
      chats.push({ id, title: c.title ?? '', lastMessagePreview: last ? groupPreview(last) : '', createdAt: c.createdAt, ...(last ? { lastActiveAt: last.createdAt } : {}) });
    });
    // the members' own threads for the group there came with the bots: they follow it here
    if (p.fromId) {
      if (!chatIds.has(p.fromId)) chatIds.set(p.fromId, g.id);
      for (const t of this.ctx.s.threads.list({ limit: 100_000 })) {
        if (t.source !== 'group' || t.groupId !== p.fromId || !known.has(t.botId)) continue;
        const to = chatIds.get(t.groupChatId ?? p.fromId);
        if (!to) continue;
        this.ctx.s.threads.update(t.id, { groupId: g.id, groupChatId: to !== g.id ? to : undefined }, false);
      }
    }
    const lastChat = chats[chats.length - 1]!;
    return this.save({ ...g, chats, currentChatId: lastChat.id, lastMessagePreview: lastChat.lastMessagePreview, ...(lastChat.lastActiveAt ? { lastActiveAt: lastChat.lastActiveAt } : {}), updatedAt: now });
  }

  /** A bot posts to a room it is in (`post_to_group`), from its own chat. */
  postAsBot(botId: string, ref: string, text: string): GroupMessage {
    const g = this.find(ref);
    if (!g) throw notFound('Group', ref);
    const bot = this.ctx.s.bots.require(botId);
    if (!g.botIds.includes(bot.id) && !bot.chief) throw new RpcError('forbidden', `${bot.name} isn't in the group ${g.name}`);
    return this.post(g, currentGroupChat(g).id, { kind: 'bot', botId: bot.id, name: bot.name }, text, 1);
  }

  /** AppuBot's own note in one of the room's threads. */
  private note(g: Group, chatId: string, text: string): GroupMessage { return this.post(g, chatId, { kind: 'system' }, text, 0); }

  /**
   * Append a message to the room, tell the apps, and give it to the members who answer it (each a quiet turn in its
   * own thread for the group). `hop`: how many bot messages since the user's last (a user's is 0).
   */
  private post(g: Group, chatId: string, from: GroupAuthor, text: string, hop: number, clientId?: string): GroupMessage {
    const members = this.members(g);
    const lead = groupLead(g, members);
    const mentions = mentionedBots(text, members);
    const msg: GroupMessage = { id: newId('gm'), groupId: g.id, ...(chatId !== g.id ? { chatId } : {}), from, text: text.trim(), mentions: mentions.map((b) => b.id), hop, ...(clientId ? { clientId } : {}), createdAt: Date.now() };
    const file = this.file(g.id, chatId);
    file.update((l) => { l.push(msg); if (l.length > GROUP_MESSAGES_MAX) l.splice(0, l.length - GROUP_MESSAGES_MAX); });
    this.ctx.bus.emit('group.message', msg);
    const current = this.require(g.id);
    const preview = groupPreview(msg);
    // a thread is titled by the user's first message in it
    const chats = groupChats(current).map((c) => (c.id === chatId ? { ...c, lastMessagePreview: preview, lastActiveAt: msg.createdAt, ...(!c.title && from.kind === 'user' ? { title: chatTitle(msg.text) } : {}) } : c));
    this.save({ ...current, chats, lastMessagePreview: preview, lastActiveAt: msg.createdAt, updatedAt: msg.createdAt });
    if (from.kind === 'system') return msg;
    // a bot reporting to the room with nobody named is news for the user: a notice, as a finished turn is
    // (not while the group works toward a goal on its own: then only its end is news)
    if (from.kind === 'bot' && !mentions.length && this.chatGoal(this.require(g.id), chatId)?.status !== 'active') {
      const bot = from.botId ? this.ctx.s.bots.get(from.botId) : undefined;
      this.ctx.s.notifications.notify({ title: `${g.name} · ${from.name ?? 'A bot'}`, body: msg.text.slice(0, 300), level: 'success', groupId: g.id, ...(bot ? { push: { kind: 'done', botId: bot.id, botName: bot.name, title: g.name, text: msg.text.slice(0, 300) } } : {}) });
    }
    // a goal on in this thread: the bots' messages count against its budget, and it, not the hop limit, ends the exchange
    let goalOn = false;
    if (from.kind === 'bot') {
      const goal = this.chatGoal(this.require(g.id), chatId);
      if (goal?.status === 'active') {
        const turns = goal.turns + 1;
        if (turns >= goal.maxTurns || (goal.until && Date.now() >= goal.until)) {
          this.pauseGoal(g.id, chatId, { ...goal, turns }, turns >= goal.maxTurns ? `used its ${goal.maxTurns} messages` : 'out of time');
          return msg;
        }
        this.setChatGoal(g.id, chatId, { ...goal, turns, updatedAt: Date.now() });
        goalOn = true;
      }
    } else if (from.kind === 'user') goalOn = this.chatGoal(this.require(g.id), chatId)?.status === 'active';
    const recipients = groupRecipients({ from, mentions, members, lead });
    if (!recipients.length) return msg;
    if (!goalOn && groupPaused(hop)) {
      this.note(this.require(g.id), chatId, `Paused: the bots have sent each other ${GROUP_HOPS_MAX} messages since you last wrote. Send a message to carry on.`);
      return msg;
    }
    const queue = this.waiting.get(g.id) ?? [];
    for (const b of recipients) queue.push({ to: b, msg });
    this.waiting.set(g.id, queue);
    this.pump(g.id);
    return msg;
  }

  /** How many of a room's members are taking a turn right now. */
  private running(groupId: string): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.groupId === groupId) n++;
    return n;
  }

  /** Start the next waiting turns, up to `GROUP_TURNS_AT_ONCE` at a time per room (a bot already on a turn waits for its own to end). */
  private pump(groupId: string): void {
    const queue = this.waiting.get(groupId);
    if (!queue?.length) return;
    while (queue.length && this.running(groupId) < GROUP_TURNS_AT_ONCE) {
      const g = this.list().find((x) => x.id === groupId);
      if (!g) { queue.length = 0; return; }
      const busy = new Set([...this.pending.values()].filter((p) => p.groupId === groupId).map((p) => p.botId));
      const i = queue.findIndex((w) => !busy.has(w.to.id));
      if (i < 0) return;
      const to = queue[i]!.to;
      // everything waiting for this bot goes in one turn (two members reporting back read as one)
      // (in the same thread: another thread's wait their own turn)
      const chatId = groupChatOf(queue[i]!.msg);
      const same = (w: Waiting) => w.to.id === to.id && groupChatOf(w.msg) === chatId;
      const mine = queue.filter(same).map((w) => w.msg);
      for (let k = queue.length - 1; k >= 0; k--) if (same(queue[k]!)) queue.splice(k, 1);
      if (!g.botIds.includes(to.id)) continue;
      const members = this.members(g);
      const lead = groupLead(g, members);
      // the room as it stands when the turn comes, the messages themselves left out
      const ids = new Set(mine.map((m) => m.id));
      const recent = this.file(g.id, chatId).get().filter((m) => !ids.has(m.id)).slice(-RECENT_FOR_PROMPT);
      // the turn holds its place while its thread is put on the group's model (an agent's answer can take a moment)
      const hold = `starting:${newId('gt')}`;
      this.pending.set(hold, { groupId: g.id, chatId, botId: to.id, hop: 0 });
      void this.dispatch(g, chatId, to, mine, members, lead, recent, hold).catch((e) => {
        this.pending.delete(hold);
        this.ctx.log.warn(`group ${g.name}: ${to.name} couldn't take the message`, errMsg(e));
        this.pump(g.id);
      });
    }
  }

  /** The agent, model and effort a member answers the group on: the group's pick when it has one, else the bot's own. */
  private choiceFor(g: Group, botId: string): { providerId: string; modelId: string; effort: string } {
    const bot = this.ctx.s.bots.require(botId);
    return g.providerId ? { providerId: g.providerId, modelId: g.modelId ?? '', effort: g.effort ?? bot.effort } : { providerId: bot.providerId, modelId: bot.modelId ?? '', effort: bot.effort };
  }

  /** The effort a member's group thread starts its agent with, when the group picks one (`ChatService.openSession`). */
  effortFor(thread: Thread): string | undefined {
    if (thread.source !== 'group' || !thread.groupId) return undefined;
    const g = this.list().find((x) => x.id === thread.groupId);
    return g?.providerId ? g.effort : undefined;
  }

  /**
   * Put a member's group thread on the agent, model and effort it should answer on before its turn: another agent
   * starts afresh (primed with its own turns), a model or effort is switched on the running agent.
   */
  private async fitThread(g: Group, botId: string, thread: Thread): Promise<void> {
    const want = this.choiceFor(g, botId);
    const chat = this.ctx.s.chat;
    if (thread.providerId !== want.providerId) {
      const bot = this.ctx.s.bots.require(botId);
      this.ctx.s.threads.update(thread.id, {
        providerId: want.providerId, acpSessionId: undefined, modelId: want.modelId || undefined, effortId: want.effort,
        modeId: toOfferedMode(want.providerId, permissionChoice(bot.providerId, bot.modeId)), modes: [], models: [], efforts: [],
      }, false);
      return;
    }
    if (want.modelId && thread.modelId !== want.modelId) await chat.inOrder(thread.id, () => chat.setModel(thread.id, want.modelId));
    const now = this.ctx.s.threads.require(thread.id);
    if (want.effort && now.effortId !== want.effort && (!now.efforts.length || now.efforts.some((e) => e.id === want.effort))) await chat.inOrder(thread.id, () => chat.setEffort(thread.id, want.effort));
  }

  /** The bot's thread for one of this group's threads: one per bot and group thread, made on the first message. */
  private threadFor(botId: string, g: Group, chatId: string): Thread {
    const found = this.ctx.s.threads.list({ limit: 100_000 }).find((t) => t.botId === botId && t.source === 'group' && t.groupId === g.id && (t.groupChatId ?? g.id) === chatId);
    return found ?? this.ctx.s.threads.create({ botId, source: 'group', groupId: g.id, ...(chatId !== g.id ? { groupChatId: chatId } : {}), title: `Group: ${g.name}` });
  }

  private async dispatch(g: Group, chatId: string, to: GroupBot, msgs: GroupMessage[], members: GroupBot[], lead: GroupBot | undefined, recent: GroupMessage[], hold: string): Promise<void> {
    const [msg, ...also] = msgs as [GroupMessage, ...GroupMessage[]];
    // a paused AppuBot computer answers a send at once with its own note, before this turn would be counted: the room
    // waits instead (a goal there pauses), and carries on when the user writes once it works again
    if (!this.ctx.s.system.cloudWorking()) {
      this.pending.delete(hold);
      const goal = this.chatGoal(this.require(g.id), chatId);
      if (goal?.status === 'active') this.setChatGoal(g.id, chatId, { ...goal, status: 'paused', note: 'This AppuBot computer is paused', updatedAt: Date.now() });
      this.waiting.delete(g.id);
      return;
    }
    const thread = this.threadFor(to.id, g, chatId);
    await this.fitThread(g, to.id, thread).catch((e) => this.ctx.log.warn(`group ${g.name}: putting ${to.name} on the group's model failed`, errMsg(e)));
    // stopped (or the group gone) meanwhile: nothing goes out
    if (!this.pending.delete(hold)) return;
    const goal = this.chatGoal(this.require(g.id), chatId);
    const preface = renderGroupPrompt({ group: g, you: to, members, lead, message: msg, also, recent, ...(goal?.status === 'active' ? { goal } : {}) });
    const hop = Math.max(...msgs.map((m) => m.hop));
    // one bot's message keeps its author on the stored message; several read as "Bo: … / Cy: …"
    const from = msgs.length === 1 && msg.from.kind === 'bot' && msg.from.botId ? { botId: msg.from.botId, name: msg.from.name ?? 'A bot' } : undefined;
    const via = msgs.every((m) => m.from.kind === 'bot') ? 'bot' : 'desktop';
    const r = this.ctx.s.chat.send({ threadId: thread.id, text: joinGroupMessages(msgs), attachments: [], images: [] }, via, { quiet: true, ...(from ? { from } : {}), preface, hop });
    this.pending.set(r.agentMessageId, { groupId: g.id, chatId, botId: to.id, hop });
    this.setWorking(g.id, to.id, true, chatId);
  }

  private setWorking(groupId: string, botId: string, on: boolean, chatId?: string): void {
    const g = this.list().find((x) => x.id === groupId);
    if (!g) return;
    const working = on ? [...new Set([...g.working, botId])] : g.working.filter((b) => b !== botId);
    const workingIn = { ...g.workingIn };
    if (on && chatId) workingIn[botId] = chatId; else delete workingIn[botId];
    if (working.length === g.working.length && working.every((b, i) => g.working[i] === b) && workingIn[botId] === g.workingIn[botId]) return;
    this.save({ ...g, working, workingIn });
  }

  /** A member's turn on a room message ended: its reply is the next room message (nothing for NO_REPLY or a cancel). */
  private replied(p: Pending, reply: Message, status: 'complete' | 'cancelled' | 'error'): void {
    this.setWorking(p.groupId, p.botId, false);
    const g = this.list().find((x) => x.id === p.groupId);
    if (!g) return;
    const bot = this.ctx.s.bots.get(p.botId);
    const name = bot?.name ?? 'A bot';
    try {
      if (status === 'cancelled') return;
      const text = replyTextOf(reply);
      if (status === 'error') { this.note(g, p.chatId, `${name} couldn't answer${reply.error ? `: ${reply.error}` : '.'}`); return; }
      if (isNoReply(text)) return;
      this.post(g, p.chatId, { kind: 'bot', botId: p.botId, name }, text, p.hop + 1);
    } finally {
      // the next member's turn; with a goal on and nothing left to do, the lead is sent on
      this.pump(p.groupId);
      this.nudgeLater(p.groupId, p.chatId);
    }
  }

  /* ------------------------------------------------------------------- goals */

  private chatGoal(g: Group, chatId: string): Goal | undefined { return groupChats(g).find((c) => c.id === chatId)?.goal; }

  private setChatGoal(groupId: string, chatId: string, goal: Goal | undefined): Group {
    const g = this.require(groupId);
    return this.save({ ...g, chats: groupChats(g).map((c) => (c.id === chatId ? { ...c, goal } : c)), updatedAt: Date.now() });
  }

  /** Whether anything still runs or waits in one of a group's threads. */
  private busyIn(groupId: string, chatId: string): boolean {
    for (const p of this.pending.values()) if (p.groupId === groupId && p.chatId === chatId) return true;
    return (this.waiting.get(groupId) ?? []).some((w) => groupChatOf(w.msg) === chatId);
  }

  /**
   * The group's own goal (the lead's \`start_goal\`): on from now in that thread, its budget the bots' messages. The
   * lead is sent on at once when the room is quiet.
   */
  startGoal(groupId: string, chatId: string, objective: string, maxTurns = GROUP_GOAL_MESSAGES_DEFAULT, hours?: number): Goal {
    const g = this.require(groupId);
    if (this.chatGoal(g, chatId)?.status === 'active') throw new RpcError('invalid_params', 'This group already has a goal on: call finish_goal first');
    const now = Date.now();
    const goal: Goal = { objective: objective.trim(), status: 'active', turns: 0, maxTurns, ...(hours ? { until: now + hours * 3_600_000 } : {}), startedAt: now, updatedAt: now };
    this.setChatGoal(groupId, chatId, goal);
    this.note(this.require(groupId), chatId, `Goal on: ${goal.objective}`);
    this.nudgeLater(groupId, chatId);
    return goal;
  }

  /** A member ends the group's goal (\`finish_goal\`): achieved, or the group needs the user. */
  finishGoal(groupId: string, chatId: string, status: 'done' | 'blocked', note: string): Goal {
    const g = this.require(groupId);
    const cur = this.chatGoal(g, chatId);
    if (!cur || (cur.status !== 'active' && cur.status !== 'paused')) throw new RpcError('invalid_params', 'No goal is on in this group');
    const goal: Goal = { ...cur, status, ...(note.trim() ? { note: note.trim() } : {}), updatedAt: Date.now() };
    this.setChatGoal(groupId, chatId, goal);
    this.note(this.require(groupId), chatId, status === 'done' ? `Goal done${goal.note ? `: ${goal.note}` : '.'}` : `Goal on hold: ${goal.note || 'the group needs you'}`);
    this.ctx.s.notifications.notify({
      title: status === 'done' ? `${g.name} reached its goal` : `${g.name} needs you for its goal`,
      body: (goal.note || goal.objective).slice(0, 300), groupId, level: status === 'done' ? 'success' : 'warning',
    });
    return goal;
  }

  /** The user's pause, resume, stop or clear on a group thread's goal (\`groups.goal\`). */
  async goalAct(groupId: string, chatId: string | undefined, action: 'pause' | 'resume' | 'stop' | 'clear'): Promise<Group> {
    const g = this.require(groupId);
    const cid = this.chatOf(g, chatId).id;
    const goal = this.chatGoal(g, cid);
    if (!goal) throw notFound('Goal', cid);
    const now = Date.now();
    switch (action) {
      case 'clear': return this.setChatGoal(groupId, cid, undefined);
      case 'pause': return this.setChatGoal(groupId, cid, { ...goal, status: 'paused', note: 'Paused by you', updatedAt: now });
      case 'stop': {
        const out = this.setChatGoal(groupId, cid, { ...goal, status: 'stopped', updatedAt: now });
        await this.stop(groupId);
        return this.require(groupId) ?? out;
      }
      case 'resume': {
        const maxTurns = goal.turns >= goal.maxTurns ? goal.turns + GROUP_GOAL_MORE : goal.maxTurns;
        const until = goal.until && goal.until <= now ? now + 3_600_000 : goal.until;
        const out = this.setChatGoal(groupId, cid, { ...goal, status: 'active', maxTurns, ...(until ? { until } : {}), note: undefined, updatedAt: now });
        this.nudgeLater(groupId, cid, 0);
        return out;
      }
    }
  }

  /** Out of messages or time: paused to resume, said in the room, and the user hears of it. */
  private pauseGoal(groupId: string, chatId: string, goal: Goal, why: string): void {
    this.setChatGoal(groupId, chatId, { ...goal, status: 'paused', note: why, updatedAt: Date.now() });
    const g = this.require(groupId);
    this.note(g, chatId, `Goal paused: it ${why}. Resume it to carry on.`);
    this.ctx.s.notifications.notify({ title: `${g.name} paused its goal`, body: `It ${why}. Resume it to keep going.`, groupId, level: 'info' });
  }

  private nudges = new Map<string, ReturnType<typeof setTimeout>>();

  /** With a goal on, a room gone quiet sends the lead on (\`GROUP_NUDGE_MS\` later, if still quiet then). */
  private nudgeLater(groupId: string, chatId: string, ms = GROUP_NUDGE_MS): void {
    const key = `${groupId}:${chatId}`;
    const old = this.nudges.get(key);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      this.nudges.delete(key);
      try { this.nudge(groupId, chatId); } catch (e) { this.ctx.log.warn('group goal nudge failed', errMsg(e)); }
    }, ms);
    t.unref?.();
    this.nudges.set(key, t);
  }

  private nudge(groupId: string, chatId: string): void {
    const g = this.list().find((x) => x.id === groupId);
    const goal = g && this.chatGoal(g, chatId);
    if (!g || goal?.status !== 'active' || this.busyIn(groupId, chatId)) return;
    const members = this.members(g);
    const to = groupLead(g, members) ?? members[0];
    if (!to) return;
    // the nudge counts as one of the goal's messages, so a lead that keeps answering NO_REPLY still runs out
    const turns = goal.turns + 1;
    if (turns >= goal.maxTurns || (goal.until && Date.now() >= goal.until)) { this.pauseGoal(groupId, chatId, { ...goal, turns }, turns >= goal.maxTurns ? `used its ${goal.maxTurns} messages` : 'out of time'); return; }
    this.setChatGoal(groupId, chatId, { ...goal, turns, updatedAt: Date.now() });
    const now = Date.now();
    const msg: GroupMessage = { id: newId('gm'), groupId, ...(chatId !== groupId ? { chatId } : {}), from: { kind: 'system' }, text: `The goal isn't done yet: ${goal.objective}\nWhat's the next step? Hand it out with @Name, or call finish_goal if it's done or you need the user.`, mentions: [to.id], hop: 0, createdAt: now };
    // only the lead reads this (it isn't posted to the room)
    const queue = this.waiting.get(groupId) ?? [];
    queue.push({ to, msg });
    this.waiting.set(groupId, queue);
    this.pump(groupId);
  }

  /** Stop every member's turn on the room (`groups.stop`); what was queued is dropped too. */
  async stop(id: string): Promise<{ ok: true }> {
    let g = this.require(id);
    // a goal running in the room is paused with it
    for (const c of groupChats(g)) if (c.goal?.status === 'active') g = this.setChatGoal(id, c.id, { ...c.goal, status: 'paused', note: 'Stopped by you', updatedAt: Date.now() });
    const queued = this.waiting.get(id)?.length ?? 0;
    this.waiting.delete(id);
    const mine = [...this.pending.entries()].filter(([, p]) => p.groupId === id);
    for (const [k] of mine) this.pending.delete(k);
    for (const t of this.ctx.s.threads.list({ limit: 100_000 }).filter((t) => t.source === 'group' && t.groupId === id)) {
      await this.ctx.s.chat.cancel(t.id).catch(() => undefined);
    }
    if (g.working.length) this.save({ ...g, working: [], workingIn: {} });
    const chatIds = [...new Set(mine.map(([, p]) => p.chatId))];
    if (mine.length || queued) for (const c of chatIds.length ? chatIds : [currentGroupChat(g).id]) this.note(this.require(id), c, 'Stopped.');
    return { ok: true };
  }

  /** Whether a thread is a bot's thread for a group (the apps show it with the group's name). */
  isGroupThread(t: Thread): boolean { return t.source === 'group'; }
}
