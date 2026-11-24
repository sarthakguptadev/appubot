import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { EASE_T3 } from '../../lib/motion';
import { X } from './icons';
import { cn } from './cn';
import { Button } from './Button';

const stack: string[] = [];
/** True when any dialog is open (lets global shortcuts like Esc-to-reject stand down). */
export function isDialogOpen(): boolean {
  return stack.length > 0;
}

const watchers = new Set<() => void>();
const changed = () => { for (const w of watchers) w(); };
/** True while any dialog is open, as a hook (What's new waits for them to close before it opens by itself). */
export function useDialogOpen(): boolean {
  return useSyncExternalStore((w) => { watchers.add(w); return () => { watchers.delete(w); }; }, isDialogOpen);
}

/**
 * A full-window screen that isn't a `Dialog` counts as one while it is up (the launch gift): what opens by itself
 * (What's new) waits for it, and global shortcuts stand down.
 */
export function useModalPresence(open: boolean): void {
  const id = useId();
  useEffect(() => {
    if (!open) return;
    stack.push(id);
    changed();
    return () => { const i = stack.indexOf(id); if (i >= 0) stack.splice(i, 1); changed(); };
  }, [open, id]);
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The Settings window's look, shared by every dialog: the page dimmed toward the content colour and softly blurred
 * behind a solid content surface with a hairline edge, 2xl corners and a deep shadow (T3 Code's dialog).
 */
export const MODAL_BACKDROP = 'bg-[color-mix(in_srgb,var(--ab-content)_64%,transparent)] backdrop-blur-[4px]';
export const MODAL_SURFACE =
  'squircle rounded-sheet bg-[var(--ab-content)] text-fg shadow-[0_0_0_1px_var(--ab-hairline),0_25px_50px_-12px_rgba(0,0,0,.4)]';

const sizes = { sm: 'w-[400px]', md: 'w-[520px]', lg: 'w-[720px]', xl: 'w-[min(1040px,calc(100vw-48px))] h-[min(720px,calc(100vh-48px))]' } as const;

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof sizes;
  className?: string;
  bodyClassName?: string;
  hideClose?: boolean;
  /** the dialog's name for screen readers when it shows no title (the command palette) */
  label?: string;
}

function Panel({ onClose, title, description, children, footer, size = 'md', className, bodyClassName, hideClose, label }: Omit<DialogProps, 'open'>) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    stack.push(id);
    changed();
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    // React's autoFocus focuses its field on mount without leaving an attribute: keep that focus if it's inside
    requestAnimationFrame(() => { if (!el?.contains(document.activeElement)) (first ?? el)?.focus(); });
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === 'Escape') { if (e.defaultPrevented) return; e.preventDefault(); onClose(); return; }
      // a menu inside the dialog handles its own Tab (it closes and gives focus back to its trigger)
      if (e.key === 'Tab' && el && !e.defaultPrevented) {
        const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
          // only what Tab can reach: visible, and not taken out of the order (a listbox's options, tabIndex -1)
          .filter((x) => x.offsetParent !== null && x.tabIndex >= 0);
        if (!items.length) return;
        const firstEl = items[0]!;
        const lastEl = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = stack.indexOf(id);
      if (i !== -1) stack.splice(i, 1);
      changed();
      prev?.focus?.();
    };
  }, [id, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <motion.div
        className={cn('absolute inset-0', MODAL_BACKDROP)}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease: EASE_T3 }}
        onMouseDown={onClose}
      />
      <motion.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        // named and described by its own header, so a screen reader announces what opened
        aria-labelledby={title ? `${id}-title` : undefined}
        aria-label={title ? undefined : label}
        aria-describedby={description ? `${id}-description` : undefined}
        tabIndex={-1}
        className={cn(MODAL_SURFACE, 'no-drag relative flex max-h-[calc(100vh-48px)] flex-col overflow-hidden outline-none', sizes[size], className)}
        // T3 Code's dialog: a 200ms fade from 98%, the same way out
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.2, ease: EASE_T3 }}
      >
        {title || !hideClose ? (
          // Settings' page header, a step down: the title in the system face, semibold, its line under it
          <div className="flex items-start gap-3 px-6 pt-5 pb-1">
            <div className="min-w-0 flex-1">
              {title ? <h2 id={`${id}-title`} className="text-[18px] leading-tight font-semibold tracking-ui text-fg">{title}</h2> : null}
              {description ? <p id={`${id}-description`} className="mt-1 text-copy leading-normal text-muted">{description}</p> : null}
            </div>
            {!hideClose ? <Button variant="ghost" size="icon-sm" icon={X} aria-label="Close" onClick={onClose} className="-mt-1 -mr-2.5" /> : null}
          </div>
        ) : null}
        <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 py-4', bodyClassName)}>{children}</div>
        {footer ? <div className="flex items-center justify-end gap-2 border-t border-[color-mix(in_srgb,var(--ab-fg)_6%,transparent)] px-6 py-3.5">{footer}</div> : null}
      </motion.div>
    </div>
  );
}

export function Dialog(props: DialogProps) {
  const { open, ...rest } = props;
  // no DOM (a server render in tests): nothing to portal into
  if (typeof document === 'undefined') return null;
  return createPortal(<AnimatePresence>{open ? <Panel key="dialog" {...rest} /> : null}</AnimatePresence>, document.body);
}
