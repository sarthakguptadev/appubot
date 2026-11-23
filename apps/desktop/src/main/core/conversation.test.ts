/**
 * A bot's threads, each its own agent session: a send names its thread or goes to the current one (started or sent to
 * last); a new thread starts a brand-new session that only knows the bot's memory; a thread that lost its session is
 * primed with its own turns; the thread the user leaves is asked, hidden, what to remember; a bot keeps two agents.
 * Threads older versions made ("New chat") are just threads.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { GatewayClient } from '@appubot/client';
import { ThreadSchema, currentChat, type Bot, type Message, type Thread } from '@appubot/protocol';
import { memoryTemplate } from '@appubot/chat-core';
import type { McpServerStdio, PromptBlock } from '@appubot/agent-runtime';
import { createCore, type Core } from './app';
import { FakeRuntime } from './testing/fakeRuntime';
import { silentLogger } from './util';

const WS = WebSocket as unknown as typeof globalThis.WebSocket;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let core: Core;
let runtime: FakeRuntime;
let owner: GatewayClient;
let root: string;
let bot: Bot;
let older: Thread;
let current: Thread;
let started: Thread;

function connect(token: string, id: string): Promise<GatewayClient> {
  const c = new GatewayClient({ baseUrl: `http://127.0.0.1:${core.gateway.port}`, token, device: { id, name: id, platform: 'cli' }, WebSocketImpl: WS, callTimeoutMs: 10_000 });
  return new Promise((resolve, reject) => {
    const off = c.onState((s, err) => { if (s === 'connected') { off(); resolve(c); } if (s === 'unauthorized') { off(); reject(new Error(err)); } });
    c.connect();
  });
}
/** The MCP bridge's token of the thread's latest agent session (what its tools call the gateway with). */
const agentOf = (threadId: string) =>
  connect((runtime.created.filter((c) => c.env?.APPUBOT_THREAD_ID === threadId).at(-1)!.mcpServers![0]! as McpServerStdio).env.APPUBOT_TOKEN!, `agent-${threadId}`);

const sessionOf = async (id: string) => (await owner.call('threads.get', { id })).thread.acpSessionId;
const memory = () => readFileSync(join(bot.workspace, 'MEMORY.md'), 'utf8');
const textOf = (b: PromptBlock | undefined) => (b?.type === 'text' ? b.text : '');
const texts = (ms: Message[]) => ms.map((m) => (m.parts[0]?.type === 'text' ? m.parts[0].text : ''));
const isMemorySave = (text: string) => text.includes('The user has moved on from this thread');

/** One turn through the gateway, answered by the fake agent ("Hello world … Done."): the prompt its thread's session got. */
async function turn(params: { botId?: string; threadId?: string }, text: string): Promise<{ threadId: string; blocks: PromptBlock[] }> {
  const start = runtime.prompts.length;
  // the reply may finish before the call returns: listen first
  const done = new Set<string>();
  const off = owner.on('message.completed', (p) => { done.add(p.messageId); });
  const sent = await owner.call('chat.send', { ...params, text });
  await vi.waitFor(() => expect(done.has(sent.agentMessageId)).toBe(true), { timeout: 8000 });
  off();
  const threadId = sent.userMessage.threadId;
  // a hidden turn may run in the thread just left meanwhile: pick this thread's own prompt
  const sid = await sessionOf(threadId);
  const mine = runtime.prompts.slice(start).filter((p) => p.sessionId === sid && !isMemorySave(textOf(p.blocks[0])));
  expect(mine).toHaveLength(1);
  return { threadId, blocks: mine[0]!.blocks };
}

