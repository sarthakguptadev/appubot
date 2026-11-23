/**
 * Live view: a device watching this computer's screen and using it from afar, like a remote desktop (the phone's
 * Computer view). macOS only for now: the native helper keeps a ScreenCaptureKit stream of the display with the
 * cursor left out and posts the watcher's input as real mouse and keyboard events at global points.
 *
 * Two ways to watch. Pictures (`computer.live`, every device): each watcher gets its own JPEGs, at a size and quality
 * for its link (`TIERS`), only when the screen changed (`display_stream_frame`), and no more than `WINDOWS` ahead of
 * the pictures it has confirmed showing (`computer.liveAck`): a slow link (AppuBot Connect through its relay) gets
 * fewer pictures instead of a queue that grows, and on `auto` a link slow to confirm steps down a size, a quick one
 * back up. Video (`computer.liveVideo`, a device that asks with `computer.watch {video}`): the helper encodes the
 * display as H.264 (`display_video_start`, LiveVideo.swift; hardware, low-latency, a still screen sends nothing) and
 * pushes each frame as a helper event; one encoder serves every video watcher at the lowest of their tiers
 * (`VIDEO_TIERS`). A frame needs the ones before it, so a watcher is never sent a frame past one it missed: one too
 * far behind (`videoGate`: unconfirmed bytes over its budget, or its socket backed up) gets nothing until it has
 * caught up, then a keyframe. Each watcher's tier follows its link (`stepVideoTier`: queueing on top of its round
 * trip steps it down, a long quick run back up), and the encoder stops the moment the last video watcher goes. A
 * helper without video (an older build, an error starting it) leaves the device on pictures.
 *
 * Pictures and frames leave the cursor out and say where it is (`cursor`): the device draws one pointer that answers
 * its finger at once. Pure parts (`stepTier`, `stepVideoTier`, `videoGate`, `videoBudget`, `toPoint`, `cursorOn`) are
 * tested.
 *
 * Elsewhere than a Mac the pictures come from `CoreDeps.liveScreen` (a `ScreenSource`: on the AppuBot Cloud computer
 * an RFB client to its own Xvnc, in its gateway), paced and tiered the same way, and the
 * watcher's input goes out through the computer-use backend's desktop scope (`ComputerService.userAct`: Cua on X11),
 * pixels of the display being the picture's own coordinates. Video stays the helper's. Nothing of it runs until a
 * device watches, and the source is stopped the moment the last one leaves.
 */
import type { ComputerAction, LiveFrame, LiveInput, LiveQuality, LiveVideo, NetRoute } from '@appubot/protocol';
import type { CoreCtx, ScreenFrame, ScreenSource } from '../context';
import type { HelperTransport } from './nativeHelper';
import { RpcError, errMsg } from '../util';

export interface LiveTier { maxDim: number; quality: number }

/** best → data saver (long edge in px, JPEG quality 0..1) */
export const TIERS: readonly LiveTier[] = [
  { maxDim: 1600, quality: 0.7 },
  { maxDim: 1280, quality: 0.6 },
  { maxDim: 1024, quality: 0.55 },
  { maxDim: 864, quality: 0.5 },
  { maxDim: 720, quality: 0.45 },
];
const FIXED: Record<Exclude<LiveQuality, 'auto'>, number> = { best: 0, balanced: 2, saver: TIERS.length - 1 };
/** devices always get the best picture (`settings.computer.liveQuality` is no longer offered)... */
export const LIVE_MODE: LiveQuality = 'best';
/**
 * ...except through AppuBot Connect's relay: a picture can't cross it faster than its round trip, and best ones
 * (~0.3-0.5 MB) four at a time backed it up until it closed the phone (a "network error" mid-watch). There each link
 * finds its own size from how fast it confirms (`auto`, starting at 1024 px).
 */
export function liveModeFor(route: NetRoute): LiveQuality {
  return route === 'connect' || route === 'cloud' ? 'auto' : LIVE_MODE;
}
/**
 * bytes of pictures that may be on their way to one device unconfirmed: the relay pauses a phone's socket at 1 MB
 * queued and closes it at 4 MB, so a distant link carries only a little at a time (local links are never short)
 */
export const BYTES_AHEAD: Record<NetRoute, number> = { local: Infinity, lan: 16_000_000, tailscale: 4_000_000, connect: 900_000, cloud: 900_000 };
/** where `auto` starts, by how the device reaches this computer */
const START: Record<NetRoute, number> = { local: 0, lan: 0, tailscale: 1, connect: 2, cloud: 2 };

/**
 * pictures sent ahead of the last one the device confirmed: more on a distant link, whose confirmations take a whole
 * round trip (over AppuBot Connect's relay, half a second or more) and would otherwise cap the pictures a second
 */
export const WINDOWS: Record<NetRoute, number> = { local: 2, lan: 2, tailscale: 3, connect: 4, cloud: 4 };
export const WINDOW = WINDOWS.local;
/** at most this many pictures a second to one device */
const MAX_FPS = 20;
/** how often a still screen is looked at again (the helper answers "unchanged" in a millisecond) */
const LOOK_MS = 33;
/**
 * after the device's input, its next pictures skip the queue (one past its window, no pacing) for this long, so the
 * picture showing what the click did isn't held behind the confirmations of pictures from before it
 */
const URGENT_MS = 700;
/** a picture not confirmed in this long is taken as lost */
const LOST_MS = 5000;
/** confirmations slower than this (smoothed) step `auto` down a size; this many quick ones in a row step it up */
export const SLOW_MS = 900;
export const QUICK_MS = 350;
export const QUICK_RUN = 15;

type LiveEvent = 'computer.live' | 'computer.liveVideo' | 'computer.liveState';
type LivePayload<E extends LiveEvent> = E extends 'computer.live' ? LiveFrame : E extends 'computer.liveVideo' ? LiveVideo : { blocked: 'locked' | null };

