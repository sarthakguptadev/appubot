/**
 * Computer use: a ComputerService that serializes actions, enforces pause, emits frames/actions,
 * on top of a pluggable backend - Cua Driver (in-process) or the Swift native helper.
 */
import { computerUseSupported, machineName, newId, type ComputerAction, type ComputerFrame, type ComputerStatus, type ComputerTarget, type ScreenControl, type ScreenWait } from '@appubot/protocol';
import type { CoreCtx, ImageCodec } from '../context';
import { errMsg, Mutex, RpcError, sleep, truncate } from '../util';
import type { HelperTransport } from './nativeHelper';
import { AgentCursorController } from './agentCursor';
import { linuxSessionProblem } from './inputRecorder';
import { ScreenControlHolder, type ControlHolder } from './screenControl';
import type { Borrow, ComputerBackend, Opened, Perms, ScreenInfo, Shot, WindowGeometry, WindowSnapshot } from './computerBackend';
import { CuaBackend, findLabel, isWeb, someLabels } from './cuaBackend';
import { AGENT_DIM, AGENT_JPEG, AGENT_QUALITY, KEYBOARD, NEEDS_WINDOW, NEEDS_WINDOW_HINT, POINTER_TYPES, SETTLE, STEP_GAP, UI_SHOT, masked, parseDetail, summarizeAction } from './computerHelpers';
import { NativeHelperBackend } from './nativeHelperBackend';
export type { Perms, ScreenInfo, Shot, Rect, WindowGeometry, WindowSnapshot, ActOptions, Borrow, UserPlace, Opened, ComputerBackend } from './computerBackend';
export { NEEDS_WINDOW_HINT, parseDetail, cuaModifier, pngSize, summarizeAction, AGENT_DIM, isBrowserApp, isWebArea, isPressable, launchArgs, findRunningApp } from './computerHelpers';
export { shownText, isWeb, findLabel, CuaBackend } from './cuaBackend';
export { NativeHelperBackend } from './nativeHelperBackend';

/* ===================================================================== service */

const SETTINGS_URLS = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen_recording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  input_monitoring: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
} as const;

/**
 * Background mode: a step that needs its window in front waits until the user has left the keyboard and mouse alone
 * this long, so it doesn't land in the middle of their typing or pointing.
 */
export const QUIET_MS = 1500;
/**
 * How long one call (a step, or a whole batch) may wait for that in all. Then its step fails rather than interrupt the
 * user, and the bot hears why (the bridge gives a call 60s).
 */
export const PAUSE_WAIT_MS = 25_000;
/** a bot's step waits this long at most for the person in control to give it back (each input of theirs renews it) */
export const CONTROL_WAIT_MS = 30 * 60_000;
/** your AppuBot computer: a bot's step waits this long at most for another bot's turn on the screen */
export const SCREEN_WAIT_MS = 10 * 60_000;
/** your AppuBot computer: a bot that has the screen and made no computer call for this long lets a waiting bot have it */
export const SCREEN_IDLE_MS = 90_000;
const GATE_POLL_MS = 200;
const PAUSE_POLL_MS = 200;
/** input read back within this of a borrowed step's own may be that step's (the readings and our clock differ a little) */
const OWN_INPUT_SLACK_MS = 150;
const USER_BUSY =
  "The user kept using the computer, and this step needs its window in front for a moment, so it waits until they pause: nothing was sent. " +
  'Try again in a little while, or a way that works behind their windows (keys, a menu, a native control rather than a web page).';
/** told to a bot once per turn in background mode (with its first computer call's result) */
const BACKGROUND_NOTE =
  '(Background mode: the user keeps using the computer meanwhile, so the windows you work in stay behind theirs; pictures and input still reach them. ' +
  'A step that needs its window in front, like a click or typing on a web page or a drag, waits until they pause. If a step did nothing, send it again with front: true.)';
const NO_WINDOW_IN_BACKGROUND =
  "The user is working in the app in front (background mode), so typing and keys need the bot's own window: give pid and window_id (computer_open_app or computer_list_windows).";

/** Why no computer-use backend is there: not on this platform, or none could start on this computer. */
function unavailableMsg(): string {
  const machine = machineName(process.platform);
  if (!computerUseSupported(process.platform)) return `Computer use is only available on macOS, Windows and Linux; it is not available on this ${machine}.`;
  return `Computer use is not available on this ${machine} (no backend could start). Open AppuBot → Settings → Computer use.`;
}

export class ComputerService {
  private backend: ComputerBackend | null = null;
  private perms: Perms = { accessibility: false, screenRecording: false };
  private screen: ScreenInfo | undefined;
  private paused = false;
  private busy = false;
  private activeThreadId: string | undefined;
  private mutex = new Mutex();
  private lastFrame: ComputerFrame | null = null;
  /** last agent snapshot per app window ("pid:windowId"): where its elements are */
  private windows = new Map<string, WindowGeometry>();
  private helperT: HelperTransport | null | undefined;
  /** overrides every SETTLE time (tests) */
  settleMs: number | null = null;
  /** the bot's pointer on the computer's screen (see agentCursor.ts) */
  readonly cursor: AgentCursorController;
  private cursorWired = false;
  /** background mode: a step waiting for the user to pause (in the status: the app and the tray say so) */
  private waiting: ComputerStatus['waiting'];
  /** ends that wait early when its turn ends */
  private stopWaiting: { threadId: string; stop: () => void } | undefined;
  /** when a borrowed step last sent input of its own, and the user's own last input as last read (see userQuietMs) */
  private ownInputAt = 0;
  private userInputAt: number | undefined;
  /** the native helper says how long the user has been idle (false: an older helper without `input_idle`) */
  private helperIdle: boolean | undefined;
  /** overrides how long the user has been idle, and PAUSE_WAIT_MS (tests) */
  idleMs: (() => number | undefined) | null = null;
  pauseWaitMs: number | null = null;
  /** threads whose bot heard this turn that background mode is on (see withNote) */
  private told = new Set<string>();
  /** live view's Take control: the one person whose input reaches the screen; the bots wait meanwhile (gate) */
  readonly control = new ScreenControlHolder();
  /** bots' steps waiting for control to come back or for their turn on the screen, by thread */
  private waits = new Map<string, ScreenWait>();
  /** ends those waits when their turn ends */
  private gateStops = new Map<string, () => void>();
  /** your AppuBot computer: the thread whose bot has the screen, and when it last used it (bots take turns: gate) */
  private lease: { threadId: string; lastAt: number } | null = null;
  /** overrides SCREEN_IDLE_MS, CONTROL_WAIT_MS and SCREEN_WAIT_MS (tests) */
  screenIdleMs: number | null = null;
  controlWaitMs: number | null = null;
  screenWaitMs: number | null = null;

