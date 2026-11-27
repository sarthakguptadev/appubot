import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Settings › Apps reads the custom connectors of the computer on screen: one whose AppuBot predates them must say so,
   not raise an error and stay on Loading. */
const h = vi.hoisted(() => {
  class GatewayError extends Error {
    constructor(public code: string, message: string) { super(message); }
  }
  return {
    GatewayError,
    active: 'local' as 'local' | 'cloud',
    rpc: vi.fn(),
    toasts: [] as { title: string; body?: string }[],
  };
});

vi.mock('../../lib/gateway', () => ({
  GatewayError: h.GatewayError,
  activeComputer: () => h.active,
  gateway: () => { throw new Error('unused'); },
  onActiveComputer: () => () => undefined,
  rpc: (...a: unknown[]) => h.rpc(...a),
}));
vi.mock('../../lib/actions', () => ({
  call: vi.fn(),
  toastCallError: (e: unknown, title?: string) => { h.toasts.push({ title: title ?? '', body: e instanceof Error ? e.message : String(e) }); },
}));

const { reloadConnectors, useConnectorStore } = await import('./connectorsData');
const useConnectorsState = () => useConnectorStore.getState();

const connector = { id: 'c', name: 'X', transport: 'http', args: [], headers: [], env: [], bots: 'all', status: 'connected', tools: [], createdAt: 1 };

beforeEach(() => {
  h.active = 'local';
  h.rpc.mockReset();
  h.toasts.length = 0;
});

describe('custom connectors on the computer on screen', () => {
  it('a computer whose AppuBot predates them says so, with no error toast', async () => {
    h.active = 'cloud';
    h.rpc.mockRejectedValue(new h.GatewayError('unknown_method', 'Unknown method connectors.list'));
    await reloadConnectors();
    expect(h.toasts).toEqual([]);
    expect(useConnectorsState()).toMatchObject({ loaded: true, unavailable: 'older', on: 'cloud', list: [] });
  });

  it('a computer that keeps them from this window (a team member’s) says so too', async () => {
    h.active = 'cloud';
    h.rpc.mockRejectedValue(new h.GatewayError('forbidden', 'Your device is not allowed to call connectors.list'));
    await reloadConnectors();
    expect(h.toasts).toEqual([]);
    expect(useConnectorsState()).toMatchObject({ loaded: true, unavailable: 'notAllowed' });
  });

  it('switching computers drops the other one’s list', async () => {
    h.rpc.mockResolvedValue({ connectors: [connector], encrypted: true });
    await reloadConnectors();
    expect(useConnectorsState()).toMatchObject({ loaded: true, unavailable: null, on: 'local', list: [connector] });
    h.active = 'cloud';
    h.rpc.mockRejectedValue(new h.GatewayError('unknown_method', 'Unknown method connectors.list'));
    await reloadConnectors();
    expect(useConnectorsState()).toMatchObject({ unavailable: 'older', on: 'cloud', list: [] });
  });

  it('any other failure still shows the error', async () => {
    h.rpc.mockRejectedValue(new h.GatewayError('internal', 'disk full'));
    await reloadConnectors();
    expect(h.toasts).toEqual([{ title: 'Could not read your connectors', body: 'disk full' }]);
  });
});
