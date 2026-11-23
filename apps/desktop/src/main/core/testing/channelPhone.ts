/**
 * A phone speaking the end-to-end channel (protocol connect.ts) as the phone app does, for tests: through a relay's
 * `/join/<room>` (AppuBot Connect) or straight to the gateway's SECURE_PATH (the same Wi-Fi). The hello, the Mac's
 * reply, then sealed messages: gateway sockets and HTTP requests, bodies a window at a time.
 */
import { WebSocket, type RawData } from 'ws';
import {
  CHANNEL_ACK_EVERY,
  CHANNEL_CHUNK,
  CHANNEL_WINDOW,
  Msg,
  ackPayload,
  bytesText,
  fromBase64Url,
  jsonBytes,
  parseAck,
  parseJsonBytes,
  phoneHandshake,
  textBytes,
  type ChannelMessage,
  type HttpResponseHead,
  type MsgKind,
  type PhoneHandshake,
  type SecureChannel,
} from '@appubot/protocol';

export const toU8 = (d: RawData): Uint8Array => new Uint8Array(Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d));

export class TestPhone {
  ws!: WebSocket;
  ch!: SecureChannel;
  closed = false;
  /** what the phone sent, in order (its hello first), as a relay or someone on the Wi-Fi would record it */
  readonly sent: Uint8Array[] = [];
  /** the Mac's reply to the hello */
  reply: Uint8Array | null = null;
  private inbox: ChannelMessage[] = [];
  private waiters: (() => void)[] = [];
  private raw: Uint8Array[] = [];
  private nextId = 1;

