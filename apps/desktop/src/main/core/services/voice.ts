/**
 * Voice: speech on this computer, for every client (this window, a phone app, Telegram). Speech-to-text (the model
 * Settings › Voice picks: Parakeet, Cohere Transcribe, Whisper…) and text-to-speech (Supertonic 3 or Kokoro) run on
 * the CPU through sherpa-onnx in host processes of their own
 * (`voiceHost`), on models downloaded once into `<dataDir>/voice-models` (`VOICE_MODELS`, sha256-checked). Nothing is
 * sent anywhere. Audio comes in as 16 kHz PCM, OGG/Opus (a Telegram voice note) or anything the desktop decodes
 * (`deps.decodeAudio`); replies go out as OGG/Opus (`audio/opus.ts`), or as WAV for a live conversation, which also
 * reads with fewer model passes (`TTS_LIVE_STEPS`). `warm` loads both models ahead and keeps them loaded while a
 * conversation goes on (a lease the engine honours).
 *
 * The models' files are `VoiceModelsStore`'s (`voiceModels.ts`), the processes `HostVoiceEngine`'s (`voiceEngine.ts`;
 * `deps.voiceEngine` in tests). Every change of a model's state or of what runs goes out as `voice.status`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileAttachment, SpeechLanguage, SpeechVoice, VoiceModelId, VoiceSttModelId, VoiceStatus, VoiceTtsModelId } from '@appubot/protocol';
import {
  DEFAULT_VOICE_TTS_MODEL, VOICE_MAX_SECONDS, VOICE_MODELS, VOICE_PCM_RATE, VOICE_SPEAK_MAX_CHARS, VOICE_STT_MODEL_IDS, VOICE_TTS_MODEL_IDS, VOICE_WARM_MS,
  sttLanguageFor, voiceFor, voiceModelInfo,
} from '@appubot/protocol';
import { speechChunks, speechLanguage, speechText } from '@appubot/chat-core';
import type { CoreCtx } from '../context';
import { RpcError, errMsg } from '../util';
import { durationMs, pcmToWav, resample, wavDecode } from '../audio/pcm';
import { decodeOggOpus, encodeOggOpus } from '../audio/opus';
import { VoiceModelsStore } from './voiceModels';
import { HostVoiceEngine, VoiceEngineError } from './voiceEngine';
import { TTS_LIVE_STEPS } from './voiceHostCore';

export interface TranscribeInput {
  audio: Uint8Array;
  /** `pcm16`: 16 kHz mono 16-bit little-endian; `ogg`: OGG/Opus; `encoded`: anything `deps.decodeAudio` reads (`mimeType`) */
  format: 'pcm16' | 'ogg' | 'encoded';
  mimeType?: string;
  /** overrides `settings.voice.language` ('auto': the model finds it) */
  language?: string;
}
export interface TranscribeResult { text: string; durationMs: number }

export interface SpeakInput {
  /** Markdown or plain text; read as words (chat-core `speechText`) */
  text: string;
  /** unsent: guessed from the text (chat-core `speechLanguage`) */
  language?: SpeechLanguage;
  /** unsent: `settings.voice.voice` */
  voice?: SpeechVoice;
  /** a live conversation's reading: fewer model passes (`TTS_LIVE_STEPS`), sooner */
  live?: boolean;
}
export interface Reading { pcm16: Int16Array; sampleRate: number; durationMs: number; language: SpeechLanguage }
export interface SpeakResult { audio: Uint8Array; mimeType: 'audio/ogg' | 'audio/wav'; durationMs: number; language: SpeechLanguage }

/** What runs the models: the sherpa-onnx host processes (the app), or a fake (tests, `deps.voiceEngine`). */
export interface VoiceEngine {
  /** 16 kHz mono PCM → text */
  transcribe(o: { pcm16: Int16Array; model: VoiceSttModelId; modelDir: string; language: string }): Promise<string>;
  /** text in one language → PCM at the model's rate; `steps`: the voice model's passes (its default unsent) */
  speak(o: { text: string; language: SpeechLanguage; model: VoiceTtsModelId; voice: SpeechVoice; modelDir: string; steps?: number }): Promise<{ pcm16: Int16Array; sampleRate: number }>;
  /** loads a model ahead of its first use (optional) */
  warm?(o: { kind: 'stt'; model: VoiceSttModelId; modelDir: string; language: string } | { kind: 'tts'; model: VoiceTtsModelId; voice: SpeechVoice; modelDir: string }): Promise<void>;
  /** keeps the loaded models up for `ms` from now, even idle (optional) */
  hold?(ms: number): void;
  shutdown(): Promise<void>;
}

