/**
 * Goals (protocol `GoalSchema`, chat-core `goals.ts`): a bot works toward one on its own in a thread. It proposes the
 * goal itself (`start_goal`, an Allow card: `AgentBridgeService.startGoal`); once allowed, every turn of that thread
 * that ends with the goal still on is followed, `GOAL_GAP_MS` later, by a turn of AppuBot's own whose prompt
 * (`goalPrompt`, never stored) sends the bot on to the next step, until it calls `finish_goal` (done or blocked), or
 * its turns (`maxTurns`) or time (`until`) run out, when it is paused. The user pauses, resumes and stops it from the
 * bar above the composer (`threads.goal`); Stop on the chat pauses it too. A message from the user meanwhile runs as
 * usual and the goal carries on after it. Group threads have no goals.
 */
import { GOAL_TURNS_DEFAULT, type Goal, type Thread } from '@appubot/protocol';
import { goalPrompt } from '@appubot/chat-core';
import type { CoreCtx } from '../context';
import type { TurnCompleted } from './chat';
import { RpcError, errMsg, notFound } from '../util';

/** how long after a turn ends the goal's next one starts (a message the user is typing gets in first) */
export const GOAL_GAP_MS = 1500;
/** after a restart, how long before goals still on carry on */
const GOAL_RESUME_MS = 10_000;
/** turns a resumed goal gets when it had used all of its own */
const GOAL_MORE_TURNS = 10;

export class GoalsService {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private off: (() => void)[] = [];
  private boot?: ReturnType<typeof setTimeout>;

  constructor(private ctx: CoreCtx) {
    this.off.push(ctx.s.chat.onTurnCompleted((e) => { try { this.turnEnded(e); } catch (err) { ctx.log.warn('goal step failed', errMsg(err)); } }));
    // goals still on when AppuBot stopped carry on once it's up
    this.boot = setTimeout(() => {
      for (const t of this.ctx.s.threads.list({ limit: 100_000 })) if (t.goal?.status === 'active') this.schedule(t.id, 0);
    }, GOAL_RESUME_MS);
    this.boot.unref?.();
  }

