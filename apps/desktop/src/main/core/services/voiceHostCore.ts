/**
 * What the voice host process does (`src/main/voiceHost.ts` wires it to its IPC channel): runs sherpa-onnx's N-API
 * addon on requests from the app, one at a time. It keeps one model loaded (a recognizer or a voice; a request for
 * another replaces it) and answers every request, failures included, as a message with the request's id.
 *
 * Pure apart from loading the addon (`loadAddon`, injected in tests), and self-contained: the host bundle carries no
 * app code but this, so nothing here imports beyond node:*.
 */
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { kokoroText } from './kokoroText';

/**
 * How a speech model runs: NeMo transducers (Parakeet, Underdog Bark), NeMo CTC (IndicConformer), Whisper, Cohere
 * Transcribe, Qwen3-ASR, SenseVoice, and NeMo's cache-aware streaming transducer (Nemotron), which runs on the
 * online recognizer, each recording fed whole.
 */
export type SttEngine = 'nemo-transducer' | 'nemo-ctc' | 'whisper' | 'cohere' | 'qwen3' | 'sense-voice' | 'nemo-streaming';
/** How a voice model runs; `variant` picks a part of it (Kokoro's British lexicon) */
export type TtsEngine = 'supertonic' | 'kokoro';

export type HostRequest =
  | { id: number; type: 'transcribe'; addonPath: string; engine: SttEngine; modelDir: string; language: string; pcm16: Int16Array; leadMs?: number }
  | { id: number; type: 'speak'; addonPath: string; engine?: TtsEngine; variant?: string; modelDir: string; text: string; language: string; speakerId: number; numSteps?: number }
  | { id: number; type: 'warm'; addonPath: string; kind: 'stt'; engine: SttEngine; modelDir: string; language: string }
  | { id: number; type: 'warm'; addonPath: string; kind: 'tts'; engine?: TtsEngine; variant?: string; modelDir: string };

export type HostErrorCode = 'runtime-unavailable' | 'model-load-failed' | 'inference-failed';
export type HostResponse =
  | { id: number; text: string }
  | { id: number; pcm16: Int16Array; sampleRate: number }
  | { id: number; ok: true }
  | { id: number; error: HostErrorCode; detail: string };

/** The part of the sherpa-onnx 2.0 addon used here (its exports, as `process.dlopen` gives them). */
export interface SherpaAddon {
  createOfflineRecognizerAsync(config: unknown): Promise<unknown>;
  offlineRecognizerSetConfig(rec: unknown, config: unknown): void;
  createOfflineStream(rec: unknown): unknown;
  acceptWaveformOffline(stream: unknown, wave: { samples: Float32Array; sampleRate: number }): void;
  decodeOfflineStreamAsync(rec: unknown, stream: unknown): Promise<unknown>;
  getOfflineStreamResultAsJson(stream: unknown): string;
  createOnlineRecognizer(config: unknown): unknown;
  createOnlineStream(rec: unknown): unknown;
  acceptWaveformOnline(stream: unknown, wave: { samples: Float32Array; sampleRate: number }): void;
  onlineStreamSetOption(stream: unknown, key: string, value: string): void;
  inputFinished(stream: unknown): void;
  isOnlineStreamReady(rec: unknown, stream: unknown): boolean;
  decodeOnlineStream(rec: unknown, stream: unknown): void;
  getOnlineStreamResultAsJson(rec: unknown, stream: unknown): string;
  createOfflineTtsAsync(config: unknown): Promise<unknown>;
  offlineTtsGenerateAsyncWithConfig(tts: unknown, o: unknown): Promise<{ samples: Float32Array; sampleRate: number }>;
  getOfflineTtsSampleRate(tts: unknown): number;
}

/** what the recognizers hear at */
export const STT_RATE = 16_000;
/**
 * sherpa-onnx's Whisper decoder stops after 6 tokens per second of audio, and Hindi, Tamil, Arabic… take 15-25 tokens
 * a second (byte-level BPE), so a sentence came back cut off half way. Each part gets silence after it,
 * `WHISPER_PAD_RATIO` times its length, which raises that budget; a pass reads at most `WHISPER_MAX_SEC`, so parts
 * are at most `WHISPER_PART_SEC`…
 */
