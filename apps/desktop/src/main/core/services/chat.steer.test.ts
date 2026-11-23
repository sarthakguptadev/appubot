/**
 * A message sent while the bot works: an agent that takes messages into its running turn (Claude Code's ACP steering)
 * gets it at once, and its answer is a reply of its own under that message; any other agent's turn ends there and the
 * message runs next, so the agent reads it at once either way (Stop is the composer's own button, `chat.cancel`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, Message, Thread } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

let core: Core;
let runtime: FakeRuntime;
let root: string;
let bot: Bot;
let thread: Thread;

const text = (m: Message | undefined): string => (m?.parts ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
const messages = (): Message[] => core.services.threads.messages(thread.id, { limit: 50 });
const idle = () => vi.waitFor(() => expect(core.services.threads.require(thread.id).status).toBe('idle'));

/** A turn that runs until something ends it ("slow": it has thought, and waits). */
async function startSlowTurn(): Promise<number> {
  const before = runtime.prompts.length;
  core.services.chat.send({ threadId: thread.id, text: 'do something slow', attachments: [], images: [] });
  await vi.waitFor(() => expect(runtime.prompts.length).toBe(before + 1));
  return before + 1;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-steer-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
  });
  await core.start();
  bot = core.services.bots.create({ name: 'Steady', providerId: 'claude-code' } as Parameters<typeof core.services.bots.create>[0]);
  thread = core.services.threads.chatFor(bot.id);
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('a message sent while the bot works', () => {
  it('goes into the running turn where the agent can take it, answered in a reply of its own', async () => {
    runtime.steering = true;
    const prompts = await startSlowTurn();
    const sent = core.services.chat.send({ threadId: thread.id, text: 'also check the logs', attachments: [], images: [] });
    await idle();

    // no second prompt: the agent took it into the turn
    expect(runtime.prompts.length).toBe(prompts);
    expect(runtime.steered.at(-1)?.blocks).toEqual([{ type: 'text', text: 'also check the logs' }]);
    const all = messages();
    const first = all.findIndex((m) => m.role === 'user' && text(m) === 'do something slow');
    const tail = all.slice(first).map((m) => [m.role, m.status, m.role === 'user' ? text(m) : text(m) || m.parts[0]?.type]);
    // the reply so far stays above the new message, the answer to it comes under it
    expect(tail).toEqual([
      ['user', 'complete', 'do something slow'],
      ['agent', 'complete', 'thought'],
      ['user', 'complete', 'also check the logs'],
      ['agent', 'complete', 'On it: also check the logs'],
    ]);
    expect(all.at(-1)?.id).toBe(sent.agentMessageId);
  });

  it('ends the running turn where the agent can’t take it, so the agent reads it now and decides', async () => {
    runtime.steering = false;
    runtime.reply = (t) => (t.includes('stop') ? 'Okay, stopped.' : undefined);
    const prompts = await startSlowTurn();
    const slow = messages().at(-1)!;
    core.services.chat.send({ threadId: thread.id, text: 'stop', attachments: [], images: [] });
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(prompts + 1));
    await idle();
    expect(messages().find((m) => m.id === slow.id)?.status).toBe('cancelled');
    expect(text(messages().at(-1))).toBe('Okay, stopped.');
    runtime.reply = null;
  });
});