export interface Watcher {
  id: number;
  route: NetRoute;
  /** to this device alone; `false` when it didn't go (the link too far behind): a video frame then needs a keyframe */
  send: <E extends LiveEvent>(event: E, payload: LivePayload<E>) => boolean | void;
  /** bytes still waiting to go out to this device (its socket's backlog) */
  backlog?: () => number;
}

/* ---------- video ---------- */

export interface VideoTier { maxDim: number; bitrate: number; fps: number }
/** best → data saver: the picture's long edge, average bits a second, frames a second */
export const VIDEO_TIERS: readonly VideoTier[] = [
  { maxDim: 2048, bitrate: 8_000_000, fps: 30 },
  { maxDim: 1600, bitrate: 4_000_000, fps: 30 },
  // a new size is a new encoder and a keyframe: the bitrate steps first, the size only below 0.8 Mbit/s
  { maxDim: 1280, bitrate: 2_000_000, fps: 30 },
  { maxDim: 1280, bitrate: 1_200_000, fps: 24 },
  { maxDim: 1280, bitrate: 800_000, fps: 20 },
  { maxDim: 1024, bitrate: 500_000, fps: 15 },
  { maxDim: 864, bitrate: 300_000, fps: 12 },
];
/** where a link starts: this Mac and the same Wi-Fi the best, Tailscale one down, the relay at 1280 px / 1.2 Mbit/s */
export const VIDEO_START: Record<NetRoute, number> = { local: 0, lan: 0, tailscale: 1, connect: 3, cloud: 3 };
/** the best a link may climb to: the relay's no higher than 1280 px / 2 Mbit/s (every byte crosses it twice) */
export const VIDEO_FLOOR: Record<NetRoute, number> = { local: 0, lan: 0, tailscale: 0, connect: 2, cloud: 2 };
/** seconds of video that may be unconfirmed on the way (more is a queue: the picture would lag) */
const VIDEO_AHEAD_S = 1;
/** ...but always room for a keyframe (and the first frame always goes, however big) */
const VIDEO_MIN_AHEAD = 300_000;
/** a socket this far backed up gets no frame (it would only wait there) */
export const VIDEO_BACKLOG_MAX = 1_000_000;
/** queueing (a confirmation's time over the link's own round trip, smoothed) above this steps a link down a tier */
export const VIDEO_SLOW_MS = 300;
/**
 * below this a confirmation counts as quick; this many in a row (and nothing skipped for a while) step it back up.
 * Only while the link carries at least VIDEO_LOADED of its tier's rate: tiny frames of a still screen confirm quickly
 * on any link, which says nothing about what it would carry.
 */
export const VIDEO_QUICK_MS = 120;
export const VIDEO_QUICK_RUN = 30;
export const VIDEO_LOADED = 0.5;
/**
 * a frame crosses as base64 in JSON: a third more than its bytes, and a little for the rest of the event; a link
 * found to deliver some rate gets the best tier whose stream fits in this share of it
 */
const WIRE_OVERHEAD = 4 / 3 * 1.05;
const RATE_SHARE = 0.85;
/** what a link carried lately is measured over this long */
const VIDEO_RATE_MS = 2000;
/** the least time between two steps of one link, and since its last skip before it may step up */
const VIDEO_STEP_MS = 1500;
const VIDEO_CALM_MS = 6000;
/** a keyframe asked for and not come in this long is asked for again */
const KEY_RETRY_MS = 1000;
/** the helper's video stops by itself without a word from here for 30 s: renewed this often */
const VIDEO_LEASE_MS = 10_000;
/** the codec the helper encodes */
export const VIDEO_CODEC = 'h264';

/** How many bytes of video may be unconfirmed on their way to a device on `route` at `bitrate`. */
export function videoBudget(route: NetRoute, bitrate: number): number {
  return Math.min(BYTES_AHEAD[route], Math.max(VIDEO_MIN_AHEAD, (bitrate / 8) * VIDEO_AHEAD_S));
}

/**
 * One encoded frame for one watcher: `send` it; `wait` (it is waiting for a keyframe and this isn't one: dropped, it
 * couldn't decode it); or `skip` (it is too far behind: dropped, and from now on it waits for a keyframe). The first
 * frame always goes when nothing is unconfirmed, however big.
 */
export function videoGate(s: { needKey: boolean; ahead: number; backlog: number }, f: { key: boolean; bytes: number }, budget: number): 'send' | 'skip' | 'wait' {
  if (s.needKey && !f.key) return 'wait';
  if (s.backlog >= VIDEO_BACKLOG_MAX) return 'skip';
  if (s.ahead > 0 && s.ahead + s.backlog + f.bytes > budget) return 'skip';
  return 'send';
}

/** Whether a watcher waiting for a keyframe has caught up enough to be sent one. */
export function caughtUp(ahead: number, backlog: number, budget: number): boolean {
  return ahead <= budget / 2 && backlog < VIDEO_BACKLOG_MAX / 4;
}

/**
 * A video link's next tier from its smoothed queueing delay (`queueMs`: confirmation time over its own round trip) or
 * a queue seen growing (`growing`), its quick confirmations in a row and how long since it last had to skip a frame. Slow: down a tier (a lower bitrate
 * and size); a long quick run with nothing skipped lately: up one, never above `floor`. `sinceStep` keeps steps apart.
 */
export function stepVideoTier(tier: number, a: { queueMs: number; quick: number; sinceSkip: number; sinceStep: number; growing?: boolean }, floor = 0): { tier: number; quick: number } {
  if (a.sinceStep < VIDEO_STEP_MS) return { tier, quick: a.quick };
  if ((a.queueMs > VIDEO_SLOW_MS || a.growing) && tier < VIDEO_TIERS.length - 1) return { tier: tier + 1, quick: 0 };
  if (a.quick >= VIDEO_QUICK_RUN && a.sinceSkip > VIDEO_CALM_MS && tier > floor) return { tier: tier - 1, quick: 0 };
  return { tier, quick: a.quick };
}

/**
 * a queue growing: confirmation times rising this much per second of sending (least squares over the last few
 * seconds), while the link is loaded. Seen without knowing the link's own round trip, which a link full from its first
 * second never shows.
 */
