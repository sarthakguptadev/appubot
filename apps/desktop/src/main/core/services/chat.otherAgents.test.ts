/**
 * Agents other than Claude Code and Codex (Cursor, the ACP registry's). Without permission levels of their own they
 * are on AppuBot's approvals: Full access says yes to everything they ask, Approve for me lets reads through and asks
 * the user about the rest. One that doesn't read the bot's CLAUDE.md/AGENTS.md gets its instructions in the first
 * message of a session.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

let core: Core;
let runtime: FakeRuntime;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-approvals-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, quiet: true,
  });
  await core.start();
  await core.services.providers.upsert({ id: 'other', name: 'Other agent', command: 'fake-other', args: [], env: {} });
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

const botOn = (modeId: string): Bot => core.services.bots.create({ name: `Bot ${modeId}`, providerId: 'other', modeId } as Parameters<typeof core.services.bots.create>[0]);

async function turn(bot: Bot): Promise<'asked' | 'done'> {
  const thread = core.services.threads.chatFor(bot.id);
  core.services.chat.send({ botId: bot.id, text: 'hi', attachments: [], images: [] });
  await vi.waitFor(() => {
    const t = core.services.threads.require(thread.id);
    expect(core.services.chat.listPermissions().some((p) => p.threadId === thread.id) || t.status === 'idle').toBe(true);
  });
  const asked = core.services.chat.listPermissions().find((p) => p.threadId === thread.id);
  if (!asked) return 'done';
  core.services.chat.respondPermission(asked.id, 'allow');
  await vi.waitFor(() => expect(core.services.threads.require(thread.id).status).toBe('idle'));
  return 'asked';
}

describe("AppuBot's approvals", () => {
  it('offers every agent Approve for me and Full access', async () => {
    const bot = botOn('auto');
    expect(bot.modeId).toBe('auto');
    expect((await core.services.providers.choices('other')).modes.map((m) => m.id)).toEqual(['auto', 'bypassPermissions']);
  });

  it('runs everything without asking on Full access', async () => {
    runtime.askKind = 'execute';
    expect(await turn(botOn('bypassPermissions'))).toBe('done');
  });

  it('asks before a command on Approve for me, and lets a read through', async () => {
    runtime.askKind = 'execute';
    const bot = botOn('auto');
    expect(await turn(bot)).toBe('asked');
    runtime.askKind = 'read';
    expect(await turn(bot)).toBe('done');
  });

  it("asks an agent's question as a question, even on Full access, and answers with the option picked", async () => {
    runtime.askKind = 'question';
    const bot = botOn('bypassPermissions');
    const thread = core.services.threads.chatFor(bot.id);
    core.services.chat.send({ botId: bot.id, text: 'hi', attachments: [], images: [] });
    let question: { questionId: string; options: string[] } | undefined;
    await vi.waitFor(() => {
      const parts = core.services.threads.history(bot.id, { limit: 5 }).messages.flatMap((m) => m.parts);
      const q = parts.find((p) => p.type === 'question');
      expect(q).toBeDefined();
      question = q as unknown as { questionId: string; options: string[] };
    });
    expect(question!.options).toEqual(['Red', 'Blue']);
    expect(core.services.chat.listPermissions().some((p) => p.threadId === thread.id)).toBe(false);
    core.services.agentBridge.answer(question!.questionId, 'blue');
    await vi.waitFor(() => expect(core.services.threads.require(thread.id).status).toBe('idle'));
    expect(runtime.lastChoice).toBe('2');
    runtime.askKind = 'execute';
  });

  it('keeps the choice when a bot moves between agents', () => {
    const bot = core.services.bots.create({ name: 'Mover', providerId: 'codex', modeId: 'agent' } as Parameters<typeof core.services.bots.create>[0]);
    expect(core.services.bots.update(bot.id, { providerId: 'other' }).modeId).toBe('auto');
    expect(core.services.bots.update(bot.id, { providerId: 'codex' }).modeId).toBe('agent');
    expect(core.services.bots.update(bot.id, { modeId: 'agent-full-access' }).modeId).toBe('agent-full-access');
    expect(core.services.bots.update(bot.id, { providerId: 'other' }).modeId).toBe('bypassPermissions');
  });
});

describe("the bot's instructions", () => {
  const textOf = (i: number) => runtime.prompts[i]!.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const reply = async (bot: Bot, text: string) => {
    const before = runtime.prompts.length;
    core.services.chat.send({ botId: bot.id, text, attachments: [], images: [] });
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(before + 1));
    await vi.waitFor(() => expect(core.services.threads.require(core.services.threads.chatFor(bot.id).id).status).toBe('idle'));
    return textOf(before);
  };
  beforeAll(() => { runtime.reply = () => 'ok'; });
  afterAll(() => { runtime.reply = null; });

  it("open the first message to an agent that doesn't read the instructions file, and come again when they change", async () => {
    const bot = core.services.bots.create({ name: 'Reader', providerId: 'other', job: 'Keeps my books' } as Parameters<typeof core.services.bots.create>[0]);
    const first = await reply(bot, 'hello');
    expect(first).toContain('your standing instructions as Reader');
    expect(first).toContain('Your job: **Keeps my books**');
    expect(first).not.toContain('<!-- Generated by AppuBot');
    expect(first.indexOf('<instructions>')).toBeLessThan(first.indexOf('hello'));
    expect(await reply(bot, 'again')).not.toContain('<instructions>');
    core.services.bots.update(bot.id, { job: 'Plans my trips' });
    const changed = await reply(bot, 'and now');
    expect(changed).toContain('your instructions as Reader have changed');
    expect(changed).toContain('Plans my trips');
  });

  it("aren't sent to an agent that reads CLAUDE.md or AGENTS.md", async () => {
    const bot = core.services.bots.create({ name: 'Claude bot', providerId: 'claude-code' } as Parameters<typeof core.services.bots.create>[0]);
    expect(await reply(bot, 'hello')).not.toContain('<instructions>');
  });
});
