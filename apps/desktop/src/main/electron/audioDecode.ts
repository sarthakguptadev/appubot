/**
 * Any recording Chromium plays (WebM/Opus from the window's recorder, MP3, M4A, WAV…) → 16 kHz mono PCM, in a hidden
 * window of its own (`CoreDeps.decodeAudio`; Node has no decoders for these). Web Audio decodes into a 16 kHz
 * OfflineAudioContext, which resamples as it decodes; the channels are averaged and the samples come back as base64.
 * One short-lived window per call: sandboxed, no preload, nothing loaded but the page below.
 */
import { BrowserWindow } from 'electron';

/** larger recordings aren't decoded */
export const DECODE_MAX_BYTES = 25 * 1024 * 1024;
const DECODE_TIMEOUT_MS = 30_000;
const RATE = 16_000;

const PAGE = `<!doctype html><meta charset="utf-8"><script>
window.decodeTo16k = async (b64) => {
  let audio;
  try {
    const buf = await (await fetch('data:application/octet-stream;base64,' + b64)).arrayBuffer();
    audio = await new OfflineAudioContext(1, 1, ${RATE}).decodeAudioData(buf);
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
  const n = audio.length, ch = audio.numberOfChannels, out = new Int16Array(n);
  const data = Array.from({ length: ch }, (_, c) => audio.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += data[c][i];
    s /= ch;
    out[i] = s >= 1 ? 32767 : s <= -1 ? -32768 : Math.round(s < 0 ? s * 32768 : s * 32767);
  }
  const bytes = new Uint8Array(out.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { pcm: btoa(bin), sampleRate: audio.sampleRate };
};
</script>`;

export async function decodeAudio(bytes: Uint8Array, _mimeType: string): Promise<{ pcm16: Int16Array; sampleRate: number }> {
  if (!bytes.byteLength) throw new Error('the recording is empty');
  if (bytes.byteLength > DECODE_MAX_BYTES) throw new Error('the recording is too large');
  const win = new BrowserWindow({
    show: false, width: 100, height: 100,
    webPreferences: { javascript: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, images: false, webgl: false, spellcheck: false },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await win.loadURL(`data:text/html;base64,${Buffer.from(PAGE).toString('base64')}`);
    const b64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    const run = win.webContents.executeJavaScript(`window.decodeTo16k(${JSON.stringify(b64)})`) as Promise<{ pcm: string; sampleRate: number } | { error: string }>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('decoding took too long')), DECODE_TIMEOUT_MS); });
    const out = await Promise.race([run, timeout]);
    // Chromium's own words ("Unable to decode audio data") say what went wrong well enough
    if ('error' in out) throw new Error(out.error);
    const raw = Buffer.from(out.pcm, 'base64');
    // a fresh copy: Int16Array needs an even offset, a pooled Buffer's may not be
    const pcm16 = new Int16Array(raw.byteLength >> 1);
    new Uint8Array(pcm16.buffer).set(raw.subarray(0, pcm16.byteLength));
    return { pcm16, sampleRate: out.sampleRate };
  } finally {
    clearTimeout(timer);
    win.destroy();
  }
}
