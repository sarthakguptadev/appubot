import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VOICE_MODELS, VOICE_WARM_MS, type EventPayload, type Message, type VoiceModelId } from '@appubot/protocol';
import { createCore, type Core } from '../app';
import type { CoreDeps } from '../context';
import { FakeRuntime } from '../testing/fakeRuntime';
import { RpcError, silentLogger } from '../util';
import { decodeOggOpus, encodeOggOpus } from '../audio/opus';
import { pcmToWav, wavDecode } from '../audio/pcm';
import { VOICE_MODEL_SPECS, markerOf } from './voiceModels';
import { joinReadings, type VoiceEngine } from './voice';
import { TTS_LIVE_STEPS } from './voiceHostCore';

/** a model's files as they'd be after a download: sparse files of the right sizes and the marker */
function placeModel(dataDir: string, id: VoiceModelId): void {
  const spec = VOICE_MODEL_SPECS[id];
  const dir = join(dataDir, 'voice-models', spec.dir);
  mkdirSync(dir, { recursive: true });
  // sparse: the right sizes without the bytes
  for (const f of spec.files) { writeFileSync(join(dir, f.name), ''); truncateSync(join(dir, f.name), f.bytes); }
  writeFileSync(join(dir, '.ok'), markerOf(spec));
}

const sine = (sec: number, rate: number, hz = 440) => Int16Array.from({ length: Math.round(sec * rate) }, (_, i) => Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000));

class FakeEngine implements VoiceEngine {
  heard: { pcm16: Int16Array; model: string; language: string }[] = [];
  said: { text: string; language: string; model: string; voice: string; steps?: number }[] = [];
  warmed: string[] = [];
  held: number[] = [];
  async transcribe(o: { pcm16: Int16Array; model: string; modelDir: string; language: string }) { this.heard.push(o); return '  hello\n  world '; }
  async speak(o: { text: string; language: string; model: string; voice: string; modelDir: string; steps?: number }) { this.said.push(o); return { pcm16: sine(0.3, 44_100), sampleRate: 44_100 }; }
  async warm(o: { kind: 'stt' | 'tts'; modelDir: string }) { this.warmed.push(`${o.kind}:${o.modelDir.split(/[\\/]/).pop()}`); }
  hold(ms: number) { this.held.push(ms); }
  async shutdown() {}
}

let root: string;
let core: Core;
let engine: FakeEngine;
const events: { event: string; payload: unknown }[] = [];

async function boot(o: { models?: VoiceModelId[]; deps?: Partial<CoreDeps> } = {}) {
  const dataDir = join(root, 'data');
  for (const id of o.models ?? []) placeModel(dataDir, id);
  engine = new FakeEngine();
  core = createCore({
    paths: { dataDir, botsRoot: join(root, 'bots'), filesDir: join(dataDir, 'files'), logsDir: join(root, 'logs'), bridgePath: '/nonexistent/bridge.mjs' },
    runtime: (hooks) => new FakeRuntime(hooks),
    openExternal: () => undefined,
    openTerminal: () => undefined,
    nativeNotify: () => undefined,
    version: '0.0.0-test',
    hostName: 'test-mac',
    log: silentLogger,
    validate: true,
    port: 0,
    quiet: true,
    computerBackends: () => [],
    helperTransport: () => null,
    voiceRuntime: { addonPath: __filename },
    voiceEngine: engine,
    ...o.deps,
  });
  core.ctx.bus.on((e) => events.push({ event: e.event, payload: e.payload }));
  await core.start();
  return core.services.voice;
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'appubot-voice-')); events.length = 0; });
afterEach(async () => { await core?.stop(); rmSync(root, { recursive: true, force: true }); });

