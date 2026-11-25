/**
 * Channels: Telegram bots (grammY long polling) → threads (one per chat), replies on completion. There can be several,
 * each its own token and @handle wired to one AppuBot bot (`TelegramRunner` per channel). A Telegram bot wears its
 * AppuBot bot's face: its name, its job as the description and its avatar as the profile photo, pushed when Telegram
 * connects and whenever that bot changes (only what changed since the last push, `StoredChannel.profile`).
 * A Telegram message goes to its bot's current chat (`threads.chatFor`), like a message from the app, and only the
 * turns Telegram started answer there (`telegramTurns`): what is asked from the app stays in the app.
 * A voice note is heard on this computer (`VoiceService.transcribe`): the bot gets its words and the message keeps
 * the recording (`chat.send` `voice`); its reply then goes back as a voice note too, with the text under it
 * (`settings.voice.telegramVoiceReplies`, /voice). A bot may also send a voice note itself mid-turn (`send_voice`,
 * `voiceSent`), whatever the user wrote with; then its reply isn't read aloud again.
 */
import type { Context as HonoContext } from 'hono';
import { ChannelSchema, newId, type Channel, type FileAttachment, type MethodParams, type MethodResult, type QuestionForm } from '@appubot/protocol';
import { TELEGRAM_FORM_FIELDS } from '@appubot/chat-core';
import type { AgentContext } from '../auth';
import type { CoreCtx } from '../context';
import type { StoredChannel } from '../store';
import { errMsg, RpcError } from '../util';
import { TelegramRunner } from './telegramRunner';
import { FIRST_TELEGRAM, START_RETRY_DELAYS_MS, type TelegramTurn, telegramAgent, telegramErrorText } from './telegramShared';
export { FIRST_TELEGRAM, TOKEN_ELSEWHERE, START_RETRY_DELAYS_MS, telegramErrorText, isTransientTelegramError, telegramAbout, photoKey } from './telegramShared';
export { TelegramRunner, speakable, mediaOf, describe, sendKind } from './telegramRunner';

export class ChannelsService {
  private runners = new Map<string, TelegramRunner>();
  /** agent message id → the Telegram chat that asked for it */
  private telegramTurns = new Map<string, TelegramTurn>();
  /** who hears of a webhook delivery on the cloud (CloudPresence: what woke the computer) */
  private webhookListeners = new Set<(channelId: string) => void>();

  constructor(private ctx: CoreCtx) {
    // the cloud computer's payment was sorted (or it is back after a stop): its Telegram bots listen again
    if (ctx.deps.cloud) ctx.s.system.onCloudState((info, prev) => { if (info.state === 'ok' && prev && prev.state !== 'ok') void this.resumeWebhooks(); });
    ctx.s.chat.onTurnCompleted((e) => {
      const t = this.telegramTurns.get(e.message.id);
      if (!t) return;
      this.telegramTurns.delete(e.message.id);
      void this.runners.get(t.runnerId)?.onCompleted(t, e).catch((err) => this.ctx.log.warn('telegram reply failed', errMsg(err)));
    });
    ctx.bus.on((ev) => {
      if (ev.event === 'question.asked') {
        const q = ev.payload as { threadId: string; questionId: string; question: string; options: string[]; form?: QuestionForm };
        const t = this.askingIn(q.threadId);
        if (t) void this.runners.get(t.runnerId)?.forwardQuestion(t.chatId, q);
      }
      if (ev.event === 'permission.requested') {
        const p = ev.payload as { id: string; threadId: string; title: string; options: { optionId: string; kind: string; name: string }[] };
        const t = this.askingIn(p.threadId);
        if (t) void this.runners.get(t.runnerId)?.forwardPermission(t.chatId, p);
      }
      if (ev.event === 'permission.resolved') {
        const id = (ev.payload as { id: string }).id;
        for (const r of this.runners.values()) r.permissionResolved(id);
      }
      if (ev.event === 'bot.updated' || ev.event === 'bot.deleted') {
        const id = (ev.payload as { id?: string }).id;
        for (const r of this.runners.values()) r.botChanged(id);
      }
    });
  }

  all(): StoredChannel[] { return this.ctx.store.channels.get(); }

