/**
 * Telegram on an AppuBot Cloud computer: a channel sets a webhook on the computer's public port (with a secret
 * Telegram sends back on every delivery) instead of polling; the gateway's /telegram/:id hands deliveries to it;
 * a stop removes the webhook keeping Telegram's pending updates and a resume sets it again; and a token whose webhook
 * belongs to another computer (a Mac finding the cloud's, or the other way round) is refused, never taken over.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../app';
import type { CoreDeps } from '../context';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { TOKEN_ELSEWHERE } from './channels';

const roots: string[] = [];
const cores: Core[] = [];
/** every Telegram API call made: method and params */
const tg: { method: string; params: Record<string, unknown> }[] = [];
/** what getWebhookInfo answers */
let webhookUrl = '';

/** Telegram's API, faked: the core's `deps.fetch` (grammY is given it as its client's fetch). */
const telegramFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const m = /api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(url);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    const method = m[1]!;
    let params: Record<string, unknown> = {};
    try { params = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}; } catch { /* multipart */ }
    tg.push({ method, params });
    const result = method === 'getMe' ? { id: 7, is_bot: true, first_name: 'Ledger', username: 'ledger_bot' }
      : method === 'getWebhookInfo' ? { url: webhookUrl, has_custom_certificate: false, pending_update_count: 0 }
        : method === 'setWebhook' ? (webhookUrl = String(params.url), true)
          : method === 'deleteWebhook' ? (webhookUrl = '', true)
            : method === 'sendMessage' ? { message_id: 1, date: 0, chat: { id: 100, type: 'private' }, text: '' }
              : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

afterAll(async () => {
  for (const c of cores) await c.stop();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function makeCore(extra: Partial<CoreDeps> = {}): Core {
  const root = mkdtempSync(join(tmpdir(), 'appubot-webhook-'));
  roots.push(root);
  const core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'AppuBot Cloud', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    fetch: telegramFetch,
    ...extra,
  });
  cores.push(core);
  return core;
}

