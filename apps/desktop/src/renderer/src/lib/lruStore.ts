/**
 * A small least-recently-used map kept in localStorage: what the window remembers between launches so things show at
 * once at their size (a page's height, a picture's shape). Only measurements, never content: localStorage isn't
 * sealed, so anything private stays out (the cloud computers' content is in their sealed copies, cloudCacheData.ts).
 *
 * Reads are synchronous (a first frame can use them); writes land in memory at once and reach storage after a short
 * quiet (`SAVE_MS`), so a chat measuring two dozen things writes once.
 */
export interface KeyValueStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

const SAVE_MS = 1000;

export class LruStore<V> {
  private map: Map<string, V> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly key: string,
    private readonly max: number,
    private readonly valid: (v: unknown) => v is V,
    private readonly storage: () => KeyValueStorage | null = () => (typeof localStorage === 'undefined' ? null : localStorage),
  ) {}

  private load(): Map<string, V> {
    if (this.map) return this.map;
    const m = new Map<string, V>();
    try {
      const raw = this.storage()?.getItem(this.key);
      const v: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(v)) for (const e of v) if (Array.isArray(e) && typeof e[0] === 'string' && this.valid(e[1])) m.set(e[0], e[1]);
    } catch { /* unreadable: start afresh */ }
    this.map = m;
    return m;
  }

  /** The value (and it counts as used). */
  get(k: string): V | undefined {
    const m = this.load();
    const v = m.get(k);
    if (v !== undefined) { m.delete(k); m.set(k, v); }
    return v;
  }

  /** Without counting as a use. */
  peek(k: string): V | undefined { return this.load().get(k); }

  set(k: string, v: V): void {
    const m = this.load();
    const same = m.get(k);
    m.delete(k);
    m.set(k, v);
    while (m.size > this.max) m.delete(m.keys().next().value!);
    if (same === undefined || JSON.stringify(same) !== JSON.stringify(v)) this.saveSoon();
  }

  delete(k: string): void {
    if (this.load().delete(k)) this.saveSoon();
  }

  clear(): void {
    this.map = new Map();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.storage()?.removeItem(this.key); } catch { /* fine */ }
  }

  get size(): number { return this.load().size; }

  /** Writes now (tests; and a page going away). */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.storage()?.setItem(this.key, JSON.stringify([...this.load()])); } catch { /* full: kept in memory */ }
  }

  private saveSoon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, SAVE_MS);
  }
}

/** A string's short, stable fingerprint (cyrb53: 53 bits, as base 36) with its length, for cache keys. */
export function contentHash(s: string): string {
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}.${s.length.toString(36)}`;
}

/** A Map that forgets its least recently used entries past `max` (in memory only). */
export class MemoryLru<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  has(k: string): boolean { return this.map.has(k); }
  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  delete(k: string): boolean { return this.map.delete(k); }
  keys(): string[] { return [...this.map.keys()]; }
  clear(): void { this.map.clear(); }
  get size(): number { return this.map.size; }
}
