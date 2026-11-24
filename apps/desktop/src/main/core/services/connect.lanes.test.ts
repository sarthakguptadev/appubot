/**
 * How the phones share what goes out to them, and who keeps a place when they are many: answer bodies take turns on a
 * socket (`BulkLane`) and fill it only while chat has room, so one phone's download over the relay never holds up another
 * phone's chat; a full pool makes room by letting go of a stream that hasn't signed in yet (`evictee`), the relay's and
 * the channel's own sockets alike, the local network's and Tailscale's apart.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { RelayFrame, decodeRelayFrame, encodeRelayFrame, textBytes } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { LinkPhone } from '../testing/channelPhone';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { BulkLane, evictee, type ConnectService } from './connect';

const cores: Core[] = [];
const roots: string[] = [];
const links: { close(): void }[] = [];
afterEach(async () => {
  for (const l of links.splice(0)) l.close();
  for (const c of cores.splice(0)) await c.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeCore(): Core {
  const root = mkdtempSync(join(tmpdir(), 'appubot-lanes-'));
  roots.push(root);
  const core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
  });
  cores.push(core);
  return core;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (test: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error('timed out'); await sleep(5); }
};

async function deviceToken(core: Core, ip: string): Promise<{ token: string; deviceId: string }> {
  const { code } = await core.services.devices.startPairing(120);
  const [status, out] = await core.services.devices.pair({ code, device: { id: `p-${ip}`, name: 'iPhone', platform: 'ios' } }, ip);
  expect(status).toBe(200);
  return out as { token: string; deviceId: string };
}

/**
 * The relay's host socket on a slow uplink, in place of the real one: what the Mac sends waits in `bufferedAmount` and
 * reaches the relay at `bytesPerSec`, whose DATA frames go to each phone (`toPhone`), CLOSE frames are noted.
 */
class SlowRelaySocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly toPhone = new Map<number, Uint8Array[]>();
  readonly closedStreams = new Set<number>();
  private queue: Uint8Array[] = [];
  private credit = 0;
  private timer: ReturnType<typeof setInterval>;
  constructor(private bytesPerSec: number) {
    this.timer = setInterval(() => this.tick(), 5);
  }
  send(frame: Uint8Array): void {
    const m = new Uint8Array(frame);
    if (this.bytesPerSec === Infinity) { this.arrive(m); return; }
    this.queue.push(m);
    this.bufferedAmount += m.length;
  }
  private tick(): void {
    this.credit += this.bytesPerSec / 200;
    while (this.queue.length && this.credit >= this.queue[0]!.length) {
      const m = this.queue.shift()!;
      this.credit -= m.length;
      this.bufferedAmount -= m.length;
      this.arrive(m);
    }
    if (!this.queue.length) this.credit = 0;
  }
  private arrive(m: Uint8Array): void {
    const f = decodeRelayFrame(m);
    if (f?.type === RelayFrame.DATA) {
      const q = this.toPhone.get(f.streamId) ?? [];
      q.push(f.payload);
      this.toPhone.set(f.streamId, q);
    } else if (f?.type === RelayFrame.CLOSE) this.closedStreams.add(f.streamId);
  }
  close(): void { clearInterval(this.timer); this.readyState = WebSocket.CLOSED; }
  terminate(): void { this.close(); }
}

/** What the tests reach inside ConnectService: the relay socket, its frames, and that it runs. */
type Inside = { sock: unknown; running: boolean; onFrame(buf: Uint8Array): void };

/** Connect "up" on `relay` (no real relay: frames are handed in and taken out by the test). */
function onRelay(core: Core, relay: SlowRelaySocket): Inside {
  const svc = core.services.connect as unknown as Inside;
  svc.running = true;
  svc.sock = relay;
  links.push(relay);
  return svc;
}

/** A phone joining through the relay as stream `id`, from `ip`. */
function relayPhone(core: Core, svc: Inside, relay: SlowRelaySocket, id: number, ip: string): Promise<LinkPhone> {
  svc.onFrame(encodeRelayFrame(RelayFrame.OPEN, id, textBytes(ip)));
  return new LinkPhone(() => relay.toPhone.get(id) ?? [], (b) => svc.onFrame(encodeRelayFrame(RelayFrame.DATA, id, b))).start(core.services.connect.keys.xPublic);
}

