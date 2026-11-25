/**
 * Batches on AppuBot Connect's route: a phone that reads them gets a streaming reply in a few frames per second instead
 * of one per event (every frame is a relay message), with no more delay than the window, while answers, urgent events
 * and live pictures don't wait; older phones and other routes get every frame as before; a resume replays across
 * batches with the same seqs. `APPUBOT_BENCH=1` prints the measurements.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { GatewayClient, type WebSocketLike } from '@appubot/client';
import { BATCH_FEATURE, CONNECT_PEER_HEADER, PROTOCOL_VERSION, type Bot, type Thread } from '@appubot/protocol';
import { createCore, type Core } from './app';
import { BATCH_WINDOW_MS } from './gateway';
import type { Watcher } from './services/liveView';
import { FakeRuntime } from './testing/fakeRuntime';
import { silentLogger } from './util';

type Rec = Record<string, unknown>;
const WINDOW = BATCH_WINDOW_MS.connect!;
const BENCH = process.env.APPUBOT_BENCH === '1';

let core: Core;
let runtime: FakeRuntime;
let root: string;
let base: string;
let bot: Bot;
let thread: Thread;
/** a paired phone's token (the owner's counts only from this computer) */
let token: string;
const phones: Phone[] = [];

/**
 * A phone's gateway socket, read raw: every WebSocket frame it gets (what the relay would carry), and the frames inside
 * them (`items`, a batch unpacked), each with when it arrived.
 */
class Phone {
  frames: { at: number; raw: string }[] = [];
  items: { at: number; f: Rec; frame: number }[] = [];
  hello!: Rec;
  private waiters: (() => void)[] = [];
  private constructor(readonly ws: WebSocket) {}

  /** `connect`: through AppuBot Connect (as its channel replays a phone on this computer); `features`: what it reads */
  static open(o: { connect?: boolean; features?: string[]; lastSeq?: number; bootId?: string } = {}): Promise<Phone> {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, o.connect ? { headers: { [CONNECT_PEER_HEADER]: '203.0.113.7' } } : {});
    const p = new Phone(ws);
    phones.push(p);
    return new Promise((resolve, reject) => {
      ws.on('error', reject);
      ws.on('open', () => ws.send(JSON.stringify({
        type: 'connect', protocolVersion: PROTOCOL_VERSION, token, device: { id: 'phone-1', name: 'Phone', platform: 'ios' },
        ...(o.features ? { features: o.features } : {}), ...(o.lastSeq !== undefined ? { lastSeq: o.lastSeq, bootId: o.bootId } : {}),
      })));
      ws.on('message', (d) => {
        const at = performance.now();
        const raw = String(d);
        p.frames.push({ at, raw });
        const f = JSON.parse(raw) as Rec;
        if (f.type === 'hello') { p.hello = f; resolve(p); return; }
        for (const item of f.type === 'batch' ? (f.items as Rec[]) : [f]) p.items.push({ at, f: item, frame: p.frames.length - 1 });
        for (const w of p.waiters.splice(0)) w();
      });
    });
  }

  get batches(): number { return this.frames.filter((x) => x.raw.startsWith('{"type":"batch"')).length; }
  get lastSeq(): number { return Math.max(Number(this.hello.seq), ...this.sequenced().map((e) => Number(e.f.seq))); }
  /** the events of the stream a resume continues (live pictures and their state carry no seq) */
  sequenced(): { at: number; f: Rec; frame: number }[] { return this.events().filter((x) => typeof x.f.seq === 'number'); }
  events(name?: string): { at: number; f: Rec; frame: number }[] { return this.items.filter((x) => x.f.type === 'event' && (!name || x.f.event === name)); }

  async until(test: () => boolean, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!test()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 20); });
    }
  }

  /** A request, answered: the answer and the round trip. */
  async req(method: string, params: Rec = {}): Promise<{ res: Rec; ms: number }> {
    const id = `r${Math.random().toString(36).slice(2)}`;
    const t0 = performance.now();
    this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    await this.until(() => this.items.some((x) => x.f.type === 'res' && x.f.id === id), 5000);
    const got = this.items.find((x) => x.f.type === 'res' && x.f.id === id)!;
    return { res: got.f, ms: got.at - t0 };
  }

  close(): void { try { this.ws.close(); } catch { /* ignore */ } }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : NaN; };
