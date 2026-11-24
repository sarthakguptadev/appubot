/**
 * Hand-offs in a bot's chat (chat-core handoff.ts, the owner's 2026-11-24 brief): "@Ledger check this invoice" in the
 * user's chat with Ada goes to Ledger instead of Ada. Ledger takes it the way it takes a message from another bot
 * (`message_bot`): as a turn in its own current chat, on its own agent, model, permissions and apps, with chat-core's
 * `renderHandoffPrompt` (where it comes from, the chat's latest messages) before it. Its answer is posted back into
 * Ada's chat as Ledger's message (`Message.from`): a streaming one from the moment the task is handed over (the
 * chat's working row, in Ledger's avatar), filled with the answer when the turn ends. Ada reads what it missed with
 * its next prompt (`contextFor`). A reply of Ada's that names another bot hands off the same way; that bot's answer
 * then goes back to Ada as a turn of its own (it asked), and an answer naming another bot goes on to it, until
 * `HANDOFF_HOPS_MAX` bot messages follow the user's last, when AppuBot stops with a note. The answer reaches the chat
 * however long the turn takes; one cut off by AppuBot stopping reads as stopped.
 */
import { newId, type Message, type Part, type Thread } from '@appubot/protocol';
import { HANDOFF_PAUSED_NOTE, handoffContext, handoffNext, renderHandoffBack, renderHandoffPrompt, replyTextOf, type GroupBot } from '@appubot/chat-core';
import type { CoreCtx } from '../context';
import type { FileRecord } from '../store';
import { errMsg } from '../util';
import type { TurnCompleted } from './chat';

/** the chat's messages the bot handed a task reads, and the chat's own bot looks back over for what it missed */
const LOOK_BACK = 30;

/** a hand-off on its way: the bot named is answering it in its own chat */
interface Pending {
  /** the chat the answer goes to, and the message of the bot named there that carries it */
  threadId: string;
  messageId: string;
  botId: string;
  /** the answer's hop: bot messages since the user's last, the answer included */
  hop: number;
  /** the chat's own bot handed it over (its answer goes back to it) */
  askedByChatBot: boolean;
}

/** A bot's chat with the user, where hand-offs happen (not a Telegram chat, a group's thread or a routine's). */
const isChat = (t: Thread | undefined): t is Thread => !!t && (t.source === 'desktop' || t.source === 'mobile');

export class HandoffService {
  /** hand-offs on their way, by the reply message in the named bot's chat that will carry the answer */
  private pending = new Map<string, Pending>();
  /** the chat's own bot carrying on after a hand-off, by the reply its turn will carry: that reply's hop */
  private carrying = new Map<string, number>();
  /** chats whose own bot carries on once every hand-off it waits on is answered: the hop its reply will be at */
  private back = new Map<string, number>();
  private off: () => void;

  constructor(private ctx: CoreCtx) {
    this.off = ctx.s.chat.onTurnCompleted((e) => {
      try {
        const p = this.pending.get(e.message.id);
        if (p) { this.pending.delete(e.message.id); this.answered(p, e); return; }
        this.replied(e);
      } catch (err) { this.ctx.log.warn('hand-off failed', errMsg(err)); }
    });
  }

  /** AppuBot stops: answers still on their way read as stopped (the turns that would carry them are stopping too). */
  shutdown(): void {
    this.off();
    for (const p of this.pending.values()) this.settle(p, [], 'cancelled');
    this.pending.clear();
  }

  private bots(): GroupBot[] { return this.ctx.s.bots.list().map((b) => ({ id: b.id, name: b.name, chief: b.chief })); }

  /**
   * The user's message in a bot's chat (`chat.send`, already stored): the other bots it names take it. Null when it
   * names none (the chat's own bot answers as always); else the message carrying the first answer, and whether the
   * chat's own bot answers too (named as well).
   */
  fromUser(thread: Thread, msg: Message, o: { images: { mimeType: string; data: string }[]; attachments: FileRecord[] }): { replyId: string; chatBot: boolean } | null {
    if (!isChat(thread) || !this.ctx.s.system.cloudWorking()) return null;
    const text = msg.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
    const step = handoffNext({ text, from: 'user', chatBotId: thread.botId, bots: this.bots(), hop: 0 });
    if (!step.to.length) return null;
    const ids = step.to.map((b) => this.handOff(thread, b, { from: 'user', text, hop: 1, askedByChatBot: false, before: msg.id, via: msg.via, images: o.images, attachments: o.attachments }));
    return { replyId: ids[0]!, chatBot: step.chatBot };
  }

