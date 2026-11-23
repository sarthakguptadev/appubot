/**
 * Who wants the screen session (`screenSession.ts`) now: the side panel's preview, the full-screen viewer. Each view
 * asks under its own key and lets go when it goes; the session follows the list (`change`). When the last view lets go
 * the connection isn't closed at once but after `RELEASE_GRACE_MS` (`idle`): a panel collapsed for a moment, a tab
 * switched and back, the preview and the full viewer handing the picture over, React's dev double mount, a window
 * hidden briefly all come back to the same live connection, while nothing showing it for longer lets the computer
 * sleep (an open screen socket counts as watching on the computer, so it would stay awake). Pure: timers only.
 */

/** nothing shows the screen for this long: its connection closes */
export const RELEASE_GRACE_MS = 30_000;

export class ScreenWants<W> {
  private readonly wants = new Map<string, W>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly on: {
      /** the wishes now (empty: nobody shows it, the grace runs) */
      change(list: W[]): void;
      /** the grace ran out with nobody back: close the connection */
      idle(): void;
    },
    private readonly graceMs = RELEASE_GRACE_MS,
  ) {}

  /** A view wants the screen (again with new wishes: the same key replaces them). */
  want(key: string, w: W): void {
    this.wants.set(key, w);
    this.cancelGrace();
    this.on.change(this.list());
  }

  /** A view lets go; the last one starts the grace. */
  release(key: string): void {
    if (!this.wants.delete(key)) return;
    this.on.change(this.list());
    if (this.wants.size || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.wants.size) this.on.idle();
    }, this.graceMs);
  }

  list(): W[] { return [...this.wants.values()]; }

  /** the grace is running (nobody shows it, the connection is still up) */
  get lingering(): boolean { return this.timer !== null; }

  private cancelGrace(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
