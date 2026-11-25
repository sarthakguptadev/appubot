/** Computer use through Cua Driver (in-process): window snapshots with element tokens, input sent to a window in the background. */
import type { ComputerAction, ComputerTarget } from '@appubot/protocol';
import { errMsg, sleep, truncate, type Logger } from '../util';
import { AGENT_CURSOR_TITLE } from './agentCursor';
import type { ActOptions, Borrow, ComputerBackend, Opened, Perms, Rect, ScreenInfo, Shot, UserPlace, WindowGeometry, WindowSnapshot } from './computerBackend';
import { NEEDS_WINDOW_HINT, clampText, cuaModifier, findRunningApp, isBrowserApp, isPressable, isWebArea, launchArgs, menuBarRole, parseDetail, pngSize, staticTextRoles } from './computerHelpers';

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
export function someLabels(g: WindowGeometry, label: string): string {
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
