/** agent.* handlers - called by the MCP bridge on behalf of a running agent (role 'agent'). */
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { extname } from 'node:path';
import { appOn, GOAL_TURNS_DEFAULT, GOAL_TURNS_MAX, GROUP_GOAL_MESSAGES_DEFAULT, BOT_MESSAGE_HOPS_MAX, BOT_MESSAGE_WAIT_MS, computerUseSupported, currentChat, machineName, newId, withAppOn, type Bot, type FileAttachment, type FormChange, type Message, type MethodParams, type MethodResult, type Part, type QuestionForm, FormFieldSchema, type Skill } from '@appubot/protocol';
import { botCardFields, goalCardFields, cleanFormValues, cronToHuman, fileValueId, formAnswerText, formDeclinedText, formProblems, groupLead, renderBotMessagePreface, replyTextOf, routineFormCron, routineFormFields, routineFormSpec, transcriptText, withoutSecrets, type FormValues } from '@appubot/chat-core';
import { permissionChoice } from '@appubot/agent-runtime';
import type { AgentContext, Role } from '../auth';
import type { CoreCtx } from '../context';
import { mimeFromName, notFound, RpcError } from '../util';
import { cleanBotName } from './bots';
import { validateCron } from './routines';

/** Images a page may build in: each, and all together. */
const PAGE_IMAGE_MAX = 8 * 1024 * 1024;
const PAGE_IMAGES_TOTAL = 24 * 1024 * 1024;

const ALLOW = 'Allow';
const DONT_ALLOW = "Don't allow";
/** the longest job / instructions a bot may propose for another bot: the user reviews all of it, so it must fit on screen */
const STEER_MAX = { job: 300, instructions: 4000 } as const;
/** the biggest file `transcribe_audio` reads (a video's sound included) */
const HEAR_MAX_BYTES = 100 * 1024 * 1024;
const OGG_EXT = new Set(['ogg', 'oga', 'opus']);
/** what the bot is told when a voice model is missing: something only the user can fix */
const NOT_READY = {
  stt: "The speech model isn't downloaded on this computer yet: ask the user to download it in Settings › Voice.",
  tts: "The voice model isn't downloaded on this computer yet: ask the user to download it in Settings › Voice.",
} as const;

type QuestionPart = Extract<Part, { type: 'question' }>;
/** How a question was answered: its words, and for a form what was filled in (secrets never kept here). */
export interface QuestionOutcome { answer: string; values?: FormValues; declined?: boolean; savedId?: string }
/** A form's answer as it arrives, with who sent it (a Vault card takes secrets from the owner's devices only). */
export interface FormSubmission { values: FormValues; savedId?: string; role: Role }
interface PendingQuestion {
  threadId: string; messageId: string; partIndex: number; part: QuestionPart; resolve: (o: QuestionOutcome | null) => void; timer: ReturnType<typeof setTimeout>;
  /** a form's own handling of a submission (a Vault card saves it); throws to leave the card open with the reason */
  onSubmit?: (s: FormSubmission) => QuestionOutcome | Promise<QuestionOutcome>;
}

/** The hooks a card may bring to `open`: its submission, and the question's id once it shows (to settle it from outside). */
export interface OpenHooks { onSubmit?: PendingQuestion['onSubmit']; onOpen?: (questionId: string) => void }

/** Turning computer use on fails clearly where it doesn't exist (anywhere but macOS, Windows and Linux). */
function noComputerUseHere(): void {
  if (computerUseSupported(process.platform)) return;
  throw new RpcError('unavailable', `Computer use is only available on macOS, Windows and Linux; it can't be turned on on this ${machineName(process.platform)}.`);
}

export class AgentBridgeService {
  private questions = new Map<string, PendingQuestion>();
  /** bots waiting for another bot's reply (`message_bot wait`), by the agent message that will carry it */
  private replyWaiters = new Map<string, (m: Message, status: 'complete' | 'cancelled' | 'error') => void>();

  constructor(private ctx: CoreCtx) {
    ctx.s.chat.onTurnCompleted((e) => {
      const w = this.replyWaiters.get(e.message.id);
      if (!w) return;
      this.replyWaiters.delete(e.message.id);
      w(e.message, e.status);
    });
  }

  private bot(a: AgentContext) { return this.ctx.s.bots.require(a.botId); }

  context(a: AgentContext): { botId: string; threadId: string; botName: string; workspace: string; computerUse: boolean } {
    const bot = this.bot(a);
    return { botId: bot.id, threadId: a.threadId, botName: bot.name, workspace: bot.workspace, computerUse: bot.computerUse && computerUseSupported(process.platform) };
  }

  async ask(a: AgentContext, question: string, options: string[], timeoutSec: number): Promise<{ answer: string | null }> {
    const o = await this.open(a, { question, options }, timeoutSec);
    return { answer: o?.answer ?? null };
  }

  /** A form card (`ask_form`): the user fills it in and sends it, or turns it down. */
  async askForm(a: AgentContext, p: MethodParams<'agent.askForm'>): Promise<MethodResult<'agent.askForm'>> {
    const ids = new Set<string>();
    const fields = p.fields.map((f) => FormFieldSchema.parse(f));
    for (const f of fields) {
      if (ids.has(f.id)) throw new RpcError('invalid_params', `Two fields share the id “${f.id}”.`);
      ids.add(f.id);
      if (f.type === 'secret') throw new RpcError('invalid_params', `A form can't ask for a secret (“${f.label}”): you would see it. Use vault_request for a password, card or API key: it goes into the Vault, and you use it from there without seeing it.`);
      if ((f.type === 'choice' || f.type === 'multichoice') && !f.options.length) throw new RpcError('invalid_params', `“${f.label}” is a ${f.type} with no options.`);
      if (f.type === 'file' && f.value) throw new RpcError('invalid_params', `“${f.label}” is a file field: the user picks the file, so leave its value out.`);
    }
    const form: QuestionForm = { kind: 'form', fields, ...(p.submit ? { submit: p.submit } : {}) };
    const o = await this.open(a, { question: p.question, options: [], form }, p.timeoutSec ?? 900);
    if (!o) return { values: null };
    if (o.declined) return { values: null, declined: true };
    // answered in words (an older app, or Telegram): the bot gets them as they are
    if (!o.values) return { values: null, answer: o.answer };
    return { values: o.values };
  }

