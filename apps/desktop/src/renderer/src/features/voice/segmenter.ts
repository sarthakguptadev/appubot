// Hearing while you speak: the microphone's 16 kHz samples cut into segments at the pauses between your phrases, so
// each is heard (`voice.transcribe`) while you go on talking and only the last is left when the turn ends. The speech
// model hears whole stretches of audio, so a cut only falls in a real pause, never inside a word: the middle of at
// least `PAUSE_MS` without speech. Speech is what the VAD says (`vad.ts`: samples pushed with its probability, so a fan
// or typing is a pause like silence); samples pushed without one are judged by loudness (20 ms frames against an
// adaptive noise floor and a decaying speech peak). Pure, so it runs in tests and the latency script.
import { VOICE_PCM_RATE } from '@appubot/protocol';
import { SPEECH_OFF, SPEECH_ON } from './vad';

/** 20 ms frames */
const FRAME = VOICE_PCM_RATE / 50;
const FRAME_MS = 20;
/** quiet that cuts a segment */
export const PAUSE_MS = 300;
/** past this length a segment is cut at a shorter pause, so the one left at the end is never long */
export const LONG_SEGMENT_MS = 8000;
export const LONG_PAUSE_MS = 160;
/** a segment is at least this long (a word alone is heard worse than a phrase) */
export const MIN_SEGMENT_MS = 1000;
/** speech a segment needs before it is cut */
const MIN_SPEECH_MS = 200;
/** what is kept before a segment's first speech */
export const PRE_ROLL_MS = 400;
/** sound (anything not quiet) the rest needs to be worth hearing */
const MIN_SOUND_MS = 100;

const FLOOR_MIN_DB = -90;
const FLOOR_MAX_DB = -25;
/** the noise floor rises 1 dB a second; the speech peak falls 2.5 dB a second */
const FLOOR_RISE_DB = 0.02;
const PEAK_FALL_DB = 0.05;
/** the span between floor and peak assumed until speech shows how loud it is */
const MIN_SPAN_DB = 20;
/** where speech starts and quiet ends, as parts of that span */
const SPEECH_AT = 0.5;
const QUIET_BELOW = 0.3;
/** speech also stands this far above the floor */
const SPEECH_MIN_DB = 12;

function frameDb(s: Int16Array, from: number): number {
  let sum = 0;
  for (let i = from; i < from + FRAME; i++) { const v = s[i]! / 32768; sum += v * v; }
  return 20 * Math.log10(Math.sqrt(sum / FRAME) + 1e-10);
}

type Kind = 'speech' | 'quiet' | 'sound';

export class Segmenter {
  /** the current segment, frame by frame */
  private frames: Int16Array[] = [];
  /** samples short of a whole frame */
  private partial = new Int16Array(0);
  private speechFrames = 0;
  private soundFrames = 0;
  /** the quiet run at the end of the segment, in frames */
  private quietRun = 0;
  private floor = -60;
  private peak = -60 + MIN_SPAN_DB;
  private taken = 0;
  /** the last frame the VAD judged was speech (its hysteresis) */
  private voiced = false;

  /** samples taken in so far */
  get total(): number { return this.taken; }

  /**
   * Takes in samples, with the VAD's speech probability for them (its frames are the pushes; none: judged by
   * loudness); returns the segments they complete (cut at a pause), oldest first.
   */
  push(samples: Int16Array, prob?: number | null): Int16Array[] {
    this.taken += samples.length;
    let s = samples;
    if (this.partial.length) {
      s = new Int16Array(this.partial.length + samples.length);
      s.set(this.partial);
      s.set(samples, this.partial.length);
    }
    const out: Int16Array[] = [];
    let at = 0;
    for (; at + FRAME <= s.length; at += FRAME) {
      const cut = this.frame(s.slice(at, at + FRAME), prob);
      if (cut) out.push(cut);
    }
    this.partial = s.slice(at);
    return out;
  }

