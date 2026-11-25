/**
 * What the channel (SECURE_PATH, AppuBot Connect) costs a stranger, and what it holds: a stream must prove it's a
 * paired phone soon after READY (its WebSocket signs in, or a request with its token succeeds) or it is let go, an idle
 * one is let go too, a request body that stops coming frees its place; an address gets a few channel sockets at once and
 * a few new ones a minute; `/api/pair` reads small bodies only and counts tries per address (an IPv6 /64 as one), an
 * upload without a token is refused before its body is read; a phone that falls behind has its gateway sockets paused
 * (so the gateway's own guards see the backlog), and read again once it catches up; a stream's keys go with it.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import {
  CONNECT_PEER_HEADER, Msg, SECURE_PEER_HEADER, SecureChannel, bytesText, jsonBytes, textBytes,
  type ChannelMessage,
} from '@appubot/protocol';
import { Auth, MAX_PAIR_FAILURES, MAX_PAIR_FAILURES_TOTAL } from './auth';
import { createCore, type Core } from './app';
import type { CoreDeps } from './context';
import type { Store } from './store';
import { LinkPhone, TestPhone } from './testing/channelPhone';
import { FakeRuntime } from './testing/fakeRuntime';
import { silentLogger } from './util';

const cores: Core[] = [];
const roots: string[] = [];
const phones: TestPhone[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of phones.splice(0)) p.close();
  for (const c of cores.splice(0)) await c.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** `stream`: the phone streams' deadlines (no relay: nothing here pairs, so Connect never dials). */
function makeCore(stream?: NonNullable<CoreDeps['connect']>['stream']): Core {
  const root = mkdtempSync(join(tmpdir(), 'appubot-channel-'));
  roots.push(root);
  const core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    ...(stream ? { connect: { relayUrl: 'ws://127.0.0.1:9', stream } } : {}),
  });
  cores.push(core);
  return core;
}

const until = async (test: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function directPhone(core: Core): Promise<TestPhone> {
  const p = await TestPhone.direct(`ws://127.0.0.1:${core.gateway.port}/secure`, core.services.connect.key());
  phones.push(p);
  return p;
}

/** A plain WebSocket upgrade to `path`: the status it was refused with, or 101 (the socket, left open). */
function upgrade(url: string): Promise<{ status: number; ws: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('unexpected-response', (_req, res) => { resolve({ status: res.statusCode ?? 0, ws }); ws.terminate(); });
    ws.on('open', () => resolve({ status: 101, ws }));
    ws.on('error', () => undefined);
  });
}

const uploadForm = async (bytes: Uint8Array<ArrayBuffer>) => {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), 'note.bin');
  const req = new Request('http://x/api/files', { method: 'POST', body: form });
  return { body: new Uint8Array(await req.arrayBuffer()), type: req.headers.get('content-type')! };
};

