/**
 * Claude Code at an AppuBot Cloud computer's first start. The
 * image ships no agent CLI (each person installs what they use, into the home folder), but every plan comes with the
 * launch bonus's AppuBot AI (`credit.ts`), a Claude Code profile: without Claude Code itself the first message to a bot
 * failed with "claude was not found on PATH" until the user installed it from Settings › Agents. So a computer with a
 * plan installs it by itself, the same way that Install button does (`ProvidersService.install` → `installOnCloud`:
 * Claude's own `install.sh` into `~/.local`, as user node), in the background, at every start where it is missing (a
 * new computer, and one from before this that never had it); nothing else of the setup waits for it.
 *
 * Meanwhile `SystemInfo.cloud.agentSetup` says so (the apps' "Setting up Claude…" above the composer; Settings ›
 * Agents shows the provider's `installing` as for a click), and a turn on Claude Code or one of its profiles (AppuBot
 * AI) waits for it rather than failing (`ready`, from `ChatService.openSession`). A try that fails is tried again
 * (`RETRY_DELAYS_MS`); after the last one it says `failed`, and the next turn on Claude, a later timer
 * (`LATER_MS`) or a restart try again. Other agents stay on demand. A Mac has none of this (`deps.cloud` absent).
 */
import { APPUBOT_AI_PROVIDER_ID, providerBase, type CloudAgentSetup } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { errMsg } from '../util';

/** the agent every plan's computer gets at its first start */
export const SETUP_PROVIDER_ID = 'claude-code';
const SETUP_NAME = 'Claude Code';
/** waits between tries within one setup (three tries in all), then `failed` */
export const RETRY_DELAYS_MS = [15_000, 60_000];
/** after giving up: tried again this much later in the background (a turn on Claude tries at once) */
export const LATER_MS = 15 * 60_000;

export interface AgentSetupOptions {
  retryDelaysMs?: number[];
  laterMs?: number;
}

export class AgentSetupService {
  private job: Promise<boolean> | null = null;
  private state: CloudAgentSetup | undefined;
  /** Claude Code was seen installed: nothing more to do this run */
  private done = false;
  private later: ReturnType<typeof setTimeout> | null = null;
  private wait: { timer: ReturnType<typeof setTimeout>; wake: () => void } | null = null;
  private stopped = false;
  private offCloud: (() => void) | null = null;
  private offInstalled: (() => void) | null = null;
  private readonly delays: number[];
  private readonly laterMs: number;

  constructor(private ctx: CoreCtx, o: AgentSetupOptions = {}) {
    this.delays = o.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.laterMs = o.laterMs ?? LATER_MS;
  }

  /** only a cloud computer whose plan is on (not ended: `export-only` runs no agents) sets Claude Code up */
  private applies(): boolean {
    return !!this.ctx.deps.cloud && !this.stopped && this.ctx.s.system.cloudState() !== 'export-only';
  }

  /** whether `providerId` runs Claude Code's own CLI (Claude Code, its profiles, AppuBot AI) */
  covers(providerId: string | undefined): boolean {
    return !!providerId && providerBase(providerId) === SETUP_PROVIDER_ID;
  }

  /** `SystemInfo.cloud.agentSetup`: while it is being set up or gave up; undefined once it's there */
  status(): CloudAgentSetup | undefined { return this.state; }

  /** At the core's start (a cloud computer): set it up if it is missing, and again when a plan comes back. */
  start(): void {
    if (!this.ctx.deps.cloud) return;
    this.stopped = false;
    this.offCloud ??= this.ctx.s.system.onCloudState((info, prev) => {
      if (info.state !== 'export-only' && prev?.state === 'export-only') void this.ensure('plan back');
    });
    // installed another way meanwhile (Settings › Agents' Install, the notice's Try again): nothing left to say
    this.offInstalled ??= this.ctx.bus.on((e) => {
      if (e.event !== 'provider.updated' || !this.state || this.job) return;
      const p = e.payload as { id?: string; installed?: boolean };
      if (p.id === SETUP_PROVIDER_ID && p.installed) { this.done = true; this.set(undefined); }
    });
    void this.ensure('start');
  }

  stop(): void {
    this.stopped = true;
    this.offCloud?.();
    this.offCloud = null;
    this.offInstalled?.();
    this.offInstalled = null;
    if (this.later) clearTimeout(this.later);
    this.later = null;
    if (this.wait) { clearTimeout(this.wait.timer); this.wait.wake(); }
  }