const r1 = (n: number) => Math.round(n * 10) / 10;
/** the message's text as the phone put it together from its deltas */
const textOf = (p: Phone, messageId: string) => p.events('message.delta').filter((x) => (x.f.payload as Rec).messageId === messageId).map((x) => (x.f.payload as Rec).delta).join('');
const seqsRise = (p: Phone) => p.sequenced().every((x, i, all) => i === 0 || Number(x.f.seq) > Number(all[i - 1]!.f.seq));
/** events carried by the frames `from` ≤ i < `to` */
const eventsIn = (p: Phone, from: number, to: number) => p.events().filter((x) => x.frame >= from && x.frame < to).length;
const conns = () => [...(core.gateway as unknown as { conns: Set<{ route: string; outbox?: unknown; watcher: Watcher }> }).conns];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-gw-batch-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, host: '127.0.0.1', quiet: true,
    computerBackends: () => [], helperTransport: () => null,
  });
  await core.start();
  // AppuBot Connect is up (no relay here: its phones are replayed on loopback with the header, as the channel does)
  vi.spyOn(core.services.connect, 'active').mockReturnValue(true);
  base = `http://127.0.0.1:${core.gateway.port}`;
  bot = core.services.bots.create({ name: 'Streamer', providerId: 'claude-code' } as Parameters<typeof core.services.bots.create>[0]);
  thread = core.services.threads.chatFor(bot.id);
  const { code } = core.ctx.auth.startPairing(120);
  const [status, out] = await core.services.devices.pair({ code, device: { id: 'phone-1', name: 'Phone', platform: 'ios' } }, '203.0.113.7', undefined, 'connect');
  expect(status).toBe(200);
  token = (out as { token: string }).token;
});