describe('BulkLane', () => {
  it('phones take turns, a piece each, and only while the socket has room', async () => {
    let backlog = 10 * 1024 * 1024;
    const lane = new BulkLane(() => backlog, 1000);
    const order: string[] = [];
    const a = {};
    const b = {};
    const piece = (who: string) => () => { order.push(who); backlog += 400; };
    const sent = [lane.send(a, piece('a1')), lane.send(a, piece('a2')), lane.send(a, piece('a3')), lane.send(b, piece('b1')), lane.send(b, piece('b2'))];
    await sleep(30);
    expect(order).toEqual([]);
    // room for three pieces (each adds 400, under 1000 after two): a, b, a… in turn
    backlog = 0;
    await sleep(30);
    expect(order).toEqual(['a1', 'b1', 'a2']);
    backlog = 0;
    await sleep(30);
    expect(order).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
    expect(await Promise.all(sent)).toEqual([true, true, true, true, true]);
    expect(lane.waiting).toBe(0);
  });

  it('waits while a phone’s chat is paused for the backlog, and a phone that goes takes its pieces with it', async () => {
    const lane = new BulkLane(() => 0, 1000);
    const order: string[] = [];
    const a = {};
    const b = {};
    lane.hold(true);
    const pa = lane.send(a, () => order.push('a'));
    const pb = lane.send(b, () => order.push('b'));
    await sleep(30);
    expect(order).toEqual([]);
    lane.drop(b);
    expect(await pb).toBe(false);
    lane.hold(false);
    expect(await pa).toBe(true);
    expect(order).toEqual(['a']);
    // a piece that throws fails its own sender, and the others go on
    const bad = lane.send(a, () => { throw new Error('sealed nothing'); });
    const good = lane.send(b, () => order.push('b'));
    await expect(bad).rejects.toThrow('sealed nothing');
    expect(await good).toBe(true);
  });
});

describe('evictee', () => {
  const s = (key: string, since: number, proven = false) => ({ key, since, proven });

  it('a stream that hasn’t signed in, from the address holding the most such streams, its oldest', () => {
    const phone = s('203.0.113.9', 1);
    const strangerA = [s('198.51.100.1', 5), s('198.51.100.1', 3), s('198.51.100.1', 9)];
    const strangerB = [s('198.51.100.2', 2), s('198.51.100.2', 4)];
    expect(evictee([phone, ...strangerA, ...strangerB])).toBe(strangerA[1]);
    // equals: the address whose oldest came first
    expect(evictee([phone, strangerB[0]!, strangerB[1]!, strangerA[0]!, strangerA[1]!])).toBe(strangerB[0]);
    // signed-in streams never go; with nothing else, none does
    expect(evictee([s('a', 1, true), s('a', 2, true), phone])).toBe(phone);
    expect(evictee([s('a', 1, true), s('b', 2, true)])).toBeNull();
    expect(evictee([])).toBeNull();
  });
});

describe('the relay’s one socket, shared by every phone', () => {
  it('one phone’s download on a slow uplink never holds up another phone’s chat', async () => {
    const core = makeCore();
    await core.start();
    const a = await deviceToken(core, '203.0.113.9');
    const b = await deviceToken(core, '198.51.100.20');
    const big = new Uint8Array(16 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big[i] = (i >> 12) & 0xff;
    const file = core.services.files.upload(big, 'big.bin', 'application/octet-stream');
    // the Mac's uplink to the relay: 8 MB a second
    const relay = new SlowRelaySocket(8 * 1024 * 1024);
    const svc = onRelay(core, relay);
    const phoneA = await relayPhone(core, svc, relay, 1, '203.0.113.9');
    const phoneB = await relayPhone(core, svc, relay, 2, '198.51.100.20');
    expect(await phoneA.signIn(1, a.token, a.deviceId)).toContain('"ok":true');
    expect(await phoneB.signIn(1, b.token, b.deviceId)).toContain('"ok":true');
    expect(core.services.devices.list().find((d) => d.id === b.deviceId)?.route).toBe('connect');

    let done = false;
    const download = phoneA.get(2, file.url, a.token).then((r) => { done = true; return r; });
    await sleep(250);
    let most = 0;
    const watch = setInterval(() => { most = Math.max(most, relay.bufferedAmount); }, 5);
    // phone B's chat, and phone A's own, answer at once while A's download fills the uplink
    try {
      for (const id of ['a', 'b', 'c']) {
        for (const p of [phoneB, phoneA]) {
          const t0 = Date.now();
          p.ping(1, id);
          expect(await p.nextRes(1, id, 1500)).toMatchObject({ ok: true });
          expect(Date.now() - t0).toBeLessThan(800);
        }
      }
    } finally {
      clearInterval(watch);
    }
    expect(done).toBe(false);
    // the download never filled the uplink past what chat waits behind
    expect(most).toBeLessThan(1024 * 1024);
    const got = await download;
    expect(got.status).toBe(200);
    expect(Buffer.compare(got.body, Buffer.from(big))).toBe(0);
  });

  it('two phones downloading at once share the uplink', async () => {
    const core = makeCore();
    await core.start();
    const a = await deviceToken(core, '203.0.113.9');
    const b = await deviceToken(core, '198.51.100.20');
    const big = new Uint8Array(12 * 1024 * 1024);
    const file = core.services.files.upload(big, 'big.bin', 'application/octet-stream');
    const relay = new SlowRelaySocket(12 * 1024 * 1024);
    const svc = onRelay(core, relay);
    const phoneA = await relayPhone(core, svc, relay, 1, '203.0.113.9');
    const phoneB = await relayPhone(core, svc, relay, 2, '198.51.100.20');
    // A starts first and asks for three copies at once; B asks for one a moment later
    const startA = [2, 3, 4].map((id) => phoneA.get(id, file.url, a.token, 30_000));
    await sleep(300);
    const t0 = Date.now();
    const gotB = await phoneB.get(2, file.url, b.token, 30_000);
    const tookB = Date.now() - t0;
    expect(gotB.body.length).toBe(big.length);
    for (const r of await Promise.all(startA)) expect(r.body.length).toBe(big.length);
    const tookAll = Date.now() - t0;
    // in turn with A's three, B's one gets half the uplink and is done about halfway through; with a quarter of it, it
    // would finish with A's. Timed against the whole, so a slower machine (Windows' runner) moves both alike
    expect(tookB).toBeLessThan(tookAll * 0.75);
  }, 30_000);
});

/** A stand-in for a phone's channel socket (the gateway's SECURE_PATH hands ConnectService one). */
class FakeChannelSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  send(msg: Uint8Array): void { this.sent.push(new Uint8Array(msg)); }
  close(): void { if (this.readyState === WebSocket.CLOSED) return; this.readyState = WebSocket.CLOSED; this.emit('close'); }
}

