/**
 * A message sent while the bot works: an agent that takes messages into its running turn (ACP steering: Claude Code,
 * Codex, OpenCode) gets it at once with a line of AppuBot's telling it to answer and carry on, and its answer is a
 * reply of its own under that message. Any other agent's job is never cut short by it: the message waits for the turn
 * to end and runs next (Stop is the composer's own button, `chat.cancel`). And what the bot sends on its own while it
 * works (`send_message`): short, not too often, never twice, and no notification.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, Message, Thread } from '@appubot/protocol';
import { waitingSends } from '@appubot/chat-core';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { MID_JOB_HINT, OPENING_NOTE_AFTER_MS } from './chat';
import { NOTE_BURST, NOTE_EVERY_MS, NOTE_MAX_CHARS } from './notes';

let core: Core;
let runtime: FakeRuntime;
let root: string;
let bot: Bot;
let thread: Thread;
/** every notice raised: the OS's (the app is never in front here) and the app's own toasts */
const notices: string[] = [];

const text = (m: Message | undefined): string => (m?.parts ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
const messages = (): Message[] => core.services.threads.messages(thread.id, { limit: 50 });
const idle = () => vi.waitFor(() => expect(core.services.threads.require(thread.id).status).toBe('idle'));
const send = (t: string) => core.services.chat.send({ threadId: thread.id, text: t, attachments: [], images: [] });
const session = (): string => runtime.prompts.at(-1)!.sessionId;
const promptText = (i: number): string => runtime.prompts[i]!.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');

/** A turn that runs until something ends it ("slow": it has thought, and waits). */
async function startSlowTurn(): Promise<number> {
  const before = runtime.prompts.length;
  send('do something slow');
  await vi.waitFor(() => expect(runtime.prompts.length).toBe(before + 1));
  return before + 1;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-steer-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: (title, body) => { notices.push(`${title}: ${body}`); },
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
  });
  await core.start();
  core.ctx.bus.on((e) => { if (e.event === 'notification') notices.push(JSON.stringify(e.payload)); });
  bot = core.services.bots.create({ name: 'Steady', providerId: 'claude-code' } as Parameters<typeof core.services.bots.create>[0]);
  thread = core.services.threads.chatFor(bot.id);
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  runtime.steering = false;
  runtime.steerAnswerMs = 5;
  runtime.steerThenStep = false;
  core.services.chat.openingNoteAfterMs = OPENING_NOTE_AFTER_MS;
  runtime.reply = null;
  vi.useRealTimers();
});

