/**
 * Hand-offs in a bot's chat: "@Ledger check this invoice" in the user's chat with Ada goes to Ledger (a turn in its own
 * chat, with the chat's latest messages), its answer comes back into Ada's chat as Ledger's message, and Ada reads it
 * with its next prompt; a reply of Ada's naming Ledger hands off too, and Ledger's answer sends Ada on; bots handing
 * each other messages stop at HANDOFF_HOPS_MAX.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HANDOFF_HOPS_MAX, type Bot, type Message } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

let core: Core;
let root: string;
let runtime: FakeRuntime;
let ada: Bot, ledger: Bot, cy: Bot;
/** what each bot answers, by the words it gets */
let says: Record<'Ada' | 'Ledger' | 'Cy', (text: string) => string>;
/** every prompt each bot got, in order */
let heard: Record<'Ada' | 'Ledger' | 'Cy', string[]>;

const until = async (ok: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!ok()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const msgs = (threadId: string): Message[] => core.services.threads.messages(threadId);
const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
const answers = (threadId: string) => msgs(threadId).filter((m) => m.role === 'agent' && m.from && m.status === 'complete');
const idle = (threadId: string) => !core.services.chat.hasWork(threadId) && !msgs(threadId).some((m) => m.status === 'streaming');
const send = (threadId: string, text: string) => core.services.chat.send({ threadId, text, attachments: [], images: [] }, 'desktop');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-handoff-'));
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
  ledger = core.services.bots.create({ name: 'Ledger', providerId: ada.providerId, computerUse: false });
  cy = core.services.bots.create({ name: 'Cy', providerId: ada.providerId, computerUse: false });
  runtime.reply = (text) => {
    const who = /named you \(@(\w+)\)/.exec(text)?.[1] as 'Ledger' | 'Cy' | undefined;
    // every prompt but a hand-off is Ada's in these tests (only Ada's chats are written in)
    const bot = who ?? 'Ada';
    heard[bot].push(text);
    return says[bot](text);
  };
});
afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

let chat: string;
beforeEach(async () => {
  says = { Ada: () => 'Ada here.', Ledger: () => 'Ledger here.', Cy: () => 'Cy here.' };
  heard = { Ada: [], Ledger: [], Cy: [] };
  // a new chat with Ada, its opening line said
  chat = core.services.chat.startThread(ada.id).id;
  if (msgs(chat).some((m) => m.role === 'user')) chat = core.services.chat.startThread(ada.id).id;
  await until(() => idle(chat));
  heard.Ada = [];
});

