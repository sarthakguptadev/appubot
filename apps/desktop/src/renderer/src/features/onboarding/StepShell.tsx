import type { ReactNode } from 'react';
import { ArrowLeft } from '../../components/ui/icons';
import { Button, cn } from '../../components/ui';

/** how wide a step's content is (its footer is always the widest, so Back and the actions never move between steps) */
const WIDTHS = { sm: 'max-w-[460px]', md: 'max-w-[720px]', lg: 'max-w-[860px]', xl: 'max-w-[1040px]' } as const;

/**
 * One setup step: a centred title and line, the step's content, and a footer pinned to the window's bottom with Back
 * on the left and the step's actions on the right (macOS Setup Assistant's places, the same on every step).
 */
export function StepShell({ hero, title, body, children, onBack, actions, note, width = 'md', tight }: {
  /** above the title (Done's bot) */
  hero?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  children?: ReactNode;
  onBack?: () => void;
  /** the right of the footer: Skip/Later, then the primary action last */
  actions?: ReactNode;
  /** a quiet line before the actions */
  note?: ReactNode;
  width?: keyof typeof WIDTHS;
  /** less room between the title and a tall content (the plan cards) */
  tight?: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 overflow-y-auto px-10">
        <div className={cn('m-auto flex w-full flex-col items-center py-6 [@media(max-height:720px)]:py-3', WIDTHS[width])}>
          {hero}
          <h1 className="text-center font-display text-[32px] leading-[1.12] font-medium tracking-display text-balance text-fg [@media(max-height:720px)]:text-[26px]">{title}</h1>
          {body ? <p className="mt-2.5 max-w-[500px] text-center text-lead leading-relaxed text-balance text-fg-2 [@media(max-height:720px)]:mt-1.5 [@media(max-height:720px)]:text-copy">{body}</p> : null}
          {children ? <div className={cn('w-full', tight ? 'mt-6 [@media(max-height:720px)]:mt-4' : 'mt-9 [@media(max-height:720px)]:mt-5')}>{children}</div> : null}
        </div>
      </div>
      <footer className="shrink-0 px-10 pt-2 pb-7 [@media(max-height:720px)]:pb-4">
        <div className={cn('mx-auto flex w-full items-center gap-2', width === 'xl' ? WIDTHS.xl : 'max-w-[860px]')}>
          {onBack ? <Button size="lg" variant="ghost" icon={ArrowLeft} onClick={onBack}>Back</Button> : null}
          <div className="flex-1" />
          {note ? <span className="mr-2 min-w-0 truncate text-ui text-muted">{note}</span> : null}
          {actions}
        </div>
      </footer>
    </div>
  );
}
