import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewerChannel, withoutContinuous } from './viewerChannel';

/** a WebSocket stand-in: events and what was sent */
class FakeSocket extends EventTarget {
  binaryType = 'blob';
  protocol = '';
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  send(d: unknown) { this.sent.push(d); }
  close() { this.closed = true; }
  fire(type: string, init: Record<string, unknown> = {}) { const e = new Event(type); Object.assign(e, init); this.dispatchEvent(e); }
}

describe('the screen viewer’s channel', () => {
  it('has what noVNC’s Websock.attach checks for', () => {
    const ch = new ViewerChannel(new FakeSocket() as unknown as WebSocket, () => undefined);
    // noVNC 1.7 core/websock.js rawChannelProps, looked for among own keys and the prototype's names
    const props = [...Object.keys(ch), ...Object.getOwnPropertyNames(Object.getPrototypeOf(ch))];
    for (const p of ['send', 'close', 'binaryType', 'onerror', 'onmessage', 'onopen', 'protocol', 'readyState']) expect(props).toContain(p);
  });

  it('hands the computer’s text frames to the control channel and RFB bytes to noVNC', () => {
    const sock = new FakeSocket();
    const texts: string[] = [];
    const ch = new ViewerChannel(sock as unknown as WebSocket, (t) => texts.push(t));
    expect(sock.binaryType).toBe('arraybuffer');
    const rfb: unknown[] = [];
    let opened = false;
    ch.onmessage = (e) => rfb.push(e.data);
    ch.onopen = () => { opened = true; };
    // noVNC sets this; the channel stays on array buffers
    ch.binaryType = 'blob';
    expect(ch.binaryType).toBe('arraybuffer');
    sock.fire('open');
    sock.fire('message', { data: '{"t":"hello","v":1}' });
    const bytes = new ArrayBuffer(12);
    sock.fire('message', { data: bytes });
    expect(opened).toBe(true);
    expect(texts).toEqual(['{"t":"hello","v":1}']);
    expect(rfb).toEqual([bytes]);
    ch.send(new Uint8Array([1]));
    ch.close();
    expect(sock.sent).toHaveLength(1);
    expect(sock.closed).toBe(true);
  });
});

/** noVNC's messages as it sends them (each its own send) */
const request = (incremental: boolean, w = 1280, h = 800) => new Uint8Array([3, incremental ? 1 : 0, 0, 0, 0, 0, w >> 8, w & 0xff, h >> 8, h & 0xff]);
const continuous = (on: boolean, w = 1280, h = 800) => new Uint8Array([150, on ? 1 : 0, 0, 0, 0, 0, w >> 8, w & 0xff, h >> 8, h & 0xff]);
/** SetEncodings: Tight (7), JPEG quality -23, ContinuousUpdates -313 */
const encodings = () => new Uint8Array([2, 0, 0, 3, 0, 0, 0, 7, 0xff, 0xff, 0xff, 0xe9, 0xff, 0xff, 0xfe, 0xc7]);
const bytes = (d: unknown) => Array.from(d as Uint8Array);

