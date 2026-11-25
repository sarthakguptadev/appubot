/**
 * AppuBot Cloud as the desktop shows it: one phase for the account and its computer (signed out, no plan, running,
 * asleep, payment on hold…), its words and badge, the plan card's lines and the quiet awake line, in chat-core's
 * terms. Pure functions over the Mac's `CloudAccountView` (protocol cloud.ts), so Settings › Cloud, the computer
 * switcher and the chat's notice all say the same thing. Prices, plan names and shapes come from the backend's
 * catalog: nothing here names one, and nothing here is a limit (plans have none).
 */
import type { CloudAccountView, CloudCredit, CloudInterval, CloudPlanId, CloudPrice, CloudTeam, CloudTeamMember, CloudTeamView, CloudWorkCatalogPlan, SystemInfo } from '@appubot/protocol';
import {
  CLOUD_ENDED_KEEP_DAYS, keepDaysText, inviteStatusText, moneyText, planTitle, priceText, scheduledChangeText,
  scheduledSeatsText, seatsText, shapeText, shortDate, computerDisplayName, teamRoleText, workPrice,
  personalPaywall as cardsPersonal, workPaywall as cardsWork, paywallIntervals as intervalsOf,
  type PaywallCard, type PaywallKind, TRIAL_BADGE,
  cloudPhase, hasComputer, teamAsView, type CloudPhase,
} from '@appubot/chat-core';
import type { BadgeTone } from '../../components/ui';
import { COMPUTER_NAME, SOLD_OUT_TEXT, YOUR_COMPUTER, YOUR_COMPUTER_CAP, exportOnlyText, onHoldText } from './names';

/** The account's phase, read the same way by the Mac's core (chat-core `cloudOnly.ts`). */
export { cloudPhase, hasComputer, canWork, teamAsView, type CloudPhase } from '@appubot/chat-core';

export interface PhaseWords { label: string; tone: BadgeTone; line: string }

/** The badge and one line for a phase ("Asleep" · "It wakes when a message or a routine needs it."). */
export function phaseWords(p: CloudPhase, v?: CloudAccountView | null, now = Date.now()): PhaseWords {
  const c = v?.computer;
  const sub = v?.account?.subscription;
  switch (p) {
    case 'unknown': return { label: 'Checking…', tone: 'neutral', line: '' };
    case 'signed-out': return { label: 'Signed out', tone: 'neutral', line: `Sign in to use ${YOUR_COMPUTER}.` };
    case 'no-plan': return { label: 'No plan', tone: 'neutral', line: 'Your bots can keep working in the cloud 24/7, even while this computer is off.' };
    case 'sold-out': return { label: 'Sold out for now', tone: 'warning', line: SOLD_OUT_TEXT };
    case 'provisioning': return { label: 'Setting up', tone: 'accent', line: c?.progress ? `${c.progress}…` : `${YOUR_COMPUTER_CAP} is being set up. This takes a few minutes.` };
    case 'running': return { label: 'Awake', tone: 'success', line: c?.computer?.resizing ? 'Awake, and being resized to your plan. A minute, at most a few.' : 'Awake and working. It goes back to sleep when nothing needs it.' };
    case 'asleep': return { label: 'Asleep', tone: 'neutral', line: 'It wakes when you open one of its bots, a message comes in or a routine is due.' };
    case 'waking': return { label: 'Waking', tone: 'accent', line: 'Waking up. This takes a few seconds.' };
    case 'stopped': return { label: 'Stopped', tone: 'neutral', line: 'It starts when you open one of its bots or a message comes in.' };
    case 'past-due': return {
      label: 'Payment failed', tone: 'warning',
      line: `The last payment didn’t go through${sub?.pastDueEndsAt ? `. Update your card by ${shortDate(sub.pastDueEndsAt, now)} to keep it running` : '. Update your card in Manage billing to keep it running'}.`,
    };
    case 'on-hold': return { label: 'Payment on hold', tone: 'danger', line: onHoldText(c?.exportUntil ?? v?.account?.exportUntil, now) };
    case 'ending': return {
      label: 'Ending', tone: 'warning',
      line: `Your plan ends${sub ? ` on ${shortDate(sub.periodEnd, now)}` : ''}. Your bots and files are kept for ${keepDaysText(CLOUD_ENDED_KEEP_DAYS)} after that, then deleted. Keep your plan in Manage billing.`,
    };
    case 'export-only': {
      const until = c?.exportUntil ?? v?.account?.exportUntil;
      return { label: 'Plan ended', tone: 'neutral', line: exportOnlyText(c?.plan?.name, until, now) };
    }
    case 'suspended': return { label: 'Suspended', tone: 'danger', line: c?.message ?? `${YOUR_COMPUTER_CAP} was stopped for a review. Write to sarthak@appubot.com and we’ll sort it out.` };
    case 'failed': return { label: 'Setting up is taking longer', tone: 'warning', line: c?.message ?? 'Setting up is taking longer than usual. We’re on it and will email you when it’s ready.' };
    case 'deleted': return { label: 'Deleted', tone: 'neutral', line: `${YOUR_COMPUTER_CAP} was deleted.` };
  }
}

