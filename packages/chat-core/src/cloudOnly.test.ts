import { describe, expect, it } from 'vitest';
import type { CloudAccountView, CloudComputer, CloudSubscription, CloudTeamView } from '@appubot/protocol';
import { cloudOnlyInEffect, cloudOnlyOffered, launchComputer, listsThisComputer, savedCloudComputer, workingClouds, type CloudOnlyState } from './cloudOnly';

const NOW = Date.UTC(2026, 10, 15);
const DAY = 86_400_000;

const sub = (o: Partial<CloudSubscription> = {}): CloudSubscription => ({
  status: 'active', plan: 'pro', interval: 'monthly', periodStart: NOW - DAY, periodEnd: NOW + 29 * DAY, cancelAtPeriodEnd: false, ...o,
});
const computer = (state: CloudComputer['state'] = 'asleep'): CloudComputer => ({
  state, noticeSeq: 0,
  computer: { id: 'i1', region: 'us', publicUrl: 'https://x.agent37.app', hostName: 'Sarthak’s Cloud Computer', recentWakes: [] },
});
/** someone signed in with a plan of their own whose computer is in `state` */
function view(o: { state?: CloudComputer['state'] | 'none'; sub?: Partial<CloudSubscription> | null; status?: 'active' | 'ended'; teams?: CloudTeamView[]; signedIn?: boolean } = {}): CloudAccountView {
  const state = o.state ?? 'asleep';
  return {
    signedIn: o.signedIn ?? true, paired: true,
    account: {
      id: 'acc', email: 'a@b.co', createdAt: 0, signupsOpen: true,
      ...(o.status ? { status: o.status } : {}),
      ...(o.sub === null ? {} : { subscription: sub(o.sub ?? {}) }),
    },
    ...(state === 'none' ? {} : { computer: computer(state) }),
    ...(o.teams ? { teams: o.teams } : {}),
  };
}
const team = (id: string, state: CloudComputer['state'] | 'none' = 'running', s: Partial<CloudSubscription> = {}): CloudTeamView => ({
  team: { id, name: id, role: 'member', members: 3, used: 3, minMembers: 2, maxMembers: 5, people: [], canManage: false, subscription: sub({ plan: 'team', ...s }) },
  ...(state === 'none' ? {} : { computer: computer(state) }),
  paired: false,
});
/** no plan of their own, on a team */
const teamOnly = (...teams: CloudTeamView[]): CloudAccountView => view({ state: 'none', sub: null, teams });

describe('workingClouds', () => {
  it('lists the person’s own computer first, then each team’s that can work', () => {
    expect(workingClouds(view({ teams: [team('acme'), team('beta', 'on-hold')] }))).toEqual([{}, { team: 'acme' }]);
    expect(workingClouds(teamOnly(team('acme')))).toEqual([{ team: 'acme' }]);
  });

  it('counts an asleep, stopped, ending or past-due computer: a message wakes it', () => {
    for (const state of ['asleep', 'running', 'stopped', 'waking'] as const) expect(workingClouds(view({ state }))).toEqual([{}]);
    expect(workingClouds(view({ sub: { cancelAtPeriodEnd: true } }))).toEqual([{}]);
    expect(workingClouds(view({ sub: { status: 'past_due' } }))).toEqual([{}]);
  });

  it('leaves out one that can’t work: on hold, kept-until, suspended, being set up, gone, signed out', () => {
    expect(workingClouds(view({ sub: { status: 'on_hold' } }))).toEqual([]);
    expect(workingClouds(view({ state: 'on-hold' }))).toEqual([]);
    expect(workingClouds(view({ state: 'export-only' }))).toEqual([]);
    expect(workingClouds(view({ state: 'suspended' }))).toEqual([]);
    expect(workingClouds(view({ state: 'provisioning' }))).toEqual([]);
    expect(workingClouds(view({ state: 'failed' }))).toEqual([]);
    expect(workingClouds(view({ state: 'none', sub: null, status: 'ended' }))).toEqual([]);
    expect(workingClouds(view({ signedIn: false }))).toEqual([]);
    expect(workingClouds(null)).toEqual([]);
    expect(workingClouds(teamOnly(team('acme', 'none')))).toEqual([]);
  });
});

