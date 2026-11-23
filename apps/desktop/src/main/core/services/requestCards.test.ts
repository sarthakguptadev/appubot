/**
 * The request cards a bot raises in its chat beyond ask_form and the Vault: `telegram_request` (a token typed in on
 * the computer, never on a phone or in the chat, into the bot's own Telegram channel), `create_routine`'s card (the
 * schedule as fields the user adjusts before allowing it; "Allow" in words takes it as proposed) and `apps_request`
 * (an app card that settles by itself once the app is connected and on; an older app's empty submit is refused with
 * where to connect it), the bot cards of `create_bot` (the new bot's name a field) and `update_bot` (each change a
 * row) and `update_routine`'s card (the change's rows, the new schedule adjustable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, EventPayload } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

const TOKEN = '123456789:AAHq8f9VQ1x7Yz2kLmNoPqRsTuVwXyZ01234';
let core: Core;
let root: string;
let bot: Bot;
const tg: string[] = [];
const ctx = () => ({ botId: bot.id, threadId: core.services.threads.chatFor(bot.id).id });

/** Telegram's API, faked: every token is taken, the bot is @ledger_bot */
const telegramFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  const m = /api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(url);
  if (!m) throw new Error(`unexpected fetch ${url}`);
  tg.push(m[1]!);
  if (m[1] === 'getUpdates') await new Promise((r) => setTimeout(r, 50));
  const result = m[1] === 'getMe' ? { id: 7, is_bot: true, first_name: 'Ledger', username: 'ledger_bot' }
    : m[1] === 'getWebhookInfo' ? { url: '', has_custom_certificate: false, pending_update_count: 0 }
      : m[1] === 'getUpdates' ? [] : true;
  return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

function nextQuestion(): Promise<EventPayload<'question.asked'>> {
  return new Promise((resolve) => {
    const off = core.ctx.bus.on((e) => {
      if (e.event !== 'question.asked') return;
      off();
      resolve(e.payload as EventPayload<'question.asked'>);
    });
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-cards-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    fetch: telegramFetch,
  });
  await core.start();
  await core.services.providers.refresh();
  bot = core.services.bots.list()[0]!;
});
afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('the Telegram card', () => {
  it('takes the token on the computer only, starts the bot and tells the bot its handle and pairing code', async () => {
    const asked = nextQuestion();
    const done = core.services.channels.request(ctx(), { reason: 'So you can send receipts from your phone.', timeoutSec: 30 });
    const q = await asked;
    expect(q.form?.kind).toBe('telegram');
    expect(q.form?.fields.map((f) => [f.id, f.type])).toEqual([['token', 'secret']]);
    expect(q.form?.telegram).toEqual({ botName: bot.name, reason: 'So you can send receipts from your phone.' });
    // a phone with full access may not type the token
    await expect(core.services.agentBridge.answerForm({ questionId: q.questionId, values: { token: TOKEN } }, 'full')).rejects.toMatchObject({ code: 'forbidden' });
    // words don't do either
    expect(() => core.services.agentBridge.answer(q.questionId, TOKEN)).toThrow(/card/);
    // something that isn't a token keeps the card open with the field marked
    await expect(core.services.agentBridge.answerForm({ questionId: q.questionId, values: { token: 'hello' } }, 'owner')).rejects.toMatchObject({ code: 'invalid_params', data: { problems: { token: 'Not a bot token' } } });
    await core.services.agentBridge.answerForm({ questionId: q.questionId, values: { token: TOKEN } }, 'owner');
    const r = await done;
    expect(r.channel).toMatchObject({ botId: bot.id, enabled: true, status: 'running', botUsername: 'ledger_bot' });
    expect(r.channel?.pairingCode).toMatch(/^\d{6}$/);
    expect(tg).toContain('getMe');
    // the token never shows in the chat: the answered card carries no values of it
    const msgs = core.services.threads.messages(ctx().threadId, { limit: 20 });
    const part = msgs.flatMap((m) => m.parts).find((p) => p.type === 'question' && p.questionId === q.questionId) as { answer?: string; values?: Record<string, unknown> };
    expect(part.answer).toBe('Connected @ledger_bot');
    expect(JSON.stringify(part)).not.toContain(TOKEN);
    // asked again, the bot is told its Telegram bot is already there, without a card
    const again = await core.services.channels.request(ctx(), { timeoutSec: 5 });
    expect(again).toMatchObject({ already: true, channel: { botUsername: 'ledger_bot' } });
  });
});

