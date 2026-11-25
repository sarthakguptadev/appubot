/**
 * Computer use: a ComputerService that serializes actions, enforces pause, emits frames/actions,
 * on top of a pluggable backend - Cua Driver (in-process) or the Swift native helper.
 */
import { computerUseSupported, machineName, newId, type ComputerAction, type ComputerFrame, type ComputerStatus, type ComputerTarget, type ScreenControl, type ScreenWait } from '@appubot/protocol';
import type { CoreCtx, ImageCodec } from '../context';
import { errMsg, Mutex, RpcError, sleep, truncate, type Logger } from '../util';
import type { HelperTransport } from './nativeHelper';
import { AGENT_CURSOR_TITLE, AgentCursorController } from './agentCursor';
import { linuxSessionProblem } from './inputRecorder';
import { ScreenControlHolder, type ControlHolder } from './screenControl';

export interface Perms { accessibility: boolean; screenRecording: boolean; inputMonitoring?: boolean }
export interface ScreenInfo { width: number; height: number; scale: number }
export interface Shot { data: string; mimeType: string; width: number; height: number }

export interface Rect { x: number; y: number; w: number; h: number }

/** Where things are in an app window's last snapshot: element centres in snapshot pixels and in screen points. */
export interface WindowGeometry {
  target: ComputerTarget & { bounds: NonNullable<ComputerTarget['bounds']> };
  shotWidth: number;
  shotHeight: number;
  elements: Map<string, { px: { x: number; y: number }; pt: { x: number; y: number }; role?: string; label?: string }>;
  /** Cua's snapshot id: element N of this snapshot is the token "<snapshotId>:N" */
  snapshotId?: string;
  /** web content in the picture (AXWebArea frames, snapshot pixels) */
  web: Rect[];
  /** a web browser: its page may be missing from the tree (another tab, a truncated walk), so treat it as web */
  browser: boolean;
}
export interface WindowSnapshot { shot: Shot; geometry: WindowGeometry; text: string }

export interface ActOptions {
  /** the user taking over (no bot): whole-screen coordinates are allowed, and they do move the real pointer */
  desktop: boolean;
  /**
   * The action aims at web content (a browser page, an Electron app). Pages only react to real input: a background
   * pixel click there becomes an accessibility press on whatever element sits under the point, which custom buttons
   * (a cart's "+") ignore. So the backend clicks and types for real, then puts the user's pointer back.
   */
  web?: boolean;
  /** where a pointer action lands, in global screen points (from the window's last snapshot) */
  pt?: { x: number; y: number };
  /**
   * The window was brought to the front for the user to watch (on-screen mode): while it is still the frontmost
   * window, keys and typing go to it as real keystrokes (tens of ms) rather than Cua's background route, which
   * waits about a second per call to read back an effect. Keystrokes never move the user's pointer.
   */
  front?: boolean;
  /**
   * Background mode (a bot's action, with the user working meanwhile): input that needs the window in front (a real
   * click or typing on a web page, a modified click, a drag, what the app refused in the background, a step the bot
   * asked to send in front) goes out through this. It waits until the user pauses, then `send` brings the window
   * forward for a moment, and the user's app or window and pointer are put back if they moved (see
   * CuaBackend.userPlace). Absent on screen, where the window is in front already.
   */
  borrow?: Borrow;
  /**
   * The screen is the bots' own (your AppuBot computer): their input goes out for real, in the foreground (real pointer
   * and keystrokes on the display, the window raised), never through the background routes that exist so a person can
   * keep working beside them.
   */
  real?: boolean;
}

/** Sends input that needs the window in front without getting in the user's way (see ActOptions.borrow). */
export type Borrow = <T>(send: () => Promise<T>) => Promise<T>;

/** Where the user was before a borrowed step: put them back (their pointer, the app they were in) if it moved them. */
export interface UserPlace { restore(): Promise<void> }

/** What opening an app gave: its pid and the window to work in (absent when it has none on screen yet). */
export interface Opened { pid: number; windowId?: number }

export interface ComputerBackend {
  readonly name: 'cua-driver' | 'native';
  init(): Promise<void>;
  permissions(): Promise<Perms>;
  requestPermissions(): Promise<void>;
  screenSize(): Promise<ScreenInfo>;
  /** Screenshot whose pixel space is the coordinate space for subsequent actions. */
  screenshot(o: { maxWidth: number; quality: number }): Promise<Shot>;
  act(a: ComputerAction, o?: ActOptions): Promise<{ text?: string; opened?: Opened }>;
  /** App window snapshot for the agent: screenshot + element tokens (replaces that window's previous tokens). */
  windowSnapshot?(o: { pid: number; windowId: number; maxElements: number; maxWidth: number }): Promise<WindowSnapshot>;
  /** Picture of an app window for the live view; leaves the agent's element tokens alone. */
  windowShot?(o: { pid: number; windowId: number; maxWidth: number }): Promise<{ shot: Shot; target: ComputerTarget }>;
  /** Bring an app window to the front (so the user can watch the bot work in it). */
  raise?(pid: number, windowId: number): Promise<void>;
  /** Is this the frontmost window on screen? (cheap: lets `raise`, which is slow, be skipped) */
  isFront?(pid: number, windowId: number): Promise<boolean>;
  /**
   * Can the user see this window at a point (global screen points: the topmost window there), or with no point, is it
   * the frontmost window? Background mode only draws the bot's cursor where its window shows.
   */
  visibleAt?(pid: number, windowId: number, pt?: { x: number; y: number }): Promise<boolean>;
  /** Note where the user is (pointer, app in front) before a borrowed step, to put them back after it. */
  userPlace?(): Promise<UserPlace>;
  /** The topmost window at a global screen point, named (teach mode says where a click landed). */
  windowAtPoint?(pt: { x: number; y: number }): Promise<{ app?: string; title?: string } | undefined>;
  shutdown(): Promise<void>;
}

/** Pointer actions a bot may only aim at an app window (background delivery keeps the user's mouse free). */
const NEEDS_WINDOW = new Set<ComputerAction['type']>(['click', 'double_click', 'right_click', 'drag', 'scroll', 'move']);
/** keyboard input: it goes to the window given, else to the app in front */
const KEYBOARD = new Set<ComputerAction['type']>(['type', 'key', 'hotkey']);
/** clicks: on web content they go out as real clicks (see CuaBackend.realClick) */
const POINTER_TYPES = new Set<ComputerAction['type']>(['click', 'double_click', 'right_click']);
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

const normMod = (m: string): string => {
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
const SETTLE: Partial<Record<ComputerAction['type'], number>> = {
  click: 250, double_click: 250, right_click: 250, drag: 250, scroll: 180, type: 150, key: 180, hotkey: 200, focus_window: 250,
};
/**
 * Between the steps of a batch (ms): long enough for the app to take the input in before the next one, with no
 * picture to wait for. Only the batch's last step gets its full SETTLE before the look at the end.
 */
const STEP_GAP: Partial<Record<ComputerAction['type'], number>> = {
  click: 60, double_click: 60, right_click: 120, drag: 120, scroll: 60, type: 40, key: 40, hotkey: 80, focus_window: 150, open_app: 150,
};

/** An action as the feed may show it: a Vault secret's text never leaves the step that types it. */
const masked = (a: ComputerAction): ComputerAction => (a.secret ? { ...a, text: '••••••' } : a);

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
const AGENT_JPEG = 0.95;
/** JPEG quality of the pictures the bot gets from Cua (lossless PNG there): small text stays sharp */
const AGENT_QUALITY = 0.85;
/** what a device's own `computer.screenshot` call gets back (its live view adapts separately) */
const UI_SHOT = { maxDim: 1600, quality: 0.75 };

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
function staticTextRoles(os: string): Set<string> {
  return new Set(os === 'darwin' ? ['AXStaticText'] : os === 'win32' ? ['Text'] : ['label', 'static']);
}

/** The menu bar's role (its menus, hundreds of items in some apps, crowd the element list). */
const menuBarRole = (os: string): string => (os === 'darwin' ? 'AXMenuBar' : os === 'win32' ? 'MenuBar' : 'menu bar');

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
const clampText = (s: string): string => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\n…(truncated)' : s);

/* =================================================================== Cua backend */

type CuaElement = {
  element_index?: number; element_token?: string; role?: string; label?: string; value?: unknown; parent_index?: number;
  frame?: Rect; screenshot_frame?: Rect; in_web_content?: boolean;
};
interface CuaWindowState {
  app_name?: string; window_title?: string; snapshot_id?: string; tree_markdown?: string;
  window_bounds?: { x: number; y: number; width: number; height: number };
  screenshot_width?: number; screenshot_height?: number;
  elements?: CuaElement[];
}

/**
 * Elements under the app's menu bar (every menu item of every menu: hundreds in a browser). They crowd the list the
 * bot reads; the menu bar's own items ("File", "Edit") stay.
 */
function menuItems(st: CuaWindowState, os: string): Set<number> {
  const inMenus = new Set<number>();
  const hidden = new Set<number>();
  if (os !== 'darwin') {
    // Windows and Linux have no menu-bar-item role of their own: the menu bar's direct children stay
    const bar = menuBarRole(os);
    const bars = new Set<number>();
    for (const e of st.elements ?? []) {
      if (e.element_index === undefined) continue;
      if (e.role === bar) { bars.add(e.element_index); inMenus.add(e.element_index); hidden.add(e.element_index); continue; }
      if (e.parent_index !== undefined && inMenus.has(e.parent_index)) {
        inMenus.add(e.element_index);
        if (!bars.has(e.parent_index)) hidden.add(e.element_index);
      }
    }
    return hidden;
  }
  for (const e of st.elements ?? []) {
    if (e.element_index === undefined) continue;
    if (e.role === 'AXMenuBar' || (e.parent_index !== undefined && inMenus.has(e.parent_index))) {
      inMenus.add(e.element_index);
      if (e.role !== 'AXMenuBarItem') hidden.add(e.element_index);
    }
  }
  return hidden;
}

function toGeometry(o: { pid: number; windowId: number }, st: CuaWindowState, pngBase64: string, os: string): WindowGeometry {
  const size = pngSize(pngBase64);
  const shotWidth = st.screenshot_width ?? size?.width ?? 0;
  const shotHeight = st.screenshot_height ?? size?.height ?? 0;
  const b = st.window_bounds ?? { x: 0, y: 0, width: shotWidth, height: shotHeight };
  const elements: WindowGeometry['elements'] = new Map();
  const web: Rect[] = [];
  // Where each element is in the picture (screenshot_frame → window bounds, else the AX frame). Cua derives both
  // from the app's own accessibility frame, which rendered views (a chess board, canvases, games) can misreport, so
  // bots aim pointer actions by what they see in the image (see ComputerService.atElement).
  const toPt = (px: number, py: number) => ({ x: b.x + (px * b.width) / (shotWidth || 1), y: b.y + (py * b.height) / (shotHeight || 1) });
  for (const e of st.elements ?? []) {
    if (isWebArea(os, e.role, e.in_web_content)) {
      const r = e.screenshot_frame
        ?? (e.frame && { x: ((e.frame.x - b.x) * shotWidth) / (b.width || 1), y: ((e.frame.y - b.y) * shotHeight) / (b.height || 1), w: (e.frame.w * shotWidth) / (b.width || 1), h: (e.frame.h * shotHeight) / (b.height || 1) });
      if (r && r.w > 1 && r.h > 1) web.push(r);
    }
    if (!e.element_token) continue;
    const sf = e.screenshot_frame;
    if (sf) {
      const px = { x: sf.x + sf.w / 2, y: sf.y + sf.h / 2 };
      elements.set(e.element_token, { px, pt: toPt(px.x, px.y), role: e.role, label: e.label });
    } else if (e.frame) {
      const pt = { x: e.frame.x + e.frame.w / 2, y: e.frame.y + e.frame.h / 2 };
      elements.set(e.element_token, { px: { x: ((pt.x - b.x) * shotWidth) / (b.width || 1), y: ((pt.y - b.y) * shotHeight) / (b.height || 1) }, pt, role: e.role, label: e.label });
    }
  }
  return {
    target: { pid: o.pid, windowId: o.windowId, app: st.app_name, title: st.window_title, bounds: { x: b.x, y: b.y, width: b.width, height: b.height } },
    shotWidth, shotHeight, elements, web, snapshotId: st.snapshot_id,
    browser: isBrowserApp(st.app_name, os),
  };
}

/**
 * The window's own text (labels, a calculator's display, a status line) from Cua's tree: the static texts the
 * element list leaves out, so the bot can read results without studying the picture.
 */
export function shownText(tree: string | undefined, os = 'darwin', elements: CuaElement[] = []): string {
  if (os !== 'darwin') return shownTextElsewhere(tree, os, elements);
  if (!tree) return '';
  const out: string[] = [];
  for (const line of tree.split('\n')) {
    if (/AXMenuBar\b/.test(line)) break; // the menus come after the window
    const m = /^\s*- AXStaticText(?: "([^"]*)")?(?: = "([^"]*)")?/.exec(line);
    const t = m && (m[2] || m[1]);
    if (t && t.trim()) out.push(`"${truncate(t.trim(), 120)}"`);
    if (out.length >= 40) break;
  }
  return out.join(' · ');
}

/**
 * The same on Windows and Linux: their static texts (UI Automation "Text", AT-SPI "label"/"static") from the snapshot's
 * elements, else from its tree's rows (`- [N] Text "label" = "value"`, the row number optional), menus left out.
 */
function shownTextElsewhere(tree: string | undefined, os: string, elements: CuaElement[]): string {
  const roles = staticTextRoles(os);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string | undefined) => {
    const s = t?.trim();
    if (!s || seen.has(s) || out.length >= 40) return;
    seen.add(s);
    out.push(`"${truncate(s, 120)}"`);
  };
  if (elements.length) {
    const st = { elements };
    const menus = menuItems(st, os);
    for (const e of elements) {
      if (!roles.has(e.role ?? '') || menus.has(e.element_index ?? -1)) continue;
      add(typeof e.value === 'string' && e.value.trim() ? e.value : e.label);
    }
    if (out.length) return out.join(' · ');
  }
  const bar = menuBarRole(os);
  for (const line of (tree ?? '').split('\n')) {
    const m = /^\s*- (?:\[\d+\] )?(.+?)(?: "([^"]*)")?(?: = "([^"]*)")?(?: \[.*\])?\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === bar) break; // the menus come after the window
    if (roles.has(m[1]!)) add(m[3] || m[2]);
    if (out.length >= 40) break;
  }
  return out.join(' · ');
}

