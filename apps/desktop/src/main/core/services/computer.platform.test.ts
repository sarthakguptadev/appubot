import { describe, expect, it } from 'vitest';
import type { ComputerAction } from '@appubot/protocol';
import { silentLogger } from '../util';
import { agentCursorSupport, AGENT_CURSOR_TITLE } from './agentCursor';
import { CuaBackend, cuaModifier, findLabel, findRunningApp, isBrowserApp, isPressable, isWeb, isWebArea, launchArgs, shownText, type Borrow, type WindowGeometry } from './computer';

/* Computer use on Windows and Linux: what differs from macOS, each test naming the OS it plays. */

type Call = { name: string; args: Record<string, unknown> };
interface Res { text: string; images: { mimeType: string; dataBase64: string }[]; isError: boolean; structuredJson?: string; errorCode?: string }
const ok = (structured?: unknown, text = 'ok'): Res => ({ text, images: [], isError: false, structuredJson: structured === undefined ? undefined : JSON.stringify(structured) });
/** a 1x1 PNG, enough for a window snapshot */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function fakeCua(os: string, on: Record<string, (args: Record<string, unknown>) => Res> = {}, more: Partial<ConstructorParameters<typeof CuaBackend>[0]> = {}) {
  const calls: Call[] = [];
  const driver = {
    callTool: async (name: string, json: string) => {
      const args = JSON.parse(json) as Record<string, unknown>;
      calls.push({ name, args });
      if (on[name]) return on[name]!(args);
      if (name === 'health_report') return ok({ overall: 'ok', checks: [{ name: 'ax_capability', status: 'pass' }, { name: 'screen_capture_capability', status: 'pass' }] });
      if (name === 'get_screen_size') return ok({ width: 2880, height: 1800, scale_factor: 1.5 });
      return ok({});
    },
    shutdown: async () => undefined,
  };
  let requested = 0;
  const backend = new CuaBackend({ log: silentLogger, defaultDim: () => 2048, os, requestPermissions: () => { requested++; }, load: async () => ({ CuaDriver: { create: () => driver } }), ...more });
  return { backend, calls, requested: () => requested };
}

const win = (pid: number, window_id: number, z: number | null, title = '') => ({ pid, window_id, z_index: z, layer: 0, is_on_screen: true, title, bounds: { x: 0, y: 0, width: 1000, height: 800 } });

describe('modifiers on each OS', () => {
  it('keeps macOS names, and maps a Mac shortcut to Ctrl on Windows and Linux', () => {
    expect(['cmd', 'option', 'ctrl', 'shift'].map((m) => cuaModifier(m, 'darwin'))).toEqual(['cmd', 'option', 'ctrl', 'shift']);
    expect(cuaModifier('meta', 'darwin')).toBe('cmd');
    expect(['cmd', 'command', 'option', 'alt', 'control', 'shift', 'win', 'super'].map((m) => cuaModifier(m, 'win32'))).toEqual(['ctrl', 'ctrl', 'alt', 'alt', 'ctrl', 'shift', 'win', 'win']);
    expect(['cmd', 'option', 'meta', 'super'].map((m) => cuaModifier(m, 'linux'))).toEqual(['ctrl', 'alt', 'super', 'super']);
  });
});

