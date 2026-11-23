/**
 * A launch that ends on a cloud computer: the window says so from its first moment (`placing`), so the splash stays up
 * and this computer's bots never show first; it is over once the cloud computer is on screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '@appubot/protocol';

const storage = vi.hoisted(() => {
  const kept = new Map<string, string>([['appubot:lastComputer', 'cloud']]);
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => { kept.set(k, v); },
    removeItem: (k: string) => { kept.delete(k); },
  };
  return kept;
});

// the window as the hold rules see it (no DOM here)
(globalThis as { document?: unknown }).document ??= { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} };

vi.mock('../../lib/native', () => ({ native: () => ({ version: 'test' }) }));
vi.mock('../../lib/macName', () => ({ macName: () => 'Test Mac' }));
vi.mock('../../lib/gateway', async (orig) => {
  const real = await orig<typeof import('../../lib/gateway')>();
  return { ...real, localGateway: () => ({ state: 'connected', call: async () => null, close() {}, connect() {} }) };
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

import { getState, setState } from '../../lib/store';
import { reopenLastComputer, setCloudClientFactory, useCloudLink } from './cloudClient';
import { useCloud } from './cloudAccount';
import type { GatewayLike } from '../../lib/gateway';

afterEach(() => { setCloudClientFactory(null); });

describe('a launch by someone who works on their cloud computer', () => {
  it('keeps the splash up from the start until the cloud computer is on screen', async () => {
    // before anything is read: the window was on the cloud computer last time, so it waits
    expect(useCloudLink.getState()).toMatchObject({ computer: 'local', placing: true });

    const now = Date.now();
    useCloud.setState({
      supported: true,
      view: {
        signedIn: true, paired: true,
        account: { id: 'acc', email: 'a@b.co', createdAt: 0, signupsOpen: true, subscription: { status: 'active', plan: 'pro', interval: 'monthly', periodStart: now - 86_400_000, periodEnd: now + 29 * 86_400_000, cancelAtPeriodEnd: false } },
        computer: { state: 'running', noticeSeq: 0, computer: { id: 'i1', region: 'us', publicUrl: 'https://x.agent37.app', hostName: 'Cloud', recentWakes: [] } },
      } as never,
    });
    setState({ hydrated: true, conn: 'connected', bots: [{ id: 'mac-bot', name: 'On this Mac' } as never] });
    const client = {
      state: 'idle' as string, snapshot: null as Snapshot | null,
      onAny: () => () => {}, onState: () => () => {},
      connect() { this.state = 'connecting'; }, close() { this.state = 'closed'; }, call: async () => ({}),
    };
    setCloudClientFactory(() => client as unknown as GatewayLike);

    await reopenLastComputer();
    expect(useCloudLink.getState()).toMatchObject({ computer: 'cloud', placing: false });
    // this computer's bots went with it: none of them is in what the window shows now
    expect(getState().bots).toEqual([]);
    expect(storage.get('appubot:launchedOnCloud')).toBe('1');
  });
});
