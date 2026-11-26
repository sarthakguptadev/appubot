/**
 * Chat: the heart of AppuBot. Owns ACP sessions per thread, maps runtime TurnOps onto
 * messages/events, queues sends, and runs the permission/approval flow.
 *
 * A bot has many threads, each with an agent session of its own (resumed with ACP session/load across restarts). A
 * send names its thread, or goes to the bot's current one (`threads.chatFor`); sending in a thread makes it current.
 * `startThread` begins a new one: a brand-new session (no resume, none of the earlier conversation), so long-running
 * bots answer fast again. What carries over is the bot's memory (MEMORY.md): every fresh session's first prompt opens
 * with it, and a thread that lost its session (resume failed, another provider, the agent died) also gets its own
 * recent turns (`conversationPreface`). When the user leaves a thread for another, its idle agent is asked in a hidden
 * turn (nothing reaches the chat) what to remember; a bot keeps at most `LIVE_THREADS_PER_BOT` agents running.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyDelta, computerUseSupported, currentChat, hasPermissionModes, freeModelsToTry, isFreeAgent, isRetiredModel, learntRetiredModels, nextFreeModel, noteRetiredModel, providerBase, retiredModelError, messagePreview, newId, setPart, threadActiveAt, ToolKind, type Bot, type Message, type MethodParams, type Part, type PermissionRequest, type Thread } from '@appubot/protocol';
import { AGENT_IMAGE_TYPES, FollowUpsStream, IMAGE_FIT_DIM, IMAGE_MAX_BASE64, IMAGE_SOURCE_MAX, cloudStateText, conversationPreface, fitPlan, fitsAgent, imageSize, isNothingNewRun, parseMemoryFacts, providerLogin, reactionBack, splitFollowUps, withoutNoReply } from '@appubot/chat-core';
import { elicitationContent } from '@appubot/agent-runtime';
import type { ElicitationAnswer, ElicitationAsk, PermissionAsk, PromptBlock, RuntimeHooks, SessionInfo, TurnOp } from '@appubot/agent-runtime';
import type { CoreCtx } from '../context';
import type { Role } from '../auth';
import { systemDirOf } from '../context';
import type { FileRecord } from '../store';
import { writeFileAtomic } from '../store';
import { errMsg, RpcError, notFound, type Logger } from '../util';
import { agentKind } from './analytics';
import { readsInstructionFile, renderAgentInstructions, renderInstructionsPreface, renderIntroPrompt, renderMemorySavePrompt, renderThreadOpenPrompt } from './bots';
import { buildBridgeServer } from './bridgeEnv';
import { actsInAccounts, isOwnTool, isSetupTool, pickAllowOnce, pickReject } from './policy';
import { inputCard } from './agentInput';
import { autoTitle, isDefaultTitle } from './threads';
import { RESUME_PROMPT, type ResumeThread } from './updateRestart';
import { checkCreditPick } from './credit';
import { newNoteState, takeNote, type NoteState } from './notes';

type Via = Message['via'];
type ToolCallPart = Extract<Part, { type: 'tool_call' }>;

interface Job {
  /**
   * a message the user just sent (not a routine, not one sent again after an update): mid-turn it goes into the turn
   * with `MID_JOB_HINT` before it; on an agent that can't take it, it waits for the turn to end (`steer`)
   */
  fresh?: boolean;
  /** none for a turn of AppuBot's own (a new bot's greeting): its prompt is never stored */
  userMsg?: Message;
  agentMessageId: string;
  text: string;
  images: { mimeType: string; data: string }[];
  attachments: FileRecord[];
  via: Via;
  /** no "done" notification (errors still notify) */
  quiet?: boolean;
  /** said aloud in a live conversation (voice mode): the prompt says so (`VOICE_TURN_HINT`) */
  spoken?: boolean;
  /** its reply goes after this moment (a turn of AppuBot's own that follows a notice it just posted) */
  after?: number;
  /** the bot's opening line in a new thread (`openThread`): it never notifies, not even when it fails */
  opener?: boolean;
  /** words for the agent before the message, never stored (a message from another bot or a group: who speaks, the rules) */
  preface?: string;
  /** a message from another bot (`via: 'bot'`): how many replies between bots led here (loop guard) */
  hop?: number;
}

/**
 * What a turn said aloud in voice mode tells the agent with its words (never stored on the message): answer to be
 * heard, and soon, since its first sentence is read out while it writes the rest. Worded as AppuBot's own note that
 * isn't to be talked about: as a bare "(Said by voice…)" the smaller models (OpenCode's free ones, the cloud
 * computer's default) answered the note itself ("your voice message came through, I'm answering in plain spoken
 * sentences without formatting").
 */
/**
 * What a message the user sends while the bot works tells the agent with its words (never stored on the message), on
 * an agent that takes it into the running turn: answer it, then carry on, so a question never costs the job. The answer
 * goes out with `send_message`, the one thing the chat shows before the turn's reply.
 */
export const MID_JOB_HINT = '[AppuBot: the user sent the message below while you were working. Answer it now with your send_message tool, in a line or two, then carry on with what you were doing; stop or change course only if the message asks you to. This note is from AppuBot, not the user: do not mention it.]';
export const VOICE_TURN_HINT = '[AppuBot: the user said the message below aloud and will hear your answer read out. Answer as you would speak: plain sentences, a short first one, no Markdown, lists or emoji, brief unless asked for detail. This note is from AppuBot, not the user: do not mention it, and say nothing about voice, transcription or how the message reached you unless the user asks.]';

interface ThreadRun {
  threadId: string;
  sessionId?: string;
  agentToken?: string;
  /** whether the bridge offered the apps tools when the session started ('apps'; '' without them) */
  appsKey?: string;
  /** what the bot looked like to the agent when the session started (its instructions file, computer use) */
  profileKey?: string;
  /** the session started fresh and hasn't had a prompt yet: the next one opens with the memory (and the thread's recent turns) */
  needsPreface?: boolean;
  /**
   * the agent doesn't read the bot's instructions file (`readsInstructionFile`) and hasn't been given these
   * instructions yet: the next prompt opens with them (`renderInstructionsPreface`); `changed` after it had others
   */
  needsInstructions?: { changed: boolean };
  /** a hidden turn is running (AppuBot asking what to remember): its reply collects here and nothing reaches the chat */
  hidden?: { text: string; part: number; /** the bot reacted back during it (the `react` tool) */ reacted?: boolean };
  /** turns with a user message answered since the session started or last said what to remember */
  userTurns: number;
  /** the user left this thread while it was busy: ask what to remember once it is idle */
  leaving?: boolean;
  /** the agent refused a model/mode/effort switch mid-turn: it restarts (resuming) with the pick before the next turn */
  restart?: boolean;
  /** a session being started (a warm-up and the first turn share it instead of starting two) */
  opening?: Promise<string>;
  inflight: boolean;
  queue: Job[];
  job?: Job;
  agentMsg?: Message;
  idxMap: Map<number, number>;
  /** this turn's replies before a message was steered into it (`steer`): what they started still updates there */
  earlier?: { msg: Message; idxMap: Map<number, number> }[];
  /**
   * the text the bot is writing now, read for the follow-ups block that may end it (chat-core followUps.ts): the block
   * is held back here, so it never reaches the message (`settleTail`)
   */
  tail?: { msg: Message; idxMap: Map<number, number>; partIndex: number; stream: FollowUpsStream };
  cancelled: boolean;
  /** what the bot sent on its own lately (`say`): how many more may go out, and its last one this turn */
  notes?: NoteState;
  /** the reply whose first step has started, and the wait before its opening line shows as a note (`armOpeningNote`) */
  openingNote?: { messageId: string; timer?: ReturnType<typeof setTimeout> };
  /** terminal output's throttled updates, by `<messageId>:<partIndex>` */
  termThrottle: Map<string, { last: number; timer: ReturnType<typeof setTimeout> | null; msg: Message; idx: number }>;
}

interface PendingPermission { req: PermissionRequest; resolve: (optionId: string | null) => void }

export interface TurnCompleted { threadId: string; message: Message; via: Via; status: 'complete' | 'cancelled' | 'error' }

const CONFIG_OPS = new Set(['modes', 'models', 'efforts', 'fast', 'commands', 'mode_changed', 'title']);
/** A bot's threads (Telegram chats aside) whose agents stay up: its current one and the one before; older ones are let go when idle. */
export const LIVE_THREADS_PER_BOT = 2;
/** How long a reaction waits before the bot hears of it (`answerReaction`). */
const REACTION_WAIT_MS = 3000;
/** how soon after a turn ends a reaction made during it is answered (the turn's own bookkeeping settles first) */
const REACTION_AFTER_TURN_MS = 800;
/**
 * how long a device's message id is remembered (`chat.send`/`chat.answer` `clientId`), across a restart too: longer
 * than a phone keeps a message it couldn't send yet (its outbox survives the app being closed)
 */
const CLIENT_SEND_TTL_MS = 24 * 60 * 60_000;
/** how many are remembered at most */
const CLIENT_SEND_MAX = 500;
/** What Approve for me lets an agent on AppuBot's approvals do without asking: looking, never changing. */
const APPROVED_KINDS: ReadonlySet<string> = new Set(['read', 'search', 'think']);
/** A hidden "what to remember?" turn is given up after this long. */
const HIDDEN_TURN_MS = 120_000;
/** How long a job runs past its first step before the line the bot wrote ahead of it shows as a note (`armOpeningNote`). */
export const OPENING_NOTE_AFTER_MS = 20_000;
const TERMINAL_MAX = 64 * 1024;
const TERMINAL_INTERVAL_MS = 100;

/** an attachment with sound in it (audio, or a video's track): `transcribe_audio` hears it */
const SOUND_EXT = /\.(ogg|oga|opus|m4a|mp3|wav|webm|aac|flac|mp4|mov)$/i;
const hasTerminal = (m: Message, terminalId: string): boolean =>
  m.parts.some((p) => p.type === 'tool_call' && p.content.some((c) => c.type === 'terminal' && c.terminalId === terminalId));
const isSound = (a: { mimeType: string; name: string }): boolean => /^(audio|video)\//.test(a.mimeType) || SOUND_EXT.test(a.name);

interface SentEntry { at: number; threadId?: string; userMessageId?: string; agentMessageId?: string; userMessage?: Message }

/**
 * What devices sent lately (`chat.send`, `chat.answer`), by the device and its own id for it (`clientId`), so one sent
 * again (a dropped connection, the phone's app closed and opened again) is taken once. Another device's same id is
 * another message. Kept in `<dataDir>/sent-ids.json` (0600), so it holds across a restart of AppuBot.
 */
class SentIds {
  private map = new Map<string, SentEntry>();

  constructor(private file: string, private log: Logger) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { entries?: [string, SentEntry][] };
      for (const [k, v] of raw.entries ?? []) if (typeof k === 'string' && v && Number.isFinite(v.at)) this.map.set(k, v);
    } catch { /* none yet */ }
  }

  static key(device: string, clientId: string): string { return `${device}\n${clientId}`; }

  get(key: string, now = Date.now()): SentEntry | undefined {
    const e = this.map.get(key);
    return e && now - e.at <= CLIENT_SEND_TTL_MS ? e : undefined;
  }

  note(key: string, entry: SentEntry): void {
    this.map.delete(key);
    this.map.set(key, entry);
    // oldest first (insertion order): the expired ones, and past the cap the oldest
    for (const [k, e] of this.map) if (entry.at - e.at > CLIENT_SEND_TTL_MS || this.map.size > CLIENT_SEND_MAX) this.map.delete(k); else break;
    try { writeFileAtomic(this.file, JSON.stringify({ entries: [...this.map] }), 0o600); }
    catch (e) { this.log.warn('saving sent message ids failed', errMsg(e)); }
  }
}

/** A sent message as remembered for a device sending it again: pictures' bytes left out (the thread has them). */
const lightMessage = (m: Message): Message => ({ ...m, parts: m.parts.map((p) => (p.type === 'image' && p.data ? { ...p, data: '' } : p)) });

export class ChatService {
  private runs = new Map<string, ThreadRun>();
  /** shutting down: the queue waits (`shutdown`) */
  private closing = false;
  private sessionToThread = new Map<string, string>();
  private earlyOps = new Map<string, TurnOp[]>();
  /** sessions AppuBot runs for itself (drawing a character): their ops go to the listener, never to a chat */
  private sideSessions = new Map<string, (op: TurnOp) => void>();
  private pending = new Map<string, PendingPermission>();
  private completedListeners = new Set<(e: TurnCompleted) => void>();
  /** the user's reactions on a thread's replies the bot hasn't heard about yet */
  private reactionNotes = new Map<string, { messageId: string; emoji: string; preview: string }[]>();
  /** a reaction waits this long before the bot hears of it, so a quick change of mind (or a few at once) is one turn */
  private reactionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  readonly hooks: RuntimeHooks;
  /** `OPENING_NOTE_AFTER_MS`, shorter in tests */
  openingNoteAfterMs = OPENING_NOTE_AFTER_MS;
  /** what devices sent lately, by their own ids (`clientId`) */
  private sentIds: SentIds;
  /** the free models this computer learnt are retired (`learnRetired`) */
  private retiredFile: string;