/** Why a window has no picture, on Windows and Linux (with what Cua said). */
function noWindowPicture(os: string, said: string | undefined): string {
  const why = os === 'win32'
    ? 'is the window minimised? Bring it back up first'
    : 'is the window minimised or on another workspace? On Wayland only apps running through XWayland can be seen';
  return `get_window_state returned no screenshot (${why})${said?.trim() ? `: ${truncate(said.trim(), 200)}` : ''}`;
}

/** Does this point of the window picture (pixels) land on web content? With no point: is the window web content? */
export function isWeb(g: WindowGeometry | undefined, px?: { x: number; y: number }): boolean {
  if (!g) return false;
  if (!px) return g.browser || g.web.length > 0;
  if (g.web.some((r) => px.x >= r.x && px.x <= r.x + r.w && px.y >= r.y && px.y <= r.y + r.h)) return true;
  // a browser whose page isn't in the tree: the page is everything under its toolbar
  return g.browser && g.web.length === 0;
}

/** Is this element on the window's picture (not a closed menu's item, which has no place on screen)? */
const inPicture = (g: WindowGeometry, px: { x: number; y: number }) => px.x >= 0 && px.y >= 0 && px.x <= g.shotWidth && px.y <= g.shotHeight;
const norm = (s: string) => s.replace(/[\u200e\u200f]/g, '').trim().toLowerCase();

/**
 * The element a label means in a window snapshot: the exact label (case aside), else the one element whose label
 * contains it. Among several, what is on the picture and pressable (by `os`'s roles) wins. Null when nothing (or too
 * much) matches.
 */
export function findLabel(g: WindowGeometry, label: string, os = 'darwin'): { token: string; px: { x: number; y: number } } | null {
  const want = norm(label);
  if (!want) return null;
  const all = [...g.elements.entries()].filter(([, e]) => e.label && inPicture(g, e.px));
  const rank = (list: typeof all) => list.sort(([, a], [, b]) => Number(isPressable(os, b.role)) - Number(isPressable(os, a.role)))[0];
  const exact = all.filter(([, e]) => norm(e.label!) === want);
  const hit = exact.length ? rank(exact) : (() => { const part = all.filter(([, e]) => norm(e.label!).includes(want)); return part.length ? rank(part) : undefined; })();
  return hit ? { token: hit[0], px: hit[1].px } : null;
}

/** Labels to suggest when one wasn't found. */
function someLabels(g: WindowGeometry, label: string): string {
  const want = norm(label);
  const labels = [...new Set([...g.elements.values()].filter((e) => e.label && inPicture(g, e.px)).map((e) => e.label!))];
  const near = labels.filter((l) => norm(l).includes(want.slice(0, 3)));
  return [...near, ...labels.filter((l) => !near.includes(l))].slice(0, 25).map((l) => `"${truncate(l, 40)}"`).join(', ');
}

interface CuaWindowInfo { pid?: number; window_id?: number; layer?: number; z_index?: number | null; is_on_screen?: boolean; title?: string; bounds?: { x: number; y: number; width: number; height: number } }
interface CuaToolResult { text: string; images: { mimeType: string; dataBase64: string }[]; isError: boolean; structuredJson?: string; errorCode?: string }
interface CuaDriverLike { callTool(name: string, args: string): Promise<CuaToolResult>; shutdown(): Promise<void> }

/** Cua's answer when the target won't take input in the background: the same action goes again with foreground delivery. */
const BACKGROUND_REFUSED = 'background_unavailable';
/** Inside a borrowed step, where the user has already paused: what the app refuses climbs to the foreground at once. */
const HELD: Borrow = (send) => send();

export class CuaBackend implements ComputerBackend {
  readonly name = 'cua-driver' as const;
  private driver: CuaDriverLike | null = null;
  /** the OS Cua drives (Node's `process.platform`; tests pass another) */
  private readonly os: string;
  private dim = 0;
  /** the main display, in points (desktop-scope input is in pixels of the last desktop image, else native pixels) */
  private screen: ScreenInfo | null = null;
  /** size of the last get_desktop_state image (Cua maps desktop-scope coordinates to it) */
  private desktopShot: { width: number; height: number } | null = null;
  /** the on-screen window list, briefly reused (one action can ask twice: is it in front, is it on top at the point) */
  private onScreen: { at: number; windows: Promise<CuaWindowInfo[]> } | null = null;

  constructor(private opts: {
    log: Logger; requestPermissions?: () => unknown; defaultDim: () => number; load?: () => Promise<unknown>;
    /** a quicker way to front a window (the native helper: ~0.1s, where Cua's bring_to_front takes over a second) */
    raise?: (pid: number, windowId: number) => Promise<void>;
    /** a quicker way to launch or activate an app, with URLs to open in it (the native helper: 0.06-0.2s and in front when asked, where Cua's launch_app takes 0.9-1.8s and stays in the background) */
    launch?: (o: { name?: string; bundleId?: string; urls?: string[]; activate: boolean }) => Promise<{ pid: number }>;
    /** the window's newest frame from a persistent capture stream (the native helper: 15-40ms, where Cua's one-shot capture takes ~140ms) */
    streamFrame?: (windowId: number, maxDim: number) => Promise<{ data: string; width: number; height: number }>;
    /** the pid of the app in front, and bringing an app back to the front (the native helper; background mode puts the user's app back with them) */
    frontApp?: () => Promise<number | undefined>;
    activate?: (pid: number) => Promise<void>;
    /** Windows and Linux: put the user's pointer back after a borrowed step (default yes; not on Wayland, where Cua only knows the pointer it moved itself) */
    restorePointer?: boolean;
    /** the OS (default: this one) */
    os?: string;
  }) {
    this.os = opts.os ?? process.platform;
  }

  /** where each window was and how big its picture was at Cua's last look (stream frames reuse it: see windowShot) */
  private lastShot = new Map<string, { target: ComputerTarget; width: number; height: number }>();

  async init(): Promise<void> {
    const mod = (await (this.opts.load ? this.opts.load() : import('@trycua/cua-driver'))) as { CuaDriver: { create(o: { embedded: boolean }): CuaDriverLike } };
    // in-process: without it Cua 0.35+ prefers a CuaDriver.app daemon when one is installed
    this.driver = mod.CuaDriver.create({ embedded: true });
    await this.permissions();
  }

  /** when Cua last got a call (its implicit session ends after five idle minutes) */
  private lastCall = 0;

  /**
   * Windows and Linux: Cua draws a cursor overlay of its own there, beside the one AppuBot draws for the bot. It is
   * hidden on this connection's implicit session (no session named: Cua uses that one), and again after a quiet spell,
   * since a new session shows it again. A refusal only means a second cursor, never a failed action.
   */
  private async hideCuaCursor(): Promise<void> {
    const r = await this.driver!.callTool('set_agent_cursor_enabled', JSON.stringify({ enabled: false })).catch((e: unknown) => ({ isError: true, text: errMsg(e) }) as CuaToolResult);
    if (r.isError) this.opts.log.debug('Cua cursor overlay stays on', r.text);
  }

  private async call(name: string, args: Record<string, unknown> = {}): Promise<CuaToolResult> {
    if (!this.driver) throw new Error('Cua driver not initialised');
    if (this.os !== 'darwin' && Date.now() - this.lastCall > 60_000) await this.hideCuaCursor();
    this.lastCall = Date.now();
    const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
    const r = await this.driver.callTool(name, JSON.stringify(clean));
    if (r.isError) throw Object.assign(new Error(r.text || `${name} failed`), { code: r.errorCode });
    return r;
  }

  private structured<T>(r: CuaToolResult): T | undefined {
    if (!r.structuredJson) return undefined;
    try { return JSON.parse(r.structuredJson) as T; } catch { return undefined; }
  }

  /** Did Cua refuse to deliver this in the background (an error, or a result marked refused)? */
  private refusedInBackground(r: CuaToolResult | unknown): boolean {
    if (r instanceof Error) return (r as Error & { code?: string }).code === BACKGROUND_REFUSED || r.message.includes(BACKGROUND_REFUSED);
    if (!r || typeof r !== 'object') return false;
    const res = r as CuaToolResult;
    if (res.errorCode === BACKGROUND_REFUSED) return true;
    const st = this.structured<{ effect?: string; error?: { code?: string }; code?: string }>(res);
    return st?.error?.code === BACKGROUND_REFUSED || st?.code === BACKGROUND_REFUSED;
  }

  /**
   * Input aimed at a window goes in the background first, and what the target refuses there (`background_unavailable`:
   * no input was sent) goes again with Cua's foreground delivery, which fronts the window, acts and gives the front
   * back: Cua's own ladder. Windows and Linux always climb it. macOS sends as asked on screen (the window is in front
   * already) and climbs it in background mode (`borrow`), once the user pauses.
   */
  private async deliver(name: string, args: Record<string, unknown>, borrow?: Borrow): Promise<CuaToolResult> {
    if ((this.os === 'darwin' && !borrow) || args.delivery_mode !== 'background') return this.call(name, args);
    try {
      const r = await this.call(name, args);
      if (!this.refusedInBackground(r)) return r;
    } catch (e) {
      if (!this.refusedInBackground(e)) throw e;
    }
    this.opts.log.debug(`${name}: refused in the background, sending it in the foreground`);
    this.onScreen = null;
    const again = () => this.call(name, { ...args, delivery_mode: 'foreground' });
    return borrow ? borrow(again) : again();
  }

  /** Input that needs the window in front: in background mode it waits for the user and puts them back (see ActOptions.borrow). */
  private async inFront<T>(o: ActOptions, send: () => Promise<T>): Promise<T> {
    this.onScreen = null;
    try { return await (o.borrow ? o.borrow(send) : send()); }
    finally { this.onScreen = null; }
  }

  async permissions(): Promise<Perms> {
    if (this.os !== 'darwin') return this.reach();
    const r = await this.call('check_permissions');
    const s = this.structured<{ accessibility?: boolean; screen_recording?: boolean }>(r);
    if (!s) throw new Error('check_permissions returned no structured result');
    return { accessibility: !!s.accessibility, screenRecording: !!s.screen_recording };
  }

  /**
   * Windows and Linux have no permissions to grant (Cua's check_permissions there takes no prompt). What can be missing
   * is what Cua reaches apps through: UI Automation and DXGI capture on Windows, the AT-SPI accessibility bus and X11
   * capture on Linux (its health report's `ax_capability` and `screen_capture_capability`), reported in the same two
   * fields. A report that can't be read says nothing is missing: the actions then fail with Cua's own reason.
   */
  private async reach(): Promise<Perms> {
    try {
      const r = this.structured<{ checks?: { name?: string; status?: string }[] }>(await this.call('health_report', { include: ['ax_capability', 'screen_capture_capability'] }));
      const failed = (name: string) => !!r?.checks?.some((c) => c.name === name && c.status === 'fail');
      return { accessibility: !failed('ax_capability'), screenRecording: !failed('screen_capture_capability') };
    } catch (e) {
      this.opts.log.warn('Cua health report failed', errMsg(e));
      return { accessibility: true, screenRecording: true };
    }
  }

  async requestPermissions(): Promise<void> {
    // macOS's grants only: Windows and Linux have nothing to request
    if (this.os === 'darwin') await this.opts.requestPermissions?.();
  }

  async screenSize(): Promise<ScreenInfo> {
    const s = this.structured<{ width: number; height: number; scale_factor?: number }>(await this.call('get_screen_size'));
    this.screen = { width: s?.width ?? 0, height: s?.height ?? 0, scale: s?.scale_factor ?? 1 };
    return this.screen;
  }

