/**
 * The Mac's AppuBot Cloud account against the fake backend (`cloudFake.ts`, the same one `APPUBOT_CLOUD_FAKE` runs):
 * the sign-in's PKCE and state, the session sealed on disk, the view (account, computer, catalog) and its events,
 * pairing this Mac as the owner of a real cloud-mode core over the end-to-end channel, notices raised while the window
 * is hidden, the backend's refusals by state, a refused session signing out, and the gateway's gating (owner only;
 * nothing on a cloud computer; `cloud.export` only there).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PAIRED_DEVICES_MAX } from '@appubot/protocol';
import { join } from 'node:path';
import { createCore, type Core } from '../app';
import type { CoreDeps } from '../context';
import { buildHandlers, checkRole } from '../handlers';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

/** the platform this computer names when it pairs (`cloudAccount.ts`): tests run on every OS */
const PLATFORM = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
import { CloudFakeBackend } from './cloudFake';

let mac: Core;
let cloud: Core;
let root: string;
let fake: CloudFakeBackend;
const opened: string[] = [];
const notified: { title: string; body: string }[] = [];
const events: { event: string; payload: unknown }[] = [];
let hidden = true;

const base = (dir: string, extra: Partial<CoreDeps>): CoreDeps => ({
  paths: { dataDir: join(dir, 'data'), botsRoot: join(dir, 'bots'), filesDir: join(dir, 'data', 'files'), logsDir: join(dir, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
  runtime: (hooks) => new FakeRuntime(hooks),
  openExternal: (url) => { opened.push(url); }, openTerminal: () => undefined,
  nativeNotify: async (title: string, body: string) => { notified.push({ title, body }); return { shown: true }; },
  version: '0.0.0-test', hostName: 'Sarthak’s Mac', log: silentLogger, validate: true, port: 0, quiet: true,
  computerBackends: () => [], helperTransport: () => null,
  ...extra,
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-cloud-account-'));
  // the cloud computer: a cloud-mode core whose public address is its own port (the fake backend hands out its pairings)
  cloud = createCore(base(join(root, 'cloud'), { hostName: 'AppuBot Cloud', cloud: { publicUrl: '', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 } }));
  await cloud.start();
  cloud.ctx.deps.cloud!.publicUrl = `http://127.0.0.1:${cloud.gateway.port}`;
  fake = new CloudFakeBackend({
    state: 'no-plan',
    pairing: async () => {
      const info = await cloud.services.devices.startPairing(120, { role: 'owner' });
      return { code: info.code, key: cloud.services.connect.key(), hosts: ['127.0.0.1'], port: cloud.gateway.port, hostName: 'AppuBot Cloud', publicUrl: `http://127.0.0.1:${cloud.gateway.port}`, expiresAt: info.expiresAt };
    },
    publicUrl: () => `http://127.0.0.1:${cloud.gateway.port}`,
    onChange: () => { void mac?.services.cloudAccount.refresh().catch(() => undefined); },
  });
  mac = createCore(base(join(root, 'mac'), {
    cloudBackendUrl: 'https://cloud.test/', cloudFetch: fake.fetch,
    secretBox: { encrypt: (s) => `sealed:${s}`, decrypt: (s) => s.replace(/^sealed:/, '') },
    windowHidden: () => hidden,
  }));
  mac.ctx.bus.on((e) => { if (e.event.startsWith('cloudAccount.')) events.push({ event: e.event, payload: e.payload }); });
  await mac.start();
});

afterAll(async () => {
  await mac.stop();
  await cloud.stop();
  fake.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the cloud account', () => {
  it('signs in with PKCE, keeps the session sealed, and reads the account, the computer and the catalog', async () => {
    const acc = mac.services.cloudAccount;
    // signed out, the plans still show (the catalog is public)
    expect(await acc.status()).toMatchObject({ signedIn: false, paired: false, catalog: { plans: [{ id: 'starter' }, { id: 'pro' }, { id: 'max' }, { id: 'ultra' }] } });
    await expect(acc.checkout({ plan: 'starter', interval: 'monthly' })).rejects.toMatchObject({ code: 'signed_out' });
    const { url, state } = await acc.startSignIn();
    expect(opened).toEqual([url]);
    const q = new URL(url).searchParams;
    expect(url.startsWith('https://cloud.test/sign-in?')).toBe(true);
    expect(q.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('redirect')).toBe('appubot://cloud/signed-in');
    expect(q.get('state')).toBe(state);
    expect((await acc.status()).signingIn).toBe(true);
    await expect(acc.finishSignIn({ code: 'c', state: 'not-it' })).rejects.toMatchObject({ code: 'sign_in_failed' });
    const view = await acc.finishSignIn({ code: 'the-code', state });
    expect(view).toMatchObject({ signedIn: true, paired: false, account: { email: 'you@example.com', signupsOpen: true }, computer: { state: 'none' }, catalog: { plans: [{ id: 'starter', monthly: { display: '$19' } }, { id: 'pro', monthly: { display: '$49' } }, { id: 'max' }, { id: 'ultra', monthly: { display: '$109' } }] } });
    expect(view.signingIn).toBeUndefined();
    const swap = fake.requests.find((r) => r.path === '/auth/token')!;
    expect(swap.body).toMatchObject({ code: 'the-code', codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), device: { name: 'Sarthak’s Mac', platform: PLATFORM } });
    const file = JSON.parse(readFileSync(join(root, 'mac', 'data', 'cloud-account.json'), 'utf8'));
    expect(file).toMatchObject({ token: expect.stringMatching(/^sealed:cs_fake_/), sealed: true, email: 'you@example.com' });
    expect(events.some((e) => e.event === 'cloudAccount.updated' && (e.payload as { signedIn: boolean }).signedIn)).toBe(true);
  });

  it('opens the checkout and the portal in the browser, and shows the computer once it is there', async () => {
    const acc = mac.services.cloudAccount;
    const co = await acc.checkout({ plan: 'pro', interval: 'monthly' });
    expect(co.checkoutUrl).toContain('/checkout/pro:monthly');
    expect(opened.at(-1)).toBe(co.checkoutUrl);
    await expect(acc.portal()).rejects.toMatchObject({ code: 'no_subscription' });
    fake.set('running');
    const v = await acc.status(true);
    expect(v.computer).toMatchObject({ state: 'running', awake: { used: 37.5 }, plan: { id: 'pro', name: 'Pro', interval: 'monthly', shape: { cpu: 4, memory: 8, disk: 20 } }, computer: { hostName: 'AppuBot Cloud', shape: { memory: 8 }, recentWakes: expect.any(Array) } });
    expect(v.account).toMatchObject({ status: 'active', subscription: { status: 'active', cancelAtPeriodEnd: false } });
    const portal = await acc.portal();
    expect(opened.at(-1)).toBe(portal.url);
    expect((await acc.desktopLink()).websocketUrl).toContain('/websockify');
    // no page for a browser
    expect(await acc.desktopLink()).not.toHaveProperty('url');
    expect((await acc.accessLog()).items.length).toBeGreaterThan(0);
  });

  it('pairs this Mac as the owner of the cloud computer over the channel and keeps the connection for the window', async () => {
    const acc = mac.services.cloudAccount;
    expect(acc.connection()).toBeNull();
    const r = await acc.pair();
    expect(r.paired).toBe(true);
    expect(fake.requests.at(-1)).toMatchObject({ path: '/computer/pair', body: { device: { platform: PLATFORM }, role: 'owner' } });
    const dev = cloud.services.devices.list().find((d) => d.id === r.deviceId);
    expect(dev).toMatchObject({ role: 'owner', name: 'Sarthak’s Mac', platform: 'desktop' });
    const conn = acc.connection();
    expect(conn).toMatchObject({ publicUrl: `http://127.0.0.1:${cloud.gateway.port}`, key: cloud.services.connect.key(), deviceId: r.deviceId, hostName: 'AppuBot Cloud', role: 'owner' });
    expect(conn!.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const file = JSON.parse(readFileSync(join(root, 'mac', 'data', 'cloud-account.json'), 'utf8'));
    expect(file.cloud).toMatchObject({ token: `sealed:${conn!.token}`, sealed: true, role: 'owner' });
    expect((await acc.status()).paired).toBe(true);
    // the token never rides an event
    expect(JSON.stringify(events)).not.toContain(conn!.token);
  });

  it('raises a notification per cloud notice while the window is hidden, and only the event while it shows', async () => {
    const acc = mac.services.cloudAccount;
    notified.length = 0;
    fake.addNotice('done');
    fake.addNotice('needs-you');
    await acc.poll();
    expect(notified.map((n) => n.title)).toEqual(['Ada finished', 'Ada needs you']);
    expect(events.filter((e) => e.event === 'cloudAccount.notice').map((e) => (e.payload as { kind: string }).kind)).toEqual(['done', 'needs-you']);
    await acc.poll();
    expect(notified).toHaveLength(2);
    hidden = false;
    fake.addNotice('failed', 'Bo');
    await acc.poll();
    expect(notified).toHaveLength(2);
    expect(events.filter((e) => e.event === 'cloudAccount.notice')).toHaveLength(3);
    hidden = true;
    const file = JSON.parse(readFileSync(join(root, 'mac', 'data', 'cloud-account.json'), 'utf8'));
    expect(file.noticeSeq).toBe(3);
  });

  it('passes the backend’s refusals on by state, and starts a sleeping computer', async () => {
    const acc = mac.services.cloudAccount;
    fake.set('on-hold');
    await expect(acc.start()).rejects.toMatchObject({ code: 'on_hold' });
    expect((await acc.status(true)).computer).toMatchObject({ state: 'on-hold', resetsAt: expect.any(Number) });
    await expect(acc.desktopLink()).rejects.toMatchObject({ code: 'on_hold' });
    // a plan change: the preview and the change, then a scheduled downgrade called off
    fake.set('running');
    expect(await acc.previewPlanChange({ plan: 'max', interval: 'monthly' })).toMatchObject({ kind: 'upgrade', when: 'immediate', shape: { memory: 16 } });
    expect((await acc.changePlan({ plan: 'max', interval: 'monthly' })).subscription.plan).toBe('max');
    expect((await acc.changePlan({ plan: 'starter', interval: 'monthly' })).subscription.scheduledChange).toMatchObject({ plan: 'starter' });
    expect((await acc.status(true)).account?.subscription?.scheduledChange).toMatchObject({ plan: 'starter' });
    await acc.cancelPlanChange();
    expect((await acc.status(true)).account?.subscription?.scheduledChange).toBeUndefined();
    expect((await acc.accountPage()).url).toBe('https://cloud.test/account');
    fake.set('asleep');
    expect((await acc.start()).state).toBe('waking');
    // an ended plan's computer stays stopped: nothing starts it for a download
    fake.set('export-only');
    await expect(acc.exportStart()).rejects.toMatchObject({ code: 'export_only' });
    expect((await acc.status(true)).account).toMatchObject({ status: 'ended', exportUntil: expect.any(Number) });
  });

  it('signs out when the backend refuses the session, and on request', async () => {
    const acc = mac.services.cloudAccount;
    fake.set('signed-out');
    const v = await acc.status(true);
    expect(v).toMatchObject({ signedIn: false, paired: false, error: expect.stringMatching(/session ended/) });
    expect(existsSync(join(root, 'mac', 'data', 'cloud-account.json'))).toBe(false);
    expect(acc.connection()).toBeNull();
    const { state } = await acc.startSignIn();
    await acc.finishSignIn({ code: 'c2', state });
    expect((await acc.status()).signedIn).toBe(true);
    expect(await acc.signOut()).toEqual({ ok: true });
    expect(fake.requests.at(-1)).toMatchObject({ method: 'POST', path: '/auth/signout' });
    expect((await acc.status()).signedIn).toBe(false);
  });

  it('pairs in its old place after signing out and in again, and a full cloud computer’s refusal has a code of its own', async () => {
    // a cloud computer keeps a few devices only; a Mac whose every sign-in was a new device there locked itself out
    const acc = mac.services.cloudAccount;
    const devices = cloud.services.devices;
    fake.set('running');
    const was = devices.list();
    expect(was.filter((d) => d.platform === 'desktop')).toHaveLength(1);
    const { state } = await acc.startSignIn();
    await acc.finishSignIn({ code: 'c3', state });
    expect(acc.connection()).toBeNull();
    const r = await acc.pair();
    const now = devices.list();
    expect(now).toHaveLength(was.length);
    expect(now.filter((d) => d.platform === 'desktop').map((d) => d.id)).toEqual([r.deviceId]);
    expect(JSON.parse(readFileSync(join(root, 'mac', 'data', 'cloud-device.json'), 'utf8')).id).toMatch(/^dev_/);
    // the backend hears the same id at every pairing, so it knows this Mac from a new device when the computer is full
    const asked = fake.requests.filter((q) => q.path === '/computer/pair').map((q) => (q.body as { identity?: string }).identity);
    expect(asked.at(-1)).toMatch(/^dev_/);
    expect(asked.at(-1)).toBe(JSON.parse(readFileSync(join(root, 'mac', 'data', 'cloud-device.json'), 'utf8')).id);
    expect(new Set(asked).size).toBe(1);
    // the computer full of other devices, this Mac not among them: told apart from any other failure
    for (const d of devices.list()) devices.revoke(d.id);
    for (let i = 0; i < PAIRED_DEVICES_MAX; i++) {
      const info = await devices.startPairing(120, { role: 'full' });
      expect((await devices.pair({ code: info.code, device: { id: `other-${i}`, name: `Phone ${i}`, platform: 'ios' } }, '127.0.0.1'))[0]).toBe(200);
    }
    await acc.signOut();
    fake.set('running');
    const again = await acc.startSignIn();
    await acc.finishSignIn({ code: 'c4', state: again.state });
    await expect(acc.pair()).rejects.toMatchObject({ code: 'device_limit', message: expect.stringMatching(/already has 3 devices/) });
    devices.revoke(devices.list()[0]!.id);
    expect((await acc.pair()).paired).toBe(true);
    await acc.signOut();
  });

  it('is the Mac’s alone: a phone may not call it, and a cloud computer has none (its export is there instead)', async () => {
    expect(() => checkRole('cloudAccount.status', {}, { role: 'full', deviceId: 'd' })).toThrow(/not allowed/);
    expect(() => checkRole('cloudAccount.connection', {}, { role: 'full', deviceId: 'd' })).toThrow(/not allowed/);
    expect(() => checkRole('cloudAccount.status', {}, { role: 'owner', deviceId: 'desktop' })).not.toThrow();
    await expect(cloud.services.cloudAccount.status()).rejects.toMatchObject({ code: 'unsupported' });
    const onMac = buildHandlers(mac.ctx);
    await expect(onMac['cloud.export']({}, { role: 'owner', deviceId: 'desktop' })).rejects.toMatchObject({ code: 'unsupported' });
    const onCloud = buildHandlers(cloud.ctx);
    const r = await onCloud['cloud.export']({}, { role: 'owner', deviceId: 'dev_1' });
    expect(r).toMatchObject({ fileId: expect.stringMatching(/^file/), name: expect.stringMatching(/^appubot-export-.*\.zip$/), size: expect.any(Number) });
  });
});
