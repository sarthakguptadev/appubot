import { useEffect } from 'react';
import { create } from 'zustand';
import { providerBase, type ModelEndpoint } from '@appubot/protocol';
import { call } from '../../lib/actions';
import { forgetChoices } from './useChoices';

/** The custom model endpoints (`endpoints.list`), read when Settings › Agents first shows them and after each change. */
const useEndpointStore = create<{ list: ModelEndpoint[]; loaded: boolean }>(() => ({ list: [], loaded: false }));

/** After a change: the list again, and OpenCode's models read afresh (they include the endpoints'). */
export async function reloadEndpoints(): Promise<void> {
  forgetChoices((id) => providerBase(id) === 'opencode');
  const list = await call('endpoints.list', {}, { errorTitle: 'Could not read your custom models' });
  if (list) useEndpointStore.setState({ list, loaded: true });
}

export function useEndpoints(): ModelEndpoint[] {
  const { list, loaded } = useEndpointStore();
  useEffect(() => { if (!loaded) void reloadEndpoints(); }, [loaded]);
  return list;
}
