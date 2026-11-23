// Quote a reply (T3 Code's "Cite in composer"): select text inside one of the bot's replies and a small "Quote" button
// floats above the selection; it hands the words to the composer (QUOTE_EVENT), which shows them as a quote above your
// message and sends them as a Markdown quote before it, so the bot knows exactly what you mean.
import { useEffect, useState } from 'react';
import { MessageSquare } from '../../components/ui/icons';
import { Icon } from '../../components/ui';

export const QUOTE_EVENT = 'appubot:quote';
export interface QuoteRequest { threadId: string; text: string }

/** Longest quote kept (a whole long reply can still be selected; its start is what matters). */
const QUOTE_MAX = 2000;

export function QuoteSelection({ threadId }: { threadId: string }) {
  const [at, setAt] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const sel = window.getSelection();
      const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
      const node = range?.commonAncestorContainer;
      const el = node instanceof Element ? node : node?.parentElement;
      // one reply of this chat only: a selection across two messages, or outside the transcript, quotes nothing
      const inReply = el?.closest('[data-quotable]') && el.closest('[data-transcript]')?.getAttribute('data-transcript') === threadId;
      const text = inReply ? sel!.toString().trim() : '';
      if (!range || !text) { setAt(null); return; }
      const r = range.getBoundingClientRect();
      setAt({ x: r.left + r.width / 2, y: r.top, text: text.slice(0, QUOTE_MAX) });
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(update); };
    document.addEventListener('selectionchange', soon);
    window.addEventListener('scroll', soon, true);
    window.addEventListener('resize', soon);
    return () => {
      document.removeEventListener('selectionchange', soon);
      window.removeEventListener('scroll', soon, true);
      window.removeEventListener('resize', soon);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [threadId]);

  if (!at) return null;
  return (
    <button
      type="button"
      // keep the selection while pressing
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        window.dispatchEvent(new CustomEvent<QuoteRequest>(QUOTE_EVENT, { detail: { threadId, text: at.text } }));
        window.getSelection()?.removeAllRanges();
        setAt(null);
      }}
      style={{ left: at.x, top: Math.max(8, at.y - 8) }}
      className="glass-popover no-drag fixed z-30 flex h-8 -translate-x-1/2 -translate-y-full items-center gap-1.5 ab-pill squircle rounded-control px-3 text-ui font-semibold tracking-ui text-fg hover:bg-surface-2"
    >
      <Icon icon={MessageSquare} size={14} className="text-fg-2" />
      Quote
    </button>
  );
}