afterAll(async () => {
  for (const p of phones) p.close();
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

/** A slow turn on the bot's thread (the fake agent holds it open): its session and agent message. */
async function startTurn(p: Phone): Promise<{ sid: string; messageId: string }> {
  const before = runtime.prompts.length;
  const { res } = await p.req('chat.send', { threadId: thread.id, text: 'slow please' });
  const messageId = String((res.result as Rec).agentMessageId);
  await p.until(() => runtime.prompts.length > before);
  return { sid: runtime.prompts.at(-1)!.sessionId, messageId };
}

describe('a streaming reply over AppuBot Connect', () => {
  it('reaches a phone that reads batches in several times fewer frames, no later than the window, everything in order', async () => {
    const legacy = await Phone.open({ connect: true });
    const batched = await Phone.open({ connect: true, features: [BATCH_FEATURE] });
    const local = await Phone.open({ features: [BATCH_FEATURE] });
    expect(batched.hello.features).toContain(BATCH_FEATURE);
    const { sid, messageId } = await startTurn(legacy);
    await sleep(WINDOW * 2);

    // a reply streaming at an agent's pace (a few tokens every 8 ms), the context ring and a tool step moving with it
    const sentAt = new Map<number, number>();
    let n = 0;
    let used = 10_000;
    const op = runtime.hooks.onTurnOp.bind(runtime.hooks, sid);
    const stream = async (ms: number, tick?: () => void) => {
      const end = performance.now() + ms;
      let k = 0;
      while (performance.now() < end) {
        sentAt.set(n, performance.now());
        op({ op: 'delta', partIndex: 1, partType: 'text', delta: `t${n};` });
        n += 1;
        k += 1;
        if (k % 30 === 0) op({ op: 'usage', used: (used += 2_000), size: 200_000 });
        if (k % 60 === 0) op({ op: 'part', partIndex: 2, part: { type: 'tool_call', toolCallId: 'tool', title: `Step ${k}`, kind: 'read', status: 'in_progress', content: [], locations: [] } });
        tick?.();
        await sleep(8);
      }
    };
    const mark = () => ({ legacy: legacy.frames.length, batched: batched.frames.length, local: local.frames.length, t: performance.now() });

    // 1. streaming alone: frames per second, and how long each token took to arrive
    const a = mark();
    await stream(2_000);
    await sleep(WINDOW + 60);
    const b = mark();
    const secs = (b.t - a.t) / 1000;
    const rate = { legacy: (b.legacy - a.legacy) / secs, batched: (b.batched - a.batched) / secs, local: (b.local - a.local) / secs };
    const latency = (p: Phone) => {
      const out: number[] = [];
      for (const x of p.events('message.delta')) {
        for (const m of String((x.f.payload as Rec).delta).matchAll(/t(\d+);/g)) {
          const at = sentAt.get(Number(m[1]));
          if (at !== undefined) out.push(x.at - at);
        }
      }
      return out;
    };
    const lat = { legacy: latency(legacy), batched: latency(batched) };
    expect(lat.batched.length).toBe(n);
    // fewer frames, by the rule that holds on any machine: the older phone gets a frame per event, the batching one a
    // frame per window at most (a timer never fires early). How many times fewer that comes to depends on how late this
    // machine's timers fire (each one about 15 ms late and it drops under 3 times), so that is a measurement, printed
    // with APPUBOT_BENCH=1, not a check
    expect(eventsIn(legacy, a.legacy, b.legacy)).toBe(b.legacy - a.legacy);
    expect(b.batched - a.batched).toBeLessThanOrEqual(Math.ceil((b.t - a.t) / WINDOW) + 1);
    expect(b.batched - a.batched).toBeLessThan(b.legacy - a.legacy);
    // what batching adds is the window at most (timers on a busy test machine get some slack at the tail)
    expect(pct(lat.batched, 50) - pct(lat.legacy, 50)).toBeLessThanOrEqual(WINDOW);
    expect(pct(lat.batched, 99) - pct(lat.legacy, 99)).toBeLessThanOrEqual(WINDOW + 40);

    // 2. while it streams: answers come as fast as before, live pictures at once
    const pings: Record<'legacy' | 'batched', number[]> = { legacy: [], batched: [] };
    const live: number[] = [];
    const watcher = conns().find((c) => c.route === 'connect' && c.outbox)!.watcher;
    let k = 0;
    let busy = Promise.resolve();
    await stream(1_000, () => {
      if (++k % 12 !== 0) return;
      busy = busy.then(async () => {
        const [l, bt] = await Promise.all([legacy.req('system.ping'), batched.req('system.ping')]);
        pings.legacy.push(l.ms);
        pings.batched.push(bt.ms);
      });
      const t0 = performance.now();
      const seen = batched.items.length;
      watcher.send('computer.liveState', { blocked: null });
      void batched.until(() => batched.items.slice(seen).some((x) => x.f.event === 'computer.liveState')).then(() => {
        const got = batched.items.slice(seen).find((x) => x.f.event === 'computer.liveState')!;
        // never inside a batch: it went on its own, past whatever waited
        expect(batched.frames[got.frame]!.raw.startsWith('{"type":"event"')).toBe(true);
        live.push(got.at - t0);
      });
    });
    await busy;
    await sleep(WINDOW + 60);
    expect(pct(pings.batched, 50)).toBeLessThanOrEqual(pct(pings.legacy, 50) + 15);
    expect(pct(pings.batched, 99)).toBeLessThan(WINDOW);
    expect(pct(live, 99)).toBeLessThan(WINDOW / 2);

    await legacy.req('chat.cancel', { threadId: thread.id });
    await legacy.until(() => legacy.events('message.completed').length > 0 && batched.events('message.completed').length > 0);
    const want = Array.from({ length: n }, (_, i) => `t${i};`).join('');
    // the same reply, in the same order, with rising seqs, whichever way it came
    expect(textOf(legacy, messageId).endsWith(want)).toBe(true);
    expect(textOf(batched, messageId)).toBe(textOf(legacy, messageId));
    expect(textOf(local, messageId)).toBe(textOf(legacy, messageId));
    for (const p of [legacy, batched, local]) expect(seqsRise(p)).toBe(true);
    expect(batched.lastSeq).toBe(legacy.lastSeq);
    // only the Connect phone that reads batches got any (this Mac's own route and an older phone get every frame)
    expect(batched.batches).toBeGreaterThan(0);
    expect(legacy.batches).toBe(0);
    expect(local.batches).toBe(0);

    if (BENCH) {
      console.info([
        `streaming ${r1(n / ((sentAt.get(n - 1)! - sentAt.get(0)!) / 1000))} tokens/s for ${r1(secs)} s (bus coalesces 30 ms, Connect window ${WINDOW} ms)`,
        `frames/s to the phone: older phone ${r1(rate.legacy)}, batching phone ${r1(rate.batched)} (${r1(rate.legacy / rate.batched)}x fewer), this Mac's route ${r1(rate.local)}`,
        `events in that time: older phone ${eventsIn(legacy, a.legacy, b.legacy)}, batching phone ${eventsIn(batched, a.batched, b.batched)} (deltas merged)`,
        `token latency p50/p99 ms: older ${r1(pct(lat.legacy, 50))}/${r1(pct(lat.legacy, 99))}, batching ${r1(pct(lat.batched, 50))}/${r1(pct(lat.batched, 99))}`,
        `ping while streaming p50/p99 ms: older ${r1(pct(pings.legacy, 50))}/${r1(pct(pings.legacy, 99))}, batching ${r1(pct(pings.batched, 50))}/${r1(pct(pings.batched, 99))}`,
        `live picture while a batch waits p50/p99 ms: ${r1(pct(live, 50))}/${r1(pct(live, 99))}`,
      ].join('\n'));
    }
    for (const p of [legacy, batched, local]) p.close();
  }, 20_000);
});

describe('what never waits for the window', () => {
  /** a delta of a message nobody stores (the bus stamps no rev on it), straight on the bus */
  const delta = (messageId: string, text: string) => core.ctx.bus.emit('message.delta', { threadId: thread.id, messageId, partIndex: 0, partType: 'text', delta: text });

  it('an answer goes with the events before it, in order, at once', async () => {
    const p = await Phone.open({ connect: true, features: [BATCH_FEATURE] });
    await sleep(WINDOW + 20);
    delta('m-answer', 'first');
    await p.until(() => textOf(p, 'm-answer') === 'first');
    // the next one waits for the window: an answer takes it along
    delta('m-answer', ' second');
    core.ctx.bus.flush();
    const { res, ms } = await p.req('system.ping');
    expect(res.ok).toBe(true);
    expect(ms).toBeLessThan(WINDOW / 2);
    const last = p.frames.at(-1)!.raw;
    const items = (JSON.parse(last) as { items: Rec[] }).items;
    expect(items.map((x) => x.type)).toEqual(['event', 'res']);
    expect(textOf(p, 'm-answer')).toBe('first second');
    p.close();
  });

  it('a permission request goes at once, after what waited', async () => {
    const p = await Phone.open({ connect: true, features: [BATCH_FEATURE] });
    await sleep(WINDOW + 20);
    delta('m-ask', 'a');
    await p.until(() => textOf(p, 'm-ask') === 'a');
    delta('m-ask', 'b');
    core.ctx.bus.flush();
    const t0 = performance.now();
    core.ctx.bus.emit('permission.requested', {
      id: 'perm-1', threadId: thread.id, botId: bot.id, title: 'Run ls', kind: 'execute', content: [],
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }], createdAt: Date.now(),
    });
    await p.until(() => p.events('permission.requested').length > 0);
    expect(p.events('permission.requested')[0]!.at - t0).toBeLessThan(WINDOW / 2);
    const names = p.events().slice(-2).map((x) => x.f.event);
    expect(names).toEqual(['message.delta', 'permission.requested']);
    expect(textOf(p, 'm-ask')).toBe('ab');
    p.close();
  });

  it('requests a client sends together are answered together on Connect, one by one elsewhere', async () => {
    const batch = JSON.stringify({ type: 'batch', items: ['a', 'b', 'c'].map((id) => ({ type: 'req', id, method: 'system.ping', params: {} })) });
    const onConnect = await Phone.open({ connect: true, features: [BATCH_FEATURE] });
    const here = await Phone.open({ features: [BATCH_FEATURE] });
    for (const p of [onConnect, here]) {
      p.ws.send(batch);
      await p.until(() => p.items.filter((x) => x.f.type === 'res').length === 3);
      expect(p.items.filter((x) => x.f.type === 'res').map((x) => x.f.id)).toEqual(['a', 'b', 'c']);
      // the frames the answers came in: an event that happens to arrive meanwhile (the other phone coming online) is
      // a frame of its own on every route, and says nothing about how the answers were sent
      expect(new Set(p.items.filter((x) => x.f.type === 'res').map((x) => x.frame)).size).toBe(p === onConnect ? 1 : 3);
    }
    for (const p of [onConnect, here]) p.close();
  });

  it('a batch is sent once it is big, so one stays within a channel chunk', async () => {
    const p = await Phone.open({ connect: true, features: [BATCH_FEATURE] });
    await sleep(WINDOW + 20);
    const before = p.frames.length;
    // separate messages: nothing merges
    for (let i = 0; i < 30; i++) delta(`m-big-${i}`, 'x'.repeat(8_000));
    core.ctx.bus.flush();
    await p.until(() => p.events('message.delta').filter((x) => String((x.f.payload as Rec).messageId).startsWith('m-big-')).length === 30);
    const sent = p.frames.slice(before);
    expect(sent.length).toBeGreaterThan(1);
    for (const f of sent) expect(f.raw.length).toBeLessThan(128 * 1024 + 8_500);
    expect(seqsRise(p)).toBe(true);
    p.close();
  });
});

