/**
 * A bot's own follow-ups: the block that ends its reply (chat-core followUps.ts) never reaches the chat as text. Its
 * lines are kept on the message and sent with its completion, so the apps show them as pills under it, the same after
 * a restart and in another window.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Events, MessageSchema, type Bot, type Message, type Thread } from '@appubot/protocol';
import type { TurnOp } from '@appubot/agent-runtime';
import { FOLLOW_UP_MAX_CHARS } from '@appubot/chat-core';
import { createCore, type Core } from '../app';
import { FOLLOW_UPS_PARAGRAPH, renderAgentInstructions, renderInstructionsPreface } from './bots';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

let core: Core;
let runtime: FakeRuntime;
let root: string;
let bot: Bot;
let thread: Thread;
const events: { event: string; payload: Record<string, unknown> }[] = [];

const make = (dir: string): Core => createCore({
  paths: { dataDir: join(dir, 'data'), botsRoot: join(dir, 'bots'), filesDir: join(dir, 'data', 'files'), logsDir: join(dir, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
  runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
  openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
  version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
});
const text = (m: Message | undefined): string => (m?.parts ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('|');
const messages = (): Message[] => core.services.threads.messages(thread.id, { limit: 50 });
const idle = () => vi.waitFor(() => expect(core.services.threads.require(thread.id).status).toBe('idle'));

/** One turn whose agent sends these ops; returns the reply as the computer keeps it, and the events it sent for it. */
async function turn(ops: TurnOp[], ends: 'end_turn' | 'cancelled' = 'end_turn'): Promise<{ reply: Message; sent: typeof events }> {
  runtime.reply = (_t, sid) => { for (const op of ops) runtime.hooks.onTurnOp(sid, op); return ''; };
  runtime.replyEnds = ends;
  const from = events.length;
  const { agentMessageId } = core.services.chat.send({ threadId: thread.id, text: 'summarise the report', attachments: [], images: [] });
  await vi.waitFor(() => expect(events.slice(from).some((e) => e.event === 'message.completed' && e.payload.messageId === agentMessageId)).toBe(true));
  await idle();
  runtime.reply = null;
  runtime.replyEnds = 'end_turn';
  return { reply: messages().find((m) => m.id === agentMessageId)!, sent: events.slice(from).filter((e) => e.payload.messageId === agentMessageId) };
}
const words = (partIndex: number, t: string, size = 5): TurnOp[] =>
  Array.from({ length: Math.ceil(t.length / size) }, (_, i) => ({ op: 'delta' as const, partIndex, partType: 'text' as const, delta: t.slice(i * size, (i + 1) * size) }));
const tool = (partIndex: number): TurnOp => ({ op: 'part', partIndex, part: { type: 'tool_call', toolCallId: `t${partIndex}`, title: 'Read report.md', kind: 'read', status: 'completed', content: [], locations: [] } });

const BLOCK = '\n\n<followups>\nEmail it to the team\nMake it shorter\n</followups>\n';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-followups-'));
  core = make(root);
  await core.start();
  core.ctx.bus.on((e) => { events.push(e as { event: string; payload: Record<string, unknown> }); });
  bot = core.services.bots.create({ name: 'Steady', providerId: 'claude-code' } as Parameters<typeof core.services.bots.create>[0]);
  thread = core.services.threads.chatFor(bot.id);
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('a reply that ends with follow-ups', () => {
  it('keeps them on the message and out of its text, and sends them with its completion', async () => {
    const { reply, sent } = await turn(words(0, `The summary is in summary.md.${BLOCK}`));
    expect(text(reply)).toBe('The summary is in summary.md.');
    expect(reply.status).toBe('complete');
    expect(reply.followUps).toEqual(['Email it to the team', 'Make it shorter']);
    // nothing of the block went out while it was written
    const streamed = sent.filter((e) => e.event === 'message.delta').map((e) => String(e.payload.delta)).join('');
    expect(streamed).toBe('The summary is in summary.md.');
    const done = sent.find((e) => e.event === 'message.completed')!;
    expect(done.payload.followUps).toEqual(['Email it to the team', 'Make it shorter']);
    // as the wire has it: an app from before follow-ups reads the same event and message without them
    expect(Events['message.completed'].parse(done.payload).followUps).toEqual(['Email it to the team', 'Make it shorter']);
    expect(MessageSchema.parse(reply).followUps).toEqual(reply.followUps);
    // the chat's preview and what a waiting bot or Telegram is told are the reply's own words
    expect(core.services.threads.require(thread.id).lastMessagePreview).toBe('The summary is in summary.md.');
  });

  it('reads them after the work, in the reply’s last text', async () => {
    const { reply } = await turn([...words(0, 'Reading the report.'), tool(1), ...words(2, `Done: three pages.${BLOCK}`)]);
    expect(text(reply)).toBe('Reading the report.|Done: three pages.');
    expect(reply.followUps).toEqual(['Email it to the team', 'Make it shorter']);
  });

  it('holds the count and the length, and drops empty and repeated lines', async () => {
    const long = 'x'.repeat(FOLLOW_UP_MAX_CHARS + 1);
    const { reply } = await turn(words(0, `Done.\n<followups>\n- One\n\none\n${long}\n2. Two\nThree\nFour\nFive\n</followups>`, 7));
    expect(text(reply)).toBe('Done.');
    expect(reply.followUps).toEqual(['One', 'Two', 'Three', 'Four']);
  });

  it('leaves a reply without a block exactly as it was written, with no follow-ups', async () => {
    const { reply, sent } = await turn(words(0, 'Use a < b, or <b>bold</b>.\n'));
    expect(text(reply)).toBe('Use a < b, or <b>bold</b>.\n');
    expect(reply.followUps).toBeUndefined();
    expect('followUps' in sent.find((e) => e.event === 'message.completed')!.payload).toBe(false);
  });

  it('gives none when the block is empty, and still hides it', async () => {
    const { reply } = await turn(words(0, 'Hello!\n\n<followups>\n</followups>'));
    expect(text(reply)).toBe('Hello!');
    expect(reply.followUps).toBeUndefined();
  });
});

