/**
 * The paywall: ONE design, the landing page's (its plan cards, plans and the `.seg`,
 * `.plan-members`, `.plan-grid`, `.plan-cell` styles in its globals.css, as appubot.com/pricing shows them). Every
 * other surface draws its cards from here so they can't drift: the desktop's Settings › Billing (`Paywall.tsx`) and
 * the backend's account and team pages.
 *
 * What lives here: the cards' words, rows, badges and prices from the backend's catalog (`paywallView`: the control
 * row, the cells, what each button says and does for someone already on a plan), the Free card (a wide one under the
 * plans) and the Custom card, the note
 * under them, the website's line icons as SVG markup, and the website's colours and type (`PAYWALL_TOKENS`,
 * `paywallCss`: the same CSS for every surface, scoped to `.pw`). Pure: no DOM, no React.
 */
import type { CloudCatalog, CloudInterval, CloudPlanId, CloudPrice, CloudShape } from '@appubot/protocol';
import { CLOUD_TEAM_MEMBERS, cloudCreditUsd } from '@appubot/protocol';
import { fitsMembers, moneyText, upToMembersText, workPrice, YEARLY_SAVING } from './cloud';
import { PROVIDER_MARKS } from './providers';

export type PaywallKind = 'personal' | 'work';

/** the website's thin line icons the cards use (24×24, stroke 1.5) */
export type PaywallIcon =
  | 'send' | 'key' | 'sparkle' | 'shield' | 'grid' | 'check' | 'minus' | 'plus' | 'chip' | 'storage' | 'users'
  | 'infinity' | 'tag' | 'moonSleep' | 'phone' | 'cloud' | 'laptop' | 'bolt' | 'apple' | 'windows' | 'linux' | 'download'
  /** Claude's own mark, filled in its clay (the Claude allowance's row; the one icon that isn't a line drawing) */
  | 'claude';

/** one line of a plan card, with the website's icon beside it */
export interface PlanRow { icon: PaywallIcon; text: string }

export interface PaywallCard {
  id: CloudPlanId;
  name: string;
  blurb: string;
  /** "$49", "$490" (the interval's own price; for a team: base + (members − 1) × per member, the first included) */
  price: string;
  /** "/ month", "/ year" */
  per: string;
  /** yearly: twelve months at the monthly price, struck through ('' otherwise) */
  struck: string;
  /** "Billed monthly" / "$40.83 a month, billed yearly" */
  sub: string;
  /** "Most popular" / "Best value" (accent) */
  badge?: { text: string; tone: 'accent' | 'muted' };
  /** the card the eye goes to (Pro, the biggest team plan), with the accent's top edge */
  highlight: boolean;
  /** too small for the team: greyed, can't be chosen */
  off: boolean;
  /** what its (disabled) button says while `off`: "Up to 5 members" */
  offText?: string;
  /** what the computer is and what the plan gives, as the website's cards say it */
  rows: PlanRow[];
}

export const MOST_POPULAR = 'Most popular';
/** The badge on the work plan the eye goes to (the biggest: the most computer per person) */
export const BEST_VALUE = 'Best value';
export const CURRENT_PLAN = 'Current plan';

/** where a card's bots run, the icon at its top right */
export type PaywallWhere = 'cloud' | 'own';
export const PAYWALL_WHERE: Record<PaywallWhere, { icon: PaywallIcon; label: string }> = {
  cloud: { icon: 'cloud', label: 'Runs on your AppuBot computer in the cloud' },
  own: { icon: 'laptop', label: 'Runs on your own computer' },
};
/** the muted line over a paid card's rows: whose computer the specs describe */
export const PAYWALL_SPEC_LABEL: Record<PaywallKind, string> = {
  personal: 'Your AppuBot computer in the cloud',
  work: 'Your team’s AppuBot computer in the cloud',
};
export const PAYWALL_KIND_LABELS: Record<PaywallKind, string> = { personal: 'Personal', work: 'Work' };
export const PAYWALL_INTERVAL_LABELS: Record<CloudInterval, string> = { monthly: 'Monthly', yearly: 'Yearly' };
export { YEARLY_SAVING };

/** under the cards, said once (the site's `CREDIT_BONUS_NOTE`): the included Claude allowance is a launch offer */
export const CREDIT_BONUS_NOTE = 'The Claude allowance is a launch offer for a limited time; we may change or end it with notice. Your plan price doesn’t include it.';

// ---------------------------------------------------------------------------------------------------------------
// The free trial (2026-11-12): a first plan, any plan, starts with a few days free. A card is taken at checkout, the
// first charge comes when the trial ends, and cancelling before then costs nothing. Every surface words it from here.
// Since 2026-11-19 the backend may charge for those days (`CloudCatalog.trialPrice`, $1: a card that can't pay never
// starts a trial). Every wording below takes that price as its last argument ("$1") and says "free" only without it.

/**
 * The days of free trial this viewer's first plan starts with: a signed-in person's own (`CloudAccount.trialDays`,
 * 0 once they have had a plan), else what the catalog offers a newcomer. 0: no trial, the buttons read as before.
 */
export function trialDaysOf(catalog: Pick<CloudCatalog, 'trialDays'> | null | undefined, account?: { trialDays?: number | undefined } | null): number {
  const days = account ? account.trialDays : catalog?.trialDays;
  return typeof days === 'number' && days > 0 ? Math.round(days) : 0;
}
/** what the trial's days cost, as the catalog says it ("$1"), or undefined while they are free */
export function trialPriceOf(catalog: Pick<CloudCatalog, 'trialPrice'> | null | undefined): string | undefined {
  const p = catalog?.trialPrice;
  return p && p.amount > 0 && p.display ? p.display : undefined;
}
const daysText = (days: number): string => `${days} day${days === 1 ? '' : 's'}`;
/** "3-day free trial" / "3-day trial for $1" */
export const trialName = (days: number, cost?: string): string => (cost ? `${days}-day trial for ${cost}` : `${days}-day free trial`);
/** a plan card's button: "Start 3-day free trial" / "Start 3-day trial for $1" */
export const trialCta = (days: number, cost?: string): string => `Start ${trialName(days, cost)}`;
/** a page's one big button: "Start your 3-day free trial" / "Start your 3-day trial for $1" */
export const trialCtaYour = (days: number, cost?: string): string => `Start your ${trialName(days, cost)}`;
/** a short one, for a small button or a link: "Try free for 3 days" / "Try 3 days for $1" */
export const trialTry = (days: number, cost?: string): string => (cost ? `Try ${daysText(days)} for ${cost}` : `Try free for ${daysText(days)}`);
/** "3 days free" / "3 days for $1" */
export const trialFree = (days: number, cost?: string): string => (cost ? `${daysText(days)} for ${cost}` : `${daysText(days)} free`);
/** the line under a price: "3 days free, then $49 / month" / "3 days for $1, then $49 / month" */
export const trialThen = (days: number, price: string, per: string, cost?: string): string => `${trialFree(days, cost)}, then ${price} ${per}`;
/** under the cards, said once */
export const trialNote = (days: number, cost?: string): string => (cost
  ? `Every plan starts with ${trialFree(days, cost)}. The ${cost} is charged when you start; your plan’s price is charged when the trial ends, unless you cancel before then.`
  : `Every plan starts with ${trialFree(days)}. We ask for a card to start; you’re charged when the trial ends, and cancelling before then costs nothing.`);
