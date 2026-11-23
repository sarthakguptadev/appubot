/**
 * `appubot://` scheme: the phone uses it for pairing links; on the Mac it surfaces the app, and AppuBot Cloud's browser
 * pages come back through it (plan §6.5, §6.6):
 *
 * - `appubot://cloud/signed-in?code=…&state=…` (or `?error=…`): the sign-in page is done; the code is swapped for a
 *   session with PKCE (`cloudAccount.finishSignIn`);
 * - `appubot://cloud/checkout-done`: Dodo's checkout returned; the account is read again (`cloudAccount.status
 *   {refresh}`);
 * - `appubot://cloud/invite?token=…`: a team invite's email opened in the app (Work plans, §6.11); the account is read
 *   again and Settings › Cloud shows the invite (addressed to the signed-in email) with Join / Decline: nothing is
 *   accepted by the link alone;
 * - `appubot://apps/signed-in?code=…&state=…` (or `?error=…`, protocol `APPS_SIGNED_IN_LINK`): the Composio sign-in the
 *   window ran for the cloud computer came back. The cloud holds the sign-in, so the window (whose second gateway client
 *   reaches it) hands it over with `apps.finishSignIn` (`appubot:appsSignedIn`); this Mac's own sign-in never comes
 *   here (it returns to the gateway's loopback page).
 *
 * The core finishes them (`cloudLinks.ts`, which keeps a link until the core is up) and the app comes forward on
 * Settings › Cloud. Only a link `parseCloudLink` reads goes on. macOS hands links to `open-url`; Windows and Linux
 * start a second instance with the link in its argv.
 */
import { app } from 'electron';
import { handleCloudLink } from './cloudLinks';
import { mainWindow, showMainWindow } from './window';

export type CloudLink =
  | { kind: 'signed-in'; code: string; state: string }
  | { kind: 'signed-in'; error: string; state?: string }
  | { kind: 'checkout-done'; status?: string }
  | { kind: 'invite' };

/** What a Composio sign-in brought back to `appubot://apps/signed-in`, as the window hands it to `apps.finishSignIn`. */
export type AppsSignInReturn = { code: string; state: string } | { error: string; state?: string };

/**
 * An `appubot://apps/signed-in` link as what it carries; null for anything else. The state is ours (hex), the code
 * Composio's (URL-safe, base64 at most); anything that doesn't look like them is dropped, never passed on.
 */
export function parseAppsLink(url: string): AppsSignInReturn | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'appubot:') return null;
  const path = `${u.host}${u.pathname}`.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (path !== 'apps/signed-in') return null;
  const q = u.searchParams;
  const state = q.get('state');
  const okState = state && /^[\w-]{8,200}$/.test(state) ? state : null;
  const code = q.get('code');
  if (code && okState) return code.length <= 2000 && /^[\w.~+/=-]+$/.test(code) ? { code, state: okState } : null;
  const error = q.get('error');
  if (error) return { error: error.replace(/[^\w .,:;'()-]/g, '').slice(0, 200) || 'refused', ...(okState ? { state: okState } : {}) };
  return null;
}

/** An `appubot://cloud/…` link as what it asks for; null for anything else (a pairing link, a typo, a forged path). */
export function parseCloudLink(url: string): CloudLink | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'appubot:') return null;
  // `appubot://cloud/signed-in`: host `cloud`, path `/signed-in` (some platforms fold the host into the path)
  const path = `${u.host}${u.pathname}`.replace(/^\/+|\/+$/g, '').toLowerCase();
  const q = u.searchParams;
  const short = (v: string | null, max: number): string | null => (v && v.length <= max && /^[\w.~-]+$/.test(v) ? v : null);
  if (path === 'cloud/signed-in') {
    const state = short(q.get('state'), 200);
    const code = short(q.get('code'), 200);
    if (code && state) return { kind: 'signed-in', code, state };
    const error = q.get('error');
    if (error) return { kind: 'signed-in', error: error.slice(0, 200), ...(state ? { state } : {}) };
    return null;
  }
  if (path === 'cloud/invite') return { kind: 'invite' };
  if (path === 'cloud/checkout-done') {
    const status = short(q.get('status'), 40);
    return { kind: 'checkout-done', ...(status ? { status } : {}) };
  }
  return null;
}

/** Sends the main window a message once it is there and its page has loaded. */
function sendToWindow(channel: string, payload: unknown, log: (msg: string) => void): void {
  const send = (): void => {
    const w = mainWindow();
    if (!w) return void setTimeout(send, 500);
    const go = () => w.webContents.send(channel, payload);
    // the page's listener mounts with the app: give a page still loading time to get there
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => setTimeout(go, 1500));
    else go();
  };
  try { send(); } catch (e) { log(`deep link: couldn't reach the window: ${String(e)}`); }
}

/** The app forward on Settings › Cloud (once its page has loaded), where the account shows how the link went. */
function showCloudSettings(log: (msg: string) => void): void {
  sendToWindow('appubot:navigate', { to: 'settings', id: 'cloud' }, log);
}

export function handle(url: string, log: (msg: string) => void): void {
  log(`deep link: ${url.split('?')[0]}`);
  if (app.isReady()) showMainWindow();
  const apps = parseAppsLink(url);
  if (apps) {
    if (app.isReady()) sendToWindow('appubot:appsSignedIn', apps, log);
    else void app.whenReady().then(() => sendToWindow('appubot:appsSignedIn', apps, log));
    return;
  }
  // only a well-formed cloud link goes on to the core (cloudLinks.ts, which keeps it until the core is up)
  if (!parseCloudLink(url) || !handleCloudLink(url, log)) return;
  if (app.isReady()) showCloudSettings(log);
  else void app.whenReady().then(() => showCloudSettings(log));
}

export function registerDeepLinks(log: (msg: string) => void): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('appubot', process.execPath, [process.argv[1]!]);
  } else {
    app.setAsDefaultProtocolClient('appubot');
  }
  app.on('open-url', (e, url) => {
    e.preventDefault();
    handle(url, log);
  });
  // Windows and Linux: the link starts a second instance, which hands its argv over and quits
  if (process.platform !== 'darwin') {
    app.on('second-instance', (_e, argv) => {
      const url = argv.find((a) => a.startsWith('appubot://'));
      if (url) handle(url, log);
    });
    const first = process.argv.find((a) => a.startsWith('appubot://'));
    if (first) handle(first, log);
  }
}
