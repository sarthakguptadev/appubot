/**
 * Which saved copies of a cloud computer's chats an app may keep (the desktop's `<dataDir>/cloud-cache/`, the phone's
 * per-computer cache): a copy shows the computer's bots and chats at once while it wakes, so it is dropped as soon as
 * the computer stops being the person's: signed out, off the team (or the team gone), the plan ended (export only,
 * deleted, failed, nothing set up). Only what a successful account read says counts: a failed read, or none yet, drops
 * nothing (a network blip must not wipe the copies). Pure: the same rule on the Mac's core, its window and the phone.
 */
import type { CloudComputerState } from '@appubot/protocol';

/** the person's own AppuBot computer */
export const CLOUD_CACHE_OWN = 'own';

/** A saved copy's key: `own`, or `team:<id>` for a team's computer. */
export const cloudCacheKey = (team?: string | null): string => (team ? `team:${team}` : CLOUD_CACHE_OWN);

/** The team a key is for (null: the person's own). */
export const teamOfCacheKey = (key: string): string | null => (key.startsWith('team:') ? key.slice(5) : null);

/**
 * A computer's folder for what the desktop keeps of its files and pages (`<dataDir>/cloud-files/<own|team-<id>>`):
 * `own`, or `team-<id>` with anything but letters, digits, `_` and `-` made `_`.
 */
export const cloudFilesDir = (team?: string | null): string => (team ? `team-${team.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}` : CLOUD_CACHE_OWN);

/** The copy key a `cloudFilesDir` folder belongs to (null: not one of ours). */
export const cacheKeyOfFilesDir = (dir: string): string | null => (dir === CLOUD_CACHE_OWN ? CLOUD_CACHE_OWN : /^team-[A-Za-z0-9_-]{1,80}$/.test(dir) ? `team:${dir.slice(5)}` : null);

/** computer states that mean its chats can't be reached any more (on hold or suspended still are the person's) */
const GONE: ReadonlySet<CloudComputerState> = new Set(['none', 'deleted', 'failed', 'export-only']);

/** What the account says, in the shape both apps can give. */
export interface CloudAccessFacts {
  signedIn: boolean;
  /** the last account read answered (false: failed, or none yet; nothing is dropped then, except on sign-out) */
  read: boolean;
  /** the account's status (`ended`/`deleted` = the plan is over) */
  accountStatus?: string | null;
  /** the person's own computer's state (absent: no computer) */
  ownState?: CloudComputerState | null;
  /**
   * The teams the person is on now and each one's computer state (null: that team's computer wasn't read this time);
   * absent: the teams weren't read (an older backend), so no team copy is dropped.
   */
  teams?: { id: string; state: CloudComputerState | null }[] | null;
}

/** Of the copies kept (`keys`), the ones to drop now. */
export function lostCloudCaches(facts: CloudAccessFacts, keys: readonly string[]): string[] {
  if (!facts.signedIn) return [...keys];
  if (!facts.read) return [];
  const teams = facts.teams ? new Map(facts.teams.map((t) => [t.id, t.state])) : null;
  const ended = facts.accountStatus === 'ended' || facts.accountStatus === 'deleted';
  return keys.filter((key) => {
    const team = teamOfCacheKey(key);
    if (team === null) return ended || !facts.ownState || GONE.has(facts.ownState);
    if (!teams) return false;
    if (!teams.has(team)) return true;
    const state = teams.get(team);
    return state != null && GONE.has(state);
  });
}