  /** Layer-0 windows on screen, front first. Reused for a quarter second. */
  private windowsOnScreen(): Promise<CuaWindowInfo[]> {
    if (this.onScreen && Date.now() - this.onScreen.at < 250) return this.onScreen.windows;
    const windows = this.call('list_windows', { on_screen_only: true })
      .then((r) => (this.structured<{ windows?: CuaWindowInfo[] }>(r)?.windows ?? [])
        .filter((w) => (w.layer ?? 0) === 0 && w.is_on_screen !== false && (w.bounds?.width ?? 0) > 1 && (w.bounds?.height ?? 0) > 1)
        .filter((w) => this.os === 'darwin' || !(w.pid === process.pid && w.title === AGENT_CURSOR_TITLE))
        .sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0)))
      // Windows and Linux report every window on layer 0, the agent cursor's always-on-top overlay among them (left out
      // above); and where they can't tell the stacking order (a null z_index) nothing counts as in front
      .then((ws) => (this.os !== 'darwin' && ws.some((w) => typeof w.z_index !== 'number') ? [] : ws));
    windows.catch(() => { this.onScreen = null; });
    this.onScreen = { at: Date.now(), windows };
    return windows;
  }

  async isFront(pid: number, windowId: number): Promise<boolean> {
    const top = (await this.windowsOnScreen())[0];
    return top?.pid === pid && top.window_id === windowId;
  }

  /** The topmost window at a global screen point. */
  private async windowAt(pt: { x: number; y: number }): Promise<CuaWindowInfo | undefined> {
    return (await this.windowsOnScreen()).find((w) => pt.x >= w.bounds!.x && pt.x < w.bounds!.x + w.bounds!.width && pt.y >= w.bounds!.y && pt.y < w.bounds!.y + w.bounds!.height);
  }

  async visibleAt(pid: number, windowId: number, pt?: { x: number; y: number }): Promise<boolean> {
    if (!pt) return this.isFront(pid, windowId);
    const top = await this.windowAt(pt);
    return top?.pid === pid && top.window_id === windowId;
  }

  async windowAtPoint(pt: { x: number; y: number }): Promise<{ app?: string; title?: string } | undefined> {
    const w = await this.windowAt(pt).catch(() => undefined);
    if (!w) return undefined;
    const named = w as CuaWindowInfo & { app_name?: string; owner_name?: string; bundle_id?: string };
    const app = named.app_name ?? named.owner_name ?? named.bundle_id;
    return { ...(app ? { app } : {}), ...(w.title ? { title: w.title } : {}) };
  }

  /**
   * Where the user is before a borrowed step: the app (macOS) or window (Windows, Linux) in front and their pointer.
   * Putting them back brings their app or window forward again only if another one stayed in front, then moves the
   * pointer back only if the step moved it. Cua's foreground delivery fronts the bot's window for the step and on macOS
   * gives the front back itself (a click can still open something that takes it); on Windows only keys and typing
   * reliably do, and Linux (X11) leaves the bot's window active and the pointer where it clicked, scrolled or dragged.
   */
  async userPlace(): Promise<UserPlace> {
    const none: CuaToolResult = { text: '', images: [], isError: false };
    const pointer = this.os === 'darwin' || this.opts.restorePointer !== false;
    const cursor = async () => (pointer ? this.structured<{ x?: number; y?: number }>(await this.call('get_cursor_position').catch(() => none)) : undefined);
    if (pointer && !this.screen) await this.screenSize().catch(() => undefined);
    const [was, front] = await Promise.all([cursor(), this.front()]);
    return {
      restore: async () => {
        this.onScreen = null;
        if (front) {
          const now = await this.front();
          if (now && (now.pid !== front.pid || (front.windowId !== undefined && now.windowId !== front.windowId))) {
            await this.giveFront(front).catch((e) => this.opts.log.debug('giving the front back failed', errMsg(e)));
          }
        }
        if (was?.x !== undefined && was.y !== undefined) {
          const now = await cursor();
          const back = this.desktopPx({ x: was.x, y: was.y });
          if (back && (now?.x === undefined || now.y === undefined || Math.hypot(now.x - was.x, now.y - was.y) > 1)) {
            await this.call('move_cursor', { ...back, scope: 'desktop' }).catch(() => undefined);
          }
        }
      },
    };
  }

  /**
   * What is in front: macOS's frontmost app (the native helper), else the top of Cua's window list (Windows and Linux
   * stack it by z_index); undefined when that can't be told.
   */
  private async front(): Promise<{ pid: number; windowId?: number } | undefined> {
    if (this.opts.frontApp) {
      const pid = await this.opts.frontApp().catch(() => undefined);
      return pid === undefined ? undefined : { pid };
    }
    if (this.os === 'darwin') return undefined;
    this.onScreen = null;
    const top = (await this.windowsOnScreen().catch(() => []))[0];
    return top?.pid !== undefined && top.window_id !== undefined ? { pid: top.pid, windowId: top.window_id } : undefined;
  }

  /** Bring the user's app (macOS: the native helper) or window (Cua's bring_to_front) back to the front. */
  private async giveFront(f: { pid: number; windowId?: number }): Promise<void> {
    this.onScreen = null;
    if (this.opts.activate) await this.opts.activate(f.pid);
    else if (this.os !== 'darwin') await this.call('bring_to_front', { pid: f.pid, window_id: f.windowId });
    this.onScreen = null;
  }

  /**
   * A global screen point (macOS: points; Windows: physical pixels; X11: root pixels, as Cua's get_cursor_position
   * reports them) in desktop-scope pixels: those of the last desktop picture, which Cua scales back up to its full
   * size (on macOS the display's native pixels). Null off the main display, unless it can go as is.
   */
  private desktopPx(pt: { x: number; y: number }): { x: number; y: number } | null {
    // Windows and Linux with no desktop picture taken: Cua takes the point as is (SetCursorPos, XTEST), any display
    if (this.os !== 'darwin' && !this.desktopShot) return { x: Math.round(pt.x), y: Math.round(pt.y) };
    const s = this.screen;
    if (!s?.width || pt.x < 0 || pt.y < 0 || pt.x >= s.width || pt.y >= s.height) return null;
    const k = this.desktopShot ? this.desktopShot.width / s.width : s.scale;
    return { x: Math.round(pt.x * k), y: Math.round(pt.y * k) };
  }

  /**
   * A real click on web content: pages ignore input posted to a background app, and a background pixel click there
   * turns into an accessibility press of whatever element is under the point (a cart's "+" icon ignores that). When
   * the window is on top at that point the click goes there for real (about a quarter second) and the user's pointer
   * is put back; otherwise Cua's foreground delivery fronts the window first (slower, about a second). In background
   * mode either way waits for the user to pause first.
   */
  private realClick(a: ComputerAction, o: ActOptions, click: { button: string; count: number; modifier?: string[] }): Promise<CuaToolResult> {
    return this.inFront(o, () => this.clickForReal(a, o, click));
  }

  private async clickForReal(a: ComputerAction, o: ActOptions, click: { button: string; count: number; modifier?: string[] }): Promise<CuaToolResult> {
    // Windows and Linux: always Cua's foreground delivery, aimed in the window's own picture (Cua maps it to the
    // screen itself, so no screen coordinates of ours are needed across display scales). The pointer may stay there.
    if (this.os !== 'darwin') {
      this.onScreen = null;
      return this.call('click', { x: a.x, y: a.y, ...click, pid: a.pid, window_id: a.windowId, delivery_mode: 'foreground' });
    }
    if (!this.screen) await this.screenSize().catch(() => undefined);
    const px = o.pt ? this.desktopPx(o.pt) : null;
    const top = px && o.pt ? await this.windowAt(o.pt).catch(() => undefined) : undefined;
    if (!px || top?.pid !== a.pid || top?.window_id !== a.windowId) {
      this.onScreen = null;
      return this.call('click', { x: a.x, y: a.y, ...click, pid: a.pid, window_id: a.windowId, delivery_mode: 'foreground' });
    }
    const was = this.structured<{ x?: number; y?: number }>(await this.call('get_cursor_position').catch(() => ({ text: '', images: [], isError: false })));
    const r = await this.call('click', { ...px, ...click, scope: 'desktop' });
    const back = was?.x !== undefined && was.y !== undefined ? this.desktopPx({ x: was.x, y: was.y }) : null;
    if (back) await this.call('move_cursor', { ...back, scope: 'desktop' }).catch(() => undefined);
    return r;
  }

  /**
   * Typing into web content goes through real keystrokes to the frontmost app when that is the window (background
   * keystrokes to a page drop characters), 5ms apart (Cua's default 30ms makes 100 characters take 4.5s). Anything
   * else goes to Cua's background route: an AX insert, about half a second whatever the length, exactly the text
   * (real keystrokes go through the app's autocorrect). Cua refuses a long route in one go and says how much got
   * through, so the rest is sent again.
   *
   * Background mode: real keystrokes only once the user paused and while the window still is in front (else they
   * would land in the user's app), else the background route, climbing to a borrowed foreground when refused.
   */
  private async typeText(a: ComputerAction, o: ActOptions, where: Record<string, unknown>): Promise<CuaToolResult> {
    // Windows and Linux type for real into any window in front: their background routes (WM_CHAR, XSendEvent) are
    // dropped by many apps, and Windows' Store apps (Notepad, Calculator) take none at all
    const typist = (o.web || this.os !== 'darwin') && !a.element && a.pid !== undefined && a.windowId !== undefined;
    const real = async () => typist && (await this.isFront(a.pid!, a.windowId!).catch(() => false));
    // Cua's type_text has no delay_ms on Linux
    const keystrokes = { scope: 'desktop', ...(this.os === 'linux' ? {} : { delay_ms: 5 }) };
    if (!o.borrow) return this.typeAll(a.text ?? '', (await real()) ? keystrokes : where);
    // the bot asked for the window in front: Cua's foreground delivery
    if (a.front) return this.inFront(o, () => this.typeAll(a.text ?? '', { ...where, delivery_mode: 'foreground' }));
    if (await real()) return this.inFront(o, async () => this.typeAll(a.text ?? '', (await real()) ? keystrokes : where, HELD));
    return this.typeAll(a.text ?? '', where, o.borrow);
  }

  private async typeAll(text: string, at: Record<string, unknown>, borrow?: Borrow): Promise<CuaToolResult> {
    let rest = Array.from(text);
    let r: CuaToolResult | undefined;
    for (let i = 0; i < 6 && rest.length; i++) {
      try {
        r = await this.deliver('type_text', { text: rest.join(''), ...at }, borrow);
        break;
      } catch (e) {
        const m = /delivered (\d+) of (\d+) character/.exec(errMsg(e));
        const sent = m ? Number(m[1]) : 0;
        if (!m || sent <= 0 || Number(m[2]) !== rest.length) throw e;
        rest = rest.slice(sent);
      }
    }
    return r ?? { text: 'Typed.', images: [], isError: false };
  }

  /** Keys for this window may go out as real keystrokes: it was brought forward and is still the frontmost window. */
  private async keysToFront(a: ComputerAction, o: ActOptions): Promise<boolean> {
    return !!o.front && !a.element && a.pid !== undefined && a.windowId !== undefined && (await this.isFront(a.pid, a.windowId).catch(() => false));
  }

  async screenshot(o: { maxWidth: number }): Promise<Shot> {
    // Cua maps desktop-scope coordinates to the LAST get_desktop_state image, so keep one size.
    this.dim = o.maxWidth || this.dim || this.opts.defaultDim();
    const r = await this.call('get_desktop_state', { max_image_dimension: this.dim });
    const img = r.images[0];
    if (!img) throw new Error('get_desktop_state returned no image');
    const st = this.structured<Record<string, unknown>>(r) ?? {};
    const size = pngSize(img.dataBase64) ?? { width: Number(st.screenshot_width ?? st.width ?? 0), height: Number(st.screenshot_height ?? st.height ?? 0) };
    if (size.width > 0) this.desktopShot = size;
    return { data: img.dataBase64, mimeType: img.mimeType || 'image/png', width: size.width, height: size.height };
  }

  /** dimension the agent is currently working in (UI screenshots reuse it so coordinates stay valid) */
  currentDim(): number { return this.dim; }

  async windowSnapshot(o: { pid: number; windowId: number; maxElements: number; maxWidth: number }): Promise<WindowSnapshot> {
    // full_output: Cua 0.35+ returns only the markdown tree otherwise, without the elements we place and aim by
    const r = await this.call('get_window_state', { pid: o.pid, window_id: o.windowId, max_elements: o.maxElements, max_image_dimension: o.maxWidth, full_output: true });
    const st = this.structured<CuaWindowState>(r) ?? {};
    const img = r.images[0];
    if (!img) throw new Error(this.os === 'darwin' ? 'get_window_state returned no screenshot (is the window minimised or on another Space?)' : noWindowPicture(this.os, r.text));
    const geometry = toGeometry(o, st, img.dataBase64, this.os);
    this.lastShot.set(`${o.pid}:${o.windowId}`, { target: geometry.target, width: geometry.shotWidth, height: geometry.shotHeight });
    const snap = st.snapshot_id ? `Elements: [N] is element_token "${st.snapshot_id}:N" (or just element "N"); or aim by label.\n` : '';
    const menus = menuItems(st, this.os);
    const listed = (st.elements ?? []).filter((e) => e.element_token && !menus.has(e.element_index ?? -1)).slice(0, o.maxElements)
      .map((e) => `[${e.element_index}] ${(e.role ?? '').replace(/^AX/, '')}${e.label ? ` "${truncate(e.label, 80)}"` : ''}${e.value ? ` = "${truncate(String(e.value), 60)}"` : ''}`).join('\n');
    const head = `Window "${st.window_title ?? ''}" of ${st.app_name ?? 'app'} (pid ${o.pid}, window_id ${o.windowId}) · image ${geometry.shotWidth}x${geometry.shotHeight}px`;
    const said = this.os === 'darwin' ? shownText(st.tree_markdown) : shownText(st.tree_markdown, this.os, st.elements);
    return {
      shot: { data: img.dataBase64, mimeType: img.mimeType || 'image/png', width: geometry.shotWidth, height: geometry.shotHeight },
      geometry,
      text: clampText(`${head}\n${snap}${listed || st.tree_markdown || r.text || ''}${said ? `\nText shown: ${said}` : ''}`),
    };
  }

  async raise(pid: number, windowId: number): Promise<void> {
    this.onScreen = null;
    if (this.opts.raise) {
      // the helper can report success without the window coming forward: check, else let Cua do it
      try {
        await this.opts.raise(pid, windowId);
        this.onScreen = null;
        if (await this.isFront(pid, windowId)) return;
        await sleep(80);
        this.onScreen = null;
        if (await this.isFront(pid, windowId)) return;
        this.opts.log.debug('quick raise left the window behind, using Cua');
      } catch (e) { this.opts.log.debug('quick raise failed, using Cua', errMsg(e)); }
      finally { this.onScreen = null; }
    }
    await this.call('bring_to_front', { pid, window_id: windowId });
  }

  async windowShot(o: { pid: number; windowId: number; maxWidth: number }): Promise<{ shot: Shot; target: ComputerTarget }> {
    // The stream's frame when the window is as big as at Cua's last look: same picture size, so the bot's pixels
    // still mean the same points. Its position stays Cua's (macOS's window list reports bounds in another frame).
    const last = this.lastShot.get(`${o.pid}:${o.windowId}`);
    if (this.opts.streamFrame && last) {
      try {
        const f = await this.opts.streamFrame(o.windowId, o.maxWidth);
        if (f.width === last.width && f.height === last.height) return { shot: { data: f.data, mimeType: 'image/jpeg', width: f.width, height: f.height }, target: last.target };
      } catch (e) { this.opts.log.debug('stream frame failed, using Cua', errMsg(e)); }
    }
    const r = await this.call('get_window_state', { pid: o.pid, window_id: o.windowId, include_accessibility_tree: false, display_only: true, max_image_dimension: o.maxWidth });
    const st = this.structured<CuaWindowState>(r) ?? {};
    const img = r.images[0];
    if (!img) throw new Error(this.os === 'darwin' ? 'get_window_state returned no screenshot' : noWindowPicture(this.os, r.text));
    const g = toGeometry(o, st, img.dataBase64, this.os);
    this.lastShot.set(`${o.pid}:${o.windowId}`, { target: g.target, width: g.shotWidth, height: g.shotHeight });
    return { shot: { data: img.dataBase64, mimeType: img.mimeType || 'image/png', width: g.shotWidth, height: g.shotHeight }, target: g.target };
  }

  private async pidForApp(name: string): Promise<number | undefined> {
    const s = this.structured<{ apps?: { name?: string; pid?: number; running?: boolean; bundle_id?: string }[] }>(await this.call('list_apps'));
    return findRunningApp(s?.apps ?? [], name, this.os)?.pid || undefined;
  }

  async act(a: ComputerAction, o: ActOptions = { desktop: false }): Promise<{ text?: string; opened?: Opened }> {
    const d = parseDetail(a.detail);
    const out = (r: CuaToolResult) => ({ text: clampText(r.text || r.structuredJson || '') });
    // say plainly how a click went out, so the bot knows what to check
    const clickOut = (r: CuaToolResult) => {
      const st = this.structured<{ route?: string; effect?: string }>(r);
      return st?.route && st.effect !== 'suspected_noop' && st.effect !== 'refused' ? { text: 'Clicked.' } : out(r);
    };
    // An app window (pid + window_id, or an element token): Cua delivers in the background - no pointer move,
    // no focus steal. Whole-screen coordinates (scope desktop) post real mouse events; only the user's own
    // take-over clicks may use them.
    const onWindow = (a.pid !== undefined && a.windowId !== undefined) || !!a.element;
    const where = onWindow
      ? { pid: a.pid, window_id: a.windowId, element_token: a.element }
      : { scope: 'desktop' };
    const pointerWhere = (bg: boolean) => {
      if (!onWindow && !o.desktop) throw new Error(NEEDS_WINDOW_HINT);
      return onWindow ? { ...where, delivery_mode: bg ? 'background' : 'foreground' } : where;
    };
    const xy = a.element ? {} : { x: a.x, y: a.y };
    // web content only reacts to real pointer input (see realClick)
    const real = onWindow && !a.element && o.web && a.x !== undefined && a.y !== undefined;
    // background mode: the bot asked for this step with its window in front (it did nothing in the background)
    const forced = (!!o.borrow && !!a.front && onWindow) || (!!o.real && onWindow);
    // `bg`: background delivery (what the app refuses climbs to the foreground); else foreground, borrowed in background mode
    const send = (bg: boolean, go: () => Promise<CuaToolResult>) => (bg ? go() : this.inFront(o, go));
    const press = async (click: { button: string; count: number; modifier?: string[] }, bg: boolean) => {
      if (real) return clickOut(await this.realClick(a, o, click));
      const args = { ...xy, ...click, ...pointerWhere(bg && !forced) };
      return clickOut(await send(bg && !forced, () => this.deliver('click', args, o.borrow)));
    };
    switch (a.type) {
      case 'click': {
        const mods = Array.isArray(d.modifiers) ? (d.modifiers as string[]).map((m) => cuaModifier(m, this.os)) : [];
        // macOS only sees modifier keys on a fronted window (and Windows' background clicks carry none)
        return press({ button: (d.button as string) ?? 'left', count: Number(d.count ?? 1), modifier: mods.length ? mods : undefined }, !mods.length);
      }
      case 'double_click': return press({ button: 'left', count: 2 }, true);
      case 'right_click': return press({ button: 'right', count: 1 }, true);
      case 'move':
        // hover only exists for the real pointer: bots never move it (the on-screen agent cursor shows intent)
        if (onWindow || !o.desktop) return { text: 'ok' };
        return out(await this.call('move_cursor', { x: a.x, y: a.y, scope: 'desktop' }));
      // macOS has no background drag: Cua briefly fronts the window, moves the real pointer along the path, then
      // brings back the app the user was in. The one action that borrows the user's mouse. Windows and Linux drag the
      // same way: their background drags (posted mouse moves, a virtual pointer) aren't taken by every app.
      case 'drag': {
        const args = { from_x: a.x, from_y: a.y, to_x: a.toX, to_y: a.toY, duration_ms: Number(d.value ?? 500) || 500, ...pointerWhere(false) };
        return out(await this.inFront(o, () => this.call('drag', args)));
      }
      case 'type': return out(await this.typeText(a, o, onWindow ? { ...where, delivery_mode: o.real ? 'foreground' : 'background' } : where));
      case 'key': case 'hotkey': {
        // the window in front: real keystrokes, at once (see ActOptions.front)
        const keysAt = (await this.keysToFront(a, o)) && (!forced || o.real) ? { scope: 'desktop' }
          : forced ? { ...where, delivery_mode: 'foreground' } : onWindow ? { ...where, delivery_mode: 'background' } : where;
        const keys = (a.key ?? '').split('+').map((s) => s.trim()).filter(Boolean).map((k, i, arr) => (i < arr.length - 1 ? cuaModifier(k, this.os) : k));
        return out(await send(!forced, () => (keys.length < 2
          ? this.deliver('press_key', { key: keys[0] ?? a.key ?? '', ...keysAt }, o.borrow)
          : this.deliver('hotkey', { keys, ...keysAt }, o.borrow))));
      }
      // Windows posts scroll messages to the window and Linux synthetic wheel events, which web content may ignore
      // without refusing: pages there scroll with foreground delivery
      case 'scroll': {
        const bg = !forced && (this.os === 'darwin' || !o.web);
        const args = { ...xy, direction: (d.direction as string) ?? 'down', amount: Number(d.amount ?? 5), ...pointerWhere(bg) };
        return out(await send(bg, () => this.deliver('scroll', args, o.borrow)));
      }
      case 'open_app': {
        const bundleId = d.bundle_id as string | undefined;
        // background mode: what the user is in, to give the front back to if the opened app takes it anyway
        const userFront = o.borrow ? await this.front() : undefined;
        let r: CuaToolResult | undefined;
        let quick: number | undefined;
        if (this.opts.launch) {
          try { quick = (await this.opts.launch({ name: bundleId ? undefined : a.app, bundleId, ...(d.url ? { urls: [String(d.url)] } : {}), activate: !!o.front })).pid; }
          catch (e) { this.opts.log.debug('quick launch failed, using Cua', errMsg(e)); }
        }
        r ??= quick ? { text: `Opened ${a.app ?? bundleId ?? 'the app'}.`, images: [], isError: false, structuredJson: JSON.stringify({ pid: quick }) }
          : await this.call('launch_app', launchArgs(this.os, { app: a.app, bundleId, url: d.url ? String(d.url) : undefined }));
        const s = this.structured<{ pid?: number }>(r);
        let pid = s?.pid ?? (a.app ? await this.pidForApp(a.app).catch(() => undefined) : undefined);
        if (!pid) return out(r);
        type Win = { window_id: number; title?: string; is_on_screen?: boolean; layer?: number; bounds?: { width: number; height: number } };
        let wins: Win[] = [];
        // a freshly launched app takes a moment to put its window up
        for (let i = 0; i < 40; i++) {
          wins = this.structured<{ windows?: Win[] }>(await this.call('list_windows', { pid }).catch(() => r!))?.windows ?? [];
          if (wins.some((w) => w.is_on_screen !== false && (w.layer ?? 0) === 0)) break;
          await sleep(50);
        }
        // Windows and Linux: an app already running often hands what it was asked to open to that copy and quits (a
        // browser given a URL), so the launched pid has no window: the running app's own is the one
        if (this.os !== 'darwin' && a.app && !wins.some((w) => w.is_on_screen !== false && (w.layer ?? 0) === 0)) {
          const running = await this.pidForApp(a.app).catch(() => undefined);
          if (running && running !== pid) {
            const theirs = this.structured<{ windows?: Win[] }>(await this.call('list_windows', { pid: running }).catch(() => r!))?.windows ?? [];
            if (theirs.length) { pid = running; wins = theirs; }
          }
        }
        const main = wins.find((w) => w.is_on_screen !== false && (w.layer ?? 0) === 0 && (w.bounds?.width ?? 2) > 1);
        // Cua's launch_app (the fallback) opens the app in the background: bring it forward when the user watches
        if (!quick && o.front && main) await this.raise(pid, main.window_id).catch((e) => this.opts.log.debug('raise after launch failed', errMsg(e)));
        // it opens in the background, but some apps bring themselves forward as they start
        if (userFront && userFront.pid !== pid && (await this.front())?.pid === pid) {
          await this.giveFront(userFront).catch((e) => this.opts.log.debug('giving the front back failed', errMsg(e)));
        }
        this.onScreen = null;
        const list = wins.map((w) => `- window_id ${w.window_id}${w.title ? ` "${truncate(w.title, 80)}"` : ''}${w.is_on_screen === false ? ' (not on screen)' : ''}`).join('\n');
        return {
          text: clampText(`${r.text || 'Opened.'}\npid ${pid}${list ? `\nwindows:\n${list}` : '\n(no windows yet: wait, then computer_list_windows)'}`),
          opened: { pid, windowId: main?.window_id },
        };
      }
      case 'focus_window': {
        let pid = typeof d.pid === 'number' ? d.pid : undefined;
        if (!pid && (a.app || d.app)) pid = await this.pidForApp(String(a.app ?? d.app));
        if (!pid && typeof d.window_id === 'number') {
          const s = this.structured<{ windows?: { window_id: number; pid: number }[] }>(await this.call('list_windows', {}));
          pid = s?.windows?.find((w) => w.window_id === d.window_id)?.pid;
        }
        if (!pid) throw new Error('focus_window: could not find that app/window');
        return out(await this.call('bring_to_front', { pid, window_id: typeof d.window_id === 'number' ? d.window_id : undefined }));
      }
      case 'accessibility': {
        const pid = typeof d.pid === 'number' ? d.pid : undefined;
        const r = pid ? await this.call('get_window_state', { pid, include_accessibility_tree: true }) : await this.call('get_accessibility_tree');
        return out(r);
      }
      case 'clipboard': {
        if (d.op === 'write') return out(await this.call('clipboard_write', { text: a.text ?? '' }));
        const r = await this.call('clipboard_read', { include_text: true });
        const s = this.structured<{ text?: string }>(r);
        return { text: clampText(s?.text ?? r.text) };
      }
      case 'other': {
        if (d.cmd === 'list_apps') return out(await this.call('list_apps'));
        if (d.cmd === 'list_windows') return out(await this.call('list_windows', { pid: d.pid, on_screen_only: true }));
        throw new Error(`Unsupported computer command: ${String(d.cmd)}`);
      }
      default:
        throw new Error(`Unsupported action: ${a.type}`);
    }
  }

  async shutdown(): Promise<void> {
    const d = this.driver;
    this.driver = null;
    await d?.shutdown().catch(() => undefined);
  }
}

