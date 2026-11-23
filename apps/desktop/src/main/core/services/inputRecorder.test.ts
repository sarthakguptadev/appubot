/**
 * Teach mode's recorder on Windows and Linux: synthetic hook events in, the macOS helper's InputEvents out (clicks with
 * their counts, drags, right clicks, typed text, shortcuts, scrolls), AppuBot's own windows left out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InputRecorder, MULTI_CLICK_MS, SCROLL_PAUSE_MS, SETTLE_MS, TYPED_PAUSE_MS, VC, charFor, keyName, linuxSessionProblem, modifierNames,
  type Foreground, type InputWatchHost, type Mods, type Point, type RawInput,
} from './inputRecorder';
import type { InputEvent } from './teach';

const M = (o: Partial<Mods> = {}): Mods => ({ ctrl: false, alt: false, shift: false, meta: false, ...o });
const NOTEPAD: Foreground = { app: 'Notepad', title: 'notes.txt - Notepad', self: false };

/* libuiohook codes used below */
const K = {
  h: 0x0023, e: 0x0012, l: 0x0026, o: 0x0018, w: 0x0011, r: 0x0013, d: 0x0020, c: 0x002e, t: 0x0014, s: 0x001f, a: 0x001e,
  one: 0x0002, space: 0x0039, slash: 0x0035, kp7: 0x0047, kpEnd: 0xee4f,
};

class FakeHost implements InputWatchHost {
  onInput: ((e: RawInput) => void) | null = null;
  ok = true;
  reason: string | undefined = undefined;
  stopped = 0;
  fg: (at?: Point) => Foreground | Promise<Foreground> = () => NOTEPAD;
  shot: () => Promise<string | null> = async () => 'SHOT';
  shots = 0;
  async available() { return this.ok ? { ok: true } : { ok: false, reason: this.reason }; }
  async start(fn: (e: RawInput) => void) { this.onInput = fn; }
  async stop() { this.stopped++; this.onInput = null; }
  cursor() { return { x: 500, y: 300 }; }
  async foreground(at?: Point) { return this.fg(at); }
  screenshot() { this.shots++; return this.shot(); }
}

let host: FakeHost;
let out: InputEvent[];
let now: number;
let rec: InputRecorder;

async function startRec(platform = 'win32', screenshots = true): Promise<void> {
  rec = new InputRecorder(host, (e) => out.push(e), { platform, screenshots, scale: 0.5, now: () => now });
  await rec.start();
}
const send = (e: RawInput): void => host.onInput!(e);
const press = (x: number, y: number, button = 1, mods = M()): void => send({ type: 'mousedown', button, x, y, mods });
const release = (x: number, y: number, button = 1, mods = M()): void => send({ type: 'mouseup', button, x, y, mods });
const click = (x: number, y: number, button = 1, mods = M()): void => { press(x, y, button, mods); now += 60; release(x, y, button, mods); };
const key = (keycode: number, mods = M()): void => { send({ type: 'keydown', keycode, mods }); send({ type: 'keyup', keycode, mods }); };
const keys = (codes: number[], mods = M()): void => { for (const c of codes) { key(c, mods); now += 50; } };
/** lets the timers (typed/scroll pauses, the window lookup's settle) run and the queue drain */
const settle = (ms = 1000): Promise<void> => vi.advanceTimersByTimeAsync(ms).then(() => undefined);
const strip = (e: InputEvent): Partial<InputEvent> => { const { ts: _ts, ...rest } = e; return rest; };

beforeEach(() => {
  vi.useFakeTimers();
  host = new FakeHost();
  out = [];
  now = 1_000_000;
});
afterEach(() => { vi.useRealTimers(); });

