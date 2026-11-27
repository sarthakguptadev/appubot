// Voice mode: a spoken conversation with the bot on screen. It listens, sends what
// you said once you pause (with its recording, for replay), reads the reply aloud as it streams, and listens again.
// Everything that can happen ahead does: the speech models stay loaded and the bot's agent is started while voice mode
// is open (`voice.warm`, `threads.warm`), what you say is heard phrase by phrase while you speak (`Hearing`), the
// recording uploads while the last words are heard, and the first piece read may end at a comma. The mic stays open
// while the bot thinks and speaks, so you can talk over it: a voice clearly louder than the bot's echo makes a
// candidate, the reading is ducked while its words are heard, and only words that aren't the bot's own cut the reading
// short (`bargeIn.ts`); what you say then becomes the next message, and the bot's turn itself runs on. Its echo or
// noise lets the reading go on, and a turn that began while the bot was reading is only sent when it holds words of
// your own. The Interrupt button cuts it short at once. One conversation at a time, for the bot (and thread) on
// screen: `store.voiceMode` says which. What is speech (a turn starting and ending, the phrases cut, a cut-in) is the
// voice activity detector's call (Silero, `vad.ts`), never loudness alone, so a fan, a TV or typing neither starts a
// turn nor stops the reading; the meter only draws the orb (and decides while the VAD isn't loaded, or where it failed
// to). Each turn's timing: `timing.ts`; what happened: `voiceLog.ts`. A turn ends
// sooner after a finished sentence than mid-sentence, and audio far fainter than your voice (or Whisper's words for
// silence) is never sent (`endpoint.ts`). The next recording opens as soon as a turn ends: speech within `GRACE_MS` of
// it being sent, before the reply makes a sound, continues it (the bot's turn is cancelled and both parts go as one).
import { create } from 'zustand';
import type { Message, SpeechLanguage } from '@appubot/protocol';
import { findVoiceModel } from '@appubot/protocol';
import { loadConversation, sentShown, showSending, unsentShown } from '../../lib/actions';
import { activeComputer, errorMessage, localGateway, rpc, upload } from '../../lib/gateway';
import { native } from '../../lib/native';
import { getState, isVoiceBarView, mergeConversation, setState, touchConversation, ui, useStore } from '../../lib/store';
import { capturePcm, closeStream, createMeter, createRecorder, openMic, recordingToPcm16, setMicDevice, toBase64, type Meter, type PcmCapture, type Recording } from './audio';
import { VERIFY_PRE_MS, VoiceLevel, novelty, ownWords, verifyCutIn } from './bargeIn';
import { playEarcon } from './earcons';
import { GRACE_MS, carefulHearing, endQuietMs, junkHeard, tooQuiet } from './endpoint';
import { Hearing, type Heard } from './hearing';
import { readiness } from './models';
import { askedForVoice } from './DownloadNotice';
import { activeVoiceRoute, currentVoiceRoute, followMacDownload, hearingGateway, readMacVoice, setActiveVoiceRoute, useMacVoice } from './macVoice';
import { HERE, macReadiness, readsFromAfar, type VoiceRoute } from './voiceRoute';
import { loadVad, preloadVad } from './silero';
import { firstClauseMin, speakableEnd, speakablePiece } from './speakable';
import { readingLanguage, speaker, useReading } from './speech';
import { TurnClock } from './timing';
import { joinSegments } from './segmenter';
import { TurnDetector } from './turnDetector';
import { VadFeed, VoiceActivity } from './vad';
import { voiceLog } from './voiceLog';

/** how often the speech models' lease is renewed while voice mode is open (it runs out after `VOICE_WARM_MS`) */
const WARM_EVERY_MS = 20_000;
/** the parts read last that a cut-in's words are held against (its echo can only be of these) */
const SAID_KEEP = 4;
/** the longest a cut-in's words may take to be heard */
const VERIFY_TIMEOUT_MS = 10_000;

export type VoicePhase = 'starting' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'offline' | 'error';

export interface VoiceConversationState {
  phase: VoicePhase;
  /** the mic is off until unmuted (the bot still speaks) */
  muted: boolean;
  /** what you said: live while you speak, then the message sent */
  heard: string;
  /** the part of the reply being read now */
  said: string;
  /** the mic's loudness now, 0..1 */
  level: number;
  error: string | null;
}

const IDLE: VoiceConversationState = { phase: 'starting', muted: false, heard: '', said: '', level: 0, error: null };
export const useVoiceState = create<VoiceConversationState>(() => IDLE);
const set = (patch: Partial<VoiceConversationState>) => useVoiceState.setState(patch);

