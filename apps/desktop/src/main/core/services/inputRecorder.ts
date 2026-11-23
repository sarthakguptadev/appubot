/**
 * Teach mode's recorder on Windows and Linux. The Electron host (`electron/inputWatch.ts`: uiohook-napi's global hooks,
 * a low-level hook on Windows, XRecord on X11) hands over raw mouse and keyboard events; this turns them into the same
 * InputEvent stream the macOS helper's watcher emits (native/appubot-helper Watcher.swift):
 * - a left press and release is a `click` (with its count: double and triple clicks by time and distance), or a
 *   `drag_end` with `from` when the pointer moved more than 5 points in between; a right press is a `right_click`,
 *   other buttons a `click`;
 * - printable keys without Ctrl/Alt/Win (Shift is fine) build up `typed` text (Backspace edits it) until a 0.6s pause,
 *   a press, a scroll or another key; any other key is a `key` event with its modifiers;
 * - wheel turns add up into one `scroll` until they stop for 0.3s (dy > 0 is down).
 * Clicks, right clicks and drags carry a picture of the display (`screenshot_base64`, taken at the press). Events in
 * AppuBot's own windows are left out (macOS drops them by app name, teach.ts `SELF_APPS`).
 * Keys are uiohook's (libuiohook `VC_*`) codes, which are layout independent: typed text is read as a US layout.
 * Pure (no Electron), so it runs in tests.
 */
import type { InputEvent } from './teach';

export interface Point { x: number; y: number }
export interface Mods { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }

/**
 * A global hook event as the host hands it over. Points are screen DIPs, the space macOS's helper reports points in.
 * Buttons are libuiohook's: 1 left, 2 right, 3 middle, 4 and 5 the side buttons. Wheel turns are in lines, dy > 0 down
 * and dx > 0 right.
 */
export type RawInput =
  | { type: 'mousedown' | 'mouseup'; button: number; x: number; y: number; mods: Mods }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number; mods: Mods }
  | { type: 'keydown' | 'keyup'; keycode: number; mods: Mods };

type MouseInput = Extract<RawInput, { button: number }>;
type WheelInput = Extract<RawInput, { type: 'wheel' }>;
type KeyInput = Extract<RawInput, { keycode: number }>;

/** The window an event went to: its app and title when the host can tell, and whether it is one of AppuBot's own. */
export interface Foreground { app?: string; title?: string; self: boolean }

/** What the recorder needs from the desktop (Electron in the app: `electron/inputWatch.ts`; a fake in tests). */
export interface InputWatchHost {
  /** whether recording can run on this computer; `reason` says why not (a Wayland session, missing X11 libraries) */
  available(): Promise<{ ok: boolean; reason?: string }>;
  /** starts the global hooks; rejects when they can't run */
  start(onInput: (e: RawInput) => void): Promise<void>;
  stop(): Promise<void>;
  /** the pointer now, in DIPs */
  cursor(): Point;
  /** the window in front (`at`: the point a mouse event happened at) */
  foreground(at?: Point): Promise<Foreground>;
  /** a JPEG (base64) of the display under `at`, at `scale` times its size; null when it can't (or one is being taken) */
  screenshot(at: Point, scale: number): Promise<string | null>;
}

/** like the helper: a release more than this many points from its press is a drag */
export const DRAG_MIN = 5;
/** like the helper: typed text is one step until the keys pause this long */
export const TYPED_PAUSE_MS = 600;
/** like the helper: wheel turns are one scroll until they pause this long */
export const SCROLL_PAUSE_MS = 300;
/** presses of the same button this close in time and space are a double (triple…) click (Windows' defaults are 500ms, 4px) */
export const MULTI_CLICK_MS = 500;
export const MULTI_CLICK_DIST = 5;
/** a mouse event's window is looked up this long after it, once a click into another app has brought that app forward */
export const SETTLE_MS = 120;
const FOREGROUND_WAIT_MS = 1500;
const SHOT_WAIT_MS = 3000;
const STOP_WAIT_MS = 3000;
const UNKNOWN: Foreground = { self: false };

