/**
 * "Only in the cloud" on a Mac (`settings.cloudOnly`): while the person has an AppuBot computer that can work, this
 * computer's routines don't run and its Telegram bots stop listening; turned off, or once no cloud computer can work
 * (a plan on hold here), they run again as they were. Nothing about a routine or a channel is changed. An AppuBot
 * computer ignores the setting. The account is the fake backend (`cloudFake.ts`), Telegram a fake `deps.fetch`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { CloudFakeBackend } from './cloudFake';

const TOKEN = '123456789:AAHq8f9VQ1x7Yz2kLmNoPqRsTuVwXyZ01234';
const tg: string[] = [];
let mac: Core;
let runtime: FakeRuntime;
let fake: CloudFakeBackend;
let root: string;
let bot: Bot;

const until = async (ok: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)); }
};

/** Telegram, answering every call (getUpdates slowly, as long polling does) */
const telegramFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = /api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(url)?.[1];
  if (!method) throw new Error(`unexpected fetch ${url}`);
  tg.push(method);
  if (method === 'getUpdates') await new Promise((r) => setTimeout(r, 50));
  const result = method === 'getMe' ? { id: 7, is_bot: true, first_name: 'Ledger', username: 'ledger_bot' }
    : method === 'getWebhookInfo' ? { url: '', has_custom_certificate: false, pending_update_count: 0 }
      : method === 'getUpdates' ? [] : true;
  return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-cloud-only-'));
  fake = new CloudFakeBackend({ state: 'running', onChange: () => { void mac?.services.cloudAccount.refresh().catch(() => undefined); } });
  mac = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'Sarthak’s Mac', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    cloudBackendUrl: 'https://cloud.test/', cloudFetch: fake.fetch, fetch: telegramFetch,
  });
  await mac.start();
  bot = mac.services.bots.list()[0]!;
  runtime.reply = () => 'done';
  const acc = mac.services.cloudAccount;
  const { state } = await acc.startSignIn();
  await acc.finishSignIn({ code: 'the-code', state });
  await acc.status(true);
});

afterAll(async () => {
  await mac.stop();
  fake.close();
  rmSync(root, { recursive: true, force: true });
});

describe('only in the cloud', () => {
  it('is off by default, and holds once chosen while the cloud computer can work', () => {
    const acc = mac.services.cloudAccount;
    expect(mac.services.settings.get().cloudOnly).toBe(false);
    expect(acc.cloudOnly()).toBe(false);
    const seen: boolean[] = [];
    const off = acc.onCloudOnlyChange((on) => seen.push(on));
    mac.services.settings.update({ cloudOnly: true });
    expect(acc.cloudOnly()).toBe(true);
    mac.services.settings.update({ cloudOnly: false });
    expect(acc.cloudOnly()).toBe(false);
    expect(seen).toEqual([true, false]);
    off();
  });

  it('lets this computer’s routines go while it holds, and runs them again after, with the routine untouched', async () => {
    const routines = mac.services.routines;
    const r = routines.create({ botId: bot.id, name: 'Brief', prompt: 'Morning brief', schedule: '0 9 * * *', enabled: true, deliverTo: 'thread' });
    mac.services.settings.update({ cloudOnly: true });
    const before = runtime.prompts.length;
    routines.due(r.id);
    await new Promise((res) => setTimeout(res, 100));
    expect(runtime.prompts.length).toBe(before);
    const kept = routines.list().find((x) => x.id === r.id);
    expect(kept?.enabled).toBe(true);
    expect(kept?.lastRunAt).toBeUndefined();
    mac.services.settings.update({ cloudOnly: false });
    routines.due(r.id);
    await until(() => runtime.prompts.length > before);
    expect(routines.list().find((x) => x.id === r.id)?.lastRunAt).toBeGreaterThan(0);
    routines.delete(r.id);
  });

  it('stops this computer’s Telegram bots while it holds and starts them again as they were', async () => {
    const channels = mac.services.channels;
    await channels.start();
    mac.services.settings.update({ cloudOnly: true });
    tg.length = 0;
    // a bot switched on while only the cloud is used: saved as asked, never started here
    const c = await channels.configure({ id: 'telegram', token: TOKEN, enabled: true, botId: bot.id });
    expect(c).toMatchObject({ enabled: true, status: 'stopped' });
    expect(tg).not.toContain('getMe');
    expect(channels.listening()).toEqual([]);
    // turned off: it starts by itself
    mac.services.settings.update({ cloudOnly: false });
    await until(() => channels.listening().includes('telegram'));
    // on again: it stops, its record as it was
    mac.services.settings.update({ cloudOnly: true });
    await until(() => channels.list().find((x) => x.id === 'telegram')?.status === 'stopped');
    expect(channels.listening()).toEqual([]);
    expect(channels.list().find((x) => x.id === 'telegram')).toMatchObject({ enabled: true, botId: bot.id });
  });

  it('stops holding once no cloud computer can work (a payment on hold): this computer’s bots run again by themselves', async () => {
    const acc = mac.services.cloudAccount;
    expect(acc.cloudOnly()).toBe(true);
    fake.set('on-hold');
    await until(() => !acc.cloudOnly());
    await until(() => mac.services.channels.listening().includes('telegram'));
    // the choice is kept, and holds again once the computer can work
    expect(mac.services.settings.get().cloudOnly).toBe(true);
    fake.set('running');
    await until(() => acc.cloudOnly());
    await until(() => mac.services.channels.listening().length === 0);
  });
});
