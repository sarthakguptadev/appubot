import { describe, expect, it } from 'vitest';
import { Globe02Icon, InternetIcon, Search01Icon, Copy01Icon } from '@hugeicons/core-free-icons';
import { mergeIconParts, type IconPart } from './iconParts';

const parts = (icon: unknown) => mergeIconParts(icon as readonly IconPart[]);

describe('an icon’s strokes as one path', () => {
  it('joins a globe’s circle, meridian and equator, so a see-through colour lands once where they cross', () => {
    const simple = parts(InternetIcon);
    expect(simple).toHaveLength(1);
    // the circle and the ellipse are there as arcs, the equator as it was, with the equator's round ends
    expect(simple[0]!.d).toContain('a10 10 0 1 0 20 0');
    expect(simple[0]!.d).toContain('a4 10 0 1 0 8 0');
    expect(simple[0]!.d).toContain('M2 12H22');
    // nothing in it has a corner, so no join is named
    expect(simple[0]!.attrs).toMatchObject({ strokeLinecap: 'round' });
    expect(simple[0]!.attrs.strokeLinejoin).toBeUndefined();

    // the detailed globe too: its circle names no style, its lens only a join, its parallels both
    const detailed = parts(Globe02Icon);
    expect(detailed).toHaveLength(1);
    expect(detailed[0]!.attrs).toMatchObject({ strokeLinecap: 'round', strokeLinejoin: 'round' });
  });

  it('joins a closed outline with a capped line, and a single segment with a cornered one', () => {
    const merged = mergeIconParts([
      ['path', { d: 'M4 4H20V20H4Z', strokeLinejoin: 'round' }],
      ['path', { d: 'M8 12H16', strokeLinecap: 'round' }],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.attrs).toMatchObject({ strokeLinecap: 'round', strokeLinejoin: 'round' });
  });

  it('keeps apart what would draw differently joined', () => {
    // an open line with square ends beside one with round ends
    expect(mergeIconParts([['path', { d: 'M2 6H22' }], ['path', { d: 'M2 18H22', strokeLinecap: 'round' }]])).toHaveLength(2);
    // a cornered outline with mitred corners beside one with round corners
    expect(mergeIconParts([['path', { d: 'M4 4H20V20H4Z' }], ['path', { d: 'M8 8H16V16H8Z', strokeLinejoin: 'round' }]])).toHaveLength(2);
    // a filled part beside a stroked one
    expect(mergeIconParts([['path', { d: 'M4 4H20V20H4Z', fill: 'currentColor' }], ['circle', { cx: '12', cy: '12', r: '3' }]])).toHaveLength(2);
    // an open two-segment line has a corner: its join is its own
    expect(mergeIconParts([['path', { d: 'M4 4L12 12L20 4' }], ['path', { d: 'M4 20L12 14L20 20', strokeLinejoin: 'round' }]])).toHaveLength(2);
  });

  it('draws the everyday icons in one path each', () => {
    for (const icon of [Search01Icon, Copy01Icon]) expect(parts(icon).length).toBe(1);
  });
});