  constructor(private ctx: CoreCtx) {
    this.cursor = new AgentCursorController(ctx);
    this.control.onChange((c) => {
      // the person's hand on the screen: the bot's pointer steps aside
      if (c) this.cursor.hide();
      this.emitStatus();
    });
  }

  private get codec(): ImageCodec | undefined { return this.ctx.deps.imageCodec; }
  private get cfg() { return this.ctx.s.settings.get().computer; }
  /**
   * Your AppuBot computer: its screen is the bots' own, so they always work on it for real (on-screen mode, windows
   * raised, real input) and take turns on it; there is no background mode there. A person steps in through live view.
   */
  get onScreenOnly(): boolean { return !!this.ctx.deps.cloud; }
  /** background mode as it applies here (never on your AppuBot computer) */
  private get background(): boolean { return !this.onScreenOnly && this.cfg.background; }

  /** Shared native helper transport (also used by Teach). */
  helper(): HelperTransport | null {
    if (this.helperT === undefined) {
      try {
        this.helperT = this.ctx.deps.helperTransport ? this.ctx.deps.helperTransport() : null;
      } catch (e) {
        this.ctx.log.warn('native helper unavailable', errMsg(e));
        this.helperT = null;
      }
    }
    return this.helperT;
  }

  /** the backend starting (`init`), until it is up or has failed */
  private starting: Promise<void> | null = null;

  /**
   * Starts the backend (Cua, the native helper): at launch without holding up the window (core.start doesn't await
   * it), and again from `requestPermissions` when none started. Calls while one is starting share it.
   */
  init(o: { after?: Promise<unknown> } = {}): Promise<void> {
    // `after` (launch): starting at once (Cua's driver takes ~70ms of this thread) would hold up the window; it counts
    // as starting from now, so a hello meanwhile still waits for it
    this.starting ??= (o.after ? o.after.then(() => undefined, () => undefined) : Promise.resolve())
      .then(() => this.startBackend()).finally(() => { this.starting = null; });
    return this.starting;
  }

  /**
   * While the backend is starting: a promise for its end, at most `maxMs` away (the hello's snapshot and the bots'
   * steps wait on it); null once it is up or failed.
   */
  whenReady(maxMs = 10_000): Promise<void> | null {
    if (!this.starting) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([this.starting.catch(() => undefined), new Promise<void>((r) => { timer = setTimeout(r, maxMs); })]).finally(() => clearTimeout(timer));
  }

  private async startBackend(): Promise<void> {
    // macOS, Windows and Linux (computerUseSupported): elsewhere no backend starts and bots run without computer use.
    // Only macOS has the native helper, which makes focusing, launching and looking at windows quicker: elsewhere Cua
    // does all of it.
    const mac = process.platform === 'darwin';
    const candidates = this.ctx.deps.computerBackends?.() ?? (!computerUseSupported(process.platform) ? [] : !mac ? [
      new CuaBackend({
        log: this.ctx.log,
        defaultDim: () => AGENT_DIM,
        // Wayland: Cua knows only the pointer it moved itself there, so the user's isn't put back after a borrowed step
        restorePointer: process.platform !== 'linux' || !linuxSessionProblem(process.env),
        ...(this.ctx.deps.importCua ? { load: () => this.ctx.deps.importCua!('') } : {}),
      }),
    ] : [
      new CuaBackend({
        log: this.ctx.log,
        requestPermissions: this.ctx.deps.requestCuaPermissions,
        defaultDim: () => AGENT_DIM,
        raise: async (pid, windowId) => {
          const h = this.helper();
          if (!h) throw new Error('no native helper');
          await h.request('focus_window', { pid, window_id: windowId }, 3000);
        },
        launch: async ({ name, bundleId, urls, activate }) => {
          const h = this.helper();
          if (!h) throw new Error('no native helper');
          return h.request<{ pid: number }>('open_app', { ...(bundleId ? { bundle_id: bundleId } : { name }), ...(urls ? { urls } : {}), activate }, 15_000);
        },
        streamFrame: async (windowId, maxDim) => {
          const h = this.helper();
          if (!h) throw new Error('no native helper');
          const r = await h.request<{ image_base64: string; width: number; height: number }>('window_stream_frame', { window_id: windowId, max_dimension: maxDim, quality: AGENT_QUALITY }, 5000);
          return { data: r.image_base64, width: r.width, height: r.height };
        },
        frontApp: async () => {
          const h = this.helper();
          if (!h) throw new Error('no native helper');
          return (await h.request<{ pid?: number }>('frontmost_app', {}, 2000)).pid;
        },
        activate: async (pid) => {
          const h = this.helper();
          if (!h) throw new Error('no native helper');
          await h.request('activate_app', { pid }, 5000);
        },
        ...(this.ctx.deps.importCua ? { load: () => this.ctx.deps.importCua!('') } : {}),
      }),
      new NativeHelperBackend(() => this.helper(), { defaultMaxWidth: () => AGENT_DIM }),
    ]);
    for (const b of candidates) {
      try {
        await b.init();
        this.perms = await b.permissions();
        this.screen = await b.screenSize().catch(() => undefined);
        this.backend = b;
        this.ctx.log.info(`computer use backend: ${b.name}`, this.perms);
        break;
      } catch (e) {
        this.ctx.log.warn(`computer backend ${b.name} unavailable`, errMsg(e));
        await b.shutdown().catch(() => undefined);
      }
    }
    this.emitStatus();
    // the Input Monitoring grant (teach mode) is the native helper's to tell, and starting the helper takes ~0.15s:
    // nothing waits for it (the hello at launch, a bot's first step), its answer follows as a status of its own
    void this.refreshInputMonitoring().then(() => { if (this.perms.inputMonitoring !== undefined) this.emitStatus(); });
    if (!this.cursorWired) {
      this.cursorWired = true;
      // The cursor leaves with the turn that brought it (also when the user stops the run). Once the whole task is
      // done (the turn ended with its final message, not between its steps), the screen stops being recorded: the
      // window streams that made its pictures quick end (macOS's indicator goes off), and AppuBot comes back to the
      // front with the bot's answer, unless the bot worked in the background.
      this.ctx.s.chat.onTurnCompleted((e) => {
        this.cursor.turnEnded(e.threadId);
        this.told.delete(e.threadId);
        if (this.stopWaiting?.threadId === e.threadId) this.stopWaiting.stop();
        this.gateStops.get(e.threadId)?.();
        // its turn on the screen is over: the next bot may have it
        if (this.lease?.threadId === e.threadId) { this.lease = null; this.emitStatus(); }
        if (this.activeThreadId !== e.threadId) return;
        this.activeThreadId = undefined;
        this.emitStatus();
        void this.helper()?.request('window_stream_stop', {}, 2000).catch(() => undefined);
        if (!this.background) this.ctx.deps.showApp?.(e.threadId);
      });
      let background = this.background;
      this.ctx.s.settings.onChange((next) => {
        if (!next.computer.agentCursor) this.cursor.hide();
        if (this.background !== background) { background = this.background; this.emitStatus(); }
      });
    }
  }