  /** What is left since the last cut, and whether it holds any sound worth hearing (not only quiet). */
  rest(): { pcm: Int16Array; voiced: boolean } {
    const pcm = concat([...this.frames, this.partial]);
    return { pcm, voiced: this.speechFrames > 0 || this.soundFrames * FRAME_MS >= MIN_SOUND_MS };
  }

  private classify(f: Int16Array, prob?: number | null): Kind {
    const db = frameDb(f, 0);
    if (db < this.floor) this.floor = Math.max(FLOOR_MIN_DB, db);
    else this.floor = Math.min(FLOOR_MAX_DB, this.floor + Math.min(db - this.floor, FLOOR_RISE_DB));
    this.peak = Math.max(db, this.peak - PEAK_FALL_DB, this.floor + MIN_SPAN_DB);
    // the VAD's word: speech or not, however loud
    if (prob !== undefined && prob !== null) {
      this.voiced = prob >= SPEECH_ON || (this.voiced && prob >= SPEECH_OFF);
      return this.voiced ? 'speech' : 'quiet';
    }
    const span = this.peak - this.floor;
    if (db >= this.floor + SPEECH_AT * span && db >= this.floor + SPEECH_MIN_DB) return 'speech';
    if (db < this.floor + QUIET_BELOW * span) return 'quiet';
    return 'sound';
  }

  /** one frame in; a finished segment out when this frame completes a pause */
  private frame(f: Int16Array, prob?: number | null): Int16Array | null {
    const kind = this.classify(f, prob);
    this.frames.push(f);
    if (kind === 'quiet') this.quietRun++;
    else {
      this.quietRun = 0;
      if (kind === 'speech') this.speechFrames++;
      else this.soundFrames++;
    }
    // nothing said yet: keep only a moment before it
    if (!this.speechFrames) {
      const keep = PRE_ROLL_MS / FRAME_MS;
      if (this.frames.length > keep) {
        // the sound being dropped no longer counts
        const dropped = this.frames.splice(0, this.frames.length - keep);
        if (this.soundFrames && dropped.length) this.soundFrames = Math.min(this.soundFrames, this.frames.length);
      }
      return null;
    }
    const length = this.frames.length * FRAME_MS;
    const pause = length - this.quietRun * FRAME_MS >= LONG_SEGMENT_MS ? LONG_PAUSE_MS : PAUSE_MS;
    if (this.quietRun * FRAME_MS < pause || this.speechFrames * FRAME_MS < MIN_SPEECH_MS) return null;
    // the middle of the pause
    const cutAt = this.frames.length - this.quietRun + Math.floor(this.quietRun / 2);
    if (cutAt * FRAME_MS < MIN_SEGMENT_MS) return null;
    const segment = concat(this.frames.slice(0, cutAt));
    this.frames = this.frames.slice(cutAt);
    this.quietRun = this.frames.length;
    this.speechFrames = 0;
    this.soundFrames = 0;
    return segment;
  }
}

function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A whole recording cut as voice mode cuts it while it comes in (50 ms at a time); the rest last, if it holds sound. */
export function splitAtPauses(pcm: Int16Array): Int16Array[] {
  const seg = new Segmenter();
  const out: Int16Array[] = [];
  const step = VOICE_PCM_RATE / 20;
  for (let i = 0; i < pcm.length; i += step) out.push(...seg.push(pcm.subarray(i, i + step)));
  const rest = seg.rest();
  if (rest.voiced || !out.length) out.push(rest.pcm);
  return out;
}

/**
 * The segments' words as one message. The speech model ends a segment as if its sentence were over: a full stop
 * before words that go on in lowercase is dropped ("I want to." + "go home" reads "I want to go home").
 */
export function joinSegments(texts: string[]): string {
  let out = '';
  for (const raw of texts) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (out && /^\p{Ll}/u.test(t)) out = out.replace(/(?<![.…])\.$/u, '');
    out = out ? `${out} ${t}` : t;
  }
  return out;
}
