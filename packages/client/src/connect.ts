/**
 * AppuBot Connect for clients: the gateway reached through the relay (connect.appubot.com) instead of over the
 * network, end to end encrypted with the Mac (protocol `connect.ts`). The same channel runs straight to the Mac on the
 * same Wi-Fi (`directSession`: a WebSocket to the gateway's SECURE_PATH instead of the relay's join), so the local
 * network never sees the device token or anything else in the clear.
 *
 * A `RelaySession` is one join socket to the Mac's room (or one direct socket): the phone says hello with a fresh X25519 key, and sends
 * nothing else until the Mac's reply (its own fresh key and a sealed READY) opens with keys that need the Mac key
 * pinned at pairing (only the real Mac can make one; protocol `phoneHandshake`). Everything for that Mac then goes
 * over it, multiplexed by id: HTTP requests (`request`, bodies in chunks both ways, at most CHANNEL_WINDOW of them in
 * flight) and gateway WebSockets (`openSocket`, a `RelaySocket` that GatewayClient drives like a browser WebSocket;
 * long frames cross in pieces). A message that doesn't open (cut, replayed, tampered) ends the session, and the next
 * `relaySession` makes a new one. `relaySession` keeps one live session per room and makes a new one after it drops;
 * `relayFetch` turns a session into a fetch for pairing, health checks and uploads.
 *
 * The cipher is `channelCipher()`: the one the app registered (the phone: expo-crypto's native AES-GCM, whose answers
 * are promises that may settle in any order), else this runtime's own. Each message's number is taken when it is sealed
 * or opened, in call or arrival order, and `InOrder` hands the answers on in that same order: sealed messages go out,
 * and opened ones are handled, strictly one after another, never a later one first.
 */
import {
  CONNECT_SIGN_IN_TEXT,
  CHANNEL_ACK_EVERY, CHANNEL_CHUNK, CHANNEL_MESSAGE_MAX, CHANNEL_VERSION, CHANNEL_WINDOW, CONNECT_RELAY_URL, Msg,
  SECURE_PATH, SecureChannel, ackPayload, bytesText, channelCipher, hostRoute, hostUrl, jsonBytes, parseAck, parseJsonBytes, phoneHandshake, textBytes,
  type ChannelMessage, type FileAttachment, type HttpRequestHead, type HttpResponseHead, type MsgKind, type PhoneHandshake, type WsCloseInfo,
} from '@appubot/protocol';
import { GatewayError } from './errors';

/** An event handler slot; `any` so a platform WebSocket (whose events are its own types) fits. */
type Handler = ((ev: any) => void) | null;

/** What GatewayClient needs of a WebSocket: a browser's, React Native's, Node's `ws`, or a `RelaySocket`. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: Handler;
  onmessage: Handler;
  onerror: Handler;
  onclose: Handler;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** The socket to the relay itself (a WebSocket that carries binary). */
export interface RelayTransport {
  binaryType: string;
  readonly readyState: number;
  onopen: Handler;
  onmessage: Handler;
  onerror: Handler;
  onclose: Handler;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}
export type RelayTransportCtor = new (url: string) => RelayTransport;

export const NO_HOST_MESSAGE = 'Your computer isn’t on AppuBot Connect right now. Is it awake with AppuBot open?';

export const RELAY_BUSY_MESSAGE = 'AppuBot Connect is busy right now. Trying again in a moment.';

const RELAY_REASONS: Record<string, string> = {
  rate_limited: 'Too many tries through AppuBot Connect. Wait a few minutes and try again.',
  room_busy: 'Your computer has too many connections through AppuBot Connect right now.',
  bad_room: 'This computer’s AppuBot Connect address isn’t valid. Pair again.',
};

/**
 * Whether this app may use AppuBot Connect right now: only while signed in to AppuBot. The app says (the phone: its
 * account session); a relay session dialled meanwhile fails with `sign_in_required`. Allowed until set.
 */
let relayAllowed: () => boolean = () => true;
export function setRelayAllowed(fn: () => boolean): void { relayAllowed = fn; }
/**
 * The relay itself is full or shedding load: not this phone's or computer's doing, and over soon. They fail with code
 * `busy`; the room's cooldown (`relaySession`) and the client's backoff try again.
 */
const BUSY_REASONS = new Set(['relay_full', 'relay_busy']);
/** RFC 6455 "try again later": the relay closed a phone that fell too far behind, or is shedding load */
const CLOSE_TRY_AGAIN = 1013;

export interface RelaySessionOptions {
  /** the room (from the pairing QR); not with `direct` */
  connectId?: string;
  /**
   * the Mac's own channel socket on the same Wi-Fi or over Tailscale (`directUrl`: `ws://<address>:<port>/secure`)
   * instead of the relay: the hello goes out as soon as it opens
   */
  direct?: string;
  /** that socket is over Tailscale, not the Wi-Fi (how its failures read, and the longer wait a tunnel may need) */
  overTailscale?: boolean;
  /**
   * that socket goes to an AppuBot Cloud computer's public port (`wss://<slug>.agent37.app/secure`): a sleeping
   * computer is woken by the connection itself and answers only once restored, so its first byte may take minutes
   * (`CLOUD_READY_TIMEOUT_MS`), and its failures say so
   */
  cloud?: boolean;
  /** the Mac's 32-byte X25519 public key, pinned at pairing */
  macKey: Uint8Array;
  /** default CONNECT_RELAY_URL */
  relayUrl?: string;
  /** default the global WebSocket */
  WebSocketImpl?: RelayTransportCtor;
  /** how long the relay, then the Mac (its READY), each get to answer */
  readyTimeoutMs?: number;
  /** a gateway socket the Mac hasn't opened by then means the session is dead (it is dropped, a new one is made) */
  openTimeoutMs?: number;
  /** a session with nothing open closes after this long */
  idleMs?: number;
  /** a request that hears nothing from the Mac for this long fails (default 60 s; 0 never) */
  requestTimeoutMs?: number;
  /**
   * a request given up on (aborted) after at least this long with not one message from the Mac since it went ends the
   * whole session (default 2 s): a probe's timeout on a half-open socket, left behind when the phone changed networks
   */
  silentAbortMs?: number;
  log?: (...args: unknown[]) => void;
}

export interface RelayRequest { method: string; path: string; headers?: Record<string, string> }
export interface RelayResponse { status: number; headers: Record<string, string>; body: Uint8Array }