/* ============================================================ native helper backend */

export class NativeHelperBackend implements ComputerBackend {
  readonly name = 'native' as const;
  /** image pixels per screen point of the last screenshot */
  private scale: number | null = null;
  private screen: ScreenInfo | null = null;

  constructor(private helper: () => HelperTransport | null, private opts: { defaultMaxWidth: () => number }) {}

  private h(): HelperTransport {
    const t = this.helper();
    if (!t) throw new Error('appubot-helper is not available');
    return t;
  }

  async init(): Promise<void> {
    await this.h().request('ping', {}, 5000);
    await this.permissions();
  }

  async permissions(): Promise<Perms> {
    const r = await this.h().request<{ accessibility: boolean; screen_recording: boolean; input_monitoring?: boolean }>('permissions');
    return { accessibility: !!r.accessibility, screenRecording: !!r.screen_recording, inputMonitoring: r.input_monitoring };
  }

  async requestPermissions(): Promise<void> {
    await this.h().request('request_permissions', { which: ['accessibility', 'screen_recording', 'input_monitoring'] }, 60_000);
  }

  async screenSize(): Promise<ScreenInfo> {
    const r = await this.h().request<{ width: number; height: number; scale: number }>('screen_size');
    this.screen = { width: r.width, height: r.height, scale: r.scale };
    return this.screen;
  }

