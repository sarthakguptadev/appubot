// Talking over the bot, verified (as ChatGPT's voice mode does it). Echo cancellation still leaves some of the bot's
// voice in the microphone, and speech the model can't make out still sounds loud, so a loud moment alone never stops
// a reading. First a candidate: `BARGE_IN_MS` of what the VAD calls speech (`vad.ts`; noise never is), standing
// clearly above what the echo of the voice playing now could be (`bargeInLevel`, against the loudest output of the
// last moment, `EchoMeter`) and coming near the
// loudness of the user's own voice, learned from the turns they sent (`VoiceLevel`): someone talking across the room,
// a TV, or the echo that gets past echo cancellation reach the mic tens of dB fainter than you do. Then the reading is
// ducked (it goes on, quieter) while the candidate's audio is heard (`verifyCutIn`): only words that aren't the bot's
// own (`novelty`: the heard words aligned in order with what it just read) cut the reading short; its echo, nothing,
// a filler or noise lets it go on at full volume. Pure, so it runs in tests.

/** loudness and length that make a candidate while nothing plays (the bot thinks) */
export const BARGE_IN_LEVEL = 0.5;
export const BARGE_IN_MS = 500;
/** a dip this short inside the loud run doesn't end it (speech has gaps between syllables) */
export const BARGE_IN_GAP_MS = 100;
/** while the bot speaks the mic must beat its echo: output level × `ECHO_K` + `ECHO_MARGIN`, never above `BARGE_IN_MAX` */
export const ECHO_K = 0.8;
export const ECHO_MARGIN = 0.15;
export const BARGE_IN_MAX = 0.85;
/** the output's loudest over this long counts (the echo comes back a little later than it plays) */
export const ECHO_WINDOW_MS = 300;
/** a cut-in comes within this many dB of the user's own voice (smoothed dBFS, as `VoiceLevel` learns it) */
export const VOICE_DB_MARGIN = 20;
/** turns the user's voice level is learned from (the median of their loudness) */
export const VOICE_TURNS = 5;
/** loud ticks a turn needs to teach it */
const VOICE_MIN_TICKS = 4;
/** the reading's volume while a candidate is checked */
export const DUCK_GAIN = 0.2;
/** listening this long with the reading ducked before hearing the candidate (the voice stands out better) */
export const VERIFY_AFTER_MS = 250;
/** audio kept from before the loud run began (a word's start) */
export const VERIFY_PRE_MS = 300;
/** the most audio heard for a check */
export const VERIFY_MAX_MS = 2500;
/** nothing heard while you still talk: once more after this much more audio */
export const VERIFY_RETRY_MS = 400;
/** novel words that make a cut-in: this many (and at least `MIN_NOVEL_SHARE` of them), or `NOVEL_SHARE` of them */
export const NOVEL_WORDS = 2;
export const NOVEL_SHARE = 0.6;
export const MIN_NOVEL_SHARE = 0.25;

/** How loud the mic must be to start a candidate, given the bot's output level (0 when nothing plays). */
export function bargeInLevel(echo: number): number {
  return Math.min(BARGE_IN_MAX, Math.max(BARGE_IN_LEVEL, echo * ECHO_K + ECHO_MARGIN));
}

/** The bot's loudest output over the last `ECHO_WINDOW_MS`. */
export class EchoMeter {
  private points: { level: number; at: number }[] = [];

  /** Notes the output level now; returns the loudest of the window. */
  note(level: number, now: number): number {
    this.points.push({ level, at: now });
    while (this.points.length && now - this.points[0]!.at > ECHO_WINDOW_MS) this.points.shift();
    let max = 0;
    for (const p of this.points) if (p.level > max) max = p.level;
    return max;
  }

  reset(): void { this.points = []; }
}

/** A dB reading smoothed like the level (quick up, slower down), so a tick between syllables doesn't drop it. */
export function smoothDb(prev: number, db: number): number {
  return prev + (db - prev) * (db > prev ? 0.6 : 0.3);
}

/** How loud the user's own voice reaches the mic: the median, over their last turns, of each turn's loud ticks' p75. */
export class VoiceLevel {
  private turns: number[] = [];

  /** One sent turn's loud ticks (smoothed dBFS). */
  learn(dbs: readonly number[]): void {
    if (dbs.length < VOICE_MIN_TICKS) return;
    const s = [...dbs].sort((a, b) => a - b);
    this.turns = [...this.turns, s[Math.floor(s.length * 0.75)]!].slice(-VOICE_TURNS);
  }

  /** null until a turn has taught it */
  get db(): number | null {
    if (!this.turns.length) return null;
    const s = [...this.turns].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  }
}

/** sounds, not words: a speech model writes them for a breath, a hum or a backchannel */
const FILLERS = new Set(['mm', 'mmm', 'mhm', 'hmm', 'hm', 'uh', 'uhh', 'um', 'umm', 'uhm', 'ah', 'ahh', 'oh', 'er', 'erm', 'eh', 'huh']);
/** what speech models (Whisper above all) make of noise or silence, when heard alone */
const NOISE = new Set(['you', 'thank you', 'thanks for watching', 'thank you for watching', 'thank you so much for watching', 'bye', 'bye bye']);

