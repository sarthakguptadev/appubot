import { describe, expect, it, vi } from 'vitest';
import type { LiveFrame } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { BYTES_AHEAD, LiveViewService, QUICK_RUN, SLOW_MS, TIERS, WINDOWS, cursorOn, stepTier, toPoint } from './liveView';

/** A helper whose display changes every time it is asked (a moving screen), recording what it was asked. */
function fakeHelper(imageBytes = 0) {
  let n = 0;
  const calls: { cmd: string; params: Record<string, unknown> }[] = [];
  return {
    calls,
    request: vi.fn(async (cmd: string, params: Record<string, unknown> = {}) => {
      calls.push({ cmd, params });
      if (cmd === 'display_stream_frame') {
        n += 1;
        return { image_base64: imageBytes ? `img${n}`.padEnd(imageBytes, 'x') : `img${n}`, width: 1280, height: 832, seq: n, bounds: { x: 0, y: 0, width: 1470, height: 956 }, cursor: { x: 735, y: 478 } };
      }
      if (cmd === 'clipboard_get') return { text: 'from the Mac' };
      return { ok: true };
    }),
    onEvent: () => () => undefined,
    close: () => undefined,
  };
}

function service(helper: ReturnType<typeof fakeHelper>, liveQuality = 'auto') {
  const ctx = {
    s: { computer: { helper: () => helper, ...inControl() }, settings: { get: () => ({ computer: { liveQuality } }) } },
    log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
  } as unknown as CoreCtx;
  return new LiveViewService(ctx);
}

