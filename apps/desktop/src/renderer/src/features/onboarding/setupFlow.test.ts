import { describe, expect, it } from 'vitest';
import type { CloudAccountView } from '@appubot/protocol';
import { mockCloudView } from '../../dev/mockCloud';
import { lastCloudComputer } from '../cloud/cloudClient';
import { cloudOffered, cloudStage, knownStep, pathOf, stepsFor } from './setupFlow';

type State = Parameters<typeof mockCloudView>[0];
/** the account alone: the mock remembers the teams of the state asked for before */
function view(state: State): CloudAccountView {
  const { teams: _teams, ...v } = mockCloudView(state);
  return v.account ? { ...v, account: { ...v.account, teams: [] } } : v;
}
/** with its teams, as the mock has them */
const withTeams = (state: State): CloudAccountView => mockCloudView(state);

describe('first-run setup', () => {
  it('asks where the bots work, then goes one of two ways', () => {
    const o = { offer: true, permissions: true };
    expect(stepsFor(null, o)).toEqual(['welcome', 'computer', 'agents', 'permissions', 'pair', 'follow', 'done']);
    expect(stepsFor('local', o)).toEqual(['welcome', 'computer', 'agents', 'permissions', 'pair', 'follow', 'done']);
    // the cloud computer needs none of this computer's setup
    expect(stepsFor('cloud', o)).toEqual(['welcome', 'computer', 'plans', 'cloud']);
    expect(stepsFor('local', { offer: true, permissions: false })).not.toContain('permissions');
    // nothing to choose where the cloud computer can't be had
    expect(stepsFor(null, { offer: false, permissions: true })).toEqual(['welcome', 'agents', 'permissions', 'pair', 'follow', 'done']);
  });

  it('knows each step’s path, and a step saved by an older version', () => {
    expect(pathOf('welcome')).toBeNull();
    expect(pathOf('computer')).toBeNull();
    expect(pathOf('plans')).toBe('cloud');
    expect(pathOf('cloud')).toBe('cloud');
    expect(pathOf('permissions')).toBe('local');
    const o = { offer: true, permissions: true };
    // granting Screen Recording relaunches into the same step; a checkout may outlast a quit
    expect(knownStep('permissions', o)).toBe('permissions');
    expect(knownStep('cloud', o)).toBe('cloud');
    expect(knownStep('made-up', o)).toBe('welcome');
    expect(knownStep(null, o)).toBe('welcome');
    expect(knownStep('permissions', { offer: true, permissions: false })).toBe('welcome');
  });

  it('reads where someone stands with a cloud computer', () => {
    expect(cloudStage(null)).toEqual({ kind: 'loading' });
    expect(cloudStage(view('signed-out'))).toEqual({ kind: 'sign-in' });
    expect(cloudStage(view('no-plan'))).toEqual({ kind: 'plans', invites: [] });
    expect(cloudStage(view('sold-out'))).toEqual({ kind: 'sold-out' });
    expect(cloudStage(view('provisioning')).kind).toBe('making');
    // asleep is still theirs to open: opening wakes it
    for (const s of ['running', 'asleep', 'waking', 'past-due', 'ending'] as const) expect(cloudStage(view(s))).toEqual({ kind: 'ready', name: expect.stringContaining('Cloud Computer') });
    // theirs, but nothing opens it from here
    for (const s of ['on-hold', 'suspended', 'failed', 'export-only'] as const) expect(cloudStage(view(s)).kind).toBe('held');
  });

  it('takes a team’s computer, and shows a team’s invitation with the plans', () => {
    expect(cloudStage(withTeams('team-member'))).toEqual({ kind: 'ready', team: 'team_acme', name: 'Acme Cloud Computer' });
    // their own comes first when they have both
    const both = cloudStage(withTeams('personal-team'));
    expect(both.kind).toBe('ready');
    expect(both).not.toHaveProperty('team');
    const free = view('no-plan');
    const invited: CloudAccountView = { ...free, account: { ...free.account!, invites: [{ id: 'inv_1', teamId: 'team_acme', teamName: 'Acme', role: 'member', expiresAt: Date.now() + 60_000 }, { id: 'inv_old', teamId: 'team_b', teamName: 'Bolt', role: 'member', expiresAt: Date.now() - 1 }] } };
    expect(cloudStage(invited)).toEqual({ kind: 'plans', invites: [{ id: 'inv_1', teamName: 'Acme' }] });
    // an invitation is somewhere to go even while sign-ups are closed
    const closed = view('sold-out');
    expect(cloudStage({ ...closed, account: { ...closed.account!, invites: invited.account!.invites } }).kind).toBe('plans');
  });

  it('offers the cloud computer unless it can’t be had', () => {
    expect(cloudOffered(null, null)).toBe(true);
    expect(cloudOffered(true, view('signed-out'))).toBe(true);
    expect(cloudOffered(true, view('running'))).toBe(true);
    // an AppuBot without a cloud account, or sign-ups closed
    expect(cloudOffered(false, null)).toBe(false);
    expect(cloudOffered(true, view('sold-out'))).toBe(false);
  });

  it('reads the computer used last', () => {
    expect(lastCloudComputer('cloud')).toEqual({});
    expect(lastCloudComputer('cloud:team_acme')).toEqual({ team: 'team_acme' });
    expect(lastCloudComputer('cloud:')).toBeNull();
    expect(lastCloudComputer('local')).toBeNull();
    expect(lastCloudComputer(null)).toBeNull();
  });
});