  private async refreshInputMonitoring(): Promise<void> {
    if (this.perms.inputMonitoring !== undefined) return;
    const h = this.helper();
    if (!h) return;
    try {
      const r = await h.request<{ input_monitoring?: boolean }>('permissions', {}, 5000);
      if (r.input_monitoring !== undefined) this.perms = { ...this.perms, inputMonitoring: r.input_monitoring };
    } catch { /* ignore */ }
  }

  status(): ComputerStatus {
    return {
      backend: this.backend?.name ?? 'none',
      available: !!this.backend,
      permissions: { ...this.perms },
      screen: this.screen,
      busy: this.busy,
      paused: this.paused,
      activeThreadId: this.activeThreadId,
      liveView: this.cfg.liveView,
      background: this.background,
      ...(this.waiting ? { waiting: this.waiting } : {}),
      takeControl: true,
      ...(this.control.current() ? { control: this.control.current()! } : {}),
      ...(this.waits.size ? { waits: [...this.waits.values()] } : {}),
      ...(this.lease ? { screenThreadId: this.lease.threadId } : {}),
      ...(this.onScreenOnly ? { onScreenOnly: true } : {}),
    };
  }

  /* ---------- live view's Take control ---------- */

  /** A viewer takes control of the screen (or renews it): refused while someone else has it (`in_control`). */
  takeControl(h: ControlHolder): ScreenControl { return this.control.take(h); }
  /** The holder gives control back (Watching again, its view closed); nothing for anyone else. */
  releaseControl(key: string): boolean { return this.control.release(key); }
  /** The holder's input: its idle time starts again. False when the key doesn't hold control. */
  touchControl(key: string): boolean { return this.control.touch(key); }

  /** a thread's bot, by name ("Ada"), for what the bots are told while they wait */
  private botName(threadId: string): string {
    const t = this.ctx.s.threads.get(threadId);
    return (t && this.ctx.s.bots.get(t.botId)?.name) || 'Another bot';
  }

  /**
   * Before a bot's computer call: it waits while a person has control (live view's Take control), and on your
   * AppuBot computer for its turn on the one screen while another bot has it (that bot's turn ends, or it makes no
   * computer call for SCREEN_IDLE_MS). The waits show in the status (`waits`: "Paused while you're in control",
   * "Waiting for the screen") and end with the turn. Returns a line for the bot when it waited.
   */
  private async gate(threadId: string | undefined): Promise<string | undefined> {
    if (!threadId) return undefined;
    const start = Date.now();
    let stopped = false;
    let last: { kind: ScreenWait['for']; who: string } | undefined;
    this.gateStops.set(threadId, () => { stopped = true; });
    try {
      for (;;) {
        const c = this.control.current();
        const idle = this.screenIdleMs ?? SCREEN_IDLE_MS;
        const other = this.onScreenOnly && this.lease && this.lease.threadId !== threadId && Date.now() - this.lease.lastAt < idle ? this.lease : null;
        if (!c && !other) break;
        if (stopped) throw new RpcError('stopped', 'Stopped: the turn ended.');
        const kind: ScreenWait['for'] = c ? 'control' : 'screen';
        const who = c ? c.name : this.botName(other!.threadId);
        const limit = kind === 'control' ? (this.controlWaitMs ?? CONTROL_WAIT_MS) : (this.screenWaitMs ?? SCREEN_WAIT_MS);
        if (Date.now() - start >= limit) {
          throw kind === 'control'
            ? new RpcError('in_control', `${who} still has control of the screen, so computer use waits. Tell the user what is left to do, or try again later.`)
            : new RpcError('screen_busy', `${who} is still using the screen. Try again in a while.`);
        }
        const prev = this.waits.get(threadId);
        if (!prev || prev.for !== kind || prev.holder !== (other?.threadId ?? undefined)) {
          this.waits.set(threadId, { threadId, for: kind, since: prev?.since ?? start, ...(other ? { holder: other.threadId } : {}) });
          this.emitStatus();
        }
        last = { kind, who };
        await sleep(GATE_POLL_MS);
      }
    } finally {
      this.gateStops.delete(threadId);
      if (this.waits.delete(threadId)) this.emitStatus();
    }
    if (this.onScreenOnly) {
      const fresh = this.lease?.threadId !== threadId;
      this.lease = { threadId, lastAt: Date.now() };
      if (fresh) this.emitStatus();
    }
    if (!last) return undefined;
    const secs = Math.round((Date.now() - start) / 1000);
    const took = secs >= 90 ? `${Math.round(secs / 60)} min` : `${secs} s`;
    return last.kind === 'control'
      ? `(Waited ${took} while ${last.who} had control of the screen; it is yours again. Look before acting: they may have changed things.)`
      : `(Waited ${took} for the screen while ${last.who} used it. Look before acting: windows may have moved.)`;
  }

