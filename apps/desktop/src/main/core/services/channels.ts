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
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Agent as HttpsAgent } from 'node:https';
import { Bot as TgBot, GrammyError, HttpError, InputFile, InlineKeyboard, webhookCallback, type Context } from 'grammy';
import type { Context as HonoContext } from 'hono';
import type { Message as TgMessage } from 'grammy/types';
import { ChannelSchema, machineName, newId, VOICE_SPEAK_MAX_CHARS, type Bot, type Channel, type Thread, type FileAttachment, type MethodParams, type MethodResult, type Part, type QuestionForm } from '@appubot/protocol';
import { botAvatarSvg, botFigure, characterKey, escapeHtml as esc, htmlToPlain, TELEGRAM_FORM_FIELDS, telegramChunks, type CharacterFigure } from '@appubot/chat-core';
import type { AgentContext } from '../auth';
import type { CoreCtx } from '../context';
import type { StoredChannel, TelegramProfileSync } from '../store';
import { errMsg, RpcError } from '../util';
import type { TurnCompleted } from './chat';
import { agentMenu, agentName, chatsMenu, effortMenu, fastMenu, helpText, modeMenu, modelMenu, routinesMenu, statusText, TELEGRAM_COMMANDS, voiceMenu, type MenuKind, type MenuSpec } from './telegramCommands';

/** the id of the first Telegram channel (from before there could be several) */
export const FIRST_TELEGRAM = 'telegram';

/** What a Telegram bot whose token another AppuBot computer holds is told (the Mac finds the cloud's webhook, or the other way round). */
export const TOKEN_ELSEWHERE = 'This Telegram bot is connected to another AppuBot computer. Disconnect it there first, then connect it here.';
/** The cloud computer's Telegram bots wait for the backend to tell the computer its public address. */
const NO_PUBLIC_URL = 'Waiting for this computer’s AppuBot Cloud address.';
/** the updates a webhook is asked for: what the runner handles */
const WEBHOOK_UPDATES = ['message', 'callback_query'] as const;

const newCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

/**
 * One keep-alive connection pool to Telegram for every bot here. grammY keeps one of its own per process that nothing
 * can reach; this one is dropped by `ChannelsService.afterWake` (a sleep checkpoint restored on the cloud, a Mac's
 * wake), since the sockets it held are dead then and the first request on one fails ("socket hang up").
 */
const telegramAgent = new HttpsAgent({ keepAlive: true });
const TIMEOUT_TEXT = 'Telegram did not respond (timeout)';
/** a token as it appears in node-fetch's messages (`…/bot<token>/getMe failed…`) or on its own */
const TOKEN_IN_URL = /\/bot[^/\s]+/g;
const BARE_TOKEN = /\b\d{5,}:[A-Za-z0-9_-]{20,}/g;
/** the waits between a start that failed for a passing reason and the next try (then every last one) */
export const START_RETRY_DELAYS_MS = [15_000, 60_000, 300_000];
/** the waits before trying `getMe` again at once when the network failed (not a timeout) */
const GETME_RETRY_MS = [1000, 3000];

const scrubToken = (s: string): string => s.replace(TOKEN_IN_URL, '/bot…').replace(BARE_TOKEN, '<token>');

/**
 * What a failed Telegram call says, with its cause. grammY's `HttpError` ("Network request for 'getMe' failed!") hides
 * why: the fetch's own error (node-fetch's `code` and "reason", or undici's `cause`), or a `SyntaxError` when Telegram
 * answered something that isn't JSON (a gateway error page). Never a token: node-fetch's messages carry the URL.
 */
export function telegramErrorText(e: unknown): string {
  if (e instanceof HttpError) {
    const cause = e.error;
    let why = '';
    if (cause instanceof SyntaxError) why = 'Telegram answered something that isn’t JSON, likely an error page';
    else if (cause instanceof Error) {
      const c = cause as Error & { code?: unknown; cause?: { code?: unknown; message?: unknown } };
      const code = typeof c.code === 'string' ? c.code : typeof c.cause?.code === 'string' ? c.cause.code : '';
      const reason = /reason: ([\s\S]*)$/.exec(c.message)?.[1]?.trim() ?? (typeof c.cause?.message === 'string' ? c.cause.message : c.message);
      why = code && !reason.includes(code) ? `${code}: ${reason}` : reason;
    } else if (cause !== undefined && cause !== null) why = String(cause);
    return scrubToken(why ? `${e.message} (${why})` : e.message);
  }
  return scrubToken(errMsg(e));
}

