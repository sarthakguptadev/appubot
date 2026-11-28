/**
 * Agent cursor: while a bot uses the computer, its own avatar rides a small pointer on the screen. The pointer
 * glides to each target before the click lands; the avatar reacts to what the bot does (a press and a ripple on a
 * click, a grab on a drag, eyes that follow a scroll, keystroke bounces while it types, a wide-eyed look when it takes
 * a snapshot), thinks between actions (its `tool` mood: round eyes, wandering) and asks for you while the turn waits for a permission. It
 * stays until the bot's turn ends (Cua Driver has the same idea, but its overlay needs Cua's standalone GUI service,
 * which an embedded app can't use). The drawing lives behind `AgentCursorHost` (an Electron overlay window in the
 * app, absent in tests); this controller decides when the cursor shows, moves, reacts and hides. The bot's real input
 * goes to app windows in the background, so the user's own mouse never moves: this cursor is how they see where the
 * bot is working.
 */
import { botFigure, characterKey, motionSeed, type BotFigure, type BotMood } from '@appubot/chat-core';
import type { ComputerAction, EventPayload } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { errMsg } from '../util';

/**
 * The overlay window's title. Windows and Linux list it among the app windows (it is always on top), so the computer
 * backend leaves the window with this title out of AppuBot's own process when it asks which window is in front.
 */
export const AGENT_CURSOR_TITLE = 'AppuBot agent cursor';

/**
 * Can the overlay be drawn safely on this system (`os`: Node's `process.platform`, `env`: its environment, `release`:
 * `os.release()`)? It is a transparent, click-through, always-on-top window over the whole display, kept out of
 * screenshots:
 * - macOS: yes.
 * - Windows: from Windows 10 2004 (build 19041), which leaves such a window out of captures; before it, the agent's
 *   screenshots would show it as a black screen.
 * - Linux: only in an X11 session of a desktop that always composites (GNOME, KDE, Cinnamon…). Without a compositor a
 *   transparent window draws black over the screen, and Wayland lets no app place or raise its own windows.
 */
export function agentCursorSupport(os: string, env: Record<string, string | undefined>, release: string): { ok: boolean; why?: string } {
  if (os === 'darwin') return { ok: true };
  if (os === 'win32') {
    const [major = 0, , build = 0] = release.split('.').map((n) => Number(n) || 0);
    return major > 10 || (major === 10 && build >= 19041) ? { ok: true } : { ok: false, why: 'needs Windows 10 version 2004 or later to stay out of screenshots' };
  }
  if (os !== 'linux') return { ok: false, why: 'not on this system' };
  if (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY) return { ok: false, why: 'Wayland lets no app keep an overlay on top' };
  if (!env.DISPLAY) return { ok: false, why: 'no X11 display' };
  const desktops = (env.XDG_CURRENT_DESKTOP ?? '').toLowerCase().split(':').map((d) => d.trim());
  return desktops.some((d) => COMPOSITING_DESKTOPS.has(d)) ? { ok: true } : { ok: false, why: 'needs a compositing desktop (GNOME, KDE, Cinnamon…) for a transparent overlay' };
}
/** Linux desktops (XDG_CURRENT_DESKTOP) whose window manager always composites on X11. */
const COMPOSITING_DESKTOPS = new Set(['gnome', 'gnome-classic', 'ubuntu', 'kde', 'cinnamon', 'x-cinnamon', 'unity', 'budgie', 'budgie-desktop', 'pantheon', 'deepin']);

/** One-shot reactions where the cursor is. */
export type CursorReaction = 'click' | 'double' | 'right' | 'grab' | 'release' | `scroll-${'up' | 'down' | 'left' | 'right'}` | 'key' | 'look';

export interface AgentCursorHost {
  /**
   * Show the cursor as this bot (its avatar's look; `seed` offsets its loops), in the `rest` mood. A hidden cursor
   * pops in at the user's pointer; a showing one keeps its place.
   */
  show(o: { figure: BotFigure; color: string; seed: number; chief?: boolean }): void;
  /** Glide to a point in GLOBAL screen points (any display); resolves when the pointer arrives. */
  moveTo(x: number, y: number, durationMs: number): Promise<void>;
  react(kind: CursorReaction): void;
  /** A loop for as long as the bot keeps doing something (`typing`); `null` ends it with a small nod. */
  activity(kind: 'typing' | null): void;
  /** The avatar's mood: `rest` while it acts, `tool` while it thinks, `needs-you` while it waits for you. */
  mood(mood: BotMood): void;
  hide(): void;
  dispose(): void;
}

