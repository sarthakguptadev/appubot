/**
 * Quitting works as in any app: Cmd+Q (Ctrl+Q on Windows and Linux), the app menu's and the tray's Quit, Dock › Quit
 * and `kill` in packaged builds all quit AppuBot. It asks first only while a bot is in the middle of a turn or waiting
 * on you, since quitting cuts that short. The window asks in its own dialog when it can (it acks at once); otherwise,
 * or without an ack in time (or once it hangs), a native dialog does. A logout or shutdown never waits on a prompt
 * (macOS would cancel it): one still open then counts as Cancel.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Notification, app, dialog, ipcMain, powerMonitor, type BrowserWindow, type IpcMainEvent } from 'electron';
import { machineName } from '@appubot/protocol';
import type { Core } from '../core/app';
import { isHeadless, isQuitting, mainWindow, markQuitting, showMainWindow } from './window';

/** the renderer acks straight away when it can show the dialog (hydrated, no connection overlay) */
const ACK_MS = 1500;
let seq = 0;
let pending: Promise<boolean> | null = null;
/** answers the open prompt (window or native) with Cancel */
let cancelOpen: (() => void) | null = null;
let systemQuit = false;

/** Logout, restart or shut down (listened to without preventDefault, which would make macOS wait on us). */
export function watchSystemQuit(): void {
  powerMonitor.on('shutdown', () => {
    systemQuit = true;
    // another app may still cancel the logout
    setTimeout(() => { systemQuit = false; }, 60_000).unref();
  });
}
export const systemQuitting = (): boolean => systemQuit;

/** Bots in the middle of a turn (or waiting on you): what quitting would cut short. */
export function workingCount(core: Core): number {
  return core.services.threads.list({ limit: 200 }).filter((t) => t.status === 'running' || t.status === 'waiting').length;
}

export function quitDetail(working: number): string {
  const now = working ? `${working} bot${working === 1 ? ' is' : 's are'} working right now and will stop. ` : '';
  return `${now}Your bots and routines stop, your phone can’t reach this ${machineName(process.platform)}, and Telegram goes quiet until you open AppuBot again.`;
}

/**
 * Quit: at once when no bot is working, else ask and quit if the user confirms. A second request while asking shares
 * the first and brings it back to the front.
 */
export function requestQuit(core: Core): Promise<boolean> {
  if (pending) {
    // the prompt may sit in a hidden window (Cmd+H and the close button only hide it)
    if (!isHeadless()) { showMainWindow(); app.focus({ steal: true }); }
    return pending;
  }
  const working = workingCount(core);
  // nothing to cut short: no prompt (already stopping is still a no: it quits regardless)
  pending = (working ? ask(working) : Promise.resolve(noPrompt() ?? true))
    .catch(() => false)
    .then((ok) => {
      if (ok) { markQuitting(); app.quit(); }
      return ok;
    })
    .finally(() => { pending = null; });
  return pending;
}

/**
 * No prompt while quitting anyway, it would only hold that up: already stopping is a no (it quits regardless), a logout
 * or shutdown a yes (as before-quit lets it through). Null: ask.
 */
function noPrompt(): boolean | null {
  if (isQuitting()) return false;
  return systemQuitting() ? true : null;
}

/** The stop path: an open prompt answers Cancel and none opens after. */
export function settleQuitPrompt(): void {
  cancelOpen?.();
}

async function ask(working: number): Promise<boolean> {
  const skip = noPrompt();
  if (skip !== null) return skip;
  const win = mainWindow();
  if (win && !isHeadless() && !win.webContents.isCrashed() && !win.webContents.isLoading()) {
    showMainWindow();
    app.focus({ steal: true });
    const answer = await askWindow(win, working);
    if (answer !== null) return answer;
  }
  return askNative(working);
}

/**
 * The window's own dialog: null when it can't answer (no ack in time, it went away or hung mid-question). Whenever
 * it ends without the window's answer, the window hears so (`quitCancel`) and drops a dialog it showed late.
 */
function askWindow(win: BrowserWindow, working: number): Promise<boolean | null> {
  const wc = win.webContents;
  const id = ++seq;
  return new Promise((resolve) => {
    const mine = (e: IpcMainEvent, rid: unknown): boolean => e.sender === wc && rid === id;
    const onAck = (e: IpcMainEvent, rid: unknown): void => { if (mine(e, rid)) clearTimeout(timer); };
    const onAnswer = (e: IpcMainEvent, rid: unknown, ok: unknown): void => { if (mine(e, rid)) done(ok === true, true); };
    const gone = (): void => done(null);
    const timer = setTimeout(gone, ACK_MS);
    function done(v: boolean | null, answered = false): void {
      clearTimeout(timer);
      cancelOpen = null;
      ipcMain.off('appubot:quitAck', onAck);
      ipcMain.off('appubot:quitAnswer', onAnswer);
      win.off('closed', gone);
      win.off('unresponsive', gone);
      wc.off('render-process-gone', gone);
      wc.off('did-start-loading', gone);
      if (!answered && !wc.isDestroyed()) wc.send('appubot:quitCancel', id);
      resolve(v);
    }
    cancelOpen = () => done(false);
    ipcMain.on('appubot:quitAck', onAck);
    ipcMain.on('appubot:quitAnswer', onAnswer);
    win.once('closed', gone);
    win.on('unresponsive', gone);
    wc.on('render-process-gone', gone);
    wc.on('did-start-loading', gone);
    wc.send('appubot:quitRequest', { id, working });
  });
}

async function askNative(working: number): Promise<boolean> {
  const skip = noPrompt();
  if (skip !== null) return skip;
  app.focus({ steal: true });
  // closes a sheet when the stop path cancels (a parentless alert on macOS can't be closed: it blocks until answered)
  const abort = new AbortController();
  const opts = {
    type: 'question' as const, buttons: ['Quit', 'Cancel'], defaultId: 0, cancelId: 1,
    message: 'Quit AppuBot?', detail: quitDetail(working), signal: abort.signal,
  };
  const win = mainWindow();
  cancelOpen = () => abort.abort();
  try {
    const { response } = win?.isVisible() && !isHeadless() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return response === 0;
  } finally {
    cancelOpen = null;
  }
}

/** Where AppuBot's icon lives once its window is closed, in the words of each system (macOS keeps it in the Dock). */
const STILL_RUNNING = `AppuBot keeps running in ${process.platform === 'win32' ? 'the taskbar’s notification area' : 'the system tray'}. To quit, use its icon there or press Ctrl+Q in its window.`;

/** Once ever: AppuBot went out of sight but keeps running (closing the window on Windows and Linux). */
export function stillRunningHint(): void {
  const seen = join(app.getPath('userData'), 'quit-hint-shown');
  try {
    if (existsSync(seen)) return;
    writeFileSync(seen, '');
  } catch { /* shown again next time */ }
  if (Notification.isSupported()) {
    new Notification({ title: 'AppuBot is still running', body: STILL_RUNNING }).show();
  }
}
