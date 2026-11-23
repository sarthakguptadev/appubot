/**
 * Visual replies' frames kept warm: a page's frame leaving the chat (another chat opened, its message scrolled out of
 * the list) is parked off screen rather than destroyed, and the next card showing that page takes it back, its
 * scripts, charts and scroll exactly as they were, with no reload or flash. Chromium moves a frame without reloading
 * it only through `moveBefore` (state-preserving moves); where that's missing nothing is parked and every card loads
 * its page as before. The newest `max` parked frames are kept; a parked frame is hidden and off screen, so Chromium
 * throttles it (a cross-origin frame out of view runs no animation frames).
 *
 * Pure: the DOM work is `FrameOps`, so the keeping is tested without a window.
 */
export interface FrameOps<F> {
  /** frames can move without reloading */
  canMove(): boolean;
  /** off screen, still running (throws when the move isn't possible: the frame is destroyed then) */
  park(f: F): void;
  destroy(f: F): void;
}

export class FramePool<F> {
  private idle = new Map<string, F>();

  constructor(private readonly max: number, private readonly ops: FrameOps<F>) {}

  /** A parked frame of that page, now the caller's (undefined: none). */
  take(key: string): F | undefined {
    const f = this.idle.get(key);
    if (f !== undefined) this.idle.delete(key);
    return f;
  }

  /** A frame the chat is done with: parked for the next card of its page, or destroyed. */
  release(key: string, f: F): void {
    if (!this.ops.canMove()) { this.ops.destroy(f); return; }
    const before = this.idle.get(key);
    if (before !== undefined && before !== f) this.ops.destroy(before);
    this.idle.delete(key);
    try {
      this.ops.park(f);
    } catch {
      this.ops.destroy(f);
      return;
    }
    this.idle.set(key, f);
    while (this.idle.size > this.max) {
      const [k, old] = this.idle.entries().next().value as [string, F];
      this.idle.delete(k);
      this.ops.destroy(old);
    }
  }

  /** Every parked frame destroyed (the theme changed, the computer switched). */
  clear(): void {
    for (const f of this.idle.values()) this.ops.destroy(f);
    this.idle.clear();
  }

  get size(): number { return this.idle.size; }
}
