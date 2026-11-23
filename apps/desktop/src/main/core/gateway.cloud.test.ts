/**
 * The gateway on an AppuBot Cloud computer: every peer but the computer itself is route `cloud` and gets only
 * /api/health, the channel (SECURE_PATH) and Telegram's webhook; the computer's own `*.agent37.app` name is a valid
 * Host; the relay is never admitted; a phone pairs and connects through the channel, as on the Wi-Fi, and the control
 * server can hand out an owner pairing.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { CONNECT_PEER_HEADER, SECURE_PEER_HEADER, type Settings } from '@appubot/protocol';
import { createCore, type Core } from './app';
import type { CoreDeps } from './context';
import { connectionRole, forwardedAddress, hostAllowed, peerPolicy, plainCloud } from './gateway';
import { buildHandlers } from './handlers';
import { FakeRuntime } from './testing/fakeRuntime';
import { TestPhone } from './testing/channelPhone';
import { silentLogger } from './util';

const roots: string[] = [];
const cores: Core[] = [];
const phones: TestPhone[] = [];
afterAll(async () => {
  for (const p of phones) p.close();
  for (const c of cores) await c.stop();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const CLOUD: CoreDeps['cloud'] = { publicUrl: 'https://ab12cd34ef.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 };

function makeCore(extra: Partial<CoreDeps> = {}): Core {
  const root = mkdtempSync(join(tmpdir(), 'appubot-cloud-gw-'));
  roots.push(root);
  const core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'AppuBot Cloud', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    cloud: CLOUD,
    ...extra,
  });
  cores.push(core);
  return core;
}

/** Plain peers (no channel header) look like they came from the internet; the channel's own replays are checked as they are. */
function onInternet(core: Core, ip = '203.0.113.5'): void {
  const real = core.gateway.checkPeer.bind(core.gateway);
  vi.spyOn(core.gateway, 'checkPeer').mockImplementation((rawIp, headers = {}) =>
    real(headers[SECURE_PEER_HEADER] || headers[CONNECT_PEER_HEADER] ? rawIp : ip, headers));
}

/** A GET with its own Host header (fetch won't send one): the status. */
function getWithHost(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

/** A Mac's own gateway over loopback (`/ws`, no channel): the hello a device token gets. */
function helloOf(port: number, token: string, deviceId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'connect', token, device: { id: deviceId, name: 'Phone', platform: 'ios', appVersion: '1' } })));
    ws.on('message', (d) => { resolve(JSON.parse(String(d))); ws.close(); });
    ws.on('error', reject);
  });
}

function plainUpgrade(url: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
    ws.on('open', () => { resolve(101); ws.close(); });
    ws.on('error', () => undefined);
  });
}

const g: Settings['gateway'] = { bind: 'tailscale', allowLan: true, requireTailscalePeer: true, port: 7890 };

