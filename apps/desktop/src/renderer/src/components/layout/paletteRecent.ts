/*
 * What the ⌘K palette remembers you picked (T3 Code's palette keeps the same: its recent threads, and which thread you
 * picked for which query): the rows themselves, newest first, for its Recent section, and the query each was picked
 * with, so typing that query again puts the same row first (paletteSearch.ts `pickedFor`). Kept on this device per
 * computer (a bot's or a chat's id means nothing on another), a few dozen at most, picks older than three weeks
 * forgotten as T3's are.
 */
import { activeComputer } from '../../lib/gateway';
import type { PalettePick } from './paletteSearch';

const KEY = 'appubot:palette:picks:v1';
/** picks kept per computer */
export const PICKS_KEPT = 40;
/** a pick counts this long */
export const PICK_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;

/** The picks after picking `key` with `query` at `at`: it leads, its older pick for the same query goes. */
export function addPick(picks: readonly PalettePick[], key: string, query: string, at: number): PalettePick[] {
  return [{ key, query, at }, ...picks.filter((p) => !(p.key === key && p.query === query) && at - p.at <= PICK_WINDOW_MS)].slice(0, PICKS_KEPT);
}

/** The rows picked lately, newest first, each once. */
export function recentKeys(picks: readonly PalettePick[], now: number): string[] {
  const out: string[] = [];
  for (const p of picks) if (now - p.at <= PICK_WINDOW_MS && !out.includes(p.key)) out.push(p.key);
  return out;
}

const storageKey = () => `${KEY}:${activeComputer()}`;

export function loadPicks(): PalettePick[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey()) ?? '[]');
    return Array.isArray(raw) ? raw.filter((p): p is PalettePick => typeof p?.key === 'string' && typeof p.at === 'number' && typeof p.query === 'string') : [];
  } catch { return []; }
}

export function savePick(key: string, query: string): void {
  try { localStorage.setItem(storageKey(), JSON.stringify(addPick(loadPicks(), key, query, Date.now()))); } catch { /* storage unavailable */ }
}
