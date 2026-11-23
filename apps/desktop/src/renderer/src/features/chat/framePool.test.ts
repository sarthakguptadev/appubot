import { describe, expect, it } from 'vitest';
import { FramePool } from './framePool';

function pool(max = 2, opts: { canMove?: boolean; parkThrows?: boolean } = {}) {
  const destroyed: string[] = [];
  const parked: string[] = [];
  const p = new FramePool<string>(max, {
    canMove: () => opts.canMove ?? true,
    park: (f) => { if (opts.parkThrows) throw new Error('no'); parked.push(f); },
    destroy: (f) => { destroyed.push(f); },
  });
  return { p, destroyed, parked };
}

describe('FramePool', () => {
  it('a card coming back takes its warm frame; a miss gets none', () => {
    const { p, parked } = pool();
    expect(p.take('page-a')).toBeUndefined();
    p.release('page-a', 'frame-a');
    expect(parked).toEqual(['frame-a']);
    expect(p.take('page-a')).toBe('frame-a');
    expect(p.take('page-a')).toBeUndefined();
  });

  it('keeps the newest few, destroying the oldest', () => {
    const { p, destroyed } = pool(2);
    p.release('a', 'fa'); p.release('b', 'fb'); p.release('c', 'fc');
    expect(destroyed).toEqual(['fa']);
    expect(p.size).toBe(2);
    expect(p.take('a')).toBeUndefined();
    expect(p.take('c')).toBe('fc');
  });

  it('destroys rather than parks where frames can’t move without reloading', () => {
    const a = pool(2, { canMove: false });
    a.p.release('a', 'fa');
    expect(a.destroyed).toEqual(['fa']);
    expect(a.p.take('a')).toBeUndefined();
    const b = pool(2, { parkThrows: true });
    b.p.release('a', 'fa');
    expect(b.destroyed).toEqual(['fa']);
  });

  it('a second frame of the same page replaces the parked one; clear empties it', () => {
    const { p, destroyed } = pool(3);
    p.release('a', 'fa1');
    p.release('a', 'fa2');
    expect(destroyed).toEqual(['fa1']);
    p.clear();
    expect(destroyed).toEqual(['fa1', 'fa2']);
    expect(p.size).toBe(0);
  });
});
