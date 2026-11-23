/**
 * A phone whose connection dropped before `chat.send` answered sends the message again with the same `clientId`: the
 * bot gets it once, and the phone gets back the message it already sent. The ids are each device's own, and are
 * remembered across a restart of AppuBot (a phone's outbox outlives both); answers to a bot's question too.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, Thread } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

let core: Core;
let runtime: FakeRuntime;
let root: string;
let bot: Bot;
let thread: Thread;

const makeCore = () => createCore({
  paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
  runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
  openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
  version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-resend-'));
  core = makeCore();
  await core.start();
  bot = core.services.bots.create({ name: 'Once', providerId: 'claude-code' } as Parameters<typeof core.services.bots.create>[0]);
  thread = core.services.threads.chatFor(bot.id);
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('a message sent again after a dropped connection', () => {
  it('is taken once, and carries the id the phone knows it by', async () => {
    const before = runtime.prompts.length;
    const first = core.services.chat.send({ threadId: thread.id, text: 'hello once', attachments: [], images: [], clientId: 'local:abc-1' }, 'mobile');
    const again = core.services.chat.send({ threadId: thread.id, text: 'hello once', attachments: [], images: [], clientId: 'local:abc-1' }, 'mobile');
    expect(again).toEqual(first);
    expect(first.userMessage.clientId).toBe('local:abc-1');
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(before + 1));
    const mine = core.services.threads.messages(thread.id, { limit: 50 }).filter((m) => m.role === 'user');
    expect(mine).toHaveLength(1);
    // another message with the same words is a message of its own
    core.services.chat.send({ threadId: thread.id, text: 'hello once', attachments: [], images: [], clientId: 'local:abc-2' }, 'mobile');
    expect(core.services.threads.messages(thread.id, { limit: 50 }).filter((m) => m.role === 'user')).toHaveLength(2);
  });
});

describe('sent ids, per device and across a restart', () => {
  let thread: Thread;
  const userMessages = () => core.services.threads.messages(thread.id, { limit: 200 }).filter((m) => m.role === 'user');

  beforeAll(() => {
    // a chat of its own, whose agent just answers (no approval to wait on)
    const other = core.services.bots.create({ name: 'Twice', providerId: 'claude-code' } as Parameters<typeof core.services.bots.create>[0]);
    thread = core.services.threads.chatFor(other.id);
    runtime.reply = () => 'Sure.';
  });

  it('are each device’s own: another phone’s same id is another message', () => {
    const before = userMessages().length;
    const mine = core.services.chat.send({ threadId: thread.id, text: 'from phone A', attachments: [], images: [], clientId: 'local:same' }, 'mobile', { device: 'phone-a' });
    const theirs = core.services.chat.send({ threadId: thread.id, text: 'from phone B', attachments: [], images: [], clientId: 'local:same' }, 'mobile', { device: 'phone-b' });
    expect(theirs.userMessage.id).not.toBe(mine.userMessage.id);
    expect(userMessages()).toHaveLength(before + 2);
  });

  it('hold after AppuBot restarts: the message sent before comes back, not a second one', async () => {
    const first = core.services.chat.send({ threadId: thread.id, text: 'sent just before the restart', attachments: [], images: [], clientId: 'local:restart-1' }, 'mobile', { device: 'phone-a' });
    await vi.waitFor(() => expect(core.services.threads.get(thread.id)?.status).toBe('idle'));
    await core.stop();
    core = makeCore();
    await core.start();
    runtime.reply = () => 'Sure.';
    const before = userMessages().length;
    const again = core.services.chat.send({ threadId: thread.id, text: 'sent just before the restart', attachments: [], images: [], clientId: 'local:restart-1' }, 'mobile', { device: 'phone-a' });
    expect(again.userMessage.id).toBe(first.userMessage.id);
    expect(again.agentMessageId).toBe(first.agentMessageId);
    expect(userMessages()).toHaveLength(before);
  });

  it('take an answer to a bot’s question once: sent again it answers ok, never “not found”', async () => {
    const asked = new Promise<string>((resolve) => {
      const off = core.ctx.bus.on((e) => { if (e.event === 'question.asked') { off(); resolve((e.payload as { questionId: string }).questionId); } });
    });
    core.services.chat.send({ threadId: thread.id, text: 'slow question time', attachments: [], images: [] }, 'mobile', { device: 'phone-a' });
    await vi.waitFor(() => expect(core.services.threads.get(thread.id)?.status).toBe('running'));
    const answer = core.services.agentBridge.ask({ botId: thread.botId, threadId: thread.id } as Parameters<typeof core.services.agentBridge.ask>[0], 'Which one?', ['Red', 'Blue'], 60);
    const questionId = await asked;
    expect(core.services.chat.answer({ questionId, answer: 'Red', clientId: 'local:ans-1' }, 'phone-a')).toEqual({ ok: true });
    expect(await answer).toEqual({ answer: 'Red' });
    expect(core.services.chat.answer({ questionId, answer: 'Red', clientId: 'local:ans-1' }, 'phone-a')).toEqual({ ok: true });
    // another device's answer to a question that's gone is still news to it
    expect(() => core.services.chat.answer({ questionId, answer: 'Red', clientId: 'local:ans-1' }, 'phone-b')).toThrow(/not found/i);
    await core.services.chat.cancel(thread.id);
  });
});
