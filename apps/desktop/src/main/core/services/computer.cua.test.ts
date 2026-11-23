import { describe, expect, it } from 'vitest';
import type { ComputerAction } from '@appubot/protocol';
import { silentLogger } from '../util';
import { CuaBackend, findLabel, isWeb, shownText, type Borrow, type WindowGeometry } from './computer';

type Call = { name: string; args: Record<string, unknown> };
interface Res { text: string; images: { mimeType: string; dataBase64: string }[]; isError: boolean; structuredJson?: string; errorCode?: string }
const ok = (structured?: unknown, text = 'ok'): Res => ({ text, images: [], isError: false, structuredJson: structured === undefined ? undefined : JSON.stringify(structured) });

/** A Cua driver that records calls; `on` answers per tool. The backend is the Mac's (computer.platform.test.ts has the others). */
function fakeCua(on: Record<string, (args: Record<string, unknown>) => Res> = {}, quick: Partial<ConstructorParameters<typeof CuaBackend>[0]> = {}) {
  const calls: Call[] = [];
  const driver = {
    callTool: async (name: string, json: string) => {
      const args = JSON.parse(json) as Record<string, unknown>;
      calls.push({ name, args });
      if (on[name]) return on[name]!(args);
      if (name === 'check_permissions') return ok({ accessibility: true, screen_recording: true });
      if (name === 'get_screen_size') return ok({ width: 1440, height: 900, scale_factor: 2 });
      return ok({});
    },
    shutdown: async () => undefined,
  };
  const backend = new CuaBackend({ log: silentLogger, defaultDim: () => 2048, load: async () => ({ CuaDriver: { create: () => driver } }), os: 'darwin', ...quick });
  return { backend, calls };
}

const win = (pid: number, window_id: number, z: number, bounds = { x: 0, y: 0, width: 1000, height: 800 }) => ({ pid, window_id, z_index: z, layer: 0, is_on_screen: true, bounds });
const click: ComputerAction = { type: 'click', pid: 42, windowId: 7, x: 400, y: 300 };

