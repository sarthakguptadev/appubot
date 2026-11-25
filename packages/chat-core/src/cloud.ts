/**
 * The AppuBot computer's words and numbers, shared by the desktop and the phone: the plans ("Pro · 4 vCPU · 8 GB RAM ·
 * 20 GB disk", "$49 a month"), the awake line ("Awake this month: 37 h": information, never a limit), the computer's state
 * as the apps explain it (payment on hold, plan ended) and the notices the Mac raises for cloud bots while its window
 * is hidden ("Ada finished", "Ada needs you"). Pure functions over plain numbers and the protocol's `CloudState`.
 * Prices and plan names come from the backend's catalog (the backend's config is the one place they live).
 */
import { APPUBOT_AI_PROVIDER_ID, CLOUD_TEAM_MEMBERS, cloudPaidSeats, type CloudCredit, type CloudCreditStatus, type CloudInterval, type CloudPlanId, type CloudPrice, type CloudShape, type CloudState, type CloudTeam, type CloudTeamLogins, type CloudTeamRole, type CloudWorkCatalogPlan, type CloudWorkPlanId, type PushKind } from '@appubot/protocol';

// ---------------------------------------------------------------------------------------------------------------
// Plans

/** The plans in the order the pickers show them (the catalog's order; a backend from before lists fewer). */
export const CLOUD_PLAN_ORDER: readonly CloudPlanId[] = ['starter', 'pro', 'max', 'ultra'];
/** The Work plans (one computer a team shares) in the order the pickers show them. */
export const CLOUD_WORK_PLAN_ORDER: readonly CloudWorkPlanId[] = ['team', 'business', 'scale'];

/**
 * A profile picture (`CloudAccount.photoUrl`) as the apps may load it, asked for at `px` pixels square: only https (or a
 * `data:image/` one, the mocks'), else null and the initials show. Google's photo URLs end in a size option (`=s96-c`),
 * which is swapped (or added) so a large avatar isn't a blurry 96 px one; other URLs stay as they are.
 */
export function profilePhoto(url: string | undefined | null, px: number): string | null {
  if (!url) return null;
  if (url.startsWith('data:image/')) return url;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    host = u.hostname;
  } catch { return null; }
  if (!/(^|\.)googleusercontent\.com$/.test(host)) return url;
  const size = Math.max(16, Math.min(1024, Math.round(px)));
  return /=s\d+(-c)?$/.test(url) ? url.replace(/=s\d+(-c)?$/, `=s${size}-c`) : `${url}=s${size}-c`;
}