/** A failure that may pass by itself: the network, a non-JSON answer, Telegram's 5xx or 429, our own timeout. */
export function isTransientTelegramError(e: unknown): boolean {
  if (e instanceof HttpError) return true;
  if (e instanceof GrammyError) return e.error_code === 429 || e.error_code >= 500;
  return e instanceof Error && e.message === TIMEOUT_TEXT;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Telegram's limits: name 64, description 512, short description ("about") 120 characters. */
const cut = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
/** What the Telegram bot's description says: the bot's job, or a line naming it. */
export const telegramAbout = (bot: Pick<Bot, 'name' | 'job'>): string => bot.job.replace(/\s+/g, ' ').trim() || `${bot.name}, your AppuBot.`;
/**
 * Changes when the avatar would look different (bump the version when the drawing does): the shape and colour, or the
 * character it wears (its id and a hash of its drawing) and the colour. v2: the flat avatar (chat-core `BOT_FLAT`,
 * 2026-11-11).
 */
export const photoKey = (bot: Pick<Bot, 'shape' | 'color' | 'characterId'>, figure?: CharacterFigure | null): string =>
  figure && bot.characterId ? `v2c:${bot.characterId}:${characterKey(figure)}:${bot.color.toLowerCase()}` : `v2:${bot.shape}:${bot.color.toLowerCase()}`;
const PHOTO_PX = 640;

/** A turn Telegram started: where its reply (and what it asks on the way) goes. */
interface TelegramTurn {
  runnerId: string;
  chatId: string;
  threadId: string;
  /** the Telegram message it answers (the reply quotes it) */
  replyTo?: number;
  /** files that went out mid-turn (`send_file`), not sent again with the reply */
  sentFiles?: Set<string>;
  /** it was asked by voice: the reply goes out as a voice note too (`settings.voice.telegramVoiceReplies`) */
  voice?: boolean;
  /** the bot sent a voice note itself (`send_voice`): no automatic one at the end */
  spoken?: boolean;
  /** what went out mid-turn and is still sending: the reply waits for it, so it lands after */
  sending?: Promise<void>;
}

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

/** One Telegram bot: its polling, its chats and the face it wears. */
export class TelegramRunner {
  private tg: TgBot | null = null;
  /** chatId → the question waiting for an answer there (and the message with its buttons) */
  private pendingQuestion = new Map<string, { id: string; options: string[]; messageId?: number }>();
  private pendingPermission = new Map<string, { id: string; title: string; allow?: string; deny?: string; messageId?: number }>();
  /** chatId → the timer keeping "typing…" up while a turn runs */
  private typing = new Map<string, ReturnType<typeof setInterval>>();
  /** `chatId:messageId` → a menu sent there: what its buttons (`k:<n>`) choose */
  private menus = new Map<string, { kind: MenuKind; values: string[] }>();
  /** an album being collected (`chatId:media_group_id`) */
  private albums = new Map<string, Inbox>();
  /** the running Telegram bot's own id (getMe) */
  private tgId: number | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing: Promise<void> = Promise.resolve();
  /** the bot the last sync was for */
  private syncedFor: string | undefined;
  /** chats told this run that voice messages need the speech model (once each) */
  private sttHinted = new Set<string>();
  /** the cloud's webhook: its secret (new on every start) and the handler Telegram's deliveries go to */
  private webhook: { secret: string; url: string; handler: (c: HonoContext) => Promise<Response>; paused: boolean } | null = null;
  /** starts run one after another (a retry behind the user's own start finds the bot up and does nothing) */
  private starting: Promise<void> = Promise.resolve();
  /** the next try after a start that failed for a passing reason, and how many there were since the user's start */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;

  constructor(private ctx: CoreCtx, private svc: ChannelsService, readonly id: string) {}

  /** The Telegram bot is up and taking updates (polling on a Mac, a set webhook on the cloud). */
  get listening(): boolean { return !!this.tg && (!this.webhook || !this.webhook.paused); }

  private stored(): StoredChannel {
    const c = this.svc.stored(this.id);
    if (!c) throw new RpcError('not_found', 'No such Telegram bot');
    return c;
  }

  private save(patch: Partial<StoredChannel>): StoredChannel { return this.svc.save(this.id, patch); }

  /** a bot changed (or went): the face follows on Telegram */
  botChanged(id: string | undefined): void {
    const linked = this.linkedBotId();
    if (this.tg && (linked !== this.syncedFor || id === linked)) this.scheduleSync(1500);
  }

  /**
   * Start the Telegram bot. `retry` marks a start of AppuBot's own (a scheduled try, a wake): it gives way to a bot
   * already up and keeps counting tries; the user's own start counts from the first again.
   */
  start(retry = false): Promise<void> {
    const run = this.starting.then(() => this.doStart(retry));
    this.starting = run.catch(() => undefined);
    return run;
  }

  private async doStart(retry: boolean): Promise<void> {
    if (retry && this.tg) return;
    if (!retry) this.retries = 0;
    await this.stop(false);
    const c = this.stored();
    if (!c.enabled || !c.token) return;
    // only in the cloud: not listening here until that stops holding (ChannelsService.start runs it again then)
    if (this.svc.paused()) { await this.stop(true); return; }
    // tests give the core a fetch of their own (`deps.fetch`): Telegram's API goes through it too
    const bot = new TgBot(c.token, { client: { baseFetchConfig: { agent: telegramAgent }, ...(this.ctx.deps.fetch ? { fetch: this.ctx.deps.fetch } : {}) } });
    try {
      const me = await this.getMe(bot);
      bot.botInfo = me; // so grammY's own start doesn't ask again
      this.tg = bot;
      bot.catch((err) => this.ctx.log.warn('telegram handler error', errMsg(err.error)));
      bot.on('message', (cx) => this.onMessage(cx).catch((e) => this.ctx.log.warn('telegram message failed', errMsg(e))));
      bot.on('callback_query:data', (cx) => this.onButton(cx).catch((e) => this.ctx.log.warn('telegram button failed', errMsg(e))));
      // the "/" menu next to the message field
      void bot.api.setMyCommands([...TELEGRAM_COMMANDS]).catch((e) => this.ctx.log.warn('telegram: setting the command menu failed', errMsg(e)));
      this.tgId = me.id;
      // the token in use on another AppuBot computer: a Mac finds the cloud's webhook, the cloud another's; neither
      // takes it over (polling would delete the webhook silently, and a second webhook would steal the updates)
      const info = await bot.api.getWebhookInfo();
      const cloud = this.ctx.deps.cloud;
      if (info.url && !(cloud && cloud.publicUrl && info.url.startsWith(this.webhookUrl(cloud.publicUrl)))) {
        this.ctx.log.warn(`telegram ${this.id}: the token has a webhook elsewhere (${info.url.replace(/\/telegram\/.*$/, '/…')})`);
        this.tg = null;
        this.tgId = null;
        this.save({ status: 'error', error: TOKEN_ELSEWHERE, botUsername: me.username });
        return;
      }
      this.save({ status: 'running', error: undefined, botUsername: me.username, pairingCode: newCode() });
      this.scheduleSync(0);
      if (cloud) {
        // the cloud: Telegram delivers to the public port, which wakes the computer; the secret proves each delivery
        if (!cloud.publicUrl) { this.save({ status: 'error', error: NO_PUBLIC_URL }); return; }
        const secret = randomBytes(24).toString('base64url');
        const url = this.webhookUrl(cloud.publicUrl);
        this.webhook = { secret, url, handler: webhookCallback(bot, 'hono', { secretToken: secret, timeoutMilliseconds: 25_000 }), paused: false };
        await bot.api.setWebhook(url, { secret_token: secret, allowed_updates: [...WEBHOOK_UPDATES], drop_pending_updates: false });
        return;
      }
      bot.start({ drop_pending_updates: false }).catch((e) => {
        if (this.tg !== bot) return;
        this.tg = null;
        this.failed('polling stopped', e);
      });
    } catch (e) {
      this.tg = null;
      this.webhook = null;
      this.failed('start failed', e);
    }
  }

  /**
   * `getMe`, the first call of a start, within 15 s. A network failure (never a timeout, nor an answer of Telegram's)
   * is tried again at once, twice: a connection cut as the request went out, a passing DNS miss.
   */
  private async getMe(bot: TgBot): Promise<Awaited<ReturnType<TgBot['api']['getMe']>>> {
    for (let attempt = 0; ; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          bot.api.getMe(),
          new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(TIMEOUT_TEXT)), 15_000); }),
        ]);
      } catch (e) {
        const wait = GETME_RETRY_MS[attempt];
        if (!(e instanceof HttpError) || wait === undefined) throw e;
        this.ctx.log.warn(`telegram ${this.id}: ${telegramErrorText(e)}; trying again in ${wait / 1000} s`);
        await sleep(wait);
      } finally { if (timer) clearTimeout(timer); }
    }
  }

  /**
   * The bot is down after a failure: the status says why (the cause, never the token). A reason that may pass (the
   * network, Telegram's 5xx or 429, a timeout) gets another start by itself, after `ChannelsService.retryDelays`.
   */
  private failed(what: string, e: unknown): void {
    const text = telegramErrorText(e);
    this.ctx.log.warn(`telegram ${this.id}: ${what}`, text);
    const again = isTransientTelegramError(e) && this.scheduleRetry();
    const c = this.svc.stored(this.id);
    if (c && c.enabled) this.save({ status: 'error', error: again ? `${text} AppuBot will try again.` : text });
  }

  /** The next start of AppuBot's own, unless the bot was switched off meanwhile. */
  private scheduleRetry(): boolean {
    const delays = this.svc.retryDelays;
    if (delays.length === 0) return false;
    const ms = delays[Math.min(this.retries, delays.length - 1)]!;
    this.retries += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const c = this.svc.stored(this.id);
      if (!c || !c.enabled || !c.token || this.tg) return;
      void this.start(true).catch((err) => this.ctx.log.warn(`telegram ${this.id}: retry failed`, telegramErrorText(err)));
    }, ms);
    this.retryTimer.unref?.();
    return true;
  }

  /** Where this channel's updates land on the cloud: `<public URL>/telegram/<channel id>`. */
  private webhookUrl(publicUrl: string): string { return `${publicUrl.replace(/\/+$/, '')}/telegram/${this.id}`; }

  /** A delivery from Telegram (the gateway's `/telegram/:id`); null when this bot isn't on a webhook. */
  async handleWebhook(c: HonoContext): Promise<Response | null> {
    const w = this.webhook;
    // paused (the computer is stopping): not taken, so Telegram keeps the update and tries again later
    if (!w || !this.tg || w.paused) return null;
    return w.handler(c);
  }

  /** The webhook is removed, Telegram keeping what it can't deliver (the computer is about to stop). */
  async pauseWebhook(): Promise<void> {
    const w = this.webhook;
    if (!w || !this.tg || w.paused) return;
    await this.tg.api.deleteWebhook({ drop_pending_updates: false });
    w.paused = true;
    this.ctx.log.info(`telegram ${this.id}: webhook removed until the computer is back`);
  }

  /** The webhook is set again (the same secret and handler), and the kept updates come. */
  async resumeWebhook(): Promise<void> {
    const w = this.webhook;
    if (!w || !this.tg || !w.paused) return;
    await this.tg.api.setWebhook(w.url, { secret_token: w.secret, allowed_updates: [...WEBHOOK_UPDATES], drop_pending_updates: false });
    w.paused = false;
    this.ctx.log.info(`telegram ${this.id}: webhook set again`);
  }

  /** The webhook as Telegram has it, set again when it isn't ours (a restore from sleep, a start). */
  async recheckWebhook(): Promise<void> {
    const w = this.webhook;
    if (!w || !this.tg || w.paused) return;
    const info = await this.tg.api.getWebhookInfo();
    if (info.url === w.url) return;
    if (info.url) { this.ctx.log.warn(`telegram ${this.id}: the webhook now points elsewhere; not taking it back`); this.save({ status: 'error', error: TOKEN_ELSEWHERE }); return; }
    await this.tg.api.setWebhook(w.url, { secret_token: w.secret, allowed_updates: [...WEBHOOK_UPDATES], drop_pending_updates: false });
    this.ctx.log.info(`telegram ${this.id}: webhook was gone; set again`);
  }

  async stop(markStopped = true): Promise<void> {
    const bot = this.tg;
    const webhook = this.webhook;
    this.tg = null;
    this.tgId = null;
    this.webhook = null;
    if (this.syncTimer) { clearTimeout(this.syncTimer); this.syncTimer = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    for (const chatId of [...this.typing.keys()]) this.stopTyping(chatId);
    for (const a of this.albums.values()) if (a.timer) clearTimeout(a.timer);
    this.albums.clear();
    // on the cloud a disconnected or switched-off bot gives its webhook up; a mere restart of this process keeps it
    // (Telegram's deliveries wait, and wake the computer, for when it is back)
    if (bot && webhook) { if (markStopped && !webhook.paused) { try { await bot.api.deleteWebhook({ drop_pending_updates: false }); } catch { /* ignore */ } } }
    else if (bot) { try { await bot.stop(); } catch { /* ignore */ } }
    const c = this.svc.stored(this.id);
    if (markStopped && c && c.status !== 'stopped') this.save({ status: 'stopped', error: undefined });
  }

  /** The bot this Telegram bot talks to, if any. */
  private linkedBotId(): string | undefined {
    const c = this.svc.stored(this.id);
    return c ? this.svc.botIdOf(c) : undefined;
  }

  private scheduleSync(ms: number): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.syncing = this.syncing.then(() => this.syncProfile()).catch((e) => this.ctx.log.warn('telegram profile sync failed', errMsg(e)));
    }, ms);
    this.syncTimer.unref?.();
  }

  /**
   * Push the linked bot's name, description and avatar to the Telegram bot, each only when it differs from what was
   * pushed last. A step that fails is retried at the next sync (Telegram's rate limit: after the wait it asks for).
   */
  async syncProfile(): Promise<void> {
    const tg = this.tg;
    const tgId = this.tgId;
    const botId = this.linkedBotId();
    const bot = botId ? this.ctx.s.bots.get(botId) : undefined;
    if (!tg || tgId === null || !bot) return;
    this.syncedFor = bot.id;
    const prev = this.stored().profile;
    const done: TelegramProfileSync = prev?.tgId === tgId ? { ...prev } : { tgId };
    let retryIn = 0;
    const step = async (what: string, fn: () => Promise<unknown>): Promise<boolean> => {
      try { await fn(); return true; } catch (e) {
        const wait = e instanceof GrammyError ? e.parameters.retry_after : undefined;
        if (wait) retryIn = Math.max(retryIn, Math.min(wait, 3600) * 1000 + 1000);
        this.ctx.log.warn(`telegram: setting the bot's ${what} failed`, telegramErrorText(e));
        return false;
      }
    };
    const name = cut(bot.name, 64);
    if (done.name !== name && await step('name', () => tg.api.setMyName(name))) done.name = name;
    const about = telegramAbout(bot);
    if (done.about !== about && await step('description', async () => {
      await tg.api.setMyDescription(cut(about, 512));
      await tg.api.setMyShortDescription(cut(about, 120));
    })) done.about = about;
    const figure = botFigure(bot, this.ctx.s.characters.list());
    const photo = photoKey(bot, typeof figure === 'object' ? figure : null);
    const draw = this.ctx.deps.svgToJpeg;
    if (done.photo !== photo && draw && await step('photo', async () => {
      const jpeg = await draw(botAvatarSvg(figure, bot.color, PHOTO_PX), PHOTO_PX);
      await tg.api.setMyProfilePhoto({ type: 'static', photo: new InputFile(jpeg, 'avatar.jpg') });
    })) done.photo = photo;
    // still the same Telegram bot: keep what went through (no event: the app never shows this)
    if (this.tgId === tgId && this.svc.stored(this.id)) this.svc.save(this.id, { profile: done }, false);
    if (retryIn && this.tg === tg) this.scheduleSync(retryIn);
  }

  private botId(): string {
    const id = this.linkedBotId();
    if (!id) throw new RpcError('not_found', 'No bot available for Telegram');
    return id;
  }

  /** Telegram talks in the bot's current chat, the same one the apps show */
  private threadFor(): string {
    return this.ctx.s.threads.chatFor(this.botId()).id;
  }

  private thread(): Thread { return this.ctx.s.threads.require(this.threadFor()); }

  /** One of the "/" menu's commands; false for anything else (an agent's own commands reach it as a message). */
  private async command(cmd: string, arg: string, cx: Context, chatId: string): Promise<boolean> {
    if (cmd !== 'start' && !TELEGRAM_COMMANDS.some((c) => c.command === cmd)) return false;
    const s = this.ctx.s;
    const bot = s.bots.require(this.botId());
    // Telegram HTML: anything of the user's is escaped
    const say = (html: string) => cx.reply(html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    if (cmd === 'start' || cmd === 'help') { await say(helpText(bot)); return true; }
    // a stopped version (the version policy) changes nothing
    const stopped = s.appUpdate.stopped;
    if (stopped) { await cx.reply(`⚠️ ${stopped.message}`); return true; }
    const choices = (t: Thread) => s.providers.choices(t.providerId).catch(() => ({ models: [], efforts: [], modes: [] }));
    switch (cmd) {
      case 'new': s.chat.startThread(bot.id); await say('✨ <b>New chat started.</b> What should we do?'); break;
      case 'stop': this.stopTyping(chatId); await s.chat.cancel(this.threadFor()); await say('⏹ <b>Stopped.</b>'); break;
      case 'status': await say(statusText(bot, this.thread(), s.providers.list())); break;
      case 'chats': await this.sendMenu(chatId, chatsMenu(this.thread(), s.threads.conversationThreads(bot.id))); break;
      case 'model': {
        // a chat whose agent hasn't started yet: the lists that agent gave before
        const t = this.thread();
        await this.sendMenu(chatId, modelMenu(t, t.models.length ? t.models : (await choices(t)).models));
        break;
      }
      case 'effort': {
        const t = this.thread();
        await this.sendMenu(chatId, effortMenu(t, t.models.length ? t.efforts : (await choices(t)).efforts));
        break;
      }
      case 'fast': {
        const menu = fastMenu(this.thread());
        if (menu) await this.sendMenu(chatId, menu);
        else await say(`⚡ Fast mode is only offered by Claude Code, and ${esc(bot.name)} runs on <b>${esc(agentName(bot.providerId, s.providers.list()))}</b>.`);
        break;
      }
      case 'mode': {
        const t = this.thread();
        await this.sendMenu(chatId, modeMenu(t, t.modes.length ? t.modes : (await choices(t)).modes));
        break;
      }
      case 'agent': await this.sendMenu(chatId, agentMenu(bot, s.providers.list())); break;
      case 'voice': {
        const want = arg.toLowerCase();
        if (want === 'on' || want === 'off') await say(`✅ ${esc(this.setVoiceReplies(want === 'on'))}`);
        else await this.sendMenu(chatId, voiceMenu(s.settings.get().voice.telegramVoiceReplies, { stt: s.voice.ready('stt'), tts: s.voice.ready('tts') }, machineName(process.platform)));
        break;
      }
      case 'memory': {
        const memory = s.bots.getMemory(bot.id).memory.trim();
        if (!memory) { await say(`🧠 ${esc(bot.name)} hasn't saved anything to remember yet.`); break; }
        await this.sendText(chatId, memory.length > MEMORY_SHOWN ? `${memory.slice(0, MEMORY_SHOWN)}\n\n…the rest is in the app (the bot's Memory panel).` : memory);
        break;
      }
      case 'routines': await this.sendMenu(chatId, routinesMenu(bot, s.routines.list())); break;
      case 'rename': {
        if (!arg) { await say('Send the new name with it, like: <code>/rename Trip plans</code>'); break; }
        const t = s.threads.rename(this.threadFor(), arg);
        await say(`✏️ Renamed this chat to <b>${esc(t.title)}</b>.`);
        break;
      }
    }
    return true;
  }

  /** A menu as a message with a button per choice; the buttons carry only their index (`k:<n>`). */
  private async sendMenu(chatId: string, m: MenuSpec): Promise<void> {
    const api = this.tg?.api;
    if (!api) return;
    if (!m.options.length) { await api.sendMessage(chatId, m.text, { parse_mode: 'HTML' }); return; }
    const kb = new InlineKeyboard();
    m.options.forEach((o, i) => { kb.text(o.label, `k:${i}`); if ((i + 1) % m.perRow === 0) kb.row(); });
    const sent = await api.sendMessage(chatId, m.text, { parse_mode: 'HTML', reply_markup: kb });
    this.menus.set(`${chatId}:${sent.message_id}`, { kind: m.kind, values: m.options.map((o) => o.value) });
    if (this.menus.size > MENUS_KEPT) this.menus.delete(this.menus.keys().next().value!);
  }

  /** A tap on a menu's button: the choice is made and the menu turns into what was done. */
  private async onMenu(cx: Context, chatId: string, n: number): Promise<void> {
    const messageId = cx.callbackQuery?.message?.message_id;
    const key = `${chatId}:${messageId}`;
    const menu = messageId ? this.menus.get(key) : undefined;
    const value = menu?.values[n];
    if (!menu || value === undefined) {
      await cx.answerCallbackQuery({ text: 'This menu has expired: send the command again.' });
      await this.clearButtons(chatId, messageId);
      return;
    }
    const stopped = this.ctx.s.appUpdate.stopped;
    if (stopped) { await cx.answerCallbackQuery({ text: stopped.message.slice(0, 190) }); return; }
    let done: string;
    try {
      done = await this.pick(menu.kind, value);
    } catch (e) {
      await cx.answerCallbackQuery({ text: errMsg(e).slice(0, 190) });
      return;
    }
    this.menus.delete(key);
    await cx.answerCallbackQuery({ text: done.slice(0, 190) });
    if (this.tg && messageId) await this.tg.api.editMessageText(chatId, messageId, `✅ ${done}`).catch(() => undefined);
  }

  /** Makes a menu's choice, the same way the app does; what was done, in words. */
  private async pick(kind: MenuKind, value: string): Promise<string> {
    const s = this.ctx.s;
    const bot = s.bots.require(this.botId());
    switch (kind) {
      case 'chat': {
        const t = s.chat.useThread(value);
        return `Back in "${t.title}". Your next message continues it.`;
      }
      case 'model': {
        const t = await s.chat.setModel(this.threadFor(), value);
        return `Model: ${t.models.find((m) => m.id === t.modelId)?.name ?? t.modelId ?? value}`;
      }
      case 'effort': {
        // the bot keeps the pick, like the app's picker (threads.setEffort)
        const t = await s.chat.setEffort(this.threadFor(), value);
        if (bot.effort !== value) s.bots.update(bot.id, { effort: value });
        return `Effort: ${t.efforts.find((e) => e.id === t.effortId)?.name ?? value}`;
      }
      case 'fast': {
        const on = value === 'on';
        const t = await s.chat.setFast(this.threadFor(), on);
        if (bot.fast !== on) s.bots.update(bot.id, { fast: on });
        return `Fast mode ${on ? 'on' : 'off'}${on && !t.fastAvailable ? " (this model doesn't offer it: it applies once you pick one that does)" : ''}`;
      }
      case 'mode': {
        const t = await s.chat.setMode(this.threadFor(), value);
        return `Permissions: ${t.modes.find((m) => m.id === t.modeId)?.name ?? value}`;
      }
      case 'agent': {
        const name = agentName(value, s.providers.list());
        if (value === bot.providerId) return `${bot.name} already runs on ${name}.`;
        s.bots.update(bot.id, { providerId: value });
        return `${bot.name} now runs on ${name}. /model picks its model.`;
      }
      case 'voice': return this.setVoiceReplies(value === 'on');
      case 'routine': {
        const at = value.indexOf(':');
        const op = value.slice(0, at);
        const r = s.routines.list().find((x) => x.id === value.slice(at + 1));
        if (!r) throw new RpcError('not_found', 'That routine is gone.');
        if (op === 'run') { await s.routines.run(r.id); return `Running "${r.name}" now: its result shows in the app.`; }
        s.routines.update(r.id, { enabled: op === 'on' });
        return `${op === 'on' ? 'Resumed' : 'Paused'} "${r.name}".`;
      }
    }
  }

  /** `settings.voice.telegramVoiceReplies` (every Telegram bot's), and what was done in words */
  private setVoiceReplies(on: boolean): string {
    const s = this.ctx.s;
    const voice = s.settings.get().voice;
    if (voice.telegramVoiceReplies !== on) s.settings.update({ voice: { ...voice, telegramVoiceReplies: on } });
    if (!on) return 'Voice replies off: voice messages get their answer as text.';
    return `Voice replies on: a voice message gets its answer as a voice note too${s.voice.ready('tts') ? '' : ` (once the voice model is downloaded in AppuBot on your ${machineName(process.platform)}: Settings → Voice)`}.`;
  }

  private async onMessage(cx: Context): Promise<void> {
    const m = cx.message;
    if (!m || !cx.from || !cx.chat) return;
    const userId = String(cx.from.id);
    const chatId = String(cx.chat.id);
    const text = (m.text ?? m.caption ?? '').trim();
    const c = this.stored();
    if (!c.allowedUsers.includes(userId)) {
      const pm = /^\/pair\s+(\d{6})$/.exec(text);
      if (pm && c.pairingCode && pm[1] === c.pairingCode) {
        this.save({ allowedUsers: [...c.allowedUsers, userId], pairingCode: newCode() });
        await cx.reply('Paired ✅ You can now talk to your AppuBot here. Type / to see what you can do.');
        const name = this.ctx.s.bots.get(this.linkedBotId() ?? '')?.name ?? 'your bot';
        this.ctx.s.notifications.notify({ title: 'Telegram paired', body: `${cx.from.first_name ?? 'A user'} can now message ${name}${c.botUsername ? ` (@${c.botUsername})` : ''}.`, level: 'success' });
      } else {
        await cx.reply(`This AppuBot is private. Open AppuBot on your ${machineName(process.platform)} → Settings → Channels → Telegram, then send:\n/pair <code>`);
      }
      return;
    }
    // commands may carry the bot's handle in groups (/new@MyBot)
    const cmd = /^\/([a-z]+)(?:@\w+)?(?:\s|$)/i.exec(text)?.[1]?.toLowerCase();
    if (cmd && await this.command(cmd, text.replace(/^\S+\s*/, '').trim(), cx, chatId)) return;

    const perm = this.pendingPermission.get(chatId);
    if (perm && (cmd === 'allow' || cmd === 'deny')) { await this.answerPermission(chatId, cmd === 'allow'); return; }
    const q = this.pendingQuestion.get(chatId);
    if (q && text && !hasMedia(m)) {
      this.pendingQuestion.delete(chatId);
      await this.clearButtons(chatId, q.messageId);
      try { this.ctx.s.agentBridge.answer(q.id, text); return; } catch { /* question expired: treat as a new message */ }
    }

    // an album arrives as one message per photo or file: they go to the bot together
    const group = m.media_group_id ? `${chatId}:${m.media_group_id}` : undefined;
    let inbox = group ? this.albums.get(group) : undefined;
    if (!inbox) {
      inbox = { chatId, replyTo: m.message_id, texts: [], attachments: [], notes: [], downloads: [], timer: null };
      if (group) this.albums.set(group, inbox);
    }
    const into = inbox;
    // a voice note is heard here when the speech model is: the bot gets its words, not the "(A voice message)" line
    const voice = m.voice;
    const hear = !!voice && this.ctx.s.voice.ready('stt');
    // a computer that only reads aloud has no speech model to point at: the note goes to the bot as the file it is
    if (voice && !hear && this.ctx.s.voice.hears()) await this.hintSpeechModel(chatId);
    const said = describe(m, { voice: !hear });
    if (said) into.texts.push(said);
    const threadId = this.threadFor();
    for (const f of mediaOf(m)) {
      if ((f.size ?? 0) > TG_DOWNLOAD_MAX) { into.notes.push(`${f.name} is too big for a bot to fetch from Telegram (20 MB at most). Send it in the AppuBot app instead, or as a link.`); continue; }
      const heard = hear && f.fileId === voice!.file_id;
      into.downloads.push(this.download(f, threadId).then((id) => (heard ? this.transcribe(into, id, voice!.duration) : void into.attachments.push(id)), (e) => {
        this.ctx.log.warn('telegram download failed', errMsg(e));
        into.notes.push(`Couldn't fetch ${f.name} from Telegram (${errMsg(e)}).`);
      }));
    }
    if (!group) { await this.deliver(into, threadId); return; }
    if (into.timer) clearTimeout(into.timer);
    into.timer = setTimeout(() => {
      this.albums.delete(group);
      void this.deliver(into, this.threadFor()).catch((e) => this.ctx.log.warn('telegram message failed', errMsg(e)));
    }, ALBUM_WAIT_MS);
  }

  /** Once per chat and run: voice messages reach the bot only as recordings until the speech model is downloaded. */
  private async hintSpeechModel(chatId: string): Promise<void> {
    if (this.sttHinted.has(chatId) || !this.tg) return;
    this.sttHinted.add(chatId);
    await this.tg.api.sendMessage(chatId, `🎙 To have your voice messages understood, open AppuBot on your ${machineName(process.platform)} → Settings → Voice and download the speech model.`).catch(() => undefined);
  }

  /**
   * A downloaded voice note to words, into the inbox (`voice`: the message keeps the recording, the bot gets the
   * text). If it can't be heard, it goes to the bot as the file it is, with a note, as before the speech model.
   */
  private async transcribe(into: Inbox, fileId: string, seconds: number): Promise<void> {
    const rec = this.ctx.s.files.getRecord(fileId);
    // "typing…" while it listens; the turn keeps it up after
    this.startTyping(into.chatId);
    try {
      if (!rec) throw new Error('the file is gone');
      const { text } = await this.ctx.s.voice.transcribe({ audio: await readFile(rec.storedPath), format: 'ogg' });
      into.voice = { recordingId: fileId, durationMs: seconds * 1000, text: text.trim() };
    } catch (e) {
      this.ctx.log.warn('telegram: transcribing a voice message failed', errMsg(e));
      into.attachments.push(fileId);
      into.texts.push(`(A voice message, ${seconds}s)`);
      into.notes.push(`Couldn't understand the voice message (${errMsg(e)}).`);
    }
  }

  /** One Telegram file into AppuBot's files (and the bot's inbox), by id. */
  private async download(f: TgMedia, threadId: string): Promise<string> {
    const tg = this.tg;
    const token = this.stored().token;
    if (!tg || !token) throw new Error('Telegram is not connected');
    const file = await tg.api.getFile(f.fileId);
    if (!file.file_path) throw new Error('Telegram gave no file');
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    // Telegram knows the type better than the name for photos and voice notes; a file's own name keeps its extension
    const name = /\.[a-z0-9]{1,6}$/i.test(f.name) ? f.name : `${f.name}${extOf(file.file_path, f.mime)}`;
    return this.ctx.s.files.upload(new Uint8Array(await res.arrayBuffer()), name, f.mime, threadId).id;
  }

  private async deliver(inbox: Inbox, threadId: string): Promise<void> {
    await Promise.all(inbox.downloads);
    const api = this.tg?.api;
    const quote = { reply_parameters: { message_id: inbox.replyTo, allow_sending_without_reply: true } };
    if (inbox.notes.length && api) await api.sendMessage(inbox.chatId, inbox.notes.map((n) => `⚠️ ${n}`).join('\n'), quote).catch(() => undefined);
    const voice = inbox.voice;
    // a voice note with nothing in it (silence, noise): no turn
    if (voice && !voice.text) {
      this.stopTyping(inbox.chatId);
      if (api) await api.sendMessage(inbox.chatId, "🎙 I couldn't hear anything in that voice message.", quote).catch(() => undefined);
      return;
    }
    const text = [...inbox.texts, ...(voice ? [voice.text] : [])].join('\n\n');
    if (!text && !inbox.attachments.length) return;
    let agentMessageId: string;
    try {
      ({ agentMessageId } = this.ctx.s.chat.send({
        threadId, text, attachments: inbox.attachments.map((id) => ({ id })), images: [],
        ...(voice ? { voice: { recordingId: voice.recordingId, durationMs: voice.durationMs } } : {}),
      }, 'channel'));
    } catch (e) {
      this.stopTyping(inbox.chatId);
      // this version was stopped (the version policy): say so on Telegram rather than going quiet
      if (!(e instanceof RpcError) || e.code !== 'update_required') throw e;
      if (api) await api.sendMessage(inbox.chatId, `⚠️ ${e.message}`, quote).catch(() => undefined);
      return;
    }
    this.svc.trackTurn(agentMessageId, { runnerId: this.id, chatId: inbox.chatId, threadId, replyTo: inbox.replyTo, ...(voice ? { voice: true } : {}) });
    this.startTyping(inbox.chatId);
  }

  /** "typing…" lasts 5 seconds on Telegram: keep it up until the reply goes out (at most 15 minutes) */
  private startTyping(chatId: string): void {
    this.stopTyping(chatId);
    const started = Date.now();
    const tick = () => {
      if (!this.tg || Date.now() - started > 15 * 60_000) { this.stopTyping(chatId); return; }
      void this.tg.api.sendChatAction(chatId, 'typing').catch(() => undefined);
    };
    tick();
    const t = setInterval(tick, 4500);
    t.unref?.();
    this.typing.set(chatId, t);
  }

  private stopTyping(chatId: string): void {
    const t = this.typing.get(chatId);
    if (t) { clearInterval(t); this.typing.delete(chatId); }
  }

  /** Markdown as Telegram-formatted messages (plain text for any one Telegram refuses to parse). */
  async sendText(chatId: string, md: string, replyTo?: number): Promise<void> {
    const api = this.tg?.api;
    if (!api) return;
    let first = true;
    for (const html of telegramChunks(md)) {
      const reply = first && replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};
      first = false;
      try {
        await api.sendMessage(chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...reply });
      } catch (e) {
        if (!(e instanceof GrammyError) || e.error_code !== 400) throw e;
        await api.sendMessage(chatId, htmlToPlain(html), { link_preview_options: { is_disabled: true }, ...reply });
      }
    }
  }

  /** A file the bot sent, as Telegram's own kind of message (photo, audio, voice, video…), else as a document. */
  async sendFile(chatId: string, file: FileAttachment): Promise<void> {
    const api = this.tg?.api;
    const rec = this.ctx.s.files.getRecord(file.id);
    if (!api || !rec || !existsSync(rec.storedPath)) return;
    const caption = file.caption ? { caption: file.caption.slice(0, 1024) } : {};
    if (rec.size > TG_UPLOAD_MAX) {
      await api.sendMessage(chatId, `📎 ${rec.name} (${Math.round(rec.size / 1024 / 1024)} MB) is too big for Telegram (50 MB at most). It's in the AppuBot app on your ${machineName(process.platform)}.`);
      return;
    }
    const input = () => new InputFile(rec.storedPath, rec.name);
    const kind = sendKind(rec.mimeType, rec.name, rec.size);
    void api.sendChatAction(chatId, kind === 'photo' ? 'upload_photo' : kind === 'video' ? 'upload_video' : kind === 'audio' || kind === 'voice' ? 'upload_voice' : 'upload_document').catch(() => undefined);
    try {
      if (kind === 'photo') { await api.sendPhoto(chatId, input(), caption); return; }
      if (kind === 'animation') { await api.sendAnimation(chatId, input(), caption); return; }
      if (kind === 'video') { await api.sendVideo(chatId, input(), { ...caption, supports_streaming: true }); return; }
      if (kind === 'voice') { await api.sendVoice(chatId, input(), caption); return; }
      if (kind === 'audio') { await api.sendAudio(chatId, input(), { ...caption, title: rec.name.replace(/\.[^.]+$/, '') }); return; }
    } catch (e) {
      // Telegram refuses some files as media (an odd photo size, a codec it can't play): send them as a document
      if (!(e instanceof GrammyError) || e.error_code !== 400) throw e;
      this.ctx.log.warn(`telegram: sending ${rec.name} as ${kind} failed, as a document instead`, errMsg(e));
    }
    await api.sendDocument(chatId, input(), caption);
  }

  async onCompleted(t: TelegramTurn, e: TurnCompleted): Promise<void> {
    this.stopTyping(t.chatId);
    if (!this.tg) return;
    const api = this.tg.api;
    if (e.status === 'error') { await api.sendMessage(t.chatId, `⚠️ ${e.message.error ?? 'Something went wrong.'}`); return; }
    if (e.status !== 'complete') return;
    // a voice note the bot sent itself lands first
    await t.sending;
    // what it sent along the way (`said`, files, voice notes) went out already
    const text = e.message.parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text' && !p.said).map((p) => p.text).join('\n\n').trim();
    // asked by voice: the answer as a voice note first (quoting the question), the text under it; not when the bot spoke already
    const spoke = !!text && !!t.voice && !t.spoken && await this.sendSpoken(t, e.message.id, text);
    if (text) await this.sendText(t.chatId, text, spoke ? undefined : t.replyTo);
    for (const p of e.message.parts) {
      if (p.type !== 'file' || t.sentFiles?.has(p.file.id)) continue;
      await this.sendFile(t.chatId, p.file).catch((err) => this.ctx.log.warn('telegram file failed', errMsg(err)));
    }
  }

  /**
   * The reply read aloud as a Telegram voice note (`VoiceService.speakForMessage`, which also keeps it on the message
   * for the app). False when voice replies are off, the voice model isn't here, or speaking failed (the text still goes).
   */
  private async sendSpoken(t: TelegramTurn, messageId: string, text: string): Promise<boolean> {
    const api = this.tg?.api;
    const voice = this.ctx.s.voice;
    if (!api || !this.ctx.s.settings.get().voice.telegramVoiceReplies || !voice.ready('tts')) return false;
    // "recording a voice message…" lasts 5 seconds too: kept up while it speaks
    const action = () => void api.sendChatAction(t.chatId, 'record_voice').catch(() => undefined);
    action();
    const timer = setInterval(action, 4500);
    timer.unref?.();
    try {
      const r = await voice.speakForMessage(t.threadId, messageId, { text: speakable(text) });
      await api.sendVoice(t.chatId, new InputFile(Buffer.from(r.audio), 'reply.ogg'), t.replyTo ? { reply_parameters: { message_id: t.replyTo, allow_sending_without_reply: true } } : {});
      return true;
    } catch (e) {
      this.ctx.log.warn('telegram: speaking the reply failed', errMsg(e));
      return false;
    } finally {
      clearInterval(timer);
    }
  }

  private async clearButtons(chatId: string, messageId?: number): Promise<void> {
    if (this.tg && messageId) await this.tg.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: undefined }).catch(() => undefined);
  }

  /** a tap on one of our buttons: an answer to a question (`q:<n>`) or to an approval (`p:allow`/`p:deny`) */
  private async onButton(cx: Context): Promise<void> {
    const data = cx.callbackQuery?.data;
    const chatId = cx.chat ? String(cx.chat.id) : undefined;
    if (!data || !chatId || !cx.from) return;
    if (!this.stored().allowedUsers.includes(String(cx.from.id))) { await cx.answerCallbackQuery({ text: 'This AppuBot is private.' }); return; }
    if (data.startsWith('k:')) { await this.onMenu(cx, chatId, Number(data.slice(2))); return; }
    if (data.startsWith('p:')) {
      const ok = await this.answerPermission(chatId, data === 'p:allow');
      await cx.answerCallbackQuery(ok ? { text: data === 'p:allow' ? 'Allowed' : 'Denied' } : { text: 'Already answered' });
      return;
    }
    const q = this.pendingQuestion.get(chatId);
    const pick = q && data.startsWith('q:') ? q.options[Number(data.slice(2))] : undefined;
    if (!q || pick === undefined) { await cx.answerCallbackQuery({ text: 'Already answered' }); await this.clearButtons(chatId, cx.callbackQuery?.message?.message_id); return; }
    this.pendingQuestion.delete(chatId);
    await this.clearButtons(chatId, q.messageId);
    try { this.ctx.s.agentBridge.answer(q.id, pick); await cx.answerCallbackQuery({ text: pick.slice(0, 190) }); } catch { await cx.answerCallbackQuery({ text: 'That question has expired' }); }
  }

  /** answer the approval waiting in this chat; false when there was none (or it was answered elsewhere) */
  private async answerPermission(chatId: string, allow: boolean): Promise<boolean> {
    const perm = this.pendingPermission.get(chatId);
    if (!perm) return false;
    this.pendingPermission.delete(chatId);
    const opt = allow ? perm.allow : perm.deny;
    let ok = false;
    if (opt) { try { this.ctx.s.chat.respondPermission(perm.id, opt, 'telegram'); ok = true; } catch { /* already resolved */ } }
    if (this.tg && perm.messageId) {
      await this.tg.api.editMessageText(chatId, perm.messageId, `🔐 ${perm.title}\n${ok ? (allow ? '✅ Allowed' : '🚫 Denied') : 'Answered already'}`).catch(() => undefined);
    }
    return ok;
  }

  /** an approval answered somewhere else (the app): its buttons on Telegram go */
  permissionResolved(id: string): void {
    for (const [chatId, p] of this.pendingPermission) {
      if (p.id !== id) continue;
      this.pendingPermission.delete(chatId);
      if (this.tg && p.messageId) void this.tg.api.editMessageText(chatId, p.messageId, `🔐 ${p.title}\nAnswered in the app`).catch(() => undefined);
    }
  }

  async forwardQuestion(chatId: string, q: { threadId: string; questionId: string; question: string; options: string[]; form?: QuestionForm }): Promise<void> {
    if (!this.tg) return;
    this.stopTyping(chatId);
    if (q.form?.kind === 'vault') {
      // a Vault card's secrets are typed into AppuBot itself, never into a chat with Telegram's servers in it
      const reason = q.form.vault?.reason ? `\n${q.form.vault.reason}` : '';
      await this.tg.api.sendMessage(chatId, `🔐 ${q.question}${reason}\n\nOpen AppuBot on your computer or phone to add it: it goes straight into your Vault. Don't send passwords, card numbers or keys here.`).catch(() => undefined);
      return;
    }
    if (q.form?.kind === 'telegram') {
      await this.tg.api.sendMessage(chatId, `🤖 ${q.question}\n\nOpen AppuBot on your computer to paste the bot token there. Don't send tokens here.`).catch(() => undefined);
      return;
    }
    if (q.form?.kind === 'app' && q.form.app) {
      // the card's buttons live in the apps: here, say where to do it
      const reason = q.form.app.reason ? `\n${q.form.app.reason}` : '';
      const where = q.form.app.state === 'turn-on' ? `turn ${q.form.app.name} on for this bot` : `connect ${q.form.app.name}`;
      await this.tg.api.sendMessage(chatId, `🔌 ${q.question}${reason}\n\nOpen AppuBot on your computer or phone → Apps to ${where}. This card then finishes by itself.`).catch(() => undefined);
      return;
    }
    if (q.form?.kind === 'routine' || q.form?.kind === 'bot') {
      // the schedule's fields (or a new bot's name) are adjusted in the apps; here the proposal is allowed or not, as
      // before (the question's words already list a change's rows)
      const r = q.form.kind === 'routine' ? q.form.routine : undefined;
      const kb = new InlineKeyboard();
      q.options.forEach((o, i) => kb.text(o, `q:${i}`));
      this.pendingQuestion.set(chatId, { id: q.questionId, options: q.options });
      const tail = q.form.kind === 'bot'
        ? (q.form.bot?.action === 'create' ? 'Allow it as proposed, or look it over and change its name on the card in AppuBot.' : 'Allow it, or look it over on the card in AppuBot.')
        : r?.action === 'update' ? 'Allow the change as proposed, or adjust the schedule on the card in AppuBot.'
          : 'Allow it as proposed, or adjust its time and days on the card in AppuBot.';
      const body = r && r.action !== 'update' ? `\n\nIt will send this, on its own:\n${r.prompt}` : '';
      const sent = await this.tg.api.sendMessage(chatId, `${q.form.kind === 'bot' ? '🤖' : '⏰'} ${q.question}${body}\n\n${tail}`, q.options.length ? { reply_markup: kb } : {}).catch(() => undefined);
      const cur = this.pendingQuestion.get(chatId);
      if (sent && cur?.id === q.questionId) cur.messageId = sent.message_id;
      return;
    }
    if (q.form) {
      // a form, answered here in words: the fields listed, one reply with them all
      const fields = q.form.fields.map((f) => `• ${f.label}${f.required ? ' (required)' : ''}${f.options.length ? `: ${f.options.join(' / ')}` : ''}${f.value ? ` [${f.value}]` : ''}`);
      this.pendingQuestion.set(chatId, { id: q.questionId, options: [] });
      const sent = await this.tg.api.sendMessage(chatId, `📝 ${q.question}\n\n${fields.join('\n')}\n\nReply with these in one message, or fill in the form in AppuBot.`).catch(() => undefined);
      const cur = this.pendingQuestion.get(chatId);
      if (sent && cur?.id === q.questionId) cur.messageId = sent.message_id;
      return;
    }
    const options = q.options.slice(0, 20);
    const kb = new InlineKeyboard();
    options.forEach((o, i) => { kb.text(o.slice(0, 60), `q:${i}`); if (i % 2 === 1 || o.length > 20) kb.row(); });
    this.pendingQuestion.set(chatId, { id: q.questionId, options });
    const sent = await this.tg.api.sendMessage(chatId, `❓ ${q.question}\n\n${options.length ? 'Tap an answer or reply with your own.' : 'Reply with your answer.'}`, options.length ? { reply_markup: kb } : {}).catch(() => undefined);
    const cur = this.pendingQuestion.get(chatId);
    if (sent && cur?.id === q.questionId) cur.messageId = sent.message_id;
  }

  async forwardPermission(chatId: string, p: { id: string; threadId: string; title: string; options: { optionId: string; kind: string }[] }): Promise<void> {
    if (!this.tg) return;
    this.stopTyping(chatId);
    const allow = p.options.find((o) => o.kind === 'allow_once')?.optionId ?? p.options.find((o) => o.kind.startsWith('allow'))?.optionId;
    const deny = p.options.find((o) => o.kind === 'reject_once')?.optionId ?? p.options.find((o) => o.kind.startsWith('reject'))?.optionId;
    this.pendingPermission.set(chatId, { id: p.id, title: p.title, allow, deny });
    const kb = new InlineKeyboard();
    if (allow) kb.text('✅ Allow', 'p:allow');
    if (deny) kb.text('🚫 Deny', 'p:deny');
    const sent = await this.tg.api.sendMessage(chatId, `🔐 Approval needed: ${p.title}\nTap a button, or reply /allow or /deny.`, { reply_markup: kb }).catch(() => undefined);
    const cur = this.pendingPermission.get(chatId);
    if (sent && cur?.id === p.id) cur.messageId = sent.message_id;
  }
}

