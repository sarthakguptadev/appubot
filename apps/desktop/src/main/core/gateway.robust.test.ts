/**
 * The gateway as seen by a phone on a poor link: a resume after a restart or a long gap, a chat opened while a reply
 * streams, and what a web page in the user's browser can (not) do with it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { GatewayClient } from '@appubot/client';
import { PROTOCOL_VERSION, type Bot, type Thread } from '@appubot/protocol';
import type { McpServerStdio } from '@appubot/agent-runtime';
import { createCore, type Core } from './app';
import { corsOrigin, hostAllowed } from './gateway';
import { FakeRuntime } from './testing/fakeRuntime';
import { silentLogger } from './util';

const WS = WebSocket as unknown as typeof globalThis.WebSocket;
let core: Core;
let runtime: FakeRuntime;
let root: string;
let base: string;
let bot: Bot;
let thread: Thread;
const clients: GatewayClient[] = [];

function client(): GatewayClient {
  const c = new GatewayClient({ baseUrl: base, token: core.ownerToken, device: { id: 'phone', name: 'phone', platform: 'cli' }, WebSocketImpl: WS, callTimeoutMs: 10_000 });
  clients.push(c);
  return c;
}

function connected(c: GatewayClient): Promise<void> {
  return new Promise((resolve) => {
    const off = c.onState((s) => { if (s === 'connected') { off(); resolve(); } });
    c.connect();
  });
}

/** A raw socket's frames until `done` says so (the hello and what follows it). */
function rawSession(connect: Record<string, unknown>, done: (frames: Record<string, unknown>[]) => boolean, ms = 3000): Promise<Record<string, unknown>[]> {
  const frames: Record<string, unknown>[] = [];
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.close(); reject(new Error('timed out')); }, ms);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'connect', protocolVersion: PROTOCOL_VERSION, token: core.ownerToken, device: { id: 'raw', name: 'raw', platform: 'cli' }, ...connect })));
    ws.on('message', (d) => {
      frames.push(JSON.parse(String(d)));
      if (done(frames)) { clearTimeout(t); ws.close(); resolve(frames); }
    });
  });
}

/** An HTTP request with headers fetch won't let a test set (Host, Origin). */
function raw(path: string, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-gw-robust-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, host: '127.0.0.1', quiet: true,
    computerBackends: () => [], helperTransport: () => null,
  });
  await core.start();
  base = `http://127.0.0.1:${core.gateway.port}`;
  bot = core.services.bots.create({ name: 'Streamer', providerId: 'claude-code' } as Parameters<typeof core.services.bots.create>[0]);
  thread = core.services.threads.chatFor(bot.id);
});