/** Where the sherpa-onnx N-API addon is (its libraries beside it), or why this computer has none. */
export type VoiceRuntime =
  | {
    addonPath: string;
    /** the Node that runs the hosts (unsent: this process's own; an AppuBot computer's gateway runs on one its children can't start) */
    nodePath?: string;
    /**
     * Set: this computer only reads aloud (no speech model runs here: an AppuBot computer, whose phone hears you
     * itself), and this says so to whoever asks it to hear. `VoiceStatus.supported` stays false, `speaks` is true.
     */
    speakOnly?: string;
  }
  | { error: string };

/** `voice.status` goes out at most this often while only progress moves */
const STATUS_MS = 250;
/** recordings past this many bytes aren't decoded (180 s of WAV at 48 kHz stereo is ~35 MB) */
const MAX_INPUT_BYTES = 40 * 1024 * 1024;

const tag = (b: Uint8Array, at: number): string => (b.byteLength >= at + 4 ? String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!) : '');
const isWav = (b: Uint8Array): boolean => tag(b, 0) === 'RIFF' && tag(b, 8) === 'WAVE';

/** how long after launch the models the settings pick start downloading in the background (launch comes first) */
export const VOICE_PREFETCH_DELAY_MS = 30_000;

export class VoiceService {
  private store: VoiceModelsStore;
  private engineInstance: VoiceEngine | null = null;
  private busy = { stt: 0, tts: 0 };
  private lastEmit = 0;
  /** WAV copies made for `voice.convert`, by the source file's id (one per run; the file itself stays stored) */
  private converted = new Map<string, FileAttachment>();
  private lastShape = '';
  private trailing: NodeJS.Timeout | undefined;
  private prefetchTimer: NodeJS.Timeout | undefined;

  constructor(private ctx: CoreCtx) {
    this.store = new VoiceModelsStore({
      root: join(ctx.paths.dataDir, 'voice-models'),
      fetch: () => ctx.deps.fetch ?? fetch,
      log: ctx.log,
      onChange: () => this.changed(),
    });
  }

  /**
   * Reads which models are on disk already, then fetches the ones the settings pick in the background
   * (2026-11-17, the owner's call: they download once AppuBot is installed, not when the mic is first pressed; the
   * apps only show the download to someone who asked for voice). A computer that only speaks gets its voice at once
   * (nobody there has Settings › Voice to get it); elsewhere `VOICE_PREFETCH_DELAY_MS` after launch.
   */
  start(): void {
    this.store.sweep();
    const { supported, speaks, reason } = this.runtime();
    if (!speaks) { this.ctx.log.info(`voice: unavailable (${reason})`); return; }
    if (!supported) { this.ctx.log.info('voice: reads aloud only'); this.prepare(); return; }
    this.prefetchTimer = setTimeout(() => this.prefetch(), VOICE_PREFETCH_DELAY_MS);
    this.prefetchTimer.unref?.();
  }

  /** where the models fetched by themselves are written down: each only once, so one someone removed stays removed */
  private get prefetchedFile(): string { return join(this.ctx.paths.dataDir, 'voice-prefetched.json'); }

  private prefetched(): Set<string> {
    try { return new Set((JSON.parse(readFileSync(this.prefetchedFile, 'utf8')) as { ids?: string[] }).ids ?? []); } catch { return new Set(); }
  }

  private notePrefetched(ids: Set<string>): void {
    try { writeFileSync(this.prefetchedFile, JSON.stringify({ ids: [...ids].sort() })); } catch (e) { this.ctx.log.warn('voice: could not note prefetched models', errMsg(e)); }
  }

  /** the background download: the speech model and the voice the settings pick, each the first time only */
  prefetch(): void {
    const rt = this.runtime();
    if (!rt.speaks) return;
    const v = this.ctx.s.settings.get().voice;
    const done = this.prefetched();
    const before = done.size;
    for (const id of [...(rt.supported ? [v.sttModel] : []), v.ttsModel ?? DEFAULT_VOICE_TTS_MODEL] as VoiceModelId[]) {
      const phase = this.store.state(id).phase;
      if (phase === 'ready') { done.add(id); continue; }
      if (done.has(id) || phase === 'downloading') continue;
      this.ctx.log.info(`voice: downloading ${id} in the background`);
      this.fetchModel(id);
      // written down once it is here (the next launch's look); a failed one is tried again then
    }
    if (done.size !== before) this.notePrefetched(done);
  }

