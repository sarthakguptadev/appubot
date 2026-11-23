import type { ReactNode } from 'react';
import { cn } from './cn';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded-[6px] bg-surface-2 px-1 font-sans text-[11px] font-semibold text-muted', className)}>
      {children}
    </kbd>
  );
}
