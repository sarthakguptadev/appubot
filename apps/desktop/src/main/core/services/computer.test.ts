import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerAction, ComputerStatus } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import { FakeRuntime } from '../testing/fakeRuntime';
import { silentLogger } from '../util';
import { NEEDS_WINDOW_HINT, type ActOptions, type ComputerBackend } from './computer';

let core: Core;
let root: string;
const acted: ComputerAction[] = [];
const opts: (ActOptions | undefined)[] = [];
const raised: string[] = [];
let front = false;
/** background mode: what a borrowed step did (noted where the user is, sent, put them back), and where the cursor was asked to show */
const borrowed: string[] = [];
const seen: ({ x: number; y: number } | undefined)[] = [];

/** A backend that only records what reaches it. */
const backend: ComputerBackend = {
  name: 'native',
  init: async () => undefined,
  permissions: async () => ({ accessibility: true, screenRecording: true }),
  requestPermissions: async () => undefined,
  screenSize: async () => ({ width: 1440, height: 900, scale: 2 }),
  screenshot: async () => ({ data: '', mimeType: 'image/png', width: 1440, height: 900 }),
  act: async (a, o) => {
    acted.push(a); opts.push(o);
    if (a.type === 'type' && a.text === 'boom') throw new Error('the field is gone');
    // like the Cua backend: a page click, a drag or a step asked for in front borrows the screen
    if (o?.borrow && (o.web || a.front || a.type === 'drag')) return o.borrow(async () => { borrowed.push(`sent ${a.type}`); return { text: 'ok' }; });
    return a.type === 'open_app' ? { text: 'Opened.', opened: { pid: 43, windowId: 9 } } : { text: 'ok' };
  },
  /** pid 42 is a browser (its page from y 100 down), pid 43 a native app */
  windowSnapshot: async ({ pid, windowId }) => ({
    shot: { data: '', mimeType: 'image/png', width: 1000, height: 800 },
    geometry: {
      target: { pid, windowId, app: pid === 42 ? 'Safari' : 'Notes', bounds: { x: 100, y: 50, width: 500, height: 400 } },
      shotWidth: 1000, shotHeight: 800, snapshotId: 's1',
      // Notes has a "Save" button and a "7" key (and a closed menu's "Save" item with no place in the picture)
      elements: new Map(pid === 42 ? [] : [
        ['s1:2', { px: { x: -5, y: -5 }, pt: { x: 0, y: 0 }, role: 'AXMenuItem', label: 'Save' }],
        ['s1:3', { px: { x: 300, y: 200 }, pt: { x: 250, y: 150 }, role: 'AXButton', label: 'Save' }],
        ['s1:5', { px: { x: 600, y: 400 }, pt: { x: 400, y: 250 }, role: 'AXButton', label: '7' }],
      ]),
      web: pid === 42 ? [{ x: 0, y: 100, w: 1000, h: 700 }] : [], browser: pid === 42,
    },
    text: 'snapshot',
  }),
  windowShot: async ({ pid, windowId }) => ({ shot: { data: '', mimeType: 'image/png', width: 1000, height: 800 }, target: { pid, windowId, bounds: { x: 100, y: 50, width: 500, height: 400 } } }),
  raise: async (pid, windowId) => { raised.push(`${pid}:${windowId}`); },
  isFront: async () => front,
  visibleAt: async (_pid, _w, pt) => { seen.push(pt); return false; },
  userPlace: async () => { borrowed.push('noted'); return { restore: async () => { borrowed.push('restored'); } }; },
  shutdown: async () => undefined,
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'appubot-computer-'));
  core = createCore({
    paths: { dataDir: join(root, 'data'), botsRoot: join(root, 'bots'), filesDir: join(root, 'data', 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined, openTerminal: () => undefined, nativeNotify: () => undefined,
    version: '0.0.0-test', hostName: 'test-mac', log: silentLogger, validate: true, port: 0, host: '127.0.0.1', quiet: true,
    computerBackends: () => [backend], helperTransport: () => null,
  });
  await core.start();
  core.services.computer.settleMs = 0;
});