/**
 * A request body read piece by piece (a file streamed from disk) rather than held whole: `read` gives the next piece
 * (any length: it is cut to CHANNEL_CHUNK), or null at the end; `close` is called once, however the request ended.
 */
export interface BodySource { read(): Promise<Uint8Array | null>; close?(): void }

/** How a session's failures read: through the relay, or on the same Wi-Fi. */
interface Words { via: string; on: string; unreachable: string; noAnswer: string }
const RELAY_WORDS: Words = {
  via: 'through AppuBot Connect', on: 'on AppuBot Connect', unreachable: 'Couldn’t reach AppuBot Connect', noAnswer: 'AppuBot Connect didn’t answer in time',
};
const DIRECT_WORDS: Words = {
  via: 'on this Wi-Fi', on: 'on this Wi-Fi', unreachable: 'Couldn’t reach your computer on this Wi-Fi', noAnswer: 'Your computer didn’t answer on this Wi-Fi',
};
const TAILSCALE_WORDS: Words = {
  via: 'over Tailscale', on: 'over Tailscale', unreachable: 'Couldn’t reach your computer over Tailscale', noAnswer: 'Your computer didn’t answer over Tailscale',
};
const CLOUD_WORDS: Words = {
  via: 'to your AppuBot computer', on: 'on your AppuBot computer', unreachable: 'Couldn’t reach your AppuBot computer', noAnswer: 'Your AppuBot computer didn’t wake up in time',
};

type PendingRequest = {
  method: string;
  head: HttpResponseHead | null;
  parts: Uint8Array[];
  /** response body bytes so far, and how many of them the Mac was told about (HTTP_ACK) */
  received: number;
  acked: number;
  /** request body bytes the Mac has taken (its HTTP_ACK): the body goes out at most CHANNEL_WINDOW ahead */
  taken: number;
  /** the body's sender, waiting for room in the window */
  wake: (() => void) | null;
  /** when the Mac last said anything about it, and the session's message count when it was sent */
  heard: number;
  sessionSeen: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** told as the response body comes in: bytes so far and the declared length (null when not given) */
  onProgress?: (received: number, total: number | null) => void;
  resolve: (r: RelayResponse) => void;
  reject: (e: Error) => void;
};

const READY_TIMEOUT_MS = 8000;
/** on the same Wi-Fi an answer takes milliseconds: a computer that isn't there is given up on sooner */
const DIRECT_READY_TIMEOUT_MS = 5000;
/**
 * an AppuBot Cloud computer asleep when the socket opens is restored first (seconds), or rebuilt from scratch when its
 * checkpoint can't be restored (up to a few minutes): the connection waits that long for the first byte
 */
export const CLOUD_READY_TIMEOUT_MS = 180_000;
const OPEN_TIMEOUT_MS = 10_000;
const IDLE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const SILENT_ABORT_MS = 2000;
/** the most one response may bring (it is held whole in memory) */
const MAX_RESPONSE_BODY = 512 * 1024 * 1024;
const EMPTY = new Uint8Array(0);

function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function isPromise<T>(v: T | Promise<T>): v is Promise<T> {
  return typeof (v as { then?: unknown } | null)?.then === 'function';
}

/**
 * Answers that may come later (an asynchronous cipher's), used strictly in the order they were put: a later one never
 * goes ahead of an earlier one, however soon it is ready. A plain answer put while nothing waits is used at once (what
 * `use` throws then goes to the caller, as before), so a synchronous cipher runs exactly as it always did. An answer
 * that rejects, or a `use` that throws while the queue drains, goes to `failed`, and what waited behind it is dropped.
 */
class InOrder {
  private queue: { answer: unknown; use: (v: any) => void }[] = [];
  private draining = false;

  constructor(private failed: (e: unknown) => void) {}

  put<T>(answer: T | Promise<T>, use: (v: T) => void): void {
    if (!this.draining && !this.queue.length && !isPromise(answer)) { use(answer); return; }
    // never an unhandled rejection while it waits its turn (it is still seen when its turn comes)
    if (isPromise(answer)) answer.catch(() => undefined);
    this.queue.push({ answer, use });
    if (!this.draining) void this.drain();
  }

  /** Drop whatever waits (the session closed). */
  clear(): void {
    this.queue = [];
  }

  private async drain(): Promise<void> {
    this.draining = true;
    while (this.queue.length) {
      const job = this.queue[0]!;
      let v: unknown;
      try {
        v = await job.answer;
      } catch (e) {
        if (this.queue[0] === job) { this.clear(); this.failed(e); }
        continue;
      }
      if (this.queue[0] !== job) continue; // cleared meanwhile
      this.queue.shift();
      try { job.use(v); } catch (e) { this.clear(); this.failed(e); }
    }
    this.draining = false;
  }
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export class RelaySession {
  state: 'connecting' | 'ready' | 'closed' = 'connecting';
  /** why it closed (null while open, or closed by `close()` before anything failed) */
  error: GatewayError | null = null;
  /** resolves once the Mac's READY opened; rejects with the reason it couldn't */
  readonly ready: Promise<void>;
  /** the room ('' for a direct session) */
  readonly connectId: string;
  readonly macKey: Uint8Array;
  readonly relayUrl: string;
  /** the Mac's own channel socket on the same Wi-Fi, or null through the relay */
  readonly directUrl: string | null;
  private readonly words: Words;
  private ws: RelayTransport | null = null;
  private relayJoined = false;
  private handshake: PhoneHandshake<boolean> | null = null;
  private channel: SecureChannel<boolean> | null = null;
  /** the Mac's reply is being checked (an asynchronous cipher): what comes meanwhile waits for it, in order */
  private finishing = false;
  private early: Uint8Array[] = [];
  /** the Mac's messages, opened in the order they came and handled in that order */
  private readonly inbox = new InOrder(() => this.fail(new GatewayError('closed', `The connection ${this.words.via} broke`)));
  /** ours, sealed in the order they were sent and sent in that order */
  private readonly outbox = new InOrder(() => this.fail(new GatewayError('closed', `The connection ${this.words.via} broke`)));
  /** messages from the Mac so far (a request that times out with none since it went means the session is dead) */
  private seen = 0;
  private nextId = 1;
  private requests = new Map<number, PendingRequest>();
  private sockets = new Map<number, RelaySocket>();
  /** sockets asked for before READY: they get an id once it comes */
  private waiting = new Set<RelaySocket>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveReady!: () => void;
  private rejectReady!: (e: Error) => void;
  private closeHandlers = new Set<(s: RelaySession) => void>();
  everReady = false;
  private readonly opts: RelaySessionOptions;

  constructor(opts: RelaySessionOptions) {
    this.opts = opts;
    this.connectId = opts.direct ? '' : opts.connectId ?? '';
    this.macKey = opts.macKey;
    this.relayUrl = (opts.relayUrl ?? CONNECT_RELAY_URL).replace(/\/+$/, '');
    this.directUrl = opts.direct ?? null;
    this.words = !this.directUrl ? RELAY_WORDS : opts.cloud ? CLOUD_WORDS : opts.overTailscale ? TAILSCALE_WORDS : DIRECT_WORDS;
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => undefined); // read by whoever awaits it; never an unhandled rejection
    this.dial();
  }

