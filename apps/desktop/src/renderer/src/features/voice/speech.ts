// Reading aloud in this window. One speaker for the app: texts queue up by owner (a reply's message id, or a preview),
// each part goes to `voice.speak` (nothing is stored; asked as WAV, which needs no encoding or decoding, and in voice
// mode as a live reading, with fewer model passes) and plays through Web Audio while the next part is already being
// made (a pipeline of one), so the voice runs on without gaps. Small parts queued meanwhile join into one request, no
// more than a few times the part before it (reading it takes less time than playing that one, so no gap opens).
// A part that fails to be made is asked for once more, then skipped (an `error` event, never a stalled queue), and
// one that never finishes playing is let go. `duck` lowers the voice while voice mode checks whether you cut in.
// `useReading` tells what is being read now and how loud it is, for the voice panel's waveform.
import { create } from 'zustand';
import { SPEECH_FIRST_PART_MAX, SPEECH_PART_GROWTH, SPEECH_PART_MAX, speechChunks, speechLanguage, speechText } from '@appubot/chat-core';
import { SPEECH_LANGUAGES, type SpeechLanguage, type SpeechVoice } from '@appubot/protocol';
import { errorMessage, rpc } from '../../lib/gateway';
import { getState } from '../../lib/store';
import { LEVEL_INTERVAL_MS } from './levels';
import { analyserLevel, fromBase64 } from './audio';
import { DUCK_GAIN } from './bargeIn';
import { voiceLog } from './voiceLog';

/** times a part is asked for before it is skipped */
export const SPEAK_TRIES = 2;
/** a part still playing this long after its length has stalled (the output went away): it is let go */
export const STALL_MS = 3000;
/** how quickly ducking takes hold (s, the gain's time constant) */
const DUCK_TIME = 0.04;

export interface Reading {
  /** whose words are playing (a message id, or 'preview'); null when nothing is */
  owner: string | null;
  /** the part playing now */
  text: string;
  paused: boolean;
  /** the voice's loudness now, 0..1 */
  level: number;
  /** when the part now playing started (ms, wall clock) */
  startedAt: number;
}

const IDLE: Reading = { owner: null, text: '', paused: false, level: 0, startedAt: 0 };
export const useReading = create<Reading>(() => IDLE);

interface Job {
  owner: string;
  text: string;
  language: SpeechLanguage;
  voice?: SpeechVoice;
  /** a live conversation's reading: sooner, a little less polish */
  live?: boolean;
  audio?: Promise<AudioBuffer | null>;
}

export interface SpeakerEvents {
  /** a part of `owner`'s starts playing */
  start?: (owner: string, text: string) => void;
  /** nothing of `owner`'s is left to play (it ran out, or was stopped) */
  idle?: (owner: string) => void;
  error?: (owner: string, message: string) => void;
}

let ctx: AudioContext | null = null;
/** Its own audio context, so pausing a reading never stops the microphone's meter; small buffers, so it starts at once. */
function playback(): AudioContext {
  if (!ctx || ctx.state === 'closed') ctx = new AudioContext({ latencyHint: 'interactive' });
  return ctx;
}

/** the dev mock's readings: silences as long as the voice would take */
const silences = new WeakSet<AudioBuffer>();

const isLanguage = (x: string): x is SpeechLanguage => (SPEECH_LANGUAGES as readonly string[]).includes(x);

/** The language to read a text in: the one Settings › Voice names, else guessed from the text. */
/**
 * Who reads aloud: the computer on screen, unless voice mode says this Mac does (another computer's chat whose own
 * voice isn't there yet: macVoice.ts).
 */
let speakCall: typeof rpc = rpc;
export function readThrough(call: typeof rpc | null): void { speakCall = call ?? rpc; }

export function readingLanguage(text: string): SpeechLanguage {
  const set = getState().settings?.voice.language ?? 'auto';
  return speechLanguage(text, isLanguage(set) ? set : 'en');
}

export class Speaker {
  private queue: Job[] = [];
  private gen = 0;
  private pumping = false;
  private source: AudioBufferSourceNode | null = null;
  private finish: (() => void) | null = null;
  private analyser: AnalyserNode | null = null;
  private gain: GainNode | null = null;
  private ducked = false;
  private meter: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<SpeakerEvents>();

