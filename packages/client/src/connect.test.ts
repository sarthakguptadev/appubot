import { afterEach, describe, expect, test, vi } from 'vitest';
import * as protocol from '@appubot/protocol';
import {
  CHANNEL_ACK_EVERY, CHANNEL_CHUNK, CHANNEL_FRAME_MAX, CHANNEL_VERSION, CHANNEL_WINDOW, Msg, SecureChannel, acceptHello,
  ackPayload, bytesText, channelCipher, chunks, createEphemeralKeypair, jsonBytes, parseAck, parseJsonBytes, setChannelCipher, textBytes,
  type HttpRequestHead, type MsgKind, type WsCloseInfo, type WsOpenHead,
} from '@appubot/protocol';
import {
  CLOUD_READY_TIMEOUT_MS, GatewayClient, GatewayError, RELAY_BUSY_MESSAGE, RelaySession, checkHealth, cloudDirectUrl, closeRelaySessions, directSession, directUrl, isCloudUrl, multipartBody, pathOfUrl,
  probeHosts, relayFetch, relaySession, uploadBytes, uploadStream, type BodySource, type RelayTransport,
} from './index';
import { asyncCipher } from './testing/asyncCipher';

const ROOM = 'abcdefghijklmnopqrstuvwxyz';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * An in-memory relay plus the Mac behind it: the phone's transport gets the relay's text answer, its binary goes to
 * the Mac, and the Mac (SecureChannel, mac side) answers HTTP requests and gateway sockets like the real one.
 */
interface MacPlan {
  /** the relay's answer to the join */
  join?: 'ready' | 'no_host' | 'rate_limited' | 'relay_full' | 'relay_busy';
  /** someone else answers the hello: their X25519 key isn't the one the phone pinned */
  impostor?: boolean;
  /** a Mac on another channel version: it answers the hello with its version byte alone */
  version?: number;
  /** never answer the hello */
  silent?: boolean;
  /** never answer requests (they stay pending) */
  hang?: boolean;
  /** never acknowledge request bodies (HTTP_ACK) */
  noAck?: boolean;
  /** the relay loses this (1-based) message from the Mac */
  loseFromMac?: number;
  /** the relay flips a bit in this (1-based) message from the Mac */
  tamperFromMac?: number;
  /** the Mac's own socket on the Wi-Fi: it only opens, no relay says anything */
  direct?: boolean;
  /** nothing answers at that address (the socket never opens) */
  unreachable?: boolean;
}

