/**
 * The Vault: items kept for this user only with their secrets sealed, never on the wire (but to the owner's Show),
 * and bots using them without seeing them: a secret typed by AppuBot as a masked step, an API key in a private file,
 * each item's first use in a chat after the user's "Allow".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, ComputerAction, EventPayload } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { envLine } from './vault';
import { summarizeAction } from './computer';
import { checkRole } from '../handlers';

let core: Core;
let root: string;
let bot: Bot;
const typed: { action: ComputerAction; threadId: string }[] = [];
const events: { event: string; payload: unknown }[] = [];
const ctx = () => ({ botId: bot.id, threadId: core.services.threads.chatFor(bot.id).id });

/** a keychain stand-in: sealed text never holds the plain text */
const box = {
  encrypt: (s: string) => `sealed:${Buffer.from(s).toString('base64').split('').reverse().join('')}`,
  decrypt: (s: string) => Buffer.from(s.slice(7).split('').reverse().join(''), 'base64').toString(),
};

/** answer the next question in the chat with `answer` */
function answerNext(answer: string): void {
  const off = core.ctx.bus.on((e) => {
    if (e.event !== 'question.asked') return;
    off();
    queueMicrotask(() => core.services.agentBridge.answer((e.payload as { questionId: string }).questionId, answer));
  });
}

