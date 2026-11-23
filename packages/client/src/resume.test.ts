import { describe, expect, test, vi } from 'vitest';
import { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION } from '@appubot/protocol';
import { GatewayClient, GatewayError, type ConnectionState } from './index';
import type { WebSocketLike } from './connect';

/** A socket the test plays the server for: what the client sent, and `hello`/`close` to answer it. */
class FakeSocket implements WebSocketLike {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onerror: WebSocketLike['onerror'] = null;
  onclose: WebSocketLike['onclose'] = null;
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
  frame(f: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(f) }); }
  hello(o: { seq: number; bootId?: string; gap?: boolean }) {
    this.frame({ type: 'hello', ok: true, serverVersion: '1', protocolVersion: PROTOCOL_VERSION, deviceId: 'd', role: 'full', snapshot: {}, ...o });
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const states: ConnectionState[] = [];
  const c = new GatewayClient({
    baseUrl: 'http://127.0.0.1:1', token: 't', device: { id: 'p', name: 'p', platform: 'ios' }, connectTimeoutMs: 0,
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); queueMicrotask(() => s.onopen?.({})); return s; },
  });
  c.onState((s) => states.push(s));
  return { c, sockets, states };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('resuming the event stream', () => {
  test('resumes with the server run’s bootId, and says whether nothing was lost', async () => {
    const { c, sockets } = setup();
    c.connect();
    await tick();
    expect(sockets[0]!.sent[0]).toMatchObject({ type: 'connect' });
    expect(sockets[0]!.sent[0]!.lastSeq).toBeUndefined();
    sockets[0]!.hello({ seq: 5, bootId: 'run-1' });
    // a first connect continues nothing: what was kept (a saved copy) may be stale
    expect(c.resumed).toBe(false);
    sockets[0]!.frame({ type: 'event', event: 'thread.updated', payload: {}, seq: 7 });

    c.reconnectNow();
    await tick();
    expect(sockets[1]!.sent[0]).toMatchObject({ lastSeq: 7, bootId: 'run-1' });
    sockets[1]!.hello({ seq: 9, bootId: 'run-1' });
    expect(c.resumed).toBe(true);

    // the server restarted: another run, and its hello says the replay didn't happen
    c.reconnectNow();
    await tick();
    sockets[2]!.hello({ seq: 2, bootId: 'run-2', gap: true });
    expect(c.resumed).toBe(false);
    expect(c.lastSeq).toBe(2);

    // the same run, but the missed events were no longer there
    c.reconnectNow();
    await tick();
    expect(sockets[3]!.sent[0]).toMatchObject({ lastSeq: 2, bootId: 'run-2' });
    sockets[3]!.hello({ seq: 4000, bootId: 'run-2', gap: true });
    expect(c.resumed).toBe(false);
    c.close();
  });

  test('a server that speaks another protocol is not retried, until asked', async () => {
    vi.useFakeTimers();
    try {
      const { c, sockets, states } = setup();
      c.connect();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.frame({ type: 'hello', ok: false, code: 'protocol_mismatch', error: 'Update the app.' });
      expect(c.state).toBe('incompatible');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(1);
      expect(states).not.toContain('reconnecting');
      // the user updated one side and tries again
      c.reconnectNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(2);
      c.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('protocol range', () => {
  test('says its range and keeps the version agreed', async () => {
    const { c, sockets } = setup();
    c.connect();
    await tick();
    expect(sockets[0]!.sent[0]).toMatchObject({ protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_PROTOCOL_VERSION });
    sockets[0]!.frame({ type: 'hello', ok: true, serverVersion: '2026.10.31', protocolVersion: PROTOCOL_VERSION + 1, minProtocolVersion: MIN_PROTOCOL_VERSION, agreedProtocolVersion: PROTOCOL_VERSION, deviceId: 'd', role: 'full', seq: 1, snapshot: {} });
    expect(c.state).toBe('connected');
    expect(c.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(c.serverVersion).toBe('2026.10.31');
    expect(c.updateNeeded).toBeNull();
    c.close();
  });

  test('a server that predates the range, speaking our version, gets along (the lower one is agreed)', async () => {
    const { c, sockets } = setup();
    c.connect();
    await tick();
    sockets[0]!.hello({ seq: 1 });
    expect(c.state).toBe('connected');
    expect(c.protocolVersion).toBe(PROTOCOL_VERSION);
    c.close();
  });

  test('a server too old for this client: refused here, the computer must update', async () => {
    const { c, sockets } = setup();
    c.connect();
    await tick();
    sockets[0]!.frame({ type: 'hello', ok: true, serverVersion: '2026.1.1', protocolVersion: MIN_PROTOCOL_VERSION - 1, deviceId: 'd', role: 'full', seq: 1, snapshot: {} });
    expect(c.state).toBe('incompatible');
    expect(c.updateNeeded).toBe('server');
    expect(c.serverVersion).toBe('2026.1.1');
    expect(c.snapshot).toBeNull();
  });

  test('a server whose oldest is past this client: this app must update', async () => {
    const { c, sockets } = setup();
    c.connect();
    await tick();
    sockets[0]!.frame({ type: 'hello', ok: true, serverVersion: '2027.1.1', protocolVersion: PROTOCOL_VERSION + 5, minProtocolVersion: PROTOCOL_VERSION + 1, deviceId: 'd', role: 'full', seq: 1, snapshot: {} });
    expect(c.state).toBe('incompatible');
    expect(c.updateNeeded).toBe('client');
  });

  test('a refusal names the side to update; an older server’s says nothing', async () => {
    const { c, sockets } = setup();
    c.connect();
    await tick();
    sockets[0]!.frame({ type: 'hello', ok: false, code: 'protocol_mismatch', error: 'x', update: 'client', serverVersion: '2027.1.1', protocolVersion: 9, minProtocolVersion: 5 });
    expect(c.state).toBe('incompatible');
    expect(c.updateNeeded).toBe('client');
    expect(c.serverVersion).toBe('2027.1.1');
    c.reconnectNow();
    await tick();
    sockets[1]!.frame({ type: 'hello', ok: false, code: 'protocol_mismatch', error: 'x' });
    expect(c.state).toBe('incompatible');
    expect(c.updateNeeded).toBeNull();
    // updated meanwhile: the next hello clears it
    c.reconnectNow();
    await tick();
    sockets[2]!.hello({ seq: 1 });
    expect(c.state).toBe('connected');
    expect(c.updateNeeded).toBeNull();
    c.close();
  });

  test('the end-to-end channel refusing (another channel version) is incompatible too, with its side', async () => {
    vi.useFakeTimers();
    try {
      const { c, sockets } = setup();
      c.connect();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.onclose?.({ code: 1006, reason: 'x', error: new GatewayError('incompatible', 'Update it', { update: 'server' }) });
      expect(c.state).toBe('incompatible');
      expect(c.updateNeeded).toBe('server');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(1);
      c.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