  /** Where its sockets say they go: `connect://<room>`, or the Mac's address on the Wi-Fi. */
  get label(): string {
    return this.directUrl ? this.directUrl.replace(/^ws/i, 'http').slice(0, -SECURE_PATH.length) : `connect://${this.connectId}`;
  }

  /** Called once when the session closes, for whatever reason. */
  onClose(fn: (s: RelaySession) => void): () => void {
    this.closeHandlers.add(fn);
    return () => this.closeHandlers.delete(fn);
  }

  /**
   * An HTTP request to the Mac's gateway (`path` with its query); the whole response comes back at once. It fails when
   * the Mac says nothing about it for `timeoutMs` (default the session's `requestTimeoutMs`, 60 s). `onProgress` hears
   * the response body arriving (a big file's download bar).
   */
  async request(
    head: RelayRequest, body?: Uint8Array | BodySource,
    opts: { signal?: AbortSignal; timeoutMs?: number; onProgress?: (received: number, total: number | null) => void } = {},
  ): Promise<RelayResponse> {
    this.busy();
    try {
      await untilAborted(this.ready, opts.signal);
    } catch (e) {
      (body as BodySource | undefined)?.close?.();
      throw e;
    } finally {
      this.maybeIdle();
    }
    if (opts.signal?.aborted || this.state !== 'ready') {
      (body as BodySource | undefined)?.close?.();
      if (opts.signal?.aborted) throw abortError();
      throw this.error ?? new GatewayError('closed', `The connection ${this.words.via} closed`);
    }
    const timeoutMs = opts.timeoutMs ?? this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    return new Promise<RelayResponse>((resolve, reject) => {
      const id = this.nextId++;
      const signal = opts.signal;
      const sentAt = Date.now();
      const onAbort = () => {
        const silent = this.seen === p.sessionSeen && Date.now() - sentAt >= (this.opts.silentAbortMs ?? SILENT_ABORT_MS);
        this.endRequest(id, abortError());
        // nothing at all from the Mac since it went: the session is dead (not just slow), so the next try dials afresh
        // rather than waiting on it again
        if (silent) this.fail(new GatewayError('closed', `Your computer stopped answering ${this.words.via}`));
      };
      const p: PendingRequest = {
        method: head.method.toUpperCase(),
        head: null,
        parts: [],
        received: 0,
        acked: 0,
        taken: 0,
        wake: null,
        heard: Date.now(),
        sessionSeen: this.seen,
        timer: null,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        resolve: (r) => { done(); resolve(r); },
        reject: (e) => { done(); reject(e); },
      };
      const done = () => {
        signal?.removeEventListener('abort', onAbort);
        if (p.timer) clearTimeout(p.timer);
        p.timer = null;
        wakeSender(p);
      };
      this.requests.set(id, p);
      this.busy();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs > 0) this.watchRequest(id, p, timeoutMs, timeoutMs);
      void this.sendRequest(id, p, { method: p.method, path: head.path || '/', headers: head.headers ?? {} }, body);
    });
  }

  /** A gateway WebSocket at `path` (e.g. `/ws`), driven like a browser WebSocket. */
  openSocket(path: string): RelaySocket {
    const sock = new RelaySocket(this, path);
    if (this.state === 'closed') {
      sock._fail(this.error ?? new GatewayError('closed', `The connection ${this.words.via} closed`));
      return sock;
    }
    this.waiting.add(sock);
    this.busy();
    if (this.state === 'ready') this.startSocket(sock);
    return sock;
  }

  /** Close the session and everything on it. */
  close(): void {
    this.fail(new GatewayError('closed', `The connection ${this.words.via} closed`), true);
  }

  /* ---------- for RelaySocket ---------- */

  _sendText(sock: RelaySocket, text: string): void {
    const bytes = textBytes(text);
    if (bytes.length > CHANNEL_MESSAGE_MAX) throw new GatewayError('too_large', `This message is too large to send ${this.words.via}`);
    // a long frame goes in pieces (WS_MORE…), its last one as WS_TEXT
    let at = 0;
    for (; bytes.length - at > CHANNEL_CHUNK; at += CHANNEL_CHUNK) this.sendSealed(Msg.WS_MORE, sock._id, bytes.subarray(at, at + CHANNEL_CHUNK));
    this.sendSealed(Msg.WS_TEXT, sock._id, at ? bytes.subarray(at) : bytes);
  }

  _closeSocket(sock: RelaySocket, info: WsCloseInfo): void {
    this.waiting.delete(sock);
    if (sock._id && this.sockets.get(sock._id) === sock) {
      this.sockets.delete(sock._id);
      if (this.state === 'ready') {
        this.trySend(Msg.WS_CLOSE, sock._id, jsonBytes(info));
      }
    }
    this.maybeIdle();
  }

  /* ---------- internals ---------- */

  private get readyTimeoutMs(): number {
    if (this.opts.readyTimeoutMs !== undefined) return this.opts.readyTimeoutMs;
    if (this.opts.cloud) return CLOUD_READY_TIMEOUT_MS;
    return this.directUrl && !this.opts.overTailscale ? DIRECT_READY_TIMEOUT_MS : READY_TIMEOUT_MS;
  }

  private dial() {
    const WS = this.opts.WebSocketImpl ?? (globalThis as unknown as { WebSocket?: RelayTransportCtor }).WebSocket;
    if (!WS) { this.fail(new GatewayError('connect_failed', 'No WebSocket implementation available')); return; }
    if (!this.directUrl && !this.connectId) { this.fail(new GatewayError('connect_failed', 'No AppuBot Connect room to join')); return; }
    if (!this.directUrl && !relayAllowed()) { this.fail(new GatewayError('sign_in_required', CONNECT_SIGN_IN_TEXT)); return; }
    let ws: RelayTransport;
    try {
      ws = new WS(this.directUrl ?? `${this.relayUrl}/join/${this.connectId}`);
    } catch (e) {
      this.fail(new GatewayError('connect_failed', `${this.words.unreachable}: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.arm(this.readyTimeoutMs, this.words.noAnswer);
    // straight to the Mac there is no relay to put us through: the hello goes as soon as the socket is open
    if (this.directUrl) ws.onopen = () => { if (this.ws === ws && !this.relayJoined) this.joined(); };
    ws.onmessage = (ev: { data: unknown }) => this.onData(ev.data);
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (ev: { code?: number; reason?: string }) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const reason = ev?.reason ?? '';
      if (reason === 'host_gone' && !this.directUrl) this.fail(new GatewayError('no_host', NO_HOST_MESSAGE));
      // a phone that fell behind is dropped by the relay: an ordinary drop, the client reconnects and resumes
      else if (this.state === 'ready') this.fail(new GatewayError('closed', ev?.code === CLOSE_TRY_AGAIN && !this.directUrl ? 'AppuBot Connect dropped a slow connection. Reconnecting…' : `Lost the connection ${this.words.via}`));
      else if (ev?.code === CLOSE_TRY_AGAIN && !this.directUrl) this.fail(new GatewayError('busy', RELAY_BUSY_MESSAGE));
      else this.fail(new GatewayError('connect_failed', `Couldn’t reach your computer ${this.words.via}${reason ? ` (${reason})` : ''}`));
    };
  }

  private arm(ms: number, message: string) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = ms > 0 ? setTimeout(() => { this.timer = null; this.fail(new GatewayError('connect_failed', message)); }, ms) : null;
  }

  private onData(data: unknown) {
    if (this.state === 'closed') return;
    if (typeof data === 'string') {
      if (this.relayJoined || this.directUrl) return; // text after the relay's answer (or from the Mac itself) is ignored
      const m = parseJsonBytes<{ t?: string; reason?: string }>(textBytes(data));
      if (m?.t === 'ready') this.joined();
      else if (m?.t === 'no_host') this.fail(new GatewayError('no_host', NO_HOST_MESSAGE));
      else if (m?.t === 'error' && BUSY_REASONS.has(m.reason ?? '')) this.fail(new GatewayError('busy', RELAY_BUSY_MESSAGE));
      else if (m?.t === 'error') this.fail(new GatewayError('connect_failed', RELAY_REASONS[m.reason ?? ''] ?? `AppuBot Connect refused the connection${m.reason ? ` (${m.reason})` : ''}`));
      return;
    }
    const bytes = toBytes(data);
    if (!bytes) return;
    this.seen += 1;
    if (this.state === 'connecting') {
      // the first binary message must be the Mac's reply: its fresh key and a READY that opens with the pinned key
      const hs = this.handshake;
      if (hs) {
        this.handshake = null;
        this.finishHandshake(hs, bytes);
      } else if (this.finishing) {
        // the reply is still being checked: whatever follows waits for it
        this.early.push(bytes);
      }
      return;
    }
    this.receive(bytes);
  }

  /** The Mac's reply to the hello: the channel once its READY opens (at once, or when the cipher answers). */
  private finishHandshake(hs: PhoneHandshake<boolean>, reply: Uint8Array) {
    if (reply.length > 0 && reply[0] !== CHANNEL_VERSION) {
      // a Mac on another channel version answers with its own: the side with the lower one must update
      hs.abandon();
      const update = reply[0]! > CHANNEL_VERSION ? 'client' : 'server';
      this.fail(new GatewayError('incompatible', update === 'client'
        ? `Your computer runs a newer AppuBot. Update this app to connect ${this.words.via}.`
        : `Your computer runs an older AppuBot. Update it to connect ${this.words.via}.`, { update }));
      return;
    }
    const ch = hs.finish(reply);
    if (!isPromise(ch)) { this.handshook(ch); return; }
    this.finishing = true;
    ch.then((c) => this.handshook(c), () => this.handshook(null));
  }

  private handshook(ch: SecureChannel<boolean> | null) {
    this.finishing = false;
    const early = this.early;
    this.early = [];
    // given up on meanwhile (timed out, closed): the channel's keys go with it
    if (this.state === 'closed') { ch?.close(); return; }
    if (!ch) {
      this.fail(new GatewayError('connect_failed', `Couldn’t confirm it’s your computer ${this.words.on}. Pair again if this keeps happening.`));
      return;
    }
    this.channel = ch;
    this.becomeReady();
    for (const bytes of early) if (this.state === 'ready') this.receive(bytes);
  }

  /** One sealed message from the Mac: its number taken now (in the order they came), handled after every earlier one. */
  private receive(bytes: Uint8Array) {
    const ch = this.channel;
    if (!ch) return;
    this.inbox.put(ch.open(bytes), (msg) => {
      if (this.state !== 'ready') return;
      if (!msg) {
        // cut short, out of order, replayed or tampered with: this session can't be trusted any more
        this.fail(new GatewayError('closed', `The connection ${this.words.via} broke`));
        return;
      }
      this.dispatch(msg);
    });
  }

  /** The relay put us through to the Mac (or the direct socket opened): say hello, then wait for its READY. */
  private joined() {
    this.relayJoined = true;
    this.handshake = phoneHandshake(this.macKey, channelCipher());
    try {
      this.ws?.send(this.handshake.hello);
    } catch (e) {
      this.fail(new GatewayError('connect_failed', `Couldn’t reach your computer ${this.words.via}: ${String(e)}`));
      return;
    }
    this.arm(this.readyTimeoutMs, `Your computer didn’t answer ${this.words.via}`);
  }

  private becomeReady() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state = 'ready';
    this.everReady = true;
    this.resolveReady();
    for (const s of [...this.waiting]) this.startSocket(s);
    this.maybeIdle();
  }

  private startSocket(sock: RelaySocket) {
    if (sock.readyState !== RelaySocket.CONNECTING) { this.waiting.delete(sock); return; }
    this.waiting.delete(sock);
    const id = this.nextId++;
    sock._id = id;
    this.sockets.set(id, sock);
    try {
      this.sendSealed(Msg.WS_OPEN, id, jsonBytes({ path: sock.path }));
    } catch (e) {
      this.sockets.delete(id);
      sock._fail(e instanceof GatewayError ? e : new GatewayError('closed', String(e)));
      return;
    }
    const ms = this.opts.openTimeoutMs ?? OPEN_TIMEOUT_MS;
    // the Mac opens its gateway socket at once: no answer means this session is dead (a half-open relay socket)
    if (ms > 0) sock._openTimer = setTimeout(() => {
      if (sock.readyState === RelaySocket.CONNECTING && this.sockets.get(id) === sock) this.fail(new GatewayError('connect_failed', `Your computer didn’t answer ${this.words.via}`));
    }, ms);
  }

  private dispatch(msg: ChannelMessage) {
    switch (msg.kind) {
      case Msg.HTTP_RES: {
        const p = this.requests.get(msg.id);
        if (!p) break;
        p.heard = Date.now();
        p.head = parseJsonBytes<HttpResponseHead>(msg.payload) ?? { status: 502, headers: {} };
        break;
      }
      case Msg.HTTP_RES_BODY: {
        const p = this.requests.get(msg.id);
        if (!p) break;
        p.heard = Date.now();
        p.received += msg.payload.length;
        if (p.received > MAX_RESPONSE_BODY) {
          this.endRequest(msg.id, new GatewayError('too_large', `This is too large to fetch ${this.words.via}`));
          break;
        }
        // the payload is a view into its own decrypted message: kept as is, copied once at the end
        p.parts.push(msg.payload);
        if (p.onProgress) {
          const declared = p.head?.headers ? lowerKeys(p.head.headers)['content-length'] : undefined;
          try { p.onProgress(p.received, declared && /^\d+$/.test(declared) ? Number(declared) : null); } catch { /* a listener's own failure */ }
        }
        if (p.received - p.acked >= CHANNEL_ACK_EVERY) {
          p.acked = p.received;
          this.trySend(Msg.HTTP_ACK, msg.id, ackPayload(p.received));
        }
        break;
      }
      case Msg.HTTP_RES_END: {
        const p = this.requests.get(msg.id);
        if (!p) break;
        this.requests.delete(msg.id);
        const head = p.head ?? { status: 502, headers: {} };
        const headers = lowerKeys(head.headers ?? {});
        // a body shorter (or longer) than its declared length was cut on the way: never hand it out as whole
        const declared = headers['content-length'];
        if (declared && /^\d+$/.test(declared) && p.method !== 'HEAD' && !NULL_BODY.has(head.status) && Number(declared) !== p.received) {
          p.reject(new GatewayError('http_failed', `The answer from your computer ${this.words.via} was cut short. Try again.`));
        } else {
          p.resolve({ status: head.status, headers, body: concat(p.parts.length ? p.parts : [EMPTY]) });
        }
        this.maybeIdle();
        break;
      }
      case Msg.HTTP_ERR: {
        const p = this.requests.get(msg.id);
        if (!p) break;
        this.requests.delete(msg.id);
        const m = parseJsonBytes<{ message?: string }>(msg.payload);
        p.reject(new GatewayError('http_failed', m?.message || 'The request failed on your computer'));
        this.maybeIdle();
        break;
      }
      case Msg.HTTP_ACK: {
        const p = this.requests.get(msg.id);
        const taken = parseAck(msg.payload);
        if (!p || taken === null) break;
        p.heard = Date.now();
        if (taken > p.taken) p.taken = taken;
        wakeSender(p);
        break;
      }
      case Msg.WS_OPEN: {
        this.sockets.get(msg.id)?._opened();
        break;
      }
      case Msg.WS_MORE:
      case Msg.WS_TEXT: {
        const sock = this.sockets.get(msg.id);
        if (sock && !sock._piece(msg.payload, msg.kind === Msg.WS_TEXT)) this.fail(new GatewayError('closed', 'A message through AppuBot Connect was too large'));
        break;
      }
      case Msg.WS_CLOSE: {
        const sock = this.sockets.get(msg.id);
        if (!sock) break;
        this.sockets.delete(msg.id);
        const info = parseJsonBytes<WsCloseInfo>(msg.payload);
        sock._closed({ code: info?.code ?? 1006, reason: info?.reason ?? '' });
        this.maybeIdle();
        break;
      }
      default:
        break;
    }
  }

  /**
   * The request's head, then its body at most CHANNEL_WINDOW ahead of what the Mac has taken (a source is read only as
   * room opens up, so a file streamed from disk never sits whole in memory), then its end.
   */
  private async sendRequest(id: number, p: PendingRequest, head: HttpRequestHead, body?: Uint8Array | BodySource): Promise<void> {
    const source = body instanceof Uint8Array ? onePiece(body) : body;
    try {
      this.sendSealed(Msg.HTTP_REQ, id, jsonBytes(head));
      let sent = 0;
      while (source && this.requests.get(id) === p) {
        const piece = await source.read();
        if (!piece) break;
        for (let at = 0; at < piece.length; at += CHANNEL_CHUNK) {
          const part = piece.subarray(at, at + CHANNEL_CHUNK);
          while (sent + part.length - p.taken > CHANNEL_WINDOW && this.requests.get(id) === p) await new Promise<void>((r) => { p.wake = r; });
          if (this.requests.get(id) !== p) return; // answered, aborted or failed meanwhile
          this.sendSealed(Msg.HTTP_REQ_BODY, id, part);
          sent += part.length;
        }
      }
      if (this.requests.get(id) === p) this.sendSealed(Msg.HTTP_REQ_END, id);
    } catch (e) {
      // the session closing, or the source failing to read: the Mac drops what it has of it
      if (this.requests.get(id) === p) this.endRequest(id, e instanceof Error ? e : new GatewayError('closed', String(e)));
    } finally {
      source?.close?.();
    }
  }

  /** Fail a request that is still waiting: `timeoutMs` without a word from the Mac about it. */
  private watchRequest(id: number, p: PendingRequest, timeoutMs: number, wait: number) {
    p.timer = setTimeout(() => {
      p.timer = null;
      if (this.requests.get(id) !== p) return;
      const quiet = Date.now() - p.heard;
      if (quiet < timeoutMs) { this.watchRequest(id, p, timeoutMs, timeoutMs - quiet); return; }
      // nothing at all from the Mac since it went: the session is dead (a half-open relay socket), not just this request
      if (this.seen === p.sessionSeen) { this.fail(new GatewayError('closed', `Your computer stopped answering ${this.words.via}`)); return; }
      this.endRequest(id, new GatewayError('timeout', `Your computer didn’t answer in time ${this.words.via}`));
    }, wait);
  }

  /** Give up on a request here, and tell the Mac to stop working on it. */
  private endRequest(id: number, err: Error) {
    const p = this.requests.get(id);
    if (!p) return;
    this.requests.delete(id);
    this.trySend(Msg.HTTP_CANCEL, id);
    p.reject(err);
    this.maybeIdle();
  }

  /** Send if the session is up; a send failing here means it is closing anyway. */
  private trySend(kind: MsgKind, id: number, payload?: Uint8Array) {
    if (this.state !== 'ready') return;
    try { this.sendSealed(kind, id, payload); } catch { /* onclose follows */ }
  }

  private sendSealed(kind: MsgKind, id: number, payload?: Uint8Array) {
    if (!this.ws || !this.channel || this.state !== 'ready') throw this.error ?? new GatewayError('closed', `The connection ${this.words.via} closed`);
    // its number is taken now, so messages go out in the order they were sent, whenever the cipher answers
    this.outbox.put(this.channel.seal(kind, id, payload), (sealed) => {
      if (this.state === 'ready') this.ws?.send(sealed);
    });
  }

  private busy() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private maybeIdle() {
    if (this.state !== 'ready' || this.requests.size || this.sockets.size || this.waiting.size || this.idleTimer) return;
    const ms = this.opts.idleMs ?? IDLE_MS;
    if (ms > 0) this.idleTimer = setTimeout(() => { this.idleTimer = null; if (!this.requests.size && !this.sockets.size && !this.waiting.size) this.close(); }, ms);
  }

  private fail(err: GatewayError, quiet = false) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (!quiet) this.error = err;
    this.opts.log?.(this.directUrl ? 'direct session closed' : 'relay session closed', this.label, err.code, err.message);
    if (this.timer) clearTimeout(this.timer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.timer = this.idleTimer = null;
    // nothing of this session's keys outlives it: a handshake never answered, and the channel's keys (one still being
    // made goes when it is: `handshook`); nothing waiting to be handled or sent goes either
    this.handshake?.abandon();
    this.handshake = null;
    this.channel?.close();
    this.channel = null;
    this.early = [];
    this.inbox.clear();
    this.outbox.clear();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = ws.onclose = ws.onerror = ws.onopen = null;
      try { ws.close(1000); } catch { /* ignore */ }
    }
    this.rejectReady(err);
    const reqs = [...this.requests.values()];
    this.requests.clear();
    for (const p of reqs) p.reject(err);
    const socks = [...this.sockets.values(), ...this.waiting];
    this.sockets.clear();
    this.waiting.clear();
    for (const s of socks) s._fail(err);
    for (const h of this.closeHandlers) { try { h(this); } catch { /* ignore */ } }
    this.closeHandlers.clear();
  }
}

/** A body held whole, as a source of one piece. */
function onePiece(body: Uint8Array): BodySource {
  let given = false;
  return { read: async () => (given || !body.length ? null : ((given = true), body)) };
}

/** `p`, or an AbortError as soon as `signal` aborts (a request mustn't wait out the handshake once it's given up). */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function wakeSender(p: PendingRequest) {
  const wake = p.wake;
  p.wake = null;
  wake?.();
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

/**
 * A gateway WebSocket through a RelaySession: the part of the browser WebSocket API GatewayClient uses (the `on*`
 * handlers, `send`, `close`, `readyState`). Events arrive on later ticks, as a browser's do.
 */
export class RelaySocket implements WebSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = RelaySocket.CONNECTING;
  binaryType = 'arraybuffer';
  onopen: ((ev: { type: 'open' }) => void) | null = null;
  onmessage: ((ev: { type: 'message'; data: string }) => void) | null = null;
  onerror: ((ev: { type: 'error'; message: string }) => void) | null = null;
  /** `error`: why the session failed under it (GatewayClient reads an `incompatible` one) */
  onclose: ((ev: { type: 'close'; code: number; reason: string; wasClean: boolean; error?: GatewayError }) => void) | null = null;
  /** @internal its channel id, 0 until the session is ready */
  _id = 0;
  /** @internal */
  _openTimer: ReturnType<typeof setTimeout> | null = null;
  /** the pieces of a long frame so far */
  private parts: Uint8Array[] | null = null;
  private partBytes = 0;

  constructor(private session: RelaySession, readonly path: string) {}

  get url(): string { return `${this.session.label}${this.path}`; }

  send(data: string): void {
    if (this.readyState !== RelaySocket.OPEN) throw new Error('WebSocket is not open');
    this.session._sendText(this, String(data));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === RelaySocket.CLOSING || this.readyState === RelaySocket.CLOSED) return;
    this.readyState = RelaySocket.CLOSED;
    this.clearOpenTimer();
    this.session._closeSocket(this, { code, reason });
    this.later(() => this.onclose?.({ type: 'close', code, reason, wasClean: true }));
  }

  /** @internal the Mac opened it */
  _opened(): void {
    if (this.readyState !== RelaySocket.CONNECTING) return;
    this.clearOpenTimer();
    this.readyState = RelaySocket.OPEN;
    this.onopen?.({ type: 'open' });
  }

  /** @internal a frame from the gateway, or a piece of one (`last` false); false when it grows past CHANNEL_MESSAGE_MAX */
  _piece(bytes: Uint8Array, last: boolean): boolean {
    if (last && !this.parts) { this._text(bytesText(bytes)); return true; }
    this.partBytes += bytes.length;
    if (this.partBytes > CHANNEL_MESSAGE_MAX) return false;
    (this.parts ??= []).push(bytes);
    if (!last) return true;
    const whole = concat(this.parts);
    this.parts = null;
    this.partBytes = 0;
    this._text(bytesText(whole));
    return true;
  }

  /** @internal a frame from the gateway */
  _text(data: string): void {
    if (this.readyState !== RelaySocket.OPEN) return;
    this.onmessage?.({ type: 'message', data });
  }

  /** @internal the Mac closed it (or couldn't open it) */
  _closed(info: WsCloseInfo): void {
    if (this.readyState === RelaySocket.CLOSED) return;
    this.readyState = RelaySocket.CLOSED;
    this.clearOpenTimer();
    this.later(() => this.onclose?.({ type: 'close', code: info.code, reason: info.reason, wasClean: true }));
  }

  /** @internal the session failed or closed under it */
  _fail(err: GatewayError): void {
    if (this.readyState === RelaySocket.CLOSED) return;
    this.readyState = RelaySocket.CLOSED;
    this.clearOpenTimer();
    this.later(() => {
      this.onerror?.({ type: 'error', message: err.message });
      this.onclose?.({ type: 'close', code: 1006, reason: err.message, wasClean: false, error: err });
    });
  }

  private clearOpenTimer() {
    if (this._openTimer) clearTimeout(this._openTimer);
    this._openTimer = null;
  }

  private later(fn: () => void) {
    setTimeout(fn, 0);
  }
}

/* ---------- one session per room ---------- */

const sessions = new Map<string, RelaySession>();
/** rooms whose last session failed before READY: the same failure is answered until `until`, so retries don't flood the relay */
const cooldowns = new Map<string, { until: number; fails: number; session: RelaySession }>();
const COOLDOWN_BASE_MS = 5000;
const COOLDOWN_MAX_MS = 60_000;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The live session for a room, made when there is none (or the last one dropped). A room whose last session failed
 * before the Mac answered (not on Connect, refused, timed out) gets that failed session back for a while (5 s, then
 * up to a minute as failures repeat), since the relay limits how often a phone may join.
 */
export function relaySession(opts: Omit<RelaySessionOptions, 'direct'> & { connectId: string }): RelaySession {
  const key = opts.connectId;
  const live = sessions.get(key);
  if (live && live.state !== 'closed') {
    if (sameBytes(live.macKey, opts.macKey) && live.relayUrl === (opts.relayUrl ?? CONNECT_RELAY_URL).replace(/\/+$/, '')) return live;
    live.close();
  }
  const cool = cooldowns.get(key);
  if (cool && Date.now() < cool.until && sameBytes(cool.session.macKey, opts.macKey)) return cool.session;
  const s = new RelaySession(opts);
  sessions.set(key, s);
  const settle = (closed: RelaySession) => {
    if (sessions.get(key) === closed) sessions.delete(key);
    if (closed.everReady || !closed.error) { cooldowns.delete(key); return; }
    const fails = (cooldowns.get(key)?.fails ?? 0) + 1;
    // ±20%: phones that lost the relay together (it restarted) don't come back in step
    const wait = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (fails - 1)) * (0.8 + Math.random() * 0.4);
    cooldowns.set(key, { fails, session: closed, until: Date.now() + wait });
  };
  if (s.state === 'closed') settle(s);
  else s.onClose(settle);
  return s;
}

/** Forget a room's failures so the next `relaySession` dials at once (the user asked to try again). */
export function retryRelaySoon(connectId: string): void {
  cooldowns.delete(connectId);
}

/* ---------- one direct session per address (the same Wi-Fi, or Tailscale) ---------- */

const directs = new Map<string, RelaySession>();

/** The Mac's channel socket at `host:port` (the Wi-Fi, Tailscale): `ws://<host>:<port>/secure` (an IPv6 address in brackets). */
export function directUrl(host: string, port: number): string {
  return `${hostUrl(host, port).replace(/^http/, 'ws')}${SECURE_PATH}`;
}

/**
 * An AppuBot Cloud computer's channel socket from its public address (`https://<slug>.agent37.app`, as the backend gives
 * it): `wss://<slug>.agent37.app/secure`. A `ws(s)://` base is kept as it is; a path on it is dropped.
 */
export function cloudDirectUrl(publicUrl: string): string {
  const u = new URL(publicUrl.trim());
  const scheme = u.protocol === 'http:' || u.protocol === 'ws:' ? 'ws:' : 'wss:';
  return `${scheme}//${u.host}${SECURE_PATH}`;
}

/** An address of an AppuBot Cloud computer: its public port on agent37.app (never a LAN, Tailscale or loopback address). */
export function isCloudUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return (u.protocol === 'https:' || u.protocol === 'wss:') && /\.agent37\.app$/i.test(u.hostname);
  } catch {
    return false;
  }
}

export interface DirectSessionOptions extends Omit<RelaySessionOptions, 'connectId' | 'direct' | 'relayUrl'> {
  /** the Mac's address on the Wi-Fi or Tailscale (with `port`) */
  host?: string;
  port?: number;
  /**
   * instead: the channel socket's whole URL (`wss://<slug>.agent37.app/secure`, `cloudDirectUrl`), for an AppuBot
   * Cloud computer; `cloud` is taken from it (`isCloudUrl`) unless given
   */
  url?: string;
}

/**
 * The live end-to-end session with the Mac at `host:port` on the same Wi-Fi or over Tailscale, made when there is none
 * (or the last one dropped). One per address carries the gateway socket and every request (files, uploads, pages), so
 * a handshake is made once, not per request. No cooldown: nothing in between limits how often the phone may try.
 */
export function directSession(opts: DirectSessionOptions): RelaySession {
  if (!opts.url && (opts.host === undefined || opts.port === undefined)) throw new Error('directSession needs a url, or a host and port');
  const url = opts.url ?? directUrl(opts.host!, opts.port!);
  const live = directs.get(url);
  if (live && live.state !== 'closed') {
    if (sameBytes(live.macKey, opts.macKey)) return live;
    live.close();
  }
  const { host: _h, port: _p, url: _u, ...rest } = opts;
  const cloud = opts.cloud ?? isCloudUrl(url);
  const s = new RelaySession({ ...rest, direct: url, cloud, overTailscale: !cloud && opts.host !== undefined && hostRoute(opts.host) === 'tailscale' });
  directs.set(url, s);
  const forget = (closed: RelaySession) => { if (directs.get(url) === closed) directs.delete(url); };
  if (s.state === 'closed') forget(s);
  else s.onClose(forget);
  return s;
}

/** Close every session, through the relay and direct (switching computers, tests). */
export function closeRelaySessions(): void {
  for (const s of [...sessions.values(), ...directs.values()]) s.close();
  sessions.clear();
  directs.clear();
  cooldowns.clear();
}

/* ---------- fetch through a session ---------- */

/** `path?query` of a URL, any scheme (`connect://room/api/pair?x=1` → `/api/pair?x=1`). */
export function pathOfUrl(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^#]*)/i.exec(url.trim());
  const rest = m ? m[1]! : url.replace(/#.*$/, '');
  if (!rest) return '/';
  return rest.startsWith('/') ? rest : rest.startsWith('?') ? `/${rest}` : `/${rest}`;
}

function headerRecord(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof (h as { forEach?: unknown }).forEach === 'function' && !Array.isArray(h)) {
    (h as { forEach(fn: (v: string, k: string) => void): void }).forEach((v, k) => { out[k.toLowerCase()] = String(v); });
    return out;
  }
  const entries = Array.isArray(h) ? (h as [string, string][]) : Object.entries(h as Record<string, string>);
  for (const [k, v] of entries) out[k.toLowerCase()] = String(v);
  return out;
}

async function bodyBytes(body: unknown, headers: Record<string, string>): Promise<Uint8Array | undefined> {
  if (body == null) return undefined;
  if (typeof body === 'string') {
    headers['content-type'] ??= 'text/plain;charset=UTF-8';
    return textBytes(body);
  }
  const bytes = toBytes(body);
  if (bytes) return bytes;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    headers['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8';
    return textBytes(body.toString());
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    throw new GatewayError('unsupported', 'Form data can’t go through AppuBot Connect: send the bytes with uploadBytes');
  }
  const blob = body as { arrayBuffer?: () => Promise<ArrayBuffer>; type?: string };
  if (typeof blob.arrayBuffer === 'function') {
    if (blob.type) headers['content-type'] ??= blob.type;
    return new Uint8Array(await blob.arrayBuffer());
  }
  throw new GatewayError('unsupported', 'This kind of request body can’t go through AppuBot Connect');
}

const NULL_BODY = new Set([101, 204, 205, 304]);

/** A fetch Response for a relay answer: the global Response where there is one, else a small stand-in. */
export function relayResponse(r: RelayResponse): Response {
  // Always this stand-in, never the global Response: React Native's fetch polyfill reads a byte body's text() one
  // byte per character (Latin-1), which garbled every non-ASCII letter (a Mac named "Sarthak’s" came out
  // "Sarthakâ€™s"). bytesText decodes UTF-8 the same on every runtime.
  const body = NULL_BODY.has(r.status) ? new Uint8Array(0) : r.body;
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    statusText: '',
    url: '',
    redirected: false,
    headers: { get: (n: string) => r.headers[n.toLowerCase()] ?? null, has: (n: string) => n.toLowerCase() in r.headers },
    text: async () => bytesText(body),
    json: async () => JSON.parse(bytesText(body)) as unknown,
    arrayBuffer: async () => new Uint8Array(body).buffer,
    // the window's cloud files (thumbnails, players) are blob: URLs of these; React Native can't make a Blob of bytes,
    // and never asks
    blob: async () => new Blob([new Uint8Array(body)], { type: r.headers['content-type'] ?? '' }),
  } as unknown as Response;
}

/**
 * A fetch that goes through AppuBot Connect: the URL's path and query (its scheme and host are ignored; use
 * `connect://<room>`), with string, bytes, URLSearchParams or Blob bodies (not FormData: see `uploadBytes`). `session`
 * may be a function, so each call gets the room's live session.
 */
export function relayFetch(session: RelaySession | (() => RelaySession)): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : 'href' in input ? input.href : input.url;
    const s = typeof session === 'function' ? session() : session;
    const headers = headerRecord(init.headers);
    const body = await bodyBytes(init.body, headers);
    const res = await s.request({ method: init.method ?? 'GET', path: pathOfUrl(url), headers }, body, { signal: init.signal ?? undefined });
    return relayResponse(res);
  }) as typeof fetch;
}

