// Is that a voice? Loudness can't tell speech from a fan, a TV, typing or traffic, so every speech decision in voice
// mode (a turn starting and ending, where a segment is cut, a cut-in on the bot) asks a neural voice activity detector
// (Silero VAD v5, `silero.ts`) instead: one speech probability per 32 ms of the mic's 16 kHz samples. This file is the
// pure part: `VadFeed` cuts the samples into the model's frames and runs them in order (the model is passed in, a fake
// in tests), `VoiceActivity` turns the probabilities into speech with Silero's hysteresis (in at 0.5, out below 0.35).
// The loudness meter (`levels.ts`) only draws the orb, and decides alone while the model isn't there (it failed to load).

/** samples per frame (32 ms at 16 kHz) and its length */
export const VAD_FRAME = 512;
export const VAD_FRAME_MS = 32;
/** a frame this likely is speech; once in speech, it stays until a frame falls below `SPEECH_OFF` */
export const SPEECH_ON = 0.5;
export const SPEECH_OFF = 0.35;
/** speech that starts a turn (Silero's min speech) */
export const MIN_SPEECH_MS = 250;
/** quiet inside speech that doesn't start the count over (Silero's redemption) */
export const REDEMPTION_MS = 600;
/** frames waiting for the model past this many: the rest go on without it (the meter decides) until it catches up */
export const VAD_BACKLOG = 8;

/** The model: a frame's speech probability, its state carried from frame to frame. */
export interface VadModel {
  prob(frame: Float32Array): Promise<number>;
  /** a new stream starts: forget the state */
  reset(): void;
}

/** What the frames since the last look said. */
export interface VadTick {
  /** speech (with hysteresis) in any frame since */
  voiced: boolean;
  /** how much of it was speech (ms) */
  voicedMs: number;
  /** the most likely frame */
  prob: number;
}

/** Silero's hysteresis over the frames, read once per meter tick (`take`). */
export class VoiceActivity {
  /** the last frame was speech */
  speaking = false;
  private voicedMs = 0;
  private any = false;
  private max = 0;

  frame(prob: number): void {
    this.speaking = prob >= SPEECH_ON || (this.speaking && prob >= SPEECH_OFF);
    if (this.speaking) { this.any = true; this.voicedMs += VAD_FRAME_MS; }
    this.max = Math.max(this.max, prob);
  }

  /** The frames since the last look (none came: still where the last one left it). */
  take(): VadTick {
    const t: VadTick = { voiced: this.any || this.speaking, voicedMs: this.voicedMs, prob: this.max };
    this.any = false;
    this.voicedMs = 0;
    this.max = 0;
    return t;
  }

  reset(): void {
    this.speaking = false;
    this.take();
  }
}

/**
 * The mic's samples cut into the model's frames, each run in order and handed on with its probability (null: no
 * model, or too far behind). Every sample is handed on, in order, whatever the model does.
 */
export class VadFeed {
  private model: VadModel | null = null;
  private partial = new Int16Array(0);
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private behind = false;

  constructor(
    private readonly onFrame: (pcm: Int16Array, prob: number | null) => void,
    private readonly onFail?: (error: unknown) => void,
    private readonly onBehind?: (frames: number) => void,
  ) {}

  /** The model to ask from now on (null: none). */
  use(model: VadModel | null): void {
    this.model = model;
    model?.reset();
  }

  get active(): boolean { return this.model !== null; }

  push(samples: Int16Array): void {
    let s = samples;
    if (this.partial.length) {
      s = new Int16Array(this.partial.length + samples.length);
      s.set(this.partial);
      s.set(samples, this.partial.length);
    }
    let at = 0;
    for (; at + VAD_FRAME <= s.length; at += VAD_FRAME) this.queue(s.slice(at, at + VAD_FRAME));
    this.partial = s.slice(at);
  }

  /** Waits for every frame pushed so far (tests). */
  drain(): Promise<void> { return this.chain; }

  private queue(pcm: Int16Array): void {
    const model = this.model;
    // too far behind (a stalled window): hand frames on without asking, so hearing never falls behind the mic
    const skip = this.pending >= VAD_BACKLOG;
    if (skip && !this.behind) { this.behind = true; this.onBehind?.(this.pending); }
    if (!skip) this.behind = false;
    this.pending++;
    this.chain = this.chain.then(async () => {
      let prob: number | null = null;
      if (model && !skip && this.model === model) {
        try {
          prob = await model.prob(toFloat(pcm));
        } catch (e) {
          // a model that fails once isn't asked again: the meter decides from here
          if (this.model === model) { this.model = null; this.onFail?.(e); }
        }
      }
      this.pending--;
      this.onFrame(pcm, prob);
    });
  }
}

function toFloat(pcm: Int16Array): Float32Array {
  const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i]! / 32768;
  return f;
}
