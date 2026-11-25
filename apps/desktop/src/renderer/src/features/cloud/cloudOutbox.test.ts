import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@appubot/protocol';
import { GatewayError, type GatewayLike } from '../../lib/gateway';
import {
  SEND_WAIT_MS, absorbSent, discardSend, dropSendsFor, failWaiting, hasPending, localMessage, pumpOutbox, resetOutbox, restoreSends, retrySend,
  enqueueSend, setOutboxChat, setOutboxLink, useOutbox, whenCloudReady, type QueuedSend,
} from '../../lib/outbox';

/** a cloud client whose `chat.send` answers what each test says */
function fakeClient(answer: (p: { clientId?: string; text: string }) => Promise<unknown>) {
  const calls: { clientId?: string; text: string }[] = [];
  const client = {
    state: 'connected',
    call: vi.fn(async (_m: string, p: { clientId?: string; text: string }) => { calls.push(p); return answer(p); }),
  } as unknown as GatewayLike;
  return { client, calls };
}

const real = (p: { clientId?: string; text: string }): Message =>
  ({ id: `msg_${p.text}`, threadId: 't1', role: 'user', parts: [{ type: 'text', text: p.text }], status: 'complete', via: 'desktop', clientId: p.clientId, createdAt: 1, updatedAt: 1 }) as Message;

let onScreen: string | null;
let ready: GatewayLike | null;
let wakes: number;
let placed: string[];
let settled: [string, string][];
let removed: string[];

beforeEach(() => {
  vi.useFakeTimers();
  resetOutbox();
  onScreen = 'own';
  ready = null;
  wakes = 0;
  placed = [];
  settled = [];
  removed = [];
  setOutboxLink({ onScreen: () => onScreen, ready: () => ready, wake: () => { wakes += 1; } });
  setOutboxChat({
    place: (q) => placed.push(q.localId),
    settle: (q, m) => settled.push([q.localId, m.id]),
    remove: (q) => removed.push(q.localId),
  });
});
afterEach(() => { vi.useRealTimers(); });

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const sends = () => useOutbox.getState().sends;