/** A thread as older versions left it, with messages at the given times. */
function seedThread(id: string, createdAt: number, msgs: [Message['role'], number, string][], extra: Partial<Thread> = {}): Thread {
  const thread = ThreadSchema.parse({
    id, botId: bot.id, title: 'New chat', providerId: bot.providerId, cwd: bot.workspace, createdAt, updatedAt: createdAt, ...extra,
  });
  core.ctx.store.threads.put(thread);
  msgs.forEach(([role, at, text], i) => core.services.threads.addMessage({
    id: `${id}_m${i}`, threadId: id, role, parts: [{ type: 'text', text }], status: 'complete', via: 'desktop', createdAt: at, updatedAt: at,
  }));
  return thread;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-convo-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, host: '127.0.0.1', quiet: true,
    computerBackends: () => [], helperTransport: () => null,
  });
  await core.start();
  await core.services.providers.refresh();
  owner = await connect(core.ownerToken, 'convo');
  // the fake agent asks before running `ls`: say yes, as the user would
  owner.on('permission.requested', (p) => { void owner.call('permissions.respond', { id: p.id, optionId: 'allow' }); });
  bot = (await owner.call('bots.list'))[0]!;
  const now = Date.now();
  // what an existing user has: an older chat, the chat "New chat" made after it, and a Telegram chat
  older = seedThread('thr_older', now - 5 * DAY, [
    ['user', now - 5 * DAY, 'Make an invoice for Acme'],
    ['agent', now - 5 * DAY + 60_000, 'Done: INV-0042 is in your workspace.'],
    ['user', now - 4 * DAY, 'Plan a Goa trip'],
    ['agent', now - 4 * DAY + 60_000, 'Saved trips/goa.md'],
  ], { acpSessionId: 'old-session' });
  current = seedThread('thr_current', now - DAY, [
    ['user', now - DAY, 'Tidy my Desktop'],
    ['agent', now - DAY + 60_000, 'Moved 63 screenshots.'],
  ]);
  seedThread('thr_telegram', now - 2 * DAY, [['user', now - 2 * DAY, 'sent from telegram'], ['agent', now - 2 * DAY + 1, 'telegram reply']], { source: 'channel', channel: 'telegram:42' });
});

