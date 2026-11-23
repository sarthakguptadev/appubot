/**
 * The reasoning efforts a chat's model offers, for the pickers. A chat's own list can be empty for a moment while its
 * model does offer them: right after a model switch (the agent sends the new model's levels in a config update a
 * moment after answering the switch) or before its agent has reported them. Then the levels any other chat (or this
 * one, earlier) last reported for the same agent and model stand in, so the picker keeps its slider instead of
 * "Set by the model". A model that has never reported any (Haiku has none) still shows none.
 */
import type { Thread } from '@appubot/protocol';

type EffortList = Thread['efforts'];
type Known = Pick<Thread, 'providerId' | 'modelId' | 'efforts' | 'updatedAt'>;

const keyOf = (providerId: string, modelId: string | undefined) => `${providerId}::${modelId ?? ''}`;

/** what each agent's model last reported, this run (a thread's list emptying for a moment doesn't forget it) */
const seen = new Map<string, EffortList>();

/** Note what these chats report now (call with every list of threads the app gets). */
export function noteEfforts(threads: readonly Known[]): void {
  const newest = new Map<string, Known>();
  for (const t of threads) {
    if (t.efforts.length < 2) continue;
    const k = keyOf(t.providerId, t.modelId);
    const cur = newest.get(k);
    if (!cur || t.updatedAt > cur.updatedAt) newest.set(k, t);
  }
  for (const [k, t] of newest) seen.set(k, t.efforts);
}

/** The chat's efforts: its own when it has a choice, else what its agent's model reported elsewhere, else its own. */
export function effortsFor(thread: Known, threads: readonly Known[]): EffortList {
  noteEfforts(threads);
  if (thread.efforts.length >= 2) return thread.efforts;
  return seen.get(keyOf(thread.providerId, thread.modelId)) ?? thread.efforts;
}

/** For tests. */
export function forgetEfforts(): void {
  seen.clear();
}