/** A person's initials for their letter avatar: from their name when there is one ("Ada Lovelace" → "AL"), else the email's. */
export function personInitials(email: string, name?: string | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter((w) => /\p{L}|\p{N}/u.test(w));
  if (words.length) {
    const first = Array.from(words[0]!)[0] ?? '';
    const last = words.length > 1 ? Array.from(words[words.length - 1]!)[0] ?? '' : '';
    return (first + last).toUpperCase();
  }
  const local = email.split('@')[0] ?? email;
  const parts = local.split(/[._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || email.charAt(0).toUpperCase();
}

/** "4 vCPU · 8 GB RAM · 20 GB disk" (a plan's size, or what the computer actually has). */
export function shapeText(s: CloudShape): string {
  return `${s.memory} GB RAM · ${s.cpu} vCPU · ${s.disk} GB disk`;
}

/** "4 vCPU / 8 GB" for a short label (the plan card's second line, the switcher). */
export function shapeShort(s: Pick<CloudShape, 'cpu' | 'memory'>): string {
  return `${s.memory} GB / ${s.cpu} vCPU`;
}

/** "a month", "a year" ('' for a one-off). */
export function intervalText(p: Pick<CloudPrice, 'interval'>): string {
  return p.interval === 'month' ? 'a month' : p.interval === 'year' ? 'a year' : '';
}

/** "$49 a month", "$490 a year" (the backend's own display string; tax as it says). */
export function priceText(p: CloudPrice): string {
  const per = intervalText(p);
  return per ? `${p.display} ${per}` : p.display;
}

/** "Monthly" / "Yearly" (the interval as the plan card and the picker's switch say it). */
export function intervalLabel(i: CloudInterval): string {
  return i === 'yearly' ? 'Yearly' : 'Monthly';
}

/** "Pro · Monthly" (the plan card's title). */
export function planTitle(name: string, interval: CloudInterval): string {
  return `${name} · ${intervalLabel(interval)}`;
}

/** The yearly plan's saving next to its switch: "2 months free" (ten months' price for twelve). */
export const YEARLY_SAVING = '2 months free';

/** Said next to Open desktop: watching keeps the computer awake (no hours are spent: plans have no limit). */
export const WATCHING_KEEPS_AWAKE = 'Watching keeps it awake';

// ---------------------------------------------------------------------------------------------------------------
// Hours

/** Seconds as hours with at most one decimal ("37.5", "100", "0.3"); whole hours have none. */
export function formatHours(seconds: number): string {
  const h = Math.max(0, seconds) / 3600;
  const rounded = Math.round(h * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** A day and month, in the user's language ("3 Dec"), with the year only when it isn't this one. */
export function shortDate(ts: number, now = Date.now(), locale?: string): string {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  try {
    return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  } catch {
    return d.toDateString();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The computer's state

/** how long a computer stopped on hold (a payment that didn't go through) is kept before it is deleted (the backend's `retention.keepDays`) */
export const CLOUD_KEEP_DAYS = 1;
/** how long a computer stopped by an ended plan is kept before it is deleted (the backend's `retention.endedKeepDays`) */
export const CLOUD_ENDED_KEEP_DAYS = 1;
/** "one day", "7 days" */
export const keepDaysText = (days: number): string => (days === 1 ? 'one day' : `${days} days`);
export const ON_HOLD_TEXT = `Your AppuBot computer is paused: the payment didn’t go through. Your bots and files are kept for ${keepDaysText(CLOUD_KEEP_DAYS)}, then deleted; update your card in Settings › Billing in AppuBot on your computer to carry on.`;
/** said on every device (a stopped computer's reply, pushes, Telegram), so it names no price or purchase */
export const EXPORT_ONLY_TEXT = `Your plan has ended, so your AppuBot computer is stopped. Its bots and files are kept for ${keepDaysText(CLOUD_ENDED_KEEP_DAYS)}, then deleted.`;

/** One line for the computer's state, or '' while it works (`ok`). */
export function cloudStateText(state: CloudState): string {
  switch (state) {
    case 'ok': return '';
    case 'on-hold': return ON_HOLD_TEXT;
    case 'export-only': return EXPORT_ONLY_TEXT;
  }
}

/** A short title for the state ("Payment on hold"), for a computer's card or its chat's notice. */
export function cloudStateTitle(state: CloudState): string {
  switch (state) {
    case 'ok': return '';
    case 'on-hold': return 'Payment on hold';
    case 'export-only': return 'Plan ended';
  }
}

/** "Changes to Starter on 3 Dec" (a scheduled downgrade), for the plan card. */
export function scheduledChangeText(planName: string, interval: CloudInterval, at: number, now = Date.now()): string {
  return `Changes to ${planTitle(planName, interval)} on ${shortDate(at, now)}`;
}

/** The notice listing the routines that didn't run while the computer was paused (payment on hold), once it is back. */
export function skippedRoutinesText(names: readonly string[]): string {
  const list = [...new Set(names)];
  if (!list.length) return '';
  const shown = list.slice(0, 6).map((n) => `“${n}”`).join(', ') + (list.length > 6 ? ` and ${list.length - 6} more` : '');
  return `${list.length === 1 ? 'A routine' : `${list.length} routines`} didn’t run while your AppuBot computer was paused: ${shown}. ${list.length === 1 ? 'It runs' : 'They run'} again on schedule from now.`;
}

/** A cloud bot's notice, with only its name and the kind: "Ada finished", "Ada needs you", "Ada couldn’t finish". */
export function cloudNoticeTitle(kind: PushKind, botName: string): string {
  switch (kind) {
    case 'done': return `${botName} finished`;
    case 'needs-you': return `${botName} needs you`;
    case 'failed': return `${botName} couldn’t finish`;
  }
}

/** The reasons a cloud computer woke, as the apps list them ("what woke it recently"). */
export type WakeReason = 'routine' | 'telegram' | 'client' | 'backend' | 'boot' | 'unknown';
export function wakeReasonText(reason: WakeReason): string {
  switch (reason) {
    case 'routine': return 'a routine';
    case 'telegram': return 'a Telegram message';
    case 'client': return 'you opened it';
    case 'backend': return 'AppuBot';
    case 'boot': return 'it started';
    case 'unknown': return 'unknown';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Work plans and teams: the price is the plan's base (the first member included) plus a price per extra member, both from
// the backend's catalog (Dodo's products), so the apps compute a team's price only by adding what the catalog says.

/** The paywall's two kinds, as its switch says them. */
export const PLAN_KIND_LABELS = { personal: 'Personal', work: 'Work' } as const;
/** The Work paywall's stepper. */
export const MEMBERS_LABEL = 'People at work';
/** The smallest Work plan that takes the team, highlighted. */
export const FITS_YOUR_TEAM = 'Fits your team';
/** The rules every team runs by (the website says them too). */
export const TEAM_RULES = [
  'The person who buys the plan is the first admin.',
  'Admins invite and remove people, choose the plan and manage billing.',
  'Members use the team’s bots, routines and apps, but can’t change the plan or billing.',
  'Everyone signs in with their own email.',
  'Someone removed loses access at once; what they made stays with the team.',
] as const;

/** A member count within what any team may have (2–30), whole. */
export function clampMembers(n: number): number {
  if (!Number.isFinite(n)) return CLOUD_TEAM_MEMBERS.default;
  return Math.min(CLOUD_TEAM_MEMBERS.max, Math.max(CLOUD_TEAM_MEMBERS.min, Math.round(n)));
}

/** Whether a Work plan takes this many people. */
export function fitsMembers(plan: Pick<CloudWorkCatalogPlan, 'maxMembers' | 'minMembers'>, members: number): boolean {
  return members <= plan.maxMembers && members >= plan.minMembers;
}

/** The smallest Work plan that takes the team (the catalog's order), else the biggest. */
export function smallestFit<P extends Pick<CloudWorkCatalogPlan, 'maxMembers' | 'minMembers'>>(plans: readonly P[], members: number): P | undefined {
  return plans.find((p) => fitsMembers(p, members)) ?? plans[plans.length - 1];
}

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD', 'UGX', 'XAF', 'XOF']);
const SYMBOL: Record<string, string> = { USD: '$', INR: '₹', EUR: '€', GBP: '£', JPY: '¥', AUD: 'A$', CAD: 'C$', SGD: 'S$' };
/** "3040" → "3,040" (the integer part grouped in threes; the fraction left as is) */
function groupThousands(text: string): string {
  const [int, frac] = text.split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}
/** An amount in a currency's minor unit as the backend shows prices ("$79", "$12.50", "₹999", "$3,040"). */
export function moneyText(amount: number, currency: string): string {
  const cur = currency.toUpperCase();
  const major = ZERO_DECIMAL.has(cur) ? amount : amount / 100;
  const text = groupThousands(Number.isInteger(major) ? String(major) : major.toFixed(2));
  const sym = SYMBOL[cur];
  return sym ? `${sym}${text}` : `${text} ${cur}`;
}

/**
 * A Work plan's price for a team of this many people at an interval: base (the first member included) + each member after it × per member, from the
 * catalog's own prices. Undefined while either isn't on sale, or when they disagree on currency.
 */
export function workPrice(plan: Pick<CloudWorkCatalogPlan, 'base' | 'perMember'>, members: number, interval: CloudInterval): CloudPrice | undefined {
  const base = plan.base[interval], per = plan.perMember[interval];
  if (!base || !per || base.currency !== per.currency) return undefined;
  const amount = base.amount + per.amount * cloudPaidSeats(members);
  return { amount, currency: base.currency, display: moneyText(amount, base.currency), interval: base.interval, taxInclusive: base.taxInclusive };
}

/** "+ $20 per extra member" under a Work plan's price (the base includes the first). */
export function perMemberText(per: CloudPrice | undefined): string {
  return per ? `+ ${per.display} per extra member` : '';
}

/** "Up to 5 members" (a Work plan's limit; the paywall greys a plan too small for the team and says it on its button). */
export function upToMembersText(max: number): string {
  return `Up to ${max} member${max === 1 ? '' : 's'}`;
}

/** "5 people" / "1 person" for the stepper and the plan cards. */
export function peopleText(n: number): string {
  return `${n} ${n === 1 ? 'person' : 'people'}`;
}

/** "3 of 5 seats used" for the team card. */
export function seatsText(used: number, seats: number): string {
  return `${used} of ${seats} seat${seats === 1 ? '' : 's'} used`;
}

/** "Admin" / "Member". */
export function teamRoleText(role: CloudTeamRole): string {
  return role === 'admin' ? 'Admin' : 'Member';
}

/** What a role may do, one line under it. */
export function teamRoleNote(role: CloudTeamRole): string {
  return role === 'admin' ? 'Invites and removes people, manages the plan and billing.' : 'Uses the team’s bots, routines and apps.';
}

/** "Seats go down to 3 on 3 Dec" (fewer seats wait for the renewal). */
export function scheduledSeatsText(seats: number, at: number, now = Date.now()): string {
  return `Seats go down to ${seats} on ${shortDate(at, now)}`;
}

/**
 * How a team's computer signs agents in (a team admin's setting, `CloudTeam.logins` / `CloudInfo.logins`): each
 * person's own, or one shared set. The options as the apps show them, in this order.
 */
export const TEAM_LOGINS_OPTIONS: readonly { id: CloudTeamLogins; title: string; description: string }[] = [
  { id: 'own', title: 'Each person uses their own', description: 'Everyone signs in to Claude Code, Codex and the rest as themselves. Their bots use their logins, keys, Vault and connected apps, and nobody sees anyone else’s.' },
  { id: 'shared', title: 'Shared for the whole team', description: 'An admin signs in once. Everyone’s bots use those logins; members can use them but never see or export the secrets.' },
] as const;
/** the admins' note beside the setting */
export const TEAM_LOGINS_TERMS_NOTE = 'Shared logins should follow each provider’s terms: some plans (Claude, ChatGPT and others) are for one person, so check before sharing one.';
/** "Each person uses their own" / "Shared for the whole team" */
export function teamLoginsText(logins: CloudTeamLogins): string {
  return TEAM_LOGINS_OPTIONS.find((o) => o.id === logins)?.title ?? 'Each person uses their own';
}
/** what a member (who can't change it) sees under the setting */
export const TEAM_LOGINS_MEMBER_NOTE = 'An admin chooses this for the team.';
/**
 * Whose logins a bot uses, one line for the bot's editor and row on a team's computer: "Uses ada@acme.com’s logins",
 * "Uses the team’s logins", "Uses no one’s logins yet" (a bot nobody owns on "each person uses their own").
 */
export function botLoginsText(logins: CloudTeamLogins, owner?: { email: string }): string {
  if (logins === 'shared') return 'Uses the team’s logins';
  return owner ? `Uses ${owner.email}’s logins` : 'Uses no one’s logins yet';
}

/**
 * A team's tile colour, from its name (the tile wears AppuBot's mark on it, `APP_MARK`): the same team, the same colour
 * on the desktop and the phone. No orange, red or amber: those would read as the app's own orange.
 */
export const TEAM_TINTS = ['#3a6ff7', '#14a37f', '#8f5cf6', '#2b9bd8', '#c2417a', '#5856d6', '#5f6f84'] as const;
export function teamTint(name: string): string {
  // keyed on the bare name, so "Acme" and its label "Acme Cloud Computer" (or the older "Acme’s Computer", "Acme Cloud")
  // get the same colour
  const bare = name.trim().toLowerCase();
  const key = bare.replace(/(\s+cloud\s+computer|\s*cloud|[’']s?\s+computer)$/, '') || bare;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TEAM_TINTS[h % TEAM_TINTS.length]!;
}

/** "Sarthak’s", "Bots’": a name's possessive, as the apps write device names ("Sarthak’s iPhone"). */
export function possessive(name: string): string {
  const n = name.trim();
  return /s$/i.test(n) ? `${n}’` : `${n}’s`;
}

/** The first word of a person's name ("Sarthak" from "Sarthak Gupta"), or '' when there is none. */
export function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0]?.slice(0, 40) ?? '';
}

/**
 * What every app calls an AppuBot computer in short UI (the owner's call, 2026-11-06, replacing "Sarthak’s Computer"):
 * the person's own is "Sarthak’s Cloud Computer" from their account's name ("My Cloud Computer" without one), a team's
 * is "Acme Cloud Computer" (the team's name as it is, no possessive; "Team Cloud Computer" without a name). Both wear a
 * cloud icon (a team's tinted with `teamTint`), beside the Macs and PCs, which go by their own names ("Sarthak’s
 * MacBook Pro", `macDisplayName`). Display only: stored names stay as they are (a team's is "Acme" and its rename field
 * edits just that). Used by the switchers, plan cards, the Team page's title, pickers, notifications, the screen viewer
 * and the backend's default name for a new computer; sentences that read badly with a long name keep plain words
 * ("your cloud computer", "this Mac"), and sentences about the team as a group keep the bare name ("Remove from Acme").
 */
export function computerDisplayName(of: { team: string | null | undefined } | { person: string | null | undefined }): string {
  if ('team' in of) {
    const n = of.team?.trim() ?? '';
    // a team already named "Acme Cloud" isn't doubled
    return n ? `${n.replace(/\s+cloud$/i, '') || n} Cloud Computer` : 'Team Cloud Computer';
  }
  const first = firstName(of.person);
  return first ? `${possessive(first)} Cloud Computer` : 'My Cloud Computer';
}

/**
 * A Mac's or PC's name as Finder and AirDrop show it (macOS's ComputerName, "Sarthak’s MacBook Pro"), from what the
 * computer reports; a bare network host name ("Sarthaks-MacBook-Pro.local") is made readable ("Sarthaks MacBook Pro"),
 * and nothing at all is `fallback` ("This Mac").
 */
export function macDisplayName(name: string | null | undefined, fallback: string): string {
  let n = (name ?? '').trim().replace(/\.(local|lan|home|localdomain)\.?$/i, '');
  // a host name has no spaces: its hyphens stood for them
  if (n && !/\s/.test(n) && /-/.test(n)) n = n.replace(/-+/g, ' ').trim();
  return n.slice(0, 80) || fallback;
}

/** words a Mac's or PC's own name ends in once its owner's name is left off ("MacBook Pro", "Mac mini", "ThinkPad") */
const DEVICE_WORD = /^(mac|macbook|imac|pc|laptop|desktop|computer|thinkpad|surface|xps|dell|hp|lenovo|asus|acer|framework|ubuntu|linux|windows|workstation)\b/i;

/**
 * A computer's name and its shorter forms, longest first, for a label that has only so much room (the switchers' pill
 * at the top; their menus always show it in full). "Sarthak’s Cloud Computer" → "Sarthak’s Cloud" → "Cloud", "Acme
 * Cloud Computer" → "Acme Cloud" → "Cloud"; a Mac or PC named for its owner ("Sarthak’s MacBook Pro", or "Sarthaks MacBook Pro" from a
 * host name) → "MacBook Pro" → "MacBook" → "Mac". A label shows the first that fits and truncates the last.
 */
export function computerNameSteps(name: string): string[] {
  const full = name.trim();
  const steps = [full];
  const cloud = full.match(/^(.+\sCloud)\s+Computer$/i);
  // where even that is too long, the one word that says what it is (never the name cut off with "…")
  if (cloud) steps.push(cloud[1]!, 'Cloud');
  else {
    // "Sarthak’s MacBook Pro", "James’ PC"; "Sarthaks MacBook Pro" (a host name's possessive lost its apostrophe) only
    // before a device's name of two words or more, so "Atlas MacBook" stays itself
    const own = full.match(/^\S+?(?:[’']s|s[’']|s)\s+(.+)$/);
    const marked = /[’']/.test(full.split(/\s/)[0]!);
    if (own && (marked || (DEVICE_WORD.test(own[1]!) && /\s/.test(own[1]!)))) steps.push(own[1]!);
    // and where even the device's name is too long, down to the one word that says what it is: "MacBook Air" →
    // "MacBook" → "Mac" (never the name cut off with "…")
    const device = steps[steps.length - 1]!;
    if (DEVICE_WORD.test(device)) {
      const first = device.split(/\s+/)[0]!;
      steps.push(first);
      if (/^(macbook|imac)$/i.test(first)) steps.push('Mac');
    }
  }
  return steps.filter((s, i) => s && steps.indexOf(s) === i);
}

/** The switcher's row for someone without a computer of their own (it opens the plans). */
export const ADD_COMPUTER_LABEL = 'Add a cloud computer';

/** "Invited · expires 18 Nov" for an open invite's row. */
export function inviteStatusText(expiresAt: number, now = Date.now()): string {
  return expiresAt < now ? 'Invite expired' : `Invited · expires ${shortDate(expiresAt, now)}`;
}

/** The removal confirm's question (desktop, web, phone). */
export const DROP_SEAT_QUESTION = 'Also drop their seat?';

/** What dropping the seat of someone leaving (or an invite taken back) would do, or why it can't. */
export interface SeatDropOffer {
  /** the question is asked (default on) */
  offer: boolean;
  /** seats at the renewal before and after */
  from: number; to: number;
  /** when it applies: the next billing date (or the date of the change already waiting) */
  at?: number;
  /** the team's price from then on, when the catalog's prices are known (never on the phone) */
  price?: CloudPrice;
  /** "5 → 4 seats: $89 a month from 13 Nov"; without a price "5 → 4 seats from 13 Nov" */
  text: string;
  /** why it isn't offered */
  reason?: string;
}

/**
 * Dropping one seat when someone is removed or an invite is taken back (owner decision 2026-11-04): a seat decrease
 * at the next billing date, on top of a change already waiting (its plan and interval kept, one seat fewer). Not
 * offered below the team's least seats, below the people and open invites left after this one goes, or while the
 * plan can't change (a payment due, or set to end). `work` is the catalog's Work plans, for the price (the phone
 * passes none: it shows no prices). The backend applies the same rule.
 */
export function seatDropOffer(
  team: Pick<CloudTeam, 'seats' | 'scheduledSeats' | 'used' | 'minMembers' | 'subscription'>,
  work?: readonly Pick<CloudWorkCatalogPlan, 'id' | 'base' | 'perMember'>[] | null,
  now = Date.now(),
): SeatDropOffer {
  const sub = team.subscription;
  const from = team.scheduledSeats ?? sub?.scheduledChange?.seats ?? team.seats ?? sub?.seats ?? 0;
  const to = from - 1;
  const no = (reason: string): SeatDropOffer => ({ offer: false, from, to, text: '', reason });
  if (!sub) return no('The team has no plan right now.');
  if (sub.status !== 'active') return no('Settle the last payment first; then the seats can go down.');
  if (sub.cancelAtPeriodEnd) return no('The team’s plan is set to end, so there are no seats to lower.');
  if (to < team.minMembers) return no(`A team keeps at least ${team.minMembers} seats.`);
  const left = Math.max(0, team.used - 1);
  if (to < left) return no(`The other ${left} seats are in use (people and open invites).`);
  const at = sub.scheduledChange?.at ?? sub.periodEnd;
  const planId = sub.scheduledChange?.plan ?? sub.plan;
  const interval = sub.scheduledChange?.interval ?? sub.interval;
  const plan = work?.find((p) => p.id === planId);
  const price = plan ? workPrice(plan, to, interval) : undefined;
  const when = `from ${shortDate(at, now)}`;
  return { offer: true, from, to, at, ...(price ? { price } : {}), text: price ? `${from} → ${to} seats: ${priceText(price)} ${when}` : `${from} → ${to} seats ${when}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Included Claude credit: "AppuBot AI (included Claude credit)", a limited-time launch
// bonus of a quarter of the plan's price every month in whole dollars, spent by bots on the AppuBot AI agent through
// the backend. The same words on the desktop (Settings › Cloud, the chat's notice once it can't be spent) and the phone
// (the account screen: usage, never a price to buy). Money in whole dollars only: no cents anywhere.

/** the AppuBot AI agent (a Claude Code profile the included credit runs) */
export const isAppubotAi = (providerId: string | undefined): boolean => providerId === APPUBOT_AI_PROVIDER_ID;

type CreditLike = Pick<CloudCredit | CloudCreditStatus, 'budgetCents' | 'usedCents' | 'currency' | 'resetsAt' | 'exhausted' | 'ended'>;

/** what the credit is called everywhere */
export const CREDIT_NAME = 'Claude launch bonus';

/** whole dollars: the budget to the nearest one (it is whole already), what is used rounded down (so "$12 of $12" means it is really spent) */
function creditMoney(c: Pick<CreditLike, 'budgetCents' | 'usedCents' | 'currency'>): { used: string; budget: string } {
  const budget = Math.round(c.budgetCents / 100) * 100;
  const used = Math.floor(Math.min(c.usedCents, c.budgetCents) / 100) * 100;
  return { used: moneyText(used, c.currency), budget: moneyText(budget, c.currency) };
}

/** "$7 of $12 used" (Settings › Cloud beside the bar; "$12 used up" when it is, "Ended" once the bonus has) */
export function creditAmount(c: CreditLike): string {
  if (c.ended) return 'Ended';
  const m = creditMoney(c);
  return c.exhausted ? `${m.budget} used up` : `${m.used} of ${m.budget} used`;
}

/** "Claude launch bonus: $7 of $12 used, resets on Dec 5" (the phone's account screen, Settings › Cloud) */
export function creditLine(c: CreditLike, now = Date.now(), locale?: string): string {
  if (c.ended) return `${CREDIT_NAME}: ended`;
  return `${CREDIT_NAME}: ${creditAmount(c)}, resets on ${shortDate(c.resetsAt, now, locale)}`;
}

/** how far along the month's credit is, 0..1 (for a bar) */
export function creditFraction(c: Pick<CreditLike, 'budgetCents' | 'usedCents' | 'ended'>): number {
  if (c.ended) return 1;
  return c.budgetCents > 0 ? Math.min(1, Math.max(0, c.usedCents / c.budgetCents)) : 1;
}

/** under the credit line: what it is and covers */
export const CREDIT_NOTE = 'A launch bonus for a limited time, spent by bots on AppuBot AI with Claude Sonnet or Haiku (Sonnet uses it faster). Resets every month; nothing carries over. We may change or end it with notice.';
/** a team's pool */
export const CREDIT_SHARED_NOTE = 'One pool for the whole team, shared by everyone’s bots.';
/** once the bonus has ended (the backend's refusal says the same) */
export const CREDIT_ENDED_TEXT = 'The launch bonus has ended. Sign in with your own Claude, ChatGPT or other account to keep going.';

/** the chat's notice while the chat's agent is AppuBot AI and the credit can't be spent: the month's is used up, or the bonus has ended */
export function creditNotice(c: CreditLike, now = Date.now(), locale?: string): { title: string; detail: string } {
  if (c.ended) return { title: 'The launch bonus has ended', detail: 'Sign in with your own Claude, ChatGPT or other account to keep going.' };
  return { title: 'This month’s launch bonus is used up', detail: `Sign in with your own account to keep going, or wait until ${shortDate(c.resetsAt, now, locale)}.` };
}

/** what `agentSetupNotice` needs of `CloudInfo.agentSetup` */
export interface AgentSetupLike { providerId: string; state: 'installing' | 'retrying' | 'failed'; attempt: number; retryAt?: number; error?: string }

/** whether a chat on `providerId` runs Claude Code's own CLI (Claude Code, its profiles, AppuBot AI): what the setup is for */
export function runsOnClaudeCode(providerId: string | undefined): boolean {
  return !!providerId && (providerId === 'claude-code' || providerId.startsWith('claude-code@'));
}

/**
 * The chat's notice while an AppuBot Cloud computer sets Claude Code up by itself (its first start: the launch bonus's
 * AppuBot AI runs on it) and the chat runs on Claude; null otherwise. `retry`: the apps offer Try again (it gave up).
 */
export function agentSetupNotice(setup: AgentSetupLike | undefined, providerId: string | undefined, now = Date.now()): { title: string; detail: string; tone: 'info' | 'attention'; busy: boolean; retry: boolean } | null {
  if (!setup || !runsOnClaudeCode(providerId)) return null;
  if (setup.state === 'failed') {
    return { title: 'Claude couldn’t be set up', detail: 'Its download didn’t finish. AppuBot tries again when you send a message, or try now.', tone: 'attention', busy: false, retry: true };
  }
  if (setup.state === 'retrying') {
    const secs = setup.retryAt ? Math.max(0, Math.ceil((setup.retryAt - now) / 1000)) : 0;
    return { title: 'Setting up Claude…', detail: `The first try didn’t finish; trying again${secs > 0 ? ` in ${secs} s` : ' now'}. Messages you send wait for it.`, tone: 'info', busy: true, retry: false };
  }
  return { title: 'Setting up Claude…', detail: `Getting Claude ready on your AppuBot computer, about a minute. Messages you send now go out once it’s ready.`, tone: 'info', busy: true, retry: false };
}