describe('Cua backend', () => {
  it('clicks web content for real when the window is on top at the point, and puts the pointer back', async () => {
    const { backend, calls } = fakeCua({
      list_windows: () => ok({ windows: [win(9, 1, 10), win(42, 7, 50)] }),
      get_cursor_position: () => ok({ x: 100, y: 50 }),
      click: () => ok({ route: 'global_input', effect: 'unverifiable' }, '✅ Sent screen-absolute click'),
    });
    await backend.init();
    await backend.screenSize();
    expect(await backend.act(click, { desktop: false, web: true, pt: { x: 200, y: 150 } })).toEqual({ text: 'Clicked.' });
    const sent = calls.filter((c) => c.name === 'click' || c.name === 'move_cursor');
    expect(sent).toEqual([
      { name: 'click', args: { x: 400, y: 300, button: 'left', count: 1, scope: 'desktop' } },
      { name: 'move_cursor', args: { x: 200, y: 100, scope: 'desktop' } },
    ]);
  });

  it('falls back to foreground delivery when another window covers the point', async () => {
    const { backend, calls } = fakeCua({ list_windows: () => ok({ windows: [win(9, 1, 80), win(42, 7, 50)] }) });
    await backend.init();
    await backend.act(click, { desktop: false, web: true, pt: { x: 200, y: 150 } });
    expect(calls.find((c) => c.name === 'click')?.args).toMatchObject({ pid: 42, window_id: 7, x: 400, y: 300, delivery_mode: 'foreground' });
  });

  it('keeps native apps on background delivery', async () => {
    const { backend, calls } = fakeCua();
    await backend.init();
    await backend.act(click, { desktop: false, web: false, pt: { x: 200, y: 150 } });
    expect(calls.find((c) => c.name === 'click')?.args).toMatchObject({ pid: 42, window_id: 7, delivery_mode: 'background' });
    expect(calls.some((c) => c.name === 'list_windows')).toBe(false);
  });

  it('sends the rest of a text Cua only partly typed', async () => {
    let n = 0;
    const { backend, calls } = fakeCua({
      type_text: (a) => (n++ === 0 ? { text: `type_text incomplete: delivered 4 of ${String(a.text).length} character(s) via CGEvent`, images: [], isError: true } : ok({}, 'typed')),
    });
    await backend.init();
    await backend.act({ type: 'type', pid: 42, windowId: 7, text: 'thums up 750 ml' }, { desktop: false });
    expect(calls.filter((c) => c.name === 'type_text').map((c) => c.args.text)).toEqual(['thums up 750 ml', 's up 750 ml']);
  });

  it('types into web content with real keystrokes when its window is in front', async () => {
    const { backend, calls } = fakeCua({ list_windows: () => ok({ windows: [win(42, 7, 50)] }) });
    await backend.init();
    await backend.act({ type: 'type', pid: 42, windowId: 7, text: 'lays' }, { desktop: false, web: true });
    expect(calls.find((c) => c.name === 'type_text')?.args).toEqual({ text: 'lays', scope: 'desktop', delay_ms: 5 });
  });

  it('sends keys as real keystrokes to a window in front (typing goes to the AX insert), and in the background otherwise', async () => {
    let top = 42;
    const { backend, calls } = fakeCua({ list_windows: () => ok({ windows: [win(top, 7, 50)] }) });
    await backend.init();
    await backend.act({ type: 'key', key: 'cmd+b', pid: 42, windowId: 7 }, { desktop: false, front: true });
    await backend.act({ type: 'key', key: 'enter', pid: 42, windowId: 7 }, { desktop: false, front: true });
    await backend.act({ type: 'type', text: 'milk', pid: 42, windowId: 7 }, { desktop: false, front: true });
    await backend.act({ type: 'key', key: 'enter', pid: 42, windowId: 7 }, { desktop: false }); // background mode
    top = 9;
    await new Promise((r) => setTimeout(r, 300)); // the on-screen window list is reused for a quarter second
    await backend.act({ type: 'key', key: 'enter', pid: 42, windowId: 7 }, { desktop: false, front: true }); // another window came forward
    expect(calls.filter((c) => ['hotkey', 'press_key', 'type_text'].includes(c.name))).toEqual([
      { name: 'hotkey', args: { keys: ['cmd', 'b'], scope: 'desktop' } },
      { name: 'press_key', args: { key: 'enter', scope: 'desktop' } },
      { name: 'type_text', args: { text: 'milk', pid: 42, window_id: 7, delivery_mode: 'background' } },
      { name: 'press_key', args: { key: 'enter', pid: 42, window_id: 7, delivery_mode: 'background' } },
      { name: 'press_key', args: { key: 'enter', pid: 42, window_id: 7, delivery_mode: 'background' } },
    ]);
  });

  it('opens and fronts apps through the quick path, and finds the window to work in', async () => {
    const launched: unknown[] = [];
    const raised: string[] = [];
    const { backend, calls } = fakeCua(
      { list_windows: () => ok({ windows: [{ pid: 77, window_id: 5, title: 'Calculator', is_on_screen: true, layer: 0, bounds: { width: 230, height: 408 } }] }) },
      { launch: async (o) => { launched.push(o); return { pid: 77 }; }, raise: async (pid, w) => { raised.push(`${pid}:${w}`); } },
    );
    await backend.init();
    const r = await backend.act({ type: 'open_app', app: 'Calculator', detail: '{}' }, { desktop: false, front: true });
    expect(r.opened).toEqual({ pid: 77, windowId: 5 });
    expect(launched).toEqual([{ name: 'Calculator', bundleId: undefined, activate: true }]);
    await backend.raise(77, 5);
    expect(raised).toEqual(['77:5']);
    expect(calls.some((c) => c.name === 'launch_app' || c.name === 'bring_to_front')).toBe(false);
  });

  it('falls back to Cua when the quick raise leaves the window behind', async () => {
    const { backend, calls } = fakeCua({ list_windows: () => ok({ windows: [win(9, 1, 80), win(42, 7, 50)] }) }, { raise: async () => undefined });
    await backend.init();
    await backend.raise(42, 7);
    expect(calls.filter((c) => c.name === 'bring_to_front').map((c) => c.args)).toEqual([{ pid: 42, window_id: 7 }]);
  });

  it('takes window pictures from the stream when the window is as big as at Cua\'s last look', async () => {
    const state = { screenshot_width: 400, screenshot_height: 300, window_bounds: { x: 10, y: 20, width: 200, height: 150 }, app_name: 'Safari' };
    const withImage = (st: object): Res => ({ ...ok(st), images: [{ mimeType: 'image/png', dataBase64: 'cG5n' }] });
    let size = { width: 400, height: 300 };
    const { backend, calls } = fakeCua({ get_window_state: () => withImage(state) }, { streamFrame: async () => ({ data: 'anBn', ...size }) });
    await backend.init();
    const cuaShots = () => calls.filter((c) => c.name === 'get_window_state').length;
    await backend.windowShot({ pid: 42, windowId: 7, maxWidth: 2048 }); // nothing known yet: Cua
    expect(cuaShots()).toBe(1);
    const r = await backend.windowShot({ pid: 42, windowId: 7, maxWidth: 2048 });
    expect(cuaShots()).toBe(1);
    expect(r.shot).toEqual({ data: 'anBn', mimeType: 'image/jpeg', width: 400, height: 300 });
    expect(r.target.bounds).toEqual({ x: 10, y: 20, width: 200, height: 150 });
    size = { width: 500, height: 300 }; // resized: Cua looks again
    await backend.windowShot({ pid: 42, windowId: 7, maxWidth: 2048 });
    expect(cuaShots()).toBe(2);
  });

  it('tells whether a window is in front', async () => {
    const { backend } = fakeCua({ list_windows: () => ok({ windows: [win(42, 7, 50), win(9, 1, 60, { x: 0, y: 0, width: 0, height: 0 })] }) });
    await backend.init();
    expect(await backend.isFront(42, 7)).toBe(true);
    expect(await backend.isFront(9, 1)).toBe(false);
  });

  it("leaves the menu bar's menu items out of a window snapshot, and finds the page", async () => {
    const { backend } = fakeCua({
      get_window_state: () => ({
        ...ok({
          app_name: 'Safari', window_title: 'Cart', snapshot_id: 's1', screenshot_width: 2000, screenshot_height: 1000, window_bounds: { x: 0, y: 0, width: 1000, height: 500 },
          elements: [
            { element_index: 0, element_token: 's1:0', role: 'AXWindow', label: 'Cart' },
            { element_index: 1, element_token: 's1:1', role: 'AXWebArea', label: 'Cart', parent_index: 0, screenshot_frame: { x: 0, y: 100, w: 2000, h: 900 } },
            { element_index: 2, element_token: 's1:2', role: 'AXButton', label: 'Add', parent_index: 1, screenshot_frame: { x: 10, y: 200, w: 20, h: 20 } },
            { element_index: 3, element_token: 's1:3', role: 'AXMenuBar' },
            { element_index: 4, element_token: 's1:4', role: 'AXMenuBarItem', label: 'File', parent_index: 3 },
            { element_index: 5, element_token: 's1:5', role: 'AXMenu', parent_index: 4 },
            { element_index: 6, element_token: 's1:6', role: 'AXMenuItem', label: 'New Window', parent_index: 5 },
          ],
        }),
        images: [{ mimeType: 'image/png', dataBase64: '' }],
      }),
    });
    await backend.init();
    const snap = await backend.windowSnapshot({ pid: 42, windowId: 7, maxElements: 300, maxWidth: 2048 });
    expect(snap.text).toContain('"Add"');
    expect(snap.text).toContain('"File"');
    expect(snap.text).not.toContain('New Window');
    expect(snap.geometry.web).toEqual([{ x: 0, y: 100, w: 2000, h: 900 }]);
    expect(isWeb(snap.geometry, { x: 50, y: 50 })).toBe(false); // the toolbar
    expect(isWeb(snap.geometry, { x: 50, y: 500 })).toBe(true);
  });
});