/* libuiohook key codes (uiohook.h VC_*) */
export const VC = {
  ESCAPE: 0x0001, BACKSPACE: 0x000e, TAB: 0x000f, ENTER: 0x001c, SPACE: 0x0039,
  CAPS_LOCK: 0x003a, NUM_LOCK: 0x0045, SCROLL_LOCK: 0x0046,
  SHIFT_L: 0x002a, SHIFT_R: 0x0036, CONTROL_L: 0x001d, CONTROL_R: 0x0e1d, ALT_L: 0x0038, ALT_R: 0x0e38,
  META_L: 0x0e5b, META_R: 0x0e5c,
  KP_ENTER: 0x0e1c, DELETE: 0x0e53, F4: 0x003e, LEFT: 0xe04b,
} as const;

/** US layout: key → [unshifted, shifted] */
const PRINTABLE = new Map<number, [string, string]>([
  [0x0029, ['`', '~']], [0x0002, ['1', '!']], [0x0003, ['2', '@']], [0x0004, ['3', '#']], [0x0005, ['4', '$']],
  [0x0006, ['5', '%']], [0x0007, ['6', '^']], [0x0008, ['7', '&']], [0x0009, ['8', '*']], [0x000a, ['9', '(']],
  [0x000b, ['0', ')']], [0x000c, ['-', '_']], [0x000d, ['=', '+']], [0x001a, ['[', '{']], [0x001b, [']', '}']],
  [0x002b, ['\\', '|']], [0x0027, [';', ':']], [0x0028, ["'", '"']], [0x0033, [',', '<']], [0x0034, ['.', '>']],
  [0x0035, ['/', '?']], [0x0039, [' ', ' ']],
  ...([
    ['a', 0x001e], ['b', 0x0030], ['c', 0x002e], ['d', 0x0020], ['e', 0x0012], ['f', 0x0021], ['g', 0x0022],
    ['h', 0x0023], ['i', 0x0017], ['j', 0x0024], ['k', 0x0025], ['l', 0x0026], ['m', 0x0032], ['n', 0x0031],
    ['o', 0x0018], ['p', 0x0019], ['q', 0x0010], ['r', 0x0013], ['s', 0x001f], ['t', 0x0014], ['u', 0x0016],
    ['v', 0x002f], ['w', 0x0011], ['x', 0x002d], ['y', 0x0015], ['z', 0x002c],
  ] as const).map(([c, k]): [number, [string, string]] => [k, [c, c.toUpperCase()]]),
]);
const LETTERS = new Set([...PRINTABLE].filter(([, [c]]) => c >= 'a' && c <= 'z').map(([k]) => k));

/** the keypad with Num Lock on: its character and its key name (the helper's `kp…` names) */
const KEYPAD = new Map<number, [string, string]>([
  [0x0052, ['0', 'kp0']], [0x004f, ['1', 'kp1']], [0x0050, ['2', 'kp2']], [0x0051, ['3', 'kp3']], [0x004b, ['4', 'kp4']],
  [0x004c, ['5', 'kp5']], [0x004d, ['6', 'kp6']], [0x0047, ['7', 'kp7']], [0x0048, ['8', 'kp8']], [0x0049, ['9', 'kp9']],
  [0x0053, ['.', 'kpdecimal']], [0x0e35, ['/', 'kpdivide']], [0x0037, ['*', 'kpmultiply']], [0x004a, ['-', 'kpminus']],
  [0x004e, ['+', 'kpplus']], [0x0e0d, ['=', 'kpequals']], [0x007e, [',', 'kpcomma']],
]);

/** names of the other keys, in the helper's words where it has one (`enter`, `escape`, `pageup`, `f5`, …) */
const KEY_NAMES = new Map<number, string>([
  [0x0001, 'escape'], [0x000e, 'backspace'], [0x000f, 'tab'], [0x001c, 'enter'], [0x0039, 'space'], [0x0e1c, 'kpenter'],
  ...[0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x57, 0x58, 0x5b, 0x5c, 0x5d, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b]
    .map((k, i): [number, string] => [k, `f${i + 1}`]),
  [0x0e37, 'printscreen'], [0x0e45, 'pause'], [0x0e52, 'insert'], [0x0e53, 'delete'], [0x0e47, 'home'], [0x0e4f, 'end'],
  [0x0e49, 'pageup'], [0x0e51, 'pagedown'], [0xe048, 'up'], [0xe04b, 'left'], [0xe04c, 'clear'], [0xe04d, 'right'],
  [0xe050, 'down'], [0x0e5d, 'menu'],
  // the keypad with Num Lock off (VC_KP_END = 0xEE00 | VC_KP_1, …)
  [0xee4f, 'end'], [0xee50, 'down'], [0xee51, 'pagedown'], [0xee4b, 'left'], [0xee4c, 'clear'], [0xee4d, 'right'],
  [0xee47, 'home'], [0xee48, 'up'], [0xee49, 'pageup'], [0xee52, 'insert'], [0xee53, 'delete'],
  [0xe020, 'mute'], [0xe030, 'volumeup'], [0xe02e, 'volumedown'], [0xe022, 'playpause'], [0xe024, 'mediastop'],
  [0xe010, 'previoustrack'], [0xe019, 'nexttrack'], [0xe06a, 'browserback'], [0xe069, 'browserforward'],
  [0xe067, 'browserrefresh'], [0xe065, 'browsersearch'], [0xe032, 'browserhome'],
]);

