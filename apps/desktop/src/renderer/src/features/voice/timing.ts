// How long a spoken turn takes, stage by stage, from the moment voice mode notices you stopped (`endQuietMs` after
// your last sound): your words heard, sent, the bot's first words, the first piece queued to read, its first sound.
// One line per turn goes to the voice log (`voiceLog.ts`, always printed); with `appubot.voiceDebug` = 1 in
// localStorage voice mode also shows the last turns, the last `KEEP` of which stay in memory for that readout.
import { create } from 'zustand';
import { voiceLog } from './voiceLog';

export const TIMING_MARKS = ['heard', 'sent', 'firstText', 'firstPiece', 'firstAudio'] as const;
export type TimingMark = (typeof TIMING_MARKS)[number];

export interface TurnTiming {
  id: number;
  /** when the turn's end was noticed (wall clock) */
  at: number;
  /** the quiet waited for before that */
  quietMs: number;
  /** ms after the turn's end was noticed */
  marks: Partial<Record<TimingMark, number>>;
  /** parts the words were heard in */
  segments?: number;
  /** how it ended without a first sound (interrupted, nothing heard…) */
  note?: string;
}

const KEEP = 20;
const DEBUG_KEY = 'appubot.voiceDebug';
const LABELS: Record<TimingMark, string> = { heard: 'heard', sent: 'sent', firstText: 'first words', firstPiece: 'first piece', firstAudio: 'first sound' };

export const useVoiceTimings = create<{ turns: TurnTiming[] }>(() => ({ turns: [] }));

export function voiceDebugOn(): boolean {
  try { return localStorage.getItem(DEBUG_KEY) === '1'; } catch { return false; }
}

/** One turn as a line: each stage's time since the turn's end was noticed, and the whole wait since you stopped. */
export function formatTiming(t: TurnTiming): string {
  const parts = TIMING_MARKS.flatMap((m) => (t.marks[m] === undefined ? [] : [`${LABELS[m]} ${t.marks[m]}`]));
  const end = t.marks.firstAudio;
  const whole = end === undefined ? '' : ` (${t.quietMs + end} ms after you stopped)`;
  const seg = t.segments ? ` · ${t.segments} part${t.segments === 1 ? '' : 's'}` : '';
  return `quiet ${t.quietMs} · ${parts.join(' · ')} ms${whole}${seg}${t.note ? ` · ${t.note}` : ''}`;
}

let nextId = 1;

/** A turn's clock, started when its end is noticed. */
export class TurnClock {
  private readonly t0 = performance.now();
  readonly record: TurnTiming;
  private closed = false;

  constructor(quietMs: number) {
    this.record = { id: nextId++, at: Date.now(), quietMs, marks: {} };
  }

  /** A stage reached (only the first time counts); the first sound ends the record. */
  mark(m: TimingMark): void {
    if (this.closed || this.record.marks[m] !== undefined) return;
    this.record.marks[m] = Math.round(performance.now() - this.t0);
    if (m === 'firstAudio') this.close();
    else this.publish();
  }

  set segments(n: number) { this.record.segments = n; }

  /** The turn ended without (more) sound: `note` says why. */
  close(note?: string): void {
    if (this.closed) return;
    this.closed = true;
    if (note && this.record.marks.firstAudio === undefined) this.record.note = note;
    this.publish();
    voiceLog(`timing ${formatTiming(this.record)}`);
  }

  private publish(): void {
    const copy = { ...this.record, marks: { ...this.record.marks } };
    useVoiceTimings.setState((s) => ({ turns: [...s.turns.filter((t) => t.id !== copy.id), copy].slice(-KEEP) }));
  }
}
