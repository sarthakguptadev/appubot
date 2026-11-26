/**
 * A reply's follow-ups block never leaves the computer as text. A turn that ends in a block goes down every road a
 * reply takes out of the core here (another window or a phone through the gateway, Telegram in text and as a voice
 * note, a notification on this computer and on a phone, a group's room, a bot that asked another one, a hand-off in a
 * chat, the files it is kept in), and none of them carries the tags or the block's lines.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { GatewayClient } from '@appubot/client';
import type { Bot, GroupMessage, Message } from '@appubot/protocol';
import type { TurnOp } from '@appubot/agent-runtime';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

/** lines no test, instruction or fixture says anywhere else: wherever one turns up, the block got there */
const LINES = ['Send it to Priya', 'Trim it to five lines'];
const BLOCK = `\n\n<followups>\n${LINES.join('\n')}\n</followups>\n`;
const TAG = /<\/?follow/i;
const LINE = new RegExp(LINES.join('|'));
/** neither the tags nor the lines are anywhere in it */
const clean = (what: unknown): void => {
  const s = typeof what === 'string' ? what : JSON.stringify(what);
  expect(s).not.toMatch(TAG);
  expect(s).not.toMatch(LINE);
};
/** the same, with the one place the lines belong (a message's or a completion's `followUps`) set aside */
const cleanButForPills = (what: unknown): void => clean((typeof what === 'string' ? what : JSON.stringify(what)).replace(/"followUps":\s*\[[^\]]*\]/g, ''));

let core: Core;
let runtime: FakeRuntime;
let root: string;
let ada: Bot, bo: Bot, cy: Bot;
/** what the agent answers a prompt with; `undefined` leaves the fake agent's own script */
let says: (prompt: string, sessionId: string) => string | undefined = () => 'Okay.';
/** every frame the gateway sent a client, as it came over the socket */
const frames: string[] = [];
/** every notification handed to the OS, and to the phones */
const native: string[] = [];
const bus: { event: string; payload: unknown }[] = [];

class Tapped extends WebSocket {
  constructor(...a: ConstructorParameters<typeof WebSocket>) {
    super(...a);
    this.on('message', (d) => frames.push(String(d)));
  }
}
const clients: GatewayClient[] = [];
function connect(id: string): Promise<GatewayClient> {
  const c = new GatewayClient({ baseUrl: `http://127.0.0.1:${core.gateway.port}`, token: core.ownerToken, device: { id, name: id, platform: 'cli' }, WebSocketImpl: Tapped as unknown as typeof globalThis.WebSocket, callTimeoutMs: 10_000 });
  clients.push(c);
  return new Promise((resolve, reject) => {
    const off = c.onState((s, err) => {
      if (s === 'connected') { off(); resolve(c); }
      if (s === 'unauthorized') { off(); reject(new Error(String(err))); }
    });
    c.connect();
  });
}

const until = async (ok: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!ok()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const msgs = (threadId: string): Message[] => core.services.threads.messages(threadId, { limit: 100 });
const textOf = (m: Message | undefined): string => (m?.parts ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('|');
const idle = (threadId: string) => !core.services.chat.hasWork(threadId) && !msgs(threadId).some((m) => m.status === 'streaming');
const ctxOf = (b: Bot) => ({ botId: b.id, threadId: core.services.threads.chatFor(b.id).id });
/** the reply in pieces of three characters, so the tag arrives a few letters at a time */
const pieces = (sid: string, text: string): string => {
  for (let i = 0; i < text.length; i += 3) runtime.hooks.onTurnOp(sid, { op: 'delta', partIndex: 0, partType: 'text', delta: text.slice(i, i + 3) } satisfies TurnOp);
  return '';
};
/** one message to a bot's chat, answered; the reply as the computer keeps it */
async function ask(bot: Bot, text: string, via: 'desktop' | 'channel' = 'desktop', before?: (agentMessageId: string, threadId: string) => void): Promise<Message> {
  const threadId = core.services.threads.chatFor(bot.id).id;
  const { agentMessageId } = core.services.chat.send({ threadId, text, attachments: [], images: [] }, via);
  before?.(agentMessageId, threadId);
  await until(() => msgs(threadId).some((m) => m.id === agentMessageId && m.status === 'complete') && idle(threadId));
  return msgs(threadId).find((m) => m.id === agentMessageId)!;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-followups-paths-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined,
    nativeNotify: (title, body) => { native.push(`${title}: ${body}`); },
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, host: '127.0.0.1', quiet: true,
    computerBackends: () => [], helperTransport: () => null,
  });
  await core.start();
  await core.services.providers.refresh();
  core.ctx.bus.on((e) => { bus.push(e as { event: string; payload: unknown }); });
  ada = core.services.bots.update(core.services.bots.list()[0]!.id, { name: 'Ada', chief: true });
  bo = core.services.bots.create({ name: 'Bo', providerId: ada.providerId, computerUse: false });
  cy = core.services.bots.create({ name: 'Cy', providerId: ada.providerId, computerUse: false });
  runtime.reply = (text, sid) => says(text, sid);
});