  constructor(private ctx: CoreCtx) {
    this.sentIds = new SentIds(join(systemDirOf(ctx.paths), 'sent-ids.json'), ctx.log);
    this.retiredFile = join(systemDirOf(ctx.paths), 'retired-models.json');
    try {
      const saved = JSON.parse(readFileSync(this.retiredFile, 'utf8')) as { models?: unknown };
      if (Array.isArray(saved.models)) for (const id of saved.models) if (typeof id === 'string') noteRetiredModel(id);
    } catch { /* none learnt yet */ }
    // a reaction made while the bot was working is answered once that turn ends (`answerReaction`)
    this.onTurnCompleted((e) => {
      if (!this.reactionNotes.get(e.threadId)?.length || this.reactionTimers.has(e.threadId)) return;
      const t = setTimeout(() => { this.reactionTimers.delete(e.threadId); void this.answerReaction(e.threadId); }, REACTION_AFTER_TURN_MS);
      t.unref?.();
      this.reactionTimers.set(e.threadId, t);
    });
    // message events carry the message's revision (`Message.rev`), stamped on the stored copy (the newest is last)
    ctx.bus.trackRevisions((threadId, messageId) => {
      const list = ctx.store.threads.getMessages(threadId);
      for (let i = list.length - 1; i >= 0; i--) if (list[i]!.id === messageId) return list[i];
      return undefined;
    });
    this.hooks = {
      requestPermission: (ask) => this.onPermission(ask),
      requestInput: (ask) => this.onInput(ask),
      onTurnOp: (sid, op) => {
        const side = this.sideSessions.get(sid);
        if (side) { try { side(op); } catch (e) { this.ctx.log.error('side session op failed', errMsg(e)); } return; }
        try { this.onTurnOp(sid, op); } catch (e) { this.ctx.log.error('turn op failed', errMsg(e)); }
      },
      onSessionState: (info) => this.onSessionState(info),
      log: (level, msg, meta) => this.ctx.log[level](`[runtime] ${msg}`, meta),
      secretEnv: (providerId, scope) => this.ctx.s.providers.secretEnv(providerId, scope),
      // a sign-in the user started (Antigravity's Google page): in their own browser
      openAuthUrl: (_providerId, url) => void Promise.resolve(this.ctx.deps.openExternal(url)).catch((e) => this.ctx.log.warn('opening a sign-in page failed', errMsg(e))),
    };
    // the default bot says hello once the first-run setup is done (greet skips bots that have talked already)
    ctx.s.settings.onChange((next, prev) => {
      if (!prev.onboarded && next.onboarded) for (const b of ctx.s.bots.list()) this.greet(b.id);
    });
  }

  /**
   * A session of AppuBot's own, not a chat's (characters.ts): what it says goes to `fn` alone. Its permission requests
   * are refused like any session's that isn't a chat's (`onPermission`). Returns the unsubscribe.
   */
  listenSession(sessionId: string, fn: (op: TurnOp) => void): () => void {
    this.sideSessions.set(sessionId, fn);
    return () => { if (this.sideSessions.get(sessionId) === fn) this.sideSessions.delete(sessionId); };
  }

  onTurnCompleted(fn: (e: TurnCompleted) => void): () => void {
    this.completedListeners.add(fn);
    return () => this.completedListeners.delete(fn);
  }

  private run(threadId: string): ThreadRun {
    let r = this.runs.get(threadId);
    if (!r) {
      r = { threadId, inflight: false, queue: [], idxMap: new Map(), cancelled: false, termThrottle: new Map(), userTurns: 0 };
      this.runs.set(threadId, r);
    }
    return r;
  }

  isBusy(threadId: string): boolean { return !!this.runs.get(threadId)?.inflight; }
  /** The turn running in a thread: whose message it answers (`via`, `from`) and how deep a bots' exchange it is (`hop`). */
  runningJob(threadId: string): { via: Via; from?: Message['from']; hop?: number } | undefined {
    const job = this.runs.get(threadId)?.job;
    return job ? { via: job.via, from: job.userMsg?.from, hop: job.hop } : undefined;
  }
  /** The thread's agent is in a hidden turn (AppuBot asking what to remember): nothing of it may reach the chat. */
  isHiddenTurn(threadId: string): boolean { return !!this.runs.get(threadId)?.hidden; }
  currentAgentMessage(threadId: string): Message | undefined { return this.runs.get(threadId)?.agentMsg; }

  /* ------------------------------------------------------------------ send */

  /** The thread a send goes to: the one it names (a Telegram chat's included), else the bot's current one (`chatFor`). */
  private target(p: { botId?: string; threadId?: string }): Thread {
    const threads = this.ctx.s.threads;
    if (p.threadId) {
      const named = threads.require(p.threadId);
      if (p.botId && named.botId !== p.botId) throw new RpcError('invalid_params', `Thread ${named.id} belongs to another bot`);
      return named;
    }
    if (!p.botId) throw new RpcError('invalid_params', 'botId or threadId is required');
    return threads.chatFor(this.ctx.s.bots.require(p.botId).id);
  }

  /** `quiet`: no "done" notification when the turn ends (a routine that only keeps its result in the chat) */
  /** `device`: who sent it (the gateway's device id), which a `clientId` is that device's own for */
  /** `waits`: it waits for a turn running there instead of cutting in (a task handed over from another chat) */
  send(p: MethodParams<'chat.send'>, via: Via = 'desktop', opts: { quiet?: boolean; device?: string; from?: Message['from']; preface?: string; hop?: number; routine?: Message['routine']; waits?: boolean } = {}): { userMessage: Message; agentMessageId: string } {
    // a stopped version (the version policy) takes no turns, from the app, Telegram or a routine
    this.ctx.s.appUpdate?.assertWorking();
    // sent again by a device whose connection dropped before the answer (or whose app was closed meanwhile, or after
    // AppuBot restarted): the message it already sent, not a second one
    const sentKey = p.clientId ? SentIds.key(opts.device ?? 'local', p.clientId) : undefined;
    const again = sentKey ? this.sentIds.get(sentKey) : undefined;
    if (again?.userMessageId && again.threadId && again.agentMessageId) {
      const msg = this.ctx.s.threads.findMessage(again.threadId, again.userMessageId) ?? again.userMessage;
      if (msg) return { userMessage: structuredClone(msg), agentMessageId: again.agentMessageId };
    }
    const thread = this.target(p);
    const bot = this.ctx.s.bots.require(thread.botId);
    const text = p.text ?? '';
    const attachments: FileRecord[] = (p.attachments ?? []).map((a) => {
      const rec = this.ctx.s.files.getRecord(a.id);
      if (!rec) throw notFound('File', a.id);
      return this.ctx.s.files.ensureInInbox(rec, bot, thread.id);
    });
    const images = p.images ?? [];
    const parts: Part[] = [];
    if (text.trim()) parts.push({ type: 'text', text });
    // a spoken message keeps its recording for replay; the bot gets only the words (never an attachment)
    if (p.voice) {
      const rec = this.ctx.s.files.getRecord(p.voice.recordingId);
      if (!rec) throw notFound('File', p.voice.recordingId);
      if (!text.trim()) throw new RpcError('invalid_params', 'Nothing was heard in the recording');
      parts.push({ type: 'voice', file: this.ctx.s.files.toAttachment(rec), durationMs: p.voice.durationMs, kind: 'recording', transcript: text });
    }
    for (const img of images) parts.push({ type: 'image', mimeType: img.mimeType, data: img.data });
    for (const rec of attachments) parts.push({ type: 'file', file: this.ctx.s.files.toAttachment(rec) });
    if (!parts.length) throw new RpcError('invalid_params', 'Message is empty');

    const now = Date.now();
    // the thread sent to is the bot's current one now; the one it replaces is left (a Telegram chat or a group's
    // thread never becomes current)
    if (thread.source !== 'channel' && thread.source !== 'group') this.makeCurrent(thread, now);
    const userMsg: Message = { id: newId('msg'), threadId: thread.id, role: 'user', parts, status: 'complete', via, ...(opts.from ? { from: opts.from } : {}), ...(opts.routine && via === 'routine' ? { routine: opts.routine } : {}), ...(p.clientId ? { clientId: p.clientId } : {}), createdAt: now, updatedAt: now };
    this.ctx.s.threads.addMessage(userMsg);
    if (isDefaultTitle(thread.title) && text.trim()) this.ctx.s.threads.rename(thread.id, autoTitle(text));

    // an AppuBot Cloud computer the backend paused (payment on hold, plan ended): the message is kept, and answered
    // with the reason instead of a turn (the agent never starts)
    if (!this.ctx.s.system.cloudWorking()) {
      const reply = this.cloudPausedReply(thread, userMsg, via);
      if (sentKey) this.sentIds.note(sentKey, { at: now, threadId: thread.id, userMessageId: userMsg.id, agentMessageId: reply.id, userMessage: lightMessage(userMsg) });
      return { userMessage: structuredClone(userMsg), agentMessageId: reply.id };
    }

    // "@Ledger check this" in a bot's chat: the other bots it names take it (`HandoffService`), each answer posted here
    // as that bot's message; the chat's own bot answers only when it is named too. Not a message AppuBot passes on with
    // words of its own (a hand-off itself, a group's): that one is for the bot it is sent to
    if ((via === 'desktop' || via === 'mobile') && !opts.preface) {
      const handed = this.ctx.s.handoffs?.fromUser(thread, userMsg, { images, attachments });
      if (handed && !handed.chatBot) {
        if (sentKey) this.sentIds.note(sentKey, { at: now, threadId: thread.id, userMessageId: userMsg.id, agentMessageId: handed.replyId, userMessage: lightMessage(userMsg) });
        return { userMessage: structuredClone(userMsg), agentMessageId: handed.replyId };
      }
    }

    // a voice note from Telegram is answered in writing too: only the app's voice mode is a live conversation
    const spoken = !!p.voice && via !== 'channel';
    const job: Job = {
      userMsg, agentMessageId: newId('msg'), text, images, attachments, via, ...(via !== 'routine' && via !== 'bot' && !opts.waits ? { fresh: true } : {}), ...(opts.quiet ? { quiet: true } : {}), ...(spoken ? { spoken } : {}),
      ...(opts.preface ? { preface: opts.preface } : {}), ...(opts.hop !== undefined ? { hop: opts.hop } : {}),
    };
    this.ctx.s.analytics?.capture('message_sent', { via, agent: agentKind(bot.providerId), attachments: attachments.length, images: p.images?.length ?? 0 });
    this.start(thread.id, job);
    const result = { userMessage: structuredClone(userMsg), agentMessageId: job.agentMessageId };
    if (sentKey) this.sentIds.note(sentKey, { at: now, threadId: thread.id, userMessageId: userMsg.id, agentMessageId: job.agentMessageId, userMessage: lightMessage(userMsg) });
    return result;
  }

  /**
   * The reply a paused cloud computer gives in place of a turn: a complete agent message of AppuBot's own (`via:
   * 'system'`) saying why, under the user's message. The turn listeners hear it like a finished turn, so a message
   * from Telegram gets the same line back there.
   */
  private cloudPausedReply(thread: Thread, userMsg: Message, via: Via): Message {
    const info = this.ctx.s.system.cloudInfo();
    const text = cloudStateText(info?.state ?? 'on-hold');
    const now = Math.max(Date.now(), userMsg.createdAt + 1);
    const msg: Message = { id: newId('msg'), threadId: thread.id, role: 'agent', parts: [{ type: 'text', text }], status: 'complete', stopReason: 'cloud_paused', via: 'system', createdAt: now, updatedAt: now };
    this.ctx.s.threads.addMessage(msg);
    this.ctx.s.threads.update(thread.id, { status: 'idle', lastMessagePreview: text.slice(0, 200) });
    this.ctx.bus.emit('message.completed', { threadId: thread.id, messageId: msg.id, status: 'complete', stopReason: 'cloud_paused' });
    const ev: TurnCompleted = { threadId: thread.id, message: structuredClone(msg), via, status: 'complete' };
    for (const l of this.completedListeners) {
      try { l(ev); } catch (e) { this.ctx.log.error('turn listener failed', errMsg(e)); }
    }
    return msg;
  }

  /** The user's answer to a bot's question (`chat.answer`); one sent again with the same `clientId` is taken once. */
  answer(p: MethodParams<'chat.answer'>, device = 'local'): { ok: true } {
    const key = p.clientId ? SentIds.key(device, p.clientId) : undefined;
    if (key && this.sentIds.get(key)) return { ok: true };
    const r = this.ctx.s.agentBridge.answer(p.questionId, p.answer);
    if (key) this.sentIds.note(key, { at: Date.now() });
    return r;
  }

  /** A form card filled in or turned down (`chat.answerForm`); one sent again with the same `clientId` is taken once. */
  async answerForm(p: MethodParams<'chat.answerForm'>, role: Role, device = 'local'): Promise<{ ok: true }> {
    const key = p.clientId ? SentIds.key(device, p.clientId) : undefined;
    if (key && this.sentIds.get(key)) return { ok: true };
    const r = await this.ctx.s.agentBridge.answerForm(p, role);
    if (key) this.sentIds.note(key, { at: Date.now() });
    return r;
  }

  private start(threadId: string, job: Job): void {
    const run = this.run(threadId);
    if (this.closing) { run.queue.push(job); return; }
    if (!run.inflight) { void this.runTurn(run, job); return; }
    // a message sent while the bot works goes into its turn where the agent can take it (Claude Code, Codex, OpenCode),
    // else after it; it waits in the queue until the agent says it took it, so it is never lost
    const steerable = !run.hidden && !run.queue.length && !!run.sessionId && !!job.userMsg;
    run.queue.push(job);
    // the user comes first: a hidden turn gives way (it ends cancelled and the queue moves on)
    if (run.hidden && run.sessionId) void this.ctx.runtime.cancel(run.sessionId).catch(() => undefined);
    if (steerable) void this.steer(run, job);
  }

