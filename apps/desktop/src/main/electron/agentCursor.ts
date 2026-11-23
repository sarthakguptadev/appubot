/**
 * On-screen agent cursor (the Electron side of core/services/agentCursor.ts): a transparent, click-through,
 * always-on-top window over the display the bot is working on, drawing its pointer and avatar (the page is
 * agentCursorPage.ts, animated with the app's own botAvatar.css). It is excluded from screen capture (content
 * protection), so the agent never sees its own cursor in screenshots. Windows and Linux only get it where that is
 * safe (`agentCursorSupported`).
 */
import { release } from 'node:os';
import { BrowserWindow, screen } from 'electron';
import avatarCss from '../../renderer/src/components/ui/botAvatar.css?raw';
import { AGENT_CURSOR_TITLE, agentCursorSupport, type AgentCursorHost } from '../core/services/agentCursor';
import { cursorLook, cursorPage } from './agentCursorPage';

const PAGE = cursorPage(avatarCss);

/** Can this system show the overlay (see core's agentCursorSupport)? */
export function agentCursorSupported(): boolean {
  return agentCursorSupport(process.platform, process.env, release()).ok;
}

/**
 * Global screen points from the computer backend in Electron's own screen coordinates. macOS: the same points.
 * Windows and Linux (X11): Cua's are physical pixels, Electron's are scaled by each display's factor (DIPs).
 */
const toDip = (x: number, y: number): { x: number; y: number } =>
  process.platform === 'win32' || process.platform === 'linux' ? screen.screenToDipPoint({ x, y }) : { x, y };

export function createAgentCursorHost(): AgentCursorHost {
  let win: BrowserWindow | null = null;
  let ready: Promise<void> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  /** shown since the last hide (the window itself stays up a moment for the fade) */
  let shown = false;
  /** the display the overlay currently covers (the cursor is drawn relative to its origin) */
  let display = screen.getPrimaryDisplay();

  const cover = (d: Electron.Display) => {
    display = d;
    win?.setBounds({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height });
    syncOrigin();
  };
  /**
   * The page draws in display space (0,0 = the display's top-left). macOS moves or resizes the overlay on its own
   * (measured: a screen capture started from this process shifts it 32pt up and makes it 32pt taller), so the page's
   * wrapper is offset by wherever the window's content really is; it is re-synced on every move/resize event.
   */
  const syncOrigin = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getContentBounds();
    void run(`window.__cursor.origin(${display.bounds.x - b.x}, ${display.bounds.y - b.y})`).catch(() => undefined);
  };
  const fit = () => cover(screen.getDisplayNearestPoint({ x: display.bounds.x + 1, y: display.bounds.y + 1 }));

  const ensure = (): Promise<void> => {
    if (win && !win.isDestroyed() && ready) return ready;
    const d = display.bounds;
    win = new BrowserWindow({
      x: d.x, y: d.y, width: d.width, height: d.height,
      transparent: true, frame: false, hasShadow: false, resizable: false, movable: false,
      focusable: false, skipTaskbar: true, show: false, enableLargerThanScreen: true,
      // the computer backend knows the overlay by this title (Windows and Linux list it among the app windows)
      title: AGENT_CURSOR_TITLE,
      // Windows: a tool window, which Alt+Tab and Task View leave out
      ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.on('page-title-updated', (e) => e.preventDefault());
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(true); // keep the cursor out of the agent's screenshots (Linux has no such thing)
    win.setAlwaysOnTop(true, 'screen-saver');
    // Windows has no workspaces to follow
    if (process.platform !== 'win32') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    screen.on('display-metrics-changed', fit);
    screen.on('display-removed', fit);
    win.on('move', syncOrigin);
    win.on('resize', syncOrigin);
    ready = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).then(syncOrigin);
    return ready;
  };

  /**
   * Calls into the page run in the order they are made: each waits for the same page load, then goes at once (so
   * callers must not add awaits before `run`, or a later call could overtake them).
   */
  const run = async (js: string): Promise<unknown> => {
    await ensure();
    return win && !win.isDestroyed() ? win.webContents.executeJavaScript(js, true) : undefined;
  };
  /** A call for a page that is already up (reactions, mood): nothing to do without one. */
  const call = (js: string) => {
    if (win && !win.isDestroyed()) void run(js).catch(() => undefined);
  };

  /** Make the overlay visible on `display` (macOS may nudge a window when it first shows: re-assert the frame). */
  const reveal = () => {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) win.showInactive();
    // re-assert the frame once; if macOS still keeps the overlay off the display's origin, toPage() measures from
    // wherever it really is, so the pointer still lands on the target
    const want = display.bounds;
    const has = win.getBounds();
    if (has.x !== want.x || has.y !== want.y || has.width !== want.width || has.height !== want.height) cover(display);
    else syncOrigin();
  };
  /** Page (display-space) coordinates for a global screen point; `syncOrigin` absorbs where the window really is. */
  const toPage = (x: number, y: number) => ({ x: x - display.bounds.x, y: y - display.bounds.y });

  return {
    show(o) {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      // a hidden cursor pops in where the user's pointer is, on that display
      const m = screen.getCursorScreenPoint();
      if (!shown || !win || win.isDestroyed() || !win.isVisible()) cover(screen.getDisplayNearestPoint(m));
      shown = true;
      const p = toPage(m.x, m.y);
      void ensure().then(reveal).catch(() => undefined);
      void run(`window.__cursor.show(${JSON.stringify(cursorLook(o))}, ${p.x}, ${p.y})`).catch(() => undefined);
    },
    async moveTo(gx, gy, durationMs) {
      // global points: hop the overlay to the display that holds the target, then glide within it
      const { x, y } = toDip(gx, gy);
      const target = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
      const hop = target.id !== display.id;
      if (hop) cover(target);
      const p = toPage(x, y);
      void ensure().then(reveal).catch(() => undefined);
      await run(`window.__cursor.moveTo(${p.x}, ${p.y}, ${hop ? 0 : Math.max(0, Math.round(durationMs))})`).catch(() => undefined);
    },
    react(kind) { call(`window.__cursor.react(${JSON.stringify(kind)})`); },
    activity(kind) { call(`window.__cursor.activity(${JSON.stringify(kind)})`); },
    mood(m) { call(`window.__cursor.mood(${JSON.stringify(m)})`); },
    hide() {
      shown = false;
      if (!win || win.isDestroyed()) return;
      call('window.__cursor.hide()');
      if (hideTimer) clearTimeout(hideTimer);
      // let the fade finish, then take the window off screen entirely
      hideTimer = setTimeout(() => { hideTimer = null; if (win && !win.isDestroyed()) win.hide(); }, 300);
    },
    dispose() {
      screen.off('display-metrics-changed', fit);
      screen.off('display-removed', fit);
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
      ready = null;
    },
  };
}
