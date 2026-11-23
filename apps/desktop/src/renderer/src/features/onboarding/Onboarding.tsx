import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cloudCacheKey, trialDaysOf } from '@appubot/chat-core';
import { Logo, cn } from '../../components/ui';
import { call } from '../../lib/actions';
import { activeComputer, localGateway } from '../../lib/gateway';
import { COMPUTER_USE, IS_MAC } from '../../lib/platform';
import { setState } from '../../lib/store';
import { signInToCloud, useCloud } from '../cloud/cloudAccount';
import { switchComputer } from '../cloud/cloudClient';
import { markCloudWelcomed } from '../cloud/CloudWelcome';
import { markWhatsNewSeen } from '../whatsNew/WhatsNew';
import { AgentsStep } from './AgentsStep';
import { CloudSetupStep } from './CloudSetupStep';
import { ComputerStep } from './ComputerStep';
import { DoneStep } from './DoneStep';
import { FollowStep } from './FollowStep';
import { PairStep } from './PairStep';
import { PermissionsStep } from './PermissionsStep';
import { PlansStep, type PlanPick } from './PlansStep';
import { cloudOffered, cloudStage, knownStep, pathOf, stepsFor, type OnboardingStep } from './setupFlow';
import { Welcome } from './Welcome';
import { EASE_OUT } from '../../lib/motion';

export type { OnboardingStep };

/** every step in one order, for which way a move slides */
const ORDER: readonly OnboardingStep[] = ['welcome', 'computer', 'plans', 'cloud', 'agents', 'permissions', 'pair', 'follow', 'done'];

/**
 * Where setup was: granting Screen Recording makes macOS offer to reopen AppuBot, and a checkout in the browser may
 * outlast a quit; setup carries on from the same step. Cleared when setup finishes. `?step=` picks one in a preview
 * (the renderer mock: `?onboarding=1&step=computer`, with `&cloud=<state>` for the account).
 */
const STEP_KEY = 'appubot:onboardingStep';
const PREVIEW_STEP = (import.meta.env.DEV || import.meta.env.VITE_APPUBOT_MOCK === '1') && typeof location !== 'undefined' ? new URLSearchParams(location.search).get('step') : null;
/** a preview of the cloud path's waiting screen as if a plan had just been picked (`&picked=1`) */
const PREVIEW_PICK: PlanPick | null = PREVIEW_STEP && typeof location !== 'undefined' && new URLSearchParams(location.search).get('picked') ? { plan: 'pro', interval: 'monthly' } : null;

function savedStep(): string | null {
  if (PREVIEW_STEP) return PREVIEW_STEP;
  try { return localStorage.getItem(STEP_KEY); } catch { return null; }
}

const LOGO_LEFT = IS_MAC ? 'left-[97px]' : 'left-5';
/** a step slides in from the side it comes from, a little, and fades */
const SLIDE = {
  enter: (dir: number) => ({ opacity: 0, x: 24 * dir }),
  center: { opacity: 1, x: 0, transition: { duration: 0.45, ease: EASE_OUT } },
  exit: (dir: number) => ({ opacity: 0, x: -16 * dir, transition: { duration: 0.18, ease: [0.4, 0, 1, 1] as const } }),
};

/**
 * First-run setup, one step at a time. Welcome, then where the bots work (`ComputerStep`): a cloud computer, the main
 * choice (the plans, the browser's sign-in and checkout, the computer being made, then the app opens on it), or this
 * computer (the AI its bots run on, permissions, a phone, X, done). Back on every step, a progress bar once a path is
 * taken, the footer's actions in the same place on each. Finishing on this computer saves `onboarded`, which makes
 * its first bot greet and counts `onboarding_completed`; finishing on the cloud computer puts it on screen (its own
 * first bot greets there: App.tsx) and marks this one set up too, so it is ready whenever it is picked.
 */
