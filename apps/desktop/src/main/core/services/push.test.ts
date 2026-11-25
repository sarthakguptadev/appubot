/**
 * Phone notifications through the relay: who gets a notice (registered, on, wanting that kind, not in front), what it
 * says with previews off, and the queue (signed requests, the nonce chain, dedupe, a newer word on a chat replacing a
 * waiting one, retries within ~2 minutes, dead tokens forgotten, a refusing relay left alone). The relay is a fake that
 * verifies each signature with WebCrypto over exactly the bytes the real one checks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { GatewayClient } from '@appubot/client';
import { PRESENCE_TTL_MS, PUSH_HEADER, fromBase64Url, pushSignedBytes, toBase64Url, type PushMessage, type PushResult } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import type { CoreDeps } from '../context';
import type { StoredDevice } from '../store';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { checkRole } from '../handlers';
import { publicDevice } from './devices';
import { RETRY_MS, pushTargets, pushText, type PushNotice } from './push';

const RELAY = 'http://relay.test';

/** The relay's push endpoint, as the real one answers; `answer` decides each POST that verified. */
class FakeRelay {
  gets = 0;
  posts: Array<{ ok: boolean; messages: PushMessage[]; nonce: string }> = [];
  issued = new Set<string>();
  used = new Set<string>();
  /** per POST: a status with a body, or results per message */
  answer: (messages: PushMessage[], n: number) => { status: number; body?: unknown; headers?: Record<string, string> } = (m) => ({ status: 200, body: { results: m.map(() => ({ status: 'sent' })) } });
  private n = 0;
  fresh(): string {
    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(38)));
    this.issued.add(nonce);
    return nonce;
  }
  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url !== `${RELAY}/push`) throw new Error(`unexpected ${url}`);
    if ((init?.method ?? 'GET') === 'GET') { this.gets += 1; return json(200, { nonce: this.fresh() }); }
    const h = new Headers(init?.headers);
    const body = new TextEncoder().encode(String(init?.body));
    const nonce = h.get(PUSH_HEADER.nonce) ?? '';
    const key = new Uint8Array(fromBase64Url(h.get(PUSH_HEADER.key) ?? '')!);
    const sig = new Uint8Array(fromBase64Url(h.get(PUSH_HEADER.sig) ?? '')!);
    const pub = await crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify']);
    const fresh = this.issued.has(nonce) && !this.used.has(nonce);
    const ok = fresh && await crypto.subtle.verify('Ed25519', pub, sig, new Uint8Array(pushSignedBytes(fromBase64Url(nonce)!, body)));
    const messages = (JSON.parse(String(init?.body)) as { messages: PushMessage[] }).messages;
    this.posts.push({ ok, messages, nonce });
    if (!ok) return json(401, { error: 'auth', nonce: this.fresh() });
    this.used.add(nonce);
    const a = this.answer(messages, this.n++);
    return json(a.status, { ...(a.body as object), nonce: this.fresh() }, a.headers);
  }) as typeof fetch;
  get sent(): PushMessage[] { return this.posts.filter((p) => p.ok).flatMap((p) => p.messages); }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const roots: string[] = [];
const cores: Core[] = [];
function makeCore(extra: Partial<CoreDeps> = {}): Core {
  const root = mkdtempSync(join(tmpdir(), 'appubot-push-'));
  roots.push(root);
  const core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-pc', log: silentLogger, validate: true, port: 0, host: '127.0.0.1', quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    connect: { relayUrl: RELAY.replace('http', 'ws') },
    ...extra,
  });
  // no tunnel in these tests: pushing needs only the identity
  core.services.settings.update({ connect: { ...core.services.settings.get().connect, enabled: false } });
  cores.push(core);
  return core;
}

function phone(core: Core, id: string, extra: Partial<StoredDevice> = {}): { token: string } {
  const { token, hash } = core.ctx.auth.newDeviceToken();
  const d: StoredDevice = {
    id, name: id, platform: 'ios', role: 'full', pairedAt: 1, online: false, tokenHash: hash,
    push: { token: `fcm-${id}`, platform: 'ios', previews: true, kinds: ['done', 'needs-you', 'failed'], at: 1 },
    ...extra,
  };
  core.ctx.store.devices.update((f) => ({ ...f, devices: [...f.devices, d] }));
  return { token };
}

const notice = (o: Partial<PushNotice> = {}): PushNotice => ({ nid: 'ntf_1', kind: 'done', botName: 'Appu', botId: 'bot_1', threadId: 'thr_1', title: 'Appu', text: 'All done: 3 invoices sent.', ...o });

