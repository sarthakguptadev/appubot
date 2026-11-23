// The pickers' choices (a chat's model, effort, fast mode, permission mode and agent; Settings' defaults for new bots)
// show the moment they're picked and stay put while the computer catches up (chat-core `ChoiceSync`): each chat's
// requests go one at a time in the order picked, a pick still waiting is replaced by a newer one of the same kind, and
// what the computer reports meanwhile (an older state's event, an agent's late config update) can't flip the picker
// back. Only a refused request puts the picker back, with a small error.
import { useSyncExternalStore } from 'react';
import type { Bot, Settings, Thread } from '@appubot/protocol';
import { ChoiceSync, type ChoiceChange } from '@appubot/chat-core';
import { toastCallError } from './actions';
import { rpc } from './gateway';
import { byId, getState, setState, upsertBy } from './store';

export const choices = new ChoiceSync();

const threadKey = (id: string) => `thread:${id}`;
const botKey = (id: string) => `bot:${id}`;
const SETTINGS = 'settings';

/** Re-render when a pick shows, settles or goes back. */
function useChoicesVersion(): number {
  return useSyncExternalStore(choices.subscribe, choices.getVersion);
}

/** The chat as the pickers show it: what the computer reports, with picks still standing on top. */
export function useThreadChoices(thread: Thread | undefined): Thread | undefined {
  useChoicesVersion();
  return thread ? choices.view(threadKey(thread.id), thread) : thread;
}

/** Send a pick; resolves to the computer's answer, or undefined when it was replaced or refused (refusals toast). */
async function pick<R>(c: ChoiceChange<R>, errorTitle: string): Promise<R | undefined> {
  const out = await choices.change(c);
  if (out.ok) return 'result' in out ? out.result : undefined;
  if (out.latest) toastCallError(out.error, errorTitle);
  return undefined;
}

const threadAnswer = (t: Thread) => ({ [threadKey(t.id)]: t });

export function setThreadModel(thread: Thread, modelId: string): Promise<Thread | undefined> {
  const key = threadKey(thread.id);
  return pick({ lane: key, slot: 'model', show: { [key]: { modelId } }, send: () => rpc('threads.setModel', { id: thread.id, modelId }), answered: threadAnswer }, 'Could not switch model');
}

/** The effort also becomes the bot's own (core's `threads.setEffort` does both). */
export function setThreadEffort(thread: Thread, effortId: string): Promise<Thread | undefined> {
  const key = threadKey(thread.id);
  return pick({
    lane: key, slot: 'effort', show: { [key]: { effortId }, [botKey(thread.botId)]: { effort: effortId } },
    send: () => rpc('threads.setEffort', { id: thread.id, effortId }), answered: threadAnswer,
  }, 'Could not change the reasoning effort');
}

/** Fast mode also becomes the bot's own (core's `threads.setFast`). */
export function setThreadFast(thread: Thread, fast: boolean): Promise<Thread | undefined> {
  const key = threadKey(thread.id);
  return pick({
    lane: key, slot: 'fast', show: { [key]: { fast }, [botKey(thread.botId)]: { fast } },
    send: () => rpc('threads.setFast', { id: thread.id, fast }), answered: threadAnswer,
  }, 'Could not switch fast mode');
}

export function setThreadMode(thread: Thread, modeId: string): Promise<Thread | undefined> {
  const key = threadKey(thread.id);
  return pick({ lane: key, slot: 'mode', show: { [key]: { modeId } }, send: () => rpc('threads.setMode', { id: thread.id, modeId }), answered: threadAnswer }, 'Could not switch mode');
}

/**
 * The bot moves to another agent (its model, when one was picked there) and the chat continues on it (core's
 * `switchProvider`). Until the computer has the new agent's lists the picker reads that agent's own (empty thread lists).
 */
export async function switchThreadAgent(thread: Thread, bot: Bot, providerId: string, modelId: string, agentName: string): Promise<void> {
  const key = threadKey(thread.id);
  const updated = await pick({
    lane: key, slot: 'agent',
    show: {
      [key]: { providerId, modelId, models: [], efforts: [] },
      [botKey(bot.id)]: { providerId, ...(modelId ? { modelId } : {}) },
    },
    send: () => rpc('bots.update', { id: bot.id, patch: { providerId, ...(modelId ? { modelId } : {}) } }),
    answered: (b) => ({ [botKey(b.id)]: b }),
  }, `Could not switch to ${agentName}`);
  if (updated) setState((st) => ({ bots: upsertBy(st.bots, updated, byId) }));
}

/* ---------- settings ---------- */

/**
 * Settings live in the store (every page reads them there), so the picks are laid over the computer's copy as it
 * arrives (`settingsFromServer`: the hello, `settings.updated`, an update's answer) and again whenever a pick shows,
 * settles or goes back: fields that stopped standing get the computer's value back, the rest of the store is left be.
 */
let serverSettings: Settings | null = null;
let shownFields = new Set<string>();

function showSettings(base: Settings | null): void {
  if (!base) return;
  const standing = choices.standing(SETTINGS);
  const back = [...shownFields].filter((f) => !(f in standing));
  shownFields = new Set(Object.keys(standing));
  if (!back.length && !shownFields.size && base === getState().settings) return;
  const server = (serverSettings ?? {}) as Record<string, unknown>;
  setState({ settings: { ...base, ...Object.fromEntries(back.map((f) => [f, server[f]])), ...standing } as Settings });
}

choices.subscribe(() => {
  if (shownFields.size || Object.keys(choices.standing(SETTINGS)).length) showSettings(getState().settings);
});

/** The computer's settings arrived: they become the store's, under any picks still standing. */
export function settingsFromServer(s: Settings): void {
  serverSettings = s;
  showSettings(s);
}

/**
 * Change settings: shown at once, sent in order (a waiting change of the same fields is replaced by a newer one), the
 * picker put back with an error only if the computer refuses. Nested objects (computer, approvals, notifications,
 * gateway) must be sent whole.
 */
export async function updateSettings(patch: Partial<Settings>): Promise<Settings | undefined> {
  const out = await choices.change({
    lane: SETTINGS, slot: Object.keys(patch).sort().join(','), show: { [SETTINGS]: patch as Record<string, unknown> },
    send: () => rpc('settings.update', patch), answered: (s) => ({ [SETTINGS]: s }),
  });
  if (out.ok && 'result' in out) {
    settingsFromServer(out.result);
    return out.result;
  }
  if (out.ok) return getState().settings ?? undefined;
  if (out.latest) toastCallError(out.error, 'Could not save settings');
  return undefined;
}
