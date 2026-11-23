import { describe, expect, it } from 'vitest';
import { decodeOggOpus, encodeOggOpus, oggOpusDurationMs } from './opus';
import { demuxOggOpus } from './ogg';
import { resample } from './pcm';
import { FFMPEG_TONE } from './tone.fixture';

const sine = (hz: number, rate: number, seconds: number): Int16Array =>
  Int16Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.round(12_000 * Math.sin((2 * Math.PI * hz * i) / rate)));
const crossings = (s: Int16Array): number => { let n = 0; for (let i = 1; i < s.length; i++) if ((s[i - 1]! < 0) !== (s[i]! < 0)) n++; return n; };

describe('opus', () => {
  it('encodes a second of 440 Hz and decodes it back to the same tone', () => {
    const ogg = encodeOggOpus(sine(440, 16_000, 1), 16_000);
    const s = demuxOggOpus(ogg);
    expect(s).toMatchObject({ channels: 1, preSkip: 312, inputSampleRate: 16_000, granuleEnd: 312 + 48_000 });
    expect(oggOpusDurationMs(ogg)).toBe(1000);
    const { pcm16, sampleRate } = decodeOggOpus(ogg);
    expect(sampleRate).toBe(48_000);
    expect(Math.abs(pcm16.length - 48_000)).toBeLessThan(48_000 * 0.05);
    const back = resample(pcm16, 48_000, 16_000);
    expect(Math.abs(crossings(back) - 880)).toBeLessThan(88);
  });

  it('decodes a voice note another encoder wrote', () => {
    const { pcm16 } = decodeOggOpus(FFMPEG_TONE);
    expect(pcm16.length).toBe(14_400);
    expect(oggOpusDurationMs(FFMPEG_TONE)).toBe(300);
    expect(Math.abs(crossings(pcm16) - 264)).toBeLessThan(27);
  });

  it('encodes silence and very short audio', () => {
    const ogg = encodeOggOpus(new Int16Array(10), 24_000, { bitrate: 16_000, application: 'audio' });
    expect(decodeOggOpus(ogg).pcm16.length).toBe(20);
  });
});