/**
 * The sidebar's computer dropdown, the AppuBot computer's row: no state shown (Awake, Asleep… aren't the switcher's
 * business), only `warn` when it can't work for money or a review (its icon turns amber). Null: no dropdown at all
 * (signed out, no plan, being set up), the free app's top strip.
 */
export function computerMenuStatus(v: CloudAccountView | null | undefined): { warn: boolean } | null {
  if (!hasComputer(v)) return null;
  const p = cloudPhase(v);
  return { warn: p === 'on-hold' || p === 'suspended' };
}

export interface PlanCard {
  /** "Pro · Monthly" */
  title: string;
  /** "4 vCPU · 8 GB RAM · 20 GB disk" */
  shape: string;
  /** the instance's own size when it differs from the plan's (a downgrade keeps a larger disk), else '' */
  actualShape: string;
  /** "$49 a month" ('' without a catalog price) */
  price: string;
  /** "Renews on 3 Dec" / "Ends on 3 Dec" / "The last payment didn’t go through" / "On hold until the payment goes through" */
  billing: string;
  /** "Changes to Starter · Monthly on 3 Dec" ('' without a scheduled change) */
  scheduled: string;
  /** the plan card's billing line needs the user (a failed payment) */
  attention: boolean;
}

/** The plan card's lines (null without a subscription). */
export function planCard(v: CloudAccountView | null | undefined, phase: CloudPhase, now = Date.now()): PlanCard | null {
  const sub = v?.account?.subscription;
  if (!sub) return null;
  const plan = v?.computer?.plan;
  const name = plan?.name ?? planName(v, sub.plan);
  const shape = plan?.shape ? shapeText(plan.shape) : '';
  const actual = v?.computer?.computer?.shape;
  const differs = !!actual && !!plan?.shape && (actual.cpu !== plan.shape.cpu || actual.memory !== plan.shape.memory || actual.disk !== plan.shape.disk);
  const attention = phase === 'on-hold' || phase === 'past-due';
  const billing = phase === 'ending' ? `Ends on ${shortDate(sub.periodEnd, now)}`
    : phase === 'past-due' ? 'The last payment didn’t go through'
    : phase === 'on-hold' ? 'On hold until the payment goes through'
    : `Renews on ${shortDate(sub.periodEnd, now)}`;
  const sc = sub.scheduledChange;
  return {
    title: planTitle(name, sub.interval),
    shape,
    actualShape: differs && actual ? shapeText(actual) : '',
    price: plan?.price ? priceText(plan.price) : '',
    billing,
    scheduled: sc ? scheduledChangeText(planName(v, sc.plan), sc.interval, sc.at, now) : '',
    attention,
  };
}