describe('clicks and drags', () => {
  it('reports a left click at the release, with its window and the picture taken at the press', async () => {
    await startRec();
    press(100, 200);
    now += 80;
    release(101, 200);
    await settle();
    expect(out).toEqual([{
      kind: 'click', x: 101, y: 200, modifiers: [], ts: now, count: 1, button: 'left',
      app: 'Notepad', window_title: 'notes.txt - Notepad', screenshot_base64: 'SHOT',
    }]);
    expect(host.shots).toBe(1);
  });

  it('counts double and triple clicks by time and distance', async () => {
    await startRec();
    click(100, 100);
    now += 150;
    click(102, 101);
    now += 150;
    click(101, 100);
    now += MULTI_CLICK_MS + 1;
    click(101, 100);
    now += 100;
    // too far away to be the same click
    click(140, 100);
    // another button breaks the run
    now += 100;
    click(140, 100, 3);
    now += 100;
    click(140, 100);
    await settle();
    expect(out.map((e) => [e.kind, e.button, e.count])).toEqual([
      ['click', 'left', 1], ['click', 'left', 2], ['click', 'left', 3], ['click', 'left', 1], ['click', 'left', 1],
      ['click', 'middle', 1], ['click', 'left', 1],
    ]);
  });

  it('turns a press and release more than 5 points apart into a drag', async () => {
    await startRec();
    press(10, 10);
    now += 400;
    release(110.256, 60);
    now += 100;
    // a quick click right after a drag is a new click, not a double
    click(110, 60);
    await settle();
    expect(strip(out[0]!)).toEqual({
      kind: 'drag_end', x: 110.26, y: 60, modifiers: [], from: { x: 10, y: 10 }, duration_ms: 400, button: 'left',
      app: 'Notepad', window_title: 'notes.txt - Notepad', screenshot_base64: 'SHOT',
    });
    expect(out[1]).toMatchObject({ kind: 'click', count: 1 });
  });

  it('keeps a press of 5 points or less a click', async () => {
    await startRec();
    press(10, 10);
    release(13, 14);
    await settle();
    expect(out[0]).toMatchObject({ kind: 'click', x: 13, y: 14 });
  });

  it('reports right clicks at the press with a picture, middle clicks without one', async () => {
    await startRec();
    press(50, 60, 2, M({ shift: true }));
    release(50, 60, 2);
    press(70, 80, 3);
    release(70, 80, 3);
    await settle();
    expect(out.map(strip)).toEqual([
      { kind: 'right_click', x: 50, y: 60, modifiers: ['shift'], button: 'right', app: 'Notepad', window_title: 'notes.txt - Notepad', screenshot_base64: 'SHOT' },
      { kind: 'click', x: 70, y: 80, modifiers: [], button: 'middle', count: 1, app: 'Notepad', window_title: 'notes.txt - Notepad' },
    ]);
  });

  it('names a click\'s modifiers the Windows way, the Windows key as win', async () => {
    await startRec('win32');
    click(1, 1, 1, M({ ctrl: true, shift: true, meta: true, alt: true }));
    await settle();
    expect(out[0]!.modifiers).toEqual(['win', 'ctrl', 'alt', 'shift']);
  });

  it('looks the window up a moment after the event, once the click has brought it forward', async () => {
    await startRec();
    let inFront = 'Explorer';
    host.fg = () => ({ app: inFront, self: false });
    press(5, 5);
    release(5, 5);
    inFront = 'Chrome';
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 5);
    expect(out[0]!.app).toBe('Chrome');
  });

  it('takes no pictures when asked not to', async () => {
    await startRec('win32', false);
    click(5, 5);
    press(6, 6, 2);
    await settle();
    expect(host.shots).toBe(0);
    expect(out.every((e) => e.screenshot_base64 === undefined)).toBe(true);
  });

  it('keeps the order when a picture is slow, and gives up on one that never comes', async () => {
    await startRec();
    host.shot = () => new Promise(() => undefined);
    click(5, 5);
    key(VC.ENTER);
    await settle(5000);
    expect(out.map((e) => e.kind)).toEqual(['click', 'key']);
    expect(out[0]!.screenshot_base64).toBeUndefined();
  });
});