  async shutdown(): Promise<void> {
    clearTimeout(this.trailing);
    clearTimeout(this.prefetchTimer);
    this.store.cancelAll();
    const engine = this.engineInstance;
    this.engineInstance = null;
    await engine?.shutdown();
  }

  status(): VoiceStatus {
    const { supported, speaks, reason } = this.runtime();
    const speakOnly = speaks && !supported;
    return {
      supported,
      ...(reason ? { reason } : {}),
      ...(speakOnly ? { speaks: true } : {}),
      // a computer that only speaks lists its voices alone
      models: VOICE_MODELS.filter((m) => !speakOnly || m.kind === 'tts').map((m) => ({ id: m.id, kind: m.kind, name: m.name, bytes: m.bytes, ...this.store.state(m.id) })),
      busy: { stt: this.busy.stt > 0, tts: this.busy.tts > 0 },
    };
  }

  /** the model this kind needs with the current settings is downloaded and the runtime is here */
  ready(kind: 'stt' | 'tts'): boolean {
    const rt = this.runtime();
    return kind === 'stt' ? rt.supported && !!this.sttModel() : rt.speaks && !!this.ttsModel();
  }

  /** this computer can hear speech at all (false where it only reads aloud, or has no voice) */
  hears(): boolean {
    return this.runtime().supported;
  }

  download(id: VoiceModelId): VoiceStatus {
    const { supported, speaks, reason } = this.runtime();
    if (!speaks || (!supported && voiceModelInfo(id).kind === 'stt')) throw new RpcError('unsupported', reason ?? 'Voice is not available on this computer.');
    this.fetchModel(id);
    return this.status();
  }

  cancel(id: VoiceModelId): VoiceStatus {
    this.store.cancel(id);
    return this.status();
  }

  async remove(id: VoiceModelId): Promise<VoiceStatus> {
    if (this.store.downloading(id)) throw new RpcError('busy', `${voiceModelInfo(id).name} is downloading: cancel the download first.`);
    // both hosts stop below, so nothing may be running in either
    if (this.busy.stt || this.busy.tts) throw new RpcError('busy', 'Voice is in use. Try again in a moment.');
    await this.store.settled(id);
    // the hosts keep the model's files open (Windows can't delete them then); they start again on the next use
    const engine = this.engineInstance;
    this.engineInstance = null;
    await engine?.shutdown().catch((e: unknown) => this.ctx.log.warn('voice: engine shutdown failed', errMsg(e)));
    try { this.store.remove(id); } catch (e) { throw new RpcError('busy', errMsg(e)); }
    // removed by hand: never fetched again by itself
    const done = this.prefetched();
    if (!done.has(id)) { done.add(id); this.notePrefetched(done); }
    return this.status();
  }

  /** downloads what the current settings need, if missing (`only`: the voice, or the speech model, alone) */
  prepare(only?: 'voice' | 'speech'): VoiceStatus {
    const rt = this.runtime();
    if (!rt.speaks) return this.status();
    const v = this.ctx.s.settings.get().voice;
    for (const id of [...(rt.supported && only !== 'voice' ? [v.sttModel] : []), ...(only !== 'speech' ? [v.ttsModel ?? DEFAULT_VOICE_TTS_MODEL] : [])] as VoiceModelId[]) {
      const st = this.store.state(id).phase;
      if (st === 'missing' || st === 'error') this.fetchModel(id);
    }
    return this.status();
  }

  async transcribe(o: TranscribeInput): Promise<TranscribeResult> {
    const rt = this.runtime();
    // it only reads aloud: no speech model to download, so no "download it" either
    if (rt.speaks && !rt.supported) throw new RpcError('unsupported', rt.reason ?? 'This computer doesn’t hear speech.');
    const model = rt.supported ? this.sttModel() : null;
    if (!model) throw new RpcError('voice_not_ready', 'The speech model is not downloaded yet. Download it in Settings › Voice.');
    const pcm16 = await this.decode(o);
    const ms = durationMs(pcm16.length, VOICE_PCM_RATE);
    if (pcm16.length > VOICE_MAX_SECONDS * VOICE_PCM_RATE) {
      throw new RpcError('invalid_params', `Recordings can be ${VOICE_MAX_SECONDS / 60} minutes long at most.`);
    }
    if (!pcm16.length) return { text: '', durationMs: 0 };
    const text = await this.running('stt', () => this.engine().transcribe({ pcm16, model, modelDir: this.store.dir(model), language: this.sttLanguage(model, o.language) }));
    return { text: text.replace(/\s+/g, ' ').trim(), durationMs: ms };
  }

