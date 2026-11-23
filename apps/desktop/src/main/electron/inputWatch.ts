/**
 * Teach mode's recording on Windows and Linux (`CoreDeps.inputWatch`; core's `InputRecorder` makes the steps):
 * - global mouse/keyboard hooks from uiohook-napi (a low-level hook on Windows, XRecord on X11), loaded the first time
 *   recording is asked about and never on macOS, where the Swift helper records. It sees nothing of native Wayland
 *   apps, so a Wayland session doesn't record (`linuxSessionProblem`);
 * - points in DIPs, the space macOS's helper reports points in: Windows' hook gives physical pixels
 *   (`screen.screenToDipPoint`); on X11, libuiohook shifts points by its first CRTC's origin when there are several,
 *   so the pointer's own position (`screen.getCursorScreenPoint`, a click doesn't move it) is used there;
 * - the window in front: Linux `xprop`, Windows one PowerShell process for the whole recording (core `foreground.ts`);
 *   a window of this process is AppuBot's own. When neither tells, AppuBot's focused window does;
 * - a picture of the display under a click (`desktopCapturer`, one at a time so input never waits on it).
 * Everything here fails soft: no module, no xprop, no PowerShell just means less detail (or manual mode).
 */
import type { ChildProcess } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { BrowserWindow, desktopCapturer, screen } from 'electron';
import { killTree, spawnCommand } from '@appubot/agent-runtime';
import { PS_FOREGROUND_SCRIPT, parseActiveWindowId, parsePsLine, parseXpropWindow, type ForegroundInfo } from '../core/services/foreground';
import { linuxSessionProblem, type Foreground, type InputWatchHost, type Mods, type Point, type RawInput } from '../core/services/inputRecorder';
import { errMsg, type Logger } from '../core/util';

type Uiohook = typeof import('uiohook-napi');
type HookEvent = { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

/** libuiohook's WHEEL_VERTICAL_DIRECTION */
const WHEEL_VERTICAL = 3;
const PROBE_WAIT_MS = 800;
const JPEG_QUALITY = 60;

let hookModule: Promise<Uiohook | null> | null = null;
let loadError = '';

/** uiohook-napi, loaded once (its N-API prebuild for this platform sits in app.asar.unpacked when packaged) */
function loadHooks(log: Logger): Promise<Uiohook | null> {
  hookModule ??= import('uiohook-napi').then(
    // a CommonJS module: its exports come as named exports, and as `default` in any case
    (m) => ((m as Partial<Uiohook>).uIOhook ? m : (m as unknown as { default: Uiohook }).default),
    (e: unknown) => {
      loadError = errMsg(e);
      log.warn('teach: the input hooks (uiohook-napi) did not load', loadError);
      return null;
    },
  );
  return hookModule;
}

/** what to tell the user when the hooks didn't load */
function loadProblem(): string {
  if (process.platform === 'linux' && /libX\w*\.so/.test(loadError)) {
    return 'Recording needs the X11 libraries libXtst and libXt (on Debian or Ubuntu: sudo apt install libxtst6 libxt6).';
  }
  return `Recording isn't available on this computer (${loadError || 'the input hooks did not load'}).`;
}

const modsOf = (e: HookEvent): Mods => ({ ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, meta: !!e.metaKey });

/** a hook point → DIPs (see the header) */
function toDip(x: number, y: number): Point {
  if (process.platform === 'win32') return screen.screenToDipPoint({ x, y });
  return screen.getCursorScreenPoint();
}

const inside = (b: Electron.Rectangle, p: Point): boolean => p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;

/** without a reading of the window in front: AppuBot's focused (and, for a mouse event, under the point) */
function ownWindowInFront(at?: Point): boolean {
  if (!BrowserWindow.getFocusedWindow()) return false;
  if (!at) return true;
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized() && inside(w.getBounds(), at));
}

/** reads the window in front; null when it can't */
interface ForegroundProbe { read(): Promise<ForegroundInfo | null>; close(): void }

/** a command's stdout, or null (missing, failed, too slow) */
function output(command: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let child: ChildProcess;
    try {
      child = spawnCommand(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { killTree(child); resolve(null); }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
}

/** Linux (X11): two `xprop` runs per reading; none at all once it turns out to be missing */
function xpropProbe(log: Logger): ForegroundProbe {
  let missing = false;
  return {
    async read() {
      if (missing) return null;
      const root = await output('xprop', ['-root', '-notype', '_NET_ACTIVE_WINDOW'], PROBE_WAIT_MS);
      if (root === null) {
        missing = true;
        log.info('teach: xprop is not available; steps are recorded without their app and window');
        return null;
      }
      const id = parseActiveWindowId(root);
      if (!id) return null;
      const props = await output('xprop', ['-id', id, '-notype', 'WM_CLASS', '_NET_WM_NAME', 'WM_NAME', '_NET_WM_PID'], PROBE_WAIT_MS);
      return props === null ? null : parseXpropWindow(props);
    },
    close() { /* nothing kept running */ },
  };
}

/** Windows: one PowerShell process answering a line per reading (it takes a second or two to start) */
function powershellProbe(log: Logger): ForegroundProbe {
  const script = join(tmpdir(), `appubot-foreground-${process.pid}.ps1`);
  const pending = new Map<number, (info: ForegroundInfo | null) => void>();
  let next = 1;
  let child: ChildProcess | null = null;
  const settleAll = (): void => { for (const r of pending.values()) r(null); pending.clear(); };
  try {
    writeFileSync(script, PS_FOREGROUND_SCRIPT, 'utf8');
    const exe = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    child = spawnCommand(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['pipe', 'pipe', 'ignore'] });
    const c = child;
    c.on('error', (e) => { log.info('teach: the foreground-window reader did not start', errMsg(e)); child = null; settleAll(); });
    c.on('exit', () => { if (child === c) child = null; settleAll(); });
    c.stdin?.on('error', () => undefined);
    if (c.stdout) {
      createInterface({ input: c.stdout }).on('line', (line) => {
        const a = parsePsLine(line);
        if (!a) return;
        const r = pending.get(a.id);
        pending.delete(a.id);
        r?.(a.info);
      });
    }
  } catch (e) {
    log.info('teach: the foreground-window reader did not start', errMsg(e));
    child = null;
  }
  return {
    read() {
      const c = child;
      if (!c?.stdin || c.stdin.destroyed) return Promise.resolve(null);
      const id = next++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(id); resolve(null); }, PROBE_WAIT_MS);
        pending.set(id, (info) => { clearTimeout(timer); resolve(info); });
        c.stdin!.write(`${id}\n`);
      });
    },
    close() {
      const c = child;
      child = null;
      settleAll();
      if (c) {
        c.stdin?.end();
        killTree(c);
      }
      try { rmSync(script, { force: true }); } catch { /* the temp folder's problem */ }
    },
  };
}