/** a bot may only download files up to 20 MB from Telegram, and upload up to 50 MB */
const TG_DOWNLOAD_MAX = 20 * 1024 * 1024;
const TG_UPLOAD_MAX = 50 * 1024 * 1024;
/** how much of the bot's memory /memory shows (the rest is in the app) */
const MEMORY_SHOWN = 6000;
/** menus whose buttons still work (the oldest go first) */
const MENUS_KEPT = 50;
/** the photos of an album arrive one message each, within a moment */
const ALBUM_WAIT_MS = 1200;

/** what a Telegram message brings in, before it goes to the bot */
interface Inbox {
  chatId: string;
  replyTo: number;
  texts: string[];
  attachments: string[];
  notes: string[];
  downloads: Promise<void>[];
  timer: ReturnType<typeof setTimeout> | null;
  /** a voice note heard here: its recording (a file id) and what was said ('' for silence) */
  voice?: { recordingId: string; durationMs: number; text: string };
}

/** At most `VOICE_SPEAK_MAX_CHARS` of a reply is read aloud, ending at a sentence (or word) where it can. */
export function speakable(text: string): string {
  if (text.length <= VOICE_SPEAK_MAX_CHARS) return text;
  const head = text.slice(0, VOICE_SPEAK_MAX_CHARS);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('\n\n'));
  if (end > VOICE_SPEAK_MAX_CHARS / 2) return head.slice(0, end + 1).trimEnd();
  const space = head.lastIndexOf(' ');
  return space > VOICE_SPEAK_MAX_CHARS / 2 ? head.slice(0, space) : head;
}

