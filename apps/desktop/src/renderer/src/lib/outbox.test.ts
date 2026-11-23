// The send queue as the window uses it on this Mac (lib/outbox.ts with actions.ts's chat side and the real store):
// what shows at once, the order things go in, a dropped connection, the computer's echo, and a refusal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Thread } from '@appubot/protocol';
import { GatewayError, type GatewayLike } from './gateway';
import { MAC_KEY, enqueueSend, pumpOutbox, resetOutbox, retrySend, setMacOutboxLink, setOutboxLink, takeBackSend, useOutbox } from './outbox';
import { applyEvent } from './events';
import { getState, mergeConversation, rowKeyOf, setState } from './store';
import { resetOverlay } from './optimistic';
import './actions';

const thread = (status: Thread['status'] = 'idle'): Thread => ({
  id: 't1', botId: 'b1', title: 'Chat', providerId: 'claude-code', cwd: '/x', status, modes: [], models: [], efforts: [], fastAvailable: false, fast: false,
  commands: [], source: 'desktop', lastMessagePreview: '', createdAt: 1, updatedAt: 1,
});

type Send = { clientId?: string; text: string; attachments?: { id: string }[] };
let calls: Send[];
let answer: (p: Send) => Promise<unknown>;
let ready: GatewayLike | null;
let uploads: string[];

const real = (p: Send, extra: Partial<Message> = {}): Message =>
  ({ id: `msg_${p.text}`, threadId: 't1', role: 'user', parts: [{ type: 'text', text: p.text }], status: 'complete', via: 'desktop', clientId: p.clientId, createdAt: Date.now(), updatedAt: Date.now(), ...extra }) as Message;
const ok = async (p: Send) => ({ userMessage: real(p), agentMessageId: `reply_${p.text}` });

const client = {
  state: 'connected',
  call: vi.fn(async (_m: string, p: Send) => { calls.push(p); return answer(p); }),
  upload: vi.fn(async (_f: Blob, name: string) => { uploads.push(name); return { id: `f_${name}`, name, mimeType: 'text/plain', size: 1, url: `/files/f_${name}` }; }),
} as unknown as GatewayLike;

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const ids = () => getState().convo.t1!.ids;
const shownThread = () => getState().threads.find((t) => t.id === 't1')!;

beforeEach(() => {
  vi.useFakeTimers();
  resetOutbox();
  resetOverlay();
  calls = [];
  uploads = [];
  answer = ok;
  ready = client;
  setOutboxLink(null);
  setMacOutboxLink({ onScreen: () => MAC_KEY, ready: () => ready, wake: () => undefined, waitMs: 60_000 });
  setState({ threads: [thread()], bots: [], convo: {}, convoLru: [], hydrated: true });
  mergeConversation('t1', [], { newest: true, hasMore: false });
});
afterEach(() => { vi.useRealTimers(); });

