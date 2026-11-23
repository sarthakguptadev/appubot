/**
 * The menu bar's voice call: a small frameless, transparent window floating over everything (every Space, full-screen
 * apps too, never in the Dock or ⌘Tab) at the bottom centre of the display the pointer is on, showing the call bar
 * (renderer `features/voice/bar/`). The page reports its size (`appubot:voiceBarSize`) and the window grows or
 * shrinks around it with its bottom edge where it was; around the bar itself clicks go through to what is behind
 * (`appubot:voiceBarIgnore`; not on Linux, which has no forwarded mouse moves to switch back with, so there the window
 * just stays the bar's size). One call at a time: starting another bot's moves the window to it. A page that fails
 * to load or crashes closes the window, so no invisible window is left taking clicks or holding an update's restart.
 */
import { join } from 'node:path';
import { BrowserWindow, ipcMain, screen, shell } from 'electron';
import { browserMayOpen, mainWindow, showMainWindow } from './window';

let bar: BrowserWindow | null = null;
let botId: string | null = null;
const listeners = new Set<() => void>();

/** how far above the bottom of the work area the window's bottom edge sits */
const BOTTOM_GAP = 48;
/** the size before the page has reported its own (the bar plus room for its shadow and tooltips) */
const START = { width: 420, height: 140 };

const changed = (): void => { for (const fn of listeners) fn(); };

export function voiceBarWindow(): BrowserWindow | null { return bar && !bar.isDestroyed() ? bar : null; }
/** the bot the open call is with (null: none) */
export function voiceBarBot(): string | null { return voiceBarWindow() ? botId : null; }
/** Called whenever a call starts or ends (the tray rebuilds its menu). */
export function onVoiceBarChange(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

function pageUrl(bot: string): { url?: string; file?: string; query: Record<string, string> } {
  const query = { view: 'voicebar', bot };
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) return { url: `${devUrl}${devUrl.includes('?') ? '&' : '?'}${new URLSearchParams(query)}`, query };
  return { file: join(__dirname, '../renderer/index.html'), query };
}

/** Opens a call with a bot (or switches the open one to it) and brings the bar forward. */
export function openVoiceBar(bot: string): void {
  const open = voiceBarWindow();
  if (open && botId === bot) { open.show(); open.focus(); return; }
  open?.destroy();
  botId = bot;
  // one conversation at a time: voice mode in the main window ends
  mainWindow()?.webContents.send('appubot:endVoice');
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = new BrowserWindow({
    ...START,
    x: Math.round(workArea.x + (workArea.width - START.width) / 2),
    y: workArea.y + workArea.height - BOTTOM_GAP - START.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'AppuBot call',
    // macOS: an NSPanel floats over full-screen apps without taking the app's other windows along
    ...(process.platform === 'darwin' ? { type: 'panel' as const, hiddenInMissionControl: true } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  bar = w;
  w.setAlwaysOnTop(true, 'floating');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  w.once('ready-to-show', () => { if (!w.isDestroyed()) w.show(); });
  w.on('closed', () => { if (bar === w) { bar = null; botId = null; } changed(); });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url) && browserMayOpen(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => { if (url !== w.webContents.getURL()) e.preventDefault(); });
  // a page that can't load, or whose renderer is gone, ends the call (the 'closed' handler clears it)
  const fail = (): void => { if (!w.isDestroyed()) w.destroy(); };
  w.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => { if (isMainFrame) fail(); });
  w.webContents.on('render-process-gone', fail);
  const page = pageUrl(bot);
  (page.url ? w.loadURL(page.url) : w.loadFile(page.file!, { query: page.query })).catch(fail);
  changed();
}

/** Ends the call: the page hangs up (its own animation) and closes the window; a page that doesn't answer is closed. */
export function closeVoiceBar(): void {
  const w = voiceBarWindow();
  if (!w) return;
  w.webContents.send('appubot:voiceBarEnd');
  setTimeout(() => { if (!w.isDestroyed()) w.destroy(); }, 1500);
}

export function registerVoiceBarIpc(): void {
  const fromBar = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null => {
    const w = voiceBarWindow();
    return w && e.sender === w.webContents ? w : null;
  };
  ipcMain.on('appubot:voiceBarSize', (e, size: { width: number; height: number }) => {
    const w = fromBar(e);
    if (!w || !size) return;
    // the page measures in its own CSS pixels; Chromium keeps a zoom per origin, so a zoom picked in the main window applies here too
    const zoom = w.webContents.getZoomFactor() || 1;
    const width = Math.max(120, Math.min(1000, Math.ceil((Number(size.width) || 0) * zoom)));
    const height = Math.max(60, Math.min(1100, Math.ceil((Number(size.height) || 0) * zoom)));
    const b = w.getBounds();
    if (b.width === width && b.height === height) return;
    // the bottom edge and the centre stay put: the bar grows upward as its panels open
    w.setBounds({ x: Math.round(b.x + (b.width - width) / 2), y: b.y + b.height - height, width, height });
  });
  ipcMain.on('appubot:voiceBarIgnore', (e, ignore: boolean) => {
    const w = fromBar(e);
    // Linux has no `forward`: a click-through window would never hear the pointer come back to the bar
    if (!w || process.platform === 'linux') return;
    if (ignore) w.setIgnoreMouseEvents(true, { forward: true });
    else w.setIgnoreMouseEvents(false);
  });
  ipcMain.on('appubot:voiceBarClose', (e) => { fromBar(e)?.destroy(); });
  ipcMain.on('appubot:showApp', () => { showMainWindow(); });
  // the main window's voice mode started: the call hangs up as from the menu bar (its session ends, the tray updates)
  ipcMain.on('appubot:voiceBarHangUp', (e) => { if (e.sender === mainWindow()?.webContents) closeVoiceBar(); });
}