/** the next question asked in a chat */
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
  root = mkdtempSync(join(tmpdir(), 'appubot-vault-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined, secretBox: box,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
  });
  await core.start();
  bot = core.services.bots.list()[0]!;
  // the computer: record what would be typed
  const computer = core.services.computer as unknown as { typeSecret: (a: ComputerAction, t: string) => Promise<{ ok: boolean }>; windowName: () => string };
  computer.typeSecret = async (action, threadId) => { typed.push({ action, threadId }); return { ok: true }; };
  computer.windowName = () => 'Safari (“Sign in · GitHub”)';
  core.ctx.bus.on((e) => { events.push(e as { event: string; payload: unknown }); });
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('vault', () => {
  it('keeps items for this user only, secrets sealed and never listed', () => {
    const v = core.services.vault;
    const login = v.save({ kind: 'login', name: 'GitHub', site: 'github.com', username: 'me@example.com', secrets: { password: 'hunter2' } });
    const card = v.save({ kind: 'card', name: 'Work card', expiry: '08/29', secrets: { number: '4242 4242 4242 4242', cvc: '123' } });
    expect(login.secrets).toEqual(['password']);
    expect(card).toMatchObject({ hint: '4242', brand: 'Visa', secrets: ['number', 'cvc'] });

    const file = join(root, 'data', 'vault.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, 'utf8');
    for (const s of ['hunter2', '4242424242424242', '"123"']) expect(raw).not.toContain(s);
    const wire = JSON.stringify([v.list(), v.agentList(ctx())]);
    for (const s of ['hunter2', '4242424242424242', 'sealed:']) expect(wire).not.toContain(s);
    expect(v.reveal(login.id, 'password')).toEqual({ value: 'hunter2' });

    // a secret left out stays; '' clears it
    expect(v.save({ id: card.id, kind: 'card', name: 'Work card', expiry: '09/30' }).secrets).toEqual(['number', 'cvc']);
    expect(v.save({ id: card.id, kind: 'card', name: 'Work card', secrets: { cvc: '' } }).secrets).toEqual(['number']);
    expect(() => v.save({ id: card.id, kind: 'login', name: 'x' })).toThrow(/kind/);
    expect(() => v.save({ kind: 'card', name: 'Bad', expiry: '13/40', secrets: { number: '4242424242424242' } })).toThrow(/MM\/YY/);
    expect(() => v.save({ kind: 'apiKey', name: 'No name', secrets: { key: 'k' } })).toThrow(/variable/);
  });

  it('types a secret only after the Allow, once per chat, masked', async () => {
    const v = core.services.vault;
    const login = v.agentList(ctx(), 'login').items[0]!;
    const before = typed.length;
    answerNext("Don't allow");
    await expect(v.fill(ctx(), { id: login.id, field: 'password', pid: 1, windowId: 2 })).rejects.toThrow(/didn't allow/);
    expect(typed.length).toBe(before);

    // computer use must be on for the bot
    core.services.bots.update(bot.id, { computerUse: true });
    answerNext('Allow');
    const asked = events.length;
    const r = await v.fill(ctx(), { id: login.id, field: 'password', pid: 1, windowId: 2, label: 'Password' });
    expect(r.ok).toBe(true);
    expect(r.text).not.toContain('hunter2');
    const q = events.slice(asked).find((e) => e.event === 'question.asked')!.payload as { question: string };
    expect(q.question).toMatch(/type your “GitHub” password \(saved for github.com\) into Safari/);
    expect(typed.at(-1)!.action).toMatchObject({ type: 'type', text: 'hunter2', pid: 1, windowId: 2, label: 'Password' });

    // the same chat doesn't ask again; the username (not secret) never asks
    const n = events.filter((e) => e.event === 'question.asked').length;
    await v.fill(ctx(), { id: login.id, field: 'password', pid: 1, windowId: 2 });
    await v.fill(ctx(), { id: login.id, field: 'username', pid: 1, windowId: 2 });
    expect(events.filter((e) => e.event === 'question.asked').length).toBe(n);
    expect(typed.at(-1)!.action.text).toBe('me@example.com');
    await expect(v.fill(ctx(), { id: login.id, field: 'cvc', pid: 1, windowId: 2 })).rejects.toThrow(/no security code/);
  });

  it('puts an API key in the bot\'s private keys file after the Allow, and takes it out again', async () => {
    const v = core.services.vault;
    const key = v.save({ kind: 'apiKey', name: 'OpenAI', envName: 'OPENAI_API_KEY', secrets: { key: 'sk-abc$1' } });
    expect(key.hint).toBe('c$1'.padStart(4, 'b'));
    answerNext('Allow');
    const r = await v.key(ctx(), key.id);
    expect(r.envName).toBe('OPENAI_API_KEY');
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(r.path, 'utf8')).toBe("OPENAI_API_KEY='sk-abc$1'\n");
    v.delete(key.id);
    expect(readFileSync(r.path, 'utf8')).toBe('');
  });

  it('never shows a secret step\'s text in the action feed', () => {
    expect(summarizeAction({ type: 'type', text: 'hunter2', secret: true })).toBe('Typed a saved item from the Vault');
    expect(summarizeAction({ type: 'type', text: 'hello' })).toBe('Typed "hello"');
  });

  it('keeps secrets to the computer: a paired phone may not see or type one, nor a model server\'s key', () => {
    const phone = { role: 'full' as const, deviceId: 'p1' };
    expect(() => checkRole('vault.reveal', { id: 'v1', field: 'password' }, phone)).toThrow(/not allowed/);
    expect(() => checkRole('vault.save', { kind: 'login', name: 'GitHub', secrets: { password: 'hunter2' } }, phone)).toThrow(/not allowed/);
    // renaming, clearing a secret and deleting work from a phone too
    expect(() => checkRole('vault.save', { id: 'v1', kind: 'login', name: 'GitHub', secrets: { password: '' } }, phone)).not.toThrow();
    expect(() => checkRole('vault.save', { id: 'v1', kind: 'login', name: 'GitHub' }, phone)).not.toThrow();
    expect(() => checkRole('vault.delete', { id: 'v1' }, phone)).not.toThrow();
    expect(() => checkRole('vault.list', {}, { role: 'limited', deviceId: 'p2' })).toThrow(/not allowed/);
    expect(() => checkRole('endpoints.save', { kind: 'openai', name: 'X', baseUrl: 'https://x', apiKey: 'sk-1', models: ['m'] }, phone)).toThrow(/not allowed/);
    expect(() => checkRole('endpoints.probe', { baseUrl: 'https://x', apiKey: 'sk-1' }, phone)).toThrow(/not allowed/);
    expect(() => checkRole('endpoints.save', { id: 'e1', kind: 'openai', name: 'X', baseUrl: 'https://x', models: ['m'] }, phone)).not.toThrow();
    expect(() => checkRole('vault.reveal', { id: 'v1', field: 'password' }, { role: 'owner', deviceId: 'mac' })).not.toThrow();
    // many at once: a secret in any of them keeps the whole call to the computer
    expect(() => checkRole('vault.saveMany', { items: [{ kind: 'login', name: 'A' }, { kind: 'login', name: 'B', secrets: { password: 'x' } }] }, phone)).toThrow(/not allowed/);
    expect(() => checkRole('vault.saveMany', { items: [{ kind: 'contact', name: 'Home' }] }, phone)).not.toThrow();
    // what one of the person's computers hands another goes through the computer's own window only
    for (const m of ['github.local', 'github.localToken', 'github.setup', 'macLink.create', 'macLink.setFolders', 'macLink.setWritable', 'macLink.status', 'macFiles.link', 'macFiles.unlink'] as const) {
      expect(() => checkRole(m, {}, phone)).toThrow(/not allowed/);
      expect(() => checkRole(m, {}, { role: 'limited', deviceId: 'p2' })).toThrow(/not allowed/);
      expect(() => checkRole(m, {}, { role: 'agent', deviceId: 'a1' })).toThrow(/not allowed/);
    }
    // a bot reads the linked computer's lent folders through its own tools, and nothing else of the link
    expect(() => checkRole('agent.mac.fetch', { path: '/x' }, { role: 'agent', deviceId: 'a1' })).not.toThrow();
    expect(() => checkRole('agent.mac.put', { path: '/x', text: 'y' }, { role: 'agent', deviceId: 'a1' })).not.toThrow();
    expect(() => checkRole('agent.mac.put', { path: '/x', text: 'y' }, phone)).toThrow(/not allowed/);
    expect(() => checkRole('macFiles.status', {}, { role: 'agent', deviceId: 'a1' })).toThrow(/not allowed/);
  });

  it('saves many items in one write, all or nothing', () => {
    const v = core.services.vault;
    const before = v.list().items.length;
    const { items } = v.saveMany([
      { kind: 'login', name: 'Zoho', site: 'zoho.com', username: 'me', secrets: { password: 'pw-one' } },
      { kind: 'login', name: 'Stripe', site: 'stripe.com', username: 'me', secrets: { password: 'pw-two' } },
    ]);
    expect(items.map((i) => i.name)).toEqual(['Zoho', 'Stripe']);
    expect(v.list().items).toHaveLength(before + 2);
    expect(v.reveal(items[1]!.id, 'password')).toEqual({ value: 'pw-two' });
    const raw = readFileSync(join(root, 'data', 'vault.json'), 'utf8');
    expect(raw).not.toContain('pw-one');
    // one bad item refuses the lot, named by its place, and the file is as it was
    expect(() => v.saveMany([
      { kind: 'login', name: 'Fine', secrets: { password: 'pw-three' } },
      { kind: 'card', name: 'Bad card', expiry: '99/99', secrets: { number: '4242424242424242' } },
    ])).toThrow(/Item 2 \(“Bad card”\).*MM\/YY/);
    expect(v.list().items).toHaveLength(before + 2);
    expect(readFileSync(join(root, 'data', 'vault.json'), 'utf8')).toBe(raw);
    // the next single change still writes (and leaves the Vault as the tests after this one expect it)
    v.delete(items[0]!.id);
    expect(readFileSync(join(root, 'data', 'vault.json'), 'utf8')).not.toBe(raw);
    v.delete(items[1]!.id);
    expect(v.list().items).toHaveLength(before);
  });

  it('asks for a missing item on a card in the chat: its secrets go straight into the Vault, never to the bot', async () => {
    const v = core.services.vault;
    const bridge = core.services.agentBridge;
    // a card's fields are AppuBot's own; a phone may pick or decline but not type a secret in
    let asked = nextQuestion();
    const req = v.request(ctx(), { kind: 'login', name: 'GST portal', site: 'gst.gov.in', reason: 'To file GSTR-3B.' });
    let q = await asked;
    expect(q.form).toMatchObject({ kind: 'vault', vault: { kind: 'login', reason: 'To file GSTR-3B.', saved: [{ name: 'GitHub', detail: 'me@example.com · github.com' }] } });
    expect(q.form!.fields.map((f) => [f.id, f.type, f.value])).toEqual([['name', 'text', 'GST portal'], ['site', 'text', 'gst.gov.in'], ['username', 'text', undefined], ['password', 'secret', undefined]]);
    expect(() => bridge.answer(q.questionId, 'my password is hunter3')).toThrow(/card/);
    await expect(bridge.answerForm({ questionId: q.questionId, values: { name: 'GST portal', password: 'pw-123' } }, 'full')).rejects.toThrow(/on your computer/);
    await expect(bridge.answerForm({ questionId: q.questionId, values: { name: 'GST portal' } }, 'owner')).rejects.toThrow(/Password: Required/);
    expect(await bridge.answerForm({ questionId: q.questionId, values: { name: 'GST portal', site: 'gst.gov.in', username: 'ACME01', password: 'pw-123' } }, 'owner')).toEqual({ ok: true });
    const got = await req;
    expect(got.item).toMatchObject({ kind: 'login', name: 'GST portal', username: 'ACME01', secrets: ['password'] });
    expect(JSON.stringify(got)).not.toContain('pw-123');
    expect(v.reveal(got.item!.id, 'password')).toEqual({ value: 'pw-123' });
    // the chat keeps what isn't secret
    const kept = JSON.stringify(events.filter((e) => e.event === 'message.part' || e.event === 'question.asked'));
    expect(kept).toContain('Saved “GST portal” to the Vault');
    expect(kept).not.toContain('pw-123');

    // saved from the card: this chat may type it without another Allow
    const n = events.filter((e) => e.event === 'question.asked').length;
    await v.fill(ctx(), { id: got.item!.id, field: 'password', pid: 1, windowId: 2 });
    expect(events.filter((e) => e.event === 'question.asked').length).toBe(n);
    expect(typed.at(-1)!.action.text).toBe('pw-123');

    // or one already saved, picked; or turned down
    asked = nextQuestion();
    const pick = v.request(ctx(), { kind: 'login', name: 'GitHub' });
    q = await asked;
    const github = q.form!.vault!.saved.find((s) => s.name === 'GitHub')!;
    bridge.answerForm({ questionId: q.questionId, values: {}, savedId: github.id }, 'full');
    expect(await pick).toMatchObject({ item: { name: 'GitHub' }, picked: true });
    asked = nextQuestion();
    const no = v.request(ctx(), { kind: 'apiKey', name: 'OpenAI', envName: 'openai_api_key' });
    q = await asked;
    expect(q.form!.fields.find((f) => f.id === 'envName')!.value).toBe('OPENAI_API_KEY');
    bridge.answerForm({ questionId: q.questionId, values: {}, decline: true }, 'owner');
    expect(await no).toEqual({ item: null, declined: true });
  });

  it('asks for details on a form card, never for a secret', async () => {
    const bridge = core.services.agentBridge;
    await expect(bridge.askForm(ctx(), { question: 'Sign in', fields: [{ id: 'pw', label: 'Password', type: 'secret' }] })).rejects.toThrow(/vault_request/);
    await expect(bridge.askForm(ctx(), { question: 'Pick', fields: [{ id: 'r', label: 'Room', type: 'choice' }] })).rejects.toThrow(/no options/);
    let asked = nextQuestion();
    const fields = [
      { id: 'check_in', label: 'Check-in', type: 'date' as const, required: true },
      { id: 'room', label: 'Room', type: 'choice' as const, options: ['Standard', 'Suite'] },
      { id: 'extras', label: 'Extras', type: 'multichoice' as const, options: ['Breakfast', 'Pickup'] },
      { id: 'refundable', label: 'Refundable', type: 'toggle' as const },
    ];
    const form = bridge.askForm(ctx(), { question: 'Hotel details', fields });
    let q = await asked;
    expect(q.form).toMatchObject({ kind: 'form', fields: [{ id: 'check_in', required: true, options: [] }, { id: 'room' }, { id: 'extras' }, { id: 'refundable' }] });
    await expect(bridge.answerForm({ questionId: q.questionId, values: { room: 'Suite' } }, 'full')).rejects.toThrow(/Check-in: Required/);
    await expect(bridge.answerForm({ questionId: q.questionId, values: { check_in: '2026-12-04', room: 'Penthouse' } }, 'full')).rejects.toThrow(/Room: Pick one/);
    await bridge.answerForm({ questionId: q.questionId, values: { check_in: '2026-12-04', room: 'Suite', extras: ['Breakfast'], junk: 'x' } }, 'limited');
    expect(await form).toEqual({ values: { check_in: '2026-12-04', room: 'Suite', extras: ['Breakfast'], refundable: false } });
    // answered in words (an older app, Telegram): the bot gets them as they are
    asked = nextQuestion();
    const words = bridge.askForm(ctx(), { question: 'Hotel details', fields });
    q = await asked;
    bridge.answer(q.questionId, 'Dec 4, a suite');
    expect(await words).toEqual({ values: null, answer: 'Dec 4, a suite' });
  });

  it('writes env lines a shell and dotenv both read', () => {
    expect(envLine('A', 'sk-123_abc')).toBe('A=sk-123_abc');
    expect(envLine('A', "it's $x")).toBe("A='it'\\''s $x'");
  });
});
