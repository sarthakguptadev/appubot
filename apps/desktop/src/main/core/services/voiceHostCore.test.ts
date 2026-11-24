import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LONG_PART_SEC, STREAMING_TAIL_SEC, STT_RATE, TTS_LIVE_STEPS, VoiceHostCore, WHISPER_MAX_SEC, WHISPER_PART_SEC, cleanText, quietCuts, unshout, whisperPad, type HostRequest, type SherpaAddon } from './voiceHostCore';

/** a fake addon: counts calls, hears each part's length, speaks a ramp */
function fakeAddon(o: { failCreate?: boolean; failDecode?: boolean } = {}) {
  const calls: string[] = [];
  const heard: number[] = [];
  const configs: unknown[] = [];
  const addon: SherpaAddon = {
    async createOfflineRecognizerAsync(c) { calls.push('createRec'); configs.push(c); if (o.failCreate) throw new Error('no such file'); return { rec: true }; },
    offlineRecognizerSetConfig(_r, c) { calls.push('setConfig'); configs.push(c); },
    createOfflineStream() { return { samples: 0 }; },
    acceptWaveformOffline(stream, w) { (stream as { samples: number }).samples = w.samples.length; },
    async decodeOfflineStreamAsync() { if (o.failDecode) throw new Error('boom'); },
    getOfflineStreamResultAsJson(stream) {
      const n = (stream as { samples: number }).samples;
      heard.push(n);
      return JSON.stringify({ text: ` part${heard.length} `, lang: '<|en|>' });
    },
    async createOfflineTtsAsync(c) { calls.push('createTts'); configs.push(c); return { tts: true }; },
    async offlineTtsGenerateAsyncWithConfig(_t, g) {
      calls.push(`gen:${JSON.stringify((g as { generationConfig: unknown }).generationConfig)}`);
      return { samples: Float32Array.from([0, 0.5, -0.5, 1, -1]), sampleRate: 44_100 };
    },
    getOfflineTtsSampleRate() { return 44_100; },
    createOnlineRecognizer(c) { calls.push('createOnline'); configs.push(c); return { online: true }; },
    createOnlineStream() { return { samples: 0, chunks: 0, finished: false, options: {} as Record<string, string> }; },
    acceptWaveformOnline(stream, w) { (stream as { samples: number }).samples += w.samples.length; },
    onlineStreamSetOption(stream, k, v) { (stream as { options: Record<string, string> }).options[k] = v; },
    inputFinished(stream) { (stream as { finished: boolean }).finished = true; },
    isOnlineStreamReady(_r, stream) { const st = stream as { samples: number; chunks: number; finished: boolean }; return st.finished && st.chunks < 3; },
    decodeOnlineStream(_r, stream) { (stream as { chunks: number }).chunks++; },
    getOnlineStreamResultAsJson(_r, stream) {
      const st = stream as { samples: number; chunks: number; options: Record<string, string> };
      heard.push(st.samples);
      return JSON.stringify({ text: `Hallo zusammen. <de-DE> (${st.options.language}, ${st.chunks} chunks)` });
    },
  };
  return { addon, calls, heard, configs };
}

const base = { addonPath: '/x/sherpa-onnx.node', modelDir: '/m/whisper' };

describe('quietCuts', () => {
  it('cuts 70 s at the quiet points of each part’s last 4 s', () => {
    const n = 70 * STT_RATE;
    const s = new Int16Array(n);
    // loud everywhere, with a short silence at 26 s and at 51 s
    for (let i = 0; i < n; i++) s[i] = i % 2 ? 8000 : -8000;
    const hush = (sec: number) => { for (let i = sec * STT_RATE; i < sec * STT_RATE + 800; i++) s[i] = 0; };
    hush(26);
    hush(51);
    const cuts = quietCuts(s, STT_RATE, 28, 4);
    expect(cuts.length).toBe(2);
    expect(Math.abs(cuts[0]! - 26 * STT_RATE)).toBeLessThan(800);
    expect(Math.abs(cuts[1]! - 51 * STT_RATE)).toBeLessThan(800);
    // never longer than 28 s
    let start = 0;
    for (const c of [...cuts, n]) { expect(c - start).toBeLessThanOrEqual(28 * STT_RATE); start = c; }
  });

  it('leaves short audio whole', () => {
    expect(quietCuts(new Int16Array(WHISPER_PART_SEC * STT_RATE), STT_RATE)).toEqual([]);
  });
});

