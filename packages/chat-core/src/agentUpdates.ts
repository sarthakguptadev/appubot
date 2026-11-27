/**
 * Agent updates, told in the app: the computer checks
 * its agents' CLIs at launch and every hour (core `providerUpdates.ts`); the app raises one notice per agent whose newer
 * version AppuBot can install, which then carries the update itself (Update, Updating…, done or Try again).
 *
 * When it shows: on opening the app (the first list it sees), and while it's open, when an agent's offer first appears
 * or moves to a newer version. Not for every agent on the computer: only ones that are on and that a bot (or new bots)
 * uses, so an old CLI nobody here runs never nags. Closing the notice puts that version off for a few days.
 */
import { providerBase, type Bot, type Provider, type Settings } from '@appubot/protocol';

export interface AgentUpdateOffer {
  id: string;
  name: string;
  /** the version on the computer, when known */
  from?: string;
  to: string;
}

/** Closing an offer puts off that version of that agent this long (a newer version is a new offer). */
export const AGENT_UPDATE_SNOOZE_MS = 3 * 24 * 60 * 60_000;
/** How long after the app opens (connected, list read) the first offers show: after the launch's own notices. */
export const AGENT_UPDATE_FIRST_DELAY_MS = 4000;

/** agent id → the version put off and until when */
export type AgentUpdateSnoozes = Record<string, { version: string; until: number }>;

/** Agents a bot runs on (a profile counts for its agent), and the agent new bots get. */
export function agentsInUse(bots: readonly Pick<Bot, 'providerId'>[], settings: Pick<Settings, 'defaultProviderId'> | null | undefined): Set<string> {
  const used = new Set<string>();
  for (const b of bots) if (b.providerId) used.add(providerBase(b.providerId));
  if (settings?.defaultProviderId) used.add(providerBase(settings.defaultProviderId));
  return used;
}

/**
 * The updates worth offering: an installed agent that is on, used here, with a newer version out that AppuBot can
 * install itself (a registry agent, or a CLI whose way of updating it knows), and no update running.
 */
export function agentUpdateOffers(
  providers: readonly Provider[], bots: readonly Pick<Bot, 'providerId'>[], settings: Pick<Settings, 'defaultProviderId'> | null | undefined,
): AgentUpdateOffer[] {
  const used = agentsInUse(bots, settings);
  const out: AgentUpdateOffer[] = [];
  for (const p of providers) {
    if (p.profile || !p.installed || !p.enabled || !p.updateAvailable || !p.latestVersion) continue;
    if (p.update?.running || !used.has(p.id)) continue;
    if (!p.registry && !p.update?.via) continue;
    const from = p.registry?.version ?? p.update?.current;
    out.push({ id: p.id, name: p.name, ...(from ? { from } : {}), to: p.latestVersion });
  }
  return out;
}

/** Whether the user put this version of this agent off and it hasn't run out. */
export function agentUpdateSnoozed(snoozes: AgentUpdateSnoozes, offer: Pick<AgentUpdateOffer, 'id' | 'to'>, now: number): boolean {
  const s = snoozes[offer.id];
  return !!s && s.version === offer.to && s.until > now;
}

/**
 * The offers to raise now. `seen` is what was raised (or deliberately passed over) since the app opened, by agent →
 * version: an offer already there is never raised twice in a run, so a list pushed for anything else (every provider
 * event is the whole list) leaves a closed notice closed; a newer version is a new offer.
 */
export function agentUpdatesToAnnounce(offers: readonly AgentUpdateOffer[], seen: ReadonlyMap<string, string>, snoozes: AgentUpdateSnoozes, now: number): AgentUpdateOffer[] {
  return offers.filter((o) => seen.get(o.id) !== o.to && !agentUpdateSnoozed(snoozes, o, now));
}

/** Snoozes with the ones run out dropped (what gets saved back). */
export function liveSnoozes(snoozes: AgentUpdateSnoozes, now: number): AgentUpdateSnoozes {
  return Object.fromEntries(Object.entries(snoozes).filter(([, s]) => s && typeof s.until === 'number' && s.until > now));
}

const v = (s: string | undefined): string => (!s ? '' : /^v/i.test(s) ? s : `v${s}`);

/** "v2.1.3 → v2.1.5" (or just the new one when the installed version isn't known). */
export function agentUpdateVersions(offer: Pick<AgentUpdateOffer, 'from' | 'to'>): string {
  return offer.from ? `${v(offer.from)} → ${v(offer.to)}` : v(offer.to);
}

export type AgentUpdateStage = 'offer' | 'updating' | 'done' | 'failed';

/** The notice's words for each step of an agent's update. */
export function agentUpdateNotice(offer: AgentUpdateOffer, stage: AgentUpdateStage, detail?: string): { title: string; body: string } {
  switch (stage) {
    case 'offer': return { title: `${offer.name} has an update`, body: agentUpdateVersions(offer) };
    case 'updating': return { title: `Updating ${offer.name}…`, body: `${agentUpdateVersions(offer)}. Your bots keep working.` };
    case 'done': return { title: `${offer.name} is up to date`, body: detail?.trim() || `Now on ${v(offer.to)}. New chats use it.` };
    case 'failed': return { title: `Couldn't update ${offer.name}`, body: detail?.trim() || 'Try again, or update it the way you installed it.' };
  }
}
