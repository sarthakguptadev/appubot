// The image gallery's one host (after T3 Code's ExpandedImageDialog, MIT), mounted in ModalHost: the image opened
// over a dimmed backdrop, titled with its name when it has one; with more than one in the message, ‹ n / total ›
// under it and ←/→ to go round them. Esc, ✕ or the backdrop close it. Opened through `openGalleryAt` (imageGallery.ts).
import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight } from '../../components/ui/icons';
import { Button, Dialog } from '../../components/ui';
import { closeGallery, stepGallery, useGallery } from './imageGallery';

const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function ImageGallery() {
  const open = useGallery((s) => s.gallery);
  // keeps its picture while it animates out
  const last = useRef(open);
  if (open) last.current = open;
  const gallery = last.current;
  const item = gallery?.images[gallery.index];
  const count = gallery?.images.length ?? 0;

  useEffect(() => {
    if (!open || open.images.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || editable(e.target)) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      stepGallery(e.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <Dialog
      open={!!open}
      onClose={closeGallery}
      title={item?.title}
      size="lg"
      className={count > 1 ? '!w-auto min-w-[360px] max-w-[min(1100px,calc(100vw-48px))]' : '!w-auto max-w-[min(1100px,calc(100vw-48px))]'}
      bodyClassName="flex flex-col items-center p-3 pt-1"
    >
      {item ? (
        <img
          key={item.src}
          src={item.src}
          alt={item.title ?? ''}
          className={count > 1 ? 'max-h-[calc(100vh-200px)] max-w-full rounded-control object-contain' : 'max-h-[calc(100vh-160px)] max-w-full rounded-control object-contain'}
        />
      ) : null}
      {count > 1 ? (
        <div className="mt-2 flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" icon={ChevronLeft} aria-label="Previous image" title="Previous image" onClick={() => stepGallery(-1)} />
          <span className="min-w-12 text-center text-note text-muted tabular-nums" aria-live="polite">{gallery!.index + 1} / {count}</span>
          <Button variant="ghost" size="icon-sm" icon={ChevronRight} aria-label="Next image" title="Next image" onClick={() => stepGallery(1)} />
        </div>
      ) : null}
    </Dialog>
  );
}
