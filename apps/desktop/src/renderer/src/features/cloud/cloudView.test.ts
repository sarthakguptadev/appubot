import { describe, expect, it, vi } from 'vitest';
import type { CloudAccountView, CloudCatalog } from '@appubot/protocol';

vi.mock('../../lib/platform', () => ({ MACHINE: 'Mac', THIS_MACHINE: 'this Mac', TERMINAL: 'Terminal' }));

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 4, 12);
const price = (amount: number, interval: 'month' | 'year') => ({ amount, currency: 'USD', display: `$${amount / 100}`, interval, taxInclusive: false });
const catalog: CloudCatalog = {
  plans: [
    { id: 'starter', name: 'Starter', blurb: 'A bot or two.', shape: { cpu: 2, memory: 4, disk: 12 }, monthly: price(1900, 'month'), yearly: price(19000, 'year') },
    { id: 'pro', name: 'Pro', blurb: 'Several bots.', shape: { cpu: 4, memory: 8, disk: 20 }, monthly: price(4900, 'month'), yearly: price(49000, 'year') },
    { id: 'max', name: 'Max', blurb: 'Heavy pages.', shape: { cpu: 4, memory: 16, disk: 40 }, monthly: price(8900, 'month') },
  ],
  asOf: now,
};
const PLAN = { id: 'pro' as const, name: 'Pro', interval: 'monthly' as const, region: 'us' as const, shape: { cpu: 4, memory: 8, disk: 20 }, price: price(4900, 'month') };
const machine = { id: 'c', region: 'us' as const, publicUrl: 'https://abc.agent37.app', hostName: 'AppuBot Cloud', recentWakes: [], shape: { cpu: 4, memory: 8, disk: 20 } };

function view(over: { state?: string; sub?: Record<string, unknown> | null; account?: Record<string, unknown>; computer?: Record<string, unknown>; machine?: Record<string, unknown> } = {}): CloudAccountView {
  const sub = over.sub === null ? undefined : { status: 'active', plan: 'pro', interval: 'monthly', periodStart: now - 20 * DAY, periodEnd: now + 10 * DAY, cancelAtPeriodEnd: false, ...over.sub };
  return {
    signedIn: true, paired: true, catalog,
    account: { id: 'a', email: 'a@b.co', createdAt: 0, signupsOpen: true, ...(sub ? { status: 'active', plan: 'pro', interval: 'monthly', subscription: sub } : {}), ...over.account },
    computer: { state: (over.state ?? 'asleep') as never, plan: PLAN, noticeSeq: 0, computer: { ...machine, ...over.machine }, ...over.computer },
  } as CloudAccountView;
}

describe('cloudPhase', async () => {
  const { cloudPhase, hasComputer, canWork } = await import('./cloudView');
  it('reads signed out, no plan and sold out', () => {
    expect(cloudPhase(null)).toBe('unknown');
    expect(cloudPhase({ signedIn: false, paired: false })).toBe('signed-out');
    expect(cloudPhase(view({ state: 'none', sub: null }))).toBe('no-plan');
    expect(cloudPhase(view({ state: 'none', sub: null, account: { signupsOpen: false } }))).toBe('sold-out');
  });
  it('takes the computer’s own state, then the subscription’s', () => {
    expect(cloudPhase(view({ state: 'running' }))).toBe('running');
    expect(cloudPhase(view({ state: 'on-hold' }))).toBe('on-hold');
    expect(cloudPhase(view({ state: 'asleep', sub: { status: 'past_due' } }))).toBe('past-due');
    expect(cloudPhase(view({ state: 'asleep', sub: { cancelAtPeriodEnd: true } }))).toBe('ending');
    expect(cloudPhase(view({ state: 'provisioning', sub: null }))).toBe('provisioning');
  });
  it('an ended plan offers its download until the date, then nothing', () => {
    expect(cloudPhase(view({ state: 'export-only', sub: null, account: { status: 'ended', exportUntil: Date.now() + DAY } }))).toBe('export-only');
    expect(cloudPhase(view({ state: 'none', sub: null, account: { status: 'ended', exportUntil: Date.now() - DAY } }))).toBe('no-plan');
  });
  it('shows the switcher only with a computer, and lets work run where it can', () => {
    expect(hasComputer(view())).toBe(true);
    expect(hasComputer(view({ state: 'none', sub: null }))).toBe(false);
    expect(canWork('asleep')).toBe(true);
    expect(canWork('on-hold')).toBe(false);
    expect(canWork('export-only')).toBe(false);
  });
});

