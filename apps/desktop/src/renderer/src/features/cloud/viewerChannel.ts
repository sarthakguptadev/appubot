/**
 * The VNC socket of your AppuBot computer's screen port, as noVNC's RFB wants a channel (the properties its
 * `Websock.attach` checks), with the computer's text frames kept out of it: those are the control channel
 * (protocol `viewerControl.ts`: `hello`, then who has control), handed to `onText`. RFB bytes pass through untouched,
 * except while the channel is paced (`pace(ms)`, the side panel's small preview): then it asks the computer for a
 * picture at most every `ms` (noVNC asks again after every update; the channel holds its incremental
 * FramebufferUpdateRequest back until it's time, keeping only the newest) and keeps continuous updates off (it
 * leaves the ContinuousUpdates pseudo-encoding out of SetEncodings, turns them off if the full viewer had them on, and
 * asks for one picture so the cycle goes on). Pacing back to 0 sends what waits at once, declares continuous updates
 * again (noVNC's last SetEncodings as it wrote it: TigerVNC closes a viewer that enables them undeclared, which made
 * every expand after the first reconnect) and turns them on again where noVNC had them. noVNC sends every message as its own `send` (Websock.flush), from a reused buffer:
 * what is held back is copied.
 */
export class ViewerChannel {
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  private interval = 0;
  private pending: Uint8Array | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRequestAt = 0;
  /** the framebuffer's size, from noVNC's own update requests */
  private fb: { w: number; h: number } | null = null;
  /** noVNC turned continuous updates on (the computer supports them); whether they are on now */
  private continuousSupported = false;
  private continuous = false;
  /**
   * noVNC's last SetEncodings as it wrote it, and whether the computer was last told the ContinuousUpdates
   * pseudo-encoding (a paced SetEncodings leaves it out). TigerVNC drops a client that enables continuous updates
   * without having declared it ("Client tried to enable continuous updates when not allowed"), so going back to
   * unpaced declares it again before turning them on.
   */
  private encodings: Uint8Array | null = null;
  private declared = false;

  constructor(private readonly ws: WebSocket, onText: (text: string) => void, private readonly now: () => number = Date.now) {
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', (e) => this.onopen?.(e));
    ws.addEventListener('close', (e) => { this.clearTimer(); this.onclose?.(e); });
    ws.addEventListener('error', (e) => this.onerror?.(e));
    ws.addEventListener('message', (e) => {
      if (typeof e.data === 'string') onText(e.data);
      else this.onmessage?.(e);
    });
  }

  get binaryType(): BinaryType { return 'arraybuffer'; }
  set binaryType(_v: BinaryType) { /* always array buffers */ }
  get protocol(): string { return this.ws.protocol; }
  get readyState(): number { return this.ws.readyState; }

  /** At most one picture every `ms` (0: as fast as noVNC asks, continuous updates allowed). */
  pace(ms: number): void {
    const was = this.interval;
    this.interval = Math.max(0, ms);
    if (was === 0 && this.interval > 0) {
      if (this.continuous && this.declared && this.fb) {
        this.raw(updatesMessage(150, false, this.fb));
        this.continuous = false;
        // noVNC waits for the next update before asking again: ask for it
        this.defer(updatesMessage(3, true, this.fb));
      }
    } else if (was > 0 && this.interval === 0) {
      this.flushPending();
      // declare continuous updates again first (the computer answers EndOfContinuousUpdates; noVNC, never told
      // before, turns them on itself)
      if (this.encodings && !this.declared && withoutContinuous(this.encodings) !== this.encodings) {
        this.raw(this.encodings);
        this.declared = true;
      }
      if (this.continuousSupported && this.declared && !this.continuous && this.fb) {
        this.raw(updatesMessage(150, true, this.fb));
        this.continuous = true;
      }
    }
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    const b = bytesOf(data);
    if (b) {
      if (b.length === 10 && (b[0] === 3 || b[0] === 150)) this.fb = { w: (b[6]! << 8) | b[7]!, h: (b[8]! << 8) | b[9]! };
      if (b.length === 10 && b[0] === 3 && b[1] === 1 && this.interval > 0) { this.defer(b); return; }
      if (b.length === 10 && b[0] === 3) this.lastRequestAt = this.now();
      if (b.length === 10 && b[0] === 150) {
        if (b[1] === 1) {
          this.continuousSupported = true;
          // paced: keep asking picture by picture
          if (this.interval > 0) return;
          this.continuous = true;
        } else this.continuous = false;
      }
      if (b[0] === 2) {
        const stripped = withoutContinuous(b);
        const declares = stripped !== b;
        this.encodings = new Uint8Array(b);
        if (declares && this.interval > 0) { this.declared = false; this.ws.send(stripped as Uint8Array<ArrayBuffer>); return; }
        this.declared = declares;
      }
    }
    this.ws.send(data as ArrayBuffer);
  }

  close(): void { this.clearTimer(); this.ws.close(); }

  private raw(b: Uint8Array): void {
    if (this.ws.readyState === 1) this.ws.send(b as Uint8Array<ArrayBuffer>); // OPEN
  }

  private defer(b: Uint8Array): void {
    this.pending = new Uint8Array(b);
    if (this.timer) return;
    const wait = Math.max(0, this.lastRequestAt + this.interval - this.now());
    this.timer = setTimeout(() => { this.timer = null; this.flushPending(); }, wait);
  }

  private flushPending(): void {
    this.clearTimer();
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    this.lastRequestAt = this.now();
    this.raw(p);
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

/** ContinuousUpdates (-313) as RFB's big-endian int32 */
const CONTINUOUS = [0xff, 0xff, 0xfe, 0xc7] as const;

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

/** a FramebufferUpdateRequest (3) or EnableContinuousUpdates (150) for the whole screen */
function updatesMessage(type: 3 | 150, flag: boolean, fb: { w: number; h: number }): Uint8Array {
  return new Uint8Array([type, flag ? 1 : 0, 0, 0, 0, 0, fb.w >> 8, fb.w & 0xff, fb.h >> 8, fb.h & 0xff]);
}

/** SetEncodings without the ContinuousUpdates pseudo-encoding (the same array when it isn't there or isn't one) */
export function withoutContinuous(b: Uint8Array): Uint8Array {
  if (b.length < 4 || b[0] !== 2) return b;
  const n = (b[2]! << 8) | b[3]!;
  if (b.length !== 4 + 4 * n) return b;
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4 + 4 * i;
    if (b[o] === CONTINUOUS[0] && b[o + 1] === CONTINUOUS[1] && b[o + 2] === CONTINUOUS[2] && b[o + 3] === CONTINUOUS[3]) continue;
    keep.push(o);
  }
  if (keep.length === n) return b;
  const out = new Uint8Array(4 + 4 * keep.length);
  out[0] = 2;
  out[2] = keep.length >> 8;
  out[3] = keep.length & 0xff;
  keep.forEach((o, i) => out.set(b.subarray(o, o + 4), 4 + 4 * i));
  return out;
}