describe('the app’s own client on Connect', () => {
  it('reads the batches it is sent, and sends the calls it makes together as one', async () => {
    let socket: WebSocket | null = null;
    const up: string[] = [];
    let down = 0;
    const c = new GatewayClient({
      baseUrl: base, token, device: { id: 'phone-1', name: 'Phone', platform: 'ios' }, callTimeoutMs: 5_000,
      openSocket: (url) => {
        const ws = new WebSocket(url, { headers: { [CONNECT_PEER_HEADER]: '203.0.113.7' } });
        const send = ws.send.bind(ws);
        ws.send = ((d: string) => { up.push(String(d)); send(d); }) as typeof ws.send;
        ws.on('message', () => { down += 1; });
        socket = ws;
        return ws as unknown as WebSocketLike;
      },
    });
    await new Promise<void>((resolve) => { const off = c.onState((st) => { if (st === 'connected') { off(); resolve(); } }); c.connect(); });
    expect(c.serverFeatures).toContain(BATCH_FEATURE);
    const text: string[] = [];
    c.on('message.delta', (d) => { if (d.messageId === 'm-client') text.push(d.delta); });
    await sleep(WINDOW + 20);
    const before = { up: up.length, down, seq: c.lastSeq };
    for (let i = 0; i < 10; i++) {
      core.ctx.bus.emit('message.delta', { threadId: thread.id, messageId: 'm-client', partIndex: 0, partType: 'text', delta: `${i},` });
      await sleep(15);
    }
    const [ping, bots, threads] = await Promise.all([c.call('system.ping'), c.call('bots.list'), c.call('threads.list')]);
    expect(ping).toBeTruthy();
    expect(bots.some((b) => b.id === bot.id)).toBe(true);
    expect(threads.length).toBeGreaterThan(0);
    // three calls, one frame up; the deltas before them and the three answers, a few frames down
    expect(up.length - before.up).toBe(1);
    expect(JSON.parse(up.at(-1)!).items).toHaveLength(3);
    expect(down - before.down).toBeLessThanOrEqual(4);
    expect(text.join('')).toBe('0,1,2,3,4,5,6,7,8,9,');
    expect(c.lastSeq).toBeGreaterThan(before.seq);
    c.close();
    expect(socket).not.toBeNull();
  });
});

