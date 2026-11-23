import { describe, expect, it } from 'vitest';
import type { Message } from '@appubot/protocol';
import { EventBus } from './events';

describe('EventBus', () => {
  it('keeps only the newest screenshot frame whole (a reconnect replays just that one)', () => {
    const bus = new EventBus();
    const frame = (id: string) => ({ id, mimeType: 'image/png', data: `pixels-${id}`, width: 10, height: 10, ts: 1 });
    bus.emit('computer.frame', frame('a'));
    bus.emit('computer.frame', frame('b'));
    const frames = (bus.since(0) ?? []).filter((e) => e.event === 'computer.frame').map((e) => e.payload as { id: string; data: string });
    expect(frames).toEqual([expect.objectContaining({ id: 'a', data: '' }), expect.objectContaining({ id: 'b', data: 'pixels-b' })]);
  });

  it('tells a lastSeq from another run of the app: it can’t be replayed', () => {
    const a = new EventBus();
    const b = new EventBus();
    expect(a.bootId).not.toBe(b.bootId);
    a.emit('thread.deleted', { id: 't1' });
    expect(a.since(0)).toHaveLength(1);
    expect(a.since(1)).toEqual([]);
    // the phone saw seq 500 from the run before; this one is only at 1
    expect(a.since(500)).toBeNull();
  });

  it('still covers the last `capacity` events while it trims in batches', () => {
    const bus = new EventBus({ capacity: 8 });
    for (let i = 0; i < 50; i++) bus.emit('thread.deleted', { id: `t${i}` });
    expect(bus.since(42)!.map((e) => e.seq)).toEqual([43, 44, 45, 46, 47, 48, 49, 50]);
    expect(bus.since(10)).toBeNull();
  });

  it('stamps message events with the message’s revision, a coalesced delta with the last one', () => {
    const bus = new EventBus();
    const msg: Message = { id: 'm1', threadId: 't1', role: 'agent', parts: [], status: 'streaming', via: 'desktop', createdAt: 1, updatedAt: 1 };
    bus.trackRevisions((threadId, id) => (threadId === 't1' && id === 'm1' ? msg : undefined));
    const seen: { event: string; rev?: number; delta?: string }[] = [];
    bus.on((e) => seen.push({ event: e.event, ...(e.payload as { rev?: number; delta?: string }) }));
    bus.emit('message.created', structuredClone(msg));
    bus.emit('message.delta', { threadId: 't1', messageId: 'm1', partIndex: 0, partType: 'text', delta: 'Hel' });
    bus.emit('message.delta', { threadId: 't1', messageId: 'm1', partIndex: 0, partType: 'text', delta: 'lo' });
    // the stored message is at the revision of its newest change already, before the coalesced delta goes out
    expect(msg.rev).toBe(3);
    bus.flush();
    bus.emit('message.completed', { threadId: 't1', messageId: 'm1', status: 'complete' });
    expect(seen.map((x) => [x.event, x.rev])).toEqual([['message.created', 1], ['message.delta', 3], ['message.completed', 4]]);
    expect(seen[1]!.delta).toBe('Hello');
    // a message it doesn't know (an old one in the archive) goes out without one
    bus.emit('message.reactions', { threadId: 't1', messageId: 'old', reactions: [] });
    expect(seen.at(-1)!.rev).toBeUndefined();
  });
});