/** every watcher has control (the gate itself: its own test below) */
function inControl() {
  return { touchControl: () => true, control: { current: () => null } };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const onMac = process.platform === 'darwin';

describe('live view', () => {
  it('a slow link steps down a size, a quick run steps back up, never above where its route starts', () => {
    expect(stepTier(1, SLOW_MS + 1, 0)).toEqual({ tier: 2, quick: 0 });
    expect(stepTier(TIERS.length - 1, SLOW_MS + 1, 0).tier).toBe(TIERS.length - 1);
    expect(stepTier(2, 200, QUICK_RUN)).toEqual({ tier: 1, quick: 0 });
    expect(stepTier(2, 200, QUICK_RUN, 2)).toEqual({ tier: 2, quick: QUICK_RUN });
    expect(stepTier(2, 500, 3)).toEqual({ tier: 2, quick: 3 });
  });

  it('a touch on the picture lands on the same spot of the display, in global points', () => {
    const b = { x: 1470, y: -200, width: 1920, height: 1080 };
    expect(toPoint(b, 0.5, 0.5)).toEqual({ x: 2430, y: 340 });
    // the far edge is the next display's: a point short of it
    expect(toPoint(b, 1.4, -0.2)).toEqual({ x: 3389, y: -200 });
  });

  it("says where the pointer is on the picture, and nothing when it is on another display", () => {
    const b = { x: 0, y: 0, width: 1470, height: 956 };
    expect(cursorOn(b, { x: 735, y: 239 })).toEqual({ x: 0.5, y: 0.25 });
    expect(cursorOn(b, { x: 2000, y: 100 })).toBeUndefined();
    expect(cursorOn(b, undefined)).toBeUndefined();
  });

  // the Mac's helper reports the lock; elsewhere the pictures come from another source
  it.runIf(process.platform === 'darwin')('tells the phone once when the screen locks, and again when pictures come back', async () => {
    let locked = true;
    let n = 0;
    const h = {
      request: vi.fn(async (cmd: string) => {
        if (cmd !== 'display_stream_frame') return { ok: true };
        if (locked) throw Object.assign(new Error('the screen is locked'), { code: 'screen_locked' });
        n += 1;
        return { image_base64: `img${n}`, width: 10, height: 10, seq: n, bounds: { x: 0, y: 0, width: 10, height: 10 } };
      }),
      onEvent: () => () => undefined,
      close: () => undefined,
    };
    const live = service(h as unknown as ReturnType<typeof fakeHelper>);
    const states: unknown[] = [];
    await live.watch({ id: 9, route: 'lan', send: (e, p) => { if (e === 'computer.liveState') states.push(p); } }, true);
    await vi.waitFor(() => expect(states).toEqual([{ blocked: 'locked' }]), { timeout: 3000 });
    locked = false;
    await vi.waitFor(() => expect(states).toEqual([{ blocked: 'locked' }, { blocked: null }]), { timeout: 4000 });
    await live.watch({ id: 9, route: 'lan', send: () => undefined }, false);
  });

  it.runIf(onMac)('sends only a few pictures ahead of what the phone has shown (more over a distant link)', async () => {
    const h = fakeHelper();
    const live = service(h);
    const got: LiveFrame[] = [];
    const r = await live.watch({ id: 1, route: 'connect', send: (e, f) => { if (e === 'computer.live') got.push(f as LiveFrame); } }, true);
    expect(r).toEqual({ ok: true, live: true, screen: { width: 1470, height: 956 } });
    await tick(400);
    expect(got).toHaveLength(WINDOWS.connect);
    // through the relay the size adapts to the link, starting at 1024 px (the best one backed the relay up)
    const asked = h.calls.filter((c) => c.cmd === 'display_stream_frame').at(-1)!.params;
    expect(asked.max_dimension).toBe(TIERS[2]!.maxDim);
    expect(asked.wait_ms).toBe(0);
    // the phone draws the pointer: the picture comes without it, saying where it is
    expect(asked.cursor).toBe(false);
    expect(got[0]!.cursor).toEqual({ x: 0.5, y: 0.5 });
    live.ack(1, got.at(-1)!.seq);
    await tick(400);
    expect(got.length).toBe(WINDOWS.connect * 2);
    live.drop(1);
    live.shutdown();
  });

  it.runIf(onMac)('through the relay, never more bytes on their way than the link carries', async () => {
    const h = fakeHelper(BYTES_AHEAD.connect);
    const live = service(h);
    const got: LiveFrame[] = [];
    await live.watch({ id: 7, route: 'connect', send: (e, f) => { if (e === 'computer.live') got.push(f as LiveFrame); } }, true);
    await tick(300);
    // one big picture fills the budget: the next waits for it to be shown
    expect(got).toHaveLength(1);
    live.ack(7, got[0]!.seq);
    await tick(300);
    expect(got).toHaveLength(2);
    live.drop(7);
    live.shutdown();
  });

  it.runIf(onMac)('on the same Wi-Fi, always the best picture', async () => {
    const h = fakeHelper();
    const live = service(h);
    await live.watch({ id: 8, route: 'lan', send: () => undefined }, true);
    await tick(100);
    expect(h.calls.filter((c) => c.cmd === 'display_stream_frame').at(-1)!.params.max_dimension).toBe(TIERS[0]!.maxDim);
    live.drop(8);
    live.shutdown();
  });

  it.runIf(onMac)("right after the device's input, a picture goes even with its window full", async () => {
    const h = fakeHelper();
    const live = service(h);
    const got: LiveFrame[] = [];
    await live.watch({ id: 5, route: 'lan', send: (e, f) => { if (e === 'computer.live') got.push(f as LiveFrame); } }, true);
    await tick(200);
    expect(got).toHaveLength(WINDOWS.lan);
    await live.input({ kind: 'click', x: 0.5, y: 0.5, button: 'left', count: 1, seq: 1 }, 5);
    await tick(100);
    // one past the window, carrying the click
    expect(got).toHaveLength(WINDOWS.lan + 1);
    expect(got.at(-1)!.inputSeq).toBe(1);
    live.drop(5);
    live.shutdown();
  });

  it.runIf(onMac)("pictures say which of the device's inputs had landed when they were taken", async () => {
    const h = fakeHelper();
    const live = service(h);
    const got: LiveFrame[] = [];
    await live.watch({ id: 4, route: 'lan', send: (e, f) => { if (e === 'computer.live') got.push(f as LiveFrame); } }, true);
    await tick(250);
    expect(got[0]!.inputSeq).toBe(0);
    await live.input({ kind: 'move', x: 0.2, y: 0.2, seq: 7 }, 4);
    for (const f of got) live.ack(4, f.seq);
    await tick(300);
    expect(got.at(-1)!.inputSeq).toBe(7);
    live.drop(4);
    live.shutdown();
  });

  it.runIf(onMac)("the watcher's hand: a tap clicks at that point, paste sets the clipboard and pastes, copy reads it", async () => {
    const h = fakeHelper();
    const live = service(h);
    await live.watch({ id: 2, route: 'lan', send: () => undefined }, true);
    live.drop(2);
    await live.input({ kind: 'click', x: 0.5, y: 0.25, button: 'left', count: 2 }, 2);
    expect(h.calls.find((c) => c.cmd === 'click')!.params).toEqual({ x: 735, y: 239, button: 'left', count: 2, click_state: 2 });
    await live.input({ kind: 'paste', text: 'hello' }, 2);
    expect(h.calls.slice(-2).map((c) => c.cmd)).toEqual(['clipboard_set', 'hotkey']);
    expect(await live.input({ kind: 'copy' }, 2)).toEqual({ ok: true, text: 'from the Mac' });
    live.shutdown();
  });

  it.runIf(onMac)('the last viewer leaving stops the screen capture at once', async () => {
    const h = fakeHelper();
    const live = service(h);
    await live.watch({ id: 6, route: 'lan', send: () => undefined }, true);
    await live.watch({ id: 7, route: 'lan', send: () => undefined }, true);
    live.drop(6);
    expect(h.calls.some((c) => c.cmd === 'display_stream_stop')).toBe(false);
    await live.watch({ id: 7, route: 'lan', send: () => undefined }, false);
    expect(h.calls.at(-1)!.cmd).toBe('display_stream_stop');
    // a second goodbye from the same device asks nothing more
    const n = h.calls.length;
    live.drop(7);
    expect(h.calls.length).toBe(n);
    live.shutdown();
  });

  it('where the computer has no helper, live view says so', async () => {
    const ctx = { s: { computer: { helper: () => null }, settings: { get: () => ({ computer: { liveQuality: 'auto' } }) } }, log: { warn: () => undefined } } as unknown as CoreCtx;
    const live = new LiveViewService(ctx);
    expect(await live.watch({ id: 3, route: 'lan', send: () => undefined }, true)).toEqual({ ok: true, live: false });
  });
});

/* ---------- without a helper: a screen source (the AppuBot Cloud computer) and input through the computer backend ---------- */

function fakeScreen() {
  let seq = 0;
  const asked: { maxDim: number; quality: number; after: number }[] = [];
  const src = {
    asked,
    stopped: 0,
    /** the screen changes once per `change()`; until then `unchanged` for anyone who has the latest */
    change: () => { seq += 1; },
    frame: vi.fn(async (o: { maxDim: number; quality: number; after: number }) => {
      asked.push(o);
      if (seq <= o.after) return { unchanged: true, seq, bounds: { x: 0, y: 0, width: 1440, height: 900 } };
      return { seq, image_base64: `pic${seq}`, width: Math.min(o.maxDim, 1440), height: 900, bounds: { x: 0, y: 0, width: 1440, height: 900 } };
    }),
    stop: vi.fn(() => { src.stopped += 1; }),
  };
  return src;
}

function sourceService(src: ReturnType<typeof fakeScreen>) {
  const acts: import('@appubot/protocol').ComputerAction[] = [];
  const ctx = {
    deps: { liveScreen: () => src },
    s: { computer: { helper: () => null, ...inControl(), userAct: vi.fn(async (a: import('@appubot/protocol').ComputerAction) => { acts.push(a); return a.type === 'clipboard' && !a.text ? { text: 'from the cloud' } : {}; }) } },
    log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
  } as unknown as CoreCtx;
  return { live: new LiveViewService(ctx), acts };
}

describe('live view from a screen source (no native helper)', () => {
  it('streams the source’s pictures only when the screen changed, and stops the source with the last watcher', async () => {
    const src = fakeScreen();
    src.change();
    const { live } = sourceService(src);
    expect(live.supported).toBe(true);
    const got: LiveFrame[] = [];
    const r = await live.watch({ id: 1, route: 'cloud', send: (e, f) => { if (e === 'computer.live') got.push(f as LiveFrame); } }, true);
    expect(r).toEqual({ ok: true, live: true, screen: { width: 1440, height: 900 } });
    await tick(150);
    // the first picture, then only "unchanged" answers (the screen stood still)
    expect(got).toHaveLength(1);
    expect(got[0]!.data).toBe('pic1');
    // over the cloud route the size starts at the relay's tier (1024 px) and the picture comes without a cursor
    expect(src.asked.at(-1)!.maxDim).toBe(TIERS[2]!.maxDim);
    expect(got[0]!.cursor).toBeUndefined();
    src.change();
    live.ack(1, got[0]!.seq);
    await tick(150);
    expect(got).toHaveLength(2);
    expect(got[1]!.data).toBe('pic2');
    live.drop(1);
    await tick(50);
    expect(src.stopped).toBe(1);
    expect(live.watcherCount()).toBe(0);
  });

  it('carries the watcher’s hand through the computer backend in the display’s pixels, and tells its listeners', async () => {
    const src = fakeScreen();
    src.change();
    const { live, acts } = sourceService(src);
    const heard: unknown[] = [];
    const off = live.onInput((i) => heard.push(i.kind));
    await live.watch({ id: 2, route: 'cloud', send: () => undefined }, true);
    await tick(50);
    await live.input({ kind: 'click', x: 0.5, y: 0.5, button: 'left', count: 1 }, 2);
    expect(acts.at(-1)).toMatchObject({ type: 'click', x: 720, y: 450 });
    await live.input({ kind: 'click', x: 0.25, y: 0.1, button: 'left', count: 2 }, 2);
    expect(acts.at(-1)).toMatchObject({ type: 'double_click', x: 360, y: 90 });
    await live.input({ kind: 'click', x: 0, y: 0, button: 'right', count: 1 }, 2);
    expect(acts.at(-1)).toMatchObject({ type: 'right_click', x: 0, y: 0 });
    // a finger down and up apart: a drag; together: a click
    await live.input({ kind: 'down', x: 0.1, y: 0.1 }, 2);
    await live.input({ kind: 'up', x: 0.5, y: 0.5 }, 2);
    expect(acts.at(-1)).toMatchObject({ type: 'drag', x: 144, y: 90, toX: 720, toY: 450 });
    await live.input({ kind: 'down', x: 0.1, y: 0.1 }, 2);
    await live.input({ kind: 'up', x: 0.1, y: 0.1 }, 2);
    expect(acts.at(-1)).toMatchObject({ type: 'click', x: 144, y: 90 });
    await live.input({ kind: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: -120 }, 2);
    expect(acts.at(-1)).toMatchObject({ type: 'scroll', x: 720, y: 450 });
    expect(JSON.parse(acts.at(-1)!.detail!)).toEqual({ direction: 'up', amount: 3 });
    await live.input({ kind: 'type', text: 'hello' }, 2);
    expect(acts.at(-1)).toMatchObject({ type: 'type', text: 'hello' });
    await live.input({ kind: 'key', key: 'forwarddelete', modifiers: [] }, 2);
    expect(acts.at(-1)).toMatchObject({ type: 'key', key: 'delete' });
    await live.input({ kind: 'key', key: 'c', modifiers: ['cmd', 'shift'] }, 2);
    expect(acts.at(-1)).toMatchObject({ type: 'hotkey', key: 'cmd+shift+c' });
    await live.input({ kind: 'paste', text: 'pasted' }, 2);
    expect(acts.slice(-2).map((a) => a.type)).toEqual(['clipboard', 'hotkey']);
    expect(acts.at(-2)).toMatchObject({ text: 'pasted' });
    const copied = await live.input({ kind: 'copy' }, 2);
    expect(copied.text).toBe('from the cloud');
    expect(heard).toEqual(['click', 'click', 'click', 'down', 'up', 'down', 'up', 'scroll', 'type', 'key', 'key', 'paste', 'copy']);
    off();
    live.drop(2);
    live.shutdown();
  });

  it('takes one snapshot for anyone on this computer without leaving the source running', async () => {
    const src = fakeScreen();
    src.change();
    const { live } = sourceService(src);
    const shot = await live.snapshot(800, 0.5);
    expect(shot).toEqual({ data: 'pic1', width: 800, height: 900 });
    expect(src.stopped).toBe(1);
    expect(live.screenBounds()).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  });

  it('is not supported with neither a helper nor a source', () => {
    const ctx = { deps: {}, s: { computer: { helper: () => null } }, log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined } } as unknown as CoreCtx;
    const live = new LiveViewService(ctx);
    expect(live.supported).toBe(false);
  });
});

