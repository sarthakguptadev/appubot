/**
 * What runs the speech models in the app: two voice host processes (`src/main/voiceHost.ts`), one that hears and one
 * that speaks, so dictation never waits behind a reply being read. Each starts on first use (`fork` under
 * Electron-as-Node, like the MCP bridge), answers requests by id, and is let go after `IDLE_MS` without one (the
 * model's memory goes with it) and at shutdown; a lease (`hold`, voice mode's `voice.warm`) keeps it up meanwhile.
 * A host that exits or hangs fails what it was asked.
 */
import { fork } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { KOKORO_VOICES, SPEECH_VOICES, voiceFor, type SpeechLanguage, type SpeechVoice, type VoiceSttModelId, type VoiceTtsModelId } from '@appubot/protocol';
import { errMsg, silentLogger, type Logger } from '../util';
import type { VoiceEngine } from './voice';
import type { HostErrorCode, HostRequest, HostResponse, SttEngine, TtsEngine } from './voiceHostCore';

/** a host with nothing to do for this long exits */
export const IDLE_MS = 60_000;
/** Whisper hears Hindi at about 1.4x real time on Apple silicon: 3 min of it (`VOICE_MAX_SECONDS`) takes ~4 */
export const STT_TIMEOUT_MS = 360_000;
export const TTS_TIMEOUT_MS = 120_000;

export type VoiceEngineErrorCode = HostErrorCode | 'host-exited' | 'timeout';
export class VoiceEngineError extends Error {
  constructor(public code: VoiceEngineErrorCode, detail: string) {
    super(detail);
    this.name = 'VoiceEngineError';
  }
}

/** the part of a ChildProcess used here (a fake in tests) */
export interface HostChild extends EventEmitter {
  send(msg: unknown): boolean;
  kill(): boolean;
  readonly connected: boolean;
  stderr?: Readable | null;
}

export function forkVoiceHost(hostPath: string, execPath = process.execPath): HostChild {
  return fork(hostPath, [], {
    execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
}

type Body<R = HostRequest> = R extends HostRequest ? Omit<R, 'id'> : never;
interface Pending { resolve: (r: HostResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/** One host process: started on demand, requests matched to answers by id, let go when idle. */
export class HostConnection {
  private child: HostChild | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private idle: NodeJS.Timeout | undefined;
  /** a lease: not let go for being idle before this (ms, wall clock) */
  private heldUntil = 0;

  constructor(private o: { name: string; spawn: () => HostChild; idleMs?: number; log?: Logger }) {}

  get running(): boolean { return !!this.child; }

  /** Keeps the process (and its model) up, idle or not, until `until`; a later lease extends it. */
  hold(until: number): void {
    this.heldUntil = Math.max(this.heldUntil, until);
    if (this.child && !this.pending.size) this.armIdle();
  }

  request(body: Body, timeoutMs: number): Promise<HostResponse> {
    clearTimeout(this.idle);
    const child = this.ensure();
    const id = this.nextId++;
    return new Promise<HostResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VoiceEngineError('timeout', `voice host (${this.o.name}) took longer than ${Math.round(timeoutMs / 1000)}s`));
        // it is stuck on this request and would hold up every later one
        this.stop();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.send({ ...body, id });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new VoiceEngineError('host-exited', errMsg(e)));
      }
    });
  }

  /** ends the process; what it was asked fails with `host-exited` */
  stop(): void {
    clearTimeout(this.idle);
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.failAll('voice host stopped');
    try { child.kill(); } catch { /* gone already */ }
  }

  private ensure(): HostChild {
    if (this.child) return this.child;
    const log = this.o.log ?? silentLogger;
    const child = this.o.spawn();
    this.child = child;
    child.on('message', (res: HostResponse) => this.answer(res));
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = null;
      clearTimeout(this.idle);
      this.failAll(why);
    };
    child.on('exit', (code: number | null, signal: string | null) => {
      if (this.child === child) log.warn(`voice host (${this.o.name}) exited`, { code, signal });
      gone(`voice host exited (${signal ?? code})`);
    });
    child.on('error', (e: Error) => { log.warn(`voice host (${this.o.name}) failed`, errMsg(e)); gone(errMsg(e)); });
    if (child.stderr) createInterface({ input: child.stderr }).on('line', (line) => log.debug(`voice host (${this.o.name}): ${line}`));
    return child;
  }

  private answer(res: HostResponse): void {
    const p = this.pending.get(res?.id);
    if (!p) return;
    this.pending.delete(res.id);
    clearTimeout(p.timer);
    if ('error' in res) p.reject(new VoiceEngineError(res.error, res.detail));
    else p.resolve(res);
    if (!this.pending.size) this.armIdle();
  }

  private armIdle(): void {
    clearTimeout(this.idle);
    // idle for `idleMs`, and never while a lease runs
    const wait = Math.max(this.o.idleMs ?? IDLE_MS, this.heldUntil - Date.now());
    this.idle = setTimeout(() => this.stop(), wait);
    this.idle.unref?.();
  }

  private failAll(why: string): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) { clearTimeout(p.timer); p.reject(new VoiceEngineError('host-exited', why)); }
  }
}

