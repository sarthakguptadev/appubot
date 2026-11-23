/**
 * The end-to-end channel on the same Wi-Fi (the gateway's SECURE_PATH): a phone on the local network pairs and
 * connects only through it, with AppuBot Connect off; nothing that carries a token, the pairing code or a file answers
 * it in the clear; the QR always carries the key; a recorded stream replayed opens nothing; the gateway judges the
 * phone by the address its channel socket really comes from. The local network is played on loopback: the gateway is
 * told the plain peer's address is 192.168.1.30 (the channel's own replays still go through the real check).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, type RawData } from 'ws';
import { CHANNEL_VERSION, CONNECT_PEER_HEADER, SECURE_PEER_HEADER, createEphemeralKeypair, helloFrame, parsePairUrl, toBase64Url } from '@appubot/protocol';
import { createCore, type Core } from './app';
import type { CoreDeps } from './context';
import { TestPhone, toU8 } from './testing/channelPhone';
import { FakeRuntime } from './testing/fakeRuntime';
import { silentLogger } from './util';

const cores: Core[] = [];
const roots: string[] = [];
const phones: TestPhone[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of phones.splice(0)) p.close();
  for (const c of cores.splice(0)) await c.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeCore(extra: Partial<CoreDeps> = {}): Core {
  const root = mkdtempSync(join(tmpdir(), 'appubot-secure-'));
  roots.push(root);
  const core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    ...extra,
  });
  cores.push(core);
  return core;
}

const until = async (test: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

/** Plain peers (no channel header) look like `ip` on the Wi-Fi; the channel's own replays are checked as they are. */
function onWifi(core: Core, ip = '192.168.1.30'): void {
  const real = core.gateway.checkPeer.bind(core.gateway);
  vi.spyOn(core.gateway, 'checkPeer').mockImplementation((rawIp, headers = {}) =>
    real(headers[SECURE_PEER_HEADER] || headers[CONNECT_PEER_HEADER] ? rawIp : ip, headers));
}

async function directPhone(core: Core, key: string): Promise<TestPhone> {
  const p = await TestPhone.direct(`ws://127.0.0.1:${core.gateway.port}/secure`, key);
  phones.push(p);
  return p;
}

/** A plain WebSocket upgrade: the status it was refused with, or 101. */
function plainUpgrade(url: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
    ws.on('open', () => { resolve(101); ws.close(); });
    ws.on('error', () => undefined);
  });
}

/** A recorded stream sent again on a new channel socket: what came back, and whether the Mac closed it. */
async function replayDirect(url: string, messages: Uint8Array[]): Promise<{ got: Uint8Array[]; closed: boolean }> {
  const ws = new WebSocket(url);
  const got: Uint8Array[] = [];
  let closed = false;
  ws.on('open', () => { for (const m of messages) ws.send(m); });
  ws.on('message', (data: RawData, isBinary: boolean) => { if (isBinary) got.push(toU8(data)); });
  ws.on('close', () => { closed = true; });
  ws.on('error', () => undefined);
  await until(() => closed, 3000).catch(() => undefined);
  if (!closed) ws.close();
  return { got, closed };
}

const uploadForm = async (bytes: Uint8Array<ArrayBuffer>) => {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), 'note.bin');
  const req = new Request('http://x/api/files', { method: 'POST', body: form });
  return { body: new Uint8Array(await req.arrayBuffer()), type: req.headers.get('content-type')! };
};

