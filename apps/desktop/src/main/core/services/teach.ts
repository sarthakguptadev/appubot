/**
 * Teach mode: record the user's clicks/keys (macOS: the native helper's watcher; Windows and Linux: `InputRecorder` over
 * the host's global hooks, `deps.inputWatch`), then ask the bot to turn the recording into a reusable SKILL.md (saved
 * via the `save_skill` tool). Where nothing can record, it is manual: the bot writes the skill from the description.
 *
 * Your AppuBot computer has neither a helper nor hooks, but everything the user does on its screen comes through
 * AppuBot itself: live view's input (`computer.liveInput`, the phone and the desktop app) and what the desktop app's
 * noVNC view mirrors (`teach.input`). `LiveRecorder` turns those into the same events (clicks with a picture of the
 * screen from the live source, typed text joined up, keys, scrolls, drags), so a bot there learns from a demo given
 * through the screen (`teach.support` says `how: 'live'`, and the apps open the screen to show it on).
 */
import { machineName, newId, slugify, type LiveInput, type TeachInput, type TeachSession } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { errMsg, notFound, RpcError, truncate } from '../util';
import { InputRecorder } from './inputRecorder';
import { toPoint, type Bounds } from './liveView';

export interface InputEvent {
  kind: string; x?: number; y?: number; app?: string; window_title?: string; modifiers?: string[];
  count?: number; button?: string; ax?: { role?: string; title?: string; label?: string; value?: string };
  from?: { x: number; y: number }; text?: string; key?: string; chars?: string; dx?: number; dy?: number;
  screenshot_base64?: string; ts?: number;
  /** typed: when the typing stopped; drag_end: how long the button was down; key: the key is repeating */
  end_ts?: number; duration_ms?: number; repeat?: boolean;
}

const MAX_EVENTS = 400;
const MAX_SHOTS = 12;
const SELF_APPS = new Set(['appubot', 'electron']);
/** live recording: typing within this of the last typed text is the same text; a drag shorter than this is a click */
const TYPE_JOIN_MS = 1500;
const DRAG_MIN_PX = 4;
/** live recording: the picture at each click is the screen at half size, as the other recorders take it */
const SHOT_SCALE = 0.5;
const SHOT_QUALITY = 0.5;

const r = (n: number | undefined): number => Math.round(n ?? 0);

export function describeEvent(e: InputEvent): string | null {
  const where = e.app ? ` in ${e.app}${e.window_title ? ` ("${truncate(e.window_title, 60)}")` : ''}` : '';
  const at = e.x !== undefined ? ` at (${r(e.x)},${r(e.y)})` : '';
  switch (e.kind) {
    case 'click':
    case 'right_click': {
      const label = e.ax?.title || e.ax?.label || e.ax?.value;
      const target = label ? ` '${truncate(label, 60)}'${e.ax?.role ? ` (${e.ax.role})` : ''}` : e.ax?.role ? ` a ${e.ax.role}` : '';
      const verb = e.kind === 'right_click' ? 'Right-clicked' : (e.count ?? 1) >= 3 ? 'Triple-clicked' : (e.count ?? 1) === 2 ? 'Double-clicked' : 'Clicked';
      const mods = e.modifiers?.length ? ` with ${e.modifiers.join('+')}` : '';
      return `${verb}${target}${where}${at}${mods}`;
    }
    case 'drag_end':
      return `Dragged from (${r(e.from?.x)},${r(e.from?.y)}) to (${r(e.x)},${r(e.y)})${where}`;
    case 'typed':
      return `Typed '${truncate(e.text ?? '', 200)}'${where}`;
    case 'key':
      return `Pressed ${[...(e.modifiers ?? []), e.key ?? e.chars ?? '?'].join('+')}${where}`;
    case 'scroll':
      return `Scrolled ${(e.dy ?? 0) > 0 ? 'down' : (e.dy ?? 0) < 0 ? 'up' : (e.dx ?? 0) > 0 ? 'right' : 'left'}${where}${at}`;
    default:
      return null;
  }
}

/** Pick ≤n evenly spaced items. */
export function evenlySpaced<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]!);
  return out;
}

