/**
 * PCM helpers shared by voice: sample conversion, resampling, downmixing and WAV framing. Pure, no Electron.
 * Samples are 16-bit signed (`Int16Array`, the machine's byte order: little-endian everywhere we run).
 */

/** 16-bit little-endian mono PCM at `sampleRate` as a WAV file. */
export function pcmToWav(pcm: Uint8Array, sampleRate = 16_000): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const ascii = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, 'data'); v.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

const tag = (b: Uint8Array, o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

/**
 * A WAV file as mono 16-bit samples. Reads integer PCM (8, 16, 24, 32 bit) and float (32, 64 bit), plain or
 * WAVE_FORMAT_EXTENSIBLE; walks the chunks (any order, odd sizes padded), so headers needn't be 44 bytes.
 * Several channels are averaged into one.
 */
export function wavDecode(bytes: Uint8Array): { pcm16: Int16Array; sampleRate: number; channels: number } {
  if (bytes.byteLength < 12 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE') throw new Error('Not a WAV file');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: { format: number; channels: number; rate: number; bits: number; align: number } | null = null;
  let data: { at: number; size: number } | null = null;
  for (let o = 12; o + 8 <= bytes.byteLength;) {
    const id = tag(bytes, o);
    // a streamed file may say 0 or 0xffffffff: whatever is there
    const size = Math.min(v.getUint32(o + 4, true), bytes.byteLength - o - 8);
    const body = o + 8;
    if (id === 'fmt ' && size >= 16) {
      let format = v.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format GUID's first two bytes
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true);
      fmt = { format, channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true), align: v.getUint16(body + 12, true) };
    } else if (id === 'data') {
      data = { at: body, size };
      if (fmt) break;
    }
    o = body + size + (size & 1);
  }
  if (!fmt) throw new Error('WAV file has no format chunk');
  if (!data) throw new Error('WAV file has no audio data');
  const { format, channels, rate, bits } = fmt;
  if (channels < 1) throw new Error('WAV file has no channels');
  const width = bits / 8;
  const float = format === 3;
  if (!(format === 1 || float) || !Number.isInteger(width) || (float ? width !== 4 && width !== 8 : width < 1 || width > 4)) {
    throw new Error(`Unsupported WAV encoding (format ${format}, ${bits} bit)`);
  }
  const frame = Math.max(fmt.align, width * channels);
  const frames = Math.floor(data.size / frame);
  const out = new Int16Array(frames * channels);
  const clamp = (x: number) => (x >= 1 ? 32767 : x <= -1 ? -32768 : Math.round(x * 32768));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const o = data.at + f * frame + c * width;
      let s: number;
      if (float) s = clamp(width === 4 ? v.getFloat32(o, true) : v.getFloat64(o, true));
      else if (width === 1) s = (v.getUint8(o) - 128) << 8;
      else if (width === 2) s = v.getInt16(o, true);
      else if (width === 3) s = ((v.getUint8(o + 2) << 24) | (v.getUint8(o + 1) << 16) | (v.getUint8(o) << 8)) >> 16;
      else s = v.getInt32(o, true) >> 16;
      out[f * channels + c] = s;
    }
  }
  return { pcm16: downmix(out, channels), sampleRate: rate, channels };
}

/** Interleaved samples of `channels` channels, averaged into one. */
export function downmix(interleaved: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return interleaved;
  const n = Math.floor(interleaved.length / channels);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += interleaved[i * channels + c]!;
    out[i] = Math.round(sum / channels);
  }
  return out;
}

/** Low-pass taps (Hamming-windowed sinc) with the cutoff at `fc` cycles per sample, summing to 1. */
function lowPass(fc: number, taps: number): Float64Array {
  const h = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)));
    sum += h[i]!;
  }
  for (let i = 0; i < taps; i++) h[i]! /= sum;
  return h;
}

/**
 * Mono samples from one rate to another by linear interpolation. Going down by more than 1.2× (Supertonic's
 * 44.1 kHz, a 48 kHz recording → 16 kHz) the signal is low-passed first, just under the new Nyquist, so what's above
 * it doesn't fold back in as noise. The same rate returns the input.
 */
export function resample(pcm16: Int16Array, from: number, to: number): Int16Array {
  if (from === to || !pcm16.length) return pcm16;
  if (!(from > 0 && to > 0)) throw new Error(`Bad sample rates (${from} → ${to})`);
  let src: ArrayLike<number> = pcm16;
  const ratio = from / to;
  if (ratio > 1.2) {
    // about 4 output samples' worth of taps either side keeps the transition band narrow enough for speech
    const half = Math.ceil(4 * ratio);
    const h = lowPass(0.45 / ratio, 2 * half + 1);
    const n = pcm16.length;
    const f = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      const lo = Math.max(0, i - half);
      const hi = Math.min(n - 1, i + half);
      for (let j = lo; j <= hi; j++) acc += pcm16[j]! * h[j - i + half]!;
      f[i] = acc;
    }
    src = f;
  }
  const outLen = Math.max(1, Math.round((pcm16.length * to) / from));
  const out = new Int16Array(outLen);
  const last = pcm16.length - 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const k = Math.min(Math.floor(pos), last);
    const t = pos - k;
    const a = src[k]!;
    const b = src[Math.min(k + 1, last)]!;
    const s = Math.round(a + (b - a) * t);
    out[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
  }
  return out;
}

/** -1…1 floats as 16-bit samples (clipped). */
export function floatToInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const x = f[i]!;
    out[i] = x >= 1 ? 32767 : x <= -1 ? -32768 : Math.round(x < 0 ? x * 32768 : x * 32767);
  }
  return out;
}

/** 16-bit samples as -1…1 floats. */
export function int16ToFloat(s: Int16Array): Float32Array {
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i]! / 32768;
  return out;
}

/** How long `samples` samples last at `rate`, in whole milliseconds. */
export function durationMs(samples: number, rate: number): number {
  return rate > 0 ? Math.round((samples * 1000) / rate) : 0;
}