afterAll(async () => {
  for (const c of clients) c.close();
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('a reply that ends in a follow-ups block', () => {
  it('reaches another window and a phone without it: as it streams, when it ends, and when they load the chat', async () => {
    const [here, phone] = [await connect('this-window'), await connect('a-phone')];
    const threadId = core.services.threads.chatFor(ada.id).id;
    const deltas: string[] = [];
    phone.on('message.delta', (d) => { if (d.threadId === threadId && d.partType === 'text') deltas.push(d.delta); });
    const completed = new Promise<{ messageId: string; followUps?: string[] }>((resolve) => { phone.on('message.completed', (p) => { if (p.threadId === threadId) resolve(p); }); });
    says = (_t, sid) => pieces(sid, `The summary is in summary.md.${BLOCK}`);
    const sent = await here.call('chat.send', { threadId, text: 'summarise the report' });
    const done = await completed;
    await until(() => idle(threadId));
    expect(done.messageId).toBe(sent.agentMessageId);
    expect(done.followUps).toEqual(LINES);
    expect(deltas.join('')).toBe('The summary is in summary.md.');
    const loaded = (await phone.call('threads.messages', { id: threadId })).find((m) => m.id === sent.agentMessageId)!;
    expect(textOf(loaded)).toBe('The summary is in summary.md.');
    expect(loaded.followUps).toEqual(LINES);
    await phone.call('threads.list', {});
    // every frame both of them were sent: the turn's events and the answers to their calls
    expect(frames.some((f) => f.includes('message.delta'))).toBe(true);
    expect(frames.some((f) => f.includes(LINES[0]!))).toBe(true);
    for (const f of frames) cleanButForPills(f);
  });

  it('goes to Telegram without it, in text and read aloud', async () => {
    const channelId = core.services.channels.add({ botId: bo.id }).id;
    const sent: unknown[][] = [];
    const api = {
      sendMessage: async (chat: string, text: string, o?: { parse_mode?: string }) => { sent.push(['message', chat, text, o?.parse_mode]); return { message_id: 1 }; },
      sendVoice: async (chat: string, f: { filename?: string }) => { sent.push(['voice', chat, f.filename]); return {}; },
      sendChatAction: async () => true,
    };
    const runner = (core.services.channels as unknown as { runner(id: string): Record<string, unknown> }).runner(channelId);
    Object.assign(runner, { tg: { api }, tgId: 7 });
    const services = core.services as unknown as { voice: unknown };
    const realVoice = services.voice;
    const speakForMessage = vi.fn(async () => ({ audio: new Uint8Array([0x4f, 0x67, 0x67, 0x53]), mimeType: 'audio/ogg', durationMs: 900, language: 'en', file: {} }));
    services.voice = { ready: () => true, hears: () => true, speakForMessage };
    const v = core.services.settings.get().voice;
    core.services.settings.update({ voice: { ...v, telegramVoiceReplies: true } });
    try {
      says = (_t, sid) => pieces(sid, `**Two** meetings today.${BLOCK}`);
      const reply = await ask(bo, 'what is on my calendar today', 'channel', (id, threadId) => core.services.channels.trackTurn(id, { runnerId: channelId, chatId: '5', threadId, replyTo: 9, voice: true }));
      await until(() => sent.some((x) => x[0] === 'message'));
      expect(sent).toEqual([['voice', '5', 'reply.ogg'], ['message', '5', '<b>Two</b> meetings today.', 'HTML']]);
      expect(speakForMessage).toHaveBeenCalledTimes(1);
      const spoken = (speakForMessage.mock.calls[0] as unknown as [string, string, { text: string }])[2].text;
      expect(spoken).toMatch(/^(\*\*)?Two(\*\*)? meetings today\.$/);
      clean([sent, speakForMessage.mock.calls]);
      expect(reply.followUps).toEqual(LINES);
    } finally {
      services.voice = realVoice;
      Object.assign(runner, { tg: null, tgId: null });
    }
  });

  it('is announced without it: the notification here, the one pushed to phones, and the chat’s preview', async () => {
    const notify = vi.spyOn(core.services.notifications, 'notify');
    const pushed = vi.spyOn(core.services.push, 'notice');
    native.length = 0;
    try {
      says = (_t, sid) => pieces(sid, `The summary is in summary.md.${BLOCK}`);
      const reply = await ask(cy, 'summarise the report');
      expect(reply.followUps).toEqual(LINES);
      await until(() => notify.mock.calls.length > 0);
      expect(notify.mock.calls.at(-1)![0]).toMatchObject({ title: 'Cy', body: 'The summary is in summary.md.', push: { kind: 'done', text: 'The summary is in summary.md.' } });
      expect(pushed.mock.calls.at(-1)![0]).toMatchObject({ kind: 'done', botName: 'Cy', text: 'The summary is in summary.md.' });
      expect(native).toEqual(['Cy: The summary is in summary.md.']);
      expect(core.services.threads.require(reply.threadId).lastMessagePreview).toBe('The summary is in summary.md.');
      clean([notify.mock.calls, pushed.mock.calls, native]);
    } finally {
      notify.mockRestore();
      pushed.mockRestore();
    }
  });

  it('is posted to a group’s room without it, and handed to the lead without it', async () => {
    const notify = vi.spyOn(core.services.notifications, 'notify');
    const room = (id: string): GroupMessage[] => core.services.groups.history(id).messages;
    const g = core.services.groups.create({ name: 'Launch', botIds: [ada.id, bo.id, cy.id] });
    const script: Record<string, (t: string) => string> = {
      Ada: (t) => (t.includes('The user wrote') ? `@Bo write the email.${BLOCK}` : t.includes('Email written') ? `All done: email written.${BLOCK}` : 'NO_REPLY'),
      Bo: () => `Email written.${BLOCK}`,
    };
    const from = runtime.prompts.length;
    says = (t) => { const who = /you \((\w+)\)/.exec(t)?.[1]; return who ? script[who]?.(t) ?? 'NO_REPLY' : 'Okay.'; };
    try {
      core.services.groups.send({ id: g.id, text: 'Plan the launch', limit: undefined } as never);
      await until(() => room(g.id).some((x) => x.text.startsWith('All done')));
      expect(room(g.id).map((x) => `${x.from.kind === 'user' ? 'You' : x.from.name}: ${x.text}`)).toEqual(['You: Plan the launch', 'Ada: @Bo write the email.', 'Bo: Email written.', 'Ada: All done: email written.']);
      // what the lead was given of Bo's reply: a message in its thread for the group, and the prompt of its next turn
      const leads = core.services.threads.list({ limit: 1000 }).find((t) => t.botId === ada.id && t.source === 'group' && t.groupId === g.id)!;
      expect(msgs(leads.id).filter((m) => m.role === 'user').map(textOf)).toEqual(['Plan the launch', 'Email written.']);
      const given = runtime.prompts.slice(from).map((p) => p.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'));
      expect(given.filter((t) => t.includes('Email written.'))).toHaveLength(1);
      clean([room(g.id), given, notify.mock.calls]);
      cleanButForPills(msgs(leads.id));
    } finally {
      notify.mockRestore();
    }
  });

  it('comes back to a bot that asked another one without it, alone or with every bot asked at once', async () => {
    says = (t) => (t.includes('A message from the bot') ? `Four.${BLOCK}` : 'Okay.');
    const one = await core.services.agentBridge.messageBot(ctxOf(ada), { bot: 'Bo', text: 'What is 2+2?', wait: true });
    expect(one.reply).toBe('Four.');
    const all = await core.services.agentBridge.broadcast(ctxOf(ada), { text: 'What is 2+2?', wait: true });
    expect(all.replies.map((r) => [r.bot.name, r.reply]).sort()).toEqual([['Bo', 'Four.'], ['Cy', 'Four.']]);
    // and when a bot reads another bot's chat
    const history = core.services.agentBridge.botHistory(ctxOf(ada), bo.id, undefined, 50);
    expect(history.messages.some((m) => m.text.includes('Four.'))).toBe(true);
    clean([one, all, history]);
  });

  it('is handed into a chat that named another bot without it, and read by the chat’s own bot without it', async () => {
    const chat = core.services.chat.startThread(ada.id).id;
    await until(() => idle(chat));
    const heard: string[] = [];
    says = (t) => {
      if (t.includes('named you (@Bo)')) return `It charges VAT twice.${BLOCK}`;
      heard.push(t);
      return `Noted.${BLOCK}`;
    };
    const r = core.services.chat.send({ threadId: chat, text: '@Bo check this invoice', attachments: [], images: [] }, 'desktop');
    await until(() => msgs(chat).some((m) => m.id === r.agentMessageId && m.status === 'complete') && idle(chat));
    const answer = msgs(chat).find((m) => m.id === r.agentMessageId)!;
    expect(answer.from).toMatchObject({ botId: bo.id });
    expect(textOf(answer)).toBe('It charges VAT twice.');
    // the chat's own bot reads the exchange with the user's next message
    heard.length = 0;
    const next = core.services.chat.send({ threadId: chat, text: 'thanks, pay the right amount', attachments: [], images: [] }, 'desktop');
    await until(() => msgs(chat).some((m) => m.id === next.agentMessageId && m.status === 'complete') && idle(chat));
    expect(heard.join('\n')).toContain('It charges VAT twice.');
    clean(heard);
    cleanButForPills(msgs(chat));
  });

  it('left the tags nowhere: not in an event, a prompt to an agent, or a file the computer keeps', async () => {
    for (const e of bus) cleanButForPills(e);
    // every prompt of every turn above: an agent is never handed another one's block
    clean(runtime.prompts.map((p) => p.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : []))));
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p]; });
    const kept = files(join(root, 'data'));
    expect(kept.some((p) => readFileSync(p, 'utf8').includes(LINES[0]!))).toBe(true);
    for (const p of kept) cleanButForPills(readFileSync(p, 'utf8'));
  });
});
