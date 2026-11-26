/**
 * The permission mode as Synara's mode menu: a row per option with its icon, title and a two-line description, the
 * current one in the accent with a ✓. AppuBot offers only Auto ("Approve for me") and Bypass ("Full access"); their
 * names and descriptions are the agent runtime's (`PROVIDER_MODES`, through the modes a session or
 * `providers.choices` reports), only the icons are chosen here. Used by the composer (the running thread), the bot
 * editor and Settings' default.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import type { SessionMode } from '@appubot/protocol';
import { Check, ChevronDown, ShieldAlert, ShieldCheck, type IconComponent } from '../../components/ui/icons';
import { Icon, Popover, cn } from '../../components/ui';
import { CHROME_TRIGGER, FIELD_TRIGGER } from './ModelPicker';
import { useChoices } from './useChoices';

/** Each agent's Auto and Bypass ids (Settings' default is stored as Claude Code's: `auto`, `bypassPermissions`). */
const MODE_KIND: Record<string, 'auto' | 'bypass'> = { auto: 'auto', agent: 'auto', bypassPermissions: 'bypass', 'agent-full-access': 'bypass' };
const KIND_ICON: Record<'auto' | 'bypass', IconComponent> = { auto: ShieldCheck, bypass: ShieldAlert };
const GENERIC_ID: Record<string, string> = { auto: 'auto', bypass: 'bypassPermissions' };
/** before the agent has said which modes it has */
const KIND_FALLBACK: Record<'auto' | 'bypass', string> = { auto: 'Auto', bypass: 'Bypass' };

const iconOf = (id: string): IconComponent => KIND_ICON[MODE_KIND[id] ?? 'auto'];

/** A mode as AppuBot's own choice, stored as Claude Code's id (`auto`, `bypassPermissions`); '' when it is neither. */
export function genericMode(id: string): string {
  const kind = MODE_KIND[id];
  return kind ? GENERIC_ID[kind]! : '';
}

/** `value` as one of `modes`: itself, else the mode of the same kind (Claude Code's `auto` is Codex's `agent`). */
export function shownMode(modes: readonly SessionMode[], value: string): string {
  if (modes.some((m) => m.id === value)) return value;
  const kind = MODE_KIND[value];
  return (kind && modes.find((m) => MODE_KIND[m.id] === kind)?.id) || value;
}

export function PermissionPicker({ providerId, value, onChange, modes: own, generic, variant = 'field', side = 'bottom', align = 'start', label = 'Permissions', className }: {
  providerId: string;
  value: string;
  onChange: (modeId: string) => void;
  /** the thread's own modes (the composer); otherwise read with `useChoices` */
  modes?: SessionMode[];
  /** store the pick as Claude Code's id (`auto`, `bypassPermissions`), as Settings' default is */
  generic?: boolean;
  variant?: 'chrome' | 'field';
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  label?: string;
  className?: string;
}) {
  const read = useChoices(providerId, !own);
  const modes = own ?? read.modes;
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const shown = shownMode(modes, value);
  const current = modes.find((m) => m.id === shown);
  const kind = MODE_KIND[shown];
  const name = current?.name ?? (read.loading && !own ? 'Loading…' : kind ? KIND_FALLBACK[kind] : value || "Agent's default");
  const pickable = modes.length > 1 || (modes.length === 1 && !current);

  const content = (
    <>
      <Icon icon={iconOf(shown)} size={variant === 'chrome' ? 14 : 15} className={cn('shrink-0', variant === 'field' && 'text-fg-2')} />
      <span className="min-w-0 truncate">{name}</span>
    </>
  );

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  if (!pickable) {
    return variant === 'chrome'
      ? <span className={cn(CHROME_TRIGGER, 'hover:bg-transparent hover:text-muted', className)}>{content}</span>
      : <span className={cn('inline-flex w-full min-w-0', className)}><button type="button" disabled aria-label={label} className={FIELD_TRIGGER}>{content}</button></span>;
  }

  return (
    <>
      <span ref={anchor} className={cn('inline-flex min-w-0', variant === 'field' && 'w-full', className)}>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={variant === 'chrome' ? cn(CHROME_TRIGGER, kind === 'bypass' && 'text-accent hover:text-accent aria-expanded:text-accent') : FIELD_TRIGGER}
        >
          {content}
          <Icon icon={ChevronDown} size={variant === 'chrome' ? 12 : 14} className={cn('shrink-0 text-muted', variant === 'chrome' ? 'opacity-70' : 'ms-auto')} />
        </button>
      </span>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} side={side} align={align} label={label} className="squircle w-[300px] rounded-card">
        <div ref={panel} role="menu" aria-label={label} onKeyDown={onKey} className="flex flex-col gap-0.5 p-1.5">
          {modes.map((m, i) => {
            const on = m.id === shown;
            return (
              <button
                key={m.id}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                autoFocus={on || (!current && i === 0)}
                onClick={() => { setOpen(false); if (!on) onChange(generic ? GENERIC_ID[MODE_KIND[m.id] ?? ''] ?? m.id : m.id); }}
                className={cn(
                  'squircle flex w-full items-start gap-2.5 rounded-card px-2.5 py-2.5 text-left transition-colors duration-100 outline-none',
                  on ? 'bg-accent-soft' : 'hover:bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)]',
                )}
              >
                <Icon icon={iconOf(m.id)} size={16} className={cn('mt-px shrink-0', on ? 'text-accent' : 'text-fg-2')} />
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-copy font-medium', on ? 'text-accent' : 'text-fg')}>{m.name}</span>
                  {m.description ? <span className={cn('mt-0.5 line-clamp-2 block text-note leading-snug', on ? 'text-accent/80' : 'text-muted')}>{m.description}</span> : null}
                </span>
                {on ? <Icon icon={Check} size={14} className="mt-0.5 shrink-0 text-accent" /> : <span className="size-3.5 shrink-0" />}
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}