  on(events: SpeakerEvents): () => void {
    this.listeners.add(events);
    return () => { this.listeners.delete(events); };
  }

  /** Queue words to read (already plain text, as `speechText` gives); `live`: voice mode's conversation; `voice`: another than the settings' (a sample). */
  enqueue(owner: string, text: string, language: SpeechLanguage, o: { live?: boolean; voice?: SpeechVoice } = {}): void {
    const t = text.trim();
    if (!t) return;
    const voice = o.voice ?? getState().settings?.voice.voice;
    // more of a reading under way follows on from its last part; only a reading's first words are cut short
    const last = this.queue[this.queue.length - 1];
    for (const part of speechChunks(t, language, last && last.owner === owner ? { after: last.text.length } : {})) this.queue.push({ owner, text: part, language, voice, ...(o.live ? { live: true } : {}) });
    this.prefetch();
    void this.pump();
  }

  /** Read a whole Markdown reply. */
  read(owner: string, markdown: string): void {
    const words = speechText(markdown);
    this.enqueue(owner, words, readingLanguage(words));
  }

  /** Something of `owner`'s (anyone's, without one) is queued or playing. */
  busy(owner?: string): boolean {
    return this.queue.some((j) => !owner || j.owner === owner);
  }

  /** Stop reading (only `owner`'s words, when given: another owner's reading goes on). */
  stop(owner?: string): void {
    const hit = (j: Job) => !owner || j.owner === owner;
    if (!this.queue.some(hit)) return;
    const owners = new Set(this.queue.filter(hit).map((j) => j.owner));
    const head = this.queue[0]!;
    this.queue = this.queue.filter((j) => !hit(j));
    if (hit(head)) {
      this.gen++;
      this.pumping = false;
      this.halt();
      this.duck(false);
      if (useReading.getState().paused) void playback().resume();
      useReading.setState(IDLE);
    }
    for (const o of owners) this.emit('idle', o);
    if (this.queue.length) void this.pump();
  }

  pause(): void {
    if (!this.source) return;
    void playback().suspend();
    useReading.setState({ paused: true });
  }

  resume(): void {
    void playback().resume();
    useReading.setState({ paused: false });
  }

  /** Lowers the voice to `DUCK_GAIN` (it goes on playing), or brings it back; parts that start meanwhile follow. */
  duck(on: boolean): void {
    if (this.ducked === on) return;
    this.ducked = on;
    const g = this.gain;
    if (!g) return;
    const now = playback().currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setTargetAtTime(on ? DUCK_GAIN : 1, now, DUCK_TIME);
  }

  private emit<K extends keyof SpeakerEvents>(kind: K, ...args: Parameters<NonNullable<SpeakerEvents[K]>>): void {
    for (const l of this.listeners) (l[kind] as ((...a: unknown[]) => void) | undefined)?.(...args);
  }

  /**
   * The part after the one playing is made now; parts queued behind it join it (same owner), up to a part's size and
   * `SPEECH_PART_GROWTH` times the part before it, so it is read before that one has finished playing.
   */
  private prefetch(): void {
    for (const k of [0, 1]) {
      const job = this.queue[k];
      if (!job || job.audio) continue;
      // the head with nothing playing is what is heard first: short
      const max = k ? Math.min(SPEECH_PART_MAX, Math.max(SPEECH_FIRST_PART_MAX, this.queue[k - 1]!.text.length * SPEECH_PART_GROWTH)) : SPEECH_FIRST_PART_MAX;
      while (this.queue[k + 1] && this.queue[k + 1]!.owner === job.owner && !this.queue[k + 1]!.audio
        && job.text.length + 1 + this.queue[k + 1]!.text.length <= max) {
        job.text += ` ${this.queue.splice(k + 1, 1)[0]!.text}`;
      }
      job.audio = this.synth(job);
    }
  }

