/**
 * Pairing needs this computer signed in to AppuBot (`CoreDeps.accountRequired`): `pairing.start` refuses
 * `sign_in_required` while signed out, and works once signed in; an AppuBot Cloud computer is always signed in.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function makeCore(o: { signedIn?: boolean; cloud?: boolean } = {}): Core {
  const root = mkdtempSync(join(tmpdir(), 'appubot-pair-account-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  if (o.signedIn) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'cloud-account.json'), JSON.stringify({ token: 'session', sealed: false, email: 'ada@example.com', signedInAt: 1 }));
  }
  const core = createCore({
    paths: { dataDir, botsRoot: join(root, 'bots'), filesDir: join(dataDir, 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    accountRequired: true,
    cloudFetch: async () => new Response('{"error":{"code":"not_found","message":"no"}}', { status: 404, headers: { 'content-type': 'application/json' } }),
    ...(o.cloud ? { cloud: CLOUD } : {}),
  });
  cores.push(core);
  return core;
}

describe('pairing needs this computer signed in', () => {
  it('refuses to start while signed out', async () => {
    await expect(makeCore().services.devices.startPairing(300)).rejects.toMatchObject({ code: 'sign_in_required' });
  });

  it('pairs once signed in, and on an AppuBot Cloud computer always', async () => {
    for (const core of [makeCore({ signedIn: true }), makeCore({ cloud: true })]) {
      const info = await core.services.devices.startPairing(300);
      const [status] = await core.services.devices.pair({ code: info.code, device: { id: 'phone', name: 'Phone', platform: 'ios' } }, '192.168.1.5', undefined, 'lan');
      expect(status).toBe(200);
    }
  });
});