const calls = (method: string) => tg.filter((c) => c.method === method);
const until = async (test: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

describe('Telegram webhooks on the cloud', () => {
  it('sets a webhook with a secret, takes deliveries that carry it, pauses and resumes it, and gives it up when disconnected', async () => {
    const cloud: CoreDeps['cloud'] = { publicUrl: 'https://ab12cd34ef.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 };
    const core = makeCore({ cloud });
    await core.start();
    const woke: string[] = [];
    core.services.channels.onWebhook((id) => woke.push(id));
    const bot = core.services.bots.list()[0]!;
    const ch = core.services.channels.add({ botId: bot.id });
    await core.services.channels.configure({ id: ch.id, token: '123:abc', enabled: true });
    const set = calls('setWebhook');
    expect(set).toHaveLength(1);
    expect(set[0]!.params).toMatchObject({ url: `https://ab12cd34ef.agent37.app/telegram/${ch.id}`, drop_pending_updates: false, allowed_updates: ['message', 'callback_query'] });
    const secret = set[0]!.params.secret_token as string;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(calls('getUpdates')).toHaveLength(0);
    expect(core.services.channels.list().find((c) => c.id === ch.id)).toMatchObject({ status: 'running', botUsername: 'ledger_bot' });
    expect(core.services.channels.listening()).toEqual([ch.id]);

    const base = `http://127.0.0.1:${core.gateway.port}`;
    const update = { update_id: 1, message: { message_id: 1, date: 1, chat: { id: 100, type: 'private' }, from: { id: 100, is_bot: false, first_name: 'Sam' }, text: 'hello' } };
    const deliver = (s: string) => fetch(`${base}/telegram/${ch.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': s }, body: JSON.stringify(update) });
    expect((await deliver('wrong')).status).toBe(401);
    expect(woke).toEqual([]);
    const ok = await deliver(secret);
    expect(ok.status).toBeLessThan(300);
    expect(woke).toEqual([ch.id]);
    // the bot answered the stranger (a pairing code is asked for): the update reached the runner
    await until(() => calls('sendMessage').length > 0);
    expect((await fetch(`${base}/telegram/nope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);

    // about to stop: the webhook goes, Telegram keeps its updates; back: set again with the same secret
    await core.services.channels.pauseWebhooks();
    expect(calls('deleteWebhook').at(-1)!.params).toMatchObject({ drop_pending_updates: false });
    expect(core.services.channels.listening()).toEqual([]);
    expect((await deliver(secret)).status).toBe(404);
    await core.services.channels.resumeWebhooks();
    expect(calls('setWebhook')).toHaveLength(2);
    expect(calls('setWebhook')[1]!.params.secret_token).toBe(secret);
    expect(core.services.channels.listening()).toEqual([ch.id]);
    // the computer is back after a pause: set again by itself
    await core.services.channels.pauseWebhooks();
    core.services.system.setCloudState({ state: 'on-hold' });
    core.services.system.setCloudState({ state: 'ok' });
    await until(() => calls('setWebhook').length === 3 && core.services.channels.listening().length === 1);
    // a restore from sleep finds it still set: nothing to do; gone: set again
    await core.services.channels.recheckWebhooks();
    expect(calls('setWebhook')).toHaveLength(3);
    webhookUrl = '';
    await core.services.channels.recheckWebhooks();
    expect(calls('setWebhook')).toHaveLength(4);
    // disconnected: the webhook is given up for good
    const deletes = calls('deleteWebhook').length;
    await core.services.channels.configure({ id: ch.id, enabled: false });
    expect(calls('deleteWebhook')).toHaveLength(deletes + 1);
    expect(webhookUrl).toBe('');
  });

  it('refuses a token whose webhook belongs to another computer, on a Mac and on the cloud', async () => {
    webhookUrl = 'https://other-computer.agent37.app/telegram/telegram';
    const mac = makeCore();
    await mac.start();
    const bot = mac.services.bots.list()[0]!;
    const ch = mac.services.channels.add({ botId: bot.id });
    const before = tg.length;
    await mac.services.channels.configure({ id: ch.id, token: '999:zzz', enabled: true });
    expect(mac.services.channels.list().find((c) => c.id === ch.id)).toMatchObject({ status: 'error', error: TOKEN_ELSEWHERE });
    await new Promise((r) => setTimeout(r, 50));
    expect(tg.slice(before).map((c) => c.method)).not.toContain('getUpdates');
    expect(tg.slice(before).map((c) => c.method)).not.toContain('deleteWebhook');
    expect(webhookUrl).toBe('https://other-computer.agent37.app/telegram/telegram');
    // the cloud computer likewise, unless the webhook is its own
    const cloud = makeCore({ cloud: { publicUrl: 'https://ab12cd34ef.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 } });
    await cloud.start();
    const c2 = cloud.services.channels.add({ botId: cloud.services.bots.list()[0]!.id });
    await cloud.services.channels.configure({ id: c2.id, token: '999:zzz', enabled: true });
    expect(cloud.services.channels.list().find((c) => c.id === c2.id)).toMatchObject({ status: 'error', error: TOKEN_ELSEWHERE });
    webhookUrl = `https://ab12cd34ef.agent37.app/telegram/${c2.id}`;
    await cloud.services.channels.configure({ id: c2.id, enabled: true });
    expect(cloud.services.channels.list().find((c) => c.id === c2.id)).toMatchObject({ status: 'running' });
    // no public address yet: the bot waits for it
    webhookUrl = '';
    const unknown = makeCore({ cloud: { publicUrl: '', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 } });
    await unknown.start();
    const c3 = unknown.services.channels.add({ botId: unknown.services.bots.list()[0]!.id });
    await unknown.services.channels.configure({ id: c3.id, token: '555:yyy', enabled: true });
    expect(unknown.services.channels.list().find((c) => c.id === c3.id)).toMatchObject({ status: 'error', error: expect.stringMatching(/Waiting for this computer’s AppuBot Cloud address/) });
  });
});
