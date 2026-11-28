import { create } from 'zustand';
import { controlDeadline } from '@appubot/chat-core';
import { parseComputerMessage, type CloudDesktopLink, type ScreenControl, type ViewerToComputer } from '@appubot/protocol';
import { errorMessage } from '../../lib/gateway';
import { pushToast } from '../../lib/store';
import { desktopLink, useCloud } from './cloudAccount';
import { RECONNECT_GIVE_UP, autoStart, rateOver, reconnectDelayMs, stepQuality, type AutoState } from './desktopQuality';
import { CLIPBOARD_MAX, PREVIEW_LEVELS, PREVIEW_PACE_MS, XK_CONTROL_L, controlUntil, localControl, screenRefused, screenUrl, shortcutKeysym, type ScreenPhase } from './screenView';
import { ViewerChannel } from './viewerChannel';
import { ScreenWants } from './screenWants';

/*
 * The screen of your AppuBot computer (or a team's), one connection for every view of it in this window: the side
 * panel's small preview (Computer tab) and the full-screen viewer (`DesktopView`). A view asks for it with
 * `wantScreen(key, {full, team, screen})` (`screen`: a bot's own screen on the computer, by the bot's id; one screen at a
 * time, the full viewer's choice first) and lets go with `releaseScreen(key)`; nobody wanting it for `RELEASE_GRACE_MS`
 * (`screenWants.ts`) closes the socket, so nothing keeps the computer awake for nothing, while a view coming back
 * within it (a tab switched, the panel collapsed for a moment) finds the same live connection. The picture is one
 * element (`screenElement`), moved into whichever view is up (`ScreenSurface`: the full viewer wins) and refitted to
 * it at once, so expanding the preview, and closing the viewer again, shows the live picture without a reconnect.
 *
 * It is noVNC's RFB client, bundled with the app (`@novnc/novnc`, pinned), over a WebSocket opened here to the
 * computer's screen port from a 60-second signed link the backend mints for this Mac (`cloudAccount.desktopLink`).
 * Owning the socket lets it measure what arrives and move the picture quality by it (`desktopQuality.ts` `auto`) and
 * pace the preview (`ViewerChannel.pace`: one picture a second at the cheapest quality, `PREVIEW_*`). A dropped
 * connection mints a fresh link and reconnects by itself with a growing wait (the last picture stays up meanwhile),
 * and a socket slow to open means the computer is waking (its URL wakes it).
 *
 * Watching / Take control (chat-core `controlPill`): the socket carries the screen port's control channel beside the
 * VNC bytes (protocol `viewerControl.ts`, kept out of noVNC's way by `ViewerChannel`); the computer lets this
 * viewer's input through only while it has control, and every bot's computer use waits meanwhile. A computer from
 * before the channel (no `hello`) gets the same pill, held here alone (`localControl`). Control only exists in the full
 * viewer: going back to the preview gives it back. Left alone for `IDLE_PAUSE_MS` (no mouse or keys in this
 * window) the session pauses, so a panel left open overnight doesn't keep the computer awake.
 *
 * The clipboard, while this window has control (the computer takes a viewer's clipboard only then): what's copied on
 * the computer comes to this Mac's clipboard (noVNC's `clipboard` event, from Xvnc's; never while only watching, so a
 * bot copying something doesn't overwrite yours), and this Mac's goes to the computer on taking control, on coming
 * back to the window and right before a ⌘V. ⌘ shortcuts (⌘C, ⌘V, ⌘X, ⌘A, ⌘Z…) reach the computer as Ctrl ones, as its
 * apps (Linux) expect, and ⌘ alone stays the Mac's (never the computer's Super key).
 */

type RFB = import('@novnc/novnc').default;

/** what the session publishes for the views */
export interface ScreenState {
  phase: ScreenPhase;
  why: string;
  /** the computer speaks the control channel */
  speaks: boolean;
  control: ScreenControl | null;
  /** this window has control */
  mine: boolean;
  /** when control goes back by itself, on this window's clock */
  deadline: number;
  /** the full viewer is up (else only the preview) */
  full: boolean;
  team?: string;
  /** a bot's own screen on the computer (its id; absent: the computer's main screen) */
  screen?: string;
  /** the last picture (a data URL) shown while reconnecting or paused */
  lastFrame?: string;
  /** the computer's screen size in pixels (its framebuffer), once known: the full viewer fits a box of its shape */
  fb?: { w: number; h: number };
}
export const useScreen = create<ScreenState>()(() => ({ phase: 'idle', why: '', speaks: false, control: null, mine: false, deadline: 0, full: false }));