export const VIDEO_TREND = 0.08;
const TREND_SAMPLES = 24;
const TREND_MIN_SPAN_MS = 1200;

/** How fast confirmation times rise (ms per ms of sending) over `samples` ({sent at, took ms}); 0 for too few. */
export function trendSlope(samples: readonly { t: number; ms: number }[]): number {
  if (samples.length < 6) return 0;
  const n = samples.length;
  const t0 = samples[0]!.t;
  let st = 0, sm = 0;
  for (const p of samples) { st += p.t - t0; sm += p.ms; }
  const mt = st / n, mm = sm / n;
  let cov = 0, vt = 0;
  for (const p of samples) { const dt = p.t - t0 - mt; cov += dt * (p.ms - mm); vt += dt * dt; }
  return vt ? cov / vt : 0;
}

/** The best tier whose stream fits in a link found to deliver `bitsPerSecond` (of base64 frames). */
export function tierForRate(bitsPerSecond: number): number {
  const i = VIDEO_TIERS.findIndex((t) => t.bitrate * WIRE_OVERHEAD <= bitsPerSecond * RATE_SHARE);
  return i < 0 ? VIDEO_TIERS.length - 1 : i;
}

/** a helper `video` event: one encoded frame */
interface HelperUnit {
  event: 'video';
  data: string; key: boolean; sps?: string; pps?: string; width: number; height: number; bytes?: number;
  bounds?: Bounds; cursor?: { x: number; y: number };
}

interface WatchState extends Watcher {
  tier: number;
  /** picture number → when it went */
  out: Map<number, number>;
  /** picture number → its size, while unconfirmed */
  bytes: Map<number, number>;
  /** the newest picture of the display this device has */
  seq: number;
  lastSent: number;
  /** smoothed confirmation time, and quick confirmations in a row */
  ackMs: number;
  quick: number;
  /** the newest of this device's inputs carried out (pictures say it, `inputSeq`) */
  applied: number;
  /** until when its pictures skip the queue (just after its input) */
  urgentUntil: number;
  /** what it was last told stops its pictures (the screen locked), so it hears each change once */
  blocked: 'locked' | null;
  /** it gets video (`computer.liveVideo`) rather than pictures */
  video: boolean;
  /** video: it missed a frame (or just came): nothing until a keyframe */
  needKey: boolean;
  /** video: its tier (VIDEO_TIERS), when it last stepped and last had to skip a frame */
  vtier: number;
  steppedAt: number;
  skippedAt: number;
  /** video: the quickest confirmation lately (its link's own round trip): this window's and the one before */
  minMs: number;
  prevMinMs: number;
  minSince: number;
  /** video: what went to it lately (when, bytes), for the rate its link carried; and what it confirmed */
  recent: { at: number; bytes: number }[];
  delivered: { at: number; bytes: number }[];
  /** video: confirmation times by when the frame went, for the trend */
  trend: { t: number; ms: number }[];
}

/**
 * `auto`: the next size for a link from its smoothed confirmation time (`ms`) and quick ones in a row. A slow link
 * goes down a size (its run starts over); a quick run goes up one, never above `floor` (where its route starts best).
 */
export function stepTier(tier: number, ms: number, quick: number, floor = 0): { tier: number; quick: number } {
  if (ms > SLOW_MS && tier < TIERS.length - 1) return { tier: tier + 1, quick: 0 };
  if (quick >= QUICK_RUN && tier > floor) return { tier: tier - 1, quick: 0 };
  return { tier, quick };
}

export interface Bounds { x: number; y: number; width: number; height: number }

/**
 * A point on the watched screen (0..1 across and down) as a global screen point, inside the display: its right and
 * bottom edges are the next display's, so the farthest point is a point short of them.
 */
export function toPoint(b: Bounds, fx: number, fy: number): { x: number; y: number } {
  const along = (f: number, size: number) => Math.min(Math.max(0, f) * size, Math.max(0, size - 1));
  return { x: Math.round((b.x + along(fx, b.width)) * 100) / 100, y: Math.round((b.y + along(fy, b.height)) * 100) / 100 };
}

type HelperFrame = ScreenFrame;
/** the picture live view asks the native helper for, as a `ScreenSource` (the same calls as before) */
function helperSource(h: HelperTransport): ScreenSource {
  return {
    frame: (o) => h.request<ScreenFrame>('display_stream_frame', { max_dimension: o.maxDim, quality: o.quality, after: o.after, wait_ms: 0, cursor: false }, 5000),
    stop: () => void h.request('display_stream_stop', {}, 3000).catch(() => undefined),
  };
}

/** the pixel distance within which a finger's down and up are a click, not a drag */
const DRAG_MIN_PX = 4;
/** live scrolls come as pixels; the computer-use backend scrolls in lines (about this many pixels each) */
const SCROLL_LINE_PX = 40;

/** The pointer's place in global points as 0..1 of the display, or nothing when it is on another one. */
export function cursorOn(b: Bounds, p: { x: number; y: number } | undefined): { x: number; y: number } | undefined {
  if (!p || !b.width || !b.height) return undefined;
  const x = (p.x - b.x) / b.width, y = (p.y - b.y) / b.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 } : undefined;
}

export class LiveViewService {
  private watchers = new Map<number, WatchState>();
  private running = false;
  private bounds: Bounds | null = null;
  /** the helper's video: started, at which tier (VIDEO_TIERS), its helper events, the lease and the watchers' check */
  private videoOn = false;
  private videoStarting: Promise<boolean> | null = null;
  private videoTier = -1;
  private videoSeq = 0;
  private offEvents: (() => void) | null = null;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  /** a keyframe asked of the helper and not come yet (since when) */
  private keyAskedAt = 0;
  /** this helper can't stream video (an older build): pictures for everyone until AppuBot restarts */
  private videoUnsupported = false;
  /** what the helper last said stops the video (the screen locked) */
  private videoBlocked: 'locked' | null = null;
  /** the helper's picture stream may be running (asked for a picture since it was last stopped) */
  private picturesOn = false;
  /** where pictures come from without a helper (`CoreDeps.liveScreen`), made on the first watch, dropped with the last */
  private screen: ScreenSource | null = null;
  /** a pointer held down by a watcher (its finger), for the drag it may become */
  private held: { x: number; y: number } | null = null;
  /** who hears every input a watcher gives (teach mode's recorder) */
  private inputListeners = new Set<(i: LiveInput, bounds: Bounds | null) => void>();
  /** something other than a watcher keeps the source up (teach mode, for its click pictures) */
  private holds = 0;

