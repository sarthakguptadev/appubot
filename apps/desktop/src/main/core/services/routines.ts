/**
 * Routines: cron-scheduled prompts (croner), each run sent to the bot's current chat (`via: 'routine'`).
 * On an AppuBot Cloud computer the schedule also drives the computer's sleep: `nextRunAt()` goes out in every heartbeat
 * so the backend starts it a few minutes before a run (`CloudPresence`), a run whose minute passed while the computer
 * was asleep or starting is caught up on start (croner only schedules forward), and while the backend says the
 * computer is paused (`SystemService.cloudState`: payment on hold) runs are skipped and listed in one notice when it is back.
 */
import { Cron } from 'croner';
import { RoutineSchema, newId, type MethodParams, type Routine, type Thread } from '@appubot/protocol';
import { skippedRoutinesText } from '@appubot/chat-core';
import type { CoreCtx } from '../context';
import { errMsg, notFound, RpcError } from '../util';

/** A run whose time passed this recently before the service started is run at once (a cold wake can miss its minute). */
export const CATCH_UP_MS = 10 * 60_000;

export function validateCron(expr: string): Date | null {
  try {
    const c = new Cron(expr.trim(), { paused: true });
    const next = c.nextRun();
    c.stop();
    return next;
  } catch (e) {
    throw new RpcError('invalid_params', `Invalid schedule "${expr}": ${errMsg(e)}`);
  }
}

/** When `expr` last fired before `now` (null when it never did, or the pattern is bad). Pure, for the catch-up. */
export function previousRunOf(expr: string, now = new Date()): Date | null {
  try {
    const c = new Cron(expr.trim(), { paused: true });
    const prev = c.previousRuns(1, now)[0] ?? null;
    c.stop();
    return prev;
  } catch {
    return null;
  }
}

export class RoutinesService {
  private jobs = new Map<string, Cron>();
  private started = false;
  /** routines that didn't run while the computer was paused (cloud: payment on hold), by bot */
  private skipped = new Map<string, { id: string; name: string; at: number }[]>();
  private nextRunListeners = new Set<(at: number | undefined) => void>();
  private offCloud: (() => void) | null = null;

  constructor(private ctx: CoreCtx) {}

  list(): Routine[] { return this.ctx.store.routines.get(); }
  private require(id: string): Routine {
    const r = this.list().find((x) => x.id === id);
    if (!r) throw notFound('Routine', id);
    return r;
  }

  /**
   * Schedules every routine. `catchUp` (the default on an AppuBot Cloud computer, which starts and stops with its work):
   * one whose time passed within CATCH_UP_MS and hasn't run since runs now, since a computer asleep or starting at its
   * minute missed croner's tick. Never on a Mac: a laptop opened in the morning doesn't replay last night's runs.
   */
  start(o: { catchUp?: boolean; now?: number } = {}): void {
    this.started = true;
    const catchUp = o.catchUp ?? !!this.ctx.deps.cloud;
    const now = o.now ?? Date.now();
    for (const r of this.list()) {
      this.schedule(r);
      if (!catchUp || !r.enabled) continue;
      const prev = previousRunOf(r.schedule, new Date(now));
      if (!prev || now - prev.getTime() > CATCH_UP_MS || (r.lastRunAt ?? 0) >= prev.getTime()) continue;
      this.ctx.log.info(`routine ${r.name}: its ${prev.toISOString()} run was missed while this computer was down; running it now`);
      void this.run(r.id).catch((e) => this.ctx.log.error(`routine ${r.id} catch-up failed`, errMsg(e)));
    }
    this.announceNextRun();
    // the computer is back (the cloud): the skipped runs are listed, and the schedule goes on
    if (this.ctx.deps.cloud && !this.offCloud) {
      this.offCloud = this.ctx.s.system.onCloudState((info, prev) => { if (info.state === 'ok' && prev && prev.state !== 'ok') this.reportSkipped(); });
    }
  }

  private save(r: Routine, emit = true): Routine {
    this.ctx.store.routines.update((l) => (l.some((x) => x.id === r.id) ? l.map((x) => (x.id === r.id ? r : x)) : [...l, r]));
    if (emit) this.ctx.bus.emit('routine.updated', r);
    return r;
  }

  private schedule(r: Routine): Routine {
    this.jobs.get(r.id)?.stop();
    this.jobs.delete(r.id);
    let nextRunAt: number | undefined;
    if (r.enabled && this.started) {
      try {
        const job = new Cron(r.schedule, { protect: true, catch: (e) => this.ctx.log.error(`routine ${r.name} failed`, errMsg(e)) }, () => this.due(r.id));
        this.jobs.set(r.id, job);
        nextRunAt = job.nextRun()?.getTime();
      } catch (e) {
        this.ctx.log.warn(`routine ${r.name} has an invalid schedule`, errMsg(e));
      }
    }
    if (r.nextRunAt !== nextRunAt) {
      r = { ...r, nextRunAt };
      this.save(r, false);
    }
    return r;
  }

  /**
   * A routine's time came (croner): it runs, unless "Only in the cloud" holds on this computer (`settings.cloudOnly`,
   * `CloudAccountService.cloudOnly`), when this run is let go and the routine stays as it is for the next one.
   */
  due(id: string): void {
    if (this.ctx.s.cloudAccount?.cloudOnly()) { this.ctx.log.info(`routine ${id} not run: only in the cloud`); return; }
    void this.run(id).catch((e) => this.ctx.log.error(`routine ${id} run failed`, errMsg(e)));
  }

