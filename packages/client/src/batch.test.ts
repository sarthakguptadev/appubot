import { describe, expect, test } from 'vitest';
import { BATCH_FEATURE, BATCH_ITEMS_MAX, PROTOCOL_VERSION } from '@appubot/protocol';
import { GatewayClient } from './index';
import type { WebSocketLike } from './connect';

/** A socket the test plays the server for: every frame the client sent, as sent. */
class FakeSocket implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onerror: WebSocketLike['onerror'] = null;
  onclose: WebSocketLike['onclose'] = null;
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
  frame(f: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(f) }); }
  hello(o: Record<string, unknown> = {}) {
    this.frame({ type: 'hello', ok: true, serverVersion: '1', protocolVersion: PROTOCOL_VERSION, deviceId: 'd', role: 'full', snapshot: {}, seq: 1, bootId: 'run', ...o });
  }
  get frames(): Record<string, unknown>[] { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>); }
}

async function connected(hello: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const c = new GatewayClient({
    baseUrl: 'http://127.0.0.1:1', token: 't', device: { id: 'p', name: 'p', platform: 'ios' }, connectTimeoutMs: 0,
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); queueMicrotask(() => s.onopen?.({})); return s; },
  });
  c.connect();
  await tick();
  sockets.at(-1)!.hello(hello);
  return { c, sockets, ws: () => sockets.at(-1)! };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const event = (seq: number, delta: string) => ({ type: 'event', event: 'message.delta', payload: { threadId: 't', messageId: 'm', partIndex: 0, partType: 'text', delta }, seq });

describe('batches from the server', () => {
  test('the connect frame says the client reads them', async () => {
    const { c, sockets } = await connected();
    expect(sockets[0]!.frames[0]).toMatchObject({ type: 'connect', features: [BATCH_FEATURE] });
    c.close();
  });

  test('are handled item by item, in order, as if each had come alone', async () => {
    const { c, ws } = await connected({ features: [BATCH_FEATURE] });
    const seen: string[] = [];
    c.on('message.delta', (d, seq) => seen.push(`${d.delta}@${seq}`));
    c.onAny((name, _p, seq) => seen.push(`any:${name}@${seq}`));
    const answer = c.call('system.ping');
    await tick();
    const id = String(ws().frames.at(-1)!.id);
    ws().frame({ type: 'batch', items: [event(5, 'a'), event(7, 'b'), { type: 'res', id, ok: true, result: { pong: 1 } }, event(8, 'c')] });
    expect(seen).toEqual(['a@5', 'any:message.delta@5', 'b@7', 'any:message.delta@7', 'c@8', 'any:message.delta@8']);
    await expect(answer).resolves.toEqual({ pong: 1 });
    // the resume point is the last event it carried
    expect(c.lastSeq).toBe(8);
    c.close();
  });

  test('a hello or a batch inside one is not taken; a handler that ends the socket ends the rest', async () => {
    const { c, ws, sockets } = await connected({ features: [BATCH_FEATURE] });
    const seen: string[] = [];
    c.on('message.delta', (d) => {
      seen.push(d.delta);
      if (d.delta === 'stop') c.reconnectNow();
    });
    ws().frame({ type: 'batch', items: [{ type: 'hello', ok: false, code: 'revoked', error: 'x' }, { type: 'batch', items: [event(3, 'nested')] }, event(4, 'a')] });
    expect(c.state).toBe('connected');
    expect(seen).toEqual(['a']);
    const first = sockets[0]!;
    first.frame({ type: 'batch', items: [event(5, 'stop'), event(6, 'after')] });
    // the old socket's later events would be applied twice after the resume
    expect(seen).toEqual(['a', 'stop']);
    expect(c.lastSeq).toBe(5);
    c.close();
  });

  test('a server that predates them: its frames as before', async () => {
    const { c, ws } = await connected();
    expect(c.serverFeatures).toEqual([]);
    const seen: string[] = [];
    c.on('message.delta', (d) => seen.push(d.delta));
    ws().frame(event(2, 'plain'));
    expect(seen).toEqual(['plain']);
    expect(c.lastSeq).toBe(2);
    c.close();
  });
});

describe('batches to the server', () => {
  test('calls made in the same tick go as one, to a server that reads them', async () => {
    const { c, ws } = await connected({ features: [BATCH_FEATURE] });
    const before = ws().sent.length;
    void c.call('system.ping').catch(() => undefined);
    void c.call('threads.list').catch(() => undefined);
    void c.call('bots.list').catch(() => undefined);
    expect(ws().sent.length).toBe(before);
    await tick();
    expect(ws().sent.length).toBe(before + 1);
    const sent = ws().frames.at(-1)!;
    expect(sent.type).toBe('batch');
    expect((sent.items as { method: string }[]).map((r) => r.method)).toEqual(['system.ping', 'threads.list', 'bots.list']);
    // one alone goes as itself
    void c.call('system.ping').catch(() => undefined);
    await tick();
    expect(ws().frames.at(-1)).toMatchObject({ type: 'req', method: 'system.ping' });
    c.close();
  });

  test('never more than BATCH_ITEMS_MAX in one', async () => {
    const { c, ws } = await connected({ features: [BATCH_FEATURE] });
    const before = ws().sent.length;
    for (let i = 0; i < BATCH_ITEMS_MAX + 3; i++) void c.call('system.ping').catch(() => undefined);
    await tick();
    const out = ws().frames.slice(before);
    expect(out).toHaveLength(2);
    expect((out[0]!.items as unknown[]).length).toBe(BATCH_ITEMS_MAX);
    expect((out[1]!.items as unknown[]).length).toBe(3);
    c.close();
  });

  test('a server that predates them gets each call as it is made', async () => {
    const { c, ws } = await connected();
    const before = ws().sent.length;
    void c.call('system.ping').catch(() => undefined);
    void c.call('threads.list').catch(() => undefined);
    expect(ws().sent.length).toBe(before + 2);
    expect(ws().frames.slice(before).map((f) => f.type)).toEqual(['req', 'req']);
    c.close();
  });

  test('calls waiting for a socket that was replaced are rejected with it, never sent on the next', async () => {
    const { c, sockets } = await connected({ features: [BATCH_FEATURE] });
    const first = sockets[0]!;
    const before = first.sent.length;
    const call = c.call('system.ping');
    c.reconnectNow();
    await expect(call).rejects.toMatchObject({ code: 'disconnected' });
    await tick();
    expect(first.sent.length).toBe(before);
    expect(sockets[1]!.frames.every((f) => f.type === 'connect')).toBe(true);
    c.close();
  });

  test('a send that fails rejects the calls it carried', async () => {
    const { c, ws } = await connected({ features: [BATCH_FEATURE] });
    ws().send = () => { throw new Error('socket gone'); };
    const a = c.call('system.ping');
    const b = c.call('threads.list');
    await expect(a).rejects.toThrow('socket gone');
    await expect(b).rejects.toThrow('socket gone');
    c.close();
  });
});
