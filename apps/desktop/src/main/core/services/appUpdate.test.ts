import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchema, type Settings } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { checkWorking } from '../handlers';
import { deepMerge, silentLogger } from '../util';
import { AppUpdateService, STOPPED_MESSAGE, compareVersions, shortError, stoppedBy, type AppUpdaterEvent, type AppUpdaterHost } from './appUpdate';

class FakeUpdater implements AppUpdaterHost {
  checks = 0;
  installs = 0;
  /** what a check reports, in order */
  next: AppUpdaterEvent[] = [{ type: 'checking' }, { type: 'none' }];
  fail: Error | null = null;
  private listeners = new Set<(e: AppUpdaterEvent) => void>();

  async check() {
    this.checks++;
    for (const e of this.next) this.emit(e);
    if (this.fail) throw this.fail;
  }
  install() { this.installs++; }
  onEvent(fn: (e: AppUpdaterEvent) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  emit(e: AppUpdaterEvent) { for (const l of this.listeners) l(e); }
}

function setup(o: { host?: FakeUpdater | null; saved?: Record<string, unknown>; version?: string; policy?: () => Response | Promise<Response>; dataDir?: string } = {}) {
  const host = o.host === undefined ? new FakeUpdater() : (o.host ?? undefined);
  let settings = SettingsSchema.parse(o.saved ?? {});
  const listeners = new Set<(n: Settings, p: Settings) => void>();
  const events: string[] = [];
  const notices: { title: string; body?: string }[] = [];
  const cancelled: string[] = [];
  const policy = o.policy;
  const ctx = {
    deps: {
      appUpdater: host, version: o.version ?? '2026.10.17',
      ...(policy ? { versionPolicyUrl: 'https://example.test/version-policy.json', fetch: async () => policy() } : {}),
    },
    paths: { dataDir: o.dataDir ?? '/nonexistent' },
    log: silentLogger,
    bus: { emit: (e: string) => { events.push(e); } },
    s: {
      settings: {
        get: () => settings,
        update: (patch: Partial<Settings>) => {
          const prev = settings;
          settings = SettingsSchema.parse(deepMerge(prev, patch));
          for (const l of listeners) l(settings, prev);
          return settings;
        },
        onChange: (fn: (n: Settings, p: Settings) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
      },
      notifications: { notify: (n: { title: string; body?: string }) => { notices.push(n); } },
      chat: { cancelAll: async () => { cancelled.push('all'); } },
      system: { info: () => ({ update: svc.status() }) },
    },
  } as unknown as CoreCtx;
  const svc = new AppUpdateService(ctx);
  return { svc, host: host as FakeUpdater, ctx, events, notices, cancelled };
}

afterEach(() => { vi.useRealTimers(); });

describe('app updates', () => {
  it('is unsupported without an updater (dev builds, test instances)', async () => {
    const { svc } = setup({ host: null });
    svc.start();
    expect(svc.status()).toEqual({ state: 'unsupported' });
    await expect(svc.check()).rejects.toMatchObject({ code: 'unsupported' });
    expect(() => svc.install()).toThrow();
  });

  it('says up to date when there is nothing newer', async () => {
    const { svc, host, events } = setup();
    svc.start();
    expect(svc.status().state).toBe('idle');
    const s = await svc.check();
    expect(s.state).toBe('up-to-date');
    expect(s.checkedAt).toBeTypeOf('number');
    expect(host.checks).toBe(1);
    expect(events).toContain('system.updated');
    svc.stop();
  });

  it('downloads a newer version, tells the user once and installs it only when ready', async () => {
    const { svc, host, notices } = setup();
    svc.start();
    host.next = [{ type: 'checking' }, { type: 'available', version: '0.2.0' }, { type: 'progress', percent: 41.7 }];
    expect(await svc.check()).toMatchObject({ state: 'downloading', version: '0.2.0', percent: 41 });
    expect(() => svc.install()).toThrow(/No update/);
    // a check while it downloads doesn't start another
    await svc.check();
    expect(host.checks).toBe(1);

    host.emit({ type: 'downloaded', version: '0.2.0' });
    expect(svc.status()).toMatchObject({ state: 'ready', version: '0.2.0' });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toContain('0.2.0');
    host.emit({ type: 'downloaded', version: '0.2.0' });
    expect(notices).toHaveLength(1);

    // a later failure doesn't hide the downloaded update
    host.emit({ type: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' });
    expect(svc.status().state).toBe('ready');
    expect(svc.install()).toEqual({ ok: true });
    expect(host.installs).toBe(1);
    svc.stop();
  });

  it('keeps a failed check short', async () => {
    const { svc, host } = setup();
    svc.start();
    host.next = [{ type: 'checking' }];
    host.fail = new Error('HttpError: 404 \n"method: GET url: https://github.com/x/y/releases.atom"\nData: ...');
    expect(await svc.check()).toMatchObject({ state: 'error', error: 'No release published yet.' });
    svc.stop();
  });

  it('checks in the background a minute after launch, then every 4 hours until stopped', async () => {
    vi.useFakeTimers();
    const { svc, host } = setup();
    svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(4 * 3600_000);
    expect(host.checks).toBe(2);
    svc.stop();
    await vi.advanceTimersByTimeAsync(8 * 3600_000);
    expect(host.checks).toBe(2);
  });

  it('is always on: a switch saved off by an older version is ignored', async () => {
    vi.useFakeTimers();
    const { svc, host } = setup({ saved: { autoUpdate: false } });
    svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.checks).toBe(1);
    svc.stop();
  });
});

describe('shortError', () => {
  it('keeps the first line and names the common cases', () => {
    expect(shortError('Error: getaddrinfo ENOTFOUND github.com\n    at ...')).toBe('No connection to GitHub.');
    expect(shortError('Unable to find latest version on GitHub (https://github.com/x/y/releases/latest)')).toBe('No release published yet.');
    expect(shortError('\n  sha512 checksum mismatch\nmore')).toBe('sha512 checksum mismatch');
    expect(shortError('x'.repeat(500))).toHaveLength(200);
  });
});

describe('version policy', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('compares date versions and says when one is stopped', () => {
    expect(compareVersions('2026.10.17', '2026.10.18')).toBe(-1);
    expect(compareVersions('2026.10.9', '2026.10.17')).toBe(-1);
    expect(compareVersions('2026.11.1', '2026.10.31')).toBe(1);
    expect(compareVersions('2026.10.17', '2026.10.17')).toBe(0);
    expect(stoppedBy({}, '2026.10.17')).toBeNull();
    expect(stoppedBy({ minVersion: '2026.10.17' }, '2026.10.17')).toBeNull();
    expect(stoppedBy({ minVersion: '2026.10.18' }, '2026.10.17')).toBe(STOPPED_MESSAGE);
    expect(stoppedBy({ blocked: ['2026.10.17'], message: ' Fix inside. ' }, '2026.10.17')).toBe('Fix inside.');
    expect(stoppedBy({ blocked: ['2026.10.16'] }, '2026.10.17')).toBeNull();
  });

  it('stops this version: refuses work, ends running turns, tells the user and fetches the update', async () => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'appubot-policy-'));
    const { svc, host, notices, cancelled } = setup({ dataDir: dir, policy: () => json({ minVersion: '2026.10.20', message: 'Please update.' }) });
    svc.start();
    expect(svc.stopped).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(svc.status().required).toEqual({ message: 'Please update.' });
    expect(() => svc.assertWorking()).toThrow(expect.objectContaining({ code: 'update_required' }));
    expect(cancelled).toEqual(['all']);
    expect(notices[0]!.title).toMatch(/needs an update/);
    expect(host.checks).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, 'version-policy.json'), 'utf8'))).toMatchObject({ minVersion: '2026.10.20' });
    svc.stop();
  });

  it('stays stopped offline and across restarts, and works again once the policy lets it', async () => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'appubot-policy-'));
    let answer: () => Response = () => json({ blocked: ['2026.10.17'] });
    const first = setup({ dataDir: dir, policy: () => answer() });
    first.svc.start();
    await vi.advanceTimersByTimeAsync(5_000);
    first.svc.stop();
    expect(first.svc.stopped).toBeDefined();

    // restarted with no connection: the saved policy still applies at once
    answer = () => { throw new Error('offline'); };
    const again = setup({ dataDir: dir, policy: () => answer() });
    again.svc.start();
    expect(again.svc.stopped?.message).toBe(STOPPED_MESSAGE);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(again.svc.stopped).toBeDefined();

    // the policy is lifted (no file at all is no policy)
    answer = () => new Response('not found', { status: 404 });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(again.svc.stopped).toBeUndefined();
    expect(again.svc.status().required).toBeUndefined();
    again.svc.stop();
  });

  it('applies the policy’s phone rules to phones only, once read', async () => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'appubot-policy-'));
    const { svc } = setup({ dataDir: dir, version: '2026.1108.1', policy: () => json({ phone: { minVersion: '2026.1108.1' } }) });
    svc.start();
    // before the read nothing is stopped
    expect(svc.phoneStopped({ platform: 'ios', appVersion: '2026.1107.1' })).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(svc.stopped).toBeUndefined();
    expect(svc.phoneStopped({ platform: 'ios', appVersion: '2026.1107.1' })).toMatch(/the App Store/);
    expect(svc.phoneStopped({ platform: 'android', appVersion: '2026.1107.1' })).toMatch(/Google Play/);
    expect(svc.phoneStopped({ platform: 'ios', appVersion: '2026.1108.1' })).toBeNull();
    expect(svc.phoneStopped({ platform: 'ios' })).toBeNull();
    expect(svc.phoneStopped({ platform: 'desktop', appVersion: '2026.1107.1' })).toBeNull();
    // the saved policy's phone rules apply at the next start too
    svc.stop();
    const again = setup({ dataDir: dir, version: '2026.1108.1', policy: () => { throw new Error('offline'); } });
    again.svc.start();
    expect(again.svc.phoneStopped({ platform: 'ios', appVersion: '2026.1107.1' })).toMatch(/the App Store/);
    again.svc.stop();
  });

  it('never stops a build without a policy URL (dev builds, tests)', async () => {
    vi.useFakeTimers();
    const { svc } = setup({ version: '0.1.0' });
    svc.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(svc.stopped).toBeUndefined();
    svc.stop();
  });

  it('lets a stopped version only update itself and show that', () => {
    const stopped = { message: 'Update.' };
    for (const m of ['system.info', 'system.checkForUpdate', 'system.installUpdate', 'settings.get'] as const) expect(() => checkWorking(m, stopped)).not.toThrow();
    for (const m of ['chat.send', 'bots.create', 'routines.create', 'agent.say', 'settings.update'] as const) expect(() => checkWorking(m, stopped)).toThrow(expect.objectContaining({ code: 'update_required' }));
    expect(() => checkWorking('chat.send', undefined)).not.toThrow();
  });
});