function world(plan: MacPlan = {}) {
  const mac = createEphemeralKeypair();
  const answering = plan.impostor ? createEphemeralKeypair() : mac;
  const transports: FakeTransport[] = [];
  const seen = {
    requests: [] as { head: HttpRequestHead; body: Uint8Array; chunks: number }[],
    wsText: [] as string[],
    /** request body bytes the Mac had when each one arrived, and the phone's acks and cancels */
    bodyBytes: 0,
    acks: [] as number[],
    cancels: [] as number[],
    /** the size of every binary message either way */
    frames: [] as number[],
  };

  class FakeTransport implements RelayTransport {
    binaryType = 'blob';
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    private channel: SecureChannel | null = null;
    private bodies = new Map<number, { head: HttpRequestHead; parts: Uint8Array[]; size: number; acked: number }>();
    private pieces = new Map<number, Uint8Array[]>();
    private fromMacCount = 0;
    constructor(readonly url: string) {
      transports.push(this);
      setTimeout(() => {
        if (plan.unreachable) return;
        this.readyState = 1;
        this.onopen?.({});
        if (plan.direct) return;
        const join = plan.join ?? 'ready';
        if (join === 'ready') this.onmessage?.({ data: JSON.stringify({ t: 'ready' }) });
        else if (join === 'no_host') { this.onmessage?.({ data: JSON.stringify({ t: 'no_host' }) }); this.drop(4005, 'join_refused'); }
        else { this.onmessage?.({ data: JSON.stringify({ t: 'error', reason: join }) }); this.drop(4005, 'join_refused'); }
      }, 0);
    }
    send(data: string | ArrayBufferLike | ArrayBufferView): void {
      if (this.readyState !== 1) throw new Error('not open');
      const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data as ArrayBuffer);
      seen.frames.push(bytes.length);
      setTimeout(() => this.toMac(bytes), 0);
    }
    close(): void { this.drop(1000, ''); }
    /** the relay drops the stream (the Mac left, the network went) */
    drop(code: number, reason: string) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setTimeout(() => this.onclose?.({ code, reason }), 0);
    }
    fromMac(kind: MsgKind, id: number, payload?: Uint8Array) {
      if (this.readyState !== 1) return;
      this.raw(this.channel!.seal(kind, id, payload));
    }
    private raw(sealed: Uint8Array) {
      seen.frames.push(sealed.length);
      if (++this.fromMacCount === plan.loseFromMac) return;
      if (this.fromMacCount === plan.tamperFromMac) sealed[sealed.length - 1]! ^= 1;
      // the relay delivers ArrayBuffers, as React Native's WebSocket does with binaryType 'arraybuffer'
      setTimeout(() => this.onmessage?.({ data: sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength) }), 0);
    }
    private toMac(bytes: Uint8Array) {
      if (!this.channel) {
        if (plan.version) { this.raw(Uint8Array.of(plan.version)); this.drop(1000, ''); return; }
        const accepted = acceptHello({ xSecret: answering.secret, xPublic: answering.public }, bytes);
        if (!accepted) throw new Error('first message must be the hello');
        this.channel = accepted.channel;
        if (!plan.silent) this.raw(accepted.reply);
        return;
      }
      const m = this.channel.open(bytes);
      if (!m) throw new Error('the Mac could not open a phone message');
      switch (m.kind) {
        case Msg.HTTP_REQ: this.bodies.set(m.id, { head: parseJsonBytes<HttpRequestHead>(m.payload)!, parts: [], size: 0, acked: 0 }); break;
        case Msg.HTTP_REQ_BODY: {
          const r = this.bodies.get(m.id)!;
          r.parts.push(m.payload.slice());
          r.size += m.payload.length;
          seen.bodyBytes += m.payload.length;
          if (!plan.noAck && r.size - r.acked >= CHANNEL_ACK_EVERY) { r.acked = r.size; this.fromMac(Msg.HTTP_ACK, m.id, ackPayload(r.size)); }
          break;
        }
        case Msg.HTTP_ACK: seen.acks.push(parseAck(m.payload)!); break;
        case Msg.HTTP_CANCEL: seen.cancels.push(m.id); this.bodies.delete(m.id); break;
        case Msg.HTTP_REQ_END: {
          const r = this.bodies.get(m.id)!;
          this.bodies.delete(m.id);
          const body = new Uint8Array(r.parts.reduce((n, p) => n + p.length, 0));
          let at = 0;
          for (const p of r.parts) { body.set(p, at); at += p.length; }
          seen.requests.push({ head: r.head, body, chunks: r.parts.length });
          if (plan.hang) break;
          this.answer(m.id, r.head, body);
          break;
        }
        case Msg.WS_OPEN: {
          const head = parseJsonBytes<WsOpenHead>(m.payload)!;
          if (head.path === '/ws') this.fromMac(Msg.WS_OPEN, m.id);
          else this.fromMac(Msg.WS_CLOSE, m.id, jsonBytes({ code: 4404, reason: 'no such socket' } satisfies WsCloseInfo));
          break;
        }
        case Msg.WS_MORE: {
          const parts = this.pieces.get(m.id) ?? [];
          parts.push(m.payload.slice());
          this.pieces.set(m.id, parts);
          break;
        }
        case Msg.WS_TEXT: {
          const parts = [...(this.pieces.get(m.id) ?? []), m.payload];
          this.pieces.delete(m.id);
          const text = Buffer.concat(parts).toString('utf8');
          seen.wsText.push(text);
          const f = JSON.parse(text) as { type: string; id?: string; method?: string; params?: unknown };
          // a tiny gateway: hello on connect, an answer to every request
          if (f.type === 'connect') this.fromMac(Msg.WS_TEXT, m.id, textBytes(JSON.stringify({ type: 'hello', ok: true, snapshot: {}, deviceId: 'd1', role: 'full', serverVersion: '2026.10.30', seq: 3 })));
          else if (f.type === 'req') this.sendText(m.id, textBytes(JSON.stringify({ type: 'res', id: f.id, ok: true, result: { ts: 42, method: f.method, params: f.params } })));
          break;
        }
        default: break;
      }
    }
    /** a gateway frame, in pieces when long, as the Mac sends it */
    sendText(id: number, bytes: Uint8Array) {
      let at = 0;
      for (; bytes.length - at > CHANNEL_CHUNK; at += CHANNEL_CHUNK) this.fromMac(Msg.WS_MORE, id, bytes.subarray(at, at + CHANNEL_CHUNK));
      this.fromMac(Msg.WS_TEXT, id, bytes.subarray(at));
    }
    private answer(id: number, head: HttpRequestHead, body: Uint8Array) {
      if (head.path === '/api/health') {
        this.fromMac(Msg.HTTP_RES, id, jsonBytes({ status: 200, headers: { 'Content-Type': 'application/json' } }));
        this.fromMac(Msg.HTTP_RES_BODY, id, jsonBytes({ ok: true, hostName: 'Studio' }));
        this.fromMac(Msg.HTTP_RES_END, id);
      } else if (head.path === '/api/files') {
        this.fromMac(Msg.HTTP_RES, id, jsonBytes({ status: 200, headers: { 'content-type': 'application/json' } }));
        this.fromMac(Msg.HTTP_RES_BODY, id, jsonBytes({ id: 'f1', name: 'a.bin', mimeType: 'application/octet-stream', size: body.length, url: '/files/f1' }));
        this.fromMac(Msg.HTTP_RES_END, id);
      } else if (head.path.startsWith('/sized/')) {
        // declares a length, then sends what the path says
        const [, declared, sent] = /^\/sized\/(\d+)\/(\d+)/.exec(head.path)!;
        this.fromMac(Msg.HTTP_RES, id, jsonBytes({ status: 200, headers: { 'Content-Length': declared } }));
        if (Number(sent)) this.fromMac(Msg.HTTP_RES_BODY, id, new Uint8Array(Number(sent)));
        this.fromMac(Msg.HTTP_RES_END, id);
      } else if (head.path.startsWith('/echo')) {
        // the body back, reversed, in CHANNEL_CHUNK pieces
        const out = body.slice().reverse();
        this.fromMac(Msg.HTTP_RES, id, jsonBytes({ status: 201, headers: { 'X-Path': head.path, 'X-Method': head.method } }));
        for (const c of chunks(out)) this.fromMac(Msg.HTTP_RES_BODY, id, c);
        this.fromMac(Msg.HTTP_RES_END, id);
      } else {
        this.fromMac(Msg.HTTP_ERR, id, jsonBytes({ message: 'gateway refused' }));
      }
    }
  }

  return { macKey: mac.public, transports, seen, WebSocketImpl: FakeTransport };
}

function session(w: ReturnType<typeof world>, extra: Partial<ConstructorParameters<typeof RelaySession>[0]> = {}) {
  return new RelaySession({ connectId: ROOM, macKey: w.macKey, WebSocketImpl: w.WebSocketImpl, relayUrl: 'wss://relay.test', idleMs: 0, ...extra });
}

afterEach(() => { closeRelaySessions(); vi.restoreAllMocks(); });

