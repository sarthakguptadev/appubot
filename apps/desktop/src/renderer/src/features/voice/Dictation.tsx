// Dictation: the composer's mic button, left of its round button (voice mode, send, stop). At rest a quiet round
// control (a faint fill and hairline, the mic); a click listens, and the button turns into a live strip of the mic's
// level with the time, a quiet ✕ (throw it away) and a filled ✓ (Done: what was heard is added to the draft).
// `round`: a group room's voice button in Send's place, in the room's colour; its Done is ↑ (what was heard is sent).
// The speech model downloads on first use (the chat's notice shows how far).
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { VOICE_MAX_SECONDS } from '@appubot/protocol';
import { ArrowUp, Check, MicSolid, VoiceWave, X } from '../../components/ui/icons';
import { Icon, Spinner, Tooltip, cn } from '../../components/ui';
import { call } from '../../lib/actions';
import { errorMessage, gateway, localGateway, rpc } from '../../lib/gateway';
import { useShallow } from 'zustand/react/shallow';
import { pushToast, setState, useStore } from '../../lib/store';
import { useT } from '../../lib/i18n';
import { closeStream, createMeter, createRecorder, openMic, recordingToPcm16, toBase64, type Meter, type Recording } from './audio';
import { clock, percent, readiness } from './models';
import { followMacDownload, useMacVoice, useVoiceRoute } from './macVoice';
import { askedForVoice } from './DownloadNotice';

type DictationState = 'idle' | 'opening' | 'recording' | 'transcribing';

/** A quiet round control in the composer: a faint fill and hairline, the glyph a step back from the text (+, the mic, ✕). */
export const QUIET_ROUND =
  'ab-press ab-pill squircle flex size-7 shrink-0 items-center justify-center rounded-control bg-fg/[.06] text-fg/60 shadow-[inset_0_0_0_.5px_color-mix(in_srgb,var(--ab-fg)_9%,transparent)] hover:bg-fg/10 hover:text-fg focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)] disabled:opacity-50';

/** how many bars the listening strip draws: the newest on the right */
const BARS = 18;

/** The mic's level while it listens: the last `BARS` readings as bars, and the time. */
function ListeningStrip({ levels, elapsed }: { levels: number[]; elapsed: number }) {
  return (
    <span aria-hidden className="flex h-7 shrink-0 items-center gap-2 pr-1 pl-1.5">
      <span className="flex h-5 items-center gap-[2px]">
        {Array.from({ length: BARS }, (_, i) => {
          const v = levels[levels.length - BARS + i] ?? 0;
          return <span key={i} className="w-[2.5px] rounded-full bg-fg/70 transition-[height] duration-75" style={{ height: `${Math.round(3 + v * 17)}px` }} />;
        })}
      </span>
      <span className="text-note text-muted tabular-nums">{clock(elapsed)}</span>
    </span>
  );
}