  /**
   * Before a session of `providerId` starts: true at once for anything but Claude Code (and on a Mac, or once it is
   * known to be there); else Claude Code being set up (now, or started by this call when it is missing) is awaited.
   * False when it couldn't be set up: the session then fails as it would have.
   */
  async ready(providerId: string | undefined): Promise<boolean> {
    if (!this.covers(providerId) || this.done || !this.applies()) return true;
    if (this.job) return this.job;
    if (this.installed() === true) { this.done = true; return true; }
    return this.ensure('turn');
  }

  /** whether a setup is running now (a greeting waits for it rather than being skipped) */
  pending(providerId: string | undefined): boolean { return this.covers(providerId) && !!this.job; }

  private installed(): boolean | undefined {
    return this.ctx.s.providers.list().find((p) => p.id === SETUP_PROVIDER_ID)?.installed;
  }

  /** Set Claude Code up unless it is there; one at a time (a second caller joins the first). */
  ensure(why: string): Promise<boolean> {
    if (!this.applies()) return Promise.resolve(true);
    if (this.job) return this.job;
    if (this.later) { clearTimeout(this.later); this.later = null; }
    const job = this.run(why).catch((e) => { this.ctx.log.warn('cloud setup: Claude Code failed', errMsg(e)); return false; })
      .finally(() => { if (this.job === job) this.job = null; });
    this.job = job;
    return job;
  }

  private async run(why: string): Promise<boolean> {
    const providers = this.ctx.s.providers;
    // what the runtime last saw may predate this start: looked at once more
    await providers.refresh([SETUP_PROVIDER_ID]).catch((e) => this.ctx.log.warn('cloud setup: checking Claude Code failed', errMsg(e)));
    if (this.installed() !== false) {
      // installed, or not an agent this computer knows (nothing to set up)
      this.done = this.installed() === true;
      this.set(undefined);
      return true;
    }
    const startedAt = Date.now();
    this.ctx.log.info(`cloud setup: installing Claude Code (${why})`);
    for (let attempt = 1; ; attempt++) {
      if (!this.applies()) { this.set(undefined); return false; }
      this.set({ providerId: SETUP_PROVIDER_ID, name: SETUP_NAME, state: 'installing', attempt, startedAt });
      const r = await providers.install(SETUP_PROVIDER_ID).catch((e: unknown) => ({ ok: false, output: errMsg(e) }));
      if (r.ok || this.installed() === true) {
        this.done = true;
        this.ctx.log.info(`cloud setup: Claude Code installed in ${Math.round((Date.now() - startedAt) / 1000)} s (try ${attempt})`);
        // AppuBot AI runs the same CLI: its status follows
        if (this.ctx.s.credit?.offered()) await providers.refresh([APPUBOT_AI_PROVIDER_ID]).catch(() => undefined);
        this.set(undefined);
        this.ctx.bus.emit('providers.updated', providers.list());
        return true;
      }
      const error = lastLine(r.output);
      this.ctx.log.warn(`cloud setup: installing Claude Code failed (try ${attempt})`, r.output.slice(-500));
      const delay = this.delays[attempt - 1];
      if (delay === undefined) {
        this.set({ providerId: SETUP_PROVIDER_ID, name: SETUP_NAME, state: 'failed', attempt, startedAt, ...(error ? { error } : {}) });
        this.scheduleLater();
        return false;
      }
      this.set({ providerId: SETUP_PROVIDER_ID, name: SETUP_NAME, state: 'retrying', attempt, startedAt, retryAt: Date.now() + delay, ...(error ? { error } : {}) });
      await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => { this.wait = null; resolve(); };
      const timer = setTimeout(wake, ms);
      timer.unref?.();
      this.wait = { timer, wake };
    });
  }

  private scheduleLater(): void {
    if (this.stopped || this.later) return;
    this.later = setTimeout(() => { this.later = null; void this.ensure('later'); }, this.laterMs);
    this.later.unref?.();
  }

  private set(next: CloudAgentSetup | undefined): void {
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.ctx.s.system.cloudChanged();
  }
}

/** the installer's last words, short (curl's or install.sh's error), for the apps' "couldn't be set up" */
function lastLine(output: string): string | undefined {
  const line = output.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop();
  return line ? line.slice(0, 200) : undefined;
}
