import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { IconComponent } from './icons';
import { cn } from './cn';
import { Icon } from './Icon';
import { radioTarget } from './menuKeys';
import { SEGMENT, SEGMENT_SIZE, SEGMENT_TRACK, SegmentChip } from './Tabs';

/*
 * The Settings window's building blocks (T3 Code's settingsLayout.tsx / SettingsGroup.tsx, in AppuBot colours), shared
 * by every dialog so a bot's editor, a routine or Add custom read like a Settings page: titled cards of rows with
 * hairlines between them, a 14px row title over a 12px description, the control at the right.
 */

/**
 * Grouped settings card, a Rare UI card: the raised tone, squircle corners and a soft shadow for its edge (no
 * border); rows stack with dividers. Focus outlines sit inside it (the card clips anything outside, which left a
 * stray line under a focused row).
 */
export const SETTINGS_CARD = '[&_:focus-visible]:outline-offset-[-2px] squircle overflow-hidden rounded-card bg-surface shadow-raised';
/**
 * Hairlines between stacked rows of a card or inset list. The last row carries the hairline's colour too: a row that
 * stops being last (a folded group opening) would otherwise fade its new border in from the text colour, a white flash.
 */
export const ROW_DIVIDERS = 'divide-y divide-[color-mix(in_srgb,var(--ab-fg)_5%,transparent)] *:border-[color-mix(in_srgb,var(--ab-fg)_5%,transparent)]';
/** Row padding inside a settings card. */
export const SETTINGS_ROW = 'px-4 py-3.5';
export const SETTINGS_ROW_TITLE = 'text-copy font-semibold tracking-ui text-fg';
export const SETTINGS_ROW_DESCRIPTION = 'max-w-2xl text-ui leading-[18px] text-muted';
/** A section's title above its card: T3 Code's 16px semibold heading. */
export const SETTINGS_SECTION_TITLE = 'flex min-h-7 items-center gap-2 text-title font-semibold tracking-ui text-fg';
/** A row that is a button (a menu of choices drawn as a card): Settings' nav hover, a quiet fill. */
export const SETTINGS_ROW_BUTTON =
  'flex w-full items-center gap-3 text-left outline-none hover:bg-[color-mix(in_srgb,var(--ab-fg)_4%,transparent)] ' +
  'focus-visible:bg-[color-mix(in_srgb,var(--ab-fg)_4%,transparent)]';

/** Card shell for groups that draw their own rows. */
export function SettingsCard({ children, className, divided = true }: { children: ReactNode; className?: string; divided?: boolean }) {
  return <div className={cn(SETTINGS_CARD, divided && ROW_DIVIDERS, className)}>{children}</div>;
}

/**
 * One row of a settings card: an optional icon, the title and its description, the control at the right. Settings'
 * own `SettingRow` adds its search anchor on top of this; dialogs use it as is.
 */
export function CardRow({ icon, title, description, children, className, id }: {
  icon?: IconComponent; title: ReactNode; description?: ReactNode; children?: ReactNode; className?: string; id?: string;
}) {
  return (
    <div id={id} className={cn(SETTINGS_ROW, 'flex items-center gap-3', className)}>
      {icon ? <Icon icon={icon} size={16} className="shrink-0 self-start mt-0.5 text-muted" /> : null}
      <div className="min-w-0 flex-1 space-y-1">
        <div className={cn(SETTINGS_ROW_TITLE, 'flex min-h-5 items-center gap-1.5')}>{title}</div>
        {description ? <div className={SETTINGS_ROW_DESCRIPTION}>{description}</div> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center justify-end gap-2">{children}</div> : null}
    </div>
  );
}

/** A titled group inside a dialog: the section title (smaller than a Settings page's) above its card. */
export function CardSection({ title, action, children, className, bare }: {
  title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
  /** render children without the card (they bring their own) */
  bare?: boolean;
}) {
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      {title || action ? (
        <div className="flex min-h-6 items-center justify-between gap-3">
          {title ? <h3 className="text-ui font-semibold tracking-ui text-fg">{title}</h3> : <span />}
          {action ? <div className="flex items-center gap-1">{action}</div> : null}
        </div>
      ) : null}
      {bare ? children : <SettingsCard>{children}</SettingsCard>}
    </section>
  );
}

/** A handful of choices in place of a select: segments on a track, the chosen one a raised chip. */
export function SettingsSegmented<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const onSegmentKey = (e: ReactKeyboardEvent) => {
    const at = options.findIndex((o) => o.value === value);
    const next = radioTarget(e.key, at, options.length);
    if (next === null) return;
    const target = options[next];
    if (!target) return;
    e.preventDefault();
    onChange(target.value);
    groupRef.current?.querySelectorAll('button')[next]?.focus();
  };
  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      className={cn(SEGMENT_TRACK, 'flex w-full sm:inline-flex sm:w-auto')}
      onKeyDown={onSegmentKey}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            className={cn(SEGMENT, SEGMENT_SIZE.md, 'flex-1 sm:flex-none', active ? 'text-fg' : 'text-muted hover:text-fg')}
            onClick={() => onChange(o.value)}
          >
            {active ? <SegmentChip /> : null}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