describe('the channel on the same Wi-Fi', () => {
  it('with AppuBot Connect off the QR still carries the key, and a phone on the Wi-Fi pairs and connects only through the channel', async () => {
    const core = makeCore();
    await core.start();
    const info = await core.services.devices.startPairing(120);
    // Connect is off (tests never reach a relay unless one is given): the key, no room
    expect(core.services.connect.info().state).toBe('off');
    expect(info.connectId).toBeUndefined();
    expect(info.connectKey).toBe(core.services.connect.key());
    expect(info.url).toContain(`k=${info.connectKey}`);
    expect(info.url).not.toContain('r=');
    expect(parsePairUrl(info.url)?.connectKey).toBe(info.connectKey);
    // the key rides SystemInfo with Connect off too (a phone paired over Tailscale learns it there)
    expect(core.services.system.info().connect).toMatchObject({ state: 'off', connectKey: info.connectKey });
    expect(core.services.system.info().connect?.connectId).toBeUndefined();

    onWifi(core);
    const base = `http://127.0.0.1:${core.gateway.port}`;
    // in the clear: health (and nothing secret in it), nothing else
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect(Object.keys(await health.json() as object).sort()).toEqual(['hostName', 'ok', 'version']);
    const plainPair = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: info.code, device: { id: 'p', name: 'Phone', platform: 'ios' } }) });
    expect(plainPair.status).toBe(403);
    expect(await plainPair.json()).toMatchObject({ code: 'secure_required' });
    expect((await fetch(`${base}/files/nope?token=x`)).status).toBe(403);
    expect((await fetch(`${base}/pages/nope?v=x`)).status).toBe(403);
    expect((await fetch(`${base}/api/files`, { method: 'POST', body: 'x' })).status).toBe(403);
    expect(await plainUpgrade(`ws://127.0.0.1:${core.gateway.port}/ws`)).toBe(403);
    expect(core.services.devices.list()).toHaveLength(0);

    // through the channel: the same code (never used up by the refusal above) pairs
    const phone = await directPhone(core, info.connectKey!);
    expect((await phone.request('GET', '/api/health')).status).toBe(200);
    // forged channel headers from the phone are dropped: it is judged by its own socket's address
    const paired = await phone.request('POST', '/api/pair', { code: info.code, device: { id: 'p-iphone', name: 'iPhone', platform: 'ios' } }, { [CONNECT_PEER_HEADER]: '203.0.113.1', [SECURE_PEER_HEADER]: '127.0.0.1' });
    expect(paired.status).toBe(200);
    const { token, deviceId } = paired.json as { token: string; deviceId: string };
    expect(core.services.devices.list()[0]).toMatchObject({ id: deviceId, route: 'lan', lastIp: '192.168.1.30' });

    // the gateway socket: hello inside the channel, the device online on the Wi-Fi route
    expect(await phone.openGateway(5, token, deviceId)).toContain('"hello"');
    await until(() => core.services.devices.list()[0]?.online === true);
    expect(core.services.devices.list()[0]).toMatchObject({ route: 'lan', lastIp: '192.168.1.30' });

    // the paired token in the clear is still refused, however it is sent
    expect(await plainUpgrade(`ws://127.0.0.1:${core.gateway.port}/ws?token=${encodeURIComponent(token)}`)).toBe(403);
    expect((await fetch(`${base}/files/nope`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);

    // an upload and its download through the channel
    const data = new Uint8Array(300_000).map((_, i) => (i * 7) & 0xff);
    const form = await uploadForm(data);
    const up = await phone.requestRaw('POST', '/api/files', form.body, { 'content-type': form.type, authorization: `Bearer ${token}` });
    expect(up.status).toBe(200);
    const file = JSON.parse(up.body.toString('utf8')) as { url: string };
    const down = await phone.requestRaw('GET', `${file.url}?token=${encodeURIComponent(token)}`, undefined);
    expect(Buffer.compare(down.body, Buffer.from(data))).toBe(0);
    expect(core.services.connect.held).toBe(0);

    // the owner turns the Wi-Fi off for phones: the channel socket is dropped and a new one refused
    const g = core.services.settings.get().gateway;
    core.services.settings.update({ gateway: { ...g, allowLan: false } });
    await until(() => phone.closed);
    await expect(TestPhone.direct(`ws://127.0.0.1:${core.gateway.port}/secure`, info.connectKey!)).rejects.toThrow();
    await until(() => core.services.devices.list()[0]?.online === false);
  });

  it('a recorded stream replayed on a new socket opens nothing and runs nothing', async () => {
    const core = makeCore();
    await core.start();
    const info = await core.services.devices.startPairing(120);
    onWifi(core);
    const phone = await directPhone(core, info.connectKey!);
    const { token } = (await phone.request('POST', '/api/pair', { code: info.code, device: { id: 'x', name: 'iPhone', platform: 'ios' } })).json as { token: string };
    // someone on the Wi-Fi records the whole stream: the hello and an upload with the device token in it
    const form = await uploadForm(new Uint8Array([1, 2, 3]));
    expect((await phone.requestRaw('POST', '/api/files', form.body, { 'content-type': form.type, authorization: `Bearer ${token}` })).status).toBe(200);
    const recorded = phone.sent.slice();
    expect(core.services.files.list()).toHaveLength(1);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { got, closed } = await replayDirect(`ws://127.0.0.1:${core.gateway.port}/secure`, recorded);
    // a fresh key of the Mac's own answered the replayed hello, so nothing recorded opened: dropped at the first one
    expect(got).toHaveLength(1);
    expect(got[0]![0]).toBe(CHANNEL_VERSION);
    expect(Buffer.from(got[0]!.subarray(1, 33))).not.toEqual(Buffer.from(phone.reply!.subarray(1, 33)));
    expect(closed).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(core.services.files.list()).toHaveLength(1);
    // the real phone goes on
    expect((await phone.request('GET', '/api/health')).status).toBe(200);
  });

  it('someone who answers with another key never gets past READY, and junk ends only its own socket', async () => {
    const core = makeCore();
    await core.start();
    const info = await core.services.devices.startPairing(120);
    const wrong = toBase64Url(createEphemeralKeypair().public);
    await expect(TestPhone.direct(`ws://127.0.0.1:${core.gateway.port}/secure`, wrong)).rejects.toThrow();
    // text, or bytes that aren't a hello: that socket is closed
    expect((await replayDirect(`ws://127.0.0.1:${core.gateway.port}/secure`, [new Uint8Array([CHANNEL_VERSION, 1, 2])])).closed).toBe(true);
    // a phone on the last version (2, ChaCha20-Poly1305) is told this one, so it can ask for an update
    const v2 = helloFrame(createEphemeralKeypair().public);
    v2[0] = 2;
    expect(await replayDirect(`ws://127.0.0.1:${core.gateway.port}/secure`, [v2])).toEqual({ got: [Uint8Array.of(CHANNEL_VERSION)], closed: true });
    const ws = new WebSocket(`ws://127.0.0.1:${core.gateway.port}/secure`);
    let textClosed = false;
    ws.on('open', () => ws.send('hello?'));
    ws.on('close', () => { textClosed = true; });
    ws.on('error', () => undefined);
    await until(() => textClosed);
    expect(core.services.connect.direct.size).toBe(0);
    const phone = await directPhone(core, info.connectKey!);
    expect((await phone.request('GET', '/api/health')).status).toBe(200);
  });

  it('the channel headers count only from this computer itself, and only demote', async () => {
    const core = makeCore();
    await core.start();
    // a peer on the Wi-Fi claiming to be a replay: plain local network, nothing more
    expect(await core.gateway.checkPeer('192.168.1.30', { [SECURE_PEER_HEADER]: '127.0.0.1' })).toEqual({ ok: true, route: 'lan', ip: '192.168.1.30' });
    // a replay for a phone on the Wi-Fi is judged by the phone's address
    expect(await core.gateway.checkPeer('127.0.0.1', { [SECURE_PEER_HEADER]: '192.168.1.30' })).toEqual({ ok: true, route: 'lan', ip: '192.168.1.30', secure: true });
    expect((await core.gateway.checkPeer('127.0.0.1', { [SECURE_PEER_HEADER]: '203.0.113.9' })).ok).toBe(false);
    const g = core.services.settings.get().gateway;
    core.services.settings.update({ gateway: { ...g, allowLan: false } });
    expect((await core.gateway.checkPeer('127.0.0.1', { [SECURE_PEER_HEADER]: '192.168.1.30' })).ok).toBe(false);
    // this computer's own window keeps its plain access
    expect(await core.gateway.checkPeer('127.0.0.1', {})).toEqual({ ok: true, route: 'local', ip: '127.0.0.1' });
  });

  it('waking up, unlocking or a network change nudges AppuBot Connect', async () => {
    let wake: ((why: string) => void) | null = null;
    const core = makeCore({ onWake: (fn) => { wake = fn; return () => { wake = null; }; } });
    const nudge = vi.spyOn(core.services.connect, 'nudge');
    await core.start();
    expect(wake).toBeTypeOf('function');
    wake!('woke from sleep');
    expect(nudge).toHaveBeenCalledWith('woke from sleep');

    // the computer's addresses change: phones are told, and the relay socket is checked
    const ts = core.services.tailscale;
    vi.spyOn(ts, 'status').mockResolvedValue(ts.cached());
    let hosts = [{ host: '192.168.1.5', kind: 'lan' as const }];
    vi.spyOn(ts, 'hostsNow').mockImplementation(() => hosts);
    core.services.system.watchNetwork();
    hosts = [{ host: '192.168.1.77', kind: 'lan' as const }];
    const g = core.services.settings.get().gateway;
    core.services.settings.update({ gateway: { ...g, requireTailscalePeer: !g.requireTailscalePeer } });
    await until(() => nudge.mock.calls.some(([why]) => why === 'network changed'));
    core.services.system.stopWatching();

    await core.stop();
    cores.splice(cores.indexOf(core), 1);
    expect(wake).toBeNull();
  });
});
