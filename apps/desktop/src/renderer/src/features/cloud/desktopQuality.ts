/**
 * The desktop viewer's picture quality (noVNC's `qualityLevel` 0..9, JPEG, and `compressionLevel` 0..9, zlib), and
 * how `auto` moves it. The server (TigerVNC's Xvnc) already paces its updates to the link's round trip and bandwidth;
 * what the viewer decides is how many bytes each update costs. `auto` watches what arrived over the last seconds and
 * lowers the quality while the screen is busy enough to flood the link (a scrolling page, video), bringing it back
 * once the stream is light again, so a busy screen stays fluid instead of lagging behind a queue of crisp frames.
 * The full viewer always uses `auto` (there is no picker); the side panel's preview has levels of its own
 * (`screenView.ts` `PREVIEW_LEVELS`). Pure, tested.
 */
export type DesktopQuality = 'auto' | 'best' | 'balanced' | 'saver';

export interface QualityLevels { quality: number; compression: number }

export const QUALITY_LEVELS: Record<Exclude<DesktopQuality, 'auto'>, QualityLevels> = {
  best: { quality: 8, compression: 1 },
  balanced: { quality: 6, compression: 2 },
  saver: { quality: 3, compression: 6 },
};
/** where `auto` starts (noVNC's own defaults) and the range it moves in */
export const AUTO_START: QualityLevels = QUALITY_LEVELS.balanced;
const AUTO_MIN = 2;
const AUTO_MAX = 8;
/** bytes a second of updates above which the picture goes a step cheaper, below which (for a while) a step better */
export const HEAVY_BPS = 1_500_000;
export const LIGHT_BPS = 250_000;
/** the stream must stay light this long before quality steps up (and steps are this far apart) */
export const STEP_UP_MS = 6000;
export const STEP_MS = 2000;

export interface AutoState { quality: number; compression: number; lightSince: number; steppedAt: number }

export function autoStart(now = Date.now()): AutoState {
  return { ...AUTO_START, lightSince: now, steppedAt: now - STEP_MS };
}

/** `auto`'s next levels from the bytes a second seen over the last window. */
export function stepQuality(s: AutoState, bytesPerSecond: number, now: number): AutoState {
  const sinceStep = now - s.steppedAt;
  if (bytesPerSecond >= HEAVY_BPS) {
    const lightSince = now;
    if (sinceStep < STEP_MS || s.quality <= AUTO_MIN) return { ...s, lightSince };
    return { quality: s.quality - 1, compression: Math.min(9, s.compression + 1), lightSince, steppedAt: now };
  }
  if (bytesPerSecond > LIGHT_BPS) return { ...s, lightSince: now };
  if (now - s.lightSince < STEP_UP_MS || sinceStep < STEP_MS || s.quality >= AUTO_MAX) return s;
  return { quality: s.quality + 1, compression: Math.max(AUTO_START.compression, s.compression - 1), lightSince: now, steppedAt: now };
}

/** "1.2 MB/s" / "340 KB/s" (for logs; the viewer no longer shows the rate). */
export function rateText(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1_000_000) return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`;
  return `${Math.round(bytesPerSecond / 1000)} KB/s`;
}

/** Bytes a second over the samples (when, bytes) of the last `windowMs`. */
export function rateOver(samples: readonly { at: number; bytes: number }[], now: number, windowMs: number): number {
  let total = 0;
  for (const s of samples) if (now - s.at <= windowMs) total += s.bytes;
  return (total * 1000) / windowMs;
}

/** how long a reconnect waits after `attempt` failures in a row (1 s, 2, 4, 8, then 8), and when to give up */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(8000, 1000 * 2 ** Math.max(0, attempt - 1));
}
export const RECONNECT_GIVE_UP = 8;
