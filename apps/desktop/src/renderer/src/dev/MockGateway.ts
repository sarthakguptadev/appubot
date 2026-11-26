/**
 * Dev-only in-memory gateway (VITE_APPUBOT_MOCK=1). Mimics @appubot/client's GatewayClient:
 * connect() → 'connecting' → 'connected' + `hello` (snapshot) through onAny; events carry an
 * incrementing seq; `call` resolves after a little artificial latency.
 *
 * URL switches: ?onboarding=1 (first-run setup: Accessibility, Screen Recording and notifications not given yet; add
 *               &step=welcome|agents|permissions|pair|follow|done to open a step, &perms=granted to start granted)
 *               ?theme=dark|light  ?voice=ready|off (speech models downloaded / unsupported)  ?panel=skills|memory|routines|files|computer (computer: with ?screen=asleep|waking|connecting|live|reconnecting|paused|unreachable)  ?page=apps|connected (the Connect apps popup, or its connected apps)
 *               ?settings=providers (or any Settings section)
 *               ?bot=bot_ledger (another bot than Appu)   ?approval=0   ?forms=1 (a form and a Vault card)   ?apps=onboarding|none|many|accounts (signed out of Composio, nothing connected, fifteen connected, apps with several accounts)
 *               ?threads=1 (the thread switcher open, one of Appu's older threads unread)
 *               ?editor=1 (the bot's side panel open on Details, where it is set up)
 *               ?characters=off|fail|worn (a computer without characters / Generate failing / Ledger wearing one)
 *               ?cloud=signed-out|no-plan|sold-out|provisioning|running|asleep|waking|on-hold|past-due|ending|scheduled|export-only|failed|suspended
 *               (AppuBot Cloud's account, dev/mockCloud.ts; &on=cloud starts on the cloud computer's bots, &catalog=0 hides the plans' prices,
 *               &menu=computer opens the sidebar's computer dropdown; teams: team-admin|team-member|team-invite|personal-team,
 *               &kind=work&members=12&billing=y opens the paywall on Work)
 */
import { APPUBOT_AI_NAME, APPUBOT_AI_PROVIDER_ID } from '@appubot/protocol';
import {
  applyDelta, leanThread, newId, setPart,
  type ComputerAction, type ComputerFrame, type EventName, type EventPayload, type FileAttachment, type MethodName,
  type MethodParams, type MethodResult, type Message, type Part, type Snapshot, type Thread,
} from '@appubot/protocol';
import { GatewayError, type ConnectionState, type GatewayLike } from '../lib/gateway';
import { setState, ui } from '../lib/store';
import { openBot, openThread } from '../lib/actions';
import { GROUP_ID, buildSeed, readOptions, seedFiles, seedMemory, type MockOptions } from './mockData';
import { IDS } from './mockIds';
import { mainActions } from './mockMessages';
import { FRAME_H, FRAME_W, frameImage, placeholderFileUrl } from './mockFrame';
import { createHandlers, type Handlers } from './mockHandlers';
import { benchMessages } from './benchThread';
import { installBench } from './mockBench';
import { Runs } from './mockChat';
import { mockCloudState, mockCredit, mockOpenComputerMenu, mockStartOnCloud } from './mockCloud';
import { setCloudClientFactory, switchComputer } from '../features/cloud/cloudClient';

type AnyHandler = (event: EventName, payload: unknown, seq: number) => void;
type StateHandler = (s: ConnectionState, err?: string) => void;

export class MockGateway implements GatewayLike {
  state: ConnectionState = 'idle';
  snapshot: Snapshot | null = null;

  readonly opts: MockOptions;
  /** live in-memory database (snapshot-shaped; arrays are always replaced, never mutated) */
  db: Snapshot;
  messages: Record<string, Message[]>;
  files: FileAttachment[] = seedFiles.map((f) => ({ ...f }));
  memory: Record<string, string> = { ...seedMemory };
  readonly runs = new Runs();
  /** misc timers (teach, pairing, …) cleared on close */
  readonly timers = new Set<ReturnType<typeof setTimeout>>();

  private seq = 0;
  private anyHandlers = new Set<AnyHandler>();
  private stateHandlers = new Set<StateHandler>();
  private readonly handlers: Handlers;
  private frameCounter = 0;

  /** the stand-in for the user's AppuBot Cloud computer (features/cloud), not this Mac */
  readonly cloud: boolean;