describe('browsers and web content on each OS', () => {
  it('knows browsers by the names Cua gives them', () => {
    expect(isBrowserApp('Safari', 'darwin')).toBe(true);
    expect(isBrowserApp('msedge.exe', 'darwin')).toBe(false);
    expect(isBrowserApp('msedge.exe', 'win32')).toBe(true);
    expect(isBrowserApp('Microsoft Edge', 'win32')).toBe(true);
    expect(isBrowserApp('chrome.exe', 'win32')).toBe(true);
    expect(isBrowserApp('notepad.exe', 'win32')).toBe(false);
    expect(isBrowserApp('google-chrome', 'linux')).toBe(true);
    expect(isBrowserApp('firefox', 'linux')).toBe(true);
    expect(isBrowserApp('gedit', 'linux')).toBe(false);
  });

  it('finds web areas by each OS role', () => {
    expect(isWebArea('darwin', 'AXWebArea')).toBe(true);
    expect(isWebArea('linux', 'document web')).toBe(true);
    expect(isWebArea('linux', 'document frame')).toBe(false);
    // UI Automation calls a text editor's area a Document too: only one Cua marks as web content is a page
    expect(isWebArea('win32', 'Document')).toBe(false);
    expect(isWebArea('win32', 'Document', true)).toBe(true);
    expect(isWebArea('win32', 'AXWebArea', true)).toBe(false);
  });

  it('ranks pressable controls by each OS role', () => {
    expect(isPressable('win32', 'Button')).toBe(true);
    expect(isPressable('win32', 'Edit')).toBe(true);
    expect(isPressable('win32', 'Text')).toBe(false);
    expect(isPressable('linux', 'push button')).toBe(true);
    expect(isPressable('linux', 'menu item')).toBe(true);
    expect(isPressable('linux', 'label')).toBe(false);
    const g: WindowGeometry = {
      target: { pid: 1, windowId: 1, bounds: { x: 0, y: 0, width: 100, height: 100 } }, shotWidth: 100, shotHeight: 100, web: [], browser: false,
      elements: new Map([
        ['s:1', { px: { x: 10, y: 10 }, pt: { x: 10, y: 10 }, role: 'label', label: 'Save' }],
        ['s:2', { px: { x: 20, y: 20 }, pt: { x: 20, y: 20 }, role: 'push button', label: 'Save' }],
      ]),
    };
    expect(findLabel(g, 'save', 'linux')?.token).toBe('s:2');
  });
});

