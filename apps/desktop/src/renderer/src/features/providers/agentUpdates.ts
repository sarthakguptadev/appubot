/**
 * Agent updates in the app: one notice per agent with a newer version to install (chat-core `agentUpdates.ts` says
 * which and when), and the update itself, shared with Settings › Agents' Update button. The notice stays until acted on
 * or closed and carries the whole update in place: Update → Updating… → up to date (then it goes) or Couldn't update
 * with Try again. Closing it puts that version off for a few days. Only for this Mac: a computer in the cloud keeps its
 * agents current itself, and the notice's Update is the owner's to press there.
 */
import { useEffect } from 'react';
import type { Provider } from '@appubot/protocol';
import {
  AGENT_UPDATE_FIRST_DELAY_MS, AGENT_UPDATE_SNOOZE_MS, agentUpdateNotice, agentUpdateOffers, agentUpdatesToAnnounce, liveSnoozes,
  type AgentUpdateOffer, type AgentUpdateSnoozes,
} from '@appubot/chat-core';
import { activeComputer, errorMessage, onActiveComputer, rpc } from '../../lib/gateway';
import { dismissToast, pushToast, ui, updateToast, useStore } from '../../lib/store';

const SNOOZE_KEY = 'appubot.agentUpdateSnoozed';
const toastId = (agentId: string) => `agent-update:${agentId}`;

function readSnoozes(): AgentUpdateSnoozes {
  try { return liveSnoozes(JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? '{}') as AgentUpdateSnoozes, Date.now()); } catch { return {}; }
}
function snooze(offer: AgentUpdateOffer): void {
  const next = { ...readSnoozes(), [offer.id]: { version: offer.to, until: Date.now() + AGENT_UPDATE_SNOOZE_MS } };
  try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(next)); } catch { /* private mode: it shows again next launch */ }
}

/** The result of `providers.update`, or why it didn't run. */
export type AgentUpdateResult = { ok: boolean; output: string; message?: string };

const running = new Map<string, Promise<AgentUpdateResult>>();

/**
 * Install an agent's newest version (`providers.update` waits for the install, which can take minutes). One run per
 * agent: the notice and Settings pressing Update both get the same one. Throws when the computer refused it.
 */
export function updateAgent(p: Pick<Provider, 'id'>): Promise<AgentUpdateResult> {
  let run = running.get(p.id);
  if (!run) {
    run = rpc('providers.update', { id: p.id }, { timeoutMs: 15 * 60_000 }).finally(() => running.delete(p.id));
    running.set(p.id, run);
  }
  return run;
}

/** What went wrong, in a line or two: the updater's last words, else its message. */
export function updateFailureText(r: AgentUpdateResult): string {
  return (r.message && !r.output ? r.message : r.output.trim().split('\n').slice(-3).join('\n').slice(-240)) || r.message || '';
}

/** Where each agent's notice stands (only the ones raised this run). */
const stage = new Map<string, 'offer' | 'updating' | 'failed'>();
/** agent → the version raised (or passed over) this run: never raised twice */
const seen = new Map<string, string>();

function showOffer(offer: AgentUpdateOffer): void {
  stage.set(offer.id, 'offer');
  seen.set(offer.id, offer.to);
  pushToast({
    id: toastId(offer.id), ...agentUpdateNotice(offer, 'offer'), level: 'info', agentId: offer.id, sticky: true,
    actions: [{ label: 'Update', primary: true, onClick: () => void runFromNotice(offer) }, { label: 'Not now', onClick: () => closeOffer(offer) }],
    onClose: () => closeOffer(offer, false),
  });
}

function closeOffer(offer: AgentUpdateOffer, dismiss = true): void {
  if (stage.get(offer.id) === 'offer') snooze(offer);
  stage.delete(offer.id);
  if (dismiss) dismissToast(toastId(offer.id));
}

async function runFromNotice(offer: AgentUpdateOffer): Promise<void> {
  const id = toastId(offer.id);
  stage.set(offer.id, 'updating');
  // it may have been closed meanwhile: the outcome still shows
  const busy = { ...agentUpdateNotice(offer, 'updating'), level: 'info' as const, agentId: offer.id, sticky: true, busy: true, actions: [], onClose: undefined };
  if (!updateToast(id, busy)) pushToast({ id, ...busy });
  let r: AgentUpdateResult;
  try {
    r = await updateAgent(offer);
  } catch (e) {
    r = { ok: false, output: '', message: errorMessage(e) };
  }
  const outcome = r.ok
    ? { ...agentUpdateNotice(offer, 'done', r.message), level: 'success' as const, sticky: false, busy: false, actions: [] }
    : {
        ...agentUpdateNotice(offer, 'failed', updateFailureText(r)), level: 'warning' as const, sticky: true, busy: false,
        actions: [{ label: 'Try again', primary: true, onClick: () => void runFromNotice(offer) }, { label: 'Agents settings', onClick: () => { dismissToast(id); stage.delete(offer.id); ui.openSettings('providers'); } }],
        onClose: () => { stage.delete(offer.id); },
      };
  if (r.ok) stage.delete(offer.id);
  else stage.set(offer.id, 'failed');
  if (!updateToast(id, outcome)) pushToast({ id, agentId: offer.id, ...outcome });
}

/** Take down offers that no longer stand (installed elsewhere, the agent turned off, another computer on screen). */
function withdraw(keep: ReadonlySet<string>): void {
  for (const [agentId, st] of stage) {
    if (st !== 'offer' || keep.has(agentId)) continue;
    stage.delete(agentId);
    dismissToast(toastId(agentId));
  }
}

/**
 * Raise agent update notices: the first look a few seconds after the app has the computer's lists, then whenever an
 * offer appears or moves on while it runs. Mounted once (MainLayout, after onboarding).
 */
export function useAgentUpdateNotices(): void {
  const providers = useStore((s) => s.providers);
  const bots = useStore((s) => s.bots);
  const settings = useStore((s) => s.settings);
  const ready = !!settings && providers.length > 0;

  useEffect(() => onActiveComputer(() => withdraw(new Set())), []);

  useEffect(() => {
    if (!ready || activeComputer() !== 'local') return;
    const offers = agentUpdateOffers(providers, bots, settings);
    withdraw(new Set(offers.map((o) => o.id)));
    // Settings' Update (or the bridge) started one: the notice follows it
    for (const p of providers) {
      if (stage.get(p.id) === 'offer' && p.update?.running) updateToast(toastId(p.id), { title: `Updating ${p.name}…`, busy: true, actions: [] });
    }
    const raise = () => {
      if (activeComputer() !== 'local') return;
      const fresh = agentUpdateOffers(useStore.getState().providers, useStore.getState().bots, useStore.getState().settings);
      for (const o of agentUpdatesToAnnounce(fresh, seen, readSnoozes(), Date.now())) showOffer(o);
    };
    // the first look waits a moment, so the launch's own notices and the window settle first
    if (!firstLookDone) {
      const t = setTimeout(() => { firstLookDone = true; raise(); }, AGENT_UPDATE_FIRST_DELAY_MS);
      return () => clearTimeout(t);
    }
    raise();
    return undefined;
  }, [ready, providers, bots, settings]);
}
let firstLookDone = false;