describe('a message sent while the bot works', () => {
  it('goes into the running turn where the agent can take it, with the line that says answer and carry on, and is answered in a reply of its own', async () => {
    runtime.steering = true;
    const prompts = await startSlowTurn();
    const sent = send('also check the logs');
    await idle();

    // no second prompt: the agent took it into the turn
    expect(runtime.prompts.length).toBe(prompts);
    // what the agent was given: AppuBot's line, then the message; what the chat keeps: the message alone
    expect(runtime.steered.at(-1)?.blocks).toEqual([{ type: 'text', text: `${MID_JOB_HINT}\nalso check the logs` }]);
    expect(MID_JOB_HINT).toMatch(/send_message/);
    expect(MID_JOB_HINT).toMatch(/carry on/);
    const all = messages();
    const first = all.findIndex((m) => m.role === 'user' && text(m) === 'do something slow');
    const tail = all.slice(first).map((m) => [m.role, m.status, m.role === 'user' ? text(m) : text(m) || m.parts[0]?.type]);
    // the reply so far stays above the new message, the answer to it comes under it
    expect(tail).toEqual([
      ['user', 'complete', 'do something slow'],
      ['agent', 'complete', 'thought'],
      ['user', 'complete', 'also check the logs'],
      ['agent', 'complete', `On it: ${MID_JOB_HINT}\nalso check the logs`],
    ]);
    expect(all.at(-1)?.id).toBe(sent.agentMessageId);
  });

  it('waits where the agent can’t take it: the job runs to its end, then the message is read', async () => {
    const prompts = await startSlowTurn();
    const slow = messages().at(-1)!;
    const sent = send('how long will it take?');
    // tried, not taken: nothing is stopped, no second prompt, and the chat shows the message as waiting
    await vi.waitFor(() => expect(core.services.chat.isBusy(thread.id)).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(runtime.prompts.length).toBe(prompts);
    expect(messages().find((m) => m.id === slow.id)?.status).toBe('streaming');
    expect(core.services.threads.require(thread.id).status).toBe('running');
    expect(waitingSends(messages())).toEqual([sent.userMessage.id]);

    // the job ends by itself: its reply is complete, never cut, and the message runs as the next turn, as it was written
    runtime.reply = (t) => (t.includes('how long') ? 'It took a minute; all done.' : undefined);
    runtime.finishSlow(session());
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(prompts + 1));
    await idle();
    const done = messages().find((m) => m.id === slow.id)!;
    expect(done.status).toBe('complete');
    expect(text(done)).toBe('The slow thing is done.');
    expect(promptText(prompts)).toBe('how long will it take?');
    expect(text(messages().at(-1))).toBe('It took a minute; all done.');
    expect(messages().at(-1)?.id).toBe(sent.agentMessageId);
    expect(waitingSends(messages())).toEqual([]);
  });

  it('is read at once on "Stop and read now": only the running turn ends, and the message runs next', async () => {
    runtime.reply = (t) => (t.includes('stop') ? 'Okay, stopped.' : undefined);
    const prompts = await startSlowTurn();
    const slow = messages().at(-1)!;
    const sent = send('stop, wrong folder');
    await new Promise((r) => setTimeout(r, 20));
    expect(runtime.prompts.length).toBe(prompts);
    await core.services.chat.cancel(thread.id, { keepQueued: true });
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(prompts + 1));
    await idle();
    expect(messages().find((m) => m.id === slow.id)?.status).toBe('cancelled');
    expect(text(messages().at(-1))).toBe('Okay, stopped.');
    expect(messages().at(-1)?.id).toBe(sent.agentMessageId);
    // with nothing waiting it stops nothing
    await startSlowTurn();
    await core.services.chat.cancel(thread.id, { keepQueued: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(core.services.chat.isBusy(thread.id)).toBe(true);
    runtime.finishSlow(session());
    await idle();
  });

  it('goes with the job on a plain Stop, as every waiting turn does', async () => {
    const prompts = await startSlowTurn();
    const slow = messages().at(-1)!;
    const sent = send('and send Priya a copy');
    await new Promise((r) => setTimeout(r, 20));
    await core.services.chat.cancel(thread.id);
    await idle();
    expect(runtime.prompts.length).toBe(prompts);
    expect(messages().find((m) => m.id === slow.id)?.status).toBe('cancelled');
    expect(messages().find((m) => m.id === sent.agentMessageId)).toMatchObject({ status: 'cancelled', parts: [] });
  });

  it('still ends a turn that is itself waiting for the user: what they wrote is the answer it gets', async () => {
    runtime.reply = (t) => (t.includes('neither') ? 'Understood.' : undefined);
    const prompts = await startSlowTurn();
    const slow = messages().at(-1)!;
    // the bot asked something (a question card, an approval): the thread waits for the user
    core.services.chat.setWaiting(thread.id, true);
    expect(core.services.threads.require(thread.id).status).toBe('waiting');
    send('neither, do it the other way');
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(prompts + 1));
    await idle();
    expect(messages().find((m) => m.id === slow.id)?.status).toBe('cancelled');
    expect(text(messages().at(-1))).toBe('Understood.');
  });
});