  /** the bot that has the screen used it just now (its idle time on the screen starts again) */
  private usedScreen(threadId: string | undefined): void {
    if (threadId && this.lease?.threadId === threadId) this.lease.lastAt = Date.now();
  }

  /** A line the bot gets with its call's result. */
  private static withLine(text: string | undefined, line: string | undefined): string | undefined {
    if (!line) return text;
    return text ? `${line}\n${text}` : line;
  }

  emitStatus(): void { this.ctx.bus.emit('computer.status', this.status()); }

  async refreshPermissions(): Promise<ComputerStatus> {
    await this.whenReady();
    if (this.backend) {
      try { this.perms = await this.backend.permissions(); }
      catch (e) { this.ctx.log.warn('permission check failed', errMsg(e)); }
    }
    await this.refreshInputMonitoring();
    this.emitStatus();
    return this.status();
  }

  async requestPermissions(): Promise<ComputerStatus> {
    await this.whenReady();
    try {
      // macOS's grants (Windows and Linux have none to ask for: CuaBackend's own check says what is missing there)
      if (process.platform === 'darwin' && this.backend?.name === 'cua-driver' && this.ctx.deps.requestCuaPermissions) await this.ctx.deps.requestCuaPermissions();
      else if (this.backend) await this.backend.requestPermissions();
    } catch (e) { this.ctx.log.warn('requesting permissions failed', errMsg(e)); }
    if (!this.backend) await this.init();
    return this.refreshPermissions();
  }

  async openSettings(pane: keyof typeof SETTINGS_URLS): Promise<{ ok: true }> {
    if (!computerUseSupported(process.platform)) throw new RpcError('unavailable', unavailableMsg());
    // System Settings' privacy panes: Windows and Linux ask for no permissions
    if (process.platform !== 'darwin') throw new RpcError('unsupported', `There are no permissions to grant on this ${machineName(process.platform)}.`);
    await this.ctx.deps.openExternal(SETTINGS_URLS[pane]);
    return { ok: true };
  }

  pause(): ComputerStatus { this.paused = true; this.cursor.hide(); this.emitStatus(); return this.status(); }
  resume(): ComputerStatus { this.paused = false; this.emitStatus(); return this.status(); }
  isPaused(): boolean { return this.paused; }

  setLiveView(enabled: boolean): ComputerStatus {
    this.ctx.s.settings.update({ computer: { ...this.cfg, liveView: enabled } });
    this.emitStatus();
    return this.status();
  }

  getLastFrame(): ComputerFrame | null { return this.lastFrame; }

  private setBusy(busy: boolean, threadId?: string): void {
    this.busy = busy;
    if (busy) this.activeThreadId = threadId;
    this.emitStatus();
  }

  private async capture(maxWidth: number | undefined, threadId: string | undefined, action: ComputerAction | undefined): Promise<ComputerFrame> {
    const b = this.backend!;
    let width = maxWidth ?? AGENT_DIM;
    // Cua: keep the agent's coordinate space stable - UI screenshots reuse the last agent size.
    if (!action && b instanceof CuaBackend && b.currentDim()) width = b.currentDim();
    const shot = await b.screenshot({ maxWidth: width, quality: AGENT_JPEG });
    return this.toFrame(shot, threadId, action, undefined);
  }

  /**
   * On-screen mode (default): bring the bot's window to the front before it acts, so the user watches the app
   * react. Input still goes straight to the app (their pointer stays put, except for a click on a web page). Background
   * mode skips this: the window stays where it is and only a step that needs it in front borrows the screen (borrowScreen).
   */
  private async raiseFor(action: ComputerAction): Promise<void> {
    if (this.background || action.pid === undefined || action.windowId === undefined || !this.backend?.raise) return;
    try {
      // raising takes Cua about a second even for the window already in front: ask first (a few ms)
      if (this.backend.isFront && (await this.backend.isFront(action.pid, action.windowId).catch(() => false))) return;
      await this.backend.raise(action.pid, action.windowId);
      // give the raised window a moment to come forward before acting / capturing it
      await sleep(120);
    } catch (e) {
      this.ctx.log.debug('raise window failed', errMsg(e));
    }
  }

  /**
   * Background mode: a step that needs its window in front (see ActOptions.borrow). It waits until the user pauses,
   * notes where they are, sends the input (the window comes forward for a moment), then puts their app or window and
   * pointer back.
   * `call` is the call's waiting budget, shared by a batch's steps.
   */
  private async borrowScreen<T>(threadId: string, app: string | undefined, send: () => Promise<T>, call: { waited: number }): Promise<T> {
    await this.untilUserPauses(threadId, app, call);
    const place = await this.backend?.userPlace?.().catch((e) => { this.ctx.log.debug('noting where the user is failed', errMsg(e)); return undefined; });
    try {
      return await send();
    } finally {
      this.ownInputAt = Date.now();
      await place?.restore().catch((e) => this.ctx.log.debug('putting the user back failed', errMsg(e)));
      this.ownInputAt = Date.now();
    }
  }

  /** Wait until the user has left the keyboard and mouse alone for QUIET_MS, within the call's budget (else USER_BUSY). */
  private async untilUserPauses(threadId: string, app: string | undefined, call: { waited: number }): Promise<void> {
    let quiet = await this.userQuietMs();
    if (quiet === undefined || quiet >= QUIET_MS) return;
    const start = Date.now();
    let stopped = false;
    this.stopWaiting = { threadId, stop: () => { stopped = true; } };
    this.waiting = { threadId, app, since: start };
    this.emitStatus();
    try {
      while (quiet !== undefined && quiet < QUIET_MS) {
        if (this.paused) throw new RpcError('paused', 'Computer use is paused by the user');
        if (stopped) throw new Error('Stopped: the turn ended.');
        if (call.waited + (Date.now() - start) >= (this.pauseWaitMs ?? PAUSE_WAIT_MS)) throw new Error(USER_BUSY);
        await sleep(Math.min(PAUSE_POLL_MS, Math.max(20, QUIET_MS - quiet)));
        quiet = await this.userQuietMs();
      }
    } finally {
      call.waited += Date.now() - start;
      this.stopWaiting = undefined;
      this.waiting = undefined;
      this.emitStatus();
    }
  }

