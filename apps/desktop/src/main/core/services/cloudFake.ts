/**
 * A fake AppuBot Cloud backend in the Mac's own process, for development of the apps' cloud screens without the real
 * backend (`APPUBOT_CLOUD_FAKE=1`, dev only): it answers the backend's `/v1/...` API in the shapes
 * of protocol `cloud.ts` for one account, in whichever state is asked for (signed out, no plan, provisioning, running,
 * asleep, waking, on hold, cancelling, a downgrade scheduled, export-only…). The state comes from `APPUBOT_CLOUD_FAKE`'s
 * value, and changes at run time from `<dataDir>/cloud-fake.json` (`{ "state": "asleep" }`, watched). A checkout
 * provisions a computer after a moment, a start wakes one, a plan change applies at once (up) or is scheduled (down);
 * pairing hands out a pairing of this very Mac's gateway (the cloud computer stands in for itself: its "cloud" bots
 * are this Mac's own). Nothing here touches the network. Its catalog is the three plans with placeholder prices (the
 * real ones come from Dodo).
 *
 * Teams (Work plans): `team-admin`, `team-member`, `team-invite` and `personal-team` seed a
 * team "Acme" (you its admin, a member of it, invited to it, or a Pro plan of your own plus Acme's admin), and the
 * `/teams/:id/...` routes keep the backend's rules: a free seat to invite, seats within the plan and never below the
 * people on the team, the last admin stays, members can't touch billing; more seats or a bigger plan at once, fewer
 * or a smaller one at the period's end. A Work checkout makes a team with you as its admin.
 */
import { existsSync, readFileSync, unwatchFile, watchFile } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { CloudAccount, CloudBackup, CloudRepair, CloudRepairKind, CloudRepairState, CloudAwake, CloudCatalog, CloudComputer, CloudComputerState, CloudInterval, CloudInviteForMe, CloudNotice, CloudPairResponse, CloudPlanChangePreview, CloudPlanId, CloudPrice, CloudShape, CloudTeam, CloudTeamMember, CloudTeamRole, CloudTeamSummary, CloudWorkPlanId } from '@appubot/protocol';
import { CLOUD_API_PREFIX, CLOUD_TEAM_MEMBERS, cloudPaidSeats, isWorkPlan } from '@appubot/protocol';

export const FAKE_CLOUD_STATES = [
  'signed-out', 'no-plan', 'sold-out', 'provisioning', 'running', 'asleep', 'waking', 'stopped', 'past-due', 'on-hold',
  'cancelling', 'scheduled', 'export-only', 'suspended', 'failed', 'deleted',
  // teams (§6.11): admin of "Acme" with no plan of your own, a member of it, invited to it, a Pro plan plus Acme's admin
  'team-admin', 'team-member', 'team-invite', 'personal-team',
] as const;
const TEAM_STATES: readonly string[] = ['team-admin', 'team-member', 'team-invite', 'personal-team'];
export type FakeCloudState = (typeof FAKE_CLOUD_STATES)[number];
export const isFakeCloudState = (s: string): s is FakeCloudState => (FAKE_CLOUD_STATES as readonly string[]).includes(s);

/** `cloud-fake.json`: the state, and knobs the UI sessions turn */
export interface FakeCloudFile {
  state?: FakeCloudState;
  /** the plan and how it is paid (default pro, monthly) */
  plan?: CloudPlanId;
  interval?: CloudInterval;
  /** awake hours this month (default 37.5) */
  awakeHours?: number;
  /** raise it to add a notice ("Ada finished"): each step up adds one */
  notice?: number;
  /** the signed-in account's address (default you@example.com) */
  email?: string;
  /** the team states: Acme's plan, its seats and its name (default team, 3, Acme) */
  team?: CloudWorkPlanId;
  seats?: number;
  teamName?: string;
  /** a launch gift is on (the free Claude day: `GET /promo` says open for the next `giftHours`, default 24; its token is a stand-in, so the card and pickers show but Claude doesn't answer) */
  gift?: boolean;
  giftHours?: number;
}

export interface CloudFakeOptions {
  state?: string;
  /** the watched file (absent: the state only changes through `set`) */
  file?: string;
  /** a pairing of the stand-in computer: the Mac's own gateway */
  pairing?: () => Promise<{ code: string; key: string; hosts: string[]; port: number; hostName: string; publicUrl: string; expiresAt: number }>;
  /** the stand-in computer's address, when `pairing` isn't asked (the view's `publicUrl`) */
  publicUrl?: () => string;
  now?: () => number;
  /** something changed by itself (a timer, the file): the account service re-reads the view */
  onChange?: () => void;
  log?: (m: string) => void;
}

const DAY = 86_400_000;
/** the plans as the backend's config has them (placeholders in the shape of the backend's catalog; work plans' is the base) */
const PLANS: Record<CloudPlanId, { name: string; blurb: string; shape: CloudShape; monthlyUsd: number; rank: number; maxMembers?: number }> = {
  starter: { name: 'Starter', blurb: 'A few bots, routines and Telegram, running in the cloud around the clock.', shape: { cpu: 2, memory: 4, disk: 12 }, monthlyUsd: 19, rank: 1 },
  pro: { name: 'Pro', blurb: 'Bots that spend the day in a browser and your apps, on a cloud computer.', shape: { cpu: 4, memory: 8, disk: 20 }, monthlyUsd: 49, rank: 2 },
  max: { name: 'Max', blurb: 'Many bots at once, heavy websites, long jobs and big files, all in the cloud.', shape: { cpu: 4, memory: 16, disk: 40 }, monthlyUsd: 79, rank: 3 },
  ultra: { name: 'Ultra', blurb: 'The biggest computer in the cloud, for bots that never stop.', shape: { cpu: 4, memory: 32, disk: 80 }, monthlyUsd: 109, rank: 4 },
  team: { name: 'Team', blurb: 'A small team sharing bots, routines and apps on one computer in the cloud.', shape: { cpu: 4, memory: 8, disk: 20 }, monthlyUsd: 49, rank: 1, maxMembers: 5 },
  business: { name: 'Business', blurb: 'A growing team with busy bots all day, on one computer in the cloud.', shape: { cpu: 4, memory: 16, disk: 40 }, monthlyUsd: 79, rank: 2, maxMembers: 15 },
  scale: { name: 'Scale', blurb: 'The biggest computer in the cloud, for teams whose bots never stop.', shape: { cpu: 4, memory: 32, disk: 80 }, monthlyUsd: 109, rank: 3, maxMembers: 30 },
};
const PLAN_ORDER: CloudPlanId[] = ['starter', 'pro', 'max', 'ultra'];
const WORK_ORDER: CloudWorkPlanId[] = ['team', 'business', 'scale'];
/** what each member after the first adds a month (the base includes the first) */
const MEMBER_USD = 20;
/** the free trial a first plan starts with, as the real backend's config has it */
const FAKE_TRIAL_DAYS = 3;
const usd = (n: number, interval: CloudPrice['interval']): CloudPrice => ({ amount: Math.round(n * 100), currency: 'USD', display: `$${Number.isInteger(n) ? n : n.toFixed(2)}`, interval, taxInclusive: false });
const per = (interval: CloudInterval): CloudPrice['interval'] => (interval === 'yearly' ? 'year' : 'month');
const price = (plan: CloudPlanId, interval: CloudInterval): CloudPrice => usd(PLANS[plan].monthlyUsd * (interval === 'yearly' ? 10 : 1), per(interval));
/** a team's price: base + (seats − 1) × per member (the first included) */
const teamPrice = (plan: CloudPlanId, interval: CloudInterval, seats: number): CloudPrice => usd((PLANS[plan].monthlyUsd + MEMBER_USD * cloudPaidSeats(seats)) * (interval === 'yearly' ? 10 : 1), per(interval));

