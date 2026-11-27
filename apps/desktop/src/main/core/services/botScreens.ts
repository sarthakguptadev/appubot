/**
 * Your AppuBot computer: every bot gets a screen of its own (a display of its own on the computer, with its own
 * pointer and keyboard focus), so several bots use their computers at the same time instead of taking turns on the
 * one screen. The host (`CoreDeps.botScreens`: the cloud gateway's displays) starts and stops the displays; this
 * decides which screen a bot's computer use goes to, and when a screen sleeps.
 *
 * - A bot's first computer step starts its screen (or a viewer opening it does), and that bot's steps go to its own
 *   ComputerService from then on: its own Take control, no turns with other bots.
 * - There is no cap: every bot gets its screen. One that can't start (the host says why in the log, say the memory ran
 *   out) leaves the bot on the main screen for that turn, taking turns there as every bot did before. A turn that
 *   started on the main screen stays there until it ends, so its windows don't move away from it mid-task.
 * - A screen nobody used for SCREEN_SLEEP_MS (no step, no turn on it, nobody in control or watching) sleeps: its
 *   display stops (the apps on it close; what they keep on disk, like the browser's logins, stays). The next use
 *   starts it again.
 * - A deleted bot's screen goes for good, its own files with it.
 *
 * Without a host (a Mac, a PC) every bot uses `s.computer`, as before.
 */
import type { BotScreen } from '@appubot/protocol';
import type { CoreCtx, CoreDeps } from '../context';
import { errMsg } from '../util';
import { ComputerService } from './computer';

export interface BotScreenHost {
  /** starts the bot's display (again) and says how its computer use loads Cua there */
  open(botId: string): Promise<{ importCua: NonNullable<CoreDeps['importCua']> }>;
  /** stops it; `forget`: the bot is gone, so its screen's own files (its browser profile) go too */
  close(botId: string, o: { forget: boolean }): Promise<void>;
  /** someone is watching it (a viewer on the screen port): it doesn't sleep meanwhile */
  watched?(botId: string): boolean;
}

/** a bot's screen unused this long sleeps */
export const SCREEN_SLEEP_MS = 10 * 60_000;
const SWEEP_MS = 60_000;

interface Entry {
  botId: string;
  state: BotScreen['state'];
  lastAt: number;
  computer?: ComputerService;
  opening?: Promise<ComputerService | null>;
}

export class BotScreens {
  private screens = new Map<string, Entry>();
  /** turns that started on the main screen (no room for their own): they stay there until they end */
  private onMain = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private offs: (() => void)[] = [];
  /** overrides SCREEN_SLEEP_MS (tests) */
  sleepMs: number | null = null;

  constructor(private ctx: CoreCtx) {}

  private get host(): BotScreenHost | undefined { return this.ctx.deps.botScreens; }
  /** bots have screens of their own here */
  get enabled(): boolean { return !!this.host; }

  start(): void {
    if (!this.host || this.timer) return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref?.();
    this.offs.push(this.ctx.bus.on((e) => {
      if (e.event === 'bot.deleted') void this.forget((e.payload as { id: string }).id);
    }));
    this.ctx.s.chat.onTurnCompleted((e) => { this.onMain.delete(e.threadId); });
  }

  /** the bots' screens, for the computer's status */
  list(): BotScreen[] {
    return [...this.screens.values()].map((e) => {
      const st = e.state === 'on' ? e.computer?.status() : undefined;
      return {
        botId: e.botId,
        state: e.state,
        busy: !!st?.busy,
        ...(st?.activeThreadId ? { activeThreadId: st.activeThreadId } : {}),
        ...(st?.control ? { control: st.control } : {}),
        ...(st?.waits ? { waits: st.waits } : {}),
      };
    });
  }

  /** A bot's awake screen (undefined while it has none, or it sleeps). */
  get(botId: string): ComputerService | undefined {
    const e = this.screens.get(botId);
    return e?.state === 'on' ? e.computer : undefined;
  }

  /** Every awake screen's ComputerService (the presence counts their work). */
  awakeScreens(): ComputerService[] {
    return [...this.screens.values()].flatMap((e) => (e.state === 'on' && e.computer ? [e.computer] : []));
  }