  /**
   * How long the user has left the keyboard and mouse alone (ms), or undefined when this computer can't tell (then
   * nothing waits). The system counts a borrowed step's own input as input too, so input that came no later than our
   * own (give or take the reading's resolution) may be ours: the user's last input stays the one seen before it.
   */
  private async userQuietMs(): Promise<number | undefined> {
    const idle = await this.systemIdle();
    if (!idle) return undefined;
    const now = Date.now();
    const last = now - idle.ms;
    if (last <= this.ownInputAt + idle.resolution + OWN_INPUT_SLACK_MS && this.userInputAt !== undefined) return now - this.userInputAt;
    this.userInputAt = last;
    return idle.ms;
  }

  /** Time since the last keyboard or mouse input: the native helper's (macOS, exact), else the system's (whole seconds). */
  private async systemIdle(): Promise<{ ms: number; resolution: number } | undefined> {
    if (this.idleMs) {
      const ms = this.idleMs();
      return ms === undefined ? undefined : { ms, resolution: 0 };
    }
    const h = process.platform === 'darwin' && this.helperIdle !== false ? this.helper() : null;
    if (h) {
      try {
        const r = await h.request<{ seconds?: number }>('input_idle', {}, 1000);
        if (typeof r.seconds === 'number' && Number.isFinite(r.seconds)) { this.helperIdle = true; return { ms: Math.max(0, r.seconds * 1000), resolution: 0 }; }
      } catch (e) {
        if ((e as { code?: string }).code === 'unknown_command') this.helperIdle = false;
        else this.ctx.log.debug('input idle time failed', errMsg(e));
      }
    }
    const s = this.ctx.deps.systemIdleMs?.();
    return s === undefined ? undefined : { ms: s, resolution: 1000 };
  }

  /** Live-view frame of an app window after the agent acted on it (does not disturb its element tokens). */
  private async captureWindow(pid: number, windowId: number, threadId: string | undefined, action: ComputerAction | undefined): Promise<ComputerFrame> {
    const b = this.backend!;
    if (!b.windowShot) return this.capture(undefined, threadId, action);
    const { shot, target } = await b.windowShot({ pid, windowId, maxWidth: AGENT_DIM });
    // the window may have moved since the snapshot: aim (and draw the cursor) where it is now
    const g = this.windows.get(`${pid}:${windowId}`);
    if (g && target.bounds && shot.width === g.shotWidth && shot.height === g.shotHeight) this.moveGeometry(g, target.bounds);
    return this.toFrame(shot, threadId, action, target);
  }

  private moveGeometry(g: WindowGeometry, bounds: NonNullable<ComputerTarget['bounds']>): void {
    const old = g.target.bounds;
    if (old.x === bounds.x && old.y === bounds.y && old.width === bounds.width && old.height === bounds.height) return;
    g.target = { ...g.target, bounds };
    for (const el of g.elements.values()) el.pt = { x: bounds.x + (el.px.x * bounds.width) / (g.shotWidth || 1), y: bounds.y + (el.px.y * bounds.height) / (g.shotHeight || 1) };
  }

  /**
   * The frame as the bot gets it: the backend's picture at its own size (so pixels stay the coordinates), as a
   * high-quality JPEG. Cua's PNGs run to 1-2 MB for a big window; the agent sends every picture of the turn again with
   * each request, so a lossless one makes every later step slower. Watchers get per-device encodes.
   */
  private toFrame(shot: Shot, threadId: string | undefined, action: ComputerAction | undefined, target: ComputerTarget | undefined): ComputerFrame {
    shot = this.forAgent(shot);
    const frame: ComputerFrame = { id: newId('frm'), threadId, mimeType: shot.mimeType, data: shot.data, width: shot.width, height: shot.height, ts: Date.now(), action, ...(target ? { target } : {}) };
    this.lastFrame = frame;
    if (this.cfg.liveView) this.ctx.bus.emit('computer.frame', frame);
    return frame;
  }

  private forAgent(shot: Shot): Shot {
    if (shot.mimeType !== 'image/png' || !this.codec) return shot;
    try {
      const jpg = this.codec.encode(shot.data, { maxDim: Math.max(shot.width, shot.height), quality: AGENT_QUALITY });
      // never a different size: the bot aims at pixels of this picture
      return jpg && jpg.width === shot.width && jpg.height === shot.height && jpg.data.length < shot.data.length ? { ...shot, ...jpg } : shot;
    } catch (e) {
      this.ctx.log.debug('agent picture encode failed', errMsg(e));
      return shot;
    }
  }

  /**
   * Where an action lands: in screen points (for the on-screen agent cursor) and normalised 0..1 in the image the
   * live view shows (the window's picture, or the whole screen).
   */
  private locate(a: ComputerAction): { global?: { x: number; y: number }; norm?: { x: number; y: number }; endGlobal?: { x: number; y: number } } {
    const key = a.pid !== undefined && a.windowId !== undefined ? `${a.pid}:${a.windowId}` : undefined;
    const g = key ? this.windows.get(key) : undefined;
    if (g) {
      // Everything comes from the snapshot the bot is acting on: its window bounds and its image. (Re-anchoring to
      // a fresh `list_windows` reading put the pointer off: that call reports bounds in a different frame.)
      const { bounds } = g.target;
      const toPt = (px: number, py: number) => ({ x: bounds.x + (px * bounds.width) / (g.shotWidth || 1), y: bounds.y + (py * bounds.height) / (g.shotHeight || 1) });
      const el = a.element ? g.elements.get(a.element) : undefined;
      const px = el?.px ?? (a.x !== undefined && a.y !== undefined ? { x: a.x, y: a.y } : undefined);
      if (!px) return {};
      return {
        global: el?.pt ?? toPt(px.x, px.y),
        norm: { x: px.x / (g.shotWidth || 1), y: px.y / (g.shotHeight || 1) },
        endGlobal: a.toX !== undefined && a.toY !== undefined ? toPt(a.toX, a.toY) : undefined,
      };
    }
    // whole-screen coordinates: pixels of the last desktop screenshot of the primary display (origin 0,0)
    const f = this.lastFrame && !this.lastFrame.target ? this.lastFrame : null;
    if (!f || a.x === undefined || a.y === undefined || !this.screen?.width) return {};
    const toPt = (px: number, py: number) => ({ x: (px * this.screen!.width) / f.width, y: (py * this.screen!.height) / f.height });
    return {
      global: toPt(a.x, a.y),
      norm: { x: a.x / f.width, y: a.y / f.height },
      endGlobal: a.toX !== undefined && a.toY !== undefined ? toPt(a.toX, a.toY) : undefined,
    };
  }