  async screenshot(o: { maxWidth: number; quality: number }): Promise<Shot> {
    const r = await this.h().request<{ image_base64: string; format: string; width: number; height: number; scale: number }>(
      'screenshot', { max_width: o.maxWidth, format: 'jpeg', quality: o.quality, scale: 1 },
    );
    this.scale = r.scale > 0 ? r.scale : 1;
    return { data: r.image_base64, mimeType: r.format === 'png' ? 'image/png' : 'image/jpeg', width: r.width, height: r.height };
  }

  /** Agent coordinates are in screenshot pixels; the helper wants screen points. */
  private async pt(x: number | undefined, y: number | undefined): Promise<{ x: number; y: number }> {
    if (x === undefined || y === undefined) throw new Error('x and y are required');
    if (this.scale === null) {
      const screen = this.screen ?? (await this.screenSize());
      this.scale = screen.width > 0 ? Math.min(1, this.opts.defaultMaxWidth() / screen.width) : 1;
    }
    const s = this.scale || 1;
    return { x: Math.round((x / s) * 100) / 100, y: Math.round((y / s) * 100) / 100 };
  }

  getScale(): number | null { return this.scale; }

  async act(a: ComputerAction): Promise<{ text?: string }> {
    const h = this.h();
    const d = parseDetail(a.detail);
    const json = (v: unknown) => ({ text: clampText(typeof v === 'string' ? v : JSON.stringify(v)) });
    switch (a.type) {
      case 'click': {
        const p = await this.pt(a.x, a.y);
        const mods = Array.isArray(d.modifiers) ? (d.modifiers as string[]).map(normMod) : [];
        await h.request('click', { ...p, button: (d.button as string) ?? 'left', count: Number(d.count ?? 1), modifiers: mods });
        return {};
      }
      case 'double_click': await h.request('click', { ...(await this.pt(a.x, a.y)), button: 'left', count: 2, modifiers: [] }); return {};
      case 'right_click': await h.request('click', { ...(await this.pt(a.x, a.y)), button: 'right', count: 1, modifiers: [] }); return {};
      case 'move': await h.request('mouse_move', await this.pt(a.x, a.y)); return {};
      case 'drag': {
        const from = await this.pt(a.x, a.y);
        const to = await this.pt(a.toX, a.toY);
        await h.request('drag', { from, to, duration_ms: Number(d.value ?? 400) || 400 });
        return {};
      }
      case 'type': await h.request('type_text', { text: a.text ?? '' }, 120_000); return {};
      case 'key': await h.request('key', { key: a.key ?? '' }); return {};
      case 'hotkey': await h.request('hotkey', { keys: (a.key ?? '').split('+').map((s) => s.trim()).filter(Boolean) }); return {};
      case 'scroll': {
        const p = await this.pt(a.x, a.y);
        const amount = Number(d.amount ?? 5);
        const dir = String(d.direction ?? 'down');
        const dx = dir === 'right' ? amount : dir === 'left' ? -amount : 0;
        const dy = dir === 'down' ? amount : dir === 'up' ? -amount : 0;
        await h.request('scroll', { ...p, dx, dy, lines: true });
        return {};
      }
      case 'open_app': {
        const params: Record<string, unknown> = {};
        if (d.bundle_id) params.bundle_id = d.bundle_id; else params.name = a.app;
        if (d.url) params.url = d.url;
        return json(await h.request('open_app', params, 30_000));
      }
      case 'focus_window': {
        if (d.window_id !== undefined || d.pid !== undefined || d.title !== undefined) {
          const params: Record<string, unknown> = {};
          for (const k of ['window_id', 'pid', 'title']) if (d[k] !== undefined) params[k] = d[k];
          if (a.app && params.pid === undefined && params.window_id === undefined) params.app = a.app;
          return json(await h.request('focus_window', params));
        }
        return json(await h.request('activate_app', { name: a.app ?? d.app }));
      }
      case 'accessibility': {
        const r = await h.request<{ nodes?: unknown; compact?: string }>('ax_tree', {
          ...(typeof d.pid === 'number' ? { pid: d.pid } : {}), max_depth: Number(d.max_depth ?? 10), only_interactive: !!d.only_interactive,
        }, 30_000);
        return json(r.compact ?? r.nodes ?? r);
      }
      case 'clipboard': {
        if (d.op === 'write') { await h.request('clipboard_set', { text: a.text ?? '' }); return { text: 'Clipboard updated.' }; }
        const r = await h.request<{ text?: string }>('clipboard_get');
        return { text: clampText(r.text ?? '') };
      }
      case 'other': {
        if (d.cmd === 'list_apps') return json(await h.request('running_apps'));
        if (d.cmd === 'list_windows') return json(await h.request('list_windows', d.pid !== undefined ? { pid: d.pid } : {}));
        throw new Error(`Unsupported computer command: ${String(d.cmd)}`);
      }
      default:
        throw new Error(`Unsupported action: ${a.type}`);
    }
  }

  async shutdown(): Promise<void> { /* the transport is owned by ComputerService */ }
}

/* ===================================================================== service */

const SETTINGS_URLS = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen_recording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  input_monitoring: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
} as const;

/**
 * Background mode: a step that needs its window in front waits until the user has left the keyboard and mouse alone
 * this long, so it doesn't land in the middle of their typing or pointing.
 */
export const QUIET_MS = 1500;
/**
 * How long one call (a step, or a whole batch) may wait for that in all. Then its step fails rather than interrupt the
 * user, and the bot hears why (the bridge gives a call 60s).
 */
export const PAUSE_WAIT_MS = 25_000;
/** a bot's step waits this long at most for the person in control to give it back (each input of theirs renews it) */
export const CONTROL_WAIT_MS = 30 * 60_000;
/** your AppuBot computer: a bot's step waits this long at most for another bot's turn on the screen */
export const SCREEN_WAIT_MS = 10 * 60_000;
/** your AppuBot computer: a bot that has the screen and made no computer call for this long lets a waiting bot have it */
export const SCREEN_IDLE_MS = 90_000;
const GATE_POLL_MS = 200;
const PAUSE_POLL_MS = 200;
/** input read back within this of a borrowed step's own may be that step's (the readings and our clock differ a little) */
const OWN_INPUT_SLACK_MS = 150;
const USER_BUSY =
  "The user kept using the computer, and this step needs its window in front for a moment, so it waits until they pause: nothing was sent. " +
  'Try again in a little while, or a way that works behind their windows (keys, a menu, a native control rather than a web page).';
/** told to a bot once per turn in background mode (with its first computer call's result) */
const BACKGROUND_NOTE =
  '(Background mode: the user keeps using the computer meanwhile, so the windows you work in stay behind theirs; pictures and input still reach them. ' +
  'A step that needs its window in front, like a click or typing on a web page or a drag, waits until they pause. If a step did nothing, send it again with front: true.)';
const NO_WINDOW_IN_BACKGROUND =
  "The user is working in the app in front (background mode), so typing and keys need the bot's own window: give pid and window_id (computer_open_app or computer_list_windows).";

/** Why no computer-use backend is there: not on this platform, or none could start on this computer. */
function unavailableMsg(): string {
  const machine = machineName(process.platform);
  if (!computerUseSupported(process.platform)) return `Computer use is only available on macOS, Windows and Linux; it is not available on this ${machine}.`;
  return `Computer use is not available on this ${machine} (no backend could start). Open AppuBot → Settings → Computer use.`;
}

export class ComputerService {
  private backend: ComputerBackend | null = null;
  private perms: Perms = { accessibility: false, screenRecording: false };
  private screen: ScreenInfo | undefined;
  private paused = false;
  private busy = false;
  private activeThreadId: string | undefined;
  private mutex = new Mutex();
  private lastFrame: ComputerFrame | null = null;
  /** last agent snapshot per app window ("pid:windowId"): where its elements are */
  private windows = new Map<string, WindowGeometry>();
  private helperT: HelperTransport | null | undefined;
  /** overrides every SETTLE time (tests) */
  settleMs: number | null = null;
  /** the bot's pointer on the computer's screen (see agentCursor.ts) */
  readonly cursor: AgentCursorController;
  private cursorWired = false;
  /** background mode: a step waiting for the user to pause (in the status: the app and the tray say so) */
  private waiting: ComputerStatus['waiting'];
  /** ends that wait early when its turn ends */
  private stopWaiting: { threadId: string; stop: () => void } | undefined;
  /** when a borrowed step last sent input of its own, and the user's own last input as last read (see userQuietMs) */
  private ownInputAt = 0;
  private userInputAt: number | undefined;
  /** the native helper says how long the user has been idle (false: an older helper without `input_idle`) */
  private helperIdle: boolean | undefined;
  /** overrides how long the user has been idle, and PAUSE_WAIT_MS (tests) */
  idleMs: (() => number | undefined) | null = null;
  pauseWaitMs: number | null = null;
  /** threads whose bot heard this turn that background mode is on (see withNote) */
  private told = new Set<string>();
  /** live view's Take control: the one person whose input reaches the screen; the bots wait meanwhile (gate) */
  readonly control = new ScreenControlHolder();
  /** bots' steps waiting for control to come back or for their turn on the screen, by thread */
  private waits = new Map<string, ScreenWait>();
  /** ends those waits when their turn ends */
  private gateStops = new Map<string, () => void>();
  /** your AppuBot computer: the thread whose bot has the screen, and when it last used it (bots take turns: gate) */
  private lease: { threadId: string; lastAt: number } | null = null;
  /** overrides SCREEN_IDLE_MS, CONTROL_WAIT_MS and SCREEN_WAIT_MS (tests) */
  screenIdleMs: number | null = null;
  controlWaitMs: number | null = null;
  screenWaitMs: number | null = null;

  constructor(private ctx: CoreCtx) {
    this.cursor = new AgentCursorController(ctx);
    this.control.onChange((c) => {
      // the person's hand on the screen: the bot's pointer steps aside
      if (c) this.cursor.hide();
      this.emitStatus();
    });
  }

  private get codec(): ImageCodec | undefined { return this.ctx.deps.imageCodec; }
  private get cfg() { return this.ctx.s.settings.get().computer; }
  /**
   * Your AppuBot computer: its screen is the bots' own, so they always work on it for real (on-screen mode, windows
   * raised, real input) and take turns on it; there is no background mode there. A person steps in through live view.
   */
  get onScreenOnly(): boolean { return !!this.ctx.deps.cloud; }
  /** background mode as it applies here (never on your AppuBot computer) */
  private get background(): boolean { return !this.onScreenOnly && this.cfg.background; }

  /** Shared native helper transport (also used by Teach). */
  helper(): HelperTransport | null {
    if (this.helperT === undefined) {
      try {
        this.helperT = this.ctx.deps.helperTransport ? this.ctx.deps.helperTransport() : null;
      } catch (e) {
        this.ctx.log.warn('native helper unavailable', errMsg(e));
        this.helperT = null;
      }
    }
    return this.helperT;
  }

  /** the backend starting (`init`), until it is up or has failed */
  private starting: Promise<void> | null = null;

  /**
   * Starts the backend (Cua, the native helper): at launch without holding up the window (core.start doesn't await
   * it), and again from `requestPermissions` when none started. Calls while one is starting share it.
   */
  init(o: { after?: Promise<unknown> } = {}): Promise<void> {
    // `after` (launch): starting at once (Cua's driver takes ~70ms of this thread) would hold up the window; it counts
    // as starting from now, so a hello meanwhile still waits for it
    this.starting ??= (o.after ? o.after.then(() => undefined, () => undefined) : Promise.resolve())
      .then(() => this.startBackend()).finally(() => { this.starting = null; });
    return this.starting;
  }

  /**
   * While the backend is starting: a promise for its end, at most `maxMs` away (the hello's snapshot and the bots'
   * steps wait on it); null once it is up or failed.
   */
  whenReady(maxMs = 10_000): Promise<void> | null {
    if (!this.starting) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([this.starting.catch(() => undefined), new Promise<void>((r) => { timer = setTimeout(r, maxMs); })]).finally(() => clearTimeout(timer));
  }

