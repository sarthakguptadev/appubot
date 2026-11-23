import { describe, expect, it } from 'vitest';
import type { Bot, ComputerStatus, Message, Thread } from '@appubot/protocol';
import type { AppState, Conversation } from '../../lib/store';
import { CACHE_CHAT_MAX_CHARS, CACHE_MESSAGES, QUEUED_MAX_AGE_MS, TOOL_TEXT_MAX, keepInMemory, keptMessages, lighten, quietComputer, recentChats, restoreComputer, serializeComputer, syncStripView } from './cloudCacheData';
import type { QueuedSend } from './cloudOutbox';

const NOW = 1_800_000_000_000;

const thread = (id: string, botId: string, at: number, extra: Partial<Thread> = {}): Thread =>
  ({ id, botId, title: id, status: 'idle', createdAt: at, updatedAt: at, lastActiveAt: at, models: [], modes: [], commands: [], ...extra }) as unknown as Thread;
const msg = (id: string, threadId: string, at: number, extra: Partial<Message> = {}): Message =>
  ({ id, threadId, role: 'user', parts: [{ type: 'text', text: id }], status: 'complete', via: 'desktop', createdAt: at, updatedAt: at, ...extra }) as Message;
const convo = (list: Message[], extra: Partial<Conversation> = {}): Conversation =>
  ({ ids: list.map((m) => m.id), byId: Object.fromEntries(list.map((m) => [m.id, m])), loaded: true, loading: false, hasMore: false, ...extra });

function state(over: Partial<AppState> = {}): AppState {
  return {
    bots: [{ id: 'b1', name: 'Ada' } as Bot], threads: [], providers: [], devices: [], settings: null, computer: null, skills: [], routines: [],
    channels: [], system: null, voice: null, characters: [], charactersSupported: false, limits: [], limitsSupported: false, files: [], remembered: {},
    pendingPermissions: [{ id: 'perm' }] as never, pairing: { code: '123456' } as never, convo: {}, convoLru: [],
    selectedBotId: 'b1', selectedThreadId: null, threadPick: {},
    ...over,
  } as AppState;
}