  /**
   * A bot's pointer input lands on one point of the window picture, the same point its cursor glides to, so the user
   * always sees where it clicks. An element token is turned into that point: pressing the element instead would land
   * wherever the app says it is, which can be far from where it is drawn (Chess reports its squares upside down).
   */
  private atElement(a: ComputerAction, key: string | undefined): ComputerAction {
    const el = key ? this.windows.get(key)?.elements.get(a.element!) : undefined;
    if (!el) throw new Error('That element_token is not in the latest computer_window snapshot of this window: call computer_window again, then aim with x/y pixels of its image.');
    return { ...a, element: undefined, x: Math.round(el.px.x), y: Math.round(el.px.y) };
  }

  private ensureUsable(): ComputerBackend {
    if (!this.cfg.enabled) throw new RpcError('disabled', 'Computer use is turned off in AppuBot settings');
    if (this.paused) throw new RpcError('paused', 'Computer use is paused by the user');
    if (!this.backend) throw new RpcError('unavailable', unavailableMsg());
    return this.backend;
  }

  /** A device's own screenshot (`computer.screenshot`): the screen, re-encoded smaller for the trip (the bot's go through act). */
  async screenshot(maxWidth?: number, quality?: number): Promise<ComputerFrame> {
    await this.whenReady();
    if (!this.backend) throw new RpcError('unavailable', unavailableMsg());
    const frame = await this.mutex.run(() => this.capture(undefined, undefined, undefined)).catch((e) => {
      if (e instanceof RpcError) throw e;
      throw new RpcError('screenshot_failed', this.screenshotHint(errMsg(e)));
    });
    const small = this.codec?.encode(frame.data, { maxDim: maxWidth ?? UI_SHOT.maxDim, quality: quality ?? UI_SHOT.quality });
    return small ? { ...frame, ...small } : frame;
  }

  private screenshotHint(msg: string): string {
    if (this.perms.screenRecording) return msg;
    if (process.platform === 'win32') return `${msg} - AppuBot can't capture the screen on this PC right now (Cua's screen capture check failed).`;
    if (process.platform === 'linux') return `${msg} - AppuBot can't capture the screen here: it needs an X11 session (on Wayland, only apps running through XWayland).`;
    return `${msg} - Screen Recording permission is not granted to AppuBot (System Settings → Privacy & Security → Screen Recording).`;
  }

  async act(action: ComputerAction, threadId?: string): Promise<{ ok: boolean; frame?: ComputerFrame; text?: string }> {
    await this.whenReady();
    this.ensureUsable();
    const waited = await this.gate(threadId);
    return this.mutex.run(async () => {
      this.setBusy(true, threadId);
      try {
        const { ok, frame, text } = await this.step(action, threadId, true, { waited: 0 });
        return { ok, frame, text: ComputerService.withLine(this.withNote(text, threadId), waited) };
      } finally {
        this.usedScreen(threadId);
        this.setBusy(false);
      }
    });
  }

  /**
   * The user's own hand on this computer where no native helper posts it (live view's take-over on the AppuBot Cloud
   * computer, teach mode there): whole-screen coordinates through the backend's desktop scope, under the same mutex as
   * the bots' steps, allowed while the bots are paused (that is what the pause is for) and whatever the setting says
   * about bots using the computer. No action event, no picture, no agent cursor: it is the user, not a bot.
   */
  async userAct(action: ComputerAction): Promise<{ text?: string }> {
    await this.whenReady();
    const backend = this.backend;
    if (!backend) throw new RpcError('unavailable', unavailableMsg());
    return this.mutex.run(() => backend.act(action, { desktop: true }));
  }

  /** The window under a global screen point, named (teach mode's "in Chromium (“Gmail”)"); nothing where it can't tell. */
  async windowAtPoint(pt: { x: number; y: number }): Promise<{ app?: string; title?: string } | undefined> {
    await this.whenReady();
    return this.backend?.windowAtPoint?.(pt).catch(() => undefined);
  }

  /** "Safari (“Sign in · GitHub”)" for a window AppuBot has looked at, else undefined. */
  windowName(pid: number, windowId: number): string | undefined {
    const t = this.windows.get(`${pid}:${windowId}`)?.target;
    if (!t?.app) return undefined;
    return t.title ? `${t.app} (“${t.title}”)` : t.app;
  }

  /**
   * Types a Vault item into a window for a bot (`agent.vault.fill`): a typing step with no look afterwards, its text
   * masked wherever the step is reported, and a failure's message kept free of it.
   */
  async typeSecret(action: ComputerAction, threadId: string): Promise<{ ok: boolean; text?: string }> {
    await this.whenReady();
    this.ensureUsable();
    await this.gate(threadId);
    return this.mutex.run(async () => {
      this.setBusy(true, threadId);
      try {
        const r = await this.step({ ...action, type: 'type', secret: true }, threadId, false, { waited: 0 });
        const secret = action.text ?? '';
        return { ok: r.ok, text: r.ok ? undefined : (secret ? (r.text ?? '').split(secret).join('••••••') : r.text) };
      } finally {
        this.usedScreen(threadId);
        this.setBusy(false);
      }
    });
  }

