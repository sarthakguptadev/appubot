import { useEffect, useRef, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { SETUP_COMPUTER, setupTrialTerms, withMachine } from '@appubot/chat-core';
import { ArrowRight, Check, Cloud, ExternalLink, type IconComponent } from '../../components/ui/icons';
import { Button, Icon, Spinner } from '../../components/ui';
import { MACHINE, THIS_MACHINE } from '../../lib/platform';
import { buyCloud, loadCloud, signInToCloud, useCloud } from '../cloud/cloudAccount';
import { SOLD_OUT_TEXT } from '../cloud/names';
import type { PlanPick } from './PlansStep';
import type { CloudStage } from './setupFlow';
import { StepShell } from './StepShell';

/** how often the account is read while the browser has the sign-in or the checkout, or the computer is being made */
const WATCH_MS = 4000;
/** a computer that turned ready while this screen waited opens by itself, after a moment to read that it is */
const OPEN_AFTER_MS = 1100;

function Mark({ icon, tone = 'accent', spin }: { icon?: IconComponent; tone?: 'accent' | 'success' | 'quiet'; spin?: boolean }) {
  const look = tone === 'success' ? 'bg-success-soft text-success' : tone === 'quiet' ? 'bg-surface-3 text-fg-2' : 'bg-accent-soft text-accent';
  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4, ease: [0.25, 1, 0.5, 1] }}
      className={`mb-6 flex size-16 items-center justify-center rounded-[20px] ${look}`}
    >
      {spin ? <Spinner size={24} /> : icon ? <Icon icon={icon} size={28} /> : null}
    </motion.span>
  );
}

interface Screen { mark: ReactNode; title: string; body: ReactNode; note?: string; primary?: ReactNode; second?: ReactNode; /** a quiet link under the note: the way on with this computer, where the footer's buttons are taken */ quiet?: boolean }

/**
 * Setup's cloud path after a plan is picked: the browser has the sign-in, then the checkout, then the computer is
 * made and opened. One screen that says where things stand and moves on by itself as the account changes (the Mac's
 * `cloudAccount.updated`, plus a read every few seconds while it waits), with the way to open the browser's page
 * again and, always, the way on with this computer instead.
 */
export function CloudSetupStep({ stage, pick, trialDays, opening, onOpen, onPlans, onOwn, onBack }: {
  stage: CloudStage;
  /** the plan picked on the screen before (none after a relaunch, or for someone who came to sign in) */
  pick: PlanPick | null;
  trialDays: number;
  opening: boolean;
  onOpen: (team?: string) => void;
  onPlans: () => void;
  onOwn: () => void;
  onBack: () => void;
}) {
  const busy = useCloud((s) => s.busy);
  const waiting = stage.kind === 'loading' || stage.kind === 'sign-in' || stage.kind === 'making' || (stage.kind === 'plans' && !!pick);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') void loadCloud(true); }, WATCH_MS);
    return () => clearInterval(t);
  }, [waiting]);

  // it turned ready while this screen was waiting for it: open it
  const waited = useRef(false);
  if (stage.kind === 'making' || (stage.kind === 'plans' && pick)) waited.current = true;
  const ready = stage.kind === 'ready' ? stage : null;
  useEffect(() => {
    if (!ready || !waited.current) return;
    const t = setTimeout(() => onOpen(ready.team), OPEN_AFTER_MS);
    return () => clearTimeout(t);
    // `onOpen` is the caller's latest; the computer is what this follows
  }, [ready?.team, ready?.name]);

  const own = withMachine(SETUP_COMPUTER.own, MACHINE);
  const useOwn = <Button size="lg" variant="ghost" onClick={onOwn}>{own}</Button>;
  const screen = ((): Screen => {
    switch (stage.kind) {
      case 'loading':
        return { mark: <Mark spin />, title: 'Reading your account', body: 'One moment.', second: useOwn };
      case 'sign-in':
        return {
          mark: <Mark icon={ExternalLink} />,
          title: 'Sign in in your browser',
          body: 'The sign-in page is open in your browser. Sign in there and come back: this screen carries on by itself.',
          primary: <Button size="lg" variant="primary" loading={!!busy.signIn} onClick={() => void signInToCloud()}>Open the page again</Button>,
          second: useOwn,
        };
      case 'plans':
        return pick ? {
          mark: <Mark icon={ExternalLink} />,
          title: 'Finish in your browser',
          body: 'The checkout is open in your browser. Once it is done, your cloud computer is set up and this screen carries on by itself.',
          note: setupTrialTerms(trialDays),
          primary: <Button size="lg" variant="primary" loading={!!busy.checkout} onClick={() => void buyCloud(pick.plan, pick.interval, pick.members)}>Open the checkout again</Button>,
          second: <Button size="lg" variant="ghost" onClick={onPlans}>Pick another plan</Button>,
          quiet: true,
        } : {
          mark: <Mark icon={Cloud} tone="quiet" />,
          title: 'No cloud computer here yet',
          body: stage.invites.length ? 'This account has no cloud computer yet, but a team has invited you. The plans have it.' : 'This account has no cloud computer yet. Pick a plan to get one.',
          primary: <Button size="lg" variant="primary" iconRight={ArrowRight} onClick={onPlans} autoFocus>See plans</Button>,
          second: useOwn,
        };
      case 'making':
        return {
          mark: <Mark spin />,
          title: 'Setting up your cloud computer',
          body: stage.line || 'This takes a few minutes.',
          note: `You can wait here, or set up ${THIS_MACHINE} meanwhile: your cloud computer is in the sidebar’s computer menu once it is ready.`,
          // paid for and on its way: this computer is as well, not instead
          second: <Button size="lg" variant="ghost" onClick={onOwn}>{`Set up ${THIS_MACHINE} meanwhile`}</Button>,
        };
      case 'ready':
        return {
          mark: <Mark icon={Check} tone="success" />,
          title: `${stage.name} is ready`,
          body: `Your bots work there, day and night, with Claude included. You can set up ${THIS_MACHINE} too, any time, from the computer menu.`,
          primary: <Button size="lg" variant="primary" iconRight={ArrowRight} loading={opening} onClick={() => onOpen(stage.team)} autoFocus>Open it</Button>,
        };
      case 'held':
        return {
          mark: <Mark icon={Cloud} tone="quiet" />,
          title: stage.label,
          body: stage.line,
          note: 'Billing has what to do, in Settings once setup is done.',
          primary: <Button size="lg" variant="primary" iconRight={ArrowRight} onClick={onOwn} autoFocus>{`Set up ${THIS_MACHINE} for now`}</Button>,
        };
      case 'sold-out':
        return {
          mark: <Mark icon={Cloud} tone="quiet" />,
          title: 'Sold out for now',
          body: SOLD_OUT_TEXT,
          primary: <Button size="lg" variant="primary" iconRight={ArrowRight} onClick={onOwn} autoFocus>{`Set up ${THIS_MACHINE}`}</Button>,
        };
    }
  })();

  return (
    <StepShell
      hero={screen.mark}
      title={screen.title}
      body={screen.body}
      width="sm"
      onBack={opening ? undefined : onBack}
      actions={<>{screen.second}{screen.primary}</>}
    >
      {screen.note ? <p className="text-center text-ui leading-relaxed text-balance text-muted">{screen.note}</p> : null}
      {screen.quiet ? (
        <button type="button" onClick={onOwn} className="ab-pill squircle no-drag mx-auto mt-3 block rounded-control-sm px-3 py-1.5 text-ui text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]">
          {own}
        </button>
      ) : null}
    </StepShell>
  );
}