/** a plan on its trial, on its card: "Free trial" */
export const TRIAL_BADGE = 'Free trial';
/** the same where the trial's days are paid for: "Trial" */
export const trialBadge = (cost?: string): string => (cost ? 'Trial' : TRIAL_BADGE);
/** a card's sub-line while a trial is offered: "3 days free, then billed monthly" */
const trialSub = (days: number, interval: CloudInterval, cost?: string): string => `${trialFree(days, cost)}, then billed ${interval}`;

/** "1 person" / "5 people": the stepper's count */
export const stepperText = (n: number) => (n === 1 ? '1 person' : `${n} people`);

const PER: Record<CloudInterval, string> = { monthly: '/ month', yearly: '/ year' };
/** roughly how many bots work at once on each plan (the website's cards say the same) */
const AT_ONCE: Record<CloudPlanId, string> = { starter: 'about 3–4', pro: 'about 8', max: 'about 15 or more', ultra: 'about 30 or more', team: 'about 8', business: 'about 15 or more', scale: 'about 30 or more' };
/** "Unlimited bots, about 8 working at once" (a team's: "…, shared by the team") */
/** the same, for a surface that lays the plans out its own way (the phone's compare table) */
export const PLAN_BOTS_AT_ONCE: Readonly<Record<CloudPlanId, string>> = AT_ONCE;
const botsRow = (id: CloudPlanId, team = false): PlanRow[] => AT_ONCE[id] ? [{ icon: 'bolt', text: `Unlimited bots, ${AT_ONCE[id]} working at once${team ? ', shared by the team' : ''}` }] : [];
/** the computer's rows, RAM first (the site's `computerRows`) */
const computerRows = (s: CloudShape): PlanRow[] => [
  { icon: 'chip', text: `${s.memory} GB memory · ${s.cpu} vCPU` },
  { icon: 'storage', text: `${s.disk} GB storage` },
  { icon: 'moonSleep', text: 'Sleeps when idle, wakes in seconds' },
  { icon: 'infinity', text: 'No hour limits' },
];
/**
 * How big each plan's Claude allowance is, in words (the owner's call, 2026-11-06: no share or amount on the cards; the
 * amount is protocol `cloudCreditUsd`, shown in Billing once bought). The site's `ALLOWANCE` says the same.
 */
export const CREDIT_ALLOWANCE: Record<CloudPlanId, string> = {
  starter: 'generous', pro: 'higher', max: 'much higher', ultra: 'highest',
  team: 'generous', business: 'higher', scale: 'highest',
};
/** a paid card's credit row, drawn with Claude's own mark (icon `claude`): "Launch offer: higher Claude allowance" (a team's ", shared") */
export function creditRowFor(id: CloudPlanId, team = false): string {
  const size = CREDIT_ALLOWANCE[id];
  return `Launch offer: ${size ? `${size} ` : ''}Claude allowance${team ? ', shared' : ''}`;
}
/** @deprecated the row depends on the plan now: `creditRowFor` */
export const creditRowText = (_monthly?: CloudPrice): string => 'Launch offer: Claude allowance';
/** @deprecated a Work card's row depends on the plan now: `creditRowFor(id, true)` */
export const WORK_CREDIT_ROW = 'Launch offer: Claude allowance, shared';

/** the yearly sub-line and struck price from a plan's monthly and yearly prices */
function priceLines(monthly: CloudPrice | undefined, shown: CloudPrice, interval: CloudInterval): Pick<PaywallCard, 'struck' | 'sub'> {
  if (interval === 'monthly') return { struck: '', sub: 'Billed monthly' };
  const struck = monthly && monthly.currency === shown.currency ? moneyText(monthly.amount * 12, monthly.currency) : '';
  return { struck: struck && struck !== shown.display ? struck : '', sub: `${moneyText(Math.round(shown.amount / 12), shown.currency)} a month, billed yearly` };
}

/** The personal plans the catalog sells at an interval, as the website's cards (Pro is the popular one). */
export function personalPaywall(catalog: CloudCatalog | null | undefined, interval: CloudInterval): PaywallCard[] {
  const plans = (catalog?.plans ?? []).filter((p) => p[interval]);
  return plans.map((p) => {
    const shown = p[interval]!;
    const popular = p.id === 'pro' && plans.length > 1;
    return {
      id: p.id, name: p.name, blurb: p.blurb, price: shown.display, per: PER[interval], ...priceLines(p.monthly, shown, interval),
      highlight: popular,
      ...(popular ? { badge: { text: MOST_POPULAR, tone: 'accent' as const } } : {}),
      off: false,
      rows: [...computerRows(p.shape), { icon: 'claude', text: creditRowFor(p.id) }, ...botsRow(p.id), { icon: 'phone', text: 'Phone and desktop apps' }],
    };
  });
}

