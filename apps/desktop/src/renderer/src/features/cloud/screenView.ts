import { CONTROL_IDLE_MS, type BotScreen, type ScreenControl } from '@appubot/protocol';
import type { CloudPhase } from './cloudView';
import type { QualityLevels } from './desktopQuality';

/**
 * What the side panel's Computer tab and the full-screen viewer show of your AppuBot computer's screen (or a team's),
 * decided from the computer's state, the app's connection to it and the screen session's phase. Pure, tested.
 */

/** the screen session (`screenSession.ts`): asking for a link, opening the socket, the computer waking, live, … */
export type ScreenPhase = 'idle' | 'linking' | 'connecting' | 'waking' | 'connected' | 'reconnecting' | 'failed' | 'paused';

/** the app's connection to that computer (`useCloudLink.conn`) */
export type LinkConn = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'unauthorized' | 'incompatible' | (string & {});

export type ScreenCardKind = 'asleep' | 'waking' | 'connecting' | 'live' | 'reconnecting' | 'paused' | 'unreachable';
export interface ScreenCard { kind: ScreenCardKind; title: string; line?: string }

/** the preview: one picture a second, cheap JPEG, scaled down in the panel */
export const PREVIEW_PACE_MS = 1000;
export const PREVIEW_LEVELS: QualityLevels = { quality: 1, compression: 9 };

const ASLEEP: readonly CloudPhase[] = ['asleep', 'stopped'];
const LINK_FAILED: readonly LinkConn[] = ['closed', 'unauthorized', 'incompatible'];

/** The app can't reach that computer at all (its bots aren't here either). */
export function linkFailed(conn: LinkConn, linkError?: string): boolean {
  return LINK_FAILED.includes(conn) || !!linkError;
}

/** Whether the preview may open the screen by itself: not while it sleeps (that would wake it for a look) or can't be reached. */
export function mayStream(o: { cloud: CloudPhase; conn: LinkConn; linkError?: string }): boolean {
  if (linkFailed(o.conn, o.linkError)) return false;
  return !(ASLEEP.includes(o.cloud) && o.conn !== 'connected');
}

/** The card's state and words. */
export function screenCard(o: { cloud: CloudPhase; conn: LinkConn; linkError?: string; phase: ScreenPhase; why?: string }): ScreenCard {
  if (linkFailed(o.conn, o.linkError)) return { kind: 'unreachable', title: 'Can’t reach it', line: o.linkError || 'It didn’t answer. Try again in a moment.' };
  if (o.phase === 'failed') return { kind: 'unreachable', title: 'Can’t reach its screen', line: o.why || 'Its screen didn’t open.' };
  if (o.phase === 'connected') return { kind: 'live', title: 'Live' };
  if (o.phase === 'paused') return { kind: 'paused', title: 'Paused', line: 'Paused after a while without you, so it can sleep.' };
  if (o.phase === 'reconnecting') return { kind: 'reconnecting', title: 'Reconnecting…' };
  if (o.phase === 'waking' || o.cloud === 'waking' || o.conn === 'connecting' || o.conn === 'reconnecting') return { kind: 'waking', title: 'Waking up…' };
  if (o.phase === 'linking' || o.phase === 'connecting') return { kind: 'connecting', title: 'Connecting…' };
  if (ASLEEP.includes(o.cloud) && o.conn !== 'connected') return { kind: 'asleep', title: 'Asleep', line: 'Wake it to watch its screen.' };
  return { kind: 'connecting', title: 'Connecting…' };
}

/**
 * The screen port's socket for one screen: a bot's own (`screen`: its id, the gateway's `?screen=`), else the
 * computer's main screen (the link as it came).
 */
export function screenUrl(websocketUrl: string, screen: string | undefined): string {
  if (!screen) return websocketUrl;
  const u = new URL(websocketUrl);
  u.searchParams.set('screen', screen);
  return u.toString();
}

/**
 * What a bot's own screen is doing, in a few words (the bot's Computer tab, the viewer's switcher): who has control,
 * else working, else its state. Never started yet reads as asleep: it starts with its first step, or when opened.
 */
