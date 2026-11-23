/**
 * First-run setup's shape (pure): which steps there are, in which order, on which path, and where the person stands
 * with the cloud computer. Setup asks one thing early, where the bots work: a cloud computer (the main choice: plans,
 * the browser's sign-in and checkout, then the computer itself) or this one (the agents its bots run on, permissions,
 * a phone, and done). The phone app lays the same choice out the same way (Home › "Give your bots a computer").
 */
import type { CloudAccountView } from '@appubot/protocol';
import { computerDisplayName } from '@appubot/chat-core';
import { canWork, cloudPhase, hasComputer, ownComputerName, phaseWords, teamAsView } from '../cloud/cloudView';

export type OnboardingStep = 'welcome' | 'computer' | 'plans' | 'cloud' | 'agents' | 'permissions' | 'pair' | 'follow' | 'done';
/** the two ways through setup after the choice */
export type SetupPath = 'cloud' | 'local';

const CLOUD_STEPS: readonly OnboardingStep[] = ['plans', 'cloud'];

/** The path a step belongs to (none: the steps before the choice). */
export function pathOf(step: OnboardingStep): SetupPath | null {
  if (step === 'welcome' || step === 'computer') return null;
  return CLOUD_STEPS.includes(step) ? 'cloud' : 'local';
}

/**
 * The steps of one path, in order. `offer`: the cloud computer can be had here (else there is no choice to make and
 * setup is this computer's alone). `permissions`: this computer has a permissions step (computer use exists on it).
 */
export function stepsFor(path: SetupPath | null, o: { offer: boolean; permissions: boolean }): OnboardingStep[] {
  const local: OnboardingStep[] = ['agents', ...(o.permissions ? ['permissions' as const] : []), 'pair', 'follow', 'done'];
  if (!o.offer) return ['welcome', ...local];
  return ['welcome', 'computer', ...(path === 'cloud' ? CLOUD_STEPS : local)];
}

/** A step saved from before (a relaunch mid-setup, an older version's `cloud` pitch) that still exists on some path. */
export function knownStep(saved: string | null, o: { offer: boolean; permissions: boolean }): OnboardingStep {
  const all = new Set<string>([...stepsFor('cloud', o), ...stepsFor('local', o)]);
  return saved && all.has(saved) ? (saved as OnboardingStep) : 'welcome';
}

/** Where the person stands with a cloud computer, as setup's cloud steps show it. */
export type CloudStage =
  /** the account hasn't been read yet */
  | { kind: 'loading' }
  /** signed out: the browser's sign-in comes first */
  | { kind: 'sign-in' }
  /** signed in with nothing to open: a plan to pick (and any team that invited them) */
  | { kind: 'plans'; invites: { id: string; teamName: string }[] }
  /** no plan and sign-ups are closed */
  | { kind: 'sold-out' }
  /** paid for, being set up */
  | { kind: 'making'; line: string }
  /** a computer to open: their own first, else a team's */
  | { kind: 'ready'; team?: string; name: string }
  /** theirs, but it can't be opened (payment on hold, a review, a plan that ended): what to do is in Billing */
  | { kind: 'held'; label: string; line: string };

export function cloudStage(v: CloudAccountView | null | undefined, now = Date.now()): CloudStage {
  if (!v) return { kind: 'loading' };
  if (!v.signedIn) return { kind: 'sign-in' };
  const phase = cloudPhase(v);
  if (hasComputer(v) && canWork(phase)) return { kind: 'ready', name: ownComputerName(v) };
  if (phase === 'provisioning') return { kind: 'making', line: phaseWords(phase, v, now).line };
  // a team's computer that works is somewhere to go, whatever their own plan's state
  const teams = (v.teams ?? []).map((t) => ({ t, tv: teamAsView(v, t) }));
  const team = teams.find(({ tv }) => hasComputer(tv) && canWork(cloudPhase(tv)));
  if (team) return { kind: 'ready', team: team.t.team.id, name: computerDisplayName({ team: team.t.team.name }) };
  // a team just bought here: its computer is being set up
  const making = teams.find(({ tv }) => cloudPhase(tv) === 'provisioning');
  if (making) return { kind: 'making', line: phaseWords('provisioning', making.tv, now).line };
  if (phase === 'no-plan' || phase === 'sold-out') {
    const invites = (v.account?.invites ?? []).filter((i) => i.expiresAt > now).map((i) => ({ id: i.id, teamName: i.teamName }));
    return phase === 'sold-out' && !invites.length ? { kind: 'sold-out' } : { kind: 'plans', invites };
  }
  const w = phaseWords(phase, v, now);
  return { kind: 'held', label: w.label, line: w.line };
}

/**
 * Whether setup offers the cloud computer at all: not where this AppuBot has no cloud account (an older core), and
 * not while sign-ups are closed for someone with nothing to open. Offered while the account is still being read.
 */
export function cloudOffered(supported: boolean | null, v: CloudAccountView | null | undefined): boolean {
  if (supported === false) return false;
  if (!v) return true;
  return cloudStage(v).kind !== 'sold-out';
}