  /**
   * Put a queued message into the running turn; from then on the bot's words go into a new reply under it. The user's
   * own message goes in with `MID_JOB_HINT`: answered in a line, and the job goes on.
   */
  private async steer(run: ThreadRun, job: Job): Promise<void> {
    let taken = false;
    // a job is in hand (not the bot's own opening line, which just gives way to what the user wrote)
    const midJob = !!job.fresh && !run.job?.opener;
    const blocks = this.buildBlocks(midJob ? { ...job, preface: job.preface ? `${MID_JOB_HINT}\n${job.preface}` : MID_JOB_HINT } : job);
    try { taken = await this.ctx.runtime.steer(run.sessionId!, blocks); } catch (e) { this.ctx.log.warn('steering failed', errMsg(e)); }
    const i = run.queue.indexOf(job);
    // not taken by an agent that can't take messages mid-turn (Cursor, Grok, Copilot): the message waits for the turn to
    // end and runs next, so the job in hand is never cut short by a question (2026-11-26; before, the turn ended there
    // and the command it was running was killed). The chat says under the message that it waits (chat-core
    // `waitingSends`) and offers to end the turn so it is read at once (`chat.cancel` `keepQueued`). Two turns still give way as they
    // did: the bot's own opening line, and one that is itself waiting for the user (a question, an approval), which
    // would otherwise wait for an answer the user just gave in other words
    if (!taken && job.fresh && i >= 0 && run.inflight && !run.hidden) {
      if (run.job?.opener || this.ctx.s.threads.get(run.threadId)?.status === 'waiting') this.interrupt(run);
      return;
    }
    // not taken because the turn just ended: it runs as the next turn
    if (!taken || i < 0 || !run.inflight) return;
    // its answer goes out whatever the bot sent before (`say`)
    if (midJob) (run.notes ??= newNoteState(Date.now())).owed = true;
    run.queue.splice(i, 1);
    const before = run.agentMsg;
    const threads = this.ctx.s.threads;
    this.dropOpeningNote(run);
    if (before) {
      this.flushTerminals(run);
      this.settleTail(run);
      // the reply so far is done: it answered the message before
      before.status = 'complete';
      before.updatedAt = Date.now();
      (run.earlier ??= []).push({ msg: before, idxMap: run.idxMap });
      if (run.job?.userMsg) run.userTurns++;
      this.ctx.bus.emit('message.completed', { threadId: before.threadId, messageId: before.id, status: 'complete' });
      const ev: TurnCompleted = { threadId: run.threadId, message: structuredClone(before), via: run.job?.via ?? 'desktop', status: 'complete' };
      for (const l of this.completedListeners) {
        try { l(ev); } catch (e) { this.ctx.log.error('turn listener failed', errMsg(e)); }
      }
    }
    run.job = job;
    run.idxMap = new Map();
    const now = Math.max(Date.now(), (job.userMsg?.createdAt ?? 0) + 1);
    const agentMsg: Message = { id: job.agentMessageId, threadId: run.threadId, role: 'agent', parts: [], status: 'streaming', via: job.via, createdAt: now, updatedAt: now };
    run.agentMsg = agentMsg;
    threads.addMessage(agentMsg);
  }

  /* ---------------------------------------------------------------- threads */

  /**
   * A new thread for the bot, now its current one (`threads.start`). Its first turn gets a brand-new agent session,
   * started right away so it is up by the time the user has typed; the bot's memory comes with its first prompt. A
   * current thread nobody has written in yet (empty, or only the bot's opening line) is returned instead. The thread it
   * replaces is left (see `leave`). The bot opens the thread itself (`openThread`), so it never sits empty.
   */
  startThread(botId: string, source: 'desktop' | 'mobile' = 'desktop'): Thread {
    const bot = this.ctx.s.bots.require(botId);
    const threads = this.ctx.s.threads;
    const prev = currentChat(threads.conversationThreads(bot.id), bot.id);
    const prevRun = prev && this.runs.get(prev.id);
    if (prev && threads.isUntouched(prev.id) && !prevRun?.queue.length) {
      // one still empty (from before the bot opened threads, or its opening line couldn't be said then) is opened now
      this.openThread(prev, bot);
      return threads.require(prev.id);
    }
    const thread = threads.create({ botId: bot.id, source });
    if (prev) this.leave(prev);
    this.warmThread(thread, bot);
    this.openThread(thread, bot);
    return threads.require(thread.id);
  }

  /**
   * The bot says the first thing in a thread nobody has written in (the owner's call, 2026-11-17: "a thread shouldn't
   * be new any time, the agent should send a message to initiate"): a quiet turn of AppuBot's own, its prompt never
   * stored (`renderThreadOpenPrompt`: a short line, no tools). A bot nobody has talked to at all sets itself up
   * instead (`greet`). Nothing where no turn can run: an agent not installed or signed out, a stopped version, a
   * paused AppuBot computer; a message the user sends meanwhile takes the turn over like any other.
   */
  private openThread(thread: Thread, bot: Bot, recheck = true, afterSetup = false): void {
    if (!this.ctx.deps.threadOpeners || thread.source === 'channel' || thread.source === 'group') return;
    if (!this.ctx.s.threads.isEmpty(thread.id)) return;
    const run = this.run(thread.id);
    if (run.inflight || run.queue.length) return;
    if (this.ctx.s.appUpdate?.stopped || !this.ctx.s.system.cloudWorking()) return;
    if (!this.ctx.s.threads.history(bot.id, { limit: 1 }).messages.length) { this.greet(bot.id); return; }
    // asked again for what the thread and its bot are by then (a first start may move both onto another agent)
    const again = (fromSetup: boolean) => {
      const now = this.ctx.s.threads.get(thread.id);
      const still = this.ctx.s.bots.get(bot.id);
      if (now && still) this.openThread(now, still, false, fromSetup);
    };
    // OpenCode being installed or made the default right now (`freeAgent.ts`, a computer's first minutes): the opener
    // waits, as the greeting does, so it runs on the agent the bot ends up on (2026-11-18: one run on a new cloud
    // computer's Claude Code, not signed in yet, left "Claude Code: Authentication required" as a new thread's first line)
    if (!afterSetup && this.ctx.s.freeAgent?.busy()) {
      void this.ctx.s.freeAgent.settled().then(() => again(true), () => undefined);
      return;
    }
    const provider = this.ctx.s.providers.list().find((p) => p.id === thread.providerId);
    const login = provider ? providerLogin(provider).kind : 'not_installed';
    // an agent not checked yet reads as not installed or unknown: check it once, then decide (as `greet` does)
    if (provider && login !== 'logged_in' && recheck) {
      void this.ctx.s.providers.refresh([provider.id]).then(() => again(afterSetup), () => undefined);
      return;
    }
    // the opening line is a nicety: only on an agent known to be signed in, never one that may answer with an error
    if (login !== 'logged_in') return;
    this.start(thread.id, { agentMessageId: newId('msg'), text: renderThreadOpenPrompt(bot), images: [], attachments: [], via: 'system', quiet: true, opener: true });
  }

  /** One of the bot's earlier threads becomes its current one (Telegram's /chats), the one it replaces is left. */
  useThread(threadId: string): Thread {
    const thread = this.ctx.s.threads.require(threadId);
    if (thread.source === 'channel') throw new RpcError('invalid_params', 'That chat is from an older Telegram conversation and cannot be continued');
    if (thread.source === 'group') throw new RpcError('invalid_params', "That is the bot's thread for a group and cannot be continued on its own");
    this.makeCurrent(thread, Date.now());
    return this.ctx.s.threads.require(threadId);
  }

  private makeCurrent(thread: Thread, now: number): void {
    const was = currentChat(this.ctx.s.threads.conversationThreads(thread.botId), thread.botId);
    // later than the one it replaces even within the same millisecond (or with the clock set back)
    this.ctx.s.threads.markActive(thread.id, was && was.id !== thread.id ? Math.max(now, threadActiveAt(was) + 1) : now);
    if (was && was.id !== thread.id) this.leave(was);
  }

  /**
   * `thread` is no longer its bot's current one. Once its agent is idle (now, or when its turns end) it is asked in a
   * hidden turn what to remember from it, and the bot's oldest agents are let go (`trimSessions`).
   */
  private leave(thread: Thread): void {
    const run = this.runs.get(thread.id);
    if (run && (run.inflight || run.queue.length)) { run.leaving = true; return; }
    void this.wrapUp(thread.id, thread.botId);
  }

  private async wrapUp(threadId: string, botId: string): Promise<void> {
    const run = this.runs.get(threadId);
    if (run) run.leaving = false;
    try {
      // back in it already: nothing to wrap up
      if (run && currentChat(this.ctx.s.threads.conversationThreads(botId), botId)?.id !== threadId) await this.saveMemoryFrom(run);
    } catch (e) {
      this.ctx.log.warn(`asking thread ${threadId} what to remember failed`, errMsg(e));
    }
    await this.trimSessions(botId);
  }

  /**
   * Asks the thread's idle agent, in a turn nobody sees, what from it is worth remembering, and saves what it lists
   * (`renderMemorySavePrompt`: a plain-text reply, so no tool call and no approval). Only when the agent is up and
   * answered the user since it last did; a message sent to the thread meanwhile cancels it.
   */
  private async saveMemoryFrom(run: ThreadRun): Promise<void> {
    const thread = this.ctx.s.threads.get(run.threadId);
    const sid = this.liveSession(run.threadId);
    const bot = thread && this.ctx.s.bots.get(thread.botId);
    if (!thread || !bot || !sid || run.inflight || run.queue.length || run.userTurns === 0 || this.ctx.s.appUpdate?.stopped) return;
    run.inflight = true;
    run.hidden = { text: '', part: -1 };
    run.userTurns = 0;
    const timer = setTimeout(() => void this.ctx.runtime.cancel(sid).catch(() => undefined), HIDDEN_TURN_MS);
    try {
      const prompt = renderMemorySavePrompt(bot, this.ctx.s.bots.getMemory(bot.id).memory);
      const result = await this.ctx.runtime.prompt(sid, [{ type: 'text', text: prompt }]);
      if (result.stopReason === 'cancelled') return;
      let added = 0;
      for (const fact of parseMemoryFacts(splitFollowUps(run.hidden.text).text)) {
        try { if (this.ctx.s.bots.remember(bot.id, fact).added) added++; } catch { /* a fact it can't take */ }
      }
      this.ctx.log.info(`thread ${thread.id}: ${bot.name} saved ${added} new fact(s) to memory on leaving it`);
    } catch (e) {
      this.ctx.log.info(`thread ${thread.id}: asking ${bot.name} what to remember failed`, errMsg(e));
    } finally {
      clearTimeout(timer);
      run.hidden = undefined;
      run.inflight = false;
      const next = this.closing ? undefined : run.queue.shift();
      if (next && this.ctx.s.threads.get(run.threadId)) void this.runTurn(run, next);
    }
  }

  /**
   * A bot keeps the agents of its `LIVE_THREADS_PER_BOT` most recently active threads (Telegram chats aside); older
   * idle ones are let go (each agent is a process of its own). A message there later resumes its session.
   */
  private async trimSessions(botId: string): Promise<void> {
    // an agent still starting (a new thread's) counts as up
    const live = this.ctx.s.threads.conversationThreads(botId)
      .filter((t) => { const r = this.runs.get(t.id); return !!(r?.sessionId || r?.opening); })
      .sort((a, b) => threadActiveAt(b) - threadActiveAt(a) || b.createdAt - a.createdAt);
    for (const t of live.slice(LIVE_THREADS_PER_BOT)) {
      const run = this.runs.get(t.id)!;
      if (run.inflight || run.queue.length || run.opening || run.leaving || !run.sessionId) continue;
      const sid = run.sessionId;
      this.dropSession(run);
      await this.ctx.runtime.closeSession(sid).catch((e) => this.ctx.log.warn(`closing session ${sid} failed`, errMsg(e)));
    }
  }

  /**
   * A new bot speaks first: it says hello and asks what the user wants, in a turn with no user message (AppuBot's
   * prompt, never stored). Only while its conversation is empty and its agent is known to be signed in: a computer's
   * first minutes wait for Claude Code's set-up and for the free agent to take the bot over, each wait on its own, so
   * one never skips the other (2026-11-18: a new cloud computer greeted on Claude Code, just installed and not signed
   * in, and "Claude Code: Authentication required" was the bot's first word). An agent whose sign-in isn't known yet
   * is looked at once more; still not signed in, the bot says nothing (its chat opening later greets it then).
   */
  greet(botId: string, recheck = true, waited: { setup?: boolean; free?: boolean } = {}): void {
    if (this.ctx.s.appUpdate?.stopped) return;
    const bot = this.ctx.s.bots.get(botId);
    const provider = bot && this.ctx.s.providers.list().find((p) => p.id === bot.providerId);
    if (!bot || !provider) return;
    const login = providerLogin(provider).kind;
    // an AppuBot Cloud computer still setting Claude Code up (agentSetup.ts): it greets once that's done
    if (login === 'not_installed' && !waited.setup && this.ctx.s.agentSetup?.pending(provider.id)) {
      void this.ctx.s.agentSetup.ready(provider.id).then((ok) => { if (ok) this.greet(botId, true, { ...waited, setup: true }); }, () => undefined);
      return;
    }
    // OpenCode being installed or made the default right now (`freeAgent.ts`): the greeting waits, so the first bot
    // says hello on the agent it ends up on
    if (!waited.free && this.ctx.s.freeAgent?.busy()) {
      void this.ctx.s.freeAgent.settled().then(() => this.greet(botId, true, { ...waited, free: true }), () => undefined);
      return;
    }
    // an agent not checked yet (or whose sign-in isn't known): check it once, then decide
    if (login !== 'logged_in' && recheck) {
      void this.ctx.s.providers.refresh([provider.id]).then(() => this.greet(botId, false, waited), () => undefined);
      return;
    }
    if (login !== 'logged_in') return;
    if (this.ctx.s.threads.history(botId, { limit: 1 }).messages.length) return;
    const thread = this.ctx.s.threads.chatFor(botId);
    const run = this.run(thread.id);
    if (run.job?.quiet || run.queue.some((j) => j.quiet)) return;
    this.start(thread.id, { agentMessageId: newId('msg'), text: renderIntroPrompt(bot), images: [], attachments: [], via: 'system', quiet: true });
  }