/** a team the fake knows: the plan, seats, the people and open invites, and you on it */
interface FakeTeam {
  id: string; name: string; plan: CloudWorkPlanId; interval: CloudInterval; seats: number;
  scheduled: { plan: CloudWorkPlanId; interval: CloudInterval; seats: number } | null;
  people: { id: string; email: string; role: CloudTeamRole; since: number }[];
  invites: { id: string; email: string; role: CloudTeamRole; since: number; expiresAt: number; invitedBy: string }[];
  computer: 'provisioning' | 'running' | 'asleep';
  shape: CloudShape;
  cycleStart: number;
}
const ME = 'acc_fake';

export class CloudFakeBackend {
  state: FakeCloudState = 'signed-out';
  private file: FakeCloudFile = {};
  private token: string | null = null;
  private signedOutByState = false;
  private notices: CloudNotice[] = [];
  private noticeSeq = 0;
  private cycleStart: number;
  /** the plan the account is on, and a downgrade waiting for the period's end */
  private plan: { plan: CloudPlanId; interval: CloudInterval } | null = null;
  private scheduled: { plan: CloudPlanId; interval: CloudInterval } | null = null;
  /** people removed from a team (a second remove answers the same, idempotent) */
  private removed = new Set<string>();
  /** the instance's size (a downgrade keeps the larger disk) */
  private shape: CloudShape | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** the teams you are on, invites waiting for you, and the team state last seeded */
  private teams: FakeTeam[] = [];
  private invitesForMe: (CloudInviteForMe & { team: FakeTeam })[] = [];
  private seeded: string | null = null;
  private readonly now: () => number;
  readonly fetch: typeof fetch;
  /** every request, newest last (tests) */
  readonly requests: { method: string; path: string; body?: unknown }[] = [];

  constructor(private o: CloudFakeOptions = {}) {
    this.now = o.now ?? (() => Date.now());
    this.cycleStart = this.now() - 18 * DAY;
    const initial = o.state && isFakeCloudState(o.state) ? o.state : 'signed-out';
    this.state = initial;
    this.seed(initial);
    if (o.file) {
      this.readFile();
      watchFile(o.file, { interval: 1000, persistent: false }, () => { this.readFile(); });
    }
    this.fetch = (async (input: string | URL | Request, init?: RequestInit) => this.handle(input, init)) as typeof fetch;
  }

  close(): void {
    if (this.o.file) unwatchFile(this.o.file);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Move to a state (a timer, the file, a test); the account service hears of it. */
  set(state: FakeCloudState): void {
    if (TEAM_STATES.includes(state)) {
      if (this.seeded === state) return;
      this.seed(state);
      this.o.log?.(`cloud fake: state ${state}`);
      this.o.onChange?.();
      return;
    }
    if (state === this.state) return;
    this.state = state;
    this.o.log?.(`cloud fake: state ${state}`);
    if (state === 'signed-out') { this.token = null; this.signedOutByState = true; }
    if (state === 'scheduled' && !this.scheduled) this.scheduled = { plan: 'starter', interval: 'monthly' };
    this.o.onChange?.();
  }

  get signedIn(): boolean { return !!this.token; }

  /**
   * The team states: Acme seeded, and the personal side as such a person's would be (no plan, or Pro running). Other
   * states leave the teams as they are (a checkout or an invite may have made one).
   */
  private seed(state: FakeCloudState): void {
    if (!TEAM_STATES.includes(state)) return;
    this.seeded = state;
    const now = this.now();
    const f = this.file;
    const plan: CloudWorkPlanId = f.team && isWorkPlan(f.team) ? f.team : 'team';
    const name = f.teamName ?? 'Acme';
    const me = f.email ?? 'you@example.com';
    const t: FakeTeam = {
      id: 'team_acme', name, plan, interval: 'monthly', seats: Math.min(PLANS[plan].maxMembers!, Math.max(2, f.seats ?? 3)), scheduled: null, people: [], invites: [],
      computer: 'running', shape: { ...PLANS[plan].shape }, cycleStart: now - 12 * DAY,
    };
    this.teams = [];
    this.invitesForMe = [];
    if (state === 'team-member') {
      t.people = [{ id: 'acc_alice', email: 'alice@acme.test', role: 'admin', since: now - 30 * DAY }, { id: ME, email: me, role: 'member', since: now - 9 * DAY }];
      t.invites = [{ id: 'inv_carol', email: 'carol@acme.test', role: 'member', since: now - DAY, expiresAt: now + 13 * DAY, invitedBy: 'alice@acme.test' }];
    } else {
      t.people = [{ id: ME, email: me, role: 'admin', since: now - 30 * DAY }, { id: 'acc_bob', email: 'bob@acme.test', role: 'member', since: now - 9 * DAY }];
      t.invites = [{ id: 'inv_carol', email: 'carol@acme.test', role: 'member', since: now - DAY, expiresAt: now + 13 * DAY, invitedBy: me }];
    }
    if (state === 'team-invite') {
      t.people = [{ id: 'acc_alice', email: 'alice@acme.test', role: 'admin', since: now - 30 * DAY }, { id: 'acc_bob', email: 'bob@acme.test', role: 'member', since: now - 9 * DAY }];
      t.seats = Math.max(t.seats, 4);
      t.invites = [{ id: 'inv_you', email: me, role: 'member', since: now - 3_600_000, expiresAt: now + 14 * DAY, invitedBy: 'alice@acme.test' }];
      this.invitesForMe = [{ id: 'inv_you', teamId: t.id, teamName: t.name, role: 'member', invitedBy: 'alice@acme.test', expiresAt: now + 14 * DAY, team: t }];
    } else {
      this.teams = [t];
    }
    if (state === 'personal-team') { this.state = 'running'; this.plan = { plan: 'pro', interval: 'monthly' }; this.shape = { ...PLANS.pro.shape }; }
    else this.state = 'no-plan';
    if (!this.token) this.signedOutByState = false;
  }

  private readFile(): void {
    if (!this.o.file || !existsSync(this.o.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.o.file, 'utf8')) as FakeCloudFile;
      const prevNotice = this.file.notice ?? 0;
      this.file = raw;
      if (raw.plan && raw.plan in PLANS) this.plan = { plan: raw.plan, interval: raw.interval ?? this.plan?.interval ?? 'monthly' };
      if ((raw.notice ?? 0) > prevNotice) for (let i = prevNotice; i < (raw.notice ?? 0); i++) this.addNotice(i % 3 === 0 ? 'needs-you' : i % 3 === 1 ? 'failed' : 'done');
      // a file that moves the team's plan or seats re-seeds the same state
      if (raw.state && TEAM_STATES.includes(raw.state) && (raw.team !== undefined || raw.seats !== undefined || raw.teamName !== undefined)) this.seeded = null;
      if (raw.state && isFakeCloudState(raw.state)) this.set(raw.state);
      else this.o.onChange?.();
    } catch (e) { this.o.log?.(`cloud fake: ${this.o.file} unreadable: ${String(e)}`); }
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    t.unref?.();
    this.timers.add(t);
  }

