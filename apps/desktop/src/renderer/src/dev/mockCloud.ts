/**
 * Dev-only: AppuBot Cloud for the mock gateway. `?cloud=<state>` picks the account (default `signed-out`):
 *   signed-out | no-plan | sold-out | provisioning | running | asleep | waking | on-hold | past-due | ending |
 *   scheduled (a downgrade waits for the period's end) | export-only | failed | suspended
 * `&on=cloud` starts with the cloud computer on screen (its bots, through a second mock gateway, which sends threads
 * without their slash commands as a real computer sends a paired device); `&menu=computer` opens the sidebar's computer
 * dropdown (signed out, no plan, sold out, provisioning and failed have none); `&catalog=0` answers without a catalog.
 * Sign in, Subscribe, Change plan, Start now and Delete move the state along.
 * Teams (Work plans): `team-admin` (no plan of your own, admin of Acme on Team: 3 people + 1 invite of 5 seats),
 * `team-member` (the same team as a member: read-only), `team-invite` (an invite to Acme waiting), `personal-team`
 * (Pro of your own and admin of Acme). Invite, roles, remove, resend, take back, seats, leave and accept move it along
 * and keep the rules (seat_limit, plan_limit, last_admin, not_admin). `&kind=work&members=12&billing=y` opens the
 * paywall on Work for 12 people, yearly.
 * Fix your computer: `&fix=<kind>:<state>` shows a repair (`recover:restoring`, `reset:failed`, `update:done`…),
 * `&fix=current` a computer already on the newest version; Update, Recover and Reset run through their steps a second
 * or two each (Reset's copies: seven nightly ones and one saved on demand).
 * No price is real: the mock's are placeholders, as the backend's would be (Dodo's products are the truth).
 */
import type {
  CloudAccountView, CloudBackup, CloudCatalog, CloudRepair, CloudRepairKind, CloudRepairState, CloudComputer, CloudInterval, CloudPlanChangePreview, CloudPlanId, CloudSubscription, CloudTeam, CloudTeamMember, CloudTeamRole,
  CloudTeamView, CloudWorkPlanId, DeviceLogin, CloudCredit, CloudPairedDevice,
} from '@appubot/protocol';
import { APPUBOT_AI_DEFAULT_MODEL, cloudCreditUsd } from '@appubot/protocol';
import { seatDropOffer } from '@appubot/chat-core';
import { GatewayError } from '../lib/gateway';
import { fixStart, paywallStart } from '../features/cloud/cloudAccount';
import type { Handlers } from './mockHandlers';
import type { MockGateway } from './MockGateway';

type CloudHandlers = Pick<Handlers,
  | 'cloudAccount.status' | 'cloudAccount.signIn' | 'cloudAccount.finishSignIn' | 'cloudAccount.signOut' | 'cloudAccount.checkout'
  | 'cloudAccount.portal' | 'cloudAccount.accountPage' | 'cloudAccount.previewPlanChange' | 'cloudAccount.changePlan' | 'cloudAccount.cancelPlanChange'
  | 'cloudAccount.pair' | 'cloudAccount.devices' | 'cloudAccount.removeDevice' | 'cloudAccount.connection' | 'cloudAccount.desktopLink' | 'cloudAccount.start'
  | 'cloudAccount.notices' | 'cloudAccount.accessLog' | 'cloudAccount.exportStart' | 'cloud.export'
  | 'cloudAccount.backups' | 'cloudAccount.repair'
  | 'cloudAccount.team' | 'cloudAccount.invite' | 'cloudAccount.resendInvite' | 'cloudAccount.revokeInvite' | 'cloudAccount.setMemberRole'
  | 'cloudAccount.removeMember' | 'cloudAccount.renameTeam' | 'cloudAccount.setTeamLogins' | 'cloudAccount.leaveTeam' | 'cloudAccount.acceptInvite' | 'cloudAccount.declineInvite'>;

/** `dropSeat` on a removal: one seat fewer at the renewal, the backend's rule (chat-core `seatDropOffer`) */
function seatDropSub(team: CloudTeam, dropSeat: boolean): CloudTeam['subscription'] | null {
  if (!dropSeat) return null;
  const o = seatDropOffer(team);
  if (!o.offer) throw new GatewayError('seat_limit', `Their seat can’t be dropped: ${o.reason ?? ''} Remove them without dropping it.`);
  const sub = team.subscription!;
  const base = sub.scheduledChange ?? { plan: sub.plan, interval: sub.interval, at: sub.periodEnd };
  return { ...sub, scheduledChange: { ...base, seats: o.to } };
}

export type MockCloudState =
  | 'signed-out' | 'no-plan' | 'sold-out' | 'provisioning' | 'running' | 'asleep' | 'waking' | 'on-hold'
  | 'past-due' | 'ending' | 'scheduled' | 'export-only' | 'failed' | 'suspended'
  | 'team-admin' | 'team-member' | 'team-invite' | 'personal-team';
const STATES: MockCloudState[] = ['signed-out', 'no-plan', 'sold-out', 'provisioning', 'running', 'asleep', 'waking', 'on-hold', 'past-due', 'ending', 'scheduled', 'export-only', 'failed', 'suspended', 'team-admin', 'team-member', 'team-invite', 'personal-team'];
/** the person's own account in a team state */
type PersonalState = Exclude<MockCloudState, 'team-admin' | 'team-member' | 'team-invite' | 'personal-team'>;
const personalOf = (s: MockCloudState): PersonalState => (s === 'personal-team' ? 'running' : s === 'team-admin' || s === 'team-member' || s === 'team-invite' ? 'no-plan' : s);

const q = (): URLSearchParams => new URLSearchParams(typeof location === 'undefined' ? '' : location.search);