describe('words', async () => {
  const { phaseWords, cloudLacks, planCard, pickerPlans, planName } = await import('./cloudView');
  it('words each phase', () => {
    expect(phaseWords('on-hold').label).toBe('Payment on hold');
    expect(phaseWords('running', view({ state: 'running', machine: { resizing: true } })).line).toMatch(/resized/);
  });
  it('never names a price or a limit in a phase', () => {
    for (const p of ['no-plan', 'sold-out', 'running', 'asleep', 'ending', 'past-due', 'on-hold'] as const) {
      const w = phaseWords(p, view(), now);
      expect(w.line).not.toMatch(/[$₹€£]\s?\d/);
      expect(`${w.label} ${w.line}`).not.toMatch(/hours|limit/i);
    }
  });
  it('never calls the computer "Cloud" in a phase', () => {
    for (const p of ['signed-out', 'no-plan', 'sold-out', 'provisioning', 'running', 'asleep', 'stopped', 'past-due', 'on-hold', 'ending', 'export-only', 'suspended', 'failed', 'deleted'] as const) {
      const w = phaseWords(p, view(), now);
      expect(`${w.label} ${w.line}`, p).not.toMatch(/AppuBot Cloud|cloud computer|Settings › Cloud/);
    }
  });
  it('the plan card: title, shape, price, billing, a scheduled change, the kept disk', () => {
    const card = planCard(view(), 'asleep', now)!;
    expect(card).toMatchObject({ title: 'Pro · Monthly', shape: '8 GB RAM · 4 vCPU · 20 GB disk', actualShape: '', price: '$49 a month', scheduled: '', attention: false });
    expect(card.billing).toMatch(/^Renews on /);
    expect(planCard(view(), 'ending', now)!.billing).toMatch(/^Ends on /);
    expect(planCard(view(), 'past-due', now)!).toMatchObject({ billing: 'The last payment didn’t go through', attention: true });
    const sched = planCard(view({ sub: { scheduledChange: { plan: 'starter', interval: 'monthly', at: now + 10 * DAY } } }), 'asleep', now)!;
    expect(sched.scheduled).toMatch(/^Changes to Starter · Monthly on /);
    const kept = planCard(view({ computer: { plan: { ...PLAN, id: 'starter', name: 'Starter', shape: { cpu: 2, memory: 4, disk: 12 } } }, machine: { shape: { cpu: 2, memory: 4, disk: 40 } } }), 'asleep', now)!;
    expect(kept.actualShape).toBe('4 GB RAM · 2 vCPU · 40 GB disk');
    expect(planCard(view({ sub: null }), 'no-plan', now)).toBeNull();
    expect(planName(view(), 'max')).toBe('Max');
    expect(planName({ signedIn: true, paired: false }, 'max')).toBe('Max');
  });
  it('the picker lists what the catalog prices at an interval, in its order', () => {
    expect(pickerPlans(view(), 'monthly').map((p) => `${p.name} ${p.price}`)).toEqual(['Starter $19 a month', 'Pro $49 a month', 'Max $89 a month']);
    expect(pickerPlans(view(), 'yearly').map((p) => p.id)).toEqual(['starter', 'pro']);
    expect(pickerPlans(view(), 'monthly')[1]!.shape).toBe('8 GB RAM · 4 vCPU · 20 GB disk');
    expect(pickerPlans({ signedIn: true, paired: false }, 'monthly')).toEqual([]);
  });
  it('turns off what a cloud computer lacks, nothing on a Mac', () => {
    expect(Object.values(cloudLacks({ cloud: undefined })).some(Boolean)).toBe(false);
    expect(cloudLacks({ cloud: { state: 'ok' } })).toEqual({ voice: true, power: true, permissions: true, teach: false, agentCursor: true, vaultCards: true, background: true });
  });
});

