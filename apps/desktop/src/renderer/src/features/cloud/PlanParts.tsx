import type { CSSProperties, ReactNode } from 'react';
import { AlertTriangle, Cloud, Laptop, Info } from '../../components/ui/icons';
import { teamTint } from '@appubot/chat-core';
import { Icon, LogoMark, SETTINGS_CARD, cn } from '../../components/ui';

/*
 * The pieces Settings › Billing and Team are built from (the 2026-11-05 revamp, direction A "Plan cards", after
 * Vercel's and Cursor's billing pages): every computer has a tile (a cloud for a cloud computer, your own on the quiet
 * fill, a team's tinted with its colour; a laptop for this Mac), a team itself AppuBot's mark on its colour, every plan is a card (a coloured band when something needs
 * the person, the head with the tile, name, badges and one action, then a strip of facts with meters), and plain
 * rows link out (payments, starting a team).
 */

/**
 * A tile's size and corner: a quarter of its size, the app icon's own rounding (Account's computers use 9px at 36),
 * as `TILE` reads it; a circle in the Round look (`ab-pill`).
 */
const tile = (size: number, rest?: CSSProperties) => ({ width: size, height: size, '--tile-r': `${Math.round(size * 0.25)}px`, ...rest }) as CSSProperties;
const TILE = 'ab-pill rounded-(--tile-r)';

/**
 * A cloud computer ("Sarthak’s Cloud Computer", "Acme Cloud Computer"): a cloud on the quiet fill, like This Mac's
 * laptop; a team's (`team`: its bare name) wears the team's colour (`teamTint`) faintly behind and on the cloud. `warn`
 * rings it amber (on hold or suspended: the switcher).
 */
export function CloudTile({ team, size = 40, warn, className }: { team?: string | null; size?: number; warn?: boolean; className?: string }) {
  const tint = team != null ? teamTint(team) : null;
  return (
    <span
      aria-hidden
      className={cn(TILE, 'flex shrink-0 items-center justify-center', !tint && 'bg-surface-3 text-fg-2', warn && 'outline-[1.5px] outline-offset-1 outline-warning outline-solid', className)}
      style={tile(size, tint ? { background: `color-mix(in srgb, ${tint} 16%, transparent)`, color: tint } : undefined)}
    >
      <Icon icon={Cloud} size={Math.round(size * (size < 20 ? 0.72 : 0.5))} strokeWidth={size < 20 ? 2 : undefined} />
    </span>
  );
}

/**
 * A team itself (its page's header, an invite, its payments): AppuBot's mark (the app icon's visor and eyes) on the
 * team's own colour (`teamTint`, from its name), the tile's shape, so each team has its own colour. Its computer is a
 * `CloudTile` in that colour.
 * `warn` rings it amber (on hold or suspended: the switcher).
 */
export function TeamTile({ name, size = 40, warn, className }: { name: string; size?: number; warn?: boolean; className?: string }) {
  const tint = teamTint(name);
  return (
    <span
      aria-hidden
      className={cn(TILE, 'flex shrink-0 overflow-hidden shadow-[inset_0_0_0_1px_rgba(255,255,255,.12)]', warn && 'outline-[1.5px] outline-offset-1 outline-warning outline-solid', className)}
      style={tile(size, { background: `linear-gradient(180deg, color-mix(in srgb, ${tint} 86%, #fff), ${tint})` })}
    >
      <LogoMark size={size} />
    </span>
  );
}

/** This Mac (or PC): a laptop on the quiet fill. */
export function MacTile({ size = 40 }: { size?: number }) {
  return (
    <span aria-hidden className={cn(TILE, 'flex shrink-0 items-center justify-center bg-surface-3 text-fg-2')} style={tile(size)}>
      <Icon icon={Laptop} size={Math.round(size * 0.48)} />
    </span>
  );
}

/** A small square for a row's icon (payments, invoices, start a team). */
export function RowIcon({ children }: { children: ReactNode }) {
  return <span aria-hidden className="ab-pill flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2 text-fg-2">{children}</span>;
}

