/**
 * Starting a Telegram bot when Telegram can't be reached for a moment (seen on an AppuBot Cloud computer: the first
 * `getMe` after a token was saved failed with "Network request for 'getMe' failed!" while a curl from the same
 * computer answered 200, and the bot stayed in that error until the user re-saved the token): the cause is said
 * (never the token), a cut connection is tried again at once, a passing failure gets a start of AppuBot's own later,
 * and a wake (a restore from sleep) starts a bot that failed and drops the kept connections.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammyError, HttpError } from 'grammy';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { isTransientTelegramError, telegramErrorText } from './channels';

const TOKEN = '123456789:AAHq8f9VQ1x7Yz2kLmNoPqRsTuVwXyZ01234';
const roots: string[] = [];
const cores: Core[] = [];
/** every Telegram API call made: method and params */
const tg: { method: string; params: Record<string, unknown> }[] = [];
/** what the next getMe calls do: each entry one call, then Telegram answers properly */
let getMeFailures: (() => never)[] = [];
const calls = (method: string) => tg.filter((c) => c.method === method);
const until = async (ok: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)); }
};

/** node-fetch's error for a connection cut as the request went out (its message carries the URL, token and all) */
const connectionCut = (method: string) => (): never => {
  const e = new Error(`request to https://api.telegram.org/bot${TOKEN}/${method} failed, reason: socket hang up`) as Error & { code: string; type: string };
  e.code = 'ECONNRESET';
  e.type = 'system';
  throw e;
};
const badGateway = (): never => { throw Object.assign(new Error('Bad Gateway'), { badGateway: true }); };

/** Telegram's API, faked, as the core's `deps.fetch`. */
const telegramFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const m = /api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(url);
  if (!m) throw new Error(`unexpected fetch ${url}`);
  const method = m[1]!;
  let params: Record<string, unknown> = {};
  try { params = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}; } catch { /* multipart */ }
  tg.push({ method, params });
  if (method === 'getMe' && getMeFailures.length > 0) {
    const fail = getMeFailures.shift()!;
    try { fail(); } catch (e) {
      // Telegram's own 502 is an answer (a GrammyError), the rest fails the fetch itself (an HttpError)
      if ((e as { badGateway?: boolean }).badGateway) return new Response(JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }), { status: 502, headers: { 'content-type': 'application/json' } });
      throw e;
    }
  }
  if (method === 'getUpdates') await new Promise((r) => setTimeout(r, 50));
  const result = method === 'getMe' ? { id: 7, is_bot: true, first_name: 'Ledger', username: 'ledger_bot' }
    : method === 'getWebhookInfo' ? { url: '', has_custom_certificate: false, pending_update_count: 0 }
      : method === 'getUpdates' ? []
        : true;
  return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

afterAll(async () => {
  for (const c of cores) await c.stop();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function makeCore(): Promise<Core> {
  const root = mkdtempSync(join(tmpdir(), 'appubot-tg-start-'));
  roots.push(root);
  const core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    fetch: telegramFetch,
  });
  cores.push(core);
  await core.start();
  return core;
}

