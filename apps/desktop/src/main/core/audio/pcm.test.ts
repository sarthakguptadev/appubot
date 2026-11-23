import { describe, expect, it } from 'vitest';
import { downmix, durationMs, floatToInt16, int16ToFloat, pcmToWav, resample, wavDecode } from './pcm';

const sine = (hz: number, rate: number, seconds: number, amp = 12_000): Int16Array =>
  Int16Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * hz * i) / rate)));
/** sign changes: about 2 per cycle */
const crossings = (s: Int16Array): number => { let n = 0; for (let i = 1; i < s.length; i++) if ((s[i - 1]! < 0) !== (s[i]! < 0)) n++; return n; };
const rms = (s: Int16Array): number => Math.sqrt(s.reduce((a, x) => a + x * x, 0) / s.length);

describe('pcm', () => {
  it('reads back a WAV made by pcmToWav', () => {
    const s = sine(440, 16_000, 0.1);
    const w = wavDecode(pcmToWav(new Uint8Array(s.buffer), 16_000));
    expect(w.sampleRate).toBe(16_000);
    expect(w.channels).toBe(1);
    expect([...w.pcm16]).toEqual([...s]);
  });

  it('finds the chunks wherever they are, and downmixes stereo float', () => {
    // RIFF, WAVE, a LIST chunk of odd size (padded), fmt (float, 2 channels), data
    const frames = 4;
    const list = 3;
    const len = 12 + 8 + list + 1 + 8 + 16 + 8 + frames * 8;
    const b = new Uint8Array(len);
    const v = new DataView(b.buffer);
    const ascii = (o: number, s: string) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i); };
    ascii(0, 'RIFF'); v.setUint32(4, len - 8, true); ascii(8, 'WAVE');
    ascii(12, 'LIST'); v.setUint32(16, list, true);
    let o = 20 + list + 1;
    ascii(o, 'fmt '); v.setUint32(o + 4, 16, true); v.setUint16(o + 8, 3, true); v.setUint16(o + 10, 2, true);
    v.setUint32(o + 12, 44_100, true); v.setUint32(o + 16, 44_100 * 8, true); v.setUint16(o + 20, 8, true); v.setUint16(o + 22, 32, true);
    o += 24;
    ascii(o, 'data'); v.setUint32(o + 4, frames * 8, true);
    const samples = [[0.5, -0.5], [1, 1], [-1, -1], [0.25, 0.75]];
    samples.forEach(([l, r], i) => { v.setFloat32(o + 8 + i * 8, l!, true); v.setFloat32(o + 12 + i * 8, r!, true); });
    const w = wavDecode(b);
    expect(w).toMatchObject({ sampleRate: 44_100, channels: 2 });
    expect([...w.pcm16]).toEqual([0, 32767, -32768, 16384]);
  });

  it('refuses what is not a WAV', () => {
    expect(() => wavDecode(new Uint8Array(20))).toThrow('Not a WAV file');
  });

  it('resamples to the right length and keeps the pitch', () => {
    const s = sine(440, 16_000, 1);
    const up = resample(s, 16_000, 48_000);
    expect(up.length).toBe(48_000);
    expect(Math.abs(crossings(up) - 880)).toBeLessThan(10);
    const down = resample(sine(440, 44_100, 1), 44_100, 16_000);
    expect(down.length).toBe(16_000);
    expect(Math.abs(crossings(down) - 880)).toBeLessThan(10);
    expect(resample(s, 16_000, 16_000)).toBe(s);
  });

  it('low-passes before going down, so tones above the new Nyquist fade rather than fold back', () => {
    // 12 kHz at 48 kHz would alias to 4 kHz at 16 kHz
    const high = resample(sine(12_000, 48_000, 0.5), 48_000, 16_000);
    const keep = resample(sine(1_000, 48_000, 0.5), 48_000, 16_000);
    expect(rms(high)).toBeLessThan(rms(keep) / 20);
  });

  it('converts samples and durations', () => {
    expect([...floatToInt16(Float32Array.from([0, 1, -1, 2, 0.5]))]).toEqual([0, 32767, -32768, 32767, 16384]);
    expect([...int16ToFloat(Int16Array.from([0, -32768, 16384]))]).toEqual([0, -1, 0.5]);
    expect([...downmix(Int16Array.from([2, 4, -6, -8]), 2)]).toEqual([3, -7]);
    expect(durationMs(24_000, 48_000)).toBe(500);
  });
});