/** The Work plans the catalog sells at an interval for a team of `members`: priced, greyed when too small, the biggest highlighted ("Best value"). */
export function workPaywall(catalog: CloudCatalog | null | undefined, interval: CloudInterval, members: number): PaywallCard[] {
  const plans = (catalog?.work?.plans ?? []).filter((p) => p.base[interval] && p.perMember[interval]);
  return plans.map((p, i) => {
    const shown = workPrice(p, members, interval)!;
    const off = !fitsMembers(p, members);
    const best = !off && i === plans.length - 1 && plans.length > 1;
    const monthly = workPrice(p, members, 'monthly');
    // the row says the monthly base and seat on either interval, as the site does
    const base = p.base.monthly ?? p.base[interval]!, per = p.perMember.monthly ?? p.perMember[interval]!;
    return {
      id: p.id, name: p.name, blurb: p.blurb, price: shown.display, per: PER[interval], ...priceLines(monthly, shown, interval),
      highlight: best, off,
      ...(off ? { offText: upToMembersText(p.maxMembers) } : {}),
      ...(best ? { badge: { text: BEST_VALUE, tone: 'accent' as const } } : {}),
      rows: [
        ...computerRows(p.shape),
        { icon: 'claude', text: creditRowFor(p.id, true) },
        ...botsRow(p.id, true),
        { icon: 'users', text: upToMembersText(p.maxMembers) },
        { icon: 'tag', text: `${base.display} + ${per.display} per extra member` },
        { icon: 'grid', text: 'Shared bots, routines and apps' },
        { icon: 'key', text: 'Everyone signs in with their own email' },
        { icon: 'shield', text: 'Admin and member roles' },
      ],
    };
  });
}

/** The intervals the paywall can sell for a kind (the switch shows only those). */
export function paywallIntervals(catalog: CloudCatalog | null | undefined, kind: PaywallKind): CloudInterval[] {
  return (['monthly', 'yearly'] as const).filter((i) => (kind === 'work' ? (catalog?.work?.plans ?? []).some((p) => p.base[i] && p.perMember[i]) : (catalog?.plans ?? []).some((p) => p[i])));
}

/**
 * What choosing a card does for someone already on a plan: "Upgrade to Max", "Downgrade to Starter", "Switch to yearly",
 * "Change seats" (the team's own plan at another size), or nothing (their plan as it is). By the catalog's order.
 */
