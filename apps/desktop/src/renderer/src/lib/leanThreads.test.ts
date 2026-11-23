import { describe, expect, it, vi } from 'vitest';
import { ThreadSchema, leanThread, type Snapshot, type Thread } from '@appubot/protocol';

vi.mock('./native', () => ({ native: () => ({ version: '1' }) }));
vi.mock('./platform', () => ({ MACHINE: 'Mac' }));

const COMPACT = { name: 'compact', description: 'Sum up the chat' };
const thread = (id: string, extra: Partial<Thread> = {}): Thread => ThreadSchema.parse({
  id, botId: 'bot_a', title: 'Chat', providerId: 'claude-code', cwd: '/x', createdAt: 1, updatedAt: 1,
  context: { used: 1000, size: 200_000 }, commands: [COMPACT], ...extra,
});
const snapshot = (threads: Thread[]): Snapshot => ({
  bots: [], threads, providers: [], pendingPermissions: [], devices: [], routines: [], channels: [], skills: [], computer: null,
  settings: {} as Snapshot['settings'], system: {} as Snapshot['system'],
} as unknown as Snapshot);

/*
 * The cloud computer's gateway treats this Mac as a paired device, so its hello, `threads.list` and `thread.updated`
 * carry threads without `commands` (protocol `leanThread`). The chat (the context ring's `thread.commands.some`, the
 * composer's "/" list) reads it as an array: a lean thread in the store blanked the window on switching to Cloud.
 */
describe('threads from a computer this Mac is a paired device of', () => {
  it('always have a commands array in the store, keeping the ones read before', async () => {
    const { getState, setState, upsertThreads } = await import('./store');
    const { applyEvent } = await import('./events');
    setState({ threads: [] });

    const lean = leanThread(thread('thr_1'));
    expect('commands' in lean).toBe(false);
    applyEvent('hello', snapshot([lean, leanThread(thread('thr_2', { commands: [] }))]));
    for (const t of getState().threads) expect(t.commands).toEqual([]);
    // what the context ring does with it
    expect(getState().threads[0]!.commands.some((c) => c.name === 'compact')).toBe(false);

    // read with threads.commands, then a lean update (status, title...) doesn't lose them
    setState((s) => ({ threads: s.threads.map((t) => (t.id === 'thr_1' ? { ...t, commands: [COMPACT] } : t)) }));
    applyEvent('thread.updated', leanThread(thread('thr_1', { status: 'running', updatedAt: 2 })));
    expect(getState().threads.find((t) => t.id === 'thr_1')!.commands).toEqual([COMPACT]);
    // nor a reconnect's hello, nor a threads.list page
    applyEvent('hello', snapshot([leanThread(thread('thr_1', { updatedAt: 3 }))]));
    expect(getState().threads.find((t) => t.id === 'thr_1')!.commands).toEqual([COMPACT]);
    upsertThreads([leanThread(thread('thr_1', { updatedAt: 4 })), leanThread(thread('thr_3'))]);
    expect(getState().threads.find((t) => t.id === 'thr_1')!.commands).toEqual([COMPACT]);
    expect(getState().threads.find((t) => t.id === 'thr_3')!.commands).toEqual([]);

    // this Mac's own gateway sends full threads: they are taken as they are
    applyEvent('thread.updated', thread('thr_1', { commands: [], updatedAt: 5 }));
    expect(getState().threads.find((t) => t.id === 'thr_1')!.commands).toEqual([]);
  });
});
