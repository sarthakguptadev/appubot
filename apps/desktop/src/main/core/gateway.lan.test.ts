/**
 * A paired phone on the same network as the Mac, Tailscale or not: the QR carries the Mac's local address and its key,
 * pairing and the device token work over it through the end-to-end channel (SECURE_PATH) and never in the clear, the
 * device shows the local route, and turning allowLan off cuts it off. Runs only where this machine has a private
 * local-network address.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { GatewayClient } from '@appubot/client';
import { parsePairUrl } from '@appubot/protocol';
import { createCore, type Core } from './app';
import { TestPhone } from './testing/channelPhone';
import { FakeRuntime } from './testing/fakeRuntime';
import { lanAddresses } from './services/tailscale';
import { silentLogger } from './util';

const WS = WebSocket as unknown as typeof globalThis.WebSocket;
const lanIp = lanAddresses(networkInterfaces())[0];

describe.skipIf(!lanIp)('gateway over the local network', () => {
  let core: Core;
  let root: string;
  let lanBase = '';
  const clients: GatewayClient[] = [];

  const connect = (baseUrl: string, token: string) => new Promise<GatewayClient>((resolve, reject) => {
    const c = new GatewayClient({ baseUrl, token, device: { id: 'lan-phone', name: 'Phone', platform: 'ios' }, WebSocketImpl: WS, callTimeoutMs: 5000 });
    clients.push(c);
    const off = c.onState((s, err) => {
      if (s === 'connected') { off(); resolve(c); }
      if (s === 'unauthorized') { off(); reject(new Error(err)); }
    });
    c.connect();
  });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appubot-lan-'));
    core = createCore({
      paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
      runtime: (hooks) => new FakeRuntime(hooks),
      openExternal: () => undefined,
      openTerminal: () => undefined,
      nativeNotify: () => undefined,
      version: '0.0.0-test',
      hostName: 'test-mac',
      log: silentLogger,
      validate: true,
      port: 0,
      quiet: true,
      computerBackends: () => [],
      helperTransport: () => null,
    });
    await core.start();
    lanBase = `http://${lanIp}:${core.gateway.port}`;
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await core?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('pairs and connects over the Mac’s Wi-Fi address through the channel, with Tailscale out of the picture', async () => {
    const owner = await connect(`http://127.0.0.1:${core.gateway.port}`, core.ownerToken);
    const info = await owner.call('pairing.start', {});
    expect(info.hosts).toContainEqual({ host: lanIp, port: core.gateway.port, kind: 'lan' });
    expect(parsePairUrl(info.url)?.hosts).toContain(lanIp);
    expect(parsePairUrl(info.url)?.connectKey).toBe(info.connectKey);

    // in the clear only health answers: pairing, files and the gateway socket need the channel
    expect((await fetch(`${lanBase}/api/health`)).status).toBe(200);
    expect((await fetch(`${lanBase}/files/nope`)).status).toBe(403);
    const plain = await fetch(`${lanBase}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: info.code, device: { id: 'lan-phone', name: 'Phone', platform: 'ios' } }) });
    expect(plain.status).toBe(403);

    const phone = await TestPhone.direct(`ws://${lanIp}:${core.gateway.port}/secure`, info.connectKey!);
    const res = await phone.request('POST', '/api/pair', { code: info.code, device: { id: 'lan-phone', name: 'Phone', platform: 'ios' } });
    expect(res.status).toBe(200);
    const { token, deviceId } = res.json as { token: string; deviceId: string };

    // the token in the clear is refused before it is even read (the upgrade itself is refused): never connected
    const plainClient = new GatewayClient({ baseUrl: lanBase, token, device: { id: 'lan-phone', name: 'Phone', platform: 'ios' }, WebSocketImpl: WS });
    let plainConnected = false;
    plainClient.onState((st) => { if (st === 'connected') plainConnected = true; });
    plainClient.connect();
    await new Promise((r) => setTimeout(r, 800));
    plainClient.close();
    expect(plainConnected).toBe(false);
    expect(await phone.openGateway(3, token, deviceId)).toContain('"hello"');
    const dev = (await owner.call('devices.list')).find((d) => d.id === deviceId);
    expect(dev).toMatchObject({ online: true, route: 'lan', lastIp: lanIp });

    // the owner turns local-network access off: the phone is dropped and refused
    const g = core.services.settings.get().gateway;
    core.services.settings.update({ gateway: { ...g, allowLan: false } });
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (phone.closed) { clearInterval(t); resolve(); } }, 10); });
    expect((await fetch(`${lanBase}/api/health`)).status).toBe(403);
    core.services.settings.update({ gateway: { ...g, allowLan: true } });
  });
});
