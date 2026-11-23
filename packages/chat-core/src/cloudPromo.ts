/**
 * The sidebar's cloud card (2026-11-07): a small card above Settings and Connect apps for people without a cloud
 * computer (`eligible`), opening Settings › Billing's plan cards. It comes back for them (the owner's calls,
 * 2026-11-17: "show the cloud promo always", then "allow to dismiss it for 24 hrs"): its ✕ puts it away for
 * `CLOUD_PROMO_SNOOZE_MS` only (a dismissal for good saved on 2026-11-11 is ignored), and it no longer makes way for
 * What's new's card, which sits above it.
 */
import { trialCtaYour, trialFree, trialTry } from './paywall';

export const CLOUD_PROMO = {
  eyebrow: 'AppuBot Cloud',
  title: 'Keep your bots working 24/7',
  line: 'A computer in the cloud for your bots, on even when this one sleeps.',
  cta: 'See plans',
} as const;

/**
 * What the card's link says: "Try free for 3 days" while this person's first plan starts with a free trial
 * (`trialDaysOf`), else "See plans"; and the price beside it ("· then from $19/mo" / "· from $19/mo").
 */
export const cloudPromoCta = (trialDays: number): string => (trialDays > 0 ? trialTry(trialDays) : CLOUD_PROMO.cta);
export const cloudPromoFrom = (trialDays: number, cheapest: string): string => `${trialDays > 0 ? 'then ' : ''}from ${cheapest}/mo`;

/** how long the card's ✕ puts it away: a day */
export const CLOUD_PROMO_SNOOZE_MS = 24 * 60 * 60 * 1000;

/** `snoozedUntil`: when a ✕ put away ends (0 or missing: not put away). */
export function cloudPromoShows(s: { eligible: boolean; loaded: boolean; snoozedUntil?: number; now?: number }): boolean {
  if (!s.eligible || !s.loaded) return false;
  return !s.snoozedUntil || (s.now ?? Date.now()) >= s.snoozedUntil;
}

/**
 * Setup's cloud offer (desktop onboarding): what an AppuBot computer gives, for people without one. `{machine}` is
 * "Mac" / "PC" / "computer". The Claude line is the launch bonus (it may change or end, so it never names an amount).
 */
export const CLOUD_ONBOARDING = {
  eyebrow: 'AppuBot Cloud',
  title: 'Keep your bots working 24/7',
  body: 'Give them a computer of their own in the cloud. Nothing to set up, and your {machine} can sleep.',
  points: [
    { id: 'always', title: 'Always on', line: 'Routines, Telegram and long tasks keep going with your {machine} shut.' },
    { id: 'screen', title: 'A screen of their own', line: 'Bots use apps on their computer while you use yours. Watch or take over from here or your phone.' },
    { id: 'claude', title: 'Claude included', line: 'Launch offer: every plan comes with a Claude allowance, so bots work without your own account.' },
  ],
  cta: 'See plans',
  later: 'Maybe later',
} as const;

/** the step's button: "Start your 3-day free trial" while a trial is on offer, else "See plans" (either opens the plan cards) */
export const cloudOnboardingCta = (trialDays: number): string => (trialDays > 0 ? trialCtaYour(trialDays) : CLOUD_ONBOARDING.cta);
/** the line under the step: "3 days free, then plans from $19/mo. Cancel anytime." / "Plans from $19/mo" */
export const cloudOnboardingNote = (trialDays: number, cheapest: string): string => (trialDays > 0 ? `${trialFree(trialDays)}, then plans from ${cheapest}/mo. Cancel anytime.` : `Plans from ${cheapest}/mo`);

/** "{machine}" filled in */
export const withMachine = (text: string, machine: string): string => text.replaceAll('{machine}', machine);

/**
 * Setup's second screen (desktop onboarding, 2026-11-14, after the phone's Home › "Give your bots a computer"): where
 * the bots work. The cloud computer is the one main action, a card with what it gives and the screen's only filled
 * button; this computer is the quiet link under it. `{machine}` as above.
 */
export const SETUP_COMPUTER = {
  title: 'Give your bots a computer',
  body: 'Bots work on a computer, and you talk to them from here and your phone. Pick where they work.',
  cloud: {
    title: 'A cloud computer',
    line: 'A computer of their own, always on. Nothing to set up.',
    tag: 'Recommended',
  },
  own: 'Use this {machine} instead',
  have: 'I already have a cloud computer',
} as const;

/** under the card's button: "Nothing is charged for 3 days. Cancel anytime." / "Cancel anytime." */
export const setupTrialTerms = (trialDays: number): string => (trialDays > 0 ? `Nothing is charged for ${trialDays} day${trialDays === 1 ? '' : 's'}. Cancel anytime.` : 'Cancel anytime.');
/** beside it, the price: "Then plans from $19/mo" / "Plans from $19/mo" */
export const setupFrom = (trialDays: number, cheapest: string): string => `${trialDays > 0 ? 'Then plans' : 'Plans'} from ${cheapest}/mo`;

/** The end of setting up this computer: the cloud computer, offered once more in one line. */
export const SETUP_LATER = {
  line: 'Want them working with your {machine} shut? A cloud computer keeps them going.',
} as const;
