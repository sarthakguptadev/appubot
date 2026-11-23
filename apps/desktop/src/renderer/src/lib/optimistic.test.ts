// Optimistic actions (lib/optimistic.ts through actions.ts): shown at once, kept over stale events, put back when the
// computer refuses.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, PermissionRequest, Thread } from '@appubot/protocol';

const rpcMock = vi.hoisted(() => vi.fn());
vi.mock('./gateway', async (orig) => ({ ...(await orig<typeof import('./gateway')>()), rpc: rpcMock }));

import { GatewayError } from './gateway';
import { renameThread, setPinned, startThread } from './actions';
import { MAC_KEY, enqueueSend, resetOutbox, setMacOutboxLink, setOutboxLink } from './outbox';
import { applyEvent } from './events';
import { optimisticCall, resetOverlay } from './optimistic';
import { getState, mergeConversation, setState } from './store';

const thread: Thread = {
  id: 't1', botId: 'b1', title: 'Old', providerId: 'claude-code', cwd: '/x', status: 'idle', modes: [], models: [], efforts: [], fastAvailable: false, fast: false,
  commands: [], source: 'desktop', lastMessagePreview: '', createdAt: 1, updatedAt: 1,
};
const bot = { id: 'b1', name: 'Ada', pinned: false } as unknown as import('@appubot/protocol').Bot;

/** a request whose answer the test hands over */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const title = () => getState().threads.find((t) => t.id === 't1')?.title;

beforeEach(() => {
  rpcMock.mockReset();
  resetOverlay();
  setState({ threads: [thread], bots: [bot], toasts: [], convo: {}, pendingPermissions: [], selectedBotId: 'b1', selectedThreadId: 't1', threadPick: {} });
});