  /**
   * Loads the speech model the settings pick and the voice (those on disk) and keeps them loaded `VOICE_WARM_MS`
   * from now, so a live conversation never waits for a model to load. Says which ones are loaded.
   */
  async warm(only?: 'voice' | 'speech'): Promise<{ stt: boolean; tts: boolean }> {
    const rt = this.runtime();
    if (!rt.speaks) return { stt: false, tts: false };
    // a client that hears you itself asks for the voice alone (no 2 GB speech model loaded for nothing), and one
    // that has the reply read elsewhere for the speech model alone
    const model = rt.supported && only !== 'voice' ? this.sttModel() : null;
    const tts = only !== 'speech' ? this.ttsModel() : null;
    if (!model && !tts) return { stt: false, tts: false };
    const engine = this.engine();
    engine.hold?.(VOICE_WARM_MS);
    const load = async (what: string, fn: (() => Promise<void>) | undefined): Promise<boolean> => {
      if (!fn) return true;
      try { await fn(); return true; } catch (e) { this.ctx.log.warn(`voice: warming the ${what} failed`, errMsg(e)); return false; }
    };
    const [stt, voice] = await Promise.all([
      model ? load('speech model', engine.warm && (() => engine.warm!({ kind: 'stt', model, modelDir: this.store.dir(model), language: this.sttLanguage(model) }))) : false,
      tts ? load('voice', engine.warm && (() => engine.warm!({ kind: 'tts', model: tts, voice: voiceFor(tts, this.ctx.s.settings.get().voice.voice), modelDir: this.store.dir(tts) }))) : false,
    ]);
    return { stt, tts: voice };
  }

  /** `o` read aloud: OGG/Opus (any client plays it, kept on messages), or a WAV that needs no encoding (`wav`) */
  async speak(o: SpeakInput & { format?: 'ogg' | 'wav' }): Promise<SpeakResult> {
    const { reading } = await this.read(o);
    return o.format === 'wav' ? asWav(reading) : asOgg(reading);
  }

  /** speaks and keeps the audio as a `voice` part (`kind: 'reply'`) of that message, so every client can play it again */
  async speakForMessage(threadId: string, messageId: string, o: SpeakInput): Promise<SpeakResult & { file: FileAttachment }> {
    if (!this.ctx.s.threads.findMessage(threadId, messageId)) throw new RpcError('not_found', `Message not found: ${messageId}`);
    const { reading, words } = await this.read(o);
    const result = asOgg(reading);
    // no thread: a reply's reading is never copied into the bot's inbox
    const file = this.ctx.s.files.upload(result.audio, `reply-${new Date().toISOString().replace(/[:.]/g, '-')}.ogg`, 'audio/ogg');
    this.ctx.s.threads.appendPart(threadId, messageId, { type: 'voice', file, durationMs: result.durationMs, kind: 'reply', transcript: words });
    return { ...result, file };
  }

  /* ---------- internals ---------- */

  /**
   * Whether this computer runs the models (`supported`: it hears and speaks), or reads aloud only (`speaks` without
   * `supported`), and why not.
   */
  private runtime(): { supported: boolean; speaks: boolean; reason?: string } {
    const rt = this.ctx.deps.voiceRuntime;
    const none = (reason: string) => ({ supported: false, speaks: false, reason });
    if (!rt) return none('Voice is not available in this build.');
    if ('error' in rt) return none(rt.error);
    if (!existsSync(rt.addonPath)) return none('The speech runtime is missing from this build.');
    if (!this.ctx.deps.voiceEngine && !(this.ctx.paths.voiceHostPath && existsSync(this.ctx.paths.voiceHostPath))) {
      return none('The speech runtime is missing from this build.');
    }
    if (rt.speakOnly) return { supported: false, speaks: true, reason: rt.speakOnly };
    return { supported: true, speaks: true };
  }

