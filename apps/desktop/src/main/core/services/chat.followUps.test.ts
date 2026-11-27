/**
 * A bot's own follow-ups: the block that ends its reply (chat-core followUps.ts) never reaches the chat as text. Its
 * lines are kept on the message and sent with its completion, so the apps show them as pills under it, the same after
 * a restart and in another window.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Events, MessageSchema, type Bot, type Message, type Thread } from '@appubot/protocol';
import type { TurnOp } from '@appubot/agent-runtime';
import { FOLLOW_UP_MAX_CHARS } from '@appubot/chat-core';
import { createCore, type Core } from '../app';
import { OPENING_NOTE_AFTER_MS } from './chat';
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
async function turn(ops: TurnOp[], ends: 'end_turn' | 'cancelled' | 'max_tokens' = 'end_turn'): Promise<{ reply: Message; sent: typeof events }> {
  runtime.reply = (_t, sid) => { for (const op of ops) runtime.hooks.onTurnOp(sid, op); return ''; };
  runtime.replyEnds = ends;
  const from = events.length;
  const { agentMessageId } = core.services.chat.send({ threadId: thread.id, text: 'summarise the report', attachments: [], images: [] });
  await vi.waitFor(() => expect(events.slice(from).some((e) => e.event === 'message.completed' && e.payload.messageId === agentMessageId)).toBe(true), { timeout: 5000 });
  await idle();
  runtime.reply = null;
  runtime.replyEnds = 'end_turn';
  return { reply: messages().find((m) => m.id === agentMessageId)!, sent: events.slice(from).filter((e) => e.payload.messageId === agentMessageId) };
}
const words = (partIndex: number, t: string, size = 5): TurnOp[] =>
  Array.from({ length: Math.ceil(t.length / size) }, (_, i) => ({ op: 'delta' as const, partIndex, partType: 'text' as const, delta: t.slice(i * size, (i + 1) * size) }));
const tool = (partIndex: number): TurnOp => ({ op: 'part', partIndex, part: { type: 'tool_call', toolCallId: `t${partIndex}`, title: 'Read report.md', kind: 'read', status: 'completed', content: [], locations: [] } });

/** the reply's text as the apps were sent it, piece by piece */
const streamed = (sent: typeof events): string => sent.flatMap((e) => (e.event === 'message.delta' && e.payload.partType === 'text' ? [String(e.payload.delta)] : [])).join('');

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

describe('a reply cut off while its block was arriving', () => {
  it('keeps nothing of the tag, and only the lines that were whole, when it ran out of words', async () => {
    const line = await turn(words(0, 'Here it is.\n\n<followups>\nEmail it to the team\nMake it sh', 4), 'max_tokens');
    expect(line.reply).toMatchObject({ status: 'complete', stopReason: 'max_tokens', followUps: ['Email it to the team'] });
    expect(text(line.reply)).toBe('Here it is.');
    expect(streamed(line.sent)).toBe('Here it is.');
    const tag = await turn(words(0, 'Here it is.\n\n<follow', 4), 'max_tokens');
    expect(text(tag.reply)).toBe('Here it is.');
    expect(streamed(tag.sent)).toBe('Here it is.');
    expect(tag.reply.followUps).toBeUndefined();
    const closing = await turn(words(0, 'Here it is.\n\n<followups>\nEmail it to the team\n</follo', 4), 'max_tokens');
    expect(text(closing.reply)).toBe('Here it is.');
    expect(closing.reply.followUps).toEqual(['Email it to the team']);
    expect(JSON.stringify([line.sent, tag.sent, closing.sent])).not.toMatch(/<\/?fol/i);
  });
});