/** A text's words, lowercased, without punctuation, English contractions spelt out ("I'm" is "i am"). */
export function speechWords(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().replace(/[’`]/g, "'")
    .replace(/n't\b/g, ' not').replace(/'m\b/g, ' am').replace(/'re\b/g, ' are').replace(/'ve\b/g, ' have').replace(/'ll\b/g, ' will').replace(/'d\b/g, ' would')
    .replace(/'/g, '')
    .split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
}

/** The same word, allowing for a mishearing: one edit in a word of 4+ letters, two in one of 8+. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  const max = n >= 8 ? 2 : n >= 4 ? 1 : 0;
  if (!max || Math.abs(a.length - b.length) > max) return false;
  // Levenshtein, one row
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (row[j]! < best) best = row[j]!;
    }
    if (best > max) return false;
    prev = row;
  }
  return prev[b.length]! <= max;
}

/** How many of `heard` line up, in order, with words of `read` (the longest common subsequence). */
function aligned(heard: string[], read: string[]): number {
  if (!heard.length || !read.length) return 0;
  let prev = new Array<number>(read.length + 1).fill(0);
  for (let i = 1; i <= heard.length; i++) {
    const row = new Array<number>(read.length + 1).fill(0);
    for (let j = 1; j <= read.length; j++) {
      row[j] = sameWord(heard[i - 1]!, read[j - 1]!) ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!);
    }
    prev = row;
  }
  return prev[read.length]!;
}

export interface Novelty {
  /** words heard (fillers left out) */
  words: number;
  /** of those, the ones that aren't the bot's own words in the order it read them */
  novel: number;
}

/** How much of what was heard isn't what the bot just read. */
export function novelty(heard: string, read: string): Novelty {
  const h = speechWords(heard).filter((w) => !FILLERS.has(w));
  return { words: h.length, novel: h.length - aligned(h, speechWords(read)) };
}

/** Enough of the words are the user's own (not the bot's echo). */
export function ownWords({ words, novel }: Novelty): boolean {
  if (!words) return false;
  const share = novel / words;
  return share >= NOVEL_SHARE || (novel >= NOVEL_WORDS && share >= MIN_NOVEL_SHARE);
}

/** What a speech model writes for noise, heard on its own. */
export function isNoise(heard: string): boolean {
  return NOISE.has(speechWords(heard).join(' '));
}

export interface CutInVerdict {
  /** cut the reading short: the user is talking */
  cut: boolean;
  text: string;
  reason: string;
  novelty: Novelty;
  /** times it was heard (1, or 2 when the first heard nothing while the user still talked) */
  tries: number;
}

export interface CutInChecker {
  /** the recording's last `ms` of samples (16 kHz) */
  audio(ms: number): Promise<Int16Array | null>;
  hear(pcm: Int16Array): Promise<string>;
  /** what the bot read lately (asked when the verdict is made) */
  read(): string;
  /** the user is making sound right now */
  loud(): boolean;
  /** the check still matters (no Interrupt button, end or new recording meanwhile) */
  live(): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * Checks a candidate whose loud run lasted `runMs`, with the reading already ducked: waits `VERIFY_AFTER_MS`, hears
 * the candidate's audio (and what came before it, `VERIFY_PRE_MS`) and says whether it cuts the reading. Heard nothing
 * while the user still talks: once more, with more audio. Null when the check stopped mattering meanwhile.
 */
export async function verifyCutIn(runMs: number, c: CutInChecker): Promise<CutInVerdict | null> {
  const t0 = c.now();
  await c.sleep(VERIFY_AFTER_MS);
  let text = '';
  let tries = 0;
  for (;;) {
    if (!c.live()) return null;
    tries++;
    try {
      const pcm = await c.audio(Math.min(VERIFY_MAX_MS, runMs + VERIFY_PRE_MS + (c.now() - t0)));
      if (!c.live()) return null;
      text = pcm?.length ? (await c.hear(pcm)).trim() : '';
    } catch (e) {
      if (!c.live()) return null;
      return { cut: false, text: '', reason: `couldn’t hear it (${e instanceof Error ? e.message : String(e)})`, novelty: { words: 0, novel: 0 }, tries };
    }
    if (!c.live()) return null;
    if (text || tries >= 2 || !c.loud()) break;
    await c.sleep(VERIFY_RETRY_MS);
  }
  const n = novelty(text, c.read());
  const verdict = (cut: boolean, reason: string): CutInVerdict => ({ cut, text, reason, novelty: n, tries });
  if (!text) return verdict(false, 'nothing heard');
  if (!n.words) return verdict(false, 'only a filler');
  if (isNoise(text)) return verdict(false, 'noise');
  if (!ownWords(n)) return verdict(false, 'the bot’s own words');
  return verdict(true, 'your own words');
}
