// The microphone and sound in this window: opening the mic (asking macOS first), recording it as WebM/Opus, its
// samples as the 16 kHz mono PCM `voice.transcribe` hears, live (`capturePcm`) or from a recording, and a loudness
// meter that reports every 80 ms.
import { VOICE_PCM_RATE } from '@appubot/protocol';
import { native } from '../../lib/native';
import { IS_MAC } from '../../lib/platform';
import { LEVEL_INTERVAL_MS, createLoudness, playbackLevel, rmsDb, stepLoudness } from './levels';
import tapUrl from './pcmTap.worklet.ts?worker&url';

export const MIC_DENIED = IS_MAC
  ? 'Allow the microphone in System Settings › Privacy & Security › Microphone, then try again.'
  : 'Allow AppuBot to use the microphone in your system’s privacy settings, then try again.';

let ctx: AudioContext | null = null;
/** One audio context for the window: the meters and the speaker share it. */
export function audioContext(): AudioContext {
  if (!ctx || ctx.state === 'closed') ctx = new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  return ctx;
}

/** the microphone picked (a device id; null: the system's default), for the menu bar call's Input */
let micDevice: string | null = null;
export function setMicDevice(id: string | null): void { micDevice = id && id !== 'default' ? id : null; }
export function micDeviceId(): string | null { return micDevice; }

/** The microphone, with the browser's echo cancellation (so the bot's own voice doesn't count as yours). */
export async function openMic(): Promise<MediaStream> {
  const access = await native().requestMicrophone().catch(() => 'unknown' as const);
  if (access === 'denied') throw new Error(MIC_DENIED);
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(micDevice ? { deviceId: { exact: micDevice } } : {}) },
    });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new Error(MIC_DENIED);
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new Error('No microphone found. Connect one and try again.');
    if (name === 'NotReadableError') throw new Error('The microphone is in use by another app.');
    throw e instanceof Error ? e : new Error('Couldn’t open the microphone.');
  }
}

export function closeStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}

const OPUS = 'audio/webm;codecs=opus';

/** One recording of the mic: chunks every 250 ms, so what was said so far can be heard before it ends. */
export interface Recording {
  readonly startedAt: number;
  readonly mimeType: string;
  /** what was recorded so far (a valid file: it starts with the first chunk's header) */
  snapshot(): Blob;
  /** ends it and hands back the whole recording */
  stop(): Promise<Blob>;
  /** ends it and throws it away */
  discard(): void;
}

export function createRecorder(stream: MediaStream): Recording {
  const opts: MediaRecorderOptions = { audioBitsPerSecond: 32_000 };
  if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(OPUS)) opts.mimeType = OPUS;
  const rec = new MediaRecorder(stream, opts);
  const chunks: Blob[] = [];
  const mimeType = rec.mimeType || opts.mimeType || 'audio/webm';
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.start(250);
  const startedAt = Date.now();
  let stopped: Promise<Blob> | null = null;
  return {
    startedAt, mimeType,
    snapshot: () => new Blob(chunks, { type: mimeType }),
    stop() {
      stopped ??= new Promise<Blob>((resolve) => {
        if (rec.state === 'inactive') { resolve(new Blob(chunks, { type: mimeType })); return; }
        rec.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
        rec.stop();
      });
      return stopped;
    },
    discard() {
      rec.ondataavailable = null;
      if (rec.state !== 'inactive') rec.stop();
      chunks.length = 0;
    },
  };
}

/** A recording as `voice.transcribe` hears it: decoded, mixed down to mono, resampled to 16 kHz, 16-bit. */
export async function recordingToPcm16(blob: Blob): Promise<{ pcm16: Int16Array; durationMs: number }> {
  const decoded = await audioContext().decodeAudioData(await blob.arrayBuffer());
  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const ch = decoded.getChannelData(c);
    for (let i = 0; i < ch.length; i++) mono[i]! += ch[i]! / decoded.numberOfChannels;
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * VOICE_PCM_RATE));
  const off = new OfflineAudioContext(1, frames, VOICE_PCM_RATE);
  const buf = off.createBuffer(1, mono.length || 1, decoded.sampleRate);
  buf.copyToChannel(mono, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const out = (await off.startRendering()).getChannelData(0);
  const pcm16 = new Int16Array(out.length);
  for (let i = 0; i < out.length; i++) {
    const v = Math.max(-1, Math.min(1, out[i]!));
    pcm16[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return { pcm16, durationMs: Math.round(decoded.duration * 1000) };
}

export interface PcmCapture { stop(): void }

/**
 * The microphone as it comes, 16 kHz mono 16-bit, 50 ms at a time: an audio context of its own at that rate
 * (Chromium resamples the mic for it) with an AudioWorklet off the main thread, else a ScriptProcessor. Null where
 * neither runs (voice mode then hears the whole recording when the turn ends).
 */
export async function capturePcm(stream: MediaStream, onPcm: (pcm: Int16Array) => void): Promise<PcmCapture | null> {
  let ac: AudioContext;
  try { ac = new AudioContext({ sampleRate: VOICE_PCM_RATE, latencyHint: 'interactive' }); } catch { return null; }
  try {
    const src = ac.createMediaStreamSource(stream);
    let node: AudioNode;
    try {
      await ac.audioWorklet.addModule(tapUrl);
      const tap = new AudioWorkletNode(ac, 'appubot-pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      tap.port.onmessage = (e: MessageEvent<Int16Array>) => onPcm(e.data);
      node = tap;
    } catch {
      const sp = ac.createScriptProcessor(1024, 1, 1);
      sp.onaudioprocess = (e) => onPcm(floatToPcm16(e.inputBuffer.getChannelData(0)));
      node = sp;
    }
    src.connect(node);
    // the output pulls it along (silent: nothing is written to it)
    node.connect(ac.destination);
    if (ac.state === 'suspended') await ac.resume().catch(() => undefined);
    return {
      stop() {
        src.disconnect();
        node.disconnect();
        void ac.close().catch(() => undefined);
      },
    };
  } catch {
    void ac.close().catch(() => undefined);
    return null;
  }
}

function floatToPcm16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i]!));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/** Base64 of the samples' bytes (little-endian, as every Mac and PC stores them). */
export function toBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

export interface Meter { stop(): void }

/**
 * How loud the mic is: an AnalyserNode (fftSize 512) read every 80 ms, RMS in dB over an adaptive noise floor
 * (`stepLoudness`), reported as 0..1, with the raw dBFS (how loud it is in itself, not against the room).
 */
export function createMeter(stream: MediaStream, onLevel: (level: number, now: number, db: number) => void): Meter {
  const ac = audioContext();
  const src = ac.createMediaStreamSource(stream);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const state = createLoudness();
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    const db = rmsDb(buf);
    onLevel(stepLoudness(state, db), Date.now(), db);
  }, LEVEL_INTERVAL_MS);
  return {
    stop() {
      clearInterval(timer);
      src.disconnect();
      analyser.disconnect();
    },
  };
}

/** The level of what an analyser plays now (the bot's voice), 0..1. */
export function analyserLevel(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  return playbackLevel(rmsDb(buf));
}