/** how each speech model runs, and the silence some want before the words (Underdog Bark was scored with 0.25 s) */
export const STT_ENGINES: Record<VoiceSttModelId, { engine: SttEngine; leadMs?: number }> = {
  'parakeet-unified-en': { engine: 'nemo-transducer' },
  'cohere-transcribe': { engine: 'cohere' },
  'whisper-turbo': { engine: 'whisper' },
  'parakeet-tdt-0.6b-v2': { engine: 'nemo-transducer' },
  'parakeet-tdt-0.6b-v3': { engine: 'nemo-transducer' },
  'qwen3-asr-0.6b': { engine: 'qwen3' },
  'sensevoice-small': { engine: 'sense-voice' },
  'bark-3.0-plus': { engine: 'nemo-transducer', leadMs: 250 },
  'bark-3.0-clean': { engine: 'nemo-transducer', leadMs: 250 },
  'nemotron-3.5-asr': { engine: 'nemo-streaming' },
  'indicconformer-hi': { engine: 'nemo-ctc' },
};

/** how a voice of a voice model is asked for: its engine, the part of the model it needs, and its speaker id */
export function ttsVoice(model: VoiceTtsModelId, voice: SpeechVoice): { engine: TtsEngine; variant?: string; speakerId: number } {
  const id = voiceFor(model, voice);
  if (model === 'kokoro-en') {
    const k = KOKORO_VOICES.find(([, v]) => v === id) ?? KOKORO_VOICES[0]!;
    return { engine: 'kokoro', variant: k[1].startsWith('b') ? 'gb' : 'us', speakerId: k[0] };
  }
  return { engine: 'supertonic', speakerId: Math.max(0, (SPEECH_VOICES as readonly string[]).indexOf(id)) };
}

export interface HostVoiceEngineOptions {
  hostPath: string;
  addonPath: string;
  /** the Node that runs the hosts (unsent: this process's own) */
  execPath?: string;
  log?: Logger;
  /** override how a host starts (tests) */
  spawn?: () => HostChild;
  idleMs?: number;
}

export class HostVoiceEngine implements VoiceEngine {
  private stt: HostConnection;
  private tts: HostConnection;

  constructor(private o: HostVoiceEngineOptions) {
    const spawn = o.spawn ?? (() => forkVoiceHost(o.hostPath, o.execPath));
    this.stt = new HostConnection({ name: 'stt', spawn, idleMs: o.idleMs, log: o.log });
    this.tts = new HostConnection({ name: 'tts', spawn, idleMs: o.idleMs, log: o.log });
  }

  async transcribe(o: { pcm16: Int16Array; model: VoiceSttModelId; modelDir: string; language: string }): Promise<string> {
    const { engine, leadMs } = STT_ENGINES[o.model];
    const res = await this.stt.request({ type: 'transcribe', addonPath: this.o.addonPath, engine, modelDir: o.modelDir, language: o.language, pcm16: o.pcm16, ...(leadMs ? { leadMs } : {}) }, STT_TIMEOUT_MS);
    if (!('text' in res)) throw new VoiceEngineError('inference-failed', 'voice host answered without text');
    return res.text;
  }

  async speak(o: { text: string; language: SpeechLanguage; model: VoiceTtsModelId; voice: SpeechVoice; modelDir: string; steps?: number }): Promise<{ pcm16: Int16Array; sampleRate: number }> {
    const { engine, variant, speakerId } = ttsVoice(o.model, o.voice);
    const res = await this.tts.request({ type: 'speak', addonPath: this.o.addonPath, engine, ...(variant ? { variant } : {}), modelDir: o.modelDir, text: o.text, language: o.language, speakerId, ...(o.steps ? { numSteps: o.steps } : {}) }, TTS_TIMEOUT_MS);
    if (!('pcm16' in res)) throw new VoiceEngineError('inference-failed', 'voice host answered without audio');
    return { pcm16: res.pcm16, sampleRate: res.sampleRate };
  }

  async warm(o: { kind: 'stt'; model: VoiceSttModelId; modelDir: string; language: string } | { kind: 'tts'; model: VoiceTtsModelId; voice: SpeechVoice; modelDir: string }): Promise<void> {
    if (o.kind === 'stt') {
      await this.stt.request({ type: 'warm', kind: 'stt', addonPath: this.o.addonPath, engine: STT_ENGINES[o.model].engine, modelDir: o.modelDir, language: o.language }, STT_TIMEOUT_MS);
    } else {
      const { engine, variant } = ttsVoice(o.model, o.voice);
      await this.tts.request({ type: 'warm', kind: 'tts', addonPath: this.o.addonPath, engine, ...(variant ? { variant } : {}), modelDir: o.modelDir }, TTS_TIMEOUT_MS);
    }
  }

  hold(ms: number): void {
    const until = Date.now() + ms;
    this.stt.hold(until);
    this.tts.hold(until);
  }

  async shutdown(): Promise<void> {
    this.stt.stop();
    this.tts.stop();
  }
}