describe('opening apps on each OS', () => {
  it('hands macOS its name or bundle id, and the URL to the app', () => {
    expect(launchArgs('darwin', { app: 'Safari', url: 'https://a.b' })).toEqual({ name: 'Safari', bundle_id: undefined, urls: ['https://a.b'] });
    expect(launchArgs('darwin', { app: 'Safari', bundleId: 'com.apple.Safari' })).toEqual({ name: undefined, bundle_id: 'com.apple.Safari', urls: undefined });
  });

  it('opens Windows apps by name, path or AUMID, with a URL on the app\'s command line', () => {
    expect(launchArgs('win32', { app: 'Notepad' })).toEqual({ name: 'Notepad' });
    expect(launchArgs('win32', { app: 'C:\\Program Files\\App\\app.exe' })).toEqual({ path: 'C:\\Program Files\\App\\app.exe' });
    expect(launchArgs('win32', { app: 'msedge.exe', url: 'https://a.b' })).toEqual({ path: 'msedge.exe', additional_arguments: ['https://a.b'] });
    expect(launchArgs('win32', { bundleId: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' })).toEqual({ bundle_id: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' });
    // no app: the default browser
    expect(launchArgs('win32', { url: 'https://a.b' })).toEqual({ urls: ['https://a.b'] });
  });

  it('opens Linux apps by name or desktop-file id', () => {
    expect(launchArgs('linux', { app: 'firefox', url: 'https://a.b' })).toEqual({ name: 'firefox', additional_arguments: ['https://a.b'] });
    expect(launchArgs('linux', { bundleId: 'org.gnome.Nautilus' })).toEqual({ name: 'org.gnome.Nautilus' });
    expect(launchArgs('linux', { url: 'https://a.b' })).toEqual({ urls: ['https://a.b'] });
  });

  it('finds a running app by its executable name on Windows', () => {
    const apps = [{ name: 'Notepad', pid: 5, running: true }, { name: 'notepad++', pid: 6, running: true }];
    expect(findRunningApp(apps, 'notepad.exe', 'win32')?.pid).toBe(5);
    expect(findRunningApp(apps, 'notepad', 'darwin')?.pid).toBe(5);
    expect(findRunningApp(apps, 'notepad.exe', 'darwin')).toBeUndefined();
  });

  it('works in the running copy\'s window when the launched process hands off and quits (Windows)', async () => {
    const { backend } = fakeCua('win32', {
      launch_app: () => ok({ pid: 100 }),
      list_windows: (a) => ok({ windows: a.pid === 200 ? [win(200, 9, 3)] : [] }),
      list_apps: () => ok({ apps: [{ name: 'msedge', pid: 200, running: true }] }),
    });
    await backend.init();
    const r = await backend.act({ type: 'open_app', app: 'msedge', detail: JSON.stringify({ url: 'https://a.b' }) }, { desktop: false });
    expect(r.opened).toEqual({ pid: 200, windowId: 9 });
  });
});

describe('text a window shows on Windows and Linux', () => {
  it('reads static texts from the elements, menus left out', () => {
    const elements = [
      { element_index: 0, role: 'Window' },
      { element_index: 1, role: 'Text', label: 'Display is 42', parent_index: 0 },
      { element_index: 2, role: 'MenuBar', parent_index: 0 },
      { element_index: 3, role: 'MenuItem', label: 'File', parent_index: 2 },
      { element_index: 4, role: 'Text', label: 'Open…', parent_index: 3 },
    ];
    expect(shownText(undefined, 'win32', elements)).toBe('"Display is 42"');
  });

  it('falls back to the tree\'s rows', () => {
    const tree = '- [0] frame "Calc"\n  - label "Total" = "1,234"\n  - [3] push button "OK" [actions=[click]]\n  - [4] static "Ready"\n- menu bar\n  - label "Hidden"';
    expect(shownText(tree, 'linux')).toBe('"1,234" · "Ready"');
  });
});

describe('Cua backend on Windows and Linux', () => {
  it('has nothing to grant: permissions come from Cua\'s health report', async () => {
    const { backend, calls, requested } = fakeCua('linux', {
      health_report: () => ok({ checks: [{ name: 'ax_capability', status: 'fail' }, { name: 'screen_capture_capability', status: 'pass' }] }),
    });
    await backend.init();
    expect(await backend.permissions()).toEqual({ accessibility: false, screenRecording: true });
    expect(calls.some((c) => c.name === 'check_permissions')).toBe(false);
    await backend.requestPermissions();
    expect(requested()).toBe(0);
  });

  it('clicks web content with Cua\'s foreground delivery, aimed in the window\'s picture', async () => {
    const { backend, calls } = fakeCua('win32', { list_windows: () => ok({ windows: [win(42, 7, 50)] }) });
    await backend.init();
    await backend.act({ type: 'click', pid: 42, windowId: 7, x: 400, y: 300 }, { desktop: false, web: true, pt: { x: 200, y: 150 } });
    const sent = calls.filter((c) => c.name === 'click' || c.name === 'move_cursor' || c.name === 'get_cursor_position');
    expect(sent).toEqual([{ name: 'click', args: { x: 400, y: 300, button: 'left', count: 1, pid: 42, window_id: 7, delivery_mode: 'foreground' } }]);
  });

  it('sends a click the target refuses in the background again in the foreground', async () => {
    let n = 0;
    const { backend, calls } = fakeCua('win32', {
      click: () => (n++ === 0 ? { text: 'background_unavailable: PostMessage is dropped here', images: [], isError: true, errorCode: 'background_unavailable' } : ok({ route: 'global_input', effect: 'confirmed' })),
    });
    await backend.init();
    expect(await backend.act({ type: 'click', pid: 42, windowId: 7, x: 4, y: 3 }, { desktop: false })).toEqual({ text: 'Clicked.' });
    expect(calls.filter((c) => c.name === 'click').map((c) => c.args.delivery_mode)).toEqual(['background', 'foreground']);
  });

  it('does not retry other failures', async () => {
    const { backend, calls } = fakeCua('linux', { click: () => ({ text: 'target_occluded', images: [], isError: true }) });
    await backend.init();
    await expect(backend.act({ type: 'click', pid: 42, windowId: 7, x: 4, y: 3 }, { desktop: false })).rejects.toThrow('target_occluded');
    expect(calls.filter((c) => c.name === 'click')).toHaveLength(1);
  });

  it('types for real into any window in front, without delay_ms on Linux', async () => {
    const front = { list_windows: () => ok({ windows: [win(42, 7, 50)] }) };
    const w = fakeCua('win32', front);
    await w.backend.init();
    await w.backend.act({ type: 'type', pid: 42, windowId: 7, text: 'hi' }, { desktop: false, web: false });
    expect(w.calls.find((c) => c.name === 'type_text')?.args).toEqual({ text: 'hi', scope: 'desktop', delay_ms: 5 });
    const l = fakeCua('linux', front);
    await l.backend.init();
    await l.backend.act({ type: 'type', pid: 42, windowId: 7, text: 'hi' }, { desktop: false, web: false });
    expect(l.calls.find((c) => c.name === 'type_text')?.args).toEqual({ text: 'hi', scope: 'desktop' });
  });

  it('types in the background into a window behind others', async () => {
    const { backend, calls } = fakeCua('win32', { list_windows: () => ok({ windows: [win(9, 1, 80), win(42, 7, 50)] }) });
    await backend.init();
    await backend.act({ type: 'type', pid: 42, windowId: 7, text: 'hi' }, { desktop: false });
    expect(calls.find((c) => c.name === 'type_text')?.args).toEqual({ text: 'hi', pid: 42, window_id: 7, delivery_mode: 'background' });
  });

  it('sends Windows key names for a Mac shortcut', async () => {
    const { backend, calls } = fakeCua('win32', { list_windows: () => ok({ windows: [win(42, 7, 50)] }) });
    await backend.init();
    await backend.act({ type: 'hotkey', pid: 42, windowId: 7, key: 'cmd+shift+s' }, { desktop: false, front: true });
    expect(calls.find((c) => c.name === 'hotkey')?.args).toEqual({ keys: ['ctrl', 'shift', 's'], scope: 'desktop' });
  });

  it('leaves the agent cursor\'s overlay out when asking which window is in front', async () => {
    const { backend } = fakeCua('win32', { list_windows: () => ok({ windows: [win(process.pid, 99, 90, AGENT_CURSOR_TITLE), win(42, 7, 50)] }) });
    await backend.init();
    expect(await backend.isFront(42, 7)).toBe(true);
  });

  it('counts no window as in front when the stacking order is unknown', async () => {
    const { backend } = fakeCua('linux', { list_windows: () => ok({ windows: [win(42, 7, null), win(9, 1, null)] }) });
    await backend.init();
    expect(await backend.isFront(42, 7)).toBe(false);
  });

  it('marks Linux web pages and browsers in a window snapshot', async () => {
    const { backend } = fakeCua('linux', {
      get_window_state: () => ({
        ...ok({
          app_name: 'firefox', snapshot_id: 's1', window_bounds: { x: 0, y: 0, width: 1000, height: 800 }, screenshot_width: 1000, screenshot_height: 800,
          elements: [{ element_index: 1, role: 'document web', element_token: 's1:1', screenshot_frame: { x: 0, y: 100, w: 1000, h: 700 } }],
        }),
        images: [{ mimeType: 'image/png', dataBase64: PNG }],
      }),
    });
    await backend.init();
    const snap = await backend.windowSnapshot({ pid: 42, windowId: 7, maxElements: 50, maxWidth: 2048 });
    expect(snap.geometry.browser).toBe(true);
    expect(isWeb(snap.geometry, { x: 50, y: 50 })).toBe(false);
    expect(isWeb(snap.geometry, { x: 50, y: 500 })).toBe(true);
  });

  it('scrolls a page with foreground delivery, anything else in the background', async () => {
    const { backend, calls } = fakeCua('linux');
    await backend.init();
    const scroll: ComputerAction = { type: 'scroll', pid: 42, windowId: 7, x: 10, y: 10, detail: JSON.stringify({ direction: 'down' }) };
    await backend.act(scroll, { desktop: false, web: true });
    await backend.act(scroll, { desktop: false, web: false });
    expect(calls.filter((c) => c.name === 'scroll').map((c) => c.args.delivery_mode)).toEqual(['foreground', 'background']);
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
const refusedInBackground = (a: Record<string, unknown>): Res => (a.delivery_mode === 'background'
  ? { text: 'background_unavailable: the window takes no posted input', images: [], isError: true, errorCode: 'background_unavailable' } : ok({}));

describe('background mode on Windows and Linux', () => {
  it('clicks web content with foreground delivery only once the user paused', async () => {
    const { backend, calls } = fakeCua('win32');
    await backend.init();
    const { borrow, log } = borrowing(calls);
    await backend.act({ type: 'click', pid: 42, windowId: 7, x: 400, y: 300 }, { desktop: false, web: true, pt: { x: 200, y: 150 }, borrow });
    expect(log).toEqual(['wait', 'click foreground', 'back']);
  });

  it('sends what a window refuses in the background again in the foreground, once the user paused', async () => {
    for (const os of ['win32', 'linux']) {
      const { backend, calls } = fakeCua(os, { press_key: refusedInBackground, type_text: refusedInBackground });
      await backend.init();
      const { borrow, log } = borrowing(calls);
      await backend.act({ type: 'key', key: 'enter', pid: 42, windowId: 7 }, { desktop: false, borrow });
      await backend.act({ type: 'type', text: 'hi', pid: 42, windowId: 7 }, { desktop: false, borrow });
      expect(log).toEqual(['wait', 'press_key foreground', 'back', 'wait', 'type_text foreground', 'back']);
    }
  });

  it('types for real into its window in front only inside the borrow', async () => {
    const { backend, calls } = fakeCua('linux', { list_windows: () => ok({ windows: [win(42, 7, 50)] }) });
    await backend.init();
    const { borrow, log } = borrowing(calls);
    await backend.act({ type: 'type', pid: 42, windowId: 7, text: 'hi' }, { desktop: false, borrow });
    expect(log).toEqual(['wait', 'type_text desktop', 'back']);
  });

  it('scrolls a page and drags with foreground delivery once the user paused, a native window in the background', async () => {
    const { backend, calls } = fakeCua('linux');
    await backend.init();
    const { borrow, log } = borrowing(calls);
    const scroll: ComputerAction = { type: 'scroll', pid: 42, windowId: 7, x: 10, y: 10, detail: JSON.stringify({ direction: 'down' }) };
    await backend.act(scroll, { desktop: false, web: true, borrow });
    await backend.act(scroll, { desktop: false, web: false, borrow });
    await backend.act({ type: 'drag', pid: 42, windowId: 7, x: 1, y: 1, toX: 9, toY: 9 }, { desktop: false, borrow });
    expect(log).toEqual(['wait', 'scroll foreground', 'back', 'wait', 'drag foreground', 'back']);
    expect(calls.filter((c) => c.name === 'scroll').map((c) => c.args.delivery_mode)).toEqual(['foreground', 'background']);
  });
});

describe("putting the user back after a borrowed step on Windows and Linux", () => {
  /** the window list in front-to-back turns: the user's window, then the bot's (Cua fronted it and left it there) */
  const stacking = (...tops: [number, number][]) => (a: Record<string, unknown>): Res => {
    const [pid, id] = tops.length > 1 ? tops.shift()! : tops[0]!;
    return ok({ windows: a.pid === 77 ? [win(77, 5, 1)] : [win(pid, id, 90), win(pid === 9 ? 42 : 9, pid === 9 ? 7 : 1, 50)] });
  };

  it('brings the user\'s window back to the front and puts their pointer back, in physical pixels (Windows)', async () => {
    const cursor = [{ x: 2500, y: 1400 }, { x: 900, y: 600 }];
    const { backend, calls } = fakeCua('win32', { list_windows: stacking([9, 1], [42, 7]), get_cursor_position: () => ok(cursor.shift() ?? { x: 0, y: 0 }) });
    await backend.init();
    await (await backend.userPlace()).restore();
    expect(calls.filter((c) => c.name === 'bring_to_front' || c.name === 'move_cursor')).toEqual([
      { name: 'bring_to_front', args: { pid: 9, window_id: 1 } },
      // as Cua reported it (no desktop picture taken: Cua moves it there as is)
      { name: 'move_cursor', args: { x: 2500, y: 1400, scope: 'desktop' } },
    ]);
  });

  it('scales the pointer to the last desktop picture, and leaves alone what didn\'t move (Linux)', async () => {
    const cursor = [{ x: 1000, y: 500 }, { x: 10, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 10 }];
    const { backend, calls } = fakeCua('linux', {
      list_windows: stacking([9, 1], [42, 7], [9, 1]),
      get_cursor_position: () => ok(cursor.shift()),
      get_desktop_state: () => ({ ...ok({ width: 1440, height: 900 }), images: [{ mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAABaAAAAOECAYAAAA' }] }),
    });
    await backend.init();
    await backend.screenshot({ maxWidth: 1440 }); // a desktop picture at half the screen's 2880 pixels
    await (await backend.userPlace()).restore();
    expect(calls.filter((c) => c.name === 'move_cursor').map((c) => c.args)).toEqual([{ x: 500, y: 250, scope: 'desktop' }]);
    calls.length = 0;
    await (await backend.userPlace()).restore(); // the user's window still in front, the pointer where it was
    expect(calls.some((c) => c.name === 'bring_to_front' || c.name === 'move_cursor')).toBe(false);
  });

  it("doesn't touch the pointer where Cua can't read the user's (Wayland)", async () => {
    const { backend, calls } = fakeCua('linux', { list_windows: stacking([9, 1], [42, 7]) }, { restorePointer: false });
    await backend.init();
    await (await backend.userPlace()).restore();
    expect(calls.some((c) => c.name === 'get_cursor_position' || c.name === 'move_cursor')).toBe(false);
    expect(calls.filter((c) => c.name === 'bring_to_front').map((c) => c.args)).toEqual([{ pid: 9, window_id: 1 }]);
  });

  it('gives the front back when an app it opens in the background comes forward anyway (Linux)', async () => {
    const { backend, calls } = fakeCua('linux', { launch_app: () => ok({ pid: 77 }), list_windows: stacking([9, 1], [77, 5]) });
    await backend.init();
    const r = await backend.act({ type: 'open_app', app: 'gedit', detail: '{}' }, { desktop: false, borrow: (send) => send() });
    expect(r.opened).toEqual({ pid: 77, windowId: 5 });
    expect(calls.filter((c) => c.name === 'bring_to_front').map((c) => c.args)).toEqual([{ pid: 9, window_id: 1 }]);
  });
});

describe('agent cursor overlay support', () => {
  it('shows on macOS, and on Windows from 10 2004', () => {
    expect(agentCursorSupport('darwin', {}, '25.0.0').ok).toBe(true);
    expect(agentCursorSupport('win32', {}, '10.0.19041').ok).toBe(true);
    expect(agentCursorSupport('win32', {}, '10.0.22631').ok).toBe(true);
    expect(agentCursorSupport('win32', {}, '10.0.18363').ok).toBe(false);
    expect(agentCursorSupport('win32', {}, '6.3.9600').ok).toBe(false);
  });

  it('shows on Linux only in an X11 session of a compositing desktop', () => {
    expect(agentCursorSupport('linux', { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, '6.8.0').ok).toBe(true);
    expect(agentCursorSupport('linux', { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'KDE' }, '6.8.0').ok).toBe(true);
    expect(agentCursorSupport('linux', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' }, '6.8.0').ok).toBe(false);
    expect(agentCursorSupport('linux', { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'i3' }, '6.8.0').ok).toBe(false);
    expect(agentCursorSupport('linux', { XDG_CURRENT_DESKTOP: 'GNOME' }, '6.8.0').ok).toBe(false);
    expect(agentCursorSupport('freebsd', {}, '14.0').ok).toBe(false);
  });
});

describe("Cua's own cursor overlay", () => {
  it('is hidden on Windows and Linux (AppuBot draws the bot cursor), once per busy spell; never touched on macOS', async () => {
    for (const os of ['win32', 'linux']) {
      const { backend, calls } = fakeCua(os);
      await backend.init();
      await backend.screenSize();
      const hides = calls.filter((c) => c.name === 'set_agent_cursor_enabled');
      expect(hides).toEqual([{ name: 'set_agent_cursor_enabled', args: { enabled: false } }]);
      expect(calls[0]!.name).toBe('set_agent_cursor_enabled');
    }
    const mac = fakeCua('darwin', { check_permissions: () => ok({ accessibility: true, screen_recording: true }) });
    await mac.backend.init().catch(() => undefined);
    expect(mac.calls.some((c) => c.name === 'set_agent_cursor_enabled')).toBe(false);
  });

  it('a refusal is not an error', async () => {
    const { backend, calls } = fakeCua('linux', { set_agent_cursor_enabled: () => ({ text: 'unsupported', images: [], isError: true }) });
    await backend.init();
    expect(calls.map((c) => c.name)).toContain('health_report');
  });
});