  /**
   * Several actions back to back in one call (`computer.batch`): one agent turn instead of one per action. Steps
   * without a window use the one the previous step worked in (or the app it opened); none gets a picture of its own,
   * the first failure (or a pause) stops the rest, and one look at the window comes back at the end. The computer
   * stays this bot's for the whole batch, so another bot's actions can't land in between.
   */
  async batch(steps: ComputerAction[], look: 'window' | 'picture' | 'none', threadId?: string): Promise<{ ok: boolean; done: number; frame?: ComputerFrame; text?: string }> {
    await this.whenReady();
    this.ensureUsable();
    const waited = await this.gate(threadId);
    return this.mutex.run(async () => {
      this.setBusy(true, threadId);
      const log: string[] = [];
      let done = 0;
      let ok = true;
      let at: { pid: number; windowId: number } | undefined;
      let last: ComputerAction | undefined;
      // background mode: the batch's steps share one budget for waiting until the user pauses
      const call = { waited: 0 };
      try {
        for (const [i, step] of steps.entries()) {
          if (this.paused) { ok = false; log.push(`${i + 1}. Stopped: the user paused computer use.`); break; }
          // a person took control mid-batch: their hand is on the screen now, the rest waits for the next call
          const took = threadId ? this.control.current() : null;
          if (took) { ok = false; log.push(`${i + 1}. Stopped: ${took.name} took control of the screen. Your next computer call waits until they give it back.`); break; }
          const a: ComputerAction = { ...step };
          if (at && a.pid === undefined && a.windowId === undefined && a.type !== 'open_app' && a.type !== 'screenshot' && a.type !== 'clipboard' && a.type !== 'other') {
            a.pid = at.pid;
            a.windowId = at.windowId;
          }
          const r = await this.step(a, threadId, false, call);
          last = r.ev;
          if (!r.ok) { ok = false; log.push(`${i + 1}. ${summarizeAction(r.ev)}: FAILED: ${r.text ?? 'failed'}`); break; }
          done++;
          if (r.opened?.windowId !== undefined) at = { pid: r.opened.pid, windowId: r.opened.windowId };
          else if (a.pid !== undefined && a.windowId !== undefined) at = { pid: a.pid, windowId: a.windowId };
          const said = r.opened ? `pid ${r.opened.pid}${r.opened.windowId !== undefined ? `, window_id ${r.opened.windowId}` : ' (no window on screen yet)'}` : r.text && !/^(Clicked\.|ok|Typed\.?)$/i.test(r.text.trim()) ? truncate(r.text.trim(), 300) : '';
          log.push(`${i + 1}. ${summarizeAction(r.ev)}${step.label ? ` on "${step.label}"` : ''}${said ? `: ${said}` : ''}`);
        }
        let frame: ComputerFrame | undefined;
        let text: string | undefined;
        if (look !== 'none' && this.backend) {
          const settle = last ? SETTLE[last.type] : undefined;
          if (settle !== undefined) await sleep(this.settleMs ?? settle);
          try {
            if (at && look === 'window' && this.backend.windowSnapshot) {
              const snap = await this.snapshot(at.pid, at.windowId);
              frame = this.toFrame(snap.shot, threadId, { type: 'window', pid: at.pid, windowId: at.windowId, app: snap.geometry.target.app }, snap.geometry.target);
              text = snap.text;
            } else {
              frame = at ? await this.captureWindow(at.pid, at.windowId, threadId, last) : await this.capture(undefined, threadId, last);
            }
          } catch (e) {
            log.push(`(could not look at the result: ${this.screenshotHint(errMsg(e))})`);
          }
        }
        const head = ok ? `Did all ${done} steps.` : `Did ${done} of ${steps.length} steps; the rest were skipped.`;
        return { ok, done, frame, text: ComputerService.withLine(this.withNote([head, ...log, ...(text ? ['', text] : [])].join('\n'), threadId), waited) };
      } finally {
        this.usedScreen(threadId);
        this.setBusy(false);
      }
    });
  }

  /** Background mode, once per turn: the bot hears that its windows stay behind the user's, and how to ask for the front. */
  private withNote(text: string | undefined, threadId: string | undefined): string | undefined {
    if (!threadId || !this.background || this.told.has(threadId)) return text;
    this.told.add(threadId);
    return text ? `${text}\n\n${BACKGROUND_NOTE}` : BACKGROUND_NOTE;
  }

  /** A fresh snapshot of a window for the agent: its picture, and its elements become the ones tokens resolve in. */
  private async snapshot(pid: number, windowId: number, maxElements = 300): Promise<WindowSnapshot> {
    const snap = await this.backend!.windowSnapshot!({ pid, windowId, maxElements, maxWidth: AGENT_DIM });
    this.windows.set(`${pid}:${windowId}`, snap.geometry);
    return snap;
  }

  /**
   * An element given by its accessibility label, or by its number in the window's snapshot, as a token of that
   * snapshot. A label comes from the latest snapshot, or a fresh one when it isn't there (none yet, or the window has
   * changed since).
   */
  private async resolveElement(a: ComputerAction, key: string | undefined): Promise<ComputerAction> {
    if (a.pid === undefined || a.windowId === undefined || !key) throw new Error('Aiming by label or element number needs the window: give pid and window_id.');
    if (a.label === undefined) {
      const g = this.windows.get(key) ?? (await this.snapshot(a.pid, a.windowId)).geometry;
      const token = `${g.snapshotId ?? ''}:${a.element}`;
      if (!g.elements.has(token)) throw new Error(`There is no element [${a.element}] in the latest computer_window snapshot of this window.`);
      return { ...a, element: token };
    }
    let g = this.windows.get(key);
    let hit = g ? findLabel(g, a.label, process.platform) : null;
    if (!hit && this.backend?.windowSnapshot) {
      g = (await this.snapshot(a.pid, a.windowId)).geometry;
      hit = findLabel(g, a.label, process.platform);
    }
    if (!hit || !g) throw new Error(`Nothing labelled "${a.label}" in this window.${g ? ` Labels there: ${someLabels(g, a.label)}` : ''}`);
    return { ...a, label: undefined, element: hit.token };
  }