describe('the sidebar’s computer dropdown', async () => {
  const { computerMenuStatus } = await import('./cloudView');
  const { mockCloudView } = await import('../../dev/mockCloud');
  it('shows in every ?cloud= mock state with a computer, no state beside it, warning only on hold or suspended', () => {
    // no computer yet: the free app's strip, no dropdown
    for (const s of ['signed-out', 'no-plan', 'sold-out', 'provisioning', 'failed'] as const) expect(computerMenuStatus(mockCloudView(s)), s).toBeNull();
    expect(computerMenuStatus(null)).toBeNull();
    const at = (s: Parameters<typeof mockCloudView>[0]) => computerMenuStatus(mockCloudView(s));
    for (const s of ['running', 'asleep', 'scheduled', 'past-due', 'ending', 'waking', 'export-only'] as const) expect(at(s), s).toEqual({ warn: false });
    expect(at('on-hold')).toEqual({ warn: true });
    expect(at('suspended')).toEqual({ warn: true });
  });
});

const work = (id: 'team' | 'business' | 'scale', name: string, base: number, max: number, memory: number) => ({
  id, name, blurb: `${name}.`, shape: { cpu: 4, memory, disk: memory * 2.5 }, minMembers: 2, maxMembers: max,
  base: { monthly: price(base * 100, 'month'), yearly: price(base * 1000, 'year') },
  perMember: { monthly: price(2000, 'month'), yearly: price(20000, 'year') },
});
const workCatalog: CloudCatalog = {
  ...catalog,
  work: { plans: [work('team', 'Team', 29, 5, 8), work('business', 'Business', 79, 15, 16), work('scale', 'Scale', 149, 30, 32)], members: { min: 2, max: 30, default: 5 } },
};
const noPlan = (): CloudAccountView => ({ ...view({ state: 'none', sub: null }), catalog: workCatalog });