  stored(id: string): StoredChannel | undefined { return this.all().find((c) => c.id === id); }

  save(id: string, patch: Partial<StoredChannel>, emit = true): StoredChannel {
    const prev = this.stored(id);
    if (!prev) throw new RpcError('not_found', 'No such Telegram bot');
    const next: StoredChannel = { ...prev, ...patch, id };
    this.ctx.store.channels.update((l) => l.map((c) => (c.id === id ? next : c)));
    if (emit) this.ctx.bus.emit('channel.updated', ChannelSchema.parse(next));
    return next;
  }

  list(): Channel[] { return this.all().map((c) => ChannelSchema.parse(c)); }

  private runner(id: string): TelegramRunner {
    let r = this.runners.get(id);
    if (!r) { r = new TelegramRunner(this.ctx, this, id); this.runners.set(id, r); }
    return r;
  }

  /** A message the bot sent on its own mid-turn (`send_message`): a turn Telegram started gets it there at once. */
  said(agentMessageId: string, text: string): void {
    const t = this.telegramTurns.get(agentMessageId);
    if (t) void this.runners.get(t.runnerId)?.sendText(t.chatId, text).catch((e) => this.ctx.log.warn('telegram message failed', errMsg(e)));
  }

  /** A file the bot sent mid-turn (`send_file`): a turn Telegram started gets it there at once. */
  fileSent(agentMessageId: string, file: FileAttachment): void {
    const t = this.telegramTurns.get(agentMessageId);
    if (!t) return;
    (t.sentFiles ??= new Set()).add(file.id);
    void this.runners.get(t.runnerId)?.sendFile(t.chatId, file).catch((e) => this.ctx.log.warn('telegram file failed', errMsg(e)));
  }

  /**
   * A voice message the bot sent mid-turn (`send_voice`, a `voice` part of `kind: 'reply'`): a turn Telegram started
   * gets it there at once as a voice note, `caption` under it, and no reading of its own reply at the end.
   */
  voiceSent(agentMessageId: string, file: FileAttachment, caption?: string): void {
    const t = this.telegramTurns.get(agentMessageId);
    if (!t) return;
    t.spoken = true;
    (t.sentFiles ??= new Set()).add(file.id);
    const runner = this.runners.get(t.runnerId);
    if (!runner) return;
    t.sending = (t.sending ?? Promise.resolve())
      .then(() => runner.sendFile(t.chatId, caption ? { ...file, caption } : file))
      .catch((e) => this.ctx.log.warn('telegram voice message failed', errMsg(e)));
  }

  /** a turn sent from Telegram: its reply goes back there */
  trackTurn(agentMessageId: string, t: TelegramTurn): void { this.telegramTurns.set(agentMessageId, t); }

  /** the Telegram chat waiting on a turn in this thread (the latest one, if several) */
  private askingIn(threadId: string): TelegramTurn | undefined {
    let found: TelegramTurn | undefined;
    for (const t of this.telegramTurns.values()) if (t.threadId === threadId) found = t;
    return found;
  }

  /** The bot this channel answers as: its own pick, else the first bot. */
  botIdOf(c: StoredChannel): string | undefined {
    return c.botId && this.ctx.s.bots.get(c.botId) ? c.botId : this.ctx.s.bots.list()[0]?.id;
  }

  add(p: MethodParams<'channels.add'>): Channel {
    if (p.botId) this.ctx.s.bots.require(p.botId);
    const taken = new Set(this.all().map((c) => c.botId).filter(Boolean));
    const botId = p.botId ?? this.ctx.s.bots.list().find((b) => !taken.has(b.id))?.id ?? this.ctx.s.bots.list()[0]?.id;
    const id = this.all().some((c) => c.id === FIRST_TELEGRAM) ? newId('tg') : FIRST_TELEGRAM;
    const c: StoredChannel = { id, enabled: false, status: 'stopped', allowedUsers: [], ...(botId ? { botId } : {}) };
    this.ctx.store.channels.update((l) => [...l, c]);
    const out = ChannelSchema.parse(c);
    this.ctx.bus.emit('channel.updated', out);
    return out;
  }