const POINTER = new Set<ComputerAction['type']>(['click', 'double_click', 'right_click', 'move', 'drag', 'scroll']);
/** What brings the cursor out: pointer actions and keyboard input into the bot's window. */
const SHOWS = new Set<ComputerAction['type']>([...POINTER, 'type', 'key', 'hotkey']);
/** The bot looking rather than acting: only a cursor that is already out reacts. */
const LOOKS = new Set<ComputerAction['type']>(['window', 'screenshot', 'open_app', 'focus_window']);
/** No computer action for this long while the turn runs: the bot is thinking. */
export const THINK_MS = 1200;

/** The longest glide between the steps of a batch. */
export const QUICK_GLIDE_MS = 90;

/** Glide time grows with distance (roughly Fitts-like), bounded so the agent never waits long (the action waits for it). */
export function glideMs(dx: number, dy: number): number {
  return Math.round(Math.min(380, 140 + Math.hypot(dx, dy) * 0.3));
}

/** Which way a scroll goes (`detail.direction`, as the backends read it; down when absent). */
function scrollWay(detail: string | undefined): 'up' | 'down' | 'left' | 'right' {
  let d: unknown;
  try { d = (JSON.parse(detail ?? '{}') as { direction?: unknown }).direction; } catch { /* not JSON (or null) */ }
  return d === 'up' || d === 'left' || d === 'right' ? d : 'down';
}

function reaction(a: ComputerAction): CursorReaction | null {
  switch (a.type) {
    case 'click': return 'click';
    case 'double_click': return 'double';
    case 'right_click': return 'right';
    case 'drag': return 'release';
    case 'scroll': return `scroll-${scrollWay(a.detail)}`;
    case 'key': case 'hotkey': return 'key';
    default: return null;
  }
}

export class AgentCursorController {
  private threadId: string | undefined;
  private at: { x: number; y: number } | null = null;
  /** the bot and look the host draws, so an unchanged bot isn't redrawn on every action */
  private drawn: string | undefined;
  private mood: BotMood = 'rest';
  private thinking = false;
  private typing = false;
  private idle: ReturnType<typeof setTimeout> | undefined;
  /** this thread's unanswered permission requests */
  private waiting = new Set<string>();
  private unlisten: (() => void) | undefined;

  constructor(private ctx: CoreCtx) {}

  private get host(): AgentCursorHost | undefined { return this.ctx.deps.agentCursor; }
  private get enabled(): boolean { return !!this.host && this.ctx.s.settings.get().computer.agentCursor !== false; }

  /**
   * Before a bot's action: show its cursor and glide to `point` (global screen points, resolved by the
   * ComputerService from the window snapshot or screenshot), start typing, or grab for a drag. Opening or focusing an
   * app is a look (see `look`). Never throws.
   */
  async before(action: ComputerAction, threadId: string | undefined, point: { x: number; y: number } | null, quick = false): Promise<void> {
    if (!this.enabled || !threadId) return; // take-over input from a phone is the user's own
    if (LOOKS.has(action.type)) return this.look(action, threadId);
    try {
      if (!SHOWS.has(action.type)) { if (threadId === this.threadId) this.busy(); return; }
      if (!this.showFor(threadId)) return;
      this.busy();
      if (action.type === 'type') { this.typing = true; this.host!.activity('typing'); return; }
      if (!point || !POINTER.has(action.type)) return;
      // in a batch the steps come back to back: a short hop each, so a long sequence doesn't crawl
      const ms = Math.min(quick ? QUICK_GLIDE_MS : Infinity, this.at ? glideMs(point.x - this.at.x, point.y - this.at.y) : 240);
      this.at = point;
      await this.host!.moveTo(point.x, point.y, ms);
      if (action.type === 'drag' && this.threadId === threadId) this.host!.react('grab');
    } catch (e) {
      this.ctx.log.debug('agent cursor: before failed', errMsg(e));
    }
  }

  /** During a drag the cursor follows the drag to its end point. */
  follow(point: { x: number; y: number }, durationMs: number): void {
    if (!this.enabled || !this.threadId) return;
    this.at = point;
    void this.host!.moveTo(point.x, point.y, durationMs).catch(() => undefined);
  }