  /** A part's audio: asked for up to `SPEAK_TRIES` times; null (and an `error` event) when it can't be had. */
  private async synth(job: Job): Promise<AudioBuffer | null> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.speakOnce(job);
      } catch (e) {
        const message = errorMessage(e);
        // stopped meanwhile: nobody waits for it
        const wanted = this.queue.includes(job);
        if (wanted && attempt < SPEAK_TRIES) {
          voiceLog('speak failed, trying again', { owner: job.owner, chars: job.text.length, message });
          continue;
        }
        voiceLog('speak failed, part skipped', { owner: job.owner, chars: job.text.length, message });
        if (wanted) this.emit('error', job.owner, message);
        return null;
      }
    }
  }

  private async speakOnce(job: Job): Promise<AudioBuffer> {
    const res = await speakCall('voice.speak', { text: job.text, language: job.language, format: 'wav', ...(job.live ? { live: true } : {}), ...(job.voice ? { voice: job.voice } : {}) }, { timeoutMs: job.live ? 30_000 : 60_000 });
    const ac = playback();
    // the dev mock has no voice: a silence as long as the reading would be
    if (!res.audio) {
      const silence = ac.createBuffer(1, Math.max(1, Math.round((res.durationMs / 1000) * ac.sampleRate)), ac.sampleRate);
      silences.add(silence);
      return silence;
    }
    return await ac.decodeAudioData(fromBase64(res.audio));
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const gen = this.gen;
    while (gen === this.gen && this.queue.length) {
      this.prefetch();
      const job = this.queue[0]!;
      const buf = await job.audio!;
      if (gen !== this.gen) return;
      if (buf) {
        this.emit('start', job.owner, job.text);
        await this.play(job, buf, gen);
        if (gen !== this.gen) return;
      }
      this.queue.shift();
      if (!this.queue.length) useReading.setState(IDLE);
      // that owner's reading ran out (more of a streaming reply may still come)
      if (!this.queue.some((j) => j.owner === job.owner)) this.emit('idle', job.owner);
    }
    // a stop meanwhile may have let a new loop start: that one owns the flag now
    if (gen === this.gen) this.pumping = false;
  }

  private play(job: Job, buf: AudioBuffer, gen: number): Promise<void> {
    const ac = playback();
    if (!this.analyser || !this.gain) {
      // source → gain (ducking) → analyser (the level, as heard) → speakers
      this.gain = ac.createGain();
      this.gain.gain.value = this.ducked ? DUCK_GAIN : 1;
      this.analyser = ac.createAnalyser();
      this.analyser.fftSize = 512;
      this.gain.connect(this.analyser);
      this.analyser.connect(ac.destination);
    }
    const analyser = this.analyser;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    this.source = src;
    const { paused } = useReading.getState();
    useReading.setState({ owner: job.owner, text: job.text, paused, level: 0, startedAt: Date.now() });
    const samples = new Float32Array(analyser.fftSize);
    // the mock's silence still moves the bars a little, so the panel can be looked at
    const silent = silences.has(buf);
    // how long it has played, not counting a pause: past its length (and `STALL_MS`) it has stalled
    let playedMs = 0;
    const lengthMs = buf.duration * 1000;
    if (this.meter) clearInterval(this.meter);
    this.meter = setInterval(() => {
      const held = useReading.getState().paused;
      const level = silent ? 0.25 + 0.2 * Math.sin(Date.now() / 140) * Math.sin(Date.now() / 370) : analyserLevel(analyser, samples);
      useReading.setState({ level: held ? 0 : level });
      if (held) return;
      if (ac.state === 'suspended') void ac.resume().catch(() => undefined);
      playedMs += LEVEL_INTERVAL_MS;
      if (playedMs > lengthMs + STALL_MS && gen === this.gen && this.source === src) {
        voiceLog('reading stalled, part let go', { owner: job.owner, ms: Math.round(lengthMs), output: ac.state });
        this.emit('error', job.owner, 'The voice stopped playing.');
        this.halt();
      }
    }, LEVEL_INTERVAL_MS);
    return new Promise<void>((resolve) => {
      this.finish = resolve;
      src.onended = () => {
        if (gen === this.gen) this.halt();
        resolve();
      };
      if (!paused) void ac.resume().catch(() => undefined);
      src.start();
    });
  }

  /** Silences what plays and lets its promise go. */
  private halt(): void {
    const src = this.source;
    this.source = null;
    if (src) {
      src.onended = null;
      try { src.stop(); } catch { /* not started */ }
      src.disconnect();
    }
    if (this.meter) { clearInterval(this.meter); this.meter = null; }
    useReading.setState({ level: 0 });
    this.finish?.();
    this.finish = null;
  }
}

export const speaker = new Speaker();