  addNotice(kind: CloudNotice['kind'], bot = 'Ada'): void {
    this.noticeSeq += 1;
    this.notices.push({ seq: this.noticeSeq, at: this.now(), bot, kind, threadId: 'thr_fake' });
    if (this.notices.length > 50) this.notices.splice(0, this.notices.length - 50);
    this.o.onChange?.();
  }

  /* ------------------------------------------------------------- views */

  private hasPlan(): boolean { return !['signed-out', 'no-plan', 'sold-out', 'deleted'].includes(this.state); }
  private currentPlan(): { plan: CloudPlanId; interval: CloudInterval } { return this.plan ?? { plan: (this.file.plan && this.file.plan in PLANS ? this.file.plan : 'pro'), interval: this.file.interval ?? 'monthly' }; }
  private currentShape(): CloudShape { return this.shape ?? PLANS[this.currentPlan().plan].shape; }

  private awake(): CloudAwake | undefined {
    if (['no-plan', 'sold-out', 'provisioning', 'deleted', 'failed'].includes(this.state)) return undefined;
    const used = this.file.awakeHours ?? 37.5;
    return { used, usedSeconds: Math.round(used * 3600), cycleStart: this.cycleStart, cycleEnd: this.cycleStart + 30 * DAY };
  }

  account(): CloudAccount {
    const now = this.now();
    const base: CloudAccount = {
      id: ME, email: this.file.email ?? 'you@example.com', createdAt: now - 40 * DAY, signupsOpen: this.state !== 'sold-out', emailVerified: true,
      teams: this.teams.map((t) => this.teamSummary(t)),
      invites: this.invitesForMe.filter((i) => i.expiresAt > now).map(({ team: _t, ...i }) => i),
    };
    // a first plan starts with the free trial (as the real backend offers it)
    if (['no-plan', 'sold-out'].includes(this.state)) return { ...base, trialDays: this.teams.length ? 0 : FAKE_TRIAL_DAYS };
    if (this.state === 'deleted') return { ...base, status: 'deleted' };
    const p = this.currentPlan();
    const sub = (status: NonNullable<CloudAccount['subscription']>['status'], extra: Partial<NonNullable<CloudAccount['subscription']>> = {}): CloudAccount['subscription'] =>
      ({ status, plan: p.plan, interval: p.interval, periodStart: this.cycleStart, periodEnd: this.cycleStart + (p.interval === 'yearly' ? 365 : 30) * DAY, cancelAtPeriodEnd: false, ...(this.scheduled ? { scheduledChange: { ...this.scheduled, at: this.cycleStart + 30 * DAY } } : {}), ...extra });
    const withPlan = { ...base, plan: p.plan, interval: p.interval, region: 'us' as const };
    switch (this.state) {
      case 'past-due': return { ...withPlan, status: 'past_due', subscription: sub('past_due', { pastDueEndsAt: now + 2 * DAY }) };
      case 'on-hold': return { ...withPlan, status: 'on_hold', subscription: sub('on_hold'), exportUntil: now + DAY };
      case 'cancelling': return { ...withPlan, status: 'cancelling', subscription: sub('active', { cancelAtPeriodEnd: true }) };
      case 'export-only': return { ...withPlan, status: 'ended', exportUntil: now + DAY };
      case 'suspended': return { ...withPlan, status: 'suspended', subscription: sub('active') };
      default: return { ...withPlan, status: 'active', subscription: sub('active') };
    }
  }

  private computerState(): CloudComputerState {
    switch (this.state) {
      // the team states are seeded into a personal one (no plan, or Pro running) and never stay as `state`
      case 'signed-out': case 'no-plan': case 'sold-out': case 'team-admin': case 'team-member': case 'team-invite': return 'none';
      case 'personal-team': return 'running';
      case 'past-due': case 'cancelling': case 'scheduled': return 'running';
      default: return this.state;
    }
  }

  /* ------------------------------------------------- Fix your computer */

  /** the repair on each computer ('' = the person's own, else a team's id); the fake moves each step after a few seconds */
  private repairs = new Map<string, CloudRepair>();
  private fixVersion = 3;
  private backups(): CloudBackup[] {
    const night = (i: number): CloudBackup => { const d = new Date(this.now() - i * DAY); d.setHours(2, 10, 0, 0); return { id: `bk_fake_${i}`, kind: 'nightly', createdAt: d.getTime(), sizeBytes: 400_000_000 }; };
    return [...Array.from({ length: 7 }, (_, i) => night(i)), { id: 'bk_fake_manual', kind: 'manual' as const, createdAt: this.now() - 3 * DAY, sizeBytes: 390_000_000 }].sort((a, b) => b.createdAt - a.createdAt);
  }
  private fix(key: string): Pick<CloudComputer, 'fix' | 'repair'> {
    const r = this.repairs.get(key);
    return { fix: { latestVersion: 4, upToDate: this.fixVersion === 4 }, ...(r ? { repair: r } : {}) };
  }
  private repairRoute(key: string, method: string, path: string, body: unknown): Response | null {
    if (path === '/computer/backups' && method === 'GET') return this.json(200, { backups: this.backups(), asOf: this.now() });
    if (path !== '/computer/repair' || method !== 'POST') return null;
    const b = (body ?? {}) as { kind?: CloudRepairKind; backupId?: string; confirm?: string };
    if (!b.kind || !['update', 'recover', 'reset'].includes(b.kind)) return this.error(400, 'invalid_request', 'kind: update | recover | reset');
    const running = this.repairs.get(key);
    if (running && running.state !== 'done' && running.state !== 'failed') return running.kind === b.kind ? this.json(200, { repair: running }) : this.error(409, 'repair_running', 'A fix is already running on your AppuBot computer. Wait for it to finish, then try again.');
    if (b.kind === 'update' && this.fixVersion === 4) return this.json(200, { repair: null, message: 'Your AppuBot computer is already on the newest version (4). If it isn’t working, try Recover.' });
    if (b.kind === 'reset' && b.confirm !== 'reset') return this.error(400, 'invalid_request', 'Reset needs confirming: type reset.');
    const backup = b.kind === 'reset' ? (this.backups().find((x) => x.id === b.backupId) ?? this.backups().find((x) => x.kind === 'nightly')) : b.kind === 'recover' ? { id: 'bk_fake_fresh', kind: 'manual' as const, createdAt: this.now() } : undefined;
    const now = this.now();
    let r: CloudRepair = { id: `rep_fake_${now}`, kind: b.kind, state: 'queued', startedAt: now, updatedAt: now, ...(backup ? { backup } : {}), fromVersion: this.fixVersion, toVersion: 4, notes: [] };
    this.repairs.set(key, r);
    const steps: CloudRepairState[] = b.kind === 'update' ? ['backing-up', 'rebuilding', 'starting', 'done'] : ['backing-up', 'rebuilding', 'restoring', 'starting', 'done'];
    steps.forEach((st, i) => this.later(2500 * (i + 1), () => {
      r = { ...r, state: st, updatedAt: this.now(), ...(st === 'done' ? { finishedAt: this.now() } : {}) };
      this.repairs.set(key, r);
      if (st === 'done') this.fixVersion = 4;
      this.o.onChange?.();
    }));
    return this.json(200, { repair: r });
  }

