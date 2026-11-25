/** What a computer-use backend is to ComputerService (computer.ts): the pictures, window snapshots and input it gives. */
import type { ComputerAction, ComputerTarget } from '@appubot/protocol';

export interface Perms { accessibility: boolean; screenRecording: boolean; inputMonitoring?: boolean }
export interface ScreenInfo { width: number; height: number; scale: number }
export interface Shot { data: string; mimeType: string; width: number; height: number }

export interface Rect { x: number; y: number; w: number; h: number }

/** Where things are in an app window's last snapshot: element centres in snapshot pixels and in screen points. */
export interface WindowGeometry {
  target: ComputerTarget & { bounds: NonNullable<ComputerTarget['bounds']> };
  shotWidth: number;
  shotHeight: number;
  elements: Map<string, { px: { x: number; y: number }; pt: { x: number; y: number }; role?: string; label?: string }>;
  /** Cua's snapshot id: element N of this snapshot is the token "<snapshotId>:N" */
  snapshotId?: string;
  /** web content in the picture (AXWebArea frames, snapshot pixels) */
  web: Rect[];
  /** a web browser: its page may be missing from the tree (another tab, a truncated walk), so treat it as web */
  browser: boolean;
}
export interface WindowSnapshot { shot: Shot; geometry: WindowGeometry; text: string }

export interface ActOptions {
  /** the user taking over (no bot): whole-screen coordinates are allowed, and they do move the real pointer */
  desktop: boolean;
  /**
   * The action aims at web content (a browser page, an Electron app). Pages only react to real input: a background
   * pixel click there becomes an accessibility press on whatever element sits under the point, which custom buttons
   * (a cart's "+") ignore. So the backend clicks and types for real, then puts the user's pointer back.
   */
  web?: boolean;
  /** where a pointer action lands, in global screen points (from the window's last snapshot) */
  pt?: { x: number; y: number };
  /**
   * The window was brought to the front for the user to watch (on-screen mode): while it is still the frontmost
   * window, keys and typing go to it as real keystrokes (tens of ms) rather than Cua's background route, which
   * waits about a second per call to read back an effect. Keystrokes never move the user's pointer.
   */
  front?: boolean;
  /**
   * Background mode (a bot's action, with the user working meanwhile): input that needs the window in front (a real
   * click or typing on a web page, a modified click, a drag, what the app refused in the background, a step the bot
   * asked to send in front) goes out through this. It waits until the user pauses, then `send` brings the window
   * forward for a moment, and the user's app or window and pointer are put back if they moved (see
   * CuaBackend.userPlace). Absent on screen, where the window is in front already.
   */
  borrow?: Borrow;
  /**
   * The screen is the bots' own (your AppuBot computer): their input goes out for real, in the foreground (real pointer
   * and keystrokes on the display, the window raised), never through the background routes that exist so a person can
   * keep working beside them.
   */
  real?: boolean;
}

/** Sends input that needs the window in front without getting in the user's way (see ActOptions.borrow). */
export type Borrow = <T>(send: () => Promise<T>) => Promise<T>;

/** Where the user was before a borrowed step: put them back (their pointer, the app they were in) if it moved them. */
export interface UserPlace { restore(): Promise<void> }

/** What opening an app gave: its pid and the window to work in (absent when it has none on screen yet). */
export interface Opened { pid: number; windowId?: number }

export interface ComputerBackend {
  readonly name: 'cua-driver' | 'native';
  init(): Promise<void>;
  permissions(): Promise<Perms>;
  requestPermissions(): Promise<void>;
  screenSize(): Promise<ScreenInfo>;
  /** Screenshot whose pixel space is the coordinate space for subsequent actions. */
  screenshot(o: { maxWidth: number; quality: number }): Promise<Shot>;
  act(a: ComputerAction, o?: ActOptions): Promise<{ text?: string; opened?: Opened }>;
  /** App window snapshot for the agent: screenshot + element tokens (replaces that window's previous tokens). */
  windowSnapshot?(o: { pid: number; windowId: number; maxElements: number; maxWidth: number }): Promise<WindowSnapshot>;
  /** Picture of an app window for the live view; leaves the agent's element tokens alone. */
  windowShot?(o: { pid: number; windowId: number; maxWidth: number }): Promise<{ shot: Shot; target: ComputerTarget }>;
  /** Bring an app window to the front (so the user can watch the bot work in it). */
  raise?(pid: number, windowId: number): Promise<void>;
  /** Is this the frontmost window on screen? (cheap: lets `raise`, which is slow, be skipped) */
  isFront?(pid: number, windowId: number): Promise<boolean>;
  /**
   * Can the user see this window at a point (global screen points: the topmost window there), or with no point, is it
   * the frontmost window? Background mode only draws the bot's cursor where its window shows.
   */
  visibleAt?(pid: number, windowId: number, pt?: { x: number; y: number }): Promise<boolean>;
  /** Note where the user is (pointer, app in front) before a borrowed step, to put them back after it. */
  userPlace?(): Promise<UserPlace>;
  /** The topmost window at a global screen point, named (teach mode says where a click landed). */
  windowAtPoint?(pt: { x: number; y: number }): Promise<{ app?: string; title?: string } | undefined>;
  shutdown(): Promise<void>;
}