/**
 * The full-screen viewer's own state: open, for which computer (`team`; absent: the person's own) and in teach mode
 * (`teach`: mirror the input to the computer's teach session), or for an agent's sign-in (`signIn`: its name; control
 * is taken as the screen opens, since its terminal or browser waits for you there). `control`: the id of the screen control this window
 * holds now (the chats say "Paused while you’re in control").
 */
export const useCloudDesktop = create<{ open: boolean; team?: string; screen?: string; takeOver?: boolean; teach: boolean; signIn?: string; control?: string; from?: DOMRect }>()(() => ({ open: false, teach: false }));

/** no mouse or keyboard in this window for this long: pause */
const IDLE_PAUSE_MS = 15 * 60_000;
/** a socket not open after this long: the computer is waking */
const WAKING_MS = 2500;
/** the rate is measured over this window, every so often */
const RATE_WINDOW_MS = 2000;
const RATE_TICK_MS = 500;

interface Want { full: boolean; team?: string; screen?: string; takeControl?: boolean }
const wants = new ScreenWants<Want>({ change: (list) => reconcile(list), idle: () => stop() });

let running = false;
let runningTeam: string | undefined;
let runningScreen: string | undefined;
/** every link fetch and connection belongs to one generation; anything from an older one is ignored */
let gen = 0;
let client: RFB | null = null;
let socket: WebSocket | null = null;
let channel: ViewerChannel | null = null;
let say: (m: ViewerToComputer) => void = () => undefined;
let failures = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wakingTimer: ReturnType<typeof setTimeout> | null = null;
let rateTimer: ReturnType<typeof setInterval> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
/** watches noVNC's canvas for the screen's size (it sets the canvas to the framebuffer's size, no event of its own) */
let fbWatch: MutationObserver | null = null;
let auto: AutoState = autoStart();
let samples: { at: number; bytes: number }[] = [];
let lastTouch = Date.now();
let takeOnConnect = false;
/** control held here on a computer without the channel */
let localSince = 0;
let lastInputNote = 0;
/** the clipboard text last carried either way, so one copy doesn't bounce back */
let clipSeen = '';
/** the computer's copy that couldn't be written here yet (the window wasn't focused): written on the next focus */
let clipPending: string | null = null;

let el: HTMLDivElement | null = null;
/** The picture's element: noVNC draws into it; views move it into their place. */
export function screenElement(): HTMLDivElement {
  if (!el) {
    el = document.createElement('div');
    el.className = 'ab-screen absolute inset-0';
    el.style.backgroundPosition = 'center';
    el.style.backgroundRepeat = 'no-repeat';
    el.style.backgroundSize = 'contain';
    // watching (not in control): the Mac's own arrow over the picture, never noVNC's copy of the computer's cursor
    el.toggleAttribute('data-watching', !useScreen.getState().mine);
    useScreen.subscribe((st) => el?.toggleAttribute('data-watching', !st.mine));
  }
  return el;
}
/** the canvas noVNC draws on (null while there is none) */
export function screenCanvas(): HTMLCanvasElement | null { return el?.querySelector('canvas') ?? null; }

const surfaces = new Map<'preview' | 'full', HTMLElement>();
/** A view's place for the picture (the full viewer's wins over the preview's); null takes it away. */
export function placeSurface(slot: 'preview' | 'full', host: HTMLElement | null): void {
  if (host) surfaces.set(slot, host);
  else surfaces.delete(slot);
  const target = surfaces.get('full') ?? surfaces.get('preview');
  const e = screenElement();
  if (target && e.parentElement !== target) { target.appendChild(e); refitScreen(); }
  else if (!target) e.remove();
}

/**
 * Fit the picture to its place now (noVNC refits on its own ResizeObserver a frame later, which would show the old
 * size for a frame): after it moves between the preview and the full viewer, and when the viewer's box changes.
 */
