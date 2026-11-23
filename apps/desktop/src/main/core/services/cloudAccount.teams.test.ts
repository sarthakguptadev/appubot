/**
 * Teams on the Mac's AppuBot Cloud account (Work plans) against the fake backend: the view
 * lists the teams with their computers, the team rules (a free seat to invite, seats within the plan and never below
 * the people, the last admin stays, members can't manage), seats and plan changes, pairing a team's computer beside
 * the personal one (its own connection and notice mark), leaving, accepting and declining invites, a Work checkout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../app';
import type { CoreDeps } from '../context';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { CloudFakeBackend } from './cloudFake';

/** the platform this computer names when it pairs (`cloudAccount.ts`): tests run on every OS */
const PLATFORM = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';

let mac: Core;
let cloud: Core;
let root: string;
let fake: CloudFakeBackend;

const base = (dir: string, extra: Partial<CoreDeps>): CoreDeps => ({
  paths: { dataDir: join(dir, 'data'), botsRoot: join(dir, 'bots'), filesDir: join(dir, 'data', 'files'), logsDir: join(dir, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
  runtime: (hooks) => new FakeRuntime(hooks),
  openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: async () => ({ shown: true }),
  version: '0.0.0-test', hostName: 'Sarthak’s Mac', log: silentLogger, validate: true, port: 0, quiet: true,
  computerBackends: () => [], helperTransport: () => null,
  ...extra,
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-cloud-teams-'));
  cloud = createCore(base(join(root, 'cloud'), { hostName: 'Acme', cloud: { publicUrl: '', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 } }));
  await cloud.start();
  cloud.ctx.deps.cloud!.publicUrl = `http://127.0.0.1:${cloud.gateway.port}`;
  fake = new CloudFakeBackend({
    state: 'personal-team',
    pairing: async () => {
      const info = await cloud.services.devices.startPairing(120, { role: 'owner' });
      return { code: info.code, key: cloud.services.connect.key(), hosts: ['127.0.0.1'], port: cloud.gateway.port, hostName: 'Acme', publicUrl: `http://127.0.0.1:${cloud.gateway.port}`, expiresAt: info.expiresAt };
    },
    publicUrl: () => `http://127.0.0.1:${cloud.gateway.port}`,
  });
  mac = createCore(base(join(root, 'mac'), { cloudBackendUrl: 'https://cloud.test/', cloudFetch: fake.fetch, windowHidden: () => true }));
  await mac.start();
  const acc = mac.services.cloudAccount;
  const { state } = await acc.startSignIn();
  await acc.finishSignIn({ code: 'the-code', state });
});

afterAll(async () => {
  await mac.stop();
  await cloud.stop();
  fake.close();
  rmSync(root, { recursive: true, force: true });
});

describe('teams on the cloud account', () => {
  it('lists the teams with their computers beside the personal plan, and the Work catalog', async () => {
    const v = await mac.services.cloudAccount.status(true);
    expect(v.computer).toMatchObject({ state: 'running', plan: { id: 'pro' } });
    expect(v.account?.teams).toEqual([expect.objectContaining({ id: 'team_acme', name: 'Acme', role: 'admin', plan: 'team', seats: 3, members: 2 })]);
    expect(v.teams).toHaveLength(1);
    expect(v.teams![0]).toMatchObject({
      paired: false,
      team: { id: 'team_acme', canManage: true, used: 3, maxMembers: 5, people: expect.arrayContaining([expect.objectContaining({ email: 'carol@acme.test', status: 'invited' }), expect.objectContaining({ you: true, role: 'admin' })]) },
      computer: { state: 'running', team: { id: 'team_acme', name: 'Acme' }, plan: { id: 'team', seats: 3, kind: 'work', price: { display: '$89' } }, computer: { hostName: 'Acme' } },
    });
    expect(v.catalog?.work?.plans.map((p) => [p.id, p.base.monthly?.display, p.perMember.monthly?.display, p.maxMembers])).toEqual([['team', '$49', '$20', 5], ['business', '$79', '$20', 15], ['scale', '$109', '$20', 30]]);
  });

  it('keeps the team rules: a free seat to invite, seats within the plan, more seats at once and fewer at the renewal', async () => {
    const acc = mac.services.cloudAccount;
    await expect(acc.invite('team_acme', 'dan@acme.test')).rejects.toMatchObject({ code: 'seat_limit' });
    await expect(acc.previewPlanChange({ team: 'team_acme', plan: 'team', interval: 'monthly', seats: 6 })).rejects.toMatchObject({ code: 'plan_limit' });
    await expect(acc.changePlan({ team: 'team_acme', plan: 'team', interval: 'monthly', seats: 2 })).rejects.toMatchObject({ code: 'seat_limit' });
    const up = await acc.changePlan({ team: 'team_acme', plan: 'team', interval: 'monthly', seats: 4 });
    expect(up).toMatchObject({ kind: 'upgrade', when: 'immediate', seats: 4, subscription: { seats: 4 } });
    const t = await acc.invite('team_acme', 'dan@acme.test');
    expect(t).toMatchObject({ used: 4, seats: 4 });
    expect(fake.requests.find((r) => r.method === 'POST' && r.path === '/teams/team_acme/invites' && (r.body as { email: string }).email === 'dan@acme.test')).toBeDefined();
    // bigger than Team takes: move up, with the seats
    const biz = await acc.changePlan({ team: 'team_acme', plan: 'business', interval: 'monthly', seats: 6 });
    expect(biz).toMatchObject({ kind: 'upgrade', when: 'immediate', seats: 6, shape: { memory: 16 } });
    // fewer seats wait for the renewal, and can be called off
    const down = await acc.changePlan({ team: 'team_acme', plan: 'business', interval: 'monthly', seats: 5 });
    expect(down).toMatchObject({ kind: 'downgrade', when: 'scheduled', subscription: { scheduledChange: { seats: 5 } } });
    expect((await acc.team('team_acme')).scheduledSeats).toBe(5);
    await acc.cancelPlanChange('team_acme');
    expect((await acc.team('team_acme')).scheduledSeats).toBeUndefined();
  });

  it('manages people: roles, invites, removal, and the last admin stays', async () => {
    const acc = mac.services.cloudAccount;
    let t = await acc.revokeInvite('team_acme', 'inv_carol');
    expect(t.people.some((p) => p.id === 'inv_carol')).toBe(false);
    const dan = t.people.find((p) => p.email === 'dan@acme.test')!;
    t = await acc.resendInvite('team_acme', dan.id);
    await expect(acc.leaveTeam('team_acme')).rejects.toMatchObject({ code: 'last_admin' });
    await expect(acc.setMemberRole('team_acme', 'acc_fake', 'member')).rejects.toMatchObject({ code: 'last_admin' });
    t = await acc.setMemberRole('team_acme', 'acc_bob', 'admin');
    expect(t.people.find((p) => p.id === 'acc_bob')?.role).toBe('admin');
    t = await acc.removeMember('team_acme', 'acc_bob');
    expect(t.people.some((p) => p.id === 'acc_bob')).toBe(false);
    t = await acc.renameTeam('team_acme', 'Acme Inc');
    expect(t.name).toBe('Acme Inc');
  });

  it('drops a removed person’s or a taken-back invite’s seat when asked, at the renewal; refused at the minimum', async () => {
    const acc = mac.services.cloudAccount;
    let t = await acc.team('team_acme');
    // room to drop: seats on the plan's most, nothing waiting
    if (t.subscription?.scheduledChange) await acc.cancelPlanChange('team_acme');
    t = await acc.changePlan({ team: 'team_acme', plan: t.plan!, interval: t.interval!, seats: t.maxMembers }).then(() => acc.team('team_acme'));
    t = await acc.invite('team_acme', 'drop-me@acme.test');
    const inv = t.people.find((p) => p.email === 'drop-me@acme.test')!;
    const from = t.scheduledSeats ?? t.seats!;
    t = await acc.revokeInvite('team_acme', inv.id, { dropSeat: true });
    expect(t.people.some((p) => p.id === inv.id)).toBe(false);
    expect(t.scheduledSeats ?? t.subscription?.scheduledChange?.seats).toBe(from - 1);
    // again: nothing more
    t = await acc.revokeInvite('team_acme', inv.id, { dropSeat: true });
    expect(t.scheduledSeats ?? t.subscription?.scheduledChange?.seats).toBe(from - 1);
    // without it, the seat stays
    t = await acc.invite('team_acme', 'keep-seat@acme.test');
    const keep = t.people.find((p) => p.email === 'keep-seat@acme.test')!;
    t = await acc.revokeInvite('team_acme', keep.id);
    expect(t.scheduledSeats ?? t.subscription?.scheduledChange?.seats).toBe(from - 1);
    // at the minimum it's refused and nothing is done
    t = await acc.changePlan({ team: 'team_acme', plan: t.plan!, interval: t.interval!, seats: Math.max(2, t.used) }).then(() => acc.team('team_acme'));
    expect([t.scheduledSeats ?? t.seats, t.used]).toEqual([2, 2]);
    {
      const other = t.people.find((p) => !p.you)!;
      await expect(other.status === 'invited' ? acc.revokeInvite('team_acme', other.id, { dropSeat: true }) : acc.removeMember('team_acme', other.id, { dropSeat: true })).rejects.toMatchObject({ code: 'seat_limit' });
      expect((await acc.team('team_acme')).people.some((p) => p.id === other.id)).toBe(true);
    }
  });


  it('pairs a team’s computer beside the personal one, each with its own connection', async () => {
    const acc = mac.services.cloudAccount;
    expect(acc.connection('team_acme')).toBeNull();
    const r = await acc.pair('team_acme');
    expect(fake.requests.find((x) => x.path === '/teams/team_acme/computer/pair')?.body).toMatchObject({ device: { platform: PLATFORM } });
    expect(acc.connection('team_acme')).toMatchObject({ team: 'team_acme', deviceId: r.deviceId, role: 'owner' });
    expect(acc.connection()).toBeNull();
    expect((await acc.status()).teams![0]!.paired).toBe(true);
    const file = JSON.parse(readFileSync(join(root, 'mac', 'data', 'cloud-account.json'), 'utf8'));
    expect(file.teams.team_acme.cloud).toMatchObject({ team: 'team_acme', role: 'owner' });
    expect(file.cloud).toBeUndefined();
    expect((await acc.desktopLink('team_acme')).websocketUrl).toContain('/websockify');
    expect(await acc.start('team_acme')).toMatchObject({ state: 'running', team: { id: 'team_acme' } });
  });

  it('a member manages nothing; leaving forgets the team’s pairing', async () => {
    const acc = mac.services.cloudAccount;
    fake.set('team-member');
    const v = await acc.refresh();
    expect(v.teams![0]!.team).toMatchObject({ role: 'member', canManage: false });
    await expect(acc.invite('team_acme', 'eve@acme.test')).rejects.toMatchObject({ code: 'not_admin' });
    await expect(acc.portal('team_acme')).rejects.toMatchObject({ code: 'not_admin' });
    await expect(acc.changePlan({ team: 'team_acme', plan: 'scale', interval: 'monthly', seats: 6 })).rejects.toMatchObject({ code: 'not_admin' });
    await acc.leaveTeam('team_acme');
    expect(acc.connection('team_acme')).toBeNull();
    expect((await acc.refresh()).teams).toEqual([]);
  });

  it('shows an invite for this email and joins or declines it', async () => {
    const acc = mac.services.cloudAccount;
    fake.set('team-invite');
    let v = await acc.refresh();
    expect(v.account?.invites).toEqual([expect.objectContaining({ id: 'inv_you', teamName: 'Acme', role: 'member' })]);
    expect(v.teams).toEqual([]);
    const t = await acc.acceptInvite({ inviteId: 'inv_you' });
    expect(t).toMatchObject({ id: 'team_acme', role: 'member' });
    v = await acc.refresh();
    expect(v.account?.invites).toEqual([]);
    expect(v.teams?.map((x) => x.team.id)).toEqual(['team_acme']);
    await expect(acc.acceptInvite({ inviteId: 'inv_you' })).rejects.toMatchObject({ code: 'invite_invalid' });
    fake.set('team-admin');
    fake.set('team-invite');
    await acc.declineInvite('inv_you');
    expect((await acc.refresh()).account?.invites).toEqual([]);
  });

  it('a Work checkout makes a team with you as its admin', async () => {
    const acc = mac.services.cloudAccount;
    fake.set('no-plan');
    await expect(acc.checkout({ plan: 'team', interval: 'monthly', members: 8 })).rejects.toMatchObject({ code: 'plan_limit' });
    const co = await acc.checkout({ plan: 'business', interval: 'yearly', members: 12, teamName: 'Globex' });
    expect(co.checkoutUrl).toContain('business:yearly');
    expect(fake.requests.filter((r) => r.path === '/billing/checkout').at(-1)).toMatchObject({ body: { plan: 'business', interval: 'yearly', members: 12, teamName: 'Globex' } });
  });

});