  constructor(opts: { cloud?: boolean; hostName?: string } = {}) {
    this.cloud = !!opts.cloud;
    this.opts = readOptions();
    const seed = buildSeed(this.opts);
    this.db = seed.snapshot;
    this.messages = seed.messages;
    this.handlers = createHandlers(this);
    if (this.cloud) this.becomeCloud(opts.hostName);
    // the renderer bench (apps/desktop/bench): `?long=600` puts a long history before Appu's main chat, `?bench=1`
    // adds window.__appubotBench
    const q = new URLSearchParams(location.search);
    const long = Number(q.get('long'));
    if (!this.cloud && long > 0) {
      const main = this.threadMessages(IDS.main);
      this.messages[IDS.main] = [...benchMessages(IDS.main, long, (main[0]?.createdAt ?? Date.now()) - 3_600_000), ...main];
      // the long chat is Appu's current one (what opening Appu shows), ahead of the routine chat that runs every few minutes
      const t = this.db.threads.find((x) => x.id === IDS.main);
      if (t) t.lastActiveAt = Date.now();
    }
    if (!this.cloud && q.get('bench') === '1') installBench(this);
  }

  /** A Linux computer in a data centre with bots of its own (renamed copies of the Mac's), its state from `?cloud=`. */
  private becomeCloud(hostName = 'AppuBot computer'): void {
    const s = mockCloudState();
    const state = s === 'on-hold' ? 'on-hold' as const : s === 'export-only' ? 'export-only' as const : 'ok' as const;
    const resetsAt = Date.now() + 9 * 86_400_000;
    const credit = mockCredit();
    this.db.system = { ...this.db.system, hostName, platform: 'linux', arch: 'x64', homeDir: '/home/node', power: undefined, cloud: { state, ...(state === 'on-hold' ? { resetsAt } : {}), publicUrl: 'https://k3v9x2mq8p0w4rt7zb1c.agent37.app', credit } };
    // the included credit's agent (§6.13): a Claude Code profile of its own, signed in by the credit; the cloud bots run on it
    const claude = this.db.providers.find((p) => p.id === 'claude-code');
    if (claude) this.db.providers = [{ ...claude, id: APPUBOT_AI_PROVIDER_ID, name: APPUBOT_AI_NAME, description: 'Claude on your plan’s launch bonus, for a limited time.', auth: { state: 'logged_in', account: 'Claude launch bonus', checkedAt: Date.now() }, canLogOut: false, latestVersion: undefined, updateAvailable: undefined, update: undefined, profile: { of: 'claude-code', name: APPUBOT_AI_NAME, home: '/home/node/.appubot/profiles/claude-code/appubot-ai', source: 'credit' } }, ...this.db.providers];
    this.db.settings = { ...this.db.settings, defaultProviderId: APPUBOT_AI_PROVIDER_ID, defaultModelId: credit.defaultModel };
    const names: Record<string, { name: string; color: string; job: string }> = {
      [IDS.appu]: { name: 'Scout', color: '#3B82F6', job: 'Always on: watches the inbox and answers on Telegram' },
      [IDS.ledger]: { name: 'Atlas', color: '#10B981', job: 'Runs the nightly reports' },
    };
    this.db.bots = this.db.bots.filter((b) => names[b.id]).map((b) => ({ ...b, ...names[b.id]!, computerUse: true, pinned: false, workspace: `/home/node/AppuBot/${names[b.id]!.name.toLowerCase()}`, providerId: APPUBOT_AI_PROVIDER_ID, modelId: credit.defaultModel }));
    for (const t of this.db.threads) if (names[t.botId]) { t.providerId = APPUBOT_AI_PROVIDER_ID; t.modelId = credit.defaultModel; }
    this.db.devices = [];
    this.db.pendingPermissions = [];
  }

  /* ---------- GatewayLike ---------- */
  connect(): void {
    if (this.state === 'connected' || this.state === 'connecting') return;
    this.setState('connecting');
    // a sleeping cloud computer takes a moment to wake (`?cloud=waking`: a long one, to see it)
    const wait = !this.cloud ? 250 : mockCloudState() === 'waking' ? 120_000 : 1800;
    this.later(() => {
      this.snapshot = this.db;
      this.setState('connected');
      this.deliver('hello', this.db);
      this.later(() => this.afterHello(), 0);
    }, wait);
  }

