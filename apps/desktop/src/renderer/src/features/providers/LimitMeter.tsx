/**
 * Plan limits drawn: a small meter of what's left (neutral; amber at 20% or under, red when used up, amber "Extra
 * usage" when the agent carries on billed), the row's badge beside a model in the picker, the plan line under its
 * tabs ("Max | 5h ▬ 62%  Week ▬ 81%  ↻ 3h 10m") and the card listing every window that counts a model (the hover
 * card, Settings › Usage's rows). The numbers come from chat-core `limits.ts`.
 */
import type { ReactNode } from 'react';
import type { LimitWindow, ProviderLimits } from '@appubot/protocol';
import { backInText, limitLeftText, modelLimitText, planLine, resetText, shortPlanName, updatedAgoText, windowLeft, windowModelsText, windowOut, limitTone, carriesOn, type LimitTone, type ModelLimits, type ModelRef } from '@appubot/chat-core';
import { RefreshCw } from '../../components/ui/icons';
import { Icon, cn } from '../../components/ui';

export const TONE_TEXT: Record<LimitTone, string> = { ok: 'text-muted', low: 'text-attention', out: 'text-danger', extra: 'text-attention' };
const TONE_FILL: Record<LimitTone, string> = { ok: 'bg-[color-mix(in_srgb,var(--ab-fg)_42%,transparent)]', low: 'bg-attention', out: 'bg-danger', extra: 'bg-attention' };
const TRACK = 'bg-[color-mix(in_srgb,var(--ab-fg)_10%,transparent)]';

/** A bar filled with what's left. */
export function LimitMeter({ left, tone, className, style }: { left: number; tone: LimitTone; className?: string; style?: React.CSSProperties }) {
  const pct = Math.max(0, Math.min(100, left));
  return (
    <span aria-hidden className={cn('relative inline-block h-1 w-6 shrink-0 overflow-hidden rounded-full', TRACK, className)} style={style}>
      <span className={cn('absolute inset-y-0 left-0 rounded-full', TONE_FILL[tone])} style={{ width: `${pct}%`, minWidth: pct > 0 ? 2 : 0 }} />
    </span>
  );
}

/** Beside a model's name in the picker: the meter and "62%", or "Back in 1h 20m" / "Extra usage" alone. */
export function ModelLimitBadge({ limits, now }: { limits: ModelLimits; now: number }) {
  const text = modelLimitText(limits, now);
  if (limits.tone === 'out' || limits.tone === 'extra') {
    return <span className={cn('shrink-0 text-[11px] whitespace-nowrap', TONE_TEXT[limits.tone])}>{text}</span>;
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" title={`${limitLeftText(limits.left)} of ${limits.binding.label}`}>
      <LimitMeter left={limits.left} tone={limits.tone} />
      <span className={cn('w-7 text-right text-[11px] tabular-nums', TONE_TEXT[limits.tone])}>{text}</span>
    </span>
  );
}

/** Under the picker's tabs: the plan, each shared window's meter and what's left, and the time to the soonest reset. */
export function PlanLineRow({ limits, now, className }: { limits: ProviderLimits | undefined; now: number; className?: string }) {
  const line = planLine(limits, now);
  if (!line) return null;
  return (
    <div className={cn('flex h-[30px] shrink-0 items-center gap-2 px-3 text-note whitespace-nowrap', className)}>
      {line.plan ? <span className="max-w-[5rem] shrink-0 truncate font-medium text-fg" title={line.plan}>{shortPlanName(line.plan)}</span> : null}
      {line.plan && line.items.length ? <span aria-hidden className="h-3.5 w-px shrink-0 bg-[color-mix(in_srgb,var(--ab-fg)_15%,transparent)]" /> : null}
      <span className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
        {line.items.map((it) => (
          <span key={it.label} className="inline-flex shrink-0 items-center gap-1" title={it.resetsAt ? resetText(it.resetsAt, now) : undefined}>
            <span className="text-muted">{it.label}</span>
            <LimitMeter left={it.left} tone={it.tone} className="w-5" />
            <span className={cn('tabular-nums', it.tone === 'ok' ? 'text-fg-2' : TONE_TEXT[it.tone])}>{it.tone === 'out' ? '0%' : `${it.left}%`}</span>
          </span>
        ))}
      </span>
      {line.resetIn ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-muted tabular-nums" title="Until the soonest reset">
          <Icon icon={RefreshCw} size={11} />{line.resetIn}
        </span>
      ) : null}
    </div>
  );
}

