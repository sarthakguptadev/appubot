/**
 * The window's saved copies of the cloud computers' chats (`cloudAccount.cacheGet`/`cacheSet`): sealed on disk, bound
 * to the account, kept through a failed read and dropped when a computer stops being the person's (off the team, the
 * plan over, signed out), all against the fake backend.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../app';
import type { CoreCtx, CoreDeps } from '../context';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { CloudFakeBackend } from './cloudFake';
import { CloudCache, sameOwner } from './cloudCache';

/** a stand-in keychain: sealed text never shows the plain one */
const secretBox = {
  encrypt: (s: string) => `sealed:${Buffer.from(s, 'utf8').toString('base64')}`,
  decrypt: (s: string) => Buffer.from(s.slice('sealed:'.length), 'base64').toString('utf8'),
};

const base = (dir: string, extra: Partial<CoreDeps>): CoreDeps => ({
  paths: { dataDir: join(dir, 'data'), botsRoot: join(dir, 'bots'), filesDir: join(dir, 'data', 'files'), logsDir: join(dir, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
  runtime: (hooks) => new FakeRuntime(hooks),
  openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: async () => ({ shown: true }),
  version: '0.0.0-test', hostName: 'Sarthak’s Mac', log: silentLogger, validate: true, port: 0, quiet: true,
  computerBackends: () => [], helperTransport: () => null,
  ...extra,
});

describe('CloudCache on its own', () => {
  let dir: string;
  let owner: { id?: string; email?: string } | null;
  let cache: CloudCache;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'appubot-cloud-cache-'));
    owner = { email: 'sam@example.com' };
    const ctx = { paths: { dataDir: dir }, deps: { secretBox }, log: silentLogger } as unknown as CoreCtx;
    cache = new CloudCache(ctx, () => owner);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps a copy sealed, user-only, and reads it back', () => {
    cache.set(undefined, '{"bots":[{"name":"Ada"}]}');
    cache.set('team_acme', '{"bots":[{"name":"Acme bot"}]}');
    expect(cache.get()?.data).toBe('{"bots":[{"name":"Ada"}]}');
    expect(cache.get('team_acme')?.data).toContain('Acme bot');
    expect(cache.keys().sort()).toEqual(['own', 'team:team_acme']);
    const file = join(dir, 'cloud-cache', 'own.json');
    expect(readFileSync(file, 'utf8')).not.toContain('Ada');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'cloud-cache')).mode & 0o777).toBe(0o700);
  });

  it('drops a copy written for another account, and keeps nothing while signed out', () => {
    owner = { email: 'other@example.com' };
    expect(cache.get()).toBeNull();
    expect(existsSync(join(dir, 'cloud-cache', 'own.json'))).toBe(false);
    owner = null;
    cache.set(undefined, '{"x":1}');
    expect(cache.get()).toBeNull();
    owner = { email: 'sam@example.com' };
    cache.set(undefined, '');
    expect(cache.get()).toBeNull();
  });

  it('tells owners apart only by what both know', () => {
    expect(sameOwner({ email: 'A@x.com' }, { email: 'a@x.com', id: 'acc_1' })).toBe(true);
    expect(sameOwner({ id: 'acc_1' }, { id: 'acc_2' })).toBe(false);
    expect(sameOwner({}, { id: 'acc_2' })).toBe(true);
  });
});

