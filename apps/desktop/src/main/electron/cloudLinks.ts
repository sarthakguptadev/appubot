/**
 * The `appubot://cloud/*` deep links, for `electron/deeplinks.ts` to hand over:
 *  - `appubot://cloud/signed-in?code=…&state=…` (or `?error=…`): the browser sign-in came back; the core swaps the
 *    code for a session (`cloudAccount.finishSignIn`) and the window hears `cloudAccount.updated`.
 *  - `appubot://cloud/checkout-done?status=…`: Dodo's return page; the core reads the account again.
 *  - `appubot://cloud/invite?token=…`: a team invite's link; the core reads the account again (the invite shows there).
 * A link that arrives before the core is up waits for it (`setCore`). Returns whether the link was a cloud one.
 */
import { CLOUD_CHECKOUT_DONE_LINK, CLOUD_SIGNED_IN_LINK } from '@appubot/protocol';
import { parseSignedInLink } from '@appubot/client';
import type { Core } from '../core/app';

let core: Core | null = null;
let waiting: string[] = [];

export function setCloudLinksCore(c: Core | null): void {
  core = c;
  if (!c) return;
  const links = waiting;
  waiting = [];
  for (const l of links) void handleCloudLink(l);
}

/** True when `url` is a cloud link (handled here, or kept until the core is up); false for any other link. */
export function handleCloudLink(url: string, log: (m: string) => void = () => undefined): boolean {
  const isSignedIn = url.startsWith(CLOUD_SIGNED_IN_LINK);
  const isCheckout = url.startsWith(CLOUD_CHECKOUT_DONE_LINK);
  // a team invite (§6.11): read the account again; the window lists it with Join / Decline (never joined by the link alone)
  const isInvite = url.startsWith('appubot://cloud/invite');
  if (!isSignedIn && !isCheckout && !isInvite) return false;
  if (!core) { waiting.push(url); return true; }
  const acc = core.services.cloudAccount;
  if (isSignedIn) {
    const p = parseSignedInLink(url);
    const error = (() => { try { return new URL(url).searchParams.get('error') ?? undefined; } catch { return undefined; } })();
    acc.finishSignIn(p ? { ...p } : { error: error ?? 'no code came back' }).then(
      () => log('cloud: signed in from the browser'),
      (e: unknown) => log(`cloud: sign-in link failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  } else {
    void (isCheckout ? acc.afterCheckout() : acc.refresh()).catch(() => undefined);
  }
  return true;
}