/** A plan's name from the catalog (the id, capitalised, when the catalog hasn't come). */
export function planName(v: CloudAccountView | null | undefined, id: CloudPlanId): string {
  return v?.catalog?.plans.find((p) => p.id === id)?.name ?? v?.catalog?.work?.plans.find((p) => p.id === id)?.name
    ?? (v?.computer?.plan?.id === id ? v.computer.plan.name : undefined) ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

/** The plans the picker can sell at an interval (those the catalog prices), in the catalog's order. */
export function pickerPlans(v: CloudAccountView | null | undefined, interval: CloudInterval): { id: CloudPlanId; name: string; blurb: string; shape: string; price: string }[] {
  return (v?.catalog?.plans ?? []).filter((p) => p[interval]).map((p) => ({ id: p.id, name: p.name, blurb: p.blurb, shape: shapeText(p.shape), price: priceText(p[interval]!) }));
}

/** What `SystemInfo.cloud` turns off: a cloud computer is Linux in a data centre (plan §4.2). */
/** `background`: the bots always work on the computer's real screen there (it is theirs), so no "Work in the background" */
export interface CloudLacks { voice: boolean; power: boolean; permissions: boolean; teach: boolean; agentCursor: boolean; vaultCards: boolean; background: boolean }
export const NOTHING_LACKING: CloudLacks = { voice: false, power: false, permissions: false, teach: false, agentCursor: false, vaultCards: false, background: false };
export function cloudLacks(system: Pick<SystemInfo, 'cloud'> | null | undefined): CloudLacks {
  if (!system?.cloud) return NOTHING_LACKING;
  // teach mode records through its screen (live view / Open desktop), so it stays
  return { voice: true, power: true, permissions: true, teach: false, agentCursor: true, vaultCards: true, background: true };
}

// ---------------------------------------------------------------------------------------------------------------
// The paywall (Personal | Work, Monthly | Yearly, the website's cards): every price from the backend's catalog.

/** The paywall's cards come from chat-core (`paywall.ts`, the landing page's PlanCards); these read the Mac's view. */
export type { PaywallKind, PlanRow, PaywallCard, PlanMove } from '@appubot/chat-core';
export { BEST_VALUE, WORK_CREDIT_ROW, creditRowText, planMove, planMoveLabel } from '@appubot/chat-core';

/** The personal plans the catalog sells at an interval, as the website's cards (Pro is the popular one). */
export const personalPaywall = (v: CloudAccountView | null | undefined, interval: CloudInterval): PaywallCard[] => cardsPersonal(v?.catalog, interval);
/** The Work plans the catalog sells at an interval for a team of `members`. */
export const workPaywall = (v: CloudAccountView | null | undefined, interval: CloudInterval, members: number): PaywallCard[] => cardsWork(v?.catalog, interval, members);

/** The intervals the paywall can sell for a kind (the switch shows only those). */
export const paywallIntervals = (v: CloudAccountView | null | undefined, kind: PaywallKind): CloudInterval[] => intervalsOf(v?.catalog, kind);
/** The line under the cards (the website's words, with the catalog's per-member price). */
export function paywallNote(v: CloudAccountView | null | undefined, kind: PaywallKind): string {
  if (kind === 'personal') return `Paid plans run your bots in the cloud 24/7 on an ${COMPUTER_NAME} of your own, even when your laptop is closed.`;
  const w = v?.catalog?.work;
  const per = w?.plans.find((p) => p.perMember.monthly)?.perMember.monthly;
  return `One ${COMPUTER_NAME} your team shares. The plan’s price includes the first member, plus ${per ? `${per.display} for each extra member each month` : 'a price per extra member'}, for ${w?.members.min ?? 2} to ${w?.members.max ?? 30} members.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Teams: each team's shared computer reads like the person's own, through a view of its own.

/** The person has a personal plan of their own (else the paywall shows, even when they're on a team). */
export function hasPersonalPlan(v: CloudAccountView | null | undefined): boolean {
  const p = cloudPhase(v);
  return !['unknown', 'signed-out', 'no-plan', 'sold-out'].includes(p);
}

/** The team's card lines: "Team · Monthly", "3 of 5 seats used", your role, price, renewal, a scheduled change. */
export interface TeamCard {
  name: string;
  /** "Team · Monthly" ('' before a plan) */
  plan: string;
  /** "3 of 5 seats used" */
  seats: string;
  role: string;
  /** "$109 a month" (base + (seats − 1) × per member, from the catalog) */
  price: string;
  shape: string;
  billing: string;
  /** "Changes to Team · Monthly on 3 Dec" / "Seats go down to 3 on 3 Dec" */
  scheduled: string[];
  attention: boolean;
}

export function teamCard(v: CloudAccountView, t: CloudTeamView, now = Date.now()): TeamCard {
  const team = t.team;
  const tv = teamAsView(v, t);
  const phase = cloudPhase(tv);
  const card = planCard(tv, phase, now);
  const work = team.plan ? v.catalog?.work?.plans.find((p) => p.id === team.plan) : undefined;
  const interval = team.interval ?? team.subscription?.interval ?? 'monthly';
  const price = work && team.seats ? workPrice(work, team.seats, interval) : undefined;
  const scheduled: string[] = [];
  const sc = team.subscription?.scheduledChange;
  if (sc && (sc.plan !== team.plan || sc.interval !== interval)) scheduled.push(scheduledChangeText(planName(v, sc.plan), sc.interval, sc.at, now));
  const lower = team.scheduledSeats ?? sc?.seats;
  if (lower && team.seats && lower < team.seats) scheduled.push(scheduledSeatsText(lower, sc?.at ?? team.subscription?.periodEnd ?? now, now));
  return {
    name: computerDisplayName({ team: team.name }),
    plan: team.plan ? planTitle(work?.name ?? planName(v, team.plan), interval) : '',
    seats: team.seats ? seatsText(team.used, team.seats) : '',
    role: teamRoleText(team.role),
    price: price ? priceText(price) : card?.price ?? '',
    shape: work ? shapeText(work.shape) : card?.shape ?? '',
    billing: card?.billing ?? '',
    scheduled,
    attention: card?.attention ?? false,
  };
}

/** One row of the members list: who, their role, and what's going on (invited, expires…). */
export interface MemberRow { id: string; email: string; role: string; line: string; invited: boolean; you: boolean; expired: boolean }
export function memberRows(team: CloudTeam, now = Date.now()): MemberRow[] {
  const order = (m: CloudTeamMember) => (m.status === 'active' ? (m.role === 'admin' ? 0 : 1) : 2);
  return [...team.people].sort((a, b) => order(a) - order(b) || a.email.localeCompare(b.email)).map((m) => {
    const invited = m.status === 'invited';
    const expired = invited && !!m.expiresAt && m.expiresAt < now;
    return {
      id: m.id, email: m.email, role: teamRoleText(m.role), invited, you: !!m.you, expired,
      line: invited ? (m.expiresAt ? inviteStatusText(m.expiresAt, now) : 'Invited') + (m.invitedBy ? ` · by ${m.invitedBy}` : '') : `Joined ${shortDate(m.since, now)}`,
    };
  });
}

/** Whether a seat count can be asked for, and why not: never below the people on the team, never past the plan. */
export function seatCheck(team: CloudTeam, seats: number, plans: readonly CloudWorkCatalogPlan[] = []): { ok: boolean; reason: string } {
  if (seats < team.minMembers) return { ok: false, reason: `A team has at least ${team.minMembers} seats.` };
  if (seats < team.used) return { ok: false, reason: `${team.used} people are on the team or invited: remove someone or take an invite back first.` };
  if (seats > team.maxMembers) {
    const next = plans.find((p) => p.maxMembers >= seats);
    const plan = plans.find((p) => p.id === team.plan);
    return { ok: false, reason: `${plan?.name ?? 'This plan'} takes up to ${team.maxMembers} members.${next ? ` Move up to ${next.name} for ${seats}.` : ''}` };
  }
  return { ok: true, reason: '' };
}

/** The teams whose shared computer exists: each one's view, for the switcher and Settings. */
export function teamsWithComputer(v: CloudAccountView | null | undefined): CloudTeamView[] {
  if (!v?.signedIn) return [];
  return (v.teams ?? []).filter((t) => hasComputer(teamAsView(v, t)));
}

/**
 * One computer in the switcher besides this Mac: the person's own ("Sarthak’s Cloud Computer", once bought) and each
 * team's ("Acme Cloud Computer"; `teamName` the bare name, for its cloud's colour).
 */
export interface CloudTarget { team?: string; teamName?: string; name: string; warn: boolean }

/** The person's own computer's label: "Sarthak’s Cloud Computer" from their account's name, else "My Cloud Computer". */
export function ownComputerName(v: CloudAccountView | null | undefined): string {
  return computerDisplayName({ person: v?.account?.name });
}

/** Every AppuBot computer the switcher lists (none: the free app's strip, no dropdown). */
export function cloudTargets(v: CloudAccountView | null | undefined): CloudTarget[] {
  if (!v) return [];
  const out: CloudTarget[] = [];
  const own = computerMenuStatus(v);
  const teams = teamsWithComputer(v);
  if (own) out.push({ name: ownComputerName(v), ...own });
  for (const t of teams) {
    const tv = teamAsView(v, t);
    const st = computerMenuStatus(tv);
    if (st) out.push({ team: t.team.id, teamName: t.team.name, name: computerDisplayName({ team: t.team.name }), ...st });
  }
  return out;
}

/** What the switcher's button says for the computer on screen. */
export function targetName(v: CloudAccountView | null | undefined, team: string | undefined): string {
  if (team) {
    const t = v?.teams?.find((x) => x.team.id === team);
    return computerDisplayName({ team: t?.team.name });
  }
  return ownComputerName(v);
}

// ---------------------------------------------------------------------------------------------------------------
// Settings › Billing and Team as plan cards (the 2026-11-05 revamp, /tmp/appubot-billing-revamp direction A): each
// computer's plan is a card with its tile, a status badge, one action and a strip of facts with meters.

/** The status badge on a plan card ("Active", "Payment failed", "Ending"…). */
export function planStatus(p: CloudPhase, trial = false): { label: string; tone: BadgeTone } {
  switch (p) {
    case 'past-due': return { label: 'Payment failed', tone: 'danger' };
    case 'on-hold': return { label: 'On hold', tone: 'danger' };
    case 'ending': return { label: 'Ending', tone: 'warning' };
    case 'export-only': return { label: 'Ended', tone: 'neutral' };
    case 'suspended': return { label: 'Suspended', tone: 'danger' };
    case 'provisioning': return { label: 'Setting up', tone: 'accent' };
    case 'failed': return { label: 'Setup failed', tone: 'danger' };
    // on its free trial (`CloudSubscription.trialEndsAt`): nothing charged yet
    default: return trial ? { label: TRIAL_BADGE, tone: 'accent' } : { label: 'Active', tone: 'success' };
  }
}

/** "$49 / month" from a catalog price ("$49 a month" → the card's short form). */
export function perText(p: CloudPrice): string {
  return `${p.display} / ${p.interval === 'year' ? 'year' : p.interval === 'month' ? 'month' : p.interval}`;
}

/** What a personal plan saves a year on yearly billing ("$98"), from the catalog; '' when it doesn't. */
export function yearlySaving(v: CloudAccountView | null | undefined, plan: CloudPlanId): string {
  const p = v?.catalog?.plans.find((x) => x.id === plan);
  if (!p?.monthly || !p.yearly || p.monthly.currency !== p.yearly.currency) return '';
  const save = p.monthly.amount * 12 - p.yearly.amount;
  return save > 0 ? moneyText(save, p.monthly.currency) : '';
}

/** A team's price as its parts: "$29 + 4 extra seats × $20" ('' without the catalog's prices). */
export function seatsBreakdown(v: CloudAccountView | null | undefined, team: Pick<CloudTeam, 'plan' | 'interval' | 'seats'>): string {
  const work = team.plan ? v?.catalog?.work?.plans.find((p) => p.id === team.plan) : undefined;
  const interval = team.interval ?? 'monthly';
  const base = work?.base[interval], per = work?.perMember[interval];
  if (!base || !per || !team.seats) return '';
  const extra = Math.max(0, team.seats - 1);
  return extra ? `${base.display} + ${extra} extra seat${extra === 1 ? '' : 's'} × ${per.display}` : `${base.display}, one seat`;
}

/** The launch bonus as a plan card's fact: "$7 of $12 used", how full, and when it comes back. */
export function creditFact(c: CloudCredit, now = Date.now()): { value: string; fraction: number; sub: string } {
  const budget = Math.round(c.budgetCents / 100);
  const used = Math.min(budget, Math.floor(c.usedCents / 100));
  const money = (n: number) => moneyText(n * 100, c.currency);
  if (c.ended) return { value: 'Ended', fraction: 0, sub: 'The launch bonus has ended' };
  const value = c.exhausted || used >= budget ? `All ${money(budget)} used` : `${money(used)} of ${money(budget)} used`;
  const resets = `Resets ${shortDate(c.resetsAt, now)}`;
  return { value, fraction: budget > 0 ? Math.min(1, used / budget) : 1, sub: c.shared ? `Shared by the team · ${resets.toLowerCase()}` : resets };
}

/** Emails typed into the invite field: split on commas, spaces and new lines, lower-cased, each once; `bad` keeps the rest. */
export function inviteEmails(text: string): { emails: string[]; bad: string[] } {
  const emails: string[] = [], bad: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const t = raw.trim().replace(/^<|>$/g, '').toLowerCase();
    if (!t) continue;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) { if (!emails.includes(t)) emails.push(t); } else if (!bad.includes(t)) bad.push(t);
  }
  return { emails, bad };
}

/** The seats a team has free for new invites (its seats, or fewer once a lower count is scheduled, less people and open invites). */
export function seatsFree(team: Pick<CloudTeam, 'seats' | 'scheduledSeats' | 'used'>): number {
  if (!team.seats) return 0;
  return Math.max(0, Math.min(team.seats, team.scheduledSeats ?? team.seats) - team.used);
}