describe('the choice', () => {
  const usable = [{}];
  it('is offered only to someone with a cloud computer that can work, or while it is on', () => {
    expect(cloudOnlyOffered({ chosen: false, usable })).toBe(true);
    expect(cloudOnlyOffered({ chosen: false, usable: [] })).toBe(false);
    // on, with the plan ended since: still shown, so it can be turned off
    expect(cloudOnlyOffered({ chosen: true, usable: [] })).toBe(true);
    // never on an AppuBot computer itself
    expect(cloudOnlyOffered({ chosen: true, usable, cloud: true })).toBe(false);
  });

  it('holds only while chosen and a cloud computer can work, so nobody is locked out of this computer', () => {
    expect(cloudOnlyInEffect({ chosen: true, usable })).toBe(true);
    expect(cloudOnlyInEffect({ chosen: false, usable })).toBe(false);
    // signed out, the plan ended or on hold, the team left: this computer works again by itself
    expect(cloudOnlyInEffect({ chosen: true, usable: [] })).toBe(false);
    expect(cloudOnlyInEffect({ chosen: true, usable: workingClouds(view({ sub: { status: 'on_hold' } })) })).toBe(false);
    expect(cloudOnlyInEffect({ chosen: true, usable: workingClouds(view({ signedIn: false })) })).toBe(false);
    expect(cloudOnlyInEffect({ chosen: true, usable, cloud: true })).toBe(false);
  });
});

describe('listsThisComputer', () => {
  it('leaves this computer out of the switchers only while the choice holds and the cloud answers', () => {
    expect(listsThisComputer({ inEffect: false, onThis: false, late: false })).toBe(true);
    expect(listsThisComputer({ inEffect: true, onThis: false, late: false })).toBe(false);
    // on screen (the cloud was out of reach and the person came back here): still listed, with its check
    expect(listsThisComputer({ inEffect: true, onThis: true, late: false })).toBe(true);
    // the cloud computer on screen can't be reached for a while: this one is the way out
    expect(listsThisComputer({ inEffect: true, onThis: false, late: true })).toBe(true);
  });
});

describe('launchComputer', () => {
  const s = (chosen: boolean, usable: CloudOnlyState['usable']): CloudOnlyState => ({ chosen, usable });
  it('reads the computer kept as used last', () => {
    expect(savedCloudComputer('cloud')).toEqual({});
    expect(savedCloudComputer('cloud:team_acme')).toEqual({ team: 'team_acme' });
    expect(savedCloudComputer('cloud:')).toBeNull();
    expect(savedCloudComputer('local')).toBeNull();
    expect(savedCloudComputer(null)).toBeNull();
  });

  it('opens on the cloud computer used last while it can work', () => {
    expect(launchComputer('cloud', s(false, [{}]))).toEqual({});
    expect(launchComputer('cloud:acme', s(false, [{}, { team: 'acme' }]))).toEqual({ team: 'acme' });
  });

  it('opens on a cloud computer whenever one can work, whatever was on screen last: the person’s own first', () => {
    expect(launchComputer('local', s(false, [{}]))).toEqual({});
    expect(launchComputer(null, s(false, [{}, { team: 'acme' }]))).toEqual({});
    expect(launchComputer('local', s(true, [{}, { team: 'acme' }]))).toEqual({});
    expect(launchComputer(null, s(true, [{ team: 'acme' }]))).toEqual({ team: 'acme' });
    // the team left since: their own instead
    expect(launchComputer('cloud:acme', s(false, [{}]))).toEqual({});
    expect(launchComputer('cloud:gone', s(true, [{}]))).toEqual({});
  });

  it('stays on this computer when no cloud computer can work', () => {
    expect(launchComputer('cloud', s(true, []))).toBeNull();
    expect(launchComputer('local', s(false, []))).toBeNull();
  });
});