/** Background mode's borrow, recording what went out while the screen was borrowed. */
function borrowing(calls: Call[]) {
  const log: string[] = [];
  const borrow: Borrow = async (send) => {
    log.push('wait');
    const from = calls.length;
    try { return await send(); }
    finally { log.push(...calls.slice(from).filter((c) => c.name !== 'list_windows').map((c) => `${c.name} ${String(c.args.delivery_mode ?? c.args.scope ?? '')}`), 'back'); }
  };
  return { borrow, log };
}
const refused = (a: Record<string, unknown>): Res => (a.delivery_mode === 'background'
  ? { text: 'background_unavailable: menu items need the app in front', images: [], isError: true, errorCode: 'background_unavailable' } : ok({}));

describe('Cua backend in background mode', () => {
  it('clicks a page for real only once the user paused, even with its window on top', async () => {
    const { backend, calls } = fakeCua({ list_windows: () => ok({ windows: [win(42, 7, 50)] }), get_cursor_position: () => ok({ x: 100, y: 50 }) });
    await backend.init();
    await backend.screenSize();
    const { borrow, log } = borrowing(calls);
    await backend.act(click, { desktop: false, web: true, pt: { x: 200, y: 150 }, borrow });
    expect(log).toEqual(['wait', 'get_cursor_position ', 'click desktop', 'move_cursor desktop', 'back']);
  });

  it('keeps keys in the background, and sends what the app refuses there in front once borrowed (macOS too)', async () => {
    const { backend, calls } = fakeCua({ hotkey: refused, press_key: () => ok({}) });
    await backend.init();
    const { borrow, log } = borrowing(calls);
    await backend.act({ type: 'key', key: 'enter', pid: 42, windowId: 7 }, { desktop: false, borrow });
    expect(log).toEqual([]);
    await backend.act({ type: 'key', key: 'cmd+s', pid: 42, windowId: 7 }, { desktop: false, borrow });
    expect(log).toEqual(['wait', 'hotkey foreground', 'back']);
    // on screen a Mac sends as asked: the refusal is the bot's to read
    await expect(backend.act({ type: 'key', key: 'cmd+s', pid: 42, windowId: 7 }, { desktop: false })).rejects.toThrow('background_unavailable');
  });

  it('sends a step the bot asked for in front with foreground delivery, and ignores the ask on screen', async () => {
    const { backend, calls } = fakeCua();
    await backend.init();
    const { borrow, log } = borrowing(calls);
    await backend.act({ type: 'type', text: 'hi', pid: 42, windowId: 7, front: true }, { desktop: false, borrow });
    await backend.act({ ...click, front: true }, { desktop: false, borrow });
    expect(log).toEqual(['wait', 'type_text foreground', 'back', 'wait', 'click foreground', 'back']);
    calls.length = 0;
    await backend.act({ type: 'key', key: 'enter', pid: 42, windowId: 7, front: true }, { desktop: false });
    expect(calls.find((c) => c.name === 'press_key')?.args.delivery_mode).toBe('background');
  });

  it('borrows the screen for drags and modified clicks', async () => {
    const { backend, calls } = fakeCua();
    await backend.init();
    const { borrow, log } = borrowing(calls);
    await backend.act({ type: 'drag', pid: 42, windowId: 7, x: 1, y: 1, toX: 9, toY: 9 }, { desktop: false, borrow });
    await backend.act({ ...click, detail: JSON.stringify({ modifiers: ['cmd'] }) }, { desktop: false, borrow });
    expect(log).toEqual(['wait', 'drag foreground', 'back', 'wait', 'click foreground', 'back']);
  });

  it('types into a page in front with real keystrokes only inside the borrow, checking it is still in front', async () => {
    let top = 42;
    const { backend, calls } = fakeCua({ list_windows: () => ok({ windows: [win(top, 7, 50)] }) });
    await backend.init();
    const { borrow, log } = borrowing(calls);
    await backend.act({ type: 'type', pid: 42, windowId: 7, text: 'lays' }, { desktop: false, web: true, borrow });
    expect(log).toEqual(['wait', 'type_text desktop', 'back']);
    // the user brought their own window forward while it waited: no keystrokes into it
    log.length = 0;
    const late: Borrow = async (send) => { top = 9; await new Promise((r) => setTimeout(r, 300)); return borrow(send); };
    await backend.act({ type: 'type', pid: 42, windowId: 7, text: 'chips' }, { desktop: false, web: true, borrow: late });
    expect(log).toEqual(['wait', 'type_text background', 'back']);
  });

  it("puts the user's pointer and app back only when a step moved them", async () => {
    const cursor = [{ x: 100, y: 50 }, { x: 300, y: 200 }, { x: 10, y: 10 }, { x: 10, y: 10 }];
    const front = [11, 77, 11, 11];
    const activated: number[] = [];
    const { backend, calls } = fakeCua(
      { get_cursor_position: () => ok(cursor.shift()) },
      { frontApp: async () => front.shift(), activate: async (pid) => { activated.push(pid); } },
    );
    await backend.init();
    await (await backend.userPlace()).restore();
    expect(calls.filter((c) => c.name === 'move_cursor').map((c) => c.args)).toEqual([{ x: 200, y: 100, scope: 'desktop' }]);
    expect(activated).toEqual([11]);
    calls.length = 0;
    await (await backend.userPlace()).restore();
    expect(calls.some((c) => c.name === 'move_cursor')).toBe(false);
    expect(activated).toEqual([11]);
  });

  it('opens apps behind the user, and gives the front back to an app that takes it anyway', async () => {
    const launched: unknown[] = [];
    const front = [11, 77];
    const activated: number[] = [];
    const { backend } = fakeCua(
      { list_windows: () => ok({ windows: [{ pid: 77, window_id: 5, title: 'Music', is_on_screen: true, layer: 0, bounds: { width: 900, height: 600 } }] }) },
      { launch: async (o) => { launched.push(o); return { pid: 77 }; }, frontApp: async () => front.shift(), activate: async (pid) => { activated.push(pid); } },
    );
    await backend.init();
    const { borrow } = borrowing([]);
    const r = await backend.act({ type: 'open_app', app: 'Music', detail: '{}' }, { desktop: false, borrow });
    expect(r.opened).toEqual({ pid: 77, windowId: 5 });
    expect(launched).toEqual([{ name: 'Music', bundleId: undefined, activate: false }]);
    expect(activated).toEqual([11]);
  });

  it('tells whether the user can see a window at a point', async () => {
    const { backend } = fakeCua({ list_windows: () => ok({ windows: [win(9, 1, 80, { x: 0, y: 0, width: 300, height: 300 }), win(42, 7, 50)] }) });
    await backend.init();
    expect(await backend.visibleAt(42, 7, { x: 100, y: 100 })).toBe(false); // under the user's window
    expect(await backend.visibleAt(42, 7, { x: 600, y: 500 })).toBe(true);
    expect(await backend.visibleAt(42, 7)).toBe(false); // not the frontmost window
  });
});