describe('sending on this Mac', () => {
  it('shows the message and the bot working at once, then the computer’s copy takes the same row', async () => {
    const q = enqueueSend({ botId: 'b1', threadId: 't1', text: 'hello', images: [] })!;
    // before any answer: the copy, the working row, and the chat working
    expect(ids()).toEqual([q.localId, `${q.localId}:reply`]);
    expect(shownThread().status).toBe('running');
    await flush();
    expect(calls).toEqual([expect.objectContaining({ clientId: q.localId, text: 'hello' })]);
    expect(ids()).toEqual(['msg_hello', 'reply_hello']);
    expect(rowKeyOf('msg_hello')).toBe(q.localId);
    expect(rowKeyOf('reply_hello')).toBe(`${q.localId}:reply`);
    expect(useOutbox.getState().sends).toEqual({});
  });

  it('sends in the order written, one at a time', async () => {
    let release!: () => void;
    answer = async (p) => { if (p.text === 'one') await new Promise<void>((r) => { release = r; }); return ok(p); };
    enqueueSend({ botId: 'b1', threadId: 't1', text: 'one', images: [] }, 1000);
    enqueueSend({ botId: 'b1', threadId: 't1', text: 'two', images: [] }, 2000);
    await flush();
    // the second waits for the first's answer
    expect(calls.map((c) => c.text)).toEqual(['one']);
    release();
    await flush();
    expect(calls.map((c) => c.text)).toEqual(['one', 'two']);
  });

  it('only the first message to an idle bot gets a working row (the next ones join its turn)', () => {
    const a = enqueueSend({ botId: 'b1', threadId: 't1', text: 'one', images: [] }, 1000)!;
    const b = enqueueSend({ botId: 'b1', threadId: 't1', text: 'two', images: [] }, 2000)!;
    expect(ids()).toEqual([a.localId, `${a.localId}:reply`, b.localId]);
  });

  it('sends again with the same id after a dropped connection, and once only', async () => {
    let first = true;
    answer = async (p) => { if (first) { first = false; throw new GatewayError('disconnected', 'gone'); } return ok(p); };
    const q = enqueueSend({ botId: 'b1', threadId: 't1', text: 'hello', images: [] })!;
    await flush();
    expect(useOutbox.getState().sends[q.localId]!.state).toBe('queued');
    // the connection's hello pumps it again
    pumpOutbox();
    await flush();
    expect(calls.map((c) => c.clientId)).toEqual([q.localId, q.localId]);
    expect(ids()).toEqual(['msg_hello', 'reply_hello']);
  });

  it('waits while the computer is away, and goes when it says hello', async () => {
    ready = null;
    const q = enqueueSend({ botId: 'b1', threadId: 't1', text: 'hello', images: [] })!;
    await flush();
    expect(calls).toEqual([]);
    expect(useOutbox.getState().sends[q.localId]!.state).toBe('queued');
    ready = client;
    pumpOutbox();
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('takes the computer’s echo before its answer, and the answer then adds nothing', async () => {
    let release!: () => void;
    answer = async (p) => { await new Promise<void>((r) => { release = r; }); return ok(p); };
    const q = enqueueSend({ botId: 'b1', threadId: 't1', text: 'hello', images: [] })!;
    await flush();
    // the computer's events land first: your message, then its reply's first words
    applyEvent('message.created', real({ clientId: q.localId, text: 'hello' }));
    expect(ids()).toEqual(['msg_hello', `${q.localId}:reply`]);
    expect(useOutbox.getState().sends).toEqual({});
    applyEvent('message.delta', { threadId: 't1', messageId: 'reply_hello', partIndex: 0, partType: 'text', delta: 'Hi' });
    expect(ids()).toEqual(['msg_hello', 'reply_hello']);
    expect(rowKeyOf('reply_hello')).toBe(`${q.localId}:reply`);
    release();
    await flush();
    expect(ids()).toEqual(['msg_hello', 'reply_hello']);
    expect(getState().convo.t1!.byId.reply_hello!.parts).toEqual([{ type: 'text', text: 'Hi' }]);
  });

  it('a refused message stays with its words, marked, its working row and the chat’s working gone; Edit gives them back', async () => {
    answer = async () => { throw new GatewayError('bad_request', 'No such bot'); };
    const q = enqueueSend({ botId: 'b1', threadId: 't1', text: 'keep me', images: [] })!;
    expect(shownThread().status).toBe('running');
    await flush();
    const s = useOutbox.getState().sends[q.localId]!;
    expect(s).toMatchObject({ state: 'failed', error: 'No such bot', text: 'keep me' });
    expect(ids()).toEqual([q.localId]);
    expect(getState().convo.t1!.byId[q.localId]!.parts).toEqual([{ type: 'text', text: 'keep me' }]);
    expect(shownThread().status).toBe('idle');
    // Edit: it leaves the chat, its words go back to the composer
    expect(takeBackSend(q.localId)?.text).toBe('keep me');
    expect(ids()).toEqual([]);
  });

  it('marks a message not sent after the computer stays away its whole wait, and Try again sends it', async () => {
    ready = null;
    const q = enqueueSend({ botId: 'b1', threadId: 't1', text: 'hello', images: [] })!;
    await vi.advanceTimersByTimeAsync(60_100);
    expect(useOutbox.getState().sends[q.localId]!.state).toBe('failed');
    ready = client;
    retrySend(q.localId);
    await flush();
    expect(calls.map((c) => c.clientId)).toEqual([q.localId]);
    expect(useOutbox.getState().sends).toEqual({});
  });

  it('uploads a remote computer’s files first, counting them, then sends the message naming them', async () => {
    const files = [new File(['a'], 'a.txt', { type: 'text/plain' }), new File(['b'], 'b.txt', { type: 'text/plain' })];
    const q = enqueueSend({ botId: 'b1', threadId: 't1', text: 'files', images: [], blobs: files })!;
    // the chips show at once, before any upload
    expect(getState().convo.t1!.byId[q.localId]!.parts.filter((p) => p.type === 'file')).toHaveLength(2);
    await flush();
    expect(uploads).toEqual(['a.txt', 'b.txt']);
    expect(calls[0]!.attachments).toEqual([{ id: 'f_a.txt' }, { id: 'f_b.txt' }]);
  });
});
