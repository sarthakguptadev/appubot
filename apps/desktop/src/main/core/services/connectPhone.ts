/**
 * AppuBot Connect, one phone: `PhoneStream` runs a paired phone's end-to-end channel (through the relay or straight on
 * the Wi-Fi) and replays what it asks for against this computer's gateway; `BulkLane` is where answer bodies take turns
 * on a socket. `ConnectService` (connect.ts, which tells the whole story) owns the relay socket and the streams.
 */
import { randomBytes } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { CHANNEL_ACK_EVERY, CHANNEL_CHUNK, CHANNEL_MESSAGE_MAX, CHANNEL_VERSION, CHANNEL_WINDOW, CONNECT_PEER_HEADER, Msg, SECURE_PEER_HEADER, acceptHello, ackPayload, addressKey, jsonBytes, parseAck, parseJsonBytes, versionReply, type ChannelMessage, type HttpRequestHead, type MsgKind, type SecureChannel, type WsOpenHead } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { errMsg } from '../util';
import type { ConnectService } from './connect';

/**
 * an answer body's next piece goes out only while less than this waits on the phones' socket: with one more piece
 * (CHANNEL_FRAME_MAX) it stays under PHONE_HIGH_WATER, so a download alone never pauses a phone's chat
 */
const BULK_HIGH_WATER = 512 * 1024;
/** how often a waiting answer body looks at its socket again (short: on a fast link it empties in a few ms) */
const BULK_POLL_MS = 5;
/**
 * the phone's side this far behind (its own socket, or the relay's) stops reading its gateway sockets, so the backlog
 * shows where the gateway measures it (live pictures dropped, tiers skipped, a socket hopelessly behind closed); read
 * again below PHONE_LOW_WATER. Answer bodies wait meanwhile (`BulkLane.hold`), so only chat's own volume gets here.
 */
const PHONE_HIGH_WATER = 1024 * 1024;
const PHONE_LOW_WATER = 256 * 1024;
const BACKLOG_POLL_MS = 20;
const MAX_SOCKETS_PER_PHONE = 4;
const MAX_REQUESTS_PER_PHONE = 24;
/** a phone that takes none of an answer (no HTTP_ACK) for this long loses that request */
const ACK_WAIT_MS = 60_000;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** headers that describe one hop, not the request: never copied across */
/**
 * Set by a phone stream on everything it replays to the gateway (never taken from the phone): which stream it is, so
 * the gateway can vouch for it (`ConnectService.vouch`) once it signs in. Only read from loopback peers that also carry a
 * channel header; a local process setting it could only keep a stream it can't read open.
 */
export const STREAM_TAG_HEADER = 'x-appubot-stream';
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate', CONNECT_PEER_HEADER, SECURE_PEER_HEADER, STREAM_TAG_HEADER]);
const EMPTY = new Uint8Array(0);

/* ------------------------------------------------------------ one phone */

/** Where a phone stream's messages go: a stream inside the relay's host socket, or a WebSocket of its own (the same Wi-Fi). */
interface StreamSink {
  /** bytes left free in front of every message for the transport's own framing (RELAY_HEADER on the relay) */
  readonly headroom: number;
  /** one message for the phone; its first `headroom` bytes are the transport's */
  send(msg: Uint8Array): void;
  /** where answer bodies wait their turn on the socket (the relay's is shared by every phone on it) */
  readonly bulk: BulkLane;
  /** bytes queued for the phone and not yet out (the socket the stream rides on) */
  backlog(): number;
  /** the stream is over: `tell` the far end too (the relay's CLOSE, or closing the socket); forgotten either way */
  end(tell: boolean): void;
}

/**
 * A gateway WebSocket for a phone, and the pieces of a long frame from the phone so far. `greeted`: the gateway's first
 * frame (the sign-in's answer) has gone to the phone, so it may be paused (`paused`) while the phone's side catches up.
 */
interface PhoneSocket { ws: WebSocket; parts: Uint8Array[] | null; size: number; greeted: boolean; paused: boolean }

/** One answer-body piece waiting its turn: `run` seals and sends it; what it throws goes to its own sender (`fail`). */
interface BulkJob { run: () => void; done: (sent: boolean) => void; fail: (e: unknown) => void }

