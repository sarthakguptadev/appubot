// The menu bar's voice call: one card driven by voice mode (`useVoiceConversation`). On top the bot, what the call
// is doing and how long it has run; under it a level meter for whoever speaks; at the bottom Mute, Transcript,
// Settings and End. Transcript and Settings open inside the card, above the buttons. Built on the app's own kit
// (components/ui) and theme tokens. Settings: the voice (with a sample), the bot's reasoning effort, the language
// Whisper hears and the microphone. Hanging up ends voice mode, then the window closes (`onEnd`).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findVoiceModel, voiceFor, type Bot, type Settings, type Thread } from '@appubot/protocol';
import { languageChoices, pickedModel, shownLanguage } from '@appubot/chat-core';
import { BotAvatar, Button, FIELD_LABEL, Select, SettingsSegmented, cn } from '../../../components/ui';
import { Mic, MicOff, PhoneOff, Play, ScrollText, Settings as SettingsIcon, Stop } from '../../../components/ui/icons';
import { setThreadEffort, updateSettings, useThreadChoices } from '../../../lib/choices';
import { getState, useStore } from '../../../lib/store';
import { micDeviceId } from '../audio';
import { readingLanguage, speaker as reader, useReading } from '../speech';
import { endVoice, replyText, setVoiceInput, setVoiceMuted, useVoiceState, type VoicePhase } from '../useVoiceConversation';
import css from './CallBar.module.css';

type Panel = 'transcript' | 'settings';
type Said = { id: string; mine: boolean; text: string };

/** the reader's owner for a voice sample in Settings */
const SAMPLE = 'callbar-sample';
const METER_BARS = 21;

const STATUS: Record<VoicePhase, string> = {
  starting: 'Connecting…',
  listening: 'Listening',
  transcribing: 'Catching that…',
  thinking: 'Thinking…',
  speaking: 'Speaking',
  offline: 'Reconnecting…',
  error: 'Call trouble',
};

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function languageLabel(code: string): string {
  if (code === 'auto') return 'Auto-detect';
  try {
    return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The microphones this window can hear through, the system default first (names show once the mic is allowed). */
function useMicrophones(): { id: string; name: string }[] {
  const [mics, setMics] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    const devices = navigator.mediaDevices;
    if (!devices?.enumerateDevices) return;
    const read = () =>
      devices.enumerateDevices().then((all) => {
        const named = all
          .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
          .map((d, i) => ({ id: d.deviceId, name: d.label || `Microphone ${i + 1}` }));
        setMics([{ id: 'default', name: 'System default' }, ...named]);
      }, () => undefined);
    void read();
    devices.addEventListener('devicechange', read);
    return () => devices.removeEventListener('devicechange', read);
  }, []);
  return mics;
}

/** Everything said since the call began, then your words still being heard. */
function useSaid(threadId: string | null, since: number): Said[] {
  const convo = useStore((st) => (threadId ? st.convo[threadId] : undefined));
  const heard = useVoiceState((v) => (!v.muted && (v.phase === 'listening' || v.phase === 'transcribing') ? v.heard.trim() : ''));
  return useMemo(() => {
    const said: Said[] = [];
    for (const id of convo?.ids ?? []) {
      const m = convo?.byId[id];
      if (!m || m.createdAt < since - 2000) continue;
      const text = (m.role === 'agent' ? replyText(m) : m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ')).trim();
      if (text) said.push({ id: m.id, mine: m.role !== 'agent', text });
    }
    const flat = (t: string) => t.split(/\s+/).join(' ');
    const lastMine = said.filter((x) => x.mine).pop();
    if (heard && (!lastMine || flat(lastMine.text) !== flat(heard))) said.push({ id: 'heard', mine: true, text: heard });
    return said;
  }, [convo, heard, since]);
}

/** A sample line read in one of the voices; picking it again stops it. */
function useSample(botName: string) {
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => {
    const done = (owner: string) => { if (owner === SAMPLE) setPlaying(null); };
    const off = reader.on({ idle: done, error: done });
    return () => { off(); reader.stop(SAMPLE); };
  }, []);
  const toggle = (voice: string) => {
    reader.stop(SAMPLE);
    if (playing === voice) { setPlaying(null); return; }
    const line = `Hi, I'm ${botName}. This is how I sound.`;
    setPlaying(voice);
    reader.enqueue(SAMPLE, line, readingLanguage(line), { voice });
  };
  return { playing, toggle };
}