describe('a note sent mid-job is not the reply', () => {
  const said = (m: Message | undefined): string[] => (m?.parts ?? []).flatMap((p) => (p.type === 'text' && p.said ? [p.text] : []));
  /** a job that runs until `end`: the agent's session, and the reply being written */
  const startJob = async (): Promise<{ sid: string; id: string; end: () => Promise<Message> }> => {
    const before = runtime.prompts.length;
    const { agentMessageId: id } = core.services.chat.send({ threadId: thread.id, text: 'do something slow', attachments: [], images: [] });
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(before + 1));
    const sid = runtime.prompts.at(-1)!.sessionId;
    const end = async () => {
      (runtime as unknown as { ends: Map<string, () => void> }).ends.get(sid)!();
      await idle();
      return messages().find((m) => m.id === id)!;
    };
    return { sid, id, end };
  };
  afterEach(() => { core.services.chat.openingNoteAfterMs = OPENING_NOTE_AFTER_MS; });

  it('goes out as written, and without a block the bot put in it; the reply at the end still offers its own', async () => {
    const job = await startJob();
    const plain = 'Two were filed under Other (a < b in the rules): fixed.';
    expect(core.services.chat.say(thread.id, plain).text).toBe(plain);
    expect(core.services.chat.say(thread.id, `Rebuilding the PDF now.${BLOCK}`).text).toBe('Rebuilding the PDF now.');
    // one that is only a block is turned down, in words the bot can act on
    expect(() => core.services.chat.say(thread.id, BLOCK.trim())).toThrow(/follow-ups go at the very end of your reply/);
    expect(said(messages().find((m) => m.id === job.id))).toEqual([plain, 'Rebuilding the PDF now.']);
    const from = events.length;
    for (const op of words(9, 'The report is rebuilt.\n\n<followups>\nSend it to Priya\n</followups>')) runtime.hooks.onTurnOp(job.sid, op);
    const reply = await job.end();
    expect(reply.followUps).toEqual(['Send it to Priya']);
    expect(reply.parts.flatMap((p) => (p.type === 'text' ? [[p.text, !!p.said]] : []))).toEqual([[plain, true], ['Rebuilding the PDF now.', true], ['The report is rebuilt.', false]]);
    expect(JSON.stringify([reply.parts, events.slice(from).filter((e) => e.event !== 'message.completed')])).not.toMatch(/<\/?follow|Email it|Send it to Priya/);
  });

  it('never carries a block as the line a bot wrote before its first step, and that block offers nothing', async () => {
    core.services.chat.openingNoteAfterMs = 50;
    const job = await startJob();
    for (const op of words(1, `I’ll pull the three reports and compare them.${BLOCK}`)) runtime.hooks.onTurnOp(job.sid, op);
    runtime.hooks.onTurnOp(job.sid, { op: 'part', partIndex: 2, part: { type: 'tool_call', toolCallId: 'job1', title: 'Read reports', kind: 'read', status: 'in_progress', content: [], locations: [] } });
    await vi.waitFor(() => expect(said(messages().find((m) => m.id === job.id))).toEqual(['I’ll pull the three reports and compare them.']), { timeout: 5000 });
    for (const op of words(9, 'All three agree.')) runtime.hooks.onTurnOp(job.sid, op);
    const reply = await job.end();
    expect(reply.followUps).toBeUndefined();
    expect(JSON.stringify(reply)).not.toMatch(/follow|Email it/i);
  });
});

describe('a reply nobody sees', () => {
  it('saves no follow-up as a fact when the bot is asked what to remember', async () => {
    await turn(words(0, 'Noted.'));
    runtime.reply = (t) => (t.includes('moved on from this thread') ? '- Likes short summaries\n\n<followups>\n- Remind me tomorrow\n</followups>' : 'Hello.');
    core.services.chat.startThread(bot.id);
    await vi.waitFor(() => expect(core.services.bots.getMemory(bot.id).memory).toContain('Likes short summaries'));
    runtime.reply = null;
    expect(core.services.bots.getMemory(bot.id).memory).not.toMatch(/Remind me tomorrow|followups/);
  });
});

// last of the turns: a turn after a restart is primed with the chat's earlier messages, the "slow" one among them
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

  it('and nothing of a block that was still arriving when AppuBot stopped', async () => {
    const before = runtime.prompts.length;
    const { agentMessageId } = core.services.chat.send({ threadId: thread.id, text: 'do something slow', attachments: [], images: [] });
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(before + 1));
    const sid = runtime.prompts.at(-1)!.sessionId;
    for (const op of words(1, 'Half done.\n\n<followups>\nEmail it to the te')) runtime.hooks.onTurnOp(sid, op);
    await core.stop();
    core = make(root);
    await core.start();
    core.ctx.bus.on((e) => { events.push(e as { event: string; payload: Record<string, unknown> }); });
    const cut = messages().find((m) => m.id === agentMessageId)!;
    expect(text(cut)).toBe('Half done.');
    expect(cut.followUps).toBeUndefined();
    expect(JSON.stringify(cut)).not.toMatch(/follow|Email/i);
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