  private async runTurn(run: ThreadRun, job: Job): Promise<void> {
    run.inflight = true;
    run.cancelled = false;
    run.job = job;
    run.idxMap = new Map();
    run.earlier = undefined;
    // a new turn may open as the last one did ("On it"); how often it may write carries over
    if (run.notes) { run.notes.last = undefined; run.notes.owed = false; }
    const threads = this.ctx.s.threads;
    // strictly after the prompt it answers, so ordering by time never puts a reply above its question
    const now = Math.max(Date.now(), (job.userMsg?.createdAt ?? 0) + 1, (job.after ?? 0) + 1);
    const agentMsg: Message = { id: job.agentMessageId, threadId: run.threadId, role: 'agent', parts: [], status: 'streaming', via: job.via, createdAt: now, updatedAt: now };
    run.agentMsg = agentMsg;
    try {
      threads.addMessage(agentMsg);
      threads.update(run.threadId, { status: 'running' });
      const thread = threads.require(run.threadId);
      const bot = this.ctx.s.bots.require(thread.botId);
      const sid = await this.ensureSession(run, thread, bot);
      if (run.cancelled) { this.finish(run, 'cancelled', 'cancelled'); return; }
      const blocks = this.buildBlocks(job);
      let convo: string | null | undefined;
      if (run.needsPreface) {
        run.needsPreface = false;
        // a fresh session: the thread's recent turns when it had some (its own session was lost; a new thread has
        // none, and a turn of AppuBot's own has no message to put them before), and the bot's memory first of all
        convo = job.userMsg && conversationPreface(threads.conversationBefore(thread, job.userMsg), { botName: bot.name });
        if (convo) blocks.unshift({ type: 'text', text: convo });
        const memory = this.ctx.s.bots.memoryPreface(bot);
        if (memory) blocks.unshift({ type: 'text', text: memory });
      }
      // what it missed of its own chat: tasks handed to other bots there with @Name, and their answers (the recent
      // turns above, when they came, already hold them)
      const missed = convo || run.hidden ? null : this.ctx.s.handoffs?.contextFor(thread, job.userMsg ? { beforeId: job.userMsg.id } : { skipId: job.agentMessageId });
      if (missed) blocks.unshift({ type: 'text', text: missed });
      // before everything else, who it is: for an agent that doesn't read its instructions file by itself
      if (run.needsInstructions) {
        blocks.unshift({ type: 'text', text: renderInstructionsPreface(bot, run.needsInstructions.changed, this.ctx.s.bots.instructionsOptions(bot)) });
        run.needsInstructions = undefined;
      }
      let result;
      for (let moved = false; ; moved = true) {
        try {
          result = await this.ctx.runtime.prompt(sid, blocks);
          break;
        } catch (e) {
          // a free model the server has retired (or can't run now) before a word was said: the chat moves to another
          // free one and the same message is answered there, once
          if (moved || run.cancelled || this.saidAnything(run.threadId, job.agentMessageId) || !(await this.moveOffRetired(run.threadId, errMsg(e)))) throw e;
        }
      }
      // stopped only when someone here stopped it (Stop, a newer message): an agent that ends its own turn as
      // `cancelled` (OpenCode, when a question of its own went unanswered) has simply finished what it had to say
      this.finish(run, run.cancelled ? 'cancelled' : 'complete', result.stopReason);
    } catch (e) {
      this.ctx.log.warn(`turn failed in thread ${run.threadId}`, errMsg(e));
      if (run.cancelled) this.finish(run, 'cancelled', 'cancelled');
      else this.finish(run, 'error', undefined, errMsg(e));
    } finally {
      run.inflight = false;
      run.agentMsg = undefined;
      run.earlier = undefined;
      run.job = undefined;
      const next = this.closing ? undefined : run.queue.shift();
      const thread = this.ctx.s.threads.get(run.threadId);
      if (next && thread) void this.runTurn(run, next);
      else if (run.leaving && thread) void this.wrapUp(thread.id, thread.botId);
    }
  }

  /** whether this turn's reply has shown anything yet (a retry then would say it twice) */
  private saidAnything(threadId: string, messageId: string): boolean {
    const msg = this.ctx.store.threads.getMessages(threadId).find((m) => m.id === messageId);
    return !!msg?.parts.length;
  }

  /** note a free model as retired on this computer, kept across restarts; answers whether it was new */
  private learnRetired(id: string): boolean {
    if (!noteRetiredModel(id)) return false;
    try { writeFileAtomic(this.retiredFile, JSON.stringify({ models: learntRetiredModels() })); }
    catch (e) { this.ctx.log.warn('saving the retired models failed', errMsg(e)); }
    this.ctx.log.info(`free model ${id} is retired: no chat starts on it any more`);
    return true;
  }

  /**
   * A turn on the free agent failed because its model is gone (OpenCode's own catalog can still name a model its
   * server has retired: "Model glm-5.3-flash-free has been deprecated. Use deepseek-v4.1-flash-free instead"): the
   * model is learnt as retired (dropped from every list from now on) and the chat, and its bot when the bot was on it,
   * moves to the model the server named in its place, else the best free one. Only an OpenCode model of its own is
   * moved, never one of the person's own providers. Answers whether the chat moved.
   */
  private async moveOffRetired(threadId: string, error: string): Promise<boolean> {
    const thread = this.ctx.s.threads.get(threadId);
    if (!thread || !isFreeAgent(thread.providerId)) return false;
    const what = retiredModelError(error);
    const failed = thread.modelId;
    if (!what || !failed || !failed.toLowerCase().startsWith('opencode/')) return false;
    if (what.kind === 'retired') this.learnRetired(failed);
    const next = nextFreeModel(thread.providerId, failed, thread.models ?? [], what.instead);
    if (!next) return false;
    const moved = await this.setModel(threadId, next).catch(() => undefined);
    if (!moved || moved.modelId === failed) return false;
    const bot = this.ctx.s.bots.get(thread.botId);
    if (bot?.modelId === failed) {
      try { this.ctx.s.bots.update(bot.id, { modelId: next }); } catch (e) { this.ctx.log.warn(`moving ${bot.id} off ${failed} failed`, errMsg(e)); }
    }
    this.ctx.log.info(`thread ${threadId}: ${failed} stopped answering (${what.kind}); moved to ${next} and asking again`);
    return true;
  }

  private buildBlocks(job: Job): PromptBlock[] {
    const blocks: PromptBlock[] = [];
    let text = job.text;
    if (job.attachments.length) {
      const list = job.attachments.map((a) => a.path ?? a.storedPath).join(', ');
      text = `${text}${text ? '\n\n' : ''}[The user attached ${job.attachments.length} file(s), saved in your inbox: ${list}]`;
      // the agent can't listen to a file by itself: the bridge hears it on this computer
      const sound = job.attachments.filter(isSound).map((a) => a.path ?? a.storedPath);
      if (sound.length) text += ` (audio: use transcribe_audio to hear ${sound.join(', ')})`;
    }
    if (!text.trim() && job.images.length) text = '(see the attached image)';
    if (text && job.spoken) text = `${VOICE_TURN_HINT}\n${text}`;
    if (text && job.preface) text = `${job.preface}\n${text}`;
    if (text) blocks.push({ type: 'text', text });
    // the user's reactions to earlier replies ride along with their next message (not with AppuBot's own turns)
    const note = job.userMsg ? this.takeReactionNote(job.userMsg.threadId) : undefined;
    if (note) blocks.unshift({ type: 'text', text: note });
    for (const img of job.images) blocks.push({ type: 'image', mimeType: img.mimeType, data: img.data });
    for (const a of job.attachments) {
      const p = a.path ?? a.storedPath;
      blocks.push({ type: 'resource_link', uri: pathToFileURL(p).href, name: a.name, mimeType: a.mimeType, size: a.size });
      // an attached picture (a photo from Telegram…) is also shown to the agent, as a pasted one is
      if (AGENT_IMAGE_TYPES.test(a.mimeType) && a.size <= IMAGE_SOURCE_MAX) {
        const img = this.inlineImage(a);
        if (img) blocks.push(img);
      }
    }
    return blocks;
  }

  /**
   * An attached picture as the agent sees it: as is when it fits the APIs' 5 MB (base64) and pixel limits, else shrunk
   * through the image codec down chat-core's `fitPlan` (a JPEG ≤2048px). Null when it can't: the link is enough.
   */
  private inlineImage(a: FileRecord): PromptBlock | null {
    let buf: Buffer;
    try { buf = readFileSync(a.storedPath); } catch { return null; }
    const size = imageSize(buf);
    if (fitsAgent(a.mimeType, buf.length, size)) return { type: 'image', mimeType: a.mimeType, data: buf.toString('base64') };
    const codec = this.ctx.deps.imageCodec;
    if (!codec) return null;
    const src = buf.toString('base64');
    for (const step of fitPlan(size?.width ?? IMAGE_FIT_DIM, size?.height ?? IMAGE_FIT_DIM)) {
      const out = codec.encode(src, { maxDim: Math.max(step.width, step.height), quality: step.quality });
      if (!out) return null;
      if (out.data.length <= IMAGE_MAX_BASE64) return { type: 'image', mimeType: out.mimeType, data: out.data };
    }
    return null;
  }

  private finish(run: ThreadRun, status: 'complete' | 'cancelled' | 'error', stopReason?: string, error?: string): void {
    const msg = run.agentMsg;
    if (!msg) return;
    this.flushTerminals(run);
    this.dropOpeningNote(run);
    // what the bot offered as the person's next step, with the last words of a reply it finished
    const followUps = this.settleTail(run);
    if (status === 'complete' && followUps.length) msg.followUps = followUps;
    if (error) {
      msg.parts.push({ type: 'system', text: error, level: 'error' });
      this.ctx.bus.emit('message.part', { threadId: msg.threadId, messageId: msg.id, partIndex: msg.parts.length - 1, part: msg.parts[msg.parts.length - 1]! });
      msg.error = error;
    }
    msg.status = status;
    if (stopReason) msg.stopReason = stopReason;
    msg.updatedAt = Date.now();
    if (status === 'complete' && run.job?.userMsg) run.userTurns++;
    // a routine's run with nothing to say ("✓"): the chat folds it away, so it notifies nobody, marks nothing unread
    // and doesn't become the chat's preview (chat-core `isNothingNewRun`, the rule the transcript folds by)
    const nothingNew = run.job?.via === 'routine' && !!run.job.userMsg && !run.earlier?.length && isNothingNewRun(run.job.userMsg, [msg]);
    this.ctx.bus.emit('message.completed', { threadId: msg.threadId, messageId: msg.id, status, stopReason, error, ...(nothingNew ? { nothingNew: true } : {}), ...(msg.followUps ? { followUps: [...msg.followUps] } : {}) });
    for (const [id, p] of this.pending) if (p.req.threadId === run.threadId) this.resolvePermission(id, null, 'turn-ended');

    const threads = this.ctx.s.threads;
    const thread = threads.get(run.threadId);
    // the thread went (its bot deleted mid-turn): whoever waits on the turn (a group, a bot's message) still hears
    if (!thread) { this.tellTurnEnded({ threadId: run.threadId, message: structuredClone(msg), via: run.job?.via ?? 'desktop', status }); return; }
    threads.flush(run.threadId);
    const preview = (!nothingNew && messagePreview(msg)) || (error ? `Error: ${error}` : thread.lastMessagePreview);
    threads.update(run.threadId, { status: error ? 'error' : 'idle', lastMessagePreview: preview.slice(0, 200) });
    if (error) void this.ctx.s.providers.refreshQuiet(thread.providerId);

    const via = run.job?.via ?? 'desktop';
    const bot = this.ctx.s.bots.get(thread.botId);
    // every finished turn is a notice: an OS notification while the app is away, else a toast, which the app skips
    // while that thread is on screen (renderer `events.ts`)
    if (bot && status !== 'cancelled' && !(run.job?.quiet && !error) && !run.job?.opener && !nothingNew) {
      const body = error ? `Error: ${error}` : (messagePreview(msg) || 'Done');
      this.ctx.s.notifications.notify({
        title: bot.name,
        body,
        threadId: run.threadId,
        level: error ? 'error' : 'success',
        // phones too, but never for a quiet run (a routine keeping its result in the chat) or a turn Telegram started
        // (it answers there)
        ...(!run.job?.quiet && via !== 'channel' ? { push: { kind: error ? 'failed' as const : 'done' as const, botId: bot.id, botName: bot.name, text: body } } : {}),
      });
    }
    // the plan's limits moved with this turn: Codex wrote them to its rollout, and every agent is read again a little later
    if (bot) this.ctx.s.limits.noteTurnEnd(thread.providerId, this.ctx.s.logins.scopeOfBot(bot));
    this.tellTurnEnded({ threadId: run.threadId, message: structuredClone(msg), via, status });
  }

  private tellTurnEnded(ev: TurnCompleted): void {
    for (const l of this.completedListeners) {
      try { l(ev); } catch (e) { this.ctx.log.error('turn listener failed', errMsg(e)); }
    }
  }

  /* --------------------------------------------------------------- session */

  /**
   * Start a thread's agent ahead of its first message when the composer has no models or modes to offer yet (a new
   * bot, or an agent no thread has used): they come from the agent's session. The first turn then reuses it.
   * `threadId` (the thread on screen), else the bot's current thread. `session`: whether or not it has them, so the
   * next turn finds its agent up (voice mode).
   */
  warm(botId: string, threadId?: string, o: { session?: boolean } = {}): void {
    const bot = this.ctx.s.bots.require(botId);
    const named = threadId ? this.ctx.s.threads.require(threadId) : undefined;
    if (named && named.botId !== bot.id) throw new RpcError('invalid_params', `Thread ${named.id} belongs to another bot`);
    const thread = named ?? this.ctx.s.threads.chatFor(botId);
    if (!o.session && thread.models.length && thread.modes.length) return;
    this.warmThread(thread, bot);
  }

  private warmThread(thread: Thread, bot: Bot): void {
    const run = this.run(thread.id);
    if (run.inflight || run.opening || (run.sessionId && this.ctx.runtime.getSession(run.sessionId))) return;
    void this.ensureSession(run, thread, bot).catch((e) => this.ctx.log.info(`warming ${bot.name}'s thread failed`, errMsg(e)));
  }

  /** One session start at a time per chat: concurrent callers (a warm-up, the first turn) get the same one. */
  private ensureSession(run: ThreadRun, thread: Thread, bot: Bot): Promise<string> {
    if (run.opening) return run.opening;
    const p = this.openSession(run, thread, bot).finally(() => { if (run.opening === p) run.opening = undefined; });
    run.opening = p;
    return p;
  }