describe('hand-off in a bot’s chat', () => {
  it('passes a message naming another bot to it, with the chat’s latest messages, and posts its answer as its own', async () => {
    says.Ada = () => 'Want me to file it?';
    send(chat, 'I got an invoice from Acme for $420');
    await until(() => idle(chat));
    says.Ledger = () => 'It charges VAT twice: $70 too much.';
    const r = send(chat, '@Ledger check this invoice');
    // the answer's message is in the chat at once, streaming in Ledger's name: the chat's working row
    const placeholder = msgs(chat).find((m) => m.id === r.agentMessageId)!;
    expect(placeholder).toMatchObject({ role: 'agent', from: { botId: ledger.id, name: 'Ledger' } });
    await until(() => answers(chat).length === 1);
    const answer = answers(chat)[0]!;
    expect(answer.id).toBe(r.agentMessageId);
    expect(textOf(answer)).toBe('It charges VAT twice: $70 too much.');
    // Ada never took the message; Ledger got it with where it came from and the chat so far
    expect(heard.Ada).toHaveLength(1);
    expect(heard.Ledger).toHaveLength(1);
    const prompt = heard.Ledger[0]!;
    expect(prompt).toContain('The user named you (@Ledger) in their chat with Ada');
    expect(prompt).toContain('- The user: I got an invoice from Acme for $420\n- Ada: Want me to file it?');
    expect(prompt).toContain('The user wrote:\n@Ledger check this invoice');
    // it ran in Ledger's own chat, as the user's message there (not cutting into anything)
    const ledgerChat = core.services.threads.chatFor(ledger.id).id;
    expect(msgs(ledgerChat).find((m) => m.role === 'user' && textOf(m) === '@Ledger check this invoice')).toMatchObject({ via: 'desktop' });
    expect(core.services.threads.require(ledgerChat).botId).toBe(ledger.id);

    // Ada reads the exchange with the user's next message
    send(chat, 'Thanks, so what do I pay?');
    await until(() => heard.Ada.length === 2 && idle(chat));
    expect(heard.Ada[1]).toContain('- The user: @Ledger check this invoice\n- Ledger: It charges VAT twice: $70 too much.');
    expect(heard.Ada[1]).not.toContain('I got an invoice from Acme');
    // and only once: the message after doesn't repeat it
    send(chat, 'ok');
    await until(() => heard.Ada.length === 3 && idle(chat));
    expect(heard.Ada[2]).not.toContain('Ledger:');
  });

  it('changes nothing for a message that names no other bot', async () => {
    send(chat, 'Hello @Ada, how are you? mail me at x@ledger.com');
    await until(() => heard.Ada.length === 1 && idle(chat));
    expect(heard.Ledger).toHaveLength(0);
    expect(msgs(chat).some((m) => m.from)).toBe(false);
  });

  it('asks the chat’s own bot too when the message names it as well', async () => {
    send(chat, '@Ada and @Ledger, both of you: hi');
    await until(() => answers(chat).length === 1 && heard.Ada.length === 1 && idle(chat));
    // the words passed to Ledger name Ada too, but they are Ledger's to answer, not handed on again
    expect(heard.Ledger).toHaveLength(1);
    expect(heard.Ada[0]).toContain('@Ada and @Ledger, both of you: hi');
    expect(heard.Ada[0]).not.toContain('named you');
    expect(heard.Ledger).toHaveLength(1);
  });

  it('hands off from a bot’s reply, and the answer sends the bot that asked on', async () => {
    says.Ada = (t) => (t.includes('Ledger answered in this chat') ? 'All set: you owe $350.' : '@Ledger can you total the Acme invoice?');
    says.Ledger = () => 'Total: $350.';
    send(chat, 'Sort out the Acme invoice');
    await until(() => heard.Ada.length === 2 && idle(chat));
    expect(heard.Ledger[0]).toContain('Ada named you (@Ledger) in its chat with the user');
    expect(heard.Ledger[0]).toContain('Ada wrote:\n@Ledger can you total the Acme invoice?');
    // Ada carries on with Ledger's answer in front of it
    expect(heard.Ada[1]).toContain('- Ledger: Total: $350.');
    const chatMsgs = msgs(chat).filter((m) => m.role === 'agent' && textOf(m));
    expect(chatMsgs.map((m) => [m.from?.name ?? 'Ada', textOf(m)])).toEqual([
      ['Ada', '@Ledger can you total the Acme invoice?'],
      ['Ledger', 'Total: $350.'],
      ['Ada', 'All set: you owe $350.'],
    ]);
    // Ledger's chat shows it came from Ada
    const ledgerChat = core.services.threads.chatFor(ledger.id).id;
    expect(msgs(ledgerChat).filter((m) => m.role === 'user').at(-1)).toMatchObject({ via: 'bot', from: { botId: ada.id, name: 'Ada' } });
  });

  it('passes an answer naming a third bot on to it, and stops bots handing back and forth at the cap', async () => {
    says.Ledger = () => '@Cy over to you';
    says.Cy = () => 'Cy did it.';
    send(chat, '@Ledger start this');
    await until(() => answers(chat).length === 2 && idle(chat));
    expect(answers(chat).map((m) => m.from?.name)).toEqual(['Ledger', 'Cy']);
    expect(heard.Cy[0]).toContain('Ledger named you (@Cy) in its chat with the user');
    // Cy was asked by Ledger, not Ada: its plain answer sends nobody on
    expect(heard.Ada).toHaveLength(0);

    // Ada and Ledger hand it to each other forever: the hand-offs stop after HANDOFF_HOPS_MAX bot messages
    says.Ada = () => '@Ledger your turn';
    says.Ledger = () => '@Ada your turn';
    const before = msgs(chat).length;
    send(chat, 'go');
    await until(() => msgs(chat).some((m) => m.parts.some((p) => p.type === 'system' && p.text.startsWith('Paused'))), 10_000);
    await until(() => idle(chat));
    const bots = msgs(chat).slice(before).filter((m) => m.role === 'agent' && textOf(m));
    expect(bots).toHaveLength(HANDOFF_HOPS_MAX);
    expect(bots.map((m) => m.from?.name ?? 'Ada')).toEqual(Array.from({ length: HANDOFF_HOPS_MAX }, (_, i) => (i % 2 ? 'Ledger' : 'Ada')));
  });

  it('reads a stopped hand-off as stopped', async () => {
    send(chat, '@Ledger slow work please');
    const ledgerChat = core.services.threads.chatFor(ledger.id).id;
    await until(() => core.services.chat.isBusy(ledgerChat));
    await core.services.chat.cancel(ledgerChat);
    await until(() => idle(chat));
    expect(msgs(chat).filter((m) => m.from).at(-1)).toMatchObject({ status: 'cancelled', parts: [] });
  });
});