describe('optimistic actions', () => {
  it('renames at once, holds over a stale event, and keeps the computer’s answer', async () => {
    const d = deferred<Thread>();
    rpcMock.mockReturnValueOnce(d.promise);
    const done = renameThread('t1', 'New');
    expect(title()).toBe('New');
    // the computer's status change from before it got the rename
    applyEvent('thread.updated', { ...thread, status: 'running', updatedAt: 2 });
    expect(title()).toBe('New');
    expect(getState().threads[0]!.status).toBe('running');
    d.resolve({ ...thread, title: 'New', status: 'running', updatedAt: 3 });
    expect(await done).toBe(true);
    expect(title()).toBe('New');
  });

  it('puts the old name back, with an error, when the computer refuses', async () => {
    rpcMock.mockRejectedValueOnce(new GatewayError('not_found', 'No such thread'));
    expect(await renameThread('t1', 'New')).toBe(false);
    expect(title()).toBe('Old');
    expect(getState().toasts.at(-1)).toMatchObject({ title: 'Could not rename the thread', level: 'error' });
  });

  it('unpins back when refused', async () => {
    const d = deferred<never>();
    rpcMock.mockReturnValueOnce(d.promise);
    const done = setPinned(bot, true);
    expect(getState().bots[0]!.pinned).toBe(true);
    d.reject(new GatewayError('denied', 'no'));
    await done;
    expect(getState().bots[0]!.pinned).toBe(false);
  });

  it('a deleted thread goes at once and comes back in its place if refused', async () => {
    setState({ threads: [{ ...thread, id: 't0' }, thread, { ...thread, id: 't2' }] });
    const d = deferred<never>();
    rpcMock.mockReturnValueOnce(d.promise);
    const done = optimisticCall('threads.delete', { id: 't1' }, [{ kind: 'remove', coll: 'threads', id: 't1' }], { errorTitle: 'Could not delete the thread' });
    expect(getState().threads.map((t) => t.id)).toEqual(['t0', 't2']);
    // an event about it meanwhile doesn't bring it back
    applyEvent('thread.updated', { ...thread, title: 'Renamed', updatedAt: 5 });
    expect(getState().threads.map((t) => t.id)).toEqual(['t0', 't2']);
    d.reject(new GatewayError('denied', 'no'));
    await done;
    expect(getState().threads.map((t) => [t.id, t.title])).toEqual([['t0', 'Old'], ['t1', 'Renamed'], ['t2', 'Old']]);
  });

  it('a reaction shows at once, survives a stale reactions event, and goes back if refused', async () => {
    const msg = { id: 'm1', threadId: 't1', role: 'agent', parts: [], status: 'complete', via: 'desktop', createdAt: 1, updatedAt: 1 } as Message;
    mergeConversation('t1', [msg]);
    const d = deferred<never>();
    rpcMock.mockReturnValueOnce(d.promise);
    const done = optimisticCall('chat.react', { threadId: 't1', messageId: 'm1', emoji: '👍' }, [{ kind: 'reactions', threadId: 't1', messageId: 'm1', reactions: [{ by: 'user', emoji: '👍', at: 1 }] }], { errorTitle: 'Could not react' });
    const shown = () => getState().convo.t1!.byId.m1!.reactions;
    expect(shown()).toEqual([{ by: 'user', emoji: '👍', at: 1 }]);
    applyEvent('message.reactions', { threadId: 't1', messageId: 'm1', reactions: [] });
    expect(shown()).toEqual([{ by: 'user', emoji: '👍', at: 1 }]);
    d.reject(new GatewayError('denied', 'no'));
    await done;
    expect(shown()).toEqual([]);
  });

  it('an approval answered leaves at once, and comes back if the answer didn’t reach the computer', async () => {
    const req = { id: 'p1', threadId: 't1', title: 'Run ls', options: [] } as unknown as PermissionRequest;
    setState({ pendingPermissions: [req] });
    rpcMock.mockRejectedValueOnce(new GatewayError('timeout', 'slow'));
    const done = optimisticCall('permissions.respond', { id: 'p1', optionId: 'allow' }, [{ kind: 'remove', coll: 'pendingPermissions', id: 'p1' }], { errorTitle: 'Could not send your answer' });
    expect(getState().pendingPermissions).toEqual([]);
    await done;
    await flush();
    expect(getState().pendingPermissions.map((p) => p.id)).toEqual(['p1']);
  });

  it('a new chat shows at once; a message typed into it waits for the computer’s chat, then goes there', async () => {
    resetOutbox();
    const sent: { threadId?: string; clientId?: string }[] = [];
    const client = { state: 'connected', call: vi.fn(async (_m: string, p: { threadId: string; clientId: string; text: string }) => {
      sent.push(p);
      return { userMessage: { id: 'u1', threadId: p.threadId, role: 'user', parts: [{ type: 'text', text: p.text }], status: 'complete', via: 'desktop', clientId: p.clientId, createdAt: 10, updatedAt: 10 }, agentMessageId: 'a1' };
    }) } as unknown as import('./gateway').GatewayLike;
    setOutboxLink(null);
    setMacOutboxLink({ onScreen: () => MAC_KEY, ready: () => client, wake: () => undefined });
    const d = deferred<Thread>();
    rpcMock.mockReturnValueOnce(d.promise);
    const made = startThread('b1');
    const local = getState().selectedThreadId!;
    expect(local).toMatch(/^local:/);
    expect(getState().convo[local]!.loaded).toBe(true);
    const q = enqueueSend({ botId: 'b1', threadId: local, text: 'hi', images: [] })!;
    await flush();
    // nothing goes before the computer has the chat
    expect(sent).toEqual([]);
    expect(getState().convo[local]!.ids[0]).toBe(q.localId);
    rpcMock.mockResolvedValue({ thread: { ...thread, id: 't9' }, messages: [], hasMore: false });
    d.resolve({ ...thread, id: 't9', title: 'New thread' });
    await made;
    await flush();
    expect(getState().selectedThreadId).toBe('t9');
    expect(getState().threads.some((t) => t.id === local)).toBe(false);
    expect(sent).toEqual([expect.objectContaining({ threadId: 't9', clientId: q.localId })]);
    expect(getState().convo.t9!.ids).toEqual(['u1', 'a1']);
  });
});