afterAll(async () => {
  owner?.close();
  await core?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('threads of a bot', () => {
  it('reads one thread a page at a time, and all of them as one history (older phones, read_bot_history)', async () => {
    const page = await owner.call('threads.history', { id: older.id, limit: 3 });
    expect(texts(page.messages)).toEqual(['Done: INV-0042 is in your workspace.', 'Plan a Goa trip', 'Saved trips/goa.md']);
    expect(page.hasMore).toBe(true);
    const first = page.messages[0]!;
    const rest = await owner.call('threads.history', { id: older.id, limit: 3, before: { id: first.id, createdAt: first.createdAt, role: first.role } });
    expect(rest).toMatchObject({ messages: [{ id: 'thr_older_m0' }], hasMore: false });

    const all = await owner.call('bots.history', { id: bot.id, limit: 4 });
    expect(texts(all.messages)).toEqual(['Plan a Goa trip', 'Saved trips/goa.md', 'Tidy my Desktop', 'Moved 63 screenshots.']);
    expect(all.hasMore).toBe(true);
    const since = await owner.call('bots.history', { id: bot.id, limit: 1, since: older.createdAt });
    expect(since.messages).toHaveLength(6);
    expect(since.messages.every((m) => m.threadId !== 'thr_telegram')).toBe(true);
  });

  it('keeps threads.create for older phones: it returns the current thread, never a new one', async () => {
    const t = await owner.call('threads.create', { botId: bot.id, title: 'A new chat please' });
    expect(t.id).toBe(current.id);
    expect((await owner.call('threads.list', { botId: bot.id })).length).toBe(3);
  });

  it('primes a thread that has no session of its own with its recent turns and the memory, never other threads', async () => {
    await owner.call('bots.memory.set', { id: bot.id, memory: `${memoryTemplate(bot.name)}- [2026-10-01] The user is Sarthak, in Bengaluru\n` });
    const { threadId, blocks } = await turn({ botId: bot.id }, 'What did we do this week?');
    expect(threadId).toBe(current.id);
    expect(blocks).toHaveLength(3);
    expect(textOf(blocks[0])).toMatch(/^<memory>\n/);
    expect(textOf(blocks[0])).toContain('- [2026-10-01] The user is Sarthak, in Bengaluru');
    const convo = textOf(blocks[1]);
    expect(convo).toContain('<conversation-so-far>');
    expect(convo).toContain('User: Tidy my Desktop');
    expect(convo).toContain(`${bot.name}: Moved 63 screenshots.`);
    // another thread's conversation is not this one's
    expect(convo).not.toContain('Make an invoice');
    expect(convo).not.toContain('telegram');
    expect(textOf(blocks[2])).toBe('What did we do this week?');
    const sid = await sessionOf(current.id);
    expect(sid && runtime.sessions.has(sid)).toBe(true);
  });

  it('sends later turns into the same session without a preface, naming the thread or not', async () => {
    const created = runtime.created.length;
    const a = await turn({ botId: bot.id }, 'thanks');
    expect(a.blocks.map(textOf)).toEqual(['thanks']);
    const b = await turn({ botId: bot.id, threadId: current.id }, 'one more thing');
    expect(b.threadId).toBe(current.id);
    expect(b.blocks.map(textOf)).toEqual(['one more thing']);
    expect(runtime.created.length).toBe(created);
    await expect(owner.call('chat.send', { botId: 'bot_other', threadId: current.id, text: 'x' })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('runs at medium reasoning effort by default; a pick in the chat becomes the bot\'s and outlives the session', async () => {
    expect(bot.effort).toBe('medium');
    expect(runtime.created.at(-1)!.effortId).toBe('medium');
    const t = (await owner.call('threads.get', { id: current.id })).thread;
    expect(t.effortId).toBe('medium');
    expect(t.efforts.map((e) => e.id)).toEqual(['low', 'medium', 'high']);

    const picked = await owner.call('threads.setEffort', { id: current.id, effortId: 'high' });
    expect(picked.effortId).toBe('high');
    expect(runtime.sessions.get(t.acpSessionId!)!.currentEffortId).toBe('high');
    expect((await owner.call('bots.list')).find((b) => b.id === bot.id)!.effort).toBe('high');

    // the bot editor (or the bot itself) changing it switches the current thread's running session
    await owner.call('bots.update', { id: bot.id, patch: { effort: 'low' } });
    await vi.waitFor(async () => expect((await owner.call('threads.get', { id: current.id })).thread.effortId).toBe('low'));
    expect(runtime.sessions.get(t.acpSessionId!)!.currentEffortId).toBe('low');

    // a restarted session starts with it
    await runtime.closeSession(t.acpSessionId!);
    await turn({ botId: bot.id }, 'how hard are you thinking?');
    expect(runtime.created.at(-1)).toMatchObject({ resumeSessionId: t.acpSessionId, effortId: 'low' });
  });

  it('quick effort picks land in the order sent, even when the agent answers the first one last', async () => {
    await turn({ botId: bot.id }, 'are you there?');
    const t = (await owner.call('threads.get', { id: current.id })).thread;
    const real = runtime.setEffort.bind(runtime);
    const slow: Array<() => void> = [];
    // the agent takes its time over 'low' and answers 'high' at once
    runtime.setEffort = async (sid, effortId) => {
      if (effortId === 'low') await new Promise<void>((r) => slow.push(r));
      return real(sid, effortId);
    };
    try {
      const first = owner.call('threads.setEffort', { id: current.id, effortId: 'low' });
      const second = owner.call('threads.setEffort', { id: current.id, effortId: 'high' });
      await vi.waitFor(() => expect(slow).toHaveLength(1));
      slow[0]!();
      expect((await first).effortId).toBe('low');
      expect((await second).effortId).toBe('high');
      expect((await owner.call('threads.get', { id: current.id })).thread.effortId).toBe('high');
      expect(runtime.sessions.get(t.acpSessionId!)!.currentEffortId).toBe('high');
      expect((await owner.call('bots.list')).find((b) => b.id === bot.id)!.effort).toBe('high');
    } finally {
      runtime.setEffort = real;
    }
  });

  it('runs with fast mode off by default; a toggle in the chat becomes the bot\'s and outlives the session', async () => {
    expect(bot.fast).toBe(false);
    expect(runtime.created.at(-1)!.fast).toBe(false);
    const t = (await owner.call('threads.get', { id: current.id })).thread;
    expect([t.fastAvailable, t.fast]).toEqual([true, false]);

    const picked = await owner.call('threads.setFast', { id: current.id, fast: true });
    expect(picked.fast).toBe(true);
    expect(runtime.sessions.get(t.acpSessionId!)!.fastEnabled).toBe(true);
    expect((await owner.call('bots.list')).find((b) => b.id === bot.id)!.fast).toBe(true);

    // the bot editor (or the bot itself) changing it switches the current thread's running session
    await owner.call('bots.update', { id: bot.id, patch: { fast: false } });
    await vi.waitFor(async () => expect((await owner.call('threads.get', { id: current.id })).thread.fast).toBe(false));
    expect(runtime.sessions.get(t.acpSessionId!)!.fastEnabled).toBe(false);

    // a model without fast mode keeps the choice without asking the agent
    await owner.call('bots.update', { id: bot.id, patch: { fast: true } });
    await vi.waitFor(async () => expect((await owner.call('threads.get', { id: current.id })).thread.fast).toBe(true));
    runtime.sessions.get(t.acpSessionId!)!.fastAvailable = false;
    expect((await owner.call('threads.setFast', { id: current.id, fast: false })).fast).toBe(false);
    expect(runtime.sessions.get(t.acpSessionId!)!.fastEnabled).toBe(true);
    runtime.sessions.get(t.acpSessionId!)!.fastAvailable = true;

    // a restarted session starts with the bot's
    await owner.call('threads.setFast', { id: current.id, fast: true });
    await runtime.closeSession(t.acpSessionId!);
    await turn({ botId: bot.id }, 'are you quick?');
    expect(runtime.created.at(-1)).toMatchObject({ resumeSessionId: t.acpSessionId, fast: true });
    expect((await owner.call('threads.get', { id: current.id })).thread.fast).toBe(true);
  });

  it('resumes the stored session after the agent exits (no preface), and primes again when resuming fails', async () => {
    const sid = (await sessionOf(current.id))!;
    // the agent process went away; ACP session/load brings the same session back
    await runtime.closeSession(sid);
    const resumed = await turn({ botId: bot.id }, 'still there?');
    expect(runtime.created.at(-1)!.resumeSessionId).toBe(sid);
    expect(resumed.blocks.map(textOf)).toEqual(['still there?']);
    expect(await sessionOf(current.id)).toBe(sid);

    // this time the agent lost it too (a new install of the CLI, a cleared cache …): a fresh session, primed
    await runtime.closeSession(sid);
    runtime.saved.delete(sid);
    const fresh = await turn({ botId: bot.id }, 'are you back?');
    expect(runtime.created.at(-1)!.resumeSessionId).toBe(sid);
    expect(await sessionOf(current.id)).not.toBe(sid);
    expect(textOf(fresh.blocks[0])).toContain('<memory>');
    const preface = textOf(fresh.blocks[1]);
    expect(preface).toContain('User: still there?');
    expect(preface).toContain(`${bot.name}: Hello world`);
    expect(textOf(fresh.blocks[2])).toBe('are you back?');
  });

  it('starts a new thread on a brand-new session: no resume, none of the earlier conversation, only the memory', async () => {
    const left = (await sessionOf(current.id))!;
    await owner.call('threads.rename', { id: current.id, title: 'Desktop cleanup' });
    const before = (await owner.call('threads.history', { id: current.id, limit: 500 })).messages.length;
    // the thread it leaves is asked, hidden, what to remember
    const asked: string[] = [];
    runtime.reply = (text) => {
      if (!isMemorySave(text)) return undefined;
      asked.push(text);
      return 'Two things:\n- Sarthak keeps receipts in ~/Receipts\n- The user is Sarthak, in Bengaluru';
    };
    const seen: string[] = [];
    const offs = [
      owner.on('message.created', (m) => { seen.push(`message:${m.threadId}`); }),
      owner.on('permission.requested', (p) => { seen.push(`permission:${p.threadId}`); }),
      owner.on('notification', (n) => { seen.push(`notification:${n.title}`); }),
    ];
    const created = runtime.created.length;

    const t = await owner.call('threads.start', { botId: bot.id });
    expect(t.id).not.toBe(current.id);
    expect(t.title).toBe('New thread');
    expect(currentChat(await owner.call('threads.list', { botId: bot.id }), bot.id)?.id).toBe(t.id);
    // its agent starts right away, fresh
    await vi.waitFor(() => expect(runtime.created.length).toBe(created + 1));
    expect(runtime.created.at(-1)!.env).toMatchObject({ APPUBOT_THREAD_ID: t.id });
    expect(runtime.created.at(-1)!.resumeSessionId).toBeUndefined();

    // what the left thread lists lands in the memory, once; nothing of that turn shows anywhere
    await vi.waitFor(() => expect(memory()).toContain('- Sarthak keeps receipts in ~/Receipts'.slice(2)));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('The user is Sarthak, in Bengaluru');
    expect(memory().match(/The user is Sarthak, in Bengaluru/g)).toHaveLength(1);
    expect(runtime.prompts.filter((p) => isMemorySave(textOf(p.blocks[0]))).map((p) => p.sessionId)).toEqual([left]);
    expect((await owner.call('threads.history', { id: current.id, limit: 500 })).messages).toHaveLength(before);
    expect((await owner.call('threads.get', { id: current.id })).thread).toMatchObject({ title: 'Desktop cleanup', status: 'idle' });
    expect(seen).toEqual([]);
    for (const off of offs) off();
    runtime.reply = null;

    // starting again before saying anything gives the same thread
    expect((await owner.call('threads.start', { botId: bot.id })).id).toBe(t.id);
    // its first turn: the session started for it, the memory (with what was just saved) and the message, nothing else
    const r = await turn({ botId: bot.id }, 'hi, new thread');
    expect(r.threadId).toBe(t.id);
    expect(runtime.created.length).toBe(created + 1);
    expect(r.blocks).toHaveLength(2);
    expect(textOf(r.blocks[0])).toContain('Sarthak keeps receipts in ~/Receipts');
    expect(r.blocks.map(textOf).join('\n')).not.toMatch(/conversation-so-far|Tidy my Desktop|Make an invoice/);
    expect(textOf(r.blocks[1])).toBe('hi, new thread');
    started = (await owner.call('threads.get', { id: t.id })).thread;
  });

  it('continues an older thread when a send names it, and makes it current; the left one may only touch its memory', async () => {
    // the thread left behind (the one just started) is asked what to remember: its tools are off but for its memory,
    // and what it tries anyway is refused without asking the user
    const tried: unknown[] = [];
    runtime.reply = async (text) => {
      if (!isMemorySave(text)) return undefined;
      const agent = await agentOf(started.id);
      tried.push(await agent.call('agent.notify', { title: 'Hi', body: '' }).then(() => 'sent', (e: { code?: string }) => e.code));
      tried.push((await agent.call('agent.remember', { text: 'Ships invoices on Fridays' })).added);
      agent.close();
      return undefined;
    };
    const asked: string[] = [];
    const offAsk = owner.on('permission.requested', (p) => { asked.push(p.threadId); });

    const r = await turn({ botId: bot.id, threadId: older.id }, 'back to the invoices');
    expect(r.threadId).toBe(older.id);
    // its stored session (an older version's) is gone: a fresh one, primed with this thread's own turns
    expect(runtime.created.filter((c) => c.env?.APPUBOT_THREAD_ID === older.id).at(-1)!.resumeSessionId).toBe('old-session');
    const convo = r.blocks.map(textOf).find((x) => x.includes('<conversation-so-far>'))!;
    expect(convo).toContain('User: Make an invoice for Acme');
    expect(convo).not.toMatch(/Tidy my Desktop|hi, new thread/);
    // it is current now: turns that name no thread go there, a routine's too
    const list = await owner.call('threads.list', { botId: bot.id });
    expect(currentChat(list, bot.id)?.id).toBe(older.id);
    expect(list.find((x) => x.id === older.id)!.lastActiveAt).toBeGreaterThan(started.lastActiveAt!);
    const r2 = await turn({ botId: bot.id }, 'and one more');
    expect(r2.threadId).toBe(older.id);
    expect(r2.blocks.map(textOf)).toEqual(['and one more']);
    const routine = await owner.call('routines.create', { botId: bot.id, name: 'Morning', prompt: 'Morning summary', schedule: '0 9 * * *', enabled: false });
    const ran = new Promise<void>((resolve) => { const off = owner.on('message.completed', (m) => { if (m.threadId === older.id) { off(); resolve(); } }); });
    expect((await owner.call('routines.runNow', { id: routine.id })).id).toBe(older.id);
    await ran;

    await vi.waitFor(() => expect(tried).toEqual(['forbidden', true]));
    await vi.waitFor(() => expect(core.services.chat.isHiddenTurn(started.id)).toBe(false));
    expect(memory()).toContain('Ships invoices on Fridays');
    expect(asked).not.toContain(started.id);
    expect((await owner.call('threads.history', { id: started.id, limit: 50 })).messages).toHaveLength(2);
    offAsk();
    runtime.reply = null;
  });

  it('keeps the agents of a bot\'s two latest threads and lets older idle ones go; a message there resumes it', async () => {
    const sid = (await sessionOf(current.id))!;
    await vi.waitFor(() => expect(runtime.sessions.has(sid)).toBe(false));
    expect(await sessionOf(current.id)).toBe(sid);
    expect(runtime.sessions.has((await sessionOf(started.id))!)).toBe(true);
    expect(runtime.sessions.has((await sessionOf(older.id))!)).toBe(true);

    const r = await turn({ botId: bot.id, threadId: current.id }, 'remember me?');
    expect(runtime.created.at(-1)!.resumeSessionId).toBe(sid);
    expect(r.blocks.map(textOf)).toEqual(['remember me?']);
    // now the thread before last goes (once the one just left has said what to remember)
    const startedSid = (await sessionOf(started.id))!;
    await vi.waitFor(() => expect(runtime.sessions.has(startedSid)).toBe(false));
    await vi.waitFor(() => expect(core.services.chat.isHiddenTurn(older.id)).toBe(false));
  });

  it('continues each thread on another provider with a fresh session, primed with the memory and its own turns', async () => {
    await owner.call('bots.update', { id: bot.id, patch: { providerId: 'codex' } });
    await vi.waitFor(async () => {
      const t = (await owner.call('threads.get', { id: current.id })).thread;
      expect(t.providerId).toBe('codex');
      expect(t.acpSessionId).toBeUndefined();
    });
    const r = await turn({ botId: bot.id }, 'hello codex');
    expect(r.threadId).toBe(current.id);
    expect(runtime.created.at(-1)).toMatchObject({ providerId: 'codex' });
    expect(runtime.created.at(-1)!.resumeSessionId).toBeUndefined();
    expect(textOf(r.blocks[0])).toContain('<memory>');
    expect(textOf(r.blocks[1])).toContain('User: remember me?');
    expect(textOf(r.blocks[1])).not.toContain('Make an invoice');
    expect(textOf(r.blocks[2])).toBe('hello codex');
  });

  it('keeps Telegram chats separate', async () => {
    const r = await turn({ threadId: 'thr_telegram' }, 'from telegram again');
    expect(r.threadId).toBe('thr_telegram');
    // its own fresh session, primed with that chat only
    const preface = r.blocks.map(textOf).find((x) => x.includes('<conversation-so-far>'))!;
    expect(preface).toContain('User: sent from telegram');
    expect(preface).not.toContain('Make an invoice');
    // and it never becomes the bot's current thread
    expect(currentChat(await owner.call('threads.list', { botId: bot.id }), bot.id)?.id).toBe(current.id);
  });
});

describe('a bot\'s memory', () => {
  it('gives the bot its memory tools: remember (dated, once, short), update_memory, forget, read_memory', async () => {
    const agent = await agentOf(current.id);
    expect(await agent.call('agent.remember', { text: 'Prefers  short\nanswers' })).toMatchObject({ ok: true, added: true });
    expect(memory()).toMatch(/- \[\d{4}-\d{2}-\d{2}\] Prefers short answers\n$/);
    expect((await agent.call('agent.remember', { text: 'prefers short answers.' })).added).toBe(false);
    await expect(agent.call('agent.remember', { text: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(agent.call('agent.remember', { text: '  ' })).rejects.toMatchObject({ code: 'invalid_params' });

    const u = await agent.call('agent.memory.update', { find: 'short answers', text: 'Prefers bullet points' });
    expect(u.removed).toMatch(/Prefers short answers$/);
    expect(u.added).toMatch(/^- \[\d{4}-\d{2}-\d{2}\] Prefers bullet points$/);
    expect(memory()).not.toContain('short answers');
    // several entries match: it says which, so the bot can quote more
    await expect(agent.call('agent.memory.update', { find: 'Sarthak', text: 'x' })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('Sarthak keeps receipts') });
    expect((await agent.call('agent.memory.update', { find: 'bullet points', text: '' })).added).toBeUndefined();
    expect(memory()).not.toContain('bullet points');

    const f = await agent.call('agent.memory.forget', { text: 'receipts' });
    expect(f.removed).toEqual([expect.stringContaining('Sarthak keeps receipts in ~/Receipts')]);
    await expect(agent.call('agent.memory.forget', { text: 'nothing like this' })).rejects.toMatchObject({ code: 'invalid_params' });
    const read = await agent.call('agent.memory.read', {});
    expect(read).toMatchObject({ memory: memory(), chars: memory().length, path: join(bot.workspace, 'MEMORY.md') });
    await expect(owner.call('agent.memory.read', {})).rejects.toMatchObject({ code: 'forbidden' });
    agent.close();
  });

  it('never restarts a running session for a memory edit; a new thread starts with it, or without it once cleared', async () => {
    const created = runtime.created.length;
    await owner.call('bots.memory.set', { id: bot.id, memory: `${memory()}- [2026-10-15] Edited by hand\n` });
    const r = await turn({ botId: bot.id }, 'still the same session?');
    expect(runtime.created.length).toBe(created);
    expect(r.blocks.map(textOf)).toEqual(['still the same session?']);

    const t = await owner.call('threads.start', { botId: bot.id });
    const withMemory = await turn({ botId: bot.id, threadId: t.id }, 'what do you know?');
    expect(textOf(withMemory.blocks[0])).toContain('Edited by hand');

    await owner.call('bots.memory.set', { id: bot.id, memory: '  \n' });
    expect(memory()).toBe(memoryTemplate(bot.name));
    const t2 = await owner.call('threads.start', { botId: bot.id });
    const blank = await turn({ botId: bot.id, threadId: t2.id }, 'fresh start');
    expect(blank.blocks.map(textOf)).toEqual(['fresh start']);
  });

  it('is never written over by the generator: a missing file is made, the user\'s own stays', () => {
    const path = join(bot.workspace, 'MEMORY.md');
    writeFileSync(path, '# Mine\n- keep this\n');
    core.services.bots.ensureDefault();
    core.services.bots.update(bot.id, { job: 'Keeps the books' });
    core.services.bots.scaffold(core.services.bots.require(bot.id), true);
    expect(readFileSync(path, 'utf8')).toBe('# Mine\n- keep this\n');
    const claude = readFileSync(join(bot.workspace, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('Keeps the books');
    expect(claude).toContain('## Memory and threads');
    expect(claude).toContain('`update_memory`');
    rmSync(path);
    core.services.bots.scaffold(core.services.bots.require(bot.id), false);
    expect(readFileSync(path, 'utf8')).toBe(memoryTemplate(bot.name));
  });
});
