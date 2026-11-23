// An agent's models, reasoning efforts and permission modes, for the pickers (ModelPicker, PermissionPicker). Agents
// only list their models in a session: the choices are what that agent's latest chat reported (protocol
// `agentChoices`), else what the Mac reads from a short session of the agent's own (`providers.choices`, asked once
// per agent while the app runs).
import { useEffect, useMemo, useState } from 'react';
import { agentChoices, offeredModels, type MethodResult } from '@appubot/protocol';
import { call } from '../../lib/actions';
import { useStore } from '../../lib/store';

export type Choices = MethodResult<'providers.choices'>;
const asked = new Map<string, Promise<Choices | undefined>>();
/** what `providers.choices` answered, per agent (the favourites name models of agents not on screen) */
export const fetchedChoices = new Map<string, Choices>();

/** Forget the lists read for these agents (their models changed: OpenCode's custom models), so pickers ask again. */
export function forgetChoices(match: (providerId: string) => boolean): void {
  for (const id of [...asked.keys()]) if (match(id)) asked.delete(id);
  for (const id of [...fetchedChoices.keys()]) if (match(id)) fetchedChoices.delete(id);
}

/** Ask the Mac for these agents' lists now (it answers from its saved copy at once), so their tabs open without a wait. */
export function prefetchChoices(ids: readonly string[]): void {
  for (const id of ids) {
    if (!id || asked.has(id)) continue;
    const p = call('providers.choices', { id }, { timeoutMs: 60_000 });
    asked.set(id, p);
    void p.then((v) => { if (v?.models.length) fetchedChoices.set(id, v); else asked.delete(id); });
  }
}

/** `enabled: false` reads only what the chats reported and never asks the Mac (a chat that has its own lists). */
export function useChoices(providerId: string, enabled = true): Choices & { loading: boolean } {
  const threads = useStore((s) => s.threads);
  const local = useMemo(() => agentChoices(threads, providerId), [threads, providerId]);
  const [fetched, setFetched] = useState<{ id: string; v?: Choices } | null>(null);
  const need = enabled && !local.models.length && !!providerId;
  useEffect(() => {
    if (!need) return;
    let live = true;
    let p = asked.get(providerId);
    if (!p) {
      p = call('providers.choices', { id: providerId }, { errorTitle: 'Could not read the agent\'s models', timeoutMs: 60_000 });
      asked.set(providerId, p);
      void p.then((v) => { if (v?.models.length) fetchedChoices.set(providerId, v); else asked.delete(providerId); });
    }
    void p.then((v) => { if (live) setFetched({ id: providerId, v }); });
    return () => { live = false; };
  }, [need, providerId]);
  if (!need) return { ...local, loading: false };
  // a list already read this run shows at once (the fetch above only refreshes it)
  const v = fetched?.id === providerId ? fetched.v : fetchedChoices.get(providerId);
  // AppuBot AI's lists are narrowed to Sonnet and Haiku, also from an older computer or a list kept from before
  if (v?.models.length && fetched?.id !== providerId) return { models: offeredModels(providerId, v.models), efforts: v.efforts.length ? v.efforts : local.efforts, modes: v.modes ?? [], loading: false };
  return { models: offeredModels(providerId, v?.models ?? []), efforts: v?.efforts.length ? v.efforts : local.efforts, modes: v?.modes ?? [], loading: fetched?.id !== providerId };
}