/* ---------- multipart bodies ---------- */

export interface MultipartFile { name: string; type: string; data: Uint8Array }

function quoteField(s: string): string {
  return s.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function newBoundary(): string {
  let b = '----AppuBotFormBoundary';
  for (let i = 0; i < 24; i++) b += 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)];
  return b;
}

const textField = (b: string, name: string, value: string) => textBytes(`--${b}\r\nContent-Disposition: form-data; name="${quoteField(name)}"\r\n\r\n${value}\r\n`);
const fileHead = (b: string, name: string, file: { name: string; type: string }) =>
  textBytes(`--${b}\r\nContent-Disposition: form-data; name="${quoteField(name)}"; filename="${quoteField(file.name)}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`);

/** A multipart/form-data body built by hand (what FormData sends), for transports that need the bytes. */
export function multipartBody(fields: ReadonlyArray<readonly [string, string | MultipartFile]>, boundary?: string): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const b = boundary || newBoundary();
  const parts: Uint8Array[] = [];
  for (const [name, value] of fields) {
    if (typeof value === 'string') {
      parts.push(textField(b, name, value));
    } else {
      parts.push(fileHead(b, name, value));
      parts.push(value.data);
      parts.push(textBytes('\r\n'));
    }
  }
  parts.push(textBytes(`--${b}--\r\n`));
  return { body: concat(parts), contentType: `multipart/form-data; boundary=${b}` };
}

