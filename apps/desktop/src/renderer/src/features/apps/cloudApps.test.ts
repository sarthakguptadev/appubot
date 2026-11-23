import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppsStatus } from '@appubot/protocol';

/* The window's two gateways as cloudApps sees them: `rpc` goes to the computer on screen, the cloud's client is its own. */
const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { create } = require('zustand') as typeof import('zustand');
  const store = create<{ apps: AppsStatus | null }>()(() => ({ apps: null }));
  const stateFns = new Set<(s: string, err?: string) => void>();
  const cloud = {
    state: 'closed' as string,
    calls: [] as { method: string; params: unknown }[],
    connect: vi.fn(() => { cloud.state = 'connected'; for (const f of [...stateFns]) f('connected'); }),
    close: vi.fn(() => { cloud.state = 'closed'; }),
    onState: (f: (s: string, err?: string) => void) => { stateFns.add(f); return () => stateFns.delete(f); },
    call: vi.fn(async (method: string, params: unknown) => {
      cloud.calls.push({ method, params });
      return { ok: true, status: { configured: true, signingIn: false, pending: [] } };
    }),
  };
  return {
    store, cloud,
    active: 'cloud' as 'cloud' | 'local',
    rpc: vi.fn(),
    opened: [] as string[],
    shown: 0,
    signedIn: null as ((back: { code?: string; state?: string; error?: string }) => void) | null,
    toasts: [] as { title: string; level: string }[],
  };
});

vi.mock('../../lib/gateway', () => ({
  activeComputer: () => h.active,
  cloudGateway: () => h.cloud,
  rpc: (...a: unknown[]) => h.rpc(...a),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock('../../lib/native', () => ({
  native: () => ({
    openExternal: async (url: string) => { h.opened.push(url); },
    showApp: () => { h.shown++; },
    onAppsSignedIn: (cb: typeof h.signedIn) => { h.signedIn = cb; return () => undefined; },
  }),
}));
vi.mock('../../lib/store', () => ({
  useStore: h.store,
  setState: (p: Partial<{ apps: AppsStatus | null }>) => h.store.setState(p),
  pushToast: (t: { title: string; level: string }) => { h.toasts.push(t); return 't'; },
}));

const { finishCloudSignIn, listenForAppsSignIn, signInEnded, startCloudConnect, startCloudSignIn } = await import('./cloudApps');
const status = (over: Partial<AppsStatus> = {}): AppsStatus => ({ configured: false, signingIn: false, pending: [], ...over });

beforeEach(() => {
  h.active = 'cloud';
  h.rpc.mockReset();
  h.opened.length = 0;
  h.shown = 0;
  h.toasts.length = 0;
  h.cloud.calls.length = 0;
  h.cloud.state = 'connected';
  h.cloud.connect.mockClear();
  h.cloud.close.mockClear();
  h.store.setState({ apps: null });
});

describe('Apps on the cloud computer, from this window', () => {
  it('signs in with this app’s own link and opens the page in this computer’s browser', async () => {
    h.rpc.mockResolvedValueOnce({ ...status({ signingIn: true }), url: 'https://connect.composio.dev/oauth/authorize?state=s1' });
    await startCloudSignIn();
    expect(h.rpc).toHaveBeenCalledWith('apps.signIn', { redirectUri: 'appubot://apps/signed-in' });
    expect(h.opened).toEqual(['https://connect.composio.dev/oauth/authorize?state=s1']);
    expect(h.store.getState().apps).toEqual(status({ signingIn: true }));
    // the way back is listened for
    expect(h.signedIn).toBeTypeOf('function');
  });

  it('hands what came back to the cloud’s client, never this Mac’s', async () => {
    listenForAppsSignIn();
    h.signedIn!({ code: 'c0de', state: 's1' });
    await vi.waitFor(() => expect(h.cloud.calls).toEqual([{ method: 'apps.finishSignIn', params: { code: 'c0de', state: 's1' } }]));
    expect(h.rpc).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.store.getState().apps?.configured).toBe(true));
    expect(h.toasts.at(-1)).toMatchObject({ level: 'success' });
  });

  it('opens a closed cloud client to finish, and closes it again when this Mac is on screen', async () => {
    h.active = 'local';
    h.cloud.state = 'closed';
    await finishCloudSignIn({ code: 'c0de', state: 's1' });
    expect(h.cloud.connect).toHaveBeenCalledOnce();
    expect(h.cloud.calls.map((c) => c.method)).toEqual(['apps.finishSignIn']);
    expect(h.cloud.close).toHaveBeenCalledOnce();
    // this Mac's Apps aren't the cloud's
    expect(h.store.getState().apps).toBeNull();
  });

  it('connects an app with its link page here, and comes back once the cloud says it ended', async () => {
    h.rpc.mockResolvedValueOnce({ redirectUrl: 'https://connect.composio.dev/link/lk_1' });
    expect(await startCloudConnect({ slug: 'gmail', name: 'Gmail' })).toBe(true);
    expect(h.rpc).toHaveBeenCalledWith('apps.connect', { slug: 'gmail', open: 'caller' });
    expect(h.opened).toEqual(['https://connect.composio.dev/link/lk_1']);
    h.store.setState({ apps: status({ configured: true, pending: ['gmail'] }) });
    expect(h.shown).toBe(0);
    h.store.setState({ apps: status({ configured: true, pending: [] }) });
    expect(h.shown).toBe(1);
    // once only
    h.store.setState({ apps: status({ configured: true, pending: ['gmail'] }) });
    h.store.setState({ apps: status({ configured: true, pending: [] }) });
    expect(h.shown).toBe(1);
  });

  it('says why an app didn’t start connecting', async () => {
    h.rpc.mockRejectedValueOnce(new Error('Couldn’t reach Composio'));
    expect(await startCloudConnect({ slug: 'gmail', name: 'Gmail' })).toBe(false);
    expect(h.opened).toEqual([]);
    expect(h.toasts.at(-1)).toMatchObject({ title: "Couldn't connect Gmail", level: 'error' });
  });

  it('tells when an app’s sign-in has ended', () => {
    expect(signInEnded(['gmail'], [], 'gmail')).toBe(true);
    expect(signInEnded(['gmail'], ['gmail'], 'gmail')).toBe(false);
    expect(signInEnded(undefined, [], 'gmail')).toBe(false);
  });
});
