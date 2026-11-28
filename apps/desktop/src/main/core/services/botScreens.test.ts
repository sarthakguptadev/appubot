/**
 * Every bot's own screen on your AppuBot computer (`botScreens.ts`): bots with a screen each act at the same time
 * without waiting for each other, there is no cap on how many, Take control holds one screen only, a screen that
 * can't start leaves its bot on the computer's own screen for the rest of that turn, an unused screen sleeps after
 * a while (not while watched) and wakes with the next step, and a deleted bot's screen goes for good. A host-less
 * computer (a Mac) keeps the one screen.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerAction } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import type { BotScreenHost } from './botScreens';
import type { ComputerBackend } from './computer';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await wait(10); }
}

/** what reached which screen ('shared' or a bot's id), and the acts in flight at once */
interface World { acts: { screen: string; a: ComputerAction }[]; inFlight: number; most: number; hold: number }

function backend(world: World, screen: string): ComputerBackend {
  return {
    name: 'cua-driver',
    init: async () => undefined,
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    requestPermissions: async () => undefined,
    screenSize: async () => ({ width: 1440, height: 900, scale: 1 }),
    screenshot: async () => ({ data: '', mimeType: 'image/png', width: 1440, height: 900 }),
    act: async (a) => {
      world.inFlight++;
      world.most = Math.max(world.most, world.inFlight);
      world.acts.push({ screen, a });
      await wait(world.hold);
      world.inFlight--;
      return { text: 'ok' };
    },
    shutdown: async () => undefined,
  };
}

function fakeHost(): BotScreenHost & { opened: string[]; closed: { botId: string; forget: boolean }[]; watching: Set<string>; failing: Set<string> } {
  const h = {
    opened: [] as string[],
    closed: [] as { botId: string; forget: boolean }[],
    watching: new Set<string>(),
    /** bots whose screen fails to start (say the memory ran out) */
    failing: new Set<string>(),
    open: async (botId: string) => {
      if (h.failing.has(botId)) throw new Error('Xvnc exited (1)');
      h.opened.push(botId);
      return { importCua: async () => ({}) };
    },
    close: async (botId: string, o: { forget: boolean }) => { h.closed.push({ botId, ...o }); },
    watched: (botId: string) => h.watching.has(botId),
  };
  return h;
}

let core: Core | undefined;
let root: string | undefined;
afterEach(async () => {
  await core?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
  core = undefined;
});

