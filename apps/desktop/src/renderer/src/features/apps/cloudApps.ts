/**
 * Apps while the window shows the user's AppuBot Cloud computer (features/cloud). The cloud's own browser is on a
 * desktop nobody is looking at, so every Composio page opens here, in this computer's browser, the way the phone does
 * it (CLAUDE.md "Apps"):
 *
 * - sign-in: `apps.signIn {redirectUri: APPS_SIGNED_IN_LINK}` on the cloud, which keeps the PKCE state and answers the
 *   page to open (`url`); the browser comes back to `appubot://apps/signed-in`, main checks the link
 *   (`electron/deeplinks.ts` `parseAppsLink`) and hands it here (`onAppsSignedIn`), and it goes to the cloud's client
 *   with `apps.finishSignIn`, never this Mac's;
 * - connecting one app: `apps.connect {open: 'caller'}`; its link page opens here while the cloud watches the account
 *   and reports with `apps.updated`, and AppuBot comes back to the front once that sign-in has ended.
 *
 * The tokens stay on the cloud computer (its bots use them). This Mac's own Apps (local) keep the loopback sign-in and
 * the computer opening its own browser, unchanged.
 */
import { APPS_SIGNED_IN_LINK, type AppToolkit } from '@appubot/protocol';
import { activeComputer, cloudGateway, errorMessage, rpc, type GatewayLike } from '../../lib/gateway';
import { native } from '../../lib/native';
import { pushToast, setState, useStore } from '../../lib/store';

/** a sign-in or link page left open longer than Composio keeps it (10 minutes) stops being watched */
const WATCH_MS = 11 * 60_000;
/** how long a sign-in coming back waits for the cloud's connection (it may have closed while the browser was up) */
const CONNECT_WAIT_MS = 90_000;

/** The window shows the cloud computer, so Apps act there. */
export function onCloud(): boolean {
  return activeComputer() === 'cloud';
}

/** An app's sign-in that was in progress (`pending`) has ended, one way or another. */
export function signInEnded(prev: readonly string[] | undefined, next: readonly string[] | undefined, slug: string): boolean {
  return !!prev?.includes(slug) && !next?.includes(slug);
}

let listening = false;

/** Takes the Composio sign-ins that come back to `appubot://apps/signed-in` (once per window). */
export function listenForAppsSignIn(): void {
  if (listening) return;
  listening = true;
  native().onAppsSignedIn((back) => { void finishCloudSignIn(back); });
}

/** Starts the Composio sign-in for the cloud computer, in this computer's browser. */
export async function startCloudSignIn(): Promise<void> {
  listenForAppsSignIn();
  try {
    const { url, ...status } = await rpc('apps.signIn', { redirectUri: APPS_SIGNED_IN_LINK });
    setState({ apps: status });
    if (url) await native().openExternal(url);
  } catch (e) {
    pushToast({ title: "Couldn't start the Composio sign-in", body: errorMessage(e), level: 'error' });
  }
}

/** Waits until `client` has said hello, opening it if it is closed. */
function connected(client: GatewayLike, ms = CONNECT_WAIT_MS): Promise<void> {
  if (client.state === 'connected') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('Your AppuBot computer didn’t answer in time.')); }, ms);
    const off = client.onState((st, err) => {
      if (st === 'connected') { clearTimeout(timer); off(); resolve(); }
      else if (st === 'unauthorized' || st === 'incompatible') { clearTimeout(timer); off(); reject(new Error(err ?? 'Your AppuBot computer refused this computer.')); }
    });
    // listening first: a state that changes at once isn't missed
    if (client.state === 'idle' || client.state === 'closed') client.connect();
  });
}

/** The browser came back from a cloud sign-in: what it brought goes to the cloud computer, which keeps the tokens. */
export async function finishCloudSignIn(back: { code?: string; state?: string; error?: string }): Promise<void> {
  const client = cloudGateway();
  if (!client) {
    pushToast({ title: 'Couldn’t finish the Composio sign-in', body: 'Open your AppuBot computer in the sidebar and sign in again.', level: 'error' });
    return;
  }
  // opened here only to hand this over: closed again unless the cloud is on screen by then (it keeps it awake)
  const wasClosed = client.state === 'idle' || client.state === 'closed';
  try {
    await connected(client);
    const r = await client.call('apps.finishSignIn', back);
    if (onCloud()) setState({ apps: r.status });
    if (r.ok) pushToast({ title: 'Signed in to Composio', body: 'The bots on your AppuBot computer can use your apps now.', level: 'success' });
    else if (!back.error) pushToast({ title: 'The Composio sign-in didn’t finish', body: r.status.error ?? 'Try again in Apps.', level: 'error' });
  } catch (e) {
    pushToast({ title: 'Couldn’t finish the Composio sign-in', body: errorMessage(e), level: 'error' });
  } finally {
    if (wasClosed && !onCloud() && client.state === 'connected') client.close();
  }
}

/**
 * Starts connecting an app on the cloud computer: Composio's link page in this computer's browser. The cloud watches
 * the account; once that sign-in has ended AppuBot comes back to the front, where the app shows as added (or a toast
 * says why not). Whether it started.
 */
export async function startCloudConnect(t: Pick<AppToolkit, 'slug' | 'name'>): Promise<boolean> {
  let redirectUrl: string | undefined;
  try {
    ({ redirectUrl } = await rpc('apps.connect', { slug: t.slug, open: 'caller' }));
  } catch (e) {
    pushToast({ title: `Couldn't connect ${t.name}`, body: errorMessage(e), level: 'error' });
    return false;
  }
  if (!redirectUrl) return true;
  const timer = setTimeout(() => stop(), WATCH_MS);
  const stop = useStore.subscribe((s, prev) => {
    if (!onCloud() || !signInEnded(prev.apps?.pending, s.apps?.pending, t.slug)) return;
    stop();
    clearTimeout(timer);
    native().showApp();
  });
  try {
    await native().openExternal(redirectUrl);
  } catch (e) {
    stop();
    clearTimeout(timer);
    pushToast({ title: `Couldn't open ${t.name}'s sign-in`, body: errorMessage(e), level: 'error' });
  }
  return true;
}