  /**
   * After a bot's action, also a failed one (`ok` false: no click feedback for a click that didn't happen): typing
   * stops, a drag lets go, clicks/scrolls/keys get their reaction, and the bot starts thinking if nothing follows.
   * Never throws.
   */
  after(action: ComputerAction, threadId: string | undefined, ok = true): void {
    if (!this.enabled || !threadId || threadId !== this.threadId) return;
    try {
      if (this.typing) { this.typing = false; this.host!.activity(null); }
      const r = reaction(action);
      if (r && (ok || r === 'release')) this.host!.react(r);
      this.armIdle();
    } catch (e) {
      this.ctx.log.debug('agent cursor: after failed', errMsg(e));
    }
  }

  /** The bot looks (window snapshot, screenshot, opening or focusing an app): a cursor already out for it reacts. */
  look(action: ComputerAction, threadId: string | undefined): void {
    if (!this.enabled || !threadId || threadId !== this.threadId || !LOOKS.has(action.type)) return;
    try {
      this.busy();
      this.host!.react('look');
      this.armIdle();
    } catch (e) {
      this.ctx.log.debug('agent cursor: look failed', errMsg(e));
    }
  }

  /** The bot's turn ended (or it was stopped): its cursor goes away. */
  turnEnded(threadId: string): void {
    if (threadId === this.threadId) this.hide();
  }

  /**
   * Background mode: the bot acts in a window the user can't see (behind theirs), so its cursor isn't drawn over what
   * they are doing. It goes away and comes back (at their pointer, then gliding) once the bot acts where they can see.
   */
  away(threadId: string | undefined): void {
    if (threadId && threadId === this.threadId) this.hide();
  }

  /** Hide the cursor and drop its timers and its permission listener (turn ended, paused, setting off, shutdown). */
  hide(): void {
    this.threadId = undefined;
    this.at = null;
    this.drawn = undefined;
    this.mood = 'rest';
    this.thinking = this.typing = false;
    this.waiting.clear();
    this.clearIdle();
    this.unlisten?.();
    this.unlisten = undefined;
    try { this.host?.hide(); } catch { /* window gone */ }
  }

  /** Bring out (or keep) the cursor of the thread's bot; false when there is none. */
  private showFor(threadId: string): boolean {
    const thread = this.ctx.s.threads.get(threadId);
    const bot = thread ? this.ctx.s.bots.get(thread.botId) : undefined;
    if (!bot) return false;
    if (threadId !== this.threadId) { this.waiting.clear(); this.thinking = false; } // another bot's turn takes it over
    this.threadId = threadId;
    this.listen();
    // the shape, or the character it wears (a gone one: the shape)
    const figure = botFigure(bot, this.ctx.s.characters?.list());
    const key = `${bot.id} ${typeof figure === 'object' ? characterKey(figure) : figure} ${bot.color}${bot.chief ? ' chief' : ''}`;
    if (key !== this.drawn) {
      this.drawn = key;
      this.mood = 'rest';
      this.host!.show({ figure, color: bot.color, seed: motionSeed(bot.id), chief: bot.chief });
    }
    return true;
  }

  /** An action is under way: no thinking, back to the action reactions. */
  private busy(): void {
    this.clearIdle();
    this.thinking = false;
    this.applyMood();
  }

  private armIdle(): void {
    this.clearIdle();
    this.idle = setTimeout(() => { this.idle = undefined; this.thinking = true; this.applyMood(); }, THINK_MS);
  }

  private clearIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
  }

  /** A permission request in this cursor's thread makes the bot ask for you until it is answered, then think again. */
  private listen(): void {
    this.unlisten ??= this.ctx.bus.on((e) => {
      if (e.event === 'permission.requested') {
        const p = e.payload as EventPayload<'permission.requested'>;
        if (p.threadId !== this.threadId) return;
        this.waiting.add(p.id);
      } else if (e.event === 'permission.resolved') {
        if (!this.waiting.delete((e.payload as EventPayload<'permission.resolved'>).id)) return;
        if (!this.waiting.size) { this.clearIdle(); this.thinking = true; }
      } else return;
      this.applyMood();
    });
  }

  private applyMood(): void {
    const m: BotMood = this.waiting.size ? 'needs-you' : this.thinking ? 'tool' : 'rest';
    if (!this.threadId || m === this.mood) return;
    this.mood = m;
    try { this.host?.mood(m); } catch (e) { this.ctx.log.debug('agent cursor: mood failed', errMsg(e)); }
  }
}