describe('the paywall', async () => {
  const { personalPaywall, workPaywall, paywallIntervals, paywallNote } = await import('./cloudView');
  it('prices the personal plans from the catalog, Pro the popular one, yearly with the twelve months struck', () => {
    const m = personalPaywall(noPlan(), 'monthly');
    expect(m.map((c) => [c.name, c.price, c.per, c.sub])).toEqual([['Starter', '$19', '/ month', 'Billed monthly'], ['Pro', '$49', '/ month', 'Billed monthly'], ['Max', '$89', '/ month', 'Billed monthly']]);
    expect(m.map((c) => c.highlight)).toEqual([false, true, false]);
    expect(m[1]!.badge).toEqual({ text: 'Most popular', tone: 'accent' });
    expect(m.map((c) => c.rows[5]!.text)).toEqual(['Unlimited bots, about 3–4 working at once', 'Unlimited bots, about 8 working at once', 'Unlimited bots, about 15 or more working at once']);
    // the site's rows: the launch bonus before the bots line, then the apps line, and nothing else
    expect(m.map((c) => c.rows[4]!.text)).toEqual(['Launch offer: generous Claude allowance', 'Launch offer: higher Claude allowance', 'Launch offer: much higher Claude allowance']);
    expect(m.map((c) => c.rows.slice(6).map((r) => r.text))).toEqual([['Phone and desktop apps'], ['Phone and desktop apps'], ['Phone and desktop apps']]);
    // Max isn't sold yearly in this catalog: only the plans with a price show
    const y = personalPaywall(noPlan(), 'yearly');
    expect(y.map((c) => c.name)).toEqual(['Starter', 'Pro']);
    expect(y[1]).toMatchObject({ price: '$490', per: '/ year', struck: '$588', sub: '$40.83 a month, billed yearly' });
  });
  it('prices a team as base (the first member included) + each extra member, greys the plans too small and highlights the biggest (Best value)', () => {
    const at = (n: number) => workPaywall(noPlan(), 'monthly', n);
    expect(at(2).map((c) => c.price)).toEqual(['$49', '$99', '$169']);
    expect(at(5).map((c) => c.price)).toEqual(['$109', '$159', '$229']);
    expect(at(5).map((c) => [c.off, c.highlight, c.badge?.text, c.badge?.tone])).toEqual([[false, false, undefined, undefined], [false, false, undefined, undefined], [false, true, 'Best value', 'accent']]);
    expect(at(12).map((c) => [c.off, c.highlight, c.badge?.text, c.offText])).toEqual([[true, false, undefined, 'Up to 5 members'], [false, false, undefined, undefined], [false, true, 'Best value', undefined]]);
    expect(at(30).map((c) => [c.off, c.highlight, c.badge?.text, c.offText])).toEqual([[true, false, undefined, 'Up to 5 members'], [true, false, undefined, 'Up to 15 members'], [false, true, 'Best value', undefined]]);
    // a plan right at its limit still fits: no limit words on it
    expect(at(5)[0]!.offText).toBeUndefined();
    expect(at(30)[2]!.price).toBe('$729');
    expect(at(5)[0]!.rows.map((r) => r.text)).toContain('$29 + $20 per extra member');
    expect(at(5).map((c) => c.rows[5]!.text)).toEqual(['Unlimited bots, about 8 working at once, shared by the team', 'Unlimited bots, about 15 or more working at once, shared by the team', 'Unlimited bots, about 30 or more working at once, shared by the team']);
    // yearly is ten months of the same sum
    expect(workPaywall(noPlan(), 'yearly', 5)[0]).toMatchObject({ price: '$1,090', struck: '$1,308' });
  });
  it('offers only the intervals the catalog sells, and says how Work is priced', () => {
    expect(paywallIntervals(noPlan(), 'work')).toEqual(['monthly', 'yearly']);
    expect(paywallIntervals({ ...noPlan(), catalog: { ...catalog, plans: catalog.plans.map((p) => ({ ...p, yearly: undefined })) } }, 'personal')).toEqual(['monthly']);
    expect(paywallIntervals({ ...noPlan(), catalog }, 'work')).toEqual([]);
    expect(paywallNote(noPlan(), 'work')).toContain('includes the first member, plus $20 for each extra member each month, for 2 to 30 members');
    expect(`${paywallNote(noPlan(), 'personal')} ${paywallNote(noPlan(), 'work')}`).not.toMatch(/Cloud|cloud computer/);
  });
});

