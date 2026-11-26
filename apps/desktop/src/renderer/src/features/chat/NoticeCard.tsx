// The notices above the composer, in the composer's own look (`.chat-composer-surface`: its surface, hairline and
// shadow), so they read as part of it: neutral surfaces and ink, colour only where it means something (a dot on the
// icon for a warning or a problem, a check for what's granted).
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import type { IconComponent } from '../../components/ui/icons';
import { Icon, Spinner, cn } from '../../components/ui';

/**
 * A one-line notice above the composer: the composer's surface and shape (a rounded rectangle, never a pill: the
 * owner's call, 2026-11-15), its corner following its button's (8px + the 6px around it); add the row's own layout.
 */
export const NOTICE_LINE = 'chat-composer-surface ab-pill squircle mb-1.5 flex min-h-10 min-w-0 items-center gap-2 rounded-pop py-1.5 pr-1.5 pl-3.5 text-ui';

/** What a notice's dot says: `attention` something to do, `danger` something wrong; none for plain news. */
export type NoticeTone = 'attention' | 'danger';
const DOT: Record<NoticeTone, string> = { attention: 'bg-attention', danger: 'bg-danger' };

/**
 * A card above the composer: a neutral tile with its icon (a small dot when it needs the user), the title, a line or
 * two under it, then its actions (ghost and primary Buttons).
 */
export function NoticeCard({ icon, tone, spinning, title, detail, children }: {
  icon: IconComponent; tone?: NoticeTone; spinning?: boolean; title: string; detail?: ReactNode; children?: ReactNode;
}) {
  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, y: 6, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="chat-composer-surface squircle relative mb-2 flex min-w-0 items-center gap-3 rounded-card p-2.5"
    >
      <span className="ab-pill relative flex size-9 shrink-0 items-center justify-center rounded-control-lg bg-surface-2 text-muted">
        {spinning ? <Spinner size={16} /> : <Icon icon={icon} size={17} />}
        {tone ? (
          <span aria-hidden className={cn('absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-[color:var(--ab-content)]', DOT[tone])} />
        ) : null}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-copy font-medium text-fg" title={title}>{title}</p>
        {typeof detail === 'string' ? <p className="mt-0.5 line-clamp-2 text-note leading-snug text-muted">{detail}</p>
          : detail ? <div className="mt-0.5 text-note leading-snug text-muted">{detail}</div> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-1">{children}</div> : null}
    </motion.div>
  );
}