describe('the preview’s pace', () => {
  let now = 0;
  beforeEach(() => { vi.useFakeTimers(); now = 0; });
  afterEach(() => { vi.useRealTimers(); });
  const make = () => {
    const sock = new FakeSocket();
    sock.readyState = 1;
    const ch = new ViewerChannel(sock as unknown as WebSocket, () => undefined, () => now);
    return { sock, ch };
  };
  const tick = (ms: number) => { now += ms; vi.advanceTimersByTime(ms); };

  it('passes everything through unpaced', () => {
    const { sock, ch } = make();
    ch.send(encodings());
    ch.send(request(false));
    ch.send(request(true));
    ch.send(request(true));
    expect(sock.sent).toHaveLength(4);
    expect(bytes(sock.sent[0])).toEqual(bytes(encodings()));
  });

  it('asks for a picture at most once per pace, keeping the newest request (a copy: noVNC reuses its buffer)', () => {
    const { sock, ch } = make();
    ch.pace(1000);
    ch.send(request(false));
    expect(sock.sent).toHaveLength(1);
    const reused = request(true);
    ch.send(reused);
    ch.send(request(true));
    reused.fill(9);
    expect(sock.sent).toHaveLength(1);
    tick(999);
    expect(sock.sent).toHaveLength(1);
    tick(1);
    expect(sock.sent).toHaveLength(2);
    expect(bytes(sock.sent[1])).toEqual(bytes(request(true)));
    // long after: at once
    tick(5000);
    ch.send(request(true));
    vi.advanceTimersByTime(0);
    expect(sock.sent).toHaveLength(3);
  });

  it('leaves continuous updates out of SetEncodings while paced, and refuses noVNC turning them on', () => {
    const { sock, ch } = make();
    ch.pace(1000);
    ch.send(encodings());
    expect(bytes(sock.sent[0])).toEqual([2, 0, 0, 2, 0, 0, 0, 7, 0xff, 0xff, 0xff, 0xe9]);
    ch.send(continuous(true));
    expect(sock.sent).toHaveLength(1);
  });

  it('turns continuous updates off when the full viewer goes back to the preview, and keeps the pictures coming', () => {
    const { sock, ch } = make();
    ch.send(encodings());
    ch.send(continuous(true));
    expect(sock.sent).toHaveLength(2);
    now = 10_000;
    ch.pace(1000);
    expect(bytes(sock.sent[2])).toEqual(bytes(continuous(false)));
    vi.advanceTimersByTime(0);
    expect(bytes(sock.sent[3])).toEqual(bytes(request(true)));
  });

  it('sends what waits at once, declares continuous updates again and turns them back on when the full viewer opens', () => {
    const { sock, ch } = make();
    ch.send(encodings());
    ch.send(continuous(true));
    ch.pace(1000);
    vi.advanceTimersByTime(0);
    // the preview's quality: noVNC sends SetEncodings again, without continuous updates on the wire
    ch.send(encodings());
    const before = sock.sent.length;
    ch.send(request(true));
    expect(sock.sent).toHaveLength(before);
    ch.pace(0);
    expect(bytes(sock.sent[before])).toEqual(bytes(request(true)));
    expect(bytes(sock.sent[before + 1])).toEqual(bytes(encodings()));
    expect(bytes(sock.sent[before + 2])).toEqual(bytes(continuous(true)));
  });

  /** what TigerVNC checks: continuous updates may only be enabled (or disabled) while the last SetEncodings declared them */
  const tigerVncAllows = (sent: unknown[]): boolean => {
    let declared = false;
    for (const d of sent) {
      const b = d as Uint8Array;
      if (b[0] === 2) declared = withoutContinuous(b) !== b;
      if (b[0] === 150 && !declared) return false;
    }
    return true;
  };

  it('never turns continuous updates on or off undeclared, however often the viewer opens and closes', () => {
    const { sock, ch } = make();
    // the session starts in the preview
    ch.pace(1000);
    ch.send(encodings());
    ch.send(request(false));
    for (let i = 0; i < 3; i++) {
      tick(2000);
      // the full viewer: the channel re-declares; the computer answers EndOfContinuousUpdates, and noVNC (first time
      // only) turns them on itself
      ch.pace(0);
      ch.send(encodings());
      if (i === 0) ch.send(continuous(true));
      tick(2000);
      // back to the preview, its quality sent again
      ch.pace(1000);
      ch.send(encodings());
      vi.advanceTimersByTime(0);
    }
    expect(sock.sent.some((d) => (d as Uint8Array)[0] === 150 && (d as Uint8Array)[1] === 1)).toBe(true);
    expect(tigerVncAllows(sock.sent)).toBe(true);
  });

  it('only touches a well-formed SetEncodings', () => {
    const odd = new Uint8Array([2, 0, 0, 5, 0xff, 0xff, 0xfe, 0xc7]);
    expect(withoutContinuous(odd)).toBe(odd);
    const none = new Uint8Array([2, 0, 0, 1, 0, 0, 0, 7]);
    expect(withoutContinuous(none)).toBe(none);
  });
});
