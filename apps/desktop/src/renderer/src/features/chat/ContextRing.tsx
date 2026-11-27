import { memo, useRef, useState } from 'react';
import type { Bot, Thread } from '@appubot/protocol';
import { formatTokens } from '@appubot/chat-core';
import { Button, Popover, cn } from '../../components/ui';
import { call } from '../../lib/actions';
import { wantCommands } from './threadCommands';

/*
 * How full the chat's context is (Synara's ring beside the model): the agent's own count (`Thread.context`, from ACP
 * `usage_update`). It fills as the conversation grows; near the top the agent compacts it (sums up the earlier turns to
 * make room). Clicking it says how full, and offers "Compact now" where the agent has a /compact command.
 */

const R = 7;
const C = 2 * Math.PI * R;

export const ContextRing = memo(function ContextRing({ thread, bot }: { thread?: Thread; bot?: Bot }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const ctx = thread?.context;
  if (!thread || !ctx) return null;
  const share = Math.min(1, ctx.used / ctx.size);
  const pct = Math.round(share * 100);
  const tone = share >= 0.95 ? 'text-danger' : share >= 0.8 ? 'text-warning' : 'text-fg-2';
  const canCompact = thread.commands.some((c) => c.name === 'compact');
  const busy = thread.status === 'running' || thread.status === 'waiting';
  const name = bot?.name ?? 'The bot';

  const compact = async () => {
    setOpen(false);
    await call('chat.send', { threadId: thread.id, text: '/compact', attachments: [], images: [] }, { errorTitle: 'Could not compact the chat' });
  };

  return (
    <>
      <span ref={anchor} className="inline-flex">
        <button
          type="button"
          aria-label={`Context ${pct}% full`}
          aria-expanded={open}
          title={`Context ${pct}% full`}
          onClick={() => { if (!open) wantCommands(thread.id); setOpen((o) => !o); }}
          className={cn('flex size-7 items-center justify-center rounded-full hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]', tone)}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
            <circle cx="9" cy="9" r={R} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.2" />
            <circle
              cx="9" cy="9" r={R} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
              strokeDasharray={`${Math.max(share * C, share > 0 ? 1.5 : 0)} ${C}`} transform="rotate(-90 9 9)"
              className="transition-[stroke-dasharray] duration-500"
            />
          </svg>
        </button>
      </span>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} side="top" align="end" label="Context" className="w-[280px] rounded-card">
        <div className="flex flex-col gap-2.5 p-3.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-copy font-medium text-fg">Context</span>
            <span className={cn('text-note tabular-nums', tone)}>{pct}% full</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div className={cn('h-full rounded-full bg-current', tone)} style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
          <p className="text-note tabular-nums text-muted">{formatTokens(ctx.used)} of {formatTokens(ctx.size)} tokens</p>
          <p className="text-note leading-snug text-muted">
            When it fills up, {name} compacts the chat: it sums up the earlier turns to make room and carries on.
          </p>
          {canCompact ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void compact()} title={busy ? `Once ${name} is done` : undefined}>
              Compact now
            </Button>
          ) : null}
        </div>
      </Popover>
    </>
  );
});