/** modifier and lock keys: never steps of their own (macOS reports them as flag changes, which the helper doesn't tap) */
const MODIFIER_KEYS = new Set<number>([
  VC.SHIFT_L, VC.SHIFT_R, VC.CONTROL_L, VC.CONTROL_R, VC.ALT_L, VC.ALT_R, VC.META_L, VC.META_R,
  VC.CAPS_LOCK, VC.NUM_LOCK, VC.SCROLL_LOCK,
]);
const META_KEYS = new Set<number>([VC.META_L, VC.META_R]);

/** the character a key types on a US layout, if it types one */
export function charFor(keycode: number, shift: boolean, capsLock = false): string | undefined {
  const pair = PRINTABLE.get(keycode);
  if (pair) return (LETTERS.has(keycode) ? shift !== capsLock : shift) ? pair[1] : pair[0];
  return KEYPAD.get(keycode)?.[0];
}

/** a key's name, in the helper's vocabulary: the character for character keys, else `enter`, `f5`, `kp1`, … */
export function keyName(keycode: number): string {
  const pair = PRINTABLE.get(keycode);
  if (pair) return keycode === VC.SPACE ? 'space' : pair[0];
  return KEYPAD.get(keycode)?.[1] ?? KEY_NAMES.get(keycode) ?? `keycode_${keycode}`;
}

/** the Windows key is `win`, Linux's Super key `super` (the helper's `cmd` on macOS) */
export function metaName(platform: string): string {
  return platform === 'win32' ? 'win' : platform === 'darwin' ? 'cmd' : 'super';
}

/** modifier names in the order Windows writes shortcuts: Win+Ctrl+Alt+Shift */
export function modifierNames(m: Mods, platform: string): string[] {
  const out: string[] = [];
  if (m.meta) out.push(metaName(platform));
  if (m.ctrl) out.push('ctrl');
  if (m.alt) out.push('alt');
  if (m.shift) out.push('shift');
  return out;
}

/**
 * Why recording can't run in this Linux session (null when it can): the hooks read X11's XRecord, which sees nothing
 * of native Wayland apps.
 */
export function linuxSessionProblem(env: Record<string, string | undefined>): string | null {
  const type = (env.XDG_SESSION_TYPE ?? '').toLowerCase();
  if (type === 'wayland' || (type !== 'x11' && env.WAYLAND_DISPLAY)) {
    return 'Recording needs an X11 (Xorg) session: on Wayland, AppuBot can\'t see clicks and keys in other apps.';
  }
  if (!env.DISPLAY) return 'Recording needs an X11 display, and none was found.';
  return null;
}

/** helper-style rounding to 2 decimals */
const r2 = (n: number): number => Math.round(n * 100) / 100;
const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

export interface RecorderOptions {
  /** 'win32' or 'linux': names the Windows/Super key */
  platform: string;
  /** a picture of the display with each click, right click and drag */
  screenshots: boolean;
  /** the pictures' size against the display's (the helper's `scale`) */
  scale: number;
  now?: () => number;
}

interface Press extends Point { ts: number; count: number; shot?: Promise<string | null> }