export function DictateButton({ onText, disabled, round, className, style, onActive }: {
  onText: (text: string) => void; disabled?: boolean; round?: boolean; className?: string;
  /** the round button's own colours (a group room's) */
  style?: CSSProperties;
  /** told while the microphone is in use here (opening, recording, writing it down): the composer keeps voice mode off it meanwhile */
  onActive?: (on: boolean) => void;
}) {
  const t = useT();
  // who hears: the computer on screen, or this Mac's own speech model when that one hears nothing (voiceRoute.ts)
  const route = useVoiceRoute();
  const onMac = route.hear === 'mac';
  const supported = route.hear !== null;
  // `readiness` makes a new object each time: compared field by field, or the selector re-renders without end
  const screenModels = useStore(useShallow((s) => readiness(s.voice, s.settings, 'dictate')));
  const macModels = useMacVoice(useShallow((m) => readiness(m.voice, m.settings, 'dictate')));
  const models = onMac ? macModels : screenModels;
  // the mocks show it listening with `?dictating=1` (no microphone there)
  const mockListening = !!import.meta.env.VITE_APPUBOT_MOCK && new URLSearchParams(location.search).get('dictating') === '1';
  const [state, setDictation] = useState<DictationState>(mockListening ? 'recording' : 'idle');
  const [elapsed, setElapsed] = useState(mockListening ? 4200 : 0);
  const [levels, setLevels] = useState<number[]>(() => (mockListening ? Array.from({ length: BARS }, (_, i) => Math.abs(Math.sin(i * 0.9)) * 0.8) : []));
  const live = useRef<{ stream: MediaStream; rec: Recording; timer: ReturnType<typeof setInterval>; meter: Meter | null } | null>(null);
  const text = useRef(onText);
  text.current = onText;
  const active = useRef(onActive);
  active.current = onActive;
  const busy = state !== 'idle';
  useEffect(() => { active.current?.(busy); }, [busy]);
  useEffect(() => () => active.current?.(false), []);

  const release = () => {
    const l = live.current;
    live.current = null;
    if (!l) return null;
    clearInterval(l.timer);
    l.meter?.stop();
    return l;
  };

  // leaving the chat throws a recording away
  useEffect(() => () => { const l = release(); if (l) { l.rec.discard(); closeStream(l.stream); } }, []);

  const finish = async () => {
    const l = release();
    if (!l) return;
    setDictation('transcribing');
    try {
      const blob = await l.rec.stop();
      closeStream(l.stream);
      const { pcm16 } = await recordingToPcm16(blob);
      const res = await (onMac ? localGateway() : gateway()).call('voice.transcribe', { audio: toBase64(pcm16), format: 'pcm16' }, { timeoutMs: 120_000 });
      const heard = res.text.trim();
      if (heard) text.current(heard);
      else pushToast({ title: 'Nothing was heard', body: 'Try again a little closer to the microphone.', level: 'info' });
    } catch (e) {
      pushToast({ title: 'Couldn’t write that down', body: errorMessage(e), level: 'error' });
    } finally {
      setDictation('idle');
    }
  };

  /** ✕: what was said so far is thrown away */
  const discard = () => {
    const l = release();
    if (!l) return;
    l.rec.discard();
    closeStream(l.stream);
    setDictation('idle');
  };

  const start = async () => {
    if (models.state === 'unsupported') return;
    if (models.state !== 'ready') {
      // the download (maybe already running in the background) is shown above the composer from now on
      if (!onMac) askedForVoice();
      if (models.state === 'downloading') return;
      // this Mac's own model: fetched here, and followed here (its events aren't, with another computer on screen)
      const st = onMac
        ? await localGateway().call('voice.prepare', { only: 'speech' }).catch((e: unknown) => { pushToast({ title: 'Couldn’t download the speech model', body: errorMessage(e), level: 'error' }); return null; })
        : await call('voice.prepare', undefined, { errorTitle: 'Couldn’t download the speech model' });
      if (st) {
        if (onMac) {
          useMacVoice.setState({ voice: st }); followMacDownload();
          // this Mac's download isn't the line above the composer here (another computer is on screen)
          pushToast({ title: 'Downloading the speech model', body: 'It downloads once and stays on this computer. Dictate again when it’s ready.', level: 'info' });
        } else setState({ voice: st });
      }
      return;
    }
    setDictation('opening');
    // the speech model loads while you speak, not after (the first dictation in a while would wait a second for it)
    void (onMac ? localGateway().call('voice.warm', { only: 'speech' }) : rpc('voice.warm')).catch(() => undefined);
    try {
      const stream = await openMic();
      const rec = createRecorder(stream);
      const startedAt = Date.now();
      setElapsed(0);
      setLevels([]);
      let meter: Meter | null = null;
      try { meter = createMeter(stream, (level) => setLevels((ls) => [...ls.slice(1 - BARS * 2), level])); } catch { meter = null; }
      const timer = setInterval(() => {
        const ms = Date.now() - startedAt;
        setElapsed(ms);
        if (ms >= VOICE_MAX_SECONDS * 1000 - 1000) void finish();
      }, 250);
      live.current = { stream, rec, timer, meter };
      setDictation('recording');
    } catch (e) {
      setDictation('idle');
      pushToast({ title: 'Couldn’t open the microphone', body: errorMessage(e), level: 'error' });
    }
  };

  if (!supported) return null;
  const recording = state === 'recording';
  if (recording) {
    return (
      <span className="flex shrink-0 items-center gap-1">
        <ListeningStrip levels={levels} elapsed={elapsed} />
        <Tooltip label="Throw it away" side="top">
          <button type="button" aria-label="Throw it away" onClick={discard} className={QUIET_ROUND}>
            <Icon icon={X} size={14} strokeWidth={2.2} />
          </button>
        </Tooltip>
        <Tooltip label={round ? 'Send' : t('composer.dictateStop')} side="top">
          <button
            type="button"
            data-recording=""
            aria-label={round ? 'Send' : t('composer.dictateStop')}
            onClick={() => void finish()}
            style={round ? style : undefined}
            className={round ? cn(className, 'size-7') : 'ab-press ab-pill squircle flex size-7 shrink-0 items-center justify-center rounded-control bg-fg text-[color:var(--ab-inverse)] transition-[filter] duration-100 hover:brightness-90 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]'}
          >
            <Icon icon={round ? ArrowUp : Check} size={round ? 15 : 14} strokeWidth={2.4} />
          </button>
        </Tooltip>
      </span>
    );
  }
  const label = round ? 'Speak a message' : t('composer.dictate');
  const tip = models.state === 'downloading' ? `Downloading the speech model… ${percent(models.progress)}` : label;
  return (
    <Tooltip label={tip} side="top">
      <button
        type="button"
        aria-label={label}
        aria-pressed={false}
        disabled={disabled || state === 'opening' || state === 'transcribing'}
        onClick={() => void start()}
        style={round ? style : undefined}
        className={round ? className : cn(QUIET_ROUND, className)}
      >
        {state === 'transcribing' || state === 'opening' ? <Spinner size={13} /> : <Icon icon={round ? VoiceWave : MicSolid} size={16} />}
      </button>
    </Tooltip>
  );
}
