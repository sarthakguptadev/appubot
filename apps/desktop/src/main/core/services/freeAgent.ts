/**
 * The free agent on every computer (2026-11-14, the owner's call: "preinstall opencode for every be it local and
 * cloud … and set as default"). OpenCode runs a set of models with no account (protocol `freeModels.ts`), so a person
 * with nothing signed in still has a bot that answers. This service, on a person's own computer and on an AppuBot
 * Cloud one alike:
 *
 *  1. installs OpenCode in the background where none is found (`freeAgentInstall.ts`: no npm, no terminal), at every
 *     start until it is there, with a few tries and a later one; a chat on OpenCode waits for a running install
 *     instead of failing with "not installed" (`ready`, from `ChatService.openSession`);
 *  2. switches it on once for people who have it switched off (it used to be off until asked for); a switch turned
 *     off after that stays off;
 *  3. makes it the default once (`adopt`), as the owner chose:
 *     - an AppuBot Cloud computer: the agent for new bots, and every bot that has never been talked to moves onto it
 *       (a new computer's first bot starts there; the included Claude, AppuBot AI, is a pick away; bots already in
 *       use stay where they are);
 *     - a person's own computer that isn't set up yet: the same, so setup starts on it;
 *     - a person's own computer already in use: only where it helps. When the agent for new bots can't run (not
 *       installed, or signed out) it becomes OpenCode, and bots sitting on an agent that can't run move onto it. Someone
 *       signed in to Claude Code or Codex keeps everything as it is, with OpenCode added beside it.
 *
 * What it did is kept in `<dataDir>/free-agent.json`, so each step happens once per computer.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FREE_AGENT_ID, isFreeAgent, type Provider } from '@appubot/protocol';
import { providerLogin } from '@appubot/chat-core';
import type { CoreCtx } from '../context';
import { errMsg } from '../util';

/** waits between tries within one start (three tries in all), then a later one */
export const FREE_AGENT_RETRY_MS = [20_000, 90_000];
export const FREE_AGENT_LATER_MS = 30 * 60_000;

interface Stored { enabledAt?: number; adoptedAt?: number; adopted?: 'cloud' | 'new' | 'stuck' | 'kept' }

export interface FreeAgentOptions { retryDelaysMs?: number[]; laterMs?: number }

/** whether an agent can answer a message as things stand: installed, switched on, and not known to be signed out */
export function agentCanRun(p: Pick<Provider, 'installed' | 'enabled' | 'authStatus' | 'auth'> | undefined): boolean {
  if (!p || !p.installed || p.enabled === false) return false;
  const kind = providerLogin(p as Provider).kind;
  return kind !== 'not_installed' && kind !== 'logged_out';
}

export class FreeAgentService {
  private job: Promise<boolean> | null = null;
  private later: ReturnType<typeof setTimeout> | null = null;
  private wait: { timer: ReturnType<typeof setTimeout>; wake: () => void } | null = null;
  private stopped = false;
  private done = false;
  private readonly delays: number[];
  private readonly laterMs: number;

  constructor(private ctx: CoreCtx, o: FreeAgentOptions = {}) {
    this.delays = o.retryDelaysMs ?? FREE_AGENT_RETRY_MS;
    this.laterMs = o.laterMs ?? FREE_AGENT_LATER_MS;
  }