  /**
   * The language the speech model is told to expect: one it takes ('' = it finds it), from the request or Settings;
   * 'en-US' is 'en'. A model that takes none gets ''.
   */
  private sttLanguage(model: VoiceSttModelId, asked?: string): string {
    const lang = sttLanguageFor(model, asked ?? this.ctx.s.settings.get().voice.language);
    return lang === 'auto' ? '' : lang;
  }

  /** the speech-to-text model to use: the one picked in Settings, else another one already here */
  private sttModel(): VoiceSttModelId | null {
    const picked = this.ctx.s.settings.get().voice.sttModel;
    if (this.store.onDisk(picked)) return picked;
    return VOICE_STT_MODEL_IDS.find((id) => this.store.onDisk(id)) ?? null;
  }

  /** the voice model to read with: the one picked in Settings, else another one already here */
  private ttsModel(): VoiceTtsModelId | null {
    const picked = this.ctx.s.settings.get().voice.ttsModel ?? DEFAULT_VOICE_TTS_MODEL;
    if (this.store.onDisk(picked)) return picked;
    return VOICE_TTS_MODEL_IDS.find((id) => this.store.onDisk(id)) ?? null;
  }

  private engine(): VoiceEngine {
    if (this.engineInstance) return this.engineInstance;
    const rt = this.ctx.deps.voiceRuntime;
    if (this.ctx.deps.voiceEngine) this.engineInstance = this.ctx.deps.voiceEngine;
    else if (rt && 'addonPath' in rt && this.ctx.paths.voiceHostPath) {
      this.engineInstance = new HostVoiceEngine({ hostPath: this.ctx.paths.voiceHostPath, addonPath: rt.addonPath, ...(rt.nodePath ? { execPath: rt.nodePath } : {}), log: this.ctx.log });
    } else throw new RpcError('unsupported', 'Voice is not available on this computer.');
    return this.engineInstance;
  }

  private fetchModel(id: VoiceModelId): void {
    void this.store.download(id).catch(() => { /* the store keeps the error for status; logged there */ });
  }

  /** runs `fn` as busy `kind`, saying so in `voice.status`, and turns the engine's failures into RPC errors */
  private async running<T>(kind: 'stt' | 'tts', fn: () => Promise<T>): Promise<T> {
    this.busy[kind]++;
    this.changed();
    try {
      return await fn();
    } catch (e) {
      throw toRpcError(e, kind);
    } finally {
      this.busy[kind]--;
      this.changed();
    }
  }

  /** what `o` says, as words and as samples */
  private async read(o: SpeakInput): Promise<{ reading: Reading; words: string }> {
    const rt = this.runtime();
    const model = rt.speaks ? this.ttsModel() : null;
    if (!model && rt.speaks && !rt.supported) {
      // it fetches its own voice (`start`); one that failed then is asked for again now
      this.prepare();
      throw new RpcError('voice_not_ready', 'The voice is still being set up on this computer. Try again in a minute.');
    }
    if (!model) throw new RpcError('voice_not_ready', 'The voice model is not downloaded yet. Download it in Settings › Voice.');
    const words = cutText(speechText(o.text), VOICE_SPEAK_MAX_CHARS);
    if (!words) throw new RpcError('invalid_params', 'There are no words to read in that text.');
    const reads = voiceModelInfo(model).reads ?? ['en'];
    // a model that reads only some languages reads the rest as its first (Kokoro: English)
    const asked = o.language ?? speechLanguage(words, 'en');
    const language = reads.includes(asked) ? asked : reads[0]!;
    const voice = voiceFor(model, o.voice ?? this.ctx.s.settings.get().voice.voice);
    const modelDir = this.store.dir(model);
    // all of it comes back as one recording, so nothing waits on a short first part: whole sentences, never a cut for
    // a sooner start (a cut inside a sentence is read as a line's end, a pause, and a new line)
    const parts = speechChunks(words, language, { after: Infinity });
    const steps = o.live ? TTS_LIVE_STEPS : undefined;
    const reading = await this.running('tts', async () => {
      const pieces: Int16Array[] = [];
      let rate = 0;
      // the voice reads one language per request and a sentence at a time: part by part, joined
      for (const text of parts.length ? parts : [words]) {
        const out = await this.engine().speak({ text, language, model, voice, modelDir, ...(steps ? { steps } : {}) });
        if (!rate) rate = out.sampleRate;
        pieces.push(out.sampleRate === rate ? out.pcm16 : resample(out.pcm16, out.sampleRate, rate));
      }
      const pcm16 = joinReadings(pieces, rate);
      return { pcm16, sampleRate: rate, durationMs: durationMs(pcm16.length, rate), language };
    });
    return { reading, words };
  }