describe('whisperPad', () => {
  it('gives each part twice its length in silence, at least half a second, within one pass', () => {
    expect(whisperPad(STT_RATE)).toBe(2 * STT_RATE);
    expect(whisperPad(STT_RATE / 10)).toBe(STT_RATE / 2);
    const n = WHISPER_PART_SEC * STT_RATE;
    expect(n + whisperPad(n)).toBeLessThanOrEqual(WHISPER_MAX_SEC * STT_RATE);
    expect(whisperPad(30 * STT_RATE)).toBe(0);
  });
});

describe('VoiceHostCore', () => {
  it('splits long Whisper input, pads each part and joins the words', async () => {
    const f = fakeAddon();
    const core = new VoiceHostCore({ loadAddon: () => f.addon, numThreads: 2 });
    const pcm16 = new Int16Array(70 * STT_RATE);
    // silent with blips every second
    for (let i = 0; i < pcm16.length; i += STT_RATE) pcm16.fill(12000, i, i + 160);
    const r = await core.handle({ id: 1, type: 'transcribe', engine: 'whisper', language: '', pcm16, ...base });
    const parts = quietCuts(pcm16, STT_RATE).length + 1;
    expect(parts).toBeGreaterThanOrEqual(8);
    expect(r).toEqual({ id: 1, text: Array.from({ length: parts }, (_, i) => `part${i + 1}`).join(' ') });
    expect(f.heard.length).toBe(parts);
    // each part is followed by twice its length in silence (the decoder's token budget grows with the audio)
    expect(f.heard.reduce((a, b) => a + b, 0)).toBe(3 * pcm16.length);
    for (const h of f.heard) expect(h).toBeLessThanOrEqual(WHISPER_MAX_SEC * STT_RATE);
    expect(f.calls).toEqual(['createRec']);
  });

  it('keeps one model: a language change reconfigures, another model replaces it', async () => {
    const f = fakeAddon();
    const core = new VoiceHostCore({ loadAddon: () => f.addon });
    const pcm16 = new Int16Array(STT_RATE);
    await core.handle({ id: 1, type: 'transcribe', engine: 'whisper', language: '', pcm16, ...base });
    await core.handle({ id: 2, type: 'transcribe', engine: 'whisper', language: '', pcm16, ...base });
    await core.handle({ id: 3, type: 'transcribe', engine: 'whisper', language: 'hi', pcm16, ...base });
    expect(f.calls).toEqual(['createRec', 'setConfig']);
    expect((f.configs[1] as { modelConfig: { whisper: { language: string } } }).modelConfig.whisper.language).toBe('hi');
    const p = await core.handle({ id: 4, type: 'transcribe', engine: 'nemo-transducer', language: 'hi', pcm16, addonPath: base.addonPath, modelDir: '/m/parakeet' });
    expect(p).toEqual({ id: 4, text: 'part4' });
    // Parakeet hears the audio as is, no padding
    expect(f.heard.at(-1)).toBe(STT_RATE);
    const cfg = f.configs[2] as { modelConfig: { modelType: string; transducer: { joiner: string } } };
    expect(cfg.modelConfig.modelType).toBe('nemo_transducer');
    expect(cfg.modelConfig.transducer.joiner).toMatch(/joiner\.int8\.onnx$/);
    const w = await core.handle({ id: 5, type: 'warm', kind: 'tts', addonPath: base.addonPath, modelDir: '/m/tts' });
    expect(w).toEqual({ id: 5, ok: true });
    expect(f.calls).toEqual(['createRec', 'setConfig', 'createRec', 'createTts']);
  });

  it('runs IndicConformer as a NeMo CTC model, hearing the audio as is', async () => {
    const f = fakeAddon();
    const core = new VoiceHostCore({ loadAddon: () => f.addon, numThreads: 2 });
    const pcm16 = new Int16Array(40 * STT_RATE);
    const r = await core.handle({ id: 1, type: 'transcribe', engine: 'nemo-ctc', language: 'hi', pcm16, addonPath: base.addonPath, modelDir: '/m/indic' });
    expect(r).toEqual({ id: 1, text: 'part1' });
    expect(f.heard).toEqual([pcm16.length]);
    expect(f.configs[0]).toEqual({
      featConfig: { sampleRate: STT_RATE, featureDim: 80 },
      modelConfig: { nemoCtc: { model: join('/m', 'indic', 'model.int8.onnx') }, tokens: join('/m', 'indic', 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 },
    });
    // no language to set: another one changes nothing
    await core.handle({ id: 2, type: 'warm', kind: 'stt', engine: 'nemo-ctc', language: 'en', addonPath: base.addonPath, modelDir: '/m/indic' });
    expect(f.calls).toEqual(['createRec']);
  });

  it('speaks with the voice and language asked, as 16-bit samples', async () => {
    const f = fakeAddon();
    const core = new VoiceHostCore({ loadAddon: () => f.addon });
    const r = await core.handle({ id: 7, type: 'speak', text: 'Hello', language: 'en', speakerId: 6, addonPath: base.addonPath, modelDir: '/m/tts' });
    expect(r).toEqual({ id: 7, pcm16: Int16Array.from([0, 16384, -16384, 32767, -32768]), sampleRate: 44_100 });
    expect(f.calls.at(-1)).toBe('gen:{"sid":6,"speed":1,"numSteps":8,"extra":{"lang":"en"}}');
    // a live conversation's reading takes fewer passes
    await core.handle({ id: 8, type: 'speak', text: 'Hi', language: 'en', speakerId: 0, numSteps: TTS_LIVE_STEPS, addonPath: base.addonPath, modelDir: '/m/tts' });
    expect(f.calls.at(-1)).toBe('gen:{"sid":0,"speed":1,"numSteps":5,"extra":{"lang":"en"}}');
  });

  it('answers failures with their kind and runs requests one at a time', async () => {
    const noRuntime = new VoiceHostCore({ loadAddon: () => { throw new Error('dlopen failed'); } });
    const pcm16 = new Int16Array(100);
    const req: HostRequest = { id: 1, type: 'transcribe', engine: 'whisper', language: '', pcm16, ...base };
    expect(await noRuntime.handle(req)).toEqual({ id: 1, error: 'runtime-unavailable', detail: 'dlopen failed' });
    expect(await new VoiceHostCore({ loadAddon: () => fakeAddon({ failCreate: true }).addon }).handle(req)).toMatchObject({ error: 'model-load-failed', detail: 'no such file' });
    const failing = new VoiceHostCore({ loadAddon: () => fakeAddon({ failDecode: true }).addon });
    expect(await failing.handle(req)).toMatchObject({ id: 1, error: 'inference-failed', detail: 'boom' });

    const f = fakeAddon();
    const order: number[] = [];
    const core = new VoiceHostCore({ loadAddon: () => f.addon });
    await Promise.all([1, 2, 3].map((id) => core.handle({ ...req, id }).then((r) => order.push(r.id))));
    expect(order).toEqual([1, 2, 3]);
  });

  it('runs Cohere, Qwen3-ASR and SenseVoice with their own configs, long audio in pieces', async () => {
    const f = fakeAddon();
    const core = new VoiceHostCore({ loadAddon: () => f.addon, numThreads: 2 });
    const pcm16 = new Int16Array(60 * STT_RATE).fill(9000);
    const at = { addonPath: base.addonPath };
    await core.handle({ id: 1, type: 'transcribe', engine: 'cohere', language: 'de', pcm16, ...at, modelDir: '/m/cohere' });
    expect(f.configs[0]).toMatchObject({ modelConfig: { cohereTranscribe: { encoder: join('/m', 'cohere', 'encoder.int8.onnx'), decoder: join('/m', 'cohere', 'decoder.int8.onnx'), language: 'de', usePunct: 1, useItn: 1 }, tokens: join('/m', 'cohere', 'tokens.txt') } });
    // no piece longer than one pass, nothing padded
    expect(f.heard.length).toBe(3);
    expect(f.heard.reduce((a, b) => a + b, 0)).toBe(pcm16.length);
    for (const h of f.heard) expect(h).toBeLessThanOrEqual(LONG_PART_SEC * STT_RATE);
    // Cohere always needs a language
    await core.handle({ id: 2, type: 'transcribe', engine: 'cohere', language: '', pcm16: new Int16Array(10), ...at, modelDir: '/m/cohere' });
    expect((f.configs[1] as { modelConfig: { cohereTranscribe: { language: string } } }).modelConfig.cohereTranscribe.language).toBe('en');
    await core.handle({ id: 3, type: 'warm', kind: 'stt', engine: 'qwen3', language: 'fr', ...at, modelDir: '/m/qwen' });
    expect(f.configs[2]).toMatchObject({ modelConfig: { qwen3Asr: { convFrontend: join('/m', 'qwen', 'conv_frontend.onnx'), encoder: join('/m', 'qwen', 'encoder.int8.onnx'), decoder: join('/m', 'qwen', 'decoder.int8.onnx'), tokenizer: join('/m', 'qwen', 'tokenizer') } } });
    // it takes no language: another changes nothing
    await core.handle({ id: 4, type: 'warm', kind: 'stt', engine: 'qwen3', language: 'en', ...at, modelDir: '/m/qwen' });
    expect(f.calls.filter((c) => c === 'setConfig').length).toBe(1);
    await core.handle({ id: 5, type: 'warm', kind: 'stt', engine: 'sense-voice', language: '', ...at, modelDir: '/m/sv' });
    expect(f.configs.at(-1)).toMatchObject({ modelConfig: { senseVoice: { model: join('/m', 'sv', 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 }, tokens: join('/m', 'sv', 'tokens.txt') } });
  });

  it('puts silence before the words when asked (Underdog Bark)', async () => {
    const f = fakeAddon();
    const core = new VoiceHostCore({ loadAddon: () => f.addon });
    await core.handle({ id: 1, type: 'transcribe', engine: 'nemo-transducer', language: '', pcm16: new Int16Array(STT_RATE), leadMs: 250, addonPath: base.addonPath, modelDir: '/m/bark' });
    expect(f.heard).toEqual([STT_RATE + STT_RATE / 4]);
  });

  it('feeds a streaming model the whole recording and quiet after it, with the language as a stream option', async () => {
    const f = fakeAddon();
    const core = new VoiceHostCore({ loadAddon: () => f.addon, numThreads: 2 });
    const r = await core.handle({ id: 1, type: 'transcribe', engine: 'nemo-streaming', language: 'de', pcm16: new Int16Array(2 * STT_RATE), addonPath: base.addonPath, modelDir: '/m/nemotron' });
    // the tag after the sentence goes; decoded until it had nothing more
    expect(r).toEqual({ id: 1, text: 'Hallo zusammen. (de, 3 chunks)' });
    expect(f.heard).toEqual([2 * STT_RATE + STREAMING_TAIL_SEC * STT_RATE]);
    expect(f.calls).toEqual(['createOnline']);
    expect(f.configs[0]).toMatchObject({ modelConfig: { transducer: { encoder: join('/m', 'nemotron', 'encoder.int8.onnx') }, tokens: join('/m', 'nemotron', 'tokens.txt') }, decodingMethod: 'greedy_search' });
    // its language is per stream: another one needs no new recognizer
    const auto = await core.handle({ id: 2, type: 'transcribe', engine: 'nemo-streaming', language: '', pcm16: new Int16Array(10), addonPath: base.addonPath, modelDir: '/m/nemotron' });
    expect(auto).toMatchObject({ text: 'Hallo zusammen. (auto, 3 chunks)' });
    expect(f.calls).toEqual(['createOnline']);
  });

  it('reads Kokoro through its lexicon, American or British, with no passes or language, numbers as words', async () => {
    const f = fakeAddon();
    const texts: string[] = [];
    const gen = f.addon.offlineTtsGenerateAsyncWithConfig;
    f.addon.offlineTtsGenerateAsyncWithConfig = (t, g) => { texts.push((g as { text: string }).text); return gen(t, g); };
    const dir = mkdtempSync(join(tmpdir(), 'appubot-kokoro-'));
    writeFileSync(join(dir, 'lexicon-gb-en.txt'), 'git ɡ ˈ ɪ t\nhub h ˈ ʌ b\non ɑ n\n');
    writeFileSync(join(dir, 'lexicon-us-en.txt'), 'hi h ˈ I\n');
    try {
      const core = new VoiceHostCore({ loadAddon: () => f.addon, numThreads: 2 });
      await core.handle({ id: 1, type: 'speak', engine: 'kokoro', variant: 'gb', text: 'On GitHub at 9:05', language: 'en', speakerId: 21, addonPath: base.addonPath, modelDir: dir });
      expect(f.configs[0]).toEqual({
        model: { kokoro: { model: join(dir, 'model.int8.onnx'), voices: join(dir, 'voices.bin'), tokens: join(dir, 'tokens.txt'), lexicon: join(dir, 'lexicon-gb-en.txt') }, numThreads: 2, provider: 'cpu', debug: 0 },
        maxNumSentences: 1,
      });
      expect(f.calls.at(-1)).toBe('gen:{"sid":21,"speed":1}');
      expect(texts[0]).toBe('On Git Hub at nine oh five');
      // an American voice loads the American lexicon
      await core.handle({ id: 2, type: 'speak', engine: 'kokoro', variant: 'us', text: 'Hi', language: 'en', speakerId: 3, addonPath: base.addonPath, modelDir: dir });
      expect(f.calls.filter((c) => c === 'createTts').length).toBe(2);
      // Supertonic reads the text as it is
      await core.handle({ id: 3, type: 'speak', text: 'At 9:05', language: 'en', speakerId: 0, addonPath: base.addonPath, modelDir: '/m/tts' });
      expect(texts.at(-1)).toBe('At 9:05');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('cleanText', () => {
  it('keeps the words, not the models’ tags', () => {
    expect(cleanText('<|en|><|NEUTRAL|><|Speech|><|withitn|>Hello there.')).toBe('Hello there.');
    expect(cleanText('language English<asr_text>Hello there.')).toBe('Hello there.');
    expect(cleanText('Guten Tag. <de-DE>')).toBe('Guten Tag.');
    expect(cleanText(' a <unk> b ')).toBe('a b');
    // ordinary angle brackets in speech are rare, and kept when they aren't a tag
    expect(cleanText('2 < 3')).toBe('2 < 3');
  });
});

describe('unshout', () => {
  it('writes SenseVoice’s capitals as sentences, and leaves other text alone', () => {
    expect(unshout('THE TRIBAL CHIEF CALLED. I AM HERE AND I’M FINE')).toBe('The tribal chief called. I am here and I’m fine');
    expect(unshout('开放时间早上九点')).toBe('开放时间早上九点');
    expect(unshout('Hello NASA')).toBe('Hello NASA');
  });
});