/**
 * `POST /api/files` through a session with the file read piece by piece (`pieces`, e.g. from disk): the same multipart
 * form as `uploadBytes`, its bytes going out as they're read and at most CHANNEL_WINDOW ahead of the Mac, so a big
 * video never sits whole in the phone's memory. `pieces` is closed however it ends.
 */
export async function uploadStream(
  session: RelaySession, token: string, file: { name: string; type: string; pieces: BodySource }, threadId?: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<FileAttachment> {
  const b = newBoundary();
  const tail = concat([textBytes('\r\n'), ...(threadId ? [textField(b, 'threadId', threadId)] : []), textBytes(`--${b}--\r\n`)]);
  // the form's head, the file's pieces, then its tail
  let stage: 'head' | 'file' | 'tail' | 'done' = 'head';
  const body: BodySource = {
    read: async () => {
      if (stage === 'head') { stage = 'file'; return fileHead(b, 'file', file); }
      if (stage === 'file') {
        const piece = await file.pieces.read();
        if (piece) return piece;
        stage = 'tail';
      }
      if (stage === 'tail') { stage = 'done'; return tail; }
      return null;
    },
    close: () => file.pieces.close?.(),
  };
  const res = await session.request({ method: 'POST', path: '/api/files', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${b}` } }, body, opts);
  if (res.status < 200 || res.status >= 300) throw new GatewayError('upload_failed', `Upload failed (${res.status})`);
  return JSON.parse(bytesText(res.body)) as FileAttachment;
}