  private async startBackend(): Promise<void> {
    // macOS, Windows and Linux (computerUseSupported): elsewhere no backend starts and bots run without computer use.
    // Only macOS has the native helper, which makes focusing, launching and looking at windows quicker: elsewhere Cua
    // does all of it.
    const mac = process.platform === 'darwin';
    const candidates = this.ctx.deps.computerBackends?.() ?? (!computerUseSupported(process.platform) ? [] : !mac ? [
      new CuaBackend({
        log: this.ctx.log,
        defaultDim: () => AGENT_DIM,
        // Wayland: Cua knows only the pointer it moved itself there, so the user's isn't put back after a borrowed step
        restorePointer: process.platform !== 'linux' || !linuxSessionProblem(process.env),
        ...(this.ctx.deps.importCua ? { load: () => this.ctx.deps.importCua!('') } : {}),
      }),
    ] : [
      new CuaBackend({
        log: this.ctx.log,
        requestPermissions: this.ctx.deps.requestCuaPermissions,
        defaultDim: () => AGENT_DIM,
        raise: async (pid, windowId) => {
          const h = this.helper();
          if (!h) throw new Error('no native helper');
          await h.request('focus_window', { pid, window_id: windowId }, 3000);
        },
        launch: async ({ name, bundleId, urls, activate }) => {
          const h = this.helper();
          if (!h) throw new Error('no native helper');
          return h.request<{ pid: number }>('open_app', { ...(bundleId ? { bundle_id: bundleId } : { name }), ...(urls ? { urls } : {}), activate }, 15_000);
        },
        streamFrame: async (windowId, maxDim) => {
          const h = this.helper();
          if (!h) throw new Error('no native helper');
          const r = await h.request<{ image_base64: string; width: number; height: number }>('window_stream_frame', { window_id: windowId, max_dimension: maxDim, quality: AGENT_QUALITY }, 5000);
          return { data: r.image_base64, width: r.width, height: r.height };
        },
        frontApp: async () => {
          const h = this.helper();
          if (!h) throw new Error('no native helper');
          return (await h.request<{ pid?: number }>('frontmost_app', {}, 2000)).pid;
        },
        activate: async (pid) => {
          const h = this.helper();
          if (!h) throw new Error('no native helper');
          await h.request('activate_app', { pid }, 5000);
        },
        ...(this.ctx.deps.importCua ? { load: () => this.ctx.deps.importCua!('') } : {}),
      }),
      new NativeHelperBackend(() => this.helper(), { defaultMaxWidth: () => AGENT_DIM }),
    ]);
    for (const b of candidates) {
      try {
        await b.init();
        this.perms = await b.permissions();
        this.screen = await b.screenSize().catch(() => undefined);
        this.backend = b;
        this.ctx.log.info(`computer use backend: ${b.name}`, this.perms);
        break;
      } catch (e) {
        this.ctx.log.warn(`computer backend ${b.name} unavailable`, errMsg(e));
        await b.shutdown().catch(() => undefined);
      }
    }
    this.emitStatus();
    // the Input Monitoring grant (teach mode) is the native helper's to tell, and starting the helper takes ~0.15s:
    // nothing waits for it (the hello at launch, a bot's first step), its answer follows as a status of its own
    void this.refreshInputMonitoring().then(() => { if (this.perms.inputMonitoring !== undefined) this.emitStatus(); });
    if (!this.cursorWired) {
      this.cursorWired = true;
      // The cursor leaves with the turn that brought it (also when the user stops the run). Once the whole task is
      // done (the turn ended with its final message, not between its steps), the screen stops being recorded: the
      // window streams that made its pictures quick end (macOS's indicator goes off), and AppuBot comes back to the
      // front with the bot's answer, unless the bot worked in the background.
      this.ctx.s.chat.onTurnCompleted((e) => {
        this.cursor.turnEnded(e.threadId);
        this.told.delete(e.threadId);
        if (this.stopWaiting?.threadId === e.threadId) this.stopWaiting.stop();
        this.gateStops.get(e.threadId)?.();
        // its turn on the screen is over: the next bot may have it
        if (this.lease?.threadId === e.threadId) { this.lease = null; this.emitStatus(); }
        if (this.activeThreadId !== e.threadId) return;
        this.activeThreadId = undefined;
        this.emitStatus();
        void this.helper()?.request('window_stream_stop', {}, 2000).catch(() => undefined);
        if (!this.background) this.ctx.deps.showApp?.(e.threadId);
      });
      let background = this.background;
      this.ctx.s.settings.onChange((next) => {
        if (!next.computer.agentCursor) this.cursor.hide();
        if (this.background !== background) { background = this.background; this.emitStatus(); }
      });
    }
  }

  private async refreshInputMonitoring(): Promise<void> {
    if (this.perms.inputMonitoring !== undefined) return;
    const h = this.helper();
    if (!h) return;
    try {
      const r = await h.request<{ input_monitoring?: boolean }>('permissions', {}, 5000);
      if (r.input_monitoring !== undefined) this.perms = { ...this.perms, inputMonitoring: r.input_monitoring };
    } catch { /* ignore */ }
  }

  status(): ComputerStatus {
    return {
      backend: this.backend?.name ?? 'none',
      available: !!this.backend,
      permissions: { ...this.perms },
      screen: this.screen,
      busy: this.busy,
      paused: this.paused,
      activeThreadId: this.activeThreadId,
      liveView: this.cfg.liveView,
      background: this.background,
      ...(this.waiting ? { waiting: this.waiting } : {}),
      takeControl: true,
      ...(this.control.current() ? { control: this.control.current()! } : {}),
      ...(this.waits.size ? { waits: [...this.waits.values()] } : {}),
      ...(this.lease ? { screenThreadId: this.lease.threadId } : {}),
      ...(this.onScreenOnly ? { onScreenOnly: true } : {}),
    };
  }

  /* ---------- live view's Take control ---------- */

  /** A viewer takes control of the screen (or renews it): refused while someone else has it (`in_control`). */
  takeControl(h: ControlHolder): ScreenControl { return this.control.take(h); }
  /** The holder gives control back (Watching again, its view closed); nothing for anyone else. */
  releaseControl(key: string): boolean { return this.control.release(key); }
  /** The holder's input: its idle time starts again. False when the key doesn't hold control. */
  touchControl(key: string): boolean { return this.control.touch(key); }

  /** a thread's bot, by name ("Ada"), for what the bots are told while they wait */
  private botName(threadId: string): string {
    const t = this.ctx.s.threads.get(threadId);
    return (t && this.ctx.s.bots.get(t.botId)?.name) || 'Another bot';
  }

  /**
   * Before a bot's computer call: it waits while a person has control (live view's Take control), and on your
   * AppuBot computer for its turn on the one screen while another bot has it (that bot's turn ends, or it makes no
   * computer call for SCREEN_IDLE_MS). The waits show in the status (`waits`: "Paused while you're in control",
   * "Waiting for the screen") and end with the turn. Returns a line for the bot when it waited.
   */
  private async gate(threadId: string | undefined): Promise<string | undefined> {
    if (!threadId) return undefined;
    const start = Date.now();
    let stopped = false;
    let last: { kind: ScreenWait['for']; who: string } | undefined;
    this.gateStops.set(threadId, () => { stopped = true; });
    try {
      for (;;) {
        const c = this.control.current();
        const idle = this.screenIdleMs ?? SCREEN_IDLE_MS;
        const other = this.onScreenOnly && this.lease && this.lease.threadId !== threadId && Date.now() - this.lease.lastAt < idle ? this.lease : null;
        if (!c && !other) break;
        if (stopped) throw new RpcError('stopped', 'Stopped: the turn ended.');
        const kind: ScreenWait['for'] = c ? 'control' : 'screen';
        const who = c ? c.name : this.botName(other!.threadId);
        const limit = kind === 'control' ? (this.controlWaitMs ?? CONTROL_WAIT_MS) : (this.screenWaitMs ?? SCREEN_WAIT_MS);
        if (Date.now() - start >= limit) {
          throw kind === 'control'
            ? new RpcError('in_control', `${who} still has control of the screen, so computer use waits. Tell the user what is left to do, or try again later.`)
            : new RpcError('screen_busy', `${who} is still using the screen. Try again in a while.`);
        }
        const prev = this.waits.get(threadId);
        if (!prev || prev.for !== kind || prev.holder !== (other?.threadId ?? undefined)) {
          this.waits.set(threadId, { threadId, for: kind, since: prev?.since ?? start, ...(other ? { holder: other.threadId } : {}) });
          this.emitStatus();
        }
        last = { kind, who };
        await sleep(GATE_POLL_MS);
      }
    } finally {
      this.gateStops.delete(threadId);
      if (this.waits.delete(threadId)) this.emitStatus();
    }
    if (this.onScreenOnly) {
      const fresh = this.lease?.threadId !== threadId;
      this.lease = { threadId, lastAt: Date.now() };
      if (fresh) this.emitStatus();
    }
    if (!last) return undefined;
    const secs = Math.round((Date.now() - start) / 1000);
    const took = secs >= 90 ? `${Math.round(secs / 60)} min` : `${secs} s`;
    return last.kind === 'control'
      ? `(Waited ${took} while ${last.who} had control of the screen; it is yours again. Look before acting: they may have changed things.)`
      : `(Waited ${took} for the screen while ${last.who} used it. Look before acting: windows may have moved.)`;
  }

  /** the bot that has the screen used it just now (its idle time on the screen starts again) */
  private usedScreen(threadId: string | undefined): void {
    if (threadId && this.lease?.threadId === threadId) this.lease.lastAt = Date.now();
  }

  /** A line the bot gets with its call's result. */
  private static withLine(text: string | undefined, line: string | undefined): string | undefined {
    if (!line) return text;
    return text ? `${line}\n${text}` : line;
  }

  emitStatus(): void { this.ctx.bus.emit('computer.status', this.status()); }

  async refreshPermissions(): Promise<ComputerStatus> {
    await this.whenReady();
    if (this.backend) {
      try { this.perms = await this.backend.permissions(); }
      catch (e) { this.ctx.log.warn('permission check failed', errMsg(e)); }
    }
    await this.refreshInputMonitoring();
    this.emitStatus();
    return this.status();
  }

  async requestPermissions(): Promise<ComputerStatus> {
    await this.whenReady();
    try {
      // macOS's grants (Windows and Linux have none to ask for: CuaBackend's own check says what is missing there)
      if (process.platform === 'darwin' && this.backend?.name === 'cua-driver' && this.ctx.deps.requestCuaPermissions) await this.ctx.deps.requestCuaPermissions();
      else if (this.backend) await this.backend.requestPermissions();
    } catch (e) { this.ctx.log.warn('requesting permissions failed', errMsg(e)); }
    if (!this.backend) await this.init();
    return this.refreshPermissions();
  }

  async openSettings(pane: keyof typeof SETTINGS_URLS): Promise<{ ok: true }> {
    if (!computerUseSupported(process.platform)) throw new RpcError('unavailable', unavailableMsg());
    // System Settings' privacy panes: Windows and Linux ask for no permissions
    if (process.platform !== 'darwin') throw new RpcError('unsupported', `There are no permissions to grant on this ${machineName(process.platform)}.`);
    await this.ctx.deps.openExternal(SETTINGS_URLS[pane]);
    return { ok: true };
  }

  pause(): ComputerStatus { this.paused = true; this.cursor.hide(); this.emitStatus(); return this.status(); }
  resume(): ComputerStatus { this.paused = false; this.emitStatus(); return this.status(); }
  isPaused(): boolean { return this.paused; }

  setLiveView(enabled: boolean): ComputerStatus {
    this.ctx.s.settings.update({ computer: { ...this.cfg, liveView: enabled } });
    this.emitStatus();
    return this.status();
  }

  getLastFrame(): ComputerFrame | null { return this.lastFrame; }

  private setBusy(busy: boolean, threadId?: string): void {
    this.busy = busy;
    if (busy) this.activeThreadId = threadId;
    this.emitStatus();
  }

  private async capture(maxWidth: number | undefined, threadId: string | undefined, action: ComputerAction | undefined): Promise<ComputerFrame> {
    const b = this.backend!;
    let width = maxWidth ?? AGENT_DIM;
    // Cua: keep the agent's coordinate space stable - UI screenshots reuse the last agent size.
    if (!action && b instanceof CuaBackend && b.currentDim()) width = b.currentDim();
    const shot = await b.screenshot({ maxWidth: width, quality: AGENT_JPEG });
    return this.toFrame(shot, threadId, action, undefined);
  }

  /**
   * On-screen mode (default): bring the bot's window to the front before it acts, so the user watches the app
   * react. Input still goes straight to the app (their pointer stays put, except for a click on a web page). Background
   * mode skips this: the window stays where it is and only a step that needs it in front borrows the screen (borrowScreen).
   */
  private async raiseFor(action: ComputerAction): Promise<void> {
    if (this.background || action.pid === undefined || action.windowId === undefined || !this.backend?.raise) return;
    try {
      // raising takes Cua about a second even for the window already in front: ask first (a few ms)
      if (this.backend.isFront && (await this.backend.isFront(action.pid, action.windowId).catch(() => false))) return;
      await this.backend.raise(action.pid, action.windowId);
      // give the raised window a moment to come forward before acting / capturing it
      await sleep(120);
    } catch (e) {
      this.ctx.log.debug('raise window failed', errMsg(e));
    }
  }