describe('VoiceService', () => {
  it('says why it is unavailable without a runtime, and that models are missing', async () => {
    const voice = await boot({ deps: { voiceRuntime: { error: 'Voice needs a 64-bit Mac, Windows or Linux computer.' } } });
    const st = voice.status();
    expect(st.supported).toBe(false);
    expect(st.reason).toMatch(/64-bit/);
    expect(st.models.map((m) => m.phase)).toEqual(VOICE_MODELS.map(() => 'missing'));
    expect(voice.ready('stt')).toBe(false);
    expect(() => voice.download('supertonic-3')).toThrow(RpcError);
    expect(voice.prepare().supported).toBe(false);
  });

  it('only reads aloud where the computer hears nothing (an AppuBot computer)', async () => {
    const why = 'This computer reads replies aloud, and your phone hears you.';
    const voice = await boot({ models: ['supertonic-3', 'parakeet-unified-en'], deps: { voiceRuntime: { addonPath: __filename, speakOnly: why } } });
    const st = voice.status();
    // apps from before see voice unavailable here, as they did; newer ones read `speaks`
    expect(st).toMatchObject({ supported: false, speaks: true, reason: why });
    expect(st.models.map((m) => m.kind)).toEqual(VOICE_MODELS.filter((m) => m.kind === 'tts').map(() => 'tts'));
    expect(voice.ready('tts')).toBe(true);
    // a speech model on disk changes nothing: nothing here hears
    expect(voice.ready('stt')).toBe(false);
    expect(voice.hears()).toBe(false);
    await expect(voice.transcribe({ audio: new Uint8Array(320), format: 'pcm16' })).rejects.toMatchObject({ code: 'unsupported', message: why });
    expect(() => voice.download('parakeet-unified-en')).toThrow(RpcError);
    expect((await voice.speak({ text: 'Hello there.', format: 'wav' })).mimeType).toBe('audio/wav');
    expect(await voice.warm()).toEqual({ stt: false, tts: true });
    expect(engine.warmed).toEqual([expect.stringMatching(/^tts:/)]);
    expect(engine.heard).toEqual([]);
  });

  it('fetches its own voice where it only reads aloud (nobody there has Settings › Voice)', async () => {
    const asked: string[] = [];
    const offline = (async (url: unknown) => { asked.push(String(url)); throw new Error('offline'); }) as unknown as typeof fetch;
    const voice = await boot({ deps: { voiceRuntime: { addonPath: __filename, speakOnly: 'Reads aloud only.' }, fetch: offline } });
    // at start, and only the voice: no speech model
    for (let i = 0; i < 50 && !asked.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((u) => /supertonic/i.test(u))).toBe(true);
    // asked to read before it is there: it says so (and asks for the voice again), never "download it in Settings"
    await expect(voice.speak({ text: 'Hi' })).rejects.toMatchObject({ code: 'voice_not_ready', message: expect.stringMatching(/still being set up/) });
  });

  it('downloads the models the settings pick in the background, once each, and never one removed by hand', async () => {
    const asked: string[] = [];
    const offline = (async (url: unknown) => { asked.push(String(url)); throw new Error('offline'); }) as unknown as typeof fetch;
    const voice = await boot({ models: ['supertonic-3'], deps: { fetch: offline } });
    // not at launch: after the delay (here called at once)
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toEqual([]);
    voice.prefetch();
    for (let i = 0; i < 50 && !asked.length; i++) await new Promise((r) => setTimeout(r, 10));
    // only the speech model: the voice is already here
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.some((u) => /supertonic/i.test(u))).toBe(false);
    const noted = JSON.parse(readFileSync(join(root, 'data', 'voice-prefetched.json'), 'utf8')) as { ids: string[] };
    expect(noted.ids).toEqual(['supertonic-3']);
    // removed by hand: the next look leaves it alone
    await voice.remove('supertonic-3');
    asked.length = 0;
    voice.prefetch();
    await new Promise((r) => setTimeout(r, 50));
    expect(asked.some((u) => /supertonic/i.test(u))).toBe(false);
  });

  it('is not ready without models', async () => {
    const voice = await boot();
    expect(voice.status().supported).toBe(true);
    expect(voice.ready('stt')).toBe(false);
    await expect(voice.transcribe({ audio: new Uint8Array(320), format: 'pcm16' })).rejects.toMatchObject({ code: 'voice_not_ready' });
    await expect(voice.speak({ text: 'Hi' })).rejects.toMatchObject({ code: 'voice_not_ready' });
  });

  it('transcribes 16 kHz PCM, WAV and OGG/Opus', async () => {
    const voice = await boot({ models: ['parakeet-tdt-0.6b-v3', 'supertonic-3'] });
    expect(voice.ready('stt')).toBe(true);
    expect(voice.ready('tts')).toBe(true);
    const pcm = sine(1.5, 16_000);
    const bytes = new Uint8Array(pcm.buffer);
    const r = await voice.transcribe({ audio: bytes, format: 'pcm16' });
    expect(r).toEqual({ text: 'hello world', durationMs: 1500 });
    expect(engine.heard[0]).toMatchObject({ model: 'parakeet-tdt-0.6b-v3', language: '' });
    expect(engine.heard[0]!.pcm16.length).toBe(24_000);

    // an odd offset (a pooled Buffer) still reads
    const odd = new Uint8Array(bytes.byteLength + 1);
    odd.set(bytes, 1);
    expect((await voice.transcribe({ audio: odd.subarray(1), format: 'pcm16', language: 'hi-IN' })).durationMs).toBe(1500);
    // Parakeet takes no language: it finds it
    expect(engine.heard[1]!.language).toBe('');

    const wav = pcmToWav(new Uint8Array(sine(1, 48_000).buffer), 48_000);
    expect((await voice.transcribe({ audio: wav, format: 'encoded', mimeType: 'audio/wav' })).durationMs).toBe(1000);
    expect(engine.heard[2]!.pcm16.length).toBe(16_000);

    const ogg = encodeOggOpus(sine(2, 48_000), 48_000);
    const o = await voice.transcribe({ audio: ogg, format: 'ogg' });
    expect(o.text).toBe('hello world');
    expect(Math.abs(o.durationMs - 2000)).toBeLessThan(30);
    expect(Math.abs(engine.heard[3]!.pcm16.length - 32_000)).toBeLessThan(500);

    // anything else needs the desktop's decoder
    await expect(voice.transcribe({ audio: new Uint8Array([1, 2, 3, 4]), format: 'encoded', mimeType: 'audio/webm' })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(voice.transcribe({ audio: new Uint8Array(3), format: 'pcm16' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(voice.transcribe({ audio: new Uint8Array(181 * 16_000 * 2), format: 'pcm16' })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('converts a stored OGG/Opus recording to a WAV file once, and answers a WAV as it is', async () => {
    const voice = await boot({ models: [] });
    const ogg = core.services.files.upload(encodeOggOpus(sine(2, 48_000), 48_000), 'note.ogg', 'audio/ogg');
    const wav = await voice.convert(ogg.id);
    expect(wav).toMatchObject({ name: 'note.wav', mimeType: 'audio/wav' });
    expect(wav.id).not.toBe(ogg.id);
    const decoded = wavDecode(new Uint8Array(readFileSync(core.services.files.getRecord(wav.id)!.storedPath)));
    expect(decoded.sampleRate).toBe(48_000);
    expect(Math.abs(decoded.pcm16.length - 96_000)).toBeLessThan(5000);
    // the same copy next time; a WAV needs no copy; a missing file is said
    expect((await voice.convert(ogg.id)).id).toBe(wav.id);
    expect((await voice.convert(wav.id)).id).toBe(wav.id);
    await expect(voice.convert('file_nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('decodes other recordings with deps.decodeAudio', async () => {
    const voice = await boot({ models: ['whisper-turbo'], deps: { decodeAudio: async () => ({ pcm16: sine(0.5, 48_000), sampleRate: 48_000 }) } });
    // Parakeet (the setting) isn't here, Whisper is: it hears
    const r = await voice.transcribe({ audio: new Uint8Array(10), format: 'encoded', mimeType: 'audio/webm' });
    expect(r.durationMs).toBe(500);
    expect(engine.heard[0]!.model).toBe('whisper-turbo');
    // Whisper takes the language asked, 'en-US' as 'en'
    await voice.transcribe({ audio: new Uint8Array(10), format: 'encoded', mimeType: 'audio/webm', language: 'hi-IN' });
    expect(engine.heard[1]!.language).toBe('hi');
  });

  it('speaks a reply as OGG/Opus in the voice and language asked', async () => {
    const voice = await boot({ models: ['supertonic-3'] });
    const r = await voice.speak({ text: '**Hello** there. See [the docs](https://x.test).\n\n```js\nconsole.log(1)\n```', voice: 'M3' });
    expect(r.language).toBe('en');
    expect(engine.said.map((s) => s.text).join(' ')).not.toMatch(/console|https|\*/);
    expect(engine.said[0]).toMatchObject({ voice: 'M3', language: 'en' });
    expect(r.mimeType).toBe('audio/ogg');
    const back = decodeOggOpus(r.audio);
    expect(Math.abs((back.pcm16.length / 48) - r.durationMs)).toBeLessThan(25);
    expect(r.durationMs).toBeGreaterThan(250);
    expect(engine.said[0]!.steps).toBeUndefined();
    await expect(voice.speak({ text: '```\ncode only\n```' })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('reads with the voice model Settings picks, in one of its voices, English where it reads only English', async () => {
    const voice = await boot({ models: ['parakeet-tdt-0.6b-v3', 'supertonic-3', 'kokoro-en'] });
    core.services.settings.update({ voice: { ...core.services.settings.get().voice, ttsModel: 'kokoro-en', voice: 'bm_george' } });
    await voice.speak({ text: 'Guten Tag, wie geht es Ihnen heute?' });
    expect(engine.said[0]).toMatchObject({ model: 'kokoro-en', voice: 'bm_george', language: 'en' });
    // a Supertonic voice asked of Kokoro reads in its first
    await voice.speak({ text: 'Hello there.', voice: 'M3' });
    expect(engine.said.at(-1)).toMatchObject({ model: 'kokoro-en', voice: 'af_heart' });
    expect((await voice.warm()).tts).toBe(true);
    expect(engine.warmed).toContain('tts:kokoro-1.0-en-int8');
  });

  it('reads with another voice model already here while the one picked is missing', async () => {
    const voice = await boot({ models: ['parakeet-tdt-0.6b-v3', 'supertonic-3'] });
    core.services.settings.update({ voice: { ...core.services.settings.get().voice, ttsModel: 'kokoro-en', voice: 'af_bella' } });
    expect(voice.ready('tts')).toBe(true);
    await voice.speak({ text: 'Hello there.' });
    expect(engine.said[0]).toMatchObject({ model: 'supertonic-3', voice: 'F1' });
  });

  it('reads for a live conversation as a WAV, with fewer passes', async () => {
    const voice = await boot({ models: ['supertonic-3'] });
    const r = await voice.speak({ text: 'Hello there.', format: 'wav', live: true });
    expect(r.mimeType).toBe('audio/wav');
    const wav = wavDecode(r.audio);
    expect(wav.sampleRate).toBe(44_100);
    expect(Math.abs(wav.pcm16.length / 44.1 - r.durationMs)).toBeLessThan(2);
    expect(engine.said[0]!.steps).toBe(TTS_LIVE_STEPS);
  });

  it('reads a sentence whole, however long, and never cuts one for a sooner start', async () => {
    const voice = await boot({ models: ['supertonic-3'] });
    engine.said.length = 0;
    const plain = 'The capital of France is Paris and it is also the largest city in the whole world.';
    const list = "You're speaking out loud, and something on your end turns your speech into text that gets handed to me, then turns my written reply back into audio you hear.";
    await voice.speak({ text: plain, format: 'wav', live: true });
    await voice.speak({ text: `${plain} ${list}`, format: 'wav', live: true });
    expect(engine.said.map((s) => s.text)).toEqual([plain, `${plain} ${list}`]);
  });

  it('warms nothing while the models are missing', async () => {
    const voice = await boot();
    expect(await voice.warm()).toEqual({ stt: false, tts: false });
    expect(engine.held).toEqual([]);
  });

  it('warms the models on disk and holds them for a while', async () => {
    const voice = await boot({ models: ['parakeet-tdt-0.6b-v3', 'supertonic-3'] });
    expect(await voice.warm()).toEqual({ stt: true, tts: true });
    expect(engine.held).toEqual([VOICE_WARM_MS]);
    expect(engine.warmed.sort()).toEqual(['stt:parakeet-tdt-0.6b-v3-int8', 'tts:supertonic-3-int8']);
  });

  it('warms one half alone for a client that does the other itself', async () => {
    const voice = await boot({ models: ['parakeet-tdt-0.6b-v3', 'supertonic-3'] });
    // a phone that hears on its own: the voice is loaded, the 2 GB speech model left alone
    expect(await voice.warm('voice')).toEqual({ stt: false, tts: true });
    expect(engine.warmed).toEqual(['tts:supertonic-3-int8']);
    // this Mac hearing for another computer's chat, which reads there
    engine.warmed = [];
    expect(await voice.warm('speech')).toEqual({ stt: true, tts: false });
    expect(engine.warmed).toEqual(['stt:parakeet-tdt-0.6b-v3-int8']);
  });

  it('keeps a message’s reading as a voice part', async () => {
    const voice = await boot({ models: ['supertonic-3'] });
    const bot = core.services.bots.list()[0]!;
    const thread = core.services.threads.create({ botId: bot.id });
    const now = Date.now();
    const msg: Message = { id: 'msg_test1', threadId: thread.id, role: 'agent', parts: [{ type: 'text', text: 'Hello there.' }], status: 'complete', via: 'desktop', createdAt: now, updatedAt: now };
    core.services.threads.addMessage(msg);
    const r = await voice.speakForMessage(thread.id, msg.id, { text: 'Hello there.' });
    expect(r.file.mimeType).toBe('audio/ogg');
    const part = events.find((e) => e.event === 'message.part')?.payload as EventPayload<'message.part'>;
    expect(part).toMatchObject({ threadId: thread.id, messageId: msg.id, partIndex: 1, part: { type: 'voice', kind: 'reply', transcript: 'Hello there.', file: { id: r.file.id } } });
    const rec = core.services.files.getRecord(r.file.id)!;
    expect(rec.threadId).toBeUndefined();
    expect(readFileSync(rec.storedPath).byteLength).toBe(r.audio.byteLength);
    // busy went up and down
    const busy = events.filter((e) => e.event === 'voice.status').map((e) => (e.payload as EventPayload<'voice.status'>).busy.tts);
    expect(busy).toContain(true);
    expect(busy.at(-1)).toBe(false);
    await expect(voice.speakForMessage(thread.id, 'msg_nope', { text: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('sends voice.status while a model downloads, and on cancel', async () => {
    let release: () => void = () => undefined;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (!sent) { sent = true; c.enqueue(new Uint8Array(100_000)); return; }
          await new Promise<void>((resolve, reject) => { release = resolve; init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
        },
      });
      return new Response(body);
    }) as unknown as typeof fetch;
    const voice = await boot({ deps: { fetch: fakeFetch } });
    const st = voice.prepare();
    // a new install's: the first of each list
    expect(st.models.filter((m) => m.phase === 'downloading').map((m) => m.id)).toEqual(['parakeet-unified-en', 'supertonic-3']);
    const statuses = () => events.filter((e) => e.event === 'voice.status').map((e) => e.payload as EventPayload<'voice.status'>);
    for (let i = 0; i < 100 && !statuses().some((s) => (s.models.find((m) => m.id === 'supertonic-3')?.progress ?? 0) > 0); i++) await new Promise((r) => setTimeout(r, 20));
    expect(statuses().some((s) => (s.models.find((m) => m.id === 'supertonic-3')?.progress ?? 0) > 0)).toBe(true);
    await expect(voice.remove('supertonic-3')).rejects.toMatchObject({ code: 'busy' });
    expect(voice.cancel('supertonic-3').models.find((m) => m.id === 'supertonic-3')!.phase).toBe('missing');
    voice.cancel('parakeet-unified-en');
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(statuses().at(-1)!.models.map((m) => m.phase)).toEqual(VOICE_MODELS.map(() => 'missing'));
    expect((await voice.remove('supertonic-3')).models.find((m) => m.id === 'supertonic-3')!.phase).toBe('missing');
  });

  it('a failed download shows as an error', async () => {
    const voice = await boot({ deps: { fetch: (async () => new Response('no', { status: 503 })) as unknown as typeof fetch } });
    voice.download('supertonic-3');
    for (let i = 0; i < 50 && voice.status().models.find((m) => m.id === 'supertonic-3')!.phase !== 'error'; i++) await new Promise((r) => setTimeout(r, 10));
    const m = voice.status().models.find((x) => x.id === 'supertonic-3')!;
    expect(m.phase).toBe('error');
    expect(m.message).toMatch(/503/);
  });
});

describe('joinReadings', () => {
  it('trims each part’s padding to a short pause', () => {
    const rate = 1000;
    const part = () => { const p = new Int16Array(1000); p.fill(5000, 400, 600); return p; };
    const out = joinReadings([part(), part()], rate);
    // 100 lead + 200 + 125 | 125 + 200 + 200 tail
    expect(out.length).toBe(950);
    expect(joinReadings([new Int16Array(500)], rate).length).toBe(0);
  });
});
