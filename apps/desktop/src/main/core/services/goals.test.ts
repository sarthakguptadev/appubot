/**
 * Goals: the bot proposes one on an Allow card (`start_goal`); once allowed AppuBot sends it on after every turn with
 * a hidden prompt until it calls `finish_goal`, or its turns run out (paused, to resume); the user's Stop pauses it,
 * and a goal never runs in a group's thread.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, Thread } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { GOAL_GAP_MS } from './goals';

let core: Core;
let root: string;
let runtime: FakeRuntime;
let ada: Bot;
/** the goal prompts the bot got, in order */
const prompts: string[] = [];
/** what the bot does on a goal turn: by default it carries on */
let onGoalTurn: (n: number, threadId: string) => string = () => 'Did a step.';
let threadOf = '';

const until = async (ok: () => boolean, ms = 8000) => { const t0 = Date.now(); while (!ok()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const thread = (): Thread => core.services.threads.require(threadOf);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-goals-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
  });
  await core.start();
  await core.services.providers.refresh();
  ada = core.services.bots.update(core.services.bots.list()[0]!.id, { name: 'Ada' });
  runtime.reply = (text) => {
    const m = /\(Goal, turn (\d+) of/.exec(text);
    if (!m) return undefined;
    prompts.push(text);
    return onGoalTurn(Number(m[1]), threadOf);
  };
});
afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('goals', () => {
  it('starts from its card, goes on by itself after each turn, and stops when the bot says it is done', async () => {
    const t = core.services.threads.chatFor(ada.id);
    threadOf = t.id;
    // the card: the user sharpens the goal and its turns, then allows it
    const asked = new Promise<string>((resolve) => {
      const off = core.ctx.bus.on((e) => { if (e.event === 'question.asked') { off(); resolve((e.payload as { questionId: string }).questionId); } });
    });
    const started = core.services.agentBridge.startGoal({ botId: ada.id, threadId: t.id }, { objective: 'Sort the invoices', maxTurns: 8 });
    const questionId = await asked;
    await core.services.agentBridge.answerForm({ questionId, values: { objective: 'Sort the invoices by month', turns: '6' } }, 'owner');
    const { goal } = await started;
    expect(goal).toMatchObject({ objective: 'Sort the invoices by month', maxTurns: 6, status: 'active', turns: 0 });
    // the chat was idle: its first step starts by itself, and on until the bot finishes on turn 3
    onGoalTurn = (n, id) => { if (n === 3) core.services.goals.finish(id, 'done', 'All sorted.'); return `Step ${n}.`; };
    await until(() => thread().goal?.status === 'done');
    expect(prompts.map((p) => /turn (\d+) of 6/.exec(p)?.[1])).toEqual(['1', '2', '3']);
    expect(prompts[0]).toContain('Sort the invoices by month');
    expect(thread().goal?.note).toBe('All sorted.');
    // nothing more after it's done
    await new Promise((r) => setTimeout(r, GOAL_GAP_MS + 300));
    expect(prompts).toHaveLength(3);
    // the hidden prompts never show as messages: only the bot's replies do
    const shown = core.services.threads.messages(t.id).filter((m) => m.role === 'user');
    expect(shown.some((m) => m.parts.some((p) => p.type === 'text' && p.text.includes('(Goal,')))).toBe(false);
    await core.services.goals.act(t.id, 'clear');
    expect(thread().goal).toBeUndefined();
  });

  it('pauses when its turns run out, and resumes with a few more', async () => {
    prompts.length = 0;
    onGoalTurn = (n) => `Step ${n}.`;
    core.services.goals.start(threadOf, 'Tidy the folder', 2);
    await until(() => thread().goal?.status === 'paused');
    expect(thread().goal).toMatchObject({ turns: 2, note: 'used its 2 turns' });
    expect(prompts).toHaveLength(2);
    await core.services.goals.act(threadOf, 'resume');
    expect(thread().goal?.maxTurns).toBe(12);
    await until(() => prompts.length >= 3);
    await core.services.goals.act(threadOf, 'stop');
    expect(thread().goal?.status).toBe('stopped');
    await core.services.goals.act(threadOf, 'clear');
  });

  it('refuses a second goal while one is on, and any goal in a group', async () => {
    core.services.goals.start(threadOf, 'One thing', 50);
    await expect(core.services.agentBridge.startGoal({ botId: ada.id, threadId: threadOf }, { objective: 'Another' })).rejects.toMatchObject({ code: 'invalid_params' });
    await core.services.goals.act(threadOf, 'stop');
    await core.services.goals.act(threadOf, 'clear');
    const g = core.services.groups.create({ name: 'G', botIds: [ada.id] });
    const groupThread = core.services.threads.create({ botId: ada.id, source: 'group', groupId: g.id });
    expect(() => core.services.goals.start(groupThread.id, 'x')).toThrow(/group/);
  });
});
