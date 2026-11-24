import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/** A raised card in Rare UI's manner: the raised tone, squircle corners, and a soft shadow for an edge (no border). One you can press lifts under the pointer. */
export function Card({ interactive, className, ...rest }: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        'squircle rounded-card bg-surface shadow-raised',
        interactive && 'ab-press hover:-translate-y-0.5 hover:shadow-raised-hover',
        className,
      )}
      {...rest}
    />
  );
}