describe('serializeComputer / restoreComputer', () => {
  it('keeps the lists and the place, never approvals or pairing codes, and restores chats to be refreshed', () => {
    const t1 = thread('t1', 'b1', NOW - 1000);
    const s = state({ threads: [t1], convo: { t1: convo([msg('m1', 't1', NOW - 2000), msg('m2', 't1', NOW - 1000)]) }, threadPick: { b1: 't1' } });
    const json = serializeComputer(s, [], NOW);
    expect(json).not.toContain('123456');
    expect(json).not.toContain('perm');
    const back = restoreComputer(json, NOW)!;
    expect(back.savedAt).toBe(NOW);
    expect(back.state.bots).toEqual(s.bots);
    expect(back.state.threadPick).toEqual({ b1: 't1' });
    expect(back.state.selectedBotId).toBe('b1');
    expect(back.state.convo!.t1).toMatchObject({ ids: ['m1', 'm2'], loaded: false, loading: false, hasMore: false });
    expect(back.state.pendingPermissions).toBeUndefined();
    expect(back.state.pairing).toBeUndefined();
    expect(back.state.hydrated).toBe(true);
  });

  it('keeps the screens’ last answers (Usage, Storage) with the computer, so they show while it sleeps', () => {
    const remembered = { 'usage:7d': { at: NOW - 5000, value: { totals: { costUsd: 4.2 } } }, storage: { at: NOW - 1000, value: { items: [] } } };
    const back = restoreComputer(serializeComputer(state({ remembered }), [], NOW), NOW)!;
    expect(back.state.remembered).toEqual(remembered);
    // a copy from before kept none: the store's stays as it is
    const old = JSON.parse(serializeComputer(state({ remembered }), [], NOW)) as { lists: Record<string, unknown> };
    delete old.lists.remembered;
    expect(restoreComputer(JSON.stringify(old), NOW)!.state).not.toHaveProperty('remembered');
  });

  it('keeps a computer’s groups with it, so one computer’s groups never show on another', () => {
    const groups = [{ id: 'g1', name: 'Launch', botIds: ['b1'], lastMessagePreview: 'Ada: on it', working: [], lastActiveAt: NOW }] as never;
    const back = restoreComputer(serializeComputer(state({ groups, groupsSupported: true }), [], NOW), NOW)!;
    expect(back.state.groups).toEqual(groups);
    expect(back.state.groupsSupported).toBe(true);
    // this Mac's go with its own copy while another computer is on screen
    expect(keepInMemory(state({ groups, groupsSupported: true })).groups).toEqual(groups);
  });

  it('keeps the latest messages of each chat and says when older ones were left out', () => {
    const list = Array.from({ length: CACHE_MESSAGES + 5 }, (_, i) => msg(`m${i}`, 't1', NOW + i));
    const s = state({ threads: [thread('t1', 'b1', NOW)], convo: { t1: convo(list) } });
    const back = restoreComputer(serializeComputer(s, [], NOW), NOW)!;
    expect(back.state.convo!.t1!.ids).toHaveLength(CACHE_MESSAGES);
    expect(back.state.convo!.t1!.ids[0]).toBe('m5');
    expect(back.state.convo!.t1!.hasMore).toBe(true);
  });

  it('leaves local copies to the outbox, big pictures out, and a turn cut off by the save as finished', () => {
    const big = 'A'.repeat(60_000);
    const list = [
      msg('m1', 't1', NOW, { parts: [{ type: 'image', mimeType: 'image/png', data: big, url: '/files/f1' } as never] }),
      msg('m2', 't1', NOW + 1, { role: 'agent', status: 'streaming' }),
      msg('local:x', 't1', NOW + 2),
    ];
    const s = state({ threads: [thread('t1', 'b1', NOW, { status: 'running' })], convo: { t1: convo(list) } });
    const json = serializeComputer(s, [], NOW);
    expect(json).not.toContain(big);
    const back = restoreComputer(json, NOW)!;
    const c = back.state.convo!.t1!;
    expect(c.ids).toEqual(['m1', 'm2']);
    expect(c.byId.m1!.parts[0]).toEqual({ type: 'image', mimeType: 'image/png', url: '/files/f1' });
    expect(c.byId.m2!.status).toBe('complete');
    expect(back.state.threads![0]!.status).toBe('idle');
  });

  it('drops the least recent chats first when the copy would be too big', () => {
    const threads = [thread('old', 'b1', NOW - 5000), thread('new', 'b1', NOW)];
    const long = (t: string) => Array.from({ length: 20 }, (_, i) => msg(`${t}${i}`, t, NOW + i, { parts: [{ type: 'text', text: 'x'.repeat(1000) }] }));
    const s = state({ threads, convo: { old: convo(long('old')), new: convo(long('new')) } });
    const back = restoreComputer(serializeComputer(s, [], NOW, 30_000), NOW)!;
    expect(Object.keys(back.state.convo!)).toEqual(['new']);
  });

  it('keeps a tool call light: long outputs cut, pictures and the raw output out, a small input kept', () => {
    const big = 'o'.repeat(50_000);
    const tool = {
      type: 'tool_call', toolCallId: 'c1', title: 'Look at the window', kind: 'computer', status: 'completed', locations: [],
      content: [{ type: 'text', text: big }, { type: 'image', mimeType: 'image/jpeg', data: 'x'.repeat(60_000) }, { type: 'terminal', terminalId: 't', output: big }, { type: 'resource_link', uri: 'file:///a', name: 'a' }],
      rawInput: { label: 'OK' }, rawOutput: { tree: big },
    } as unknown as Message['parts'][number];
    const m = lighten(msg('m', 't', NOW, { role: 'agent', parts: [{ type: 'text', text: 'Done' }, tool] } as Partial<Message>));
    const kept = m.parts[1] as Extract<Message['parts'][number], { type: 'tool_call' }>;
    expect(kept.rawOutput).toBeUndefined();
    expect(kept.rawInput).toEqual({ label: 'OK' });
    expect(kept.content.map((c) => c.type)).toEqual(['text', 'terminal', 'resource_link']);
    expect((kept.content[0] as { text: string }).text.length).toBe(TOOL_TEXT_MAX + 1);
    expect(JSON.stringify(m).length).toBeLessThan(6_000);
    // a message already light is the same object (nothing re-encoded for nothing)
    const small = msg('s', 't', NOW);
    expect(lighten(small)).toBe(small);
  });

  it('keeps a chat’s newest messages within its own budget, the newest one always', () => {
    const heavy = (i: number) => msg(`m${i}`, 't', NOW + i, { parts: [{ type: 'text', text: 'x'.repeat(150_000) }] });
    const kept = keptMessages(convo([heavy(1), heavy(2), heavy(3), heavy(4)]));
    expect(kept.messages.map((m) => m.id)).toEqual(['m3', 'm4']);
    expect(kept.hasMore).toBe(true);
    const one = keptMessages(convo([msg('a', 't', NOW, { parts: [{ type: 'text', text: 'x'.repeat(CACHE_CHAT_MAX_CHARS + 10) }] })]));
    expect(one.messages.map((m) => m.id)).toEqual(['a']);
  });

  it('saves the other chats when one is too big for what is left (a computer-use chat never keeps the rest out)', () => {
    const threads = [thread('huge', 'b1', NOW), thread('small', 'b2', NOW - 10), thread('tiny', 'b3', NOW - 20)];
    const tool = (n: number) => ({ type: 'tool_call', toolCallId: `c${n}`, title: 'Look', kind: 'computer', status: 'completed', locations: [], content: [{ type: 'text', text: 'o'.repeat(1_000) }] }) as unknown as Message['parts'][number];
    // a chat of tool calls that, lightened, still passes a 60 K budget's remainder
    const hugeMsgs = Array.from({ length: 20 }, (_, i) => msg(`h${i}`, 'huge', NOW + i, { role: 'agent', parts: Array.from({ length: 10 }, (_, k) => tool(k)) } as Partial<Message>));
    const s = state({ threads, convo: { huge: convo(hugeMsgs), small: convo([msg('s1', 'small', NOW)]), tiny: convo([msg('t1', 'tiny', NOW)]) } });
    const back = restoreComputer(serializeComputer(s, [], NOW, 60_000), NOW)!;
    expect(Object.keys(back.state.convo!).sort()).toEqual(['small', 'tiny']);
    // with room for it, the huge chat comes along, its tool outputs as they are (each under the cut)
    const all = restoreComputer(serializeComputer(s, [], NOW), NOW)!;
    expect(Object.keys(all.state.convo!).sort()).toEqual(['huge', 'small', 'tiny']);
  });

  it('keeps the chat on screen among the recent ones', () => {
    const threads = [thread('a', 'b1', NOW), thread('b', 'b1', NOW - 10), thread('c', 'b1', NOW - 20)];
    const c = convo([msg('m', 'x', NOW)]);
    expect(recentChats({ threads, convo: { a: c, b: c, c }, selectedThreadId: 'c' }, 2)).toEqual(['c', 'a']);
  });

  it('brings messages on their way back, queued, unless too old to go by themselves', () => {
    const q = (localId: string, sentAt: number, state: QueuedSend['state'] = 'sending'): QueuedSend =>
      ({ localId, key: 'own', botId: 'b1', threadId: 't1', text: 'hi', images: [], sentAt, state });
    const json = serializeComputer(state(), [q('local:a', NOW - 1000), q('local:b', NOW - QUEUED_MAX_AGE_MS - 1), q('local:c', NOW, 'failed')], NOW);
    const back = restoreComputer(json, NOW)!;
    expect(back.outbox.map((x) => [x.localId, x.state])).toEqual([['local:a', 'queued'], ['local:b', 'failed'], ['local:c', 'failed']]);
  });

  it('refuses what isn’t a copy this version reads', () => {
    expect(restoreComputer('not json')).toBeNull();
    expect(restoreComputer('{"v":99,"lists":{"bots":[],"threads":[]}}')).toBeNull();
    expect(restoreComputer('{"v":1,"lists":{}}')).toBeNull();
  });
});

