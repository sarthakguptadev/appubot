// Disclosure motion shared by the transcript (Synara's disclosureMotion + DisclosureRegion, MIT): height animates
// through grid-template-rows while the content fades and drifts; a closed region is inert. Children mount on first
// open and unmount shortly after closing.
import { useEffect, useState, type ReactNode } from 'react';
import { Icon, cn } from '../../components/ui';
import { ChevronRight } from '../../components/ui/icons';

export const DISCLOSURE_MS = 220;
export const DISCLOSURE_CLEANUP_MS = 40;

export function DisclosureChevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <Icon
      icon={ChevronRight}
      size={14}
      className={cn('size-3.5 shrink-0 text-muted transition-transform duration-[220ms] ease-out motion-reduce:transition-none', open && 'rotate-90', className)}
    />
  );
}

/** Animated region; renders nothing until first opened, and drops its children shortly after closing. */
export function DisclosureRegion({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), DISCLOSURE_MS + DISCLOSURE_CLEANUP_MS);
    return () => clearTimeout(t);
  }, [open]);

  if (!mounted) return null;
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-[220ms] ease-out motion-reduce:transition-none',
        shown ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
      )}
      aria-hidden={open ? undefined : true}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className={cn(
            'transition-[opacity,translate] duration-[220ms] ease-out motion-reduce:transition-none',
            shown ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-1 opacity-0',
            className,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