interface TgMedia { fileId: string; name: string; mime?: string; size?: number }

const hasMedia = (m: TgMessage): boolean => mediaOf(m).length > 0 || !!(m.location || m.contact || m.venue || m.poll);

/** The files a Telegram message carries: photo, document, audio, voice note, video, round video, GIF, sticker. */
export function mediaOf(m: TgMessage): TgMedia[] {
  const id = m.message_id;
  const out: TgMedia[] = [];
  if (m.photo?.length) {
    const big = m.photo[m.photo.length - 1]!;
    out.push({ fileId: big.file_id, name: `photo-${id}.jpg`, mime: 'image/jpeg', size: big.file_size });
  }
  // a GIF comes with a `document` too: take it once
  if (m.animation) out.push({ fileId: m.animation.file_id, name: m.animation.file_name || `animation-${id}`, mime: m.animation.mime_type, size: m.animation.file_size });
  else if (m.document) out.push({ fileId: m.document.file_id, name: m.document.file_name || `file-${id}`, mime: m.document.mime_type, size: m.document.file_size });
  if (m.audio) {
    const title = [m.audio.performer, m.audio.title].filter(Boolean).join(' - ');
    out.push({ fileId: m.audio.file_id, name: m.audio.file_name || title || `audio-${id}`, mime: m.audio.mime_type, size: m.audio.file_size });
  }
  if (m.voice) out.push({ fileId: m.voice.file_id, name: `voice-${id}.ogg`, mime: m.voice.mime_type || 'audio/ogg', size: m.voice.file_size });
  if (m.video) out.push({ fileId: m.video.file_id, name: m.video.file_name || `video-${id}`, mime: m.video.mime_type || 'video/mp4', size: m.video.file_size });
  if (m.video_note) out.push({ fileId: m.video_note.file_id, name: `video-note-${id}.mp4`, mime: 'video/mp4', size: m.video_note.file_size });
  if (m.sticker && !m.sticker.is_animated) out.push({ fileId: m.sticker.file_id, name: `sticker-${id}${m.sticker.is_video ? '.webm' : '.webp'}`, mime: m.sticker.is_video ? 'video/webm' : 'image/webp', size: m.sticker.file_size });
  return out;
}