export type BandTone = 'danger' | 'warning' | 'neutral';
const BAND: Record<BandTone, string> = {
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
  neutral: 'bg-surface-2 text-fg-2',
};

/** The coloured line across a plan card's top when something needs the person, with its one fix. */
export function Band({ tone, children, action }: { tone: BandTone; children: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === 'neutral' ? undefined : 'alert'} className={cn('flex items-center gap-2.5 px-4 py-2.5 text-copy leading-5', BAND[tone])}>
      <Icon icon={tone === 'neutral' ? Info : AlertTriangle} size={15} className="shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {action ? <span className="shrink-0">{action}</span> : null}
    </div>
  );
}

export interface Fact {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** a meter under the value, 0..1 */
  meter?: number;
  /** the meter in the accent (the launch bonus), else ink (seats) */
  accent?: boolean;
  tone?: 'danger' | 'warning';
}

/** A plan card's strip of facts: label, value, a meter, a small line, side by side with hairlines between. */
export function Facts({ items }: { items: Fact[] }) {
  if (!items.length) return null;
  return (
    <div className={cn('grid border-t border-[color-mix(in_srgb,var(--ab-fg)_6%,transparent)]', COLS[Math.min(items.length, 4)])}>
      {items.map((f) => (
        <div key={f.label} className="min-w-0 px-4 py-3 not-first:border-l not-first:border-[color-mix(in_srgb,var(--ab-fg)_6%,transparent)]">
          <p className="text-note leading-4 text-muted">{f.label}</p>
          <p className={cn('mt-1 truncate text-copy leading-5 font-semibold tabular-nums', f.tone === 'danger' ? 'text-danger' : f.tone === 'warning' ? 'text-warning' : 'text-fg')}>{f.value}</p>
          {f.meter !== undefined ? <Meter value={f.meter} accent={f.accent} className="mt-2" /> : null}
          {f.sub ? <div className="mt-1 text-note leading-4 text-muted tabular-nums">{f.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}
const COLS: Record<number, string> = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-2 @2xl:grid-cols-4' };

export function Meter({ value, accent, className }: { value: number; accent?: boolean; className?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className={cn('h-1.5 overflow-hidden rounded-full bg-surface-3', className)}>
      <div className={cn('h-full rounded-full', accent ? 'bg-accent' : 'bg-fg')} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** One plan as a card: the band, the head (tile, name, badges, a line, actions), the facts, anything more. */
export function PlanCardBox({ band, tile, title, badges, line, actions, facts, children, className }: {
  band?: ReactNode; tile: ReactNode; title: ReactNode; badges?: ReactNode; line?: ReactNode; actions?: ReactNode; facts?: Fact[]; children?: ReactNode; className?: string;
}) {
  return (
    <article className={cn(SETTINGS_CARD, '@container', className)}>
      {band}
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          {tile}
          <div className="min-w-0">
            <h3 className="flex flex-wrap items-center gap-2 text-lead leading-5 font-semibold text-fg">{title}{badges}</h3>
            {line ? <p className="mt-0.5 text-copy leading-5 text-muted">{line}</p> : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {facts?.length ? <Facts items={facts} /> : null}
      {children}
    </article>
  );
}

/** A plain row that links somewhere: an icon or tile, a title and a line, its action at the right. */
export function LinkRow({ lead, title, description, action }: { lead: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      {lead}
      <div className="min-w-0 flex-1">
        <p className="text-copy leading-5 font-medium text-fg">{title}</p>
        {description ? <p className="text-ui leading-5 text-muted">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

/** a quiet text button (Cancel plan, Add seats inside a fact) */
export function QuietLink({ children, onClick, disabled, className }: { children: ReactNode; onClick: () => void; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn('rounded text-fg-2 underline decoration-[color-mix(in_srgb,var(--ab-fg)_25%,transparent)] underline-offset-[3px] transition-colors hover:text-fg hover:decoration-current focus-visible:ring-2 focus-visible:ring-[var(--ab-ring)] focus-visible:outline-none disabled:opacity-50', className)}
    >
      {children}
    </button>
  );
}
