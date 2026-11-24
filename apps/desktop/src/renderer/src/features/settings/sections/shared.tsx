import type { ReactNode } from 'react';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, SETTINGS_SECTION_TITLE, SettingsCard, Spinner, cn } from '../../../components/ui';
import { settingAnchorId } from '../nav';

/** Change settings at once and persist them, in order, putting them back only if the computer refuses (lib/choices.ts). */
export { updateSettings } from '../../../lib/choices';

/* T3 Code's settings tokens and card live in components/ui (SettingsCard.tsx), shared with the dialogs. */
export {
  SETTINGS_CARD, ROW_DIVIDERS, SETTINGS_ROW, SETTINGS_ROW_TITLE, SETTINGS_ROW_DESCRIPTION, SETTINGS_SECTION_TITLE,
  SettingsCard, SettingsSegmented,
} from '../../../components/ui';

/** A labelled group of settings: section label (+ optional action and blurb) above a card. */
export function SettingsGroup({ title, description, action, children, className, bare }: {
  title?: string; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
  /** render children without the card (they bring their own) */
  bare?: boolean;
}) {
  return (
    <section id={title ? settingAnchorId(title) : undefined} className={cn('flex scroll-mt-24 flex-col gap-2.5 not-first:mt-8', className)}>
      {title ? (
        <div className="flex min-h-7 items-start justify-between gap-4">
          <h2 className={SETTINGS_SECTION_TITLE}>{title}</h2>
          {action ? <div className="flex min-h-7 items-center justify-end">{action}</div> : null}
        </div>
      ) : null}
      {description ? <p className="-mt-1 text-note leading-normal text-muted">{description}</p> : null}
      {bare ? children : <SettingsCard>{children}</SettingsCard>}
    </section>
  );
}

/** One title/description + control row inside a settings card. */
export function SettingRow({ title, description, children, className, controlClassName }: {
  title: ReactNode; description?: ReactNode; children?: ReactNode; className?: string;
  /** the control's column: e.g. let a wide control shrink (its own labels truncating) rather than squeeze the title */
  controlClassName?: string;
}) {
  return (
    <div id={typeof title === 'string' ? settingAnchorId(title) : undefined} className={cn(SETTINGS_ROW, 'scroll-mt-24', className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className={SETTINGS_ROW_TITLE}>{title}</h3>
          </div>
          {description ? <p className={SETTINGS_ROW_DESCRIPTION}>{description}</p> : null}
        </div>
        {children ? <div className={cn('flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end', controlClassName)}>{children}</div> : null}
      </div>
    </div>
  );
}

/** Read-only value row: the label as a row title, the value where a control would sit. */
export function InfoRow({ label, children, mono }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className={cn(SETTINGS_ROW, 'flex min-h-[45px] items-center justify-between gap-4')}>
      <div className={cn(SETTINGS_ROW_TITLE, 'shrink-0')}>{label}</div>
      <div className={cn('selectable flex min-w-0 justify-end text-right text-copy leading-snug break-words text-muted', mono && 'font-mono text-note')}>
        {children}
      </div>
    </div>
  );
}

/** Dashed placeholder block for empty / status copy. */
export function SettingsEmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-control-lg border border-dashed border-border-subtle bg-transparent px-4 py-10 text-center text-copy leading-snug text-muted', className)}>
      {children}
    </div>
  );
}

export function SectionLoading() {
  return (
    <div className="flex h-40 items-center justify-center text-muted">
      <Spinner size={20} />
    </div>
  );
}
