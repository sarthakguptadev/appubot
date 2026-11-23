import { describe, expect, it } from 'vitest';
import { EntityOverlay, applyRestore, applySettled } from './optimistic';

type T = { id: string; title: string; pinned?: boolean };
const a: T = { id: 'a', title: 'Old', pinned: false };
const b: T = { id: 'b', title: 'Other' };

describe('EntityOverlay', () => {
  it('shows a change at once and keeps it over a stale copy from the computer until it settles', () => {
    const o = new EntityOverlay();
    const seq = o.begin();
    o.patch(seq, 'threads', 'a', { title: 'New' }, a);
    expect(o.lay('threads', [a, b])[0]!.title).toBe('New');
    // an event sent before the computer had the change
    o.noteServer('threads', { ...a, title: 'Old' });
    expect(o.lay('threads', [a, b])[0]!.title).toBe('New');
    // accepted, with the computer's own copy in its answer (noted first): that is what stays
    o.noteServer('threads', { ...a, title: 'New' });
    const { patches } = o.settle(seq, true);
    expect(patches).toEqual([{ coll: 'threads', id: 'a', fields: { title: 'New' } }]);
    expect(o.pending).toBe(false);
  });

  it('keeps the prediction on success when the computer said nothing meanwhile, and goes back on refusal', () => {
    const o = new EntityOverlay();
    const ok = o.begin();
    o.patch(ok, 'bots', 'a', { pinned: true }, a);
    expect(o.settle(ok, true).patches[0]!.fields).toEqual({ pinned: true });
    const no = o.begin();
    o.patch(no, 'bots', 'a', { pinned: true }, a);
    expect(o.settle(no, false).patches[0]!.fields).toEqual({ pinned: false });
  });

  it('lets a later change of the same field supersede an earlier one', () => {
    const o = new EntityOverlay();
    const first = o.begin();
    o.patch(first, 'threads', 'a', { title: 'One' }, a);
    const second = o.begin();
    o.patch(second, 'threads', 'a', { title: 'Two' }, { ...a, title: 'One' });
    // the first settling changes nothing shown
    expect(o.settle(first, false).patches).toEqual([]);
    expect(o.lay('threads', [a])[0]!.title).toBe('Two');
    // the second refused: back to what the computer last said (not the first prediction)
    expect(o.settle(second, false).patches[0]!.fields).toEqual({ title: 'Old' });
  });

  it('hides a removed entity, even when the computer reports it again, and puts it back where it was if refused', () => {
    const o = new EntityOverlay();
    const seq = o.begin();
    o.remove(seq, 'threads', 'a', a, 0);
    expect(o.lay('threads', [a, b]).map((x) => x.id)).toEqual(['b']);
    o.noteServer('threads', { ...a, title: 'Renamed elsewhere' });
    expect(o.lay('threads', [a, b]).map((x) => x.id)).toEqual(['b']);
    const { restores } = o.settle(seq, false);
    expect(applyRestore([b], restores[0]!)).toEqual([{ ...a, title: 'Renamed elsewhere' }, b]);
  });

  it('forgets a change the computer itself removed', () => {
    const o = new EntityOverlay();
    const seq = o.begin();
    o.patch(seq, 'threads', 'a', { title: 'New' }, a);
    o.noteGone('threads', 'a');
    expect(o.pending).toBe(false);
    expect(o.settle(seq, false)).toEqual({ patches: [], restores: [] });
  });

  it('returns the same list when nothing of it is overlaid', () => {
    const o = new EntityOverlay();
    const list = [a, b];
    expect(o.lay('threads', list)).toBe(list);
    expect(applySettled(list, { coll: 'threads', id: 'zz', fields: { title: 'x' } })).toBe(list);
  });
});
