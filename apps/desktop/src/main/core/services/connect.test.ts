/**
 * AppuBot Connect against an in-process relay (the real relay's protocol: /host with an Ed25519 challenge, /join/<room>,
 * multiplexed frames, pings echoed) and a phone that speaks the end-to-end channel: nothing runs until a phone pairs,
 * the pairing QR carries the room and key, a phone pairs and opens the gateway WebSocket through the relay as route
 * `connect` with its own address, a replayed, tampered or malformed stream ends that phone only, long frames and big
 * bodies cross in pieces within the window, a silent relay is dialled again, the identity survives a restart and
 * `reset` makes a new one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  CHANNEL_CHUNK,
  CHANNEL_FRAME_MAX,
  CHANNEL_VERSION,
  CHANNEL_WINDOW,
  Msg,
  RelayFrame,
  bytesText,
  challengeMessage,
  createEphemeralKeypair,
  decodeRelayFrame,
  encodeRelayFrame,
  fromBase64Url,
  helloFrame,
  jsonBytes,
  roomIdForPublicKey,
  textBytes,
} from '@appubot/protocol';
import { createCore, type Core } from '../app';
import type { CoreDeps } from '../context';
import { TestPhone } from '../testing/channelPhone';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

const cores: Core[] = [];
const roots: string[] = [];
const relays: FakeRelay[] = [];
const newRoot = () => { const r = mkdtempSync(join(tmpdir(), 'appubot-connect-')); roots.push(r); return r; };
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cores.splice(0)) await c.stop();
  for (const r of relays.splice(0)) await r.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const toU8 = (d: RawData): Uint8Array => new Uint8Array(Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d));

/** The relay, cut down: rooms owned by a signed challenge, phones multiplexed over the host. */
class FakeRelay {
  private wss: WebSocketServer;
  hosts = new Map<string, WebSocket>();
  private phones = new Map<number, { ws: WebSocket; room: string }>();
  private next = 1;
  /** host sockets that went silent: their messages are ignored, nothing is echoed, but they stay open */
  private muted = new Set<WebSocket>();
  /** echo the host's pings (an older relay didn't) */
  echo = true;
  /** host sockets that claimed a room, ever */
  claims = 0;
  /** the biggest DATA payload either way */
  maxData = 0;
  /** host sockets asked for, refused or not */
  hostDials = 0;
  /** the relay pass each challenge's answer carried (undefined: none) */
  tickets: (string | undefined)[] = [];
  /** refuse host sockets before the upgrade, as the real relay does with too many from one address */
  refuseHosts: { status: number; retryAfter?: string } | null = null;
  readonly listening: Promise<void>;
  constructor() {
    this.wss = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      verifyClient: (info, done) => {
        if (info.req.url !== '/host') return done(true);
        this.hostDials += 1;
        const r = this.refuseHosts;
        if (r) return done(false, r.status, 'too many hosts', r.retryAfter ? { 'retry-after': r.retryAfter } : {});
        done(true);
      },
    });
    this.listening = new Promise((r) => this.wss.once('listening', () => r()));
    this.wss.on('connection', (ws, req) => {
      const path = req.url ?? '';
      if (path === '/host') return this.host(ws, String(req.headers['x-connect-pubkey'] ?? ''));
      const m = /^\/join\/([a-z2-7]{26})$/.exec(path);
      if (m) return this.join(ws, m[1]!, String(req.headers['x-forwarded-for'] ?? '0.0.0.0'));
      ws.close();
    });
  }
  get url(): string { return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`; }
  private host(ws: WebSocket, pubB64: string): void {
    const pub = new Uint8Array(Buffer.from(pubB64, 'base64'));
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    let room = '';
    ws.send(JSON.stringify({ t: 'challenge', nonce: Buffer.from(nonce).toString('base64') }));
    ws.on('message', async (data, isBinary) => {
      if (this.muted.has(ws)) return;
      if (!isBinary) {
        const msg = JSON.parse(data.toString()) as { t: string; sig: string; ticket?: string };
        this.tickets.push(msg.ticket);
        const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
        // the context string, then the nonce: exactly what the real relay verifies
        const ok = await crypto.subtle.verify('Ed25519', key, Buffer.from(msg.sig, 'base64'), challengeMessage(nonce));
        if (!ok) { ws.send(JSON.stringify({ t: 'error', reason: 'bad_signature' })); ws.close(); return; }
        room = roomIdForPublicKey(pub);
        // another socket proved the same key: the old one is closed as replaced, as the real relay does
        const old = this.hosts.get(room);
        if (old && old !== ws) old.close(4009, 'replaced');
        this.hosts.set(room, ws);
        this.claims += 1;
        ws.send(JSON.stringify({ t: 'ready', room }));
        return;
      }
      const bytes = toU8(data);
      const f = decodeRelayFrame(bytes);
      if (!f) return;
      if (f.type === RelayFrame.PING) { if (this.echo) ws.send(bytes); return; }
      const phone = this.phones.get(f.streamId);
      if (!phone) return;
      if (f.type === RelayFrame.DATA) { this.maxData = Math.max(this.maxData, f.payload.length); phone.ws.send(f.payload); }
      if (f.type === RelayFrame.CLOSE) { this.phones.delete(f.streamId); phone.ws.close(); }
    });
    ws.on('close', () => {
      if (this.hosts.get(room) === ws) this.hosts.delete(room);
      for (const [id, p] of this.phones) if (p.room === room) { this.phones.delete(id); p.ws.close(); }
    });
  }
  private join(ws: WebSocket, room: string, ip: string): void {
    const host = this.hosts.get(room);
    if (!host) { ws.send(JSON.stringify({ t: 'no_host' })); ws.close(); return; }
    const id = this.next++;
    this.phones.set(id, { ws, room });
    host.send(encodeRelayFrame(RelayFrame.OPEN, id, new TextEncoder().encode(ip)));
    ws.send(JSON.stringify({ t: 'ready' }));
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const bytes = toU8(data);
      this.maxData = Math.max(this.maxData, bytes.length);
      host.send(encodeRelayFrame(RelayFrame.DATA, id, bytes));
    });
    ws.on('close', () => { if (this.phones.delete(id)) host.send(encodeRelayFrame(RelayFrame.CLOSE, id)); });
  }
  /** Drop every host socket (the relay restarting). */
  dropHosts(): void { for (const ws of this.hosts.values()) ws.terminate(); }
  /** Stop for a deploy as the real relay does: every host closed with 1012 and how long to spread its return over. */
  restartHosts(seconds: number): void { for (const ws of this.hosts.values()) ws.close(1012, `restart ${seconds}`); }
  /** Every host socket goes silent without closing (the relay lost the room, the network went half-open). */
  mute(): void { for (const ws of this.hosts.values()) this.muted.add(ws); }
  close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

/** A relay replaying recorded bytes on a new stream of the room: what comes back, and whether the Mac closed it. */
async function replay(relayUrl: string, room: string, messages: Uint8Array[]): Promise<{ got: Uint8Array[]; closed: boolean }> {
  const ws = new WebSocket(`${relayUrl}/join/${room}`);
  const got: Uint8Array[] = [];
  let closed = false;
  ws.on('message', (data, isBinary) => {
    if (!isBinary) { if ((JSON.parse(data.toString()) as { t: string }).t === 'ready') for (const m of messages) ws.send(m); return; }
    got.push(toU8(data));
  });
  ws.on('close', () => { closed = true; });
  await until(() => closed, 3000).catch(() => undefined);
  if (!closed) ws.close();
  return { got, closed };
}

function makeCore(root: string, relay: FakeRelay, extra: Partial<CoreDeps> = {}): Core {
  const core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-pc', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    connect: { relayUrl: relay.url, spreadMs: 0 },
    ...extra,
  });
  cores.push(core);
  return core;
}

const until = async (test: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

async function newRelay(): Promise<FakeRelay> { const r = new FakeRelay(); relays.push(r); await r.listening; return r; }

describe('AppuBot Connect', () => {
  it('does nothing until a phone pairs; then a phone pairs and talks to the gateway through the relay', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay);
    await core.start();
    expect(core.services.connect.info().state).toBe('off');
    expect(relay.hosts.size).toBe(0);

    // a pairing in progress wants Connect: the QR carries the room and the key, and the computer claims its room
    const info = await core.services.devices.startPairing(120);
    expect(info.connectId).toMatch(/^[a-z2-7]{26}$/);
    expect(fromBase64Url(info.connectKey!)?.length).toBe(32);
    expect(info.url).toContain(`r=${info.connectId}`);
    await until(() => core.services.connect.info().state === 'up');
    expect(relay.hosts.has(info.connectId!)).toBe(true);
    expect(core.services.system.info().connect).toMatchObject({ state: 'up', connectId: info.connectId, connectKey: info.connectKey });
    expect(core.services.system.candidates().some((c) => (c.kind as string) === 'connect')).toBe(false);

    // the identity is on disk, private
    const file = JSON.parse(readFileSync(join(core.ctx.paths.dataDir, 'connect.json'), 'utf8')) as { identity: { ed: string; x: string } };
    expect(file.identity.ed).toBeTruthy();

    // the phone pairs from "anywhere": its own address reaches the gateway, the route is connect
    const phone = await TestPhone.join(relay.url, info.connectId!, info.connectKey!, '203.0.113.9');
    expect((await phone.request('GET', '/api/health')).status).toBe(200);
    const paired = await phone.request('POST', '/api/pair', { code: info.code, device: { id: 'p-iphone', name: 'iPhone', platform: 'ios' } });
    expect(paired.status).toBe(200);
    const { token, deviceId } = paired.json as { token: string; deviceId: string };
    expect(core.services.devices.list()[0]).toMatchObject({ id: deviceId, name: 'iPhone', route: 'connect', lastIp: '203.0.113.9' });

    // the gateway WebSocket through the channel: hello with a snapshot
    phone.send(Msg.WS_OPEN, 50, jsonBytes({ path: '/ws' }));
    await phone.next((m) => m.kind === Msg.WS_OPEN && m.id === 50);
    phone.send(Msg.WS_TEXT, 50, textBytes(JSON.stringify({ type: 'connect', token, device: { id: deviceId, name: 'iPhone', platform: 'ios', appVersion: '1' } })));
    const hello = await phone.next((m) => m.kind === Msg.WS_TEXT && m.id === 50);
    expect(bytesText(hello.payload)).toContain('"hello"');
    await until(() => core.services.devices.list()[0]?.online === true);

    // a file the phone may fetch with its token: an unknown one is a plain 404 through the relay, not an error
    expect((await phone.request('GET', `/files/nope?token=${token}`)).status).toBe(404);
    phone.close();
  });

  it('a 9 MB upload and its download cross the channel whole, in chunks, a window at a time', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay);
    await core.start();
    const info = await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    const phone = await TestPhone.join(relay.url, info.connectId!, info.connectKey!);
    const paired = await phone.request('POST', '/api/pair', { code: info.code, device: { id: 'x', name: 'iPhone', platform: 'ios' } });
    const { token } = paired.json as { token: string };

    // the multipart body the phone builds by hand for an upload: more than two windows, so it waits for the Mac's acks
    const data = new Uint8Array(CHANNEL_WINDOW * 2 + 123).map((_, i) => (i * 31 + (i >> 9)) & 0xff);
    const form = new FormData();
    form.append('file', new Blob([data], { type: 'application/octet-stream' }), 'big.bin');
    const req = new Request('http://x/api/files', { method: 'POST', body: form });
    const body = new Uint8Array(await req.arrayBuffer());
    const up = await phone.requestRaw('POST', '/api/files', body, { 'content-type': req.headers.get('content-type')!, authorization: `Bearer ${token}` });
    expect(up.status).toBe(200);
    const file = JSON.parse(up.body.toString('utf8')) as { url: string };

    const down = await phone.requestRaw('GET', `${file.url}${file.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`, undefined);
    expect(down.status).toBe(200);
    expect(down.body.length).toBe(data.length);
    // the declared length crosses too, so the phone can tell an answer cut short
    expect(down.headers['content-length']).toBe(String(data.length));
    expect(Buffer.compare(down.body, Buffer.from(data))).toBe(0);
    // no message on the relay was bigger than the channel's frame limit
    expect(relay.maxData).toBeLessThanOrEqual(CHANNEL_FRAME_MAX);
    // and nothing is left held for the gateway
    expect(core.services.connect.held).toBe(0);
    phone.close();
  });

  it('a recorded stream replayed on a new stream opens nothing and runs nothing', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay);
    await core.start();
    const info = await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    const phone = await TestPhone.join(relay.url, info.connectId!, info.connectKey!);
    const paired = await phone.request('POST', '/api/pair', { code: info.code, device: { id: 'x', name: 'iPhone', platform: 'ios' } });
    const { token } = paired.json as { token: string };
    // the relay records a whole stream: the hello and an upload with the device token in it
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' }), 'a.bin');
    const req = new Request('http://x/api/files', { method: 'POST', body: form });
    const up = await phone.requestRaw('POST', '/api/files', new Uint8Array(await req.arrayBuffer()), { 'content-type': req.headers.get('content-type')!, authorization: `Bearer ${token}` });
    expect(up.status).toBe(200);
    const recorded = phone.sent.slice();
    expect(core.services.files.list()).toHaveLength(1);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { got, closed } = await replay(relay.url, info.connectId!, recorded);
    // the Mac answered the replayed hello with a fresh key of its own, so the recorded messages didn't open: it dropped
    // the stream at the first one, and not one request reached the gateway
    expect(got).toHaveLength(1);
    expect(got[0]![0]).toBe(CHANNEL_VERSION);
    expect(Buffer.from(got[0]!.subarray(1, 33))).not.toEqual(Buffer.from(phone.reply!.subarray(1, 33)));
    expect(closed).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(core.services.files.list()).toHaveLength(1);
    // the real phone is unaffected
    expect((await phone.request('GET', '/api/health')).status).toBe(200);
    phone.close();
  });

  it('a malformed hello or another version ends that stream only, without an error', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay);
    await core.start();
    const info = await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    // a small-order key (no shared secret), junk, and earlier versions' hellos (1, and 2: ChaCha20-Poly1305)
    const zero = await replay(relay.url, info.connectId!, [helloFrame(new Uint8Array(32))]);
    expect(zero).toEqual({ got: [], closed: true });
    const junk = await replay(relay.url, info.connectId!, [new Uint8Array([CHANNEL_VERSION, 1, 2])]);
    expect(junk).toEqual({ got: [], closed: true });
    for (const v of [1, 2]) {
      const hello = helloFrame(createEphemeralKeypair().public);
      hello[0] = v;
      const old = await replay(relay.url, info.connectId!, [hello]);
      // it says which version it speaks, so a phone can ask for an update
      expect(old.got.map((b) => [...b])).toEqual([[CHANNEL_VERSION]]);
      expect(old.closed).toBe(true);
    }
    expect(core.services.connect.info().state).toBe('up');
    const phone = await TestPhone.join(relay.url, info.connectId!, info.connectKey!);
    expect((await phone.request('GET', '/api/health')).status).toBe(200);
    phone.close();
  });

  it('long gateway frames cross in pieces both ways', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay);
    await core.start();
    const info = await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    const phone = await TestPhone.join(relay.url, info.connectId!, info.connectKey!);
    const paired = await phone.request('POST', '/api/pair', { code: info.code, device: { id: 'p', name: 'iPhone', platform: 'ios' } });
    const { token, deviceId } = paired.json as { token: string; deviceId: string };
    phone.send(Msg.WS_OPEN, 7, jsonBytes({ path: '/ws' }));
    await phone.next((m) => m.kind === Msg.WS_OPEN && m.id === 7);
    phone.sendText(7, JSON.stringify({ type: 'connect', token, device: { id: deviceId, name: 'iPhone', platform: 'ios', appVersion: '1' } }));
    expect(await phone.nextText(7)).toContain('"hello"');
    let bot = core.services.bots.list()[0];
    if (!bot) bot = await core.services.bots.create({ name: 'Appu' } as never);
    // a memory bigger than three channel messages, there and back
    const memory = `# Memory\n${'remember this, नमस्ते. '.repeat(30_000)}`;
    expect(Buffer.byteLength(memory)).toBeGreaterThan(CHANNEL_CHUNK * 3);
    phone.sendText(7, JSON.stringify({ type: 'req', id: 's', method: 'bots.memory.set', params: { id: bot.id, memory } }));
    expect(await phone.nextRes(7, 's')).toMatchObject({ ok: true });
    phone.sendText(7, JSON.stringify({ type: 'req', id: 'g', method: 'bots.memory.get', params: { id: bot.id } }));
    const got = await phone.nextRes(7, 'g') as { result: { memory: string } };
    expect(got.result.memory).toBe(memory);
    expect(relay.maxData).toBeLessThanOrEqual(CHANNEL_FRAME_MAX);
    expect(core.services.connect.held).toBe(0);
    phone.close();
  });

  it('a phone holding more than its share before the gateway takes it is dropped, and too big a body refused', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay, { connect: { relayUrl: relay.url, spreadMs: 0, limits: { streamHold: CHANNEL_CHUNK * 3, requestBody: CHANNEL_CHUNK * 2 } } });
    await core.start();
    const info = await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    // a stranger who knows the room starts a frame that never ends: no token, but the bytes are held until it does
    const a = await TestPhone.join(relay.url, info.connectId!, info.connectKey!);
    a.send(Msg.WS_OPEN, 1, jsonBytes({ path: '/ws' }));
    await a.next((m) => m.kind === Msg.WS_OPEN && m.id === 1);
    for (let i = 0; i < 4; i++) a.send(Msg.WS_MORE, 1, new Uint8Array(CHANNEL_CHUNK));
    await until(() => a.closed);
    expect(core.services.connect.held).toBe(0);
    // a body over the limit is refused, and what it held let go
    const b = await TestPhone.join(relay.url, info.connectId!, info.connectKey!);
    await expect(b.requestRaw('POST', '/api/files', new Uint8Array(CHANNEL_CHUNK * 2 + 1))).rejects.toThrow(/request too large/);
    expect(core.services.connect.held).toBe(0);
    expect((await b.request('GET', '/api/health')).status).toBe(200);
    b.close();
  });

  it('a replayed or tampered message ends that phone only', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay);
    await core.start();
    const info = await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    const a = await TestPhone.join(relay.url, info.connectId!, info.connectKey!);
    const b = await TestPhone.join(relay.url, info.connectId!, info.connectKey!);
    // the relay bouncing the Mac's own READY back to it
    a.replayLastToMac();
    await until(() => a.closed);
    expect((await b.request('GET', '/api/health')).status).toBe(200);
    b.close();
  });

  it('a phone that pinned another key never gets past READY', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay);
    await core.start();
    const info = await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    const wrongKey = Buffer.from(createEphemeralKeypair().public).toString('base64url');
    await expect(TestPhone.join(relay.url, info.connectId!, wrongKey)).rejects.toThrow();
  });

  it('a relay that goes silent is dialled again; one that never echoes isn’t held to it', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay, { connect: { relayUrl: relay.url, spreadMs: 0, pingMs: 40, pingTimeoutMs: 200, probeMs: 100 } });
    await core.start();
    await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    await new Promise((r) => setTimeout(r, 150)); // a few echoed pings
    expect(relay.claims).toBe(1);
    relay.mute();
    await until(() => relay.claims === 2, 3000);
    await until(() => core.services.connect.info().state === 'up');

    // an older relay: no echoes, so silence alone doesn't end the socket
    const old = await newRelay();
    old.echo = false;
    const core2 = makeCore(newRoot(), old, { connect: { relayUrl: old.url, spreadMs: 0, pingMs: 40, pingTimeoutMs: 120 } });
    await core2.start();
    await core2.services.devices.startPairing(120);
    await until(() => core2.services.connect.info().state === 'up');
    await new Promise((r) => setTimeout(r, 500));
    expect(old.claims).toBe(1);
    expect(core2.services.connect.info().state).toBe('up');
  });

  it('a nudge (wake, network change) checks the relay at once, and dials again only if it doesn’t answer', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay, { connect: { relayUrl: relay.url, spreadMs: 0, pingMs: 40, pingTimeoutMs: 60_000, probeMs: 100 } });
    await core.start();
    await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    await new Promise((r) => setTimeout(r, 120)); // the relay has echoed
    core.services.connect.nudge('test');
    await new Promise((r) => setTimeout(r, 250));
    expect(relay.claims).toBe(1);
    // the relay went silent; the long ping timeout would take a minute, the nudge's probe doesn't
    relay.mute();
    core.services.connect.nudge('woke up');
    // seconds at most on a slow CI machine, against the minute the ping timeout would take
    await until(() => relay.claims === 2, 10_000);
    await until(() => core.services.connect.info().state === 'up');
  });

  it('admits Connect traffic as route connect only while Connect runs, and keeps Tailscale and Wi-Fi as they were', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay);
    await core.start();
    const via = { 'x-appubot-connect': '198.51.100.4' };
    expect(await core.gateway.checkPeer('127.0.0.1', via)).toMatchObject({ ok: false, reason: expect.stringContaining('AppuBot Connect') });
    expect(await core.gateway.checkPeer('127.0.0.1', {})).toMatchObject({ ok: true, route: 'local' });
    expect(await core.gateway.checkPeer('192.168.1.30', via)).toMatchObject({ ok: true, route: 'lan' });

    await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    expect(await core.gateway.checkPeer('127.0.0.1', via)).toEqual({ ok: true, route: 'connect', ip: '198.51.100.4', secure: true });
    // a loopback-looking address never passes for this computer; with no address, pairing tries count per stream
    expect(await core.gateway.checkPeer('127.0.0.1', { 'x-appubot-connect': '127.0.0.1' })).toEqual({ ok: true, route: 'connect', ip: 'connect', secure: true, pairKey: 'connect' });
    expect(await core.gateway.checkPeer('127.0.0.1', { 'x-appubot-connect': 'connect', 'x-appubot-stream': 'abc' })).toEqual({ ok: true, route: 'connect', ip: 'connect', secure: true, stream: 'abc', pairKey: 'connect/abc' });
    expect(await core.gateway.checkPeer('127.0.0.1', { 'x-appubot-connect': '127.x.example.com' })).toMatchObject({ ip: 'connect', pairKey: 'connect' });

    // switched off: refused at once, and the room is given up
    await core.services.connect.set(false);
    await until(() => core.services.connect.info().state === 'off' && relay.hosts.size === 0);
    expect((await core.gateway.checkPeer('127.0.0.1', via)).ok).toBe(false);
    await core.services.connect.set(true);
    await until(() => core.services.connect.info().state === 'up');
  });

  it('a relay refusing this computer before the upgrade (429) is waited out, never dialled again at once', async () => {
    const relay = await newRelay();
    relay.refuseHosts = { status: 429, retryAfter: '60' };
    const core = makeCore(newRoot(), relay);
    await core.start();
    await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'error');
    expect(relay.hostDials).toBe(1);
    expect(core.services.connect.info().error).toMatch(/isn’t taking more computers from this network/);
    // the usual backoff would dial again within about a second; a wake doesn't hurry it either
    core.services.connect.nudge('woke up');
    await new Promise((r) => setTimeout(r, 1600));
    expect(relay.hostDials).toBe(1);

    // without a Retry-After it waits the minimum (made short here), then comes up
    const relay2 = await newRelay();
    relay2.refuseHosts = { status: 429 };
    const core2 = makeCore(newRoot(), relay2, { connect: { relayUrl: relay2.url, spreadMs: 0, waits: { refused: 300 } } });
    await core2.start();
    await core2.services.devices.startPairing(120);
    await until(() => relay2.hostDials === 1);
    relay2.refuseHosts = null;
    await until(() => core2.services.connect.info().state === 'up', 4000);
    expect(relay2.hostDials).toBe(2);
  });

  it('runs only while this computer is signed in to AppuBot', async () => {
    const relay = await newRelay();
    const root = newRoot();
    const core = makeCore(root, relay, { accountRequired: true, cloudFetch: async () => new Response('{}', { status: 404 }) });
    await core.start();
    // signed out: no pairing, no relay
    await expect(core.services.devices.startPairing(120)).rejects.toMatchObject({ code: 'sign_in_required' });
    expect(core.services.connect.wanted()).toBe(false);
    // signed in (as the account service does once the browser comes back): pairing, and the relay with it
    (core.services.cloudAccount as unknown as { save(a: object): void }).save({ token: 'session', sealed: false, signedInAt: 1 });
    await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up', 4000);
    // signing out stops it
    await core.services.cloudAccount.signOut();
    await until(() => core.services.connect.info().state === 'off');
  });

  it('another computer with this identity takes the room: this one says so and stays away, no fight over it', async () => {
    const relay = await newRelay();
    const rootA = newRoot();
    const a = makeCore(rootA, relay);
    await a.start();
    const info = await a.services.devices.startPairing(120);
    await until(() => a.services.connect.info().state === 'up');
    // a copy of this computer's AppuBot data on another computer
    const rootB = newRoot();
    mkdirSync(join(rootB, 'data'), { recursive: true });
    copyFileSync(join(rootA, 'data', 'connect.json'), join(rootB, 'data', 'connect.json'));
    const b = makeCore(rootB, relay);
    await b.start();
    expect((await b.services.devices.startPairing(120)).connectId).toBe(info.connectId);
    await until(() => b.services.connect.info().state === 'up');
    await until(() => a.services.connect.info().state === 'error');
    expect(a.services.connect.info().error).toMatch(/Another computer is using this AppuBot Connect identity/);
    const claims = relay.claims;
    a.services.connect.nudge('woke up');
    await new Promise((r) => setTimeout(r, 1600));
    // A waits (minutes, not the usual second), so B keeps the room
    expect(relay.claims).toBe(claims);
    expect(b.services.connect.info().state).toBe('up');
  });

  it('keeps its room across restarts, comes back after the relay drops, and reset makes a new room', async () => {
    const relay = await newRelay();
    const root = newRoot();
    const core = makeCore(root, relay);
    await core.start();
    const info = await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    await core.stop();
    cores.splice(cores.indexOf(core), 1);

    const core2 = makeCore(root, relay);
    await core2.start();
    const again = await core2.services.devices.startPairing(120);
    expect(again.connectId).toBe(info.connectId);
    expect(again.connectKey).toBe(info.connectKey);
    await until(() => core2.services.connect.info().state === 'up');

    // the relay restarts: down, then up again by itself
    relay.dropHosts();
    await until(() => core2.services.connect.info().state !== 'up');
    await until(() => core2.services.connect.info().state === 'up', 6000);

    const st = await core2.services.connect.reset();
    expect(st.connectId).not.toBe(info.connectId);
    await until(() => core2.services.connect.info().state === 'up');
    expect(relay.hosts.has(st.connectId!)).toBe(true);
    expect(relay.hosts.has(info.connectId!)).toBe(false);
  });

  it('a relay restart spreads the return over a few seconds, but a wake dials at once', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay, { connect: { relayUrl: relay.url, spreadMs: 3000 } });
    await core.start();
    await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    expect(relay.hostDials).toBe(1);
    // the most it can wait: backoff 1.5 s + spread 3 s
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    try {
      relay.dropHosts();
      await until(() => core.services.connect.info().state === 'down');
      await new Promise((r) => setTimeout(r, 2000));
      // the usual backoff alone would have dialled by now
      expect(relay.hostDials).toBe(1);
      // the computer woke or its network changed: that one is its own, not everyone's, so it goes now
      core.services.connect.nudge('woke up');
      await until(() => core.services.connect.info().state === 'up', 1500);
      expect(relay.hostDials).toBe(2);
    } finally {
      random.mockRestore();
    }
  });

  it('a relay stopping for a deploy says how long to spread the return over, and that is honoured', async () => {
    const relay = await newRelay();
    // the default spread for a plain drop is off here: only the relay's word spreads this return
    const core = makeCore(newRoot(), relay);
    await core.start();
    await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    try {
      relay.restartHosts(2);
      await until(() => core.services.connect.info().state === 'down');
      // backoff at most 1.5 s, plus up to the 2 s the relay asked for
      await new Promise((r) => setTimeout(r, 2500));
      expect(relay.hostDials).toBe(1);
      await until(() => core.services.connect.info().state === 'up', 2500);
      expect(relay.hostDials).toBe(2);
    } finally {
      random.mockRestore();
    }
  });

  it('someone who only knows the room is let go if it doesn’t sign in; a phone that signs in stays', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay, { connect: { relayUrl: relay.url, spreadMs: 0, stream: { signInMs: 300 } } });
    await core.start();
    const info = await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    // a hello is free to make: without a token the stream is dropped soon after READY
    const stranger = await TestPhone.join(relay.url, info.connectId!, info.connectKey!, '198.51.100.7');
    expect((await stranger.request('GET', '/api/health')).status).toBe(200);
    // a successful pairing counts, and so does the gateway socket signing in
    const phone = await TestPhone.join(relay.url, info.connectId!, info.connectKey!, '203.0.113.9');
    const paired = await phone.request('POST', '/api/pair', { code: info.code, device: { id: 'p', name: 'iPhone', platform: 'ios' } });
    expect(paired.status).toBe(200);
    await until(() => stranger.closed, 3000);
    expect(phone.closed).toBe(false);
    const { token, deviceId } = paired.json as { token: string; deviceId: string };
    expect(await phone.openGateway(3, token, deviceId)).toContain('"ok":true');
    expect(core.services.connect.streams.size).toBe(1);
    phone.close();
  });

  it('bind: loopback is this computer alone: AppuBot Connect stops, its phones are dropped, and it comes back after', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay);
    await core.start();
    const info = await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    const phone = await TestPhone.join(relay.url, info.connectId!, info.connectKey!);
    const { token, deviceId } = (await phone.request('POST', '/api/pair', { code: info.code, device: { id: 'p', name: 'iPhone', platform: 'ios' } })).json as { token: string; deviceId: string };
    expect(await phone.openGateway(3, token, deviceId)).toContain('"ok":true');
    await until(() => core.services.devices.list()[0]?.online === true);

    const g = core.services.settings.get().gateway;
    core.services.settings.update({ gateway: { ...g, bind: 'loopback' } });
    await until(() => core.services.connect.info().state === 'off' && relay.hosts.size === 0 && phone.closed);
    expect(core.services.connect.wanted()).toBe(false);
    expect((await core.gateway.checkPeer('127.0.0.1', { 'x-appubot-connect': '203.0.113.9' })).ok).toBe(false);
    await until(() => core.services.devices.list()[0]?.online === false);
    // a pairing QR then carries the key, never the room
    const again = await core.services.devices.startPairing(120);
    expect(again.connectId).toBeUndefined();

    core.services.settings.update({ gateway: { ...g, bind: 'tailscale' } });
    await until(() => core.services.connect.info().state === 'up' && relay.hosts.size === 1);
  });

  it('the owner’s token opens nothing through the relay; a paired phone’s does', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay);
    await core.start();
    const info = await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    const phone = await TestPhone.join(relay.url, info.connectId!, info.connectKey!);
    expect(await phone.openGateway(1, core.ownerToken, 'desktop')).toContain('"code":"unauthorized"');
    expect((await phone.request('GET', `/files/nope?token=${core.ownerToken}`)).status).toBe(401);
    const { token, deviceId } = (await phone.request('POST', '/api/pair', { code: info.code, device: { id: 'p', name: 'iPhone', platform: 'ios' } })).json as { token: string; deviceId: string };
    expect(await phone.openGateway(2, token, deviceId)).toContain('"ok":true');
    expect((await phone.request('GET', `/files/nope?token=${token}`)).status).toBe(404);
    phone.close();
  });

  it('a phone may read the state but not switch it', async () => {
    const core = makeCore(newRoot(), await newRelay());
    await core.start();
    const { checkRole } = await import('../handlers');
    const cx = { role: 'full' as const, deviceId: 'p1', host: undefined };
    expect(() => checkRole('connect.status', {}, cx as never)).not.toThrow();
    expect(() => checkRole('connect.set', { enabled: false }, cx as never)).toThrow(/not allowed/);
    expect(() => checkRole('connect.reset', {}, cx as never)).toThrow(/not allowed/);
  });
});