  shutdown(): void {
    for (const f of this.off.splice(0)) f();
    if (this.boot) clearTimeout(this.boot);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private save(threadId: string, goal: Goal | undefined): Thread {
    return this.ctx.s.threads.update(threadId, { goal }, false);
  }

  /** The goal the user allowed: on from now, the turn running counting as its first. */
  start(threadId: string, objective: string, maxTurns = GOAL_TURNS_DEFAULT, hours?: number): Goal {
    const thread = this.ctx.s.threads.require(threadId);
    if (thread.source === 'group') throw new RpcError('forbidden', 'Goals run in your own chat, not in a group');
    const now = Date.now();
    const goal: Goal = { objective: objective.trim(), status: 'active', turns: 0, maxTurns, ...(hours ? { until: now + hours * 3_600_000 } : {}), startedAt: now, updatedAt: now };
    this.save(threadId, goal);
    // started from an idle chat (a card answered after its turn ended): its first step goes now
    if (!this.ctx.s.chat.hasWork(threadId)) this.schedule(threadId);
    return goal;
  }

  /** The bot's word on its goal (`finish_goal`): achieved, or it needs the user. */
  finish(threadId: string, status: 'done' | 'blocked', note: string): Goal {
    const thread = this.ctx.s.threads.require(threadId);
    const g = thread.goal;
    if (!g || (g.status !== 'active' && g.status !== 'paused')) throw new RpcError('invalid_params', 'No goal is on in this chat');
    this.unschedule(threadId);
    const goal: Goal = { ...g, status, ...(note.trim() ? { note: note.trim() } : {}), updatedAt: Date.now() };
    this.save(threadId, goal);
    const bot = this.ctx.s.bots.get(thread.botId);
    if (bot) {
      const text = note.trim() || g.objective;
      this.ctx.s.notifications.notify({
        title: status === 'done' ? `${bot.name} reached its goal` : `${bot.name} needs you for its goal`,
        body: text.slice(0, 300), threadId, level: status === 'done' ? 'success' : 'warning',
        push: { kind: status === 'done' ? 'done' : 'needs-you', botId: bot.id, botName: bot.name, text: text.slice(0, 300) },
      });
    }
    return goal;
  }

  /** The user's pause, resume, stop or clear (`threads.goal`). */
  async act(threadId: string, action: 'pause' | 'resume' | 'stop' | 'clear'): Promise<Thread> {
    const thread = this.ctx.s.threads.require(threadId);
    const g = thread.goal;
    if (!g) throw notFound('Goal', threadId);
    const now = Date.now();
    switch (action) {
      case 'clear':
        this.unschedule(threadId);
        if (g.status === 'active') await this.stopTurn(threadId);
        return this.save(threadId, undefined);
      case 'pause':
        this.unschedule(threadId);
        return this.save(threadId, { ...g, status: 'paused', note: 'Paused by you', updatedAt: now });
      case 'stop':
        this.unschedule(threadId);
        await this.stopTurn(threadId);
        return this.save(threadId, { ...g, status: 'stopped', updatedAt: now });
      case 'resume': {
        // out of turns or time: a little more of each
        const maxTurns = g.turns >= g.maxTurns ? g.turns + GOAL_MORE_TURNS : g.maxTurns;
        const until = g.until && g.until <= now ? now + 3_600_000 : g.until;
        const t = this.save(threadId, { ...g, status: 'active', maxTurns, ...(until ? { until } : {}), note: undefined, updatedAt: now });
        if (!this.ctx.s.chat.hasWork(threadId)) this.schedule(threadId, 0);
        return t;
      }
    }
  }

  /** the goal's own turn running now, if that's what runs (a message of the user's is left to finish) */
  private async stopTurn(threadId: string): Promise<void> {
    if (this.ctx.s.chat.hasWork(threadId)) await this.ctx.s.chat.cancel(threadId).catch(() => undefined);
  }

  private turnEnded(e: TurnCompleted): void {
    const g = this.ctx.s.threads.get(e.threadId)?.goal;
    if (!g || g.status !== 'active') return;
    const now = Date.now();
    // something else waits on the chat (a message the user sent): the goal goes on after it (this runs as the turn
    // ends, before the chat lets go of it, so only what waits counts)
    if (this.ctx.s.chat.hasQueued(e.threadId)) return;
    if (e.status === 'cancelled') { this.save(e.threadId, { ...g, status: 'paused', note: 'Stopped by you', updatedAt: now }); return; }
    if (e.status === 'error') { this.save(e.threadId, { ...g, status: 'paused', note: e.message.error ? `It hit an error: ${e.message.error}` : 'It hit an error', updatedAt: now }); return; }
    const turns = g.turns + 1;
    if (turns >= g.maxTurns) { this.pause(e.threadId, { ...g, turns }, `used its ${g.maxTurns} turns`); return; }
    if (g.until && now >= g.until) { this.pause(e.threadId, { ...g, turns }, 'out of time'); return; }
    this.save(e.threadId, { ...g, turns, updatedAt: now });
    this.schedule(e.threadId);
  }

  /** Out of turns or time: paused to resume, and the user hears of it. */
  private pause(threadId: string, g: Goal, why: string): void {
    this.save(threadId, { ...g, status: 'paused', note: why, updatedAt: Date.now() });
    const thread = this.ctx.s.threads.get(threadId);
    const bot = thread && this.ctx.s.bots.get(thread.botId);
    if (bot) this.ctx.s.notifications.notify({ title: `${bot.name} paused its goal`, body: `It ${why}. Resume it to keep going.`, threadId, level: 'info', push: { kind: 'needs-you', botId: bot.id, botName: bot.name, text: `Paused its goal: it ${why}` } });
  }

  private unschedule(threadId: string): void {
    const t = this.timers.get(threadId);
    if (t) clearTimeout(t);
    this.timers.delete(threadId);
  }

  /** The goal's next turn, `ms` from now, if it's still on and the chat is free then. */
  private schedule(threadId: string, ms = GOAL_GAP_MS): void {
    this.unschedule(threadId);
    const t = setTimeout(() => {
      this.timers.delete(threadId);
      const g = this.ctx.s.threads.get(threadId)?.goal;
      if (!g || g.status !== 'active' || this.ctx.s.chat.hasWork(threadId)) return;
      try { this.ctx.s.chat.ownTurn(threadId, goalPrompt(g)); } catch (e) {
        // AppuBot can't run turns now (a stopped version, a paused computer): the goal waits, paused, for the user
        this.ctx.log.warn(`goal turn for ${threadId} failed to start`, errMsg(e));
        this.save(threadId, { ...g, status: 'paused', note: 'AppuBot couldn’t carry on', updatedAt: Date.now() });
      }
    }, ms);
    t.unref?.();
    this.timers.set(threadId, t);
  }
}