export function createInputWatchHost(log: Logger): InputWatchHost {
  let hooks: Uiohook | null = null;
  let detach: (() => void) | null = null;
  let probe: ForegroundProbe | null = null;
  let shooting = false;

  const stop = async (): Promise<void> => {
    detach?.();
    detach = null;
    probe?.close();
    probe = null;
    const m = hooks;
    hooks = null;
    if (m) {
      try { m.uIOhook.stop(); } catch (e) { log.warn('teach: stopping the input hooks failed', errMsg(e)); }
    }
  };

  return {
    async available() {
      if (process.platform === 'linux') {
        const why = linuxSessionProblem(process.env);
        if (why) return { ok: false, reason: why };
      }
      return (await loadHooks(log)) ? { ok: true } : { ok: false, reason: loadProblem() };
    },

    async start(onInput: (e: RawInput) => void) {
      const m = await loadHooks(log);
      if (!m) throw new Error(loadProblem());
      await stop();
      const h = m.uIOhook;
      const mouse = (type: 'mousedown' | 'mouseup') => (e: { x: number; y: number; button: unknown } & HookEvent): void => {
        onInput({ type, button: Number(e.button), ...toDip(e.x, e.y), mods: modsOf(e) });
      };
      const down = mouse('mousedown');
      const up = mouse('mouseup');
      const wheel = (e: { x: number; y: number; rotation: number; amount: number; direction: number } & HookEvent): void => {
        // a touchpad's part of a notch is 0 until it adds up
        const lines = e.rotation * (e.amount || 1);
        if (!lines) return;
        const vertical = e.direction === WHEEL_VERTICAL;
        onInput({ type: 'wheel', ...toDip(e.x, e.y), dx: vertical ? 0 : lines, dy: vertical ? lines : 0, mods: modsOf(e) });
      };
      const keydown = (e: { keycode: number } & HookEvent): void => onInput({ type: 'keydown', keycode: e.keycode, mods: modsOf(e) });
      const keyup = (e: { keycode: number } & HookEvent): void => onInput({ type: 'keyup', keycode: e.keycode, mods: modsOf(e) });
      h.on('mousedown', down);
      h.on('mouseup', up);
      h.on('wheel', wheel);
      h.on('keydown', keydown);
      h.on('keyup', keyup);
      detach = () => {
        h.off('mousedown', down);
        h.off('mouseup', up);
        h.off('wheel', wheel);
        h.off('keydown', keydown);
        h.off('keyup', keyup);
      };
      try {
        h.start();
      } catch (e) {
        detach();
        detach = null;
        throw e;
      }
      hooks = m;
      probe = process.platform === 'win32' ? powershellProbe(log) : xpropProbe(log);
    },

    stop,

    cursor: () => screen.getCursorScreenPoint(),

    async foreground(at?: Point): Promise<Foreground> {
      const info = probe ? await probe.read().catch(() => null) : null;
      const app = info?.app ? { app: info.app } : {};
      const title = info?.title ? { title: info.title } : {};
      if (info?.pid) return { ...app, ...title, self: info.pid === process.pid };
      return { ...app, ...title, self: ownWindowInFront(at) };
    },

    async screenshot(at: Point, scale: number) {
      // one at a time: a burst of clicks gets a picture for the first (teach keeps a few, evenly spaced, anyway)
      if (shooting) return null;
      shooting = true;
      try {
        const d = screen.getDisplayNearestPoint(at);
        const thumbnailSize = { width: Math.max(1, Math.round(d.size.width * scale)), height: Math.max(1, Math.round(d.size.height * scale)) };
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false });
        const src = sources.find((s) => s.display_id === String(d.id)) ?? (sources.length === 1 ? sources[0] : undefined);
        if (!src || src.thumbnail.isEmpty()) return null;
        return src.thumbnail.toJPEG(JPEG_QUALITY).toString('base64');
      } catch (e) {
        log.debug('teach: screenshot failed', errMsg(e));
        return null;
      } finally {
        shooting = false;
      }
    },
  };
}