export function Onboarding() {
  const view = useCloud((s) => s.view);
  const supported = useCloud((s) => s.supported);
  const stage = cloudStage(view);
  const [step, setStep] = useState<OnboardingStep>(() => knownStep(savedStep(), { offer: true, permissions: COMPUTER_USE }));
  const [dir, setDir] = useState(1);
  const [finishing, setFinishing] = useState(false);
  const [opening, setOpening] = useState(false);
  const [pick, setPick] = useState<PlanPick | null>(PREVIEW_PICK);
  // the step on screen stays in the list, so the account arriving never pulls it away
  const offer = cloudOffered(supported, view) || step === 'computer' || pathOf(step) === 'cloud';
  const steps = useMemo(() => stepsFor(pathOf(step), { offer, permissions: COMPUTER_USE }), [step, offer]);
  // a new install starts on this version's notes: only later updates are announced
  useEffect(markWhatsNewSeen, []);
  useEffect(() => { try { localStorage.setItem(STEP_KEY, step); } catch { /* no storage */ } }, [step]);

  const goTo = (to: OnboardingStep) => {
    setDir(ORDER.indexOf(to) >= ORDER.indexOf(step) ? 1 : -1);
    setStep(to);
  };
  const i = steps.indexOf(step);
  const next = () => goTo(steps[Math.min(steps.length - 1, i + 1)]!);
  const back = () => goTo(steps[Math.max(0, i - 1)]!);
  /** the first step of setting this computer up */
  const own = () => goTo('agents');
  /** onto the cloud path: straight to the computer when there is one (or one on its way), else the plans */
  const cloud = () => goTo(stage.kind === 'ready' || stage.kind === 'making' || stage.kind === 'held' ? 'cloud' : 'plans');

  const finish = async (): Promise<boolean> => {
    setFinishing(true);
    const s = await call('settings.update', { onboarded: true }, { errorTitle: 'Could not save' });
    setFinishing(false);
    if (!s) return false;
    try { localStorage.removeItem(STEP_KEY); } catch { /* no storage */ }
    setState({ settings: s });
    return true;
  };

  // the cloud computer on screen ends setup (App.tsx shows the app for it); this computer is marked set up as well
  const openCloud = async (team?: string): Promise<void> => {
    if (opening) return;
    setOpening(true);
    // its first-visit screen explains it beside this computer's bots ("nothing here changed", Transfer): someone who
    // took it in setup has none here, and its own first bot says hello
    markCloudWelcomed(cloudCacheKey(team));
    await switchComputer('cloud', team);
    if (activeComputer() === 'cloud') {
      try { localStorage.removeItem(STEP_KEY); } catch { /* no storage */ }
      void localGateway().call('settings.update', { onboarded: true }).catch(() => undefined);
    }
    setOpening(false);
  };

  const cheapest = useMemo(() => (view?.catalog?.plans ?? [])
    .map((p) => p.monthly)
    .filter((p): p is NonNullable<typeof p> => !!p)
    .sort((a, b) => a.amount - b.amount)[0]?.display, [view]);
  // a first plan starts with the free trial: the buttons and the lines under them say so
  const trialDays = trialDaysOf(view?.catalog, view?.signedIn ? (view.account ?? {}) : null);
  const onPath = pathOf(step) !== null;

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-content">
      <div className="drag relative flex h-16 shrink-0 items-center justify-center">
        {step !== 'welcome' ? (
          // beside macOS's traffic lights; Windows and Linux have their window buttons on the right
          <div className={cn('absolute top-5', LOGO_LEFT)}><Logo size={24} /></div>
        ) : null}
        {/* the steps of the path taken: before the choice there is no telling how many */}
        {onPath || (!offer && step !== 'welcome') ? <Progress at={i} of={steps.length - 1} /> : null}
      </div>
      <AnimatePresence mode="wait" custom={dir} initial={false}>
        <motion.div
          key={step} custom={dir} variants={SLIDE} initial="enter" animate="center" exit="exit"
          className="flex min-h-0 flex-1 flex-col"
        >
          {step === 'welcome' ? <Welcome onNext={next} /> : null}
          {step === 'computer' ? (
            <ComputerStep
              stage={stage} trialDays={trialDays} cheapest={cheapest}
              onCloud={cloud} onOwn={own} onBack={back}
              onHave={stage.kind === 'sign-in' ? () => { void signInToCloud(); goTo('cloud'); } : undefined}
            />
          ) : null}
          {step === 'plans' ? <PlansStep stage={stage} onPicked={(p) => { setPick(p); goTo('cloud'); }} onOwn={own} onBack={back} /> : null}
          {step === 'cloud' ? (
            <CloudSetupStep
              stage={stage} pick={pick} trialDays={trialDays} opening={opening}
              onOpen={(team) => void openCloud(team)} onPlans={() => goTo('plans')} onOwn={own}
              // back to the plans a plan was picked on; anything else was reached from the choice (a computer that is
              // there already, "I already have one")
              onBack={() => goTo(pick && (stage.kind === 'sign-in' || stage.kind === 'plans' || stage.kind === 'loading') ? 'plans' : 'computer')}
            />
          ) : null}
          {step === 'agents' ? <AgentsStep onNext={next} onBack={back} /> : null}
          {step === 'permissions' ? <PermissionsStep onNext={next} onBack={back} /> : null}
          {step === 'pair' ? <PairStep onNext={next} onBack={back} /> : null}
          {step === 'follow' ? <FollowStep onNext={next} onBack={back} /> : null}
          {step === 'done' ? (
            <DoneStep
              onBack={back} onFinish={finish} finishing={finishing}
              // the cloud computer once more, in a line, for someone who has none
              onCloud={offer && (stage.kind === 'sign-in' || stage.kind === 'plans' || stage.kind === 'loading') ? cloud : undefined}
              trialDays={trialDays}
            />
          ) : null}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** Steps after the welcome as segments, filled up to this one. */
function Progress({ at, of }: { at: number; of: number }) {
  return (
    <div className="flex items-center gap-1.5" role="progressbar" aria-valuemin={1} aria-valuemax={of} aria-valuenow={at} aria-label={`Step ${at} of ${of}`}>
      {Array.from({ length: of }, (_, k) => (
        <span key={k} className="h-[3px] w-7 overflow-hidden rounded-full bg-surface-3">
          <span className={cn('block h-full origin-left rounded-full bg-fg transition-transform duration-500 ease-reveal', k < at ? 'scale-x-100' : 'scale-x-0')} />
        </span>
      ))}
    </div>
  );
}