describe('a channel stream proves itself, or is let go', () => {
  it('one that never signs in is dropped soon after READY; one whose WebSocket signs in stays', async () => {
    const core = makeCore({ signInMs: 300, idleMs: 60_000, bodyMs: 60_000 });
    await core.start();
    // a stranger on the Wi-Fi (or one who knows the room): the hello is free to make, the health check needs nothing
    const stranger = await directPhone(core);
    expect((await stranger.request('GET', '/api/health')).status).toBe(200);
    // a wrong token doesn't count either
    const wrong = await directPhone(core);
    expect(await wrong.openGateway(1, 'not-a-token', 'x')).toContain('"ok":false');
    const phone = await directPhone(core);
    expect(await phone.openGateway(1, core.ownerToken, 'owner')).toContain('"ok":true');
    await until(() => stranger.closed && wrong.closed, 3000);
    await sleep(400);
    expect(phone.closed).toBe(false);
    phone.sendText(1, JSON.stringify({ type: 'req', id: 'p', method: 'system.ping', params: {} }));
    expect(await phone.nextRes(1, 'p')).toMatchObject({ ok: true });
    expect(core.services.connect.direct.size).toBe(1);
  });

  it('a request with its token that succeeds counts too; an idle stream is let go after a while', async () => {
    const core = makeCore({ signInMs: 300, idleMs: 900, bodyMs: 60_000 });
    await core.start();
    const phone = await directPhone(core);
    const form = await uploadForm(new Uint8Array([1, 2, 3]));
    // refused uploads (no token) don't count
    expect((await phone.requestRaw('POST', '/api/files', form.body, { 'content-type': form.type })).status).toBe(401);
    expect((await phone.requestRaw('POST', '/api/files', form.body, { 'content-type': form.type, authorization: `Bearer ${core.ownerToken}` })).status).toBe(200);
    await sleep(500);
    expect(phone.closed).toBe(false);
    // nothing open and nothing said: let go
    await until(() => phone.closed, 3000);
    expect(core.services.connect.direct.size).toBe(0);
    expect(core.services.connect.held).toBe(0);
  });

  it('a request whose body stops coming frees its place; a request that never ends its head does too', async () => {
    const core = makeCore({ signInMs: 60_000, idleMs: 60_000, bodyMs: 300 });
    await core.start();
    const phone = await directPhone(core);
    expect(await phone.openGateway(1, core.ownerToken, 'owner')).toContain('"ok":true');
    // an upload that sends one piece and then nothing
    phone.send(Msg.HTTP_REQ, 7, jsonBytes({ method: 'POST', path: '/api/files', headers: { 'content-type': 'multipart/form-data; boundary=x', authorization: `Bearer ${core.ownerToken}` } }));
    phone.send(Msg.HTTP_REQ_BODY, 7, textBytes('--x\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\n'));
    // and a GET whose end never comes
    phone.send(Msg.HTTP_REQ, 8, jsonBytes({ method: 'GET', path: '/api/health', headers: {} }));
    const errs = await Promise.all([7, 8].map((id) => phone.next((m: ChannelMessage) => m.id === id && m.kind === Msg.HTTP_ERR, 3000)));
    expect(errs.map((m) => bytesText(m.payload))).toEqual([expect.stringContaining('stopped coming'), expect.stringContaining('stopped coming')]);
    expect(core.services.connect.held).toBe(0);
    // the stream itself goes on
    expect(phone.closed).toBe(false);
    expect((await phone.request('GET', '/api/health')).status).toBe(200);
  });
});

