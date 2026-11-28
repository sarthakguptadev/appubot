/** One Telegram bot wired to one AppuBot bot: long polling or a webhook, its messages into the bot's chat, replies and files back (see channels.ts). */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Bot as TgBot, GrammyError, HttpError, InputFile, InlineKeyboard, webhookCallback, type Context } from 'grammy';
import type { Context as HonoContext } from 'hono';
import type { Message as TgMessage } from 'grammy/types';
import { machineName, VOICE_SPEAK_MAX_CHARS, type Thread, type FileAttachment, type Part, type QuestionForm } from '@appubot/protocol';
import { botAvatarSvg, botFigure, escapeHtml as esc, htmlToPlain, telegramChunks } from '@appubot/chat-core';
import type { CoreCtx } from '../context';
import type { StoredChannel, TelegramProfileSync } from '../store';
import { errMsg, RpcError } from '../util';
import type { TurnCompleted } from './chat';
import { agentMenu, agentName, chatsMenu, effortMenu, fastMenu, helpText, modeMenu, modelMenu, routinesMenu, statusText, TELEGRAM_COMMANDS, voiceMenu, type MenuKind, type MenuSpec } from './telegramCommands';
import type { ChannelsService } from './channels';
import { GETME_RETRY_MS, NO_PUBLIC_URL, PHOTO_PX, TIMEOUT_TEXT, TOKEN_ELSEWHERE, type TelegramTurn, WEBHOOK_UPDATES, cut, isTransientTelegramError, newCode, photoKey, sleep, telegramAbout, telegramAgent, telegramErrorText } from './telegramShared';

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
      const jpeg = await draw(botAvatarSvg(figure, bot.color, PHOTO_PX, bot.chief), PHOTO_PX);
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