describe('the routine card', () => {
  it('shows the schedule as fields, takes the user’s adjustments and sets the routine up so', async () => {
    const asked = nextQuestion();
    const done = core.services.agentBridge.createRoutine(ctx(), { name: 'Morning check', prompt: 'Go through the receipts.', schedule: '30 8 * * 1-5', deliverTo: 'notify' });
    const q = await asked;
    expect(q.form?.kind).toBe('routine');
    expect(q.form?.routine).toEqual({ prompt: 'Go through the receipts.', schedule: '30 8 * * 1-5', action: 'create', changes: [] });
    expect(q.options).toEqual(['Allow', "Don't allow"]);
    const by = Object.fromEntries((q.form?.fields ?? []).map((f) => [f.id, f.value]));
    expect(by).toMatchObject({ name: 'Morning check', repeat: 'Weekdays', time: '08:30' });
    // a bad day of the month keeps the card open
    await expect(core.services.agentBridge.answerForm({ questionId: q.questionId, values: { name: 'Morning check', repeat: 'Monthly', time: '09:00', day: '32', results: 'Notify me when done' } }, 'full'))
      .rejects.toMatchObject({ data: { problems: { day: '1 to 31' } } });
    await core.services.agentBridge.answerForm({ questionId: q.questionId, values: { name: 'Expense check', repeat: 'Certain days', time: '09:15', days: ['Mon', 'Thu'], results: 'Keep them in the chat' } }, 'full');
    const r = await done;
    expect(r).toMatchObject({ name: 'Expense check', schedule: '15 9 * * 1,4', deliverTo: 'thread', prompt: 'Go through the receipts.' });
    expect(core.services.routines.list().some((x) => x.id === r.id)).toBe(true);
  });

  it('is allowed as proposed in words (Telegram’s button), and refused when not allowed', async () => {
    const asked = nextQuestion();
    const done = core.services.agentBridge.createRoutine(ctx(), { name: 'Weekly digest', prompt: 'Summarise the week.', schedule: '0 18 * * 5' });
    const q = await asked;
    core.services.agentBridge.answer(q.questionId, 'Allow');
    expect(await done).toMatchObject({ name: 'Weekly digest', schedule: '0 18 * * 5', deliverTo: 'notify' });

    const asked2 = nextQuestion();
    const refused = core.services.agentBridge.createRoutine(ctx(), { name: 'Nope', prompt: 'x', schedule: '0 9 * * *' });
    const q2 = await asked2;
    await core.services.agentBridge.answerForm({ questionId: q2.questionId, values: {}, decline: true }, 'owner');
    await expect(refused).rejects.toMatchObject({ code: 'forbidden' });
    expect(core.services.routines.list().some((x) => x.name === 'Nope')).toBe(false);
  });
});

describe('the bot cards', () => {
  it('shows a new bot as it would be, takes the name the user picks and makes it so', async () => {
    const asked = nextQuestion();
    const done = core.services.agentBridge.createBot(ctx(), { name: 'Scout', job: 'Finds leads', instructions: 'Be brief.', color: '#2E8EFF', shape: 'hex' });
    const q = await asked;
    expect(q.form?.kind).toBe('bot');
    expect(q.form?.bot).toMatchObject({ action: 'create', name: 'Scout', job: 'Finds leads', instructions: 'Be brief.', color: '#2E8EFF', shape: 'hex', computerUse: false, self: false, changes: [] });
    expect(q.form?.bot?.agent).toBeTruthy();
    expect(q.form?.fields.map((f) => [f.id, f.value])).toEqual([['name', 'Scout']]);
    expect(q.options).toEqual(['Allow', "Don't allow"]);
    // an empty name keeps the card open
    await expect(core.services.agentBridge.answerForm({ questionId: q.questionId, values: { name: '  ' } }, 'full')).rejects.toMatchObject({ data: { problems: { name: 'Required' } } });
    await core.services.agentBridge.answerForm({ questionId: q.questionId, values: { name: 'Lead Scout' } }, 'full');
    const r = await done;
    expect(r.bot).toMatchObject({ name: 'Lead Scout', job: 'Finds leads', color: '#2E8EFF', shape: 'hex', computerUse: false });
    expect(core.services.bots.list().some((b) => b.id === r.bot.id)).toBe(true);
  });

  it('lays a change out as rows, with a shield on what grants power, and takes "Allow" in words', async () => {
    const other = core.services.bots.create({ name: 'Bo', providerId: bot.providerId, job: 'Books', computerUse: false });
    const asked = nextQuestion();
    const done = core.services.agentBridge.updateBot(ctx(), other.id, { job: 'Books and taxes', computerUse: true, color: '#FF4A5A' });
    const q = await asked;
    expect(q.form?.kind).toBe('bot');
    expect(q.form?.fields).toEqual([]);
    expect(q.form?.bot).toMatchObject({ action: 'update', name: 'Bo', self: false, color: '#FF4A5A' });
    expect(q.form?.bot?.changes.map((c) => [c.label, c.was, c.grants])).toEqual([['Job', 'Books', false], ['Computer use', 'Off', true]]);
    expect(q.question).toContain('wants to change Bo');
    core.services.agentBridge.answer(q.questionId, 'Allow');
    const r = await done;
    expect(r.bot).toMatchObject({ job: 'Books and taxes', computerUse: true, color: '#FF4A5A' });

    // turned down on the card: nothing changes
    const asked2 = nextQuestion();
    const refused = core.services.agentBridge.updateBot(ctx(), other.id, { name: 'Nope' });
    const q2 = await asked2;
    expect(q2.form?.bot?.changes).toEqual([{ label: 'Name', value: 'Nope', was: 'Bo', grants: false }]);
    await core.services.agentBridge.answerForm({ questionId: q2.questionId, values: {}, decline: true }, 'owner');
    await expect(refused).rejects.toMatchObject({ code: 'forbidden' });
    expect(core.services.bots.list().find((b) => b.id === other.id)?.name).toBe('Bo');
  });

  it('applies a look or an effort at once, without a card', async () => {
    const r = await core.services.agentBridge.updateBot(ctx(), undefined, { shape: 'drop' });
    expect(r.bot.shape).toBe('drop');
  });
});