describe('resuming', () => {
  it('replays what was missed packed into a batch, with the same seqs and text as an older phone gets', async () => {
    const first = await Phone.open({ connect: true, features: [BATCH_FEATURE] });
    await sleep(WINDOW + 20);
    const delta = (text: string) => core.ctx.bus.emit('message.delta', { threadId: thread.id, messageId: 'm-resume', partIndex: 0, partType: 'text', delta: text });
    delta('one ');
    await first.until(() => textOf(first, 'm-resume') === 'one ');
    const since = first.lastSeq;
    const bootId = String(first.hello.bootId);
    first.close();
    await sleep(20);

    // missed meanwhile: a reply going on, the chat renamed in the middle of it
    for (const w of ['two ', 'three ']) { delta(w); await sleep(40); }
    core.services.threads.rename(thread.id, 'Missed rename');
    for (const w of ['four ', 'five']) { delta(w); await sleep(40); }
    core.ctx.bus.flush();
    const missed = core.ctx.bus.since(since)!;
    expect(missed.length).toBeGreaterThanOrEqual(5);

    const upTo = missed.at(-1)!.seq;
    const older = await Phone.open({ connect: true, lastSeq: since, bootId });
    const again = await Phone.open({ connect: true, features: [BATCH_FEATURE], lastSeq: since, bootId });
    await again.until(() => again.lastSeq === core.ctx.bus.seq && older.lastSeq === core.ctx.bus.seq);
    expect(again.hello.gap).toBeUndefined();
    // (what happened since, the phones coming online, comes after it)
    const replayed = (p: Phone) => p.events().filter((x) => Number(x.f.seq) <= upTo);
    // the older phone: one frame per missed event; the newer one: all of it in one, deltas merged between the renames
    expect(new Set(replayed(older).map((x) => x.frame)).size).toBe(missed.length);
    expect(new Set(replayed(again).map((x) => x.frame)).size).toBe(1);
    expect(replayed(again).length).toBeLessThan(missed.length);
    expect(textOf(again, 'm-resume')).toBe('two three four five');
    expect(textOf(older, 'm-resume')).toBe(textOf(again, 'm-resume'));
    expect(again.events('thread.updated').length).toBe(older.events('thread.updated').length);
    expect(seqsRise(again)).toBe(true);
    expect(replayed(again).at(-1)!.f.seq).toBe(upTo);
    const seqs = new Set(missed.map((e) => e.seq));
    for (const e of replayed(again)) expect(seqs.has(Number(e.f.seq))).toBe(true);

    // from where the batch left it, nothing more is missing
    const lastSeq = again.lastSeq;
    again.close();
    const caughtUp = await Phone.open({ connect: true, features: [BATCH_FEATURE], lastSeq, bootId });
    await sleep(WINDOW);
    expect(caughtUp.events().filter((x) => Number(x.f.seq) <= lastSeq)).toHaveLength(0);
    expect(caughtUp.hello.gap).toBeUndefined();
    for (const p of [older, caughtUp]) p.close();
  });
});
