/**
 * Main BrowserWindow: hidden-inset title bar on macOS, the system's window buttons over the page elsewhere (Window
 * Controls Overlay), hide-on-close (menu bar / tray app), dev/prod renderer URL.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, app, nativeTheme, screen, shell, type TitleBarOverlayOptions } from 'electron';
import { dark, light } from '@appubot/theme';
import { MIN_WINDOW_SIZE, openingBounds, parseWindowState, type WindowState } from './windowBounds';

let win: BrowserWindow | null = null;
let quitting = false;

/** Permanent: only once a quit is confirmed (or the system is logging out); until then close just hides. */
export function markQuitting(): void { quitting = true; }
/** An update's install that didn't quit AppuBot after all (appUpdater.ts): closing the window hides it again, quitting asks. */
export function unmarkQuitting(): void { quitting = false; }
export function isQuitting(): boolean { return quitting; }
/** Dev harness (APPUBOT_DEV_CAPTURE): the window stays invisible and click-through. */
export const isHeadless = (): boolean => !app.isPackaged && !!process.env.APPUBOT_DEV_CAPTURE;
export function mainWindow(): BrowserWindow | null { return win && !win.isDestroyed() ? win : null; }
export const themeBackground = (): string => (nativeTheme.shouldUseDarkColors ? dark.bg : light.bg);
/**
 * The window's top strip (the sidebar's and the chat header's, px at 100%): Windows' and Linux's window buttons are
 * centred in it (macOS's traffic lights sit higher, in the corner). 64,
 * so the chat header's 40px capsule keeps 12px above it, as much as it keeps from the window's sides (at 56 it sat
 * 8px under the top edge). The renderer's strips are `h-16`: change them together.
 */
const TOP_STRIP = 64;
/**
 * Windows and Linux: minimize / maximize / close drawn by the system over the page's top-right corner, as tall as the
 * chat header (the renderer keeps that corner clear: --wco-right in index.css), on the header's own colour.
 */
export const titleBarOverlay = (): TitleBarOverlayOptions => {
  const d = nativeTheme.shouldUseDarkColors;
  return { color: d ? dark.bg : light.surface, symbolColor: d ? dark.fg : light.fg, height: TOP_STRIP };
};
/** The app icon as a file (Linux windows and the Windows/Linux tray draw it; macOS uses the bundle's). */
export const appIconPath = (): string =>
  app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'resources', 'icon.png');
/**
 * The owner token (`keepOutOfBrowser`): no link with it on goes to the system browser (its history, sync and extensions
 * would keep it), whichever window or call asks. `browserMayOpen` is every external opener's check.
 */
let ownerSecret: string | null = null;
export function keepOutOfBrowser(secret: string): void { ownerSecret = secret; }
export function browserMayOpen(url: string): boolean {
  return !ownerSecret || !url.includes(ownerSecret);
}

/** Closing the window only hides it: the first time on Windows and Linux, a notification says AppuBot is still there. */
let onHidden: (() => void) | null = null;
export function onFirstHide(fn: () => void): void { onHidden = fn; }

/**
 * The window's size: Chromium's own 100%. Actual Size (⌘0) comes back here (menu.ts); ⌘+/⌘− step from it. Until
 * 2026-11-17 it opened one ⌘+ step up (level 0.5, ~110%), and Chromium keeps a zoom per origin across launches, so a
 * window still on that old default is put back to 100% once (`settleZoom`); a zoom the person picks afterwards stays.
 */
export const DEFAULT_ZOOM_LEVEL = 0;
const OLD_DEFAULT_ZOOM_LEVEL = 0.5;
export function resetZoom(): void { mainWindow()?.webContents.setZoomLevel(DEFAULT_ZOOM_LEVEL); }

/** Once per install (a marker beside Chromium's own saved zoom): the old default, which nobody picked, becomes 100%. */
function settleZoom(w: BrowserWindow): void {
  const marker = join(app.getPath('userData'), 'zoom-100');
  if (existsSync(marker)) return;
  if (Math.abs(w.webContents.getZoomLevel() - OLD_DEFAULT_ZOOM_LEVEL) < 0.01) w.webContents.setZoomLevel(DEFAULT_ZOOM_LEVEL);
  try { writeFileSync(marker, ''); } catch { /* looked at again at the next launch */ }
}

