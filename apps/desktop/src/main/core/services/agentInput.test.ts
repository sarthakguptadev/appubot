/**
 * A question an agent asks with a tool of its own (OpenCode's `question`, ACP elicitation) reaches the chat as one of
 * AppuBot's cards and its answer goes back under the agent's field ids (`agentInput.ts`, `ChatService.onInput`); and a
 * turn the agent itself ends as `cancelled` isn't one the user stopped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { elicitationFields, type ElicitationAnswer, type ElicitationAsk } from '@appubot/agent-runtime';
import type { Bot, Message, Part } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { inputCard } from './agentInput';

// what OpenCode 2.0.22 sends for its `question` tool
const one = (multiple = false) => ({
  properties: {
    q0: multiple
      ? { type: 'array', title: 'First task', description: 'What should I help you with first?', items: { anyOf: [{ const: 'mail', title: 'Sort my email' }, { const: 'files', title: 'Tidy my files' }] } }
      : { type: 'string', title: 'First task', description: 'What should I help you with first?', oneOf: [{ const: 'mail', title: 'Sort my email' }, { const: 'files', title: 'Tidy my files' }] },
    q0_custom: { type: 'string', title: 'First task (other)', description: 'Type your own answer' },
  },
});
const ask = (schema: unknown, message = 'Questions'): ElicitationAsk => ({ sessionId: 's', message, fields: elicitationFields(schema) });

describe('an agent’s own form as a card', () => {
  it('asks one choice as a question: an option picks it, other words are the person’s own answer', () => {
    const card = inputCard(ask(one()))!;
    expect(card).toMatchObject({ kind: 'question', question: 'What should I help you with first?', options: ['Sort my email', 'Tidy my files'] });
    if (card.kind !== 'question') throw new Error('a question');
    expect(card.read('Tidy my files')).toEqual({ q0: 'files' });
    expect(card.read(' sort my EMAIL ')).toEqual({ q0: 'mail' });
    expect(card.read('2')).toEqual({ q0: 'files' });
    expect(card.read('Plan my week')).toEqual({ q0_custom: 'Plan my week' });
    expect(card.read('  ')).toEqual({});
  });

  it('asks one line to type as a plain question, and a yes or no with those two choices', () => {
    const text = inputCard(ask({ properties: { name: { type: 'string', title: 'Name', description: 'What should I call you?' } } }))!;
    expect(text).toMatchObject({ kind: 'question', question: 'What should I call you?', options: [] });
    expect(text.kind === 'question' && text.read(' Sam ')).toEqual({ name: 'Sam' });
    const yn = inputCard(ask({ properties: { daily: { type: 'boolean', title: 'Every day?' } } }))!;
    expect(yn).toMatchObject({ kind: 'question', question: 'Every day?', options: ['Yes', 'No'] });
    expect(yn.kind === 'question' && [yn.read('Yes'), yn.read('no'), yn.read('later')]).toEqual([{ daily: true }, { daily: false }, {}]);
  });

  it('asks anything more as a form, and reads it back under the agent’s own ids and values', () => {
    const card = inputCard(ask({
      properties: {
        ...one(true).properties,
        q1: { type: 'string', title: 'Season', description: 'Which season do you like best?', oneOf: [{ const: 's', title: 'Summer' }, { const: 'w', title: 'Winter' }], default: 'w' },
        q1_custom: { type: 'string', title: 'Season (other)', description: 'Type your own answer' },
        n: { type: 'integer', title: 'How many?' },
        mail: { type: 'string', title: 'Email', format: 'email' },
      },
      required: ['n'],
    }))!;
    if (card.kind !== 'form') throw new Error('a form');
    expect(card.question).toBe('A few questions');
    expect(card.fields.map((f) => [f.id, f.type, f.label, f.required])).toEqual([
      ['f0', 'multichoice', 'First task', false], ['f1', 'text', 'First task (other)', false], ['f2', 'choice', 'Season', false],
      ['f3', 'text', 'Season (other)', false], ['f4', 'number', 'How many?', true], ['f5', 'email', 'Email', false],
    ]);
    expect(card.fields[0]).toMatchObject({ options: ['Sort my email', 'Tidy my files'], hint: 'What should I help you with first?' });
    expect(card.fields[1]).toMatchObject({ placeholder: 'Type your own answer' });
    expect(card.fields[2]).toMatchObject({ value: 'Winter' });
    expect(card.read({ f0: ['Tidy my files'], f1: 'and my desk', f2: 'Summer', f4: '3' })).toEqual({ q0: ['files'], q0_custom: 'and my desk', q1: 's', n: '3' });
    // answered in words instead (Telegram): a choice it names, else the first place to type
    expect(card.words('Sort my email')).toEqual({ q0: ['mail'] });
    expect(card.words('something else')).toEqual({ q0_custom: 'something else' });
  });

  it('has nothing to show for a form with no fields', () => {
    expect(inputCard(ask({ properties: {} }))).toBeNull();
  });
});

describe('in a chat', () => {
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
  const question = (): Extract<Part, { type: 'question' }> | undefined => lastReply()?.parts.find((p): p is Extract<Part, { type: 'question' }> => p.type === 'question');
  const text = (m: Message): string => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appubot-agent-input-'));
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
  afterAll(async () => { await core.stop(); rmSync(root, { recursive: true, force: true }); });

  /** a turn in which the agent asks with its own form, then says what it was told */
  const asking = (schema: unknown): { answers: ElicitationAnswer[] } => {
    const got: ElicitationAnswer[] = [];
    runtime.reply = async (_t, sessionId) => {
      const a = await runtime.hooks.requestInput!({ sessionId, message: 'Questions', fields: elicitationFields(schema) });
      got.push(a);
      return a.action === 'accept' ? `Got ${JSON.stringify(a.content)}` : `Not answered (${a.action})`;
    };
    return { answers: got };
  };

  it('says it takes forms, shows the agent’s question as a question card and hands the answer back', async () => {
    expect(runtime.hooks.requestInput).toBeTypeOf('function');
    const { answers } = asking(one());
    core.services.chat.send({ threadId, text: 'set yourself up', attachments: [], images: [] }, 'desktop');
    await until(() => !!question());
    expect(question()).toMatchObject({ question: 'What should I help you with first?', options: ['Sort my email', 'Tidy my files'] });
    expect(core.services.threads.require(threadId).status).toBe('waiting');
    core.services.agentBridge.answer(question()!.questionId, 'Tidy my files');
    await until(() => lastReply().status === 'complete');
    expect(answers).toEqual([{ action: 'accept', content: { q0: 'files' } }]);
    expect(question()!.answer).toBe('Tidy my files');
    expect(text(lastReply())).toContain('"q0":"files"');
  });

  it('takes words of the person’s own, and a form card’s values', async () => {
    const typed = asking(one());
    core.services.chat.send({ threadId, text: 'again', attachments: [], images: [] }, 'desktop');
    await until(() => !!question() && !question()!.answer);
    core.services.agentBridge.answer(question()!.questionId, 'Plan my week');
    await until(() => lastReply().status === 'complete');
    expect(typed.answers).toEqual([{ action: 'accept', content: { q0_custom: 'Plan my week' } }]);

    const form = asking({ properties: { ...one(true).properties, n: { type: 'integer', title: 'How many?' } } });
    core.services.chat.send({ threadId, text: 'and again', attachments: [], images: [] }, 'desktop');
    await until(() => !!question()?.form && !question()!.answer);
    expect(question()!.form!.fields.map((f) => f.type)).toEqual(['multichoice', 'text', 'number']);
    await core.services.agentBridge.answerForm({ questionId: question()!.questionId, values: { f0: ['Sort my email', 'Tidy my files'], f2: '4' } }, 'owner');
    await until(() => lastReply().status === 'complete');
    expect(form.answers).toEqual([{ action: 'accept', content: { q0: ['mail', 'files'], n: 4 } }]);
  });

  it('tells the agent when the form is turned down, and when the turn is stopped', async () => {
    const declined = asking({ properties: { a: { type: 'string', title: 'A' }, b: { type: 'string', title: 'B' } } });
    core.services.chat.send({ threadId, text: 'a form', attachments: [], images: [] }, 'desktop');
    await until(() => !!question()?.form && !question()!.answer);
    await core.services.agentBridge.answerForm({ questionId: question()!.questionId, values: {}, decline: true }, 'owner');
    await until(() => lastReply().status === 'complete');
    expect(declined.answers).toEqual([{ action: 'decline' }]);

    const stopped = asking(one());
    core.services.chat.send({ threadId, text: 'one more', attachments: [], images: [] }, 'desktop');
    await until(() => !!question() && !question()!.answer);
    await core.services.chat.cancel(threadId);
    await until(() => lastReply().status !== 'streaming');
    expect(stopped.answers).toEqual([{ action: 'cancel' }]);
    // the user did stop this one
    expect(lastReply().status).toBe('cancelled');
  });

  it('doesn’t call a turn stopped when the agent itself ended it as cancelled', async () => {
    runtime.reply = () => 'Hi! I’m ready to get to work.';
    runtime.replyEnds = 'cancelled';
    core.services.chat.send({ threadId, text: 'hello', attachments: [], images: [] }, 'desktop');
    await until(() => text(lastReply()).includes('ready') && lastReply().status !== 'streaming');
    runtime.replyEnds = 'end_turn';
    expect(lastReply()).toMatchObject({ status: 'complete', stopReason: 'cancelled' });
    expect(core.services.threads.require(threadId).status).toBe('idle');
  });
});
