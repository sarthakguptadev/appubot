/**
 * A routine's run in the chat: its prompt names the routine (`Message.routine`), and a run with nothing to say ("✓")
 * notifies nobody, isn't the chat's preview and says so on `message.completed` (`nothingNew`), while a run with news is
 * an ordinary finished turn.
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
let bot: Bot;

const until = async (test: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-routines-fold-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: async () => ({ shown: true }),
    version: '0.0.0-test', hostName: 'Test Mac', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
  });
  await core.start();
  bot = core.services.bots.list()[0]!;
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('a routine’s runs in the chat', () => {
  it('names the routine on its prompt, and a run with nothing to say stays quiet', async () => {
    const thread = core.services.threads.chatFor(bot.id);
    core.services.threads.update(thread.id, { lastMessagePreview: 'Earlier news' });
    const r = core.services.routines.create({ botId: bot.id, name: 'Asana check', prompt: 'Check Asana; answer only ✓ when nothing is new', schedule: '0 9 * * *', enabled: false, deliverTo: 'notify' });
    const notify = vi.spyOn(core.services.notifications, 'notify');
    const completed: Record<string, unknown>[] = [];
    const off = core.ctx.bus.on((e) => { if (e.event === 'message.completed') completed.push(e.payload as Record<string, unknown>); });

    runtime.reply = () => '✓';
    await core.services.routines.run(r.id);
    await until(() => completed.length === 1);
    const msgs = core.services.threads.messages(thread.id);
    expect(msgs.at(-2)).toMatchObject({ role: 'user', via: 'routine', routine: { id: r.id, name: 'Asana check' } });
    expect(completed[0]).toMatchObject({ status: 'complete', nothingNew: true });
    expect(core.services.threads.require(thread.id).lastMessagePreview).toBe('Earlier news');
    expect(notify).not.toHaveBeenCalled();

    // news: an ordinary turn (a notice, the preview, no `nothingNew`)
    runtime.reply = () => 'Anna assigned you “Logo review”';
    await core.services.routines.run(r.id);
    await until(() => completed.length === 2);
    expect(completed[1]!.nothingNew).toBeUndefined();
    expect(core.services.threads.require(thread.id).lastMessagePreview).toBe('Anna assigned you “Logo review”');
    expect(notify).toHaveBeenCalledTimes(1);

    // a message of yours is never folded or quietened, however short its reply
    runtime.reply = () => '✓';
    core.services.chat.send({ threadId: thread.id, text: 'ping', attachments: [], images: [] }, 'desktop');
    await until(() => completed.length === 3);
    expect(completed[2]!.nothingNew).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);
    off();
    notify.mockRestore();
    core.services.routines.delete(r.id);
  });
});
