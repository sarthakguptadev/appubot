/**
 * A chat's agent session waits for its agent's install (OpenCode on a new computer, Claude Code on a new cloud
 * computer). The chat may move to another agent meanwhile (the free agent taking a new computer's bots over), and the
 * session then opens on the agent the chat is on by then, never the one it had when it started waiting (2026-11-18: a
 * new cloud computer's first thread opened Claude Code, not signed in, after it had moved to OpenCode).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { FreeAgentService } from './freeAgent';

let core: Core | undefined;
let root: string | undefined;
afterEach(async () => {
  await core?.stop();
  core = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});
const until = async (test: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

describe('a session that waited for an install', () => {
  it('opens on the agent the chat moved to while it waited', async () => {
    root = mkdtempSync(join(tmpdir(), 'appubot-session-start-'));
    let runtime!: FakeRuntime;
    let release!: () => void;
    const installed = new Promise<void>((r) => { release = r; });
    core = createCore({
      paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
      runtime: (hooks) => {
        const rt = new FakeRuntime(hooks);
        runtime = rt;
        const get = rt.getProviders.bind(rt);
        rt.getProviders = () => { const list = get(); return list.some((p) => p.id === 'opencode') ? list : [...list, { id: 'opencode', name: 'OpenCode', command: 'fake-opencode', args: ['acp'], env: {}, builtin: true, enabled: true }]; };
        rt.notInstalled.add('opencode');
        rt.reply = () => 'Hi!';
        return rt;
      },
      openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: async () => ({ shown: false }),
      // OpenCode's install takes a while
      freeAgentInstall: async () => { await installed; runtime.notInstalled.delete('opencode'); return { ok: true, output: 'installed', version: '2.3.0' }; },
      version: '2026.11.18', hostName: 'Test', log: silentLogger, validate: true, port: 0, quiet: true,
      computerBackends: () => [], helperTransport: () => null,
    });
    core.services.freeAgent = new FreeAgentService(core.ctx, { retryDelaysMs: [5], laterMs: 60_000 });
    await core.start();
    core.services.settings.update({ onboarded: true });
    const c = core;
    const bot = c.services.bots.list()[0]!;
    const thread = c.services.threads.chatFor(bot.id);
    // the bot and its chat are on OpenCode, which is still being installed: the chat's session waits
    c.services.bots.update(bot.id, { providerId: 'opencode' });
    expect(c.services.threads.get(thread.id)!.providerId).toBe('opencode');
    c.services.chat.send({ threadId: thread.id, text: 'hello', attachments: [], images: [] }, 'desktop');
    await new Promise((r) => setTimeout(r, 50));
    expect(runtime.created).toHaveLength(0);
    // meanwhile the bot (and so its chat) moves to Claude Code
    c.services.bots.update(bot.id, { providerId: 'claude-code' });
    expect(c.services.threads.get(thread.id)!.providerId).toBe('claude-code');
    release();
    await until(() => c.services.threads.messages(thread.id).some((m) => m.role === 'agent' && m.status !== 'streaming'));
    expect(runtime.created.map((o) => o.providerId)).toEqual(['claude-code']);
    expect(c.services.threads.messages(thread.id).find((m) => m.role === 'agent')!.status).toBe('complete');
  });
});
