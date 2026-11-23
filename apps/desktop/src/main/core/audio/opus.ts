/**
 * OGG/Opus in and out through `opusscript` (libopus 1.4 as WebAssembly: nothing native to ship per OS). Opus always
 * runs at 48 kHz here: input is resampled to it, output comes out at it. Pure Node, no Electron.
 *
 * `opusscript` is CommonJS (`module.exports = OpusScript`): the default import works under esModuleInterop, in
 * vitest and in electron-vite's main bundle (deps stay external, so it's a plain `require` at run time).
 */
import OpusScript from 'opusscript';
import { demuxOggOpus, muxOggOpus } from './ogg';
import { downmix, resample } from './pcm';

const RATE = 48_000;
/** 20 ms at 48 kHz */
const FRAME = 960;
/** libopus's look-ahead at 48 kHz (2.5 ms + 4 ms): what the decoder drops at the start */
const PRE_SKIP = 312;
const OPUS_SET_BITRATE = 4002;

/** int16 samples as the little-endian bytes opusscript reads (no copy) */
const bytesOf = (s: Int16Array, from: number, count: number): Buffer => Buffer.from(s.buffer, s.byteOffset + from * 2, count * 2);

/**
 * Mono 16-bit PCM at any rate as an OGG/Opus file (a voice note Telegram shows as one, and every client plays):
 * resampled to 48 kHz, 20 ms frames, the last padded with silence (and trimmed back by the final granule).
 */
export function encodeOggOpus(pcm16: Int16Array, sampleRate: number, o: { bitrate?: number; application?: 'voip' | 'audio' } = {}): Uint8Array {
  const pcm = resample(pcm16, sampleRate, RATE);
  // enough frames that the look-ahead's worth after the end comes out too
  const frames = Math.max(1, Math.ceil((pcm.length + PRE_SKIP) / FRAME));
  const padded = new Int16Array(frames * FRAME);
  padded.set(pcm);
  const app = o.application === 'audio' ? OpusScript.Application.AUDIO : OpusScript.Application.VOIP;
  const enc = new OpusScript(RATE, 1, app, { wasm: true });
  try {
    enc.encoderCTL(OPUS_SET_BITRATE, o.bitrate ?? 32_000);
    const packets: Uint8Array[] = [];
    for (let f = 0; f < frames; f++) packets.push(new Uint8Array(enc.encode(bytesOf(padded, f * FRAME, FRAME), FRAME)));
    return muxOggOpus(packets, { channels: 1, preSkip: PRE_SKIP, inputSampleRate: sampleRate, frameSamples: FRAME, samples: pcm.length });
  } finally {
    enc.delete();
  }
}

/** An OGG/Opus file (a Telegram voice note) as mono 16-bit PCM at 48 kHz, pre-skip dropped and trimmed to its real end. */
export function decodeOggOpus(bytes: Uint8Array): { pcm16: Int16Array; sampleRate: 48000 } {
  const s = demuxOggOpus(bytes);
  if (s.channels < 1 || s.channels > 2) throw new Error(`Unsupported Opus stream (${s.channels} channels)`);
  const dec = new OpusScript(RATE, s.channels, OpusScript.Application.AUDIO, { wasm: true });
  const chunks: Int16Array[] = [];
  let total = 0;
  try {
    for (const p of s.packets) {
      // an empty packet means a lost one: nothing to decode
      if (!p.length) continue;
      const out = dec.decode(Buffer.from(p.buffer, p.byteOffset, p.byteLength));
      const samples = new Int16Array(out.length >> 1);
      for (let i = 0; i < samples.length; i++) samples[i] = out.readInt16LE(i * 2);
      chunks.push(samples);
      total += samples.length;
    }
  } finally {
    dec.delete();
  }
  const all = new Int16Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  const mono = downmix(all, s.channels);
  const start = Math.min(s.preSkip, mono.length);
  const end = s.granuleEnd > s.preSkip ? Math.min(mono.length, s.granuleEnd) : mono.length;
  return { pcm16: mono.slice(start, Math.max(start, end)), sampleRate: 48_000 };
}

/** How long an OGG/Opus file plays, from its last granule position (no decoding). */
export function oggOpusDurationMs(bytes: Uint8Array): number {
  const s = demuxOggOpus(bytes);
  return Math.max(0, Math.round((s.granuleEnd - s.preSkip) / 48));
}