/**
 * Where the window was left (its own bounds and whether it was maximized), kept beside Chromium's own state. It opens
 * there again; the first time at a fixed size in the middle of the screen in use, never filling it (windowBounds.ts).
 * The dev harness's invisible windows keep nothing.
 */
const windowStateFile = (): string => join(app.getPath('userData'), 'window-state.json');
function readWindowState(): WindowState | null {
  try { return parseWindowState(JSON.parse(readFileSync(windowStateFile(), 'utf8'))); } catch { return null; }
}
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveWindowState(w: BrowserWindow): void {
  if (isHeadless() || w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return;
  try { writeFileSync(windowStateFile(), JSON.stringify({ bounds: w.getNormalBounds(), maximized: w.isMaximized() })); } catch { /* kept at the next change */ }
}
function saveWindowStateSoon(w: BrowserWindow): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; saveWindowState(w); }, 400);
}
/** a window left maximized is maximized again the first time it shows */
let startMaximized = false;

export function createMainWindow(opts: { hidden?: boolean } = {}): BrowserWindow {
  const existing = mainWindow();
  if (existing) return existing;
  const here = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const opening = openingBounds(readWindowState(), screen.getAllDisplays().map((d) => d.workArea), here);
  startMaximized = opening.maximized;
  win = new BrowserWindow({
    ...opening.bounds,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    title: 'AppuBot',
    ...(process.platform === 'darwin'
      ? {
        titleBarStyle: 'hiddenInset' as const,
        // tight in the window's corner, where the reference keeps them (16pt in, 15pt down to the close button's edge): above
        // the middle of the sidebar's search and + circles, and centred in the computer viewer's 44px full size row
        trafficLightPosition: { x: 16, y: 15 },
        // macOS glass: the renderer paints a translucent coat over the window's vibrancy (see index.css)
        vibrancy: 'under-window' as const, visualEffectState: 'followWindow' as const, backgroundColor: '#00000000',
      }
      : {
        titleBarStyle: 'hidden' as const,
        titleBarOverlay: titleBarOverlay(),
        autoHideMenuBar: true,
        backgroundColor: themeBackground(),
        ...(process.platform === 'linux' ? { icon: appIconPath() } : {}),
      }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  // Dev harness (APPUBOT_DEV_CAPTURE): keep test instances invisible and click-through so nobody types into them
  // by mistake; capturePage still renders the page.
  const headless = isHeadless();
  win.once('ready-to-show', () => {
    if (!win) return;
    if (headless) { win.setOpacity(0); win.setIgnoreMouseEvents(true); win.showInactive(); }
    else if (!opts.hidden) { shownOnce.add(win); if (startMaximized) win.maximize(); win.show(); }
  });
  for (const change of ['resize', 'move', 'maximize', 'unmaximize'] as const) {
    win.on(change as 'resize', () => { if (win && shownOnce.has(win)) saveWindowStateSoon(win); });
  }
  win.on('close', (e) => {
    if (win && shownOnce.has(win)) saveWindowState(win);
    if (quitting) return;
    e.preventDefault();
    win?.hide();
    if (process.platform !== 'darwin' && onHidden) { const fn = onHidden; onHidden = null; fn(); }
  });
  win.on('closed', () => { win = null; });
  // Chromium keeps a zoom across launches (per origin): one left on the old ~110% default goes to 100%, once
  win.webContents.once('did-finish-load', () => { if (win) settleZoom(win); });
  // external links open in the browser, never in-app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url) && browserMayOpen(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:/.test(url) && browserMayOpen(url)) void shell.openExternal(url);
    }
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

const shownOnce = new WeakSet<BrowserWindow>();

export function showMainWindow(): BrowserWindow {
  const w = createMainWindow();
  if (isHeadless()) return w;
  if (w.isMinimized()) w.restore();
  // a window started hidden (at login) that was left maximized is maximized the first time it shows, like one opened by hand
  if (!w.isVisible() && !shownOnce.has(w) && startMaximized) w.maximize();
  shownOnce.add(w);
  w.show();
  // in front of whatever app the user (or a bot) was in: a window's own focus() doesn't activate the app on macOS
  if (process.platform === 'darwin') app.focus({ steal: true });
  w.focus();
  return w;
}