export const WHISPER_PART_SEC = 9;
/** …each cut at the quietest point of its last seconds */
export const WHISPER_LOOK_SEC = 3;
export const WHISPER_PAD_RATIO = 2;
/** the least silence after a part, so its last words aren't dropped */
export const WHISPER_PAD_SEC = 0.5;
/** what one Whisper pass reads, padding included (3000 frames, less the 50 sherpa-onnx keeps for its own) */
export const WHISPER_MAX_SEC = 29.5;

/** the longest piece the other attention models (Cohere, Qwen3-ASR, SenseVoice) read in one pass */
export const LONG_PART_SEC = 25;
/** silence after the end of a recording fed to a streaming model, so its last chunk is decoded (its 1.12 s chunk) */
export const STREAMING_TAIL_SEC = 1.5;
/** the engines that read a language: Whisper, Cohere, SenseVoice, Nemotron (a stream option) */
export const takesLanguage = (engine: SttEngine): boolean => engine === 'whisper' || engine === 'cohere' || engine === 'sense-voice' || engine === 'nemo-streaming';

/** the silence after a Whisper part of `n` samples */
export function whisperPad(n: number, rate = STT_RATE): number {
  const max = Math.max(0, Math.floor(WHISPER_MAX_SEC * rate) - n);
  return Math.min(max, Math.max(Math.round(WHISPER_PAD_SEC * rate), Math.round(n * WHISPER_PAD_RATIO)));
}
/**
 * Supertonic's denoising passes: 8 for a reading that is kept (a reply's voice note), 5 for a live conversation's,
 * which comes about 35% sooner (Apple silicon, 4 threads: 606 → 392 ms a sentence) for a little less polish.
 */
export const TTS_STEPS = 8;
export const TTS_LIVE_STEPS = 5;

export function dlopenAddon(path: string): SherpaAddon {
  const m = { exports: {} as SherpaAddon };
  process.dlopen(m, path);
  return m.exports;
}

class HostError extends Error {
  constructor(public code: HostErrorCode, detail: string) { super(detail); }
}
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** runs `fn`, failing as `code` unless it already failed as a HostError */
async function as<T>(code: HostErrorCode, fn: () => T | Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { throw e instanceof HostError ? e : new HostError(code, msgOf(e)); }
}

/**
 * Where to cut `n` samples at `rate` into parts of at most `maxSec`: each cut is the middle of the quietest 20 ms
 * window in the last `lookSec` of its part. Returns the part boundaries (start of each part after the first).
 */
export function quietCuts(samples: ArrayLike<number>, rate: number, maxSec = WHISPER_PART_SEC, lookSec = WHISPER_LOOK_SEC): number[] {
  const max = Math.floor(maxSec * rate);
  const look = Math.floor(lookSec * rate);
  const win = Math.max(1, Math.floor(rate / 50));
  const cuts: number[] = [];
  let start = 0;
  while (samples.length - start > max) {
    const end = start + max;
    let best = end;
    let bestEnergy = Infinity;
    for (let w = end - look; w + win <= end; w += win) {
      let e = 0;
      for (let i = w; i < w + win; i++) e += samples[i]! * samples[i]!;
      if (e < bestEnergy) { bestEnergy = e; best = w + (win >> 1); }
    }
    cuts.push(best);
    start = best;
  }
  return cuts;
}

interface Loaded { key: string; kind: 'stt' | 'tts'; handle: unknown; engine?: SttEngine; language?: string; sampleRate?: number; known?: Set<string> }

export interface VoiceHostCoreOptions {
  /** default: `process.dlopen` */
  loadAddon?: (path: string) => SherpaAddon;
  numThreads?: number;
}

export class VoiceHostCore {
  private addons = new Map<string, SherpaAddon>();
  private loaded: Loaded | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private loadAddon: (path: string) => SherpaAddon;
  private threads: number;

  constructor(o: VoiceHostCoreOptions = {}) {
    this.loadAddon = o.loadAddon ?? dlopenAddon;
    this.threads = o.numThreads ?? Math.max(1, Math.min(4, availableParallelism()));
  }

