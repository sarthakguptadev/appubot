// When a spoken turn starts and ends (OpenBot's voice loop, our own code). Fed the microphone's level every tick, and
// what the voice activity detector heard since the last one (`vad.ts`: speech, not loudness, so a fan, a TV or typing
// is never a turn; without it, loudness alone decides), it says when speech began, when the turn is over (a pause after speech), when an idle recording should start over
// (so it never grows while nobody talks), and, while the bot thinks or speaks (`guard`), when the user may be cutting
// in: a 'candidate' takes `BARGE_IN_MS` of speech clearly louder than the echo of what the bot plays and near the user's own voice
// level (`bargeIn.ts`), for longer; voice mode then checks its words before it stops the reading. A run loud enough
// but far fainter than the user's voice says 'faint' once a recording (for the log).
import { BARGE_IN_GAP_MS, BARGE_IN_MS, EchoMeter, VOICE_DB_MARGIN, bargeInLevel, smoothDb } from './bargeIn';
import { LEVEL_INTERVAL_MS } from './levels';
import { MIN_SPEECH_MS, REDEMPTION_MS, type VadTick } from './vad';

/** loudness that counts as speech while listening, and for how long (without the VAD; with it, `MIN_SPEECH_MS`) */
export const SPEECH_LEVEL = 0.3;
export const SPEECH_MS = 240;
/** quiet after speech that ends the turn by default (voice mode sets `endQuietMs` from the words so far, `endpoint.ts`) */
export const END_QUIET_MS = 700;
/** a recording with no speech starts over this often, at a pause */
export const IDLE_RESTART_MS = 4000;
/** how long it must have been quiet before an idle recording may start over */
const RESTART_QUIET_MS = 500;
/** the longest turn */
export const MAX_TURN_MS = 120_000;

export type TurnSignal = 'speech' | 'candidate' | 'faint' | 'end' | 'restart' | null;

/** What made a candidate (or a faint run), for the log. */
export interface Candidate {
  /** the mic's level when it fired, and its loudest in the run */
  level: number;
  peak: number;
  /** the bot's output level it had to beat, and the level that took */
  echo: number;
  need: number;
  /** how long the loud run lasted (ms) */
  runMs: number;
  /** the VAD's speech probability when it fired (undefined: loudness alone) */
  vad?: number;
  /** its loudness (smoothed dBFS) against the user's own voice (null: not learned yet) */
  db: number;
  voiceDb: number | null;
}

export class TurnDetector {
  /** the bot is thinking or speaking: only a cut-in counts */
  guard = false;
  /** speech was heard in this recording */
  heard = false;
  /** the last candidate's numbers (or the faint run's) */
  candidate: Candidate | null = null;
  /** the user's own voice level (smoothed dBFS, `VoiceLevel`); null: any loudness may cut in */
  voiceDb: number | null = null;
  /** the quiet that ends this turn now (asked again every tick, so a shorter one ends a long-quiet turn at once) */
  endQuietMs = END_QUIET_MS;
  /** the last tick was speech (the VAD's, else loud enough) */
  speechTick = false;
  private startedAt = 0;
  private loudMs = 0;
  private peak = 0;
  private dipMs = 0;
  private faintMs = 0;
  private faintSaid = false;
  /** quiet since the last speech, while listening (the VAD's redemption) */
  private quietMs = 0;
  private smoothed = -100;
  private lastLoudAt = -Infinity;
  private lastFeed = -Infinity;
  private readonly echo = new EchoMeter();

  /** A new recording starts now. */
  reset(now: number, guard = this.guard): void {
    this.guard = guard;
    this.heard = false;
    this.candidate = null;
    this.startedAt = now;
    this.loudMs = 0;
    this.peak = 0;
    this.dipMs = 0;
    this.faintMs = 0;
    this.faintSaid = false;
    this.quietMs = 0;
    this.speechTick = false;
    this.lastLoudAt = -Infinity;
    this.lastFeed = -Infinity;
    this.echo.reset();
  }

  /** The mic's loudness now (smoothed dBFS). */
  get db(): number { return this.smoothed; }

  /** Someone is talking right now (a speech-loud tick within the last moment). */
  loudAt(now: number): boolean { return now - this.lastLoudAt < RESTART_QUIET_MS; }

  /**
   * One tick: the mic's level, the bot's output level now (0 when nothing plays), the mic's raw dBFS (without it, the
   * user's voice level isn't asked for) and the VAD's frames since the last tick (without it, loudness is speech).
   */
  feed(level: number, now: number, output = 0, db?: number, vad?: VadTick): TurnSignal {
    // the time since the last tick (one tick's worth for the first), so a stalled timer can't fake a long sound
    const dt = Number.isFinite(this.lastFeed) ? Math.min(250, Math.max(0, now - this.lastFeed)) : LEVEL_INTERVAL_MS;
    this.lastFeed = now;
    const echo = this.echo.note(output, now);
    if (db !== undefined) this.smoothed = smoothDb(this.smoothed, db);
    // speech: what the VAD says (noise of any loudness isn't), else loud enough
    const speech = vad ? vad.voiced : level >= SPEECH_LEVEL;
    this.speechTick = speech;
    if (speech) this.lastLoudAt = now;

    if (this.guard) {
      const need = bargeInLevel(echo);
      const near = db === undefined || this.voiceDb === null || this.smoothed >= this.voiceDb - VOICE_DB_MARGIN;
      const numbers = (): Candidate => ({ level, peak: this.peak, echo, need, runMs: this.loudMs, db: this.smoothed, voiceDb: this.voiceDb, ...(vad ? { vad: vad.prob } : {}) });
      // a cut-in is speech (the VAD's), louder than the bot's echo and near your own voice
      const loud = level >= need && (!vad || vad.voiced);
      if (loud && near) {
        // only the time the VAD heard speech counts
        this.loudMs += vad ? Math.min(250, vad.voicedMs) : dt;
        this.peak = Math.max(this.peak, level);
        this.dipMs = 0;
      } else if ((this.dipMs += dt) > BARGE_IN_GAP_MS) {
        this.loudMs = 0;
        this.peak = 0;
      }
      if (this.loudMs >= BARGE_IN_MS) {
        this.heard = true;
        this.guard = false;
        this.candidate = numbers();
        return 'candidate';
      }
      // loud enough to cut in, but far fainter than the user's voice: someone else, or the bot's echo
      this.faintMs = loud && !near ? this.faintMs + dt : 0;
      if (this.faintMs >= BARGE_IN_MS && !this.faintSaid) {
        this.faintSaid = true;
        this.candidate = { ...numbers(), runMs: this.faintMs };
        return 'faint';
      }
    } else if (vad) {
      // Silero's: speech adds up across short pauses, and starts over after `REDEMPTION_MS` of none
      if (vad.voicedMs > 0) { this.loudMs += vad.voicedMs; this.quietMs = 0; }
      else if (!speech && (this.quietMs += dt) >= REDEMPTION_MS) this.loudMs = 0;
      if (!this.heard && this.loudMs >= MIN_SPEECH_MS) {
        this.heard = true;
        return 'speech';
      }
    } else {
      this.loudMs = speech ? this.loudMs + dt : 0;
      if (!this.heard && this.loudMs >= SPEECH_MS) {
        this.heard = true;
        return 'speech';
      }
    }
    if (this.heard && now - this.lastLoudAt >= this.endQuietMs) return 'end';
    if (now - this.startedAt >= MAX_TURN_MS) return this.heard ? 'end' : 'restart';
    if (!this.heard && now - this.startedAt >= IDLE_RESTART_MS && !this.loudAt(now)) return 'restart';
    return null;
  }
}