describe('RelaySession', () => {
  test('joins the room, says hello and waits for the Mac’s READY', async () => {
    const w = world();
    const s = session(w);
    await s.ready;
    expect(s.state).toBe('ready');
    expect(w.transports[0]!.url).toBe(`wss://relay.test/join/${ROOM}`);
    s.close();
  });

  test('a request with a multi-chunk body both ways', async () => {
    const w = world();
    const s = session(w);
    const body = new Uint8Array(CHANNEL_CHUNK * 2 + 1234).map((_, i) => i % 251);
    const res = await s.request({ method: 'post', path: '/echo?x=1', headers: { 'Content-Type': 'application/octet-stream' } }, body);
    expect(w.seen.requests[0]!.chunks).toBe(3);
    expect(w.seen.requests[0]!.head).toEqual({ method: 'POST', path: '/echo?x=1', headers: { 'Content-Type': 'application/octet-stream' } });
    expect(res.status).toBe(201);
    expect(res.headers['x-path']).toBe('/echo?x=1');
    expect(res.body.length).toBe(body.length);
    expect(res.body[0]).toBe(body[body.length - 1]);
    expect(res.body[body.length - 1]).toBe(body[0]);
    s.close();
  });

  test('HTTP_ERR fails that request only', async () => {
    const w = world();
    const s = session(w);
    await expect(s.request({ method: 'GET', path: '/nope' })).rejects.toMatchObject({ code: 'http_failed', message: 'gateway refused' });
    expect((await s.request({ method: 'GET', path: '/echo' })).status).toBe(201);
    s.close();
  });

  test('a socket round trip, and a socket the Mac refuses', async () => {
    const w = world();
    const s = session(w);
    const ws = s.openSocket('/ws');
    const got: string[] = [];
    await new Promise<void>((resolve) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: 'req', id: 'r1', method: 'system.ping' }));
      ws.onmessage = (ev) => { got.push(ev.data); resolve(); };
    });
    expect(JSON.parse(got[0]!)).toMatchObject({ type: 'res', id: 'r1', result: { ts: 42 } });
    const bad = s.openSocket('/elsewhere');
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => { bad.onclose = resolve; });
    expect(closed).toMatchObject({ code: 4404, reason: 'no such socket' });
    // the first one still works
    expect(ws.readyState).toBe(1);
    ws.close();
    s.close();
  });

  test('no_host fails with a friendly message', async () => {
    const w = world({ join: 'no_host' });
    const s = session(w);
    const err = await s.ready.then(() => null, (e: GatewayError) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err?.code).toBe('no_host');
    expect(err?.message).toMatch(/isn’t on AppuBot Connect right now/);
    await expect(s.request({ method: 'GET', path: '/api/health' })).rejects.toMatchObject({ code: 'no_host' });
  });

  test('the relay refusing the join is connect_failed', async () => {
    const w = world({ join: 'rate_limited' });
    await expect(session(w).ready).rejects.toMatchObject({ code: 'connect_failed', message: expect.stringMatching(/Too many tries/) });
  });

  test('a READY sealed with another key is refused, and nothing else is sent', async () => {
    const w = world({ impostor: true });
    const s = session(w);
    const req = s.request({ method: 'GET', path: '/api/health' });
    await expect(s.ready).rejects.toMatchObject({ code: 'connect_failed', message: expect.stringMatching(/Couldn’t confirm/) });
    await expect(req).rejects.toMatchObject({ code: 'connect_failed' });
    expect(w.seen.requests).toHaveLength(0);
  });

  test('a Mac on another channel version is told apart from an impostor, and says which side is older', async () => {
    const newer = world({ version: CHANNEL_VERSION + 1 });
    await expect(session(newer).ready).rejects.toMatchObject({ code: 'incompatible', data: { update: 'client' }, message: expect.stringMatching(/newer AppuBot. Update this app/) });
    const older = world({ version: CHANNEL_VERSION - 1 });
    await expect(session(older).ready).rejects.toMatchObject({ code: 'incompatible', data: { update: 'server' }, message: expect.stringMatching(/older AppuBot. Update it/) });
  });

  test('a Mac that never says READY times out', async () => {
    const w = world({ silent: true });
    const abandon = vi.fn();
    const real = protocol.phoneHandshake;
    const spy = vi.spyOn(protocol, 'phoneHandshake').mockImplementation((key) => {
      const hs = real(key);
      return { hello: hs.hello, finish: hs.finish, abandon: () => { abandon(); hs.abandon(); } };
    });
    const s = session(w, { readyTimeoutMs: 40 });
    await expect(s.ready).rejects.toMatchObject({ code: 'connect_failed' });
    expect(w.seen.requests).toHaveLength(0);
    // the handshake given up on: its ephemeral secret is wiped
    expect(spy).toHaveBeenCalled();
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  test('a session that ends wipes its channel’s keys', async () => {
    const w = world();
    const close = vi.spyOn(SecureChannel.prototype, 'close');
    const s = session(w);
    await s.ready;
    const ch = (s as unknown as { channel: SecureChannel }).channel;
    s.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(ch.isClosed).toBe(true);
  });

  test('a dropped session fails pending requests and closes its sockets', async () => {
    const w = world({ hang: true });
    const s = session(w);
    const ws = s.openSocket('/ws');
    await new Promise<void>((r) => { ws.onopen = () => r(); });
    const closed = new Promise<{ code: number; reason: string }>((r) => { ws.onclose = r; });
    const req = s.request({ method: 'GET', path: '/echo' });
    await vi.waitFor(() => expect(w.seen.requests).toHaveLength(1));
    w.transports[0]!.drop(1006, '');
    await expect(req).rejects.toMatchObject({ code: 'closed' });
    expect((await closed).code).toBe(1006);
    expect(s.state).toBe('closed');
  });

  test('the Mac leaving the room reads as no_host', async () => {
    const w = world({ hang: true });
    const s = session(w);
    await s.ready;
    const req = s.request({ method: 'GET', path: '/echo' });
    await tick(10);
    w.transports[0]!.drop(1001, 'host_gone');
    await expect(req).rejects.toMatchObject({ code: 'no_host' });
  });

  test('an aborted request rejects with AbortError', async () => {
    const w = world({ hang: true });
    const s = session(w);
    const ctl = new AbortController();
    const req = s.request({ method: 'GET', path: '/echo' }, undefined, { signal: ctl.signal });
    await tick(10);
    ctl.abort();
    await expect(req).rejects.toMatchObject({ name: 'AbortError' });
    s.close();
  });
});

