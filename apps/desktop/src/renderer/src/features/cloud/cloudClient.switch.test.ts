/**
 * Switching to a cloud computer with a saved copy: its chat shows the copy's messages at once, keeps them through the
 * hello and while the newest page is read (never a blank or a spinner over them).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Snapshot, Thread } from '@appubot/protocol';

// the window as the hold rules see it (no DOM here)
(globalThis as { document?: unknown }).document ??= { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} };

const localCalls: { method: string; params: unknown }[] = [];
let copyJson: string | null = null;

vi.mock('../../lib/native', () => ({ native: () => ({ version: 'test' }) }));
vi.mock('../../lib/macName', () => ({ macName: () => 'Test Mac' }));
vi.mock('../../lib/gateway', async (orig) => {
  const real = await orig<typeof import('../../lib/gateway')>();
  return {
    ...real,
    localGateway: () => ({
      state: 'connected',
      call: async (method: string, params: unknown) => {
        localCalls.push({ method, params });
        if (method === 'cloudAccount.cacheGet') return copyJson ? { data: copyJson, savedAt: 1 } : null;
        if (method === 'cloudAccount.cacheSet') return { ok: true };
        return {};
      },
      close() {}, connect() {},
    }),
  };
});
vi.mock('./cloudAccount', async (orig) => {
  const real = await orig<typeof import('./cloudAccount')>();
  return {
    ...real,
    cloudConnection: async () => ({ publicUrl: 'https://x.agent37.app', token: 't', key: 'k', deviceId: 'd', hostName: 'Cloud' }),
    loadCloud: async () => real.useCloud.getState().view,
    pairCloud: async () => true,
  };
});
vi.mock('./cloudView', async (orig) => {
  const real = await orig<typeof import('./cloudView')>();
  return { ...real, canWork: () => true, cloudPhase: () => 'running' };
});

import { getState, setState } from '../../lib/store';
import { loadConversation } from '../../lib/actions';
import { serializeComputer } from './cloudCacheData';
import { setCloudClientFactory, switchComputer, useCloudLink } from './cloudClient';
import { useCloud } from './cloudAccount';
import type { GatewayLike } from '../../lib/gateway';

const thread = (id: string, botId: string, at: number): Thread => ({
  id, botId, title: `Chat ${id}`, status: 'idle', source: 'desktop', createdAt: at, updatedAt: at, lastActiveAt: at, lastMessagePreview: 'hi',
  cwd: '', models: [], modes: [], efforts: [], providerId: 'claude-code',
} as unknown as Thread);
const msg = (id: string, threadId: string, at: number): Message =>
  ({ id, threadId, role: 'user', parts: [{ type: 'text', text: id }], status: 'complete', via: 'desktop', createdAt: at, updatedAt: at }) as Message;

/** a cloud client that connects when told and answers history with the computer's own messages */
function fakeClient() {
  const any: ((e: string, p: unknown) => void)[] = [];
  const states: ((s: string, err?: string) => void)[] = [];
  const snapshot: Snapshot = {
    bots: [{ id: 'b1', name: 'HackerOne', providerId: 'claude-code', shape: 'circle', color: '#000', workspace: '/w', effort: 'medium', fast: false, computerUse: false, pinned: false, appsOff: [], autoApprove: false } as never],
    threads: [thread('t1', 'b1', 100)], providers: [], devices: [], settings: {} as never, computer: null as never, skills: [], routines: [], channels: [],
    system: {} as never, pendingPermissions: [],
  } as unknown as Snapshot;
  const client = {
    state: 'idle' as string,
    snapshot,
    onAny: (fn: (e: string, p: unknown) => void) => { any.push(fn); return () => {}; },
    onState: (fn: (s: string, err?: string) => void) => { states.push(fn); return () => {}; },
    // a real client connects in its own time (a sleeping computer takes a while): `arrive` is its answer
    connect() { this.state = 'connecting'; for (const f of states) f('connecting'); },
    arrive() { this.state = 'connected'; for (const f of states) f('connected'); for (const f of any) f('hello', snapshot); },
    close() { this.state = 'closed'; for (const f of states) f('closed'); },
    call: vi.fn(async (method: string) => {
      if (method === 'threads.history') return { messages: [msg('m1', 't1', 10), msg('m2', 't1', 20), msg('m3', 't1', 30)], hasMore: false };
      return {};
    }),
  };
  return client as unknown as GatewayLike & typeof client;
}

beforeEach(() => {
  localCalls.length = 0;
  copyJson = null;
  useCloud.setState({ view: { signedIn: true, paired: true, computer: { state: 'running' } } as never, supported: true });
  setState({ hydrated: true, conn: 'connected', bots: [], threads: [], convo: {}, convoLru: [], selectedBotId: null, selectedThreadId: null, threadPick: {} });
});
afterEach(() => { setCloudClientFactory(null); });

describe('switching to a cloud computer with a saved copy', () => {
  it('shows the copy’s messages at once and keeps them until the newest page replaces them', async () => {
    // the copy: as the window saved it last time, with the chat on screen loaded
    copyJson = serializeComputer({
      ...getState(),
      bots: [{ id: 'b1', name: 'HackerOne' } as never], threads: [thread('t1', 'b1', 100)],
      convo: { t1: { ids: ['m1', 'm2'], byId: { m1: msg('m1', 't1', 10), m2: msg('m2', 't1', 20) }, loaded: true, loading: false, hasMore: false } },
      convoLru: ['t1'], selectedBotId: 'b1', selectedThreadId: 't1', threadPick: { b1: 't1' },
    }, []);
    const client = fakeClient();
    setCloudClientFactory(() => client);

    await switchComputer('cloud');
    // the copy is on screen before the computer has answered
    expect(useCloudLink.getState()).toMatchObject({ computer: 'cloud', cached: true, ready: false });
    expect(getState().selectedThreadId).toBe('t1');
    expect(getState().convo.t1?.ids).toEqual(['m1', 'm2']);
    // nothing shows a spinner over them: not loaded, not loading, but with messages
    expect(getState().convo.t1).toMatchObject({ loaded: false, loading: false });

    // the computer answers: its hello keeps the copy's messages (marked to read again)
    client.arrive();
    expect(useCloudLink.getState().ready).toBe(true);
    expect(getState().selectedThreadId).toBe('t1');
    expect(getState().convo.t1?.ids).toEqual(['m1', 'm2']);

    // the newest page is read behind them, then takes their place
    const p = loadConversation('t1');
    expect(getState().convo.t1).toMatchObject({ loading: true, ids: ['m1', 'm2'] });
    await p;
    expect(getState().convo.t1).toMatchObject({ loaded: true, loading: false, ids: ['m1', 'm2', 'm3'] });
  });
});