describe('teams', async () => {
  const { teamCard, memberRows, seatCheck, cloudTargets, targetName, hasPersonalPlan, teamsWithComputer, cloudPhase, teamAsView } = await import('./cloudView');
  const team = {
    id: 'team_acme', name: 'Acme', role: 'admin' as const, plan: 'team' as const, interval: 'monthly' as const, status: 'active' as const, seats: 5, members: 3, used: 4,
    minMembers: 2, maxMembers: 5, canManage: true,
    subscription: { status: 'active' as const, plan: 'team' as const, interval: 'monthly' as const, periodStart: now - 20 * DAY, periodEnd: now + 10 * DAY, cancelAtPeriodEnd: false, seats: 5 },
    people: [
      { id: 'inv_o', email: 'omar@acme.com', role: 'member' as const, status: 'invited' as const, since: now - DAY, expiresAt: now + 13 * DAY, invitedBy: 'priya@acme.com' },
      { id: 'acc_d', email: 'dev@acme.com', role: 'member' as const, status: 'active' as const, since: now - 10 * DAY },
      { id: 'acc_me', email: 'a@b.co', role: 'admin' as const, status: 'active' as const, since: now - 20 * DAY, you: true },
    ],
  };
  const teamComputer = { state: 'asleep' as const, noticeSeq: 0, computer: { ...machine, hostName: 'Acme' } };
  const withTeam = (personal: boolean, over: Record<string, unknown> = {}): CloudAccountView => ({
    ...(personal ? view({ state: 'running' }) : noPlan()), catalog: workCatalog,
    teams: [{ team: { ...team, ...over }, computer: teamComputer, paired: true }],
  } as CloudAccountView);

  it('reads a team’s card: plan, seats used, role, price from the catalog, scheduled changes', () => {
    const v = withTeam(false);
    const card = teamCard(v, v.teams![0]!, now);
    expect(card).toMatchObject({ name: 'Acme Cloud Computer', plan: 'Team · Monthly', seats: '4 of 5 seats used', role: 'Admin', price: '$109 a month', scheduled: [] });
    const lower = withTeam(false, { scheduledSeats: 4, subscription: { ...team.subscription, scheduledChange: { plan: 'team', interval: 'monthly', at: now + 10 * DAY, seats: 4 } } });
    expect(teamCard(lower, lower.teams![0]!, now).scheduled).toEqual([expect.stringMatching(/^Seats go down to 4 on /)]);
    const moving = withTeam(false, { subscription: { ...team.subscription, scheduledChange: { plan: 'business', interval: 'monthly', at: now + 10 * DAY } } });
    expect(teamCard(moving, moving.teams![0]!, now).scheduled).toEqual([expect.stringMatching(/^Changes to Business · Monthly on /)]);
  });
  it('lists admins, then members, then invites, with you marked', () => {
    const rows = memberRows(team, now);
    expect(rows.map((r) => [r.email, r.role, r.invited, r.you])).toEqual([['a@b.co', 'Admin', false, true], ['dev@acme.com', 'Member', false, false], ['omar@acme.com', 'Member', true, false]]);
    expect(rows[2]!.line).toMatch(/^Invited · expires .* · by priya@acme\.com$/);
    expect(memberRows({ ...team, people: [{ ...team.people[0]!, expiresAt: now - 1 }] }, now)[0]).toMatchObject({ expired: true, line: expect.stringMatching(/^Invite expired/) });
  });
  it('never lets seats go under the people on the team or past the plan', () => {
    expect(seatCheck(team, 4, workCatalog.work!.plans).ok).toBe(true);
    expect(seatCheck(team, 3, workCatalog.work!.plans)).toEqual({ ok: false, reason: expect.stringContaining('4 people are on the team or invited') });
    expect(seatCheck(team, 6, workCatalog.work!.plans)).toEqual({ ok: false, reason: 'Team takes up to 5 members. Move up to Business for 6.' });
    expect(seatCheck({ ...team, used: 1 }, 1).ok).toBe(false);
  });
  it('lists the computers in the switcher: the person’s own (once bought) and each team’s, named like devices', () => {
    const both = withTeam(true);
    expect(hasPersonalPlan(both)).toBe(true);
    expect(cloudTargets(both)).toEqual([{ name: 'My Cloud Computer', warn: false }, { team: 'team_acme', teamName: 'Acme', name: 'Acme Cloud Computer', warn: false }]);
    expect(targetName(both, undefined)).toBe('My Cloud Computer');
    expect(targetName({ ...both, account: { ...both.account!, name: 'Sarthak Gupta' } }, undefined)).toBe('Sarthak’s Cloud Computer');
    expect(targetName(both, 'team_acme')).toBe('Acme Cloud Computer');
    const onlyTeam = withTeam(false);
    expect(hasPersonalPlan(onlyTeam)).toBe(false);
    expect(cloudTargets(onlyTeam)).toEqual([{ team: 'team_acme', teamName: 'Acme', name: 'Acme Cloud Computer', warn: false }]);
    expect(targetName(view({ state: 'running', account: { name: 'Ada Lovelace' } }), undefined)).toBe('Ada’s Cloud Computer');
    // a team still being set up isn't in the switcher yet
    const settingUp = { ...onlyTeam, teams: [{ ...onlyTeam.teams![0]!, computer: { state: 'provisioning' as const, noticeSeq: 0 } }] };
    expect(teamsWithComputer(settingUp)).toEqual([]);
    expect(cloudPhase(teamAsView(settingUp, settingUp.teams![0]!))).toBe('provisioning');
  });
});

