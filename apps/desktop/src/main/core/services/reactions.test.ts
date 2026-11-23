/**
 * The user's reaction on a bot's reply is always met with something they see (`ChatService.answerReaction`): the bot's
 * one line, its own reaction back, or, when it came back with nothing, its reaction on what the user last wrote. The
 * word NO_REPLY never reaches the chat, an agent that isn't up is started for it, and a busy one answers once its turn
 * ends.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, Message } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

let core: Core;
let runtime: FakeRuntime;
let root: string;
let bot: Bot;
let threadId: string;

const until = async (test: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};
const messages = (): Message[] => core.services.threads.messages(threadId);
const lastReply = (): Message => [...messages()].reverse().find((m) => m.role === 'agent')!;
const lastMine = (): Message => [...messages()].reverse().find((m) => m.role === 'user')!;
/** the hidden turn, without the few seconds AppuBot waits for a change of mind */
const answer = () => (core.services.chat as unknown as { answerReaction(id: string): Promise<void> }).answerReaction(threadId);
/** a message of the user's, answered */
async function say(text: string, reply: string): Promise<void> {
  const before = messages().filter((m) => m.role === 'agent' && m.status === 'complete').length;
  runtime.reply = () => reply;
  core.services.chat.send({ threadId, text, attachments: [], images: [] }, 'desktop');
  await until(() => messages().filter((m) => m.role === 'agent' && m.status === 'complete').length === before + 1);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-reactions-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: async () => ({ shown: true }),
    version: '0.0.0-test', hostName: 'Test Mac', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
  });
  await core.start();
  bot = core.services.bots.list()[0]!;
  threadId = core.services.threads.chatFor(bot.id).id;
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('a reaction is always answered', () => {
  it('posts the bot’s line, and never asks it for NO_REPLY', async () => {
    await say('Book the venue', 'Booked for Friday.');
    const reply = lastReply();
    let asked = '';
    runtime.reply = (text) => { asked = text; return 'Glad that worked out!'; };
    core.services.chat.react(threadId, reply.id, 'user', '👍');
    await answer();
    expect(asked).toContain('the user just reacted 👍');
    expect(asked).not.toContain('NO_REPLY');
    expect(lastReply()).toMatchObject({ via: 'system', status: 'complete', parts: [{ type: 'text', text: 'Glad that worked out!' }] });
  });

  it('keeps the word out of the chat however it comes, and reacts back when nothing else is left', async () => {
    await say('And the caterer?', 'Caterer confirmed.');
    const reply = lastReply();
    const count = messages().length;

    // the word alone, dressed up: nothing is posted, the bot's reaction lands on what the user last wrote
    runtime.reply = () => '`NO_REPLY`';
    core.services.chat.react(threadId, reply.id, 'user', '❤️');
    await answer();
    expect(messages()).toHaveLength(count);
    expect(lastMine().reactions).toMatchObject([{ emoji: '❤️', by: 'bot' }]);

    // the word with a real line after it: only the line is posted
    runtime.reply = () => 'NO_REPLY\n\nHappy to help.';
    core.services.chat.react(threadId, reply.id, 'user', '🎉');
    await answer();
    expect(lastReply().parts).toEqual([{ type: 'text', text: 'Happy to help.' }]);
    expect(messages().some((m) => m.parts.some((p) => p.type === 'text' && /NO_REPLY/i.test(p.text)))).toBe(false);

    // an unhappy reaction met with nothing: thanks for telling, never the thumbs down back
    await say('Send it', 'Sent.');
    runtime.reply = () => '';
    core.services.chat.react(threadId, lastReply().id, 'user', '👎');
    await answer();
    expect(lastMine().reactions).toMatchObject([{ emoji: '🙏', by: 'bot' }]);
  });

  it('starts an agent that isn’t up, and waits for one that is working', async () => {
    await say('One more thing', 'Done.');
    const reply = lastReply();
    // its agent was closed (to save memory, or AppuBot restarted)
    for (const s of runtime.listSessions()) await runtime.closeSession(s.id);
    runtime.reply = () => 'Anytime.';
    core.services.chat.react(threadId, reply.id, 'user', '👍');
    await answer();
    expect(lastReply().parts).toEqual([{ type: 'text', text: 'Anytime.' }]);

    // a reaction made while the bot works is answered once that turn ends
    let release: (() => void) | undefined;
    runtime.reply = (text) => (text.includes('the user just reacted') ? 'Thanks!' : new Promise<string>((r) => { release = () => r('Working on it… done.'); }));
    core.services.chat.send({ threadId, text: 'Do the long thing', attachments: [], images: [] }, 'desktop');
    await until(() => !!release);
    core.services.chat.react(threadId, reply.id, 'user', '🔥');
    await answer();
    // nothing yet: the turn is still running
    expect(lastReply().parts).not.toEqual([{ type: 'text', text: 'Thanks!' }]);
    release!();
    await until(() => lastReply().parts.some((p) => p.type === 'text' && p.text === 'Thanks!'), 6000);
  });
});
