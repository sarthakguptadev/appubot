/**
 * Opening at login (the first launch registers it, then only the Settings switch changes it, and the OS's own state wins
 * at launch) and notification access (asked for on a launch while macOS hasn't asked yet).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NotificationAccess } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import type { CoreDeps } from '../context';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

const roots: string[] = [];
const cores: Core[] = [];

function makeCore(root: string, extra: Partial<CoreDeps>): Core {
  const core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-pc', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    ...extra,
  });
  cores.push(core);
  return core;
}

const newRoot = () => { const r = mkdtempSync(join(tmpdir(), 'appubot-access-')); roots.push(r); return r; };

afterEach(async () => {
  for (const c of cores.splice(0)) await c.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

class FakeLoginItem {
  on = false;
  sets: boolean[] = [];
  get() { return this.on; }
  set(on: boolean) { this.on = on; this.sets.push(on); }
}

describe('open at login', () => {
  it('turns itself on at the first launch, follows the Settings switch, and keeps what the user set in the OS', async () => {
    const root = newRoot();
    const item = new FakeLoginItem();
    const first = makeCore(root, { loginItem: item });
    await first.start();
    expect(item.sets).toEqual([true]);
    expect(existsSync(join(root, 'data', 'login-item.json'))).toBe(true);

    first.services.settings.update({ launchAtLogin: false });
    expect(item.sets).toEqual([true, false]);
    first.services.settings.update({ launchAtLogin: true });
    expect(item.on).toBe(true);
    await first.stop();
    cores.splice(0);

    // the user removed it in System Settings: the next launch doesn't put it back, the switch shows it off
    item.on = false;
    item.sets = [];
    const second = makeCore(root, { loginItem: item });
    await second.start();
    expect(item.sets).toEqual([]);
    expect(second.services.settings.get().launchAtLogin).toBe(false);
  });

  it('leaves the OS alone without a login item (dev builds and test instances)', async () => {
    const core = makeCore(newRoot(), {});
    await core.start();
    expect(core.services.settings.get().launchAtLogin).toBe(true);
  });
});

describe('notification access', () => {
  const deps = (state: { access: NotificationAccess; asked: number }): Partial<CoreDeps> => ({
    notificationAccess: async () => state.access,
    requestNotifications: async () => { state.asked++; state.access = 'on'; return state.access; },
  });

  it('asks while the OS hasn\'t asked yet, and only then', async () => {
    const state = { access: 'not-asked' as NotificationAccess, asked: 0 };
    const core = makeCore(newRoot(), deps(state));
    await core.start();
    await core.services.notifications.askIfNotAsked();
    expect(state.asked).toBe(1);
    expect(await core.services.notifications.access()).toEqual({ access: 'on' });
    await core.services.notifications.askIfNotAsked();
    expect(state.asked).toBe(1);
  });

  it('doesn\'t ask when the user turned notifications off in AppuBot, or once they said no', async () => {
    const state = { access: 'not-asked' as NotificationAccess, asked: 0 };
    const core = makeCore(newRoot(), deps(state));
    await core.start();
    core.services.settings.update({ notifications: { desktop: false, mobile: true } });
    await core.services.notifications.askIfNotAsked();
    expect(state.asked).toBe(0);

    core.services.settings.update({ notifications: { desktop: true, mobile: true } });
    state.access = 'off';
    await core.services.notifications.askIfNotAsked();
    expect(state.asked).toBe(0);
  });

  it('says unknown where the OS can\'t tell', async () => {
    const core = makeCore(newRoot(), {});
    await core.start();
    expect(await core.services.notifications.access()).toEqual({ access: 'unknown' });
  });
});