  /** Through a relay: the relay's `ready`, then the hello. */
  static async join(relayUrl: string, room: string, macKeyB64: string, ip = '203.0.113.9'): Promise<TestPhone> {
    const p = new TestPhone();
    const hs = phoneHandshake(fromBase64Url(macKeyB64)!);
    p.ws = new WebSocket(`${relayUrl}/join/${room}`, { headers: { 'x-forwarded-for': ip } });
    await p.handshake(hs, (resolve, reject) => {
      p.ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const m = JSON.parse(data.toString()) as { t: string };
        if (m.t === 'ready') p.rawSend(hs.hello); else reject(new Error(m.t));
      });
    });
    return p;
  }

  /** Straight to the Mac's channel socket (`ws://<address>:<port>/secure`): the hello as soon as it opens. */
  static async direct(url: string, macKeyB64: string): Promise<TestPhone> {
    const p = new TestPhone();
    const hs = phoneHandshake(fromBase64Url(macKeyB64)!);
    p.ws = new WebSocket(url);
    await p.handshake(hs, () => { p.ws.on('open', () => p.rawSend(hs.hello)); });
    return p;
  }

  private handshake(hs: PhoneHandshake, start: (resolve: () => void, reject: (e: Error) => void) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      start(resolve, reject);
      this.ws.on('message', (data, isBinary) => {
        if (!isBinary) return;
        const bytes = toU8(data);
        this.raw.push(bytes);
        if (!this.reply) {
          this.reply = bytes;
          const ch = hs.finish(bytes);
          if (ch) { this.ch = ch; resolve(); } else { this.ws.close(); reject(new Error('the Mac’s reply did not open')); }
          return;
        }
        const msg = this.ch.open(bytes);
        if (msg) { this.inbox.push(msg); for (const w of this.waiters.splice(0)) w(); }
      });
      this.ws.on('close', () => { this.closed = true; reject(new Error('closed')); for (const w of this.waiters.splice(0)) w(); });
      this.ws.on('error', reject);
    });
  }

  private rawSend(bytes: Uint8Array): void {
    this.sent.push(bytes);
    this.ws.send(bytes);
  }

  send(kind: MsgKind, id: number, payload?: Uint8Array): void {
    this.rawSend(this.ch.seal(kind, id, payload));
  }

  /** A gateway frame, in pieces when long. */
  sendText(id: number, text: string): void {
    const bytes = textBytes(text);
    let at = 0;
    for (; bytes.length - at > CHANNEL_CHUNK; at += CHANNEL_CHUNK) this.send(Msg.WS_MORE, id, bytes.subarray(at, at + CHANNEL_CHUNK));
    this.send(Msg.WS_TEXT, id, bytes.subarray(at));
  }

  /** The gateway's answer to call `reqId` on that socket (events in between are skipped). */
  async nextRes(id: number, reqId: string): Promise<{ type: string; id: string; ok: boolean; result?: unknown }> {
    for (;;) {
      const f = JSON.parse(await this.nextText(id)) as { type: string; id: string; ok: boolean; result?: unknown };
      if (f.type === 'res' && f.id === reqId) return f;
    }
  }

  /** The next whole gateway frame on that socket. */
  async nextText(id: number, ms = 3000): Promise<string> {
    const parts: Uint8Array[] = [];
    for (;;) {
      const m = await this.next((x) => x.id === id && (x.kind === Msg.WS_MORE || x.kind === Msg.WS_TEXT), ms);
      parts.push(m.payload);
      if (m.kind === Msg.WS_TEXT) return Buffer.concat(parts).toString('utf8');
    }
  }

  async next(match: (m: ChannelMessage) => boolean, ms = 3000): Promise<ChannelMessage> {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.inbox.findIndex(match);
      if (i >= 0) return this.inbox.splice(i, 1)[0]!;
      if (this.closed || Date.now() > end) throw new Error('no such message');
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 50); });
    }
  }

  /** Open the gateway WebSocket as `id` and say hello with `token`: the hello frame's text. */
  async openGateway(id: number, token: string, deviceId: string): Promise<string> {
    this.send(Msg.WS_OPEN, id, jsonBytes({ path: '/ws' }));
    await this.next((m) => m.kind === Msg.WS_OPEN && m.id === id);
    this.sendText(id, JSON.stringify({ type: 'connect', token, device: { id: deviceId, name: 'iPhone', platform: 'ios', appVersion: '1' } }));
    return this.nextText(id);
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
    const h = body === undefined ? headers : { 'content-type': 'application/json', ...headers };
    const res = await this.requestRaw(method, path, body === undefined ? undefined : textBytes(JSON.stringify(body)), h);
    const text = res.body.toString('utf8');
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  /**
   * A request with a raw body, answered as raw bytes, as the phone app does it: the body at most CHANNEL_WINDOW ahead
   * of the Mac's HTTP_ACK, the answer acknowledged as it comes.
   */
  async requestRaw(method: string, path: string, body: Uint8Array | undefined, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const id = this.nextId++;
    this.send(Msg.HTTP_REQ, id, jsonBytes({ method, path, headers }));
    let taken = 0;
    if (body) {
      for (let at = 0; at < body.length; at += CHANNEL_CHUNK) {
        const end = Math.min(body.length, at + CHANNEL_CHUNK);
        while (end - taken > CHANNEL_WINDOW) taken = parseAck((await this.next((m) => m.id === id && m.kind === Msg.HTTP_ACK, 10_000)).payload)!;
        this.send(Msg.HTTP_REQ_BODY, id, body.subarray(at, end));
      }
    }
    this.send(Msg.HTTP_REQ_END, id);
    const head = await this.next((m) => m.id === id && (m.kind === Msg.HTTP_RES || m.kind === Msg.HTTP_ERR), 10_000);
    if (head.kind === Msg.HTTP_ERR) throw new Error(bytesText(head.payload));
    const parts: Uint8Array[] = [];
    let received = 0;
    let acked = 0;
    for (;;) {
      const m = await this.next((x) => x.id === id && (x.kind === Msg.HTTP_RES_BODY || x.kind === Msg.HTTP_RES_END || x.kind === Msg.HTTP_ERR), 10_000);
      if (m.kind === Msg.HTTP_ERR) throw new Error(bytesText(m.payload));
      if (m.kind === Msg.HTTP_RES_END) break;
      parts.push(m.payload);
      received += m.payload.length;
      if (received - acked >= CHANNEL_ACK_EVERY) { acked = received; this.send(Msg.HTTP_ACK, id, ackPayload(received)); }
    }
    const h = parseJsonBytes<HttpResponseHead>(head.payload)!;
    return { status: h.status, headers: h.headers, body: Buffer.concat(parts) };
  }

  /** Replay the last message the Mac sent us back to the Mac (what a malicious relay could try). */
  replayLastToMac(): void { this.ws.send(this.raw.at(-1)!); }
  close(): void { this.ws.close(); }
}

/**
 * A phone speaking the channel over a stand-in transport, no sockets of its own: `received()` is everything the Mac's
 * side has delivered to it so far (its reply to the hello first), `deliver` hands the Mac one message from it. For
 * tests that play the link themselves (a slow socket, the relay's shared one).
 */