describe('RelaySession: integrity and limits', () => {
  test('long gateway frames cross in pieces both ways, every message within the frame limit', async () => {
    const w = world();
    const s = session(w);
    const ws = s.openSocket('/ws');
    await new Promise<void>((r) => { ws.onopen = () => r(); });
    const big = 'x'.repeat(CHANNEL_CHUNK * 3 + 77) + 'नमस्ते'.repeat(5000);
    const got = new Promise<string>((r) => { ws.onmessage = (ev) => r(ev.data); });
    ws.send(JSON.stringify({ type: 'req', id: 'r1', method: 'chat.send', params: { text: big } }));
    const res = JSON.parse(await got) as { result: { params: { text: string } } };
    expect(res.result.params.text).toBe(big);
    expect(JSON.parse(w.seen.wsText[0]!).params.text).toBe(big);
    expect(Math.max(...w.seen.frames)).toBeLessThanOrEqual(CHANNEL_FRAME_MAX);
    ws.close();
    s.close();
  });

  test('a big upload goes at most a window ahead of the Mac, and arrives whole', async () => {
    const w = world();
    const s = session(w);
    const body = new Uint8Array(CHANNEL_WINDOW * 3 + 5).map((_, i) => (i * 7) & 0xff);
    const res = await s.request({ method: 'POST', path: '/echo' }, body);
    expect(res.body.length).toBe(body.length);
    expect(res.body[0]).toBe(body[body.length - 1]);
    expect(Math.max(...w.seen.frames)).toBeLessThanOrEqual(CHANNEL_FRAME_MAX);
    // the phone acknowledged the response body as it came
    await vi.waitFor(() => expect(w.seen.acks.length).toBeGreaterThanOrEqual(Math.floor(body.length / (CHANNEL_ACK_EVERY + CHANNEL_CHUNK))));
    expect(w.seen.acks.at(-1)).toBeLessThanOrEqual(body.length);
    s.close();
  });

  test('without the Mac’s acks the body stops at the window; a silent session is dropped as dead', async () => {
    const w = world({ noAck: true, hang: true });
    const s = session(w, { requestTimeoutMs: 80 });
    await s.ready;
    // caught from the start: on a loaded machine the session can fail before the checks below are reached
    const outcome = s.request({ method: 'POST', path: '/echo' }, new Uint8Array(CHANNEL_WINDOW * 2)).then(() => null, (e: unknown) => e);
    await vi.waitFor(() => expect(w.seen.bodyBytes).toBeGreaterThan(CHANNEL_WINDOW - CHANNEL_CHUNK));
    await tick(20);
    expect(w.seen.bodyBytes).toBeLessThanOrEqual(CHANNEL_WINDOW);
    // nothing at all came back since: the session is the problem, not the request
    expect(await outcome).toMatchObject({ code: 'closed' });
    expect(s.state).toBe('closed');
  });

  test('a request the Mac goes quiet on times out alone, and the Mac is told to stop', async () => {
    const w = world({ hang: true });
    const s = session(w, { requestTimeoutMs: 120 });
    const ws = s.openSocket('/ws');
    await new Promise<void>((r) => { ws.onopen = () => r(); });
    const req = s.request({ method: 'GET', path: '/echo' });
    // the session itself is alive: the gateway socket keeps talking
    const chatter = setInterval(() => ws.send(JSON.stringify({ type: 'req', id: 'p', method: 'system.ping' })), 20);
    try {
      await expect(req).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      clearInterval(chatter);
    }
    expect(s.state).toBe('ready');
    await vi.waitFor(() => expect(w.seen.cancels).toHaveLength(1));
    ws.close();
    s.close();
  });

  test('an aborted request tells the Mac to stop', async () => {
    const w = world({ hang: true });
    const s = session(w);
    const ctl = new AbortController();
    const req = s.request({ method: 'GET', path: '/echo' }, undefined, { signal: ctl.signal });
    await vi.waitFor(() => expect(w.seen.requests).toHaveLength(1));
    ctl.abort();
    await expect(req).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(w.seen.cancels).toHaveLength(1));
    s.close();
  });

  test('a body shorter than its declared length is refused, a whole one isn’t', async () => {
    const w = world();
    const s = session(w);
    await expect(s.request({ method: 'GET', path: '/sized/10/5' })).rejects.toMatchObject({ code: 'http_failed', message: expect.stringMatching(/cut short/) });
    expect((await s.request({ method: 'GET', path: '/sized/10/10' })).body.length).toBe(10);
    // HEAD answers declare the GET's length with no body
    expect((await s.request({ method: 'HEAD', path: '/sized/10/0' })).status).toBe(200);
    s.close();
  });

  test('a message the relay loses ends the session at the next one', async () => {
    // the Mac's reply is message 1; the response head 2, its first body chunk 3 (lost), the rest after
    const w = world({ loseFromMac: 3 });
    const s = session(w);
    const req = s.request({ method: 'POST', path: '/echo' }, new Uint8Array(CHANNEL_CHUNK * 2));
    await expect(req).rejects.toMatchObject({ code: 'closed', message: expect.stringMatching(/broke/) });
    expect(s.state).toBe('closed');
  });
});