describe('the cloud outbox', () => {
  it('shows a message at once, waits for the computer (waking it), and sends it with its clientId once it is up', async () => {
    const q = enqueueSend({ botId: 'b1', threadId: 't1', text: 'hello', images: [] })!;
    expect(q.localId).toMatch(/^local:/);
    expect(placed).toEqual([q.localId]);
    expect(wakes).toBe(1);
    expect(sends()[q.localId]!.state).toBe('queued');
    expect(hasPending(sends(), 'own')).toBe(true);

    const { client, calls } = fakeClient(async (p) => ({ userMessage: real(p), agentMessageId: 'a1' }));
    ready = client;
    pumpOutbox();
    await flush();
    expect(calls).toEqual([expect.objectContaining({ clientId: q.localId, text: 'hello', threadId: 't1' })]);
    expect(settled).toEqual([[q.localId, 'msg_hello']]);
    expect(sends()).toEqual({});
    expect(hasPending(sends(), 'own')).toBe(false);
  });

  it('sends in order, one at a time', async () => {
    const a = enqueueSend({ botId: 'b1', threadId: 't1', text: 'one', images: [] }, 1000)!;
    const b = enqueueSend({ botId: 'b1', threadId: 't1', text: 'two', images: [] }, 2000)!;
    const { client, calls } = fakeClient(async (p) => ({ userMessage: real(p), agentMessageId: 'a' }));
    ready = client;
    pumpOutbox();
    await flush();
    await flush();
    expect(calls.map((c) => c.text)).toEqual(['one', 'two']);
    expect(settled.map(([l]) => l)).toEqual([a.localId, b.localId]);
  });

  it('keeps a message queued when the connection drops on the way, and marks it Not sent when the computer refuses', async () => {
    const q = enqueueSend({ botId: 'b1', threadId: 't1', text: 'hi', images: [] })!;
    let refuse = false;
    const { client, calls } = fakeClient(async () => { throw refuse ? new GatewayError('not_found', 'No such chat') : new GatewayError('disconnected', 'gone'); });
    ready = client;
    pumpOutbox();
    await flush();
    expect(sends()[q.localId]!.state).toBe('queued');
    refuse = true;
    await vi.advanceTimersByTimeAsync(1100);
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.clientId).toBe(calls[1]!.clientId);
    expect(sends()[q.localId]).toMatchObject({ state: 'failed', error: 'No such chat' });
    expect(hasPending(sends(), 'own')).toBe(false);
  });

  it('gives up after SEND_WAIT_MS without the computer, then sends on Try again', async () => {
    const q = enqueueSend({ botId: 'b1', threadId: 't1', text: 'hi', images: [] })!;
    await vi.advanceTimersByTimeAsync(SEND_WAIT_MS + 100);
    expect(sends()[q.localId]!.state).toBe('failed');
    const { client, calls } = fakeClient(async (p) => ({ userMessage: real(p), agentMessageId: 'a' }));
    ready = client;
    retrySend(q.localId);
    await flush();
    expect(placed).toEqual([q.localId, q.localId]);
    expect(calls).toHaveLength(1);
    expect(sends()).toEqual({});
  });

  it('waits while another computer is on screen', async () => {
    const q = enqueueSend({ botId: 'b1', threadId: 't1', text: 'hi', images: [] })!;
    onScreen = 'team:acme';
    const { client, calls } = fakeClient(async (p) => ({ userMessage: real(p), agentMessageId: 'a' }));
    ready = client;
    pumpOutbox();
    await flush();
    expect(calls).toHaveLength(0);
    expect(sends()[q.localId]!.state).toBe('queued');
    onScreen = 'own';
    pumpOutbox();
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('lets the computer’s own event settle a copy, and deletes one Not sent', async () => {
    const a = enqueueSend({ botId: 'b1', threadId: 't1', text: 'a', images: [] })!;
    absorbSent(a.localId);
    expect(sends()[a.localId]).toBeUndefined();
    const b = enqueueSend({ botId: 'b1', threadId: 't1', text: 'b', images: [] })!;
    failWaiting('refused');
    expect(sends()[b.localId]).toMatchObject({ state: 'failed', error: 'refused' });
    discardSend(b.localId);
    expect(removed).toEqual([b.localId]);
    expect(sends()).toEqual({});
  });

  it('puts back what a saved copy had on its way, and forgets a lost computer’s queue', async () => {
    const q: QueuedSend = { localId: 'local:k', key: 'team:acme', botId: 'b1', threadId: 't1', text: 'x', images: [], sentAt: 1, state: 'queued' };
    onScreen = 'team:acme';
    restoreSends([q]);
    expect(placed).toEqual(['local:k']);
    expect(wakes).toBe(1);
    dropSendsFor('team:acme');
    expect(sends()).toEqual({});
  });

  it('queues nothing while this Mac is on screen', () => {
    onScreen = null;
    expect(enqueueSend({ botId: 'b1', threadId: 't1', text: 'x', images: [] })).toBeNull();
  });

  it('places the copy after everything already in the chat', () => {
    const q: QueuedSend = { localId: 'local:k', key: 'own', botId: 'b1', threadId: 't1', text: 'x', images: [{ mimeType: 'image/png', data: 'AA' }], sentAt: 100, state: 'queued' };
    const m = localMessage(q, 500);
    expect(m).toMatchObject({ id: 'local:k', clientId: 'local:k', role: 'user', createdAt: 501, via: 'desktop' });
    expect(m.parts.map((p) => p.type)).toEqual(['image', 'text']);
  });

  it('waits for the computer for a call that can’t queue, or says it didn’t come', async () => {
    const pending = whenCloudReady(2000);
    const { client } = fakeClient(async () => ({}));
    ready = client;
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBe(client);
    ready = null;
    const late = whenCloudReady(1000);
    await vi.advanceTimersByTimeAsync(1300);
    await expect(late).resolves.toBeNull();
  });
});