  constructor(private ctx: CoreCtx) {}

  private helper(): HelperTransport | null {
    return process.platform === 'darwin' ? this.ctx.s.computer.helper() : null;
  }

  /** The screen's pictures: the native helper on macOS, else the host's own source (the cloud computer's VNC display). */
  private source(): ScreenSource | null {
    const h = this.helper();
    if (h) return helperSource(h);
    if (!this.screen) this.screen = this.ctx.deps?.liveScreen?.() ?? null;
    return this.screen;
  }

  /** Whether this computer can stream its screen (the native helper on macOS, a screen source elsewhere). */
  get supported(): boolean { return !!this.helper() || !!this.ctx.deps?.liveScreen; }

  /** How many devices watch right now (the cloud computer stays awake for them). */
  watcherCount(): number { return this.watchers.size; }

  /** Hears every input a watcher gives this computer, carried out or not (teach mode records it); returns the unsubscribe. */
  onInput(fn: (i: LiveInput, bounds: Bounds | null) => void): () => void {
    this.inputListeners.add(fn);
    return () => { this.inputListeners.delete(fn); };
  }

  /** The display's size and place, as the pictures know it (null until the first picture). */
  screenBounds(): Bounds | null { return this.bounds; }

  /** Keeps the screen source up while nobody watches (teach mode takes pictures at each click); released, it stops. */
  hold(on: boolean): void {
    this.holds = Math.max(0, this.holds + (on ? 1 : -1));
    if (!this.holds) this.settleStreams();
  }

  /** A picture of the whole screen now, for anyone on this computer (teach mode's click pictures): null without a source. */
  async snapshot(maxDim: number, quality: number): Promise<{ data: string; width: number; height: number } | null> {
    const src = this.source();
    if (!src) return null;
    try {
      this.picturesOn = true;
      const r = await src.frame({ maxDim, quality, after: -1 });
      if (r.bounds) this.bounds = r.bounds;
      if (!r.image_base64) return null;
      return { data: r.image_base64, width: r.width ?? 0, height: r.height ?? 0 };
    } catch (e) {
      this.ctx.log.debug('live view: no snapshot', errMsg(e));
      return null;
    } finally {
      // nobody watching (and nothing holding it): the stream it may have started stops again
      if (!this.watchers.size && !this.holds) this.settleStreams();
    }
  }

  /**
   * A device starts or stops watching. `video`: the codecs it decodes; it gets video when the helper streams one of
   * them, else pictures (the answer's `video` says which).
   */
  async watch(w: Watcher, on: boolean, video?: { codecs: string[] }): Promise<{ ok: true; live: boolean; screen?: { width: number; height: number }; video?: { codec: string } }> {
    if (!on) { this.drop(w.id); return { ok: true, live: this.supported }; }
    if (!this.supported) return { ok: true, live: false };
    const mode = liveModeFor(w.route);
    const tier = mode === 'auto' ? START[w.route] : FIXED[mode];
    const prev = this.watchers.get(w.id);
    const state: WatchState = {
      ...w, tier, out: new Map(), bytes: new Map(), seq: 0, lastSent: 0, ackMs: 0, quick: 0, applied: prev?.applied ?? 0, urgentUntil: 0, blocked: null,
      video: false, needKey: true, vtier: VIDEO_START[w.route], steppedAt: 0, skippedAt: 0, minMs: Infinity, prevMinMs: Infinity, minSince: Date.now(), recent: [], delivered: [], trend: [],
    };
    this.watchers.set(w.id, state);
    const wantsVideo = !!video?.codecs.includes(VIDEO_CODEC) && !this.videoUnsupported;
    if (wantsVideo) {
      state.video = true;
      if (await this.startVideo()) {
        // (it may have stopped watching meanwhile)
        if (this.watchers.get(w.id) !== state) return { ok: true, live: true };
        // watching afresh, the other way before: that stream may stop
        if (prev) this.settleStreams();
        // (a stream just started opens with one, which may have reached it already)
        if (state.needKey) this.requestKey();
        if (this.videoBlocked) this.tell(state, this.videoBlocked);
        const b = this.bounds;
        return { ok: true, live: true, video: { codec: VIDEO_CODEC }, ...(b ? { screen: { width: b.width, height: b.height } } : {}) };
      }
      // no video here: pictures, as for any device
      state.video = false;
      if (this.watchers.get(w.id) !== state) return { ok: true, live: true };
    }
    if (prev) this.settleStreams();
    void this.loop();
    const b = this.bounds ?? (await this.readBounds());
    return { ok: true, live: true, ...(b ? { screen: { width: b.width, height: b.height } } : {}) };
  }

  /** Tells a watcher what stops its pictures, or that they flow again, once per change. */
  private tell(w: WatchState, blocked: 'locked' | null): void {
    if (w.blocked === blocked) return;
    w.blocked = blocked;
    w.send('computer.liveState', { blocked });
  }

  /** A device showed picture (or video frame) `seq`, and every one before it. */
  ack(id: number, seq: number): void {
    const w = this.watchers.get(id);
    const sentAt = w?.out.get(seq);
    if (!w || sentAt === undefined) return;
    // pictures before it that never got their own confirmation were shown or skipped too
    let confirmed = 0;
    for (const n of w.out.keys()) if (n <= seq) { confirmed += w.bytes.get(n) ?? 0; w.out.delete(n); w.bytes.delete(n); }
    const now = Date.now();
    if (w.video) w.delivered.push({ at: now, bytes: confirmed });
    const ms = now - sentAt;
    w.ackMs = w.ackMs ? w.ackMs * 0.7 + ms * 0.3 : ms;
    if (w.video) { this.ackVideo(w, ms, now, sentAt); return; }
    w.quick = ms < QUICK_MS ? w.quick + 1 : 0;
    if (liveModeFor(w.route) === 'auto') {
      const next = stepTier(w.tier, w.ackMs, w.quick, START[w.route]);
      if (next.tier !== w.tier) { w.tier = next.tier; w.ackMs = 0; }
      w.quick = next.quick;
    }
  }

