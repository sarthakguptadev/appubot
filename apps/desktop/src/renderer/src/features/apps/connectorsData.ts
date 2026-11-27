import { useEffect } from 'react';
import { create } from 'zustand';
import type { Connector, ConnectorBots, ConnectorSave } from '@appubot/protocol';
import { call } from '../../lib/actions';
import { gateway } from '../../lib/gateway';

/*
 * Custom connectors (Settings › Apps): read when the page first shows them, kept current by `connectors.updated` while
 * it is open, and changed through `connectors.*`, which the computer's own window alone may call.
 */

interface ConnectorsState { list: Connector[]; encrypted: boolean; loaded: boolean }

const useConnectorStore = create<ConnectorsState>(() => ({ list: [], encrypted: true, loaded: false }));

export async function reloadConnectors(): Promise<void> {
  const r = await call('connectors.list', {}, { errorTitle: 'Could not read your connectors' });
  if (r) useConnectorStore.setState({ list: r.connectors, encrypted: r.encrypted, loaded: true });
}

const put = (c: Connector | undefined): Connector | undefined => {
  if (c) useConnectorStore.setState((s) => ({ list: s.list.some((x) => x.id === c.id) ? s.list.map((x) => (x.id === c.id ? c : x)) : [...s.list, c] }));
  return c;
};

/** The connectors, read once and kept current while a screen shows them. */
export function useConnectors(): ConnectorsState {
  const state = useConnectorStore();
  useEffect(() => {
    let g: ReturnType<typeof gateway>;
    try { g = gateway(); } catch { return undefined; }
    // read now, or once the computer answers (Settings may open before it does)
    if (g.state === 'connected') void reloadConnectors();
    const offState = g.onState((s) => { if (s === 'connected') void reloadConnectors(); });
    const offAny = g.onAny((event, payload) => {
      if (event === 'connectors.updated') useConnectorStore.setState({ list: (payload as { connectors: Connector[] }).connectors, loaded: true });
    });
    return () => { offState(); offAny(); };
  }, []);
  return state;
}

export function useConnector(id: string | undefined): Connector | undefined {
  return useConnectorStore((s) => s.list.find((c) => c.id === id));
}

export const saveConnector = async (p: ConnectorSave, name = p.name): Promise<Connector | undefined> =>
  put(await call('connectors.save', p, { errorTitle: `Could not save ${name}`, timeoutMs: 90_000 }));
export const checkConnector = async (id: string): Promise<Connector | undefined> =>
  put(await call('connectors.check', { id }, { errorTitle: 'Could not reach it', timeoutMs: 90_000 }));
export const setConnectorTool = async (id: string, tool: string, on: boolean): Promise<Connector | undefined> =>
  put(await call('connectors.setTool', { id, tool, on }, { errorTitle: 'Could not change the tool' }));
export const setConnectorBots = async (id: string, bots: ConnectorBots): Promise<Connector | undefined> =>
  put(await call('connectors.setBots', { id, bots }, { errorTitle: 'Could not change which bots use it' }));
export const signInConnector = (id: string) => call('connectors.signIn', { id }, { errorTitle: 'Could not start the sign-in', timeoutMs: 30_000 });
export const signOutConnector = async (id: string): Promise<Connector | undefined> => put(await call('connectors.signOut', { id }, { errorTitle: 'Could not sign out' }));
export async function removeConnector(id: string, name: string): Promise<boolean> {
  const r = await call('connectors.remove', { id }, { errorTitle: `Could not remove ${name}` });
  if (r) useConnectorStore.setState((s) => ({ list: s.list.filter((c) => c.id !== id) }));
  return !!r;
}