export class TeachService {
  private session: TeachSession | null = null;
  private events: InputEvent[] = [];
  private unsub: (() => void) | null = null;
  /** Windows and Linux: the hooks' recorder while recording */
  private recorder: InputRecorder | null = null;
  /** your AppuBot computer: the recorder over live view's and the viewer's input, while recording */
  private liveRecorder: LiveRecorder | null = null;
  private offLive: (() => void) | null = null;
  /** agent message that turns the recording into a skill (the bot's chat may have other turns queued) */
  private summaryMessageId: string | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctx: CoreCtx) {
    ctx.s.chat.onTurnCompleted((e) => {
      const s = this.session;
      if (!s || s.threadId !== e.threadId || s.status !== 'summarizing' || e.message.id !== this.summaryMessageId) return;
      if (e.status === 'complete') this.update({ status: 'done', endedAt: Date.now(), skillName: s.skillName ?? slugify(s.name) });
      else this.update({ status: e.status === 'cancelled' ? 'cancelled' : 'error', endedAt: Date.now(), error: e.message.error });
    });
  }

  status(): TeachSession | null { return this.session ? structuredClone(this.session) : null; }

  /** Whether `start` records here or falls back to manual mode, and why not; `how: 'live'`: through the screen (your AppuBot computer). */
  async support(): Promise<{ recording: boolean; reason?: string; how?: 'input' | 'live' }> {
    if (this.ctx.s.computer.helper()) return { recording: true, how: 'input' };
    const watch = this.ctx.deps.inputWatch;
    if (!watch) {
      if (this.liveRecordable()) return { recording: true, how: 'live' };
      return { recording: false, reason: `AppuBot can't record clicks and keys on this ${machineName(process.platform)}.` };
    }
    const a = await watch.available().catch((e: unknown) => ({ ok: false, reason: errMsg(e) }));
    if (a.ok) return { recording: true, how: 'input' };
    if (this.liveRecordable()) return { recording: true, how: 'live' };
    return { recording: false, ...(a.reason ? { reason: a.reason } : {}) };
  }
  isTeachThread(threadId: string): boolean { return !!this.session && this.session.threadId === threadId; }

  /** the screen can be read and driven through AppuBot (a screen source: your AppuBot computer) */
  private liveRecordable(): boolean {
    return !this.ctx.s.computer.helper() && !!this.ctx.s.liveView?.supported;
  }

  /** A viewer driving the screen another way (the desktop app's noVNC view of your AppuBot computer) says what it did. */
  viewerInput(i: TeachInput): { ok: true } {
    const live = this.liveRecorder;
    if (live) {
      const b = this.ctx.s.liveView.screenBounds();
      const input: LiveInput = i.kind === 'click' ? { kind: 'click', x: i.x, y: i.y, button: i.button, count: i.count }
        : i.kind === 'type' ? { kind: 'type', text: i.text }
          : i.kind === 'key' ? { kind: 'key', key: i.key, modifiers: i.modifiers }
            : { kind: 'scroll', x: i.x, y: i.y, dx: i.dx, dy: i.dy };
      live.take(input, b ?? this.ctx.s.liveView.screenBounds());
    }
    return { ok: true };
  }
  onSkillSaved(threadId: string, name: string): void { if (this.isTeachThread(threadId)) this.update({ skillName: name }); }

  private update(patch: Partial<TeachSession>): TeachSession {
    this.session = { ...this.session!, ...patch };
    this.ctx.bus.emit('teach.updated', structuredClone(this.session));
    return structuredClone(this.session);
  }

  async start(botId: string, name: string, goal: string): Promise<TeachSession> {
    if (this.session && (this.session.status === 'recording' || this.session.status === 'summarizing')) throw new RpcError('busy', 'A teach session is already in progress');
    this.ctx.s.bots.require(botId);
    if (!name.trim()) throw new RpcError('invalid_params', 'Give the skill a name');
    this.events = [];
    this.session = { id: newId('teach'), botId, name: name.trim(), goal, status: 'recording', startedAt: Date.now(), stepCount: 0 };
    const helper = this.ctx.s.computer.helper();
    if (helper) {
      try {
        await helper.request('watch_start', { mouse: true, keyboard: true, screenshots_on_click: true, scale: 0.5 });
        this.unsub = helper.onEvent((ev) => { if (ev.event === 'input') this.onInput(ev as unknown as InputEvent); });
        return this.update({});
      } catch (e) {
        this.ctx.log.warn('teach: could not start input watching; using manual mode', errMsg(e));
      }
    } else if (this.ctx.deps.inputWatch) {
      const rec = new InputRecorder(this.ctx.deps.inputWatch, (ev) => this.onInput(ev), { platform: process.platform, screenshots: true, scale: 0.5 });
      try {
        await rec.start();
        this.recorder = rec;
        return this.update({});
      } catch (e) {
        this.ctx.log.warn('teach: could not start input recording; using manual mode', errMsg(e));
      }
    }
    if (this.liveRecordable()) {
      // through the screen: whatever a device does on it through AppuBot is the recording
      const live = this.ctx.s.liveView;
      this.liveRecorder = new LiveRecorder({
        emit: (ev) => this.onInput(ev),
        shot: async (b) => live.snapshot(Math.max(1, Math.round(Math.max(b.width, b.height) * SHOT_SCALE)), SHOT_QUALITY).then((s) => s?.data ?? null).catch(() => null),
        where: (pt) => this.ctx.s.computer.windowAtPoint(pt).catch(() => undefined),
      });
      live.hold(true);
      // the screen's size is learned from a first look, so every click lands in pixels of the display
      await live.snapshot(64, 0.3).catch(() => null);
      this.offLive = live.onInput((i, b) => this.liveRecorder?.take(i, b ?? live.screenBounds()));
      return this.update({});
    }
    // manual mode: no recording - describe the goal and let the agent write the skill
    return this.summarize(true);
  }

  private onInput(e: InputEvent): void {
    if (!this.session || this.session.status !== 'recording') return;
    if (e.app && SELF_APPS.has(e.app.toLowerCase())) return;
    if (this.events.length >= MAX_EVENTS) return;
    this.events.push(e);
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        if (this.session?.status === 'recording') this.update({ stepCount: this.events.length });
      }, 250);
    }
  }

  async stop(id: string, cancel: boolean): Promise<TeachSession> {
    const s = this.session;
    if (!s || s.id !== id) throw notFound('Teach session', id);
    if (s.status !== 'recording') {
      if (cancel && s.status === 'summarizing' && s.threadId) {
        await this.ctx.s.chat.cancel(s.threadId).catch(() => undefined);
        return this.update({ status: 'cancelled', endedAt: Date.now() });
      }
      return structuredClone(s);
    }
    await this.stopWatching();
    if (cancel) return this.update({ status: 'cancelled', endedAt: Date.now(), stepCount: this.events.length });
    return this.summarize(false);
  }

  private async stopWatching(): Promise<void> {
    // the recorder hands over what was still building up (typed text, a scroll) while the session is still recording
    const rec = this.recorder;
    this.recorder = null;
    if (rec) await rec.stop().catch((e: unknown) => this.ctx.log.warn('teach: stopping input recording failed', errMsg(e)));
    const live = this.liveRecorder;
    if (live) {
      this.offLive?.();
      this.offLive = null;
      this.liveRecorder = null;
      await live.flush();
      this.ctx.s.liveView.hold(false);
    }
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
    this.unsub?.();
    this.unsub = null;
    const helper = this.ctx.s.computer.helper();
    if (helper) await helper.request('watch_stop', {}, 5000).catch(() => undefined);
  }

  private summarize(manual: boolean): TeachSession {
    const s = this.session!;
    const slug = slugify(s.name);
    try {
      const thread = this.ctx.s.threads.chatFor(s.botId);
      this.update({ status: 'summarizing', threadId: thread.id, stepCount: this.events.length, skillName: slug });
      const steps = this.events.map(describeEvent).filter((x): x is string => !!x);
      const shots = evenlySpaced(this.events.filter((e) => e.screenshot_base64), MAX_SHOTS);
      const lines = [
        manual
          ? `I want to teach you a reusable skill called "${s.name}". I couldn't record my screen, so work from this description.`
          : `I just showed you how to do a task on this ${this.ctx.deps.cloud ? 'computer (my AppuBot computer, through its screen)' : machineName(process.platform)}. Turn my recording into a reusable skill called "${s.name}".`,
        s.goal ? `\nGoal: ${s.goal}` : '',
        steps.length ? `\nRecorded steps (${steps.length}):\n${steps.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : '',
        shots.length ? `\n${shots.length} screenshot(s) taken at key clicks are attached in order.` : '',
        `\nWrite a clear, general SKILL.md body: when to use it, prerequisites, numbered steps that rely on app names, menu items and button labels (not raw coordinates - screens change), how to verify success, and pitfalls. Replace values I typed with placeholders where they would vary between runs.`,
        `Then call the \`save_skill\` tool with name "${slug}", a one-sentence description, and the body. Don't perform the task now - just save the skill and confirm in one short message.`,
      ];
      this.summaryMessageId = this.ctx.s.chat.send({
        threadId: thread.id,
        text: lines.filter(Boolean).join('\n'),
        attachments: [],
        images: shots.map((e) => ({ mimeType: 'image/jpeg', data: e.screenshot_base64! })),
      }, 'desktop').agentMessageId;
      this.events = [];
      return structuredClone(this.session!);
    } catch (e) {
      return this.update({ status: 'error', endedAt: Date.now(), error: errMsg(e) });
    }
  }

  async shutdown(): Promise<void> {
    if (this.session?.status === 'recording') await this.stopWatching();
  }
}

