import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELEASE_GRACE_MS, ScreenWants } from './screenWants';

interface Want { full: boolean }

/** a stand-in for the screen session: one connection, opened by the first want and closed by `idle` */
function session() {
  const log: string[] = [];
  let open = false;
  let opened = 0;
  const wants = new ScreenWants<Want>({
    change: (list) => {
      if (list.length && !open) { open = true; opened += 1; log.push('connect'); }
      log.push(list.length ? (list.some((w) => w.full) ? 'full' : 'preview') : 'nobody');
    },
    idle: () => { open = false; log.push('disconnect'); },
  });
  return { wants, log, isOpen: () => open, opened: () => opened };
}

describe('the screen session’s one connection', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('survives the preview handing over to the full viewer and back', () => {
    const s = session();
    s.wants.want('panel', { full: false });
    // expand: the viewer wants it, and the preview stops drawing it (in either order)
    s.wants.want('viewer', { full: true });
    s.wants.release('panel');
    // close: the preview is back, the viewer lets go
    s.wants.want('panel', { full: false });
    s.wants.release('viewer');
    vi.advanceTimersByTime(RELEASE_GRACE_MS * 2);
    expect(s.opened()).toBe(1);
    expect(s.isOpen()).toBe(true);
    expect(s.log).toEqual(['connect', 'preview', 'full', 'full', 'full', 'preview']);
  });

  it('keeps it through a short gap: a tab switched, the panel collapsed, React’s dev double mount', () => {
    const s = session();
    s.wants.want('panel', { full: false });
    s.wants.release('panel');
    s.wants.want('panel', { full: false });
    s.wants.release('panel');
    vi.advanceTimersByTime(RELEASE_GRACE_MS - 1);
    expect(s.isOpen()).toBe(true);
    s.wants.want('panel', { full: false });
    vi.advanceTimersByTime(RELEASE_GRACE_MS * 2);
    expect(s.opened()).toBe(1);
    expect(s.log).not.toContain('disconnect');
  });

  it('closes it once nothing has shown it for the grace, so the computer can sleep', () => {
    const s = session();
    s.wants.want('viewer', { full: true });
    s.wants.release('viewer');
    // nobody shows it: the session hears it at once (paced, control given back) and stays connected meanwhile
    expect(s.log).toEqual(['connect', 'full', 'nobody']);
    expect(s.wants.lingering).toBe(true);
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(s.isOpen()).toBe(false);
    expect(s.log.filter((l) => l === 'disconnect')).toHaveLength(1);
    expect(s.wants.lingering).toBe(false);
    // a later look connects again
    s.wants.want('panel', { full: false });
    expect(s.opened()).toBe(2);
  });

  it('ignores letting go of what it never had, and a second release doesn’t restart the grace', () => {
    const s = session();
    s.wants.release('panel');
    expect(s.log).toEqual([]);
    s.wants.want('panel', { full: false });
    s.wants.release('panel');
    vi.advanceTimersByTime(RELEASE_GRACE_MS / 2);
    s.wants.release('panel');
    vi.advanceTimersByTime(RELEASE_GRACE_MS / 2);
    expect(s.isOpen()).toBe(false);
  });
});
