/** Computer use's rules that need no backend: which actions need a window, how keys and apps are named on each OS, what an action reads as. */
import type { ComputerAction } from '@appubot/protocol';
import { truncate } from '../util';

/** Pointer actions a bot may only aim at an app window (background delivery keeps the user's mouse free). */
export const NEEDS_WINDOW = new Set<ComputerAction['type']>(['click', 'double_click', 'right_click', 'drag', 'scroll', 'move']);
/** keyboard input: it goes to the window given, else to the app in front */
export const KEYBOARD = new Set<ComputerAction['type']>(['type', 'key', 'hotkey']);
/** clicks: on web content they go out as real clicks (see CuaBackend.realClick) */
export const POINTER_TYPES = new Set<ComputerAction['type']>(['click', 'double_click', 'right_click']);
export const NEEDS_WINDOW_HINT =
  "Pointer actions run in the background on an app window, so the user's own mouse keeps working. Get the window's pid and window_id " +
  '(computer_open_app or computer_list_windows), call computer_window, then target an element_token or x/y pixels of that window image.';

/* ---------- helpers ---------- */
export function parseDetail(detail: string | undefined): Record<string, unknown> {
  if (!detail) return {};
  try {
    const v = JSON.parse(detail) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch { return { value: detail }; }
}

export const normMod = (m: string): string => {
  const x = m.toLowerCase();
  if (x === 'command' || x === 'meta' || x === 'super' || x === 'cmd') return 'cmd';
  if (x === 'option' || x === 'opt' || x === 'alt') return 'option';
  if (x === 'control' || x === 'ctrl') return 'ctrl';
  return x;
};

/**
 * A modifier key as Cua takes it on this OS (`os` is Node's `process.platform`). macOS: cmd/option/ctrl/shift. Windows
 * knows ctrl/shift/alt/win and Linux ctrl/shift/alt/super: there a Mac's Cmd shortcut is the Ctrl one (Cmd+S is Ctrl+S),
 * Option is Alt, and the Windows or Super key is asked for by name (win, super, meta).
 */
export function cuaModifier(m: string, os: string): string {
  if (os === 'darwin') return normMod(m);
  const x = m.toLowerCase();
  if (x === 'command' || x === 'cmd' || x === 'control' || x === 'ctrl') return 'ctrl';
  if (x === 'option' || x === 'opt' || x === 'alt') return 'alt';
  if (x === 'meta' || x === 'super' || x === 'win' || x === 'windows') return os === 'win32' ? 'win' : 'super';
  return x;
}

/** Width/height from a PNG's IHDR chunk. */
export function pngSize(b64: string): { width: number; height: number } | null {
  try {
    const buf = Buffer.from(b64.slice(0, 64), 'base64');
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch { return null; }
}

/**
 * Actions that change what's on screen, and how long the app gets to draw the result before the picture the bot
 * gets back (ms). Opening an app returns its windows instead of a picture.
 */
export const SETTLE: Partial<Record<ComputerAction['type'], number>> = {
  click: 250, double_click: 250, right_click: 250, drag: 250, scroll: 180, type: 150, key: 180, hotkey: 200, focus_window: 250,
};
/**
 * Between the steps of a batch (ms): long enough for the app to take the input in before the next one, with no
 * picture to wait for. Only the batch's last step gets its full SETTLE before the look at the end.
 */
export const STEP_GAP: Partial<Record<ComputerAction['type'], number>> = {
  click: 60, double_click: 60, right_click: 120, drag: 120, scroll: 60, type: 40, key: 40, hotkey: 80, focus_window: 150, open_app: 150,
};

/** An action as the feed may show it: a Vault secret's text never leaves the step that types it. */
export const masked = (a: ComputerAction): ComputerAction => (a.secret ? { ...a, text: '••••••' } : a);

export function summarizeAction(a: ComputerAction): string {
  const at = a.x !== undefined && a.y !== undefined ? ` at (${Math.round(a.x)}, ${Math.round(a.y)})` : '';
  switch (a.type) {
    case 'screenshot': return 'Took a screenshot';
    case 'click': return `Clicked${at}`;
    case 'double_click': return `Double-clicked${at}`;
    case 'right_click': return `Right-clicked${at}`;
    case 'move': return `Moved the pointer${at}`;
    case 'drag': return `Dragged${at} to (${Math.round(a.toX ?? 0)}, ${Math.round(a.toY ?? 0)})`;
    case 'type': return a.secret ? 'Typed a saved item from the Vault' : `Typed "${truncate(a.text ?? '', 40)}"`;
    case 'key': case 'hotkey': return `Pressed ${a.key ?? ''}`;
    case 'scroll': return `Scrolled ${String(parseDetail(a.detail).direction ?? 'down')}${at}`;
    case 'open_app': return `Opened ${a.app ?? 'an app'}`;
    case 'focus_window': return `Focused ${a.app ?? 'a window'}`;
    case 'wait': return 'Waited';
    case 'accessibility': return 'Read the accessibility tree';
    case 'window': return `Looked at ${a.app ?? 'a window'}`;
    case 'clipboard': return parseDetail(a.detail).op === 'write' ? 'Wrote the clipboard' : 'Read the clipboard';
    default: return `Ran ${String(parseDetail(a.detail).cmd ?? a.type)}`;
  }
}

/**
 * Long edge of the screenshots the bot works from, sent losslessly. Current Claude models read up to 2576px / 3.75MP
 * with coordinates 1:1 to pixels (bigger gets shrunk and clicks drift: a full Retina screen at 2576 wide is ~4.3MP);
 * 2048 stays under both for screens and windows, and is GPT's limit too. Live views get their own encode per device
 * (gateway, liveFrames.ts).
 */
export const AGENT_DIM = 2048;
/** JPEG quality when a backend only gives JPEG (the native helper) */
export const AGENT_JPEG = 0.95;
/** JPEG quality of the pictures the bot gets from Cua (lossless PNG there): small text stays sharp */
export const AGENT_QUALITY = 0.85;
/** what a device's own `computer.screenshot` call gets back (its live view adapts separately) */
export const UI_SHOT = { maxDim: 1600, quality: 0.75 };

/** Browsers by app name: their page counts as web content even when the snapshot's tree doesn't reach it. */
const BROWSERS = new Set(['safari', 'safari technology preview', 'google chrome', 'google chrome canary', 'chromium', 'arc', 'brave browser',
  'microsoft edge', 'firefox', 'firefox developer edition', 'opera', 'vivaldi', 'orion', 'helium', 'zen', 'zen browser', 'dia', 'comet', 'sigmaos', 'duckduckgo']);
/**
 * Browsers on Windows and Linux. Cua names a window's app there by its process (Windows: the executable, "msedge.exe";
 * Linux: the command or its window class, "google-chrome", "firefox") or by its product name, so both are listed.
 */
const OTHER_BROWSERS = new Set(['microsoft edge', 'msedge', 'microsoft-edge', 'microsoft-edge-stable', 'microsoft-edge-beta', 'microsoft-edge-dev',
  'google chrome', 'chrome', 'google-chrome', 'google-chrome-stable', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'chromium-browser',
  'firefox', 'firefox-esr', 'mozilla firefox', 'firefox developer edition', 'firefox-developer-edition', 'librewolf', 'waterfox', 'floorp',
  'brave', 'brave browser', 'brave-browser', 'brave-browser-stable', 'opera', 'vivaldi', 'vivaldi-stable', 'arc', 'zen', 'zen browser', 'zen-browser', 'helium', 'yandex', 'epiphany']);

/** Is this app (as Cua names it on `os`) a web browser? */
export function isBrowserApp(name: string | undefined, os: string): boolean {
  const n = (name ?? '').toLowerCase();
  if (os === 'darwin') return BROWSERS.has(n);
  return OTHER_BROWSERS.has(n.trim().replace(/\.exe$/, ''));
}

/*
 * Accessibility roles as Cua reports them on each OS: macOS AX roles ("AXButton"), Windows UI Automation control types
 * ("Button", "Edit", "Document") and Linux AT-SPI role names ("push button", "document web").
 */

/**
 * Is this element the root of web content (a browser page, an Electron app's view)? macOS: AXWebArea. Linux: AT-SPI's
 * "document web", which only pages have. Windows: UI Automation calls a page a "Document" like any text editor's
 * area, so only one Cua marks as web content counts.
 */
export function isWebArea(os: string, role: string | undefined, inWebContent?: boolean): boolean {
  if (os === 'darwin') return role === 'AXWebArea';
  if (os === 'linux') return role === 'document web';
  return role === 'Document' && inWebContent === true;
}

/** Roles of text a window shows (a label, a calculator's display) and doesn't let you edit. */
export function staticTextRoles(os: string): Set<string> {
  return new Set(os === 'darwin' ? ['AXStaticText'] : os === 'win32' ? ['Text'] : ['label', 'static']);
}

/** The menu bar's role (its menus, hundreds of items in some apps, crowd the element list). */
export const menuBarRole = (os: string): string => (os === 'darwin' ? 'AXMenuBar' : os === 'win32' ? 'MenuBar' : 'menu bar');

/** Controls a label most likely means when several elements carry it (macOS AX roles). */
const PRESSABLE_MAC = /button|menuitem|checkbox|radio|tab|link|popup|cell|textfield|searchfield|combobox|textarea/i;
/** The same for UI Automation and AT-SPI roles, compared without spaces ("push button", "MenuItem", "Edit", "entry"). */
const PRESSABLE_OTHER = /button|menuitem|checkbox|radio|tab|link|cell|combobox|edit|entry|listitem|treeitem|dataitem|spin/i;
export function isPressable(os: string, role: string | undefined): boolean {
  return os === 'darwin' ? PRESSABLE_MAC.test(role ?? '') : PRESSABLE_OTHER.test((role ?? '').replace(/[\s_-]+/g, ''));
}

/**
 * What Cua's launch_app gets to open an app (`app`: a name, or on Windows and Linux also a path or command), with a
 * URL or file to open in it. macOS hands the URL to the app itself (`urls`). Windows and Linux open `urls` with the
 * system's default handler instead, so a URL meant for a named app goes on its command line (browsers and most apps
 * open what they are given there). A bundle id is macOS's; on Windows Cua takes a packaged app's AUMID there, and on
 * Linux the desktop-file id it lists as `bundle_id` is matched as a name.
 */
export function launchArgs(os: string, o: { app?: string; bundleId?: string; url?: string }): Record<string, unknown> {
  if (os === 'darwin') return { name: o.bundleId ? undefined : o.app, bundle_id: o.bundleId, urls: o.url ? [o.url] : undefined };
  const args: Record<string, unknown> = {};
  if (o.bundleId) {
    if (os === 'win32') args.bundle_id = o.bundleId;
    else args.name = o.bundleId;
  } else if (o.app) {
    // Windows: a full path or an .exe goes as `path`; a name is looked up among the installed apps, then on PATH
    if (os === 'win32' && (/[\\/]/.test(o.app) || /\.exe$/i.test(o.app))) args.path = o.app;
    else args.name = o.app;
  }
  if (o.url) {
    if (args.name !== undefined || args.path !== undefined || args.bundle_id !== undefined) args.additional_arguments = [o.url];
    else args.urls = [o.url];
  }
  return args;
}

/** The running app a name means (`list_apps`' entries): its name or bundle id, else a name containing it. */
export function findRunningApp<T extends { name?: string; pid?: number; running?: boolean; bundle_id?: string }>(apps: T[], name: string, os: string): T | undefined {
  // Windows names apps by their executable too ("notepad.exe")
  const bare = (s: string) => (os === 'win32' ? s.replace(/\.exe$/i, '') : s);
  const n = bare(name.toLowerCase());
  return apps.find((a) => a.running && (bare((a.name ?? '').toLowerCase()) === n || (a.bundle_id ?? '').toLowerCase() === n))
    ?? apps.find((a) => a.running && (a.name ?? '').toLowerCase().includes(n));
}

const MAX_TEXT = 60_000;
export const clampText = (s: string): string => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\n…(truncated)' : s);
