/**
 * Custom characters: the library (kept, normalized, renamed, removed with its bots going back to their shapes) and
 * drawing new ones with the user's own agent in a hidden one-off session (no chat, retried, cancellable).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHARACTER_BODY_CHARS, type Bot } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { buildSnapshot } from '../handlers';
import { photoKey } from './channels';
import { CharactersService } from './characters';

let core: Core;
let runtime: FakeRuntime;
let root: string;
let bot: Bot;
const events: { event: string; payload: unknown }[] = [];

const BLOB = 'M20 40C20 10 80 10 80 40L84 84C84 94 16 94 16 84Z';
const EARS = 'M30 34L22 8L44 28A30 30 0 0 1 56 28L78 8L70 34C86 46 86 92 50 92C14 92 14 46 30 34Z';
const reply = (n = 3) => `Here they are:\n\`\`\`json\n${JSON.stringify({ characters: [
  { name: 'Mochi', body: BLOB, face: { x: 50, y: 50, s: 0.8 } },
  { name: 'Kit', body: EARS },
  { name: 'Pebble', body: 'M10 50A40 40 0 1 1 90 50A40 40 0 1 1 10 50Z' },
].slice(0, n) })}\n\`\`\``;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-characters-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, host: '127.0.0.1', quiet: true,
  });
  await core.start();
  await core.services.providers.refresh();
  bot = core.services.bots.create({ name: 'Wearer', providerId: 'claude-code', shape: 'hex' } as Parameters<typeof core.services.bots.create>[0]);
  core.ctx.bus.on((e) => { if (e.event.startsWith('character.')) events.push({ event: e.event, payload: e.payload }); });
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('the library', () => {
  it('keeps a character fitted and checked again, on disk and as an event', () => {
    const c = core.services.characters.save({ name: '  Tofu\n<b>', body: 'M200 100H400V300H200Z', source: 'imported' });
    expect(c.name).toBe('Tofu b');
    expect(c.body).toMatch(CHARACTER_BODY_CHARS);
    expect(c.face.s).toBeGreaterThan(0.3);
    expect(core.services.characters.list().map((x) => x.id)).toContain(c.id);
    expect(JSON.parse(readFileSync(join(root, 'data', 'characters.json'), 'utf8')).characters[0].id).toBe(c.id);
    expect(events.at(-1)).toMatchObject({ event: 'character.updated', payload: { id: c.id } });
    // a fresh start reads it back
    expect(new CharactersService(core.ctx).list().map((x) => x.id)).toEqual([c.id]);
  });

  it('refuses what isn’t a drawing', () => {
    expect(() => core.services.characters.save({ name: 'x', body: 'M0 0L10 10"/><script>', source: 'imported' })).toThrow(/path commands/);
    expect(() => core.services.characters.save({ name: 'x', body: 'M10 10L90 10Z', source: 'generated' })).toThrow(/too small or flat/);
  });

  it('renames one, cleaned', () => {
    const c = core.services.characters.list()[0]!;
    expect(core.services.characters.rename(c.id, ' Big\nTofu ').name).toBe('Big Tofu');
    expect(core.services.characters.rename(c.id, '   ').name).toBe('Big Tofu');
  });

  it('dresses a bot in it, and the bot goes back to its shape when it is removed', () => {
    const c = core.services.characters.save({ name: 'Kit', body: EARS, source: 'generated' });
    expect(core.services.bots.update(bot.id, { characterId: c.id }).characterId).toBe(c.id);
    expect(() => core.services.bots.update(bot.id, { characterId: 'chr_nope' })).toThrow(/isn’t in the library/);
    expect(core.services.bots.update(bot.id, { color: '#16C47A' }).characterId).toBe(c.id);
    expect(core.services.characters.delete(c.id)).toEqual({ ok: true, bots: 1 });
    const after = core.services.bots.require(bot.id);
    expect(after.characterId).toBeUndefined();
    expect(after.shape).toBe('hex');
    expect(events.at(-1)).toMatchObject({ event: 'character.removed', payload: { id: c.id } });
    // '' takes one off
    const d = core.services.characters.save({ name: 'Blob', body: BLOB, source: 'generated' });
    core.services.bots.update(bot.id, { characterId: d.id });
    expect(core.services.bots.update(bot.id, { characterId: '' }).characterId).toBeUndefined();
  });

  it('shows in the hello snapshot and to the bots (get_bot, update_bot)', async () => {
    const c = core.services.characters.list()[0]!;
    const a = { botId: bot.id, threadId: core.services.threads.chatFor(bot.id).id };
    const set = await core.services.agentBridge.updateBot(a, undefined, { characterId: c.id });
    expect(set.character).toEqual({ id: c.id, name: c.name });
    expect(set.characters.map((x) => x.id)).toContain(c.id);
    await expect(core.services.agentBridge.updateBot(a, undefined, { characterId: 'chr_nope' })).rejects.toThrow(/No character "chr_nope"/);
    // a new shape shows: the character comes off
    const reshaped = await core.services.agentBridge.updateBot(a, undefined, { shape: 'pill' });
    expect(reshaped.character).toBeUndefined();
    expect(reshaped.bot.shape).toBe('pill');
    // the hello snapshot carries the library (a computer that predates characters sends none)
    expect(buildSnapshot(core.ctx, 'owner').characters?.map((x) => x.id)).toContain(c.id);
    expect(buildSnapshot(core.ctx, 'agent').characters).toBeUndefined();
  });

  it('keys the Telegram photo by the character’s drawing', () => {
    const c = core.services.characters.list()[0]!;
    const plain = photoKey({ shape: 'hex', color: '#FF7A1F' });
    expect(plain).toBe('v2:hex:#ff7a1f');
    const worn = photoKey({ shape: 'hex', color: '#FF7A1F', characterId: c.id }, c);
    expect(worn).toMatch(new RegExp(`^v2c:${c.id}:`));
    expect(photoKey({ shape: 'hex', color: '#FF7A1F', characterId: c.id }, { ...c, face: { ...c.face, s: 0.4 } })).not.toBe(worn);
    // a chief's picture wears its crown: a new key, so its Telegram bot gets the new picture; other bots' keys stay
    expect(photoKey({ shape: 'hex', color: '#FF7A1F', chief: true })).toBe('v3:chief:v2:hex:#ff7a1f');
    expect(photoKey({ shape: 'hex', color: '#FF7A1F', chief: false })).toBe(plain);
  });
});

describe('drawing new ones with the user’s agent', () => {
  it('asks a hidden one-off session and returns the candidates, nothing in any chat', async () => {
    const threadsBefore = core.services.threads.list({ limit: 1000 }).length;
    const sessions = runtime.created.length;
    runtime.reply = (text) => (text.includes('Draw 3 different takes on') ? reply() : undefined);
    const r = await core.services.characters.generate({ prompt: 'a round cat' }, 'owner');
    expect(r.providerId).toBe('claude-code');
    expect(r.candidates.map((c) => c.name)).toEqual(['Mochi', 'Kit', 'Pebble']);
    for (const c of r.candidates) expect(c.body).toMatch(CHARACTER_BODY_CHARS);
    const opts = runtime.created.at(-1)!;
    expect(runtime.created.length).toBe(sessions + 1);
    expect(opts.cwd).toBe(join(root, 'data', 'character-studio'));
    expect(opts.effortId).toBe('low');
    expect(opts.mcpServers).toBeUndefined();
    expect(runtime.prompts.at(-1)!.blocks[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"a round cat"') });
    expect(core.services.threads.list({ limit: 1000 }).length).toBe(threadsBefore);
    await vi.waitFor(() => expect(runtime.sessions.has(runtime.prompts.at(-1)!.sessionId)).toBe(false)); // closed
    // none were kept
    expect(core.services.characters.list().some((c) => c.name === 'Mochi')).toBe(false);
  });

  it('runs on the bot’s agent when asked for one', async () => {
    const codexBot = core.services.bots.create({ name: 'Coder', providerId: 'codex' } as Parameters<typeof core.services.bots.create>[0]);
    runtime.reply = () => reply(1);
    expect((await core.services.characters.generate({ prompt: 'a fox', botId: codexBot.id }, 'owner')).providerId).toBe('codex');
  });

  it('asks again when a reply has nothing usable, and gives up after three tries', async () => {
    let tries = 0;
    runtime.reply = () => (++tries === 1 ? 'Sorry, I can’t draw.' : reply(2));
    const r = await core.services.characters.generate({ prompt: 'a ghost' }, 'owner');
    expect(tries).toBe(2);
    expect(r.candidates).toHaveLength(2);
    expect(runtime.prompts.at(-1)!.blocks[0]).toMatchObject({ text: expect.stringContaining('couldn\'t be used') });
    runtime.reply = () => '{"characters":[{"name":"Line","body":"M0 0L100 100"}]}';
    await expect(core.services.characters.generate({ prompt: 'a stick' }, 'owner')).rejects.toMatchObject({ code: 'invalid_reply' });
  });

  it('stops when cancelled', async () => {
    runtime.reply = null;
    // the fake agent's turn waits until cancelled when the prompt says "slow"
    const p = core.services.characters.generate({ prompt: 'a slow snail', requestId: 'r1' }, 'phone-1');
    await vi.waitFor(() => expect(runtime.prompts.at(-1)!.blocks[0]).toMatchObject({ text: expect.stringContaining('slow snail') }));
    core.services.characters.cancel('phone-2', 'r1'); // another device's cancel does nothing
    core.services.characters.cancel('phone-1', 'r1');
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('says so when no agent can draw', async () => {
    runtime.logins.set('claude-code', 'logged_out');
    runtime.logins.set('codex', 'logged_out');
    await core.services.providers.refresh();
    await expect(core.services.characters.generate({ prompt: 'a bear' }, 'owner')).rejects.toMatchObject({ code: 'unavailable', message: expect.stringMatching(/none is installed and signed in/) });
    runtime.logins.set('claude-code', 'logged_in');
    runtime.logins.set('codex', 'logged_in');
    await core.services.providers.refresh();
  });

  it('draws only a few a minute', async () => {
    runtime.reply = () => reply(1);
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await core.services.characters.generate({ prompt: `a bot ${i}` }, 'owner').then(() => 'ok', (e: { code: string }) => e.code));
    expect(results).toContain('rate_limited');
  });
});