describe('the computer’s status and this Mac’s memory copy', () => {
  it('forgets what only holds while the computer is up', () => {
    const c = { backend: 'native', available: true, busy: true, paused: false, activeThreadId: 't1', waits: [{ threadId: 't1' }], control: { id: 'x' }, screenThreadId: 't1' } as unknown as ComputerStatus;
    const q = quietComputer(c)!;
    expect(q).toMatchObject({ backend: 'native', available: true, busy: false });
    expect(q.activeThreadId).toBeUndefined();
    expect(q.waits).toBeUndefined();
    expect(q.control).toBeUndefined();
  });

  it('marks this Mac’s chats to load again', () => {
    const kept = keepInMemory(state({ convo: { t1: convo([msg('m1', 't1', NOW)]) } }));
    expect(kept.convo!.t1!.loaded).toBe(false);
    expect(kept.bots).toHaveLength(1);
  });
});

describe('syncStripView', () => {
  const base = { computer: 'cloud' as const, cached: true, ready: false, conn: 'connecting' };
  it('says nothing while it wakes or connects, or even fails, for its first 30 s', () => {
    expect(syncStripView(base)).toBeNull();
    expect(syncStripView({ ...base, conn: 'closed', error: 'refused' })).toBeNull();
  });
  it('says so once it has gone 30 s without its word', () => {
    expect(syncStripView({ ...base, late: true })?.text).toContain('Still trying');
    expect(syncStripView({ ...base, conn: 'closed', error: 'refused', late: true })?.text).toContain('refused');
  });
  it('says a refusal retrying can’t fix at once', () => {
    expect(syncStripView({ ...base, conn: 'unauthorized' })).not.toBeNull();
    expect(syncStripView({ ...base, conn: 'incompatible' })).not.toBeNull();
  });
  it('shows nothing once its word is in, without a copy, or on this Mac', () => {
    expect(syncStripView({ ...base, ready: true, late: true, error: 'x' })).toBeNull();
    expect(syncStripView({ ...base, cached: false, late: true, error: 'x' })).toBeNull();
    expect(syncStripView({ ...base, computer: 'local', late: true, error: 'x' })).toBeNull();
  });
});