describe('what a failed Telegram call says', () => {
  it('names the cause of a network failure, never the token', () => {
    let cause: unknown;
    try { connectionCut('getMe')(); } catch (e) { cause = e; }
    const text = telegramErrorText(new HttpError("Network request for 'getMe' failed!", cause));
    expect(text).toBe("Network request for 'getMe' failed! (ECONNRESET: socket hang up)");
    expect(text).not.toContain(TOKEN);
    expect(isTransientTelegramError(new HttpError('x', cause))).toBe(true);
  });

  it('reads undici\'s cause, and a non-JSON answer', () => {
    const undici = new TypeError('fetch failed');
    (undici as Error & { cause: unknown }).cause = Object.assign(new Error('getaddrinfo EAI_AGAIN api.telegram.org'), { code: 'EAI_AGAIN' });
    expect(telegramErrorText(new HttpError("Network request for 'getMe' failed!", undici))).toBe("Network request for 'getMe' failed! (getaddrinfo EAI_AGAIN api.telegram.org)");
    expect(telegramErrorText(new HttpError("Network request for 'getMe' failed!", new SyntaxError('Unexpected token < in JSON at position 0'))))
      .toBe("Network request for 'getMe' failed! (Telegram answered something that isn’t JSON, likely an error page)");
  });

  it('scrubs a token wherever it appears, and tells a passing failure from a final one', () => {
    expect(telegramErrorText(new Error(`request to https://api.telegram.org/bot${TOKEN}/getMe failed`))).toBe('request to https://api.telegram.org/bot…/getMe failed');
    expect(telegramErrorText(new Error(`token ${TOKEN} refused`))).toBe('token <token> refused');
    const grammy = (code: number) => new GrammyError('Call failed', { ok: false, error_code: code, description: 'x' }, 'getMe', {});
    expect(isTransientTelegramError(grammy(502))).toBe(true);
    expect(isTransientTelegramError(grammy(429))).toBe(true);
    expect(isTransientTelegramError(grammy(401))).toBe(false);
    expect(isTransientTelegramError(new Error('Telegram did not respond (timeout)'))).toBe(true);
    expect(isTransientTelegramError(new Error('something else'))).toBe(false);
  });
});

describe('starting a Telegram bot while Telegram is out of reach for a moment', () => {
  it('tries getMe again at once when the connection was cut, and the bot starts', async () => {
    const core = await makeCore();
    core.services.channels.retryDelays = [];
    const ch = core.services.channels.add({});
    getMeFailures = [connectionCut('getMe')];
    const before = calls('getMe').length;
    const c = await core.services.channels.configure({ id: ch.id, token: TOKEN, enabled: true });
    expect(c.status).toBe('running');
    expect(c.botUsername).toBe('ledger_bot');
    expect(calls('getMe').length - before).toBe(2);
    await core.services.channels.configure({ id: ch.id, enabled: false });
  }, 15_000);

  it('says why a start failed and starts by itself when the failure passes', async () => {
    const core = await makeCore();
    core.services.channels.retryDelays = [40];
    const ch = core.services.channels.add({});
    getMeFailures = [badGateway, badGateway];
    const c = await core.services.channels.configure({ id: ch.id, token: TOKEN, enabled: true });
    expect(c.status).toBe('error');
    expect(c.error).toBe("Call to 'getMe' failed! (502: Bad Gateway) AppuBot will try again.");
    // the first try of AppuBot's own meets the second 502, the next one gets through
    await until(() => core.services.channels.stored(ch.id)?.status === 'running');
    expect(getMeFailures).toEqual([]);
    await core.services.channels.configure({ id: ch.id, enabled: false });
    // switched off: no more tries
    getMeFailures = [];
    const n = calls('getMe').length;
    await new Promise((r) => setTimeout(r, 120));
    expect(calls('getMe').length).toBe(n);
  }, 15_000);

  it('a wake starts a bot that failed, and leaves one that runs alone', async () => {
    const core = await makeCore();
    core.services.channels.retryDelays = [];
    const failing = core.services.channels.add({});
    getMeFailures = [badGateway];
    const c = await core.services.channels.configure({ id: failing.id, token: TOKEN, enabled: true });
    expect(c.status).toBe('error');
    expect(c.error).toBe("Call to 'getMe' failed! (502: Bad Gateway)");
    const other = core.services.bots.create({ name: 'Second', providerId: core.services.bots.list()[0]!.providerId });
    const running = core.services.channels.add({ botId: other.id });
    await core.services.channels.configure({ id: running.id, token: '987654321:AAHother0000000000000000000000000000', enabled: true });
    const n = calls('getMe').length;
    await core.services.channels.afterWake('test');
    expect(core.services.channels.stored(failing.id)?.status).toBe('running');
    expect(core.services.channels.stored(running.id)?.status).toBe('running');
    expect(calls('getMe').length).toBe(n + 1);
    await core.services.channels.configure({ id: failing.id, enabled: false });
    await core.services.channels.configure({ id: running.id, enabled: false });
  }, 15_000);
});