describe('typing', () => {
  it('builds typed text with Shift and hands it over after a pause', async () => {
    await startRec();
    const start = now;
    key(K.h, M({ shift: true }));
    now += 50;
    keys([K.e, K.l, K.l, K.o, K.space, K.w, K.o, K.r, K.l, K.d]);
    key(K.one, M({ shift: true }));
    await vi.advanceTimersByTimeAsync(TYPED_PAUSE_MS - 50);
    expect(out).toEqual([]);
    await settle();
    expect(out).toEqual([{
      kind: 'typed', text: 'Hello world!', ts: start, end_ts: now, x: 500, y: 300, modifiers: [],
      app: 'Notepad', window_title: 'notes.txt - Notepad',
    }]);
  });

  it('lets Backspace edit the pending text', async () => {
    await startRec();
    keys([K.c, K.a, K.t, K.s]);
    key(VC.BACKSPACE);
    key(VC.BACKSPACE);
    keys([K.r]);
    await settle();
    expect(out.map((e) => e.text)).toEqual(['car']);
  });

  it('hands typed text over before a click, a scroll or another key', async () => {
    await startRec();
    keys([K.h, K.e]);
    click(10, 10);
    keys([K.o]);
    send({ type: 'wheel', x: 1, y: 1, dx: 0, dy: 3, mods: M() });
    keys([K.l]);
    key(VC.ENTER);
    await settle();
    expect(out.map((e) => [e.kind, e.text ?? e.key ?? ''])).toEqual([
      // printable keys don't end a scroll (like the helper's), the next other key does
      ['typed', 'he'], ['click', ''], ['typed', 'o'], ['typed', 'l'], ['scroll', ''], ['key', 'enter'],
    ]);
  });

  it('records shortcuts as keys with their modifiers', async () => {
    await startRec('linux');
    keys([K.h, K.e]);
    key(K.c, M({ ctrl: true }));
    key(K.t, M({ ctrl: true, shift: true }));
    key(K.e, M({ meta: true }));
    key(VC.F4, M({ alt: true }));
    key(VC.TAB, M({ shift: true }));
    await settle();
    expect(out.map((e) => [e.kind, e.text ?? e.key, e.modifiers, e.chars])).toEqual([
      ['typed', 'he', [], undefined],
      ['key', 'c', ['ctrl'], undefined],
      ['key', 't', ['ctrl', 'shift'], undefined],
      ['key', 'e', ['super'], 'e'],
      ['key', 'f4', ['alt'], undefined],
      ['key', 'tab', ['shift'], undefined],
    ]);
    expect(out[1]).toMatchObject({ x: 500, y: 300, app: 'Notepad' });
  });

  it('never records a modifier or lock key on its own, but does record the Windows key alone', async () => {
    await startRec('win32');
    key(VC.SHIFT_L);
    key(VC.CONTROL_R);
    key(VC.ALT_L);
    key(VC.NUM_LOCK);
    await settle();
    expect(out).toEqual([]);
    // Win alone opens the Start menu
    send({ type: 'keydown', keycode: VC.META_L, mods: M({ meta: true }) });
    send({ type: 'keyup', keycode: VC.META_L, mods: M() });
    // Win+E is a shortcut, not the key alone
    send({ type: 'keydown', keycode: VC.META_L, mods: M({ meta: true }) });
    key(K.e, M({ meta: true }));
    send({ type: 'keyup', keycode: VC.META_L, mods: M() });
    await settle();
    expect(out.map((e) => [e.key, e.modifiers])).toEqual([['win', []], ['e', ['win']]]);
  });

  it('follows Caps Lock for letters only', async () => {
    await startRec();
    key(VC.CAPS_LOCK);
    keys([K.a, K.one]);
    key(K.a, M({ shift: true }));
    key(VC.CAPS_LOCK);
    keys([K.a]);
    await settle();
    expect(out.map((e) => e.text)).toEqual(['A1aa']);
  });

  it('types the keypad with Num Lock on and names its keys with it off', async () => {
    await startRec();
    keys([K.kp7, K.slash]);
    key(K.kpEnd);
    await settle();
    expect(out.map((e) => e.text ?? e.key)).toEqual(['7/', 'end']);
  });

  it('marks a key that repeats', async () => {
    await startRec();
    send({ type: 'keydown', keycode: VC.DELETE, mods: M() });
    send({ type: 'keydown', keycode: VC.DELETE, mods: M() });
    send({ type: 'keyup', keycode: VC.DELETE, mods: M() });
    send({ type: 'keydown', keycode: VC.DELETE, mods: M() });
    await settle();
    expect(out.map((e) => [e.key, e.repeat])).toEqual([['delete', undefined], ['delete', true], ['delete', undefined]]);
  });
});

describe('scrolling', () => {
  it('adds wheel turns up into one scroll until they pause', async () => {
    await startRec();
    for (let i = 0; i < 3; i++) send({ type: 'wheel', x: 300, y: 400 + i, dx: 0, dy: 3, mods: M() });
    await vi.advanceTimersByTimeAsync(SCROLL_PAUSE_MS - 10);
    send({ type: 'wheel', x: 300, y: 410, dx: 0, dy: -1, mods: M() });
    await settle();
    expect(out.map(strip)).toEqual([{ kind: 'scroll', x: 300, y: 410, dx: 0, dy: 8, modifiers: [], app: 'Notepad', window_title: 'notes.txt - Notepad' }]);
  });

  it('hands a scroll over before a press', async () => {
    await startRec();
    send({ type: 'wheel', x: 1, y: 1, dx: 2, dy: 0, mods: M() });
    click(1, 1);
    await settle();
    expect(out.map((e) => [e.kind, e.dx])).toEqual([['scroll', 2], ['click', undefined]]);
  });
});