/**
 * Answer bodies (downloads: files, pictures, pages) on one socket to the phones: the relay's, shared by every phone on
 * it, or a phone's own channel socket. A piece goes out only while the socket has less than BULK_HIGH_WATER queued and no
 * phone on it has its gateway sockets paused for the backlog (`hold`): chat and control messages, sent at once, never
 * wait behind more than a piece or two of a download, and a download never keeps chat paused. Phones take turns, one
 * piece each, so one phone's downloads don't hold up another's. Pure apart from its poll timer, for tests.
 */
export class BulkLane {
  /** each phone's pieces in order, phones in turn order (one that sent goes to the back) */
  private turns = new Map<object, BulkJob[]>();
  private holds = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private backlog: () => number, private highWater = BULK_HIGH_WATER) {}

  /** Pieces waiting, all phones together. */
  get waiting(): number {
    let n = 0;
    for (const q of this.turns.values()) n += q.length;
    return n;
  }

  /**
   * `run` (which sends one piece) runs when it is `owner`'s turn and the socket has room; true then, false when `owner`
   * was dropped (`drop`) before its turn came; rejected with what `run` threw (never thrown into the lane's timer).
   */
  send(owner: object, run: () => void): Promise<boolean> {
    return new Promise<boolean>((done, fail) => {
      const q = this.turns.get(owner);
      if (q) q.push({ run, done, fail });
      else this.turns.set(owner, [{ run, done, fail }]);
      this.pump();
    });
  }

  /** A phone's gateway sockets were paused for the backlog (`on`), or read again: no piece goes out while any is. */
  hold(on: boolean): void {
    this.holds = Math.max(0, this.holds + (on ? 1 : -1));
    if (!this.holds) this.pump();
  }

  /** The phone is gone: its pieces never go. */
  drop(owner: object): void {
    const q = this.turns.get(owner);
    if (!q) return;
    this.turns.delete(owner);
    for (const job of q) job.done(false);
  }

  private pump(): void {
    while (this.turns.size && !this.holds && this.backlog() < this.highWater) {
      const [owner, q] = this.turns.entries().next().value as [object, BulkJob[]];
      const job = q.shift()!;
      this.turns.delete(owner);
      if (q.length) this.turns.set(owner, q);
      try { job.run(); job.done(true); } catch (e) { job.fail(e); }
    }
    // a hold ends with a pump of its own; otherwise look again once the socket has had a moment to drain
    if (this.turns.size && !this.holds && !this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, BULK_POLL_MS);
      this.timer.unref?.();
    }
  }
}

/**
 * The stream a new one takes the place of when its pool is full: one that hasn't signed in yet (not vouched for), from
 * the address holding the most such streams (an IPv6 /64 as one), its oldest. Someone who fills the places with hellos
 * of their own loses those first, never a phone that has signed in. Null when every stream has.
 */
export function evictee<T extends { readonly proven: boolean; readonly since: number; readonly key: string }>(streams: Iterable<T>): T | null {
  const by = new Map<string, { n: number; oldest: T }>();
  for (const s of streams) {
    if (s.proven) continue;
    const e = by.get(s.key);
    if (!e) by.set(s.key, { n: 1, oldest: s });
    else {
      e.n += 1;
      if (s.since < e.oldest.since) e.oldest = s;
    }
  }
  let pick: { n: number; oldest: T } | null = null;
  // the most streams; between equals, the one whose oldest came first
  for (const e of by.values()) if (!pick || e.n > pick.n || (e.n === pick.n && e.oldest.since < pick.oldest.since)) pick = e;
  return pick?.oldest ?? null;
}

/** One HTTP request from a phone. */
interface PhoneRequest {
  head: HttpRequestHead;
  abort: AbortController;
  started: boolean;
  /** the body is complete (the phone's HTTP_REQ_END came) or no longer read (the gateway let it go) */
  ended: boolean;
  /** answered, failed or cancelled: whatever else comes for it is ignored */
  done: boolean;
  /** body bytes from the phone so far; read by the gateway; of those, told to the phone (HTTP_ACK) */
  size: number;
  taken: number;
  acked: number;
  /** body pieces the gateway hasn't read yet (a queue from `first`) and their bytes */
  queue: Uint8Array[];
  first: number;
  held: number;
  /** the gateway waits for the next piece */
  wake: (() => void) | null;
  /** answer bytes sent, and how many the phone says it has (HTTP_ACK) */
  sent: number;
  peerTaken: number;
  /** the answer waits for the phone's ack */
  roomWake: (() => void) | null;
  /** when its body last came or was taken (or the head came): a body that stops for BODY_WAIT_MS lets the request go */
  bodyAt: number;
}