/** One window as a row: label (and which models), a wide meter, what's left, when it resets. */
export function LimitWindowRow({ w, limits, models, now, tight, compact, card }: {
  w: LimitWindow; limits: ProviderLimits; models?: readonly ModelRef[]; now: number;
  /** marked as the tightest of the card's windows */
  tight?: boolean;
  /** smaller type, the meter under the words (a narrow Settings card, the picker's hover card) */
  compact?: boolean;
  /** inside the picker's hover card (no row padding of its own) */
  card?: boolean;
}) {
  const left = windowLeft(w, now);
  const out = windowOut(w, now);
  const tone = limitTone(left, out, carriesOn(limits));
  const reset = out && !carriesOn(limits) ? backInText(w.resetsAt, now) : resetText(w.resetsAt, now);
  const who = models ? windowModelsText(w, models) : undefined;
  if (compact) {
    return (
      <div className={cn('flex flex-col gap-1 py-1.5', !card && 'px-4 py-2.5')}>
        <div className="flex items-center gap-2 text-note">
          <span className="min-w-0 flex-1 truncate text-fg">{w.label}</span>
          {tight ? <span className="ab-pill shrink-0 rounded-[5px] bg-attention/15 px-1 text-[10px] text-attention">tightest</span> : null}
          <span className={cn('shrink-0 tabular-nums', tone === 'ok' ? 'text-fg-2' : TONE_TEXT[tone])}>{out ? (tone === 'extra' ? 'Extra usage' : 'Used up') : limitLeftText(left)}</span>
        </div>
        <LimitMeter left={out ? 0 : left} tone={tone} className="h-[3px] w-full" />
        {reset ? <div className="text-[11px] text-muted">{reset}</div> : null}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[minmax(7rem,1.1fr)_minmax(0,2fr)_6.5rem_minmax(8rem,1fr)] items-center gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-copy font-medium text-fg">
          <span className="truncate">{w.label}</span>
          {tone === 'low' ? <span className="ab-pill shrink-0 rounded-md bg-attention/15 px-1.5 text-[11px] font-normal text-attention">Low</span> : null}
          {out ? <span className={cn('ab-pill shrink-0 rounded-md px-1.5 text-[11px] font-normal', tone === 'extra' ? 'bg-attention/15 text-attention' : 'bg-danger/15 text-danger')}>{tone === 'extra' ? 'Extra usage' : 'Used up'}</span> : null}
        </div>
        {who ? <div className="truncate text-note text-muted">{who}</div> : null}
      </div>
      <LimitMeter left={out ? 0 : left} tone={tone} className="h-1.5 w-full" />
      <span className={cn('text-right text-copy whitespace-nowrap tabular-nums', tone === 'ok' ? 'text-fg' : TONE_TEXT[tone])}>{out ? (tone === 'extra' ? 'Billed' : backInText(w.resetsAt, now)) : limitLeftText(left)}</span>
      <span className="truncate text-right text-note text-muted tabular-nums">{out && tone !== 'extra' ? '' : reset}</span>
    </div>
  );
}

/** The windows that count one model, the tightest marked: the picker's hover card. */
export function ModelLimitsCard({ title, subtitle, limits, model, now, className, style }: {
  title: ReactNode; subtitle?: ReactNode; limits: ProviderLimits; model: ModelLimits; now: number; className?: string; style?: React.CSSProperties;
}) {
  return (
    <div role="tooltip" className={cn('w-[300px] rounded-card border border-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)] bg-content p-3.5 shadow-[0_12px_40px_rgba(0,0,0,.35)]', className)} style={style}>
      <div className="text-copy font-semibold text-fg">{title}</div>
      {subtitle ? <div className="mt-0.5 text-note text-muted">{subtitle}</div> : null}
      <div className="mt-2 divide-y divide-[color-mix(in_srgb,var(--ab-fg)_6%,transparent)]">
        {model.windows.map((w) => <LimitWindowRow key={w.id} w={w} limits={limits} now={now} tight={model.windows.length > 1 && w.id === model.binding.id} compact card />)}
      </div>
      <div className="mt-1.5 text-[11px] text-muted">{updatedAgoText(limits.updatedAt, now)}</div>
    </div>
  );
}