async function start(world: World, host?: BotScreenHost): Promise<Core> {
  root = mkdtempSync(join(tmpdir(), 'appubot-screens-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'AppuBot Cloud', log: silentLogger, validate: true, port: 0, host: '127.0.0.1', quiet: true,
    computerBackends: (screen) => [backend(world, screen ?? 'shared')], helperTransport: () => null,
    cloud: { publicUrl: 'https://ab12cd34ef.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 1 },
    ...(host ? { botScreens: host } : {}),
  });
  await core.start();
  core.services.computer.settleMs = 0;
  return core;
}

/** a bot and a chat of its */
function botWithThread(c: Core, name: string): { botId: string; threadId: string } {
  const s = c.services;
  const bot = s.bots.create({ name, providerId: s.bots.list()[0]!.providerId, computerUse: true });
  return { botId: bot.id, threadId: s.threads.create({ botId: bot.id }).id };
}

/** what the chat says when a turn ends */
function endTurn(c: Core, threadId: string): void {
  for (const l of (c.services.chat as unknown as { completedListeners: Set<(e: unknown) => void> }).completedListeners) l({ threadId, botId: '', ok: true, message: { id: `msg_${threadId}` } });
}

const act = async (c: Core, threadId: string, key: string) => (await c.services.screens.forThread(threadId)).act({ type: 'key', key }, threadId);

describe('bots’ own screens', () => {
  it('gives two bots a screen each, and they act at the same time without waiting for each other', async () => {
    const world: World = { acts: [], inFlight: 0, most: 0, hold: 150 };
    const host = fakeHost();
    const c = await start(world, host);
    const ada = botWithThread(c, 'Ada');
    const bo = botWithThread(c, 'Bo');
    const [a, b] = await Promise.all([act(c, ada.threadId, 'a'), act(c, bo.threadId, 'b')]);
    expect(a.ok && b.ok).toBe(true);
    expect(a.text).not.toMatch(/Waited/);
    expect(b.text).not.toMatch(/Waited/);
    expect(world.most).toBe(2);
    expect(world.acts.map((x) => x.screen).sort()).toEqual([ada.botId, bo.botId].sort());
    expect(host.opened.sort()).toEqual([ada.botId, bo.botId].sort());
    const st = c.services.computer.status();
    expect(st.screens?.map((x) => [x.botId, x.state]).sort()).toEqual([[ada.botId, 'on'], [bo.botId, 'on']].sort());
    // the computer's own screen saw none of it, and nobody holds it
    expect(st.screenThreadId).toBeUndefined();
  });

  it('holds only the screen someone took control of', async () => {
    const world: World = { acts: [], inFlight: 0, most: 0, hold: 0 };
    const c = await start(world, fakeHost());
    const ada = botWithThread(c, 'Ada');
    const bo = botWithThread(c, 'Bo');
    await act(c, ada.threadId, 'a');
    await act(c, bo.threadId, 'b');
    const adaScreen = c.services.screens.get(ada.botId)!;
    adaScreen.takeControl({ key: 'vnc:1', name: 'Sam', via: 'desktop' });
    expect(c.services.computer.status().screens?.find((x) => x.botId === ada.botId)?.control).toMatchObject({ name: 'Sam' });
    const held = act(c, ada.threadId, 'c');
    await until(() => !!c.services.computer.status().screens?.find((x) => x.botId === ada.botId)?.waits?.length);
    // Bo's screen is its own: no wait
    expect((await act(c, bo.threadId, 'd')).text).not.toMatch(/Waited/);
    adaScreen.releaseControl('vnc:1');
    expect((await held).text).toMatch(/Waited \d+ s while Sam had control/);
  });

  it('gives every bot a screen of its own, however many there are', async () => {
    const world: World = { acts: [], inFlight: 0, most: 0, hold: 100 };
    const host = fakeHost();
    const c = await start(world, host);
    const bots = Array.from({ length: 12 }, (_, i) => botWithThread(c, 'Bot ' + i));
    await Promise.all(bots.map((b, i) => act(c, b.threadId, String(i))));
    expect(world.most).toBe(12);
    expect(world.acts.map((x) => x.screen).sort()).toEqual(bots.map((b) => b.botId).sort());
    expect(host.closed).toEqual([]);
    expect(c.services.computer.status().screens?.filter((x) => x.state === 'on')).toHaveLength(12);
  });

  it('a screen that can’t start leaves its bot on the computer’s own screen for that turn, then tries again', async () => {
    const world: World = { acts: [], inFlight: 0, most: 0, hold: 0 };
    const host = fakeHost();
    const c = await start(world, host);
    const ada = botWithThread(c, 'Ada');
    host.failing.add(ada.botId);
    const r = await act(c, ada.threadId, 'a');
    expect(r.ok).toBe(true);
    expect(world.acts.map((x) => x.screen)).toEqual(['shared']);
    expect(c.services.computer.status().screenThreadId).toBe(ada.threadId);
    // the rest of the turn stays where its windows are, even once a screen could start
    host.failing.clear();
    await act(c, ada.threadId, 'b');
    expect(world.acts.at(-1)!.screen).toBe('shared');
    endTurn(c, ada.threadId);
    await act(c, ada.threadId, 'c');
    expect(world.acts.at(-1)!.screen).toBe(ada.botId);
    expect(c.services.computer.status().screens).toEqual([expect.objectContaining({ botId: ada.botId, state: 'on' })]);
  });

  it('sleeps a screen unused for a while (not while watched), and wakes it with the next step', async () => {
    const world: World = { acts: [], inFlight: 0, most: 0, hold: 0 };
    const host = fakeHost();
    const c = await start(world, host);
    const ada = botWithThread(c, 'Ada');
    await act(c, ada.threadId, 'a');
    endTurn(c, ada.threadId);
    const screens = c.services.screens;
    screens.sleepMs = 1000;
    host.watching.add(ada.botId);
    await screens.sweep(Date.now() + 5000);
    expect(screens.get(ada.botId)).toBeDefined();
    host.watching.clear();
    await screens.sweep(Date.now() + 10_000);
    expect(screens.get(ada.botId)).toBeUndefined();
    expect(c.services.computer.status().screens).toEqual([{ botId: ada.botId, state: 'asleep', busy: false }]);
    await act(c, ada.threadId, 'b');
    expect(world.acts.at(-1)!.screen).toBe(ada.botId);
    expect(host.opened).toEqual([ada.botId, ada.botId]);
  });

  it('removes a deleted bot’s screen for good', async () => {
    const world: World = { acts: [], inFlight: 0, most: 0, hold: 0 };
    const host = fakeHost();
    const c = await start(world, host);
    const ada = botWithThread(c, 'Ada');
    await act(c, ada.threadId, 'a');
    await c.services.bots.delete(ada.botId, false);
    await until(() => host.closed.some((x) => x.forget));
    expect(host.closed).toEqual([{ botId: ada.botId, forget: true }]);
    expect(c.services.computer.status().screens).toEqual([]);
  });

  it('keeps one screen where the computer offers none (a Mac)', async () => {
    const world: World = { acts: [], inFlight: 0, most: 0, hold: 0 };
    const c = await start(world);
    const ada = botWithThread(c, 'Ada');
    await act(c, ada.threadId, 'a');
    expect(world.acts.map((x) => x.screen)).toEqual(['shared']);
    expect(c.services.computer.status().screens).toBeUndefined();
  });
});