  /**
   * A stored voice file as WAV (`voice.convert`): the original when it already is one, else decoded here (OGG/Opus by
   * our own decoder, the rest through `deps.decodeAudio`), written once as a file of its own and answered again next time.
   */
  async convert(fileId: string): Promise<FileAttachment> {
    const kept = this.converted.get(fileId);
    if (kept && this.ctx.s.files.getRecord(kept.id)) return kept;
    const rec = this.ctx.s.files.getRecord(fileId);
    if (!rec || !existsSync(rec.storedPath)) throw new RpcError('not_found', 'That recording is no longer on this computer.');
    const bytes = new Uint8Array(readFileSync(rec.storedPath));
    if (bytes.byteLength > MAX_INPUT_BYTES) throw new RpcError('invalid_params', 'That recording is too large.');
    if (isWav(bytes) || /wav/i.test(rec.mimeType)) return this.ctx.s.files.toAttachment(rec);
    const unreadable = (e: unknown) => new RpcError('invalid_params', `Could not read the recording: ${errMsg(e)}`);
    let out: { pcm16: Int16Array; sampleRate: number };
    if (tag(bytes, 0) === 'OggS' || /ogg|opus/i.test(rec.mimeType)) {
      try { out = decodeOggOpus(bytes); } catch (e) { throw unreadable(e); }
    } else {
      const decodeAudio = this.ctx.deps.decodeAudio;
      if (!decodeAudio) throw new RpcError('unsupported', 'Only WAV and OGG/Opus recordings can be converted here.');
      try { out = await decodeAudio(bytes, rec.mimeType || 'application/octet-stream'); } catch (e) { throw unreadable(e); }
    }
    const pcm = new Uint8Array(out.pcm16.buffer, out.pcm16.byteOffset, out.pcm16.byteLength);
    const wav = this.ctx.s.files.upload(pcmToWav(pcm, out.sampleRate), rec.name.replace(/\.[^.]+$/, '') + '.wav', 'audio/wav');
    this.converted.set(fileId, wav);
    return wav;
  }

  /** a recording as 16 kHz mono samples */
  private async decode(o: TranscribeInput): Promise<Int16Array> {
    const bytes = o.audio;
    if (bytes.byteLength > MAX_INPUT_BYTES) throw new RpcError('invalid_params', 'That recording is too large.');
    const unreadable = (e: unknown) => new RpcError('invalid_params', `Could not read the recording: ${errMsg(e)}`);
    if (o.format !== 'ogg' && (isWav(bytes) || /wav/i.test(o.mimeType ?? ''))) {
      let wav: ReturnType<typeof wavDecode>;
      try { wav = wavDecode(bytes); } catch (e) { throw unreadable(e); }
      return resample(wav.pcm16, wav.sampleRate, VOICE_PCM_RATE);
    }
    if (o.format === 'pcm16') {
      if (bytes.byteLength % 2) throw new RpcError('invalid_params', 'PCM audio must have an even number of bytes (16-bit samples).');
      if (bytes.byteLength / 2 > VOICE_MAX_SECONDS * VOICE_PCM_RATE) {
        throw new RpcError('invalid_params', `Recordings can be ${VOICE_MAX_SECONDS / 60} minutes long at most.`);
      }
      // a view needs an even offset: a pooled Buffer's often isn't
      return bytes.byteOffset % 2 ? new Int16Array(bytes.slice().buffer) : new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    }
    if (o.format === 'ogg') {
      let ogg: ReturnType<typeof decodeOggOpus>;
      try { ogg = decodeOggOpus(bytes); } catch (e) { throw unreadable(e); }
      return resample(ogg.pcm16, ogg.sampleRate, VOICE_PCM_RATE);
    }
    const decodeAudio = this.ctx.deps.decodeAudio;
    if (!decodeAudio) throw new RpcError('unsupported', 'Only PCM, WAV and OGG/Opus recordings can be read here.');
    let out: { pcm16: Int16Array; sampleRate: number };
    try { out = await decodeAudio(bytes, o.mimeType ?? 'application/octet-stream'); } catch (e) { throw unreadable(e); }
    return resample(out.pcm16, out.sampleRate, VOICE_PCM_RATE);
  }