describe('RelaySession on an asynchronous cipher whose answers come back in any order', () => {
  // the phone's native cipher answers with promises, possibly a later message's first: each one 0-10 ms late here
  const withSlowCipher = async (fn: () => Promise<void>) => {
    const before = channelCipher();
    setChannelCipher(asyncCipher(() => Math.random() * 10));
    try { await fn(); } finally { setChannelCipher(before); }
  };
  const callAll = (ws: ReturnType<RelaySession['openSocket']>, n: number) => {
    for (let i = 0; i < n; i++) ws.send(JSON.stringify({ type: 'req', id: `r${i}`, method: 'system.ping', params: { i } }));
  };

  test('the Mac’s messages are handled, and ours sent, strictly in order', () => withSlowCipher(async () => {
    const w = world();
    const s = session(w);
    const ws = s.openSocket('/ws');
    await new Promise<void>((r) => { ws.onopen = () => r(); });
    const got: string[] = [];
    const all = new Promise<void>((r) => { ws.onmessage = (ev) => { got.push((JSON.parse(ev.data) as { id: string }).id); if (got.length === 60) r(); }; });
    // a burst of calls, sealed at once and each sealing done at its own pace; the Mac would throw on one out of order
    callAll(ws, 60);
    // and a body in pieces both ways meanwhile
    const body = new Uint8Array(CHANNEL_CHUNK * 3 + 9).map((_, i) => i % 253);
    const res = await s.request({ method: 'POST', path: '/echo' }, body);
    await all;
    expect(got).toEqual(Array.from({ length: 60 }, (_, i) => `r${i}`));
    expect(w.seen.wsText.map((t) => (JSON.parse(t) as { id: string }).id)).toEqual(got);
    expect(res.body.length).toBe(body.length);
    expect(res.body[0]).toBe(body[body.length - 1]);
    expect(s.state).toBe('ready');
    ws.close();
    s.close();
  }));

  test('a tampered message ends the session: what came before it is handled, nothing after it, however soon it opens', () => withSlowCipher(async () => {
    // the Mac's messages: 1 the reply, 2 the socket open, then an answer each: the fifth answer (message 7) is tampered with
    const w = world({ tamperFromMac: 7 });
    const s = session(w);
    const ws = s.openSocket('/ws');
    await new Promise<void>((r) => { ws.onopen = () => r(); });
    const got: string[] = [];
    ws.onmessage = (ev) => got.push((JSON.parse(ev.data) as { id: string }).id);
    const closed = new Promise<{ code: number }>((r) => { ws.onclose = r; });
    callAll(ws, 12);
    expect((await closed).code).toBe(1006);
    expect(s.error).toMatchObject({ code: 'closed', message: expect.stringMatching(/broke/) });
    expect(got).toEqual(['r0', 'r1', 'r2', 'r3']);
    // the session's keys went with it
    expect(s.state).toBe('closed');
  }));

  test('given up on while the cipher checks the Mac’s reply: the channel it makes is closed at once', () => withSlowCipher(async () => {
    const close = vi.spyOn(SecureChannel.prototype, 'close');
    const w = world();
    const s = session(w);
    // the reply has come and is being checked: the session closes meanwhile
    await vi.waitFor(() => { if (!(s as unknown as { finishing: boolean }).finishing) throw new Error('not yet'); }, { interval: 1 });
    s.close();
    await expect(s.ready).rejects.toBeTruthy();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(s.state).toBe('closed');
  }));
});

describe('relaySession', () => {
  test('one live session per room, a new one after it drops', async () => {
    const w = world();
    const opts = { connectId: ROOM, macKey: w.macKey, WebSocketImpl: w.WebSocketImpl, idleMs: 0 };
    const a = relaySession(opts);
    expect(relaySession(opts)).toBe(a);
    await a.ready;
    w.transports[0]!.drop(1006, '');
    await tick(5);
    const b = relaySession(opts);
    expect(b).not.toBe(a);
    await b.ready;
    expect(w.transports).toHaveLength(2);
  });

  test('a full or busy relay is temporary: code busy, and the room waits a moment before it is dialled again', async () => {
    for (const reason of ['relay_full', 'relay_busy'] as const) {
      const w = world({ join: reason });
      const opts = { connectId: ROOM, macKey: w.macKey, WebSocketImpl: w.WebSocketImpl };
      const a = relaySession(opts);
      await expect(a.ready).rejects.toMatchObject({ code: 'busy', message: RELAY_BUSY_MESSAGE });
      await tick(5);
      expect(relaySession(opts)).toBe(a);
      expect(w.transports).toHaveLength(1);
      closeRelaySessions();
    }
  });

  test('the relay dropping a phone that fell behind (1013) is an ordinary drop: the next session dials at once', async () => {
    const w = world();
    const opts = { connectId: ROOM, macKey: w.macKey, WebSocketImpl: w.WebSocketImpl, idleMs: 0 };
    const a = relaySession(opts);
    await a.ready;
    const ws = a.openSocket('/ws');
    await new Promise<void>((r) => { ws.onopen = () => r(); });
    const closed = new Promise<{ code: number }>((r) => { ws.onclose = r; });
    w.transports[0]!.drop(1013, 'backpressure');
    expect((await closed).code).toBe(1006);
    expect(a.error).toMatchObject({ code: 'closed', message: expect.stringMatching(/Reconnecting/) });
    const b = relaySession(opts);
    expect(b).not.toBe(a);
    await b.ready;
  });

  test('a room that wasn’t there is not dialled again at once', async () => {
    const w = world({ join: 'no_host' });
    const opts = { connectId: ROOM, macKey: w.macKey, WebSocketImpl: w.WebSocketImpl };
    const a = relaySession(opts);
    await a.ready.catch(() => undefined);
    await tick(5);
    const b = relaySession(opts);
    expect(b).toBe(a);
    await expect(b.request({ method: 'GET', path: '/' })).rejects.toMatchObject({ code: 'no_host' });
    expect(w.transports).toHaveLength(1);
  });
});

