import { describe, expect, it, vi } from 'vitest';
import { LruStore, MemoryLru, contentHash, type KeyValueStorage } from './lruStore';

function memStorage(): KeyValueStorage & { data: Map<string, string>; writes: number } {
  const data = new Map<string, string>();
  const s = { data, writes: 0, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { s.writes++; data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
  return s;
}
const isNum = (v: unknown): v is number => typeof v === 'number';

describe('LruStore', () => {
  it('misses, then hits synchronously, and survives a new window (reload)', () => {
    const st = memStorage();
    const a = new LruStore('k', 3, isNum, () => st);
    expect(a.get('x')).toBeUndefined();
    a.set('x', 420);
    expect(a.get('x')).toBe(420);
    a.flush();
    const b = new LruStore('k', 3, isNum, () => st);
    expect(b.get('x')).toBe(420);
  });

  it('forgets the least recently used past its size', () => {
    const st = memStorage();
    const a = new LruStore('k', 2, isNum, () => st);
    a.set('a', 1); a.set('b', 2);
    a.get('a');
    a.set('c', 3);
    expect(a.peek('b')).toBeUndefined();
    expect(a.peek('a')).toBe(1);
    expect(a.peek('c')).toBe(3);
  });

  it('writes once after a burst, never for an unchanged value, and drops what isn’t valid', () => {
    vi.useFakeTimers();
    const st = memStorage();
    const a = new LruStore('k', 10, isNum, () => st);
    for (let i = 0; i < 20; i++) a.set(`p${i % 5}`, i);
    expect(st.writes).toBe(0);
    vi.advanceTimersByTime(1500);
    expect(st.writes).toBe(1);
    a.set('p4', 19);
    vi.advanceTimersByTime(1500);
    expect(st.writes).toBe(1);
    vi.useRealTimers();
    st.data.set('bad', JSON.stringify([['a', 'not a number'], ['b', 2], 'junk']));
    const b = new LruStore('bad', 10, isNum, () => st);
    expect(b.peek('a')).toBeUndefined();
    expect(b.peek('b')).toBe(2);
  });
});

describe('MemoryLru and contentHash', () => {
  it('evicts the oldest use', () => {
    const m = new MemoryLru<string>(2);
    m.set('a', 'A'); m.set('b', 'B'); m.get('a'); m.set('c', 'C');
    expect(m.has('b')).toBe(false);
    expect(m.get('a')).toBe('A');
  });
  it('tells contents apart and is stable', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
    expect(contentHash('hello')).not.toBe(contentHash('hellp'));
    expect(contentHash('')).not.toBe(contentHash(' '));
  });
});