/** Bars that rise from the middle with whoever speaks: the bot's reading level, or the mic's while you talk. */
function Meter({ who }: { who: 'bot' | 'you' | null }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const mid = (METER_BARS - 1) / 2;
    let level = 0;
    let prev = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      const v = useVoiceState.getState();
      const goal = v.phase === 'speaking'
        ? Math.min(1, useReading.getState().level * 1.6)
        : !v.muted && v.phase === 'listening' ? Math.min(1, v.level * 1.4) : 0;
      level += (goal - level) * Math.min(1, dt * 10);
      bars.current.forEach((el, i) => {
        if (!el) return;
        const d = (i - mid) / mid;
        const wobble = still ? 1 : 0.7 + 0.3 * Math.sin(now / 130 + i * 1.9);
        el.style.transform = `scaleY(${Math.max(0.1, level * Math.exp(-2.4 * d * d) * wobble).toFixed(3)})`;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className={css.meter} data-who={who ?? undefined} aria-hidden>
      {Array.from({ length: METER_BARS }, (_, i) => (
        <span key={i} ref={(el) => { bars.current[i] = el; }} />
      ))}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={FIELD_LABEL}>{label}</span>
      {children}
    </div>
  );
}

function CallSettings({ bot, thread }: { bot: Bot; thread: Thread | null }) {
  const voice = useStore((st) => st.settings?.voice);
  const mics = useMicrophones();
  const [mic, setMic] = useState(() => micDeviceId() ?? 'default');
  const sample = useSample(bot.name);
  if (!voice) return null;

  const save = (patch: Partial<Settings['voice']>) => {
    const now = getState().settings;
    if (now) void updateSettings({ voice: { ...now.voice, ...patch } });
  };
  const tts = pickedModel('tts', voice);
  const voices = findVoiceModel(tts)?.voices ?? [];
  const picked = voiceFor(tts, voice.voice);
  const pickedName = voices.find((v) => v.id === picked)?.name ?? picked;
  const efforts = thread?.efforts ?? [];
  const languages = languageChoices(voice.sttModel);

  return (
    <div className="flex flex-col gap-3 px-3.5 py-3">
      {voices.length ? (
        <Row label="Voice">
          <div className="flex items-center gap-1.5">
            <Select className="min-w-0 flex-1" aria-label="Voice" value={picked} onChange={(e) => { if (e.target.value !== voice.voice) save({ voice: e.target.value }); }}>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>{v.about ? `${v.name} · ${v.about}` : v.name}</option>
              ))}
            </Select>
            <Button
              size="icon"
              icon={sample.playing === picked ? Stop : Play}
              aria-label={sample.playing === picked ? `Stop ${pickedName}'s sample` : `Hear ${pickedName}`}
              title={sample.playing === picked ? 'Stop sample' : 'Hear this voice'}
              onClick={() => sample.toggle(picked)}
            />
          </div>
        </Row>
      ) : null}
      {thread && efforts.length > 1 ? (
        <Row label="Reasoning effort">
          <SettingsSegmented
            label="Reasoning effort"
            value={thread.effortId ?? bot.effort ?? efforts[0]!.id}
            options={efforts.map((e) => ({ value: e.id, label: e.name }))}
            onChange={(id) => { if (id !== thread.effortId) void setThreadEffort(thread, id); }}
          />
        </Row>
      ) : null}
      {languages.length ? (
        <Row label="Language">
          <Select aria-label="Language" value={shownLanguage(voice)} onChange={(e) => { if (e.target.value !== voice.language) save({ language: e.target.value }); }}>
            {languages.map((l) => <option key={l} value={l}>{languageLabel(l)}</option>)}
          </Select>
        </Row>
      ) : null}
      {mics.length ? (
        <Row label="Microphone">
          <Select aria-label="Microphone" value={mic} onChange={(e) => { setMic(e.target.value); setVoiceInput(e.target.value === 'default' ? null : e.target.value); }}>
            {mics.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Row>
      ) : null}
    </div>
  );
}

