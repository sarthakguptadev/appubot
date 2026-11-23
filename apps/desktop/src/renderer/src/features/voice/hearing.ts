// One recording's words, heard while it is spoken: the microphone's samples go through a `Segmenter`, and each segment
// it cuts is sent to be heard at once, in parallel with the speaker going on. When the turn ends only the rest is left
// (usually a moment of quiet, nothing to hear), so its words are ready almost at once. Segments cut before the turn
// detector heard speech wait: speech makes them count; a cut-in on the bot drops them (they were the bot's own echo),
// all but those that end after the user began. `tail` hands out the last moment of the recording, for checking a
// cut-in's words. The hearing itself is passed in (`voice.transcribe` in the app, a fake in tests). A segment far
// fainter than your voice isn't heard, and silence-hallucinated words are dropped (`gate`, `endpoint.ts`); `whole`
// (Whisper, which hears short pieces worse) hears the whole turn once at its end, the segments only for the captions.
import { VOICE_PCM_RATE } from '@appubot/protocol';
import { pcmPeakDb } from './endpoint';
import { Segmenter, joinSegments } from './segmenter';

export type Hear = (pcm: Int16Array) => Promise<string>;

export interface HearingOptions {
  /** audio that peaked this low (dBFS) isn't heard */
  quiet?: (peakDb: number) => boolean;
  /** words heard from audio of that peak that are only the model's silence hallucination */
  junk?: (text: string, peakDb: number) => boolean;
  /** at the end, hear the whole turn once instead of joining the segments' words */
  whole?: boolean;
}

export interface Heard {
  text: string;
  /** how many parts were heard */
  segments: number;
  /** the recording's length (ms) */
  durationMs: number;
}

/** the most audio kept for hearing it all again if a segment fails: a turn's longest */
const KEEP_SAMPLES = 120 * VOICE_PCM_RATE;
/** the last moment always kept, for `tail` */
const RECENT_SAMPLES = 5 * VOICE_PCM_RATE;

export class Hearing {
  private readonly seg = new Segmenter();
  /** what each segment was heard as, in order (null until it is) */
  private readonly texts: (string | null)[] = [];
  private readonly heard: Promise<void>[] = [];
  /** segments cut before speech was heard, with where they ended (samples into the recording) */
  private held: { pcm: Int16Array; end: number }[] = [];
  private accepted = false;
  private failed = false;
  /** every sample of the recording, to hear it whole if a segment can't be */
  private all: Int16Array[] = [];
  private kept = 0;
  /** the last few seconds, whatever the length */
  private recent: Int16Array[] = [];
  private recentLength = 0;
  /** the words last handed to `onText` */
  private shown = '';
  /** where the turn begins (samples into the recording): after a cut-in, what came before was the bot's echo */
  private from = 0;

  constructor(private readonly hear: Hear, private readonly onText?: (text: string) => void, private readonly opts: HearingOptions = {}) {}

  /** The microphone's next samples (16 kHz), with the VAD's speech probability for them (`Segmenter.push`). */
  push(pcm: Int16Array, prob?: number | null): void {
    const copy = pcm.slice();
    if (this.kept < KEEP_SAMPLES) { this.all.push(copy); this.kept += copy.length; }
    this.recent.push(copy);
    this.recentLength += copy.length;
    while (this.recentLength - this.recent[0]!.length >= RECENT_SAMPLES) this.recentLength -= this.recent.shift()!.length;
    for (const s of this.seg.push(pcm, prob)) {
      if (this.accepted) this.send(s);
      else this.held.push({ pcm: s, end: this.seg.total });
    }
  }

  /** Speech was heard: what was cut so far counts too. */
  accept(): void {
    if (this.accepted) return;
    this.accepted = true;
    for (const s of this.held) this.send(s.pcm);
    this.held = [];
  }

  /** The user cut in on the bot, `keepMs` ago: what was cut before that was its echo. */
  cutIn(keepMs = 0): void {
    const from = this.seg.total - (keepMs / 1000) * VOICE_PCM_RATE;
    this.from = Math.max(0, Math.floor(from));
    this.held = this.held.filter((s) => s.end > from);
    this.accept();
  }

  /** The recording's last `ms` (as much as there is, up to a few seconds). */
  tail(ms: number): Int16Array {
    const want = Math.min(this.recentLength, Math.round((ms / 1000) * VOICE_PCM_RATE));
    const out = new Int16Array(want);
    let at = want;
    for (let k = this.recent.length - 1; k >= 0 && at > 0; k--) {
      const p = this.recent[k]!;
      const take = Math.min(at, p.length);
      out.set(p.subarray(p.length - take), at - take);
      at -= take;
    }
    return out;
  }

  /** The words so far (those heard, up to the first still being heard). */
  get text(): string {
    const done: string[] = [];
    for (const t of this.texts) { if (t === null) break; done.push(t); }
    return joinSegments(done);
  }

  /** The last segment's words, once every segment sent is heard (null: none yet, or one still being heard). */
  get lastText(): string | null {
    if (this.texts.some((t) => t === null)) return null;
    for (let k = this.texts.length - 1; k >= 0; k--) if (this.texts[k]) return this.texts[k]!;
    return null;
  }

  get durationMs(): number { return Math.round((this.seg.total / VOICE_PCM_RATE) * 1000); }

  /** The turn is over: everything said, heard in order. */
  async finish(): Promise<Heard> {
    this.accept();
    const rest = this.seg.rest();
    // the rest is heard when it holds sound, or when nothing else was cut (the turn detector heard speech somewhere)
    const durationMs = this.durationMs;
    if (this.opts.whole) return { text: await this.hearWhole(), segments: 1, durationMs };
    if (rest.voiced || (!this.texts.length && rest.pcm.length)) this.send(rest.pcm);
    await Promise.all(this.heard);
    // a part couldn't be heard: the whole recording once more, in one piece
    if (this.failed) return { text: await this.hearWhole(), segments: 1, durationMs };
    return { text: joinSegments(this.texts.map((t) => t ?? '')), segments: this.texts.length, durationMs };
  }

  /** The turn (since `from`) heard in one piece. */
  private async hearWhole(): Promise<string> {
    const whole = new Int16Array(Math.max(0, this.kept - this.from));
    let g = 0;
    for (const p of this.all) {
      // g: where p begins in the recording; s: where the turn begins in p
      const s = Math.max(0, this.from - g);
      const to = g + s - this.from;
      if (s < p.length) whole.set(p.subarray(s, s + whole.length - to), to);
      g += p.length;
      if (g - this.from >= whole.length) break;
    }
    if (!whole.length) return '';
    const peak = pcmPeakDb(whole);
    if (this.opts.quiet?.(peak)) return '';
    const text = (await this.hear(whole)).trim();
    return this.opts.junk?.(text, peak) ? '' : joinSegments([text]);
  }

  private send(pcm: Int16Array): void {
    const peak = this.opts.quiet || this.opts.junk ? pcmPeakDb(pcm) : 0;
    // far fainter than your voice: nothing to hear
    if (this.opts.quiet?.(peak)) return;
    const k = this.texts.length;
    this.texts.push(null);
    this.heard.push(this.hear(pcm).then(
      (t) => {
        this.texts[k] = this.opts.junk?.(t.trim(), peak) ? '' : t.trim();
        const text = this.text;
        if (text && text !== this.shown) { this.shown = text; this.onText?.(text); }
      },
      () => { this.texts[k] = ''; this.failed = true; },
    ));
  }
}