/** The bot's reply being followed and read as it streams. */
interface Reply {
  id: string;
  threadId: string;
  /** how much of its text has gone to the speaker */
  spoken: number;
  /** the message is complete: once its reading ends, listen again */
  done: boolean;
  language: SpeechLanguage | null;
  /** the copy last looked at (the store hands out a new one on every change) */
  seen: Message | null;
  /** it asks a question: you answer by voice, so it listens meanwhile */
  awaiting: boolean;
  /** pieces queued to read so far */
  pieces: number;
  /** the turn's timing, when it was spoken here */
  clock?: TurnClock;
}

/** The words of a reply so far: its text parts, not thoughts, tool calls or plans. */
export function replyText(m: Message): string {
  return m.parts.flatMap((p) => (p.type === 'text' && p.text.trim() ? [p.text] : [])).join('\n\n');
}

/** A cut-in being checked, with the reading ducked meanwhile. */
interface Check {
  rec: Recording;
  /** when the reading was ducked (wall clock) */
  at: number;
  /** when the loud run began */
  onset: number;
  /** the turn's pause came while it was checked: it ends once the check lets it */
  ended: boolean;
  /** the mic's loudest while ducked */
  duckedPeak: number;
}

/** A turn sent (or being heard and sent), which speech soon after it may still continue. */
interface Sent {
  /** what it said (the words sent, or '' when nothing was), once heard */
  text: Promise<string>;
  /** speech up to then continues it (Infinity until it is sent) */
  until: number;
  /** the reply has made a sound: too late to continue it */
  played: boolean;
  /** a continuation took it over: not sent, or its reply cancelled */
  continued: boolean;
  threadId: string | null;
  /** the bot's reply to it, once sent */
  messageId: string | null;
}

/** The question the bot waits on in a thread (the message it is in), from the messages loaded here. */
function openQuestionIn(threadId: string): { questionId: string; messageId: string } | null {
  const c = getState().convo[threadId];
  if (!c) return null;
  for (let k = c.ids.length - 1; k >= 0; k--) {
    const m = c.byId[c.ids[k]!];
    if (!m || m.role !== 'agent') continue;
    const q = m.status === 'streaming' ? [...m.parts].reverse().find((p) => p.type === 'question' && p.answer === undefined) : undefined;
    return q && q.type === 'question' ? { questionId: q.questionId, messageId: m.id } : null;
  }
  return null;
}

class Session {
  alive = true;
  /** the speech models are there: the mic may open */
  private ready = false;
  private stream: MediaStream | null = null;
  private meter: Meter | null = null;
  /** the mic's samples as they come (null where it can't run: each recording is then heard when it ends) */
  private capture: PcmCapture | null = null;
  private rec: Recording | null = null;
  /** what the current recording has heard so far */
  private hearing: Hearing | null = null;
  private readonly det = new TurnDetector();
  /** the mic's samples through the VAD, on to hearing; what it heard, read every meter tick */
  private vadFeed: VadFeed | null = null;
  private readonly activity = new VoiceActivity();
  /** how loud your own voice reaches the mic, learned from the turns you sent (a cut-in must come near it) */
  private readonly voiceLevel = new VoiceLevel();
  /** the current recording's loud ticks while nothing played (smoothed dBFS), to learn it from */
  private loudDbs: number[] = [];
  /** the current recording's loudest tick (raw dBFS) */
  private peakDb = -100;
  /** the last turn, while speech may still continue it */
  private last: Sent | null = null;
  /** the turn the current recording continues */
  private joined: Sent | null = null;
  /** the current recording heard the bot's voice playing (its turn must then hold words of your own) */
  private overlap = false;
  /** a cut-in in the current recording was checked and let through */
  private verified = false;
  private check: Check | null = null;
  /** the parts read last, oldest first */
  private said: string[] = [];
  /** the replies read here (their speaker errors show) */
  private readonly owners = new Set<string>();
  /** the speaker's error on show, cleared when a part plays again */
  private speakError: string | null = null;
  private reply: Reply | null = null;
  private warmTimer: ReturnType<typeof setInterval> | null = null;
  /** where hearing and reading run (voiceRoute.ts): this Mac for both, unless another computer is on screen */
  private route: VoiceRoute = HERE;
  private readonly offSpeaker: () => void;

  constructor(readonly botId: string, public threadId: string | null) {
    this.offSpeaker = speaker.on({
      start: (owner, text) => {
        this.said = [...this.said, text].slice(-SAID_KEEP);
        if (this.last && owner === this.last.messageId) this.last.played = true;
        const r = this.reply;
        if (!r || owner !== r.id) return;
        voiceLog('reading', { text });
        r.clock?.mark('firstAudio');
        if (this.speakError && useVoiceState.getState().error === this.speakError) set({ error: null });
        this.speakError = null;
        set({ phase: 'speaking', said: text });
      },
      idle: (owner) => { if (owner === this.reply?.id) this.readingPaused(); },
      error: (owner, message) => {
        if (!this.owners.has(owner)) return;
        voiceLog('reading error', { message });
        this.speakError = `Couldn’t read part of the reply aloud: ${message}`;
        set({ error: this.speakError });
      },
    });
  }

