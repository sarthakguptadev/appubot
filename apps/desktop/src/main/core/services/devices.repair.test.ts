/**
 * Fix your computer on the computer's side: the paired devices read before a restore puts
 * an older copy of `devices.json` back (`/control/devices/save` → `DevicesService.snapshot`), merged back after it
 * (`/control/devices/restore` → `mergeSnapshot`): devices paired since the copy come back, a device re-paired since
 * keeps its new token, a revoked token and a removed team member stay out, and only a cloud computer does any of it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../app';
import type { CoreDeps } from '../context';
import type { DevicesFile, StoredDevice } from '../store';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

const roots: string[] = [];
const cores: Core[] = [];
afterAll(async () => {
  for (const c of cores) await c.stop().catch(() => undefined);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const CLOUD: CoreDeps['cloud'] = { publicUrl: 'https://ab12cd34ef.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 };

function makeCore(cloud = true): Core {
  const root = mkdtempSync(join(tmpdir(), 'appubot-devices-repair-'));
  roots.push(root);
  const core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'AppuBot Cloud', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    ...(cloud ? { cloud: CLOUD } : {}),
  });
  cores.push(core);
  return core;
}

const dev = (id: string, tokenHash: string, o: Partial<StoredDevice> = {}): StoredDevice => ({ id, name: id, platform: 'ios', role: 'full', pairedAt: 1, online: false, tokenHash, ...o });

describe('a repair keeps the devices paired (cloud computer)', () => {
  it('merges the list from before the restore into the older copy the restore brought back', () => {
    const core = makeCore();
    const devices = core.services.devices;
    const store = core.ctx.store.devices;
    // last night's copy: the owner's Mac, Bo's phone (a team member), the old token of Ada's phone
    const lastNight: DevicesFile = { devices: [dev('mac', 'h_mac', { role: 'owner', platform: 'desktop' }), dev('bo', 'h_bo', { memberId: 'acc_bo', memberEmail: 'bo@acme.test' }), dev('ada_phone', 'h_ada_old')], revoked: [], removedMembers: [] };
    // today, before the reset: Ada's phone re-paired (a new token), a new iPad, Bo removed from the team, an old tablet revoked
    const today: DevicesFile = {
      devices: [dev('mac', 'h_mac', { role: 'owner', platform: 'desktop' }), dev('ada_phone', 'h_ada_new', { name: 'Ada’s phone' }), dev('ipad', 'h_ipad')],
      revoked: ['h_bo', 'h_ada_old', 'h_tablet'], removedMembers: ['acc_bo'],
    };
    store.set(today);
    const snap = devices.snapshot();
    expect(snap.devices.map((d) => d.id)).toEqual(['mac', 'ada_phone', 'ipad']);
    expect(snap.devices[1]).toMatchObject({ tokenHash: 'h_ada_new' });
    expect(JSON.stringify(snap)).not.toMatch(/"token"/);
    // the restore puts last night's file back
    store.set(lastNight);
    const r = devices.mergeSnapshot(snap);
    const after = store.get();
    expect(after.devices.map((d) => [d.id, d.tokenHash]).sort()).toEqual([['ada_phone', 'h_ada_new'], ['ipad', 'h_ipad'], ['mac', 'h_mac']]);
    expect(after.revoked).toEqual(expect.arrayContaining(['h_bo', 'h_ada_old', 'h_tablet']));
    expect(after.removedMembers).toEqual(['acc_bo']);
    expect(r).toEqual({ added: 2, removed: 1 });
    // idempotent: merging again changes nothing
    expect(devices.mergeSnapshot(snap)).toEqual({ added: 0, removed: 0 });
    expect(store.get().devices).toHaveLength(3);
    // a pairing of a removed member through anything but the backend stays refused
    expect(devices.memberRemoved('acc_bo')).toBe(true);
  });

  it('drops malformed rows instead of trusting them', () => {
    const core = makeCore();
    core.ctx.store.devices.set({ devices: [], revoked: [] });
    const r = core.services.devices.mergeSnapshot({ devices: [{ id: 'x' }, { id: 'y', tokenHash: 'h', name: 'Y', role: 'root' }, { id: 'ok', tokenHash: 'h_ok', name: 'OK', role: 'full', platform: 'ios', pairedAt: 1 }], revoked: [], at: 1 });
    expect(r.added).toBe(1);
    expect(core.ctx.store.devices.get().devices.map((d) => d.id)).toEqual(['ok']);
  });

  it('a list with nothing but one revoked token removes that device and leaves the rest (the account’s Remove)', () => {
    // the backend's `POST /v1/computer/devices/remove`: for a device this computer refused as one too many
    const core = makeCore();
    const devices = core.services.devices;
    const store = core.ctx.store.devices;
    store.set({ devices: [dev('old_mac', 'h_old', { role: 'owner', platform: 'desktop' }), dev('phone', 'h_phone', { role: 'owner' }), dev('ipad', 'h_ipad')], revoked: [] });
    expect(devices.mergeSnapshot({ devices: [], revoked: ['h_old'], removedMembers: [], at: Date.now() })).toEqual({ added: 0, removed: 1 });
    expect(store.get().devices.map((d) => d.id)).toEqual(['phone', 'ipad']);
    expect(store.get().revoked).toEqual(['h_old']);
    expect(devices.list().map((d) => d.id)).toEqual(['phone', 'ipad']);
  });

  it('only on a cloud computer', () => {
    const mac = makeCore(false);
    expect(() => mac.services.devices.snapshot()).toThrow(/Only an AppuBot Cloud computer/);
    expect(() => mac.services.devices.mergeSnapshot({ devices: [], revoked: [], at: 1 })).toThrow(/Only an AppuBot Cloud computer/);
  });
});