/** `?devices=full|stuck`: this Mac isn't paired with the cloud computer (it signed out and in again), and the computer is full */
let macUnpaired = q().get('devices') === 'full' || q().get('devices') === 'stuck';
/** the cloud computer's paired devices in `?devices=full|stuck`: this Mac's old pairing, a phone from before, the phone in use */
let paired: CloudPairedDevice[] = macUnpaired ? [
  { id: 'dev_old_mac', name: 'Sarthak’s MacBook Air', platform: 'desktop', pairedAt: Date.now() - 13 * 86_400_000, lastSeenAt: Date.now() - 4 * 60_000, appVersion: '2026.1118.1' },
  { id: 'dev_old_phone', name: 'iPhone', platform: 'ios', pairedAt: Date.now() - 13 * 86_400_000, lastSeenAt: Date.now() - 12 * 86_400_000, appVersion: '2026.11.01' },
  { id: 'dev_phone', name: 'iPhone', platform: 'ios', pairedAt: Date.now() - 6 * 86_400_000, lastSeenAt: Date.now() - 2 * 3_600_000, appVersion: '2026.1118.1' },
] : [];
export function mockCloudState(): MockCloudState {
  const v = q().get('cloud') as MockCloudState | null;
  return v && STATES.includes(v) ? v : 'signed-out';
}
/** `&on=cloud`: the cloud computer's bots on screen from the start */
export const mockStartOnCloud = (): boolean => q().get('on') === 'cloud';
/** `&menu=computer`: the sidebar's computer dropdown opens by itself (it shows in every state with a computer) */
export const mockOpenComputerMenu = (): boolean => q().get('menu') === 'computer';

const H = 3600;
const DAY = 86_400_000;

const price = (cents: number, interval: 'month' | 'year') => ({ amount: cents, currency: 'USD', display: `$${cents / 100}`, interval, taxInclusive: false });
/** the four personal plans at the backend's prices (placeholders; the real ones come from the backend's catalog) */
const CATALOG: CloudCatalog = {
  plans: [
    { id: 'starter', name: 'Starter', blurb: 'A few bots, routines and Telegram, running in the cloud around the clock.', shape: { cpu: 2, memory: 4, disk: 12 }, monthly: price(1900, 'month'), yearly: price(19000, 'year') },
    { id: 'pro', name: 'Pro', blurb: 'Bots that spend the day in a browser and your apps, on a cloud computer.', shape: { cpu: 4, memory: 8, disk: 20 }, monthly: price(4900, 'month'), yearly: price(49000, 'year') },
    { id: 'max', name: 'Max', blurb: 'Many bots at once, heavy websites, long jobs and big files, all in the cloud.', shape: { cpu: 4, memory: 16, disk: 40 }, monthly: price(7900, 'month'), yearly: price(79000, 'year') },
    { id: 'ultra', name: 'Ultra', blurb: 'The biggest computer in the cloud, for bots that never stop.', shape: { cpu: 4, memory: 32, disk: 80 }, monthly: price(10900, 'month'), yearly: price(109000, 'year') },
  ],
  asOf: Date.now(),
};
const catalogPlan = (id: CloudPlanId) => CATALOG.plans.find((p) => p.id === id) ?? CATALOG.plans[1]!;
/** the Work plans: base (the first member included) + $20 per extra member (yearly 10×), 2–30 people, up to 5 / 15 / 30 */
const work = (id: CloudWorkPlanId, name: string, blurb: string, base: number, shape: { cpu: number; memory: number; disk: number }, maxMembers: number) => ({
  id, name, blurb, shape, minMembers: 2, maxMembers,
  base: { monthly: price(base * 100, 'month'), yearly: price(base * 1000, 'year') },
  perMember: { monthly: price(2000, 'month'), yearly: price(20000, 'year') },
});
CATALOG.work = {
  plans: [
    work('team', 'Team', 'A small team sharing bots, routines and apps on one computer in the cloud.', 49, { cpu: 4, memory: 8, disk: 20 }, 5),
    work('business', 'Business', 'A growing team with busy bots all day, on one computer in the cloud.', 79, { cpu: 4, memory: 16, disk: 40 }, 15),
    work('scale', 'Scale', 'The biggest computer in the cloud, for teams whose bots never stop.', 109, { cpu: 4, memory: 32, disk: 80 }, 30),
  ],
  members: { min: 2, max: 30, default: 5 },
};
const workPlan = (id: CloudPlanId) => CATALOG.work!.plans.find((p) => p.id === id);

/** the mock account's plan (a Subscribe or Change plan moves it) */
let currentPlan: CloudPlanId = 'pro';
let currentInterval: CloudInterval = 'monthly';
let scheduledTo: { plan: CloudPlanId; interval: CloudInterval } | null = null;

function awake(hours: number) {
  const now = Date.now();
  return { used: hours, usedSeconds: Math.round(hours * H), cycleStart: now - 22 * DAY, cycleEnd: now + 9 * DAY };
}
/** the included Claude credit (§6.13, the launch bonus): a quarter of the plan's price in whole dollars, part spent; `?credit=out` all of it, `?credit=ended` the bonus over */
export function mockCredit(): CloudCredit {
  const p = catalogPlan(currentPlan);
  const budgetCents = cloudCreditUsd((p.monthly?.amount ?? 4900) / 100) * 100;
  const out = q().get('credit') === 'out', ended = q().get('credit') === 'ended';
  return { budgetCents, usedCents: out ? budgetCents + 12 : Math.round(budgetCents * 0.6), currency: 'USD', resetsAt: Date.now() + 9 * DAY, exhausted: out || ended, ...(ended ? { ended: true } : {}), defaultModel: APPUBOT_AI_DEFAULT_MODEL };
}