describe('what the bot sends on its own while it works (send_message)', () => {
  const said = (m: Message | undefined): string[] => (m?.parts ?? []).flatMap((p) => (p.type === 'text' && p.said ? [p.text] : []));
  const refused = (t: string): string => {
    try { core.services.chat.say(thread.id, t); } catch (e) { return (e as Error).message; }
    return '';
  };

  it('is a bubble in the reply being written, raises no notice, and the turn’s end raises the one there is', async () => {
    // a quiet stretch first: how often it may write carries over from the turns before
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * NOTE_EVERY_MS });
    await startSlowTurn();
    const slow = messages().at(-1)!;
    notices.length = 0;
    const { messageId } = core.services.chat.say(thread.id, 'On it: this will take a few minutes.');
    expect(messageId).toBe(slow.id);
    expect(said(messages().find((m) => m.id === slow.id))).toEqual(['On it: this will take a few minutes.']);
    expect(messages().find((m) => m.id === slow.id)?.status).toBe('streaming');
    await new Promise((r) => setTimeout(r, 30));
    expect(notices).toEqual([]);

    runtime.finishSlow(session());
    await idle();
    await vi.waitFor(() => expect(notices.length).toBe(1));
    // the notice says what the turn ended on, never the note
    expect(notices[0]).toContain('The slow thing is done.');
    expect(notices[0]).not.toContain('On it');
  });

  it('is turned down when it repeats the last one, is too long, or comes too often, in words the bot can act on', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 20 * NOTE_EVERY_MS });
    await startSlowTurn();
    const slow = messages().at(-1)!;
    expect(refused('Reading the statement.')).toBe('');
    expect(refused('reading the statement')).toMatch(/already told the user/);
    expect(refused('x'.repeat(NOTE_MAX_CHARS + 1))).toMatch(new RegExp(`${NOTE_MAX_CHARS + 1} characters is too long`));
    for (let i = 1; i < NOTE_BURST; i++) expect(refused(`Step ${i} is done.`)).toBe('');
    expect(refused('One more step is done.')).toMatch(/too many messages in a row/);
    // only the ones that went out are in the chat
    expect(said(messages().find((m) => m.id === slow.id))).toEqual(['Reading the statement.', ...Array.from({ length: NOTE_BURST - 1 }, (_, i) => `Step ${i + 1} is done.`)]);
    // a minute later one more may go
    vi.setSystemTime(Date.now() + NOTE_EVERY_MS);
    expect(refused('The PDF is built.')).toBe('');
    expect(refused('And checked.')).toMatch(/too many messages in a row/);
    runtime.finishSlow(session());
    await idle();

    // a new turn may open as the last one did, but not sooner than the minute allows
    await startSlowTurn();
    expect(refused('The PDF is built.')).toMatch(/too many messages in a row/);
    vi.setSystemTime(Date.now() + NOTE_EVERY_MS);
    expect(refused('The PDF is built.')).toBe('');
    runtime.finishSlow(session());
    await idle();
  });

  it('always lets the answer to a message the user wrote mid-job out, once', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 40 * NOTE_EVERY_MS });
    runtime.steering = true;
    runtime.steerAnswerMs = 400;
    await startSlowTurn();
    for (let i = 0; i < NOTE_BURST; i++) expect(refused(`Milestone ${i}.`)).toBe('');
    expect(refused('One too many.')).toMatch(/too many messages in a row/);
    const sent = send('what is 17 times 3?');
    await vi.waitFor(() => expect(messages().at(-1)?.id).toBe(sent.agentMessageId));
    expect(refused('51.')).toBe('');
    expect(refused('And another thing.')).toMatch(/too many messages in a row/);
    // it sits in the reply under the question, which is still being written
    expect(said(messages().at(-1))).toEqual(['51.']);
    await idle();
  });
});