export function refitScreen(): void {
  if (!client || !el?.isConnected) return;
  try { client.scaleViewport = true; } catch { /* not drawn yet */ }
}

/** who this viewer is, for "<name> has control" on the computer's other views */
function viewerName(): string {
  const account = useCloud.getState().view?.account;
  return account?.name?.trim() || account?.email || 'AppuBot on a Mac';
}

function set(s: Partial<ScreenState>): void { useScreen.setState(s); }

/** A view wants the screen (again with new wishes: the same key replaces them). */
export function wantScreen(key: string, want: Want): void { wants.want(key, want); }
export function releaseScreen(key: string): void { wants.release(key); }

function reconcile(list: Want[]): void {
  if (!list.length) {
    // nobody shows it: the connection lingers for the grace (closed by `stop` after), paced and with control given back
    if (!running) return;
    if (useScreen.getState().mine) giveBack();
    takeOnConnect = false;
    if (useScreen.getState().full) { set({ full: false }); applyMode(false); }
    return;
  }
  const fullWant = list.find((w) => w.full);
  const full = !!fullWant;
  const { team, screen } = fullWant ?? list[0]!;
  if (running && (runningTeam !== team || runningScreen !== screen)) stop();
  if (list.some((w) => w.takeControl)) takeOnConnect = true;
  const wasFull = useScreen.getState().full;
  set({ full, team, screen });
  if (!running) { start(team, screen); return; }
  applyMode(full);
  if (wasFull && !full) giveBack();
  if (takeOnConnect && useScreen.getState().phase === 'connected') { takeOnConnect = false; takeControl(); }
}

function start(team: string | undefined, screen: string | undefined): void {
  running = true;
  runningTeam = team;
  runningScreen = screen;
  failures = 0;
  lastTouch = Date.now();
  window.addEventListener('pointermove', touch, LISTEN);
  window.addEventListener('keydown', touch, LISTEN);
  window.addEventListener('wheel', touch, LISTEN);
  window.addEventListener('keydown', onShortcut, true);
  window.addEventListener('keyup', onShortcut, true);
  window.addEventListener('focus', onWindowFocus);
  tickTimer = setInterval(tick, 1000);
  void fetchLink();
}

function stop(): void {
  if (!running) return;
  if (useScreen.getState().mine) giveBack();
  running = false;
  takeOnConnect = false;
  dispose();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  window.removeEventListener('pointermove', touch, LISTEN);
  window.removeEventListener('keydown', touch, LISTEN);
  window.removeEventListener('wheel', touch, LISTEN);
  window.removeEventListener('keydown', onShortcut, true);
  window.removeEventListener('keyup', onShortcut, true);
  window.removeEventListener('focus', onWindowFocus);
  clipPending = null;
  el?.replaceChildren();
  if (el) el.style.backgroundImage = '';
  useCloudDesktop.setState({ control: undefined });
  set({ phase: 'idle', why: '', speaks: false, control: null, mine: false, deadline: 0, lastFrame: undefined, fb: undefined });
}

/** capture: noVNC stops the events on its canvas */
const LISTEN = { capture: true, passive: true } as const;
function touch(): void { lastTouch = Date.now(); }

/** every second: the idle pause, and control held here going back by itself */
function tick(): void {
  const s = useScreen.getState();
  const now = Date.now();
  if (s.phase === 'connected' && now - lastTouch > IDLE_PAUSE_MS) { pause(); return; }
  if (s.mine && !s.speaks && now >= s.deadline) giveBack();
}

/** keep the last picture up while the connection is down */
function keepLastFrame(): void {
  const canvas = screenCanvas();
  if (!canvas || !canvas.width || !canvas.height) return;
  try {
    const url = canvas.toDataURL('image/jpeg', 0.7);
    if (el) el.style.backgroundImage = `url("${url}")`;
    set({ lastFrame: url });
  } catch { /* a tainted or lost canvas: no picture */ }
}

/** close the client and socket; whatever they still say is ignored (a new generation) */
function dispose(): void {
  gen += 1;
  if (wakingTimer) { clearTimeout(wakingTimer); wakingTimer = null; }
  if (rateTimer) { clearInterval(rateTimer); rateTimer = null; }
  say = () => undefined;
  fbWatch?.disconnect();
  fbWatch = null;
  const c = client;
  client = null;
  channel = null;
  try { c?.disconnect(); } catch { /* already gone */ }
  try { socket?.close(); } catch { /* already gone */ }
  socket = null;
}