describe('the ?cloud= team mocks', async () => {
  const { mockCloudView } = await import('../../dev/mockCloud');
  const { cloudTargets, hasPersonalPlan } = await import('./cloudView');
  it('have a team computer, an invite, or both a personal plan and a team', () => {
    expect(mockCloudView('team-invite').account?.invites?.[0]).toMatchObject({ teamName: 'Acme', role: 'member' });
    expect(hasPersonalPlan(mockCloudView('team-invite'))).toBe(false);
  });
  it('lists the person’s own computer and Acme’s for personal-team', () => {
    const v = mockCloudView('personal-team');
    expect(cloudTargets(v).map((t) => t.name)).toEqual(['My Cloud Computer', 'Acme Cloud Computer']);
    expect(v.teams?.[0]?.team).toMatchObject({ role: 'admin', canManage: true, seats: 5, used: 4, members: 3 });
  });
});

describe('removing someone offers to drop their seat (the team-admin mock)', async () => {
  const { mockCloudView } = await import('../../dev/mockCloud');
  const { seatDropOffer } = await import('@appubot/chat-core');
  it('offers one seat fewer at the renewal with the catalog’s price, and not at the minimum', () => {
    const v = mockCloudView('team-admin');
    const team = v.teams![0]!.team;
    const o = seatDropOffer(team, v.catalog?.work?.plans ?? null);
    expect(o).toMatchObject({ offer: true, from: team.seats, to: team.seats! - 1 });
    expect(o.text).toMatch(new RegExp(`^${team.seats} → ${team.seats! - 1} seats: \\$\\d+ a month from `));
    expect(seatDropOffer({ ...team, seats: 2, used: 2, scheduledSeats: undefined, subscription: { ...team.subscription!, seats: 2, scheduledChange: undefined } }, null).offer).toBe(false);
  });
});

describe('plan cards (Billing and Team)', async () => {
  const v = await import('./cloudView');
  const { mockCloudView } = await import('../../dev/mockCloud');
  it('reads a team’s price as its parts and a plan’s yearly saving', () => {
    const view = mockCloudView('personal-team');
    const team = view.teams![0]!.team;
    expect(v.seatsBreakdown(view, team)).toMatch(/^\$49 \+ \d extra seats? × \$20$/);
    expect(v.seatsBreakdown(view, { ...team, seats: 1 })).toBe('$49, one seat');
    expect(v.yearlySaving(view, 'pro')).toBe('$98');
  });
  it('says the status, the credit and the free seats', () => {
    expect(v.planStatus('past-due')).toEqual({ label: 'Payment failed', tone: 'danger' });
    expect(v.planStatus('running').label).toBe('Active');
    const c = v.creditFact({ budgetCents: 1200, usedCents: 750, currency: 'USD', resetsAt: Date.UTC(2026, 10, 14), exhausted: false, defaultModel: 'x' });
    expect(c.value).toBe('$7 of $12 used');
    expect(c.fraction).toBeCloseTo(7 / 12);
    expect(v.seatsFree({ seats: 5, used: 4 })).toBe(1);
    expect(v.seatsFree({ seats: 5, scheduledSeats: 4, used: 4 })).toBe(0);
  });
  it('reads typed invites', () => {
    expect(v.inviteEmails('Maya@acme.com, leo@acme.com\nleo@acme.com nope')).toEqual({ emails: ['maya@acme.com', 'leo@acme.com'], bad: ['nope'] });
  });
});