describe('the routine change card', () => {
  it('shows the change as rows and the new schedule as fields, and takes the user’s adjustment', async () => {
    const r = core.services.routines.create({ botId: bot.id, name: 'Digest', prompt: 'Summarise.', schedule: '0 18 * * 5', deliverTo: 'notify' });
    const asked = nextQuestion();
    const done = core.services.agentBridge.updateRoutine(ctx(), r.id, { schedule: '0 17 * * 4', prompt: 'Summarise the week in five lines.' });
    const q = await asked;
    expect(q.form?.kind).toBe('routine');
    expect(q.form?.routine).toMatchObject({ action: 'update', prompt: 'Summarise the week in five lines.', schedule: '0 17 * * 4' });
    expect(q.form?.routine?.changes.map((c) => c.label)).toEqual(['It will send', 'When']);
    const by = Object.fromEntries((q.form?.fields ?? []).map((f) => [f.id, f.value]));
    expect(by).toMatchObject({ name: 'Digest', repeat: 'Certain days', time: '17:00', days: 'Thu' });
    await core.services.agentBridge.answerForm({ questionId: q.questionId, values: { name: 'Digest', repeat: 'Certain days', time: '17:30', days: ['Thu'], results: 'Notify me when done' } }, 'full');
    expect(await done).toMatchObject({ schedule: '30 17 * * 4', prompt: 'Summarise the week in five lines.', name: 'Digest' });

    // a rename alone applies at once, no card
    expect((await core.services.agentBridge.updateRoutine(ctx(), r.id, { name: 'Weekly digest' })).name).toBe('Weekly digest');
  });
});

describe('the app card', () => {
  it('shows where the app stands, refuses an older app’s empty submit with where to connect it, and takes a decline', async () => {
    const apps = core.services.composioFor('');
    const asked = nextQuestion();
    const done = apps.request(ctx(), { slug: 'gmail', reason: 'To send the invoice.', timeoutSec: 30 });
    const q = await asked;
    expect(q.form?.kind).toBe('app');
    expect(q.form?.fields).toEqual([]);
    expect(q.form?.app).toMatchObject({ slug: 'gmail', name: 'Gmail', reason: 'To send the invoice.', state: 'sign-in' });
    expect(q.form?.app?.logo).toBeTruthy();
    await expect(core.services.agentBridge.answerForm({ questionId: q.questionId, values: {} }, 'owner')).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('AppuBot → Apps') });
    await core.services.agentBridge.answerForm({ questionId: q.questionId, values: {}, decline: true }, 'owner');
    expect(await done).toMatchObject({ slug: 'gmail', name: 'Gmail', connected: false, on: false, declined: true });
  });

  it('refuses a slug that is no app', async () => {
    await expect(core.services.composioFor('').request(ctx(), { slug: 'not-an-app-at-all', timeoutSec: 5 })).rejects.toMatchObject({ code: 'not_found' });
  });
});