function CallTranscript({ said, botName }: { said: Said[]; botName: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [said]);
  return (
    <div ref={box} className="flex max-h-[240px] flex-col gap-2.5 overflow-y-auto overscroll-contain px-3.5 py-3" aria-live="polite">
      {said.length ? said.map((x) => (
        <div key={x.id} className={cn('flex flex-col gap-0.5', x.id === 'heard' && 'opacity-60')}>
          <span className="text-note font-semibold text-muted">{x.mine ? 'You' : botName}</span>
          <p className="whitespace-pre-wrap text-ui leading-snug text-fg">{x.text}</p>
        </div>
      )) : <p className="py-5 text-center text-note text-muted">Nothing said yet.</p>}
    </div>
  );
}

export function CallBar({
  bot,
  thread: reported,
  threadId,
  needsYou,
  ending,
  onEnd,
}: {
  bot: Bot;
  /** the call's thread (null until its first message makes one) */
  thread: Thread | null;
  threadId: string | null;
  /** an approval waits for the user in the app */
  needsYou: boolean;
  /** hang up now (the menu bar's End call) */
  ending: boolean;
  /** after the card has gone */
  onEnd: () => void;
}) {
  // an effort picked here shows at once and stays while the computer catches up (lib/choices.ts)
  const thread = useThreadChoices(reported ?? undefined) ?? null;
  const phase = useVoiceState((v) => v.phase);
  const muted = useVoiceState((v) => v.muted);
  const who = useVoiceState((v) => (v.phase === 'speaking' ? 'bot' : !v.muted && v.phase === 'listening' && v.level > 0.12 ? 'you' : null));
  const [panel, setPanel] = useState<Panel | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  const said = useSaid(threadId, since);
  const hungUp = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearInterval(t); window.clearTimeout(closeTimer.current); };
  }, []);

  const hangUp = useCallback(() => {
    if (hungUp.current) return;
    hungUp.current = true;
    endVoice();
    reader.stop(SAMPLE);
    setPanel(null);
    setLeaving(true);
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    closeTimer.current = window.setTimeout(onEnd, still ? 0 : 200);
  }, [onEnd]);

  useEffect(() => { if (ending) hangUp(); }, [ending, hangUp]);

  // Escape closes the open panel, else ends the call
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (panel) setPanel(null);
      else hangUp();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [panel, hangUp]);

  const toggle = (p: Panel) => setPanel((open) => (open === p ? null : p));
  const mood = needsYou ? 'needs-you' : phase === 'thinking' || phase === 'transcribing' ? 'working' : 'rest';
  const status = muted && phase === 'listening' ? 'Muted' : STATUS[phase];

  return (
    <section data-call-hit="" aria-label={`Voice call with ${bot.name}`} className={cn(css.card, leaving && css.leaving)}>
      <header className="flex items-center gap-2.5 px-3.5 pt-3.5">
        <BotAvatar bot={bot} size={36} mood={mood} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-copy font-semibold tracking-ui">{bot.name}</div>
          <div className="truncate text-note text-muted" aria-live="polite">{status}</div>
        </div>
        <span className="text-note tabular-nums text-muted">{clock(now - since)}</span>
      </header>

      <Meter who={who} />

      {panel ? (
        <div className="hairline-t hairline-b">
          {panel === 'settings' ? <CallSettings bot={bot} thread={thread} /> : <CallTranscript said={said} botName={bot.name} />}
        </div>
      ) : null}

      <footer className="flex items-center gap-1.5 p-3">
        <Button
          size="icon"
          variant={muted ? 'primary' : 'secondary'}
          icon={muted ? MicOff : Mic}
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={muted}
          title={muted ? 'Unmute' : 'Mute'}
          onClick={() => setVoiceMuted(!muted)}
        />
        <Button
          size="icon"
          variant={panel === 'transcript' ? 'primary' : 'secondary'}
          icon={ScrollText}
          aria-label="Transcript"
          aria-expanded={panel === 'transcript'}
          title="Transcript"
          onClick={() => toggle('transcript')}
        />
        <Button
          size="icon"
          variant={panel === 'settings' ? 'primary' : 'secondary'}
          icon={SettingsIcon}
          aria-label="Call settings"
          aria-expanded={panel === 'settings'}
          title="Settings"
          onClick={() => toggle('settings')}
        />
        <Button className="ml-auto" variant="danger" icon={PhoneOff} onClick={hangUp}>End</Button>
      </footer>
    </section>
  );
}