/* ---------------------------------------------------------------- live recording */

interface LiveRecorderDeps {
  emit(ev: InputEvent): void;
  /** a picture of the screen now (base64), or null */
  shot(bounds: Bounds): Promise<string | null>;
  /** the window under a point, named */
  where(pt: { x: number; y: number }): Promise<{ app?: string; title?: string } | undefined>;
}

/**
 * Live view's and the viewer's input as recorded events: a click gets a picture and the window it landed in, typed
 * text within TYPE_JOIN_MS is one `typed`, a finger down and up apart is a drag, keys and scrolls go as they are.
 * Events keep their order (each waits for the one before it). Pure apart from its deps: tested.
 */
export class LiveRecorder {
  private tail: Promise<void> = Promise.resolve();
  private typed: { text: string; at: number; ev: Promise<void> } | null = null;
  private held: { x: number; y: number } | null = null;
  constructor(private deps: LiveRecorderDeps, private now: () => number = Date.now) {}

  take(i: LiveInput, bounds: Bounds | null): void {
    const at = (fx: number, fy: number) => (bounds ? toPoint(bounds, fx, fy) : { x: Math.round(fx * 10000) / 100, y: Math.round(fy * 10000) / 100 });
    switch (i.kind) {
      case 'click': this.click(at(i.x, i.y), i.button === 'right' ? 'right_click' : 'click', i.count, bounds); break;
      case 'down': this.held = at(i.x, i.y); break;
      case 'up': {
        const from = this.held;
        this.held = null;
        if (!from) break;
        const to = at(i.x, i.y);
        if (Math.hypot(to.x - from.x, to.y - from.y) < DRAG_MIN_PX) this.click(to, 'click', 1, bounds);
        else this.enqueue({ kind: 'drag_end', from, x: to.x, y: to.y, ts: this.now() }, to, bounds);
        break;
      }
      case 'type': this.type(i.text); break;
      case 'paste': this.type(i.text); break;
      case 'key': this.flushTyped(); this.enqueue({ kind: 'key', key: i.key, modifiers: i.modifiers, ts: this.now() }); break;
      case 'scroll': this.flushTyped(); this.enqueue({ kind: 'scroll', ...at(i.x, i.y), dx: i.dx, dy: i.dy, ts: this.now() }); break;
      default: break;
    }
  }