export type PlanMove = 'current' | 'upgrade' | 'downgrade' | 'interval' | 'seats';
export function planMove(order: readonly CloudPlanId[], now: { plan: CloudPlanId; interval: CloudInterval; seats?: number }, to: { plan: CloudPlanId; interval: CloudInterval; seats?: number }): PlanMove {
  if (to.plan !== now.plan) return order.indexOf(to.plan) > order.indexOf(now.plan) ? 'upgrade' : 'downgrade';
  if (to.interval !== now.interval) return 'interval';
  if (now.seats !== undefined && to.seats !== undefined && to.seats !== now.seats) return 'seats';
  return 'current';
}
export function planMoveLabel(move: PlanMove, name: string, interval: CloudInterval): string {
  switch (move) {
    case 'upgrade': return `Upgrade to ${name}`;
    case 'downgrade': return `Downgrade to ${name}`;
    case 'interval': return interval === 'yearly' ? 'Switch to yearly' : 'Switch to monthly';
    case 'seats': return 'Change seats';
    default: return 'Your plan';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The whole paywall for a state: the control row and every cell, ready to draw.

/**
 * `buy`: no plan yet (the Personal | Work switch, the people stepper, Free as a wide card under the Personal plans,
 * Custom last on Work);
 * `personal`: changing one's own plan (no switch, no stepper, no Free); `team`: a team's plan, or a new team (Work
 * only; the stepper is its people, 2 and up).
 */
export type PaywallMode = 'buy' | 'personal' | 'team';
export interface CurrentPlan { plan: CloudPlanId; interval: CloudInterval; seats?: number }

/** a paid card as drawn: its card plus what its button says and whether it can be pressed */
export interface PaywallCell extends PaywallCard {
  /** this person's plan now (marked "Current plan") */
  current: boolean;
  button: { label: string; aria: string; primary: boolean; disabled: boolean };
}

export interface PaywallView {
  kind: PaywallKind;
  interval: CloudInterval;
  intervals: CloudInterval[];
  /** the team size the Work cards are priced for */
  members: number;
  /** the stepper's count: 1 on Personal, the team's size on Work */
  people: number;
  showKinds: boolean;
  showStepper: boolean;
  stepper: { min: number; max: number };
  /** Free as a wide card under the plans (buy mode, Personal; not one of the grid's columns) */
  free: boolean;
  /** Custom last (Work) */
  custom: boolean;
  cells: PaywallCell[];
  /** how many cards in the grid (Free isn't one): its columns follow it, 4 at most across */
  columns: number;
  /** the free trial a pick starts with, in days (0: none, or this is a plan change) */
  trialDays: number;
  /** what those days cost ("$1"); absent while they are free */
  trialPrice?: string;
}

export function paywallView(catalog: CloudCatalog | null | undefined, o: {
  mode: PaywallMode; kind: PaywallKind; interval: CloudInterval; members: number;
  current?: CurrentPlan | null; soldOut?: boolean; blocked?: boolean;
  /** the free trial this viewer's first plan starts with (`trialDaysOf`); ignored for someone changing a plan */
  trialDays?: number;
  /** what the trial's days cost (`trialPriceOf`: "$1"); absent, the buttons say "free" */
  trialPrice?: string;
}): PaywallView {
  const hasWork = !!catalog?.work?.plans.length;
  const kind: PaywallKind = o.mode === 'team' ? 'work' : o.mode === 'personal' || !hasWork ? 'personal' : o.kind;
  const intervals = paywallIntervals(catalog, kind);
  const interval = intervals.includes(o.interval) ? o.interval : (intervals[0] ?? 'monthly');
  const bounds = catalog?.work?.members ?? CLOUD_TEAM_MEMBERS;
  const members = Math.min(bounds.max, Math.max(bounds.min, Math.round(o.members)));
  const cards = kind === 'work' ? workPaywall(catalog, interval, members) : personalPaywall(catalog, interval);
  const order = cards.map((c) => c.id);
  const current = o.current ?? undefined;
  const trialDays = !current && o.trialDays && o.trialDays > 0 ? Math.round(o.trialDays) : 0;
  const trialPrice = trialDays ? o.trialPrice : undefined;
  const cells = cards.map((c): PaywallCell => {
    const move = current ? planMove(order, current, { plan: c.id, interval, ...(current.seats !== undefined ? { seats: members } : {}) }) : null;
    const isCurrent = !!current && c.id === current.plan;
    const label = c.off ? (c.offText ?? `Choose ${c.name}`) : move ? planMoveLabel(move, c.name, interval) : trialDays ? trialCta(trialDays, trialPrice) : `Choose ${c.name}`;
    const disabled = c.off || move === 'current' || (!!o.soldOut && !current) || !!o.blocked;
    const highlight = current ? isCurrent : c.highlight;
    const badge = isCurrent ? { text: CURRENT_PLAN, tone: 'accent' as const } : current && c.highlight ? undefined : c.badge;
    const { badge: _drop, ...card } = c;
    void _drop;
    // a trial's button says the same on every card, so its spoken name adds the plan
    const spoken = trialDays && !c.off ? `${label} of ${c.name}` : label;
    return {
      ...card, ...(trialDays ? { sub: trialSub(trialDays, interval, trialPrice) } : {}), ...(badge ? { badge } : {}), highlight, current: isCurrent,
      button: {
        label,
        aria: kind === 'work' && !isCurrent && !c.off ? `${spoken} for ${members} member${members === 1 ? '' : 's'}` : spoken,
        primary: !disabled && (current ? move === 'upgrade' || move === 'interval' || move === 'seats' : c.highlight),
        disabled,
      },
    };
  });
  const free = o.mode === 'buy' && kind === 'personal';
  const custom = kind === 'work';
  return {
    kind, interval, intervals, members, people: kind === 'work' ? members : 1,
    showKinds: o.mode === 'buy' && hasWork,
    showStepper: o.mode !== 'personal' && hasWork,
    stepper: { min: o.mode === 'team' ? bounds.min : 1, max: bounds.max },
    free, custom, cells, columns: cells.length + (custom ? 1 : 0), trialDays, ...(trialPrice ? { trialPrice } : {}),
  };
}

/**
 * The stepper, the site's way: on Personal it's 1, and stepping up moves to Work at the team minimum; on Work stepping
 * below the minimum moves back to Personal (in `team` mode it stays a team).
 */
export function stepPeople(mode: PaywallMode, kind: PaywallKind, n: number, bounds: { min: number; max: number } = CLOUD_TEAM_MEMBERS): { kind: PaywallKind; members?: number } {
  if (mode === 'team') return { kind: 'work', members: Math.min(bounds.max, Math.max(bounds.min, n)) };
  if (n < bounds.min) return { kind: 'personal' };
  if (kind === 'personal') return { kind: 'work', members: bounds.min };
  return { kind: 'work', members: Math.min(bounds.max, n) };
}

// ---------------------------------------------------------------------------------------------------------------
// The Free and Custom cards (no catalog behind them)

export const FREE_CARD = {
  name: 'Free',
  price: '$0',
  per: '/ forever',
  sub: 'On your own computer',
  blurb: 'Bots that work on your Mac or PC while it\'s on. No account, no card.',
  rows: [
    { icon: 'laptop', text: 'Your own computer' },
    ...['Unlimited bots on your own computer', 'Computer use in your real apps', 'A Telegram line to every bot', 'Routines, teach mode and memory', 'Mac, Windows and Linux']
      .map((text) => ({ icon: 'check' as const, text })),
  ] as PlanRow[],
} as const;

export const CUSTOM_CARD = {
  name: 'Custom',
  price: 'Let\'s talk',
  sub: 'Priced for your team',
  blurb: 'For bigger teams, or a setup that needs something different.',
  talk: 'Talk to us',
  email: 'Email us',
  rows: [
    { icon: 'users', text: `More than ${CLOUD_TEAM_MEMBERS.max} people` },
    { icon: 'chip', text: 'A bigger computer for your team' },
    { icon: 'sparkle', text: 'Help setting up your bots' },
    { icon: 'send', text: 'A direct line to us for support' },
  ] as PlanRow[],
} as const;

// ---------------------------------------------------------------------------------------------------------------
// The website's icons, as SVG markup

/** Claude's mark (chat-core `PROVIDER_MARKS`, what the model pickers draw) fitted to the icons' 24×24 box, in its own colour */
const CLAUDE_MARK = PROVIDER_MARKS['claude-code']!;
const CLAUDE_ICON = `<path transform="translate(1.5 1.5) scale(${(21 / 257).toFixed(5)})" d="${CLAUDE_MARK.paths[0]!.d}" fill="${CLAUDE_MARK.color ?? 'currentColor'}" stroke="none"/>`;

const ICON_PATHS: Record<PaywallIcon, string> = {
  claude: CLAUDE_ICON,
  send: '<path d="M20 4L4 10.5l7 2.5 2.5 7z"/><path d="M20 4l-9 9"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l2 2M18 5l2 2"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  shield: '<path d="M12 3l7 3v5.5c0 4.5-3 7.8-7 9.5-4-1.7-7-5-7-9.5V6z"/><path d="M9 12l2 2 4-4"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  storage: '<ellipse cx="12" cy="6.5" rx="7" ry="2.5"/><path d="M5 6.5v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-11"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17 14.2a5.5 5.5 0 0 1 3.5 4.8"/>',
  infinity: '<path d="M12 12c-1.8-2.4-3.3-3.5-5-3.5a3.5 3.5 0 0 0 0 7c1.7 0 3.2-1.1 5-3.5zm0 0c1.8 2.4 3.3 3.5 5 3.5a3.5 3.5 0 0 0 0-7c-1.7 0-3.2 1.1-5 3.5z"/>',
  tag: '<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-7.3 7.3a1 1 0 0 1-1.4 0z"/><circle cx="8" cy="8" r="1.3"/>',
  moonSleep: '<path d="M18.5 14.5A7 7 0 0 1 9.5 5.5a7 7 0 1 0 9 9z"/><path d="M15 4h4l-4 4h4"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  cloud: '<path d="M7 18.5a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.6 1.6A3.8 3.8 0 0 1 17.5 18.5z"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/>',
  bolt: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14"/>',
  apple: '<path fill="currentColor" stroke="none" d="M16.4 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.9-.9-3.1-.8-1.6 0-3 .9-3.9 2.3-1.7 2.9-.4 7.2 1.2 9.5.8 1.1 1.7 2.4 3 2.4 1.2 0 1.7-.8 3.1-.8s1.9.8 3.1.8c1.3 0 2.1-1.2 2.9-2.3.9-1.3 1.3-2.6 1.3-2.7 0 0-2.6-1-2.7-4zM14.1 5.9c.6-.8 1.1-1.9.9-3-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1.1.1 2.1-.5 2.8-1.3z"/>',
  windows: '<path fill="currentColor" stroke="none" d="M3 5.5l7.5-1v7H3zM11.5 4.3L21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.3z"/>',
  linux: '<path fill="currentColor" stroke="none" d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01-.018-.2v-.02a1.772 1.772 0 01.15-.768c.082-.22.232-.406.43-.533a.985.985 0 01.594-.2zm-2.962.059h.036c.142 0 .27.048.399.135.146.129.264.288.344.465.09.199.14.4.153.667v.004c.007.134.006.2-.002.266v.08c-.03.007-.056.018-.083.024-.152.055-.274.135-.393.2.012-.09.013-.18.003-.267v-.015c-.012-.133-.04-.2-.082-.333a.613.613 0 00-.166-.267.248.248 0 00-.183-.064h-.021c-.071.006-.13.04-.186.132a.552.552 0 00-.12.27.944.944 0 00-.023.33v.015c.012.135.037.2.08.334.046.134.098.2.166.268.01.009.02.018.034.024-.07.057-.117.07-.176.136a.304.304 0 01-.131.068 2.62 2.62 0 01-.275-.402 1.772 1.772 0 01-.155-.667 1.759 1.759 0 01.08-.668 1.43 1.43 0 01.283-.535c.128-.133.26-.2.418-.2zm1.37 1.706c.332 0 .733.065 1.216.399.293.2.523.269 1.052.468h.003c.255.136.405.266.478.399v-.131a.571.571 0 01.016.47c-.123.31-.516.643-1.063.842v.002c-.268.135-.501.333-.775.465-.276.135-.588.292-1.012.267a1.139 1.139 0 01-.448-.067 3.566 3.566 0 01-.322-.198c-.195-.135-.363-.332-.612-.465v-.005h-.005c-.4-.246-.616-.512-.686-.71-.07-.268-.005-.47.193-.6.224-.135.38-.271.483-.336.104-.074.143-.102.176-.131h.002v-.003c.169-.202.436-.47.839-.601.139-.036.294-.065.466-.065zm2.8 2.142c.358 1.417 1.196 3.475 1.735 4.473.286.534.855 1.659 1.102 3.024.156-.005.33.018.513.064.646-1.671-.546-3.467-1.089-3.966-.22-.2-.232-.335-.123-.335.59.534 1.365 1.572 1.646 2.757.13.535.16 1.104.021 1.67.067.028.135.06.205.067 1.032.534 1.413.938 1.23 1.537v-.043c-.06-.003-.12 0-.18 0h-.016c.151-.467-.182-.825-1.065-1.224-.915-.4-1.646-.336-1.77.465-.008.043-.013.066-.018.135-.068.023-.139.053-.209.064-.43.268-.662.669-.793 1.187-.13.533-.17 1.156-.205 1.869v.003c-.02.334-.17.838-.319 1.35-1.5 1.072-3.58 1.538-5.348.334a2.645 2.645 0 00-.402-.533 1.45 1.45 0 00-.275-.333c.182 0 .338-.03.465-.067a.615.615 0 00.314-.334c.108-.267 0-.697-.345-1.163-.345-.467-.931-.995-1.788-1.521-.63-.4-.986-.87-1.15-1.396-.165-.534-.143-1.085-.015-1.645.245-1.07.873-2.11 1.274-2.763.107-.065.037.135-.408.974-.396.751-1.14 2.497-.122 3.854a8.123 8.123 0 01.647-2.876c.564-1.278 1.743-3.504 1.836-5.268.048.036.217.135.289.202.218.133.38.333.59.465.21.201.477.335.876.335.039.003.075.006.11.006.412 0 .73-.134.997-.268.29-.134.52-.334.74-.4h.005c.467-.135.835-.402 1.044-.7zm2.185 8.958c.037.6.343 1.245.882 1.377.588.134 1.434-.333 1.791-.765l.211-.01c.315-.007.577.01.847.268l.003.003c.208.199.305.53.391.876.085.4.154.78.409 1.066.486.527.645.906.636 1.14l.003-.007v.018l-.003-.012c-.015.262-.185.396-.498.595-.63.401-1.746.712-2.457 1.57-.618.737-1.37 1.14-2.036 1.191-.664.053-1.237-.2-1.574-.898l-.005-.003c-.21-.4-.12-1.025.056-1.69.176-.668.428-1.344.463-1.897.037-.714.076-1.335.195-1.814.12-.465.308-.797.641-.984l.045-.022zm-10.814.049h.01c.053 0 .105.005.157.014.376.055.706.333 1.023.752l.91 1.664.003.003c.243.533.754 1.064 1.189 1.637.434.598.77 1.131.729 1.57v.006c-.057.744-.48 1.148-1.125 1.294-.645.135-1.52.002-2.395-.464-.968-.536-2.118-.469-2.857-.602-.369-.066-.61-.2-.723-.4-.11-.2-.113-.602.123-1.23v-.004l.002-.003c.117-.334.03-.752-.027-1.118-.055-.401-.083-.71.043-.94.16-.334.396-.4.69-.533.294-.135.64-.202.915-.47h.002v-.002c.256-.268.445-.601.668-.838.19-.201.38-.336.663-.336zm7.159-9.074c-.435.201-.945.535-1.488.535-.542 0-.97-.267-1.28-.466-.154-.134-.28-.268-.373-.335-.164-.134-.144-.333-.074-.333.109.016.129.134.199.2.096.066.215.2.36.333.292.2.68.467 1.167.467.485 0 1.053-.267 1.398-.466.195-.135.445-.334.648-.467.156-.136.149-.267.279-.267.128.016.034.134-.147.332a8.097 8.097 0 01-.69.468zm-1.082-1.583V5.64c-.006-.02.013-.042.029-.05.074-.043.18-.027.26.004.063 0 .16.067.15.135-.006.049-.085.066-.135.066-.055 0-.092-.043-.141-.068-.052-.018-.146-.008-.163-.065zm-.551 0c-.02.058-.113.049-.166.066-.047.025-.086.068-.14.068-.05 0-.13-.02-.136-.068-.01-.066.088-.133.15-.133.08-.031.184-.047.259-.005.019.009.036.03.03.05v.02h.003z"/>',
};

/** an icon as the website draws it: `<svg>` 24×24 viewBox, stroke 1.5, `currentColor` */
export function paywallIconSvg(name: PaywallIcon, size = 16, cls = ''): string {
  return `<svg${cls ? ` class="${cls}"` : ''} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}
/** just the paths (for a renderer that draws its own `<svg>`) */
export const paywallIconPaths = (name: PaywallIcon): string => ICON_PATHS[name];

// ---------------------------------------------------------------------------------------------------------------
// The website's look: its colours (globals.css `:root` and `.light`) and its paywall CSS, scoped to `.pw`.

/** the site's palette for the paywall: dark (the site's own) and light (its `.light` set) */
export const PAYWALL_TOKENS: Record<'dark' | 'light', Record<string, string>> = {
  dark: {
    '--pw-bg': '#0a0a0a', '--pw-card': '#1a1a1a', '--pw-card-2': '#2c2c2c', '--pw-fg': '#ffffff', '--pw-muted': '#7d8187', '--pw-border': '#1f2228',
    '--pw-btn-primary': '#ffffff', '--pw-btn-primary-fg': '#0a0a0a', '--pw-btn-primary-hover': '#e9e9e9',
    '--pw-btn-soft': '#2c2c2c', '--pw-btn-soft-fg': '#d5d9e2', '--pw-btn-soft-hover': 'rgba(255, 255, 255, .1)',
    '--pw-accent': '#ee7944', '--pw-accent-soft': 'rgba(238, 121, 68, .16)', '--pw-seg': 'rgba(255, 255, 255, .05)',
  },
  light: {
    '--pw-bg': '#ffffff', '--pw-card': '#f9f8f6', '--pw-card-2': '#ecebe8', '--pw-fg': '#0a0a0a', '--pw-muted': '#6b7079', '--pw-border': '#d9dde6',
    '--pw-btn-primary': '#0a0a0a', '--pw-btn-primary-fg': '#ffffff', '--pw-btn-primary-hover': '#262a31',
    '--pw-btn-soft': '#ecebe8', '--pw-btn-soft-fg': '#0a0a0a', '--pw-btn-soft-hover': 'rgba(0, 0, 0, .08)',
    '--pw-accent': '#ee7944', '--pw-accent-soft': 'rgba(238, 121, 68, .16)', '--pw-seg': 'rgba(0, 0, 0, .05)',
  },
};

/** the face the site sets everything in (each surface serves the file: Geist Variable, latin, OFL) */
export const PAYWALL_FONT_FAMILY = '"Geist Variable", "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif';

const vars = (t: Record<string, string>) => Object.entries(t).map(([k, v]) => `${k}:${v}`).join(';');

/**
 * The paywall's CSS, the site's values (globals.css + the Tailwind classes PlanCards.tsx uses), as one stylesheet:
 * `light` and `dark` are the selectors (or `@media` wrappers) that pick the palette. Breakpoints are
 * `PAYWALL_BREAKPOINTS`, measured on the paywall's own width (a container query), so every surface lays the cards out
 * alike at the same width; the site and the account pages hold the plans at the viewport less their side padding.
 */
/**
 * Where the cards change layout, in px of the paywall's own width (the site and the account pages: the viewport less
 * 32px of side padding below 1024px, 48px from there, so `row` 868 is a 900px window, `full` 976 a 1024px one, `stack`
 * 608 a 640px phone-or-tablet edge). The ONE place these numbers live: appubot.com's PlanCards and the account pages
 * draw from `paywallCss`, the desktop's Billing too.
 * - `full` and wider: the site's own sizes, every card in one row.
 * - `row` to `full`: still one row, the cards shrunk step by step (`tight` and below tighter again) rather than wrapped.
 * - `stack` to `row` (tablets): one row that scrolls sideways, each card `snapCol` wide and snapping, never 2×2.
 * - below `stack` (phones): one column.
 * The desktop's Settings (`data-row`) keeps one row at every width, shrinking further below `narrow`.
 */
export const PAYWALL_BREAKPOINTS = { stack: 608, row: 868, tight: 920, full: 976, narrow: 760, snapCol: 252 } as const;

const below = (px: number) => `${px - 0.02}px`;

/** the row layout: the columns, and each card's parts sharing rows across the cards (subgrid) */
const rowRules = (p: string) => `${p} .pw-cols[data-cols="4"]{grid-template-columns:repeat(4,minmax(0,1fr))}
${p} .pw-cols[data-cols="3"]{grid-template-columns:repeat(3,minmax(0,1fr))}
${p} .pw-cols[data-cols="2"]{grid-template-columns:repeat(2,minmax(0,1fr))}
${p} .pw-cols{grid-template-rows:repeat(7,auto)}
${p} .pw-cell{display:grid;grid-row:span 7;grid-template-rows:subgrid;row-gap:0;align-content:start}
${p} .pw-cta:has(.pw-cta-stack),${p} .pw-cell>.pw-cta+.pw-rows[data-top]{grid-row:span 2}
${p} .pw-cta:has(.pw-cta-stack)+.pw-rows[data-top]{grid-row:span 1}
${p} .pw-head{align-self:start;flex-wrap:wrap;row-gap:4px}`;

/** first step down from the site's sizes: tighter padding, a smaller price, smaller rows and badges */
const shrink1 = (p: string) => `${p} .pw-seg>button,${p} .pw-seg>a{padding:6px 14px}
${p} .pw-cell{padding:18px 14px}
${p} .pw-tags{gap:6px}
${p} .pw-badge{padding:1px 8px;font-size:11px;line-height:18px}
${p} .pw-price{margin-top:14px;column-gap:6px}
${p} .pw-amount{font-size:28px;line-height:32px}
${p} .pw-struck{font-size:15px}
${p} .pw-per,${p} .pw-sub{font-size:12.5px;line-height:18px}
${p} .pw-sub{min-height:18px}
${p} .pw-blurb{margin-top:12px;font-size:12.5px;line-height:18px}
${p} .pw-cta{margin-top:14px}
${p} .pw-btn{height:auto;min-height:36px;padding:8px 10px;font-size:13px;line-height:18px;white-space:normal;text-align:center}
${p} .pw-spec{margin-top:18px;padding-top:14px;font-size:11px;line-height:14px}
${p} .pw-rows{gap:7px;margin-top:10px}
${p} .pw-rows[data-top]{margin-top:18px;padding-top:14px}
${p} .pw-rows li{gap:7px;font-size:12px;line-height:17px}
${p} .pw-rows li svg{width:14px;height:14px;margin-top:1.5px}`;

/** the second step: less padding again and a smaller price */
const shrink2 = (p: string) => `${p} .pw-cell{padding:16px 12px}
${p} .pw-amount{font-size:26px;line-height:30px}
${p} .pw-struck{font-size:14px}`;

/** the narrowest one-row step (the desktop's Settings only) */
const shrink3 = (p: string) => `${p} .pw-amount{font-size:24px;line-height:28px}
${p} .pw-rows li{font-size:11.5px;line-height:16px}`;

/** the sideways row on tablets: fixed-width cards that snap, the grid wider than the paywall */
const scrollRules = (p: string, col: number) => `${p} .pw-grid{overflow-x:auto;overflow-y:clip;scroll-snap-type:x mandatory;overscroll-behavior-x:contain;scrollbar-width:none;-webkit-overflow-scrolling:touch}
${p} .pw-grid::-webkit-scrollbar{display:none}
${[4, 3, 2].map((n) => `${p} .pw-cols[data-cols="${n}"]{grid-template-columns:repeat(${n},minmax(${col}px,1fr));min-width:${n * col + n - 1}px}`).join('\n')}
${p} .pw-cell{scroll-snap-align:start}`;

/** every layout rule for the cards: the site's and account pages' four steps, and the desktop's always-one-row */
export function paywallLayoutCss(): string {
  const b = PAYWALL_BREAKPOINTS;
  const site = '.pw:not([data-row])';
  const row = '.pw[data-row]';
  return `/* one row from ${b.row}px of plans (a 900px window), shrinking below ${b.full}px; a sideways row of snapping
   cards from ${b.stack}px; one column below. Each card's parts share rows across the cards (subgrid: head, price, its
   line, blurb, button, spec label, rows), so a badge that wraps under its name, or a blurb a line longer, moves the
   whole row, never one card; Free's rows (no spec label) and Custom's two buttons span the spec label's row. */
@container (min-width:${b.full}px){.pw-blurb{min-height:40px}}
@container (min-width:${b.stack}px){
${rowRules(site)}
}
${rowRules(row)}
@container (min-width:${b.stack}px) and (max-width:${below(b.row)}){
${scrollRules(site, b.snapCol)}
}
@container (max-width:${below(b.full)}){
${shrink1(row)}
}
@container (min-width:${b.stack}px) and (max-width:${below(b.full)}){
${shrink1(site)}
}
@container (max-width:${below(b.tight)}){
${shrink2(row)}
}
@container (min-width:${b.row}px) and (max-width:${below(b.tight)}){
${shrink2(site)}
}
@container (max-width:${below(b.narrow)}){
${shrink3(row)}
}`;
}

export function paywallCss(o: { light: string; dark: string }): string {
  const scheme = (sel: string, t: Record<string, string>) => (sel.startsWith('@media') ? `${sel}{.pw{${vars(t)}}}` : `${sel}{${vars(t)}}`);
  return `
.pw{${vars(PAYWALL_TOKENS.dark)}}
${scheme(o.light, PAYWALL_TOKENS.light)}
${scheme(o.dark, PAYWALL_TOKENS.dark)}
.pw{container-type:inline-size;display:flex;flex-direction:column;gap:16px;font-family:${PAYWALL_FONT_FAMILY};font-size:16px;line-height:1.5;color:var(--pw-fg);-webkit-font-smoothing:antialiased;text-align:left}
.pw *,.pw *::before,.pw *::after{box-sizing:border-box}
:where(.pw) h3,:where(.pw) p,:where(.pw) ul{margin:0;padding:0}
:where(.pw) h3{font-weight:500;text-wrap:balance}
:where(.pw) p{text-wrap:pretty}
:where(.pw) ul{list-style:none}
.pw svg{display:block;flex-shrink:0}
.pw .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.pw button,.pw a{font-family:inherit}
.pw-controls{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}
.pw-controls-end{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px}
@container (max-width:607.98px){.pw-controls{justify-content:center}}
.pw-seg{display:inline-flex;padding:2px;border-radius:9999px;background:var(--pw-seg)}
.pw .pw-seg>button,.pw .pw-seg>a{appearance:none;display:inline-block;height:auto;margin:0;border:0;border-radius:9999px;padding:6px 20px;font-size:14px;line-height:20px;font-weight:500;color:var(--pw-muted);background:transparent;box-shadow:none;cursor:pointer;white-space:nowrap;text-decoration:none;transition:color .14s,background-color .14s}
.pw .pw-seg>button:hover,.pw .pw-seg>a:hover{color:var(--pw-fg);background:transparent;text-decoration:none}
.pw .pw-seg>[aria-checked="true"],.pw .pw-seg>[aria-checked="true"]:hover{background:var(--pw-bg);color:var(--pw-fg);box-shadow:0 1px 2px rgba(0,0,0,.3)}
.pw .pw-seg>button:focus-visible,.pw .pw-seg>a:focus-visible{outline:2px solid var(--pw-accent);outline-offset:1px;box-shadow:none}
.pw-save{margin-left:4px;color:var(--pw-accent)}
.pw-members{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:9999px;background:var(--pw-seg);font-size:14px;line-height:20px;font-weight:500;color:var(--pw-fg)}
.pw .pw-members>button,.pw .pw-members>a{appearance:none;display:grid;place-items:center;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:9999px;color:var(--pw-muted);background:transparent;box-shadow:none;cursor:pointer;transition:color .14s,background-color .14s,opacity .14s}
.pw .pw-members>button:hover:not(:disabled),.pw .pw-members>a:hover:not([aria-disabled="true"]){color:var(--pw-fg);background:var(--pw-bg)}
.pw .pw-members>button:disabled,.pw .pw-members>a[aria-disabled="true"]{opacity:.35;cursor:not-allowed;pointer-events:auto}
.pw .pw-members>button:focus-visible,.pw .pw-members>a:focus-visible{outline:2px solid var(--pw-accent);outline-offset:1px;box-shadow:none}
.pw-members output{min-width:76px;text-align:center;font-variant-numeric:tabular-nums}
.pw-grid{overflow:clip;padding:0;border:1px solid var(--pw-border);border-radius:24px;background:var(--pw-card)}
.pw-cols{display:grid;grid-template-columns:minmax(0,1fr);gap:1px;background:var(--pw-border)}
.pw-cell{position:relative;display:flex;flex-direction:column;min-width:0;padding:24px;background:var(--pw-card);transition:background-color .25s ease-out,opacity .25s ease-out}
.pw-cell[data-highlight]{background:color-mix(in srgb,var(--pw-accent) 5%,var(--pw-card))}
.pw-cell[data-highlight]::before{content:"";position:absolute;inset:0 0 auto;height:2px;background:var(--pw-accent)}
.pw-cell>*{transition:opacity .25s ease-out}
.pw-cell[data-off]>:not(:first-child),.pw-cell[data-off]>:first-child h3{opacity:.4}
.pw-head{display:flex;min-height:24px;align-items:center;justify-content:space-between;gap:8px}
.pw-head h3{font-size:16px;line-height:26px;font-weight:500;color:var(--pw-fg)}
.pw-tags{display:flex;align-items:center;gap:8px}
.pw-where{display:flex;flex-shrink:0;color:var(--pw-muted)}
.pw-badge{flex-shrink:0;border-radius:9999px;padding:2px 10px;font-size:12px;line-height:20px;font-weight:500;background:var(--pw-card-2);color:var(--pw-muted)}
.pw-badge[data-tone="accent"]{background:var(--pw-accent-soft);color:var(--pw-accent)}
.pw-price{margin-top:20px;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px}
.pw-price[data-forever]{gap:6px}
.pw-amount{font-size:30px;line-height:36px;letter-spacing:-.01em;font-weight:500;font-variant-numeric:tabular-nums;color:var(--pw-fg)}
.pw-struck{font-size:16px;line-height:1.625;color:color-mix(in oklab,var(--pw-muted) 80%,transparent);text-decoration:line-through;text-decoration-thickness:1px}
.pw-per,.pw-sub{font-size:14px;line-height:20px;color:var(--pw-muted)}
.pw-sub{margin-top:4px;min-height:20px}
@container (min-width:608px){.pw-amount{font-size:36px;line-height:40px}.pw-struck{font-size:18px}}
.pw-blurb{margin-top:16px;font-size:14px;line-height:20px;color:color-mix(in oklab,var(--pw-fg) 90%,transparent)}
.pw-cta{margin-top:20px}
.pw-cta-stack{display:flex;flex-direction:column;gap:8px}
.pw .pw-btn{appearance:none;display:inline-flex;width:100%;align-items:center;justify-content:center;gap:6px;height:40px;margin:0;padding:0 18px;border:0;border-radius:9999px;font-size:14px;line-height:20px;font-weight:500;white-space:nowrap;user-select:none;cursor:pointer;text-decoration:none;box-shadow:none;background:var(--pw-btn-soft);color:var(--pw-btn-soft-fg);transition:background-color .2s ease-out,color .2s ease-out,filter .15s}
.pw .pw-btn:hover{background:var(--pw-btn-soft-hover);text-decoration:none}
.pw .pw-btn[data-primary]{background:var(--pw-btn-primary);color:var(--pw-btn-primary-fg)}
.pw .pw-btn[data-primary]:hover{background:var(--pw-btn-primary-hover)}
.pw .pw-btn:disabled,.pw .pw-btn[aria-disabled="true"]{cursor:not-allowed;opacity:1;pointer-events:auto}
.pw .pw-btn:disabled:hover{background:var(--pw-btn-soft)}
.pw .pw-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--pw-bg),0 0 0 4px rgba(255,255,255,.3)}
.pw .pw-btn[aria-busy="true"]::before{content:"";width:14px;height:14px;flex-shrink:0;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:pw-spin .7s linear infinite}
@keyframes pw-spin{to{transform:rotate(360deg)}}
.pw-spec{margin-top:24px;border-top:1px dashed var(--pw-border);padding-top:20px;font-size:12px;line-height:16px;font-weight:500;color:var(--pw-muted)}
.pw-rows{display:flex;flex-direction:column;gap:10px;margin-top:12px}
.pw-rows[data-top]{margin-top:24px;border-top:1px dashed var(--pw-border);padding-top:20px}
.pw-rows li{display:flex;align-items:flex-start;gap:10px;font-size:14px;line-height:20px;color:color-mix(in oklab,var(--pw-fg) 85%,transparent)}
.pw-rows li svg{margin-top:2px;color:var(--pw-muted)}
/* Free: a wide card under the plans. Its name, price and blurb, its rows (two columns once there's room) and its button.
   Side by side, its mark and badge sit right after the name (the card's corner is the button's then, not this column's
   end), and the rows are two text columns that each stack by themselves, so a row that wraps never stretches the one
   beside it; the space between rows is padding, which a column break keeps. */
.pw-free{display:grid;grid-template-columns:minmax(0,1fr);gap:20px;padding:24px;border:1px solid var(--pw-border);border-radius:24px;background:var(--pw-card)}
.pw-free .pw-price{margin-top:12px}
.pw-free .pw-blurb{margin-top:12px;min-height:0}
.pw-free .pw-rows{margin-top:0}
@container (min-width:608px){.pw-free{grid-template-columns:minmax(0,1fr) minmax(0,1.5fr);align-items:center;column-gap:32px}.pw-free .pw-head{justify-content:flex-start;gap:10px}.pw-free .pw-rows{display:block;columns:2;column-gap:24px;grid-row:span 2;margin-bottom:-10px}.pw-free .pw-rows li{break-inside:avoid;padding-bottom:10px}.pw-free-cta{grid-column:1}}
@container (min-width:868px){.pw-free{grid-template-columns:minmax(0,.85fr) minmax(0,1.65fr) minmax(180px,.6fr)}.pw-free .pw-rows{grid-row:auto}.pw-free-cta{grid-column:auto}}
.pw-note{margin-top:12px;padding:0 4px;font-size:14px;line-height:20px;color:var(--pw-muted)}
.pw-warn{padding:0 4px;font-size:14px;line-height:20px;color:var(--pw-accent)}
${paywallLayoutCss()}
@media (prefers-reduced-motion:reduce){.pw-cell,.pw-cell>*,.pw-members>button,.pw-seg>button{transition:none!important}}
`;
}