  /** The screen a thread's bot works on: its own, else the main one (no room, no host, no such thread). */
  async forThread(threadId: string | undefined): Promise<ComputerService> {
    const main = this.ctx.s.computer;
    if (!this.host || !threadId || this.onMain.has(threadId)) return main;
    const botId = this.ctx.s.threads.get(threadId)?.botId;
    if (!botId) return main;
    const own = await this.open(botId);
    if (own) return own;
    this.onMain.add(threadId);
    return main;
  }

  /** A bot's own screen, started when it sleeps; null when it couldn't start. */
  async open(botId: string): Promise<ComputerService | null> {
    const host = this.host;
    if (!host || !this.ctx.s.bots.get(botId)) return null;
    const e = this.screens.get(botId);
    if (e?.opening) return e.opening;
    if (e?.state === 'on' && e.computer) { e.lastAt = Date.now(); return e.computer; }
    const entry: Entry = e ?? { botId, state: 'starting', lastAt: Date.now() };
    entry.state = 'starting';
    this.screens.set(botId, entry);
    entry.opening = (async () => {
      try {
        const { importCua } = await host.open(botId);
        const c = entry.computer ?? new ComputerService(this.ctx, { botId, importCua, onStatus: () => this.changed(), paused: () => this.ctx.s.computer.isPaused() });
        c.own!.importCua = importCua;
        entry.computer = c;
        await c.init();
        if (!c.status().available) throw new Error('its computer use could not start');
        entry.state = 'on';
        entry.lastAt = Date.now();
        this.ctx.log.info(`bot screens: ${botId}'s screen is up`);
        return c;
      } catch (err) {
        this.ctx.log.warn(`bot screens: ${botId}'s screen could not start; it uses the main screen`, errMsg(err));
        entry.state = 'asleep';
        await entry.computer?.sleep().catch(() => undefined);
        await host.close(botId, { forget: false }).catch(() => undefined);
        return null;
      } finally {
        entry.opening = undefined;
        this.changed();
      }
    })();
    this.changed();
    return entry.opening;
  }

  /** nothing on it now: no step, no turn, nobody in control or watching, not starting */
  private idle(e: Entry): boolean {
    if (e.state !== 'on' || e.opening || !e.computer) return false;
    const st = e.computer.status();
    return !st.busy && !st.activeThreadId && !st.control && !st.waits?.length && !this.host?.watched?.(e.botId);
  }

  /** A bot's screen stops (its display and the apps on it); its next use starts it again. */
  async sleep(botId: string, why: string): Promise<void> {
    const e = this.screens.get(botId);
    if (!e || e.state === 'asleep') return;
    e.state = 'asleep';
    this.ctx.log.info(`bot screens: ${botId}'s screen sleeps (${why})`);
    await e.computer?.sleep().catch(() => undefined);
    await this.host?.close(botId, { forget: false }).catch((err) => this.ctx.log.warn('bot screens: stopping a screen failed', errMsg(err)));
    this.changed();
  }

  /** The bot is gone: its screen too, for good. */
  async forget(botId: string): Promise<void> {
    const e = this.screens.get(botId);
    await e?.opening?.catch(() => null);
    this.screens.delete(botId);
    await e?.computer?.shutdown().catch(() => undefined);
    if (this.host) await this.host.close(botId, { forget: true }).catch((err) => this.ctx.log.warn('bot screens: removing a screen failed', errMsg(err)));
    if (e) this.changed();
  }

  /** Screens unused for a while sleep; one in use (or watched) counts as used now. */
  async sweep(now = Date.now()): Promise<void> {
    const after = this.sleepMs ?? SCREEN_SLEEP_MS;
    for (const e of [...this.screens.values()]) {
      if (e.state !== 'on') continue;
      if (!this.idle(e)) { e.lastAt = Math.max(e.lastAt, now); continue; }
      if (now - e.lastAt >= after) await this.sleep(e.botId, 'unused');
    }
  }

  private changed(): void { this.ctx.s.computer.emitStatus(); }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
    for (const e of [...this.screens.values()]) {
      await e.opening?.catch(() => null);
      await e.computer?.shutdown().catch(() => undefined);
      if (e.state !== 'asleep') await this.host?.close(e.botId, { forget: false }).catch(() => undefined);
    }
    this.screens.clear();
  }
}
