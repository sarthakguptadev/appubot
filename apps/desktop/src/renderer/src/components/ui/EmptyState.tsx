import type { ReactNode } from 'react';
import type { LucideIcon } from './icons';
import { cn } from './cn';
import { Icon } from './Icon';

export function EmptyState({ icon, title, body, action, className }: { icon?: LucideIcon; title: ReactNode; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      {icon ? (
        <div className="ab-pill squircle mb-1 flex size-11 items-center justify-center rounded-[14px] bg-surface-2 text-muted">
          <Icon icon={icon} />
        </div>
      ) : null}
      <div className="text-title font-semibold tracking-ui text-fg">{title}</div>
      {body ? <div className="max-w-[300px] text-copy leading-relaxed text-muted">{body}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