async function fetchLink(): Promise<void> {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const my = ++gen;
  if (!failures) set({ phase: 'linking', why: '' });
  const l = (await desktopLink(runningTeam)) ?? null;
  if (my !== gen || !running) return;
  if (!l) {
    if (failures) { lost('Your AppuBot computer didn’t hand out a desktop link.'); return; }
    set({ phase: 'failed', why: 'Your AppuBot computer didn’t hand out a desktop link.' });
    return;
  }
  void connect(l, my);
}

function lost(message: string): void {
  if (!running) return;
  keepLastFrame();
  dispose();
  failures += 1;
  set({ mine: false, control: null });
  useCloudDesktop.setState({ control: undefined });
  if (failures > RECONNECT_GIVE_UP) { set({ phase: 'failed', why: message }); return; }
  set({ phase: 'reconnecting', why: message });
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void fetchLink(); }, reconnectDelayMs(failures));
}

/** the screen can't be had: say why at once, with Try again (`retryScreen`), instead of reconnecting in vain */
function refuse(why: string): void {
  if (!running) return;
  dispose();
  set({ phase: 'failed', why, mine: false, control: null });
  useCloudDesktop.setState({ control: undefined });
}

function pause(): void {
  keepLastFrame();
  if (useScreen.getState().mine) giveBack();
  dispose();
  set({ phase: 'paused', control: null, mine: false });
}

/** Start over: after a failure, a pause, or a Wake. */
export function retryScreen(): void {
  if (!running) return;
  failures = 0;
  lastTouch = Date.now();
  dispose();
  void fetchLink();
}

function levels(full: boolean): { quality: number; compression: number } {
  return full ? { quality: auto.quality, compression: auto.compression } : PREVIEW_LEVELS;
}

function applyMode(full: boolean): void {
  // pace first: a SetEncodings the quality change sends goes out as the new pace wants it
  channel?.pace(full ? 0 : PREVIEW_PACE_MS);
  applyLevels(levels(full));
}

function applyLevels(q: { quality: number; compression: number }): void {
  if (!client) return;
  if (client.qualityLevel !== q.quality) client.qualityLevel = q.quality;
  if (client.compressionLevel !== q.compression) client.compressionLevel = q.compression;
}

