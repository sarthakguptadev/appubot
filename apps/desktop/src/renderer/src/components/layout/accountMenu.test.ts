import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CloudAccountView, CloudComputer, CloudPlanId, CloudSubscription, CloudTeamView, CloudWorkPlanId, ProviderLimits } from '@appubot/protocol';
import { accountPlan } from './accountMenu';

const NOW = Date.now();
const DAY = 86_400_000;
const sub = (plan: CloudPlanId): CloudSubscription => ({ status: 'active', plan, interval: 'monthly', periodStart: NOW - DAY, periodEnd: NOW + 29 * DAY, cancelAtPeriodEnd: false });
const computer: CloudComputer = { state: 'asleep', noticeSeq: 0, computer: { id: 'i1', region: 'us', publicUrl: 'https://x.agent37.app', hostName: 'Cloud', recentWakes: [] } };
const team = (id: string, plan: CloudWorkPlanId | undefined, canManage: boolean): CloudTeamView => ({
  team: { id, name: id, role: canManage ? 'admin' : 'member', members: 3, used: 3, minMembers: 2, maxMembers: 5, people: [], canManage, ...(plan ? { plan } : {}) },
  computer, paired: false,
});
function view(o: { plan?: CloudPlanId; teams?: CloudTeamView[]; signedIn?: boolean } = {}): CloudAccountView {
  return {
    signedIn: o.signedIn ?? true, paired: true,
    account: { id: 'acc', email: 'a@b.co', createdAt: 0, signupsOpen: true, ...(o.plan ? { plan: o.plan, status: 'active' as const, subscription: sub(o.plan) } : {}) },
    ...(o.plan ? { computer } : {}),
    ...(o.teams ? { teams: o.teams } : {}),
  };
}
const limits = (...used: number[]): ProviderLimits[] => [{
  providerId: 'claude-code', status: 'ok', source: 'claude', updatedAt: NOW,
  windows: used.map((u, i) => ({ id: `w${i}`, label: 'Week', usedPercent: u, scope: { kind: 'all' as const } })),
}];

describe('the account menu’s plan', () => {
  it('names your plan and the most used of your plan limits, and offers the next plan', () => {
    expect(accountPlan(view({ plan: 'pro' }), limits(13.2, 4))).toEqual({ name: 'Pro', used: 13, upgrade: 'personal', inviteTeam: null });
  });

  it('says Free with no percentage when there is no plan and nothing read, and Upgrade opens the plans', () => {
    expect(accountPlan(view(), [])).toEqual({ name: 'Free', used: null, upgrade: 'personal', inviteTeam: null });
    expect(accountPlan(view(), limits(40)).used).toBeNull();
    expect(accountPlan(null, [])).toMatchObject({ name: 'Free', upgrade: 'personal' });
  });

  it('hides Upgrade on the top plan of each kind', () => {
    expect(accountPlan(view({ plan: 'ultra' }), []).upgrade).toBeNull();
    expect(accountPlan(view({ teams: [team('acme', 'scale', true)] }), []).upgrade).toBeNull();
  });

  it('offers Invite teammates only on a Work plan you run', () => {
    expect(accountPlan(view({ teams: [team('acme', 'team', true)] }), [])).toMatchObject({ name: 'Team', upgrade: 'work', inviteTeam: 'acme' });
    expect(accountPlan(view({ teams: [team('acme', 'team', false)] }), [])).toMatchObject({ name: 'Team', upgrade: null, inviteTeam: null });
    expect(accountPlan(view({ teams: [team('acme', undefined, true)] }), []).inviteTeam).toBeNull();
    expect(accountPlan(view({ plan: 'max', teams: [team('beta', 'business', true)] }), [])).toMatchObject({ name: 'Max', upgrade: 'personal', inviteTeam: 'beta' });
  });

  it('caps a limit run past its cap at 100% and leaves out agents signed out or unread', () => {
    expect(accountPlan(view({ plan: 'pro' }), limits(130)).used).toBe(100);
    const out = [{ ...limits(90)[0]!, status: 'signed_out' }] as ProviderLimits[];
    expect(accountPlan(view({ plan: 'pro' }), out).used).toBeNull();
  });
});

describe('the account row', () => {
  const row = () => {
    const src = readFileSync(join(__dirname, 'Sidebar.tsx'), 'utf8');
    return src.slice(src.indexOf('function AccountButton'), src.indexOf('export function Sidebar'));
  };

  it('has no fill behind it, under the pointer, pressed or open', () => {
    expect(row()).not.toMatch(/(?:hover|active|aria-expanded):bg-/);
  });

  it('shows the name grey at rest and white under the pointer or while open', () => {
    expect(row()).toMatch(/text-muted [^"]*hover:text-fg aria-expanded:text-fg/);
    expect(row()).not.toMatch(/font-medium text-fg/);
  });

  it('draws the picture at the round buttons\' size, with their edge', () => {
    const src = readFileSync(join(__dirname, 'Sidebar.tsx'), 'utf8');
    const strip = /const STRIP_BUTTON = '[^']*size-\[(\d+)px\]/.exec(src)?.[1];
    expect(strip).toBeTruthy();
    expect(row()).toContain(`relative grid size-[${strip}px] shrink-0`);
    expect(row()).toContain(`size={${strip}}`);
    expect(row()).toContain('ab-edge pointer-events-none absolute inset-0 rounded-full');
  });
});
