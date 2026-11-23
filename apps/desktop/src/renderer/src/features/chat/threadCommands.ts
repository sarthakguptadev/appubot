import type { SlashCommand } from '@appubot/protocol';
import { activeComputer, rpc } from '../../lib/gateway';
import { getState, setState } from '../../lib/store';

/*
 * A cloud thread's slash commands. This Mac is a paired device to its cloud computer, and a computer sends a paired
 * device's threads without their commands (protocol `leanThread`), so the store holds them as none (`fullThread`) and
 * they're asked for (`threads.commands`) when wanted: "/" typed in the composer, the context ring's Compact now.
 * This Mac's own gateway always sends them with the thread, so nothing is asked there.
 */

/** an answer is asked for again after this long (an agent update can change its commands) */
const STALE_MS = 10 * 60_000;
const kept = new Map<string, { commands: SlashCommand[]; at: number }>();
const asking = new Set<string>();

function put(threadId: string, commands: SlashCommand[]): void {
  if (!commands.length) return;
  setState((s) => ({ threads: s.threads.map((t) => (t.id === threadId && !t.commands.length ? { ...t, commands } : t)) }));
}

/** Fills in a cloud thread's commands, when it has none yet. */
export function wantCommands(threadId: string | undefined): void {
  if (!threadId || activeComputer() !== 'cloud') return;
  const thread = getState().threads.find((t) => t.id === threadId);
  if (!thread || thread.commands.length) return;
  const have = kept.get(threadId);
  if (have) put(threadId, have.commands);
  if ((have && Date.now() - have.at < STALE_MS) || asking.has(threadId)) return;
  asking.add(threadId);
  rpc('threads.commands', { id: threadId })
    .then((r) => {
      kept.set(threadId, { commands: r.commands, at: Date.now() });
      // the answer is the cloud's: dropped when the window went back to this Mac meanwhile
      if (activeComputer() === 'cloud') put(threadId, r.commands);
    })
    .catch(() => undefined)
    .finally(() => asking.delete(threadId));
}

/** Forgets every kept answer (signed out of the cloud). */
export function forgetCommands(): void { kept.clear(); }
