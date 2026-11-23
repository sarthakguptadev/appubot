/** IPC handlers for every `appubot:*` channel the preload exposes (see src/preload/api.d.ts). */
import { execFile, spawn } from 'node:child_process';
import { cancelAuthRelay, catchAuthReturn, type AuthRelayRequest } from './authRelay';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BrowserWindow, app, dialog, ipcMain, nativeImage, nativeTheme, shell, systemPreferences, type OpenDialogOptions } from 'electron';
import type { Core } from '../core/app';
import { refreshComputerName } from './computerName';
import { imageToJpeg } from './imageConvert';
import { browserMayOpen, keepOutOfBrowser, mainWindow, markQuitting, themeBackground, titleBarOverlay } from './window';
import { registerVoiceBarIpc } from './voiceBar';
import { registerSupportChatIpc } from './supportChat';
import { RemoteFiles, type RemoteFileRef } from './remoteFiles';
import { copyBytes } from '../core/services/cloudFiles';

const SETTINGS_PANES = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen_recording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  input_monitoring: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
} as const;

const SAFE_EXTERNAL = /^(https?:|mailto:|x-apple\.systempreferences:|ms-settings:)/;

/** AppleScript string literal. */
export const asString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Runs a command line in a new terminal window the user can watch and type into (agent logins and installs). `command`
 * is in the system shell's own syntax: sh on macOS and Linux, cmd.exe on Windows.
 */
