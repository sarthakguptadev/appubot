import { describe, expect, it, vi } from 'vitest';
import type { LiveFrame, LiveVideo } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import {
  LiveViewService, VIDEO_BACKLOG_MAX, VIDEO_QUICK_RUN, VIDEO_SLOW_MS, VIDEO_START, VIDEO_TIERS, caughtUp, stepVideoTier, tierForRate, trendSlope, VIDEO_TREND, videoBudget, videoGate,
  type Watcher,
} from './liveView';

const BOUNDS = { x: 0, y: 0, width: 1470, height: 956 };

/** A helper that streams video: tests push its encoded frames (`frame`) as the real one's events. */
function videoHelper(opts: { unsupported?: boolean } = {}) {
  const listeners = new Set<(ev: Record<string, unknown>) => void>();
  const calls: { cmd: string; params: Record<string, unknown> }[] = [];
  let pictures = 0;
  const h = {
    calls,
    emit: (ev: Record<string, unknown>) => { for (const l of listeners) l(ev); },
    /** one encoded frame of `bytes` (base64 characters) */
    frame: (key: boolean, bytes = 1000) => h.emit({
      event: 'video', data: 'v'.repeat(bytes), key, ...(key ? { sps: 'SPS', pps: 'PPS' } : {}), width: 1280, height: 832, bounds: BOUNDS, cursor: { x: 735, y: 478 },
    }),
    asked: (cmd: string) => calls.filter((c) => c.cmd === cmd),
    request: vi.fn(async (cmd: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      calls.push({ cmd, params });
      if (cmd === 'display_video_start') {
        if (opts.unsupported) throw Object.assign(new Error("unknown command 'display_video_start'"), { code: 'unknown_command' });
        return { started: true, running: true, bounds: BOUNDS, width: 1280, height: 832 };
      }
      if (cmd === 'display_video_config') return { running: true, bounds: BOUNDS };
      if (cmd === 'display_video_key') return { sent: true };
      if (cmd === 'display_stream_frame') {
        pictures += 1;
        return { image_base64: `img${pictures}`, width: 1280, height: 832, seq: pictures, bounds: BOUNDS, cursor: { x: 735, y: 478 } };
      }
      return { ok: true };
    }),
    onEvent: (fn: (ev: Record<string, unknown>) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    close: () => undefined,
  };
  return h;
}

function service(helper: ReturnType<typeof videoHelper>) {
  const ctx = {
    s: { computer: { helper: () => helper }, settings: { get: () => ({ computer: { liveQuality: 'auto' } }) } },
    log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
  } as unknown as CoreCtx;
  return new LiveViewService(ctx);
}

/** a watcher recording what it was sent; `backlog`/`refuse` stand in for its socket */
function watcher(id: number, route: Watcher['route'] = 'lan') {
  const got: LiveVideo[] = [];
  const pictures: LiveFrame[] = [];
  const states: unknown[] = [];
  const link = { backlog: 0, refuse: false };
  const w: Watcher = {
    id, route,
    send: (e, p) => {
      if (e === 'computer.liveVideo') { if (link.refuse) return false; got.push(p as LiveVideo); }
      else if (e === 'computer.live') pictures.push(p as LiveFrame);
      else states.push(p);
      return true;
    },
    backlog: () => link.backlog,
  };
  return { w, got, pictures, states, link };
}

const VIDEO = { codecs: ['h264'] };
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const onMac = process.platform === 'darwin';

describe('live video: pure parts', () => {
  it('a frame goes, waits for a keyframe, or is skipped by a link too far behind', () => {
    const budget = 300_000;
    const delta = { key: false, bytes: 20_000 };
    const key = { key: true, bytes: 100_000 };
    expect(videoGate({ needKey: true, ahead: 0, backlog: 0 }, delta, budget)).toBe('wait');
    expect(videoGate({ needKey: true, ahead: 0, backlog: 0 }, key, budget)).toBe('send');
    // the first frame always goes, however big
    expect(videoGate({ needKey: false, ahead: 0, backlog: 0 }, { key: true, bytes: 900_000 }, budget)).toBe('send');
    expect(videoGate({ needKey: false, ahead: 250_000, backlog: 0 }, delta, budget)).toBe('send');
    // never more than the budget on its way, counting this frame and the socket's backlog
    expect(videoGate({ needKey: false, ahead: 250_000, backlog: 0 }, { key: false, bytes: 60_000 }, budget)).toBe('skip');
    expect(videoGate({ needKey: false, ahead: 250_000, backlog: 40_000 }, delta, budget)).toBe('skip');
    expect(videoGate({ needKey: false, ahead: 0, backlog: VIDEO_BACKLOG_MAX }, delta, budget)).toBe('skip');
    // a keyframe a link has no room for is skipped too (it keeps waiting)
    expect(videoGate({ needKey: true, ahead: 280_000, backlog: 0 }, key, budget)).toBe('skip');
  });

  it('a link may have about a second of video unconfirmed, always room for a keyframe, never more than its route carries', () => {
    expect(videoBudget('connect', VIDEO_TIERS[VIDEO_START.connect]!.bitrate)).toBe(300_000);
    expect(videoBudget('lan', VIDEO_TIERS[0]!.bitrate)).toBe(1_000_000);
    expect(videoBudget('local', VIDEO_TIERS[0]!.bitrate)).toBe(1_000_000);
    expect(caughtUp(100_000, 0, 300_000)).toBe(true);
    expect(caughtUp(200_000, 0, 300_000)).toBe(false);
    expect(caughtUp(0, VIDEO_BACKLOG_MAX, 300_000)).toBe(false);
  });

  it('queueing steps a link down a tier; a long quick run with nothing skipped steps it up, never past its floor', () => {
    const calm = { sinceSkip: 60_000, sinceStep: 60_000 };
    expect(stepVideoTier(2, { queueMs: VIDEO_SLOW_MS + 1, quick: 0, ...calm })).toEqual({ tier: 3, quick: 0 });
    expect(stepVideoTier(VIDEO_TIERS.length - 1, { queueMs: 5000, quick: 0, ...calm }).tier).toBe(VIDEO_TIERS.length - 1);
    expect(stepVideoTier(3, { queueMs: 20, quick: VIDEO_QUICK_RUN, ...calm })).toEqual({ tier: 2, quick: 0 });
    expect(stepVideoTier(2, { queueMs: 20, quick: VIDEO_QUICK_RUN, ...calm }, 2)).toEqual({ tier: 2, quick: VIDEO_QUICK_RUN });
    // not right after a skip, and steps are kept apart
    expect(stepVideoTier(3, { queueMs: 20, quick: VIDEO_QUICK_RUN, sinceSkip: 1000, sinceStep: 60_000 }).tier).toBe(3);
    expect(stepVideoTier(2, { queueMs: 5000, quick: 0, sinceSkip: 60_000, sinceStep: 100 }).tier).toBe(2);
  });

  it('a queue growing shows as confirmation times rising, whatever the link\'s own round trip', () => {
    const flat = Array.from({ length: 12 }, (_, i) => ({ t: i * 100, ms: 900 + (i % 3) * 40 }));
    expect(Math.abs(trendSlope(flat))).toBeLessThan(VIDEO_TREND);
    // 12% more than the link carries: the queue grows 0.12 s a second, on top of a round trip of 900 ms
    const rising = Array.from({ length: 12 }, (_, i) => ({ t: i * 100, ms: 900 + i * 12 + (i % 3) * 30 }));
    expect(trendSlope(rising)).toBeGreaterThan(VIDEO_TREND);
    expect(trendSlope(rising.slice(0, 3))).toBe(0);
    expect(stepVideoTier(3, { queueMs: 0, quick: 0, sinceSkip: 60_000, sinceStep: 60_000, growing: true }).tier).toBe(4);
  });

  it("a link found to deliver some rate gets the best tier whose stream (as base64) fits in it", () => {
    expect(tierForRate(100_000_000)).toBe(0);
    expect(tierForRate(1_000_000)).toBe(VIDEO_TIERS.findIndex((t) => t.bitrate === 500_000));
    expect(tierForRate(2_000_000)).toBe(VIDEO_TIERS.findIndex((t) => t.bitrate === 1_200_000));
    expect(tierForRate(10_000)).toBe(VIDEO_TIERS.length - 1);
  });

  it('the relay starts at 1280 px around 1.2 Mbit/s; the same Wi-Fi at the best; the bitrate steps before the size', () => {
    expect(VIDEO_TIERS[VIDEO_START.connect]).toMatchObject({ maxDim: 1280, bitrate: 1_200_000 });
    expect(VIDEO_TIERS[VIDEO_START.lan]!.bitrate).toBeGreaterThanOrEqual(6_000_000);
    // each step down lowers the bitrate; one step either side of the relay's start keeps its size (no new keyframe)
    for (let i = 1; i < VIDEO_TIERS.length; i++) expect(VIDEO_TIERS[i]!.bitrate).toBeLessThan(VIDEO_TIERS[i - 1]!.bitrate);
    expect(VIDEO_TIERS[VIDEO_START.connect - 1]!.maxDim).toBe(1280);
    expect(VIDEO_TIERS[VIDEO_START.connect + 1]!.maxDim).toBe(1280);
  });
});

describe.runIf(onMac)('live video', () => {
  it('a device that asks for video gets a keyframe first, with its parameter sets, then the frames after it', async () => {
    const h = videoHelper();
    const live = service(h);
    const a = watcher(1);
    const r = await live.watch(a.w, true, VIDEO);
    expect(r).toEqual({ ok: true, live: true, video: { codec: 'h264' }, screen: { width: 1470, height: 956 } });
    // the same Wi-Fi: the best tier, and a keyframe asked for at once
    expect(h.asked('display_video_start')[0]!.params).toMatchObject({ max_dimension: VIDEO_TIERS[0]!.maxDim, bitrate: VIDEO_TIERS[0]!.bitrate });
    expect(h.asked('display_video_key')).toHaveLength(1);
    // the picture stream never started
    expect(h.asked('display_stream_frame')).toHaveLength(0);
    h.frame(false);
    expect(a.got).toHaveLength(0);
    h.frame(true);
    h.frame(false);
    expect(a.got.map((f) => f.key)).toEqual([true, false]);
    expect(a.got[0]).toMatchObject({ sps: 'SPS', pps: 'PPS', width: 1280, height: 832, cursor: { x: 0.5, y: 0.5 }, screen: { width: 1470, height: 956 } });
    expect(a.got[1]!.sps).toBeUndefined();
    expect(a.got[1]!.seq).toBeGreaterThan(a.got[0]!.seq);
    live.shutdown();
  });

  it("the stream's first keyframe, coming down the pipe before the start's answer, isn't lost (nor asked for twice)", async () => {
    const h = videoHelper();
    const base = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (cmd: string, params: Record<string, unknown> = {}) => {
      const r = await base(cmd, params);
      if (cmd === 'display_video_start') h.frame(true);
      return r;
    });
    const live = service(h);
    const a = watcher(16);
    await live.watch(a.w, true, VIDEO);
    expect(a.got.map((f) => f.key)).toEqual([true]);
    expect(h.asked('display_video_key')).toHaveLength(0);
    live.shutdown();
  });

  it("a device that doesn't ask for video gets pictures, and no video starts", async () => {
    const h = videoHelper();
    const live = service(h);
    const a = watcher(2);
    const r = await live.watch(a.w, true);
    expect(r.video).toBeUndefined();
    await tick(150);
    expect(a.pictures.length).toBeGreaterThan(0);
    expect(h.asked('display_video_start')).toHaveLength(0);
    live.shutdown();
  });

  it('a helper without video (an older build) leaves the device on pictures', async () => {
    const h = videoHelper({ unsupported: true });
    const live = service(h);
    const a = watcher(3);
    const r = await live.watch(a.w, true, VIDEO);
    expect(r.video).toBeUndefined();
    expect(r.live).toBe(true);
    await tick(150);
    expect(a.pictures.length).toBeGreaterThan(0);
    expect(a.got).toHaveLength(0);
    // it isn't asked again for the next device
    await live.watch(watcher(4).w, true, VIDEO);
    expect(h.asked('display_video_start')).toHaveLength(1);
    live.shutdown();
  });

  it('a link too far behind gets nothing more until it has caught up, then a keyframe: never a frame past one it missed', async () => {
    const h = videoHelper();
    const live = service(h);
    const a = watcher(5, 'connect');
    await live.watch(a.w, true, VIDEO);
    h.frame(true, 200_000);
    h.frame(false, 60_000);
    // over its 300 KB unconfirmed: skipped, and so is everything after it
    h.frame(false, 60_000);
    h.frame(false, 1000);
    expect(a.got.map((f) => f.data.length)).toEqual([200_000, 60_000]);
    const keysBefore = h.asked('display_video_key').length;
    // the device shows what it got: it has room again, and a keyframe is asked for it
    live.ack(5, a.got.at(-1)!.seq);
    expect(h.asked('display_video_key').length).toBe(keysBefore + 1);
    h.frame(false, 1000);
    expect(a.got).toHaveLength(2);
    h.frame(true, 50_000);
    h.frame(false, 1000);
    expect(a.got.map((f) => f.key)).toEqual([true, false, true, false]);
    live.shutdown();
  });

  it('a socket backed up, or a frame the connection refused, means waiting for a keyframe', async () => {
    const h = videoHelper();
    const live = service(h);
    const a = watcher(6);
    await live.watch(a.w, true, VIDEO);
    h.frame(true);
    a.link.backlog = VIDEO_BACKLOG_MAX;
    h.frame(false);
    a.link.backlog = 0;
    h.frame(false);
    expect(a.got).toHaveLength(1);
    h.frame(true);
    expect(a.got).toHaveLength(2);
    a.link.refuse = true;
    h.frame(false);
    a.link.refuse = false;
    h.frame(false);
    expect(a.got).toHaveLength(2);
    h.frame(true);
    expect(a.got).toHaveLength(3);
    live.shutdown();
  });

  it('a skip steps the link down a tier, and the one encoder runs at the lowest tier anyone watching needs', async () => {
    const h = videoHelper();
    const live = service(h);
    const near = watcher(7, 'lan');
    const far = watcher(8, 'connect');
    await live.watch(near.w, true, VIDEO);
    await live.watch(far.w, true, VIDEO);
    // the relay's watcher sets the encoder's tier
    expect(h.asked('display_video_config').at(-1)!.params).toMatchObject({ bitrate: VIDEO_TIERS[VIDEO_START.connect]!.bitrate });
    h.frame(true, 200_000);
    h.frame(false, 200_000);
    expect(h.asked('display_video_config').at(-1)!.params).toMatchObject({ bitrate: VIDEO_TIERS[VIDEO_START.connect + 1]!.bitrate });
    // the Wi-Fi one got both
    expect(near.got).toHaveLength(2);
    // the far one leaves: the encoder goes back up to the near one's
    await live.watch(far.w, false);
    expect(h.asked('display_video_config').at(-1)!.params).toMatchObject({ bitrate: VIDEO_TIERS[0]!.bitrate });
    live.shutdown();
  });

  it("a quick link steps up only while it carries near its tier's rate (a still screen's tiny frames prove nothing)", async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      const h = videoHelper();
      const live = service(h);
      const a = watcher(17, 'connect');
      await live.watch(a.w, true, VIDEO);
      const tierOf = () => h.asked('display_video_config').filter((c) => 'bitrate' in c.params).at(-1)?.params.bitrate ?? h.asked('display_video_start')[0]!.params.bitrate;
      expect(tierOf()).toBe(VIDEO_TIERS[VIDEO_START.connect]!.bitrate);
      vi.advanceTimersByTime(8000);
      const run = (bytes: number, n: number) => {
        for (let i = 0; i < n; i++) {
          h.frame(i === 0 && a.got.length === 0, bytes);
          vi.advanceTimersByTime(40);
          live.ack(17, a.got.at(-1)!.seq);
        }
      };
      // a still screen: tiny frames, confirmed at once
      run(200, VIDEO_QUICK_RUN * 2);
      expect(tierOf()).toBe(VIDEO_TIERS[VIDEO_START.connect]!.bitrate);
      // the screen moves: the link carries its rate, and still confirms quickly
      run(8000, VIDEO_QUICK_RUN * 3);
      expect(tierOf()).toBe(VIDEO_TIERS[VIDEO_START.connect - 1]!.bitrate);
      live.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a decoder that lost its place asks for a keyframe and gets nothing until one comes', async () => {
    const h = videoHelper();
    const live = service(h);
    const a = watcher(9);
    await live.watch(a.w, true, VIDEO);
    h.frame(true);
    live.ack(9, a.got[0]!.seq);
    const keys = h.asked('display_video_key').length;
    live.needKey(9);
    expect(h.asked('display_video_key').length).toBe(keys + 1);
    h.frame(false);
    expect(a.got).toHaveLength(1);
    h.frame(true);
    expect(a.got).toHaveLength(2);
    live.shutdown();
  });

  it('the screen locking and unlocking reaches video watchers once each', async () => {
    const h = videoHelper();
    const live = service(h);
    const a = watcher(10);
    await live.watch(a.w, true, VIDEO);
    h.frame(true);
    h.emit({ event: 'video_state', blocked: 'locked' });
    h.emit({ event: 'video_state', blocked: 'locked' });
    h.emit({ event: 'video_state', blocked: null });
    expect(a.states).toEqual([{ blocked: 'locked' }, { blocked: null }]);
    // after the unlock the stream starts again from a keyframe
    h.frame(false);
    expect(a.got).toHaveLength(1);
    live.shutdown();
  });

  it('the encoder stops the moment the last video watcher leaves', async () => {
    const h = videoHelper();
    const live = service(h);
    await live.watch(watcher(11).w, true, VIDEO);
    await live.watch(watcher(12).w, true, VIDEO);
    expect(h.asked('display_video_start')).toHaveLength(1);
    live.drop(11);
    expect(h.asked('display_video_stop')).toHaveLength(0);
    await live.watch(watcher(12).w, false);
    expect(h.asked('display_video_stop')).toHaveLength(1);
    // no picture stream was running, so none is stopped; a second goodbye asks nothing more
    expect(h.asked('display_stream_stop')).toHaveLength(0);
    const n = h.calls.length;
    live.drop(12);
    expect(h.calls.length).toBe(n);
    // frames still in the helper's pipe go nowhere
    h.frame(true);
    live.shutdown();
  });

  it('video and pictures side by side: each stream stops with its last watcher', async () => {
    const h = videoHelper();
    const live = service(h);
    const v = watcher(13);
    const p = watcher(14);
    await live.watch(v.w, true, VIDEO);
    await live.watch(p.w, true);
    await tick(100);
    h.frame(true);
    expect(v.got).toHaveLength(1);
    expect(p.got).toHaveLength(0);
    expect(p.pictures.length).toBeGreaterThan(0);
    expect(v.pictures).toHaveLength(0);
    live.drop(14);
    expect(h.asked('display_stream_stop')).toHaveLength(1);
    expect(h.asked('display_video_stop')).toHaveLength(0);
    live.drop(13);
    expect(h.asked('display_video_stop')).toHaveLength(1);
    live.shutdown();
  });

  it('the helper started afresh (its video gone with it): the lease finds out and starts it again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const h = videoHelper();
      const live = service(h);
      await live.watch(watcher(15).w, true, VIDEO);
      h.request.mockImplementationOnce(async (cmd: string, params: Record<string, unknown> = {}) => {
        h.calls.push({ cmd, params });
        return { running: false };
      });
      vi.advanceTimersByTime(10_000);
      await vi.waitFor(() => expect(h.asked('display_video_start')).toHaveLength(2));
      live.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