  /**
   * One action, with the computer already this caller's. `look`: wait for the app to draw and return a picture
   * after it (a batch only looks at the end). `call`: the call's budget for waiting until the user pauses (background
   * mode). Never throws: a failure comes back as `ok: false`.
   */
  private async step(action: ComputerAction, threadId: string | undefined, look: boolean, call: { waited: number }): Promise<{ ok: boolean; frame?: ComputerFrame; text?: string; ev: ComputerAction; opened?: Opened }> {
    const d = parseDetail(action.detail);
    const key = action.pid !== undefined && action.windowId !== undefined ? `${action.pid}:${action.windowId}` : undefined;
    let ev: ComputerAction = action;
    let point: { x: number; y: number } | undefined;
    let opened: Opened | undefined;
    try {
      const backend = this.ensureUsable();
      let text: string | undefined;
      let frame: ComputerFrame | undefined;
      if (action.type === 'screenshot') {
        const mw = Number(d.value ?? 0);
        this.cursor.look(action, threadId);
        frame = await this.capture(mw >= 320 ? mw : undefined, threadId, action);
      } else if (action.type === 'window') {
        if (action.pid === undefined || action.windowId === undefined) throw new Error('computer_window needs pid and window_id (see computer_list_windows)');
        if (!backend.windowSnapshot) throw new Error(`This ${machineName(process.platform)}'s computer-use backend cannot look at single windows; use computer_screenshot.`);
        if (threadId) await this.raiseFor(action);
        this.cursor.look(action, threadId);
        const snap = await this.snapshot(action.pid, action.windowId, Math.min(1500, Math.max(20, Number(d.max_elements ?? 300) || 300)));
        ev = { ...action, app: snap.geometry.target.app };
        frame = this.toFrame(snap.shot, threadId, ev, snap.geometry.target);
        text = snap.text;
      } else if (action.type === 'wait') {
        await sleep(Math.min(15_000, Math.max(0, Number(d.value ?? 1000) || 1000)));
        if (look) frame = key ? await this.captureWindow(action.pid!, action.windowId!, threadId, action) : await this.capture(undefined, threadId, action);
      } else {
        // background mode: the user keeps working meanwhile, so the bot's window stays where it is (see borrowScreen)
        const bg = !!threadId && this.background;
        if (action.label !== undefined || (action.element !== undefined && /^\d+$/.test(action.element))) ev = action = await this.resolveElement(action, key);
        // bots act on app windows only; whole-screen pointer events would move the user's own mouse
        if (threadId && NEEDS_WINDOW.has(action.type) && !key && !action.element) throw new Error(NEEDS_WINDOW_HINT);
        // typing and keys with no window go to the app in front, which is the user's own in background mode
        if (bg && KEYBOARD.has(action.type) && !key && !action.element) throw new Error(NO_WINDOW_IN_BACKGROUND);
        if (threadId && NEEDS_WINDOW.has(action.type) && action.element) ev = action = this.atElement(action, key);
        const g = key ? this.windows.get(key) : undefined;
        if (threadId && key && !g && backend.windowSnapshot && NEEDS_WINDOW.has(action.type) && action.type !== 'move') throw new Error('Call computer_window for this window first, then aim with x/y pixels of its image (or by label).');
        const loc = this.locate(action);
        point = loc.norm;
        if (g?.target.app) ev = { ...action, app: g.target.app };
        // bring the window forward while the cursor glides to the point (both before the input goes out)
        // (in a batch the short hop runs alongside the input rather than before it). In background mode the cursor is
        // only drawn where the user can see the bot's window, never over what they are doing.
        const shown = !bg || (key !== undefined && (await backend.visibleAt?.(action.pid!, action.windowId!, loc.global).catch(() => false)) === true);
        const glide = shown ? this.cursor.before(action, threadId, loc.global ?? null, !look) : this.cursor.away(threadId);
        await Promise.all([threadId ? this.raiseFor(action) : undefined, look ? glide : undefined]);
        if (shown && action.type === 'drag' && loc.endGlobal) this.cursor.follow(loc.endGlobal, Number(d.value ?? 500) || 500);
        const px = action.x !== undefined && action.y !== undefined ? { x: action.x, y: action.y } : undefined;
        const web = !!threadId && isWeb(g, POINTER_TYPES.has(action.type) ? px : undefined);
        // the cursor hears how it went either way, so typing never outlives a failed action
        let acted = false;
        try {
          const borrow: Borrow | undefined = bg ? <T>(send: () => Promise<T>) => this.borrowScreen(threadId!, g?.target.app ?? action.app, send, call) : undefined;
          const r = await backend.act(action, { desktop: !threadId, web, pt: loc.global, front: !!threadId && !bg, ...(borrow ? { borrow } : {}), ...(threadId && this.onScreenOnly ? { real: true } : {}) });
          text = r.text || undefined;
          opened = r.opened;
          acted = true;
        } finally { this.cursor.after(action, threadId, acted); }
        if (opened?.windowId !== undefined) {
          // the app's window, ready to act on: saves the agent a computer_window call
          ev = { ...action, pid: opened.pid, windowId: opened.windowId };
          if (look && backend.windowSnapshot) {
            try {
              const snap = await this.snapshot(opened.pid, opened.windowId);
              frame = this.toFrame(snap.shot, threadId, { ...ev, type: 'window', app: snap.geometry.target.app }, snap.geometry.target);
              text = `${text ?? 'Opened.'}\n\n${snap.text}`;
            } catch (e) {
              text = `${text ?? 'Opened.'}\n(could not look at its window yet: ${errMsg(e)}; use computer_window)`;
            }
          }
        }
        const settle = SETTLE[action.type];
        if (settle !== undefined && look) {
          await sleep(this.settleMs ?? settle);
          try { frame = key ? await this.captureWindow(action.pid!, action.windowId!, threadId, ev) : await this.capture(undefined, threadId, ev); }
          catch (e) { text = `${text ? text + '\n' : ''}(screenshot failed: ${this.screenshotHint(errMsg(e))})`; }
        } else if (!look) {
          const gap = STEP_GAP[action.type];
          if (gap) await sleep(this.settleMs ?? gap);
        }
      }
      this.ctx.bus.emit('computer.action', { threadId, action: masked(ev), ts: Date.now(), ok: true, summary: summarizeAction(ev), ...(point ? { point } : {}), ...(key ? { target: { pid: action.pid!, windowId: action.windowId! } } : {}) });
      return { ok: true, frame, text, ev, opened };
    } catch (e) {
      const msg = action.type === 'screenshot' || action.type === 'wait' ? this.screenshotHint(errMsg(e)) : errMsg(e);
      this.ctx.bus.emit('computer.action', { threadId, action: masked(ev), ts: Date.now(), ok: false, summary: msg.slice(0, 300) });
      return { ok: false, text: msg, ev };
    }
  }

  async shutdown(): Promise<void> {
    // a backend still starting is stopped once it is up, not left running
    await this.whenReady(5000);
    this.control.shutdown();
    for (const stop of this.gateStops.values()) stop();
    this.cursor.hide();
    await this.backend?.shutdown().catch(() => undefined);
    this.backend = null;
    this.helperT?.close();
    this.helperT = null;
  }
}
