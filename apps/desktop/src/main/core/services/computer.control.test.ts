/**
 * Live view's Take control, from the bots' side (ComputerService.gate): a bot's computer step waits while a person
 * has control (the status says so: `waits`), a batch stops when control is taken mid-way, and on your AppuBot
 * computer (`deps.cloud`) bots take turns on the one real screen (`screenThreadId`), always on screen and with real
 * input (no background mode there). A Mac keeps its own delivery (background mode, no turns).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerAction } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import type { ActOptions, ComputerBackend } from './computer';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await wait(10); }
}

function backend(log: { a: ComputerAction; o?: ActOptions }[], onAct?: (a: ComputerAction) => void): ComputerBackend {
  return {
    name: 'cua-driver',
    init: async () => undefined,
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    requestPermissions: async () => undefined,
    screenSize: async () => ({ width: 1440, height: 900, scale: 1 }),
    screenshot: async () => ({ data: '', mimeType: 'image/png', width: 1440, height: 900 }),
    act: async (a, o) => { log.push({ a, o }); onAct?.(a); return { text: 'ok' }; },
    shutdown: async () => undefined,
  };
}

function makeCore(root: string, b: ComputerBackend, cloud: boolean): Core {
  return createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: cloud ? 'AppuBot Cloud' : 'test-mac', log: silentLogger, validate: true, port: 0, host: '127.0.0.1', quiet: true,
    computerBackends: () => [b], helperTransport: () => null,
    ...(cloud ? { cloud: { publicUrl: 'https://ab12cd34ef.agent37.app', controlToken: 'ctl', backendUrl: 'https://cloud.test', backendToken: 'bk', maxLiveSessions: 1 } } : {}),
  });
}

describe('Take control on a Mac', () => {
  let core: Core;
  let root: string;
  const log: { a: ComputerAction; o?: ActOptions }[] = [];
  const grab = () => core.services.computer.takeControl({ key: 'conn:7', name: 'Sam’s iPhone', via: 'live' });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appubot-control-'));
    core = makeCore(root, backend(log, (a) => { if (a.type === 'type' && a.text === 'grab') grab(); }), false);
    await core.start();
    core.services.computer.settleMs = 0;
  });
  afterAll(async () => { await core.stop(); rmSync(root, { recursive: true, force: true }); });

  it('says who has control in the status, refuses a second person, and lets the holder renew and give it back', () => {
    const c = core.services.computer;
    expect(c.status()).toMatchObject({ takeControl: true });
    expect(c.status().control).toBeUndefined();
    const held = grab();
    expect(c.status().control).toMatchObject({ id: held.id, name: 'Sam’s iPhone', via: 'live' });
    expect(() => c.takeControl({ key: 'conn:8', name: 'Ada’s Mac', via: 'live' })).toThrow(/Sam’s iPhone is in control/);
    expect(grab().id).toBe(held.id);
    expect(c.touchControl('conn:8')).toBe(false);
    expect(c.releaseControl('conn:8')).toBe(false);
    expect(c.releaseControl('conn:7')).toBe(true);
    expect(c.status().control).toBeUndefined();
  });

  it('holds a bot’s step while a person has control, says so, then carries on and tells the bot', async () => {
    const c = core.services.computer;
    grab();
    const before = log.length;
    const step = c.act({ type: 'key', key: 'enter' }, 'thr_a');
    await until(() => !!c.status().waits?.length);
    expect(c.status().waits).toEqual([{ threadId: 'thr_a', for: 'control', since: expect.any(Number) }]);
    await wait(100);
    expect(log.length).toBe(before);
    c.releaseControl('conn:7');
    const r = await step;
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^\(Waited \d+ s while Sam’s iPhone had control of the screen/);
    expect(c.status().waits).toBeUndefined();
    // the person's own hand isn't held back (no thread)
    grab();
    expect((await c.act({ type: 'key', key: 'a' })).ok).toBe(true);
    c.releaseControl('conn:7');
  });

  it('gives up after its wait, telling the bot who has the screen', async () => {
    const c = core.services.computer;
    grab();
    c.controlWaitMs = 50;
    await expect(c.act({ type: 'key', key: 'enter' }, 'thr_b')).rejects.toMatchObject({ code: 'in_control', message: expect.stringContaining('Sam’s iPhone still has control') });
    c.controlWaitMs = null;
    c.releaseControl('conn:7');
  });

  it('stops a batch when a person takes control in the middle of it', async () => {
    const c = core.services.computer;
    const r = await c.batch([{ type: 'type', text: 'grab' }, { type: 'key', key: 'enter' }], 'none', 'thr_c');
    expect(r).toMatchObject({ ok: false, done: 1 });
    expect(r.text).toContain('2. Stopped: Sam’s iPhone took control of the screen');
    c.releaseControl('conn:7');
  });

  it('keeps the Mac’s own ways: no turns on the screen, no real-input flag, background mode as set', async () => {
    const c = core.services.computer;
    await c.act({ type: 'key', key: 'x' }, 'thr_d');
    expect(c.status().screenThreadId).toBeUndefined();
    expect(c.status().onScreenOnly).toBeUndefined();
    expect(log.at(-1)!.o).not.toHaveProperty('real');
    core.services.settings.update({ computer: { ...core.services.settings.get().computer, background: true } });
    expect(c.status().background).toBe(true);
    core.services.settings.update({ computer: { ...core.services.settings.get().computer, background: false } });
  });
});

describe('the bots’ own screen (your AppuBot computer)', () => {
  let core: Core;
  let root: string;
  const log: { a: ComputerAction; o?: ActOptions }[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'appubot-control-cloud-'));
    core = makeCore(root, backend(log), true);
    await core.start();
    core.services.computer.settleMs = 0;
  });
  afterAll(async () => { await core.stop(); rmSync(root, { recursive: true, force: true }); });

  it('always works on screen with real input, whatever the background setting says', async () => {
    const c = core.services.computer;
    core.services.settings.update({ computer: { ...core.services.settings.get().computer, background: true } });
    expect(c.status()).toMatchObject({ onScreenOnly: true, background: false });
    await c.act({ type: 'key', key: 'enter', pid: 1, windowId: 2 }, 'thr_1');
    expect(log.at(-1)!.o).toMatchObject({ real: true, front: true });
    expect(log.at(-1)!.o).not.toHaveProperty('borrow');
  });

  it('gives the screen to one bot at a time: another waits for its turn, and gets it once the first stops using it', async () => {
    const c = core.services.computer;
    c.screenIdleMs = 400;
    await c.act({ type: 'key', key: 'a' }, 'thr_1');
    expect(c.status().screenThreadId).toBe('thr_1');
    const n = log.length;
    const other = c.act({ type: 'key', key: 'b' }, 'thr_2');
    await until(() => !!c.status().waits?.length);
    expect(c.status().waits).toEqual([{ threadId: 'thr_2', for: 'screen', since: expect.any(Number), holder: 'thr_1' }]);
    // the first keeps going meanwhile
    await c.act({ type: 'key', key: 'c' }, 'thr_1');
    expect(log.length).toBe(n + 1);
    const r = await other;
    expect(r.text).toMatch(/\(Waited \d+ s for the screen while/);
    expect(c.status().screenThreadId).toBe('thr_2');
    c.screenIdleMs = null;
  });

  it('gives up waiting for its turn after a while', async () => {
    const c = core.services.computer;
    c.screenWaitMs = 50;
    await expect(c.act({ type: 'key', key: 'd' }, 'thr_3')).rejects.toMatchObject({ code: 'screen_busy' });
    c.screenWaitMs = null;
  });
});
