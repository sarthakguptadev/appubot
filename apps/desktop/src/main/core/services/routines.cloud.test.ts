/**
 * Routines on an AppuBot Cloud computer: the earliest next run is reported (the heartbeat's `nextWakeAt`), a run missed
 * while the computer was down is caught up on start, and while the computer is paused runs are skipped and listed once
 * it is back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { CATCH_UP_MS, previousRunOf } from './routines';

let core: Core;
let runtime: FakeRuntime;
let root: string;
let bot: Bot;
const notified: { title: string; body: string }[] = [];

const until = async (test: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-routines-cloud-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => (runtime = new FakeRuntime(hooks)),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: async (title: string, body: string) => { notified.push({ title, body }); return { shown: true }; },
    version: '0.0.0-test', hostName: 'AppuBot Cloud', log: silentLogger, validate: true, port: 0, quiet: true,
    computerBackends: () => [], helperTransport: () => null,
    cloud: { publicUrl: 'https://ab12cd34ef.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 3 },
  });
  await core.start();
  bot = core.services.bots.list()[0]!;
  runtime.reply = () => 'done';
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('routines on the cloud', () => {
  it('report the earliest next run, and when it changes', () => {
    const seen: (number | undefined)[] = [];
    const off = core.services.routines.onNextRunChange((at) => seen.push(at));
    expect(core.services.routines.nextRunAt()).toBeUndefined();
    const daily = core.services.routines.create({ botId: bot.id, name: 'Daily', prompt: 'Morning brief', schedule: '0 9 * * *', enabled: true, deliverTo: 'thread' });
    const soon = core.services.routines.create({ botId: bot.id, name: 'Soon', prompt: 'Every minute', schedule: '* * * * *', enabled: true, deliverTo: 'thread' });
    const next = core.services.routines.nextRunAt()!;
    expect(next).toBe(soon.nextRunAt);
    expect(next).toBeLessThanOrEqual(daily.nextRunAt!);
    expect(next - Date.now()).toBeLessThanOrEqual(60_000);
    core.services.routines.update(soon.id, { enabled: false });
    expect(core.services.routines.nextRunAt()).toBe(daily.nextRunAt);
    core.services.routines.delete(daily.id);
    core.services.routines.delete(soon.id);
    expect(core.services.routines.nextRunAt()).toBeUndefined();
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.at(-1)).toBeUndefined();
    off();
  });

  it('knows when a schedule last fired', () => {
    const now = new Date(2026, 10, 3, 10, 30, 0);
    expect(previousRunOf('0 9 * * *', now)?.getTime()).toBe(new Date(2026, 10, 3, 9, 0, 0).getTime());
    expect(previousRunOf('*/15 * * * *', now)?.getTime()).toBe(new Date(2026, 10, 3, 10, 15, 0).getTime());
    expect(previousRunOf('not a cron', now)).toBeNull();
  });

  it('catches up a run missed within the last ten minutes on start, once', async () => {
    const r = core.services.routines.create({ botId: bot.id, name: 'Missed', prompt: 'Catch me up', schedule: '*/5 * * * *', enabled: true, deliverTo: 'thread' });
    const before = runtime.prompts.length;
    // started again (a wake): the last */5 minute passed within CATCH_UP_MS and the routine never ran since
    core.services.routines.stop();
    const prev = previousRunOf(r.schedule)!.getTime();
    core.services.routines.start({ catchUp: true, now: Math.min(Date.now(), prev + CATCH_UP_MS - 1) });
    await until(() => runtime.prompts.length > before);
    expect(runtime.prompts.at(-1)!.blocks.some((b) => b.type === 'text' && b.text.includes('Catch me up'))).toBe(true);
    await until(() => (core.services.routines.list().find((x) => x.id === r.id)?.lastRunAt ?? 0) > 0);
    // started once more: it ran since, so nothing
    const after = runtime.prompts.length;
    core.services.routines.stop();
    core.services.routines.start({ catchUp: true });
    await new Promise((res) => setTimeout(res, 50));
    expect(runtime.prompts.length).toBe(after);
    // a Mac never catches up
    core.services.routines.update(r.id, { enabled: true });
    core.services.routines.stop();
    core.services.routines.start({ catchUp: false, now: prev + 1000 });
    await new Promise((res) => setTimeout(res, 50));
    expect(runtime.prompts.length).toBe(after);
    core.services.routines.delete(r.id);
  });

  it('skips runs while the computer is paused and lists them once it is back', async () => {
    const a = core.services.routines.create({ botId: bot.id, name: 'Morning brief', prompt: 'brief', schedule: '0 9 * * *', enabled: true, deliverTo: 'thread' });
    const b = core.services.routines.create({ botId: bot.id, name: 'Inbox sweep', prompt: 'sweep', schedule: '0 18 * * *', enabled: true, deliverTo: 'thread' });
    core.services.system.setCloudState({ state: 'on-hold', resetsAt: Date.now() + 86_400_000 });
    const before = runtime.prompts.length;
    await core.services.routines.run(a.id);
    await core.services.routines.run(b.id);
    await core.services.routines.run(a.id);
    expect(runtime.prompts.length).toBe(before);
    expect(core.services.routines.skippedRuns().map((s) => s.name)).toEqual(['Morning brief', 'Inbox sweep']);
    expect(core.services.routines.list().find((x) => x.id === a.id)!.lastRunAt).toBeUndefined();
    notified.length = 0;
    core.services.system.setCloudState({ state: 'ok' });
    expect(core.services.routines.skippedRuns()).toEqual([]);
    const thread = core.services.threads.chatFor(bot.id);
    const notice = core.services.threads.messages(thread.id).at(-1)!;
    expect(notice.via).toBe('system');
    expect(notice.parts[0]).toMatchObject({ type: 'system', level: 'warning', text: expect.stringMatching(/2 routines didn’t run while your AppuBot computer was paused: “Morning brief”, “Inbox sweep”/) });
    expect(notified.at(-1)).toMatchObject({ title: expect.stringMatching(/Routines paused/) });
    // ok again: a run runs
    await core.services.routines.run(a.id);
    await until(() => runtime.prompts.length === before + 1);
    core.services.routines.delete(a.id);
    core.services.routines.delete(b.id);
  });
});