  async start(): Promise<void> {
    voiceLog('voice mode', { botId: this.botId, threadId: this.threadId ?? undefined });
    set({ phase: 'starting', error: null });
    if (getState().conn !== 'connected') { set({ phase: 'offline' }); return; }
    // the bot's agent starts now, so the first turn doesn't wait for it
    void rpc('threads.warm', { botId: this.botId, ...(this.threadId ? { threadId: this.threadId } : {}), session: true }).catch(() => undefined);
    // and the VAD loads while the speech models are checked
    preloadVad();
    try {
      // another computer on screen: this Mac hears (and reads, where that computer has no voice yet): voiceRoute.ts
      if (activeComputer() === 'cloud') await readMacVoice().catch(() => undefined);
      this.route = currentVoiceRoute();
      if (!this.route.hear) throw new Error(useMacVoice.getState().voice?.reason ?? getState().voice?.reason ?? 'Speech can’t run on this computer.');
      setActiveVoiceRoute(this.route);
      await this.ensureModels();
      if (!this.alive) return;
      // ready to listen: its chime (once a session; a retry after a failure is a new start)
      if (!this.ready) playEarcon('start');
      this.ready = true;
      this.keepWarm();
      if (useVoiceState.getState().muted) this.settle();
      else await this.openMic();
    } catch (e) {
      if (this.alive) set({ phase: 'error', error: errorMessage(e) });
    }
  }

  /** The speech models load now and stay loaded while voice mode is open (a lease, renewed). */
  private keepWarm(): void {
    const warm = () => {
      if (!this.alive || getState().conn !== 'connected') return;
      if (this.route.hear !== 'mac') { void rpc('voice.warm').catch(() => undefined); return; }
      // this Mac hears: its speech model stays loaded here (and its voice, when it also reads), the other
      // computer's voice there
      void localGateway().call('voice.warm', this.route.speak === 'mac' ? {} : { only: 'speech' }).catch(() => undefined);
      if (this.route.speak === 'screen') void rpc('voice.warm', { only: 'voice' }).catch(() => undefined);
    };
    warm();
    if (this.warmTimer) clearInterval(this.warmTimer);
    this.warmTimer = setInterval(warm, WARM_EVERY_MS);
  }