async function connect(link: CloudDesktopLink, my: number): Promise<void> {
  const target = screenElement();
  set({ phase: failures ? 'reconnecting' : 'connecting' });
  samples = [];
  auto = autoStart();
  wakingTimer = setTimeout(() => { if (my === gen && useScreen.getState().phase === 'connecting') set({ phase: 'waking' }); }, WAKING_MS);
  set({ speaks: false, control: null, mine: false });
  let RFBClass: typeof import('@novnc/novnc').default;
  try {
    RFBClass = (await import('@novnc/novnc')).default;
  } catch (e) {
    if (my === gen) set({ phase: 'failed', why: errorMessage(e) });
    return;
  }
  if (my !== gen || !running) return;
  target.replaceChildren();
  // the socket is ours: what comes through it is measured for the auto quality, and its text frames are the control
  // channel (who has control; this view's input reaches the screen only while it has it)
  const sock = new WebSocket(screenUrl(link.websocketUrl, runningScreen));
  socket = sock;
  // a bot's screen that couldn't start: the computer says why, then closes for good (before noVNC hears the close)
  let said: string | undefined;
  let refused: string | null = null;
  sock.addEventListener('close', (e) => { if (my === gen) refused = screenRefused(e.code, said); });
  sock.addEventListener('message', (e) => {
    const bytes = e.data instanceof ArrayBuffer ? e.data.byteLength : typeof e.data === 'string' ? e.data.length : 0;
    samples.push({ at: Date.now(), bytes });
  });
  say = (m) => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(m)); };
  const ch = new ViewerChannel(sock, (text) => {
    if (my !== gen) return;
    const m = parseComputerMessage(text);
    if (!m) return;
    if (m.t === 'hello') {
      const held = useScreen.getState().mine;
      set({ speaks: true });
      say({ t: 'hello', via: 'desktop', name: viewerName() });
      // control taken here before the computer said it speaks the channel: ask it properly
      if (held) say({ t: 'control', on: true });
      return;
    }
    const now = Date.now();
    const had = useScreen.getState().mine;
    set({ control: m.control, mine: m.mine, ...(m.control ? { deadline: controlDeadline(m.control, now) } : {}) });
    useCloudDesktop.setState({ control: m.mine && m.control ? m.control.id : undefined });
    if (client) client.viewOnly = !m.mine;
    if (m.mine) client?.focus();
    if (m.mine && !had) void sendMacClipboard();
    // before the picture, an error is the screen's own (it couldn't start); once live, it's about taking control
    if (m.error && useScreen.getState().phase === 'connected') pushToast({ title: 'Couldn’t take control', body: m.error, level: 'warning' });
    else if (m.error) said = m.error;
  });
  channel = ch;
  const full = useScreen.getState().full;
  ch.pace(full ? 0 : PREVIEW_PACE_MS);
  const c = new RFBClass(target, ch, { shared: true });
  // fitted to its place, never clipped or scrolled (scaling up and down, keeping the shape; noVNC refits on its own
  // ResizeObserver and on a new screen size): its scroller is hidden, since a box of the screen's own shape can be a
  // fraction of a pixel short and `overflow: auto` would show scrollbars for it
  c.clipViewport = false;
  c.scaleViewport = true;
  c.resizeSession = false;
  const scroller = target.firstElementChild as HTMLElement | null;
  if (scroller) scroller.style.overflow = 'hidden';
  watchFb(target.querySelector('canvas'));
  c.background = 'transparent';
  c.viewOnly = true;
  // in control, a blank cursor from the computer shows as a dot rather than no pointer at all
  c.showDotCursor = true;
  const start = levels(full);
  c.qualityLevel = start.quality;
  c.compressionLevel = start.compression;
  client = c;
  c.addEventListener('connect', () => {
    if (my !== gen) return;
    if (wakingTimer) { clearTimeout(wakingTimer); wakingTimer = null; }
    failures = 0;
    target.style.backgroundImage = '';
    set({ phase: 'connected', why: '', lastFrame: undefined });
    lastTouch = Date.now();
    // teach mode: the person shows the task, so the screen is theirs at once
    if (takeOnConnect && useScreen.getState().full) { takeOnConnect = false; takeControl(); }
    rateTimer = setInterval(() => {
      const now = Date.now();
      while (samples.length && now - samples[0]!.at > RATE_WINDOW_MS * 2) samples.shift();
      if (!useScreen.getState().full) return;
      const next = stepQuality(auto, rateOver(samples, now, RATE_WINDOW_MS), now);
      if (next !== auto) { auto = next; applyLevels(next); }
    }, RATE_TICK_MS);
  });
  c.addEventListener('disconnect', (e) => {
    if (my !== gen) return;
    if (refused) { refuse(refused); return; }
    const clean = !!(e as CustomEvent<{ clean: boolean }>).detail?.clean;
    lost(clean ? 'Your AppuBot computer closed the connection.' : 'The connection to your AppuBot computer dropped.');
  });
  c.addEventListener('clipboard', (e) => {
    if (my !== gen) return;
    fromComputer((e as CustomEvent<{ text?: string }>).detail?.text ?? '');
  });
  c.addEventListener('securityfailure', (e) => {
    if (my !== gen) return;
    lost(`Your AppuBot computer refused the link: ${(e as CustomEvent<{ reason?: string }>).detail?.reason ?? 'try again'}.`);
  });
}

/** publish the screen's size as noVNC sizes its canvas to it (a new resolution included) */
function watchFb(canvas: HTMLCanvasElement | null): void {
  fbWatch?.disconnect();
  fbWatch = null;
  if (!canvas) return;
  const read = () => {
    const w = canvas.width;
    const h = canvas.height;
    const fb = useScreen.getState().fb;
    if (w > 0 && h > 0 && (fb?.w !== w || fb?.h !== h)) set({ fb: { w, h } });
  };
  fbWatch = new MutationObserver(read);
  fbWatch.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
  read();
}