  /**
   * What the chat's own bot missed of its chat since its last reply (the hand-offs, the answers), for the prompt of its
   * turn in `thread` (before `beforeId`, the message it answers, else everything so far but `skipId`); null: nothing.
   */
  contextFor(thread: Thread, o: { beforeId?: string; skipId?: string }): string | null {
    if (!isChat(thread)) return null;
    const all = this.ctx.s.threads.messages(thread.id, { limit: LOOK_BACK });
    const at = o.beforeId ? all.findIndex((m) => m.id === o.beforeId) : -1;
    const before = (at >= 0 ? all.slice(0, at) : all).filter((m) => m.id !== o.skipId);
    return handoffContext(before, { botName: this.ctx.s.bots.get(thread.botId)?.name ?? 'You' });
  }

  /**
   * Hand a task to `to`: a turn in its own current chat, with where it comes from and the chat's latest messages; the
   * message that will carry its answer goes into the chat now (streaming: the working row in its avatar). Returns that
   * message's id.
   */
  private handOff(thread: Thread, to: GroupBot, o: { from: 'user' | GroupBot; text: string; hop: number; askedByChatBot: boolean; before?: string; via?: Message['via']; images?: { mimeType: string; data: string }[]; attachments?: FileRecord[] }): string {
    const threads = this.ctx.s.threads;
    const chatBot = this.ctx.s.bots.require(thread.botId);
    const all = threads.messages(thread.id, { limit: LOOK_BACK });
    const at = o.before ? all.findIndex((m) => m.id === o.before) : all.length;
    const recent = all.slice(0, at < 0 ? all.length : at).filter((m) => m.status !== 'streaming');
    const now = Math.max(Date.now(), (all[all.length - 1]?.createdAt ?? 0) + 1);
    const reply: Message = { id: newId('msg'), threadId: thread.id, role: 'agent', parts: [], status: 'streaming', via: 'bot', from: { botId: to.id, name: to.name }, createdAt: now, updatedAt: now };
    threads.addMessage(reply);
    const p: Pending = { threadId: thread.id, messageId: reply.id, botId: to.id, hop: o.hop, askedByChatBot: o.askedByChatBot };
    try {
      const preface = renderHandoffPrompt({ you: to, chatBot: { id: chatBot.id, name: chatBot.name }, from: o.from, recent });
      const target = threads.chatFor(to.id);
      const fromBot = o.from === 'user' ? undefined : { botId: o.from.id, name: o.from.name };
      // the user's own words go as theirs (from this device or the phone), a bot's as a message from that bot
      const via = fromBot ? 'bot' : o.via === 'mobile' ? 'mobile' : 'desktop';
      const r = this.ctx.s.chat.send(
        { threadId: target.id, text: o.text, attachments: (o.attachments ?? []).map((a) => ({ id: a.id })), images: o.images ?? [] },
        via,
        { quiet: true, waits: true, preface, hop: o.hop - 1, ...(fromBot ? { from: fromBot } : {}) },
      );
      this.pending.set(r.agentMessageId, p);
    } catch (e) {
      this.settle(p, [{ type: 'text', text: `(couldn't hand it to ${to.name}: ${errMsg(e)})` }], 'complete');
    }
    return reply.id;
  }

  /** Fill the message that carries a hand-off's answer, and close it. */
  private settle(p: Pending, parts: Part[], status: 'complete' | 'cancelled'): Message | undefined {
    const threads = this.ctx.s.threads;
    const msg = threads.findMessage(p.threadId, p.messageId);
    if (!msg || msg.status !== 'streaming') return undefined;
    for (const part of parts) threads.appendPart(p.threadId, p.messageId, part);
    msg.status = status;
    if (status === 'cancelled') msg.stopReason = 'cancelled';
    msg.updatedAt = Date.now();
    threads.touchMessage(p.threadId);
    this.ctx.bus.emit('message.completed', { threadId: p.threadId, messageId: p.messageId, status, ...(status === 'cancelled' ? { stopReason: 'cancelled' } : {}) });
    threads.refreshPreview(p.threadId, msg);
    return msg;
  }