  /** Downloads what voice needs if it's missing (the panel shows the progress) and waits until it's there. */
  private async ensureModels(): Promise<void> {
    if (this.route.hear === 'mac') { await this.ensureMacModels(); return; }
    const first = readiness(getState().voice, getState().settings);
    if (first.state === 'ready') return;
    if (first.state === 'unsupported') throw new Error(first.message);
    // asked for: the chat's line shows the download too once voice mode is left before it's done
    askedForVoice();
    setState({ voice: await rpc('voice.prepare') });
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        const r = readiness(getState().voice, getState().settings);
        if (!this.alive || r.state === 'ready') { unsub(); resolve(); }
        else if (r.state === 'error' || r.state === 'unsupported') { unsub(); reject(new Error(r.message)); }
      };
      const unsub = useStore.subscribe(check);
      check();
    });
  }

  /** The same for this Mac's half while another computer is on screen: its speech model, and its voice when it reads. */
  private async ensureMacModels(): Promise<void> {
    const now = () => macReadiness(this.route, useMacVoice.getState().voice, useMacVoice.getState().settings) ?? { state: 'ready' as const };
    const first = now();
    if (first.state === 'ready') return;
    if (first.state === 'unsupported') throw new Error(first.message);
    useMacVoice.setState({ voice: await localGateway().call('voice.prepare', this.route.speak === 'mac' ? {} : { only: 'speech' }) });
    followMacDownload();
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        const r = now();
        if (!this.alive || r.state === 'ready') { unsub(); resolve(); }
        else if (r.state === 'error' || r.state === 'unsupported') { unsub(); reject(new Error(r.message)); }
      };
      const unsub = useMacVoice.subscribe(check);
      check();
    });
  }

  private async openMic(): Promise<void> {
    if (this.stream) return;
    const stream = await openMic();
    if (!this.alive || useVoiceState.getState().muted || this.stream) { closeStream(stream); return; }
    this.stream = stream;
    this.meter = createMeter(stream, (level, now, db) => this.onLevel(level, now, db));
    const feed = new VadFeed(
      (pcm, prob) => {
        if (this.vadFeed !== feed) return;
        if (prob !== null) this.activity.frame(prob);
        this.hearing?.push(pcm, prob);
      },
      (e) => voiceLog('vad failed', { message: errorMessage(e), fallback: 'loudness' }),
      (frames) => voiceLog('vad behind', { frames }),
    );
    const capture = await capturePcm(stream, (pcm) => feed.push(pcm));
    // muted or ended meanwhile
    if (this.stream !== stream) { capture?.stop(); return; }
    this.capture = capture;
    this.vadFeed = feed;
    this.activity.reset();
    if (capture) this.startVad(feed);
    else voiceLog('vad off', { why: 'no live samples', fallback: 'loudness' });
    this.newRecording();
    this.settle();
  }

  /** The VAD loads (the first time only) while the mic opens; until it's there, loudness decides. */
  private startVad(feed: VadFeed): void {
    const t0 = performance.now();
    loadVad().then(
      (model) => {
        if (this.vadFeed !== feed) return;
        feed.use(model);
        voiceLog('vad ready', { ms: Math.round(performance.now() - t0) });
      },
      (e: unknown) => {
        voiceLog('vad unavailable', { message: errorMessage(e), fallback: 'loudness' });
        console.warn('[voice] the VAD couldn’t load; loudness decides what is speech', e);
      },
    );
  }

  private closeMic(): void {
    this.dropCheck();
    this.vadFeed?.use(null);
    this.vadFeed = null;
    this.rec?.discard();
    this.rec = null;
    this.hearing = null;
    this.capture?.stop();
    this.capture = null;
    this.meter?.stop();
    this.meter = null;
    closeStream(this.stream);
    this.stream = null;
    set({ level: 0 });
  }

  /** A fresh recording (and hearing); while the bot thinks or speaks only a cut-in counts. */
  private newRecording(): void {
    this.dropCheck();
    this.rec?.discard();
    this.rec = this.stream ? createRecorder(this.stream) : null;
    const v = getState().settings?.voice;
    const h = this.rec && this.capture
      ? new Hearing(
        (pcm) => hear(pcm).then((text) => { voiceLog('heard', { ms: pcmMs(pcm), text }); return text; }),
        (text) => { if (this.alive && this.hearing === h) set({ heard: text }); },
        {
          quiet: (peak) => {
            const q = tooQuiet(peak, this.voiceLevel.db);
            if (q) voiceLog('segment too quiet', { peakDb: peak, voiceDb: this.voiceLevel.db ?? undefined });
            return q;
          },
          junk: (text, peak) => {
            const j = junkHeard(text, peak, this.voiceLevel.db);
            if (j) voiceLog('segment dropped', { why: 'silence hallucination', text, peakDb: peak });
            return j;
          },
          // Whisper (and IndicConformer) hear a whole utterance better than its pieces: those are only the captions
          whole: !!(v && findVoiceModel(v.sttModel)?.hearsWhole),
        },
      )
      : null;
    this.hearing = h;
    this.overlap = !!useReading.getState().owner;
    this.verified = false;
    this.loudDbs = [];
    this.peakDb = -100;
    this.joined = null;
    this.det.reset(Date.now(), !!this.reply && !this.reply.awaiting);
  }

  /** A cut-in's check no longer matters: the reading's volume comes back. */
  private dropCheck(): void {
    if (!this.check) return;
    this.check = null;
    speaker.duck(false);
  }

  /** What the bot read last, its echo's only source. */
  private readAloud(): string { return this.said.join(' '); }

  /** The phase that follows from where things are. */
  private settle(): void {
    if (!this.alive) return;
    const r = this.reply;
    const phase = getState().conn !== 'connected' ? 'offline'
      : !this.ready ? 'starting'
        : r && !r.awaiting ? (useReading.getState().owner === r.id ? 'speaking' : 'thinking')
          : 'listening';
    set({ phase });
  }

  private onLevel(level: number, now: number, db: number): void {
    if (!this.alive) return;
    set({ level });
    if (!this.rec) return;
    const out = useReading.getState();
    if (out.owner) this.overlap = true;
    if (this.check) this.check.duckedPeak = Math.max(this.check.duckedPeak, level);
    this.peakDb = Math.max(this.peakDb, db);
    // a finished sentence ends the turn sooner than one left open
    this.det.endQuietMs = endQuietMs(this.hearing?.lastText ?? null, carefulHearing(getState().settings?.voice));
    const vad = this.vadFeed?.active ? this.activity.take() : undefined;
    const signal = this.det.feed(level, now, out.owner && !out.paused ? out.level : 0, db, vad);
    // your voice's level is learned from speech only while nothing plays (no echo in it)
    if (this.det.speechTick && !out.owner) this.loudDbs.push(this.det.db);
    switch (signal) {
      // what was cut before counts now (the captions follow the phrases as they are heard)
      case 'speech':
        voiceLog('turn start');
        this.speakError = null;
        set({ heard: '', error: null });
        this.hearing?.accept();
        this.tryJoin(now);
        break;
      // loud over the bot: duck it and hear what that was (right after your last turn, it goes on with it)
      case 'candidate':
        if (this.tryJoin(now)) { set({ heard: '', error: null }); this.hearing?.accept(); break; }
        void this.checkCutIn(now);
        break;
      case 'faint': {
        const c = this.det.candidate;
        if (c) voiceLog('too faint to cut in', { mic: c.level, echo: c.echo, need: c.need, ms: c.runMs, db: c.db, voiceDb: c.voiceDb ?? undefined });
        break;
      }
      case 'end':
        if (this.check) { this.check.ended = true; return; }
        void this.finishTurn();
        return;
      case 'restart': this.newRecording(); return;
      default: break;
    }
  }

  /** A candidate cut-in: the reading goes on, ducked, while its words are heard; only words of your own stop it. */
  private async checkCutIn(now: number): Promise<void> {
    const rec = this.rec;
    const c = this.det.candidate;
    if (!rec || !c) return;
    const check: Check = { rec, at: now, onset: now - c.runMs, ended: false, duckedPeak: 0 };
    this.check = check;
    speaker.duck(true);
    voiceLog('cut-in?', { mic: c.level, peak: c.peak, echo: c.echo, need: c.need, ms: c.runMs, vad: c.vad, reading: !!useReading.getState().owner });
    const live = () => this.alive && this.check === check && this.rec === rec;
    const verdict = await verifyCutIn(c.runMs, {
      audio: async (ms) => (this.hearing ? this.hearing.tail(ms) : recordingTail(rec, ms)),
      hear: (pcm) => hear(pcm, VERIFY_TIMEOUT_MS),
      read: () => this.readAloud(),
      loud: () => this.det.loudAt(Date.now()),
      live,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });
    if (!verdict || !live()) return;
    const data = { text: verdict.text, why: verdict.reason, words: verdict.novelty.words, novel: verdict.novelty.novel, tries: verdict.tries, ms: Date.now() - check.at, duckedPeak: check.duckedPeak };
    this.check = null;
    if (!verdict.cut) {
      voiceLog('cut-in rejected', data);
      speaker.duck(false);
      // the recording held the bot's own voice (or noise): start over, still guarding the reading
      this.newRecording();
      this.settle();
      return;
    }
    voiceLog('cut-in', data);
    this.verified = true;
    // segments cut before you began were the bot's echo
    this.hearing?.cutIn(Date.now() - check.onset + VERIFY_PRE_MS);
    set({ heard: verdict.text, error: null });
    this.interrupt(true);
    speaker.duck(false);
    if (check.ended) void this.finishTurn();
  }

  /** Speech soon after the last turn, before its reply made a sound: this recording goes on with it. */
  private tryJoin(now: number): boolean {
    const s = this.last;
    if (!s || s.played || s.continued || now > s.until || this.joined) return false;
    this.last = null;
    this.joined = s;
    s.continued = true;
    voiceLog('turn continued', { sent: !!s.messageId });
    if (s.messageId) void this.cancelSent(s);
    return true;
  }

  /** The bot's turn to a turn being continued stops: the whole of what you said goes as one message instead. */
  private async cancelSent(s: Sent): Promise<void> {
    const r = this.reply;
    if (r && r.id === s.messageId) {
      this.reply = null;
      r.clock?.close('continued');
      speaker.stop(r.id);
      set({ said: '' });
    }
    if (this.joined === s) this.det.guard = false;
    this.settle();
    if (!s.threadId) return;
    try {
      await rpc('chat.cancel', { threadId: s.threadId });
      voiceLog('reply cancelled', { messageId: s.messageId ?? undefined });
    } catch (e) {
      voiceLog('cancel failed', { message: errorMessage(e) });
    }
  }

  /** You paused: what you said becomes the next message (or answers the bot's question). */
  private async finishTurn(): Promise<void> {
    const rec = this.rec;
    if (!rec) return;
    const hearing = this.hearing;
    // begun while the bot was reading and not checked as a cut-in: it must hold words of your own
    const vet = this.overlap && !this.verified ? this.readAloud() : null;
    const dbs = this.loudDbs;
    const peak = this.peakDb;
    const voiceDb = this.voiceLevel.db;
    const joined = this.joined;
    this.rec = null;
    this.hearing = null;
    const clock = new TurnClock(this.det.endQuietMs);
    let said!: (text: string) => void;
    const sent: Sent = { text: new Promise((r) => { said = r; }), until: Infinity, played: false, continued: false, threadId: null, messageId: null };
    this.last = sent;
    // the next recording opens at once: what you say while this one is heard isn't lost (and may go on with it)
    if (this.stream) this.newRecording();
    set({ phase: 'transcribing' });
    // the recording goes up while the last words are heard; the message waits for both
    const stopped = rec.stop();
    const stored = stopped
      .then((blob) => upload(new Blob([blob], { type: blob.type.split(';')[0] || 'audio/webm' }), `voice-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`))
      .catch(() => null);
    try {
      let text = '';
      let heard: Heard | null = null;
      // far fainter than your voice: nothing said (Whisper would make words of it)
      if (tooQuiet(peak, voiceDb)) voiceLog('turn dropped', { why: 'too quiet', peakDb: peak, voiceDb: voiceDb ?? undefined });
      else {
        heard = hearing ? await hearing.finish() : await hearRecording(await stopped);
        text = heard.text.trim();
        if (text && junkHeard(text, peak, voiceDb)) {
          voiceLog('turn dropped', { why: 'silence hallucination', text, peakDb: peak, voiceDb: voiceDb ?? undefined });
          text = '';
        }
      }
      if (!this.alive) { clock.close('ended'); return; }
      clock.mark('heard');
      clock.segments = heard?.segments ?? 0;
      voiceLog('turn end', { ms: heard?.durationMs, parts: heard?.segments, text, peakDb: peak });
      if (text && vet !== null) {
        const n = novelty(text, vet);
        if (!ownWords(n)) {
          voiceLog('turn dropped', { why: n.words ? 'the bot’s own words' : 'no words', words: n.words, novel: n.novel, text });
          text = '';
        }
      }
      // a continuation: the turn it goes on with first, sent again as one sentence
      const before = joined ? await joined.text : '';
      const full = joinSegments([before, text]);
      said(full);
      if (!this.alive) { clock.close('ended'); return; }
      if (!full) {
        clock.close(vet !== null ? 'the bot’s echo' : 'nothing heard');
        set({ heard: '' });
        if (this.last === sent) this.last = null;
        this.listenAgain();
        return;
      }
      if (before) voiceLog('turn joined', { before, text });
      set({ heard: full, error: null });
      const file = await stored;
      if (!this.alive) { clock.close('ended'); return; }
      // a continuation began while this was heard: it sends both
      if (sent.continued) { clock.close('continued'); this.settle(); return; }
      await this.send(full, file && heard ? { recordingId: file.id, durationMs: heard.durationMs } : undefined, clock, sent);
      this.learnVoice(dbs);
    } catch (e) {
      clock.close('failed');
      voiceLog('turn failed', { message: errorMessage(e) });
      if (this.last === sent) this.last = null;
      if (!this.alive) return;
      set({ error: errorMessage(e) });
      this.listenAgain();
    } finally {
      said('');
    }
  }

  /** A sent turn teaches how loud your voice reaches the mic. */
  private learnVoice(dbs: number[]): void {
    const before = this.voiceLevel.db;
    this.voiceLevel.learn(dbs);
    const db = this.voiceLevel.db;
    this.det.voiceDb = db;
    if (db !== null && db !== before) voiceLog('your voice level', { db, ticks: dbs.length });
  }

  private listenAgain(): void {
    if (!this.alive) return;
    if (this.stream && !this.rec) this.newRecording();
    this.settle();
  }

  private async send(text: string, voice: { recordingId: string; durationMs: number } | undefined, clock: TurnClock, sent: Sent): Promise<void> {
    const threadId = this.threadId;
    // the bot waits on a question: the words answer it, and the reply goes on in the same message
    const q = threadId ? openQuestionIn(threadId) : null;
    if (q && threadId) {
      // an answer can't be taken back: nothing continues it
      sent.until = 0;
      await rpc('chat.answer', { questionId: q.questionId, answer: text });
      clock.mark('sent');
      if (this.reply?.id !== q.messageId) {
        this.reply?.clock?.close('answered a question');
        const m = getState().convo[threadId]?.byId[q.messageId];
        this.reply = { id: q.messageId, threadId, spoken: m ? replyText(m).length : 0, done: false, language: null, seen: m ?? null, awaiting: false, pieces: 0, clock };
        this.owners.add(q.messageId);
      } else {
        this.reply.clock?.close('asked a question');
        this.reply.awaiting = false;
        this.reply.clock = clock;
        this.reply.pieces = 0;
      }
      if (this.rec && !this.det.heard) this.det.guard = true;
      this.listenAgain();
      return;
    }
    // your words (and recording) show in the chat at once, the bot working under them (the voice bar's transcript too)
    const shown = threadId ? showSending({ botId: this.botId, threadId, text, ...(voice ? { voice } : {}) }) : null;
    let res: Awaited<ReturnType<typeof rpc<'chat.send'>>>;
    try {
      res = await rpc('chat.send', { botId: this.botId, threadId: threadId ?? undefined, text, ...(voice ? { voice } : {}), ...(shown ? { clientId: shown.localId } : {}) });
    } catch (e) {
      if (shown) unsentShown(shown);
      throw e;
    }
    if (shown) sentShown(shown, res);
    clock.mark('sent');
    voiceLog('turn sent', { messageId: res.agentMessageId });
    if (!this.alive) { clock.close('ended'); return; }
    const made = res.userMessage.threadId;
    if (made !== threadId) {
      // the bot's first message made its thread: voice mode moves there with the screen
      this.threadId = made;
      setState((s) => ({
        voiceMode: s.voiceMode ? { ...s.voiceMode, threadId: made } : s.voiceMode,
        threadPick: { ...s.threadPick, [this.botId]: made },
      }));
      ui.syncSelection();
      touchConversation(made);
      void loadConversation(made);
    }
    mergeConversation(made, [res.userMessage]);
    this.reply?.clock?.close('a new turn');
    this.reply = { id: res.agentMessageId, threadId: made, spoken: 0, done: false, language: null, seen: null, awaiting: false, pieces: 0, clock };
    this.owners.add(res.agentMessageId);
    sent.threadId = made;
    sent.messageId = res.agentMessageId;
    sent.until = Date.now() + GRACE_MS;
    set({ said: '' });
    // you went on talking while it was sent: the reply stops, and both parts go as one
    if (sent.continued) { void this.cancelSent(sent); return; }
    // the recording opened at the turn's end now guards the reply (only a cut-in counts, or speech within the grace)
    if (this.rec && !this.det.heard) this.det.guard = true;
    // the next turn's mic opens at once, so you can cut in
    this.listenAgain();
    this.onConvo();
  }

  /** The store changed: read what's new of the reply. */
  onConvo(): void {
    const r = this.reply;
    if (!r || !this.alive) return;
    const m = getState().convo[r.threadId]?.byId[r.id];
    if (!m || m === r.seen) return;
    r.seen = m;
    const text = replyText(m);
    if (text.trim()) r.clock?.mark('firstText');
    const final = m.status !== 'streaming';
    // the first piece may end at a clause break, so the voice starts before the first sentence is done
    const cut = speakableEnd(text, r.spoken, final, r.pieces ? undefined : firstClauseMin(readsFromAfar(activeVoiceRoute())));
    if (cut > r.spoken) {
      const words = speakablePiece(text.slice(r.spoken, cut));
      r.spoken = cut;
      if (words) {
        r.language ??= readingLanguage(speakablePiece(text.slice(0, cut)));
        speaker.enqueue(r.id, words, r.language, { live: true });
        r.pieces++;
        r.clock?.mark('firstPiece');
      }
    }
    if (final) r.done = true;
    const asks = !final && m.parts.some((p) => p.type === 'question' && p.answer === undefined);
    if (asks && !r.awaiting) {
      r.awaiting = true;
      if (!speaker.busy(r.id)) this.readingPaused();
    }
    if (r.done && !speaker.busy(r.id)) this.readingPaused();
  }

  /** Nothing of the reply is left to read for now: listen again if it's done or asks you, else it's still at work. */
  private readingPaused(): void {
    const r = this.reply;
    if (!r || !this.alive) return;
    if (r.done) {
      this.reply = null;
      r.clock?.close('nothing to read');
      voiceLog('reading done', { pieces: r.pieces });
    }
    if (r.done || r.awaiting) {
      set({ said: '' });
      this.det.guard = false;
      // the recording holds only the reply's echo: start over, unless you have started talking
      if (this.rec && !this.det.loudAt(Date.now())) this.newRecording();
    }
    this.settle();
  }

  /** Stop reading the reply; `byVoice`: you talked over it, and what you say is already being recorded. */
  interrupt(byVoice = false): void {
    const r = this.reply;
    if (!r || r.awaiting) return;
    this.reply = null;
    r.clock?.close('interrupted');
    voiceLog('reading stopped', { why: byVoice ? 'you talked over it' : 'the Interrupt button', playing: useReading.getState().owner === r.id });
    speaker.stop(r.id);
    set({ said: '' });
    if (!byVoice) {
      this.det.guard = false;
      if (this.stream) this.newRecording();
    }
    this.settle();
  }

  /** Hears through another microphone: the open one is closed and the picked one opened (muted: at the unmute). */
  switchMic(): void {
    if (useVoiceState.getState().muted || !this.ready) return;
    this.closeMic();
    void this.openMic().catch((e) => { if (this.alive) set({ error: errorMessage(e) }); });
  }

  setMuted(muted: boolean): void {
    set({ muted });
    if (muted) { this.closeMic(); this.settle(); return; }
    if (this.ready) void this.openMic().catch((e) => { if (this.alive) set({ error: errorMessage(e) }); });
  }

  onConn(conn: string): void {
    if (conn !== 'connected') {
      const r = this.reply;
      this.reply = null;
      if (r) { r.clock?.close('offline'); voiceLog('reading stopped', { why: 'offline' }); speaker.stop(r.id); }
      this.last = null;
      this.joined = null;
      this.dropCheck();
      this.rec?.discard();
      this.rec = null;
      this.hearing = null;
      set({ phase: 'offline', said: '' });
    } else if (useVoiceState.getState().phase === 'offline') {
      if (!this.ready) void this.start();
      else this.listenAgain();
    }
  }

  end(): void {
    this.alive = false;
    this.offSpeaker();
    if (this.warmTimer) clearInterval(this.warmTimer);
    this.warmTimer = null;
    const r = this.reply;
    this.reply = null;
    if (r) { r.clock?.close('ended'); voiceLog('reading stopped', { why: 'voice mode ended' }); speaker.stop(r.id); }
    this.closeMic();
    setActiveVoiceRoute(null);
    voiceLog('voice mode ended');
  }
}

