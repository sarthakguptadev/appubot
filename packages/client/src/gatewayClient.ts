/**
 * Typed AppuBot gateway client. Works in browsers (Electron renderer), React Native and Node.
 * - Opens a WebSocket, sends the `connect` frame, receives `hello` with a snapshot.
 * - `call(method, params)` → typed Promise. `on(event, handler)` → typed subscription.
 * - Auto-reconnect with backoff; `lastSeq` resume (with the server run's `bootId`; `resumed` says whether it held);
 *   pending calls rejected on disconnect. A server that speaks another protocol isn't retried (`incompatible`).
 * - Batches (`BATCH_FEATURE`, named in the connect frame and the hello): a server's `{type: 'batch', items}` frame is
 *   handled item by item, in order, as if each had come alone; calls made in the same tick go out as one batch to a
 *   server that reads them (one frame through AppuBot Connect's relay instead of several).
 */
import type { MethodName, MethodParams, MethodResult, EventName, EventPayload, Snapshot, DeviceIdentity, FileAttachment, UpdateSide } from '@appubot/protocol';
import { BATCH_FEATURE, BATCH_ITEMS_MAX, GATEWAY_FEATURES, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, protocolMatch, connectIdOfUrl, connectUrl, isConnectUrl, safeGatewayPath } from '@appubot/protocol';
import { GatewayError } from './errors';
import type { WebSocketLike } from './connect';

/**
 * `incompatible`: the server speaks another protocol (one side needs an update: `updateNeeded` says which, when known);
 * not retried until `reconnectNow`.
 */
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'unauthorized' | 'incompatible';

export interface GatewayClientOptions {
  /** e.g. "http://100.91.133.6:7890" (ws scheme derived automatically) */
  baseUrl: string;
  token: string;
  device: DeviceIdentity;
  /** custom WebSocket impl (Node: `ws`) */
  WebSocketImpl?: typeof WebSocket;
  /** opens the gateway socket for a URL from `wsUrl()` (default `new WebSocketImpl(url)`); AppuBot Connect's `connect://` URLs go to a `RelaySession` */
  openSocket?: (url: string) => WebSocketLike;
  callTimeoutMs?: number;
  /** a socket that hasn't said hello by then is dropped and retried (a dead address can hang a TCP connect for a minute) */
  connectTimeoutMs?: number;
  log?: (...args: unknown[]) => void;
}

/**
 * Per call: `timeoutMs` overrides `callTimeoutMs` (0: no timeout, for a call that waits on the user); `background`: a
 * call nothing waits on (a live view's acks), not counted in `inFlight`, so it never holds up a route switch.
 */
export interface CallOptions { timeoutMs?: number; background?: boolean }

type Handler<E extends EventName> = (payload: EventPayload<E>, seq: number) => void;
type Frame = { type: string; [k: string]: unknown };
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | undefined; background?: boolean };

export class GatewayClient {
  state: ConnectionState = 'idle';
  snapshot: Snapshot | null = null;
  deviceId: string | null = null;
  role: 'owner' | 'full' | 'limited' | null = null;
  serverVersion = '';
  /** the protocol this connection speaks (the lower of the two sides'); 0 before the first hello */
  protocolVersion = 0;
  /**
   * While `incompatible`: which side is too old, this app (`client`) or the computer (`server`); null when the server
   * predates saying so (either may be). Cleared by the next hello.
   */
  updateNeeded: UpdateSide | null = null;
  lastSeq = 0;
  /** the server run `lastSeq` counts in (hello's `bootId`) */
  bootId: string | null = null;
  /**
   * Whether the last hello continued the event stream this client had: it resumed from `lastSeq` and the server
   * replayed everything missed. False on a first connect, after the server restarted, or when it no longer had the
   * missed events: anything kept from before (a reply streamed live) may be stale, so it should be fetched again.
   */
  resumed = false;
  /** what the server reads beyond its protocol (hello's `features`; none from one that predates them) */
  serverFeatures: readonly string[] = [];
  private ws: WebSocketLike | null = null;
  /** calls made this tick, sent as one batch on the next microtask (only to a server that reads batches) */
  private outbox: { ws: WebSocketLike; frames: { id: string; frame: string }[] } | null = null;
  private pending = new Map<string, Pending>();
  private handlers = new Map<string, Set<(p: unknown, seq: number) => void>>();
  private stateHandlers = new Set<(s: ConnectionState, err?: string) => void>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private seqCounter = 0;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: Required<Pick<GatewayClientOptions, 'callTimeoutMs' | 'connectTimeoutMs'>> & GatewayClientOptions;