  /** The bot handed a task answered: its answer goes into the chat as its message, then on to whoever takes it next. */
  private answered(p: Pending, e: TurnCompleted): void {
    if (e.status === 'cancelled') { this.settle(p, [], 'cancelled'); this.carryOn(p.threadId); return; }
    // what it said (its text, the files and pictures it sent), never its tools
    const said = e.message.parts.filter((x) => (x.type === 'text' && x.text.trim()) || x.type === 'file' || x.type === 'image');
    const parts: Part[] = said.length ? said : [{ type: 'text', text: replyTextOf(e.message) || '(no answer)' }];
    const msg = this.settle(p, parts, 'complete');
    const thread = this.ctx.s.threads.get(p.threadId);
    const bot = this.ctx.s.bots.get(p.botId);
    if (!msg || !isChat(thread) || !bot) { this.carryOn(p.threadId); return; }
    const chatBot = this.ctx.s.bots.get(thread.botId);
    // news like any finished turn: a notice (the app skips it while that chat is on screen)
    this.ctx.s.notifications.notify({ title: chatBot ? `${bot.name} · ${chatBot.name}'s chat` : bot.name, body: (replyTextOf(msg) || 'Done').slice(0, 300), threadId: thread.id, level: 'success' });
    this.route(thread, { id: bot.id, name: bot.name }, replyTextOf(msg), p.hop, p.askedByChatBot);
  }

  /** A turn of the chat's own bot ended: a reply of its that names another bot hands off. */
  private replied(e: TurnCompleted): void {
    if (e.status !== 'complete' || e.message.role !== 'agent' || e.message.from) return;
    const carried = this.carrying.get(e.message.id);
    if (carried !== undefined) this.carrying.delete(e.message.id);
    // its answer to the user (or its turn carrying on after a hand-off), never a routine's run or another bot's message
    const hop = carried ?? (e.via === 'desktop' || e.via === 'mobile' ? 1 : undefined);
    if (hop === undefined) return;
    const thread = this.ctx.s.threads.get(e.threadId);
    if (!isChat(thread)) return;
    const bot = this.ctx.s.bots.get(thread.botId);
    if (bot) this.route(thread, { id: bot.id, name: bot.name }, replyTextOf(e.message), hop, false);
  }

  /** A bot's message in a chat (`hop` deep), passed on to the bots it names, or back to the chat's own bot. */
  private route(thread: Thread, from: GroupBot, text: string, hop: number, askedByChatBot: boolean): void {
    const step = handoffNext({ text, from: from.id, chatBotId: thread.botId, bots: this.bots(), hop, askedByChatBot });
    if (step.paused) { this.ctx.s.chat.appendPart(thread.id, { type: 'system', text: HANDOFF_PAUSED_NOTE, level: 'info' }); return; }
    for (const to of step.to) this.handOff(thread, to, { from, text, hop: hop + 1, askedByChatBot: from.id === thread.botId });
    if (step.chatBot) this.back.set(thread.id, Math.max(this.back.get(thread.id) ?? 0, hop + 1));
    this.carryOn(thread.id);
  }

  /**
   * The chat's own bot carries on (a turn of its own: the answers it missed come with it, `contextFor`), once every
   * hand-off it waits on in that chat is answered, so two answers make one turn.
   */
  private carryOn(threadId: string): void {
    const hop = this.back.get(threadId);
    if (hop === undefined || [...this.pending.values()].some((p) => p.threadId === threadId)) return;
    this.back.delete(threadId);
    const answers = this.ctx.s.threads.messages(threadId, { limit: LOOK_BACK }).filter((m) => m.role === 'agent' && m.from);
    const last = answers[answers.length - 1]?.from;
    try {
      const id = this.ctx.s.chat.ownTurn(threadId, renderHandoffBack({ from: { id: last?.botId ?? '', name: last?.name ?? 'Another bot' } }));
      this.carrying.set(id, hop);
    } catch (e) { this.ctx.log.warn('carrying on after a hand-off failed', errMsg(e)); }
  }
}