  async remove(id: string): Promise<{ ok: true }> {
    if (!this.stored(id)) throw new RpcError('not_found', 'No such Telegram bot');
    await this.runners.get(id)?.stop(false);
    this.runners.delete(id);
    this.ctx.store.channels.update((l) => l.filter((c) => c.id !== id));
    this.ctx.bus.emit('channel.removed', { id });
    return { ok: true };
  }

  async configure(p: MethodParams<'channels.configure'>): Promise<Channel> {
    // the settings page from before there could be several: the first channel, made on first use
    if (!this.stored(p.id) && p.id === FIRST_TELEGRAM) this.add({});
    if (!this.stored(p.id)) throw new RpcError('not_found', 'No such Telegram bot');
    if (p.botId) this.ctx.s.bots.require(p.botId);
    const patch: Partial<StoredChannel> = {};
    if (p.token !== undefined) {
      const token = p.token.trim() || undefined;
      // two channels polling one token would steal each other's messages
      if (token && this.all().some((c) => c.id !== p.id && c.token === token)) throw new RpcError('invalid_params', 'Another bot already uses this Telegram token');
      patch.token = token;
    }
    if (p.botId !== undefined) patch.botId = p.botId;
    if (p.enabled !== undefined) patch.enabled = p.enabled;
    if (p.allowedUsers !== undefined) patch.allowedUsers = p.allowedUsers;
    const c = this.save(p.id, patch);
    const r = this.runner(p.id);
    if (c.enabled && c.token) await r.start();
    else await r.stop();
    return ChannelSchema.parse(this.stored(p.id));
  }

  /**
   * A bot asks the user to connect a Telegram bot to it, on a card in its chat (`telegram_request`): the token is typed
   * in on the computer (the window, or an owner device; never a phone that may not, never the chat) into the bot's own
   * channel (made here when it has none), which starts at once; a token Telegram refuses keeps the card open with the
   * reason. The bot gets the channel (its @handle and pairing code) to tell the user how to reach it.
   */
  async request(a: AgentContext, p: MethodParams<'agent.telegram.request'>): Promise<MethodResult<'agent.telegram.request'>> {
    const bot = this.ctx.s.bots.require(a.botId);
    const own = () => this.all().find((c) => c.botId === bot.id);
    const running = own();
    if (running?.token && running.enabled && running.status === 'running') return { channel: ChannelSchema.parse(running), already: true };
    const form: QuestionForm = { kind: 'telegram', fields: TELEGRAM_FORM_FIELDS, telegram: { botName: bot.name, ...(p.reason?.trim() ? { reason: p.reason.trim() } : {}) } };
    let made: Channel | undefined;
    const o = await this.ctx.s.agentBridge.open(a, { question: `${bot.name} wants a Telegram bot of its own`, options: [], form }, p.timeoutSec ?? 900, async (sub) => {
      const token = typeof sub.values.token === 'string' ? sub.values.token.trim() : '';
      if (!token) throw new RpcError('invalid_params', 'Bot token: Required', { problems: { token: 'Required' } });
      if (sub.role !== 'owner') throw new RpcError('forbidden', 'The token is typed in on your computer: paste it on this card there.');
      if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new RpcError('invalid_params', 'Bot token: not a Telegram bot token (123456789:AAH…)', { problems: { token: 'Not a bot token' } });
      const c = own() ?? this.add({ botId: bot.id });
      const next = await this.configure({ id: c.id, token, enabled: true, botId: bot.id });
      if (next.status === 'error') {
        // the token didn't take: forget it so the card can be tried again, and say why
        await this.configure({ id: c.id, token: '', enabled: false });
        throw new RpcError('invalid_params', `Telegram didn't take this token: ${next.error ?? 'unknown error'}`, { problems: { token: 'Telegram refused it' } });
      }
      made = next;
      return { answer: `Connected${next.botUsername ? ` @${next.botUsername}` : ''}`, values: { connected: 'yes' } };
    });
    if (!o) return { channel: null };
    if (o.declined) return { channel: null, declined: true };
    return { channel: made ?? null };
  }