export function botScreenLine(s: BotScreen | undefined): string {
  if (!s) return 'Asleep';
  if (s.control) return `${s.control.name} has control`;
  if (s.state === 'starting') return 'Starting…';
  if (s.state === 'asleep') return 'Asleep';
  if (s.busy || s.activeThreadId) return 'Working';
  return 'Idle';
}

/** Under the preview: which bot is using it now, else whose computer it is. */
export function screenCaption(o: { computer: string; botName?: string }): string {
  return o.botName ? `${o.botName} is using it` : o.computer;
}

/**
 * Control held by this viewer alone, on a computer that doesn't speak the control channel (from before it): the
 * viewer just lets its input through, and gives it back after CONTROL_IDLE_MS without input, as the computer would.
 */
export function localControl(name: string, since: number, until: number, now: number): ScreenControl {
  return { id: 'local', name, via: 'desktop', since, expiresAt: until, left: Math.max(0, until - now) };
}

/** When control held here goes back if nothing more happens: CONTROL_IDLE_MS after the last input. */
export function controlUntil(lastInput: number): number {
  return lastInput + CONTROL_IDLE_MS;
}

/** the full viewer's layout, in CSS pixels: the room around the screen, the pill under it and the gap between */
export const VIEWER_MARGIN = 12;
export const VIEWER_PILL_H = 40;
/** the panel's top row (the computer's name and ✕) */
export const VIEWER_HEADER_H = 44;
/** the panel's place in the window: below the traffic lights' row, and this much of the dimmed app on the other sides */
export const VIEWER_INSET = { top: 42, side: 24 } as const;
/** the shape a screen is drawn in before its size is known (the cloud computer's own 1440×900) */
export const DEFAULT_SCREEN = { w: 1440, h: 900 } as const;

/**
 * The screen's box in the full viewer: as large as fits `room` (the viewer's space inside its margins) with the pill
 * (`VIEWER_PILL_H`, `VIEWER_MARGIN` above it) reserved under it, keeping the screen's shape, scaled up or down. Whole
 * pixels, never over the room, so noVNC (which fits its canvas to this box) fills it exactly.
 */
export function fitScreen(room: { w: number; h: number }, fb: { w: number; h: number } | undefined): { w: number; h: number } {
  const s = fb && fb.w > 0 && fb.h > 0 ? fb : DEFAULT_SCREEN;
  const w = Math.max(0, Math.floor(room.w));
  const h = Math.max(0, Math.floor(room.h) - VIEWER_PILL_H - VIEWER_MARGIN);
  if (!w || !h) return { w: 0, h: 0 };
  // the limiting side fills the room exactly; the other follows the shape
  if (w * s.h <= h * s.w) return { w, h: Math.min(h, Math.floor((w * s.h) / s.w)) };
  return { w: Math.min(w, Math.floor((h * s.w) / s.h)), h };
}

/** X11's left Control key: a Mac's ⌘ shortcuts go to the computer (Linux) as Ctrl ones */
export const XK_CONTROL_L = 0xffe3;
/** the clipboard text carried between this Mac and the computer at most (a bigger copy stays where it is) */
export const CLIPBOARD_MAX = 1_000_000;

const PUNCT_KEYSYMS: Record<string, number> = {
  Space: 0x20, Quote: 0x27, Comma: 0x2c, Minus: 0x2d, Period: 0x2e, Slash: 0x2f, Semicolon: 0x3b, Equal: 0x3d,
  BracketLeft: 0x5b, Backslash: 0x5c, BracketRight: 0x5d, Backquote: 0x60,
};

/**
 * The X keysym a ⌘ shortcut's key becomes on the computer, by its physical key (`KeyboardEvent.code`, so ⇧ or the
 * layout doesn't change it): letters lower case, digits and the punctuation keys; null for anything else (arrows,
 * function keys…), which goes to the computer as it is.
 */
export function shortcutKeysym(code: string): number | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!.toLowerCase().charCodeAt(0);
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1]!.charCodeAt(0);
  return PUNCT_KEYSYMS[code] ?? null;
}