  private click(pt: { x: number; y: number }, kind: 'click' | 'right_click', count: number, bounds: Bounds | null): void {
    this.flushTyped();
    this.enqueue({ kind, x: pt.x, y: pt.y, count, button: kind === 'right_click' ? 'right' : 'left', ts: this.now() }, pt, bounds);
  }

  private type(text: string): void {
    if (!text) return;
    const now = this.now();
    if (this.typed && now - this.typed.at <= TYPE_JOIN_MS) { this.typed.text += text; this.typed.at = now; return; }
    this.flushTyped();
    this.typed = { text, at: now, ev: Promise.resolve() };
  }

  private flushTyped(): void {
    const t = this.typed;
    if (!t) return;
    this.typed = null;
    this.enqueue({ kind: 'typed', text: t.text, ts: t.at, end_ts: this.now() });
  }

  private enqueue(ev: InputEvent, pt?: { x: number; y: number }, bounds?: Bounds | null): void {
    const where = pt ? this.deps.where(pt).catch(() => undefined) : Promise.resolve(undefined);
    const shot = pt && bounds ? this.deps.shot(bounds).catch(() => null) : Promise.resolve(null);
    this.tail = this.tail.then(async () => {
      const [w, s] = await Promise.all([where, shot]);
      const out: InputEvent = { ...ev };
      if (w?.app) out.app = w.app;
      if (w?.title) out.window_title = w.title;
      if (s) out.screenshot_base64 = s;
      try { this.deps.emit(out); } catch { /* the listener's own failure */ }
    });
  }

  /** What is still building up (typed text) goes out; resolves once every event has been handed over. */
  async flush(): Promise<void> {
    this.flushTyped();
    await this.tail;
  }
}