describe('the cloud peer policy', () => {
  it('admits everyone as route cloud and the computer itself as local, whatever the settings say', () => {
    expect(peerPolicy('127.0.0.1', g, true)).toEqual({ ok: true, route: 'local' });
    expect(peerPolicy('203.0.113.5', g, true)).toEqual({ ok: true, route: 'cloud' });
    expect(peerPolicy('192.168.1.9', g, true)).toEqual({ ok: true, route: 'cloud' });
    expect(peerPolicy('100.101.12.44', g, true)).toEqual({ ok: true, route: 'cloud' });
    expect(peerPolicy('203.0.113.5', { ...g, bind: 'loopback' }, true)).toEqual({ ok: true, route: 'cloud' });
    // a Mac is as it was
    expect(peerPolicy('203.0.113.5', g)).toMatchObject({ ok: false });
    expect(peerPolicy('192.168.1.9', g)).toEqual({ ok: true, route: 'lan' });
  });

  it('knows the computer by its agent37.app name only on the cloud', () => {
    expect(hostAllowed('ab12cd34ef.agent37.app', true)).toBe(true);
    expect(hostAllowed('gateway-ab12cd34ef.agent37.app:443', true)).toBe(true);
    expect(hostAllowed('ab12cd34ef.agent37.app')).toBe(false);
    expect(hostAllowed('evil.com', true)).toBe(false);
    expect(hostAllowed('agent37.app.evil.com', true)).toBe(false);
    expect(hostAllowed('127.0.0.1:7443', true)).toBe(true);
  });

  it('tells plain cloud peers from the channel’s, and reads the edge’s forwarded address', () => {
    expect(plainCloud({ route: 'cloud' })).toBe(true);
    expect(plainCloud({ route: 'cloud', secure: true })).toBe(false);
    expect(plainCloud({ route: 'lan' })).toBe(false);
    expect(forwardedAddress({ 'x-forwarded-for': '203.0.113.5, 10.0.0.2' }, '10.0.0.1')).toBe('203.0.113.5');
    expect(forwardedAddress({ 'x-forwarded-for': ['2001:db8::7'] }, '10.0.0.1')).toBe('2001:db8::7');
    expect(forwardedAddress({ 'x-forwarded-for': 'not an ip' }, '10.0.0.1')).toBe('10.0.0.1');
    expect(forwardedAddress({}, '::ffff:10.0.0.1')).toBe('10.0.0.1');
    // the edge's own word wins over what a client wrote: X-Forwarded-For's first entry is the client's to choose
    expect(forwardedAddress({ 'cf-connecting-ip': '198.51.100.9', 'x-forwarded-for': '1.2.3.4, 198.51.100.9' }, '10.0.0.1')).toBe('198.51.100.9');
    expect(forwardedAddress({ 'cf-connecting-ip': '2001:db8::9', 'x-forwarded-for': '1.2.3.4' }, '10.0.0.1')).toBe('2001:db8::9');
    expect(forwardedAddress({ 'cf-connecting-ip': 'junk', 'x-forwarded-for': '203.0.113.5' }, '10.0.0.1')).toBe('203.0.113.5');
  });
});

describe('a cloud gateway', () => {
  it('serves the internet nothing but health, the channel and the webhook path; the relay is off; a phone pairs through the channel as route cloud', async () => {
    const core = makeCore();
    await core.start();
    expect(core.services.connect.wanted()).toBe(false);
    expect(core.services.system.info().cloud).toEqual({ state: 'ok', publicUrl: 'https://ab12cd34ef.agent37.app' });
    const info = await core.services.devices.startPairing(120);
    expect(info.hosts).toEqual([{ host: '127.0.0.1', kind: 'loopback', port: core.gateway.port }]);
    expect(info.connectKey).toBe(core.services.connect.key());
    expect(info.connectId).toBeUndefined();

    onInternet(core);
    const base = `http://127.0.0.1:${core.gateway.port}`;
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    const pair = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: info.code, device: { id: 'p', name: 'P', platform: 'ios' } }) });
    expect(pair.status).toBe(403);
    expect(await pair.json()).toMatchObject({ code: 'secure_required' });
    expect((await fetch(`${base}/files/x`)).status).toBe(403);
    expect(await plainUpgrade(`ws://127.0.0.1:${core.gateway.port}/ws?token=${core.ownerToken}`)).toBe(403);
    // the webhook path is open (Telegram proves itself with its secret); no such channel here
    expect((await fetch(`${base}/telegram/telegram`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
    // the computer's own name is a valid Host, another name isn't
    expect(await getWithHost(core.gateway.port, '/api/health', 'ab12cd34ef.agent37.app')).toBe(200);
    expect(await getWithHost(core.gateway.port, '/api/health', 'evil.com')).toBe(403);
    // the channel's replays are the phone's, route cloud; the relay's header is refused
    expect(await core.gateway.checkPeer('127.0.0.1', { [SECURE_PEER_HEADER]: '203.0.113.5' })).toEqual({ ok: true, route: 'cloud', ip: '203.0.113.5', secure: true });
    expect(await core.gateway.checkPeer('127.0.0.1', { [CONNECT_PEER_HEADER]: '203.0.113.5' })).toMatchObject({ ok: false });

    const phone = await TestPhone.direct(`ws://127.0.0.1:${core.gateway.port}/secure`, info.connectKey!);
    phones.push(phone);
    const paired = await phone.request('POST', '/api/pair', { code: info.code, device: { id: 'phone', name: 'Phone', platform: 'ios' } });
    expect(paired.status).toBe(200);
    const { token, deviceId, role } = paired.json as { token: string; deviceId: string; role: string };
    expect(role).toBe('full');
    const hello = JSON.parse(await phone.openGateway(1, token, deviceId)) as { ok: boolean; role: string };
    expect(hello).toMatchObject({ ok: true, role: 'full' });
    expect(core.services.devices.list()[0]).toMatchObject({ id: deviceId, route: 'cloud', online: true });
  });

  it('pairs the owner only when the control server asks for it, and the next pairing is a full one again', async () => {
    const core = makeCore();
    await core.start();
    const owner = await core.services.devices.startPairing(120, { role: 'owner' });
    const phone = await TestPhone.direct(`ws://127.0.0.1:${core.gateway.port}/secure`, owner.connectKey!);
    phones.push(phone);
    const paired = await phone.request('POST', '/api/pair', { code: owner.code, device: { id: 'mac', name: 'Sarthak’s Mac', platform: 'desktop' } });
    expect(paired.json).toMatchObject({ role: 'owner' });
    const { token, deviceId } = paired.json as { token: string; deviceId: string };
    expect(JSON.parse(await phone.openGateway(1, token, deviceId))).toMatchObject({ ok: true, role: 'owner' });
    expect(core.services.devices.list().find((d) => d.id === deviceId)?.role).toBe('owner');
    const next = await core.services.devices.startPairing(120);
    const phone2 = await TestPhone.direct(`ws://127.0.0.1:${core.gateway.port}/secure`, next.connectKey!);
    phones.push(phone2);
    expect((await phone2.request('POST', '/api/pair', { code: next.code, device: { id: 'phone', name: 'Phone', platform: 'ios' } })).json).toMatchObject({ role: 'full' });
  });
});