/** One phrase heard on this computer. */
const hear = (pcm: Int16Array, timeoutMs = 60_000): Promise<string> =>
  hearingGateway().call('voice.transcribe', { audio: toBase64(pcm), format: 'pcm16' }, { timeoutMs }).then((r) => r.text);

const pcmMs = (pcm: Int16Array) => Math.round(pcm.length / 16);

/** The last `ms` of a recording so far (where the mic's samples can't be had as they come). */
async function recordingTail(rec: Recording, ms: number): Promise<Int16Array> {
  const { pcm16 } = await recordingToPcm16(rec.snapshot());
  return pcm16.subarray(Math.max(0, pcm16.length - Math.round(ms * 16)));
}

/** A whole recording heard at once (where the mic's samples can't be had as they come). */
async function hearRecording(blob: Blob): Promise<Heard> {
  const { pcm16, durationMs } = await recordingToPcm16(blob);
  return { text: await hear(pcm16), segments: 1, durationMs };
}

let session: Session | null = null;
let unwatch: (() => void) | null = null;

/** Voice mode for a bot's chat (`threadId` null: its first message makes the thread). */
export function startVoice(botId: string, threadId: string | null): void {
  // one conversation at a time on this computer: voice mode in the main window hangs up a menu bar call
  if (!isVoiceBarView()) native().endVoiceBar();
  session?.end();
  useVoiceState.setState(IDLE);
  setState({ voiceMode: { botId, threadId } });
  session = new Session(botId, threadId);
  watch();
  void session.start();
}