describe('what an address may ask of the channel and of pairing', () => {
  it('a few channel sockets per address at once, and a few new ones a minute', async () => {
    const core = makeCore();
    await core.start();
    const url = `ws://127.0.0.1:${core.gateway.port}/secure`;
    const open: WebSocket[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await upgrade(url);
      expect(r.status).toBe(101);
      open.push(r.ws);
    }
    // the ninth from the same address waits for one of them to go
    expect((await upgrade(url)).status).toBe(429);
    for (const ws of open) ws.close();
    await until(() => core.services.connect.direct.size === 0);
    let admitted = 8;
    let refused = false;
    for (let i = 0; i < 40 && !refused; i++) {
      const r = await upgrade(url);
      if (r.status === 101) { admitted += 1; r.ws.close(); await until(() => core.services.connect.direct.size === 0); } else { expect(r.status).toBe(429); refused = true; }
    }
    expect(refused).toBe(true);
    expect(admitted).toBe(30);
  });

  it('/api/pair reads a few KB at most, and its tries count per address, an IPv6 /64 as one', async () => {
    const core = makeCore();
    await core.start();
    const base = `http://127.0.0.1:${core.gateway.port}`;
    const big = JSON.stringify({ code: '123456', device: { id: 'p', name: 'x'.repeat(20_000), platform: 'ios' } });
    expect((await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big })).status).toBe(413);
    // with no declared length (chunked, as the channel replays every body): refused once it passes the limit
    const pieces = (n: number) => {
      let left = n;
      return new ReadableStream<Uint8Array>({ pull: (c) => { if (left-- > 0) c.enqueue(new Uint8Array(4096).fill(32)); else c.close(); } }, { highWaterMark: 0 });
    };
    const chunked = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: pieces(16), duplex: 'half' } as RequestInit);
    expect(chunked.status).toBe(413);
    // an upload without a token is refused before its body is measured (which reads a chunked one into memory): the
    // answer comes while the body is still on its way
    let pulled = 0;
    const slow = new ReadableStream<Uint8Array>({
      pull: async (c) => { await sleep(5); if (pulled++ < 200) c.enqueue(new Uint8Array(4096)); else c.close(); },
    }, { highWaterMark: 0 });
    expect((await fetch(`${base}/api/files`, { method: 'POST', body: slow, duplex: 'half' } as RequestInit)).status).toBe(401);
    expect(pulled).toBeLessThan(100);

    const g = core.gateway;
    for (let i = 0; i < 20; i++) expect(g.pairAllowed(`2001:db8:1:2::${(i + 1).toString(16)}`)).toBe(true);
    // a fresh address in the same /64 is the same phone (or home)
    expect(g.pairAllowed('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(false);
    expect(g.pairAllowed('2001:db8:1:3::1')).toBe(true);
    expect(g.pairAllowed('203.0.113.9')).toBe(true);
  });

  it('wrong codes count per address: someone else with the QR can’t use up the owner’s pairing', async () => {
    const auth = new Auth({} as Store);
    const { code } = auth.startPairing(120);
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < MAX_PAIR_FAILURES; i++) expect(auth.consumeCode(wrong, '203.0.113.9')).toBe('bad');
    // that address is done with this code, right or wrong
    expect(auth.consumeCode(code, '203.0.113.9')).toBe('blocked');
    expect(auth.consumeCode(wrong, '203.0.113.9')).toBe('blocked');
    // the owner's phone, elsewhere, pairs
    expect(auth.consumeCode(code, '192.168.1.30')).toBe('ok');
    expect(auth.consumeCode(code, '192.168.1.30')).toBe('none');

    // many addresses together still use the code up, in the end
    const next = auth.startPairing(120);
    const bad = next.code === '000000' ? '000001' : '000000';
    for (let i = 0; i < MAX_PAIR_FAILURES_TOTAL; i++) expect(auth.consumeCode(bad, `198.51.100.${Math.floor(i / MAX_PAIR_FAILURES)}`)).toBe('bad');
    expect(auth.pairing).toBeNull();
    expect(auth.consumeCode(next.code, '192.168.1.30')).toBe('none');
  });

  it('through the gateway: five wrong codes from one address don’t end the pairing for another', async () => {
    const core = makeCore();
    await core.start();
    const info = await core.services.devices.startPairing(120);
    const wrong = info.code === '000000' ? '000001' : '000000';
    const pair = (code: string, ip: string) => core.services.devices.pair({ code, device: { id: ip, name: 'Phone', platform: 'ios' } }, ip);
    for (let i = 0; i < MAX_PAIR_FAILURES; i++) expect((await pair(wrong, `2001:db8:5:6::${i + 1}`))[0]).toBe(403);
    const [status, out] = await pair(info.code, '2001:db8:5:6::99');
    expect(status).toBe(403);
    expect(out).toMatchObject({ error: expect.stringMatching(/Too many wrong codes/) });
    expect(core.services.devices.pairingInfo()).not.toBeNull();
    expect((await pair(info.code, '192.168.1.30'))[0]).toBe(200);
  });
});

/** A stand-in for the phone's channel socket (the gateway's SECURE_PATH hands ConnectService one): what the Mac sent, and a backlog to set. */
class FakeChannelSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  send(msg: Uint8Array): void { this.sent.push(new Uint8Array(msg)); }
  close(): void { if (this.readyState === WebSocket.CLOSED) return; this.readyState = WebSocket.CLOSED; this.emit('close'); }
}

/**
 * The same on a slow link: what the Mac sends waits in `bufferedAmount` and reaches the phone (`sent`) at `bytesPerSec`,
 * a whole message at a time, as a socket's send buffer drains.
 */
class SlowChannelSocket extends FakeChannelSocket {
  private queue: Uint8Array[] = [];
  private credit = 0;
  private timer: ReturnType<typeof setInterval>;
  constructor(private bytesPerSec: number) {
    super();
    this.timer = setInterval(() => this.tick(), 5);
  }
  override send(msg: Uint8Array): void {
    const m = new Uint8Array(msg);
    this.queue.push(m);
    this.bufferedAmount += m.length;
  }
  private tick(): void {
    this.credit += this.bytesPerSec / 200;
    while (this.queue.length && this.credit >= this.queue[0]!.length) {
      const m = this.queue.shift()!;
      this.credit -= m.length;
      this.bufferedAmount -= m.length;
      this.sent.push(m);
    }
    if (!this.queue.length) this.credit = 0;
  }
  override close(): void { clearInterval(this.timer); super.close(); }
}
const sockets: FakeChannelSocket[] = [];
afterEach(() => { for (const s of sockets.splice(0)) s.close(); });

