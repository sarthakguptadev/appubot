import { useState } from 'react';
import type { TeachSession } from '@appubot/protocol';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, CheckCircle2, X } from '../../components/ui/icons';
import { Button, Icon, Spinner } from '../../components/ui';
import { call, openThread } from '../../lib/actions';
import { useNow } from '../../lib/hooks';
import { setState, useStore } from '../../lib/store';
import { activeComputer } from '../../lib/gateway';
import { openCloudDesktop, useCloudDesktop } from '../cloud/DesktopView';
import { useCloudLink } from '../cloud/cloudClient';

const VISIBLE: TeachSession['status'][] = ['recording', 'summarizing', 'done', 'error'];

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function Recording({ t }: { t: TeachSession }) {
  const now = useNow(1000);
  const [busy, setBusy] = useState<'stop' | 'cancel' | null>(null);

  const stop = async (cancel: boolean) => {
    setBusy(cancel ? 'cancel' : 'stop');
    const res = await call('teach.stop', { id: t.id, cancel }, { errorTitle: cancel ? 'Could not cancel recording' : 'Could not stop recording' });
    setBusy(null);
    if (res) setState({ teach: res.status === 'cancelled' ? null : res });
  };

  return (
    <>
      <span className="relative flex size-2.5 shrink-0 items-center justify-center" aria-hidden>
        <span className="absolute -inset-1 rounded-full bg-danger/20" />
        <span className="relative size-2.5 rounded-full bg-danger" />
      </span>
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 text-copy">
        <span className="truncate font-medium text-fg">Recording “{t.name}”</span>
        <span className="shrink-0 text-muted">· {t.stepCount} {t.stepCount === 1 ? 'step' : 'steps'}</span>
        <span className="shrink-0 font-mono text-note text-muted tabular-nums">· {clock(now - t.startedAt)}</span>
      </div>
      {activeComputer() === 'cloud' && !useCloudDesktop.getState().open ? <Button size="sm" variant="secondary" onClick={() => openCloudDesktop(useCloudLink.getState().team, { teach: true })}>Show it on its screen</Button> : null}
      <Button size="sm" variant="ghost" loading={busy === 'cancel'} disabled={busy !== null} onClick={() => void stop(true)}>Cancel</Button>
      <Button size="sm" variant="primary" loading={busy === 'stop'} disabled={busy !== null} onClick={() => void stop(false)}>Stop &amp; learn</Button>
    </>
  );
}

function Body({ t }: { t: TeachSession }) {
  const dismiss = () => setState({ teach: null });
  switch (t.status) {
    case 'recording':
      return <Recording t={t} />;
    case 'summarizing':
      return (
        <>
          <Spinner size={14} className="text-accent-strong" />
          <span className="min-w-0 flex-1 truncate text-copy text-fg">
            Learning the steps… <span className="text-muted">“{t.name}” · {t.stepCount} {t.stepCount === 1 ? 'step' : 'steps'}</span>
          </span>
        </>
      );
    case 'done':
      return (
        <>
          <Icon icon={CheckCircle2} size={16} className="text-success" />
          <span className="min-w-0 flex-1 truncate text-copy text-fg">
            Skill saved{t.skillName ? <span className="text-muted"> · <span className="font-mono text-note">{t.skillName}</span></span> : null}
          </span>
          {t.threadId ? (
            <Button size="sm" variant="secondary" onClick={() => { const id = t.threadId; dismiss(); if (id) void openThread(id); }}>
              Open chat
            </Button>
          ) : null}
          <Button size="icon-sm" variant="ghost" icon={X} aria-label="Dismiss" onClick={dismiss} />
        </>
      );
    case 'error':
      return (
        <>
          <Icon icon={AlertCircle} size={16} className="text-danger" />
          <span className="min-w-0 flex-1 truncate text-copy text-danger" title={t.error}>
            Couldn't learn “{t.name}”{t.error ? `: ${t.error}` : ''}
          </span>
          <Button size="sm" variant="ghost" onClick={dismiss}>Dismiss</Button>
        </>
      );
    default:
      return null;
  }
}

/* quiet tints over the card's glass (no opaque fills) */
const TONE: Record<string, string> = {
  recording: 'bg-[color-mix(in_srgb,var(--ab-danger)_6%,transparent)]',
  summarizing: 'bg-[color-mix(in_srgb,var(--ab-accent)_7%,transparent)]',
  done: 'bg-[color-mix(in_srgb,var(--ab-success)_8%,transparent)]',
  error: 'bg-[color-mix(in_srgb,var(--ab-danger)_8%,transparent)]',
};

/** Slim glass strip at the top of the chat card while a teach session is active. */
export function TeachBanner() {
  const teach = useStore((s) => s.teach);
  const show = !!teach && VISIBLE.includes(teach.status);

  return (
    <AnimatePresence initial={false}>
      {show && teach ? (
        <motion.div
          key="teach-banner"
          role="status"
          aria-live="polite"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 40, opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.25, 1, 0.5, 1] }}
          className="no-drag hairline-b relative z-30 shrink-0 overflow-hidden"
        >
          <div className={`flex h-10 items-center gap-2.5 pr-2 pl-4 transition-colors duration-200 ${TONE[teach.status] ?? ''}`}>
            <Body t={teach} />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