export function endVoice(): void {
  if (session) playEarcon('end');
  session?.end();
  session = null;
  if (getState().voiceMode) setState({ voiceMode: null });
  useVoiceState.setState(IDLE);
}

/** Hear through another microphone (a device id; null: the system's default). */
export function setVoiceInput(deviceId: string | null): void {
  setMicDevice(deviceId);
  session?.switchMic();
}

/** Interrupt the bot's reading (the button). */
export function interruptVoice(): void { session?.interrupt(false); }
export function setVoiceMuted(muted: boolean): void {
  if (!session || useVoiceState.getState().muted === muted) return;
  playEarcon(muted ? 'mute' : 'unmute');
  session.setMuted(muted);
}
/** Start over after a failure (models, microphone). */
export function retryVoice(): void { if (session) void session.start(); }

/** Showing another bot or thread, or settings, ends voice mode; the connection and new messages reach it. */
function watch(): void {
  if (unwatch) return;
  unwatch = useStore.subscribe((s, prev) => {
    const vm = s.voiceMode;
    if (!vm || !session) return;
    // the main window leaves voice mode when the chat goes off screen; the menu bar's call window has no chat to leave
    const elsewhere = !isVoiceBarView() && (s.settingsSection !== null || s.selectedBotId !== vm.botId
      || (s.selectedThreadId !== null && s.selectedThreadId !== vm.threadId));
    if (elsewhere) { endVoice(); return; }
    if (s.conn !== prev.conn) session.onConn(s.conn);
    if (s.convo !== prev.convo) session.onConvo();
  });
}

/** Voice mode's state and controls, for the panel. */
export function useVoiceConversation() {
  const state = useVoiceState();
  return { ...state, start: startVoice, end: endVoice, interrupt: interruptVoice, setMuted: setVoiceMuted, retry: retryVoice };
}