  computer(): CloudComputer {
    const state = this.computerState();
    const now = this.now();
    const awake = this.awake();
    const out: CloudComputer = { state, noticeSeq: this.noticeSeq };
    if (this.hasPlan() || this.state === 'deleted') {
      const p = this.currentPlan();
      out.plan = { id: p.plan, name: PLANS[p.plan].name, interval: p.interval, region: 'us', shape: PLANS[p.plan].shape, price: price(p.plan, p.interval) };
    }
    if (awake) out.awake = awake;
    if (state === 'on-hold') out.resetsAt = now + 25 * DAY;
    if (this.state === 'export-only' || this.state === 'on-hold') out.exportUntil = now + DAY;
    if (state === 'provisioning') { out.progress = 'Creating your computer'; }
    if (state === 'failed') out.message = 'Setting up didn’t finish. We’re on it; write to sarthak@appubot.com if it takes more than a day.';
    if (!['none', 'provisioning', 'failed', 'deleted'].includes(state)) {
      out.computer = {
        id: 'cmp_fake', region: 'us', version: 3, shape: this.currentShape(), publicUrl: this.o.publicUrl?.() ?? 'https://ab12cd34ef.agent37.app', hostName: 'AppuBot Cloud',
        ...(state === 'asleep' ? { nextWakeAt: now + 50 * 60_000 } : {}), lastHeartbeatAt: now - 40_000,
        recentWakes: [{ at: now - 3 * 3_600_000, reason: 'routine', cold: false }, { at: now - 26 * 3_600_000, reason: 'telegram', cold: true }, { at: now - 2 * DAY, reason: 'client', cold: false }],
      };
      Object.assign(out, this.fix(''));
    }
    return out;
  }

  catalog(): CloudCatalog {
    return {
      plans: PLAN_ORDER.map((id) => ({ id, name: PLANS[id].name, blurb: PLANS[id].blurb, shape: PLANS[id].shape, monthly: price(id, 'monthly'), yearly: price(id, 'yearly') })), asOf: this.now(),
      work: {
        plans: WORK_ORDER.map((id) => ({
          id, name: PLANS[id].name, blurb: PLANS[id].blurb, shape: PLANS[id].shape,
          base: { monthly: price(id, 'monthly'), yearly: price(id, 'yearly') },
          perMember: { monthly: usd(MEMBER_USD, 'month'), yearly: usd(MEMBER_USD * 10, 'year') },
          minMembers: CLOUD_TEAM_MEMBERS.min, maxMembers: PLANS[id].maxMembers!,
        })),
        members: { ...CLOUD_TEAM_MEMBERS },
      },
      trialDays: FAKE_TRIAL_DAYS,
    };
  }

  /** up or down, as the backend's `planChangeKind` (a bigger computer or yearly is up) */
  private changeKind(to: { plan: CloudPlanId; interval: CloudInterval }): 'upgrade' | 'downgrade' | 'same' {
    const from = this.currentPlan();
    if (PLANS[to.plan].rank > PLANS[from.plan].rank) return 'upgrade';
    if (PLANS[to.plan].rank < PLANS[from.plan].rank) return 'downgrade';
    if (from.interval === to.interval) return 'same';
    return to.interval === 'yearly' ? 'upgrade' : 'downgrade';
  }

  private preview(to: { plan: CloudPlanId; interval: CloudInterval }): CloudPlanChangePreview {
    const kind = this.changeKind(to) === 'downgrade' ? 'downgrade' : 'upgrade';
    const have = this.currentShape();
    const want = PLANS[to.plan].shape;
    const shape: CloudShape = { cpu: want.cpu, memory: want.memory, disk: Math.max(want.disk, have.disk) };
    const recurring = price(to.plan, to.interval);
    const periodEnd = this.cycleStart + 30 * DAY;
    if (kind === 'upgrade') {
      // half the old cycle credited against the new plan's price (the fake's proration)
      const credit = Math.round(price(this.currentPlan().plan, this.currentPlan().interval).amount * Math.max(0, (periodEnd - this.now()) / (30 * DAY)));
      const amount = Math.max(0, recurring.amount - credit);
      return { kind, when: 'immediate', effectiveAt: this.now(), chargeNow: { amount, currency: 'USD', display: `$${(amount / 100).toFixed(2).replace(/\.00$/, '')}`, interval: 'once', taxInclusive: false }, recurring, shape };
    }
    return { kind, when: 'scheduled', effectiveAt: periodEnd, recurring, shape };
  }

