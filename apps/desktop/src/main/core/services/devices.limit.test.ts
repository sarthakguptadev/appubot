/**
 * The most devices a computer keeps paired (protocol `PAIRED_DEVICES_MAX`): a new one past it is refused with 409 and
 * words the phone shows as they are; the same device pairing again takes its old place (its old token revoked); on a
 * team's AppuBot computer the count is each member's own.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAIRED_DEVICES_MAX } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import type { CoreDeps } from '../context';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

const roots: string[] = [];
const cores: Core[] = [];
afterAll(async () => {
  for (const c of cores) await c.stop().catch(() => undefined);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const CLOUD: CoreDeps['cloud'] = { publicUrl: 'https://ab12cd34ef.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 };

function makeCore(cloud = false): Core {
  const root = mkdtempSync(join(tmpdir(), 'appubot-devices-limit-'));
  roots.push(root);
  const core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    ...(cloud ? { cloud: CLOUD } : {}),
  });
  cores.push(core);
  return core;
}

async function pairAs(core: Core, id: string, o: { member?: { id: string; email: string } } = {}) {
  const info = await core.services.devices.startPairing(300, o.member ? { member: o.member } : {});
  return core.services.devices.pair({ code: info.code, device: { id, name: id, platform: 'ios' } }, '100.64.0.2');
}

describe('paired devices limit', () => {
  it('refuses a new device past the limit, with words the phone shows as they are', async () => {
    const core = makeCore();
    for (let i = 0; i < PAIRED_DEVICES_MAX; i++) expect((await pairAs(core, `phone${i}`))[0]).toBe(200);
    const [status, body] = await pairAs(core, 'one-too-many');
    expect(status).toBe(409);
    expect((body as { error: string }).error).toMatch(/already has 3 devices paired/);
    expect(core.services.devices.list()).toHaveLength(PAIRED_DEVICES_MAX);
    // the pairing is over: the code can't be tried again
    expect(core.services.devices.pairingInfo()).toBeNull();
    // one removed, a new one pairs
    core.services.devices.revoke(core.services.devices.list()[0]!.id);
    expect((await pairAs(core, 'one-too-many'))[0]).toBe(200);
  });

  it('lets a device paired before pair again in its own place, its old token revoked', async () => {
    const core = makeCore();
    for (let i = 0; i < PAIRED_DEVICES_MAX; i++) await pairAs(core, `phone${i}`);
    const before = core.services.devices.list().find((d) => d.name === 'phone1')!;
    const oldHash = core.ctx.store.devices.get().devices.find((d) => d.id === before.id)!.tokenHash;
    const [status] = await pairAs(core, 'phone1');
    expect(status).toBe(200);
    const after = core.services.devices.list();
    expect(after).toHaveLength(PAIRED_DEVICES_MAX);
    expect(after.some((d) => d.id === before.id)).toBe(false);
    expect(core.ctx.store.devices.get().revoked).toContain(oldHash);
    // the device's own id stays off the wire
    expect(JSON.stringify(after)).not.toMatch(/identity/);
  });

  it('counts each member’s own devices on a team’s computer', async () => {
    const core = makeCore(true);
    const ada = { id: 'acc_ada', email: 'ada@acme.test' };
    const bo = { id: 'acc_bo', email: 'bo@acme.test' };
    for (let i = 0; i < PAIRED_DEVICES_MAX; i++) expect((await pairAs(core, `ada${i}`, { member: ada }))[0]).toBe(200);
    const [status, body] = await pairAs(core, 'ada-extra', { member: ada });
    expect(status).toBe(409);
    expect((body as { error: string }).error).toMatch(/the most each person can/);
    expect((await pairAs(core, 'bo0', { member: bo }))[0]).toBe(200);
  });
});