  close(): void {
    this.runs.clear();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.setState('closed');
  }

  async call<M extends MethodName>(method: M, params?: MethodParams<M>): Promise<MethodResult<M>> {
    if (this.state !== 'connected') throw new GatewayError('not_connected', 'Not connected to AppuBot');
    await new Promise<void>((r) => setTimeout(r, 150 + Math.random() * 250));
    if (!Object.hasOwn(this.handlers, method)) throw new GatewayError('unknown_method', `Unknown method: ${String(method)}`);
    const handler = this.handlers[method];
    const result: MethodResult<M> = await handler((params ?? {}) as MethodParams<M>);
    // the cloud computer sees this Mac as a paired device: its thread lists come without slash commands, as a real one's
    if (this.cloud && method === 'threads.list' && Array.isArray(result)) return (result as Thread[]).map(leanThread) as MethodResult<M>;
    return result;
  }

  onAny(fn: AnyHandler): () => void {
    this.anyHandlers.add(fn);
    return () => { this.anyHandlers.delete(fn); };
  }

  onState(fn: StateHandler): () => void {
    this.stateHandlers.add(fn);
    return () => { this.stateHandlers.delete(fn); };
  }

  async upload(file: Blob, name: string): Promise<FileAttachment> {
    const id = newId('file');
    const att: FileAttachment = { id, name, mimeType: file.type || 'application/octet-stream', size: file.size, url: `/files/${id}` };
    this.files = [att, ...this.files];
    return att;
  }

  fileUrl(file: Pick<FileAttachment, 'url'> | string): string {
    const rel = typeof file === 'string' ? file : file.url;
    if (/^(data:|blob:|https?:)/.test(rel)) return rel;
    const f = this.files.find((x) => x.url === rel || rel.startsWith(`${x.url}?`));
    return placeholderFileUrl(f?.name ?? rel.split('/').pop() ?? 'file', f?.mimeType ?? 'image/png');
  }

  /* ---------- event plumbing ---------- */
  /** Queue an event (delivered asynchronously, after any pending call result). */
  emit<E extends EventName>(event: E, payload: EventPayload<E>, delay = 0): void {
    const copy = structuredClone(payload);
    this.later(() => this.deliver(event, copy), delay);
  }

  /** setTimeout tracked for close(). */
  later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  private deliver(event: EventName | 'hello', payload: unknown): void {
    const seq = ++this.seq;
    // as a real gateway sends a paired device (the cloud computer to this Mac): threads without their slash commands,
    // `threads.commands` when wanted
    if (this.cloud && event === 'hello') payload = { ...(payload as Snapshot), threads: (payload as Snapshot).threads.map(leanThread) };
    if (this.cloud && event === 'thread.updated') payload = leanThread(payload as Thread);
    for (const h of this.anyHandlers) {
      try { h(event as EventName, payload, seq); } catch (e) { console.warn('[mock-gateway] handler error', event, e); }
    }
  }

  private setState(s: ConnectionState, err?: string): void {
    if (this.state === s && !err) return;
    this.state = s;
    for (const h of this.stateHandlers) {
      try { h(s, err); } catch (e) { console.warn('[mock-gateway] state handler error', e); }
    }
  }

  private afterHello(): void {
    if (this.cloud) return;
    // the cloud computer's bots: a second mock gateway stands in for it (`?cloud=…&on=cloud` opens on it)
    if (!this.firstHello) return;
    this.firstHello = false;
    setCloudClientFactory((info) => new MockGateway({ cloud: true, hostName: info.hostName }));
    if (mockStartOnCloud()) this.later(() => void switchComputer('cloud'), 300);
    // `&on=team`: the team Acme's shared computer on screen (a team state)
    if (new URLSearchParams(location.search).get('on') === 'team') this.later(() => void switchComputer('cloud', 'team_acme'), 300);
    // `&menu=computer`: the sidebar's computer dropdown opens by itself (screenshots of each `?cloud=` state)
    if (mockOpenComputerMenu()) this.later(() => document.querySelector<HTMLButtonElement>('button[aria-label^="Computer:"]')?.click(), mockStartOnCloud() ? 2600 : 600);
    this.afterFirstHello();
  }

  private firstHello = true;