/** A paired phone's token, paired from `ip` as a phone on the Wi-Fi would. */
async function deviceToken(core: Core, ip = '192.168.1.30'): Promise<{ token: string; deviceId: string }> {
  const { code } = await core.services.devices.startPairing(120);
  const [status, out] = await core.services.devices.pair({ code, device: { id: `p-${ip}`, name: 'iPhone', platform: 'ios' } }, ip);
  expect(status).toBe(200);
  return out as { token: string; deviceId: string };
}

/** A phone speaking the channel over `sock`, handed to ConnectService from `ip` as the gateway hands a SECURE_PATH socket. */
async function channelPhone(core: Core, sock: FakeChannelSocket, ip = '192.168.1.30'): Promise<LinkPhone> {
  sockets.push(sock);
  core.services.connect.acceptDirect(sock as unknown as WebSocket, ip);
  return new LinkPhone(() => sock.sent, (b) => sock.emit('message', Buffer.from(b), true)).start(core.services.connect.keys.xPublic);
}

const ping = (phone: LinkPhone, id: number, reqId: string) => phone.ping(id, reqId);

describe('a phone that falls behind', () => {
  it('has its gateway sockets paused until it catches up, so the gateway sees the backlog; its keys go with the stream', async () => {
    const core = makeCore();
    await core.start();
    const { token, deviceId } = await deviceToken(core);
    const sock = new FakeChannelSocket();
    const phone = await channelPhone(core, sock);
    expect(await phone.signIn(1, token, deviceId)).toContain('"ok":true');

    const pause = vi.spyOn(WebSocket.prototype, 'pause');
    const resume = vi.spyOn(WebSocket.prototype, 'resume');
    // the phone's socket is 2 MB behind: the next frame for it stops its gateway socket being read
    sock.bufferedAmount = 2 * 1024 * 1024;
    ping(phone, 1, 'a');
    expect(await phone.nextRes(1, 'a')).toMatchObject({ ok: true });
    await until(() => pause.mock.calls.length === 1);
    // what the gateway sends meanwhile waits on its side, not here
    ping(phone, 1, 'b');
    await sleep(150);
    phone.take();
    expect(phone.inbox.filter((m) => m.kind === Msg.WS_TEXT)).toHaveLength(0);
    expect(resume).not.toHaveBeenCalled();
    // caught up: read again, and the answer comes
    sock.bufferedAmount = 0;
    expect(await phone.nextRes(1, 'b')).toMatchObject({ ok: true });
    expect(resume).toHaveBeenCalledTimes(1);

    const close = vi.spyOn(SecureChannel.prototype, 'close');
    sock.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(core.services.connect.direct.size).toBe(0);
  });

  it('a download on a slow link never keeps the phone’s chat paused: answers come at once, long before it ends', async () => {
    const core = makeCore();
    await core.start();
    const { token, deviceId } = await deviceToken(core);
    const big = new Uint8Array(16 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big[i] = (i >> 12) & 0xff;
    const file = core.services.files.upload(big, 'big.bin', 'application/octet-stream');
    // 8 MB a second: the 16 MB take two seconds
    const sock = new SlowChannelSocket(8 * 1024 * 1024);
    const phone = await channelPhone(core, sock);
    expect(await phone.signIn(1, token, deviceId)).toContain('"ok":true');
    let done = false;
    const download = phone.get(2, file.url, token).then((r) => { done = true; return r; });
    await sleep(250);
    for (const id of ['a', 'b', 'c', 'd']) {
      const t0 = Date.now();
      ping(phone, 1, id);
      expect(await phone.nextRes(1, id, 1500)).toMatchObject({ ok: true });
      expect(Date.now() - t0).toBeLessThan(800);
      // the download never fills the link past what chat waits behind
      expect(sock.bufferedAmount).toBeLessThan(1024 * 1024);
    }
    expect(done).toBe(false);
    const got = await download;
    expect(got.status).toBe(200);
    expect(Buffer.compare(got.body, Buffer.from(big))).toBe(0);
    expect(core.services.connect.held).toBe(0);
  });

  it('a gateway socket opened while the phone is behind is read until its sign-in is answered', async () => {
    const core = makeCore();
    await core.start();
    const { token, deviceId } = await deviceToken(core);
    const sock = new FakeChannelSocket();
    const phone = await channelPhone(core, sock);
    expect(await phone.signIn(1, token, deviceId)).toContain('"ok":true');
    // behind: socket 1's next answer pauses the phone's sockets
    sock.bufferedAmount = 2 * 1024 * 1024;
    ping(phone, 1, 'a');
    expect(await phone.nextRes(1, 'a')).toMatchObject({ ok: true });
    await sleep(50);
    // a reconnect meanwhile: its sign-in is answered (else the phone would time out and try again, and again)
    expect(await phone.signIn(2, token, deviceId, 2000)).toContain('"ok":true');
    // from then on it waits with the others until the phone catches up
    ping(phone, 2, 'b');
    await sleep(150);
    phone.take();
    expect(phone.inbox.filter((m) => m.kind === Msg.WS_TEXT && bytesText(m.payload).includes('"id":"b"'))).toHaveLength(0);
    sock.bufferedAmount = 0;
    expect(await phone.nextRes(2, 'b')).toMatchObject({ ok: true });
  });

  it('the gateway’s heartbeat doesn’t take a socket paused for the phone’s backlog for dead', async () => {
    const core = makeCore();
    await core.start();
    const { token, deviceId } = await deviceToken(core);
    const sock = new FakeChannelSocket();
    const phone = await channelPhone(core, sock);
    expect(await phone.signIn(1, token, deviceId)).toContain('"ok":true');
    await until(() => core.gateway.onlineDevices().has(deviceId));
    await sleep(50); // the first ping's answer
    sock.bufferedAmount = 2 * 1024 * 1024;
    ping(phone, 1, 'a');
    expect(await phone.nextRes(1, 'a')).toMatchObject({ ok: true });
    await sleep(50);
    const beat = () => (core.gateway as unknown as { ping(): void }).ping();
    // two heartbeats with no answer (the socket isn't read): still there
    beat();
    await sleep(50);
    beat();
    await sleep(100);
    expect(core.gateway.onlineDevices().has(deviceId)).toBe(true);
    // caught up: it answers, and is held to the heartbeat again
    sock.bufferedAmount = 0;
    await sleep(100);
    beat();
    await sleep(100);
    beat();
    await sleep(50);
    expect(core.gateway.onlineDevices().has(deviceId)).toBe(true);
    ping(phone, 1, 'b');
    expect(await phone.nextRes(1, 'b')).toMatchObject({ ok: true });
  });
});

describe('the owner’s token is this computer’s alone', () => {
  it('the owner’s and the bots’ tokens count only from this computer; a paired device’s from anywhere admitted', () => {
    const hash = 'h';
    const auth = new Auth({ devices: { get: () => ({ devices: [{ id: 'd1', role: 'full', tokenHash: hash }], revoked: [] }) } } as unknown as Store);
    const agent = auth.issueAgentToken({ threadId: 't', botId: 'b' });
    expect(auth.verify(auth.ownerToken, 'local')).toMatchObject({ kind: 'owner' });
    expect(auth.verify(agent, 'local')).toMatchObject({ kind: 'agent' });
    for (const route of ['lan', 'tailscale', 'connect'] as const) {
      expect(auth.verify(auth.ownerToken, route), route).toEqual({ kind: 'invalid' });
      expect(auth.verify(agent, route), route).toEqual({ kind: 'invalid' });
    }
  });

  it('through the channel from the Wi-Fi it is no token: a paired phone’s is', async () => {
    const core = makeCore();
    await core.start();
    const { token, deviceId } = await deviceToken(core);
    const att = core.services.files.upload(new Uint8Array([1, 2, 3]), 'a.bin', 'application/octet-stream');
    const phone = await channelPhone(core, new FakeChannelSocket());
    const hello = await phone.signIn(1, core.ownerToken, 'desktop');
    expect(hello).toContain('"ok":false');
    expect(hello).toContain('unauthorized');
    expect((await phone.get(2, `${att.url}?token=${encodeURIComponent(core.ownerToken)}`, 'nope')).status).toBe(401);
    expect((await phone.get(3, att.url, core.ownerToken)).status).toBe(401);
    expect((await phone.get(4, att.url, token)).status).toBe(200);
    expect(await phone.signIn(5, token, deviceId)).toContain('"ok":true');
    // on this computer itself it works as ever
    const res = await fetch(`http://127.0.0.1:${core.gateway.port}${att.url}?token=${encodeURIComponent(core.ownerToken)}`);
    expect(res.status).toBe(200);
  });
});

describe('the channel over Tailscale', () => {
  it('a phone with the key pairs and connects through SECURE_PATH from its Tailscale address, checked with whois', async () => {
    const core = makeCore();
    await core.start();
    const info = await core.services.devices.startPairing(120);
    // the channel socket comes from a Tailscale address (its replays are judged by it, through the real check)
    const real = core.gateway.checkPeer.bind(core.gateway);
    vi.spyOn(core.gateway, 'checkPeer').mockImplementation((rawIp, headers = {}) => real(headers[SECURE_PEER_HEADER] ? rawIp : '100.101.12.44', headers));
    const whois = vi.spyOn(core.services.tailscale, 'whois').mockResolvedValue('me@example.com');
    const phone = await directPhone(core);
    const paired = await phone.request('POST', '/api/pair', { code: info.code, device: { id: 'p', name: 'iPhone', platform: 'ios' } });
    expect(paired.status).toBe(200);
    expect(whois).toHaveBeenCalledWith('100.101.12.44');
    const { token, deviceId } = paired.json as { token: string; deviceId: string };
    expect(await phone.openGateway(1, token, deviceId)).toContain('"ok":true');
    await until(() => core.services.devices.list()[0]?.online === true);
    expect(core.services.devices.list()[0]).toMatchObject({ route: 'tailscale', lastIp: '100.101.12.44', tailscaleUser: 'me@example.com' });

    // an address in Tailscale's range that isn't a tailnet node (a network routing 100.64/10 itself) gets no channel
    whois.mockResolvedValue(null);
    vi.spyOn(core.gateway, 'checkPeer').mockImplementation((rawIp, headers = {}) => real(headers[SECURE_PEER_HEADER] ? rawIp : '100.101.99.99', headers));
    expect((await upgrade(`ws://127.0.0.1:${core.gateway.port}/secure`)).status).toBe(403);
  });
});

describe('bind: loopback admits this computer alone', () => {
  it('no channel socket, no replayed phone: only this computer', async () => {
    const core = makeCore();
    await core.start();
    const g = core.services.settings.get().gateway;
    const phone = await directPhone(core);
    expect(await phone.openGateway(1, core.ownerToken, 'owner')).toContain('"ok":true');
    core.services.settings.update({ gateway: { ...g, bind: 'loopback' } });
    // the phone on the Wi-Fi is cut off, and its channel can't open again
    await until(() => phone.closed);
    expect((await upgrade(`ws://127.0.0.1:${core.gateway.port}/secure`)).status).toBe(403);
    expect((await core.gateway.checkPeer('127.0.0.1', { [SECURE_PEER_HEADER]: '192.168.1.30' })).ok).toBe(false);
    expect((await core.gateway.checkPeer('127.0.0.1', { [SECURE_PEER_HEADER]: '127.0.0.1' })).ok).toBe(false);
    expect((await core.gateway.checkPeer('127.0.0.1', { [CONNECT_PEER_HEADER]: '198.51.100.4' })).ok).toBe(false);
    expect(await core.gateway.checkPeer('127.0.0.1', {})).toEqual({ ok: true, route: 'local', ip: '127.0.0.1' });
    core.services.settings.update({ gateway: { ...g, bind: 'tailscale' } });
    expect((await directPhone(core)).closed).toBe(false);
  });
});