function planInfo(): NonNullable<CloudComputer['plan']> {
  const p = catalogPlan(currentPlan);
  return { id: p.id, name: p.name, interval: currentInterval, region: 'us', shape: p.shape, price: p[currentInterval] };
}

/* ---------- Fix your computer ---------- */

const LATEST_VERSION = 14;
/** the repair on each computer ('' = the person's own, else a team's id) and whether Update has been run */
const repairs = new Map<string, CloudRepair>();
let updated = q().get('fix') === 'current';
const fixLine = (): NonNullable<CloudComputer['fix']> => ({ latestVersion: LATEST_VERSION, upToDate: updated });
/** seven nightly copies at 02:10 and one saved on demand three days ago */
function mockBackups(): CloudBackup[] {
  const at = (daysAgo: number, h: number, m: number) => { const d = new Date(Date.now() - daysAgo * DAY); d.setHours(h, m, 0, 0); return d.getTime(); };
  const nightly = Array.from({ length: 7 }, (_, i): CloudBackup => ({ id: `bk_night_${i}`, kind: 'nightly', createdAt: at(i, 2, 10), sizeBytes: 412_000_000 - i * 3_000_000 }));
  return [...nightly, { id: 'bk_manual', kind: 'manual' as const, createdAt: at(3, 16, 42), sizeBytes: 398_000_000 }].sort((a, b) => b.createdAt - a.createdAt);
}
const STEPS: Record<CloudRepairKind, CloudRepairState[]> = { update: ['backing-up', 'rebuilding', 'starting'], recover: ['backing-up', 'rebuilding', 'restoring', 'starting'], reset: ['backing-up', 'rebuilding', 'restoring', 'starting'] };
function mockRepair(kind: CloudRepairKind, state: CloudRepairState, backup?: CloudBackup): CloudRepair {
  const now = Date.now();
  const over = state === 'done' || state === 'failed';
  return {
    id: `rep_mock_${kind}`, kind, state, startedAt: now - 4 * 60_000, updatedAt: now, ...(over ? { finishedAt: now } : {}),
    ...(kind !== 'update' ? { backup: backup ?? (kind === 'reset' ? mockBackups()[1]! : { id: 'bk_fresh', kind: 'manual' as const, createdAt: now - 3 * 60_000 }) } : {}),
    fromVersion: LATEST_VERSION - 1, toVersion: LATEST_VERSION, notes: [],
    ...(state === 'failed' ? { message: 'Your files couldn’t be put back: the copy was interrupted' } : {}),
  };
}
// `&fix=recover:restoring`: a repair on screen from the start
{
  const [k, st] = (q().get('fix') ?? '').split(':') as [CloudRepairKind | undefined, CloudRepairState | undefined];
  if (k && ['update', 'recover', 'reset'].includes(k) && st) repairs.set('', mockRepair(k, st));
}

function computerFor(s: MockCloudState): CloudComputer | undefined {
  const now = Date.now();
  const machine = {
    id: 'cmp_mock', region: 'us' as const, publicUrl: 'https://k3v9x2mq8p0w4rt7zb1c.agent37.app', hostName: 'AppuBot computer',
    shape: catalogPlan(currentPlan).shape,
    nextWakeAt: now + 3 * H * 1000,
    recentWakes: [
      { at: now - 40 * 60_000, reason: 'telegram' as const },
      { at: now - 5 * H * 1000, reason: 'routine' as const },
      { at: now - DAY - 2 * H * 1000, reason: 'client' as const, cold: true },
    ],
  };
  const own = repairs.get('');
  const withPlan = { plan: planInfo(), noticeSeq: 4, credit: mockCredit(), fix: fixLine(), ...(own ? { repair: own } : {}) };
  switch (s) {
    case 'signed-out': return undefined;
    case 'no-plan': case 'sold-out': return { state: 'none', noticeSeq: 0 };
    case 'provisioning': return { state: 'provisioning', plan: planInfo(), progress: 'Starting AppuBot', noticeSeq: 0 };
    case 'failed': return { state: 'failed', plan: planInfo(), noticeSeq: 0 };
    case 'running': case 'past-due': case 'ending': return { state: 'running', ...withPlan, awake: awake(37.5), computer: machine };
    case 'asleep': case 'scheduled': return { state: 'asleep', ...withPlan, awake: awake(37.5), computer: machine };
    case 'waking': return { state: 'waking', ...withPlan, awake: awake(37.5), computer: machine };
    case 'on-hold': return { state: 'on-hold', ...withPlan, awake: awake(12), resetsAt: now + 25 * DAY, computer: machine };
    case 'suspended': return { state: 'suspended', ...withPlan, awake: awake(12), computer: machine };
    case 'export-only': return { state: 'export-only', ...withPlan, exportUntil: now + 23 * DAY, computer: machine };
  }
}

function catalog(): CloudCatalog | undefined {
  if (q().get('catalog') === '0') return undefined;
  return { ...CATALOG, asOf: Date.now(), trialDays: mockTrialDays() };
}
/** the free trial a first plan starts with in the mock: 3 days; `&trial=0` none, `&trial=on` the plan shown is on it */
const mockTrialDays = (): number => (q().get('trial') === '0' ? 0 : 3);

export function mockCloudView(state: MockCloudState): CloudAccountView {
  const base = personalView(personalOf(state));
  if (!base.signedIn) return base;
  const teams = teamsOf(state);
  const invites = state === 'team-invite' && !inviteAnswered ? [{ id: 'inv_for_me', teamId: 'team_acme', teamName: 'Acme', role: 'member' as const, invitedBy: 'priya@acme.com', expiresAt: Date.now() + 12 * DAY }] : [];
  return { ...base, account: { ...base.account!, ...(invites.length ? { invites } : {}), teams: teams.map((t) => summary(t.team)) }, ...(teams.length ? { teams } : {}) };
}