export class LinkPhone {
  ch!: SecureChannel;
  readonly inbox: ChannelMessage[] = [];
  private seen = 1;

  constructor(private received: () => Uint8Array[], private deliver: (bytes: Uint8Array) => void) {}

  /** The hello, then the Mac's reply, opened with the pinned key. */
  async start(macKey: Uint8Array, ms = 3000): Promise<this> {
    const hs = phoneHandshake(macKey);
    this.deliver(hs.hello);
    const end = Date.now() + ms;
    while (!this.received().length) {
      if (Date.now() > end) throw new Error('no reply to the hello');
      await new Promise((r) => setTimeout(r, 5));
    }
    const ch = hs.finish(this.received()[0]!);
    if (!ch) throw new Error('the Mac’s reply did not open');
    this.ch = ch;
    return this;
  }

  take(): void {
    const all = this.received();
    for (; this.seen < all.length; this.seen++) {
      const m = this.ch.open(all[this.seen]!);
      if (!m) throw new Error('a message did not open');
      this.inbox.push(m);
    }
  }

  async next(match: (m: ChannelMessage) => boolean, ms = 3000): Promise<ChannelMessage> {
    const end = Date.now() + ms;
    for (;;) {
      this.take();
      const i = this.inbox.findIndex(match);
      if (i >= 0) return this.inbox.splice(i, 1)[0]!;
      if (Date.now() > end) throw new Error('no such message');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  send(kind: MsgKind, id: number, payload?: Uint8Array): void {
    this.deliver(this.ch.seal(kind, id, payload));
  }

  text(id: number, s: string): void {
    this.send(Msg.WS_TEXT, id, textBytes(s));
  }

  /** A call on gateway socket `id`, answered (events in between are skipped). */
  ping(id: number, reqId: string): void {
    this.text(id, JSON.stringify({ type: 'req', id: reqId, method: 'system.ping', params: {} }));
  }

  async nextRes(id: number, reqId: string, ms = 3000): Promise<{ type: string; id?: string; ok?: boolean }> {
    for (;;) {
      const f = JSON.parse(bytesText((await this.next((m) => m.kind === Msg.WS_TEXT && m.id === id, ms)).payload)) as { type: string; id?: string; ok?: boolean };
      if (f.type === 'res' && f.id === reqId) return f;
    }
  }

  /** Open gateway socket `id` and sign in: the hello's text. */
  async signIn(id: number, token: string, deviceId: string, ms = 3000): Promise<string> {
    this.send(Msg.WS_OPEN, id, jsonBytes({ path: '/ws' }));
    await this.next((m) => m.kind === Msg.WS_OPEN && m.id === id, ms);
    this.text(id, JSON.stringify({ type: 'connect', token, device: { id: deviceId, name: 'iPhone', platform: 'ios', appVersion: '1' } }));
    return bytesText((await this.next((m) => m.kind === Msg.WS_TEXT && m.id === id, ms)).payload);
  }

  /** GET `path` as request `id`, acknowledging the body as it comes, as the phone app does. */
  async get(id: number, path: string, token: string, ms = 15_000): Promise<{ status: number; body: Buffer }> {
    this.send(Msg.HTTP_REQ, id, jsonBytes({ method: 'GET', path, headers: { authorization: `Bearer ${token}` } }));
    this.send(Msg.HTTP_REQ_END, id);
    const head = await this.next((m) => m.id === id && (m.kind === Msg.HTTP_RES || m.kind === Msg.HTTP_ERR), ms);
    if (head.kind === Msg.HTTP_ERR) throw new Error(bytesText(head.payload));
    const status = parseJsonBytes<HttpResponseHead>(head.payload)!.status;
    const parts: Uint8Array[] = [];
    let received = 0;
    let acked = 0;
    for (;;) {
      const m = await this.next((x) => x.id === id && (x.kind === Msg.HTTP_RES_BODY || x.kind === Msg.HTTP_RES_END || x.kind === Msg.HTTP_ERR), ms);
      if (m.kind === Msg.HTTP_ERR) throw new Error(bytesText(m.payload));
      if (m.kind === Msg.HTTP_RES_END) break;
      parts.push(m.payload);
      received += m.payload.length;
      if (received - acked >= CHANNEL_ACK_EVERY) { acked = received; this.send(Msg.HTTP_ACK, id, ackPayload(received)); }
    }
    return { status, body: Buffer.concat(parts) };
  }
}