describe('live view’s Take control', () => {
  it.runIf(process.platform === 'darwin')('keeps a watcher’s hand off the screen until it has control, and renews the hold with each input', async () => {
    const { ScreenControlHolder } = await import('./screenControl');
    const holder = new ScreenControlHolder();
    const h = fakeHelper();
    const heard: string[] = [];
    const ctx = {
      s: {
        computer: { helper: () => h, control: holder, touchControl: (k: string) => holder.touch(k) },
        settings: { get: () => ({ computer: { liveQuality: 'auto' } }) },
      },
      log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
    } as unknown as CoreCtx;
    const live = new LiveViewService(ctx);
    live.onInput((i) => heard.push(i.kind));
    const { controlKey } = await import('./liveView');
    // watching: refused, unheard (teach mode records nothing), nothing sent
    await expect(live.input({ kind: 'type', text: 'hi' }, 3)).rejects.toMatchObject({ code: 'not_in_control' });
    await expect(live.input({ kind: 'type', text: 'hi' })).rejects.toMatchObject({ code: 'not_in_control' });
    // someone else has it: says who
    holder.take({ key: controlKey(9), name: 'Sam’s iPad', via: 'live' });
    await expect(live.input({ kind: 'type', text: 'hi' }, 3)).rejects.toMatchObject({ code: 'in_control', message: expect.stringContaining('Sam’s iPad') });
    holder.release(controlKey(9));
    // in control: it goes through
    holder.take({ key: controlKey(3), name: 'Phone', via: 'live' });
    await live.input({ kind: 'type', text: 'hi' }, 3);
    expect(h.calls.at(-1)).toMatchObject({ cmd: 'type_text', params: { text: 'hi' } });
    expect(heard).toEqual(['type']);
    holder.release(controlKey(3));
    // a phone from before Take control (no pill): its input takes control while nobody holds it, as before…
    await live.input({ kind: 'type', text: 'old' }, 5, { name: 'Old iPhone' });
    expect(holder.current()).toMatchObject({ name: 'Old iPhone' });
    expect(h.calls.at(-1)).toMatchObject({ cmd: 'type_text', params: { text: 'old' } });
    // …but never from someone else who has it
    holder.release(controlKey(5));
    holder.take({ key: controlKey(9), name: 'Sam’s iPad', via: 'live' });
    await expect(live.input({ kind: 'type', text: 'x' }, 5, { name: 'Old iPhone' })).rejects.toMatchObject({ code: 'in_control' });
    holder.shutdown();
    live.shutdown();
  });
});