  create(p: MethodParams<'routines.create'>): Routine {
    this.ctx.s.bots.require(p.botId);
    if (!p.prompt.trim()) throw new RpcError('invalid_params', 'Prompt is required');
    validateCron(p.schedule);
    const now = Date.now();
    let r = RoutineSchema.parse({ ...p, schedule: p.schedule.trim(), id: newId('rtn'), createdAt: now, updatedAt: now });
    this.save(r, false);
    r = this.schedule(r);
    this.ctx.bus.emit('routine.updated', r);
    this.announceNextRun();
    return r;
  }

  update(id: string, patch: MethodParams<'routines.update'>['patch']): Routine {
    const prev = this.require(id);
    if (patch.schedule !== undefined) validateCron(patch.schedule);
    if (patch.botId) this.ctx.s.bots.require(patch.botId);
    let r = RoutineSchema.parse({ ...prev, ...patch, id, createdAt: prev.createdAt, updatedAt: Date.now() });
    this.save(r, false);
    r = this.schedule(r);
    this.ctx.bus.emit('routine.updated', r);
    this.announceNextRun();
    return r;
  }

  delete(id: string): { ok: true } {
    this.require(id);
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    this.ctx.store.routines.update((l) => l.filter((x) => x.id !== id));
    this.ctx.bus.emit('routine.deleted', { id });
    this.announceNextRun();
    return { ok: true };
  }

  async run(id: string): Promise<Thread> {
    const r = this.require(id);
    // the cloud computer is paused (payment on hold): the run is skipped and listed once it is back
    if (!this.ctx.s.system.cloudWorking()) {
      const list = this.skipped.get(r.botId) ?? [];
      if (!list.some((s) => s.id === r.id)) list.push({ id: r.id, name: r.name, at: Date.now() });
      this.skipped.set(r.botId, list);
      this.ctx.log.info(`routine ${r.name} skipped: the computer is ${this.ctx.s.system.cloudState()}`);
      this.save({ ...r, nextRunAt: this.jobs.get(r.id)?.nextRun()?.getTime(), updatedAt: Date.now() });
      this.announceNextRun();
      return this.ctx.s.threads.chatFor(r.botId);
    }
    // routines report in the bot's chat (queued behind any turn already running there)
    const thread = this.ctx.s.threads.chatFor(r.botId);
    // "Just keep it in the chat": no notification when it's done (errors still notify)
    // (named on the message, so the chat shows it as one line under its name and folds its runs with nothing to say)
    this.ctx.s.chat.send({ threadId: thread.id, text: r.prompt, attachments: [], images: [] }, 'routine', { quiet: r.deliverTo === 'thread', routine: { id: r.id, name: r.name } });
    const next = { ...r, lastRunAt: Date.now(), lastThreadId: thread.id, nextRunAt: this.jobs.get(r.id)?.nextRun()?.getTime(), updatedAt: Date.now() };
    this.save(next);
    this.announceNextRun();
    return this.ctx.s.threads.require(thread.id);
  }

  /* ------------------------------------------------------- AppuBot Cloud */

  /** When the earliest enabled routine runs next (the heartbeat's `nextWakeAt`); undefined with none scheduled. */
  nextRunAt(): number | undefined {
    let min: number | undefined;
    for (const job of this.jobs.values()) {
      const at = job.nextRun()?.getTime();
      if (at !== undefined && (min === undefined || at < min)) min = at;
    }
    return min;
  }

  /** Called whenever the next run time may have changed (a routine made, changed, removed, run or caught up). */
  onNextRunChange(fn: (at: number | undefined) => void): () => void {
    this.nextRunListeners.add(fn);
    return () => this.nextRunListeners.delete(fn);
  }

  private announceNextRun(): void {
    if (!this.nextRunListeners.size) return;
    const at = this.nextRunAt();
    for (const l of this.nextRunListeners) {
      try { l(at); } catch (e) { this.ctx.log.warn('next-run listener failed', errMsg(e)); }
    }
  }

  /** The routines skipped while paused, by bot (what `reportSkipped` lists). */
  skippedRuns(): { botId: string; name: string; at: number }[] {
    return [...this.skipped].flatMap(([botId, l]) => l.map((s) => ({ botId, name: s.name, at: s.at })));
  }

  /**
   * The computer is working again (the payment went through): each bot with skipped runs gets one system message in its chat listing them, and the user one
   * notification; the list is cleared. Nothing when nothing was skipped.
   */
  reportSkipped(): void {
    if (!this.skipped.size) return;
    const all: string[] = [];
    for (const [botId, list] of this.skipped) {
      const names = list.map((s) => s.name);
      all.push(...names);
      try {
        const thread = this.ctx.s.threads.chatFor(botId);
        this.ctx.s.chat.appendPart(thread.id, { type: 'system', text: skippedRoutinesText(names), level: 'warning' });
      } catch (e) { this.ctx.log.warn(`listing ${botId}'s skipped routines failed`, errMsg(e)); }
    }
    this.skipped.clear();
    this.ctx.s.notifications.notify({ title: 'Routines paused while AppuBot Cloud was paused', body: skippedRoutinesText(all), level: 'warning' });
  }

  stop(): void {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
    this.started = false;
    this.offCloud?.();
    this.offCloud = null;
  }
}