  /**
   * Background mode: a step that needs its window in front (see ActOptions.borrow). It waits until the user pauses,
   * notes where they are, sends the input (the window comes forward for a moment), then puts their app or window and
   * pointer back.
   * `call` is the call's waiting budget, shared by a batch's steps.
   */
  private async borrowScreen<T>(threadId: string, app: string | undefined, send: () => Promise<T>, call: { waited: number }): Promise<T> {
    await this.untilUserPauses(threadId, app, call);
    const place = await this.backend?.userPlace?.().catch((e) => { this.ctx.log.debug('noting where the user is failed', errMsg(e)); return undefined; });
    try {
      return await send();
    } finally {
      this.ownInputAt = Date.now();
      await place?.restore().catch((e) => this.ctx.log.debug('putting the user back failed', errMsg(e)));
      this.ownInputAt = Date.now();
    }
  }

  /** Wait until the user has left the keyboard and mouse alone for QUIET_MS, within the call's budget (else USER_BUSY). */
  private async untilUserPauses(threadId: string, app: string | undefined, call: { waited: number }): Promise<void> {
    let quiet = await this.userQuietMs();
    if (quiet === undefined || quiet >= QUIET_MS) return;
    const start = Date.now();
    let stopped = false;
    this.stopWaiting = { threadId, stop: () => { stopped = true; } };
    this.waiting = { threadId, app, since: start };
    this.emitStatus();
    try {
      while (quiet !== undefined && quiet < QUIET_MS) {
        if (this.paused) throw new RpcError('paused', 'Computer use is paused by the user');
        if (stopped) throw new Error('Stopped: the turn ended.');
        if (call.waited + (Date.now() - start) >= (this.pauseWaitMs ?? PAUSE_WAIT_MS)) throw new Error(USER_BUSY);
        await sleep(Math.min(PAUSE_POLL_MS, Math.max(20, QUIET_MS - quiet)));
        quiet = await this.userQuietMs();
      }
    } finally {
      call.waited += Date.now() - start;
      this.stopWaiting = undefined;
      this.waiting = undefined;
      this.emitStatus();
    }
  }

  /**
   * How long the user has left the keyboard and mouse alone (ms), or undefined when this computer can't tell (then
   * nothing waits). The system counts a borrowed step's own input as input too, so input that came no later than our
   * own (give or take the reading's resolution) may be ours: the user's last input stays the one seen before it.
   */
  private async userQuietMs(): Promise<number | undefined> {
    const idle = await this.systemIdle();
    if (!idle) return undefined;
    const now = Date.now();
    const last = now - idle.ms;
    if (last <= this.ownInputAt + idle.resolution + OWN_INPUT_SLACK_MS && this.userInputAt !== undefined) return now - this.userInputAt;
    this.userInputAt = last;
    return idle.ms;
  }

  /** Time since the last keyboard or mouse input: the native helper's (macOS, exact), else the system's (whole seconds). */
  private async systemIdle(): Promise<{ ms: number; resolution: number } | undefined> {
    if (this.idleMs) {
      const ms = this.idleMs();
      return ms === undefined ? undefined : { ms, resolution: 0 };
    }
    const h = process.platform === 'darwin' && this.helperIdle !== false ? this.helper() : null;
    if (h) {
      try {
        const r = await h.request<{ seconds?: number }>('input_idle', {}, 1000);
        if (typeof r.seconds === 'number' && Number.isFinite(r.seconds)) { this.helperIdle = true; return { ms: Math.max(0, r.seconds * 1000), resolution: 0 }; }
      } catch (e) {
        if ((e as { code?: string }).code === 'unknown_command') this.helperIdle = false;
        else this.ctx.log.debug('input idle time failed', errMsg(e));
      }
    }
    const s = this.ctx.deps.systemIdleMs?.();
    return s === undefined ? undefined : { ms: s, resolution: 1000 };
  }

  /** Live-view frame of an app window after the agent acted on it (does not disturb its element tokens). */
  private async captureWindow(pid: number, windowId: number, threadId: string | undefined, action: ComputerAction | undefined): Promise<ComputerFrame> {
    const b = this.backend!;
    if (!b.windowShot) return this.capture(undefined, threadId, action);
    const { shot, target } = await b.windowShot({ pid, windowId, maxWidth: AGENT_DIM });
    // the window may have moved since the snapshot: aim (and draw the cursor) where it is now
    const g = this.windows.get(`${pid}:${windowId}`);
    if (g && target.bounds && shot.width === g.shotWidth && shot.height === g.shotHeight) this.moveGeometry(g, target.bounds);
    return this.toFrame(shot, threadId, action, target);
  }

  private moveGeometry(g: WindowGeometry, bounds: NonNullable<ComputerTarget['bounds']>): void {
    const old = g.target.bounds;
    if (old.x === bounds.x && old.y === bounds.y && old.width === bounds.width && old.height === bounds.height) return;
    g.target = { ...g.target, bounds };
    for (const el of g.elements.values()) el.pt = { x: bounds.x + (el.px.x * bounds.width) / (g.shotWidth || 1), y: bounds.y + (el.px.y * bounds.height) / (g.shotHeight || 1) };
  }

  /**
   * The frame as the bot gets it: the backend's picture at its own size (so pixels stay the coordinates), as a
   * high-quality JPEG. Cua's PNGs run to 1-2 MB for a big window; the agent sends every picture of the turn again with
   * each request, so a lossless one makes every later step slower. Watchers get per-device encodes.
   */
  private toFrame(shot: Shot, threadId: string | undefined, action: ComputerAction | undefined, target: ComputerTarget | undefined): ComputerFrame {
    shot = this.forAgent(shot);
    const frame: ComputerFrame = { id: newId('frm'), threadId, mimeType: shot.mimeType, data: shot.data, width: shot.width, height: shot.height, ts: Date.now(), action, ...(target ? { target } : {}) };
    this.lastFrame = frame;
    if (this.cfg.liveView) this.ctx.bus.emit('computer.frame', frame);
    return frame;
  }

  private forAgent(shot: Shot): Shot {
    if (shot.mimeType !== 'image/png' || !this.codec) return shot;
    try {
      const jpg = this.codec.encode(shot.data, { maxDim: Math.max(shot.width, shot.height), quality: AGENT_QUALITY });
      // never a different size: the bot aims at pixels of this picture
      return jpg && jpg.width === shot.width && jpg.height === shot.height && jpg.data.length < shot.data.length ? { ...shot, ...jpg } : shot;
    } catch (e) {
      this.ctx.log.debug('agent picture encode failed', errMsg(e));
      return shot;
    }
  }

  /**
   * Where an action lands: in screen points (for the on-screen agent cursor) and normalised 0..1 in the image the
   * live view shows (the window's picture, or the whole screen).
   */
  private locate(a: ComputerAction): { global?: { x: number; y: number }; norm?: { x: number; y: number }; endGlobal?: { x: number; y: number } } {
    const key = a.pid !== undefined && a.windowId !== undefined ? `${a.pid}:${a.windowId}` : undefined;
    const g = key ? this.windows.get(key) : undefined;
    if (g) {
      // Everything comes from the snapshot the bot is acting on: its window bounds and its image. (Re-anchoring to
      // a fresh `list_windows` reading put the pointer off: that call reports bounds in a different frame.)
      const { bounds } = g.target;
      const toPt = (px: number, py: number) => ({ x: bounds.x + (px * bounds.width) / (g.shotWidth || 1), y: bounds.y + (py * bounds.height) / (g.shotHeight || 1) });
      const el = a.element ? g.elements.get(a.element) : undefined;
      const px = el?.px ?? (a.x !== undefined && a.y !== undefined ? { x: a.x, y: a.y } : undefined);
      if (!px) return {};
      return {
        global: el?.pt ?? toPt(px.x, px.y),
        norm: { x: px.x / (g.shotWidth || 1), y: px.y / (g.shotHeight || 1) },
        endGlobal: a.toX !== undefined && a.toY !== undefined ? toPt(a.toX, a.toY) : undefined,
      };
    }
    // whole-screen coordinates: pixels of the last desktop screenshot of the primary display (origin 0,0)
    const f = this.lastFrame && !this.lastFrame.target ? this.lastFrame : null;
    if (!f || a.x === undefined || a.y === undefined || !this.screen?.width) return {};
    const toPt = (px: number, py: number) => ({ x: (px * this.screen!.width) / f.width, y: (py * this.screen!.height) / f.height });
    return {
      global: toPt(a.x, a.y),
      norm: { x: a.x / f.width, y: a.y / f.height },
      endGlobal: a.toX !== undefined && a.toY !== undefined ? toPt(a.toX, a.toY) : undefined,
    };
  }

  /**
   * A bot's pointer input lands on one point of the window picture, the same point its cursor glides to, so the user
   * always sees where it clicks. An element token is turned into that point: pressing the element instead would land
   * wherever the app says it is, which can be far from where it is drawn (Chess reports its squares upside down).
   */
  private atElement(a: ComputerAction, key: string | undefined): ComputerAction {
    const el = key ? this.windows.get(key)?.elements.get(a.element!) : undefined;
    if (!el) throw new Error('That element_token is not in the latest computer_window snapshot of this window: call computer_window again, then aim with x/y pixels of its image.');
    return { ...a, element: undefined, x: Math.round(el.px.x), y: Math.round(el.px.y) };
  }

  private ensureUsable(): ComputerBackend {
    if (!this.cfg.enabled) throw new RpcError('disabled', 'Computer use is turned off in AppuBot settings');
    if (this.paused) throw new RpcError('paused', 'Computer use is paused by the user');
    if (!this.backend) throw new RpcError('unavailable', unavailableMsg());
    return this.backend;
  }

  /** A device's own screenshot (`computer.screenshot`): the screen, re-encoded smaller for the trip (the bot's go through act). */
  async screenshot(maxWidth?: number, quality?: number): Promise<ComputerFrame> {
    await this.whenReady();
    if (!this.backend) throw new RpcError('unavailable', unavailableMsg());
    const frame = await this.mutex.run(() => this.capture(undefined, undefined, undefined)).catch((e) => {
      if (e instanceof RpcError) throw e;
      throw new RpcError('screenshot_failed', this.screenshotHint(errMsg(e)));
    });
    const small = this.codec?.encode(frame.data, { maxDim: maxWidth ?? UI_SHOT.maxDim, quality: quality ?? UI_SHOT.quality });
    return small ? { ...frame, ...small } : frame;
  }

  private screenshotHint(msg: string): string {
    if (this.perms.screenRecording) return msg;
    if (process.platform === 'win32') return `${msg} - AppuBot can't capture the screen on this PC right now (Cua's screen capture check failed).`;
    if (process.platform === 'linux') return `${msg} - AppuBot can't capture the screen here: it needs an X11 session (on Wayland, only apps running through XWayland).`;
    return `${msg} - Screen Recording permission is not granted to AppuBot (System Settings → Privacy & Security → Screen Recording).`;
  }

  async act(action: ComputerAction, threadId?: string): Promise<{ ok: boolean; frame?: ComputerFrame; text?: string }> {
    await this.whenReady();
    this.ensureUsable();
    const waited = await this.gate(threadId);
    return this.mutex.run(async () => {
      this.setBusy(true, threadId);
      try {
        const { ok, frame, text } = await this.step(action, threadId, true, { waited: 0 });
        return { ok, frame, text: ComputerService.withLine(this.withNote(text, threadId), waited) };
      } finally {
        this.usedScreen(threadId);
        this.setBusy(false);
      }
    });
  }

  /**
   * The user's own hand on this computer where no native helper posts it (live view's take-over on the AppuBot Cloud
   * computer, teach mode there): whole-screen coordinates through the backend's desktop scope, under the same mutex as
   * the bots' steps, allowed while the bots are paused (that is what the pause is for) and whatever the setting says
   * about bots using the computer. No action event, no picture, no agent cursor: it is the user, not a bot.
   */
  async userAct(action: ComputerAction): Promise<{ text?: string }> {
    await this.whenReady();
    const backend = this.backend;
    if (!backend) throw new RpcError('unavailable', unavailableMsg());
    return this.mutex.run(() => backend.act(action, { desktop: true }));
  }

  /** The window under a global screen point, named (teach mode's "in Chromium (“Gmail”)"); nothing where it can't tell. */
  async windowAtPoint(pt: { x: number; y: number }): Promise<{ app?: string; title?: string } | undefined> {
    await this.whenReady();
    return this.backend?.windowAtPoint?.(pt).catch(() => undefined);
  }

  /** "Safari (“Sign in · GitHub”)" for a window AppuBot has looked at, else undefined. */
  windowName(pid: number, windowId: number): string | undefined {
    const t = this.windows.get(`${pid}:${windowId}`)?.target;
    if (!t?.app) return undefined;
    return t.title ? `${t.app} (“${t.title}”)` : t.app;
  }

  /**
   * Types a Vault item into a window for a bot (`agent.vault.fill`): a typing step with no look afterwards, its text
   * masked wherever the step is reported, and a failure's message kept free of it.
   */
  async typeSecret(action: ComputerAction, threadId: string): Promise<{ ok: boolean; text?: string }> {
    await this.whenReady();
    this.ensureUsable();
    await this.gate(threadId);
    return this.mutex.run(async () => {
      this.setBusy(true, threadId);
      try {
        const r = await this.step({ ...action, type: 'type', secret: true }, threadId, false, { waited: 0 });
        const secret = action.text ?? '';
        return { ok: r.ok, text: r.ok ? undefined : (secret ? (r.text ?? '').split(secret).join('••••••') : r.text) };
      } finally {
        this.usedScreen(threadId);
        this.setBusy(false);
      }
    });
  }