  /**
   * Shows a question (or form) in the chat and waits for its answer. `onSubmit` handles a form's submission (a Vault
   * card saves it); null: no answer in time, the turn ended, or nobody can answer (a hidden turn).
   */
  open(a: AgentContext, q: { question: string; options: string[]; form?: QuestionForm }, timeoutSec: number, hooks?: PendingQuestion['onSubmit'] | OpenHooks): Promise<QuestionOutcome | null> {
    const bot = this.bot(a);
    const { onSubmit, onOpen } = typeof hooks === 'function' ? { onSubmit: hooks, onOpen: undefined } : hooks ?? {};
    // a hidden turn (AppuBot asking what to remember) never shows in the chat: nobody is there to answer
    if (this.ctx.s.chat.isHiddenTurn(a.threadId)) return Promise.resolve(null);
    const questionId = newId('q');
    const part: QuestionPart = { type: 'question', questionId, question: q.question, options: q.options, ...(q.form ? { form: q.form } : {}) };
    const { messageId, partIndex } = this.ctx.s.chat.appendPart(a.threadId, part);
    const what = q.form?.kind === 'vault' ? 'needs something from your Vault'
      : q.form?.kind === 'app' ? `needs ${q.form.app?.name ?? 'an app'}`
        : q.form?.kind === 'telegram' ? 'wants to connect Telegram'
          : q.form?.kind === 'routine' ? (q.form.routine?.action === 'update' ? 'proposes a change to a routine' : 'proposes a routine')
            : q.form?.kind === 'bot' ? (q.form.bot?.action === 'create' ? 'wants to make a new bot' : 'wants to change a bot')
              : q.form ? 'needs a few details' : 'has a question';
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(questionId, null), Math.max(5, Math.min(timeoutSec, 3600)) * 1000);
      this.questions.set(questionId, { threadId: a.threadId, messageId, partIndex, part, resolve, timer, onSubmit });
      onOpen?.(questionId);
      this.ctx.s.chat.setWaiting(a.threadId, true);
      this.ctx.bus.emit('question.asked', { threadId: a.threadId, messageId, questionId, question: q.question, options: q.options, ...(q.form ? { form: q.form } : {}) });
      this.ctx.s.notifications.notify({
        title: `${bot.name} ${what}`, body: q.question, threadId: a.threadId, level: 'warning', kind: 'question',
        push: { kind: 'needs-you', botId: bot.id, botName: bot.name, text: q.question },
      });
    });
  }

  /** The thread a waiting question is in (Telegram answers only the ones of its own turns). */
  questionOf(questionId: string): { threadId: string; part: QuestionPart } | undefined {
    const q = this.questions.get(questionId);
    return q ? { threadId: q.threadId, part: q.part } : undefined;
  }

  /** An answer in words (`chat.answer`). A Vault or Telegram card can't be answered so: its secrets belong on the card. */
  answer(questionId: string, answer: string): { ok: true } {
    const q = this.questions.get(questionId);
    if (!q) throw notFound('Question', questionId);
    if (q.part.form?.kind === 'vault') {
      throw new RpcError('form_required', 'Fill this in on its card in the chat: what you type there goes straight into your Vault, never to the bot. Update AppuBot if the card has no fields.');
    }
    if (q.part.form?.kind === 'telegram') {
      throw new RpcError('form_required', 'Paste the token on its card in AppuBot on your computer: it stays there, never in the chat. Update AppuBot if the card has no field.');
    }
    this.finish(questionId, { answer });
    return { ok: true };
  }

  /** A form card filled in (`chat.answerForm`), or turned down. Throws, leaving the card open, when something is wrong. */
  async answerForm(p: MethodParams<'chat.answerForm'>, role: Role): Promise<{ ok: true }> {
    const q = this.questions.get(p.questionId);
    if (!q) throw notFound('Question', p.questionId);
    const form = q.part.form;
    if (!form) throw new RpcError('invalid_params', 'That question has no form: answer it with chat.answer.');
    if (p.decline) { this.finish(p.questionId, { answer: formDeclinedText(form), declined: true }); return { ok: true }; }
    if (q.onSubmit) {
      const o = await q.onSubmit({ values: p.values ?? {}, savedId: p.savedId, role });
      // the card may have been settled meanwhile (an app card by its connection): the later word doesn't matter
      if (this.questions.get(p.questionId) === q) this.finish(p.questionId, o);
      return { ok: true };
    }
    const values = this.fileValues(form, cleanFormValues(form.fields, p.values ?? {}), role);
    const problems = formProblems(form, values);
    const first = Object.keys(problems)[0];
    if (first) {
      const label = form.fields.find((f) => f.id === first)?.label ?? first;
      throw new RpcError('invalid_params', `${label}: ${problems[first]}`, { problems });
    }
    this.finish(p.questionId, { answer: formAnswerText(form.fields, values), values });
    return { ok: true };
  }

  /**
   * A form's file fields as the bot reads them: a file a device uploaded (`file:<id>:<name>`) becomes its path on this
   * computer (the record's inbox copy, else its stored copy); a bare path is this computer's own, so only the window
   * (owner) may send one. The read-back keeps the uploaded file's name (`fileValueName` reads both).
   */
  private fileValues(form: QuestionForm, values: FormValues, role: Role): FormValues {
    const out = { ...values };
    for (const f of form.fields) {
      if (f.type !== 'file') continue;
      const v = out[f.id];
      if (typeof v !== 'string' || !v) continue;
      const id = fileValueId(v);
      if (id) {
        const rec = this.ctx.s.files.record(id);
        if (!rec) throw new RpcError('invalid_params', `${f.label}: that file is no longer here. Pick it again.`, { problems: { [f.id]: 'Pick it again' } });
        out[f.id] = rec.path ?? rec.storedPath;
      } else if (role !== 'owner') {
        throw new RpcError('forbidden', `${f.label}: pick the file on this device (a path is only taken from the computer itself).`, { problems: { [f.id]: 'Pick a file' } });
      }
    }
    return out;
  }

  /** Settle a waiting question from outside (an app card once its app is connected and on): no-op once answered. */
  settle(questionId: string, o: QuestionOutcome): void { if (this.questions.has(questionId)) this.finish(questionId, o); }

  /** Whether a question still waits. */
  isOpen(questionId: string): boolean { return this.questions.has(questionId); }

  private finish(questionId: string, o: QuestionOutcome | null): void {
    const q = this.questions.get(questionId);
    if (!q) return;
    this.questions.delete(questionId);
    clearTimeout(q.timer);
    if (o !== null) {
      const fields = q.part.form?.fields ?? [];
      const part: QuestionPart = {
        ...q.part, answer: o.answer,
        ...(o.values && q.part.form ? { values: withoutSecrets(fields, o.values) } : {}),
        ...(o.declined ? { declined: true } : {}),
        ...(o.savedId ? { savedId: o.savedId } : {}),
      };
      this.ctx.s.chat.updatePart(q.threadId, q.messageId, q.partIndex, part);
    }
    if (![...this.questions.values()].some((x) => x.threadId === q.threadId)) this.ctx.s.chat.setWaiting(q.threadId, false);
    q.resolve(o);
  }

  cancelQuestions(threadId: string): void {
    for (const [id, q] of this.questions) if (q.threadId === threadId) this.finish(id, null);
  }

  notify(a: AgentContext, title: string, body: string): { ok: true } {
    const bot = this.bot(a);
    this.ctx.s.notifications.notify({ title: title || bot.name, body, threadId: a.threadId, level: 'info', push: { kind: 'done', botId: bot.id, botName: bot.name, title: title || bot.name, text: body } });
    return { ok: true };
  }

  sendFile(a: AgentContext, path: string, caption?: string): FileAttachment {
    return this.ctx.s.files.sendToDevices(path, caption, a.threadId);
  }

  /**
   * A visual reply (`show_page`): the bot's HTML, with images it named by local path built in (the page can't load
   * anything itself), kept as a file and shown in the running message as a `page` part; a Telegram turn gets the file.
   */
  async showPage(a: AgentContext, title: string, html: string): Promise<MethodResult<'agent.showPage'>> {
    this.ctx.s.threads.require(a.threadId);
    const page = await this.embedLocalImages(html);
    const file = this.ctx.s.files.storePage(title.trim(), page, a.threadId);
    const { messageId } = this.ctx.s.chat.appendPart(a.threadId, { type: 'page', title: title.trim(), file });
    this.ctx.s.channels.fileSent(messageId, file);
    return { ok: true, bytes: file.size };
  }

  /** `src="/Users/…/chart.png"` (or file://, or a CSS url()) → a data: URL, for files under home or temp, images only. */
  private async embedLocalImages(html: string): Promise<string> {
    const found = new Map<string, string>();
    const PATH = /(src\s*=\s*["']|url\(\s*["']?)((?:file:\/\/)?\/[^"')\s]+|[A-Za-z]:\\[^"')]+)/g;
    let total = 0;
    for (const m of html.matchAll(PATH)) {
      const raw = m[2]!;
      if (found.has(raw)) continue;
      let p = raw.startsWith('file://') ? decodeURIComponent(raw.slice(7)) : raw;
      try { p = this.ctx.s.files.checkDeliverablePath(p); } catch { continue; }
      const mime = mimeFromName(p);
      if (!mime.startsWith('image/')) continue;
      const size = statSync(p).size;
      if (size > PAGE_IMAGE_MAX || total + size > PAGE_IMAGES_TOTAL) continue;
      total += size;
      found.set(raw, `data:${mime};base64,${(await readFile(p)).toString('base64')}`);
    }
    return found.size ? html.replace(PATH, (all, pre: string, raw: string) => (found.has(raw) ? pre + found.get(raw)! : all)) : html;
  }

  /* ------------------------------------------------------------------ voice */

  /** The words of an audio or video file on this computer (home folder or temp), heard here (`VoiceService`). */
  async transcribe(a: AgentContext, path: string, language?: string): Promise<MethodResult<'agent.transcribe'>> {
    void a;
    let rp: string;
    try { rp = this.ctx.s.files.checkDeliverablePath(path); } catch (e) {
      // its wording is about sending files
      if (e instanceof RpcError && e.code === 'forbidden') throw new RpcError('forbidden', `Can only hear files in your home folder or the temp folder: ${path}`);
      throw e;
    }
    if (statSync(rp).size > HEAR_MAX_BYTES) throw new RpcError('invalid_params', `That file is larger than ${HEAR_MAX_BYTES / 1024 / 1024} MB`);
    const audio = new Uint8Array(await readFile(rp));
    // OGG/Opus decodes here; anything else (WAV is sniffed by VoiceService) through the app's own decoder
    const ogg = OGG_EXT.has(extname(rp).slice(1).toLowerCase()) || String.fromCharCode(...audio.subarray(0, 4)) === 'OggS';
    try {
      return await this.ctx.s.voice.transcribe({ audio, format: ogg ? 'ogg' : 'encoded', ...(ogg ? {} : { mimeType: mimeFromName(rp) }), ...(language ? { language } : {}) });
    } catch (e) {
      if (e instanceof RpcError && e.code === 'voice_not_ready') throw new RpcError('voice_not_ready', NOT_READY.stt);
      throw e;
    }
  }

  /**
   * A voice message from the bot now: `text` read aloud, kept as a `voice` part (`kind: 'reply'`) of its running
   * message, `caption` after it as a bubble of its own (`said`), and on Telegram at once when the turn came from there.
   */
  async speak(a: AgentContext, p: MethodParams<'agent.speak'>): Promise<MethodResult<'agent.speak'>> {
    const { chat, voice } = this.ctx.s;
    this.ctx.s.threads.require(a.threadId);
    if (!voice.ready('tts')) throw new RpcError('voice_not_ready', NOT_READY.tts);
    let messageId = chat.currentAgentMessage(a.threadId)?.id;
    if (!messageId) {
      // no turn running (a late call): a message of its own, as ChatService.appendPart makes one
      const now = Date.now();
      const m: Message = { id: newId('msg'), threadId: a.threadId, role: 'agent', parts: [], status: 'complete', via: 'system', createdAt: now, updatedAt: now };
      messageId = this.ctx.s.threads.addMessage(m).id;
    }
    let r: Awaited<ReturnType<typeof voice.speakForMessage>>;
    try {
      r = await voice.speakForMessage(a.threadId, messageId, { text: p.text, ...(p.language ? { language: p.language } : {}), ...(p.voice ? { voice: p.voice } : {}) });
    } catch (e) {
      if (e instanceof RpcError && e.code === 'voice_not_ready') throw new RpcError('voice_not_ready', NOT_READY.tts);
      throw e;
    }
    const caption = p.caption?.trim();
    // right after its reading, in the same message; Telegram gets it as the voice note's caption (no `channels.said`)
    if (caption) this.ctx.s.threads.appendPart(a.threadId, messageId, { type: 'text', text: caption, said: true });
    this.ctx.s.channels.voiceSent(messageId, r.file, caption || undefined);
    return { ok: true, file: r.file, durationMs: r.durationMs, language: r.language };
  }

  /* ------------------------------------------- the caller's memory (MEMORY.md, shared by all its threads) */

  remember(a: AgentContext, text: string): MethodResult<'agent.remember'> { return this.ctx.s.bots.remember(a.botId, text); }
  readMemory(a: AgentContext): MethodResult<'agent.memory.read'> { return this.ctx.s.bots.readMemoryOf(a.botId); }
  updateMemory(a: AgentContext, find: string, text: string): MethodResult<'agent.memory.update'> { return this.ctx.s.bots.updateMemory(a.botId, find, text); }
  forgetMemory(a: AgentContext, text: string): MethodResult<'agent.memory.forget'> { return this.ctx.s.bots.forgetMemory(a.botId, text); }

  saveSkill(a: AgentContext, name: string, description: string, body: string): Skill {
    const taught = this.ctx.s.teach.isTeachThread(a.threadId);
    const s = this.ctx.s.skills.save(a.botId, name, description, body, taught ? 'taught' : 'user');
    if (taught) this.ctx.s.teach.onSkillSaved(a.threadId, s.name);
    return s;
  }

  /* ------------------------------------------------ bots looking after bots (no id: the calling bot) */

  private chatOf(botId: string) { return currentChat(this.ctx.s.threads.list({ limit: 100_000 }), botId); }

  listBots(a: AgentContext): MethodResult<'agent.bots.list'> {
    const threads = this.ctx.s.threads.list({ limit: 100_000 });
    return this.ctx.s.bots.list().map((b) => {
      const chat = currentChat(threads, b.id);
      return {
        id: b.id, name: b.name, job: b.job, providerId: b.providerId, agent: this.agentName(b.providerId), isYou: b.id === a.botId,
        status: chat?.status ?? 'idle', ...(chat?.lastMessagePreview ? { lastMessagePreview: chat.lastMessagePreview } : {}), chief: b.chief,
      };
    });
  }

  /* ------------------------------------------------------- bots talking to bots */

  /** A bot by id or name (case-insensitive; an exact name first), never the caller itself. */
  private otherBot(a: AgentContext, ref: string): Bot {
    const q = ref.trim().toLowerCase();
    const all = this.ctx.s.bots.list();
    const bot = all.find((b) => b.id === ref) ?? all.find((b) => b.name.toLowerCase() === q) ?? all.find((b) => b.name.toLowerCase().startsWith(q));
    if (!bot) throw new RpcError('not_found', `No bot "${ref}". list_bots shows them.`);
    if (bot.id === a.botId) throw new RpcError('invalid_params', "That's you: message another bot, or just answer the user.");
    return bot;
  }

  /** How deep a bots' exchange the caller is in (its running turn answers a bot's message `hop` deep). */
  private hopOf(a: AgentContext): number {
    const job = this.ctx.s.chat.runningJob(a.threadId);
    return job?.via === 'bot' ? (job.hop ?? 0) + 1 : 0;
  }

  /** The reply to a turn, once it ends (`null` after `ms`: the turn goes on, the caller stops waiting). */
  private waitReply(agentMessageId: string, ms: number): Promise<{ message: Message; status: 'complete' | 'cancelled' | 'error' } | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.replyWaiters.delete(agentMessageId); resolve(null); }, ms);
      this.replyWaiters.set(agentMessageId, (message, status) => { clearTimeout(timer); resolve({ message, status }); });
    });
  }

  /**
   * One bot messages another (`message_bot`): the text lands in the other bot's current chat as a message from the
   * caller (never the user: `via: 'bot'`, `from`), with chat-core's preface, and it answers in its own chat; with
   * `wait` the whole reply comes back. Bots answering each other's answers stop at `BOT_MESSAGE_HOPS_MAX`.
   */
  async messageBot(a: AgentContext, p: MethodParams<'agent.bots.message'>): Promise<MethodResult<'agent.bots.message'>> {
    const me = this.bot(a);
    const to = this.otherBot(a, p.bot);
    const hop = this.hopOf(a);
    if (hop >= BOT_MESSAGE_HOPS_MAX) throw new RpcError('forbidden', `You and ${to.name} have answered each other ${hop} times in a row: stop here and tell the user where things stand instead of messaging again.`);
    // answering this very bot's message: it waits on this reply, and a message back would queue behind its waiting
    // turn, so both would wait until they timed out
    const answering = this.ctx.s.chat.runningJob(a.threadId);
    if (answering?.via === 'bot' && answering.from?.botId === to.id) throw new RpcError('invalid_params', `${to.name} is waiting for your answer to its message: put what you want to say or ask in your reply instead of messaging it.`);
    const thread = this.ctx.s.threads.chatFor(to.id);
    if (this.ctx.s.chat.isHiddenTurn(thread.id)) await new Promise((r) => setTimeout(r, 500));
    const wait = p.wait !== false;
    const preface = renderBotMessagePreface({ from: { id: me.id, name: me.name }, you: { id: to.id, name: to.name }, waits: wait });
    const r = this.ctx.s.chat.send({ threadId: thread.id, text: p.text, attachments: [], images: [] }, 'bot', { quiet: true, from: { botId: me.id, name: me.name }, preface, hop });
    if (!wait) return { bot: { id: to.id, name: to.name }, threadId: thread.id, reply: null, timedOut: false };
    const done = await this.waitReply(r.agentMessageId, BOT_MESSAGE_WAIT_MS);
    if (!done) return { bot: { id: to.id, name: to.name }, threadId: thread.id, reply: null, timedOut: true };
    if (done.status === 'cancelled') return { bot: { id: to.id, name: to.name }, threadId: thread.id, reply: '(stopped before answering)', timedOut: false };
    return { bot: { id: to.id, name: to.name }, threadId: thread.id, reply: replyTextOf(done.message) || '(no answer)', timedOut: false };
  }

  /** A chief messages every other bot at once (`message_bots`, or the ones named), replies gathered. */
  async broadcast(a: AgentContext, p: MethodParams<'agent.bots.broadcast'>): Promise<MethodResult<'agent.bots.broadcast'>> {
    const me = this.bot(a);
    if (!me.chief) throw new RpcError('forbidden', `Only a chief bot may message every bot at once. Ask the user to mark you as chief in your settings, or message bots one at a time with message_bot.`);
    const targets = (p.botIds?.length ? p.botIds.map((id) => this.ctx.s.bots.require(id)) : this.ctx.s.bots.list()).filter((b) => b.id !== me.id);
    if (!targets.length) throw new RpcError('invalid_params', 'There is no other bot to message.');
    const replies = await Promise.all(targets.map(async (b) => {
      try {
        const r = await this.messageBot(a, { bot: b.id, text: p.text, wait: p.wait });
        return { bot: r.bot, reply: r.reply, timedOut: r.timedOut };
      } catch (e) { return { bot: { id: b.id, name: b.name }, reply: `(couldn't deliver: ${e instanceof Error ? e.message : String(e)})`, timedOut: false }; }
    }));
    return { replies };
  }

  /* ------------------------------------------------------------------- groups */

  private groupView(g: ReturnType<typeof this.ctx.s.groups.list>[number]): MethodResult<'agent.groups.list'>[number] {
    const members = g.botIds.map((id) => this.ctx.s.bots.get(id)).filter((b): b is Bot => !!b).map((b) => ({ id: b.id, name: b.name, chief: b.chief }));
    const lead = groupLead(g, members);
    return { ...g, members, ...(lead ? { lead: lead.name } : {}) };
  }

  /** The caller's groups (every group for a chief). */
  listGroups(a: AgentContext): MethodResult<'agent.groups.list'> {
    const me = this.bot(a);
    return this.ctx.s.groups.list().filter((g) => me.chief || g.botIds.includes(me.id)).map((g) => this.groupView(g));
  }

  /** Post to a group from the caller's own chat (in a group turn its reply is posted by itself). */
  postToGroup(a: AgentContext, ref: string, text: string): MethodResult<'agent.groups.post'> {
    // inside a group's conversation the reply is the post (and counts toward the room's pause); a second way in would
    // skip both
    if (this.ctx.s.threads.get(a.threadId)?.source === 'group') throw new RpcError('invalid_params', 'You are in the group’s conversation: your reply is posted to the room by itself. Write what you want to say there.');
    return this.ctx.s.groups.postAsBot(a.botId, ref, text);
  }

  /** Make a group, once the user allows it. */
  async createGroup(a: AgentContext, p: MethodParams<'agent.groups.create'>): Promise<MethodResult<'agent.groups.create'>> {
    const me = this.bot(a);
    const members = [...new Set(p.botIds)].map((id) => this.ctx.s.bots.require(id));
    const lead = p.leadId ? this.ctx.s.bots.require(p.leadId) : members.find((b) => b.chief);
    const lines = [`${me.name} wants to make a group, ${p.name.trim()}:`, '', `Members: ${members.map((b) => b.name).join(', ')}`, lead ? `Lead: ${lead.name}` : 'No lead: the user\'s messages go to every member'];
    const { answer } = await this.ask(a, lines.join('\n'), [ALLOW, DONT_ALLOW], 600);
    if (answer?.trim().toLowerCase() !== ALLOW.toLowerCase()) throw new RpcError('forbidden', `${answer === null ? "The user didn't answer" : "The user didn't allow it"}, so the group was not made`);
    return this.ctx.s.groups.create({ name: p.name, botIds: members.map((b) => b.id), ...(p.leadId ? { leadId: p.leadId } : {}) });
  }

  private agentName(providerId: string): string {
    return this.ctx.s.providers.list().find((p) => p.id === providerId)?.name ?? providerId;
  }

  /** Agents a bot can run on: installed and switched on (profiles too). */
  private agentChoices(): MethodResult<'agent.bots.get'>['agents'] {
    return this.ctx.s.providers.list()
      .filter((p) => p.installed && p.enabled)
      .map((p) => ({ id: p.id, name: p.name, ...(p.auth?.account ? { account: p.auth.account } : {}), loggedIn: p.auth?.state !== 'logged_out' && p.authStatus !== 'needs_auth' }));
  }


  private async detail(a: AgentContext, bot: Bot): Promise<MethodResult<'agent.bots.get'>> {
    const { autoApprove: _a, emoji: _e, ...rest } = bot;
    const chat = this.chatOf(bot.id);
    const apps = this.ctx.s.composioFor(this.ctx.s.logins.scopeOfBot(bot)).connectedSlugs();
    const worn = this.ctx.s.characters.get(bot.characterId);
    return {
      // computer use is macOS only for now: elsewhere no bot has it, whatever it was set to
      bot: computerUseSupported(process.platform) ? rest : { ...rest, computerUse: false }, isYou: bot.id === a.botId, agent: this.agentName(bot.providerId),
      models: chat?.models ?? [], efforts: chat?.efforts ?? [], fastAvailable: chat?.fastAvailable ?? false,
      modes: (chat?.modes ?? []).map((m) => ({ id: m.id, name: m.name, ...(m.description ? { description: m.description } : {}) })),
      agents: this.agentChoices(),
      apps: apps.map((slug) => ({ slug, name: this.ctx.s.composio.appName(slug), on: appOn(bot, slug) })),
      defaultAgentId: this.ctx.s.settings.get().defaultProviderId,
      ...(worn ? { character: { id: worn.id, name: worn.name } } : {}),
      characters: this.ctx.s.characters.list().map((c) => ({ id: c.id, name: c.name })),
    };
  }

  getBot(a: AgentContext, id?: string): Promise<MethodResult<'agent.bots.get'>> {
    return this.detail(a, this.ctx.s.bots.require(id ?? a.botId));
  }

  /**
   * A card the user allows or not, in the caller's chat (a bot made or changed, a routine's change): the apps show its
   * rows and fields and send them back (`onSubmit`, checked by `read`, which may throw to keep the card open); Telegram's
   * buttons and older apps answer in words, where "Allow" takes it as proposed (`null`). Anything else is a refusal.
   */
  private async allowCard<T>(a: AgentContext, question: string, form: QuestionForm, what: string, read: (values: FormValues) => T, done: (r: T) => string): Promise<T | null> {
    let got: { value: T } | undefined;
    const o = await this.open(a, { question, options: [ALLOW, DONT_ALLOW], form }, 600, (sub) => {
      const values = cleanFormValues(form.fields, sub.values);
      const problems = formProblems(form, values);
      const first = Object.keys(problems)[0];
      if (first) throw new RpcError('invalid_params', `${form.fields.find((f) => f.id === first)?.label ?? first}: ${problems[first]}`, { problems });
      const value = read(values);
      got = { value };
      return { answer: done(value), values };
    });
    if (got) return got.value;
    if (o?.answer?.trim().toLowerCase() === ALLOW.toLowerCase() && !o.declined) return null;
    throw new RpcError('forbidden', `${o === null ? "The user didn't answer" : "The user didn't allow it"}, so ${what} was not saved`);
  }

  /**
   * The bot proposes a goal to work on by itself in this chat (\`start_goal\`): an Allow card with the objective and
   * its turns, which the user may change before allowing it; once allowed AppuBot keeps the bot going after each turn
   * (\`GoalsService\`). One goal at a time per chat; none in a group's thread.
   */
  async startGoal(a: AgentContext, p: MethodParams<'agent.goal.start'>): Promise<MethodResult<'agent.goal.start'>> {
    if (!a.threadId) throw new RpcError('invalid_params', 'A goal runs in a chat: start it from one');
    const thread = this.ctx.s.threads.require(a.threadId);
    if (thread.source === 'group' && thread.groupId) return this.startGroupGoal(a, thread.groupId, thread.groupChatId ?? thread.groupId, p);
    if (thread.goal?.status === 'active') throw new RpcError('invalid_params', `A goal is already on in this chat: "${thread.goal.objective}". Call finish_goal first.`);
    const maxTurns = Math.min(GOAL_TURNS_MAX, Math.max(1, p.maxTurns ?? GOAL_TURNS_DEFAULT));
    const form: QuestionForm = { kind: 'goal', fields: goalCardFields(p.objective, maxTurns), goal: { objective: p.objective, maxTurns, ...(p.hours ? { hours: p.hours } : {}) } };
    const read = (v: FormValues) => {
      const objective = String(v.objective ?? '').trim();
      if (!objective) throw new RpcError('invalid_params', 'The goal needs a few words', { problems: { objective: 'Say what it should get done' } });
      const n = Math.round(Number(v.turns));
      if (!Number.isFinite(n) || n < 1 || n > GOAL_TURNS_MAX) throw new RpcError('invalid_params', `Turns: 1 to ${GOAL_TURNS_MAX}`, { problems: { turns: `1 to ${GOAL_TURNS_MAX}` } });
      return { objective, maxTurns: n };
    };
    const picked = await this.allowCard(a, 'Work on this until it’s done?', form, 'the goal', read, (r) => `Allowed: up to ${r.maxTurns} turns`);
    const goal = this.ctx.s.goals.start(a.threadId, picked?.objective ?? p.objective, picked?.maxTurns ?? maxTurns, p.hours);
    return { goal };
  }

  /**
   * A group's own goal, proposed from a member's group thread (\`start_goal\` there): only the lead may, when the group
   * has one. Its card shows in the room; its budget counts the bots' messages.
   */
  private async startGroupGoal(a: AgentContext, groupId: string, chatId: string, p: MethodParams<'agent.goal.start'>): Promise<MethodResult<'agent.goal.start'>> {
    const groups = this.ctx.s.groups;
    const g = groups.require(groupId);
    const bots = g.botIds.map((id) => this.ctx.s.bots.get(id)).filter((b): b is Bot => !!b);
    const lead = groupLead(g, bots.map((b) => ({ id: b.id, name: b.name, chief: b.chief })));
    if (lead && lead.id !== a.botId) throw new RpcError('forbidden', `Only ${lead.name}, who leads ${g.name}, sets its goal: suggest it to @${lead.name}`);
    const maxTurns = Math.min(GOAL_TURNS_MAX, Math.max(1, p.maxTurns ?? GROUP_GOAL_MESSAGES_DEFAULT));
    const form: QuestionForm = { kind: 'goal', fields: goalCardFields(p.objective, maxTurns, 'messages'), goal: { objective: p.objective, maxTurns, ...(p.hours ? { hours: p.hours } : {}) } };
    const read = (v: FormValues) => {
      const objective = String(v.objective ?? '').trim();
      if (!objective) throw new RpcError('invalid_params', 'The goal needs a few words', { problems: { objective: 'Say what the group should get done' } });
      const n = Math.round(Number(v.turns));
      if (!Number.isFinite(n) || n < 1 || n > GOAL_TURNS_MAX) throw new RpcError('invalid_params', `Messages: 1 to ${GOAL_TURNS_MAX}`, { problems: { turns: `1 to ${GOAL_TURNS_MAX}` } });
      return { objective, maxTurns: n };
    };
    const picked = await this.allowCard(a, `Let ${g.name} work on this until it’s done?`, form, 'the goal', read, (r) => `Allowed: up to ${r.maxTurns} messages`);
    return { goal: groups.startGoal(groupId, chatId, picked?.objective ?? p.objective, picked?.maxTurns ?? maxTurns, p.hours) };
  }

  /** The bot ends its goal (\`finish_goal\`): done, or blocked on the user; in a group thread, the group's. */
  finishGoal(a: AgentContext, p: MethodParams<'agent.goal.finish'>): MethodResult<'agent.goal.finish'> {
    if (!a.threadId) throw new RpcError('invalid_params', 'No goal: this isn\'t a chat');
    const thread = this.ctx.s.threads.require(a.threadId);
    if (thread.source === 'group' && thread.groupId) return { goal: this.ctx.s.groups.finishGoal(thread.groupId, thread.groupChatId ?? thread.groupId, p.status, p.note ?? '') };
    return { goal: this.ctx.s.goals.finish(a.threadId, p.status, p.note ?? '') };
  }

  /**
   * Through \`bots.update\`, so its CLAUDE.md, the UIs and its session follow (its agent picks the rest up next turn).
   * The user says yes first, in the caller's chat, to what grants abilities (computer use or apps turned on, Bypass
   * permissions, another agent) and to another bot's name, job or instructions (that bot's orders); looks, models,
   * efforts, fast mode, modes and turning things off apply at once.
   */
  async updateBot(a: AgentContext, id: string | undefined, patch: MethodParams<'agent.bots.update'>['patch']): Promise<MethodResult<'agent.bots.update'>> {
    const bot = this.ctx.s.bots.require(id ?? a.botId);
    const { appsTurnOn = [], appsTurnOff = [], ...rest } = patch;
    const p: Partial<Bot> = { ...rest };
    if (p.computerUse === true) noComputerUseHere();
    if (p.name !== undefined) {
      p.name = cleanBotName(p.name);
      if (!p.name) throw new RpcError('invalid_params', 'A bot needs a name');
    }
    const chat = this.chatOf(bot.id);
    // a character from the user's library ('' takes it off: the bot wears its shape again); a new shape shows, so it
    // takes the character off
    if (p.shape !== undefined && p.characterId === undefined && bot.characterId) p.characterId = '';
    if (p.characterId) {
      const all = this.ctx.s.characters.list();
      if (!all.some((c) => c.id === p.characterId)) {
        throw new RpcError('invalid_params', all.length
          ? `No character "${p.characterId}". Characters: ${all.map((c) => `${c.id} (${c.name})`).join(', ')}`
          : 'There are no characters yet: the user makes them in the bot\'s settings (Look › Generate or Import).');
      }
    }
    if (p.providerId !== undefined && p.providerId !== bot.providerId) {
      const choices = this.agentChoices();
      if (!choices.some((c) => c.id === p.providerId)) {
        throw new RpcError('invalid_params', `No agent "${p.providerId}" to run on. Agents: ${choices.map((c) => `${c.id} (${c.name})`).join(', ')}`);
      }
      // a model or mode of the old agent means nothing to the new one
      delete p.modelId; delete p.modeId;
    }
    const sameAgent = p.providerId === undefined || p.providerId === bot.providerId;
    if (p.modelId !== undefined && sameAgent) {
      const models = chat?.models ?? [];
      if (!models.some((m) => m.id === p.modelId)) {
        throw new RpcError('invalid_params', models.length
          ? `${bot.name}'s agent has no model "${p.modelId}". Its models: ${models.map((m) => m.id).join(', ')}`
          : `${bot.name}'s agent hasn't listed its models yet, so its model can't be set now`);
      }
    }
    if (p.modeId !== undefined && sameAgent) {
      const modes = chat?.modes ?? [];
      if (modes.length && !modes.some((m) => m.id === p.modeId)) throw new RpcError('invalid_params', `No mode "${p.modeId}". Modes: ${modes.map((m) => m.id).join(', ')}`);
    }
    if (p.effort !== undefined && sameAgent) {
      const efforts = chat?.efforts ?? [];
      if (efforts.length && !efforts.some((e) => e.id === p.effort)) throw new RpcError('invalid_params', `No effort "${p.effort}". Efforts: ${efforts.map((e) => e.id).join(', ')}`);
    }
    if (appsTurnOn.length || appsTurnOff.length) {
      let off = bot.appsOff ?? [];
      for (const slug of appsTurnOn) off = withAppOn({ appsOff: off }, slug, true);
      for (const slug of appsTurnOff) off = withAppOn({ appsOff: off }, slug, false);
      p.appsOff = off;
    }

    const other = bot.id !== a.botId;
    const changes: FormChange[] = [];
    const none = (t: string | undefined) => t?.trim() || '(none)';
    if (other && p.name !== undefined && p.name !== bot.name) changes.push({ label: 'Name', value: p.name, was: bot.name, grants: false });
    if (other && p.job !== undefined && p.job !== bot.job) changes.push({ label: 'Job', value: none(p.job), was: none(bot.job), grants: false });
    if (other && p.instructions !== undefined && p.instructions !== bot.instructions) changes.push({ label: 'Instructions', value: none(p.instructions), was: none(bot.instructions), grants: false });
    if (p.computerUse === true && !bot.computerUse) changes.push({ label: 'Computer use', value: `On: this ${machineName(process.platform)}'s apps, mouse and keyboard`, was: 'Off', grants: true });
    const appsOn = appsTurnOn.filter((slug) => !appOn(bot, slug));
    if (appsOn.length) changes.push({ label: 'Apps', value: appsOn.map((slug) => this.ctx.s.composio.appName(slug)).join(', '), grants: true });
    if (p.modeId !== undefined && permissionChoice(bot.providerId, p.modeId) === 'bypassPermissions' && permissionChoice(bot.providerId, bot.modeId) !== 'bypassPermissions') {
      changes.push({ label: 'Permissions', value: 'Full access: runs everything without asking', was: 'Approve for me', grants: true });
    }
    if (p.providerId !== undefined && p.providerId !== bot.providerId) changes.push({ label: 'Runs on', value: this.agentName(p.providerId), was: this.agentName(bot.providerId), grants: true });
    if (p.chief === true && !bot.chief) changes.push({ label: 'Chief', value: 'Yes: messages every bot at once and leads its groups', was: 'No', grants: true });
    if (changes.length) {
      if ((p.job?.trim().length ?? 0) > STEER_MAX.job || (p.instructions?.trim().length ?? 0) > STEER_MAX.instructions) {
        throw new RpcError('invalid_params', `Too long for the user to review: keep a job under ${STEER_MAX.job} characters and instructions under ${STEER_MAX.instructions}`);
      }
      const who = other ? `${bot.name}` : 'itself';
      // a card with each change as a row (what it was, what it becomes, a shield on what grants power); the words say
      // the same for notifications, Telegram and older apps
      const lines = changes.map((c) => `• ${c.label}: ${c.value}${c.was ? ` (was ${c.was})` : ''}`);
      const form: QuestionForm = {
        kind: 'bot', fields: [],
        bot: { action: 'update', name: p.name ?? bot.name, color: p.color ?? bot.color, shape: p.shape ?? bot.shape, ...(bot.characterId ? { characterId: p.characterId ?? bot.characterId } : {}), self: !other, changes },
      };
      await this.allowCard(a, [`${this.bot(a).name} wants to change ${who}:`, '', ...lines].join('\n'), form, `this update to ${bot.name}`, () => undefined, () => 'Allowed');
    }
    return this.detail(a, this.ctx.s.bots.update(bot.id, p));
  }

  /** A new bot, once the user allows it. It starts quiet (no greeting: the user isn't in its chat). */
  async createBot(a: AgentContext, p: MethodParams<'agent.bots.create'>): Promise<MethodResult<'agent.bots.create'>> {
    const name = cleanBotName(p.name);
    if (!name) throw new RpcError('invalid_params', 'A bot needs a name');
    const providerId = p.providerId ?? this.ctx.s.settings.get().defaultProviderId;
    const choices = this.agentChoices();
    if (!choices.some((c) => c.id === providerId)) throw new RpcError('invalid_params', `No agent "${providerId}" to run on. Agents: ${choices.map((c) => c.id).join(', ')}`);
    if ((p.job?.trim().length ?? 0) > STEER_MAX.job || (p.instructions?.trim().length ?? 0) > STEER_MAX.instructions) {
      throw new RpcError('invalid_params', `Too long for the user to review: keep the job under ${STEER_MAX.job} characters and instructions under ${STEER_MAX.instructions}`);
    }
    if (p.computerUse === true) noComputerUseHere();
    const computerUse = p.computerUse ?? false;
    const lines = [
      `${this.bot(a).name} wants to make a new bot, ${name}.`, '',
      `Runs on: ${this.agentName(providerId)}`,
      `Computer use: ${computerUse ? 'on' : 'off'}`,
      ...(p.job?.trim() ? ['', `Job: ${p.job.trim()}`] : []),
      ...(p.instructions?.trim() ? ['', 'Instructions:', p.instructions.trim()] : []),
    ];
    // a card: the bot as it would look, its setup as rows, and its name a field the user may change before allowing it
    const look = p.color && p.shape ? { color: p.color, shape: p.shape } : {};
    const form: QuestionForm = {
      kind: 'bot', fields: botCardFields(name),
      bot: {
        action: 'create', name, ...look, agent: this.agentName(providerId), computerUse, self: false, changes: [],
        ...(p.job?.trim() ? { job: p.job.trim() } : {}), ...(p.instructions?.trim() ? { instructions: p.instructions.trim() } : {}),
      },
    };
    const picked = await this.allowCard(a, lines.join('\n'), form, `the new bot ${name}`, (values) => {
      const n = cleanBotName(typeof values.name === 'string' ? values.name : '');
      if (!n) throw new RpcError('invalid_params', 'Name: a bot needs a name', { problems: { name: 'Required' } });
      return n;
    }, (n) => `Allowed: ${n}`);
    const bot = this.ctx.s.bots.create({ ...p, name: picked ?? name, providerId, computerUse }, { ...(this.bot(a).memberId ? { memberId: this.bot(a).memberId } : {}) });
    return this.detail(a, bot);
  }

  /* ------------------------------------------------------------------ routines */

  private withWhen<T extends { schedule: string }>(r: T): T & { when: string } { return { ...r, when: cronToHuman(r.schedule) }; }

  private routineOf(a: AgentContext, id: string) {
    const r = this.ctx.s.routines.list().find((x) => x.id === id);
    if (!r) throw new RpcError('not_found', `No routine ${id}. list_routines shows them.`);
    void a;
    return r;
  }

  /** A bot's routines (its own without `botId`), each with its schedule in words. */
  listRoutines(a: AgentContext, botId?: string): MethodResult<'agent.routines.list'> {
    const id = this.ctx.s.bots.require(botId ?? a.botId).id;
    return this.ctx.s.routines.list().filter((r) => r.botId === id).map((r) => this.withWhen(r));
  }

  /** A new routine, once the user allows it: it will send `prompt` to the bot on `schedule` without anyone asking. */
  async createRoutine(a: AgentContext, p: MethodParams<'agent.routines.create'>): Promise<MethodResult<'agent.routines.create'>> {
    const bot = this.ctx.s.bots.require(p.botId ?? a.botId);
    if (!p.name.trim() || !p.prompt.trim()) throw new RpcError('invalid_params', 'A routine needs a name and a prompt');
    if (p.prompt.length > STEER_MAX.instructions) throw new RpcError('invalid_params', `Keep the prompt under ${STEER_MAX.instructions} characters so the user can review it`);
    validateCron(p.schedule);
    const deliverTo = p.deliverTo === 'thread' ? 'thread' : 'notify';
    const prompt = p.prompt.trim();
    // a card: the schedule as fields the user can adjust (the time, the days) before allowing it; Telegram and older
    // apps answer in words, where "Allow" takes it as proposed
    const form: QuestionForm = {
      kind: 'routine',
      fields: routineFormFields({ name: p.name.trim(), schedule: p.schedule, deliverTo }),
      routine: { prompt, schedule: p.schedule, action: 'create', changes: [], ...(bot.id === a.botId ? {} : { forBot: bot.name }) },
    };
    const question = `${this.bot(a).name} wants to set up a routine${bot.id === a.botId ? '' : ` for ${bot.name}`}: ${p.name.trim()} (${cronToHuman(p.schedule)})`;
    let made: ReturnType<typeof this.ctx.s.routines.create> | undefined;
    const create = (o: { name: string; schedule: string; deliverTo: 'notify' | 'thread' }) => {
      made = this.ctx.s.routines.create({ botId: bot.id, name: o.name, prompt, schedule: o.schedule, deliverTo: o.deliverTo, ...(p.enabled !== undefined ? { enabled: p.enabled } : {}) });
      return made;
    };
    const o = await this.open(a, { question, options: [ALLOW, DONT_ALLOW], form }, 600, (sub) => {
      const values = cleanFormValues(form.fields, sub.values);
      const read = routineFormSpec(values);
      if ('problems' in read) {
        const first = Object.keys(read.problems)[0]!;
        throw new RpcError('invalid_params', `${form.fields.find((f) => f.id === first)?.label ?? first}: ${read.problems[first]}`, { problems: read.problems });
      }
      const schedule = routineFormCron(read.spec);
      if (!validateCron(schedule)) throw new RpcError('invalid_params', 'Schedule: this never runs', { problems: { cron: 'Never runs' } });
      const r = create({ name: read.name, schedule, deliverTo: read.deliverTo });
      return { answer: `Allowed: ${r.name}, ${cronToHuman(r.schedule)}`, values };
    });
    if (!made) {
      // in words (Telegram's buttons, an older app): "Allow" takes the routine as proposed
      if (o?.answer?.trim().toLowerCase() === ALLOW.toLowerCase() && !o.declined) create({ name: p.name.trim(), schedule: p.schedule, deliverTo });
      else throw new RpcError('forbidden', `${o === null ? "The user didn't answer" : "The user didn't allow it"}, so the routine ${p.name.trim()} was not set up. Don't set it up another way.`);
    }
    return this.withWhen(made!);
  }

  /**
   * Change a routine. What it runs or when, and turning it on, wait for the user's "Allow"; a new name, where its
   * results go, or turning it off apply at once.
   */
  async updateRoutine(a: AgentContext, id: string, patch: MethodParams<'agent.routines.update'>['patch']): Promise<MethodResult<'agent.routines.update'>> {
    const r = this.routineOf(a, id);
    if (patch.schedule !== undefined) validateCron(patch.schedule);
    if (patch.prompt !== undefined && patch.prompt.length > STEER_MAX.instructions) throw new RpcError('invalid_params', `Keep the prompt under ${STEER_MAX.instructions} characters so the user can review it`);
    const prompt = patch.prompt?.trim();
    const changes: FormChange[] = [];
    if (prompt !== undefined && prompt !== r.prompt) changes.push({ label: 'It will send', value: prompt, was: r.prompt, grants: false });
    if (patch.schedule !== undefined && patch.schedule.trim() !== r.schedule) changes.push({ label: 'When', value: cronToHuman(patch.schedule), was: cronToHuman(r.schedule), grants: false });
    if (patch.enabled === true && !r.enabled) changes.push({ label: 'Turned on', value: 'On', was: 'Off', grants: false });
    let adjusted: Partial<typeof patch> = {};
    if (changes.length) {
      // the same card as a new routine's, with the change's rows: the user may adjust the new schedule before allowing
      // it; Telegram's buttons and older apps allow it as proposed
      const schedule = patch.schedule ?? r.schedule;
      const bot = this.ctx.s.bots.list().find((b) => b.id === r.botId);
      const form: QuestionForm = {
        kind: 'routine',
        fields: routineFormFields({ name: patch.name ?? r.name, schedule, deliverTo: patch.deliverTo ?? r.deliverTo }),
        routine: { prompt: prompt ?? r.prompt, schedule, action: 'update', changes, ...(bot && bot.id !== a.botId ? { forBot: bot.name } : {}) },
      };
      const lines = changes.map((c) => `• ${c.label}: ${c.value}${c.was ? ` (was ${c.was})` : ''}`);
      const got = await this.allowCard(a, [`${this.bot(a).name} wants to change the routine ${r.name}:`, '', ...lines].join('\n'), form, `this change to ${r.name}`, (values) => {
        const read = routineFormSpec(values);
        if ('problems' in read) {
          const first = Object.keys(read.problems)[0]!;
          throw new RpcError('invalid_params', `${form.fields.find((f) => f.id === first)?.label ?? first}: ${read.problems[first]}`, { problems: read.problems });
        }
        const cron = routineFormCron(read.spec);
        if (!validateCron(cron)) throw new RpcError('invalid_params', 'Schedule: this never runs', { problems: { cron: 'Never runs' } });
        return { name: read.name, schedule: cron, deliverTo: read.deliverTo };
      }, (o) => `Allowed: ${o.name}, ${cronToHuman(o.schedule)}`);
      if (got) adjusted = got;
    }
    const next = this.ctx.s.routines.update(id, { ...patch, ...(prompt !== undefined ? { prompt } : {}), ...adjusted });
    return this.withWhen(next);
  }

  /** Remove a routine (it stops running; nothing it already did is undone). */
  deleteRoutine(a: AgentContext, id: string): MethodResult<'agent.routines.delete'> {
    this.routineOf(a, id);
    return this.ctx.s.routines.delete(id);
  }

  /** The bot's reaction on the user's message in its own thread: \`messageId\`, else the latest one. */
  react(a: AgentContext, emoji: string | null, messageId?: string): MethodResult<'agent.react'> {
    const thread = this.ctx.s.threads.require(a.threadId);
    let id = messageId;
    if (!id) {
      const recent = this.ctx.s.threads.messages(thread.id, { limit: 50 });
      id = [...recent].reverse().find((m) => m.role === 'user')?.id;
      if (!id) throw new RpcError('invalid_params', 'There is no message from the user in this thread to react to');
    }
    const msg = this.ctx.s.threads.findMessage(thread.id, id);
    if (!msg || msg.role !== 'user') throw new RpcError('invalid_params', 'You can only react to the user\'s messages in your own thread');
    this.ctx.s.chat.react(thread.id, id, 'bot', emoji);
    return { ok: true, messageId: id };
  }

  /** A page of a bot's threads as one history, as text (no images, file contents or raw tool output), oldest first. */
  botHistory(a: AgentContext, id: string | undefined, before: MethodParams<'agent.bots.history'>['before'], limit: number): MethodResult<'agent.bots.history'> {
    const bot = this.ctx.s.bots.require(id ?? a.botId);
    const page = this.ctx.s.threads.history(bot.id, { before, limit });
    return {
      messages: page.messages.map((m) => ({ id: m.id, role: m.role, createdAt: m.createdAt, via: m.via, text: transcriptText(m) })),
      hasMore: page.hasMore,
    };
  }

  shutdown(): void {
    for (const id of [...this.questions.keys()]) this.finish(id, null);
  }
}
