// When a spoken turn is over, and when it was never speech. A pause after a finished sentence ends the turn soon; a
// pause mid-sentence (people stop to think, above all in a language they speak slower in for the model) waits longer,
// so the rest isn't cut off. The words heard so far say which (segments are heard while you speak, `hearing.ts`), and
// the wait is asked again on every tick, so a transcript that comes in late ends a long-quiet turn at once. A turn (or
// segment) far fainter than your own voice is never heard at all, and what Whisper writes for silence ("you",
// "Thank you.", one word over and over) is dropped when the audio was quiet. Pure, so it runs in tests.
import type { Settings } from '@appubot/protocol';
import { VOICE_PCM_RATE, findVoiceModel } from '@appubot/protocol';
import { isNoise, speechWords } from './bargeIn';

/** quiet that ends a turn after a finished sentence, and after one left open (or nothing heard yet) */
export const END_SENTENCE_MS = 700;
export const END_OPEN_MS = 1500;
/** the same for Whisper or a language other than English (slower speech, slower words) */
export const END_SENTENCE_CAREFUL_MS = 900;
export const END_OPEN_CAREFUL_MS = 1800;
/** a turn or segment this far below your own voice (smoothed dBFS) is not speech */
export const QUIET_MARGIN_DB = 25;
/** the same before your voice level is learned */
export const QUIET_ABS_DB = -50;
/** a silence hallucination is dropped when the audio peaked this far below your voice (or below `HUSH_ABS_DB`) */
export const HUSH_MARGIN_DB = 12;
export const HUSH_ABS_DB = -35;
/** after a turn is sent, speech this soon (before the reply makes a sound) continues it */
export const GRACE_MS = 1500;

/** The text ends a sentence: `.?!।॥…`, maybe followed by a closing quote or bracket. */
export function endsSentence(text: string): boolean {
  return /[.?!।॥…。？！]["'”’»)\]]*\s*$/u.test(text);
}

/** The settings hear slowly or in another language: a slow model (Whisper, Qwen3-ASR), or a language other than English. */
export function carefulHearing(voice: Pick<Settings['voice'], 'sttModel' | 'language'> | undefined): boolean {
  if (!voice) return false;
  return !!findVoiceModel(voice.sttModel)?.slow || (voice.language !== 'auto' && !/^en\b/i.test(voice.language));
}

/** The quiet that ends the turn, given the last segment's words (null: none heard yet). */
export function endQuietMs(last: string | null, careful: boolean): number {
  const done = last !== null && endsSentence(last);
  if (careful) return done ? END_SENTENCE_CAREFUL_MS : END_OPEN_CAREFUL_MS;
  return done ? END_SENTENCE_MS : END_OPEN_MS;
}

/** The loudest 20 ms frame of some audio (dBFS RMS; -100 for none). */
export function pcmPeakDb(pcm: Int16Array): number {
  const frame = VOICE_PCM_RATE / 50;
  let peak = -100;
  for (let at = 0; at < pcm.length; at += frame) {
    const end = Math.min(pcm.length, at + frame);
    let sum = 0;
    for (let i = at; i < end; i++) { const v = pcm[i]! / 32768; sum += v * v; }
    peak = Math.max(peak, 20 * Math.log10(Math.sqrt(sum / (end - at)) + 1e-10));
  }
  return peak;
}

/** Audio that peaked this low is no speech of yours (`voiceDb`: your learned voice level, null if not yet). */
export function tooQuiet(peakDb: number, voiceDb: number | null): boolean {
  return peakDb < (voiceDb === null ? QUIET_ABS_DB : voiceDb - QUIET_MARGIN_DB);
}

/** What Whisper writes for silence: a stock phrase, punctuation alone, or one or two words said over and over. */
export function silenceHallucination(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const words = speechWords(t);
  if (!words.length) return true;
  if (isNoise(t) || /^(thanks?( you)?( (very|so) much)?( for watching)?|bye( bye)?|please subscribe)$/.test(words.join(' '))) return true;
  for (const unit of [1, 2]) {
    if (words.length < unit * 3 || words.length % unit) continue;
    if (words.every((w, i) => w === words[i % unit])) return true;
  }
  return false;
}

/** Words heard from quiet audio that are only what the model makes of silence. */
export function junkHeard(text: string, peakDb: number, voiceDb: number | null): boolean {
  return silenceHallucination(text) && peakDb < (voiceDb === null ? HUSH_ABS_DB : voiceDb - HUSH_MARGIN_DB);
}
