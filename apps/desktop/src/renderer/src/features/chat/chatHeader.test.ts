import { describe, expect, it } from 'vitest';
import { CRUMB, CRUMB_CAPSULE, CRUMB_LEAD } from './ChatHeader';

const classes = (s: string) => s.split(/\s+/);

describe('the header capsule', () => {
  it('fills edge to edge under the pointer: the fill and its hover sit on the one shape, with no padded ring around it', () => {
    expect(classes(CRUMB_CAPSULE).filter((c) => /^(bg-|p-|px-|py-|rounded|squircle$|ab-pill$)/.test(c))).toEqual([]);
    expect(classes(CRUMB)).toEqual(expect.arrayContaining(['bg-surface-2', 'hover:bg-surface-3', 'rounded-control-lg', 'ab-pill', 'squircle', 'h-10']));
  });

  it('keeps the capsule 40px tall with 7.5px before the avatar and 13.5px after the name', () => {
    expect(classes(CRUMB)).toContain('h-10');
    expect(classes(CRUMB_LEAD)).toEqual(expect.arrayContaining(['pl-[7.5px]', 'pr-[13.5px]']));
  });
});
