import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Events, LIVE_VIDEO_CODECS, LiveVideoSchema, Methods } from './index';

describe('live video on the wire', () => {
  it('a watch with video is an optional addition: an old one still parses, and an older computer drops the field', () => {
    const watch = Methods['computer.watch'].params;
    expect(watch.parse({ on: true })).toEqual({ on: true });
    expect(watch.parse({ on: true, video: { codecs: [...LIVE_VIDEO_CODECS] } })).toEqual({ on: true, video: { codecs: ['h264'] } });
    // a codec this computer doesn't know is no error (a newer phone may name more)
    expect(watch.safeParse({ on: true, video: { codecs: ['h264', 'hevc', 'av1'] } }).success).toBe(true);
    // how a computer from before reads it (its schema had `on` alone): the field is dropped, pictures as ever
    const before = z.object({ on: z.boolean() });
    expect(before.parse({ on: true, video: { codecs: ['h264'] } })).toEqual({ on: true });
  });

  it("the watch's answer says which codec, when it streams one", () => {
    const res = Methods['computer.watch'].result;
    expect(res.parse({ ok: true, live: true })).toEqual({ ok: true, live: true });
    expect(res.parse({ ok: true, live: true, video: { codec: 'h264' } }).video).toEqual({ codec: 'h264' });
  });

  it('a frame carries its parameter sets with keyframes, and the same placement as pictures', () => {
    const key = LiveVideoSchema.parse({ seq: 1, data: 'AAAA', key: true, sps: 'Z0IAKA==', pps: 'aM4=', width: 1280, height: 832, ts: 1, cursor: { x: 0.5, y: 0.5 }, screen: { width: 1470, height: 956 }, inputSeq: 0 });
    expect(key.sps).toBe('Z0IAKA==');
    const delta = Events['computer.liveVideo'].parse({ seq: 2, data: 'AAAA', key: false, width: 1280, height: 832, ts: 2 });
    expect(delta.sps).toBeUndefined();
    expect(Events['computer.liveVideo'].safeParse({ seq: 3, data: 'AAAA', width: 1, height: 1, ts: 3 }).success).toBe(false);
  });

  it('asking for a keyframe takes nothing', () => {
    expect(Methods['computer.liveKey'].params.parse(undefined)).toEqual({});
    expect(Methods['computer.liveKey'].result.parse({ ok: true })).toEqual({ ok: true });
  });
});