  private async openSession(run: ThreadRun, thread: Thread, bot: Bot): Promise<string> {
    const rt = this.ctx.runtime;
    // an AppuBot Cloud computer setting Claude Code up (its first start, `agentSetup.ts`): a session of Claude (AppuBot
    // AI included) waits for it rather than failing with "claude was not found"; OpenCode still being installed in the
    // background (`freeAgent.ts`): its chat waits for it too. The chat may move to another agent while it waits (the free
    // agent taking a new computer's bots over), so it is read again after: a session is never opened on the agent it
    // had before (2026-11-18: a new thread's warm-up waited for Claude Code's install while the thread moved to
    // OpenCode, then opened Claude Code anyway, and the bot's greeting there said "Authentication required")
    for (let tries = 0; tries < 3; tries++) {
      const wanted = thread.providerId;
      await this.ctx.s.agentSetup?.ready(wanted);
      await this.ctx.s.freeAgent?.ready(wanted);
      thread = this.ctx.s.threads.get(thread.id) ?? thread;
      bot = this.ctx.s.bots.get(bot.id) ?? bot;
      if (thread.providerId === wanted) break;
    }
    // whether the bridge offers the apps tools: the bot may use some connected app (each call is checked against
    // its apps then, so turning one off or on needs no restart)
    // whose logins the agent runs with (§6.11): a team member's own home, keys and apps on a team's computer set so
    const scope = this.ctx.s.logins.scopeOfBot(bot);
    const apps = this.ctx.s.composioFor(scope).botApps(bot).length > 0;
    const appsKey = apps ? 'apps' : '';
    // macOS, Windows and Linux (computerUseSupported): elsewhere the bridge offers no computer tools
    const computerUse = bot.computerUse && this.ctx.s.settings.get().computer.enabled && computerUseSupported(process.platform);
    // a change of logins (the team's setting, the bot's person) restarts the agent with its conversation resumed
    const profileKey = createHash('sha256').update(`${computerUse}\n${scope}\n${renderAgentInstructions(bot, this.ctx.s.bots.instructionsOptions(bot))}`).digest('hex');
    if (run.sessionId) {
      const sid = run.sessionId;
      const info = rt.getSession(sid);
      const alive = !!info && info.state !== 'closed' && info.state !== 'error';
      if (alive && !run.restart && run.appsKey === appsKey && run.profileKey === profileKey && info.providerId === thread.providerId) return sid;
      run.restart = false;
      this.dropSession(run);
      // the bot got its first app or lost its last one since the agent started (the apps tools come or go), or its
      // profile did (instructions, job, name, computer use; a bot may set itself up mid-turn): restart
      // it, resuming the conversation, so its tools and CLAUDE.md match. Another provider starts over (primed below).
      if (alive) await rt.closeSession(sid).catch((e) => this.ctx.log.warn(`closing session ${sid} failed`, errMsg(e)));
    }
    // an AppuBot Cloud computer keeps at most `maxLiveSessions` agents up across every bot (its memory): the idle ones
    // least recently used make room; when every one is busy the turn is refused rather than the computer overcommitted
    await this.makeRoomForSession(run);
    const token = this.ctx.auth.issueAgentToken({ threadId: thread.id, botId: bot.id });
    const mcp = buildBridgeServer({
      bridgePath: this.ctx.paths.bridgePath,
      port: this.ctx.gateway.port,
      token,
      threadId: thread.id,
      botId: bot.id,
      botName: bot.name,
      computerUse,
      apps,
      cloud: !!this.ctx.deps.cloud,
      // a linked computer's files (its name is in the instructions too, so linking restarts the agent: the profile key)
      macFiles: this.ctx.s.macFiles.linkedName(),
      launcher: this.ctx.deps.bridgeLauncher,
    });
    const opts = {
      providerId: thread.providerId,
      cwd: thread.cwd || bot.workspace,
      mcpServers: [mcp],
      env: { APPUBOT_THREAD_ID: thread.id, APPUBOT_BOT_ID: bot.id },
      ...this.ctx.s.logins.loginEnv(scope),
      modeId: thread.modeId,
      // a model that has left the free tier is never asked for again: the chat starts on a free one that answers
      modelId: isRetiredModel(thread.modelId) ? undefined : thread.modelId,
      // a member answering a group that picks an effort for everyone starts on that one
      effortId: this.ctx.s.groups?.effortFor(thread) ?? bot.effort,
      fast: bot.fast,
    };
    let info: SessionInfo | undefined;
    const resumeId = thread.acpSessionId;
    try {
      // the agent says itself whether it can load a session (and starts a new one when it can't): the providers list
      // only knows that once some session has run, so it isn't asked here
      if (resumeId) {
        try {
          info = await rt.createSession({ ...opts, resumeSessionId: resumeId });
        } catch (e) {
          this.ctx.log.warn(`resume of session ${resumeId} failed; starting fresh`, errMsg(e));
        }
      }
      if (!info) info = await rt.createSession(opts);
    } catch (e) {
      this.ctx.auth.revokeAgentToken(token);
      throw e;
    }
    // The free agent with no model asked for starts on a free model known to answer, whatever OpenCode itself picked:
    // its pick may be one of the person's own providers that doesn't answer (a Copilot model failed a new install's
    // first message) or one that has left the free tier. Each is set in turn (OpenCode refuses one it doesn't have)
    // and the first that takes is kept; with none, OpenCode's own pick stands.
    if (!opts.modelId) {
      for (const want of freeModelsToTry(thread.providerId, info.currentModelId, info.models)) {
        try {
          info = await rt.setModel(info.id, want);
          break;
        } catch (e) {
          this.ctx.log.warn(`thread ${thread.id}: starting on ${want} failed`, errMsg(e));
        }
      }
    }
    // a new agent session knows nothing yet: its first prompt brings the memory (and the thread's recent turns) along
    const fresh = !resumeId || info.id !== resumeId;
    // and, to an agent that doesn't read the bot's instructions file, the instructions: on a fresh session, and on a
    // resumed one whose instructions it may not have (they changed, or this app run hasn't given them yet)
    if (!readsInstructionFile(thread.providerId) && (fresh || run.profileKey !== profileKey)) {
      run.needsInstructions = { changed: !fresh && run.profileKey !== undefined };
    }
    run.sessionId = info.id;
    run.agentToken = token;
    run.appsKey = appsKey;
    run.profileKey = profileKey;
    run.needsPreface = fresh;
    this.ctx.s.providers.sessionStarted(thread.providerId);
    if (run.needsPreface && resumeId) this.ctx.log.info(`thread ${thread.id}: session ${resumeId} could not be resumed; priming ${info.id} with its recent turns`);
    this.sessionToThread.set(info.id, thread.id);
    // what the agent reported while starting (a loaded session replays its old settings) comes first: the session's
    // state as it stands now (the model and effort it was started with included) is written after, and wins
    // (a model, effort or mode picked while the agent was starting is read before that replay, and still applies)
    const now = this.ctx.s.threads.get(thread.id);
    const early = this.earlyOps.get(info.id) ?? [];
    this.earlyOps.delete(info.id);
    for (const op of early) if (CONFIG_OPS.has(op.op) && op.op !== 'title') this.onTurnOp(info.id, op);
    if (now) info = await this.catchUp(info, thread, now);
    this.ctx.s.threads.update(thread.id, {
      acpSessionId: info.id,
      modes: info.modes,
      models: info.models,
      // commands usually arrive as an op, not with the session: keep what it already reported
      commands: info.commands.length ? info.commands : this.ctx.s.threads.get(thread.id)?.commands ?? [],
      modeId: info.currentModeId ?? thread.modeId,
      modelId: info.currentModelId ?? thread.modelId,
      efforts: info.efforts,
      effortId: info.currentEffortId,
      // fast mode only where the model offers it; elsewhere the thread keeps what was asked for
      fastAvailable: info.fastAvailable,
      ...(info.fastAvailable ? { fast: info.fastEnabled } : {}),
    }, false);
    for (const op of early) if (op.op === 'title') this.onTurnOp(info.id, op);
    this.bypassIfNoAuto(thread.id, info.id, info.currentModeId);
    return info.id;
  }

  /** Agent sessions up now (starting ones included): what `maxLiveSessions` counts. */
  liveSessionCount(): number {
    let n = 0;
    for (const run of this.runs.values()) {
      const info = run.sessionId ? this.ctx.runtime.getSession(run.sessionId) : undefined;
      if (run.opening || (info && info.state !== 'closed' && info.state !== 'error')) n++;
    }
    return n;
  }

  private async makeRoomForSession(forRun: ThreadRun): Promise<void> {
    const cap = this.ctx.deps.cloud?.maxLiveSessions;
    if (!cap || cap <= 0) return;
    const live = [...this.runs.values()].filter((r) => r !== forRun && (r.opening || (r.sessionId && this.ctx.runtime.getSession(r.sessionId)?.state !== 'closed' && this.ctx.runtime.getSession(r.sessionId)?.state !== 'error')));
    if (live.length < cap) return;
    // idle ones first, least recently active first
    const idle = live
      .filter((r) => !r.inflight && !r.queue.length && !r.opening && !r.leaving && !!r.sessionId)
      .map((r) => ({ r, at: this.ctx.s.threads.get(r.threadId)?.lastActiveAt ?? 0 }))
      .sort((a, b) => a.at - b.at);
    for (const { r } of idle) {
      if (live.length - (cap - 1) <= 0) break;
      const sid = r.sessionId!;
      this.ctx.log.info(`cloud: closing ${r.threadId}'s idle agent to stay within ${cap} sessions`);
      this.dropSession(r);
      await this.ctx.runtime.closeSession(sid).catch((e) => this.ctx.log.warn(`closing session ${sid} failed`, errMsg(e)));
      live.splice(live.indexOf(r), 1);
    }
    if (live.length >= cap) throw new RpcError('busy', `Your cloud computer is already running ${cap} bots at once. Wait for one to finish, or stop it, and try again.`);
  }