  /** every enabled channel with a token (none while "Only in the cloud" holds: `paused`) */
  async start(): Promise<void> {
    // this computer's Telegram bots stop while only the cloud is used, and start again as they were when it isn't
    this.offCloudOnly ??= this.ctx.s.cloudAccount?.onCloudOnlyChange((on) => {
      void (on ? this.stop() : this.start()).catch((e) => this.ctx.log.warn('telegram: following "only in the cloud" failed', errMsg(e)));
    }) ?? null;
    if (this.paused()) return;
    await Promise.all(this.all().filter((c) => c.enabled && c.token).map((c) => this.runner(c.id).start()));
  }

  private offCloudOnly: (() => void) | null = null;

  /** "Only in the cloud" holds on this computer (settings.cloudOnly): its Telegram bots don't listen; nothing about them is changed */
  paused(): boolean { return !!this.ctx.s.cloudAccount?.cloudOnly(); }

  async stop(markStopped = true): Promise<void> {
    await Promise.all([...this.runners.values()].map((r) => r.stop(markStopped)));
  }

  /** push the linked bot's face to one Telegram bot (all of them without an id) */
  async syncProfile(id?: string): Promise<void> {
    for (const r of this.runners.values()) if (!id || r.id === id) await r.syncProfile();
  }

  /* ------------------------------------------------------- AppuBot Cloud */

  /**
   * A Telegram update for channel `id` (the gateway's `/telegram/:id` on an AppuBot Cloud computer): handed to that
   * bot's webhook handler, which checks Telegram's secret token. 404 for a channel that isn't listening (Telegram
   * retries, and the update waits with it).
   */
  async webhook(id: string, c: HonoContext): Promise<Response> {
    const r = this.runners.get(id);
    const res = r ? await r.handleWebhook(c) : null;
    if (!res) return c.json({ error: 'Not found' }, 404);
    if (res.status < 400) for (const l of this.webhookListeners) { try { l(id); } catch (e) { this.ctx.log.warn('webhook listener failed', errMsg(e)); } }
    return res;
  }

  onWebhook(fn: (channelId: string) => void): () => void {
    this.webhookListeners.add(fn);
    return () => this.webhookListeners.delete(fn);
  }

  /**
   * The computer is about to stop (`/control/prepare`): every webhook is removed, keeping Telegram's pending updates,
   * so they wait for the next start instead of hitting a computer that is down. The runners stay as they are.
   */
  async pauseWebhooks(): Promise<void> {
    await Promise.all([...this.runners.values()].map((r) => r.pauseWebhook().catch((e) => this.ctx.log.warn(`telegram ${r.id}: removing the webhook failed`, errMsg(e)))));
  }

  /** The webhooks are set again (the computer is back, it started): the updates Telegram kept arrive. */
  async resumeWebhooks(): Promise<void> {
    await Promise.all([...this.runners.values()].map((r) => r.resumeWebhook().catch((e) => this.ctx.log.warn(`telegram ${r.id}: setting the webhook failed`, errMsg(e)))));
  }

  /** After a restore from sleep (or a start): each webhook is checked against Telegram and set again where it differs. */
  async recheckWebhooks(): Promise<void> {
    await Promise.all([...this.runners.values()].map((r) => r.recheckWebhook().catch((e) => this.ctx.log.warn(`telegram ${r.id}: checking the webhook failed`, errMsg(e)))));
  }

  /** the waits between a start that failed for a passing reason and the next try (tests shorten them) */
  retryDelays: number[] = START_RETRY_DELAYS_MS;

  /**
   * The computer is back (a sleep checkpoint restored on the cloud, a Mac's wake): the kept connections to Telegram
   * are dead, so they go; a bot that listens has its webhook checked (cloud); one that failed to start (the network
   * at the time, a passing Telegram error) is started again now rather than at its next scheduled try.
   */
  async afterWake(why: string): Promise<void> {
    telegramAgent.destroy();
    await Promise.all(this.all().filter((c) => c.enabled && c.token).map(async (c) => {
      const r = this.runner(c.id);
      try {
        if (r.listening) { if (this.ctx.deps.cloud) await r.recheckWebhook(); }
        else await r.start(true);
      } catch (e) { this.ctx.log.warn(`telegram ${c.id}: after ${why}`, telegramErrorText(e)); }
    }));
  }

  /** The channels that listen now (the control API's status). */
  listening(): string[] {
    return [...this.runners.values()].filter((r) => r.listening).map((r) => r.id);
  }
}