function personalView(s: PersonalState): CloudAccountView {
  // the plans are public: a signed-out app shows them too
  if (s === 'signed-out') return { signedIn: false, paired: false, catalog: catalog() };
  const now = Date.now();
  const subscribed = !['no-plan', 'sold-out'].includes(s);
  const status = s === 'on-hold' ? 'on_hold' : s === 'past-due' ? 'past_due' : s === 'ending' ? 'cancelling' : s === 'export-only' ? 'ended' : s === 'suspended' ? 'suspended' : 'active';
  const scheduled = s === 'scheduled' ? (scheduledTo ?? { plan: 'starter' as const, interval: 'monthly' as const }) : scheduledTo;
  const subscription: CloudSubscription = {
    status: s === 'on-hold' ? 'on_hold' : s === 'past-due' ? 'past_due' : 'active',
    plan: currentPlan, interval: currentInterval, periodStart: now - 22 * DAY, periodEnd: now + 9 * DAY,
    cancelAtPeriodEnd: s === 'ending',
    ...(s === 'past-due' ? { pastDueEndsAt: now + 2 * DAY } : {}),
    ...(scheduled ? { scheduledChange: { ...scheduled, at: now + 9 * DAY } } : {}),
    ...(q().get('trial') === 'on' && status === 'active' ? { periodStart: now - 1 * DAY, periodEnd: now + 2 * DAY, trialEndsAt: now + 2 * DAY } : {}),
  };
  return {
    signedIn: true,
    paired: subscribed && s !== 'provisioning' && s !== 'failed' && !macUnpaired,
    account: {
      id: 'acc_mock', email: 'sarthak@example.com', createdAt: now - 40 * DAY,
      // `&photo=1`: a Google sign-in's name and picture (drawn here, so the mock needs no network); `&photo=name`: the name alone
      ...(q().get('photo') ? { name: 'Sarthak Gupta' } : {}),
      ...(q().get('photo') === '1' ? { photoUrl: MOCK_PHOTO } : {}),
      signupsOpen: s !== 'sold-out',
      trialDays: subscribed ? 0 : mockTrialDays(),
      ...(subscribed ? {
        status, plan: currentPlan, interval: currentInterval, region: 'us' as const,
        ...(s === 'export-only' ? { exportUntil: now + 23 * DAY } : { subscription }),
      } : {}),
    },
    computer: computerFor(s),
    catalog: catalog(),
    readAt: now,
  };
}


/* ---------- teams (Work plans) ---------- */

const ME = 'sarthak@example.com';
interface MockTeam { team: CloudTeam; state: CloudComputer['state']; paired: boolean }
let teamDb: MockTeam | null = null;
let inviteAnswered = false;
let mockSeq = 0;

function makeTeam(role: CloudTeamRole): MockTeam {
  const now = Date.now();
  const person = (id: string, email: string, r: CloudTeamRole, days: number, you?: boolean): CloudTeamMember => ({ id, email, role: r, status: 'active', since: now - days * DAY, ...(you ? { you: true } : {}) });
  const people: CloudTeamMember[] = [
    person('acc_priya', 'priya@acme.com', 'admin', 30),
    person('acc_me', ME, role, 21, true),
    person('acc_dev', 'dev@acme.com', 'member', 12),
    { id: 'inv_omar', email: 'omar@acme.com', role: 'member', status: 'invited', since: now - 2 * DAY, expiresAt: now + 12 * DAY, invitedBy: 'priya@acme.com' },
  ];
  return { state: 'asleep', paired: true, team: recount({
    id: 'team_acme', name: 'Acme', role, plan: 'team', interval: 'monthly', status: 'active', seats: 5, members: 0, used: 0,
    minMembers: 2, maxMembers: 5, people, canManage: role === 'admin', accountUrl: 'https://account.appubot.com/account/teams/team_acme',
    subscription: { status: 'active', plan: 'team', interval: 'monthly', periodStart: now - 20 * DAY, periodEnd: now + 10 * DAY, cancelAtPeriodEnd: false, seats: 5 },
  }) };
}

/** members, used and the role/permissions follow the people list */
function recount(t: CloudTeam): CloudTeam {
  const me = t.people.find((p) => p.you);
  const role = me?.role ?? t.role;
  const sc = t.subscription?.scheduledChange;
  return {
    ...t, role, canManage: role === 'admin',
    members: t.people.filter((p) => p.status === 'active').length, used: t.people.length,
    maxMembers: workPlan(t.plan ?? 'team')?.maxMembers ?? t.maxMembers,
    ...(sc?.seats ? { scheduledSeats: sc.seats } : { scheduledSeats: undefined }),
  };
}

function teamsOf(state: MockCloudState): CloudTeamView[] {
  if (!teamDb) {
    if (state === 'team-admin' || state === 'personal-team') teamDb = makeTeam('admin');
    else if (state === 'team-member') teamDb = makeTeam('member');
    else return [];
  }
  const t = teamDb;
  const now = Date.now();
  const computer: CloudComputer = {
    state: t.state, noticeSeq: 2, team: { id: t.team.id, name: t.team.name },
    plan: { id: t.team.plan!, name: workPlan(t.team.plan!)?.name ?? 'Team', interval: t.team.interval!, region: 'us', shape: workPlan(t.team.plan!)!.shape, seats: t.team.seats, kind: 'work' },
    awake: { used: 61.2, usedSeconds: Math.round(61.2 * H), cycleStart: now - 20 * DAY, cycleEnd: now + 10 * DAY },
    computer: {
      id: 'cmp_acme', region: 'us', publicUrl: 'https://acme7x2mq8p0w4rt7zb1c.agent37.app', hostName: t.team.name, shape: workPlan(t.team.plan!)!.shape,
      recentWakes: [{ at: now - 25 * 60_000, reason: 'routine' }],
    },
    fix: fixLine(), ...(repairs.get(t.team.id) ? { repair: repairs.get(t.team.id) } : {}),
  };
  return [{ team: t.team, computer, paired: t.paired }];
}