  /** A video confirmation: the link's tier follows its queueing; one caught up after skipping gets its keyframe. */
  private ackVideo(w: WatchState, ms: number, now: number, sentAt: number): void {
    // the link's own round trip: the quickest confirmation of this window or the last (so it can grow, slowly)
    if (now - w.minSince > 10_000) { w.prevMinMs = w.minMs; w.minMs = Infinity; w.minSince = now; }
    w.minMs = Math.min(w.minMs, ms);
    const base = Math.min(w.minMs, w.prevMinMs);
    const queueMs = Math.max(0, w.ackMs - base);
    // quick, and carrying enough to mean something (else the run waits, neither growing nor starting over)
    while (w.recent.length && now - w.recent[0]!.at > VIDEO_RATE_MS) w.recent.shift();
    const carried = (w.recent.reduce((n, r) => n + r.bytes, 0) * 0.75 * 8) / (VIDEO_RATE_MS / 1000);
    const loaded = carried >= VIDEO_LOADED * VIDEO_TIERS[w.vtier]!.bitrate;
    if (ms - base >= VIDEO_QUICK_MS) w.quick = 0;
    else if (loaded) w.quick += 1;
    w.trend.push({ t: sentAt, ms });
    while (w.trend.length > TREND_SAMPLES || (w.trend.length && sentAt - w.trend[0]!.t > 3 * VIDEO_RATE_MS)) w.trend.shift();
    const growing = loaded && w.trend.length >= 8 && sentAt - w.trend[0]!.t >= TREND_MIN_SPAN_MS && trendSlope(w.trend) > VIDEO_TREND;
    const next = stepVideoTier(w.vtier, { queueMs, quick: w.quick, sinceSkip: now - w.skippedAt, sinceStep: now - w.steppedAt, growing }, VIDEO_FLOOR[w.route]);
    w.quick = next.quick;
    if (next.tier > w.vtier) this.stepDown(w, now);
    else if (next.tier !== w.vtier) this.setVideoTier(w, next.tier, now);
    if (w.needKey) this.keyIfCaughtUp(w);
  }

  /**
   * The link is behind: at least a tier down, straight to the one that fits what it was found to deliver (a tight
   * link otherwise takes a queue's worth of seconds per tier to get there).
   */
  private stepDown(w: WatchState, now: number): void {
    while (w.delivered.length && now - w.delivered[0]!.at > VIDEO_RATE_MS) w.delivered.shift();
    const span = w.delivered.length > 1 ? Math.max(500, now - w.delivered[0]!.at) : 0;
    const rate = span ? (w.delivered.reduce((n, d) => n + d.bytes, 0) * 8) / (span / 1000) : 0;
    const fits = rate ? tierForRate(rate) : w.vtier + 1;
    const tier = Math.min(VIDEO_TIERS.length - 1, Math.max(w.vtier + 1, fits));
    if (tier !== w.vtier) this.setVideoTier(w, tier, now);
  }

  private setVideoTier(w: WatchState, tier: number, now = Date.now()): void {
    w.vtier = tier;
    w.steppedAt = now;
    w.trend = [];
    // the next confirmations are measured afresh
    w.ackMs = 0;
    this.configureVideo();
  }

  /**
   * The device went (left live view, went to the background, closed its connection). With nobody watching, the
   * screen's capture stops at once: nothing records the screen (and macOS's recording indicator goes) the moment
   * the last viewer leaves; coming back starts it again in a fraction of a second.
   */
  drop(id: number): void {
    if (!this.watchers.delete(id)) return;
    this.settleStreams();
  }

  /** A stream nobody watches any more stops at once (pictures or video); the video follows who still watches it. */
  private settleStreams(): void {
    const all = [...this.watchers.values()];
    if (all.some((w) => w.video)) this.configureVideo();
    else this.stopVideo();
    if (this.picturesOn && !all.some((w) => !w.video) && !this.holds) {
      this.picturesOn = false;
      this.wake?.();
      this.held = null;
      const src = this.helper() ? this.source() : this.screen;
      // the host's source is let go with its last watcher (a cloud computer's VNC client closes); made afresh next time
      this.screen = null;
      src?.stop();
    }
  }

  /** The device's decoder needs a keyframe (it failed, or was made afresh). */
  needKey(id: number): void {
    const w = this.watchers.get(id);
    if (!w?.video) return;
    w.needKey = true;
    this.keyIfCaughtUp(w);
  }

  /* ---------- video ---------- */

  /** The tier the one encoder runs at: the lowest any video watcher's link takes. */
  private wantedVideoTier(): number {
    let t = -1;
    for (const w of this.watchers.values()) if (w.video) t = Math.max(t, w.vtier);
    return t;
  }

  private videoParams(tier: number): Record<string, unknown> {
    const t = VIDEO_TIERS[tier]!;
    return { max_dimension: t.maxDim, bitrate: t.bitrate, fps: t.fps, key_interval: 10 };
  }