  /* ----------------------------------------------------------- requests */

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }
  private error(status: number, code: string, message: string): Response { return this.json(status, { error: { code, message } }); }

  /** when the stand-in gift ends: fixed from the first ask, so the card's countdown runs */
  private giftEndsAt = 0;
  private giftEnd(): number { return (this.giftEndsAt ||= this.now() + (this.file.giftHours ?? 24) * 3_600_000); }

  private async handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const path = url.pathname.startsWith(CLOUD_API_PREFIX) ? url.pathname.slice(CLOUD_API_PREFIX.length) : url.pathname;
    let body: unknown;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    this.requests.push({ method, path, ...(body !== undefined ? { body } : {}) });
    const auth = new Headers(init?.headers).get('authorization');
    // a fake session saved by an earlier dev run is honoured, so restarting the app doesn't sign it out
    if (!this.token && !this.signedOutByState && this.state !== 'signed-out' && auth?.startsWith('Bearer cs_fake_')) this.token = auth.slice('Bearer '.length);
    const signedIn = !!this.token && auth === `Bearer ${this.token}`;
    const session = () => ({ account: this.account(), device: { name: 'This Mac', platform: 'macos' as const }, expiresAt: this.now() + 90 * DAY });

    // the browser page's PKCE grant (`/auth/token`), or a Firebase ID token straight (`/auth/firebase`): any is taken
    if ((path === '/auth/firebase' || path === '/auth/token') && method === 'POST') {
      if (this.state === 'signed-out') this.state = 'no-plan';
      this.signedOutByState = false;
      this.token = `cs_fake_${randomBytes(8).toString('hex')}`;
      return this.json(200, { token: this.token, session: session() });
    }
    // the plans are public, as on the backend: a signed-out app shows them too
    if (path === '/billing/catalog') return this.json(200, this.catalog());
    // the launch gift (the free Claude day), while `cloud-fake.json` says `gift: true`: public, like the backend's
    if (path === '/promo' && method === 'GET') return this.json(200, { id: 'free-claude-day', open: !!this.file.gift, model: 'claude-haiku-5-5', ...(this.file.gift ? { endsAt: this.giftEnd() } : {}) });
    if (!signedIn) return this.error(401, 'unauthorized', this.signedOutByState ? 'Your session ended.' : 'Sign in again.');
    if (path === '/promo/start' && method === 'POST') {
      if (!this.file.gift) return this.json(200, { enabled: false, promo: 'free-claude-day' });
      const endsAt = this.giftEnd();
      return this.json(200, { enabled: true, promo: 'free-claude-day', baseUrl: 'https://cloud.fake/v1/ai', token: 'cp_fake_gift', key: 'fakegift0000', budgetCents: 2500, usedCents: 0, currency: 'USD', resetsAt: endsAt, endsAt, exhausted: false, defaultModel: 'claude-haiku-5-5' });
    }
    if (path === '/auth/session') return this.json(200, session());
    if (path === '/auth/signout' && method === 'POST') { this.token = null; return this.json(200, { ok: true }); }
    if (path === '/account') return this.json(200, this.account());
    if (path === '/computer') return this.json(200, this.computer());
    // the account views in one request, as the backend answers them
    if (path === '/overview' && method === 'GET') return this.json(200, { account: this.account(), computer: this.computer(), teams: this.teams.map((t) => ({ team: this.team(t), computer: this.teamComputer(t) })) });
    if (path === '/computer/backups' || path === '/computer/repair') { if (!this.hasPlan()) return this.error(409, 'no_subscription', 'There’s no AppuBot computer on this account.'); return this.repairRoute('', method, path, body)!; }
    if (path === '/computer/start' && method === 'POST') {
      const refused = this.refusal();
      if (refused) return refused;
      if (this.state === 'asleep' || this.state === 'stopped') { this.set('waking'); this.later(4000, () => { if (this.state === 'waking') this.set('running'); }); }
      return this.json(200, this.computer());
    }
    if (path === '/computer/pair' && method === 'POST') {
      const refused = this.refusal();
      if (refused) return refused;
      if (!this.o.pairing) return this.error(503, 'not_ready', 'The fake cloud has no computer to pair with.');
      const p = await this.o.pairing();
      const b = body as { role?: 'owner' | 'full' } | undefined;
      const out: CloudPairResponse = {
        code: p.code, hosts: p.hosts, port: p.port, hostName: p.hostName, key: p.key, role: b?.role === 'owner' ? 'owner' : 'full', expiresAt: p.expiresAt,
        url: `appubot://pair?h=${encodeURIComponent(p.hosts.join(','))}&p=${p.port}&c=${p.code}&n=${encodeURIComponent(p.hostName)}&k=${encodeURIComponent(p.key)}`,
      };
      return this.json(200, out);
    }
    if (path === '/computer/desktop' && method === 'POST') {
      const refused = this.refusal();
      if (refused) return refused;
      return this.json(200, { websocketUrl: 'ws://127.0.0.1:6080/websockify?a37_token=fake', expiresAt: this.now() + 60_000 });
    }
    if (path === '/computer/notices') {
      const after = Number(url.searchParams.get('after') ?? 0) || 0;
      return this.json(200, { seq: this.noticeSeq, items: this.notices.filter((n) => n.seq > after) });
    }
    if (path === '/computer/access-log') {
      const now = this.now();
      return this.json(200, { items: [
        { at: now - 40_000, action: 'instance.start', actor: 'system', reason: 'routine due' },
        { at: now - 3 * 3_600_000, action: 'instance.sleep', actor: 'system', reason: 'idle 3 min' },
        { at: now - DAY, action: 'instance.resize', actor: 'system', reason: 'plan pro' },
        { at: now - DAY, action: 'instance.signed_url', actor: 'user', reason: 'open desktop' },
        { at: now - 2 * DAY, action: 'instance.backup', actor: 'system', reason: 'before update' },
      ] });
    }
    if (path === '/computer/export-start' && method === 'POST') {
      // only a live computer is woken for the download: on hold or after the plan ended it stays stopped (§6.7)
      const refused = this.refusal();
      if (refused) return refused;
      if (!['running', 'asleep', 'waking', 'stopped', 'cancelling', 'scheduled', 'past-due'].includes(this.state)) return this.error(409, 'conflict', 'Nothing to download.');
      return this.json(200, this.computer());
    }
    if (path === '/billing/checkout' && method === 'POST') {
      const b = (body as { plan?: CloudPlanId; interval?: CloudInterval; members?: number; teamName?: string } | undefined) ?? {};
      const plan = b.plan && b.plan in PLANS ? b.plan : 'starter';
      const interval = b.interval ?? 'monthly';
      if (this.state === 'sold-out') return this.error(503, 'signups_closed', 'AppuBot Cloud is sold out for now.');
      if (isWorkPlan(plan)) return this.teamCheckout(plan, interval, b.members, b.teamName);
      if (!['no-plan', 'export-only', 'deleted'].includes(this.state)) return this.error(409, 'conflict', 'You already have an AppuBot Cloud plan. Change it from your account page.');
      this.plan = { plan, interval }; this.shape = { ...PLANS[plan].shape }; this.scheduled = null;
      this.later(3000, () => this.set('provisioning'));
      this.later(11_000, () => { if (this.state === 'provisioning') this.set('running'); });
      return this.json(200, { checkoutUrl: `https://cloud.fake/checkout/${plan}:${interval}`, sessionId: `cks_fake_${randomBytes(4).toString('hex')}` });
    }
    if (path === '/billing/portal' && method === 'POST') {
      if (['no-plan', 'sold-out'].includes(this.state)) return this.error(409, 'no_subscription', 'Nothing to manage yet.');
      return this.json(200, { url: 'https://cloud.fake/portal', expiresAt: this.now() + DAY });
    }
    if ((path === '/billing/change-plan' || path === '/billing/change-plan/preview') && method === 'POST') {
      if (!this.hasPlan()) return this.error(409, 'no_subscription', 'There’s no AppuBot Cloud plan to change on this account.');
      if (this.state === 'on-hold') return this.error(409, 'on_hold', 'Settle the last payment first (Manage billing), then change the plan.');
      if (this.state === 'past-due') return this.error(409, 'conflict', 'Settle the last payment first (Manage billing), then change the plan.');
      const b = (body as { plan?: CloudPlanId; interval?: CloudInterval } | undefined) ?? {};
      if (!b.plan || !(b.plan in PLANS) || !b.interval) return this.error(400, 'invalid_request', 'Pick a plan.');
      const to = { plan: b.plan, interval: b.interval };
      if (this.changeKind(to) === 'same') return this.error(409, 'conflict', 'You’re on that plan already.');
      const preview = this.preview(to);
      if (path.endsWith('/preview')) return this.json(200, preview);
      if (preview.when === 'immediate') {
        this.plan = to; this.scheduled = null;
        this.shape = preview.shape;
        if (this.state === 'scheduled') this.state = 'running';
        this.later(1500, () => this.o.onChange?.());
      } else {
        this.scheduled = to;
        if (this.state === 'running') this.state = 'scheduled';
      }
      this.o.onChange?.();
      return this.json(200, { ...preview, subscription: this.account().subscription });
    }
    if (path === '/invites/accept' && method === 'POST') return this.acceptInvite(body as { inviteId?: string; token?: string } | undefined);
    if (path === '/invites/decline' && method === 'POST') {
      const id = (body as { inviteId?: string } | undefined)?.inviteId;
      const inv = this.invitesForMe.find((i) => i.id === id);
      if (!inv) return this.error(409, 'invite_invalid', 'This invite is gone.');
      this.invitesForMe = this.invitesForMe.filter((i) => i !== inv);
      inv.team.invites = inv.team.invites.filter((i) => i.id !== inv.id);
      this.o.onChange?.();
      return this.json(200, { ok: true });
    }
    const tm = /^\/teams\/([^/]+)(\/.*)?$/.exec(path);
    if (tm) return this.teamRoute(decodeURIComponent(tm[1]!), tm[2] ?? '', method, body, url);
    if (path === '/billing/change-plan/cancel' && method === 'POST') {
      if (!this.scheduled) return this.error(409, 'conflict', 'No plan change is waiting.');
      this.scheduled = null;
      if (this.state === 'scheduled') this.state = 'running';
      this.o.onChange?.();
      return this.json(200, { ok: true });
    }
    return this.error(404, 'not_found', 'No such route.');
  }

  /* -------------------------------------------------------------- teams */

  private teamUsed(t: FakeTeam): number { return t.people.length + t.invites.filter((i) => i.expiresAt > this.now()).length; }
  private myRole(t: FakeTeam): CloudTeamRole { return t.people.find((p) => p.id === ME)?.role ?? 'member'; }

  private teamSummary(t: FakeTeam): CloudTeamSummary {
    return { id: t.id, name: t.name, role: this.myRole(t), plan: t.plan, interval: t.interval, status: 'active', seats: t.seats, members: t.people.length };
  }

  team(t: FakeTeam): CloudTeam {
    const now = this.now();
    const admin = this.myRole(t) === 'admin';
    const people: CloudTeamMember[] = [
      ...t.people.map((p) => ({ id: p.id, email: p.email, role: p.role, status: 'active' as const, since: p.since, ...(p.id === ME ? { you: true } : {}) })),
      ...t.invites.filter((i) => i.expiresAt > now).map((i) => ({ id: i.id, email: i.email, role: i.role, status: 'invited' as const, since: i.since, expiresAt: i.expiresAt, invitedBy: i.invitedBy })),
    ];
    const periodEnd = t.cycleStart + (t.interval === 'yearly' ? 365 : 30) * DAY;
    return {
      ...this.teamSummary(t),
      subscription: {
        status: 'active', plan: t.plan, interval: t.interval, periodStart: t.cycleStart, periodEnd, cancelAtPeriodEnd: false, seats: t.seats,
        ...(t.scheduled ? { scheduledChange: { plan: t.scheduled.plan, interval: t.scheduled.interval, at: periodEnd, seats: t.scheduled.seats } } : {}),
      },
      used: this.teamUsed(t), minMembers: CLOUD_TEAM_MEMBERS.min, maxMembers: PLANS[t.plan].maxMembers!,
      ...(t.scheduled && t.scheduled.seats !== t.seats ? { scheduledSeats: t.scheduled.seats } : {}),
      people, canManage: admin, accountUrl: `https://cloud.fake/account/teams/${t.id}`,
    };
  }

  private teamComputer(t: FakeTeam): CloudComputer {
    const now = this.now();
    const state: CloudComputerState = t.computer;
    const out: CloudComputer = {
      state, noticeSeq: 0, team: { id: t.id, name: t.name },
      plan: { id: t.plan, name: PLANS[t.plan].name, interval: t.interval, region: 'us', shape: PLANS[t.plan].shape, price: teamPrice(t.plan, t.interval, t.seats), seats: t.seats, kind: 'work' },
    };
    if (state === 'provisioning') { out.progress = 'Creating your computer'; return out; }
    out.awake = { used: 61.5, usedSeconds: Math.round(61.5 * 3600), cycleStart: t.cycleStart, cycleEnd: t.cycleStart + 30 * DAY };
    out.computer = {
      id: `cmp_${t.id}`, region: 'us', version: 3, shape: t.shape, publicUrl: this.o.publicUrl?.() ?? 'https://team12345.agent37.app', hostName: t.name,
      lastHeartbeatAt: now - 30_000, recentWakes: [{ at: now - 2 * 3_600_000, reason: 'client', cold: false }, { at: now - 20 * 3_600_000, reason: 'routine', cold: false }],
    };
    Object.assign(out, this.fix(t.id));
    return out;
  }

  /** a Work checkout: a team with you as its first admin, set up a moment later */
  private teamCheckout(plan: CloudWorkPlanId, interval: CloudInterval, members: number | undefined, name: string | undefined): Response {
    const max = PLANS[plan].maxMembers!;
    if (!members || members < CLOUD_TEAM_MEMBERS.min) return this.error(400, 'invalid_request', `A team has at least ${CLOUD_TEAM_MEMBERS.min} members.`);
    if (members > max) return this.error(409, 'plan_limit', `${PLANS[plan].name} takes up to ${max} members; pick a bigger plan.`);
    const now = this.now();
    const t: FakeTeam = {
      id: `team_${randomBytes(4).toString('hex')}`, name: name?.trim() || 'My team', plan, interval, seats: members, scheduled: null,
      people: [{ id: ME, email: this.file.email ?? 'you@example.com', role: 'admin', since: now }], invites: [], computer: 'provisioning', shape: { ...PLANS[plan].shape }, cycleStart: now,
    };
    this.later(3000, () => { this.teams.push(t); this.o.onChange?.(); });
    this.later(11_000, () => { t.computer = 'running'; this.o.onChange?.(); });
    return this.json(200, { checkoutUrl: `https://cloud.fake/checkout/${plan}:${interval}?members=${members}`, sessionId: `cks_fake_${randomBytes(4).toString('hex')}` });
  }

  private acceptInvite(b: { inviteId?: string; token?: string } | undefined): Response {
    const inv = this.invitesForMe.find((i) => i.id === b?.inviteId || (!!b?.token && b.token === `tok_${i.id}`));
    if (!inv || inv.expiresAt < this.now()) return this.error(409, 'invite_invalid', 'This invite is gone or has expired. Ask an admin to send a new one.');
    const t = inv.team;
    t.invites = t.invites.filter((i) => i.id !== inv.id);
    t.people.push({ id: ME, email: this.file.email ?? 'you@example.com', role: inv.role, since: this.now() });
    this.invitesForMe = this.invitesForMe.filter((i) => i !== inv);
    if (!this.teams.includes(t)) this.teams.push(t);
    this.o.onChange?.();
    return this.json(200, this.team(t));
  }

  private teamRoute(id: string, rest: string, method: string, body: unknown, url: URL): Response | Promise<Response> {
    const t = this.teams.find((x) => x.id === id);
    if (!t) return this.error(404, 'not_found', 'No such team (or you aren’t on it).');
    const admin = this.myRole(t) === 'admin';
    const notAdmin = () => this.error(403, 'not_admin', 'Only an admin of this team can do that.');
    const changed = (): Response => { this.o.onChange?.(); return this.json(200, this.team(t)); };
    const admins = () => t.people.filter((p) => p.role === 'admin').length;
    const b = (body ?? {}) as Record<string, unknown>;
    if (rest === '' && method === 'GET') return this.json(200, this.team(t));
    if (rest === '/computer' && method === 'GET') return this.json(200, this.teamComputer(t));
    if (rest === '/computer/start' && method === 'POST') {
      if (t.computer === 'provisioning') return this.error(409, 'not_ready', 'Your cloud computer is still being set up.');
      t.computer = 'running';
      return this.json(200, this.teamComputer(t));
    }
    if (rest === '/computer/pair' && method === 'POST') return this.teamPair(t);
    if (rest === '/computer/desktop' && method === 'POST') return this.json(200, { websocketUrl: 'ws://127.0.0.1:6080/websockify?a37_token=fake', expiresAt: this.now() + 60_000 });
    if (rest === '/computer/notices') return this.json(200, { seq: 0, items: [] });
    if (rest === '/computer/access-log') return this.json(200, { items: [{ at: this.now() - 60_000, action: 'control.pairing', actor: 'user', reason: 'bob@acme.test' }] });
    if (rest === '/computer/export-start' && method === 'POST') return this.json(200, this.teamComputer(t));
    if (rest === '/computer/backups' || rest === '/computer/repair') { if (!admin) return notAdmin(); return this.repairRoute(t.id, method, rest, body)!; }
    if (rest === '/leave' && method === 'POST') {
      if (this.myRole(t) === 'admin' && admins() === 1) return this.error(409, 'last_admin', 'Make someone else an admin first: a team always has one.');
      t.people = t.people.filter((p) => p.id !== ME);
      this.teams = this.teams.filter((x) => x !== t);
      this.o.onChange?.();
      return this.json(200, { ok: true });
    }
    // the rest is an admin's
    if (!admin) return notAdmin();
    if (rest === '/rename' && method === 'POST') {
      const name = String(b.name ?? '').trim();
      if (!name) return this.error(400, 'invalid_request', 'Give the team a name.');
      t.name = name.slice(0, 60);
      return changed();
    }
    if (rest === '/invites' && method === 'POST') {
      const email = String(b.email ?? '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return this.error(400, 'invalid_request', 'That isn’t an email address.');
      if (t.people.some((p) => p.email === email) || t.invites.some((i) => i.email === email && i.expiresAt > this.now())) return this.error(409, 'conflict', `${email} is on the team or invited already.`);
      const cap = Math.min(t.seats, t.scheduled?.seats ?? t.seats);
      if (this.teamUsed(t) >= cap) return this.error(409, 'seat_limit', `All ${cap} seats are taken. Add a seat first.`);
      const now = this.now();
      t.invites.push({ id: `inv_${randomBytes(4).toString('hex')}`, email, role: b.role === 'admin' ? 'admin' : 'member', since: now, expiresAt: now + 14 * DAY, invitedBy: this.file.email ?? 'you@example.com' });
      return changed();
    }
    // removing someone or taking an invite back may drop their seat at the renewal (`dropSeat`), as the backend does:
    // refused below 2 seats or below the people and invites left, checked before anything is done
    const seatDrop = (): { plan: CloudWorkPlanId; interval: CloudInterval; seats: number } | Response | null => {
      if (b.dropSeat !== true) return null;
      const from = t.scheduled?.seats ?? t.seats;
      const left = this.teamUsed(t) - 1;
      if (from - 1 < CLOUD_TEAM_MEMBERS.min) return this.error(409, 'seat_limit', `Their seat can’t be dropped: a team keeps at least ${CLOUD_TEAM_MEMBERS.min} seats. Remove them without dropping it.`);
      if (from - 1 < left) return this.error(409, 'seat_limit', `Their seat can’t be dropped: the other ${left} seats are in use. Remove them without dropping it.`);
      return { plan: t.scheduled?.plan ?? t.plan, interval: t.scheduled?.interval ?? t.interval, seats: from - 1 };
    };
    const inv = /^\/invites\/([^/]+)\/(resend|revoke)$/.exec(rest);
    if (inv && method === 'POST') {
      const i = t.invites.find((x) => x.id === decodeURIComponent(inv[1]!));
      if (!i) return inv[2] === 'revoke' ? changed() : this.error(404, 'not_found', 'No such invite.');
      if (inv[2] === 'revoke') {
        const drop = seatDrop();
        if (drop instanceof Response) return drop;
        t.invites = t.invites.filter((x) => x !== i);
        if (drop) t.scheduled = drop;
      }
      else { i.since = this.now(); i.expiresAt = this.now() + 14 * DAY; }
      return changed();
    }
    const mem = /^\/members\/([^/]+)\/(role|remove)$/.exec(rest);
    if (mem && method === 'POST') {
      const m = t.people.find((x) => x.id === decodeURIComponent(mem[1]!));
      // removed already: the same answer, no second seat dropped
      if (!m) return mem[2] === 'remove' && this.removed.has(decodeURIComponent(mem[1]!)) ? changed() : this.error(404, 'not_found', 'No such member.');
      if (mem[2] === 'role') {
        const role: CloudTeamRole = b.role === 'admin' ? 'admin' : 'member';
        if (m.role === 'admin' && role === 'member' && admins() === 1) return this.error(409, 'last_admin', 'A team always keeps one admin: make someone else an admin first.');
        m.role = role;
        return changed();
      }
      if (m.role === 'admin' && admins() === 1) return this.error(409, 'last_admin', 'A team always keeps one admin: make someone else an admin first.');
      const drop = seatDrop();
      if (drop instanceof Response) return drop;
      t.people = t.people.filter((x) => x !== m);
      this.removed.add(m.id);
      if (drop) t.scheduled = drop;
      if (m.id === ME) { this.teams = this.teams.filter((x) => x !== t); this.o.onChange?.(); }
      return changed();
    }
    if (rest === '/billing/portal' && method === 'POST') return this.json(200, { url: 'https://cloud.fake/portal?team=' + t.id, expiresAt: this.now() + DAY });
    if ((rest === '/billing/change-plan' || rest === '/billing/change-plan/preview') && method === 'POST') {
      const plan = b.plan as CloudPlanId | undefined;
      const interval = (b.interval as CloudInterval | undefined) ?? t.interval;
      if (!plan || !isWorkPlan(plan)) return this.error(400, 'invalid_request', 'Pick a Work plan.');
      const seats = typeof b.seats === 'number' ? b.seats : t.seats;
      const max = PLANS[plan].maxMembers!;
      if (seats > max) return this.error(409, 'plan_limit', `${PLANS[plan].name} takes up to ${max} members. Move up to a bigger plan for more.`);
      if (seats < CLOUD_TEAM_MEMBERS.min) return this.error(400, 'invalid_request', `A team has at least ${CLOUD_TEAM_MEMBERS.min} seats.`);
      if (seats < this.teamUsed(t)) return this.error(409, 'seat_limit', `${this.teamUsed(t)} people are on the team or invited: remove someone or call an invite off first.`);
      const rankUp = PLANS[plan].rank > PLANS[t.plan].rank, rankDown = PLANS[plan].rank < PLANS[t.plan].rank;
      const yearUp = interval === 'yearly' && t.interval === 'monthly', yearDown = interval === 'monthly' && t.interval === 'yearly';
      const kind = rankUp || yearUp ? 'upgrade' : rankDown || yearDown ? 'downgrade' : seats > t.seats ? 'upgrade' : seats < t.seats ? 'downgrade' : 'same';
      if (kind === 'same') return this.error(409, 'conflict', 'That’s the plan and seats you have.');
      const periodEnd = t.cycleStart + (t.interval === 'yearly' ? 365 : 30) * DAY;
      const recurring = teamPrice(plan, interval, seats);
      const shape: CloudShape = { cpu: PLANS[plan].shape.cpu, memory: PLANS[plan].shape.memory, disk: Math.max(PLANS[plan].shape.disk, t.shape.disk) };
      let preview: CloudPlanChangePreview;
      if (kind === 'upgrade') {
        const left = Math.max(0, (periodEnd - this.now()) / (periodEnd - t.cycleStart));
        // seats alone: the difference for the time left; a bigger plan: a new cycle less what's left of this one
        const amount = rankUp || yearUp ? Math.max(0, recurring.amount - Math.round(teamPrice(t.plan, t.interval, t.seats).amount * left)) : Math.round((recurring.amount - teamPrice(t.plan, t.interval, t.seats).amount) * left);
        preview = { kind, when: 'immediate', effectiveAt: this.now(), chargeNow: { amount, currency: 'USD', display: `$${(amount / 100).toFixed(2).replace(/\.00$/, '')}`, interval: 'once', taxInclusive: false }, recurring, shape, seats };
      } else preview = { kind, when: 'scheduled', effectiveAt: periodEnd, recurring, shape, seats };
      if (rest.endsWith('/preview')) return this.json(200, preview);
      if (kind === 'upgrade') { t.plan = plan; t.interval = interval; t.seats = seats; t.shape = shape; t.scheduled = null; }
      else t.scheduled = { plan, interval, seats };
      this.o.onChange?.();
      return this.json(200, { ...preview, subscription: this.team(t).subscription });
    }
    if (rest === '/billing/change-plan/cancel' && method === 'POST') {
      if (!t.scheduled) return this.error(409, 'conflict', 'No plan change is waiting.');
      t.scheduled = null;
      this.o.onChange?.();
      return this.json(200, { ok: true });
    }
    void url;
    return this.error(404, 'not_found', 'No such route.');
  }

  /** a team's computer pairs this Mac's own gateway, like the personal one; its role follows yours on the team */
  private async teamPairAsync(t: FakeTeam): Promise<Response> {
    if (t.computer === 'provisioning') return this.error(409, 'not_ready', 'Your cloud computer is still being set up.');
    if (!this.o.pairing) return this.error(503, 'not_ready', 'The fake cloud has no computer to pair with.');
    const p = await this.o.pairing();
    const role = this.myRole(t) === 'admin' ? 'owner' : 'full';
    const out: CloudPairResponse = {
      code: p.code, hosts: p.hosts, port: p.port, hostName: t.name, key: p.key, role, expiresAt: p.expiresAt,
      url: `appubot://pair?h=${encodeURIComponent(p.hosts.join(','))}&p=${p.port}&c=${p.code}&n=${encodeURIComponent(t.name)}&k=${encodeURIComponent(p.key)}`,
    };
    return this.json(200, out);
  }
  private teamPair(t: FakeTeam): Response | Promise<Response> { return this.teamPairAsync(t); }

  /** the backend's refusals by state, as `requireMode` gives them */
  private refusal(allowed: FakeCloudState[] = []): Response | null {
    if (allowed.includes(this.state)) return null;
    switch (this.state) {
      case 'no-plan': case 'sold-out': case 'deleted': return this.error(409, 'no_subscription', 'There’s no cloud computer on this account yet.');
      case 'provisioning': return this.error(409, 'not_ready', 'Your cloud computer is still being set up.');
      case 'failed': return this.error(409, 'not_ready', 'Setting up didn’t finish; support is on it.');
      case 'on-hold': return this.error(409, 'on_hold', 'Your payment is on hold; update your card from Manage billing.');
      case 'export-only': return this.error(409, 'export_only', 'This plan has ended, so your AppuBot computer is stopped. Subscribe again from Settings › Billing to bring it back.');
      case 'suspended': return this.error(409, 'suspended', 'This computer is paused; write to sarthak@appubot.com.');
      default: return null;
    }
  }
}
