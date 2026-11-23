/**
 * How long the desktop keeps its socket to the cloud computer open (plan §5.8 item 4, revised 2026-11-06): a
 * connection holds the computer awake, so it stays only while the person is there. The window in front (visible and
 * focused) holds it as long as they touched it within AWAY_MS; visible behind another app, for IDLE_CLOSE_MS after
 * their last look; hidden, not at all. The decision is pure so the rules are testable; `cloudClient.ts` applies it.
 */

/** the cloud on screen behind another app: its socket closes this long after the person last looked */
export const IDLE_CLOSE_MS = 5 * 60_000;
/** the window in front but untouched this long (a Mac left on): the socket closes, the computer may sleep */
export const AWAY_MS = 30 * 60_000;

export interface HoldState {
  /** the window is visible (not hidden, not minimised) */
  visible: boolean;
  /** the window is the one in front (document.hasFocus()) */
  focused: boolean;
  /** since the person last looked: the cloud came on screen, a click, a key, the window coming to the front or leaving it */
  sinceLookMs: number;
}

/** Whether the socket stays open now. */
export function holdsCloud(s: HoldState): boolean {
  if (!s.visible) return false;
  return s.sinceLookMs < (s.focused ? AWAY_MS : IDLE_CLOSE_MS);
}

/** How long until the hold runs out as things stand (0 when it has); the caller looks again then. */
export function holdLeftMs(s: HoldState): number {
  if (!s.visible) return 0;
  return Math.max(0, (s.focused ? AWAY_MS : IDLE_CLOSE_MS) - s.sinceLookMs);
}