afterAll(async () => {
  await core.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('computer use', () => {
  it('asks a bot to look at a window before pointing at it', async () => {
    expect(await core.services.computer.act({ type: 'click', pid: 44, windowId: 1, x: 5, y: 5 }, 'thr_bot')).toEqual({ ok: false, text: expect.stringContaining('computer_window') });
    expect(acted).toEqual([]);
  });

  it("marks a click on a page as web content (real input), and a native app's as not", async () => {
    for (const pid of [42, 43]) expect((await core.services.computer.act({ type: 'window', pid, windowId: 7 }, 'thr_bot')).ok).toBe(true);
    opts.length = 0;
    await core.services.computer.act({ type: 'click', pid: 42, windowId: 7, x: 500, y: 400 }, 'thr_bot');
    await core.services.computer.act({ type: 'click', pid: 42, windowId: 7, x: 500, y: 50 }, 'thr_bot'); // the toolbar
    await core.services.computer.act({ type: 'click', pid: 43, windowId: 7, x: 500, y: 400 }, 'thr_bot');
    expect(opts.map((o) => o?.web)).toEqual([true, false, false]);
    // the point in screen points, from the snapshot's window bounds
    expect(opts[0]?.pt).toEqual({ x: 350, y: 250 });
    acted.length = 0;
  });

  it('only raises a window that is not already in front', async () => {
    raised.length = 0;
    front = true;
    await core.services.computer.act({ type: 'key', key: 'enter', pid: 43, windowId: 7 }, 'thr_bot');
    expect(raised).toEqual([]);
    front = false;
    await core.services.computer.act({ type: 'key', key: 'enter', pid: 43, windowId: 7 }, 'thr_bot');
    expect(raised).toEqual(['43:7']);
    acted.length = 0;
  });

  it('runs a batch: labels and element numbers become points, steps share the window, one look at the end', async () => {
    acted.length = 0;
    opts.length = 0;
    const r = await core.services.computer.batch([
      { type: 'click', pid: 43, windowId: 8, label: 'save' },
      { type: 'click', element: '5' },
      { type: 'type', text: 'milk' },
      { type: 'key', key: 'enter' },
    ], 'window', 'thr_bot');
    expect(r).toMatchObject({ ok: true, done: 4, frame: expect.objectContaining({ target: expect.objectContaining({ pid: 43, windowId: 8 }) }) });
    expect(r.text).toContain('Did all 4 steps');
    expect(r.text).toContain('snapshot'); // the window's elements at the end
    expect(acted.map((a) => [a.type, a.pid, a.windowId, a.x, a.y])).toEqual([
      ['click', 43, 8, 300, 200], // the button, not the menu item
      ['click', 43, 8, 600, 400],
      ['type', 43, 8, undefined, undefined],
      ['key', 43, 8, undefined, undefined],
    ]);
    // on-screen mode: keys may go to the window as real keystrokes while it is in front
    expect(opts.every((o) => o?.front === true)).toBe(true);
  });

  it('stops a batch at the first failing step, and says which labels there are', async () => {
    acted.length = 0;
    const r = await core.services.computer.batch([{ type: 'type', pid: 43, windowId: 8, text: 'boom' }, { type: 'key', key: 'enter' }], 'none', 'thr_bot');
    expect(r).toMatchObject({ ok: false, done: 0, frame: undefined });
    expect(r.text).toContain('the field is gone');
    expect(acted.map((a) => a.type)).toEqual(['type']);
    const miss = await core.services.computer.batch([{ type: 'click', pid: 43, windowId: 8, label: 'Delete' }], 'none', 'thr_bot');
    expect(miss.text).toContain('Nothing labelled "Delete"');
    expect(miss.text).toContain('"Save"');
  });

  it('works in the window an open_app step opened', async () => {
    acted.length = 0;
    const r = await core.services.computer.batch([{ type: 'open_app', app: 'Notes' }, { type: 'click', label: '7' }], 'picture', 'thr_bot');
    expect(r).toMatchObject({ ok: true, done: 2 });
    expect(r.text).toContain('pid 43, window_id 9');
    expect(acted[1]).toMatchObject({ type: 'click', pid: 43, windowId: 9, x: 600, y: 400 });
  });

  it('returns the window of an app it opens, ready to act on', async () => {
    const r = await core.services.computer.act({ type: 'open_app', app: 'Notes' }, 'thr_bot');
    expect(r.frame?.target).toMatchObject({ pid: 43, windowId: 9 });
    expect(r.text).toContain('snapshot');
    acted.length = 0;
  });

  it("passes a bot's drag on an app window to the backend (the one action that borrows the user's pointer)", async () => {
    const drag: ComputerAction = { type: 'drag', pid: 42, windowId: 7, x: 10, y: 10, toX: 200, toY: 120 };
    expect((await core.services.computer.act(drag, 'thr_bot')).ok).toBe(true);
    expect(acted).toEqual([expect.objectContaining({ type: 'drag', pid: 42, windowId: 7 })]);
  });

  it("refuses a bot's whole-screen drag, and still lets the user's own take-over drag on the screen", async () => {
    acted.length = 0;
    const drag: ComputerAction = { type: 'drag', x: 10, y: 10, toX: 200, toY: 120 };
    expect(await core.services.computer.act(drag, 'thr_bot')).toEqual({ ok: false, text: NEEDS_WINDOW_HINT });
    expect(acted).toEqual([]);
    expect((await core.services.computer.act(drag)).ok).toBe(true);
    expect(acted.map((a) => a.type)).toEqual(['drag']);
  });
});

describe('computer use in the background', () => {
  const statuses: ComputerStatus[] = [];
  let off: () => void = () => undefined;
  const page: ComputerAction = { type: 'click', pid: 42, windowId: 7, x: 500, y: 400 };
  const setBackground = (background: boolean) => core.services.settings.update({ computer: { ...core.services.settings.get().computer, background } });
  /** past the last borrowed step's own input, which the system's idle time may still show */
  const later = () => new Promise((r) => setTimeout(r, 200));

  beforeAll(async () => {
    off = core.ctx.bus.on((e) => { if (e.event === 'computer.status') statuses.push(e.payload as ComputerStatus); });
    statuses.length = 0;
    setBackground(true);
    for (const pid of [42, 43]) expect((await core.services.computer.act({ type: 'window', pid, windowId: 7 }, 'thr_bg')).ok).toBe(true);
  });
  afterAll(() => {
    off();
    setBackground(false);
    core.services.computer.idleMs = null;
    core.services.computer.pauseWaitMs = null;
  });

  it('says so in the status, leaves windows where they are and keeps keys in the background', async () => {
    expect(statuses.some((st) => st.background)).toBe(true);
    expect(core.services.computer.status().background).toBe(true);
    raised.length = 0; opts.length = 0;
    front = false;
    expect((await core.services.computer.act({ type: 'key', key: 'enter', pid: 43, windowId: 7 }, 'thr_bg')).ok).toBe(true);
    expect(raised).toEqual([]);
    expect(opts[0]).toMatchObject({ front: false, borrow: expect.any(Function) });
  });

  it('tells the bot once per turn', async () => {
    const first = await core.services.computer.act({ type: 'key', key: 'tab', pid: 43, windowId: 7 }, 'thr_note');
    const next = await core.services.computer.act({ type: 'key', key: 'tab', pid: 43, windowId: 7 }, 'thr_note');
    expect(first.text).toContain('Background mode');
    expect(next.text).not.toContain('Background mode');
  });

  it('waits until the user pauses before a step that needs its window in front, then puts them back', async () => {
    const idle = [100, 400, 1600];
    core.services.computer.idleMs = () => idle.shift() ?? 5000;
    borrowed.length = 0; statuses.length = 0;
    const t0 = Date.now();
    const r = await core.services.computer.act(page, 'thr_bg');
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(borrowed).toEqual(['noted', 'sent click', 'restored']);
    // the app and the tray hear that it waits, and when it stops
    expect(statuses.find((st) => st.waiting)?.waiting).toMatchObject({ threadId: 'thr_bg', app: 'Safari' });
    expect(statuses.at(-1)?.waiting).toBeUndefined();
  });

  it("doesn't take its own input for the user's", async () => {
    // the first look finds the user away; then the system's latest input is the step's own click
    const idle = [5000, 10];
    core.services.computer.idleMs = () => idle.shift() ?? 10;
    borrowed.length = 0; statuses.length = 0;
    const r = await core.services.computer.batch([page, { ...page, y: 450 }], 'none', 'thr_bg');
    expect(r).toMatchObject({ ok: true, done: 2 });
    expect(borrowed.filter((b) => b.startsWith('sent'))).toHaveLength(2);
    expect(statuses.some((st) => st.waiting)).toBe(false);
  });

  it("gives up on the step rather than interrupt a user who doesn't pause", async () => {
    core.services.computer.idleMs = () => 0;
    core.services.computer.pauseWaitMs = 300;
    borrowed.length = 0;
    await later();
    const r = await core.services.computer.act({ type: 'drag', pid: 42, windowId: 7, x: 10, y: 10, toX: 200, toY: 120 }, 'thr_bg');
    expect(r).toMatchObject({ ok: false, text: expect.stringContaining('nothing was sent') });
    expect(borrowed).toEqual([]);
    core.services.computer.pauseWaitMs = null;
  });

  it('stops waiting when the user pauses computer use', async () => {
    core.services.computer.idleMs = () => 0;
    await later();
    setTimeout(() => core.services.computer.pause(), 100);
    const r = await core.services.computer.act(page, 'thr_bg');
    core.services.computer.resume();
    expect(r).toMatchObject({ ok: false, text: expect.stringContaining('paused') });
  });

  it("won't type into the app in front, which is the user's", async () => {
    acted.length = 0;
    const r = await core.services.computer.act({ type: 'type', text: 'hello' }, 'thr_bg');
    expect(r).toMatchObject({ ok: false, text: expect.stringContaining('pid and window_id') });
    expect(acted).toEqual([]);
  });

  it("only draws the bot's cursor where its window shows", async () => {
    core.services.computer.idleMs = () => 5000;
    seen.length = 0;
    await core.services.computer.act(page, 'thr_bg');
    expect(seen).toEqual([{ x: 350, y: 250 }]);
  });
});