const summary = (t: CloudTeam) => ({ id: t.id, name: t.name, role: t.role, members: t.members, ...(t.plan ? { plan: t.plan as CloudWorkPlanId } : {}), ...(t.interval ? { interval: t.interval } : {}), ...(t.status ? { status: t.status } : {}), ...(t.seats ? { seats: t.seats } : {}) });

function needTeam(id: string): MockTeam {
  if (!teamDb || teamDb.team.id !== id) throw new GatewayError('not_found', 'You’re not on that team.');
  return teamDb;
}
function needAdmin(id: string): MockTeam {
  const t = needTeam(id);
  if (!t.team.canManage) throw new GatewayError('not_admin', 'Only an admin of the team can do that.');
  return t;
}
const admins = (t: CloudTeam) => t.people.filter((p) => p.status === 'active' && p.role === 'admin');
const put = (t: MockTeam, team: CloudTeam): CloudTeam => { t.team = recount(team); return t.team; };

/** a team's seats or plan change, as the backend makes it: more now, fewer at the renewal; never under the people, never past the plan */
function teamChange(t: MockTeam, p: { plan: CloudPlanId; interval: CloudInterval; seats?: number }): CloudPlanChangePreview {
  const team = t.team;
  const seats = p.seats ?? team.seats ?? 2;
  const plan = workPlan(p.plan);
  if (!plan) throw new GatewayError('invalid_request', 'That isn’t a Work plan.');
  if (seats > plan.maxMembers) throw new GatewayError('plan_limit', `${plan.name} takes up to ${plan.maxMembers} members. Move up to a bigger plan for ${seats}.`);
  if (seats < team.used) throw new GatewayError('seat_limit', `${team.used} people are on the team or invited: remove someone or take an invite back first.`);
  const rank = (id: CloudPlanId) => ['team', 'business', 'scale'].indexOf(id);
  const up = rank(p.plan) > rank(team.plan!) || (p.plan === team.plan && p.interval === team.interval && seats > (team.seats ?? 0)) || (p.interval === 'yearly' && team.interval === 'monthly');
  const recurring = { amount: plan.base[p.interval]!.amount + plan.perMember[p.interval]!.amount * (seats - 1), currency: 'USD', display: `$${(plan.base[p.interval]!.amount + plan.perMember[p.interval]!.amount * (seats - 1)) / 100}`, interval: p.interval === 'yearly' ? 'year' as const : 'month' as const, taxInclusive: false };
  const added = Math.max(0, seats - (team.seats ?? 0));
  return {
    kind: up ? 'upgrade' : 'downgrade', when: up ? 'immediate' : 'scheduled',
    effectiveAt: up ? Date.now() : team.subscription!.periodEnd,
    ...(up ? { chargeNow: price(Math.round(added * plan.perMember[p.interval]!.amount * 0.33), 'month') } : {}),
    recurring, shape: plan.shape, seats,
  };
}

type DeviceLoginHandlers = Pick<Handlers, 'providers.deviceLogin.start' | 'providers.deviceLogin.status' | 'providers.deviceLogin.code' | 'providers.deviceLogin.cancel' | 'providers.deviceLogin.finish'>;

/**
 * Agents' sign-ins run for a device elsewhere: Codex's link and code; Claude Code's link and a code pasted back, plus a
 * link that comes back to the computer (`relay`); any other agent only that one. Done ~1 s after the code or return.
 */
export function createDeviceLoginHandlers(g: MockGateway): DeviceLoginHandlers {
  const logins = new Map<string, DeviceLogin>();
  const put = (l: DeviceLogin): DeviceLogin => { logins.set(l.id, l); g.emit('provider.login', l); return l; };
  return {
    'providers.deviceLogin.start': (p) => {
      const startedAt = Date.now();
      const claude = p.id.startsWith('claude');
      const codex = p.id.startsWith('codex');
      const first = put({ id: p.id, ...(p.methodId ? { methodId: p.methodId } : {}), state: 'starting', startedAt });
      const back = (host: string, port: number, path: string) => `https://${host}/oauth/authorize?response_type=code&state=mock&redirect_uri=${encodeURIComponent(`http://localhost:${port}${path}`)}`;
      g.later(() => put(claude
        ? { ...first, state: 'waiting', url: 'https://claude.ai/oauth/authorize?code=true&client_id=mock', prompt: 'Paste code here if prompted', relay: { url: back('claude.com', 53111, '/callback'), port: 53111, path: '/callback' } }
        : codex
          ? { ...first, state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'K7QM-4XWP', expiresAt: startedAt + 900_000 }
          : { ...first, state: 'waiting', url: back('accounts.google.com', 53112, '/oauth2callback'), relay: { url: back('accounts.google.com', 53112, '/oauth2callback'), port: 53112, path: '/oauth2callback' } }), 900);
      if (codex) g.later(() => { if (logins.get(p.id)?.state === 'waiting') put({ ...logins.get(p.id)!, state: 'done', message: 'Signed in.' }); }, 30_000);
      return first;
    },
    'providers.deviceLogin.status': (p) => logins.get(p.id) ?? null,
    'providers.deviceLogin.code': (p) => {
      const cur = logins.get(p.id);
      if (!cur) throw new Error('No sign-in is waiting.');
      g.later(() => put({ ...cur, state: 'done', prompt: undefined, message: 'Signed in.' }), 800);
      return cur;
    },
    'providers.deviceLogin.cancel': (p) => { logins.delete(p.id); return { ok: true as const }; },
    'providers.deviceLogin.finish': (p) => {
      const cur = logins.get(p.id);
      if (!cur?.relay) throw new Error('No sign-in is waiting here any more.');
      if (!p.url.includes(`:${cur.relay.port}${cur.relay.path}`) || !/[?&](code|error)=/.test(p.url)) throw new Error('That address doesn’t belong to this sign-in.');
      g.later(() => put({ ...cur, state: 'done', prompt: undefined, message: 'Signed in.' }), 800);
      return { ...cur, message: 'Finishing the sign-in…' };
    },
  };
}