export class InputRecorder {
  private running = false;
  private typed = '';
  private typedTs = 0;
  private typedFg: Promise<Foreground> | null = null;
  private typedTimer: ReturnType<typeof setTimeout> | null = null;
  private down: Press | null = null;
  private lastPress: (Point & { button: number; ts: number; count: number }) | null = null;
  private scroll = { dx: 0, dy: 0, x: 0, y: 0 };
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  /** keys down now: a second keydown without a keyup is the key repeating */
  private held = new Set<number>();
  /** Caps Lock as toggled while recording (assumed off at the start: the hooks don't say) */
  private caps = false;
  /** the Windows/Super key pressed with nothing else since (alone, it opens the Start menu or Activities) */
  private soloMeta: { code: number; mods: Mods; ts: number } | null = null;
  /** events wait here for their window and picture, and come out in order */
  private tail: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private host: InputWatchHost, private emit: (e: InputEvent) => void, private o: RecorderOptions) {
    this.now = o.now ?? Date.now;
  }

  async start(): Promise<void> {
    const a = await this.host.available();
    if (!a.ok) throw new Error(a.reason ?? 'recording is not available on this computer');
    this.running = true;
    try {
      await this.host.start((e) => this.input(e));
    } catch (e) {
      this.running = false;
      throw e;
    }
  }

  /** Stops the hooks and hands over what was still building up (typed text, a scroll), like the helper's watch_stop. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.host.stop().catch(() => undefined);
    this.flushTyped();
    this.flushScroll();
    this.down = null;
    this.soloMeta = null;
    await within(this.tail, STOP_WAIT_MS, undefined);
  }

  /** one raw hook event (public for tests) */
  input(e: RawInput): void {
    if (!this.running) return;
    const ts = this.now();
    switch (e.type) {
      case 'mousedown': return this.press(e, ts);
      case 'mouseup': return this.release(e, ts);
      case 'wheel': return this.wheel(e);
      case 'keydown': return this.keyDown(e, ts);
      case 'keyup': return this.keyUp(e, ts);
    }
  }

  private press(e: MouseInput, ts: number): void {
    this.flushTyped();
    this.flushScroll();
    this.soloMeta = null;
    // a key whose release was missed (a secure desktop, a UAC prompt) shouldn't count as repeating forever
    this.held.clear();
    const p = { x: e.x, y: e.y };
    const last = this.lastPress;
    const count = last && last.button === e.button && ts - last.ts <= MULTI_CLICK_MS && dist(last, p) <= MULTI_CLICK_DIST ? last.count + 1 : 1;
    this.lastPress = { ...p, button: e.button, ts, count };
    if (e.button === 1) {
      // the click (or drag) is reported at the release; the picture is taken now, like the helper's
      this.down = { ...p, ts, count, shot: this.shot(p) };
      return;
    }
    if (e.button === 2) {
      this.enqueue({ ...this.base('right_click', p, e.mods, ts), button: 'right' }, this.settled(p), this.shot(p));
      return;
    }
    // the helper's otherMouseDown: a click, no picture
    const button = e.button === 4 ? 'back' : e.button === 5 ? 'forward' : 'middle';
    this.enqueue({ ...this.base('click', p, e.mods, ts), button, count }, this.settled(p));
  }

  private release(e: MouseInput, ts: number): void {
    if (e.button !== 1) return;
    const p = { x: e.x, y: e.y };
    const start: Press = this.down ?? { ...p, ts, count: 1 };
    this.down = null;
    if (dist(start, p) > DRAG_MIN) {
      // a drag ends any run of clicks
      this.lastPress = null;
      this.enqueue({ ...this.base('drag_end', p, e.mods, ts), from: { x: r2(start.x), y: r2(start.y) }, duration_ms: ts - start.ts, button: 'left' }, this.settled(p), start.shot);
    } else {
      this.enqueue({ ...this.base('click', p, e.mods, ts), count: start.count, button: 'left' }, this.settled(p), start.shot);
    }
  }

  private wheel(e: WheelInput): void {
    this.flushTyped();
    this.soloMeta = null;
    this.scroll.dx += e.dx;
    this.scroll.dy += e.dy;
    this.scroll.x = e.x;
    this.scroll.y = e.y;
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => this.flushScroll(), SCROLL_PAUSE_MS);
  }

  private keyDown(e: KeyInput, ts: number): void {
    const code = e.keycode;
    const repeat = this.held.has(code);
    this.held.add(code);
    if (META_KEYS.has(code)) {
      if (!repeat) this.soloMeta = { code, mods: e.mods, ts };
      return;
    }
    if (code === VC.CAPS_LOCK) {
      if (!repeat) this.caps = !this.caps;
      return;
    }
    if (MODIFIER_KEYS.has(code)) return;
    this.soloMeta = null;
    const shortcut = e.mods.ctrl || e.mods.alt || e.mods.meta;
    const ch = charFor(code, e.mods.shift, this.caps);
    if (!shortcut && ch !== undefined) {
      if (!this.typed) {
        this.typedTs = ts;
        this.typedFg = this.host.foreground();
      }
      this.typed += ch;
      this.scheduleTyped();
      return;
    }
    if (code === VC.BACKSPACE && !shortcut && this.typed) {
      // Backspace while typing edits the pending text
      this.typed = Array.from(this.typed).slice(0, -1).join('');
      this.scheduleTyped();
      return;
    }
    this.flushTyped();
    this.flushScroll();
    const ev: InputEvent = { ...this.base('key', this.host.cursor(), e.mods, ts), key: keyName(code) };
    if (ch !== undefined && !e.mods.ctrl && !e.mods.alt) ev.chars = ch;
    if (repeat) ev.repeat = true;
    this.enqueue(ev, this.host.foreground());
  }

  private keyUp(e: KeyInput, ts: number): void {
    this.held.delete(e.keycode);
    const solo = this.soloMeta;
    if (!solo || solo.code !== e.keycode) return;
    this.soloMeta = null;
    // the Windows/Super key alone: the Start menu, GNOME's Activities
    this.flushTyped();
    this.flushScroll();
    const mods = { ...solo.mods, meta: false };
    this.enqueue({ ...this.base('key', this.host.cursor(), mods, ts), key: metaName(this.o.platform) }, this.host.foreground());
  }

  private scheduleTyped(): void {
    if (this.typedTimer) clearTimeout(this.typedTimer);
    this.typedTimer = setTimeout(() => this.flushTyped(), TYPED_PAUSE_MS);
  }

  private flushTyped(): void {
    if (this.typedTimer) clearTimeout(this.typedTimer);
    this.typedTimer = null;
    if (!this.typed) return;
    const at = this.host.cursor();
    const fg = this.typedFg ?? this.host.foreground();
    this.enqueue({ kind: 'typed', text: this.typed, ts: this.typedTs, end_ts: this.now(), x: r2(at.x), y: r2(at.y), modifiers: [] }, fg);
    this.typed = '';
    this.typedFg = null;
  }

  private flushScroll(): void {
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = null;
    const s = this.scroll;
    if (s.dx === 0 && s.dy === 0) return;
    const p = { x: s.x, y: s.y };
    this.enqueue({ kind: 'scroll', x: r2(s.x), y: r2(s.y), dx: r2(s.dx), dy: r2(s.dy), modifiers: [], ts: this.now() }, this.host.foreground(p));
    this.scroll = { dx: 0, dy: 0, x: 0, y: 0 };
  }

  private base(kind: string, p: Point, mods: Mods, ts: number): InputEvent {
    return { kind, x: r2(p.x), y: r2(p.y), modifiers: modifierNames(mods, this.o.platform), ts };
  }

  private shot(p: Point): Promise<string | null> | undefined {
    if (!this.o.screenshots) return undefined;
    return this.host.screenshot(p, this.o.scale).catch(() => null);
  }

  /** the window a mouse event went to, looked up once a click into another app has brought it forward */
  private settled(p: Point): Promise<Foreground> {
    return delay(SETTLE_MS).then(() => this.host.foreground(p));
  }

  private enqueue(event: InputEvent, fg: Promise<Foreground>, shot?: Promise<string | null>): void {
    const where = within(fg, FOREGROUND_WAIT_MS, UNKNOWN);
    const picture = shot ? within(shot, SHOT_WAIT_MS, null) : Promise.resolve(null);
    this.tail = this.tail.then(async () => {
      const [f, s] = await Promise.all([where, picture]);
      if (f.self) return;
      const out: InputEvent = { ...event };
      if (f.app) out.app = f.app;
      if (f.title) out.window_title = f.title;
      if (s) out.screenshot_base64 = s;
      try {
        this.emit(out);
      } catch {
        /* the listener's own failure */
      }
    });
  }
}
