/**
 * Optimistic changes with rollback (after the phone app's `Overlays`, made independent of
 * any one store's shape): what you change shows at once, before the computer answers, and stays put over whatever the
 * computer reports while the request is in flight (an event sent before it got the change can't flip the screen back).
 *
 * Entities live in collections (`threads`, `bots`, …; any name) by id. A change is fields patched on one, or one taken
 * out. When its request settles:
 *  - success: each field keeps the computer's value if it reported one after the change (an event, or the answer
 *    noted with `noteServer`: it may have adjusted what you asked for), else the predicted one, which it accepted;
 *  - failure: back to what the computer last said; a removed entity comes back where it was.
 * A later change to the same field supersedes an earlier one; the earlier one settling then changes nothing.
 *
 * Pure: the app lays the overlay over its own lists (`lay`) whenever the computer's word lands in them, and applies
 * what `settle` returns.
 */

type Entity = { id: string };

interface FieldOverlay {
  value: unknown;
  seq: number;
  /** what the computer last said for this field */
  base: unknown;
  /** the computer reported this field after the change was made (so its word wins when the change settles) */
  fresh: boolean;
}
interface RemoveOverlay { seq: number; entity: Entity; index: number }

export interface SettledPatch { coll: string; id: string; fields: Record<string, unknown> }
export interface SettledRestore { coll: string; entity: Entity; index: number }

const keyOf = (coll: string, id: string) => `${coll}\u0000${id}`;
const split = (k: string): [string, string] => {
  const i = k.indexOf('\u0000');
  return [k.slice(0, i), k.slice(i + 1)];
};

export class EntityOverlay {
  private seqNo = 0;
  private fields = new Map<string, Map<string, FieldOverlay>>();
  private removed = new Map<string, RemoveOverlay>();

  /** Anything still overlaid. */
  get pending(): boolean {
    return this.fields.size > 0 || this.removed.size > 0;
  }

  /** Whether a collection has anything overlaid (to skip work on the computer's every update). */
  touches(coll: string): boolean {
    const p = `${coll}\u0000`;
    for (const k of this.fields.keys()) if (k.startsWith(p)) return true;
    for (const k of this.removed.keys()) if (k.startsWith(p)) return true;
    return false;
  }

  /** A new change's number (one per user action; its patches and removals share it). */
  begin(): number {
    return ++this.seqNo;
  }

  /** Overlay `values` on entity `id` (its current copy gives the computer's word to fall back to). */
  patch(seq: number, coll: string, id: string, values: Record<string, unknown>, current?: object): void {
    const k = keyOf(coll, id);
    let m = this.fields.get(k);
    if (!m) this.fields.set(k, (m = new Map()));
    const cur = current as Record<string, unknown> | undefined;
    for (const [f, value] of Object.entries(values)) {
      const prev = m.get(f);
      // a second change before the first settled keeps the computer's value as the base, not the first prediction
      m.set(f, { value, seq, base: prev ? prev.base : cur?.[f], fresh: prev ? prev.fresh : false });
    }
  }

  /** Take entity `id` out of view until its change settles (put back where it was on failure). */
  remove<E extends Entity>(seq: number, coll: string, id: string, entity: E, index: number): void {
    const k = keyOf(coll, id);
    const prev = this.removed.get(k);
    this.removed.set(k, prev ? { ...prev, seq } : { seq, entity, index });
  }

  /** Whether entity `id` has anything overlaid (a field or its removal). */
  has(coll: string, id: string): boolean {
    const k = keyOf(coll, id);
    return this.fields.has(k) || this.removed.has(k);
  }

  isRemoved(coll: string, id: string): boolean {
    return this.removed.has(keyOf(coll, id));
  }

  /** The value a field shows (overlaid, else `server`). */
  value<V>(coll: string, id: string, field: string, server: V): V {
    const o = this.fields.get(keyOf(coll, id))?.get(field);
    return o ? (o.value as V) : server;
  }

  /**
   * The computer reported an entity (an event, a snapshot, a method's answer): its fields become the truth under any
   * overlaid ones. A removed entity it still reports keeps its latest copy for a rollback.
   */
  noteServer<E extends Entity>(coll: string, entity: E): void {
    const k = keyOf(coll, entity.id);
    const m = this.fields.get(k);
    if (m) {
      const server = entity as unknown as Record<string, unknown>;
      for (const [f, o] of m) {
        if (f in server) { o.base = server[f]; o.fresh = true; }
      }
    }
    const r = this.removed.get(k);
    if (r) r.entity = entity;
  }

  /** The computer removed it: nothing left to overlay or put back. */
  noteGone(coll: string, id: string): void {
    const k = keyOf(coll, id);
    this.fields.delete(k);
    this.removed.delete(k);
  }

  /** One entity as it shows: overlaid fields on top; null while it is taken out. */
  layOne<T extends Entity>(coll: string, e: T): T | null {
    const k = keyOf(coll, e.id);
    if (this.removed.has(k)) return null;
    const m = this.fields.get(k);
    if (!m?.size) return e;
    let changed = false;
    const out: Record<string, unknown> = { ...e };
    for (const [f, o] of m) {
      if (!Object.is(out[f], o.value)) { out[f] = o.value; changed = true; }
    }
    return changed ? (out as T) : e;
  }

  /** A list as it shows (the same array when nothing changes). */
  lay<T extends Entity>(coll: string, list: T[]): T[] {
    if (!this.touches(coll)) return list;
    let changed = false;
    const out: T[] = [];
    for (const e of list) {
      const shown = this.layOne(coll, e);
      if (shown !== e) changed = true;
      if (shown) out.push(shown);
    }
    return changed ? out : list;
  }

  /**
   * The request behind change `seq` finished (`ok`: accepted). Returns the fields to set (the settled value per
   * field) and the entities to put back (refused removals); everything else of that change stops being overlaid.
   */
  settle(seq: number, ok: boolean): { patches: SettledPatch[]; restores: SettledRestore[] } {
    const patches: SettledPatch[] = [];
    const restores: SettledRestore[] = [];
    for (const [k, m] of [...this.fields]) {
      const done: [string, unknown][] = [];
      for (const [f, o] of m) {
        if (o.seq !== seq) continue;
        done.push([f, ok && !o.fresh ? o.value : o.base]);
        m.delete(f);
      }
      if (!m.size) this.fields.delete(k);
      if (!done.length) continue;
      const [coll, id] = split(k);
      patches.push({ coll, id, fields: Object.fromEntries(done) });
    }
    for (const [k, r] of [...this.removed]) {
      if (r.seq !== seq) continue;
      this.removed.delete(k);
      if (ok) continue;
      restores.push({ coll: split(k)[0], entity: r.entity, index: r.index });
    }
    return { patches, restores };
  }

  /** Forget everything (another computer, or signed out): nothing pending applies there. */
  clear(): void {
    this.fields.clear();
    this.removed.clear();
  }
}

/** Put a settled field patch onto a list (the entity's other fields as they are). */
export function applySettled<T extends Entity>(list: T[], p: SettledPatch): T[] {
  let changed = false;
  const out = list.map((e) => {
    if (e.id !== p.id) return e;
    changed = true;
    return { ...e, ...p.fields } as T;
  });
  return changed ? out : list;
}

/** Put a refused removal back where it was (unless the list has it again). */
export function applyRestore<T extends Entity>(list: T[], r: SettledRestore): T[] {
  if (list.some((e) => e.id === r.entity.id)) return list;
  const at = Math.min(r.index, list.length);
  return [...list.slice(0, at), r.entity as T, ...list.slice(at)];
}