afterEach(async () => {
  vi.useRealTimers();
  for (const c of cores.splice(0)) await c.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('who hears of a notice', () => {
  const dev = (id: string, extra: Partial<StoredDevice> = {}): StoredDevice => ({
    id, name: id, platform: 'android', role: 'full', pairedAt: 1, online: true, tokenHash: 'h',
    push: { token: `t-${id}`, platform: 'android', previews: true, kinds: ['done', 'needs-you', 'failed'], at: 1 }, ...extra,
  });
  const away = { mobileOn: true };

  it('every registered phone that is on and wants the kind; nobody while phone notifications are off', () => {
    const devices = [
      dev('a'),
      dev('b', { push: undefined }),
      dev('c', { pushOff: true }),
      dev('d', { push: { token: 't-d', platform: 'ios', previews: true, kinds: ['needs-you'], at: 1 } }),
      dev('e'),
    ];
    const t = pushTargets(notice(), devices, away);
    expect(t.map((x) => x.deviceId)).toEqual(['a', 'e']);
    expect(pushTargets(notice({ kind: 'needs-you' }), devices, away).map((x) => x.deviceId)).toEqual(['a', 'd', 'e']);
    expect(pushTargets(notice(), devices, { mobileOn: false })).toEqual([]);
  });

  it('names the pairing and the chat, one banner per chat', () => {
    const [t] = pushTargets(notice(), [dev('a')], away);
    expect(t!.message).toEqual({
      token: 't-a', platform: 'android', title: 'Appu', body: 'All done: 3 invoices sent.', collapse: 'thr_1',
      data: { nid: 'ntf_1', kind: 'done', deviceId: 'a', threadId: 'thr_1', botId: 'bot_1' },
    });
  });

  it('with previews off says only who and what', () => {
    expect(pushText(notice(), false)).toEqual({ body: 'Appu finished' });
    expect(pushText(notice({ kind: 'needs-you', text: 'Approval needed: rm -rf build' }), false)).toEqual({ body: 'Appu needs you' });
    expect(pushText(notice({ kind: 'failed', text: 'Error: the agent crashed' }), false)).toEqual({ body: 'Appu couldn’t finish' });
    const [t] = pushTargets(notice(), [dev('a', { push: { token: 't', platform: 'ios', previews: false, kinds: ['done'], at: 1 } })], away);
    expect(t!.message.title).toBeUndefined();
    expect(JSON.stringify(t!.message)).not.toContain('invoices');
  });

  it('cuts long text to one short line', () => {
    const t = pushText(notice({ text: `line one\n\n${'x'.repeat(500)}` }), true);
    expect(t.body.length).toBeLessThanOrEqual(240);
    expect(t.body.startsWith('line one x')).toBe(true);
    expect(t.body.endsWith('…')).toBe(true);
  });
});

describe('the device record', () => {
  it('never carries the push token on the wire, only whether pushes reach it', () => {
    const d: StoredDevice = { id: 'a', name: 'a', platform: 'ios', role: 'full', pairedAt: 1, online: false, tokenHash: 'h', push: { token: 'secret', platform: 'ios', previews: true, kinds: ['done'], at: 1 } };
    const pub = publicDevice(d, true);
    expect(JSON.stringify(pub)).not.toContain('secret');
    expect(pub).not.toHaveProperty('tokenHash');
    expect(pub.pushOn).toBe(true);
    expect(publicDevice({ ...d, pushOff: true }, true)).toMatchObject({ pushOn: false, pushOff: true });
    expect(publicDevice({ ...d, push: undefined }, true).pushOn).toBeUndefined();
  });

  it('a phone registers itself, the computer switches it off, the phone turns it back on, revoking forgets it', () => {
    const core = makeCore();
    phone(core, 'p1', { push: undefined });
    const devices = core.services.devices;
    const reg = { token: 'fcm-1', platform: 'ios' as const, previews: false, kinds: ['done' as const] };
    expect(devices.setPush('p1', reg)).toEqual({ pushOn: true });
    expect(core.ctx.store.devices.get().devices[0]!.push).toMatchObject(reg);
    expect(devices.setNotifications('p1', false)).toMatchObject({ pushOn: false, pushOff: true });
    // a new token from the phone keeps the computer's switch off; only turning it on on the phone undoes it
    expect(devices.setPush('p1', { ...reg, token: 'fcm-2' })).toEqual({ pushOn: false });
    expect(devices.setPush('p1', reg, true)).toEqual({ pushOn: true });
    expect(devices.setPush('p1', null)).toEqual({ pushOn: false });
    expect(core.ctx.store.devices.get().devices[0]!.push).toBeUndefined();
    devices.setPush('p1', reg);
    devices.revoke('p1');
    expect(JSON.stringify(core.ctx.store.devices.get())).not.toContain('fcm-1');
  });

  it('a dead token is forgotten only while it is still the phone’s', () => {
    const core = makeCore();
    phone(core, 'p1');
    core.services.devices.dropPush('p1', 'another');
    expect(core.ctx.store.devices.get().devices[0]!.push).toBeDefined();
    core.services.devices.dropPush('p1', 'fcm-p1');
    expect(core.ctx.store.devices.get().devices[0]!.push).toBeUndefined();
  });

  it('a paired phone may register and say it is in front, limited or not; the window may not register', () => {
    expect(() => checkRole('devices.setPush', {}, { role: 'limited', deviceId: 'p' })).not.toThrow();
    expect(() => checkRole('devices.presence', {}, { role: 'limited', deviceId: 'p' })).not.toThrow();
    expect(() => checkRole('devices.setNotifications', {}, { role: 'limited', deviceId: 'p' })).toThrow();
    expect(() => checkRole('devices.setNotifications', {}, { role: 'full', deviceId: 'p' })).not.toThrow();
  });
});

describe('the queue', () => {
  let relay: FakeRelay;
  beforeEach(() => { relay = new FakeRelay(); });
  // the fake relay checks signatures with WebCrypto, which settles on real time, however long that takes on this
  // machine: a request that is out is waited for itself (never for a number of turns), then whatever it left due now
  // goes out the same way
  let current: Core;
  const settle = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
    while (current.services.push.busy) {
      await current.services.push.idle();
      await vi.advanceTimersByTimeAsync(0);
    }
  };
  // through the relay as it is at the time of each call (a test may swap its fetch)
  const viaRelay = (): Partial<CoreDeps> => ({ fetch: ((i: string | URL | Request, n?: RequestInit) => relay.fetch(i, n)) as typeof fetch });

  it('signs each request with the room key and chains nonces: one GET, then one POST per batch', async () => {
    vi.useFakeTimers();
    const core = (current = makeCore(viaRelay()));
    phone(core, 'p1');
    phone(core, 'p2', { push: { token: 'fcm-p2', platform: 'android', previews: false, kinds: ['done'], at: 1 } });
    core.services.push.notice(notice());
    await settle();
    expect(relay.gets).toBe(1);
    expect(relay.posts).toHaveLength(1);
    expect(relay.posts[0]!.ok).toBe(true);
    expect(relay.sent.map((m) => [m.token, m.body])).toEqual([['fcm-p1', 'All done: 3 invoices sent.'], ['fcm-p2', 'Appu finished']]);
    core.services.push.notice(notice({ nid: 'ntf_2', threadId: 'thr_2' }));
    await settle();
    expect(relay.gets).toBe(1);
    expect(relay.posts.every((p) => p.ok)).toBe(true);
    expect(core.services.push.stats.sent).toBe(4);
  });

  it('goes through the desktop notice of a finished turn, a question and an approval, never a quiet one', async () => {
    vi.useFakeTimers();
    const core = (current = makeCore(viaRelay()));
    phone(core, 'p1');
    core.services.notifications.notify({ title: 'Appu', body: 'Done', threadId: 'thr_1', push: { kind: 'done', botId: 'b', botName: 'Appu', text: 'Done' } });
    core.services.notifications.notify({ title: 'Device paired', body: 'x' });
    await settle();
    expect(relay.sent).toHaveLength(1);
    expect(relay.sent[0]!.data).toMatchObject({ kind: 'done', threadId: 'thr_1', botId: 'b', deviceId: 'p1' });
  });

  it.each([
    ['the window is in front', { isAppFocused: (): boolean => true }],
    ['the keyboard or mouse was used 30 s ago', { systemIdleMs: (): number => 30_000 }],
    ['input 30 s ago but the screen is locked', { systemIdleMs: (): number => 30_000, screenLocked: (): boolean => true }],
    ['nothing used for 5 minutes', { systemIdleMs: (): number => 5 * 60_000 }],
    ['nothing can be read', {}],
  ] as const)('pushes whatever the user is doing at this computer: %s', async (_, deps) => {
    vi.useFakeTimers();
    const core = (current = makeCore({ ...viaRelay(), ...deps }));
    phone(core, 'p1');
    core.services.notifications.notify({ title: 'Appu', body: 'Done', threadId: 'thr_1', push: { kind: 'done', botId: 'b', botName: 'Appu', text: 'Done' } });
    await settle();
    expect(relay.sent).toHaveLength(1);
  });

  it('sends a notice to a phone once, and a newer word on a chat replaces one still waiting', async () => {
    vi.useFakeTimers();
    const core = (current = makeCore(viaRelay()));
    phone(core, 'p1');
    core.services.push.notice(notice({ nid: 'n1', text: 'first' }));
    core.services.push.notice(notice({ nid: 'n1', text: 'first' }));
    core.services.push.notice(notice({ nid: 'n2', kind: 'needs-you', text: 'Approval needed: send it?' }));
    core.services.push.notice(notice({ nid: 'n3', threadId: 'thr_other', text: 'other chat' }));
    await settle();
    expect(relay.sent.map((m) => m.body)).toEqual(['Approval needed: send it?', 'other chat']);
  });

  it('drops what is still waiting for a phone switched off or revoked meanwhile', async () => {
    vi.useFakeTimers();
    const core = (current = makeCore(viaRelay()));
    phone(core, 'p1');
    phone(core, 'p2');
    relay.answer = () => ({ status: 503, body: {} });
    core.services.push.notice(notice());
    await settle();
    relay.answer = (m) => ({ status: 200, body: { results: m.map(() => ({ status: 'sent' })) } });
    core.services.devices.setNotifications('p1', false);
    core.services.devices.revoke('p2');
    await settle(RETRY_MS[0]!);
    expect(relay.posts).toHaveLength(1);
    expect(core.services.push.pending).toBe(0);
  });

  it('pushes to a phone in front and to one whose person is at a Mac showing this computer (the phone sorts it out)', async () => {
    vi.useFakeTimers();
    const core = (current = makeCore(viaRelay()));
    phone(core, 'p1');
    core.ctx.gateway.inFront = () => true;
    core.ctx.gateway.atDesk = () => true;
    core.services.push.notice(notice({ nid: 'n1' }));
    await settle();
    expect(relay.sent).toHaveLength(1);
  });

  it('retries a relay that is down a few times within ~2 minutes, then gives up', async () => {
    vi.useFakeTimers();
    const core = (current = makeCore(viaRelay()));
    phone(core, 'p1');
    relay.answer = (m, n) => (n < 2 ? { status: 502, body: {} } : { status: 200, body: { results: m.map(() => ({ status: 'sent' })) } });
    core.services.push.notice(notice());
    await settle();
    expect(relay.sent).toHaveLength(1); // the first POST, refused with 502
    await settle(RETRY_MS[0]!);
    await settle(RETRY_MS[1]!);
    expect(core.services.push.stats.sent).toBe(1);

    relay.answer = () => ({ status: 503, body: {} });
    core.services.push.notice(notice({ nid: 'n9', threadId: 'thr_9' }));
    for (let t = 0; t < 3 * 60_000; t += 1000) await settle(1000);
    expect(core.services.push.stats.givenUp).toBe(1);
    expect(core.services.push.pending).toBe(0);
  });

  it('honours a per-message retry and the relay’s Retry-After', async () => {
    vi.useFakeTimers();
    const core = (current = makeCore(viaRelay()));
    phone(core, 'p1');
    relay.answer = (m, n) => (n === 0
      ? { status: 200, body: { results: m.map((): PushResult => ({ status: 'retry', retryAfter: 30 })) } }
      : { status: 200, body: { results: m.map(() => ({ status: 'sent' })) } });
    core.services.push.notice(notice());
    await settle();
    await settle(29_000);
    expect(core.services.push.stats.sent).toBe(0);
    await settle(2_000);
    expect(core.services.push.stats.sent).toBe(1);
  });

  it('forgets a token the relay says is dead', async () => {
    vi.useFakeTimers();
    const core = (current = makeCore(viaRelay()));
    phone(core, 'p1');
    phone(core, 'p2');
    relay.answer = (m) => ({ status: 200, body: { results: m.map((x): PushResult => ({ status: x.token === 'fcm-p1' ? 'drop' : 'sent' })) } });
    core.services.push.notice(notice());
    await settle();
    const [p1, p2] = core.ctx.store.devices.get().devices;
    expect(p1!.push).toBeUndefined();
    expect(p2!.push).toBeDefined();
    expect(core.services.devices.list().find((d) => d.id === 'p1')!.pushOn).toBeUndefined();
  });

  it('asks again at once with the fresh nonce a 401 brings', async () => {
    vi.useFakeTimers();
    const core = (current = makeCore(viaRelay()));
    phone(core, 'p1');
    core.services.push.notice(notice({ nid: 'n1' }));
    await settle();
    // the relay restarted: the nonce the computer holds means nothing to it now
    relay.issued.clear();
    core.services.push.notice(notice({ nid: 'n2', threadId: 'thr_2' }));
    await settle();
    expect(relay.posts.map((p) => p.ok)).toEqual([true, false, true]);
    expect(core.services.push.stats.sent).toBe(2);
  });

  it('leaves a relay alone for as long as it says when it refuses this computer', async () => {
    vi.useFakeTimers();
    const core = (current = makeCore(viaRelay()));
    phone(core, 'p1');
    relay.answer = () => ({ status: 403, body: { error: 'blocked' } });
    core.services.push.notice(notice({ nid: 'n1' }));
    await settle();
    expect(relay.posts).toHaveLength(1);
    relay.answer = (m) => ({ status: 200, body: { results: m.map(() => ({ status: 'sent' })) } });
    core.services.push.notice(notice({ nid: 'n2', threadId: 'thr_2' }));
    await settle(10 * 60_000);
    expect(relay.posts).toHaveLength(1);
    await settle(60 * 60_000);
    core.services.push.notice(notice({ nid: 'n3', threadId: 'thr_3' }));
    await settle();
    expect(relay.sent.at(-1)!.data.nid).toBe('n3');
  });

  it('stops for an hour when pushes are switched off on the relay', async () => {
    vi.useFakeTimers();
    const core = (current = makeCore(viaRelay()));
    phone(core, 'p1');
    relay.fetch = (async () => json(503, { error: 'push_disabled', retryAfter: 3600 })) as typeof fetch;
    core.services.push.notice(notice({ nid: 'n1' }));
    await settle();
    expect(core.services.push.stats.failed).toBe(1);
    expect(core.services.push.pending).toBe(0);
  });
});

describe('a phone in front', () => {
  it('counts while it says so on a live connection, and not once it says it left or goes quiet', async () => {
    const core = makeCore();
    await core.start();
    const { token } = phone(core, 'p1');
    const c = new GatewayClient({ baseUrl: `http://127.0.0.1:${core.gateway.port}`, token, device: { id: 'p1', name: 'p1', platform: 'ios' }, WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket, callTimeoutMs: 5000 });
    await new Promise<void>((resolve, reject) => {
      const off = c.onState((s, err) => { if (s === 'connected') { off(); resolve(); } if (s === 'unauthorized') { off(); reject(new Error(err)); } });
      c.connect();
    });
    expect(core.gateway.inFront('p1')).toBe(false);
    await c.call('devices.presence', { foreground: true });
    expect(core.gateway.inFront('p1')).toBe(true);
    expect(core.gateway.inFront('p1', Date.now() + PRESENCE_TTL_MS + 1)).toBe(false);
    await c.call('devices.presence', { foreground: false });
    expect(core.gateway.inFront('p1')).toBe(false);
    await c.call('devices.presence', { foreground: true });
    const r = await c.call('devices.setPush', { push: { token: 'fcm-new', platform: 'ios', previews: true, kinds: ['done'] } });
    expect(r).toEqual({ pushOn: true });
    c.close();
    await new Promise((r2) => setTimeout(r2, 100));
    expect(core.gateway.inFront('p1')).toBe(false);
  });

  it('a desktop app says its person is at that Mac: counts while fresh, and not for a phone saying it is in front', async () => {
    const core = makeCore();
    await core.start();
    const { token } = phone(core, 'm1');
    const c = new GatewayClient({ baseUrl: `http://127.0.0.1:${core.gateway.port}`, token, device: { id: 'm1', name: 'Mac', platform: 'desktop' }, WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket, callTimeoutMs: 5000 });
    await new Promise<void>((resolve, reject) => {
      const off = c.onState((s, err) => { if (s === 'connected') { off(); resolve(); } if (s === 'unauthorized') { off(); reject(new Error(err)); } });
      c.connect();
    });
    await c.call('devices.presence', { foreground: true });
    expect(core.gateway.atDesk(undefined)).toBe(false);
    await c.call('devices.presence', { foreground: true, desk: true });
    expect(core.gateway.atDesk(undefined)).toBe(true);
    expect(core.gateway.atDesk('someone-else')).toBe(false);
    expect(core.gateway.atDesk(undefined, Date.now() + PRESENCE_TTL_MS + 1)).toBe(false);
    await c.call('devices.presence', { foreground: false, desk: true });
    expect(core.gateway.atDesk(undefined)).toBe(false);
    await c.call('devices.presence', { foreground: true, desk: true });
    c.close();
    await new Promise((r2) => setTimeout(r2, 100));
    expect(core.gateway.atDesk(undefined)).toBe(false);
  });
});