afterAll(async () => {
  for (const c of clients) c.close();
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('resuming', () => {
  it('replays within a run, and says `gap` for a lastSeq from another run or past what it kept', async () => {
    const c = client();
    await connected(c);
    const bootId = c.bootId!;
    expect(bootId).toBeTruthy();
    const since = c.lastSeq;
    await c.call('threads.rename', { id: thread.id, title: 'Replayed' });
    const replay = await rawSession({ lastSeq: since, bootId }, (f) => f.some((x) => x.type === 'event' && x.event === 'thread.updated'));
    expect(replay[0]).toMatchObject({ type: 'hello', ok: true, bootId });
    expect(replay[0]!.gap).toBeUndefined();

    // the phone's count is from before AppuBot restarted: no replay, and the hello says so
    const restarted = await rawSession({ lastSeq: since, bootId: 'an-earlier-run' }, (f) => f.length >= 1);
    expect(restarted[0]).toMatchObject({ type: 'hello', ok: true, gap: true });
    // an older phone that sends no bootId, with a count past this run's
    const ahead = await rawSession({ lastSeq: 1_000_000 }, (f) => f.length >= 1);
    expect(ahead[0]).toMatchObject({ gap: true });
    // a first connect resumes nothing, so there's no gap to report
    const fresh = await rawSession({}, (f) => f.length >= 1);
    expect(fresh[0]!.gap).toBeUndefined();
  });
});

describe('opening a chat while a reply streams', () => {
  it('answers threads.history only after the deltas it already holds, each stamped with the message’s revision', async () => {
    const c = client();
    await connected(c);
    const sent = await c.call('chat.send', { threadId: thread.id, text: 'slow please' });
    await vi.waitFor(() => expect(runtime.prompts.at(-1)?.blocks.some((b) => b.type === 'text' && b.text.includes('slow please'))).toBe(true));
    const sid = runtime.prompts.at(-1)!.sessionId;
    await vi.waitFor(() => expect(core.services.threads.findMessage(thread.id, sent.agentMessageId)).toBeTruthy());

    const log: string[] = [];
    let lastRev = 0;
    c.on('message.delta', (d) => { if (d.messageId === sent.agentMessageId && d.partType === 'text') { log.push(`delta:${d.delta}`); lastRev = d.rev ?? 0; } });
    // a word arrives (held a moment to coalesce), and the phone opens the chat that same moment
    runtime.hooks.onTurnOp(sid, { op: 'delta', partIndex: 1, partType: 'text', delta: 'Alpha' });
    const page = await c.call('threads.history', { id: thread.id, limit: 20 });
    log.push('history');
    const agent = page.messages.find((m) => m.id === sent.agentMessageId)!;
    const text = agent.parts.filter((p) => p.type === 'text').map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(text).toBe('Alpha');
    // the delta came first: a phone that applied it and then merges the page has it once
    expect(log).toEqual(['delta:Alpha', 'history']);
    expect(agent.rev).toBeGreaterThanOrEqual(lastRev);
    // what streams after the page is newer than it
    const next = new Promise<number>((resolve) => c.on('message.delta', (d) => { if (d.delta === 'Beta') resolve(d.rev ?? 0); }));
    runtime.hooks.onTurnOp(sid, { op: 'delta', partIndex: 1, partType: 'text', delta: 'Beta' });
    expect(await next).toBeGreaterThan(agent.rev!);
    await c.call('chat.cancel', { threadId: thread.id });
  });
});

describe('what a web page can reach', () => {
  it('refuses Host names a page could point at this computer (DNS rebinding), on HTTP and the WebSocket', async () => {
    expect((await raw('/api/health', { host: 'attacker.example' })).status).toBe(403);
    expect((await raw('/api/health', { host: `127.0.0.1:${core.gateway.port}` })).status).toBe(200);
    const upgrade = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { host: 'attacker.example' } });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => { ws.close(); resolve(101); });
      ws.on('error', () => resolve(-1));
    });
    expect(upgrade).toBe(403);
    expect(hostAllowed('100.91.1.2:7890')).toBe(true);
    expect(hostAllowed('[fd7a:115c:a1e0::1]:7890')).toBe(true);
    expect(hostAllowed('my-mac.tail1234.ts.net')).toBe(true);
    expect(hostAllowed('localhost:7890')).toBe(true);
    expect(hostAllowed('macbook.local')).toBe(true);
    expect(hostAllowed('evil.com')).toBe(false);
    expect(hostAllowed('ts.net.evil.com:7890')).toBe(false);
    expect(hostAllowed(undefined)).toBe(false);
  });

  it('gives CORS answers to the app’s own pages only, and none for health', async () => {
    const health = await raw('/api/health', { origin: 'https://attacker.example' });
    expect(health.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await raw('/api/files', { origin: 'https://attacker.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' }, 'OPTIONS');
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    const app = await raw('/api/files', { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' }, 'OPTIONS');
    expect(app.headers['access-control-allow-origin']).toBe('null');
    expect(corsOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(corsOrigin('http://localhost.attacker.example')).toBeNull();
  });

  it('serves files to the app and devices, never to a bot’s token', async () => {
    const att = core.services.files.upload(new TextEncoder().encode('secret'), 'note.txt', 'text/plain', thread.id);
    expect((await fetch(`${base}${att.url}?token=${core.ownerToken}`)).status).toBe(200);
    // any thread's agent token (the warm session made one)
    core.services.chat.warm(bot.id, thread.id, { session: true });
    await vi.waitFor(() => expect(runtime.created.some((o) => o.env?.APPUBOT_BOT_ID === bot.id)).toBe(true));
    const agentToken = (runtime.created.filter((o) => o.env?.APPUBOT_BOT_ID === bot.id).at(-1)!.mcpServers![0]! as McpServerStdio).env.APPUBOT_TOKEN!;
    expect((await fetch(`${base}${att.url}?token=${agentToken}`)).status).toBe(403);
  });

  it('takes only a small frame before a socket has signed in, and big ones after', async () => {
    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
      ws.on('open', () => ws.send('x'.repeat(200 * 1024)));
      ws.on('close', (code) => resolve(code));
    });
    expect(closed).toBe(1009);

    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const frames: Record<string, unknown>[] = [];
    await new Promise<void>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'connect', protocolVersion: PROTOCOL_VERSION, token: core.ownerToken, device: { id: 'big', name: 'big', platform: 'cli' } })));
      ws.on('message', (d) => {
        frames.push(JSON.parse(String(d)));
        if (frames.length === 1) ws.send(JSON.stringify({ type: 'req', id: 'r1', method: 'system.ping', params: { pad: 'x'.repeat(1024 * 1024) } }));
        if (frames.some((f) => f.type === 'res' && f.id === 'r1')) resolve();
      });
    });
    expect(frames.find((f) => f.type === 'res')).toMatchObject({ ok: true });
    ws.close();
  });

  it('closes a socket that never says who it is', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
      await new Promise<void>((r) => ws.on('open', () => r()));
      const closed = new Promise<void>((r) => ws.on('close', () => r()));
      await vi.advanceTimersByTimeAsync(6_000);
      await closed;
    } finally {
      vi.useRealTimers();
    }
  });
});