/**
 * One phone on the channel, through the relay or straight on the Wi-Fi (its `sink`): its end-to-end channel and what
 * it asked for. It replays the phone's gateway WebSocket and HTTP requests against this computer's gateway on loopback,
 * marked with `peerHeader` (`CONNECT_PEER_HEADER` on the relay, `SECURE_PEER_HEADER` on the Wi-Fi) set to the phone's
 * address, and sends the answers back sealed. Anything that fails to open (cut, tampered, replayed, out of order),
 * throws, or holds too much ends the stream; so does no hello within HELLO_WAIT_MS, not proving it's a paired phone
 * within SIGN_IN_WAIT_MS of READY (the gateway vouches for it: `vouched`), or nothing at all for STREAM_IDLE_MS.
 */
export class PhoneStream {
  private ch: SecureChannel | null = null;
  private closed = false;
  private sockets = new Map<number, PhoneSocket>();
  private requests = new Map<number, PhoneRequest>();
  /** bytes held for the gateway by this phone */
  private held = 0;
  private helloTimer: ReturnType<typeof setTimeout> | null;
  /** what its replays carry (STREAM_TAG_HEADER), so the gateway can vouch for it */
  private readonly tag = randomBytes(16).toString('hex');
  /** the gateway saw it sign in (or a request with its token succeed): it keeps its place */
  private signedIn = false;
  /** when it came, and its address as limits count it: what `evictee` weighs */
  readonly since = Date.now();
  readonly key: string;
  private signInTimer: ReturnType<typeof setTimeout> | null = null;
  /** the idle and stalled-body check, from READY on */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** the last message either way */
  private activeAt = Date.now();
  /** its gateway sockets aren't read while the phone's side is backed up (the poll that reads them again) */
  private backlogTimer: ReturnType<typeof setInterval> | null = null;
  private readonly times: { helloMs: number; signInMs: number; idleMs: number; bodyMs: number };

  constructor(private svc: ConnectService, private ctx: CoreCtx, private sink: StreamSink, readonly ip: string, private peerHeader: string) {
    this.key = addressKey(ip) || ip;
    this.times = svc.streamTimes;
    svc.track(this.tag, this);
    this.helloTimer = setTimeout(() => { this.helloTimer = null; if (!this.ch) this.drop('no hello'); }, this.times.helloMs);
    this.helloTimer.unref?.();
  }

  /** Signed in (the gateway vouched for it): it keeps its place. */
  get proven(): boolean { return this.signedIn; }

  /** Its gateway sockets are paused until the phone's side catches up. */
  get backedUp(): boolean { return !!this.backlogTimer; }

  /** The gateway vouched for this stream (`ConnectService.vouch`). */
  vouched(): void {
    if (this.closed || this.signedIn) return;
    this.signedIn = true;
    if (this.signInTimer) clearTimeout(this.signInTimer);
    this.signInTimer = null;
  }

  /** Its pool is full and it hadn't signed in yet: it makes room for a new one. */
  evict(): void {
    if (!this.closed) this.drop('made room for a new phone');
  }

  /** From READY: prove itself in time, and be let go when idle or when a request's body stalls. */
  private armDeadlines(): void {
    this.signInTimer = setTimeout(() => { this.signInTimer = null; if (!this.signedIn) this.drop('did not sign in'); }, this.times.signInMs);
    this.signInTimer.unref?.();
    const every = Math.max(10, Math.min(5_000, Math.min(this.times.idleMs, this.times.bodyMs) / 4));
    this.sweepTimer = setInterval(() => this.sweep(), every);
    this.sweepTimer.unref?.();
  }

