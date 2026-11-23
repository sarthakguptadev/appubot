/**
 * The version policy's phone rules at the gateway: a phone app the policy stopped is refused at hello as too old (the
 * frame every phone already reads as "update this app") and at `/api/pair` before any code is spent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION } from '@appubot/protocol';
import { createCore, type Core } from './app';
import { FakeRuntime } from './testing/fakeRuntime';
import { silentLogger } from './util';

const POLICY_URL = 'https://example.test/version-policy.json';
let core: Core;
let base: string;
let root: string;
let policy: unknown = { minVersion: '2026.1101.1', phone: { minVersion: '2026.1108.1', blocked: ['2026.1109.1'], message: 'Update the AppuBot app.' } };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-gw-policy-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined,
    openTerminal: () => undefined,
    nativeNotify: () => undefined,
    version: '2026.1108.1',
    hostName: 'test-mac',
    log: silentLogger,
    validate: true,
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    computerBackends: () => [],
    helperTransport: () => null,
    versionPolicyUrl: POLICY_URL,
    fetch: (async (url: string | URL | Request) => (String(url) === POLICY_URL
      ? new Response(JSON.stringify(policy), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('not found', { status: 404 }))) as typeof fetch,
  });
  await core.start();
  await core.services.appUpdate.refreshPolicy();
  base = `http://127.0.0.1:${core.gateway.port}`;
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

const hello = (device: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'connect', token: core.ownerToken, protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_PROTOCOL_VERSION, device: { id: 'v', name: 'v', ...device } })));
  ws.on('message', (d) => { resolve(JSON.parse(String(d))); ws.close(); });
  setTimeout(() => reject(new Error('no hello')), 3000);
});

describe('version policy for phones', () => {
  it('refuses a stopped phone at hello as too old, with the policy’s words', async () => {
    expect(core.services.appUpdate.stopped).toBeUndefined();
    expect(await hello({ platform: 'ios', appVersion: '2026.1107.2' })).toMatchObject({
      ok: false, code: 'protocol_mismatch', update: 'client', error: 'Update the AppuBot app.', protocolVersion: PROTOCOL_VERSION, minProtocolVersion: MIN_PROTOCOL_VERSION, serverVersion: '2026.1108.1',
    });
    expect(await hello({ platform: 'android', appVersion: '2026.1109.1' })).toMatchObject({ ok: false, code: 'protocol_mismatch', update: 'client' });
    // a phone the rules allow, a phone that names no version, and the desktop window with an old version
    expect(await hello({ platform: 'ios', appVersion: '2026.1108.1' })).toMatchObject({ ok: true });
    expect(await hello({ platform: 'ios' })).toMatchObject({ ok: true });
    expect(await hello({ platform: 'desktop', appVersion: '2026.10.1' })).toMatchObject({ ok: true });
  });

  it('refuses a stopped phone’s pairing before its code is spent', async () => {
    const info = await core.services.devices.startPairing();
    const body = (device: Record<string, unknown>) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: info.code, device: { id: 'p1', name: 'iPhone', ...device } }) });
    const stopped = await fetch(`${base}/api/pair`, body({ platform: 'ios', appVersion: '2026.1107.2' }));
    expect(stopped.status).toBe(409);
    expect(await stopped.json()).toEqual({ error: 'Update the AppuBot app.' });
    // the code still works for an app that may pair
    const ok = await fetch(`${base}/api/pair`, body({ platform: 'ios', appVersion: '2026.1108.1' }));
    expect(ok.status).toBe(200);
  });

  it('lets every phone through once the phone rules are lifted', async () => {
    policy = { minVersion: '2026.1101.1' };
    await core.services.appUpdate.refreshPolicy();
    expect(await hello({ platform: 'ios', appVersion: '2026.1107.2' })).toMatchObject({ ok: true });
  });
});
