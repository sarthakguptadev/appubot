/**
 * The chat on an AppuBot Cloud computer: a paused computer (payment on hold, plan ended) answers with the reason instead of a
 * turn; at most `maxLiveSessions` agents run at once (idle ones make room, busy ones refuse); a stop drains running
 * turns within a grace and the queue starts again when the stop is called off.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import type { TurnCompleted } from './chat';

let core: Core;
let runtime: FakeRuntime;
let root: string;
let ada: Bot;
let ben: Bot;
const completed: TurnCompleted[] = [];

const until = async (test: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-chat-cloud-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'AppuBot Cloud', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    cloud: { publicUrl: 'https://ab12cd34ef.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 1 },
  });
  await core.start();
  core.services.chat.onTurnCompleted((e) => completed.push(e));
  ada = core.services.bots.list()[0]!;
  ben = core.services.bots.create({ name: 'Ben', job: 'Second bot', providerId: 'claude-code', computerUse: false });
  runtime.reply = (text) => (text.includes('slow') ? undefined : 'ok');
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('a paused cloud computer', () => {
  it('answers a message with the reason instead of a turn, and the turn listeners hear it (Telegram answers with it too)', async () => {
    const resetsAt = Date.now() + 3 * 86_400_000;
    core.services.system.setCloudState({ state: 'on-hold', resetsAt });
    expect(core.services.system.info().cloud).toMatchObject({ state: 'on-hold', resetsAt, publicUrl: 'https://ab12cd34ef.agent37.app' });
    const before = runtime.prompts.length;
    const r = core.services.chat.send({ botId: ada.id, text: 'hello?', attachments: [], images: [] }, 'channel');
    const msgs = core.services.threads.messages(r.userMessage.threadId);
    const reply = msgs.find((m) => m.id === r.agentMessageId)!;
    expect(reply).toMatchObject({ role: 'agent', via: 'system', status: 'complete', stopReason: 'cloud_paused' });
    expect(reply.parts[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/^Your AppuBot computer is paused: the payment didn’t go through.*Your bots and files are kept/) });
    expect(runtime.prompts.length).toBe(before);
    expect(core.services.threads.require(r.userMessage.threadId).status).toBe('idle');
    expect(completed.at(-1)).toMatchObject({ threadId: r.userMessage.threadId, via: 'channel', status: 'complete' });
    expect(completed.at(-1)!.message.id).toBe(r.agentMessageId);
    // a message sent again by the same device gets the same answer, not a second one
    const again = core.services.chat.send({ botId: ada.id, text: 'hello?', attachments: [], images: [], clientId: 'c1' }, 'desktop', { device: 'ph' });
    expect(core.services.chat.send({ botId: ada.id, text: 'hello?', attachments: [], images: [], clientId: 'c1' }, 'desktop', { device: 'ph' }).agentMessageId).toBe(again.agentMessageId);
    core.services.system.setCloudState({ state: 'export-only' });
    const held = core.services.chat.send({ botId: ada.id, text: 'still there?', attachments: [], images: [] });
    expect(core.services.threads.messages(held.userMessage.threadId).find((m) => m.id === held.agentMessageId)!.parts[0]).toMatchObject({ text: expect.stringMatching(/plan has ended/) });
  });

  it('works again once the backend says ok', async () => {
    core.services.system.setCloudState({ state: 'ok' });
    expect(core.services.system.info().cloud).toEqual({ state: 'ok', publicUrl: 'https://ab12cd34ef.agent37.app' });
    const r = core.services.chat.send({ botId: ada.id, text: 'hello again', attachments: [], images: [] });
    await until(() => core.services.threads.messages(r.userMessage.threadId).some((m) => m.id === r.agentMessageId && m.status === 'complete'));
    expect(runtime.prompts.length).toBeGreaterThan(0);
  });
});

describe('the live session cap', () => {
  it('lets an idle agent go to make room for another bot, and refuses when every one is busy', async () => {
    const adaThread = core.services.threads.chatFor(ada.id);
    const sid = (await (core.services.chat as unknown as { ensureSession(run: unknown, t: unknown, b: Bot): Promise<string> })
      .ensureSession((core.services.chat as unknown as { run(id: string): unknown }).run(adaThread.id), core.services.threads.require(adaThread.id), ada));
    expect(runtime.sessions.has(sid)).toBe(true);
    expect(core.services.chat.liveSessionCount()).toBe(1);
    // Ben's turn: Ada's idle agent is closed first, so only one runs
    const r = core.services.chat.send({ botId: ben.id, text: 'hi ben', attachments: [], images: [] });
    await until(() => core.services.threads.messages(r.userMessage.threadId).some((m) => m.id === r.agentMessageId && m.status === 'complete'));
    expect(runtime.sessions.has(sid)).toBe(false);
    expect(core.services.chat.liveSessionCount()).toBe(1);
    // Ben's agent busy (a slow turn): Ada's turn can't start, and says so
    const slow = core.services.chat.send({ botId: ben.id, text: 'slow work', attachments: [], images: [] });
    await until(() => core.services.chat.busyThreads() === 1 && core.services.threads.require(slow.userMessage.threadId).status === 'running');
    const refused = core.services.chat.send({ botId: ada.id, text: 'me too', attachments: [], images: [] });
    await until(() => core.services.threads.messages(refused.userMessage.threadId).some((m) => m.id === refused.agentMessageId && m.status === 'error'));
    const err = core.services.threads.messages(refused.userMessage.threadId).find((m) => m.id === refused.agentMessageId)!;
    expect(err.error).toMatch(/already running 1 bots at once/);
    await core.services.chat.cancel(slow.userMessage.threadId);
    await until(() => core.services.chat.busyThreads() === 0);
  });
});

describe('draining for a stop', () => {
  it('lets a turn finish within the grace, cancels what is still running after it, and holds the queue until resumed', async () => {
    const slow = core.services.chat.send({ botId: ben.id, text: 'slow again', attachments: [], images: [] });
    await until(() => core.services.threads.require(slow.userMessage.threadId).status === 'running');
    const t0 = Date.now();
    const r = await core.services.chat.drainForStop(300);
    expect(r).toEqual({ finished: false, cancelled: 1 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    await until(() => core.services.threads.messages(slow.userMessage.threadId).some((m) => m.id === slow.agentMessageId && m.status === 'cancelled'));
    // drained: a new message waits in the queue, nothing starts
    const queued = core.services.chat.send({ botId: ben.id, text: 'after the stop', attachments: [], images: [] });
    await new Promise((res) => setTimeout(res, 50));
    expect(core.services.threads.messages(queued.userMessage.threadId).some((m) => m.id === queued.agentMessageId)).toBe(false);
    expect(core.services.chat.busyThreads()).toBe(1);
    // the stop was called off: the queue runs
    core.services.chat.resumeAfterDrain();
    await until(() => core.services.threads.messages(queued.userMessage.threadId).some((m) => m.id === queued.agentMessageId && m.status === 'complete'));
    // nothing running: the drain is immediate
    expect(await core.services.chat.drainForStop(1000)).toEqual({ finished: true, cancelled: 0 });
    core.services.chat.resumeAfterDrain();
  });
});
