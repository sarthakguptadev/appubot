import { describe, expect, it } from 'vitest';
import { menuTarget, radioTarget } from './menuKeys';

describe('menuTarget', () => {
  it('steps down and wraps to the first item', () => {
    expect(menuTarget('ArrowDown', 0, 3)).toBe(1);
    expect(menuTarget('ArrowDown', 2, 3)).toBe(0);
  });
  it('steps up and wraps to the last item', () => {
    expect(menuTarget('ArrowUp', 2, 3)).toBe(1);
    expect(menuTarget('ArrowUp', 0, 3)).toBe(2);
  });
  it('starts at an end when nothing in the menu has focus', () => {
    expect(menuTarget('ArrowDown', -1, 3)).toBe(0);
    expect(menuTarget('ArrowUp', -1, 3)).toBe(2);
  });
  it('jumps to the ends with Home and End', () => {
    expect(menuTarget('Home', 2, 4)).toBe(0);
    expect(menuTarget('End', 0, 4)).toBe(3);
  });
  it('leaves other keys and empty menus alone', () => {
    expect(menuTarget('Enter', 0, 3)).toBeNull();
    expect(menuTarget('a', 0, 3)).toBeNull();
    expect(menuTarget('ArrowDown', -1, 0)).toBeNull();
  });
});

describe('radioTarget', () => {
  it('steps right and down to the next choice and wraps to the first', () => {
    expect(radioTarget('ArrowRight', 0, 3)).toBe(1);
    expect(radioTarget('ArrowDown', 0, 3)).toBe(1);
    expect(radioTarget('ArrowRight', 2, 3)).toBe(0);
    expect(radioTarget('ArrowDown', 2, 3)).toBe(0);
  });
  it('steps left and up to the previous choice and wraps to the last', () => {
    expect(radioTarget('ArrowLeft', 2, 3)).toBe(1);
    expect(radioTarget('ArrowUp', 2, 3)).toBe(1);
    expect(radioTarget('ArrowLeft', 0, 3)).toBe(2);
    expect(radioTarget('ArrowUp', 0, 3)).toBe(2);
  });
  it('jumps to the ends with Home and End', () => {
    expect(radioTarget('Home', 2, 4)).toBe(0);
    expect(radioTarget('End', 0, 4)).toBe(3);
  });
  it('leaves other keys and empty groups alone', () => {
    expect(radioTarget('Enter', 0, 3)).toBeNull();
    expect(radioTarget('a', 0, 3)).toBeNull();
    expect(radioTarget('ArrowRight', 0, 0)).toBeNull();
  });
});
