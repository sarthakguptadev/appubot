/**
 * A thread never sits empty (`ChatService.openThread`): the bot opens a new one itself with a short line, in a quiet
 * turn of AppuBot's own; a bot nobody has talked to sets itself up instead; a thread nobody has written in yet is the
 * new thread already.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

let core: Core | undefined;
let runtime: FakeRuntime;
let root: string | undefined;

const until = async (test: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};
const texts = (m: Message): string => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
const promptsOf = (): string[] => runtime.prompts.map((p) => p.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n'));

async function start(openers: boolean): Promise<Core> {
  root = mkdtempSync(join(tmpdir(), 'appubot-openers-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: async () => ({ shown: true }),
    version: '0.0.0-test', hostName: 'Test Mac', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    ...(openers ? { threadOpeners: true } : {}),
  });
  await core.start();
  runtime.reply = (text) => (text.includes('Open the thread yourself') ? 'Morning! Want me to check the inbox?' : text.includes('set yourself up') ? 'Hi, I’m new here.' : 'Done.');
  return core;
}

afterEach(async () => {
  await core?.stop();
  core = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('a new thread is opened by its bot', () => {
  it('says the first thing in a new thread, quietly, and keeps that thread for the next New thread', async () => {
    const c = await start(true);
    const bot = c.services.bots.list()[0]!;
    const first = c.services.threads.chatFor(bot.id);
    c.services.chat.send({ threadId: first.id, text: 'hello', attachments: [], images: [] }, 'desktop');
    await until(() => c.services.threads.messages(first.id).some((m) => m.role === 'agent' && m.status === 'complete'));

    const thread = c.services.chat.startThread(bot.id);
    expect(thread.id).not.toBe(first.id);
    await until(() => c.services.threads.messages(thread.id).some((m) => m.status === 'complete'));
    const said = c.services.threads.messages(thread.id);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ role: 'agent', via: 'system', status: 'complete' });
    expect(texts(said[0]!)).toBe('Morning! Want me to check the inbox?');
    // its prompt is AppuBot's own, never stored: one short line, no tools, no setup questions
    const opener = promptsOf().find((p) => p.includes('Open the thread yourself'))!;
    expect(opener).toContain(`as ${bot.name}`);
    expect(opener).toContain('Use no tools');
    expect(c.services.threads.require(thread.id).lastMessagePreview).toContain('Morning!');

    // nobody has written in it yet: it is the new thread already, and it isn't opened twice
    const before = runtime.prompts.length;
    expect(c.services.chat.startThread(bot.id).id).toBe(thread.id);
    await new Promise((r) => setTimeout(r, 60));
    expect(runtime.prompts.length).toBe(before);

    // once written in, New thread makes another, opened in turn
    c.services.chat.send({ threadId: thread.id, text: 'yes please', attachments: [], images: [] }, 'desktop');
    await until(() => c.services.threads.messages(thread.id).filter((m) => m.role === 'agent' && m.status === 'complete').length === 2);
    const next = c.services.chat.startThread(bot.id);
    expect(next.id).not.toBe(thread.id);
    await until(() => c.services.threads.messages(next.id).some((m) => m.status === 'complete'));
  });

  it('opens a thread left empty before, and has a bot nobody talked to set itself up instead', async () => {
    const c = await start(true);
    const bot = c.services.bots.list()[0]!;
    // nobody has talked to this bot: its first thread is its setup chat
    const first = c.services.chat.startThread(bot.id);
    await until(() => c.services.threads.messages(first.id).some((m) => m.status === 'complete'));
    expect(texts(c.services.threads.messages(first.id)[0]!)).toBe('Hi, I’m new here.');
    expect(promptsOf().some((p) => p.includes('Open the thread yourself'))).toBe(false);

    // a current thread with nothing in it (made before bots opened threads): New thread opens that one
    c.services.chat.send({ threadId: first.id, text: 'ok', attachments: [], images: [] }, 'desktop');
    await until(() => c.services.threads.messages(first.id).filter((m) => m.role === 'agent' && m.status === 'complete').length === 2);
    const empty = c.services.threads.create({ botId: bot.id, source: 'desktop' });
    expect(c.services.chat.startThread(bot.id).id).toBe(empty.id);
    await until(() => c.services.threads.messages(empty.id).some((m) => m.status === 'complete'));
    expect(texts(c.services.threads.messages(empty.id)[0]!)).toBe('Morning! Want me to check the inbox?');
  });

  it('leaves a new thread empty where the switch is off', async () => {
    const c = await start(false);
    const bot = c.services.bots.list()[0]!;
    const first = c.services.threads.chatFor(bot.id);
    c.services.chat.send({ threadId: first.id, text: 'hello', attachments: [], images: [] }, 'desktop');
    await until(() => c.services.threads.messages(first.id).some((m) => m.role === 'agent' && m.status === 'complete'));
    const thread = c.services.chat.startThread(bot.id);
    await new Promise((r) => setTimeout(r, 80));
    expect(c.services.threads.messages(thread.id)).toHaveLength(0);
    expect(c.services.chat.startThread(bot.id).id).toBe(thread.id);
  });

  it('says nothing, and tells nobody, where the bot’s agent isn’t known to be signed in', async () => {
    const c = await start(true);
    const bot = c.services.bots.list()[0]!;
    const first = c.services.threads.chatFor(bot.id);
    c.services.chat.send({ threadId: first.id, text: 'hello', attachments: [], images: [] }, 'desktop');
    await until(() => c.services.threads.messages(first.id).some((m) => m.role === 'agent' && m.status === 'complete'));
    // 2026-11-18: a new cloud computer's Claude Code, not signed in yet, answered an opener with an auth error
    runtime.logins.set(bot.providerId, 'unknown');
    await c.services.providers.refresh([bot.providerId]);
    const thread = c.services.chat.startThread(bot.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(c.services.threads.messages(thread.id)).toHaveLength(0);
    // (leaving the old thread asks it what to remember: that prompt isn't an opener)
    expect(promptsOf().some((t) => t.includes('Open the thread yourself'))).toBe(false);
  });

  it('a bot nobody talked to doesn’t greet on an agent that isn’t known to be signed in', async () => {
    const c = await start(true);
    const bot = c.services.bots.list()[0]!;
    // a new cloud computer's Claude Code, installed and not signed in yet
    runtime.logins.set(bot.providerId, 'unknown');
    runtime.authStatuses.set(bot.providerId, 'unknown' as never);
    await c.services.providers.refresh([bot.providerId]);
    const thread = c.services.chat.startThread(bot.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(c.services.threads.messages(thread.id)).toHaveLength(0);
    expect(promptsOf().some((t) => t.includes('set yourself up'))).toBe(false);
  });
});
