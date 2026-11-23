/**
 * Where the main window opens and how big (pure: window.ts reads the file and the displays). The first time it is a
 * fixed size in the middle of the screen, never the whole screen; after that it comes back where and as big as it was
 * left, as long as that place still shows on a display (one unplugged since: the middle of the screen in use, at the
 * size it was).
 */
export interface Rect { x: number; y: number; width: number; height: number }

/** What is kept between launches: the window's own bounds (not its maximized ones) and whether it was maximized. */
export interface WindowState { bounds: Rect; maximized: boolean }

/** The size a window opens at the first time. */
export const DEFAULT_WINDOW_SIZE = { width: 1040, height: 760 } as const;
/** No smaller than this: the sidebar and a readable chat beside it. */
export const MIN_WINDOW_SIZE = { width: 960, height: 640 } as const;
/** this much of the window (px each way) must still be on a display for its place to be kept */
const MUST_SHOW = 120;

const whole = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** A saved state as it was written, or null for anything else (a file from elsewhere, half-written, hand-edited). */
export function parseWindowState(raw: unknown): WindowState | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = (raw as { bounds?: unknown }).bounds as Partial<Rect> | undefined;
  if (!b || !whole(b.x) || !whole(b.y) || !whole(b.width) || !whole(b.height) || b.width <= 0 || b.height <= 0) return null;
  return {
    bounds: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
    maximized: (raw as { maximized?: unknown }).maximized === true,
  };
}

function centred(area: Rect, width: number, height: number): Rect {
  const w = Math.min(width, area.width), h = Math.min(height, area.height);
  return { x: area.x + Math.round((area.width - w) / 2), y: area.y + Math.round((area.height - h) / 2), width: w, height: h };
}

function overlap(a: Rect, b: Rect): { w: number; h: number } {
  return {
    w: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    h: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  };
}

/**
 * The bounds to open with: the saved ones while enough of them shows on one of the displays' work areas (made to fit
 * it), else the default size (or the saved size) in the middle of `here`, the work area of the screen in use.
 */
export function openingBounds(saved: WindowState | null, workAreas: readonly Rect[], here: Rect): WindowState {
  if (!saved) return { bounds: centred(here, DEFAULT_WINDOW_SIZE.width, DEFAULT_WINDOW_SIZE.height), maximized: false };
  const width = Math.max(saved.bounds.width, MIN_WINDOW_SIZE.width);
  const height = Math.max(saved.bounds.height, MIN_WINDOW_SIZE.height);
  const home = workAreas.find((area) => {
    const o = overlap(saved.bounds, area);
    return o.w >= Math.min(MUST_SHOW, saved.bounds.width) && o.h >= Math.min(MUST_SHOW, saved.bounds.height);
  });
  if (!home) return { bounds: centred(here, width, height), maximized: saved.maximized };
  const w = Math.min(width, home.width), h = Math.min(height, home.height);
  return {
    bounds: {
      x: Math.min(Math.max(saved.bounds.x, home.x), home.x + home.width - w),
      y: Math.min(Math.max(saved.bounds.y, home.y), home.y + home.height - h),
      width: w,
      height: h,
    },
    maximized: saved.maximized,
  };
}