/**
 * The words a Telegram message gives the bot: its text or caption, plus what it quotes and shares (a place, a
 * contact…). `voice: false` leaves out the "(A voice message)" line, for a voice note whose words go instead.
 */
export function describe(m: TgMessage, o: { voice?: boolean } = {}): string {
  const lines: string[] = [];
  const quoted = m.quote?.text ?? (m.reply_to_message && (m.reply_to_message.text ?? m.reply_to_message.caption));
  if (quoted) lines.push(`(Replying to: "${quoted.length > 500 ? `${quoted.slice(0, 500)}…` : quoted}")`);
  const fwd = m.forward_origin;
  if (fwd) {
    const from = fwd.type === 'user' ? [fwd.sender_user.first_name, fwd.sender_user.last_name].filter(Boolean).join(' ')
      : fwd.type === 'hidden_user' ? fwd.sender_user_name : fwd.type === 'chat' ? fwd.sender_chat.title ?? '' : fwd.chat.title ?? '';
    lines.push(`(Forwarded${from ? ` from ${from}` : ''})`);
  }
  const text = (m.text ?? m.caption ?? '').trim();
  if (text) lines.push(text);
  if (m.voice && o.voice !== false) lines.push(`(A voice message, ${m.voice.duration}s)`);
  if (m.video_note) lines.push(`(A round video message, ${m.video_note.duration}s)`);
  if (m.sticker) lines.push(`(A sticker${m.sticker.emoji ? ` ${m.sticker.emoji}` : ''})`);
  if (m.venue) lines.push(`📍 ${m.venue.title}, ${m.venue.address} (${m.venue.location.latitude}, ${m.venue.location.longitude})`);
  else if (m.location) lines.push(`📍 Location: ${m.location.latitude}, ${m.location.longitude} (https://maps.google.com/?q=${m.location.latitude},${m.location.longitude})`);
  if (m.contact) lines.push(`👤 Contact: ${[m.contact.first_name, m.contact.last_name].filter(Boolean).join(' ')}, ${m.contact.phone_number}`);
  if (m.poll) lines.push(`📊 Poll: ${m.poll.question}\n${m.poll.options.map((o) => `• ${o.text}`).join('\n')}`);
  return lines.join('\n');
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
  'audio/ogg': '.ogg', 'audio/x-wav': '.wav', 'audio/wav': '.wav', 'audio/flac': '.flac', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'application/pdf': '.pdf',
};
const extOf = (path: string, mime?: string): string => /\.[a-z0-9]{1,6}$/i.exec(path)?.[0] ?? (mime ? MIME_EXT[mime] ?? '' : '');

/** How a file goes to Telegram so it shows as itself: a photo, a playable song or voice note, a video… */
export function sendKind(mime: string, name: string, size: number): 'photo' | 'animation' | 'video' | 'audio' | 'voice' | 'document' {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  // Telegram recompresses photos (10 MB max): bigger ones and other image types keep their bytes as documents
  if (/^image\/(jpeg|png|webp)$/.test(mime) && size <= 10 * 1024 * 1024) return 'photo';
  if (mime === 'image/gif') return 'animation';
  if (mime === 'video/mp4' || ext === 'mp4') return 'video';
  // only OGG/Opus shows as a voice note; MP3 and M4A play as songs
  if (ext === 'ogg' || ext === 'oga' || ext === 'opus') return 'voice';
  if (mime === 'audio/mpeg' || mime === 'audio/mp4' || ['mp3', 'm4a'].includes(ext)) return 'audio';
  return 'document';
}