describe('an owner device', () => {
  it('is the owner on the cloud alone: a device row with that role on a Mac is heard as full', async () => {
    expect(connectionRole({ kind: 'device', role: 'owner' }, true)).toBe('owner');
    expect(connectionRole({ kind: 'device', role: 'owner' }, false)).toBe('full');
    expect(connectionRole({ kind: 'device', role: 'full' }, true)).toBe('full');
    expect(connectionRole({ kind: 'owner', role: 'owner' }, false)).toBe('owner');
    expect(connectionRole({ kind: 'agent', role: 'agent' }, true)).toBe('agent');
    // a Mac with such a row (a devices.json copied from a cloud export, or edited by hand): full, like any phone
    const mac = makeCore({ cloud: undefined, hostName: 'Mac' });
    await mac.start();
    const { token, hash } = mac.ctx.auth.newDeviceToken();
    mac.ctx.store.devices.update((f) => ({ ...f, devices: [...f.devices, { id: 'dev_owner', name: 'Phone', platform: 'ios', role: 'owner', pairedAt: Date.now(), online: false, tokenHash: hash }] }));
    expect(await helloOf(mac.gateway.port, token, 'dev_owner')).toMatchObject({ ok: true, role: 'full' });
  });

  it('gets on the cloud what the window gets (agent keys, Vault secrets, gateway settings), where a full phone is refused', async () => {
    const core = makeCore();
    await core.start();
    const connect = async (role: 'owner' | 'full') => {
      const info = await core.services.devices.startPairing(120, { role });
      const phone = await TestPhone.direct(`ws://127.0.0.1:${core.gateway.port}/secure`, info.connectKey!);
      phones.push(phone);
      const paired = await phone.request('POST', '/api/pair', { code: info.code, device: { id: `p-${role}`, name: 'iPhone', platform: 'ios' } });
      const { token, deviceId } = paired.json as { token: string; deviceId: string };
      expect(JSON.parse(await phone.openGateway(1, token, deviceId))).toMatchObject({ ok: true, role });
      let n = 0;
      return async (method: string, params: unknown): Promise<{ ok: boolean; error?: { code: string } }> => {
        const id = `${role}-${++n}`;
        phone.sendText(1, JSON.stringify({ type: 'req', id, method, params }));
        return phone.nextRes(1, id) as Promise<{ ok: boolean; error?: { code: string } }>;
      };
    };
    const owner = await connect('owner');
    const full = await connect('full');
    // the gate (checkRole) is what differs: the owner's calls reach the handlers (which may still refuse on their own terms)
    expect(await full('vault.reveal', { id: 'nope', field: 'password' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect((await owner('vault.reveal', { id: 'nope', field: 'password' })).error?.code).not.toBe('forbidden');
    expect(await full('settings.update', { gateway: { allowLan: false } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await owner('settings.update', { gateway: { allowLan: false } })).toMatchObject({ ok: true });
    expect(core.services.settings.get().gateway.allowLan).toBe(false);
    expect(await full('providers.clearKeys', { id: 'claude-code' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect((await owner('providers.clearKeys', { id: 'claude-code' })).error?.code).not.toBe('forbidden');
    expect(await full('files.sendToDevices', { path: '/nonexistent/file.txt', deviceIds: [] })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect((await owner('files.sendToDevices', { path: '/nonexistent/file.txt', deviceIds: [] })).error?.code).not.toBe('forbidden');
    // the Mac's own account service isn't on a cloud computer for anyone
    expect((await owner('cloudAccount.status', {})).error?.code).toBe('unsupported');
    expect((await full('cloudAccount.status', {})).error?.code).toBe('forbidden');
  });

  it('on a team’s computer: a member’s device signs in only its own agent profiles; removing the member drops it at once', async () => {
    const core = makeCore();
    await core.start();
    const info = await core.services.devices.startPairing(120, { role: 'full', member: { id: 'acc_bob', email: 'bob@acme.test' } });
    const phone = await TestPhone.direct(`ws://127.0.0.1:${core.gateway.port}/secure`, info.connectKey!);
    phones.push(phone);
    const paired = await phone.request('POST', '/api/pair', { code: info.code, device: { id: 'bob', name: 'Bob’s iPhone', platform: 'ios' } });
    const { token, deviceId } = paired.json as { token: string; deviceId: string };
    expect(core.ctx.store.devices.get().devices.find((d) => d.id === deviceId)).toMatchObject({ memberId: 'acc_bob', memberEmail: 'bob@acme.test' });
    expect(JSON.parse(await phone.openGateway(1, token, deviceId))).toMatchObject({ ok: true, role: 'full' });
    let n = 0;
    const call = async (method: string, params: unknown): Promise<{ ok: boolean; error?: { code: string } }> => {
      const id = `m-${++n}`;
      phone.sendText(1, JSON.stringify({ type: 'req', id, method, params }));
      return phone.nextRes(1, id) as Promise<{ ok: boolean; error?: { code: string } }>;
    };
    // the team's shared logins are the admins'; a profile of their own is the member's
    expect(await call('providers.deviceLogin.start', { id: 'claude-code' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await call('providers.clearKeys', { id: 'codex' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect((await call('providers.clearKeys', { id: 'claude-code@bob' })).error?.code).not.toBe('forbidden');
    // removed from the team: the device is revoked and its socket closed
    expect(core.services.devices.revokeMember('acc_bob')).toBe(1);
    expect(core.services.devices.list().some((d) => d.id === deviceId)).toBe(false);
    expect(core.ctx.auth.verify(token, 'cloud')).toEqual({ kind: 'revoked' });
    // a Mac never pairs a team member
    const mac = makeCore({ cloud: undefined, hostName: 'Mac' });
    await mac.start();
    await expect(mac.services.devices.startPairing(120, { member: { id: 'acc_x', email: 'x@y.test' } })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('answers system.info and system.notificationAccess on a headless computer', async () => {
    const core = makeCore();
    await core.start();
    const h = buildHandlers(core.ctx);
    const cx = { role: 'owner' as const, deviceId: 'dev_1' };
    const info = await h['system.info']({}, cx);
    expect(info.cloud).toMatchObject({ state: 'ok' });
    expect(info.hostName).toBe('AppuBot Cloud');
    expect(await h['system.notificationAccess']({}, cx)).toEqual({ access: 'unknown' });
  });
});