describe('relayFetch', () => {
  test('health checks and uploads go through the session', async () => {
    const w = world();
    const s = session(w);
    const f = relayFetch(s);
    expect(await checkHealth(`connect://${ROOM}`, f)).toEqual({ ok: true, hostName: 'Studio' });
    const data = new Uint8Array([1, 2, 3, 0, 255]);
    const att = await uploadBytes(`connect://${ROOM}`, 'tok', { name: 'a "b".bin', type: 'application/octet-stream', data }, 'th1', f);
    expect(att.id).toBe('f1');
    const up = w.seen.requests.find((r) => r.head.path === '/api/files')!;
    expect(up.head.method).toBe('POST');
    expect(up.head.headers.authorization).toBe('Bearer tok');
    const boundary = /boundary=(.+)$/.exec(up.head.headers['content-type']!)![1]!;
    const text = new TextDecoder('latin1').decode(up.body);
    expect(text.startsWith(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a %22b%22.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`)).toBe(true);
    expect(text).toContain(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="threadId"\r\n\r\nth1\r\n--${boundary}--\r\n`);
    const at = text.indexOf('\r\n\r\n') + 4;
    expect([...up.body.subarray(at, at + data.length)]).toEqual([...data]);
    s.close();
  });

  test('string bodies, headers and the path with its query', async () => {
    const w = world();
    const s = session(w);
    const res = await relayFetch(s)(`connect://${ROOM}/echo/x?y=1#frag`, { method: 'PUT', headers: new Headers({ 'X-A': 'b' }), body: 'abc' });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('cba');
    expect(w.seen.requests[0]!.head).toEqual({ method: 'PUT', path: '/echo/x?y=1', headers: { 'x-a': 'b', 'content-type': 'text/plain;charset=UTF-8' } });
    s.close();
  });

  test('a file comes back as a Blob of its type, and its download is heard as it arrives', async () => {
    const w = world();
    const s = session(w);
    const heard: [number, number | null][] = [];
    const res = await s.request({ method: 'GET', path: '/sized/600/600' }, undefined, { onProgress: (n, total) => heard.push([n, total]) });
    expect(heard).toEqual([[600, 600]]);
    const body = new Uint8Array(CHANNEL_CHUNK * 2 + 5).map((_, i) => i % 251);
    const echoed: number[] = [];
    await s.request({ method: 'POST', path: '/echo' }, body, { onProgress: (n, total) => { echoed.push(n); expect(total).toBeNull(); } });
    expect(echoed).toEqual([CHANNEL_CHUNK, CHANNEL_CHUNK * 2, CHANNEL_CHUNK * 2 + 5]);
    const blob = await relayResponse({ status: 200, headers: { 'content-type': 'image/png' }, body: res.body }).blob();
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(600);
    s.close();
  });

  test('pathOfUrl', () => {
    expect(pathOfUrl(`connect://${ROOM}`)).toBe('/');
    expect(pathOfUrl(`connect://${ROOM}/files/a?token=t`)).toBe('/files/a?token=t');
    expect(pathOfUrl('http://[fd7a::1]:7890/api/health')).toBe('/api/health');
    expect(pathOfUrl('/api/pair')).toBe('/api/pair');
  });

  test('multipartBody without a file', () => {
    const { body, contentType } = multipartBody([['a', 'b']], 'XX');
    expect(contentType).toBe('multipart/form-data; boundary=XX');
    expect(bytesText(body)).toBe('--XX\r\nContent-Disposition: form-data; name="a"\r\n\r\nb\r\n--XX--\r\n');
  });
});

describe('GatewayClient over AppuBot Connect', () => {
  test('connect:// URLs, and a hello and a call through a RelaySocket', async () => {
    const w = world();
    const s = session(w);
    const opened: string[] = [];
    const c = new GatewayClient({
      baseUrl: `connect://${ROOM}`,
      token: 'tok',
      device: { id: 'dev', name: 'Phone', platform: 'ios', appVersion: '1' },
      openSocket: (url) => { opened.push(url); return s.openSocket(pathOfUrl(url)); },
    });
    expect(c.wsUrl()).toBe(`connect://${ROOM}/ws`);
    expect(c.fileUrl('/files/f1')).toBe(`connect://${ROOM}/files/f1?token=tok`);
    expect(c.fileUrl({ url: '/pages/p?v=1' })).toBe(`connect://${ROOM}/pages/p?v=1&token=tok`);
    const connected = new Promise<void>((r) => c.onState((st) => { if (st === 'connected') r(); }));
    c.connect();
    await connected;
    expect(opened).toEqual([`connect://${ROOM}/ws`]);
    expect(c.serverVersion).toBe('2026.10.30');
    expect(JSON.parse(w.seen.wsText[0]!)).toMatchObject({ type: 'connect', token: 'tok' });
    expect(await c.call('system.ping', {})).toMatchObject({ ts: 42 });
    c.close();
    s.close();
  });

  test('http base URLs are unchanged', () => {
    const c = new GatewayClient({ baseUrl: 'http://100.64.0.1:7890/', token: 't k', device: { id: 'd', name: 'n', platform: 'ios', appVersion: '1' } });
    expect(c.wsUrl()).toBe('ws://100.64.0.1:7890/ws');
    expect(c.fileUrl('/files/a')).toBe('http://100.64.0.1:7890/files/a?token=t+k');
  });

  test('the token goes only on the gateway’s own paths: never another app, host or scheme', () => {
    const device = { id: 'd', name: 'n', platform: 'ios' as const, appVersion: '1' };
    for (const baseUrl of ['http://100.64.0.1:7890', `connect://${ROOM}`, 'http://192.168.1.4:7890']) {
      const c = new GatewayClient({ baseUrl, token: 'secret', device });
      for (const bad of ['someapp://x', 'javascript:alert(1)', '//evil.com/x', '/\\evil.com/x', '/%2Fevil.com/x', '/%5Cevil.com', '/\t/evil.com', 'files/a', 'https://evil.com/files/a']) {
        expect(() => c.fileUrl(bad), `${baseUrl} ${bad}`).toThrow(GatewayError);
        expect(() => c.fileUrl({ url: bad }), `${baseUrl} ${bad}`).toThrow(/isn’t a file/);
      }
      expect(c.fileUrl('/files/a')).toContain('token=secret');
      expect(new URL(c.fileUrl('/files/a').replace(/^connect:/, 'http:')).pathname).toBe('/files/a');
    }
  });
});

import { relayResponse } from './connect';

describe('relayResponse', () => {
  test('decodes UTF-8 even where the global Response would read bytes as Latin-1 (React Native)', async () => {
    const real = globalThis.Response;
    // React Native's fetch polyfill: a byte body's text() is one character per byte
    class Latin1Response {
      constructor(private b: Uint8Array) {}
      async text() { return String.fromCharCode(...this.b); }
    }
    (globalThis as { Response: unknown }).Response = Latin1Response;
    try {
      const body = new TextEncoder().encode(JSON.stringify({ hostName: 'Sarthak’s MacBook Air', emoji: '🙂', hi: 'नमस्ते' }));
      const res = relayResponse({ status: 200, headers: { 'content-type': 'application/json' }, body });
      expect(res.ok).toBe(true);
      expect(await res.json()).toEqual({ hostName: 'Sarthak’s MacBook Air', emoji: '🙂', hi: 'नमस्ते' });
      expect(res.headers.get('Content-Type')).toBe('application/json');
    } finally {
      (globalThis as { Response: unknown }).Response = real;
    }
  });
  test('a 204 has an empty body', async () => {
    expect(await relayResponse({ status: 204, headers: {}, body: new Uint8Array([1, 2]) }).text()).toBe('');
  });
});

describe('direct sessions (the same Wi-Fi, no relay)', () => {
  const direct = (w: ReturnType<typeof world>, extra: { readyTimeoutMs?: number } = {}) =>
    directSession({ host: '192.168.1.5', port: 7890, macKey: w.macKey, WebSocketImpl: w.WebSocketImpl, idleMs: 0, ...extra });

  test('dials the Mac’s /secure socket, says hello as soon as it opens and pins the key', async () => {
    const w = world({ direct: true });
    const s = direct(w);
    await s.ready;
    expect(w.transports[0]!.url).toBe('ws://192.168.1.5:7890/secure');
    expect(s.directUrl).toBe('ws://192.168.1.5:7890/secure');
    expect(s.label).toBe('http://192.168.1.5:7890');
    expect(directUrl('fe80::1', 7890)).toBe('ws://[fe80::1]:7890/secure');
    // health, a gateway socket and a call, all inside the channel
    expect(await checkHealth('http://192.168.1.5:7890', relayFetch(s))).toEqual({ ok: true, hostName: 'Studio' });
    const c = new GatewayClient({
      baseUrl: 'http://192.168.1.5:7890', token: 'tok', device: { id: 'dev', name: 'Phone', platform: 'ios', appVersion: '1' },
      openSocket: (url) => s.openSocket(pathOfUrl(url)),
    });
    const connected = new Promise<void>((r) => c.onState((st) => { if (st === 'connected') r(); }));
    c.connect();
    await connected;
    // the token went inside the sealed channel, never as the socket's URL
    expect(JSON.parse(w.seen.wsText[0]!)).toMatchObject({ type: 'connect', token: 'tok' });
    expect(w.transports.map((t) => t.url)).toEqual(['ws://192.168.1.5:7890/secure']);
    expect(await c.call('system.ping', {})).toMatchObject({ ts: 42 });
    c.close();
  });

  test('over Tailscale the same channel runs to the Mac’s Tailscale address, and says so when it fails', async () => {
    const w = world({ direct: true, impostor: true });
    const s = directSession({ host: '100.101.12.44', port: 7890, macKey: w.macKey, WebSocketImpl: w.WebSocketImpl, idleMs: 0 });
    expect(s.directUrl).toBe('ws://100.101.12.44:7890/secure');
    // an address in Tailscale's range proves nothing: whoever answers there must hold the pinned key
    await expect(s.ready).rejects.toMatchObject({ code: 'connect_failed', message: expect.stringMatching(/Couldn’t confirm it’s your computer over Tailscale/) });
    expect(w.seen.requests).toHaveLength(0);
    const named = directSession({ host: 'studio.tail1234.ts.net', port: 7890, macKey: w.macKey, WebSocketImpl: w.WebSocketImpl, idleMs: 0 });
    expect(named.directUrl).toBe('ws://studio.tail1234.ts.net:7890/secure');
    named.close();
  });

  test('an AppuBot Cloud computer is reached by its public address over wss, and given minutes to wake', async () => {
    expect(cloudDirectUrl('https://ab12cd34ef.agent37.app')).toBe('wss://ab12cd34ef.agent37.app/secure');
    expect(cloudDirectUrl('https://x7.agent37.app/some/path')).toBe('wss://x7.agent37.app/secure');
    expect(cloudDirectUrl('http://127.0.0.1:7443')).toBe('ws://127.0.0.1:7443/secure');
    expect(isCloudUrl('https://ab12cd34ef.agent37.app')).toBe(true);
    expect(isCloudUrl('wss://ab12cd34ef.agent37.app/secure')).toBe(true);
    expect(isCloudUrl('http://192.168.1.5:7890')).toBe(false);
    expect(isCloudUrl('https://agent37.app.evil.com')).toBe(false);
    const w = world({ direct: true });
    const s = directSession({ url: cloudDirectUrl('https://ab12cd34ef.agent37.app'), macKey: w.macKey, WebSocketImpl: w.WebSocketImpl, idleMs: 0 });
    expect(s.directUrl).toBe('wss://ab12cd34ef.agent37.app/secure');
    expect(s.label).toBe('https://ab12cd34ef.agent37.app');
    expect(w.transports[0]!.url).toBe('wss://ab12cd34ef.agent37.app/secure');
    await s.ready;
    expect(await checkHealth('https://ab12cd34ef.agent37.app', relayFetch(s))).toEqual({ ok: true, hostName: 'Studio' });
    expect(directSession({ url: 'wss://ab12cd34ef.agent37.app/secure', macKey: w.macKey, WebSocketImpl: w.WebSocketImpl, idleMs: 0 })).toBe(s);
    s.close();
    // a computer that never answers: the wait is the waking one (3 min), not the Wi-Fi's 5 s, and the failure says cloud
    vi.useFakeTimers();
    try {
      const quiet = world({ direct: true, silent: true });
      const c = directSession({ url: 'wss://sleepy.agent37.app/secure', macKey: quiet.macKey, WebSocketImpl: quiet.WebSocketImpl, idleMs: 0 });
      const failed = c.ready.then(() => 'ready', (e: GatewayError) => e);
      await vi.advanceTimersByTimeAsync(CLOUD_READY_TIMEOUT_MS - 1000);
      expect(c.state).toBe('connecting');
      await vi.advanceTimersByTimeAsync(2000);
      expect(await failed).toMatchObject({ code: 'connect_failed', message: expect.stringMatching(/AppuBot computer/) });
    } finally {
      vi.useRealTimers();
    }
    expect(() => directSession({ macKey: w.macKey, WebSocketImpl: w.WebSocketImpl })).toThrow(/url, or a host and port/);
  });

  test('one session per address carries everything: no handshake per request', async () => {
    const w = world({ direct: true });
    const a = direct(w);
    expect(direct(w)).toBe(a);
    await a.ready;
    await Promise.all([a.request({ method: 'GET', path: '/api/health' }), direct(w).request({ method: 'GET', path: '/echo' })]);
    expect(w.transports).toHaveLength(1);
    // another address is another session; a dropped one is made again
    const other = directSession({ host: '10.0.0.7', port: 7890, macKey: w.macKey, WebSocketImpl: w.WebSocketImpl, idleMs: 0 });
    expect(other).not.toBe(a);
    w.transports[0]!.drop(1006, '');
    await tick(5);
    const b = direct(w);
    expect(b).not.toBe(a);
    await b.ready;
  });

  test('someone else at that address can’t finish the handshake, and is never sent anything', async () => {
    const w = world({ direct: true, impostor: true });
    const s = direct(w);
    const req = s.request({ method: 'POST', path: '/api/pair' }, new Uint8Array([1, 2, 3]));
    await expect(s.ready).rejects.toMatchObject({ code: 'connect_failed', message: expect.stringMatching(/Couldn’t confirm it’s your computer on this Wi-Fi/) });
    await expect(req).rejects.toMatchObject({ code: 'connect_failed' });
    expect(w.seen.requests).toHaveLength(0);
  });

  test('a computer that isn’t there is given up on, and a probe’s timeout doesn’t wait out the handshake', async () => {
    const w = world({ direct: true, unreachable: true });
    const s = direct(w, { readyTimeoutMs: 60 });
    const t0 = Date.now();
    expect(await checkHealth('http://192.168.1.5:7890', relayFetch(s), 20)).toEqual({ ok: false });
    expect(Date.now() - t0).toBeLessThan(55);
    await expect(s.ready).rejects.toMatchObject({ code: 'connect_failed', message: expect.stringMatching(/on this Wi-Fi/) });
  });

  test('a probe given up on with total silence from the Mac ends a half-open session, so the next one dials afresh', async () => {
    const w = world({ direct: true, hang: true });
    const s = directSession({ host: '192.168.1.5', port: 7890, macKey: w.macKey, WebSocketImpl: w.WebSocketImpl, idleMs: 0, silentAbortMs: 20 });
    await s.ready;
    // a slow answer (aborted before the silence counts) leaves the session be
    const quick = new AbortController();
    const first = s.request({ method: 'GET', path: '/api/health' }, undefined, { signal: quick.signal });
    quick.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.state).toBe('ready');
    expect(await checkHealth('http://192.168.1.5:7890', relayFetch(s), 60)).toEqual({ ok: false });
    expect(s.state).toBe('closed');
    const next = directSession({ host: '192.168.1.5', port: 7890, macKey: w.macKey, WebSocketImpl: w.WebSocketImpl, idleMs: 0 });
    expect(next).not.toBe(s);
  });

  test('probeHosts checks each address with its own fetch, and leaves out the ones it is told to', async () => {
    const w = world({ direct: true });
    const plainTried: string[] = [];
    const plain = (async (url: string) => { plainTried.push(url); throw new Error('no route'); }) as unknown as typeof fetch;
    const found = await probeHosts(['100.64.0.9', '192.168.1.5', '10.0.0.8'], 7890, {
      fetchImpl: plain,
      fetchFor: (host) => (host === '192.168.1.5' ? relayFetch(direct(w)) : host === '10.0.0.8' ? null : plain),
    });
    expect(found).toEqual({ host: '192.168.1.5', baseUrl: 'http://192.168.1.5:7890' });
    // the Wi-Fi address without a session never went out in the clear
    expect(plainTried.some((u) => u.includes('10.0.0.8'))).toBe(false);
    expect(w.transports).toHaveLength(1);
  });

  test('an upload read piece by piece goes a window at a time, and its source is closed', async () => {
    const w = world({ direct: true });
    const s = direct(w);
    const data = new Uint8Array(CHANNEL_WINDOW * 2 + 777).map((_, i) => (i * 13) & 0xff);
    let at = 0;
    let closed = 0;
    // pieces of an odd size, as a file handle may give them
    const pieces: BodySource = { read: async () => (at >= data.length ? null : data.subarray(at, (at += 300_001))), close: () => { closed += 1; } };
    const att = await uploadStream(s, 'tok', { name: 'clip.mov', type: 'video/quicktime', pieces }, 'th1');
    expect(att.id).toBe('f1');
    expect(closed).toBe(1);
    const up = w.seen.requests.find((r) => r.head.path === '/api/files')!;
    expect(up.head.headers.authorization).toBe('Bearer tok');
    expect(Math.max(...w.seen.frames)).toBeLessThanOrEqual(CHANNEL_FRAME_MAX);
    const boundary = /boundary=(.+)$/.exec(up.head.headers['content-type']!)![1]!;
    // the same form uploadBytes sends
    const same = multipartBody([['file', { name: 'clip.mov', type: 'video/quicktime', data }], ['threadId', 'th1']], boundary);
    expect(Buffer.compare(Buffer.from(up.body), Buffer.from(same.body))).toBe(0);
  });

  test('a source that fails to read cancels the request on the Mac', async () => {
    const w = world({ direct: true, hang: true });
    const s = direct(w);
    let n = 0;
    let closed = false;
    const pieces: BodySource = { read: async () => { if (n++ > 1) throw new Error('disk gone'); return new Uint8Array(1000); }, close: () => { closed = true; } };
    await expect(uploadStream(s, 'tok', { name: 'a.bin', type: '', pieces })).rejects.toThrow(/disk gone/);
    await vi.waitFor(() => expect(w.seen.cancels).toHaveLength(1));
    expect(closed).toBe(true);
    expect(s.state).toBe('ready');
  });
});