const RANK: Record<CloudPlanId, number> = { starter: 1, pro: 2, max: 3, ultra: 4, team: 1, business: 2, scale: 3 };
/** up (a bigger computer, or yearly) applies at once; down waits for the period's end, as the backend does it */
function changeKind(to: { plan: CloudPlanId; interval: CloudInterval }): 'upgrade' | 'downgrade' {
  if (RANK[to.plan] !== RANK[currentPlan]) return RANK[to.plan] > RANK[currentPlan] ? 'upgrade' : 'downgrade';
  return to.interval === 'yearly' ? 'upgrade' : 'downgrade';
}
function preview(to: { plan: CloudPlanId; interval: CloudInterval }): CloudPlanChangePreview {
  const kind = changeKind(to);
  const p = catalogPlan(to.plan);
  const recurring = p[to.interval];
  return {
    kind, when: kind === 'upgrade' ? 'immediate' : 'scheduled',
    effectiveAt: kind === 'upgrade' ? Date.now() : Date.now() + 9 * DAY,
    ...(kind === 'upgrade' && recurring ? { chargeNow: price(Math.round(recurring.amount * 0.3), 'month') } : {}),
    ...(recurring ? { recurring } : {}),
    shape: { ...p.shape, disk: Math.max(p.shape.disk, catalogPlan(currentPlan).shape.disk) },
  };
}

