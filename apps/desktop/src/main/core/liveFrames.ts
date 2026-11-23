/**
 * Live-view quality per connection. The bot gets full-quality screenshots; every device watching gets its own encode
 * of each frame at a tier picked from its link: `auto` starts in the middle, steps down when frames back up on the
 * socket or the round trip is slow, and steps back up after a run of frames that went out cleanly. This Mac's own
 * window (loopback) always gets the best tier.
 */
import type { LiveQuality } from '@appubot/protocol';

export interface FrameTier { maxDim: number; quality: number }

/** best → data saver; `maxDim` is the long edge in px, `quality` the JPEG quality 0..1 */
export const FRAME_TIERS: readonly FrameTier[] = [
  { maxDim: 2048, quality: 0.85 },
  { maxDim: 1600, quality: 0.75 },
  { maxDim: 1280, quality: 0.62 },
  { maxDim: 960, quality: 0.5 },
  { maxDim: 720, quality: 0.42 },
];
const LAST = FRAME_TIERS.length - 1;
const FIXED: Record<Exclude<LiveQuality, 'auto'>, number> = { best: 0, balanced: 2, saver: LAST };

/** bytes still queued on the socket past which a frame is skipped, or the tier stepped down */
export const SKIP_BACKLOG = 1_500_000;
export const SLOW_BACKLOG = 200_000;
/** clean frames in a row before stepping up */
export const CLEAN_RUN = 3;

export interface LinkState {
  /** current tier index (0 = best) */
  tier: number;
  /** frames in a row that found the socket drained */
  clean: number;
  /** smoothed round trip in ms, from the gateway's pings (undefined until measured) */
  rtt?: number;
  /** this Mac's own window */
  local: boolean;
}

export const newLink = (local: boolean): LinkState => ({ tier: local ? 0 : 2, clean: 0, local });

/** A slow round trip caps how good the tier may be. */
function rttFloor(rtt: number | undefined): number {
  if (rtt === undefined) return 0;
  if (rtt > 800) return 4;
  if (rtt > 400) return 3;
  if (rtt > 200) return 2;
  return 0;
}

/**
 * The tier for the next frame on this link (null: skip it, the socket is too far behind), updating `link`.
 * `backlog` is the socket's bufferedAmount right now.
 */
export function nextTier(link: LinkState, backlog: number, mode: LiveQuality): number | null {
  if (backlog > SKIP_BACKLOG) {
    link.tier = Math.min(LAST, link.tier + 1);
    link.clean = 0;
    return null;
  }
  if (mode !== 'auto') return FIXED[mode];
  if (link.local) return 0;
  if (backlog > SLOW_BACKLOG) {
    link.tier = Math.min(LAST, link.tier + 1);
    link.clean = 0;
  } else if (backlog === 0 && ++link.clean >= CLEAN_RUN) {
    link.tier = Math.max(0, link.tier - 1);
    link.clean = 0;
  }
  link.tier = Math.max(link.tier, rttFloor(link.rtt));
  return link.tier;
}

/** Fold a new round-trip sample into the link's smoothed value. */
export function addRtt(link: LinkState, ms: number): void {
  link.rtt = link.rtt === undefined ? ms : Math.round(link.rtt * 0.7 + ms * 0.3);
}