describe('AppuBot\'s own windows', () => {
  it('leaves out what happens in them', async () => {
    await startRec();
    host.fg = (at) => ({ app: 'AppuBot', self: !!at && at.x > 1000 });
    click(1200, 50);
    click(10, 50);
    await settle();
    expect(out.map((e) => [e.kind, e.x])).toEqual([['click', 10]]);
  });

  it('records the event without its window when the lookup fails', async () => {
    await startRec();
    host.fg = () => Promise.reject(new Error('xprop crashed'));
    click(10, 10);
    await settle(3000);
    expect(out).toHaveLength(1);
    expect(out[0]!.app).toBeUndefined();
  });
});

describe('start and stop', () => {
  it('refuses to start where recording can\'t run, with the reason', async () => {
    host.ok = false;
    host.reason = 'Recording needs an X11 (Xorg) session';
    rec = new InputRecorder(host, (e) => out.push(e), { platform: 'linux', screenshots: true, scale: 0.5 });
    await expect(rec.start()).rejects.toThrow('X11');
    expect(host.onInput).toBeNull();
  });

  it('hands over pending typing and scrolling at stop, then ignores input', async () => {
    await startRec();
    const feed = host.onInput!;
    send({ type: 'wheel', x: 1, y: 1, dx: 0, dy: 1, mods: M() });
    keys([K.h, K.e]);
    const stopping = rec.stop();
    await settle();
    await stopping;
    expect(host.stopped).toBe(1);
    // the helper's order at stop: typing, then scrolling
    expect(out.map((e) => e.kind)).toEqual(['typed', 'scroll']);
    feed({ type: 'keydown', keycode: K.h, mods: M() });
    await settle();
    expect(out).toHaveLength(2);
    await rec.stop();
    expect(host.stopped).toBe(1);
  });
});

describe('key tables', () => {
  it('reads characters on a US layout', () => {
    expect(charFor(K.a, false)).toBe('a');
    expect(charFor(K.a, true)).toBe('A');
    expect(charFor(K.a, false, true)).toBe('A');
    expect(charFor(K.a, true, true)).toBe('a');
    expect(charFor(K.one, true, true)).toBe('!');
    expect(charFor(K.slash, true)).toBe('?');
    expect(charFor(K.space, true)).toBe(' ');
    expect(charFor(VC.ENTER, false)).toBeUndefined();
    expect(charFor(VC.TAB, false)).toBeUndefined();
  });

  it('names keys in the helper\'s words', () => {
    expect(keyName(K.a)).toBe('a');
    expect(keyName(K.one)).toBe('1');
    expect(keyName(K.space)).toBe('space');
    expect(keyName(VC.ENTER)).toBe('enter');
    expect(keyName(VC.KP_ENTER)).toBe('kpenter');
    expect(keyName(VC.ESCAPE)).toBe('escape');
    expect(keyName(0x0057)).toBe('f11');
    expect(keyName(0x006b)).toBe('f24');
    expect(keyName(VC.LEFT)).toBe('left');
    expect(keyName(K.kp7)).toBe('kp7');
    expect(keyName(0x1234)).toBe('keycode_4660');
  });

  it('names modifiers per platform', () => {
    const all = M({ ctrl: true, alt: true, shift: true, meta: true });
    expect(modifierNames(all, 'win32')).toEqual(['win', 'ctrl', 'alt', 'shift']);
    expect(modifierNames(all, 'linux')).toEqual(['super', 'ctrl', 'alt', 'shift']);
    expect(modifierNames(M(), 'linux')).toEqual([]);
  });
});

describe('linuxSessionProblem', () => {
  it('refuses Wayland sessions and sessions without a display', () => {
    expect(linuxSessionProblem({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' })).toMatch(/X11/);
    expect(linuxSessionProblem({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })).toMatch(/Wayland/);
    expect(linuxSessionProblem({ XDG_SESSION_TYPE: 'tty' })).toMatch(/display/);
    expect(linuxSessionProblem({})).toMatch(/display/);
  });

  it('accepts X11 sessions', () => {
    expect(linuxSessionProblem({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' })).toBeNull();
    // an X11 session that happens to have a nested Wayland compositor's variable around
    expect(linuxSessionProblem({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-1' })).toBeNull();
    expect(linuxSessionProblem({ DISPLAY: ':1' })).toBeNull();
  });
});