describe('isWeb', () => {
  const g = (o: Partial<WindowGeometry>): WindowGeometry => ({ target: { pid: 1, windowId: 1, bounds: { x: 0, y: 0, width: 10, height: 10 } }, shotWidth: 10, shotHeight: 10, elements: new Map(), web: [], browser: false, ...o });
  it('treats a browser whose page is missing from the tree as web content', () => {
    expect(isWeb(g({ browser: true }), { x: 1, y: 1 })).toBe(true);
    expect(isWeb(g({}), { x: 1, y: 1 })).toBe(false);
    expect(isWeb(undefined)).toBe(false);
  });
});

describe('window text and labels', () => {
  it("reads the window's own text from Cua's tree, not the menus", () => {
    const tree = ['- [0] AXWindow "Calculator"', '    - AXStaticText = "4,827, × 391" (Last Expression)', '    - AXStaticText = "18,87,357" (Edit field)', '    - [1] AXButton (Delete)', '- [26] AXMenuBar', '    - AXStaticText = "menu text"'].join('\n');
    expect(shownText(tree)).toBe('"4,827, × 391" · "18,87,357"');
  });

  it('finds an element by label: exact first, pressable first, only what is in the picture', () => {
    const el = (x: number, role: string, label: string) => ({ px: { x, y: 10 }, pt: { x, y: 10 }, role, label });
    const g: WindowGeometry = {
      target: { pid: 1, windowId: 1, bounds: { x: 0, y: 0, width: 100, height: 100 } }, shotWidth: 100, shotHeight: 100, web: [], browser: false,
      elements: new Map([['s:1', el(-1, 'AXMenuItem', 'Save')], ['s:2', el(10, 'AXStaticText', 'Save')], ['s:3', el(20, 'AXButton', 'Save')], ['s:4', el(30, 'AXButton', 'Save As…')]]),
    };
    expect(findLabel(g, 'save')?.token).toBe('s:3');
    expect(findLabel(g, 'save as')?.token).toBe('s:4');
    expect(findLabel(g, 'Open')).toBeNull();
  });
});
