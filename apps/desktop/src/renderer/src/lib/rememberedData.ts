/**
 * Screens' last answers per computer (pure: lib/remembered.ts wires it to the store and the screens). Each entry is
 * a method's last result as a screen showed it (`at`, `value`), keyed by what was asked (`usage:7d`, `storage`).
 * A computer keeps at most `MAX_KEYS` of them (the oldest answers go first) and `MAX_CHARS` in all.
 */
export interface Remembered { at: number; value: unknown }
export type RememberedMap = Record<string, Remembered>;

export const MAX_KEYS = 40;
export const MAX_CHARS = 1_500_000;
/** this Mac's in localStorage (sizes, model names and counts: never a message or a secret) */
export const MAC_KEY = 'appubot.remembered.mac';

/** The map with one answer added, its oldest beyond the caps dropped. */
export function withAnswer(m: RememberedMap, key: string, value: unknown, now = Date.now()): RememberedMap {
  const next: RememberedMap = { ...m, [key]: { at: now, value } };
  const keys = Object.keys(next).sort((a, b) => next[a]!.at - next[b]!.at);
  while (keys.length > MAX_KEYS) delete next[keys.shift()!];
  let size = JSON.stringify(next).length;
  while (size > MAX_CHARS && keys.length > 1) {
    const k = keys.shift()!;
    size -= JSON.stringify(next[k]).length + k.length + 4;
    delete next[k];
  }
  return next;
}

/** A map read back (a saved copy or localStorage): only well-formed entries. */
export function readRemembered(v: unknown): RememberedMap {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: RememberedMap = {};
  for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
    const r = e as Partial<Remembered> | null;
    if (r && typeof r === 'object' && typeof r.at === 'number' && 'value' in r && r.value !== undefined) out[k] = { at: r.at, value: r.value };
  }
  return out;
}

export function loadMacRemembered(): RememberedMap {
  try { return readRemembered(JSON.parse(localStorage.getItem(MAC_KEY) ?? '{}')); } catch { return {}; }
}