describe('a full pool makes room for a new phone', () => {
  const proveAll = (streams: Iterable<unknown>) => { for (const s of streams) (s as { vouched(): void }).vouched(); };

  it('the channel’s sockets: one not signed in goes, the stranger’s own first; the Wi-Fi and Tailscale have places apart', async () => {
    const core = makeCore();
    await core.start();
    const connect: ConnectService = core.services.connect;
    const open = (ip: string) => {
      const sock = new FakeChannelSocket();
      links.push(sock);
      connect.acceptDirect(sock as unknown as WebSocket, ip);
      return sock;
    };
    // a phone that signed in, then a stranger on the Wi-Fi with two addresses fills the rest with hellos
    const phone = open('192.168.1.30');
    proveAll(connect.direct);
    const strangers: FakeChannelSocket[] = [];
    for (let i = 0; i < 31; i++) { strangers.push(open(i % 3 ? '192.168.1.66' : '192.168.1.67')); await sleep(1); }
    expect(connect.direct.size).toBe(32);
    // another phone still gets in: the oldest stream of the address with the most goes
    const next = open('192.168.1.31');
    expect(next.readyState).toBe(WebSocket.OPEN);
    expect(strangers[1]!.readyState).toBe(WebSocket.CLOSED);
    expect(phone.readyState).toBe(WebSocket.OPEN);
    expect(connect.direct.size).toBe(32);
    // a phone over Tailscale has places of its own: nobody on the Wi-Fi is let go for it
    const before = strangers.filter((s) => s.readyState === WebSocket.OPEN).length;
    expect(open('100.101.12.44').readyState).toBe(WebSocket.OPEN);
    expect(strangers.filter((s) => s.readyState === WebSocket.OPEN).length).toBe(before);
    // every Wi-Fi place signed in: a new one is refused (busy) and nobody goes
    proveAll(connect.direct);
    const late = open('192.168.1.99');
    expect(late.readyState).toBe(WebSocket.CLOSED);
    expect(connect.direct.size).toBe(33);
  });

  it('the relay’s streams: one not signed in goes (the relay hears its CLOSE), never one that has', async () => {
    const core = makeCore();
    await core.start();
    const relay = new SlowRelaySocket(Infinity);
    const svc = onRelay(core, relay);
    const streams = core.services.connect.streams;
    svc.onFrame(encodeRelayFrame(RelayFrame.OPEN, 1, textBytes('203.0.113.9')));
    proveAll(streams.values());
    for (let id = 2; id <= 64; id++) { svc.onFrame(encodeRelayFrame(RelayFrame.OPEN, id, textBytes('198.51.100.1'))); await sleep(id % 8 ? 0 : 1); }
    expect(streams.size).toBe(64);
    svc.onFrame(encodeRelayFrame(RelayFrame.OPEN, 65, textBytes('198.51.100.2')));
    expect(streams.has(65)).toBe(true);
    expect(streams.has(2)).toBe(false);
    expect(relay.closedStreams.has(2)).toBe(true);
    expect(streams.has(1)).toBe(true);
    proveAll(streams.values());
    svc.onFrame(encodeRelayFrame(RelayFrame.OPEN, 66, textBytes('198.51.100.3')));
    expect(streams.has(66)).toBe(false);
    expect(relay.closedStreams.has(66)).toBe(true);
    expect(streams.size).toBe(64);
  });
});

describe('pairing tries over AppuBot Connect with no address', () => {
  it('count per stream, apart from phones whose address is known', () => {
    const core = makeCore();
    const g = core.gateway;
    for (let i = 0; i < 20; i++) expect(g.pairAllowed('connect/aaaa')).toBe(true);
    expect(g.pairAllowed('connect/aaaa')).toBe(false);
    expect(g.pairAllowed('connect/bbbb')).toBe(true);
    expect(g.pairAllowed('203.0.113.9')).toBe(true);
  });
});