  /** Starts the helper's video (once, however many ask at once); false where it can't (then pictures). */
  private startVideo(): Promise<boolean> {
    if (this.videoOn) { this.configureVideo(); return Promise.resolve(true); }
    this.videoStarting ??= (async () => {
      const h = this.helper();
      if (!h) return false;
      this.offEvents ??= h.onEvent((ev) => this.onHelperEvent(ev));
      const tier = Math.max(0, this.wantedVideoTier());
      try {
        const r = await h.request<{ bounds?: Bounds; blocked?: 'locked' }>('display_video_start', this.videoParams(tier), 8000);
        if (r.bounds) this.bounds = r.bounds;
        this.videoBlocked = r.blocked ?? null;
        this.videoOn = true;
        this.videoTier = tier;
        this.keyAskedAt = 0;
        this.leaseTimer ??= setInterval(() => void this.renewVideo(), VIDEO_LEASE_MS);
        this.checkTimer ??= setInterval(() => this.checkVideo(), 250);
        // a watcher that left while it started: stopped at once
        if (![...this.watchers.values()].some((w) => w.video)) this.stopVideo();
        else this.configureVideo();
        return this.videoOn;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'unknown_command' || code === 'unsupported') this.videoUnsupported = true;
        // a start that took too long may still come up: nothing records the screen for nobody
        else void h.request('display_video_stop', {}, 3000).catch(() => undefined);
        this.ctx.log.warn('live view: no video, pictures instead', errMsg(e));
        return false;
      } finally {
        this.videoStarting = null;
      }
    })();
    return this.videoStarting;
  }

  /** The encoder follows its watchers' tiers (only when that changes). */
  private configureVideo(): void {
    if (!this.videoOn) return;
    const tier = this.wantedVideoTier();
    if (tier < 0 || tier === this.videoTier) return;
    this.videoTier = tier;
    void this.helper()?.request('display_video_config', this.videoParams(tier), 3000).catch((e) => this.ctx.log.debug('live video: config', errMsg(e)));
  }

  /** Keeps the helper's video going (it stops by itself without this), and starts it again if the helper restarted. */
  private async renewVideo(): Promise<void> {
    if (!this.videoOn) return;
    try {
      const r = await this.helper()?.request<{ running?: boolean; blocked?: string }>('display_video_config', {}, 3000);
      if (r && r.running === false && r.blocked === undefined && this.videoOn) {
        // the helper was started afresh (it crashed, or was updated): its video with it
        this.videoOn = false;
        this.videoTier = -1;
        for (const w of this.watchers.values()) if (w.video) w.needKey = true;
        if (await this.startVideo()) this.requestKey();
      }
    } catch (e) {
      this.ctx.log.debug('live video: lease', errMsg(e));
    }
  }

  private stopVideo(): void {
    const was = this.videoOn || this.videoStarting;
    this.videoOn = false;
    this.videoTier = -1;
    this.videoBlocked = null;
    if (this.leaseTimer) { clearInterval(this.leaseTimer); this.leaseTimer = null; }
    if (this.checkTimer) { clearInterval(this.checkTimer); this.checkTimer = null; }
    if (was) void this.helper()?.request('display_video_stop', {}, 3000).catch(() => undefined);
  }

  /** Asks the helper for a keyframe, unless one is already on its way. */
  private requestKey(): void {
    if (!this.videoOn && !this.videoStarting) return;
    const now = Date.now();
    if (this.keyAskedAt && now - this.keyAskedAt < KEY_RETRY_MS) return;
    this.keyAskedAt = now;
    void this.helper()?.request('display_video_key', {}, 3000).catch(() => undefined);
  }

  private keyIfCaughtUp(w: WatchState): void {
    if (caughtUp(this.ahead(w), w.backlog?.() ?? 0, this.budget(w))) this.requestKey();
  }

  /** what may be unconfirmed on its way to `w`: about a second at its link's own tier */
  private budget(w: WatchState): number {
    return videoBudget(w.route, VIDEO_TIERS[w.vtier]!.bitrate);
  }

  private ahead(w: WatchState): number {
    let n = 0;
    for (const b of w.bytes.values()) n += b;
    return n;
  }

  /** (every 250 ms while video runs) Frames never confirmed are let go; a watcher waiting for a keyframe asks for one once it has room. */
  private checkVideo(): void {
    const now = Date.now();
    for (const w of this.watchers.values()) {
      if (!w.video) continue;
      for (const [n, at] of w.out) if (now - at > LOST_MS) { w.out.delete(n); w.bytes.delete(n); }
      if (w.needKey) this.keyIfCaughtUp(w);
    }
  }

  private onHelperEvent(ev: Record<string, unknown>): void {
    if (ev.event === 'video') this.onUnit(ev as unknown as HelperUnit);
    else if (ev.event === 'video_state') {
      if (ev.error) this.ctx.log.warn('live video:', String(ev.error));
      if (ev.stopped && this.videoOn) {
        // its lease ran out (this process was too busy to renew it): started again for those still watching
        this.videoOn = false;
        this.videoTier = -1;
        if ([...this.watchers.values()].some((w) => w.video)) void this.startVideo().then((ok) => ok && this.requestKey());
        return;
      }
      if ('blocked' in ev) {
        const blocked = ev.blocked === 'locked' ? 'locked' : null;
        this.videoBlocked = blocked;
        for (const w of this.watchers.values()) {
          if (!w.video) continue;
          this.tell(w, blocked);
          // the stream starts again after an unlock with a keyframe for everyone
          if (!blocked) w.needKey = true;
        }
      }
    }
  }

  /** One encoded frame: to each video watcher that can decode it and has room for it. */
  private onUnit(u: HelperUnit): void {
    // (the first keyframe may come down the pipe before the start's answer)
    if (!this.videoOn && !this.videoStarting) return;
    if (u.key) this.keyAskedAt = 0;
    if (u.bounds) this.bounds = u.bounds;
    const seq = ++this.videoSeq;
    const bytes = u.data.length;
    const cursor = u.bounds ? cursorOn(u.bounds, u.cursor) : undefined;
    const screen = u.bounds ? { width: u.bounds.width, height: u.bounds.height } : undefined;
    const now = Date.now();
    let waiting = false;
    for (const w of this.watchers.values()) {
      if (!w.video) continue;
      const backlog = w.backlog?.() ?? 0;
      const verdict = videoGate({ needKey: w.needKey, ahead: this.ahead(w), backlog }, { key: u.key, bytes }, this.budget(w));
      if (verdict === 'wait') { waiting = true; continue; }
      if (verdict === 'skip') {
        // it couldn't decode what comes next without this one: nothing more until a keyframe, at a lower tier
        if (!w.needKey) this.ctx.log.debug(`live video: watcher ${w.id} behind, skipping to a keyframe`);
        w.needKey = true;
        // (not again just after a step: the queue from before it is still draining)
        if (now - w.skippedAt > VIDEO_STEP_MS && now - w.steppedAt > VIDEO_STEP_MS && w.vtier < VIDEO_TIERS.length - 1) this.stepDown(w, now);
        w.skippedAt = now;
        continue;
      }
      if (!this.videoBlocked) this.tell(w, null);
      const sent = w.send('computer.liveVideo', {
        seq, data: u.data, key: u.key, ...(u.key && u.sps && u.pps ? { sps: u.sps, pps: u.pps } : {}),
        width: u.width, height: u.height, ts: now, inputSeq: w.applied, ...(cursor ? { cursor } : {}), ...(screen ? { screen } : {}),
      });
      if (sent === false) { w.needKey = true; w.skippedAt = now; continue; }
      if (u.key) w.needKey = false;
      w.out.set(seq, now);
      w.bytes.set(seq, bytes);
      w.recent.push({ at: now, bytes });
      w.seq = seq;
      w.lastSent = now;
    }
    // someone is waiting for a keyframe and has room: ask (it comes with the next frame, or at once on a still screen)
    if (waiting) for (const w of this.watchers.values()) if (w.video && w.needKey) this.keyIfCaughtUp(w);
  }

  /* ---------- pictures ---------- */

  private async readBounds(): Promise<Bounds | null> {
    const src = this.source();
    if (!src) return this.bounds;
    this.picturesOn = true;
    try {
      const r = await src.frame({ maxDim: TIERS[TIERS.length - 1]!.maxDim, quality: TIERS[TIERS.length - 1]!.quality, after: 0 });
      if (r.bounds) this.bounds = r.bounds;
    } catch (e) {
      this.ctx.log.warn('live view: no picture', errMsg(e));
    }
    return this.bounds;
  }

  /** Sends each picture watcher the screen's newest picture when it changed, it has room for one, and its pace allows. */
  private async loop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while ([...this.watchers.values()].some((w) => !w.video)) {
        const src = this.source();
        if (!src) break;
        const now = Date.now();
        let sent = false;
        for (const w of [...this.watchers.values()]) {
          if (w.video) continue;
          // a fixed size applies at once (on `auto` each link keeps finding its own)
          const mode = liveModeFor(w.route);
          if (mode !== 'auto') w.tier = FIXED[mode];
          for (const [n, at] of w.out) if (now - at > LOST_MS) { w.out.delete(n); w.bytes.delete(n); }
          const urgent = now < w.urgentUntil;
          if (w.out.size >= WINDOWS[w.route] + (urgent ? 1 : 0)) continue;
          // never more on its way than the link carries (the first picture always goes)
          let ahead = 0;
          for (const b of w.bytes.values()) ahead += b;
          if (ahead && ahead >= BYTES_AHEAD[w.route]) continue;
          if (!urgent && now - w.lastSent < 1000 / MAX_FPS) continue;
          const t = TIERS[w.tier]!;
          // the helper does one thing at a time: the inputs carried out by now are all in this picture
          const applied = w.applied;
          let r: HelperFrame;
          try {
            // never waiting in the helper: it does one thing at a time, and a bot's step mustn't queue behind a picture
            // without the cursor: the device draws its own where `cursor` says (no second pointer lagging behind it)
            this.picturesOn = true;
            r = await src.frame({ maxDim: t.maxDim, quality: t.quality, after: w.seq });
          } catch (e) {
            // a locked screen: the device says so (only the person at the Mac can unlock it) and it's looked at less often
            const locked = (e as { code?: string }).code === 'screen_locked';
            if (locked) this.tell(w, 'locked');
            else this.ctx.log.warn('live view: no picture', errMsg(e));
            await sleep(locked ? 1500 : 500);
            continue;
          }
          this.tell(w, null);
          if (r.bounds) this.bounds = r.bounds;
          if (r.unchanged || !r.image_base64 || r.seq === undefined || this.watchers.get(w.id) !== w) continue;
          w.seq = r.seq;
          w.lastSent = Date.now();
          w.out.set(r.seq, w.lastSent);
          w.bytes.set(r.seq, r.image_base64.length);
          const cursor = r.bounds ? cursorOn(r.bounds, r.cursor) : undefined;
          const screen = r.bounds ? { width: r.bounds.width, height: r.bounds.height } : undefined;
          w.send('computer.live', { seq: r.seq, data: r.image_base64, width: r.width ?? 0, height: r.height ?? 0, ts: w.lastSent, inputSeq: applied, ...(cursor ? { cursor } : {}), ...(screen ? { screen } : {}) });
          sent = true;
        }
        // a still screen: look again in a moment (at once when the device's input wakes it)
        if (!sent) await this.rest(LOOK_MS);
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * The watcher's own hand on the computer: real input at the point they touched, keys, the clipboard. Once carried
   * out its `seq` is that watcher's newest, which its next pictures say (so a picture taken before a move landed
   * never puts the pointer back).
   */
  async input(i: LiveInput, watcherId?: number, legacy?: { name: string }): Promise<{ ok: true; text?: string }> {
    // view-only until this viewer takes control (computer.control): then its input goes, and renews the hold
    const computer = this.ctx.s.computer;
    if (watcherId === undefined || !computer.touchControl(controlKey(watcherId))) {
      const c = computer.control.current();
      // a phone from before Take control (`legacy`: its connection never called computer.control, so it has no pill)
      // keeps its hand as before: its input takes control while nobody holds it
      if (legacy && watcherId !== undefined && !c) computer.control.take({ key: controlKey(watcherId), name: legacy.name, via: 'live' });
      else throw new RpcError(c ? 'in_control' : 'not_in_control', c ? `${c.name} is in control of the screen right now.` : 'You’re watching: take control first (update AppuBot on this device if it has no Take control).');
    }
    for (const fn of this.inputListeners) { try { fn(i, this.bounds); } catch { /* a listener's own trouble */ } }
    try {
      return await this.apply(i);
    } finally {
      // done or failed, it is behind the device now: its next pictures say so (else its pointer would wait for it)
      const w = watcherId !== undefined ? this.watchers.get(watcherId) : undefined;
      if (w) {
        if (i.seq !== undefined && i.seq > w.applied) w.applied = i.seq;
        // what it did shows as soon as the screen has it: the next pictures skip the queue, and the loop looks now
        w.urgentUntil = Date.now() + URGENT_MS;
        this.wake?.();
      }
    }
  }

  /** the loop's rest between looks at a still screen, cut short by `wake` */
  private wake: (() => void) | null = null;
  private rest(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(t); this.wake = null; resolve(); };
    });
  }

  private async apply(i: LiveInput): Promise<{ ok: true; text?: string }> {
    const h = this.helper();
    if (!h) {
      if (!this.supported) throw new RpcError('unavailable', 'Live view isn’t available on this computer');
      return this.applyOnComputer(i);
    }
    const b = this.bounds ?? (await this.readBounds());
    if (!b && 'x' in i) throw new RpcError('unavailable', 'The screen is not available right now');
    const at = (fx: number, fy: number) => toPoint(b!, fx, fy);
    switch (i.kind) {
      // a double tap's second press: its first tap already clicked, so only the click carrying the count goes out
      case 'click': await h.request('click', { ...at(i.x, i.y), button: i.button, count: i.count, ...(i.count > 1 ? { click_state: i.count } : {}) }); break;
      case 'move': await h.request('mouse_move', at(i.x, i.y)); break;
      case 'down': await h.request('mouse_down', at(i.x, i.y)); break;
      case 'up': await h.request('mouse_up', at(i.x, i.y)); break;
      case 'scroll': await h.request('scroll', { ...at(i.x, i.y), dx: Math.round(i.dx), dy: Math.round(i.dy) }); break;
      case 'type': await h.request('type_text', { text: i.text }, 30_000); break;
      case 'key': await h.request('key', { key: i.key, modifiers: i.modifiers }); break;
      case 'paste':
        await h.request('clipboard_set', { text: i.text });
        await h.request('hotkey', { keys: ['cmd', 'v'] });
        break;
      case 'copy': {
        const r = await h.request<{ text?: string | null }>('clipboard_get', {});
        return { ok: true, text: r.text ?? '' };
      }
    }
    return { ok: true };
  }

  /**
   * Without a helper: the watcher's hand through the computer-use backend's desktop scope (Cua posts real X11 input
   * on the cloud computer), as the user's own take-over (`ComputerService.userAct`: never a bot's, and allowed while
   * the bots are paused). The display's pixels are the picture's coordinates. A finger down and up apart becomes a
   * drag, together a click.
   */
  private async applyOnComputer(i: LiveInput): Promise<{ ok: true; text?: string }> {
    const b = this.bounds ?? (await this.readBounds());
    if (!b && 'x' in i) throw new RpcError('unavailable', 'The screen is not available right now');
    const at = (fx: number, fy: number) => toPoint(b!, fx, fy);
    const run = async (a: ComputerAction) => this.ctx.s.computer.userAct(a);
    switch (i.kind) {
      case 'click': {
        const p = at(i.x, i.y);
        if (i.button === 'right') await run({ type: 'right_click', ...p });
        else if (i.count === 2) await run({ type: 'double_click', ...p });
        else await run({ type: 'click', ...p, detail: JSON.stringify({ button: 'left', count: i.count }) });
        break;
      }
      case 'move': await run({ type: 'move', ...at(i.x, i.y) }); break;
      case 'down': this.held = at(i.x, i.y); break;
      case 'up': {
        const from = this.held;
        this.held = null;
        const to = at(i.x, i.y);
        if (!from) break;
        if (Math.hypot(to.x - from.x, to.y - from.y) < DRAG_MIN_PX) await run({ type: 'click', ...to, detail: JSON.stringify({ button: 'left', count: 1 }) });
        else await run({ type: 'drag', x: from.x, y: from.y, toX: to.x, toY: to.y, detail: JSON.stringify({ value: 300 }) });
        break;
      }
      case 'scroll': {
        const vertical = Math.abs(i.dy) >= Math.abs(i.dx);
        const amount = Math.max(1, Math.round(Math.abs(vertical ? i.dy : i.dx) / SCROLL_LINE_PX));
        const direction = vertical ? (i.dy > 0 ? 'down' : 'up') : i.dx > 0 ? 'right' : 'left';
        await run({ type: 'scroll', ...at(i.x, i.y), detail: JSON.stringify({ direction, amount }) });
        break;
      }
      case 'type': await run({ type: 'type', text: i.text }); break;
      case 'key': {
        const key = [...i.modifiers, liveKeyName(i.key)].join('+');
        await run({ type: i.modifiers.length ? 'hotkey' : 'key', key });
        break;
      }
      case 'paste':
        await run({ type: 'clipboard', text: i.text, detail: JSON.stringify({ op: 'write' }) });
        await run({ type: 'hotkey', key: 'cmd+v' });
        break;
      case 'copy': {
        const r = await run({ type: 'clipboard', detail: JSON.stringify({ op: 'read' }) });
        return { ok: true, text: r.text ?? '' };
      }
    }
    return { ok: true };
  }

  shutdown(): void {
    this.watchers.clear();
    this.settleStreams();
    this.offEvents?.();
    this.offEvents = null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The control key of a gateway connection watching live (`ScreenControlHolder`): its `computer.control` holds it. */
export function controlKey(watcherId: number): string { return `conn:${watcherId}`; }

/** A live view key name (the phone's, named as the Mac helper takes them) as the computer-use backend's key. */
export function liveKeyName(key: string): string {
  const k = key.toLowerCase();
  if (k === 'forwarddelete') return 'delete';
  if (k === 'return') return 'enter';
  return k;
}