  /** answers one request; requests run one after another in the order they came */
  handle(req: HostRequest): Promise<HostResponse> {
    const run = this.queue.then(() => this.run(req));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(req: HostRequest): Promise<HostResponse> {
    try {
      const addon = this.addon(req.addonPath);
      if (req.type === 'transcribe') return { id: req.id, text: await this.transcribe(addon, req) };
      if (req.type === 'speak') return { id: req.id, ...(await this.speak(addon, req)) };
      if (req.type === 'warm') {
        if (req.kind === 'stt') await this.recognizer(addon, req.engine, req.modelDir, req.language);
        else await this.tts(addon, req.engine ?? 'supertonic', req.modelDir, req.variant);
        return { id: req.id, ok: true };
      }
      throw new HostError('inference-failed', `unknown request ${(req as { type?: string }).type}`);
    } catch (e) {
      return e instanceof HostError
        ? { id: req.id, error: e.code, detail: e.message }
        : { id: req.id, error: 'inference-failed', detail: msgOf(e) };
    }
  }

  private addon(path: string): SherpaAddon {
    let a = this.addons.get(path);
    if (!a) {
      try { a = this.loadAddon(path); } catch (e) { throw new HostError('runtime-unavailable', msgOf(e)); }
      this.addons.set(path, a);
    }
    return a;
  }

  private sttConfig(engine: SttEngine, dir: string, language: string): unknown {
    const common = { numThreads: this.threads, provider: 'cpu', debug: 0 };
    const featConfig = { sampleRate: STT_RATE, featureDim: 80 };
    const tokens = join(dir, 'tokens.txt');
    switch (engine) {
      case 'nemo-ctc':
        return { featConfig, modelConfig: { nemoCtc: { model: join(dir, 'model.int8.onnx') }, tokens, ...common } };
      case 'whisper':
        return {
          featConfig,
          modelConfig: {
            whisper: { encoder: join(dir, 'turbo-encoder.int8.onnx'), decoder: join(dir, 'turbo-decoder.int8.onnx'), language, task: 'transcribe', tailPaddings: -1 },
            tokens: join(dir, 'turbo-tokens.txt'),
            ...common,
          },
        };
      case 'cohere':
        // its weights are in encoder.int8.onnx.data beside it, found by onnxruntime
        return { featConfig, modelConfig: { cohereTranscribe: { encoder: join(dir, 'encoder.int8.onnx'), decoder: join(dir, 'decoder.int8.onnx'), language: language || 'en', usePunct: 1, useItn: 1 }, tokens, ...common } };
      case 'qwen3':
        return {
          featConfig,
          modelConfig: {
            qwen3Asr: { convFrontend: join(dir, 'conv_frontend.onnx'), encoder: join(dir, 'encoder.int8.onnx'), decoder: join(dir, 'decoder.int8.onnx'), tokenizer: join(dir, 'tokenizer') },
            ...common,
          },
        };
      case 'sense-voice':
        return { featConfig, modelConfig: { senseVoice: { model: join(dir, 'model.int8.onnx'), language: language || 'auto', useInverseTextNormalization: 1 }, tokens, ...common } };
      case 'nemo-streaming':
        return {
          featConfig,
          modelConfig: { transducer: { encoder: join(dir, 'encoder.int8.onnx'), decoder: join(dir, 'decoder.int8.onnx'), joiner: join(dir, 'joiner.int8.onnx') }, tokens, ...common },
          decodingMethod: 'greedy_search',
        };
      default:
        return {
          featConfig,
          modelConfig: {
            transducer: { encoder: join(dir, 'encoder.int8.onnx'), decoder: join(dir, 'decoder.int8.onnx'), joiner: join(dir, 'joiner.int8.onnx') },
            tokens,
            modelType: 'nemo_transducer',
            ...common,
          },
        };
    }
  }

  /** the recognizer for this model, loading it (and dropping whatever was loaded) when it isn't the current one */
  private async recognizer(addon: SherpaAddon, engine: SttEngine, dir: string, language: string): Promise<unknown> {
    const key = `stt:${engine}:${dir}`;
    // a streaming model takes its language per stream; the others in their config
    const lang = takesLanguage(engine) && engine !== 'nemo-streaming' ? language : '';
    if (this.loaded?.key === key) {
      if (this.loaded.language !== lang) {
        const handle = this.loaded.handle;
        await as('model-load-failed', () => addon.offlineRecognizerSetConfig(handle, this.sttConfig(engine, dir, lang)));
        this.loaded.language = lang;
      }
      return this.loaded.handle;
    }
    // the old model goes first: two speech models at once can take 4 GB
    this.loaded = null;
    const config = this.sttConfig(engine, dir, lang);
    const handle = await as('model-load-failed', () => (engine === 'nemo-streaming' ? addon.createOnlineRecognizer(config) : addon.createOfflineRecognizerAsync(config)));
    this.loaded = { key, kind: 'stt', handle, engine, language: lang };
    return handle;
  }

  private ttsModel(engine: TtsEngine, dir: string, variant: string): unknown {
    switch (engine) {
      case 'kokoro':
        // sherpa-onnx 2 reads Kokoro through its lexicon only (no espeak-ng): American or British pronunciations
        return { kokoro: { model: join(dir, 'model.int8.onnx'), voices: join(dir, 'voices.bin'), tokens: join(dir, 'tokens.txt'), lexicon: join(dir, variant === 'gb' ? 'lexicon-gb-en.txt' : 'lexicon-us-en.txt') } };
      default:
        return {
          supertonic: {
            durationPredictor: join(dir, 'duration_predictor.int8.onnx'),
            textEncoder: join(dir, 'text_encoder.int8.onnx'),
            vectorEstimator: join(dir, 'vector_estimator.int8.onnx'),
            vocoder: join(dir, 'vocoder.int8.onnx'),
            ttsJson: join(dir, 'tts.json'),
            unicodeIndexer: join(dir, 'unicode_indexer.bin'),
            voiceStyle: join(dir, 'voice.bin'),
          },
        };
    }
  }

  private async tts(addon: SherpaAddon, engine: TtsEngine, dir: string, variant = ''): Promise<Loaded> {
    const key = `tts:${engine}:${dir}:${variant}`;
    if (this.loaded?.key === key) return this.loaded;
    this.loaded = null;
    const config = { model: { ...(this.ttsModel(engine, dir, variant) as object), numThreads: this.threads, provider: 'cpu', debug: 0 }, maxNumSentences: 1 };
    const handle = await as('model-load-failed', () => addon.createOfflineTtsAsync(config));
    const sampleRate = await as('model-load-failed', () => addon.getOfflineTtsSampleRate(handle));
    // Kokoro skips the words its lexicon lacks: the host rewrites text with the words it has (kokoroText)
    const known = engine === 'kokoro' ? await as('model-load-failed', () => lexiconWords(join(dir, variant === 'gb' ? 'lexicon-gb-en.txt' : 'lexicon-us-en.txt'))) : undefined;
    this.loaded = { key, kind: 'tts', handle, sampleRate, ...(known ? { known } : {}) };
    return this.loaded;
  }

  private async transcribe(addon: SherpaAddon, req: Extract<HostRequest, { type: 'transcribe' }>): Promise<string> {
    const rec = await this.recognizer(addon, req.engine, req.modelDir, req.language);
    let samples = toFloat(req.pcm16);
    if (!samples.length) return '';
    // some models were trained (and scored) with a little silence before the words (Underdog Bark: 0.25 s)
    if (req.leadMs) {
      const lead = new Float32Array(Math.round((req.leadMs / 1000) * STT_RATE) + samples.length);
      lead.set(samples, lead.length - samples.length);
      samples = lead;
    }
    if (req.engine === 'nemo-streaming') return this.streamed(addon, rec, samples, req.language);
    const parts: Float32Array[] = [];
    if (req.engine === 'whisper') {
      let start = 0;
      for (const cut of [...quietCuts(samples, STT_RATE), samples.length]) {
        const part = new Float32Array(cut - start + whisperPad(cut - start));
        part.set(samples.subarray(start, cut));
        parts.push(part);
        start = cut;
      }
    } else if (req.engine === 'cohere' || req.engine === 'qwen3' || req.engine === 'sense-voice') {
      let start = 0;
      for (const cut of [...quietCuts(samples, STT_RATE, LONG_PART_SEC), samples.length]) { parts.push(samples.subarray(start, cut)); start = cut; }
    } else {
      parts.push(samples);
    }
    const texts: string[] = [];
    for (const part of parts) {
      const text = await as('inference-failed', async () => {
        const stream = addon.createOfflineStream(rec);
        addon.acceptWaveformOffline(stream, { samples: part, sampleRate: STT_RATE });
        await addon.decodeOfflineStreamAsync(rec, stream);
        const json = JSON.parse(addon.getOfflineStreamResultAsJson(stream)) as { text?: unknown };
        const t = typeof json.text === 'string' ? cleanText(json.text) : '';
        // SenseVoice writes English in capitals
        return req.engine === 'sense-voice' ? unshout(t) : t;
      });
      if (text) texts.push(text);
    }
    return texts.join(' ');
  }

  /** a whole recording through a streaming model: fed at once, then quiet so its last chunk comes out */
  private streamed(addon: SherpaAddon, rec: unknown, samples: Float32Array, language: string): Promise<string> {
    return as('inference-failed', () => {
      const stream = addon.createOnlineStream(rec);
      addon.onlineStreamSetOption(stream, 'language', language || 'auto');
      addon.acceptWaveformOnline(stream, { samples, sampleRate: STT_RATE });
      addon.acceptWaveformOnline(stream, { samples: new Float32Array(Math.round(STREAMING_TAIL_SEC * STT_RATE)), sampleRate: STT_RATE });
      addon.inputFinished(stream);
      while (addon.isOnlineStreamReady(rec, stream)) addon.decodeOnlineStream(rec, stream);
      const json = JSON.parse(addon.getOnlineStreamResultAsJson(rec, stream)) as { text?: unknown };
      return typeof json.text === 'string' ? cleanText(json.text) : '';
    });
  }

  private async speak(addon: SherpaAddon, req: Extract<HostRequest, { type: 'speak' }>): Promise<{ pcm16: Int16Array; sampleRate: number }> {
    const engine = req.engine ?? 'supertonic';
    const tts = await this.tts(addon, engine, req.modelDir, req.variant);
    // only Supertonic takes denoising passes and a language per request; the others read the voice's own
    const generationConfig = engine === 'supertonic'
      ? { sid: req.speakerId, speed: 1, numSteps: req.numSteps ?? TTS_STEPS, extra: { lang: req.language } }
      : { sid: req.speakerId, speed: 1 };
    return as('inference-failed', async () => {
      const known = tts.known;
      const out = await addon.offlineTtsGenerateAsyncWithConfig(tts.handle, {
        text: known ? kokoroText(req.text, (w) => known.has(w)) : req.text,
        generationConfig,
        // the addon's own buffer can't be handed to JS under Electron's V8 memory cage
        enableExternalBuffer: false,
      });
      return { pcm16: toInt16(out.samples), sampleRate: out.sampleRate || tts.sampleRate || 44_100 };
    });
  }
}

/**
 * A model's text as words: SenseVoice's and Qwen3-ASR's tags (`<|en|>`, `<|NEUTRAL|>`, `language English<asr_text>`),
 * Nemotron's language tag after the last sentence (`<en-US>`), an unknown word's `<unk>`.
 */
export function cleanText(text: string): string {
  return text
    .replace(/<\|[^|>]*\|>/g, ' ')
    .replace(/^\s*language\s+[A-Za-z]+\s*<asr_text>/i, ' ')
    .replace(/<\/?asr_text>/gi, ' ')
    .replace(/<unk>/gi, ' ')
    .replace(/<[a-z]{2,3}(?:-[A-Za-z]{2,4})?>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Latin text written all in capitals as a sentence is written ("HELLO THERE. I AM" → "Hello there. I am"); else as it is. */
export function unshout(text: string): string {
  if (!/[A-Z].*[A-Z].*[A-Z]/.test(text) || /[a-z]/.test(text)) return text;
  return text
    .toLowerCase()
    .replace(/(^|[.?!]\s+)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())
    .replace(/\bi\b(?!['’][a-z]{3})/g, 'I');
}

/** the words a lexicon has (its lines' first field), as Kokoro looks them up */
export function lexiconWords(path: string): Set<string> {
  const words = new Set<string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const end = line.indexOf(' ');
    if (end > 0) words.add(line.slice(0, end).toLowerCase());
  }
  return words;
}

function toFloat(s: Int16Array): Float32Array {
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i]! / 32768;
  return out;
}

function toInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const x = f[i]!;
    out[i] = x >= 1 ? 32767 : x <= -1 ? -32768 : Math.round(x < 0 ? x * 32768 : x * 32767);
  }
  return out;
}