  /**
   * Several actions back to back in one call (`computer.batch`): one agent turn instead of one per action. Steps
   * without a window use the one the previous step worked in (or the app it opened); none gets a picture of its own,
   * the first failure (or a pause) stops the rest, and one look at the window comes back at the end. The computer
   * stays this bot's for the whole batch, so another bot's actions can't land in between.
   */
  async batch(steps: ComputerAction[], look: 'window' | 'picture' | 'none', threadId?: string): Promise<{ ok: boolean; done: number; frame?: ComputerFrame; text?: string }> {
    await this.whenReady();
    this.ensureUsable();
    const waited = await this.gate(threadId);
    return this.mutex.run(async () => {
      this.setBusy(true, threadId);
      const log: string[] = [];
      let done = 0;
      let ok = true;
      let at: { pid: number; windowId: number } | undefined;
      let last: ComputerAction | undefined;
      // background mode: the batch's steps share one budget for waiting until the user pauses
      const call = { waited: 0 };
      try {
        for (const [i, step] of steps.entries()) {
          if (this.paused) { ok = false; log.push(`${i + 1}. Stopped: the user paused computer use.`); break; }
          // a person took control mid-batch: their hand is on the screen now, the rest waits for the next call
          const took = threadId ? this.control.current() : null;
          if (took) { ok = false; log.push(`${i + 1}. Stopped: ${took.name} took control of the screen. Your next computer call waits until they give it back.`); break; }
          const a: ComputerAction = { ...step };
          if (at && a.pid === undefined && a.windowId === undefined && a.type !== 'open_app' && a.type !== 'screenshot' && a.type !== 'clipboard' && a.type !== 'other') {
            a.pid = at.pid;
            a.windowId = at.windowId;
          }
          const r = await this.step(a, threadId, false, call);
          last = r.ev;
          if (!r.ok) { ok = false; log.push(`${i + 1}. ${summarizeAction(r.ev)}: FAILED: ${r.text ?? 'failed'}`); break; }
          done++;
          if (r.opened?.windowId !== undefined) at = { pid: r.opened.pid, windowId: r.opened.windowId };
          else if (a.pid !== undefined && a.windowId !== undefined) at = { pid: a.pid, windowId: a.windowId };
          const said = r.opened ? `pid ${r.opened.pid}${r.opened.windowId !== undefined ? `, window_id ${r.opened.windowId}` : ' (no window on screen yet)'}` : r.text && !/^(Clicked\.|ok|Typed\.?)$/i.test(r.text.trim()) ? truncate(r.text.trim(), 300) : '';
          log.push(`${i + 1}. ${summarizeAction(r.ev)}${step.label ? ` on "${step.label}"` : ''}${said ? `: ${said}` : ''}`);
        }
        let frame: ComputerFrame | undefined;
        let text: string | undefined;
        if (look !== 'none' && this.backend) {
          const settle = last ? SETTLE[last.type] : undefined;
          if (settle !== undefined) await sleep(this.settleMs ?? settle);
          try {
            if (at && look === 'window' && this.backend.windowSnapshot) {
              const snap = await this.snapshot(at.pid, at.windowId);
              frame = this.toFrame(snap.shot, threadId, { type: 'window', pid: at.pid, windowId: at.windowId, app: snap.geometry.target.app }, snap.geometry.target);
              text = snap.text;
            } else {
              frame = at ? await this.captureWindow(at.pid, at.windowId, threadId, last) : await this.capture(undefined, threadId, last);
            }
          } catch (e) {
            log.push(`(could not look at the result: ${this.screenshotHint(errMsg(e))})`);
          }
        }
        const head = ok ? `Did all ${done} steps.` : `Did ${done} of ${steps.length} steps; the rest were skipped.`;
        return { ok, done, frame, text: ComputerService.withLine(this.withNote([head, ...log, ...(text ? ['', text] : [])].join('\n'), threadId), waited) };
      } finally {
        this.usedScreen(threadId);
        this.setBusy(false);
      }
    });
  }

  /** Background mode, once per turn: the bot hears that its windows stay behind the user's, and how to ask for the front. */
  private withNote(text: string | undefined, threadId: string | undefined): string | undefined {
    if (!threadId || !this.background || this.told.has(threadId)) return text;
    this.told.add(threadId);
    return text ? `${text}\n\n${BACKGROUND_NOTE}` : BACKGROUND_NOTE;
  }

  /** A fresh snapshot of a window for the agent: its picture, and its elements become the ones tokens resolve in. */
  private async snapshot(pid: number, windowId: number, maxElements = 300): Promise<WindowSnapshot> {
    const snap = await this.backend!.windowSnapshot!({ pid, windowId, maxElements, maxWidth: AGENT_DIM });
    this.windows.set(`${pid}:${windowId}`, snap.geometry);
    return snap;
  }

  /**
   * An element given by its accessibility label, or by its number in the window's snapshot, as a token of that
   * snapshot. A label comes from the latest snapshot, or a fresh one when it isn't there (none yet, or the window has
   * changed since).
   */
  private async resolveElement(a: ComputerAction, key: string | undefined): Promise<ComputerAction> {
    if (a.pid === undefined || a.windowId === undefined || !key) throw new Error('Aiming by label or element number needs the window: give pid and window_id.');
    if (a.label === undefined) {
      const g = this.windows.get(key) ?? (await this.snapshot(a.pid, a.windowId)).geometry;
      const token = `${g.snapshotId ?? ''}:${a.element}`;
      if (!g.elements.has(token)) throw new Error(`There is no element [${a.element}] in the latest computer_window snapshot of this window.`);
      return { ...a, element: token };
    }
    let g = this.windows.get(key);
    let hit = g ? findLabel(g, a.label, process.platform) : null;
    if (!hit && this.backend?.windowSnapshot) {
      g = (await this.snapshot(a.pid, a.windowId)).geometry;
      hit = findLabel(g, a.label, process.platform);
    }
    if (!hit || !g) throw new Error(`Nothing labelled "${a.label}" in this window.${g ? ` Labels there: ${someLabels(g, a.label)}` : ''}`);
    return { ...a, label: undefined, element: hit.token };
  }

  /**
   * One action, with the computer already this caller's. `look`: wait for the app to draw and return a picture
   * after it (a batch only looks at the end). `call`: the call's budget for waiting until the user pauses (background
   * mode). Never throws: a failure comes back as `ok: false`.
   */
  private async step(action: ComputerAction, threadId: string | undefined, look: boolean, call: { waited: number }): Promise<{ ok: boolean; frame?: ComputerFrame; text?: string; ev: ComputerAction; opened?: Opened }> {
    const d = parseDetail(action.detail);
    const key = action.pid !== undefined && action.windowId !== undefined ? `${action.pid}:${action.windowId}` : undefined;
    let ev: ComputerAction = action;
    let point: { x: number; y: number } | undefined;
    let opened: Opened | undefined;
    try {
      const backend = this.ensureUsable();
      let text: string | undefined;
      let frame: ComputerFrame | undefined;
      if (action.type === 'screenshot') {
        const mw = Number(d.value ?? 0);
        this.cursor.look(action, threadId);
        frame = await this.capture(mw >= 320 ? mw : undefined, threadId, action);
      } else if (action.type === 'window') {
        if (action.pid === undefined || action.windowId === undefined) throw new Error('computer_window needs pid and window_id (see computer_list_windows)');
        if (!backend.windowSnapshot) throw new Error(`This ${machineName(process.platform)}'s computer-use backend cannot look at single windows; use computer_screenshot.`);
        if (threadId) await this.raiseFor(action);
        this.cursor.look(action, threadId);
        const snap = await this.snapshot(action.pid, action.windowId, Math.min(1500, Math.max(20, Number(d.max_elements ?? 300) || 300)));
        ev = { ...action, app: snap.geometry.target.app };
        frame = this.toFrame(snap.shot, threadId, ev, snap.geometry.target);
        text = snap.text;
      } else if (action.type === 'wait') {
        await sleep(Math.min(15_000, Math.max(0, Number(d.value ?? 1000) || 1000)));
        if (look) frame = key ? await this.captureWindow(action.pid!, action.windowId!, threadId, action) : await this.capture(undefined, threadId, action);
      } else {
        // background mode: the user keeps working meanwhile, so the bot's window stays where it is (see borrowScreen)
        const bg = !!threadId && this.background;
        if (action.label !== undefined || (action.element !== undefined && /^\d+$/.test(action.element))) ev = action = await this.resolveElement(action, key);
        // bots act on app windows only; whole-screen pointer events would move the user's own mouse
        if (threadId && NEEDS_WINDOW.has(action.type) && !key && !action.element) throw new Error(NEEDS_WINDOW_HINT);
        // typing and keys with no window go to the app in front, which is the user's own in background mode
        if (bg && KEYBOARD.has(action.type) && !key && !action.element) throw new Error(NO_WINDOW_IN_BACKGROUND);
        if (threadId && NEEDS_WINDOW.has(action.type) && action.element) ev = action = this.atElement(action, key);
        const g = key ? this.windows.get(key) : undefined;
        if (threadId && key && !g && backend.windowSnapshot && NEEDS_WINDOW.has(action.type) && action.type !== 'move') throw new Error('Call computer_window for this window first, then aim with x/y pixels of its image (or by label).');
        const loc = this.locate(action);
        point = loc.norm;
        if (g?.target.app) ev = { ...action, app: g.target.app };
        // bring the window forward while the cursor glides to the point (both before the input goes out)
        // (in a batch the short hop runs alongside the input rather than before it). In background mode the cursor is
        // only drawn where the user can see the bot's window, never over what they are doing.
        const shown = !bg || (key !== undefined && (await backend.visibleAt?.(action.pid!, action.windowId!, loc.global).catch(() => false)) === true);
        const glide = shown ? this.cursor.before(action, threadId, loc.global ?? null, !look) : this.cursor.away(threadId);
        await Promise.all([threadId ? this.raiseFor(action) : undefined, look ? glide : undefined]);
        if (shown && action.type === 'drag' && loc.endGlobal) this.cursor.follow(loc.endGlobal, Number(d.value ?? 500) || 500);
        const px = action.x !== undefined && action.y !== undefined ? { x: action.x, y: action.y } : undefined;
        const web = !!threadId && isWeb(g, POINTER_TYPES.has(action.type) ? px : undefined);
        // the cursor hears how it went either way, so typing never outlives a failed action
        let acted = false;
        try {
          const borrow: Borrow | undefined = bg ? <T>(send: () => Promise<T>) => this.borrowScreen(threadId!, g?.target.app ?? action.app, send, call) : undefined;
          const r = await backend.act(action, { desktop: !threadId, web, pt: loc.global, front: !!threadId && !bg, ...(borrow ? { borrow } : {}), ...(threadId && this.onScreenOnly ? { real: true } : {}) });
          text = r.text || undefined;
          opened = r.opened;
          acted = true;
        } finally { this.cursor.after(action, threadId, acted); }
        if (opened?.windowId !== undefined) {
          // the app's window, ready to act on: saves the agent a computer_window call
          ev = { ...action, pid: opened.pid, windowId: opened.windowId };
          if (look && backend.windowSnapshot) {
            try {
              const snap = await this.snapshot(opened.pid, opened.windowId);
              frame = this.toFrame(snap.shot, threadId, { ...ev, type: 'window', app: snap.geometry.target.app }, snap.geometry.target);
              text = `${text ?? 'Opened.'}\n\n${snap.text}`;
            } catch (e) {
              text = `${text ?? 'Opened.'}\n(could not look at its window yet: ${errMsg(e)}; use computer_window)`;
            }
          }
        }
        const settle = SETTLE[action.type];
        if (settle !== undefined && look) {
          await sleep(this.settleMs ?? settle);
          try { frame = key ? await this.captureWindow(action.pid!, action.windowId!, threadId, ev) : await this.capture(undefined, threadId, ev); }
          catch (e) { text = `${text ? text + '\n' : ''}(screenshot failed: ${this.screenshotHint(errMsg(e))})`; }
        } else if (!look) {
          const gap = STEP_GAP[action.type];
          if (gap) await sleep(this.settleMs ?? gap);
        }
      }
      this.ctx.bus.emit('computer.action', { threadId, action: masked(ev), ts: Date.now(), ok: true, summary: summarizeAction(ev), ...(point ? { point } : {}), ...(key ? { target: { pid: action.pid!, windowId: action.windowId! } } : {}) });
      return { ok: true, frame, text, ev, opened };
    } catch (e) {
      const msg = action.type === 'screenshot' || action.type === 'wait' ? this.screenshotHint(errMsg(e)) : errMsg(e);
      this.ctx.bus.emit('computer.action', { threadId, action: masked(ev), ts: Date.now(), ok: false, summary: msg.slice(0, 300) });
      return { ok: false, text: msg, ev };
    }
  }

  async shutdown(): Promise<void> {
    // a backend still starting is stopped once it is up, not left running
    await this.whenReady(5000);
    this.control.shutdown();
    for (const stop of this.gateStops.values()) stop();
    this.cursor.hide();
    await this.backend?.shutdown().catch(() => undefined);
    this.backend = null;
    this.helperT?.close();
    this.helperT = null;
  }
}
