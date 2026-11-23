import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE, openingBounds, parseWindowState } from './windowBounds';

const screen = { x: 0, y: 25, width: 1470, height: 870 };
const second = { x: 1470, y: 0, width: 1920, height: 1080 };

describe('the main window’s opening bounds', () => {
  it('opens at a fixed size in the middle of the screen the first time, never filling it', () => {
    const { bounds, maximized } = openingBounds(null, [screen], screen);
    expect(bounds).toEqual({ x: 215, y: 80, width: DEFAULT_WINDOW_SIZE.width, height: DEFAULT_WINDOW_SIZE.height });
    expect(maximized).toBe(false);
  });

  it('fits a screen smaller than the default size', () => {
    const small = { x: 0, y: 25, width: 1000, height: 600 };
    expect(openingBounds(null, [small], small).bounds).toEqual({ x: 0, y: 25, width: 1000, height: 600 });
  });

  it('comes back where and as big as it was left', () => {
    const saved = { bounds: { x: 100, y: 60, width: 1200, height: 800 }, maximized: false };
    expect(openingBounds(saved, [screen, second], screen)).toEqual(saved);
    const onSecond = { bounds: { x: 1600, y: 100, width: 1300, height: 900 }, maximized: true };
    expect(openingBounds(onSecond, [screen, second], screen)).toEqual(onSecond);
  });

  it('is pulled back onto its screen when part of it hangs off', () => {
    const saved = { bounds: { x: 900, y: 500, width: 1200, height: 800 }, maximized: false };
    expect(openingBounds(saved, [screen], screen).bounds).toEqual({ x: 270, y: 95, width: 1200, height: 800 });
  });

  it('goes to the middle of the screen in use when its display is gone, at the size it was', () => {
    const saved = { bounds: { x: 1600, y: 100, width: 1300, height: 800 }, maximized: false };
    expect(openingBounds(saved, [screen], screen).bounds).toEqual({ x: 85, y: 60, width: 1300, height: 800 });
  });

  it('is never smaller than the minimum', () => {
    const saved = { bounds: { x: 100, y: 60, width: 300, height: 200 }, maximized: false };
    const { bounds } = openingBounds(saved, [screen], screen);
    expect(bounds.width).toBe(MIN_WINDOW_SIZE.width);
    expect(bounds.height).toBe(MIN_WINDOW_SIZE.height);
  });
});

describe('a saved window state', () => {
  it('is read back as written', () => {
    expect(parseWindowState({ bounds: { x: 1.4, y: 2, width: 1000, height: 700 }, maximized: true }))
      .toEqual({ bounds: { x: 1, y: 2, width: 1000, height: 700 }, maximized: true });
  });

  it('is nothing when it is not one', () => {
    for (const bad of [null, 'x', {}, { bounds: {} }, { bounds: { x: 0, y: 0, width: 0, height: 700 } }, { bounds: { x: 0, y: 0, width: 'a', height: 1 } }]) {
      expect(parseWindowState(bad)).toBeNull();
    }
  });
});