  private sweep(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const [id, r] of this.requests) {
      if (!r.done && !r.ended && now - r.bodyAt >= this.times.bodyMs) this.fail(id, r, 'the request body stopped coming');
    }
    if (!this.sockets.size && !this.requests.size && now - this.activeAt >= this.times.idleMs) this.drop('idle');
  }

  private get base(): string { return `127.0.0.1:${this.ctx.gateway.port}`; }

  onData(payload: Uint8Array): void {
    if (this.closed) return;
    this.activeAt = Date.now();
    try {
      if (!this.ch) { this.hello(payload); return; }
      const m = this.ch.open(payload);
      if (!m) { this.drop('a message did not open'); return; }
      this.handle(m);
    } catch (e) {
      this.drop(`a message failed: ${errMsg(e)}`);
    }
  }

  /** The phone's hello: our reply carries our fresh key and the sealed READY, framed in place. */
  private hello(payload: Uint8Array): void {
    const accepted = acceptHello(this.svc.keys, payload, this.sink.headroom);
    if (accepted) {
      this.ch = accepted.channel;
      this.clearHelloTimer();
      this.sink.send(accepted.reply);
      this.armDeadlines();
      return;
    }
    if (payload.length > 0 && payload[0] !== CHANNEL_VERSION) {
      // a phone on another version: tell it ours (from which it tells which side must update), then end the stream
      const v = versionReply();
      const out = new Uint8Array(this.sink.headroom + v.length);
      out.set(v, this.sink.headroom);
      this.sink.send(out);
      this.drop(`a phone on channel version ${payload[0]} (ours ${CHANNEL_VERSION}: ${payload[0]! < CHANNEL_VERSION ? 'the phone' : 'this computer'} must update)`);
      return;
    }
    this.drop('not a hello');
  }

  private clearHelloTimer(): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }

  private handle(m: ChannelMessage): void {
    switch (m.kind) {
      case Msg.WS_OPEN: return this.openSocket(m.id, parseJsonBytes<WsOpenHead>(m.payload));
      case Msg.WS_MORE: return this.socketText(m.id, m.payload, false);
      case Msg.WS_TEXT: return this.socketText(m.id, m.payload, true);
      case Msg.WS_CLOSE: {
        const s = this.sockets.get(m.id);
        if (!s) return;
        this.sockets.delete(m.id);
        this.forgetParts(s);
        try { s.ws.close(1000); } catch { /* ignore */ }
        return;
      }
      case Msg.HTTP_REQ: return this.startRequest(m.id, parseJsonBytes<HttpRequestHead>(m.payload));
      case Msg.HTTP_REQ_BODY: return this.requestBody(m.id, m.payload);
      case Msg.HTTP_REQ_END: {
        const r = this.requests.get(m.id);
        if (!r || r.done || r.ended) return;
        r.ended = true;
        wake(r);
        if (!r.started) this.run(m.id, r, false);
        return;
      }
      case Msg.HTTP_ACK: {
        const r = this.requests.get(m.id);
        const n = parseAck(m.payload);
        if (!r || n === null || n <= r.peerTaken) return;
        r.peerTaken = n;
        r.roomWake?.();
        return;
      }
      case Msg.HTTP_CANCEL: {
        const r = this.requests.get(m.id);
        if (r) this.finish(m.id, r);
        return;
      }
      default: return; // nothing else comes from a phone
    }
  }

  private send(kind: MsgKind, id: number, payload?: Uint8Array): void {
    if (this.closed || !this.ch) return;
    this.activeAt = Date.now();
    // sealed and sent in the same tick, so the numbers reach the phone in order; the transport's framing goes in front in place
    this.sink.send(this.ch.seal(kind, id, payload, this.sink.headroom));
  }

  /** Room for `n` more held bytes on this phone and overall (counted when there is). */
  private hold(n: number): boolean {
    const lim = this.svc.limits;
    if (this.held + n > lim.streamHold || this.svc.held + n > lim.totalHold) return false;
    this.held += n;
    this.svc.held += n;
    return true;
  }

  private unhold(n: number): void {
    this.held -= n;
    this.svc.held -= n;
  }

  /* ---------- the gateway WebSocket ---------- */

  private openSocket(id: number, head: WsOpenHead | null): void {
    if (!head || typeof head.path !== 'string' || !/^\/ws(\?|$)/.test(head.path) || this.sockets.has(id) || this.sockets.size >= MAX_SOCKETS_PER_PHONE) {
      this.send(Msg.WS_CLOSE, id, jsonBytes({ code: 1008, reason: 'not allowed' }));
      return;
    }
    const ws = new WebSocket(`ws://${this.base}${head.path}`, { headers: { [this.peerHeader]: this.ip, [STREAM_TAG_HEADER]: this.tag } });
    const s: PhoneSocket = { ws, parts: null, size: 0, greeted: false, paused: false };
    this.sockets.set(id, s);
    // read from the start, backlog or not: the answer to its sign-in must reach the phone (paused only after it)
    ws.on('open', () => this.guard(() => this.send(Msg.WS_OPEN, id)));
    ws.on('message', (data: RawData) => this.guard(() => this.gatewayText(id, s, toU8(data))));
    ws.on('error', () => undefined);
    ws.on('close', (code: number, reason: Buffer) => this.guard(() => {
      if (this.sockets.get(id) !== s) return;
      this.sockets.delete(id);
      this.forgetParts(s);
      this.send(Msg.WS_CLOSE, id, jsonBytes({ code, reason: reason.toString('utf8') }));
    }));
  }

  /** Run a gateway socket's event: whatever it throws ends this phone, never the app. */
  private guard(fn: () => void): void {
    if (this.closed) return;
    try { fn(); } catch (e) { this.drop(`a gateway message failed: ${errMsg(e)}`); }
  }

  /** A frame (or a piece of one) for the gateway; a long frame is put together first, within the byte budget. */
  private socketText(id: number, piece: Uint8Array, last: boolean): void {
    const s = this.sockets.get(id);
    if (!s) return;
    if (last && !s.parts) {
      if (s.ws.readyState === WebSocket.OPEN) s.ws.send(piece, { binary: false });
      return;
    }
    if (s.size + piece.length > CHANNEL_MESSAGE_MAX || !this.hold(piece.length)) { this.drop('a WebSocket message too large'); return; }
    s.size += piece.length;
    (s.parts ??= []).push(piece);
    if (!last) return;
    const whole = Buffer.concat(s.parts, s.size);
    this.forgetParts(s);
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(whole, { binary: false });
  }

  private forgetParts(s: PhoneSocket): void {
    if (s.size) this.unhold(s.size);
    s.parts = null;
    s.size = 0;
  }

  /** A frame from the gateway for the phone: in pieces (WS_MORE…, then WS_TEXT) when longer than one message. */
  private gatewayText(id: number, s: PhoneSocket, bytes: Uint8Array): void {
    if (this.sockets.get(id) !== s) return;
    if (bytes.length > CHANNEL_MESSAGE_MAX) { try { s.ws.close(1009, 'message too big'); } catch { /* ignore */ } return; }
    let at = 0;
    for (; bytes.length - at > CHANNEL_CHUNK; at += CHANNEL_CHUNK) this.send(Msg.WS_MORE, id, bytes.subarray(at, at + CHANNEL_CHUNK));
    this.send(Msg.WS_TEXT, id, at ? bytes.subarray(at) : bytes);
    s.greeted = true;
    this.watchBacklog();
  }

  /**
   * The phone's side is PHONE_HIGH_WATER behind: its gateway sockets aren't read until it is under PHONE_LOW_WATER. What
   * the gateway sends them then waits in the loopback socket and the gateway's own buffer, which is what its guards look
   * at (a live picture dropped, a tier skipped, a socket hopelessly behind closed), rather than piling up here unseen.
   * Downloads on the same socket wait too (`BulkLane.hold`), so the backlog drains rather than refilling. A socket whose
   * sign-in hasn't been answered yet keeps being read: it is paused only once its answer has gone out.
   */
  private watchBacklog(): void {
    if (this.closed) return;
    if (!this.backlogTimer) {
      if (this.sink.backlog() <= PHONE_HIGH_WATER) return;
      this.sink.bulk.hold(true);
      this.backlogTimer = setInterval(() => {
        if (this.closed) { this.stopBacklogWatch(); return; }
        if (this.sink.backlog() <= PHONE_LOW_WATER) this.stopBacklogWatch();
      }, BACKLOG_POLL_MS);
      this.backlogTimer.unref?.();
    }
    for (const s of this.sockets.values()) {
      if (s.greeted && !s.paused) { s.paused = true; s.ws.pause(); }
    }
  }

  /** Caught up (or over): its gateway sockets are read again, and downloads may go on. */
  private stopBacklogWatch(): void {
    if (!this.backlogTimer) return;
    clearInterval(this.backlogTimer);
    this.backlogTimer = null;
    for (const s of this.sockets.values()) {
      if (s.paused) { s.paused = false; s.ws.resume(); }
    }
    this.sink.bulk.hold(false);
  }


  /* ---------- HTTP ---------- */

  private startRequest(id: number, head: HttpRequestHead | null): void {
    const method = head?.method?.toUpperCase() ?? '';
    if (!head || !METHODS.has(method) || typeof head.path !== 'string' || !head.path.startsWith('/') || head.path.startsWith('//') || this.requests.has(id)) {
      this.send(Msg.HTTP_ERR, id, jsonBytes({ message: 'bad request' }));
      return;
    }
    if (this.requests.size >= MAX_REQUESTS_PER_PHONE) {
      this.send(Msg.HTTP_ERR, id, jsonBytes({ message: 'too many requests at once' }));
      return;
    }
    this.requests.set(id, {
      head: { ...head, method }, abort: new AbortController(), started: false, ended: false, done: false,
      size: 0, taken: 0, acked: 0, queue: [], first: 0, held: 0, wake: null, sent: 0, peerTaken: 0, roomWake: null, bodyAt: Date.now(),
    });
  }

  /** A piece of a request body: queued for the gateway, which starts reading at the first one. */
  private requestBody(id: number, piece: Uint8Array): void {
    const r = this.requests.get(id);
    if (!r || r.done || r.ended || r.head.method === 'GET' || r.head.method === 'HEAD') return;
    r.size += piece.length;
    r.bodyAt = Date.now();
    if (r.size > this.svc.limits.requestBody) { this.fail(id, r, 'request too large'); return; }
    if (!this.hold(piece.length)) { this.fail(id, r, 'too much at once: wait for the computer to take it'); return; }
    r.held += piece.length;
    // the payload is a view into its own decrypted message, kept as is
    r.queue.push(piece);
    wake(r);
    if (!r.started) this.run(id, r, true);
  }

  private run(id: number, r: PhoneRequest, withBody: boolean): void {
    r.started = true;
    void this.runRequest(id, r, withBody);
  }

  /** The body as the gateway reads it: one piece per pull, waiting for the phone when the queue is empty. */
  private bodyStream(id: number, r: PhoneRequest): ReadableStream<Uint8Array> {
    const pull = (c: ReadableStreamDefaultController<Uint8Array>): Promise<void> | void => {
      if (r.done) { try { c.close(); } catch { /* cancelled */ } return; }
      if (r.first < r.queue.length) {
        const piece = r.queue[r.first]!;
        r.queue[r.first++] = EMPTY;
        if (r.first === r.queue.length) { r.queue.length = 0; r.first = 0; }
        r.held -= piece.length;
        this.unhold(piece.length);
        r.taken += piece.length;
        r.bodyAt = Date.now();
        // the phone sends at most CHANNEL_WINDOW past what it was told was taken
        if (r.taken - r.acked >= CHANNEL_ACK_EVERY) { r.acked = r.taken; this.send(Msg.HTTP_ACK, id, ackPayload(r.taken)); }
        c.enqueue(piece);
        return;
      }
      if (r.ended) { c.close(); return; }
      return new Promise<void>((resolve) => { r.wake = resolve; }).then(() => pull(c));
    };
    // the gateway letting the body go: what is queued, and whatever more comes, is dropped
    return new ReadableStream<Uint8Array>({ pull, cancel: () => { r.ended = true; this.dropQueue(r); } }, { highWaterMark: 0 });
  }

  /**
   * Wait until the phone has room for `n` more bytes of this answer (it may be CHANNEL_WINDOW behind); false when the
   * request ended meanwhile or the phone took nothing for ACK_WAIT_MS.
   */
  private room(r: PhoneRequest, n: number): boolean | Promise<boolean> {
    if (r.sent + n - r.peerTaken <= CHANNEL_WINDOW) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { r.roomWake = null; resolve(false); }, ACK_WAIT_MS);
      r.roomWake = () => {
        if (!r.done && r.sent + n - r.peerTaken > CHANNEL_WINDOW) return;
        clearTimeout(timer);
        r.roomWake = null;
        resolve(!r.done);
      };
    });
  }

  private async runRequest(id: number, r: PhoneRequest, withBody: boolean): Promise<void> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let whole = false;
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(r.head.headers ?? {})) if (typeof v === 'string' && !HOP.has(k.toLowerCase())) headers.set(k, v);
      headers.set(this.peerHeader, this.ip);
      headers.set(STREAM_TAG_HEADER, this.tag);
      const init: RequestInit & { duplex?: 'half' } = { method: r.head.method, headers, redirect: 'manual', signal: r.abort.signal };
      if (withBody) { init.body = this.bodyStream(id, r); init.duplex = 'half'; }
      const res = await fetch(`http://${this.base}${r.head.path}`, init);
      if (r.done) { await res.body?.cancel().catch(() => undefined); return; }
      // fetch hands over a decoded body: with a content-encoding neither it nor the length describes what we send on
      const decoded = res.headers.has('content-encoding');
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => { if (!HOP.has(k) && !(decoded && k === 'content-encoding')) out[k] = v; });
      const length = res.headers.get('content-length');
      if (length !== null && !decoded) out['content-length'] = length; // lets the phone tell a cut-short answer
      this.send(Msg.HTTP_RES, id, jsonBytes({ status: res.status, headers: out }));
      if (res.body) {
        reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (let at = 0; at < value.length; at += CHANNEL_CHUNK) {
            const piece = value.subarray(at, at + CHANNEL_CHUNK);
            if (!r.done && !(await this.room(r, piece.length))) this.fail(id, r, 'the phone stopped taking the answer');
            if (r.done || this.closed) return;
            // its turn on the socket, after the other phones' and once chat has room (sealed only then, so in order)
            await this.sink.bulk.send(this, () => {
              if (r.done || this.closed) return;
              this.send(Msg.HTTP_RES_BODY, id, piece);
              r.sent += piece.length;
            });
            if (r.done || this.closed) return;
          }
        }
      }
      whole = true;
      if (!r.done) this.send(Msg.HTTP_RES_END, id);
    } catch (e) {
      if (!r.done && !this.closed) this.send(Msg.HTTP_ERR, id, jsonBytes({ message: errMsg(e) }));
    } finally {
      if (reader && !whole) await reader.cancel().catch(() => undefined);
      // answered whole with the body all read: nothing to stop; otherwise the fetch, or a body still coming, goes
      this.finish(id, r, !whole || !r.ended);
    }
  }

  /** Tell the phone a request failed, and stop it. */
  private fail(id: number, r: PhoneRequest, message: string): void {
    if (r.done) return;
    this.send(Msg.HTTP_ERR, id, jsonBytes({ message }));
    this.finish(id, r);
  }

  /** A request is over (answered, failed or cancelled): let go of its body and (`stop`) of the fetch still running for it. */
  private finish(id: number, r: PhoneRequest, stop = true): void {
    if (this.requests.get(id) === r) this.requests.delete(id);
    if (r.done) return;
    r.done = true;
    this.dropQueue(r);
    if (stop) r.abort.abort();
    wake(r);
    r.roomWake?.();
  }

  private dropQueue(r: PhoneRequest): void {
    if (r.held) this.unhold(r.held);
    r.held = 0;
    r.queue = [];
    r.first = 0;
  }

  private drop(why: string): void {
    this.svc.noteDrop(why);
    this.close(true);
  }

  /** The transport saw something no phone speaking the channel sends: end it. */
  reject(why: string): void {
    if (!this.closed) this.drop(why);
  }

  /** End this phone: its sockets and requests stop; `tell` also closes it at the far end (the relay, or its socket). */
  close(tell: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.clearHelloTimer();
    if (this.signInTimer) clearTimeout(this.signInTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.signInTimer = this.sweepTimer = null;
    this.stopBacklogWatch();
    this.sink.bulk.drop(this);
    this.svc.track(this.tag, null);
    // its keys go with it
    this.ch?.close();
    for (const s of this.sockets.values()) {
      s.parts = null;
      s.size = 0;
      try { s.ws.close(1001); } catch { /* ignore */ }
    }
    this.sockets.clear();
    for (const r of this.requests.values()) {
      r.done = true;
      r.abort.abort();
      r.queue = [];
      r.held = 0;
      wake(r);
      r.roomWake?.();
    }
    this.requests.clear();
    // everything this phone held, its sockets' pieces included
    this.svc.held -= this.held;
    this.held = 0;
    this.sink.end(tell);
  }
}

function wake(r: PhoneRequest): void {
  const w = r.wake;
  r.wake = null;
  w?.();
}

export function toU8(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