  /** sends `voice.status`: at once when a phase or busy flag moved, else (progress) at most every `STATUS_MS` */
  private changed(): void {
    const st = this.status();
    const shape = JSON.stringify([st.supported, st.models.map((m) => m.phase), st.busy]);
    const now = Date.now();
    if (shape !== this.lastShape || now - this.lastEmit >= STATUS_MS) {
      clearTimeout(this.trailing);
      this.trailing = undefined;
      this.emit(st, shape, now);
      return;
    }
    if (this.trailing) return;
    this.trailing = setTimeout(() => {
      this.trailing = undefined;
      const s = this.status();
      this.emit(s, JSON.stringify([s.supported, s.models.map((m) => m.phase), s.busy]), Date.now());
    }, STATUS_MS - (now - this.lastEmit));
    this.trailing.unref?.();
  }

  private emit(st: VoiceStatus, shape: string, at: number): void {
    this.lastShape = shape;
    this.lastEmit = at;
    this.ctx.bus.emit('voice.status', st);
  }
}

const asOgg = (r: Reading): SpeakResult => ({ audio: encodeOggOpus(r.pcm16, r.sampleRate), mimeType: 'audio/ogg', durationMs: r.durationMs, language: r.language });
const asWav = (r: Reading): SpeakResult => ({
  audio: pcmToWav(new Uint8Array(r.pcm16.buffer, r.pcm16.byteOffset, r.pcm16.byteLength), r.sampleRate), mimeType: 'audio/wav', durationMs: r.durationMs, language: r.language,
});

/** an engine's failure as what the client reads */
function toRpcError(e: unknown, kind: 'stt' | 'tts'): RpcError {
  if (e instanceof RpcError) return e;
  const what = kind === 'stt' ? 'hear the recording' : 'read that aloud';
  if (e instanceof VoiceEngineError) {
    if (e.code === 'runtime-unavailable') return new RpcError('unavailable', 'The speech runtime could not start on this computer.', { detail: e.message });
    if (e.code === 'model-load-failed') {
      return new RpcError('internal', `The ${kind === 'stt' ? 'speech' : 'voice'} model could not be loaded. Remove it in Settings › Voice and download it again.`, { detail: e.message });
    }
    if (e.code === 'timeout') return new RpcError('internal', `It took too long to ${what}.`);
  }
  return new RpcError('internal', `Could not ${what}: ${errMsg(e)}`);
}

/** at most `max` characters, cut after a sentence or a word where it can */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text.trim();
  const head = text.slice(0, max);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentence > max / 2) return head.slice(0, sentence + 1).trim();
  const space = head.lastIndexOf(' ');
  return (space > max / 2 ? head.slice(0, space) : head).trim();
}

/** below this a sample counts as silence (about -40 dBFS) */
const QUIET = 330;
/** silence kept before the first words, between parts and after the last words, in ms */
const LEAD_MS = 100;
const GAP_MS = 250;
const TAIL_MS = 200;

/**
 * The parts' readings as one: Supertonic pads each with ~0.4 s of silence on both sides, which between parts would be
 * a pause of most of a second; each part's silence is trimmed so parts join with a sentence's pause.
 */
export function joinReadings(parts: Int16Array[], rate: number): Int16Array {
  const keep = (ms: number) => Math.round((ms / 1000) * rate);
  const spans = parts.map((p, i) => {
    let a = 0;
    while (a < p.length && Math.abs(p[a]!) < QUIET) a++;
    let b = p.length;
    while (b > a && Math.abs(p[b - 1]!) < QUIET) b--;
    // silent through: nothing to keep
    if (a >= b) return null;
    const lead = i === 0 ? LEAD_MS : GAP_MS / 2;
    const tail = i === parts.length - 1 ? TAIL_MS : GAP_MS / 2;
    return p.subarray(Math.max(0, a - keep(lead)), Math.min(p.length, b + keep(tail)));
  }).filter((x): x is Int16Array => !!x);
  if (spans.length === 1) return spans[0]!.slice();
  const out = new Int16Array(spans.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of spans) { out.set(p, at); at += p.length; }
  return out;
}
