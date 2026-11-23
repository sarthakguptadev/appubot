/**
 * A free model OpenCode's server has retired while its own catalog still names it (2026-11-18: "Model
 * glm-5.3-flash-free has been deprecated. Use deepseek-v4.1-flash-free instead"): the chat moves off it by itself and
 * the same message is answered there, the model is learnt as retired (kept across a restart), and a chat that was on
 * one starts on a free model that answers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRetiredModel } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { systemDirOf } from '../context';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';

let core: Core | undefined;
let runtime: FakeRuntime;
let root: string | undefined;

const until = async (test: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

async function start(): Promise<Core> {
  root = mkdtempSync(join(tmpdir(), 'appubot-retired-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: async () => ({ shown: true }),
    version: '0.0.0-test', hostName: 'Test Mac', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
  });
  await core.start();
  return core;
}

afterEach(async () => {
  await core?.stop();
  core = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('a free model that has been retired', () => {
  it('moves the chat to the model named in its place and answers the same message there', async () => {
    const c = await start();
    const bot = c.services.bots.list()[0]!;
    const thread = c.services.threads.chatFor(bot.id);
    c.services.threads.update(thread.id, { providerId: 'opencode', modelId: 'opencode/longcat-2.5-free' });
    const asked: string[] = [];
    runtime.reply = (_text, sid) => {
      const model = runtime.sessions.get(sid)!.currentModelId!;
      asked.push(model);
      if (model === 'opencode/longcat-2.5-free') throw new Error('Internal error: Model longcat-2.5-free has been deprecated. Use deepseek-v4.1-flash-free instead.');
      return 'Sunny in Jammu.';
    };
    c.services.chat.send({ threadId: thread.id, text: 'jammu weather', attachments: [], images: [] }, 'desktop');
    await until(() => c.services.threads.messages(thread.id).some((m) => m.role === 'agent' && m.status !== 'streaming'));
    const reply = c.services.threads.messages(thread.id).find((m) => m.role === 'agent')!;
    expect(reply.status).toBe('complete');
    expect(reply.error).toBeUndefined();
    expect(reply.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')).toBe('Sunny in Jammu.');
    expect(asked).toEqual(['opencode/longcat-2.5-free', 'opencode/deepseek-v4.1-flash-free']);
    expect(c.services.threads.get(thread.id)!.modelId).toBe('opencode/deepseek-v4.1-flash-free');
    // learnt, and kept for the next run
    expect(isRetiredModel('opencode/longcat-2.5-free')).toBe(true);
    const saved = JSON.parse(readFileSync(join(systemDirOf(c.ctx.paths), 'retired-models.json'), 'utf8')) as { models: string[] };
    expect(saved.models).toContain('opencode/longcat-2.5-free');
  });

  it('a chat kept on a retired model starts on a free one that answers', async () => {
    const c = await start();
    const bot = c.services.bots.list()[0]!;
    const thread = c.services.threads.chatFor(bot.id);
    c.services.threads.update(thread.id, { providerId: 'opencode', modelId: 'opencode/glm-5.3-flash-free' });
    runtime.reply = () => 'Hi.';
    c.services.chat.send({ threadId: thread.id, text: 'hi', attachments: [], images: [] }, 'desktop');
    await until(() => c.services.threads.messages(thread.id).some((m) => m.role === 'agent' && m.status === 'complete'));
    expect(runtime.created.at(-1)!.modelId).toBeUndefined();
    expect(c.services.threads.get(thread.id)!.modelId).toBe('opencode/big-pickle');
  });

  it('a failure that isn’t about the model is left as it is', async () => {
    const c = await start();
    const bot = c.services.bots.list()[0]!;
    const thread = c.services.threads.chatFor(bot.id);
    c.services.threads.update(thread.id, { providerId: 'opencode', modelId: 'opencode/beam-free' });
    runtime.reply = () => { throw new Error('Rate limit reached, try again later'); };
    c.services.chat.send({ threadId: thread.id, text: 'hi', attachments: [], images: [] }, 'desktop');
    await until(() => c.services.threads.messages(thread.id).some((m) => m.role === 'agent' && m.status !== 'streaming'));
    expect(c.services.threads.messages(thread.id).find((m) => m.role === 'agent')!.status).toBe('error');
    expect(c.services.threads.get(thread.id)!.modelId).toBe('opencode/beam-free');
    expect(runtime.prompts).toHaveLength(1);
  });
});
