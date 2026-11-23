// The page of the menu bar's voice call window (`?view=voicebar&bot=<id>`, electron/voiceBar.ts): it connects to the
// gateway like the main window, then talks with the bot in its current thread (voice mode, `startVoice`) through the
// call card (CallBar). The window fits the page (`voiceBarSize`, bottom edge kept) and lets clicks through around
// the card (`voiceBarIgnore`). An approval for the call's thread can't be answered here: a line above it opens AppuBot.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { useGatewayBoot } from '../../../lib/boot';
import { native } from '../../../lib/native';
import { chatThreadFor, setState, useStore } from '../../../lib/store';
import { useThemeSync } from '../../../lib/theme';
import { percent, readiness } from '../models';
import { endVoice, startVoice, useVoiceState } from '../useVoiceConversation';
import { CallBar } from './CallBar';
import s from './CallBar.module.css';

export function VoiceBarApp({ botId }: { botId: string }) {
  const { error: bootError } = useGatewayBoot();
  useThemeSync();
  const hydrated = useStore((st) => st.hydrated);
  const connected = useStore((st) => st.conn === 'connected');
  const bot = useStore((st) => st.bots.find((b) => b.id === botId) ?? null);
  // the call's thread: voice mode's (its first message makes one), else the bot's current thread
  const threadId = useStore((st) => (st.voiceMode?.botId === botId ? st.voiceMode.threadId : null) ?? chatThreadFor(st, botId));
  const thread = useStore((st) => st.threads.find((t) => t.id === threadId) ?? null);
  const needsYou = useStore((st) => st.pendingPermissions.some((p) => p.threadId === threadId));
  const status = useVoiceState((v) => v.phase);
  const voiceError = useVoiceState((v) => v.error);
  const download = useStore((st) => { const r = readiness(st.voice, st.settings); return r.state === 'downloading' ? r.progress : null; });
  const [ending, setEnding] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.view = 'voicebar';
    document.title = 'AppuBot call';
  }, []);

  // the call starts once the snapshot is in, on the bot's current thread (none yet: its first message makes it)
  useEffect(() => {
    if (started.current || !hydrated || !connected || !bot) return;
    started.current = true;
    const thread = chatThreadFor(useStore.getState(), bot.id);
    // the window's store hydrated onto the first bot: it shows the called one (its conversation is kept loaded)
    setState({ selectedBotId: bot.id, selectedThreadId: thread });
    startVoice(bot.id, thread);
  }, [hydrated, connected, bot]);

  useEffect(() => () => endVoice(), []);
  // the menu bar's End call
  useEffect(() => native().onVoiceBarEnd(() => setEnding(true)), []);
  // a bot deleted mid-call ends it
  useEffect(() => { if (hydrated && !bot) native().voiceBarClose(); }, [hydrated, bot]);

  // the window fits the page: the card, its open panel and the line above it
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const report = () => native().voiceBarSize({ width: el.offsetWidth, height: el.offsetHeight });
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // clicks go through the window around the card (its shadow)
  useEffect(() => {
    let ignoring: boolean | null = null;
    const onMove = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      const hit = !!t?.closest('[data-call-hit]');
      if (ignoring === !hit) return;
      ignoring = !hit;
      native().voiceBarIgnore(!hit);
    };
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, []);

  const onEnd = useCallback(() => native().voiceBarClose(), []);

  const line = needsYou
    ? { text: `${bot?.name ?? 'Your bot'} needs your OK - open AppuBot`, open: true }
    : bootError
      ? { text: 'Can’t reach AppuBot', open: true }
      : voiceError
        ? { text: voiceError, open: status === 'error' }
        : download !== null
          ? { text: `Getting voice ready… ${percent(download)}`, open: false }
          : status === 'offline'
            ? { text: 'Reconnecting…', open: false }
            : null;

  return (
    <MotionConfig reducedMotion="user">
      <div className={s.stageWrap}>
        <div ref={stage} className={s.stage}>
          {line && !ending ? (
            <button
              type="button"
              data-call-hit=""
              className={s.notice}
              title={line.text}
              onClick={() => { if (line.open) native().showApp(); }}
              disabled={!line.open}
            >
              {line.text}
            </button>
          ) : null}
          {bot ? (
            <CallBar
              bot={bot}
              thread={thread}
              threadId={threadId}
              needsYou={needsYou}
              ending={ending}
              onEnd={onEnd}
            />
          ) : null}
        </div>
      </div>
    </MotionConfig>
  );
}