  constructor(opts: GatewayClientOptions) {
    this.opts = { callTimeoutMs: 60_000, connectTimeoutMs: 10_000, ...opts };
  }

  get baseUrl(): string { return this.opts.baseUrl.replace(/\/$/, ''); }
  /** no socket right now: waiting out the backoff before the next attempt */
  get waitingToRetry(): boolean { return !this.ws && this.reconnectTimer !== null; }
  get token(): string { return this.opts.token; }

  wsUrl(): string {
    const room = connectIdOfUrl(this.baseUrl);
    if (room) return `${connectUrl(room)}/ws`;
    const u = new URL(this.baseUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = '';
    return u.toString();
  }

  /**
   * URL for downloading a file attachment (adds the auth token as a query param for <img>/<Image> use). Only for one of
   * the gateway's own paths (`/files/<id>`, protocol `safeGatewayPath`): anything else (another scheme, `//host`,
   * `/\host`, their encoded forms) throws, so the token never lands on a URL that leaves this computer's gateway.
   */
  fileUrl(file: Pick<FileAttachment, 'url'> | string): string {
    const path = safeGatewayPath(typeof file === 'string' ? file : file.url);
    if (!path) throw new GatewayError('bad_path', 'That isn’t a file on your computer');
    if (isConnectUrl(this.baseUrl)) return `${this.baseUrl}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.token)}`;
    const base = new URL(this.baseUrl + '/');
    const u = new URL(path, base);
    // belt and braces: a path that still resolved elsewhere gets no token
    if (u.origin !== base.origin) throw new GatewayError('bad_path', 'That isn’t a file on your computer');
    u.searchParams.set('token', this.token);
    return u.toString();
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHelloTimer();
    this.ws?.close();
    this.ws = null;
    this.setState('closed');
    this.rejectAll(new GatewayError('closed', 'Connection closed'));
  }

  /** Calls sent and not answered yet (a route switch waits for none, so nothing in flight is cut off). */
  get inFlight(): number {
    let n = 0;
    for (const p of this.pending.values()) if (!p.background) n += 1;
    return n;
  }

  /**
   * Use another address for the same Mac (e.g. its local-network IP once Tailscale is off). Keeps `lastSeq`, so
   * the next hello replays what was missed. Reconnects at once unless already connected there.
   */
  retarget(baseUrl: string): void {
    const same = baseUrl.replace(/\/$/, '') === this.baseUrl;
    this.opts.baseUrl = baseUrl;
    if (same && this.state === 'connected') return;
    this.reconnectNow();
  }

  /** Drop the current socket (if any) and connect again right away, without waiting out the backoff. */
  reconnectNow(): void {
    if (this.closedByUser || this.state === 'unauthorized') return;
    if (this.state === 'incompatible') this.attempt = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHelloTimer();
    const old = this.ws;
    this.ws = null;
    if (old) {
      try { old.close(); } catch { /* ignore */ }
      this.rejectAll(new GatewayError('disconnected', 'Disconnected from AppuBot'));
    }
    this.open();
  }

  onState(fn: (s: ConnectionState, err?: string) => void): () => void {
    this.stateHandlers.add(fn);
    return () => this.stateHandlers.delete(fn);
  }

  on<E extends EventName>(event: E, fn: Handler<E>): () => void {
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    set.add(fn as (p: unknown, seq: number) => void);
    return () => { set!.delete(fn as (p: unknown, seq: number) => void); };
  }

  /** Subscribe to every event (for stores that want one reducer). */
  onAny(fn: (event: EventName, payload: unknown, seq: number) => void): () => void {
    return this.on('*' as EventName, fn as unknown as Handler<EventName>);
  }

  async call<M extends MethodName>(method: M, params?: MethodParams<M>, opts: CallOptions = {}): Promise<MethodResult<M>> {
    if (!this.ws || this.state !== 'connected') throw new GatewayError('not_connected', 'Not connected to AppuBot');
    const id = `${Date.now().toString(36)}_${(this.seqCounter++).toString(36)}`;
    const frame = JSON.stringify({ type: 'req', id, method, params: params ?? {} });
    return new Promise<MethodResult<M>>((resolve, reject) => {
      const ms = opts.timeoutMs ?? this.opts.callTimeoutMs;
      const timer = ms > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayError('timeout', `Timed out calling ${method}`));
      }, ms) : undefined;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, background: opts.background });
      if (this.serverFeatures.includes(BATCH_FEATURE)) { this.queue(this.ws!, id, frame); return; }
      try { this.ws!.send(frame); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e as Error); }
    });
  }

  /**
   * A call for a server that reads batches: held until this tick's work is done (a microtask, no timer), then sent with
   * the others made meanwhile, alone as itself or together as one batch.
   */
  private queue(ws: WebSocketLike, id: string, frame: string): void {
    if (this.outbox?.ws !== ws) this.outbox = { ws, frames: [] };
    const box = this.outbox;
    box.frames.push({ id, frame });
    if (box.frames.length > 1) return;
    queueMicrotask(() => {
      if (this.outbox === box) this.outbox = null;
      // the socket was replaced meanwhile: its calls were rejected with it
      if (this.ws !== ws) return;
      for (let i = 0; i < box.frames.length; i += BATCH_ITEMS_MAX) {
        const part = box.frames.slice(i, i + BATCH_ITEMS_MAX);
        try {
          ws.send(part.length === 1 ? part[0]!.frame : `{"type":"batch","items":[${part.map((f) => f.frame).join(',')}]}`);
        } catch (e) {
          for (const f of part) {
            const p = this.pending.get(f.id);
            if (!p) continue;
            this.pending.delete(f.id);
            clearTimeout(p.timer);
            p.reject(e as Error);
          }
        }
      }
    });
  }

  /* ---------- internals ---------- */
  private setState(s: ConnectionState, err?: string) {
    if (this.state === s && !err) return;
    this.state = s;
    for (const h of this.stateHandlers) { try { h(s, err); } catch (e) { this.opts.log?.('state handler error', e); } }
  }

  private open() {
    // the platform's WebSocket, typed by what GatewayClient uses of it (a Worker's or Node's own type needn't match the DOM's)
    const WS = (this.opts.WebSocketImpl ?? (globalThis as unknown as { WebSocket?: unknown }).WebSocket) as (new (url: string) => WebSocketLike) | undefined;
    const openSocket = this.opts.openSocket ?? (WS ? (url: string): WebSocketLike => new WS(url) : null);
    if (!openSocket) throw new Error('No WebSocket implementation available');
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let ws: WebSocketLike;
    try { ws = openSocket(this.wsUrl()); } catch (e) { this.scheduleReconnect(String(e)); return; }
    this.ws = ws;
    this.clearHelloTimer();
    if (this.opts.connectTimeoutMs > 0) {
      this.helloTimer = setTimeout(() => {
        this.helloTimer = null;
        if (this.ws !== ws || this.state === 'connected') return;
        this.ws = null;
        try { ws.close(); } catch { /* ignore */ }
        this.scheduleReconnect('connect timeout');
      }, this.opts.connectTimeoutMs);
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'connect', protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_PROTOCOL_VERSION, token: this.opts.token, device: this.opts.device,
        lastSeq: this.lastSeq || undefined, bootId: this.lastSeq && this.bootId ? this.bootId : undefined, features: GATEWAY_FEATURES,
      }));
    };
    // a socket replaced by a new one may still deliver while it closes: its late events would be applied twice
    ws.onmessage = (ev: { data: unknown }) => { if (this.ws === ws) this.handleFrame(ws, typeof ev.data === 'string' ? ev.data : String(ev.data)); };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (ev: { code: number; reason: string }) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearHelloTimer();
      this.rejectAll(new GatewayError('disconnected', 'Disconnected from AppuBot'));
      if (this.closedByUser) return;
      if (this.state === 'unauthorized' || this.state === 'incompatible') return;
      // the end-to-end channel refused: the two sides' AppuBots differ (connect.ts `RelaySocket._fail`)
      const err = (ev as { error?: unknown }).error;
      if (err instanceof GatewayError && err.code === 'incompatible') {
        this.updateNeeded = (err.data as { update?: UpdateSide } | undefined)?.update ?? null;
        this.setState('incompatible', err.message);
        return;
      }
      this.scheduleReconnect(ev.reason || `closed (${ev.code})`);
    };
  }

  private clearHelloTimer() {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }

  private scheduleReconnect(reason: string) {
    if (this.closedByUser) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.attempt++;
    // ±25%: clients that lost their computer together (a relay restart) don't all come back in the same instant
    const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempt, 5)) * (0.75 + Math.random() * 0.5);
    this.setState('reconnecting', reason);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private rejectAll(err: Error) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  private emit(event: string, payload: unknown, seq: number) {
    const set = this.handlers.get(event);
    if (set) for (const h of set) { try { h(payload, seq); } catch (e) { this.opts.log?.('handler error', event, e); } }
    const any = this.handlers.get('*');
    if (any) for (const h of any) { try { (h as unknown as (e: string, p: unknown, s: number) => void)(event, payload, seq); } catch (e) { this.opts.log?.('handler error', event, e); } }
  }

  private handleFrame(ws: WebSocketLike, raw: string) {
    let f: Frame;
    try { f = JSON.parse(raw); } catch { return; }
    if (f?.type !== 'batch') { this.handleOne(f); return; }
    // a batch is its frames in order; one that ends this socket (a handler reconnecting) ends the rest with it
    if (!Array.isArray(f.items)) return;
    for (const item of f.items as Frame[]) {
      if (this.ws !== ws) return;
      if (item && (item.type === 'event' || item.type === 'res')) this.handleOne(item);
    }
  }

  private handleOne(f: Frame) {
    switch (f?.type) {
      case 'hello': {
        if (f.ok) {
          this.clearHelloTimer();
          // a server out of this client's range (one that predates the range speaks only its own version; a hello
          // without one is taken as ours)
          const theirs = typeof f.protocolVersion === 'number' ? f.protocolVersion : PROTOCOL_VERSION;
          const match = protocolMatch(
            { version: PROTOCOL_VERSION, min: MIN_PROTOCOL_VERSION },
            { version: theirs, min: typeof f.minProtocolVersion === 'number' ? f.minProtocolVersion : theirs },
          );
          if (!match.ok) {
            this.updateNeeded = match.update;
            this.serverVersion = typeof f.serverVersion === 'string' ? f.serverVersion : this.serverVersion;
            this.setState('incompatible', match.update === 'server' ? 'AppuBot on the computer is too old for this app.' : 'This app is too old for AppuBot on the computer.');
            this.ws?.close();
            break;
          }
          this.protocolVersion = typeof f.agreedProtocolVersion === 'number' ? f.agreedProtocolVersion : match.version;
          this.updateNeeded = null;
          this.attempt = 0;
          this.snapshot = f.snapshot as Snapshot;
          this.deviceId = f.deviceId as string;
          this.role = f.role as 'owner' | 'full' | 'limited';
          this.serverVersion = f.serverVersion as string;
          const bootId = typeof f.bootId === 'string' ? f.bootId : null;
          // a continuation only when it resumed (it had a seq), in the same server run, and nothing was lost
          this.resumed = this.lastSeq > 0 && !f.gap && (!bootId || !this.bootId || bootId === this.bootId);
          this.bootId = bootId;
          this.serverFeatures = Array.isArray(f.features) ? f.features.filter((x): x is string => typeof x === 'string') : [];
          this.lastSeq = (f.seq as number) ?? 0;
          this.setState('connected');
          this.emit('hello', this.snapshot, this.lastSeq);
        } else {
          const code = f.code as string;
          // another protocol: retrying can't help until one side is updated (`reconnectNow` tries again)
          if (code === 'protocol_mismatch') {
            this.updateNeeded = f.update === 'client' || f.update === 'server' ? f.update : null;
            if (typeof f.serverVersion === 'string' && f.serverVersion) this.serverVersion = f.serverVersion;
          }
          this.setState(code === 'unauthorized' || code === 'revoked' ? 'unauthorized' : code === 'protocol_mismatch' ? 'incompatible' : 'reconnecting', f.error as string);
          this.ws?.close();
        }
        break;
      }
      case 'res': {
        const p = this.pending.get(f.id as string);
        if (!p) return;
        this.pending.delete(f.id as string);
        clearTimeout(p.timer);
        if (f.ok) p.resolve(f.result);
        else { const e = f.error as { code: string; message: string; data?: unknown } | undefined; p.reject(new GatewayError(e?.code ?? 'error', e?.message ?? 'Unknown error', e?.data)); }
        break;
      }
      case 'event': {
        const seq = f.seq as number;
        if (seq) this.lastSeq = seq;
        this.emit(f.event as string, f.payload, seq);
        break;
      }
      default:
        break;
    }
  }
}