  private afterFirstHello(): void {
    // computer timeline thumbnails for the main thread, then a live frame
    for (const a of mainActions()) {
      this.emit('computer.action', { threadId: IDS.main, action: a.action, ts: a.ts, ok: true, summary: a.summary });
      this.emit('computer.frame', this.makeFrame(a.variant, { id: a.frameId, threadId: IDS.main, action: a.action, ts: a.ts }));
    }
    this.emit('computer.frame', this.makeFrame(0, { id: IDS.liveFrame }));

    openBot(this.opts.bot && this.db.bots.some((b) => b.id === this.opts.bot) ? this.opts.bot : IDS.appu);
    if (this.opts.thread === 'media') void openThread(IDS.appuMedia);
    if (this.opts.thread === 'routines') void openThread(IDS.appuRoutines);
    if (this.opts.thread === 'work') void openThread(IDS.appuWork);
    if (this.opts.thread === 'failed') void openThread(IDS.appuFailed);
    if (this.opts.thread === 'note' || this.opts.thread === 'question' || this.opts.thread === 'waits') void openThread(IDS.appuMidJob);
    if (this.opts.thread === 'handoff') void openThread(IDS.appuHandoff);
    const panel = this.opts.panel;
    if (panel) setState({ rightOpen: true, rightTab: panel });
    if (this.opts.page) ui.openApps(this.opts.page === 'connected' ? 'connected' : 'browse');
    if (this.opts.groups && !this.opts.bot) ui.selectGroup(GROUP_ID);
    if (this.opts.settings) ui.openSettings(this.opts.settings);
    if (this.opts.threads) {
      ui.markUnread(IDS.appuScreens);
      setState({ rightOpen: true, rightTab: 'threads' });
    }
    if (this.opts.editor) setState({ rightOpen: true, rightTab: 'bot' });
    if (this.opts.newBot) ui.openModal({ kind: 'new-bot' });
  }

  /* ---------- helpers used by handlers / simulations ---------- */
  makeFrame(variant: number, extra: { id?: string; threadId?: string; action?: ComputerAction; ts?: number } = {}): ComputerFrame {
    const img = frameImage(variant);
    return {
      id: extra.id ?? `frame_${Date.now().toString(36)}_${(this.frameCounter++).toString(36)}`,
      threadId: extra.threadId, mimeType: img.mimeType, data: img.data, width: FRAME_W, height: FRAME_H,
      ts: extra.ts ?? Date.now(), action: extra.action,
    };
  }

  thread(id: string): Thread {
    const t = this.db.threads.find((x) => x.id === id);
    if (!t) throw new GatewayError('not_found', `Thread ${id} not found`);
    return t;
  }

  patchThread(id: string, patch: Partial<Thread>): Thread {
    const next: Thread = { ...this.thread(id), ...patch, updatedAt: patch.updatedAt ?? Date.now() };
    this.db.threads = this.db.threads.map((t) => (t.id === id ? next : t));
    this.emit('thread.updated', next);
    return next;
  }

  threadMessages(threadId: string): Message[] {
    return this.messages[threadId] ?? (this.messages[threadId] = []);
  }

  findMessage(threadId: string, messageId: string): Message | undefined {
    return this.messages[threadId]?.find((m) => m.id === messageId);
  }

  addMessage(m: Message): void {
    this.threadMessages(m.threadId).push(m);
    this.emit('message.created', m);
  }

  delta(threadId: string, messageId: string, partIndex: number, partType: 'text' | 'thought', delta: string): void {
    const m = this.findMessage(threadId, messageId);
    if (m) applyDelta(m, partIndex, partType, delta);
    this.emit('message.delta', { threadId, messageId, partIndex, partType, delta });
  }

  setMessagePart(threadId: string, messageId: string, partIndex: number, part: Part): void {
    const m = this.findMessage(threadId, messageId);
    if (m) setPart(m, partIndex, structuredClone(part));
    this.emit('message.part', { threadId, messageId, partIndex, part });
  }

  completeMessage(threadId: string, messageId: string, status: 'complete' | 'cancelled' | 'error', stopReason?: string): void {
    const m = this.findMessage(threadId, messageId);
    if (m) { m.status = status; m.stopReason = stopReason; m.updatedAt = Date.now(); }
    this.emit('message.completed', { threadId, messageId, status, stopReason });
  }
}

export function createMockGateway(): GatewayLike {
  return new MockGateway();
}