export function createCloudHandlers(g: MockGateway): CloudHandlers {
  let state = mockCloudState();
  // `&kind=work&members=12&billing=y`: where the paywall opens (screenshots of the Work cards)
  const qs = q();
  if (qs.get('kind') === 'work' || qs.get('kind') === 'personal') paywallStart.kind = qs.get('kind') as 'work' | 'personal';
  if (qs.get('members')) paywallStart.members = Number(qs.get('members'));
  if (qs.get('billing') === 'y') paywallStart.interval = 'yearly';
  // `&fixdialog=update|recover|reset`: that Fix your computer confirmation open from the start
  const fd = qs.get('fixdialog');
  if (fd === 'update' || fd === 'recover' || fd === 'reset') fixStart.kind = fd;
  let view = mockCloudView(state);
  const refresh = (): void => { view = mockCloudView(state); g.emit('cloudAccount.updated', view); };
  const move = (next: MockCloudState, delay = 0): void => {
    g.later(() => { state = next; refresh(); }, delay);
  };
  const computer = (): CloudComputer => view.computer ?? { state: 'none', noticeSeq: 0 };
  /** team actions answer at once and the view follows a moment later, as the core's `cloudAccount.updated` does */
  const teamAnswer = (team: CloudTeam): CloudTeam => { g.later(refresh, 200); return team; };
  return {
    'cloudAccount.status': () => view,
    'cloudAccount.signIn': () => { move('no-plan', 1800); return { url: 'https://account.appubot.com/sign-in?mock=1', state: 'mock-state' }; },
    'cloudAccount.finishSignIn': () => { state = 'no-plan'; view = mockCloudView(state); return view; },
    'cloudAccount.signOut': () => { move('signed-out'); return { ok: true as const }; },
    'cloudAccount.checkout': (p) => {
      if (workPlan(p.plan)) {
        // a Work plan: the buyer becomes the first admin of a new team, set up a few seconds later
        g.later(() => {
          const t = makeTeam('admin');
          const seats = p.members ?? 5;
          const sub = t.team.subscription!;
          t.team = recount({ ...t.team, name: p.teamName ?? 'My team', plan: p.plan as CloudWorkPlanId, interval: p.interval, seats, people: t.team.people.filter((m) => m.you).map((m) => ({ ...m, role: 'admin' as const })), subscription: { ...sub, plan: p.plan, interval: p.interval, seats } });
          teamDb = t;
          if (personalOf(state) === 'no-plan') state = 'team-admin';
          refresh();
        }, 2500);
        return { checkoutUrl: 'https://checkout.dodopayments.com/mock', sessionId: 'cks_mock_team' };
      }
      currentPlan = p.plan; currentInterval = p.interval; scheduledTo = null;
      move('provisioning', 1500); move('asleep', 9000);
      return { checkoutUrl: 'https://checkout.dodopayments.com/mock', sessionId: 'cks_mock' };
    },
    'cloudAccount.portal': (p) => { if (p.team) needAdmin(p.team); return { url: 'https://customer.dodopayments.com/mock', expiresAt: Date.now() + 600_000 }; },
    'cloudAccount.accountPage': (p) => { if (p.team) needAdmin(p.team); return { url: p.team ? `https://account.appubot.com/account/teams/${p.team}` : 'https://account.appubot.com/account' }; },
    'cloudAccount.previewPlanChange': (p) => (p.team ? teamChange(needAdmin(p.team), p) : preview(p)),
    'cloudAccount.changePlan': (p) => {
      if (p.team) {
        const t = needAdmin(p.team);
        const pv = teamChange(t, p);
        const sub = t.team.subscription!;
        if (pv.when === 'immediate') put(t, { ...t.team, plan: p.plan as CloudWorkPlanId, interval: p.interval, seats: pv.seats, subscription: { ...sub, plan: p.plan, interval: p.interval, seats: pv.seats, scheduledChange: undefined } });
        else put(t, { ...t.team, subscription: { ...sub, scheduledChange: { plan: p.plan, interval: p.interval, at: sub.periodEnd, seats: pv.seats } } });
        g.later(refresh, 200);
        return { ...pv, subscription: t.team.subscription! };
      }
      const pv = preview(p);
      if (pv.when === 'immediate') { currentPlan = p.plan; currentInterval = p.interval; scheduledTo = null; if (state === 'scheduled') state = 'asleep'; }
      else { scheduledTo = { plan: p.plan, interval: p.interval }; if (state === 'asleep' || state === 'running') state = 'scheduled'; }
      g.later(refresh, 300);
      return { ...pv, subscription: mockCloudView(state).account!.subscription! };
    },
    'cloudAccount.cancelPlanChange': (p) => {
      if (p.team) { const t = needAdmin(p.team); put(t, { ...t.team, subscription: { ...t.team.subscription!, scheduledChange: undefined } }); g.later(refresh, 200); return { ok: true as const }; } scheduledTo = null; if (state === 'scheduled') state = 'asleep'; g.later(refresh, 300); return { ok: true as const }; },
    'cloudAccount.pair': (p) => {
      // `?devices=stuck`: the computer is full and no room could be made, so it refuses (CloudDevicesDialog lists them);
      // `?devices=full`: the backend makes room, the device unused longest goes, and the answer says which
      if (paired.length >= 3 && q().get('devices') === 'stuck') throw new GatewayError('device_limit', 'Your AppuBot computer already has 3 devices paired, the most it allows. Remove one in Settings › Devices, then try again.');
      const replaced = paired.length >= 3 ? [...paired].sort((a, b) => (a.lastSeenAt ?? 0) - (b.lastSeenAt ?? 0)).slice(0, paired.length - 2) : [];
      paired = paired.filter((d) => !replaced.includes(d));
      if (p.team) { needTeam(p.team).paired = true; g.later(refresh, 100); }
      if (macUnpaired && !p.team) { macUnpaired = false; view = mockCloudView(state); g.later(refresh, 100); }
      return { paired: true as const, deviceId: 'dev_mock_mac', ...(replaced.length ? { replaced } : {}) };
    },
    'cloudAccount.devices': () => ({ devices: paired, max: 3 }),
    'cloudAccount.removeDevice': (p) => { paired = paired.filter((d) => d.id !== p.id); return { devices: paired, max: 3 }; },
    'cloudAccount.connection': (p) => {
      if (p.team) {
        const t = needTeam(p.team);
        return t.paired ? { publicUrl: 'https://acme7x2mq8p0w4rt7zb1c.agent37.app', key: 'A'.repeat(43), token: 'mock-team-token', deviceId: 'dev_mock_mac_acme', hostName: t.team.name, role: t.team.canManage ? 'owner' as const : 'full' as const, pairedAt: Date.now() - DAY, team: t.team.id } : null;
      }
      return view.paired ? {
        publicUrl: 'https://k3v9x2mq8p0w4rt7zb1c.agent37.app', key: 'A'.repeat(43), token: 'mock-cloud-token', deviceId: 'dev_mock_mac',
        hostName: 'AppuBot computer', role: 'owner' as const, pairedAt: Date.now() - DAY,
      } : null;
    },
    'cloudAccount.desktopLink': () => ({ websocketUrl: 'wss://example.invalid/websockify', expiresAt: Date.now() + 60_000 }),
    'cloudAccount.start': (p) => {
      if (p.team) { const t = needTeam(p.team); t.state = 'waking'; g.later(() => { t.state = 'running'; refresh(); }, 1200); g.later(refresh, 50); return teamsOf(state)[0]!.computer!; }
      move('running', 1200); return { ...computer(), state: 'waking' as const };
    },
    'cloudAccount.notices': () => ({ seq: 4, items: [] }),
    'cloudAccount.accessLog': () => {
      const now = Date.now();
      return {
        items: [
          { at: now - 40 * 60_000, action: 'Started', actor: 'system' as const, reason: 'A Telegram message for Scout' },
          { at: now - 2 * H * 1000, action: 'Put to sleep', actor: 'system' as const, reason: 'Idle for 3 minutes' },
          { at: now - DAY, action: 'Resized', actor: 'system' as const, reason: 'Plan changed to Pro' },
          { at: now - 6 * DAY, action: 'Opened the desktop', actor: 'user' as const },
          { at: now - 12 * DAY, action: 'Looked at the logs', actor: 'support' as const, reason: 'Your ticket #1042' },
        ],
      };
    },
    'cloudAccount.exportStart': () => ({ ...computer(), state: 'waking' as const }),
    'cloud.export': () => ({ fileId: 'file_export', name: 'AppuBot bots.zip', size: 48_200_000 }),
    'cloudAccount.backups': (p) => { if (p.team) needAdmin(p.team); return { backups: mockBackups(), asOf: Date.now() }; },
    'cloudAccount.repair': (p) => {
      if (p.team) needAdmin(p.team);
      const key = p.team ?? '';
      const running = repairs.get(key);
      if (running && running.state !== 'done' && running.state !== 'failed') {
        if (running.kind === p.kind) return { repair: running };
        throw new GatewayError('repair_running', `${running.kind === 'update' ? 'Update' : running.kind === 'recover' ? 'Recover' : 'Reset'} is already running on your AppuBot computer. Wait for it to finish, then try again.`);
      }
      if (p.kind === 'update' && updated) return { repair: null, message: `Your AppuBot computer is already on the newest version (${LATEST_VERSION}). If it isn’t working, try Recover.` };
      if (p.kind === 'reset' && p.confirm !== 'reset') throw new GatewayError('invalid_request', 'Reset needs confirming: type reset.');
      const backup = p.kind === 'reset' ? mockBackups().find((b) => b.id === p.backupId) ?? mockBackups().find((b) => b.kind === 'nightly') : undefined;
      let r = mockRepair(p.kind, 'queued', backup);
      repairs.set(key, r);
      const steps = [...STEPS[p.kind], 'done' as const];
      steps.forEach((st, i) => g.later(() => {
        r = { ...r, state: st, updatedAt: Date.now(), ...(st === 'done' ? { finishedAt: Date.now() } : {}) };
        repairs.set(key, r);
        if (st === 'done') updated = true;
        refresh();
      }, 1600 * (i + 1)));
      g.later(refresh, 50);
      return { repair: r };
    },

    /* ---------- teams ---------- */
    'cloudAccount.team': (p) => needTeam(p.team).team,
    'cloudAccount.invite': (p) => {
      const t = needAdmin(p.team);
      const cap = Math.min(t.team.seats ?? 0, t.team.scheduledSeats ?? t.team.seats ?? 0);
      if (t.team.used >= cap) throw new GatewayError('seat_limit', 'Every seat is taken: add a seat first (or take an invite back).');
      if (t.team.people.some((m) => m.email === p.email.toLowerCase())) throw new GatewayError('conflict', `${p.email} is on the team or invited already.`);
      const now = Date.now();
      return teamAnswer(put(t, { ...t.team, people: [...t.team.people, { id: `inv_${++mockSeq}`, email: p.email.toLowerCase(), role: p.role ?? 'member', status: 'invited', since: now, expiresAt: now + 14 * DAY, invitedBy: ME }] }));
    },
    'cloudAccount.resendInvite': (p) => {
      const t = needAdmin(p.team);
      const now = Date.now();
      return teamAnswer(put(t, { ...t.team, people: t.team.people.map((m) => (m.id === p.inviteId ? { ...m, since: now, expiresAt: now + 14 * DAY, invitedBy: ME } : m)) }));
    },
    'cloudAccount.revokeInvite': (p) => {
      const t = needAdmin(p.team);
      const sub = seatDropSub(t.team, !!p.dropSeat);
      return teamAnswer(put(t, { ...t.team, people: t.team.people.filter((m) => m.id !== p.inviteId), ...(sub ? { subscription: sub } : {}) }));
    },
    'cloudAccount.setMemberRole': (p) => {
      const t = needAdmin(p.team);
      const who = t.team.people.find((m) => m.id === p.memberId && m.status === 'active');
      if (!who) throw new GatewayError('not_found', 'They aren’t on the team.');
      if (who.role === 'admin' && p.role === 'member' && admins(t.team).length <= 1) throw new GatewayError('last_admin', 'A team needs at least one admin: make someone else an admin first.');
      return teamAnswer(put(t, { ...t.team, people: t.team.people.map((m) => (m.id === p.memberId ? { ...m, role: p.role } : m)) }));
    },
    'cloudAccount.removeMember': (p) => {
      const t = needAdmin(p.team);
      const who = t.team.people.find((m) => m.id === p.memberId && m.status === 'active');
      if (!who) throw new GatewayError('not_found', 'They aren’t on the team.');
      if (who.role === 'admin' && admins(t.team).length <= 1) throw new GatewayError('last_admin', 'A team needs at least one admin.');
      const sub = seatDropSub(t.team, !!p.dropSeat);
      return teamAnswer(put(t, { ...t.team, people: t.team.people.filter((m) => m.id !== p.memberId), ...(sub ? { subscription: sub } : {}) }));
    },
    'cloudAccount.renameTeam': (p) => { const t = needAdmin(p.team); return teamAnswer(put(t, { ...t.team, name: p.name })); },
    'cloudAccount.setTeamLogins': (p) => { const t = needAdmin(p.team); return teamAnswer(put(t, { ...t.team, logins: p.logins })); },
    'cloudAccount.leaveTeam': (p) => {
      const t = needTeam(p.team);
      const me = t.team.people.find((m) => m.you);
      if (me?.role === 'admin' && admins(t.team).length <= 1) throw new GatewayError('last_admin', 'You’re the team’s only admin: make someone else an admin first, then leave.');
      teamDb = null;
      if (state === 'team-admin' || state === 'team-member') state = 'no-plan';
      else if (state === 'personal-team') state = 'running';
      g.later(refresh, 200);
      return { ok: true as const };
    },
    'cloudAccount.acceptInvite': (p) => {
      if (p.inviteId !== 'inv_for_me' || inviteAnswered) throw new GatewayError('invite_invalid', 'This invite isn’t open any more.');
      inviteAnswered = true;
      teamDb = makeTeam('member');
      teamDb.paired = false;
      state = 'team-member';
      g.later(refresh, 200);
      return teamDb.team;
    },
    'cloudAccount.declineInvite': () => { inviteAnswered = true; g.later(refresh, 200); return { ok: true as const }; },
  };
}

/** a stand-in profile picture for `&photo=1` */
const MOCK_PHOTO = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6b37a"/><stop offset="1" stop-color="#d9733a"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><circle cx="48" cy="38" r="17" fill="#3b2a20"/><path d="M14 96c4-22 18-32 34-32s30 10 34 32z" fill="#3b2a20"/></svg>')}`;
