import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import type { NotificationAccess } from '@appubot/protocol';
import { errMsg, type Logger } from '../core/util';

/** the flag a login launch passes on Windows and Linux (macOS says so itself: `wasOpenedAtLogin`) */
export const HIDDEN_ARG = '--hidden';

/** AppuBot was started by the OS at login: it stays in the menu bar / tray instead of opening its window. */
export function openedAtLogin(): boolean {
  if (process.argv.includes(HIDDEN_ARG)) return true;
  if (process.platform !== 'darwin') return false;
  try { return app.getLoginItemSettings().wasOpenedAtLogin; } catch { return false; }
}

const run = (file: string, args: string[], timeout: number): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout, encoding: 'utf8', windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** macOS: AppuBot.app/Contents/MacOS/appubot-notify (electron-builder.yml), only in the packaged app */
const notifyTool = (): string | null => {
  if (!app.isPackaged) return null;
  const p = join(dirname(process.execPath), 'appubot-notify');
  return existsSync(p) ? p : null;
};

const ACCESS = new Set<NotificationAccess>(['on', 'off', 'not-asked', 'unknown']);

async function macAccess(cmd: 'status' | 'request', log: Logger): Promise<NotificationAccess> {
  const tool = notifyTool();
  if (!tool) return 'unknown';
  try {
    // a request waits for the user to answer macOS's prompt
    const out = await run(tool, [cmd], cmd === 'request' ? 130_000 : 8000);
    const access = (JSON.parse(out.trim()) as { access?: NotificationAccess }).access;
    return access && ACCESS.has(access) ? access : 'unknown';
  } catch (e) {
    log.warn(`appubot-notify ${cmd} failed`, errMsg(e));
    return 'unknown';
  }
}

/** a REG_DWORD under HKCU, or undefined when the key or value isn't there */
async function regDword(key: string, value: string): Promise<number | undefined> {
  try {
    const out = await run('reg', ['query', key, '/v', value], 5000);
    const m = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
    return m ? parseInt(m[1]!, 16) : undefined;
  } catch {
    return undefined;
  }
}

/** Windows: all toasts off (Settings › System › Notifications), or AppuBot's own switch off there. */
async function windowsAccess(appId: string): Promise<NotificationAccess> {
  const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion';
  if ((await regDword(`${base}\\PushNotifications`, 'ToastEnabled')) === 0) return 'off';
  if ((await regDword(`${base}\\Notifications\\Settings\\${appId}`, 'Enabled')) === 0) return 'off';
  return 'on';
}

/**
 * Whether the OS shows AppuBot's notifications: macOS through appubot-notify (packaged only), Windows from the
 * registry, Linux can't say (notification daemons have no per-app switch to read).
 */
export function notificationAccess(appId: string, log: Logger): Promise<NotificationAccess> {
  if (process.platform === 'darwin') return macAccess('status', log);
  if (process.platform === 'win32') return windowsAccess(appId);
  return Promise.resolve('unknown');
}

/** macOS: asks (its prompt shows while the user hasn't been asked yet). Elsewhere nothing to ask: the current state. */
export function requestNotifications(appId: string, log: Logger): Promise<NotificationAccess> {
  if (process.platform === 'darwin') return macAccess('request', log);
  return notificationAccess(appId, log);
}

/** Linux autostart entry (XDG): ~/.config/autostart/<appId>.desktop */
const autostartFile = (appId: string): string =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart', `${appId}.desktop`);

/** a desktop-entry Exec argument: quoted, with its own quotes, backslashes and dollars escaped */
const execArg = (s: string): string => `"${s.replace(/(["`$\\])/g, '\\$1')}"`;

export interface LoginItem {
  get(): boolean;
  set(on: boolean): void;
}

/**
 * Opening AppuBot at login, hidden: macOS's login items (SMAppService), Windows' Run key (with `--hidden`), Linux's XDG
 * autostart entry (with `--hidden`; an AppImage starts from its own file, not the mounted copy).
 */
export function loginItem(appId: string): LoginItem {
  if (process.platform === 'linux') {
    const file = autostartFile(appId);
    return {
      get: () => existsSync(file),
      set: (on) => {
        if (!on) { rmSync(file, { force: true }); return; }
        const exe = process.env.APPIMAGE || process.execPath;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, [
          '[Desktop Entry]',
          'Type=Application',
          'Name=AppuBot',
          'Comment=Your bots, ready when you log in',
          `Exec=${execArg(exe)} ${HIDDEN_ARG}`,
          'Terminal=false',
          'X-GNOME-Autostart-enabled=true',
          '',
        ].join('\n'));
      },
    };
  }
  // Windows keys its Run entry by path and args, so get and set name the same ones
  const opts = process.platform === 'win32' ? { path: process.execPath, args: [HIDDEN_ARG] } : {};
  return {
    get: () => app.getLoginItemSettings(opts).openAtLogin,
    set: (on) => app.setLoginItemSettings({ openAtLogin: on, ...opts }),
  };
}