describe('a block that is not the end of the reply', () => {
  it('is dropped when the bot goes on to use a tool', async () => {
    const { reply } = await turn([...words(0, `Let me check.${BLOCK}`), tool(1), ...words(2, 'All good.')]);
    expect(text(reply)).toBe('Let me check.|All good.');
    expect(reply.followUps).toBeUndefined();
  });

  it('is dropped when the bot writes on after it', async () => {
    const { reply } = await turn(words(0, `First.${BLOCK}\nOne more thing.`));
    expect(text(reply)).toBe('First.\n\nOne more thing.');
    expect(reply.followUps).toBeUndefined();
  });

  it('is dropped with a reply that was stopped', async () => {
    const before = runtime.prompts.length;
    core.services.chat.send({ threadId: thread.id, text: 'do something slow', attachments: [], images: [] });
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(before + 1));
    const sid = runtime.prompts.at(-1)!.sessionId;
    for (const op of words(1, `Half done.${BLOCK}`)) runtime.hooks.onTurnOp(sid, op);
    await core.services.chat.cancel(thread.id);
    await idle();
    const reply = messages().at(-1)!;
    expect(reply.status).toBe('cancelled');
    expect(text(reply)).toBe('Half done.');
    expect(reply.followUps).toBeUndefined();
  });
});

describe('follow-ups are kept', () => {
  it('through a restart: the same lines on the same message', async () => {
    const { reply } = await turn(words(0, `Saved.${BLOCK}`));
    const id = reply.id;
    await core.stop();
    core = make(root);
    await core.start();
    core.ctx.bus.on((e) => { events.push(e as { event: string; payload: Record<string, unknown> }); });
    const again = core.services.threads.messages(thread.id, { limit: 50 }).find((m) => m.id === id)!;
    expect(again.followUps).toEqual(['Email it to the team', 'Make it shorter']);
    expect(text(again)).toBe('Saved.');
  });
});

describe('what the bot is told', () => {
  it('says how to offer follow-ups, to every agent', () => {
    const file = renderAgentInstructions(bot);
    expect(file).toContain(FOLLOW_UPS_PARAGRAPH);
    expect(FOLLOW_UPS_PARAGRAPH).toContain('<followups>');
    expect(FOLLOW_UPS_PARAGRAPH).toMatch(/one to 4 short lines/);
    expect(FOLLOW_UPS_PARAGRAPH).toMatch(/under 60 characters/);
    expect(FOLLOW_UPS_PARAGRAPH).toMatch(/in their language/);
    expect(FOLLOW_UPS_PARAGRAPH).toMatch(/Never a question to the user/);
    expect(FOLLOW_UPS_PARAGRAPH).toMatch(/only what you can really do/);
    // an agent that doesn't read CLAUDE.md or AGENTS.md gets the same words in its first message
    expect(renderInstructionsPreface(bot, false)).toContain(FOLLOW_UPS_PARAGRAPH.trim());
  });
});