  private get file(): string { return join(this.ctx.paths.dataDir, 'free-agent.json'); }
  private read(): Stored {
    try { return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Stored) : {}; } catch { return {}; }
  }
  private write(next: Stored): void {
    try { writeFileSync(this.file, JSON.stringify(next)); } catch (e) { this.ctx.log.warn('free agent: could not save its state', errMsg(e)); }
  }

  /** the defaults were given to OpenCode here (the cloud's credit then leaves them alone) */
  adopted(): boolean { return !!this.read().adoptedAt; }

  /** where its files go, and whose `.local/bin` gets the link */
  installPaths(): { dir: string; home: string } {
    return { dir: join(this.ctx.paths.dataDir, 'free-agent'), home: this.ctx.deps.homeDir ?? homedir() };
  }

  start(): void {
    this.stopped = false;
    void this.ensure('start');
  }

  stop(): void {
    this.stopped = true;
    if (this.later) clearTimeout(this.later);
    this.later = null;
    if (this.wait) { clearTimeout(this.wait.timer); this.wait.wake(); }
  }

  /** whether it is being installed or made the default right now (a greeting waits for that) */
  busy(): boolean { return !!this.job; }
  /** resolves once the run in progress is over (at once when none is) */
  settled(): Promise<void> { return (this.job ?? Promise.resolve(true)).then(() => undefined, () => undefined); }

  /**
   * Before a session of `providerId` starts: true at once for anything but OpenCode, or once it is there; else the
   * install (running, or started by this call) is awaited. False when it couldn't be installed: the session then
   * fails as it would have.
   */
  async ready(providerId: string | undefined): Promise<boolean> {
    if (!isFreeAgent(providerId) || this.done || this.stopped) return true;
    if (this.job) return this.job;
    if (this.provider()?.installed) { this.done = true; return true; }
    return this.ensure('turn');
  }

  private provider(): Provider | undefined {
    return this.ctx.s.providers.list().find((p) => p.id === FREE_AGENT_ID);
  }

  /** Install where missing, switch on, adopt: one run at a time (a second caller joins the first). */
  ensure(why: string): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    if (this.job) return this.job;
    if (this.later) { clearTimeout(this.later); this.later = null; }
    const job = this.run(why).catch((e) => { this.ctx.log.warn('free agent: setting OpenCode up failed', errMsg(e)); return false; })
      .finally(() => { if (this.job === job) this.job = null; });
    this.job = job;
    return job;
  }

  private async run(why: string): Promise<boolean> {
    const providers = this.ctx.s.providers;
    await providers.refresh([FREE_AGENT_ID]).catch((e) => this.ctx.log.warn('free agent: checking OpenCode failed', errMsg(e)));
    if (!this.provider()) return true; // not an agent this build knows
    if (!this.provider()!.installed) {
      const startedAt = Date.now();
      this.ctx.log.info(`free agent: installing OpenCode (${why})`);
      for (let attempt = 1; ; attempt++) {
        if (this.stopped) return false;
        const r = await providers.install(FREE_AGENT_ID, { quiet: true }).catch((e: unknown) => ({ ok: false, output: errMsg(e) }));
        if (r.ok || this.provider()?.installed) {
          this.ctx.log.info(`free agent: OpenCode installed in ${Math.round((Date.now() - startedAt) / 1000)} s (try ${attempt})`);
          break;
        }
        this.ctx.log.warn(`free agent: installing OpenCode failed (try ${attempt})`, r.output.slice(-400));
        const delay = this.delays[attempt - 1];
        if (delay === undefined) { this.scheduleLater(); return false; }
        await this.sleep(delay);
      }
    }
    this.done = true;
    this.switchOnOnce();
    // what the other agents can do decides who is "stuck": their checks, running since launch, are waited for
    if (!this.read().adoptedAt) await providers.refreshQuiet().catch(() => undefined);
    this.adoptOnce();
    return true;
  }

  /** It used to be off until asked for: on once, for everyone; a later switch off is the person's and stays. */
  private switchOnOnce(): void {
    const st = this.read();
    if (st.enabledAt) return;
    const saved = this.ctx.store.providers.get().find((p) => p.id === FREE_AGENT_ID);
    if (saved && saved.enabled === false) {
      this.ctx.store.providers.update((l) => l.map((p) => (p.id === FREE_AGENT_ID ? { ...p, enabled: true } : p)));
      this.ctx.s.providers.applyCustom();
      this.ctx.log.info('free agent: OpenCode switched on');
    }
    this.write({ ...this.read(), enabledAt: Date.now() });
    this.ctx.bus.emit('providers.updated', this.ctx.s.providers.list());
  }

  /** Make it the default where the owner's rule says so; once per computer. */
  private adoptOnce(): void {
    if (this.read().adoptedAt) return;
    const s = this.ctx.s;
    if (!agentCanRun(this.provider())) return; // switched off by the person, or not usable after all: nothing to adopt
    const settings = s.settings.get();
    const all = s.providers.list();
    const canRun = (id: string) => agentCanRun(all.find((p) => p.id === id));
    const unused = (botId: string) => !s.threads.list({ limit: 100_000 }).some((t) => t.botId === botId && (t.lastMessagePreview || t.acpSessionId));
    let how: Stored['adopted'];
    let moves: (botProviderId: string, botId: string) => boolean;
    if (this.ctx.deps.cloud) {
      how = 'cloud';
      moves = (_p, botId) => unused(botId);
    } else if (!settings.onboarded) {
      how = 'new';
      moves = (_p, botId) => unused(botId);
    } else if (!canRun(settings.defaultProviderId)) {
      how = 'stuck';
      moves = (p) => !canRun(p);
    } else {
      how = 'kept';
      moves = () => false;
    }
    try {
      if (how !== 'kept' && settings.defaultProviderId !== FREE_AGENT_ID) s.settings.update({ defaultProviderId: FREE_AGENT_ID, defaultModelId: '' });
      for (const bot of s.bots.list()) {
        if (isFreeAgent(bot.providerId) || !moves(bot.providerId, bot.id)) continue;
        try {
          s.bots.update(bot.id, { providerId: FREE_AGENT_ID, modelId: '' });
          this.ctx.log.info(`free agent: ${bot.name} moved from ${bot.providerId} to OpenCode (${how})`);
        } catch (e) { this.ctx.log.warn(`free agent: moving ${bot.name} failed`, errMsg(e)); }
      }
    } catch (e) {
      this.ctx.log.warn('free agent: applying the defaults failed', errMsg(e));
      return;
    }
    this.write({ ...this.read(), adoptedAt: Date.now(), adopted: how });
    this.ctx.log.info(`free agent: defaults applied (${how})`);
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
}