export function openInTerminal(command: string): Promise<void> {
  if (process.platform === 'win32') return openInConsole(command);
  if (process.platform === 'linux') return openInLinuxTerminal(command);
  return new Promise((resolve, reject) => {
    execFile('osascript', [
      '-e', `tell application "Terminal" to do script ${asString(command)}`,
      '-e', 'tell application "Terminal" to activate',
    ], (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * The command goes into a script file of its own, so the terminal is only ever handed a path (no shell quoting across
 * programs). Scripts from earlier runs go after a day (cmd.exe reads a batch file as it runs, so not sooner).
 */
function terminalScript(ext: string, body: string): string {
  const dir = join(tmpdir(), 'appubot-terminal');
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) {
    try { if (Date.now() - statSync(join(dir, f)).mtimeMs > 86_400_000) rmSync(join(dir, f), { force: true }); } catch { /* in use */ }
  }
  const file = join(dir, `run-${randomBytes(6).toString('hex')}${ext}`);
  writeFileSync(file, body, { mode: 0o700 });
  return file;
}

/**
 * Windows: the batch file opened the way Explorer would (a new console window, no command line to quote), ending at
 * an interactive prompt so the window stays.
 */
async function openInConsole(command: string): Promise<void> {
  // in a batch file `%` starts a variable: doubled, it stays a plain `%`
  const file = terminalScript('.cmd', `@echo off\r\n${command.replace(/%/g, '%%')}\r\ncmd /d /k\r\n`);
  const err = await shell.openPath(file);
  if (err) throw new Error(`Could not open a console window: ${err}`);
}

/** Linux terminals and how each is told to run a program (it may be a script path only). */
const LINUX_TERMINALS: [string, string[]][] = [
  ['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['ptyxis', ['--']], ['kgx', ['--']], ['konsole', ['-e']],
  ['xfce4-terminal', ['-x']], ['mate-terminal', ['-x']], ['tilix', ['-e']], ['terminator', ['-x']], ['kitty', []],
  ['alacritty', ['-e']], ['wezterm', ['start', '--']], ['foot', []], ['xterm', ['-e']],
];

function onPath(name: string): string | undefined {
  if (name.includes('/')) return existsSync(name) ? name : undefined;
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(delimiter)) {
    const p = join(dir, name);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}

/** Linux: the user's terminal ($TERMINAL, else the first one installed) runs the command, then stays at a shell. */
function openInLinuxTerminal(command: string): Promise<void> {
  const file = terminalScript('.sh', `#!/bin/sh\n${command}\nexec "\${SHELL:-/bin/sh}"\n`);
  chmodSync(file, 0o700);
  const own = process.env.TERMINAL?.trim();
  const choices: [string, string[]][] = [...(own ? [[own, ['-e']] as [string, string[]]] : []), ...LINUX_TERMINALS];
  for (const [name, args] of choices) {
    const bin = onPath(name);
    if (!bin) continue;
    return new Promise((resolve, reject) => {
      const child = spawn(bin, [...args, file], { detached: true, stdio: 'ignore' });
      child.once('error', reject);
      // terminals keep running (or hand off to a server and exit 0): it started, which is all we wait for
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }
  return Promise.reject(new Error(`No terminal app found. Run this in a terminal yourself: ${command}`));
}

/** Windows and Linux: the page's background and the window buttons follow the light or dark theme. */
function themeWindow(w: BrowserWindow | null): void {
  if (!w) return;
  w.setBackgroundColor(themeBackground());
  try { w.setTitleBarOverlay(titleBarOverlay()); } catch { /* no overlay on this window */ }
}

export async function openExternalSafe(url: string): Promise<void> {
  if (!SAFE_EXTERNAL.test(url)) throw new Error(`Refusing to open ${url.split(':')[0]}: URLs`);
  // AppuBot's own key never goes to the browser (its history and sync would keep it): its files open in their own app
  if (!browserMayOpen(url)) throw new Error('Refusing to open a link that carries AppuBot’s own key');
  await shell.openExternal(url);
}

export function registerIpc(core: Core): void {
  keepOutOfBrowser(core.ownerToken);
  registerVoiceBarIpc();
  registerSupportChatIpc();
  ipcMain.handle('appubot:getGateway', () => ({
    url: `http://127.0.0.1:${core.gateway.port}`,
    token: core.ownerToken,
    deviceId: 'desktop',
  }));
  // this Mac's name as Finder shows it (the switcher's row, Settings › Account), read again on every ask
  ipcMain.handle('appubot:computerName', () => refreshComputerName());
  // whether the person is at this Mac (window in front, or input lately with the screen unlocked): the window tells an
  // AppuBot computer it shows, so their phones aren't pushed meanwhile (cloudPresence.ts)
  ipcMain.handle('appubot:atComputer', () => core.ctx.s.notifications.atComputer());
  // typing or clicking in the window counts as using AppuBot (a downloaded update waits), whichever computer is on
  // screen: this Mac's gateway hears nothing of what is sent to an AppuBot computer
  ipcMain.on('appubot:usedApp', () => core.ctx.s.appUpdate.noteActivity());
  ipcMain.handle('appubot:openExternal', (_e, url: string) => openExternalSafe(String(url)));
  // an agent's sign-in on your AppuBot computer, finished in this computer's browser: its return is caught here
  ipcMain.handle('appubot:authRelay', (_e, req: AuthRelayRequest) => catchAuthReturn({ url: String(req?.url), port: Number(req?.port), path: String(req?.path) }, openExternalSafe));
  ipcMain.handle('appubot:authRelayCancel', (_e, port: number) => { cancelAuthRelay(Number(port)); });
  ipcMain.handle('appubot:showInFolder', (_e, p: string) => { shell.showItemInFolder(String(p)); });
  // every package the app carries with its licence, as the plain file each build writes (scripts/notices.mjs): opened in
  // the person's own text app from Settings › About › Credits; false where this build has none
  ipcMain.handle('appubot:openNotices', async () => {
    const file = app.isPackaged
      ? join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt')
      : join(app.getAppPath(), 'node_modules', '.cache', 'appubot-notices', 'THIRD_PARTY_NOTICES.txt');
    if (!existsSync(file)) return false;
    return !(await shell.openPath(file));
  });
  registerRemoteFilesIpc(core.ctx.paths.dataDir, () => core.ctx.s.settings.get().storage.cloudCopyMb);
  ipcMain.handle('appubot:pickFiles', async (e, opts: { multiple?: boolean; directories?: boolean; filters?: { name: string; extensions: string[] }[] } = {}) => {
    const properties: OpenDialogOptions['properties'] = [opts.directories ? 'openDirectory' : 'openFile'];
    if (opts.multiple) properties.push('multiSelections');
    const dialogOpts: OpenDialogOptions = { properties, ...(opts.filters ? { filters: opts.filters } : {}) };
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = win ? await dialog.showOpenDialog(win, dialogOpts) : await dialog.showOpenDialog(dialogOpts);
    return res.canceled ? [] : res.filePaths;
  });
  // a dropped picture the window can't decode (HEIC, TIFF…), as a JPEG for the agent
  ipcMain.handle('appubot:imageToJpeg', (_e, p: string) => imageToJpeg(String(p)));
  // a file attached by path, as the system draws it (macOS Quick Look, Windows' shell): the composer's preview tile;
  // null where there is none (Linux, a file gone)
  ipcMain.handle('appubot:fileThumbnail', async (_e, p: string) => {
    const path = String(p);
    if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) return null;
    try {
      const img = await nativeImage.createThumbnailFromPath(path, { width: 160, height: 160 });
      return img.isEmpty() ? null : img.toDataURL();
    } catch { return null; }
  });
  ipcMain.handle('appubot:setTheme', (_e, t: 'system' | 'light' | 'dark') => {
    nativeTheme.themeSource = t === 'light' || t === 'dark' ? t : 'system';
    if (process.platform !== 'darwin') themeWindow(mainWindow());
  });
  ipcMain.handle('appubot:getNativeTheme', () => nativeTheme.shouldUseDarkColors);
  nativeTheme.on('updated', () => {
    const w = mainWindow();
    if (process.platform !== 'darwin') themeWindow(w);
    // every window: the main one and the menu bar's call bar
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('appubot:nativeTheme', nativeTheme.shouldUseDarkColors);
  });
  ipcMain.on('appubot:windowControl', (e, action: 'minimize' | 'maximize' | 'close') => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else if (action === 'close') win.close();
  });
  ipcMain.handle('appubot:openTerminal', (_e, command: string) => openInTerminal(String(command)));
  ipcMain.handle('appubot:openSystemSettings', (_e, pane: keyof typeof SETTINGS_PANES) => {
    // macOS's privacy panes (computer use's permissions, which only macOS has)
    if (process.platform !== 'darwin') throw new Error('System Settings panes are macOS only');
    const url = SETTINGS_PANES[pane];
    if (!url) throw new Error(`Unknown settings pane: ${String(pane)}`);
    return shell.openExternal(url);
  });
  // whether it may, without asking (onboarding's Permissions step shows it): 'not-asked' until macOS has asked once
  ipcMain.handle('appubot:microphoneAccess', () => {
    if (process.platform !== 'darwin') return 'unknown';
    try {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      return status === 'granted' ? 'granted' : status === 'denied' || status === 'restricted' ? 'denied' : status === 'not-determined' ? 'not-asked' : 'unknown';
    } catch { return 'unknown'; }
  });
  // the microphone, for voice mode and dictation: macOS asks the user once (Info.plist's NSMicrophoneUsageDescription
  // says why); Windows and Linux leave it to Chromium's own prompt
  ipcMain.handle('appubot:requestMicrophone', async () => {
    if (process.platform !== 'darwin') return 'unknown';
    try {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status === 'granted') return 'granted';
      if (status === 'denied' || status === 'restricted') return 'denied';
      return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
    } catch { return 'unknown'; }
  });
  ipcMain.on('appubot:relaunch', () => {
    markQuitting();
    app.relaunch();
    app.quit();
  });
}

/** Pictures and clips the window reads back from the cache to show (bigger ones are opened, not shown). */
const REMOTE_READ_MAX = 64 * 1024 * 1024;

/** A remote computer's files on this Mac (remoteFiles.ts): the window brings the bytes, main keeps, opens and saves them. */
function registerRemoteFilesIpc(dataDir: string, capMb: () => number | undefined): void {
  const files = new RemoteFiles(dataDir);
  setTimeout(() => files.sweep(Date.now(), copyBytes(capMb())), 60_000).unref?.();
  /** a computer's folder is swept at most this often after a save (each computer keeps its own share) */
  const swept = new Map<string, number>();
  const sweepSoon = (computer: string) => {
    if (Date.now() - (swept.get(computer) ?? 0) < 30_000) return;
    swept.set(computer, Date.now());
    files.sweep(Date.now(), copyBytes(capMb()), undefined, computer);
  };
  ipcMain.handle('appubot:remoteFile', async (_e, req: { op: string; ref?: RemoteFileRef; bytes?: Uint8Array; computer?: string }) => {
    const ref = req?.ref as RemoteFileRef;
    switch (req?.op) {
      case 'cached': return files.cached(ref);
      case 'read': {
        const p = files.cached(ref);
        if (!p || statSync(p).size > REMOTE_READ_MAX) return null;
        return new Uint8Array(await readFile(p));
      }
      case 'save': {
        if (!(req.bytes instanceof Uint8Array)) throw new Error('Nothing to save');
        const p = files.save(ref, req.bytes);
        sweepSoon(ref.computer);
        return p;
      }
      case 'open': {
        const p = files.cached(ref);
        if (!p) throw new Error('That file isn’t on this computer yet');
        const err = await shell.openPath(p);
        if (err) throw new Error(err);
        return p;
      }
      case 'download': {
        const p = files.copyTo(ref, app.getPath('downloads'));
        shell.showItemInFolder(p);
        return p;
      }
      case 'forget': files.forget(typeof req.computer === 'string' ? req.computer : undefined); return null;
      default: throw new Error('Unknown request');
    }
  });
}
