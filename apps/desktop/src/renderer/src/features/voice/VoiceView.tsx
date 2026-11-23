// Voice mode's screen, ChatGPT-style: it takes the chat column over (the header strip stays) with the bot's orb and
// the captions under it (what you said, or the sentence being read) centred in the space above a round mic (mute)
// and X (end); a soft tone marks it ready, a mute, an unmute and the end (`earcons.ts`). Tapping the orb while the
// bot speaks cuts the reading short. Everything said lands in the thread, so leaving shows it. Escape ends it.
import type { CSSProperties, ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { Bot, PermissionRequest } from '@appubot/protocol';
import { useShallow } from 'zustand/react/shallow';
import { Mic, MicOff, X } from '../../components/ui/icons';
import { Button, Icon, Tooltip, cn, isDialogOpen } from '../../components/ui';
import { useHotkey } from '../../lib/hooks';
import { useStore } from '../../lib/store';
import { ApprovalBar } from '../chat/ApprovalBar';
import { percent, readiness } from './models';
import { activeVoiceRoute, useMacVoice } from './macVoice';
import { macReadiness } from './voiceRoute';
import { VoiceOrb } from './VoiceOrb';
import { useVoiceConversation, type VoicePhase } from './useVoiceConversation';

const STATUS: Record<VoicePhase, string> = {
  starting: 'Connecting…', listening: 'Listening', transcribing: 'Thinking', thinking: 'Thinking',
  speaking: 'Speaking', offline: 'Reconnecting…', error: 'Voice stopped',
};

/** the end of a long caption: two lines show what was said last */
const tail = (text: string, max = 150) => (text.length > max ? `…${text.slice(text.length - max).replace(/^\S*\s/, '')}` : text);

/** A round control of the bottom bar. */
function Round({ label, onClick, disabled, className, children }: {
  label: string; onClick: () => void; disabled?: boolean; className?: string; children: ReactNode;
}) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'no-drag flex size-14 shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform] duration-150 active:scale-95',
          'focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-bg),0_0_0_4px_var(--ab-ring)] disabled:pointer-events-none disabled:opacity-40',
          className,
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}


export function VoiceView({ bot, approvals }: { bot: Bot; approvals: PermissionRequest[] }) {
  const v = useVoiceConversation();
  const reduce = useReducedMotion();
  const screenModels = useStore(useShallow((s) => readiness(s.voice, s.settings)));
  // another computer on screen: what downloads is this Mac's own speech model (voiceRoute.ts)
  const macModels = useMacVoice(useShallow((m) => macReadiness(activeVoiceRoute(), m.voice, m.settings)));
  const models = macModels ?? screenModels;
  const speaking = v.phase === 'speaking';
  const downloading = v.phase === 'starting' && models.state === 'downloading' ? models.progress : null;

  // Escape ends voice mode, unless an approval waits (its Escape rejects it) or a dialog is open
  useHotkey((e) => e.key === 'Escape' && !isDialogOpen(), () => v.end(), !approvals.length);

  const caption = speaking ? v.said
    : v.phase === 'listening' || v.phase === 'transcribing' || v.phase === 'thinking' ? v.heard : '';

  return (
    <section role="region" aria-label={`Voice conversation with ${bot.name}`} className="relative flex min-h-0 flex-1 flex-col items-center gap-4 px-5 pt-2 pb-6">
      {/* the orb and its captions, one group centred in the space above the controls (the captions keep their room
          while empty, so the orb never moves) */}
      <div className="relative flex min-h-0 w-full flex-1 items-center justify-center [container-type:size]" style={{ '--orb': 'min(320px, 50cqh, 76cqw)' } as CSSProperties}>
        <div className="flex w-full flex-col items-center gap-6">
          <button
            type="button"
            aria-label={speaking ? 'Interrupt' : undefined}
            aria-hidden={!speaking || undefined}
            tabIndex={speaking ? 0 : -1}
            onClick={() => { if (speaking) v.interrupt(); }}
            className={cn('no-drag relative size-[var(--orb)] shrink-0 overflow-hidden rounded-full focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-bg),0_0_0_4px_var(--ab-ring)]', speaking ? 'cursor-pointer' : 'cursor-default')}
          >
            <VoiceOrb color={bot.color} phase={v.phase} />
          </button>
          {/* under the orb: only what needs you (a download, an error), then the captions */}
          <div className="flex h-[3.25rem] w-full flex-col items-center gap-2 text-center">
            {downloading !== null ? (
              <>
                <p aria-live="polite" className="text-copy text-muted">Downloading voice models · {percent(downloading)}</p>
                <div className="h-[3px] w-40 shrink-0 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="Downloading voice models" aria-valuenow={Math.round(downloading * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full rounded-full bg-fg/60 transition-[width] duration-300" style={{ width: percent(downloading) }} />
                </div>
              </>
            ) : null}
            {v.phase === 'error' || v.error ? (
              <div className="flex max-w-[36rem] flex-col items-center justify-center gap-2">
                {/* two lines, not one: the message is often what to do (where to allow the microphone) */}
                <p role="alert" className="line-clamp-2 min-w-0 text-copy leading-snug text-balance text-danger" title={v.error ?? STATUS.error}>{v.error ?? STATUS.error}</p>
                {v.phase === 'error' ? <Button size="xs" variant="secondary" className="shrink-0" onClick={v.retry}>Retry</Button> : null}
              </div>
            ) : null}
            {/* two lines, cross-fading as they change */}
            <div aria-live="polite" className="relative h-[3.25rem] w-full max-w-[36rem] shrink-0">
              <AnimatePresence initial={false}>
                {caption ? (
                  <motion.p
                    key={`${speaking ? 'said' : 'heard'}:${caption}`}
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    transition={{ duration: reduce ? 0 : 0.22, ease: 'easeOut' }}
                    className={cn('absolute inset-x-0 top-0 line-clamp-2 text-lead leading-[1.625rem]', speaking ? 'text-fg' : 'text-fg-2')}
                  >
                    {tail(caption)}
                  </motion.p>
                ) : null}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>

      {/* what waits on you, then the controls */}
      <div className="relative flex w-full max-w-[46rem] shrink-0 flex-col items-center gap-3">
        {approvals.length ? (
          <div className="w-full [&>section]:mb-0 [&>section]:rounded-b-[1.2rem] [&>section]:border-b-[color:var(--ab-surface-border)]">
            <ApprovalBar requests={approvals} botName={bot.name} />
          </div>
        ) : null}
        <p className={cn('h-4 text-note text-muted/80 transition-opacity duration-200', speaking ? 'opacity-100' : 'opacity-0')} aria-hidden={!speaking}>
          Tap to interrupt
        </p>
        <div className="flex items-center justify-center gap-5">
          <Round
            label={v.muted ? 'Unmute' : 'Mute'}
            onClick={() => v.setMuted(!v.muted)}
            disabled={v.phase === 'error'}
            className={v.muted ? 'bg-danger-soft text-danger hover:bg-[color-mix(in_srgb,var(--ab-danger)_18%,transparent)]' : 'bg-surface-2 text-fg hover:bg-surface-3'}
          >
            <Icon icon={v.muted ? MicOff : Mic} size={22} />
          </Round>
          <Round label="End voice mode" onClick={v.end} className="bg-surface-2 text-fg hover:bg-surface-3">
            <Icon icon={X} size={22} />
          </Round>
        </div>
      </div>
    </section>
  );
}