/** The real relay on the internet (connect.appubot.com): run with APPUBOT_LIVE_CONNECT=1. */
describe.runIf(process.env.APPUBOT_LIVE_CONNECT === '1')('AppuBot Connect, live relay', () => {
  it('pairs a phone and opens the gateway through connect.appubot.com', async () => {
    const live = process.env.APPUBOT_CONNECT_URL ?? 'wss://connect.appubot.com';
    const relay = { url: live } as FakeRelay;
    const core = makeCore(newRoot(), relay);
    await core.start();
    const info = await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up', 15_000);
    const t0 = Date.now();
    const phone = await TestPhone.join(live, info.connectId!, info.connectKey!);
    const joinMs = Date.now() - t0;
    const t1 = Date.now();
    expect((await phone.request('GET', '/api/health')).status).toBe(200);
    const rttMs = Date.now() - t1;
    const paired = await phone.request('POST', '/api/pair', { code: info.code, device: { id: 'x', name: 'Live phone', platform: 'ios' } });
    expect(paired.status).toBe(200);
    const { token, deviceId } = paired.json as { token: string; deviceId: string };
    phone.send(Msg.WS_OPEN, 9, jsonBytes({ path: '/ws' }));
    await phone.next((m) => m.kind === Msg.WS_OPEN && m.id === 9, 10_000);
    phone.send(Msg.WS_TEXT, 9, textBytes(JSON.stringify({ type: 'connect', token, device: { id: deviceId, name: 'Live phone', platform: 'ios', appVersion: '1' } })));
    const hello = await phone.next((m) => m.kind === Msg.WS_TEXT && m.id === 9, 10_000);
    expect(bytesText(hello.payload)).toContain('"hello"');
    console.log(`live: join ${joinMs} ms, health round trip ${rttMs} ms, device route ${core.services.devices.list()[0]?.route}, ip ${core.services.devices.list()[0]?.lastIp}`);
    phone.close();
  }, 60_000);
});

describe('AppuBot Connect: the relay pass', () => {
  it('answers the challenge with a pass from the account service, kept until it runs low', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay);
    let asked = 0;
    const keys: string[] = [];
    core.services.cloudAccount.connectTicket = async (pub) => { asked++; keys.push(Buffer.from(pub).toString('base64url')); return { ticket: `pass-${asked}`, expiresAt: Date.now() + 7 * 24 * 3600_000 }; };
    await core.start();
    await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    expect(relay.tickets).toEqual(['pass-1']);
    expect(keys[0]).toBe(Buffer.from(core.services.connect.identity().edPublic).toString('base64url'));
    // the relay restarts: the computer comes back with the same pass, not a new fetch
    relay.dropHosts();
    await until(() => relay.tickets.length === 2);
    expect(relay.tickets[1]).toBe('pass-1');
    expect(asked).toBe(1);
  });

  it('without a pass (signed out, an older backend) it still answers, with none', async () => {
    const relay = await newRelay();
    const core = makeCore(newRoot(), relay);
    core.services.cloudAccount.connectTicket = async () => null;
    await core.start();
    await core.services.devices.startPairing(120);
    await until(() => core.services.connect.info().state === 'up');
    expect(relay.tickets).toEqual([undefined]);
  });
});