/** Take control (the full viewer's pill, teach mode). */
export function takeControl(): void {
  const s = useScreen.getState();
  if (s.phase !== 'connected') { takeOnConnect = true; return; }
  if (s.speaks) { say({ t: 'control', on: true }); return; }
  // a computer without the control channel: this viewer just lets its input through, and gives it back when idle
  const now = Date.now();
  localSince = now;
  const until = controlUntil(now);
  set({ mine: true, control: localControl(viewerName(), localSince, until, now), deadline: until });
  if (client) { client.viewOnly = false; client.focus(); }
  void sendMacClipboard();
}

/** Give control back to the bots. */
export function giveBack(): void {
  const s = useScreen.getState();
  takeOnConnect = false;
  if (s.speaks) say({ t: 'control', on: false });
  // nobody has it from here on, as far as this view knows: keeping the old holder (this view itself) until the
  // computer's word came back read "<your email> has control" for a moment. If someone else took it meanwhile, the
  // computer's next word says so
  set({ mine: false, control: null });
  useCloudDesktop.setState({ control: undefined });
  if (client) client.viewOnly = true;
}

/** Keep control (near the end of the idle countdown). */
export function keepControl(): void {
  const s = useScreen.getState();
  if (s.speaks) { say({ t: 'control', on: true }); return; }
  noteInput(true);
}

/**
 * Input from this window while it has control: the computer renews the hold on each input it lets through, so this
 * window's countdown starts over too (at most once a second).
 */
export function noteInput(force = false): void {
  const s = useScreen.getState();
  if (!s.mine) return;
  const now = Date.now();
  if (!force && now - lastInputNote < 1000) return;
  lastInputNote = now;
  const until = controlUntil(now);
  if (s.speaks) set({ deadline: until });
  else set({ deadline: until, control: localControl(viewerName(), localSince, until, now) });
}


/* ---------- the clipboard and ⌘ shortcuts, while in control ---------- */

/** the computer's clipboard changed (Xvnc tells every viewer): onto this Mac's, only while this window has control */
function fromComputer(text: string): void {
  if (!useScreen.getState().mine || !text || text === clipSeen || text.length > CLIPBOARD_MAX) return;
  clipSeen = text;
  void writeMacClipboard(text);
}

async function writeMacClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    if (clipPending === text) clipPending = null;
  } catch {
    // the window isn't focused (the system refuses): written once it is
    clipPending = text;
  }
}

/** This Mac's clipboard onto the computer's (what a paste there pastes), when it changed since it was last carried. */
async function sendMacClipboard(): Promise<void> {
  if (!client || !useScreen.getState().mine) return;
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { return; }
  const c = client;
  if (!c || !useScreen.getState().mine || !text || text === clipSeen || text.length > CLIPBOARD_MAX) return;
  clipSeen = text;
  try { c.clipboardPasteFrom(text); } catch { /* the connection went meanwhile */ }
}

/** back in the window: a copy from the computer waiting to be written here, else what was copied elsewhere meanwhile */
function onWindowFocus(): void {
  if (clipPending !== null) { void writeMacClipboard(clipPending); return; }
  void sendMacClipboard();
}

/**
 * ⌘ shortcuts while in control, before noVNC sees them (capture): ⌘ alone is swallowed (it would be the computer's
 * Super key), and ⌘ + a letter, digit or punctuation key goes as Ctrl + that key (⌘V first carries this Mac's
 * clipboard over). Taking the keydown also keeps the Mac's own Edit menu from acting on it.
 */
function onShortcut(e: KeyboardEvent): void {
  const c = client;
  if (!c || !useScreen.getState().mine || !el || !(e.target instanceof Node) || !el.contains(e.target)) return;
  if (e.key === 'Meta') { e.preventDefault(); e.stopPropagation(); return; }
  if (e.type !== 'keydown' || !e.metaKey || e.ctrlKey) return;
  const sym = shortcutKeysym(e.code);
  if (sym === null) return;
  e.preventDefault();
  e.stopPropagation();
  noteInput();
  const press = () => {
    if (client !== c) return;
    c.sendKey(XK_CONTROL_L, 'ControlLeft', true);
    c.sendKey(sym, e.code, true);
    c.sendKey(sym, e.code, false);
    c.sendKey(XK_CONTROL_L, 'ControlLeft', false);
  };
  if (e.code === 'KeyV') void sendMacClipboard().finally(press);
  else press();
}