  /**
   * The cloud computer is about to stop or be recreated (payment on hold, an update, a plan change's resize): running turns get `graceMs` to finish by
   * themselves, then everything running or queued is cancelled, and queued messages are kept as cancelled replies the
   * user sees. Resolves once nothing runs. Nothing new starts meanwhile (`closing`), until `resumeAfterDrain`.
   */
  async drainForStop(graceMs: number): Promise<{ finished: boolean; cancelled: number }> {
    this.closing = true;
    const deadline = Date.now() + Math.max(0, graceMs);
    while (this.busyThreads() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(50, deadline - Date.now()))));
    const left = this.busyThreads();
    if (left) {
      this.ctx.log.info(`cloud: ${left} turn(s) still running after the grace; cancelling`);
      await this.cancelAll();
    }
    return { finished: left === 0, cancelled: left };
  }

  /** The drained computer stays up after all (the stop was called off): turns may start again. */
  resumeAfterDrain(): void {
    this.closing = false;
    for (const run of this.runs.values()) {
      if (run.inflight || !run.queue.length) continue;
      const next = run.queue.shift();
      if (next && this.ctx.s.threads.get(run.threadId)) void this.runTurn(run, next);
    }
  }

  /**
   * Permissions are Auto or Bypass only. Claude Code's adapter puts a session whose model can't do Auto on Accept edits
   * instead (AppuBot never offers that mode, so seeing it means that fallback): the chat goes to Bypass, and Auto
   * leaves its picker (the bot keeps Auto, for chats on a model that has it).
   */
  private bypassIfNoAuto(threadId: string, sessionId: string, currentModeId: string | undefined): void {
    const t = this.ctx.s.threads.get(threadId);
    if (!t || currentModeId !== 'acceptEdits' || providerBase(t.providerId) !== 'claude-code') return;
    this.ctx.log.info(`thread ${threadId}: its model has no Auto mode; running it in Bypass permissions`);
    this.ctx.s.threads.update(threadId, { modeId: 'bypassPermissions', modes: t.modes.filter((m) => m.id !== 'auto') });
    void this.ctx.runtime.setMode(sessionId, 'bypassPermissions').catch((e) => this.ctx.log.warn(`switching ${threadId} to Bypass permissions failed`, errMsg(e)));
  }

  /**
   * The thread's mode and model on the session that just started: the agent may have come up with others (a session
   * picked up while still running keeps its own, a pick may have come in while it started). An effort only when it
   * was picked meanwhile: otherwise the bot's own was asked for (and the old one may not exist for this model).
   */
  private async catchUp(info: SessionInfo, before: Thread, now: Thread): Promise<SessionInfo> {
    const rt = this.ctx.runtime;
    const apply = async (what: string, set: () => Promise<SessionInfo>) => {
      try { info = await set(); } catch (e) { this.ctx.log.warn(`applying ${now.id}'s ${what} to its agent failed`, errMsg(e)); }
    };
    if (now.modeId && now.modeId !== info.currentModeId && info.modes.some((m) => m.id === now.modeId)) await apply('mode', () => rt.setMode(info.id, now.modeId!));
    if (now.modelId && !isRetiredModel(now.modelId) && now.modelId !== info.currentModelId) await apply('model', () => rt.setModel(info.id, now.modelId!));
    if (now.effortId && now.effortId !== before.effortId && now.effortId !== info.currentEffortId && info.efforts.some((e) => e.id === now.effortId)) {
      await apply('effort', () => rt.setEffort(info.id, now.effortId!));
    }
    if (now.fast !== before.fast && info.fastAvailable && now.fast !== info.fastEnabled) await apply('fast mode', () => rt.setFast(info.id, now.fast));
    return info;
  }

  /** The chat's agent session when it is up (not closed or failed): a pick goes to it, else it waits for the next start. */
  private liveSession(threadId: string): string | undefined {
    const sid = this.runs.get(threadId)?.sessionId;
    const info = sid ? this.ctx.runtime.getSession(sid) : undefined;
    return info && info.state !== 'closed' && info.state !== 'error' ? sid : undefined;
  }

  /**
   * A pick the running agent refused: the thread keeps it and the session is let go, so the next turn starts the
   * agent again (resuming the conversation) with it, instead of carrying on with the old one.
   */
  private async keepForRestart(threadId: string, what: string, e: unknown, patch: Partial<Thread>): Promise<Thread> {
    this.ctx.log.warn(`switching ${what} on ${threadId}'s running agent failed; it restarts with it`, errMsg(e));
    const run = this.runs.get(threadId);
    if (run?.inflight) run.restart = true; // not under a running turn: before the next one
    else if (run?.sessionId) {
      const sid = run.sessionId;
      this.dropSession(run);
      await this.ctx.runtime.closeSession(sid).catch(() => undefined);
    }
    return this.ctx.s.threads.update(threadId, patch);
  }

  /**
   * Start these agents' chats again, resuming the conversation, since what they start with changed (OpenCode's custom
   * model endpoints): an idle one at once, so its model list is the new one, a busy one before its next turn.
   */
  restartAgents(match: (providerId: string) => boolean): void {
    for (const run of this.runs.values()) {
      const info = run.sessionId ? this.ctx.runtime.getSession(run.sessionId) : undefined;
      if (!info || info.state === 'closed' || info.state === 'error' || !match(info.providerId)) continue;
      run.restart = true;
      if (run.inflight || run.opening) continue;
      const thread = this.ctx.s.threads.get(run.threadId);
      const bot = thread ? this.ctx.s.bots.get(thread.botId) : undefined;
      if (thread && bot) void this.ensureSession(run, thread, bot).catch((e) => this.ctx.log.info(`restarting ${bot.name}'s agent failed`, errMsg(e)));
    }
  }

  private dropSession(run: ThreadRun): void {
    if (run.sessionId) this.sessionToThread.delete(run.sessionId);
    if (run.agentToken) this.ctx.auth.revokeAgentToken(run.agentToken);
    run.sessionId = undefined;
    run.agentToken = undefined;
  }

  private onSessionState(info: SessionInfo): void {
    if (info.state !== 'closed' && info.state !== 'error') return;
    const threadId = this.sessionToThread.get(info.id);
    if (!threadId) return;
    const run = this.runs.get(threadId);
    if (run && run.sessionId === info.id && !run.inflight) this.dropSession(run);
  }

  /* --------------------------------------------------------------- turn ops */

  private onTurnOp(sessionId: string, op: TurnOp): void {
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId) {
      // ops that arrive while the session is still being created (or replayed by session/load)
      let buf = this.earlyOps.get(sessionId);
      if (!buf) {
        if (this.earlyOps.size > 20) this.earlyOps.delete(this.earlyOps.keys().next().value!);
        buf = [];
        this.earlyOps.set(sessionId, buf);
      }
      if (CONFIG_OPS.has(op.op) && buf.length < 200) buf.push(op);
      return;
    }
    const threads = this.ctx.s.threads;
    const thread = threads.get(threadId);
    if (!thread) return;
    // a hidden turn's reply is AppuBot's to read (and its title, tools and settings nobody's)
    const hidden = this.runs.get(threadId)?.hidden;
    if (hidden) {
      if (op.op === 'delta' && op.partType === 'text') {
        if (hidden.part !== op.partIndex && hidden.text) hidden.text += '\n';
        hidden.part = op.partIndex;
        hidden.text += op.delta;
      }
      return;
    }
    switch (op.op) {
      case 'modes':
        threads.update(threadId, { modes: op.modes, modeId: op.currentModeId ?? thread.modeId }, false);
        return;
      case 'models':
        threads.update(threadId, { models: op.models, modelId: op.currentModelId ?? thread.modelId }, false);
        return;
      case 'efforts':
        threads.update(threadId, { efforts: op.efforts, effortId: op.currentEffortId }, false);
        return;
      case 'fast':
        threads.update(threadId, { fastAvailable: op.available, ...(op.available ? { fast: op.enabled } : {}) }, false);
        return;
      case 'commands':
        threads.update(threadId, { commands: op.commands }, false);
        return;
      case 'mode_changed':
        threads.update(threadId, { modeId: op.modeId }, false);
        this.bypassIfNoAuto(threadId, sessionId, op.modeId);
        return;
      case 'title':
        if (op.title.trim()) threads.update(threadId, { title: op.title.trim().slice(0, 120) }, false);
        return;
      case 'usage':
        // how full the context is (the composer's ring); only a real window size counts
        if (op.size > 0 && Number.isFinite(op.used)) {
          const was = threads.get(threadId)?.context;
          // a change under half a percent of the window isn't worth a write and an event
          if (!was || was.size !== op.size || Math.abs(was.used - op.used) >= op.size * 0.005) threads.update(threadId, { context: { used: Math.max(0, op.used), size: op.size } }, false);
        }
        return;
      case 'rateLimit': {
        // Claude Code's word on the plan's limits (the model picker's meters): laid over the agent's last snapshot
        const t = threads.get(threadId);
        if (t) this.ctx.s.limits.noteRateLimit(t.providerId, this.ctx.s.logins.scopeOfBotId(t.botId), op.info, t.modelId);
        return;
      }
      case 'user_echo':
        return;
      default:
        break;
    }
    const run = this.runs.get(threadId);
    if (!run?.agentMsg) return;
    // a part the turn started before a message was steered into it stays in that earlier reply
    const into = 'partIndex' in op ? run.earlier?.find((e) => e.idxMap.has(op.partIndex)) : undefined;
    const msg = into?.msg ?? run.agentMsg;
    const idxMap = into?.idxMap ?? run.idxMap;
    if (op.op === 'delta') {
      let delta = op.delta;
      if (op.partType === 'text' && delta) {
        // the reply's text passes through the reader of its follow-ups block: what could still become one waits
        if (run.tail && (run.tail.msg !== msg || run.tail.partIndex !== op.partIndex)) this.settleTail(run);
        run.tail ??= { msg, idxMap, partIndex: op.partIndex, stream: new FollowUpsStream() };
        delta = run.tail.stream.push(delta);
        if (!delta) return;
      } else if (op.partType !== 'text' && !idxMap.has(op.partIndex)) this.settleTail(run);
      this.applyDelta(msg, idxMap, op.partIndex, op.partType, delta);
    } else if (op.op === 'part') {
      // something new after the text (a tool, a plan): the text before it was not the reply's last words
      if (!idxMap.has(op.partIndex)) this.settleTail(run);
      const idx = this.mapIdx(idxMap, msg, op.partIndex, op.part);
      const part = this.mergeTerminalOutput(msg.parts[idx], structuredClone(op.part));
      setPart(msg, idx, part);
      this.ctx.bus.emit('message.part', { threadId, messageId: msg.id, partIndex: idx, part });
      threads.touchMessage(threadId);
      if (part.type === 'tool_call' && msg === run.agentMsg) this.armOpeningNote(run, msg, idx);
    } else if (op.op === 'terminal_output') {
      const owner = [run.agentMsg, ...(run.earlier ?? []).map((e) => e.msg)].find((m) => hasTerminal(m, op.terminalId)) ?? run.agentMsg;
      this.appendTerminal(run, owner, op.terminalId, op.chunk);
    }
  }

  /**
   * The line a bot writes before it starts on a job ("I'll pull the three reports and compare them") is what a note
   * would say, but the chat shows nothing a bot writes until its turn ends, and most models write that line rather
   * than send it (`send_message`; 2026-11-26: OpenCode's free model sent none in six real long jobs, and wrote it every
   * time). So when a reply's first step starts, the words before it are kept in mind, and if the job is still running
   * `OPENING_NOTE_AFTER_MS` later with nothing sent by the bot itself, they become a note (`said`), under the limits
   * of one it sends: no model call, and never for a quick task. In the reply to a message taken mid-job those words
   * are its answer when the bot didn't send one: they show at once. Only for a message the user wrote (not a routine,
   * a bot's message, or one said aloud, which is read out whole).
   */
  private armOpeningNote(run: ThreadRun, msg: Message, toolIdx: number): void {
    const tool = msg.parts[toolIdx];
    // Claude Code's tool lookups are no step of the job
    if (run.openingNote?.messageId === msg.id || (tool?.type === 'tool_call' && tool.title === 'ToolSearch')) return;
    const armed: NonNullable<ThreadRun['openingNote']> = { messageId: msg.id };
    run.openingNote = armed;
    if (!run.job?.fresh || run.job.spoken) return;
    // the last thing it wrote before the step
    let at = -1;
    for (let i = 0; i < toolIdx; i++) { const p = msg.parts[i]!; if (p.type === 'text' && p.text.trim()) at = i; }
    if (at < 0) return;
    const show = () => {
      const part = msg.parts[at];
      if (run.agentMsg !== msg || msg.status !== 'streaming' || part?.type !== 'text' || part.said) return;
      // the bot told the user something itself meanwhile: nothing to add
      if (msg.parts.some((p) => p.type === 'text' && p.said)) return;
      const now = Date.now();
      const text = part.text.trim();
      if (!takeNote((run.notes ??= newNoteState(now)), text, now).ok) return;
      part.said = true;
      msg.updatedAt = now;
      this.ctx.bus.emit('message.part', { threadId: msg.threadId, messageId: msg.id, partIndex: at, part: structuredClone(part) });
      this.ctx.s.threads.touchMessage(msg.threadId);
      this.ctx.s.channels.said(msg.id, text);
    };
    if (run.notes?.owed) show();
    else armed.timer = setTimeout(show, this.openingNoteAfterMs);
  }

  private dropOpeningNote(run: ThreadRun): void {
    if (run.openingNote?.timer) clearTimeout(run.openingNote.timer);
    run.openingNote = undefined;
  }

  private applyDelta(msg: Message, idxMap: Map<number, number>, runtimeIdx: number, partType: 'text' | 'thought', delta: string): void {
    const idx = this.mapIdx(idxMap, msg, runtimeIdx, { type: partType, text: '' });
    applyDelta(msg, idx, partType, delta);
    this.ctx.bus.emit('message.delta', { threadId: msg.threadId, messageId: msg.id, partIndex: idx, partType, delta });
    this.ctx.s.threads.touchMessage(msg.threadId);
  }

  /**
   * The text the bot was writing is over (something else follows it, or its turn ended): what was held back of it and
   * is no follow-ups block goes to the message after all. Returns the block's lines, for a turn that ended on them.
   */
  private settleTail(run: ThreadRun): string[] {
    const tail = run.tail;
    if (!tail) return [];
    run.tail = undefined;
    const { text, followUps } = tail.stream.end();
    if (text) this.applyDelta(tail.msg, tail.idxMap, tail.partIndex, 'text', text);
    return followUps;
  }

  private mapIdx(idxMap: Map<number, number>, msg: Message, runtimeIdx: number, placeholder: Part): number {
    let idx = idxMap.get(runtimeIdx);
    if (idx === undefined) {
      idx = msg.parts.length;
      msg.parts.push(placeholder.type === 'text' || placeholder.type === 'thought' ? { ...placeholder } : structuredClone(placeholder));
      idxMap.set(runtimeIdx, idx);
    }
    return idx;
  }

  /** Keep terminal output we accumulated when the runtime re-sends a tool_call without it. */
  private mergeTerminalOutput(prev: Part | undefined, next: Part): Part {
    if (!prev || prev.type !== 'tool_call' || next.type !== 'tool_call') return next;
    for (const c of next.content) {
      if (c.type !== 'terminal' || c.output) continue;
      const old = prev.content.find((o) => o.type === 'terminal' && o.terminalId === c.terminalId);
      if (old && old.type === 'terminal' && old.output) c.output = old.output;
    }
    if (prev.computer && !next.computer) next.computer = prev.computer;
    return next;
  }

  private appendTerminal(run: ThreadRun, msg: Message, terminalId: string, chunk: string): void {
    const idx = msg.parts.findIndex((p) => p.type === 'tool_call' && p.content.some((c) => c.type === 'terminal' && c.terminalId === terminalId));
    if (idx < 0) return;
    const part = msg.parts[idx] as ToolCallPart;
    const c = part.content.find((x) => x.type === 'terminal' && x.terminalId === terminalId);
    if (!c || c.type !== 'terminal') return;
    let out = (c.output ?? '') + chunk;
    if (out.length > TERMINAL_MAX) out = out.slice(out.length - TERMINAL_MAX);
    c.output = out;
    this.ctx.s.threads.touchMessage(msg.threadId);
    const key = `${msg.id}:${idx}`;
    let t = run.termThrottle.get(key);
    if (!t) { t = { last: 0, timer: null, msg, idx }; run.termThrottle.set(key, t); }
    const emit = () => {
      t!.timer = null;
      t!.last = Date.now();
      this.ctx.bus.emit('message.part', { threadId: msg.threadId, messageId: msg.id, partIndex: idx, part: structuredClone(msg.parts[idx]!) });
    };
    const wait = TERMINAL_INTERVAL_MS - (Date.now() - t.last);
    if (wait <= 0 && !t.timer) emit();
    else if (!t.timer) t.timer = setTimeout(emit, Math.max(0, wait));
  }

  private flushTerminals(run: ThreadRun): void {
    for (const { msg, idx, timer } of run.termThrottle.values()) {
      if (!timer) continue;
      clearTimeout(timer);
      if (msg.parts[idx]) this.ctx.bus.emit('message.part', { threadId: msg.threadId, messageId: msg.id, partIndex: idx, part: structuredClone(msg.parts[idx]!) });
    }
    run.termThrottle.clear();
  }

  /* ------------------------------------------------- parts added by AppuBot */

  /** Append a part to the thread's streaming agent message, or to a new 'system' agent message. */
  appendPart(threadId: string, part: Part): { messageId: string; partIndex: number } {
    const threads = this.ctx.s.threads;
    threads.require(threadId);
    const msg = this.runs.get(threadId)?.agentMsg;
    if (msg) {
      msg.parts.push(part);
      msg.updatedAt = Date.now();
      const partIndex = msg.parts.length - 1;
      this.ctx.bus.emit('message.part', { threadId, messageId: msg.id, partIndex, part: structuredClone(part) });
      threads.touchMessage(threadId);
      return { messageId: msg.id, partIndex };
    }
    const now = Date.now();
    const m: Message = { id: newId('msg'), threadId, role: 'agent', parts: [part], status: 'complete', via: 'system', createdAt: now, updatedAt: now };
    threads.addMessage(m);
    threads.flush(threadId);
    return { messageId: m.id, partIndex: 0 };
  }

  /**
   * A message the bot sends on its own while it works (`send_message`, `agent.say`): a bubble of its own in the reply
   * being written (`said`). Short, not too often and never its last one again (`notes.ts`): one that isn't is turned
   * down with the reason as the tool's answer. It notifies nobody: only the turn's end does (`finish`).
   */
  say(threadId: string, text: string): { messageId: string } {
    this.ctx.s.threads.require(threadId);
    const run = this.run(threadId);
    const now = Date.now();
    const verdict = takeNote((run.notes ??= newNoteState(now)), text, now);
    if (!verdict.ok) throw new RpcError('invalid_params', verdict.reason);
    return this.appendPart(threadId, { type: 'text', text, said: true });
  }

  /* --------------------------------------------------------- reactions */

  /**
   * Set (or with `emoji` null, take back) one side's reaction on a message. The user's reaction on a bot's reply goes
   * to the bot: a moment later, if its agent is up and idle, in a hidden turn of its own where it decides whether the
   * reaction needs an answer (`answerReaction`); otherwise its next turn in that thread opens with a line about it.
   */
  react(threadId: string, messageId: string, by: 'user' | 'bot', emoji: string | null): Message {
    const threads = this.ctx.s.threads;
    const run = this.runs.get(threadId);
    const msg = run?.agentMsg?.id === messageId ? run.agentMsg : threads.findMessage(threadId, messageId);
    if (!msg) throw notFound('Message', messageId);
    const clean = emoji?.trim() || null;
    // the bot's own, made while it answers a reaction: that turn then did something the person sees
    if (by === 'bot' && clean && run?.hidden) run.hidden.reacted = true;
    const before = (msg.reactions ?? []).find((r) => r.by === by)?.emoji ?? null;
    msg.reactions = [...(msg.reactions ?? []).filter((r) => r.by !== by), ...(clean ? [{ emoji: clean, by, at: Date.now() }] : [])];
    threads.touchMessage(threadId);
    this.ctx.bus.emit('message.reactions', { threadId, messageId, reactions: structuredClone(msg.reactions) });
    if (by === 'user' && msg.role === 'agent' && clean !== before) {
      const notes = (this.reactionNotes.get(threadId) ?? []).filter((n) => n.messageId !== messageId);
      if (clean) notes.push({ messageId, emoji: clean, preview: messagePreview(msg) ?? '' });
      this.reactionNotes.set(threadId, notes.slice(-5));
      clearTimeout(this.reactionTimers.get(threadId));
      if (clean) {
        const t = setTimeout(() => { this.reactionTimers.delete(threadId); void this.answerReaction(threadId); }, REACTION_WAIT_MS);
        t.unref?.();
        this.reactionTimers.set(threadId, t);
      }
    }
    return msg;
  }

  /**
   * The bot hears of the user's reactions on its own, and always answers them with something the person sees (the
   * owner's call, 2026-11-15: "when I react it should do something always"): a hidden turn (no tools but reacting back,
   * nothing streams to the chat) whose one short line is posted as its reply; a turn that only reacted back shows that
   * reaction; and one that came back with nothing puts the bot's reaction on the user's last message (`reactionBack`).
   * It is never asked for NO_REPLY any more, and that word never reaches the chat (`withoutNoReply`): a model asked
   * for it once kept saying it, once in a way the old check let through. An agent that isn't up (closed to save
   * memory, AppuBot restarted) is started for it as a message would; a busy one answers when its turn ends (the
   * constructor's turn listener). A message from the user meanwhile cancels it and takes the reaction along instead
   * (`takeReactionNote`).
   */
  private async answerReaction(threadId: string): Promise<void> {
    const thread = this.ctx.s.threads.get(threadId);
    const bot = thread && this.ctx.s.bots.get(thread.botId);
    if (!thread || !bot || !this.reactionNotes.get(threadId)?.length || this.ctx.s.appUpdate?.stopped || this.closing) return;
    const run = this.run(threadId);
    const idle = () => !run.inflight && !run.queue.length && !run.opening;
    // working, or about to: the end of that turn brings this back
    if (!idle()) return;
    let sid = this.liveSession(threadId);
    if (!sid) {
      try { sid = await this.ensureSession(run, thread, bot); } catch (e) {
        // an agent that can't start (signed out, not installed): the reaction waits for the next message
        this.ctx.log.info(`thread ${threadId}: starting ${bot.name}'s agent for a reaction failed`, errMsg(e));
        return;
      }
      if (run.inflight || run.queue.length || this.closing) return;
    }
    const notes = this.reactionNotes.get(threadId);
    if (!notes?.length) return;
    run.inflight = true;
    run.hidden = { text: '', part: -1 };
    this.reactionNotes.delete(threadId);
    const timer = setTimeout(() => void this.ctx.runtime.cancel(sid).catch(() => undefined), HIDDEN_TURN_MS);
    let keep = true;
    try {
      const each = notes.map((n) => `${n.emoji} on your reply${n.preview ? ` "${n.preview.slice(0, 120)}${n.preview.length > 120 ? '…' : ''}"` : ''}`);
      const prompt = `[AppuBot: the user just reacted ${each.join('; ')}. That is all they sent, no message. Answer it now as a person in a chat would, in one short line of your own words: a 👍 or ❤️ gets a brief, warm acknowledgement (never the same words twice in a row), a 👎 or 😕 may mean you got something wrong, so say what you'd change or ask what was off. You may also react back with the react tool. Use no other tools and start no work now. Always write the line: don't answer with nothing, and don't mention this note.]`;
      const result = await this.ctx.runtime.prompt(sid, [{ type: 'text', text: prompt }]);
      if (result.stopReason === 'cancelled') return;
      keep = false;
      const text = withoutNoReply(splitFollowUps(run.hidden.text).text);
      if (text) {
        const now = Date.now();
        this.ctx.s.threads.addMessage({ id: newId('msg'), threadId, role: 'agent', parts: [{ type: 'text', text }], status: 'complete', via: 'system', createdAt: now, updatedAt: now });
      } else if (!run.hidden.reacted) {
        // it said nothing and did nothing: its reaction on what the user last wrote, so theirs is never met with silence
        const mine = [...this.ctx.s.threads.messages(threadId, { limit: 50 })].reverse().find((m) => m.role === 'user');
        if (mine) this.react(threadId, mine.id, 'bot', reactionBack(notes[notes.length - 1]!.emoji));
      }
    } catch (e) {
      this.ctx.log.info(`thread ${threadId}: telling the bot about a reaction failed`, errMsg(e));
    } finally {
      clearTimeout(timer);
      run.hidden = undefined;
      run.inflight = false;
      // cancelled (the user wrote meanwhile): the reaction rides along with that message instead
      if (keep) this.reactionNotes.set(threadId, [...notes, ...(this.reactionNotes.get(threadId) ?? [])].slice(-5));
      const next = this.closing ? undefined : run.queue.shift();
      if (next && this.ctx.s.threads.get(run.threadId)) void this.runTurn(run, next);
    }
  }

  /** The user's reactions since the bot's last turn in a thread, as the line that opens its next prompt. */
  private takeReactionNote(threadId: string): string | undefined {
    const notes = this.reactionNotes.get(threadId);
    if (!notes?.length) return undefined;
    this.reactionNotes.delete(threadId);
    const each = notes.map((n) => `${n.emoji} on your reply${n.preview ? ` "${n.preview.slice(0, 80)}${n.preview.length > 80 ? '…' : ''}"` : ''}`);
    return `[AppuBot: since your last reply the user reacted ${each.join('; ')}. Take it as feedback; no need to mention it unless it matters.]`;
  }

  updatePart(threadId: string, messageId: string, partIndex: number, part: Part): void {
    const threads = this.ctx.s.threads;
    const msg = this.runs.get(threadId)?.agentMsg?.id === messageId ? this.runs.get(threadId)!.agentMsg! : threads.findMessage(threadId, messageId);
    if (!msg) return;
    setPart(msg, partIndex, part);
    this.ctx.bus.emit('message.part', { threadId, messageId, partIndex, part: structuredClone(part) });
    threads.touchMessage(threadId);
  }

  /* ------------------------------------------- restarting for an update */

  /** Whether a thread has a turn running (AppuBot's own hidden ones aside) or messages waiting. */
  hasWork(threadId: string): boolean {
    const run = this.runs.get(threadId);
    return !!run && ((run.inflight && !run.hidden) || run.queue.length > 0);
  }

  /** Whether a thread has messages waiting for their turn (what the turn that just ended leaves behind). */
  hasQueued(threadId: string): boolean { return (this.runs.get(threadId)?.queue.length ?? 0) > 0; }

  /**
   * A turn of AppuBot's own on a thread (a goal's next step): `text` is its prompt, never stored or shown; the bot's
   * reply shows as its message. No "done" notification.
   */
  ownTurn(threadId: string, text: string): string {
    // a stopped version, or an AppuBot computer the backend paused, runs nothing of its own
    if (this.ctx.s.appUpdate?.stopped) throw new RpcError('update_required', this.ctx.s.appUpdate.stopped.message);
    if (!this.ctx.s.system.cloudWorking()) throw new RpcError('unavailable', 'This AppuBot computer is paused');
    const agentMessageId = newId('msg');
    // after whatever the thread holds now (the notice or the answer this turn follows), which may be stamped ahead of
    // the clock: messages made within the same millisecond are stamped one after another
    const newest = this.ctx.s.threads.messages(threadId, { limit: 1 }).at(-1)?.createdAt ?? 0;
    this.start(threadId, { agentMessageId, text, images: [], attachments: [], via: 'system', after: Math.max(Date.now(), newest), quiet: true });
    return agentMessageId;
  }

  /** Threads with a turn running or waiting (AppuBot's own hidden turns aside: they give way to anything). */
  busyThreads(): number {
    let n = 0;
    for (const run of this.runs.values()) if ((run.inflight && !run.hidden) || run.queue.length) n++;
    return n;
  }

  /** Threads with work a restart would stop: the turn running now (not AppuBot's own hidden or greeting turns) and queued messages. */
  workToResume(): ResumeThread[] {
    const out: ResumeThread[] = [];
    for (const run of this.runs.values()) {
      if (!run.inflight && !run.queue.length) continue;
      const own = !!run.hidden || (!!run.job && !run.job.userMsg);
      const interrupted = run.inflight && !own ? run.job?.agentMessageId : undefined;
      const queued = run.queue.flatMap((j) => (j.userMsg ? [j.userMsg.id] : []));
      if (!interrupted && !queued.length) continue;
      out.push({ threadId: run.threadId, ...(interrupted ? { interrupted, via: run.job?.via } : {}), queued });
    }
    return out;
  }

  /**
   * After a restart for an update: each thread whose work it stopped says so, the cut-off reply is closed, the bot is
   * told (a hidden prompt) to carry on where it left off, and messages that hadn't reached it yet go to it again.
   */
  resumeAfterUpdate(work: ResumeThread[], version: string): void {
    const threads = this.ctx.s.threads;
    for (const w of work) {
      const thread = threads.get(w.threadId);
      if (!thread) continue;
      try {
        const cut = w.interrupted ? threads.findMessage(w.threadId, w.interrupted) : undefined;
        if (cut?.status === 'streaming') {
          cut.status = 'cancelled';
          cut.stopReason = 'restarted';
          cut.updatedAt = Date.now();
          threads.touchMessage(w.threadId);
          this.ctx.bus.emit('message.completed', { threadId: w.threadId, messageId: cut.id, status: 'cancelled', stopReason: 'restarted' });
        }
        const notice = this.appendPart(w.threadId, { type: 'system', text: `AppuBot updated to ${version} and picked up where it left off.`, level: 'info' });
        const at = threads.findMessage(w.threadId, notice.messageId)?.createdAt ?? Date.now();
        if (w.interrupted) {
          this.start(w.threadId, { agentMessageId: newId('msg'), text: RESUME_PROMPT, images: [], attachments: [], via: w.via === 'channel' ? 'channel' : 'system', after: at });
        }
        for (const id of w.queued) {
          const msg = threads.findMessage(w.threadId, id);
          if (msg?.role === 'user') this.start(w.threadId, this.jobFor(msg, thread.botId));
        }
      } catch (e) {
        this.ctx.log.warn(`resuming thread ${w.threadId} after the update failed`, errMsg(e));
      }
    }
  }

  /** A turn again for a user message already in the thread (one queued when AppuBot restarted). */
  private jobFor(msg: Message, botId: string): Job {
    const text = msg.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
    const images = msg.parts.flatMap((p) => (p.type === 'image' && p.data ? [{ mimeType: p.mimeType, data: p.data }] : []));
    const bot = this.ctx.s.bots.require(botId);
    const attachments = msg.parts.flatMap((p) => {
      if (p.type !== 'file') return [];
      const rec = this.ctx.s.files.getRecord(p.file.id);
      return rec ? [this.ctx.s.files.ensureInInbox(rec, bot, msg.threadId)] : [];
    });
    return { userMsg: msg, agentMessageId: newId('msg'), text, images, attachments, via: msg.via };
  }

  /* ------------------------------------------------------- cancel / close */

  /** Every thread's running and queued turns (this version was stopped: AppuBot only updates now). */
  async cancelAll(): Promise<void> {
    const busy = [...this.runs.values()].filter((r) => r.inflight || r.queue.length).map((r) => r.threadId);
    await Promise.all(busy.map((id) => this.cancel(id).catch((e) => this.ctx.log.warn(`cancelling ${id} failed`, errMsg(e)))));
  }

  /**
   * Stop (`chat.cancel`): the running turn ends, and every turn waiting behind it with it. `keepQueued`: only the
   * running turn ends, so a message waiting behind it is read now ("Stop and read now"); nothing happens when none waits.
   */
  async cancel(threadId: string, o: { keepQueued?: boolean } = {}): Promise<{ ok: true }> {
    this.ctx.s.threads.require(threadId);
    if (o.keepQueued) {
      const waiting = this.runs.get(threadId);
      if (waiting?.inflight && waiting.queue.length) this.interrupt(waiting);
      return { ok: true };
    }
    this.ctx.s.handoffs?.stopFor(threadId);
    const run = this.runs.get(threadId);
    if (!run) return { ok: true };
    for (const job of run.queue.splice(0)) {
      const now = Date.now();
      const msg: Message = { id: job.agentMessageId, threadId, role: 'agent', parts: [], status: 'cancelled', stopReason: 'cancelled', via: job.via, createdAt: now, updatedAt: now };
      this.ctx.s.threads.addMessage(msg);
      this.ctx.bus.emit('message.completed', { threadId, messageId: job.agentMessageId, status: 'cancelled', stopReason: 'cancelled' });
      // a queued turn someone waits on (a group's, a bot's message) ends here too
      this.tellTurnEnded({ threadId, message: structuredClone(msg), via: job.via, status: 'cancelled' });
    }
    if (!run.inflight) return { ok: true };
    run.cancelled = true;
    for (const [id, p] of this.pending) if (p.req.threadId === threadId) this.resolvePermission(id, null, 'cancelled');
    this.ctx.s.agentBridge.cancelQuestions(threadId);
    if (run.sessionId) await this.ctx.runtime.cancel(run.sessionId).catch((e) => this.ctx.log.warn('runtime.cancel failed', errMsg(e)));
    return { ok: true };
  }

  /** End the running turn (the queue stays and runs next). */
  private interrupt(run: ThreadRun): void {
    run.cancelled = true;
    for (const [id, p] of this.pending) if (p.req.threadId === run.threadId) this.resolvePermission(id, null, 'cancelled');
    this.ctx.s.agentBridge.cancelQuestions(run.threadId);
    if (run.sessionId) void this.ctx.runtime.cancel(run.sessionId).catch((e) => this.ctx.log.warn('runtime.cancel failed', errMsg(e)));
  }

  async closeThread(threadId: string): Promise<void> {
    const run = this.runs.get(threadId);
    if (!run) return;
    run.queue = [];
    if (run.inflight) await this.cancel(threadId).catch(() => undefined);
    const sid = run.sessionId;
    this.dropSession(run);
    this.runs.delete(threadId);
    if (sid) await this.ctx.runtime.closeSession(sid).catch(() => undefined);
  }

  /**
   * The bot moved to another provider: its threads (and its Telegram chats) continue there. Their stored sessions
   * belong to the old agent, so each one's next turn starts a fresh session, primed with the memory and that thread's
   * recent turns; a session still running a turn is replaced once that turn ends (`ensureSession` compares providers).
   */
  async switchProvider(bot: Bot): Promise<void> {
    const threads = this.ctx.s.threads;
    const known = threads.list({ limit: 10_000 }).find((t) => t.providerId === bot.providerId && (t.models.length || t.modes.length));
    for (const t of threads.list({ limit: 10_000 }).filter((x) => x.botId === bot.id && x.providerId !== bot.providerId)) {
      threads.update(t.id, {
        providerId: bot.providerId, acpSessionId: undefined, modeId: bot.modeId, modelId: bot.modelId, effortId: bot.effort, fast: bot.fast,
        modes: known?.modes ?? [], models: known?.models ?? [], efforts: known?.efforts ?? [], fastAvailable: known?.fastAvailable ?? false, commands: known?.commands ?? [],
      }, false);
      const run = this.runs.get(t.id);
      if (!run || run.inflight || !run.sessionId) continue;
      const sid = run.sessionId;
      this.dropSession(run);
      await this.ctx.runtime.closeSession(sid).catch((e) => this.ctx.log.warn(`closing session ${sid} failed`, errMsg(e)));
    }
  }

  /** Each thread's picker changes (`inOrder`), the last one queued: they reach the agent one at a time, as sent. */
  private picks = new Map<string, Promise<unknown>>();

  /**
   * Run a picker change (mode, model, effort, fast) after the thread's earlier ones have finished, so two sent in quick
   * succession (High → Low → Medium) reach the agent, and land on the thread, in the order they were sent, whatever
   * order the agent answers in.
   */
  inOrder<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.picks.get(threadId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.picks.set(threadId, tail);
    void tail.then(() => { if (this.picks.get(threadId) === tail) this.picks.delete(threadId); });
    return run;
  }

  async setMode(threadId: string, modeId: string): Promise<Thread> {
    const sid = this.liveSession(threadId);
    if (sid) {
      try {
        const info = await this.ctx.runtime.setMode(sid, modeId);
        return this.ctx.s.threads.update(threadId, { modeId: info.currentModeId ?? modeId, modes: info.modes.length ? info.modes : this.ctx.s.threads.require(threadId).modes });
      } catch (e) { return this.keepForRestart(threadId, 'mode', e, { modeId }); }
    }
    return this.ctx.s.threads.update(threadId, { modeId });
  }

  async setModel(threadId: string, modelId: string): Promise<Thread> {
    checkCreditPick(this.ctx.s.threads.require(threadId).providerId, { modelId });
    const sid = this.liveSession(threadId);
    if (sid) {
      try {
        const info = await this.ctx.runtime.setModel(sid, modelId);
        // the efforts on offer are the new model's, and so is fast mode: one it offers gets the thread's own
        const wanted = this.ctx.s.threads.require(threadId).fast;
        let fastInfo = info;
        if (info.fastAvailable && info.fastEnabled !== wanted) {
          fastInfo = await this.ctx.runtime.setFast(sid, wanted).catch((e) => {
            this.ctx.log.warn(`applying ${threadId}'s fast mode to its new model failed`, errMsg(e));
            return info;
          });
        }
        return this.ctx.s.threads.update(threadId, {
          modelId: info.currentModelId ?? modelId, models: info.models.length ? info.models : this.ctx.s.threads.require(threadId).models,
          efforts: info.efforts, effortId: info.currentEffortId,
          fastAvailable: fastInfo.fastAvailable, ...(fastInfo.fastAvailable ? { fast: fastInfo.fastEnabled } : {}),
        });
      } catch (e) { return this.keepForRestart(threadId, 'model', e, { modelId }); }
    }
    return this.ctx.s.threads.update(threadId, { modelId });
  }

  /** The thread's reasoning effort; a session that isn't running starts with its bot's `effort` (see `openSession`). */
  async setEffort(threadId: string, effortId: string): Promise<Thread> {
    const sid = this.liveSession(threadId);
    if (sid) {
      try {
        const info = await this.ctx.runtime.setEffort(sid, effortId);
        return this.ctx.s.threads.update(threadId, { effortId: info.currentEffortId ?? effortId, efforts: info.efforts });
      } catch (e) { return this.keepForRestart(threadId, 'effort', e, { effortId }); }
    }
    return this.ctx.s.threads.update(threadId, { effortId });
  }

  /**
   * The thread's fast mode; a session that isn't running starts with its bot's `fast` (see `openSession`). A model
   * without fast mode keeps the choice for when the thread is on one that has it.
   */
  async setFast(threadId: string, fast: boolean): Promise<Thread> {
    checkCreditPick(this.ctx.s.threads.require(threadId).providerId, { fast });
    const sid = this.liveSession(threadId);
    if (sid && this.ctx.runtime.getSession(sid)?.fastAvailable) {
      try {
        const info = await this.ctx.runtime.setFast(sid, fast);
        return this.ctx.s.threads.update(threadId, { fastAvailable: info.fastAvailable, fast: info.fastAvailable ? info.fastEnabled : fast });
      } catch (e) { return this.keepForRestart(threadId, 'fast mode', e, { fast }); }
    }
    return this.ctx.s.threads.update(threadId, { fast });
  }

  /* ------------------------------------------------------------ permissions */

  listPermissions(): PermissionRequest[] { return [...this.pending.values()].map((p) => structuredClone(p.req)); }

  /**
   * A question an agent sends as a permission request, its options the answers: it goes to the chat (and Telegram) as
   * a question with those choices, and the answer picks the option it names (or numbers). Any other answer, or none
   * within the hour, leaves it unanswered.
   */
  private async askAsQuestion(thread: Thread, ask: PermissionAsk): Promise<string | null> {
    const { answer } = await this.ctx.s.agentBridge.ask({ threadId: thread.id, botId: thread.botId }, ask.title, ask.options.map((o) => o.name), 3600);
    const said = answer?.trim().toLowerCase();
    if (!said) return null;
    return (ask.options.find((o) => o.name.trim().toLowerCase() === said) ?? (/^\d+$/.test(said) ? ask.options[Number(said) - 1] : undefined))?.optionId ?? null;
  }

  /**
   * A form the agent itself asks the user to fill in (OpenCode's own `question` tool, which a bot may reach for
   * instead of `ask_user`): it goes to the chat as a question or a form card like AppuBot's own (`agentInput.ts`), and
   * the answer goes back under the agent's field ids. Nobody to ask (not a chat's session, a hidden turn), no answer
   * within the hour or the turn ending: `cancel`.
   */
  private async onInput(ask: ElicitationAsk): Promise<ElicitationAnswer> {
    const threadId = this.sessionToThread.get(ask.sessionId);
    const thread = threadId ? this.ctx.s.threads.get(threadId) : undefined;
    const card = thread && !this.runs.get(thread.id)?.hidden ? inputCard(ask) : null;
    if (!thread || !card) return { action: 'cancel' };
    const a = { threadId: thread.id, botId: thread.botId };
    const o = await this.ctx.s.agentBridge.open(a, card.kind === 'form' ? { question: card.question, options: [], form: { kind: 'form', fields: card.fields } } : { question: card.question, options: card.options }, 3600);
    if (!o) return { action: 'cancel' };
    if (o.declined) return { action: 'decline' };
    const values = card.kind === 'form' ? (o.values ? card.read(o.values) : card.words(o.answer)) : card.read(o.answer);
    return { action: 'accept', content: elicitationContent(ask.fields, values) };
  }

  private onPermission(ask: PermissionAsk): Promise<string | null> {
    const threadId = this.sessionToThread.get(ask.sessionId);
    const thread = threadId ? this.ctx.s.threads.get(threadId) : undefined;
    const bot = thread ? this.ctx.s.bots.get(thread.botId) : undefined;
    if (!thread || !bot) {
      this.ctx.log.warn(`permission request for unknown session ${ask.sessionId}; rejecting`);
      return Promise.resolve(pickReject(ask.options) ?? null);
    }
    // a hidden turn was told to use no tools: refused without asking anyone (it never grants anything)
    if (this.runs.get(thread.id)?.hidden) return Promise.resolve(pickReject(ask.options) ?? null);
    // a question in a permission request (Antigravity's): asked as one, never answered for the user
    if (ask.question) return this.askAsQuestion(thread, ask);
    // AppuBot's own tools (asking, reacting, memory, bots) need no approval, nor a new bot's setup (policy.ts)
    const job = this.runs.get(thread.id)?.job;
    const tool = ask.bridgeTool ?? ask.title;
    if (isOwnTool(tool) || (job?.quiet && job.via === 'system' && isSetupTool(tool))) {
      const allow = pickAllowOnce(ask.options);
      if (allow) return Promise.resolve(allow);
    }
    // An agent with no Auto or Bypass mode of its own (Cursor, the ACP registry's) is on AppuBot's approvals: Full
    // access says yes to everything; Approve for me to reads, searches and AppuBot's own tools (the bot was given
    // those, but running app tools acts in the user's accounts), and asks you about the rest
    if (!hasPermissionModes(thread.providerId) && (thread.modeId !== 'auto' || (ask.bridgeTool && !actsInAccounts(ask.bridgeTool)) || APPROVED_KINDS.has(ask.kind))) {
      const allow = pickAllowOnce(ask.options);
      if (allow) return Promise.resolve(allow);
    }
    // No approval rules of AppuBot's own: the agent's permission mode (Auto or Bypass permissions)
    // decides what it asks about, and whatever it asks waits for you, like in its own CLI.
    const kind = ToolKind.safeParse(ask.kind).success ? (ask.kind as PermissionRequest['kind']) : 'other';
    const req: PermissionRequest = {
      id: newId('perm'), threadId: thread.id, botId: bot.id, toolCallId: ask.toolCallId, title: ask.title || 'Tool call', kind,
      content: ask.content ?? [], rawInput: ask.rawInput, options: ask.options, createdAt: Date.now(),
    };
    return new Promise<string | null>((resolve) => {
      this.pending.set(req.id, { req, resolve });
      this.ctx.s.threads.update(thread.id, { status: 'waiting' });
      this.ctx.bus.emit('permission.requested', structuredClone(req));
      this.ctx.s.notifications.notify({
        title: `Approval needed: ${req.title}`, body: bot.name, threadId: thread.id, level: 'warning', kind: 'approval',
        push: { kind: 'needs-you', botId: bot.id, botName: bot.name, text: `Approval needed: ${req.title}` },
      });
    });
  }

  respondPermission(id: string, optionId: string, by?: string): { ok: true } {
    const p = this.pending.get(id);
    if (!p) throw notFound('Permission request', id);
    if (!p.req.options.some((o) => o.optionId === optionId)) throw new RpcError('invalid_params', `Unknown option ${optionId}`);
    this.resolvePermission(id, optionId, by);
    return { ok: true };
  }

  private resolvePermission(id: string, optionId: string | null, by?: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.req.resolvedAt = Date.now();
    if (optionId) p.req.selectedOptionId = optionId;
    this.ctx.bus.emit('permission.resolved', { id, optionId: optionId ?? 'cancelled', by });
    const run = this.runs.get(p.req.threadId);
    const stillWaiting = [...this.pending.values()].some((x) => x.req.threadId === p.req.threadId);
    if (run?.inflight && !stillWaiting && this.ctx.s.threads.get(p.req.threadId)) this.ctx.s.threads.update(p.req.threadId, { status: 'running' });
    p.resolve(optionId);
  }

  setWaiting(threadId: string, waiting: boolean): void {
    const run = this.runs.get(threadId);
    if (!run?.inflight || !this.ctx.s.threads.get(threadId)) return;
    const stillWaiting = [...this.pending.values()].some((x) => x.req.threadId === threadId);
    this.ctx.s.threads.update(threadId, { status: waiting || stillWaiting ? 'waiting' : 'running' });
  }

  async shutdown(): Promise<void> {
    // AppuBot is quitting: nothing queued starts now (an update restart picks it up afterwards)
    this.closing = true;
    for (const id of [...this.pending.keys()]) this.resolvePermission(id, null, 'shutdown');
    for (const r of this.runs.values()) this.dropSession(r);
  }
}