describe('the line a bot writes before it starts on a job', () => {
  const said = (m: Message | undefined): string[] => (m?.parts ?? []).flatMap((p) => (p.type === 'text' && p.said ? [p.text] : []));
  const OPENING = 'I’ll pull the three reports and compare them.';
  const startJob = async (): Promise<Message> => {
    const before = runtime.prompts.length;
    send('a long job, please');
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(before + 1));
    await vi.waitFor(() => expect(messages().at(-1)?.parts.some((p) => p.type === 'tool_call')).toBe(true));
    return messages().at(-1)!;
  };

  it('shows as a note once the job has run a while, with no notice, and the reply at the end still stands', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60 * NOTE_EVERY_MS });
    core.services.chat.openingNoteAfterMs = 1000;
    const job = await startJob();
    notices.length = 0;
    // not at once: a quick task would be done by now
    expect(said(messages().find((m) => m.id === job.id))).toEqual([]);
    await vi.waitFor(() => expect(said(messages().find((m) => m.id === job.id))).toEqual([OPENING]), { timeout: 5000 });
    expect(notices).toEqual([]);
    // it counts as one of the bot's own: the same line isn't sent again
    expect(() => core.services.chat.say(thread.id, OPENING)).toThrow(/already told the user/);
    runtime.finishSlow(session());
    await idle();
    const done = messages().find((m) => m.id === job.id)!;
    expect(done.parts.map((p) => (p.type === 'text' ? [p.text, !!p.said] : p.type))).toEqual([[OPENING, true], 'tool_call', ['The slow thing is done.', false]]);
    await vi.waitFor(() => expect(notices.length).toBe(1));
    expect(notices[0]).toContain('The slow thing is done.');
    expect(notices[0]).not.toContain('reports');
  });

  it('stays out of the chat when the task was quick', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 80 * NOTE_EVERY_MS });
    core.services.chat.openingNoteAfterMs = 1000;
    const job = await startJob();
    runtime.finishSlow(session());
    await idle();
    await new Promise((r) => setTimeout(r, 1300));
    expect(said(messages().find((m) => m.id === job.id))).toEqual([]);
  });

  it('stays as it is when the bot sent a note itself, or when the message wasn’t the user’s own', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 100 * NOTE_EVERY_MS });
    core.services.chat.openingNoteAfterMs = 1000;
    const job = await startJob();
    core.services.chat.say(thread.id, 'On it: three reports to compare.');
    await new Promise((r) => setTimeout(r, 1300));
    expect(said(messages().find((m) => m.id === job.id))).toEqual(['On it: three reports to compare.']);
    runtime.finishSlow(session());
    await idle();

    // a routine's run: nobody is watching the chat for it
    vi.setSystemTime(Date.now() + 10 * NOTE_EVERY_MS);
    core.services.chat.openingNoteAfterMs = 100;
    const before = runtime.prompts.length;
    core.services.chat.send({ threadId: thread.id, text: 'a long job, every morning', attachments: [], images: [] }, 'routine');
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(before + 1));
    await vi.waitFor(() => expect(messages().at(-1)?.parts.some((p) => p.type === 'tool_call')).toBe(true));
    const routine = messages().at(-1)!;
    await new Promise((r) => setTimeout(r, 450));
    expect(said(messages().find((m) => m.id === routine.id))).toEqual([]);
    runtime.finishSlow(session());
    await idle();
  });

  it('is the answer to a message taken mid-job when the bot wrote it instead of sending it: it shows at once', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 120 * NOTE_EVERY_MS });
    runtime.steering = true;
    runtime.steerAnswerMs = 20;
    runtime.steerThenStep = true;
    await startSlowTurn();
    const sent = send('what is 17 times 3?');
    await idle();
    const reply = messages().find((m) => m.id === sent.agentMessageId)!;
    // written, not sent: the words before its next step are shown as its answer
    expect(reply.parts.map((p) => (p.type === 'text' ? [p.text, !!p.said] : p.type))).toEqual([[`On it: ${MID_JOB_HINT}\nwhat is 17 times 3?`, true], 'tool_call']);
  });
});
