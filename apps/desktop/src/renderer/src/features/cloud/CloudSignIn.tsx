import { useEffect, useState } from 'react';
import { LogIn } from '../../components/ui/icons';
import { Button, SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, cn } from '../../components/ui';
import { ACCOUNT_YOU_TITLE, settingAnchorId } from '../settings/nav';
import { signInToCloud, useCloud } from './cloudAccount';

/** The row's search anchor (Settings › Account while signed out). */
const ANCHOR = settingAnchorId(ACCOUNT_YOU_TITLE);

/**
 * Signing in to AppuBot (plan §6.5): the browser opens account.appubot.com/sign-in (Google, Apple, or an email and
 * a password) and comes back to AppuBot by itself (`appubot://cloud/signed-in`). Meanwhile the row says it is waiting;
 * the free product never needs this. Settings › Account shows it in place of the person, and Billing under the plan.
 */
export function CloudSignIn({ className, description }: { className?: string; description?: string }) {
  const busy = useCloud((s) => !!s.busy.signIn);
  const error = useCloud((s) => s.view?.error);
  const [clicked, setWaiting] = useState(false);
  // the Mac says when a sign-in is waiting for the browser (also one started before this page opened)
  const waiting = useCloud((s) => !!s.view?.signingIn) || clicked;
  // the browser may take a while (a new account verifies its email): the button comes back after a few minutes, or on sign-in
  useEffect(() => {
    if (!clicked) return;
    const t = setTimeout(() => setWaiting(false), 5 * 60_000);
    return () => clearTimeout(t);
  }, [clicked]);
  const signedIn = useCloud((s) => !!s.view?.signedIn);
  useEffect(() => { if (signedIn) setWaiting(false); }, [signedIn]);

  return (
    <div id={ANCHOR} className={cn(SETTINGS_ROW, 'flex scroll-mt-24 flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8', className)}>
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className={SETTINGS_ROW_TITLE}>{waiting ? 'Finish signing in in your browser' : 'Sign in to AppuBot'}</h3>
        <p className={SETTINGS_ROW_DESCRIPTION}>
          {waiting
            ? 'Continue with Google, Apple or your email there. AppuBot comes back here by itself.'
            : description ?? 'With Google, Apple or your email, in your browser. Bots on this computer never need an account.'}
        </p>
        {error && !waiting ? <p className="selectable text-note leading-normal text-danger">{error}</p> : null}
      </div>
      <Button
        size="sm"
        variant={waiting ? 'outline' : 'primary'}
        icon={LogIn}
        loading={busy}
        onClick={async () => { const r = await signInToCloud(); if (r) setWaiting(true); }}
      >
        {waiting ? 'Open again' : 'Sign in'}
      </Button>
    </div>
  );
}