describe('copies follow the account', () => {
  let mac: Core;
  let cloud: Core;
  let root: string;
  let fake: CloudFakeBackend;
  let offline = false;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appubot-cloud-cache-acc-'));
    cloud = createCore(base(join(root, 'cloud'), { hostName: 'Acme', cloud: { publicUrl: '', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 } }));
    await cloud.start();
    fake = new CloudFakeBackend({
      state: 'personal-team',
      pairing: async () => {
        const info = await cloud.services.devices.startPairing(120, { role: 'owner' });
        return { code: info.code, key: cloud.services.connect.key(), hosts: ['127.0.0.1'], port: cloud.gateway.port, hostName: 'Acme', publicUrl: `http://127.0.0.1:${cloud.gateway.port}`, expiresAt: info.expiresAt };
      },
      publicUrl: () => `http://127.0.0.1:${cloud.gateway.port}`,
    });
    const fetchVia: typeof fetch = (input, init) => (offline ? Promise.reject(new TypeError('fetch failed')) : fake.fetch(input, init));
    mac = createCore(base(join(root, 'mac'), { cloudBackendUrl: 'https://cloud.test/', cloudFetch: fetchVia, windowHidden: () => true, secretBox }));
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

  const cacheDir = () => join(root, 'mac', 'data', 'cloud-cache');

  it('keeps the window’s copies of the own and the team’s computer', async () => {
    const acc = mac.services.cloudAccount;
    await acc.status(true);
    acc.cacheSet(undefined, '{"own":true}');
    acc.cacheSet('team_acme', '{"team":true}');
    expect(acc.cacheGet()?.data).toBe('{"own":true}');
    expect(acc.cacheGet('team_acme')?.data).toBe('{"team":true}');
    expect(readdirSync(cacheDir()).sort()).toEqual(['own.json', 'team-team_acme.json']);
  });

  it('keeps a team computer’s page sealed beside its files and frames it from this Mac’s gateway', async () => {
    const acc = mac.services.cloudAccount;
    const kept = acc.pageSet('team_acme', 'file_page1', '<h1>Q3 revenue</h1>');
    expect(kept.changed).toBe(true);
    const file = join(root, 'mac', 'data', 'cloud-files', 'team-team_acme', 'file_page1', '.page.json');
    expect(readFileSync(file, 'utf8')).not.toContain('Q3 revenue');
    expect(acc.pageGet('team_acme', 'file_page1')?.hash).toBe(kept.hash);
    const res = await fetch(`http://127.0.0.1:${mac.gateway.port}${kept.path}&theme=light`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await res.text()).toContain('Q3 revenue');
    // another page's key, or none, opens nothing
    const other = acc.pageSet(undefined, 'file_page2', '<p>own</p>');
    const swapped = kept.path.replace(/v=[^&]+/, other.path.match(/v=([^&]+)/)![0]);
    expect((await fetch(`http://127.0.0.1:${mac.gateway.port}${swapped}`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${mac.gateway.port}/cloud-pages/team-team_acme/file_page1`)).status).toBe(404);
  });

  it('keeps them through a failed read', async () => {
    offline = true;
    await mac.services.cloudAccount.refresh();
    offline = false;
    expect(mac.services.cloudAccount.cacheGet('team_acme')).not.toBeNull();
    expect(mac.services.cloudAccount.cacheGet()).not.toBeNull();
  });

  it('drops the team’s copy once the person is off the team, and the own one when the plan is over', async () => {
    const acc = mac.services.cloudAccount;
    fake.set('team-member');
    await acc.refresh();
    acc.cacheSet('team_acme', '{"team":true}');
    await acc.leaveTeam('team_acme');
    await acc.refresh();
    expect(acc.cacheGet('team_acme')).toBeNull();
    // the pages and files kept of it went with it
    expect(existsSync(join(root, 'mac', 'data', 'cloud-files', 'team-team_acme'))).toBe(false);
    // a member's state here has no plan of their own: that copy went too
    expect(acc.cacheGet()).toBeNull();
    fake.set('running');
    await acc.refresh();
    acc.cacheSet(undefined, '{"own":true}');
    await acc.refresh();
    expect(acc.cacheGet()).not.toBeNull();
    fake.set('no-plan');
    await acc.refresh();
    expect(acc.cacheGet()).toBeNull();
  });

  it('a launch answers with the last view at once (sealed on disk), while its first read runs', async () => {
    const acc = mac.services.cloudAccount;
    fake.set('running');
    const read = await acc.refresh();
    const file = join(root, 'mac', 'data', 'cloud-view.json');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain('"computer"');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    let asked = 0;
    const launch = () => createCore(base(join(root, 'mac'), { cloudBackendUrl: 'https://cloud.test/', cloudFetch: () => { asked++; return new Promise<Response>(() => undefined); }, windowHidden: () => true, secretBox }));
    // under a minute old: answered as it is, nothing read (the request rules)
    const view = await launch().services.cloudAccount.status();
    expect(view.account?.id).toBe(read.account?.id);
    expect(view.computer?.state).toBe(read.computer?.state);
    await new Promise((r) => setTimeout(r, 10));
    expect(asked).toBe(0);
    // older: still answered at once, and a read starts behind it (one that never answers here)
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000);
    try {
      const later = await launch().services.cloudAccount.status();
      expect(later.account?.id).toBe(read.account?.id);
      await new Promise((r) => setTimeout(r, 10));
      expect(asked).toBeGreaterThan(0);
    } finally {
      clock.mockRestore();
    }
  });

  it('drops every copy on sign-out and keeps none after', async () => {
    const acc = mac.services.cloudAccount;
    fake.set('running');
    await acc.refresh();
    acc.cacheSet(undefined, '{"own":true}');
    acc.pageSet(undefined, 'file_page3', '<p>mine</p>');
    await acc.signOut();
    expect(existsSync(cacheDir())).toBe(false);
    expect(existsSync(join(root, 'mac', 'data', 'cloud-files'))).toBe(false);
    expect(existsSync(join(root, 'mac', 'data', 'cloud-view.json'))).toBe(false);
    expect(() => acc.pageSet(undefined, 'file_page3', '<p>mine</p>')).toThrow();
    expect(acc.cacheGet()).toBeNull();
    expect(() => acc.cacheSet(undefined, '{"own":true}')).toThrow();
  });
});
