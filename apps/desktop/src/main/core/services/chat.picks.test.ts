/**
 * The composer's model (and effort, mode) pick reaches the agent whenever it is made: while the chat's agent is
 * starting, when that agent has gone, or when it refuses the switch. And a restarted app resumes the agent's session.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, Thread } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

let core: Core;
let runtime: FakeRuntime;
let root: string;
let bot: Bot;
let thread: Thread;

/** A turn that waits until cancelled ("slow"): enough to start the chat's agent, then stopped. */
async function startTurn(): Promise<void> {
  const created = runtime.created.length;
  core.services.chat.send({ botId: bot.id, text: 'slow', attachments: [], images: [] });
  await vi.waitFor(() => expect(runtime.prompts.at(-1)?.sessionId && runtime.created.length > created).toBe(true));
  await core.services.chat.cancel(thread.id);
  await vi.waitFor(() => expect(core.services.threads.require(thread.id).status).not.toBe('running'));
}
const sessionOf = () => runtime.sessions.get(core.services.threads.require(thread.id).acpSessionId!)!;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-picks-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, host: '127.0.0.1', quiet: true,
  });
  await core.start();
  bot = core.services.bots.create({ name: 'Picker', providerId: 'claude-code' } as Parameters<typeof core.services.bots.create>[0]);
  thread = core.services.threads.chatFor(bot.id);
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('model picks', () => {
  it('applies a model picked while the agent is starting, over what a loading session replays', async () => {
    let release!: () => void;
    runtime.gate = new Promise((r) => { release = r; });
    runtime.replayModel = 'm1'; // the old setting session/load reports while it starts
    core.services.chat.warm(bot.id);
    await vi.waitFor(() => expect(runtime.created.length).toBe(1));
    expect((await core.services.chat.setModel(thread.id, 'm2')).modelId).toBe('m2');
    release();
    runtime.gate = null;
    runtime.replayModel = null;
    await vi.waitFor(() => expect(core.services.threads.require(thread.id).acpSessionId).toBeTruthy());
    expect(sessionOf().currentModelId).toBe('m2');
    expect(core.services.threads.require(thread.id).modelId).toBe('m2');
  });

  it('switches a running agent at once', async () => {
    await core.services.chat.setModel(thread.id, 'm3');
    expect(sessionOf().currentModelId).toBe('m3');
  });

  it('keeps a pick made while the agent has gone, and starts the next one with it', async () => {
    const gone = sessionOf();
    gone.state = 'error';
    expect((await core.services.chat.setModel(thread.id, 'm4')).modelId).toBe('m4');
    expect(gone.currentModelId).toBe('m3'); // never sent to the dead agent
    await startTurn();
    expect(runtime.created.at(-1)).toMatchObject({ modelId: 'm4' });
    expect(sessionOf().currentModelId).toBe('m4');
  });

  it('restarts the agent with a pick it refused, resuming the conversation', async () => {
    const before = sessionOf().id;
    runtime.failSet = true;
    expect((await core.services.chat.setModel(thread.id, 'm5')).modelId).toBe('m5');
    runtime.failSet = false;
    await startTurn();
    expect(runtime.created.at(-1)).toMatchObject({ modelId: 'm5', resumeSessionId: before });
    expect(sessionOf().currentModelId).toBe('m5');
  });

  it('resumes the agent after a restart even when the providers list cannot tell it supports that', async () => {
    runtime.loadSessionCap = false;
    await core.services.providers.refresh();
    const before = sessionOf().id;
    await core.services.chat.closeThread(thread.id); // the app quit: the agent process is gone, its session kept on disk
    await startTurn();
    expect(runtime.created.at(-1)).toMatchObject({ resumeSessionId: before });
    expect(sessionOf().id).toBe(before);
  });
});

describe('defaults for new bots', () => {
  it('starts a bot on the default agent with Settings\' model and effort, another agent on its own default', () => {
    core.services.settings.update({ defaultProviderId: 'claude-code', defaultModelId: 'opus', defaultEffort: 'high' });
    const a = core.services.bots.create({ name: 'Defaults A', providerId: 'claude-code' } as Parameters<typeof core.services.bots.create>[0]);
    expect([a.modelId, a.effort]).toEqual(['opus', 'high']);
    expect(a.modeId).toBe('bypassPermissions'); // Settings' default permission mode (Full access unless changed)
    const b = core.services.bots.create({ name: 'Defaults B', providerId: 'codex' } as Parameters<typeof core.services.bots.create>[0]);
    expect([b.modelId, b.effort]).toEqual([undefined, 'high']);
    core.services.settings.update({ defaultModelId: '', defaultEffort: 'medium' });
  });

  it('starts a bot with Settings\' fast mode unless it says otherwise', () => {
    const create = (p: object): Bot => core.services.bots.create(p as Parameters<typeof core.services.bots.create>[0]);
    expect(create({ name: 'Fast A', providerId: 'claude-code' }).fast).toBe(false);
    core.services.settings.update({ defaultFast: true });
    expect(create({ name: 'Fast B', providerId: 'claude-code' }).fast).toBe(true);
    expect(create({ name: 'Fast C', providerId: 'claude-code', fast: false }).fast).toBe(false);
    core.services.settings.update({ defaultFast: false });
  });

  it('clears a bot\'s model back to its agent\'s default, and drops it on another agent', () => {
    const c = core.services.bots.create({ name: 'Defaults C', providerId: 'claude-code', modelId: 'sonnet' } as Parameters<typeof core.services.bots.create>[0]);
    expect(core.services.bots.update(c.id, { modelId: '' }).modelId).toBeUndefined();
    core.services.bots.update(c.id, { modelId: 'sonnet' });
    expect(core.services.bots.update(c.id, { providerId: 'codex' }).modelId).toBeUndefined();
  });
});
