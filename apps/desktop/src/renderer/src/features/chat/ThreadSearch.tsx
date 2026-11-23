// Find in this chat (T3 Code's "Find in the current thread"): ⌘F opens a small bar over the transcript's top right;
// typing marks every match in the messages loaded so far with the CSS Custom Highlight API (nothing in the messages is
// rewritten), Enter / ↓ and Shift+Enter / ↑ step through them, scrolling each into view; Escape closes it.
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from '../../components/ui/icons';
import { Button, Icon, isDialogOpen } from '../../components/ui';
import { useHotkey } from '../../lib/hooks';
import { FIND_EVENT, type FindRequest } from './Transcript';

const ALL = 'ab-find';
const CURRENT = 'ab-find-current';

/** CSS.highlights where the browser has it (Chromium 105+). */
const highlights = (): HighlightRegistry | undefined => (typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : undefined);

function clearMarks(): void {
  highlights()?.delete(ALL);
  highlights()?.delete(CURRENT);
}

/** Every case-insensitive match of `q` in the transcript's text, in reading order. */
function findRanges(root: HTMLElement, q: string): Range[] {
  const needle = q.toLocaleLowerCase();
  const out: Range[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('[aria-hidden="true"], button, svg, style, script') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = (n.nodeValue ?? '').toLocaleLowerCase();
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + needle.length);
      out.push(r);
    }
  }
  return out;
}

const request = (detail: FindRequest) => window.dispatchEvent(new CustomEvent(FIND_EVENT, { detail }));
const OPEN_EVENT = 'appubot:open-find';
/** Open find in the chat on screen (the command palette's "Find in chat"). */
export const openFind = () => window.dispatchEvent(new Event(OPEN_EVENT));

export function ThreadSearch({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);

  const show = () => {
    setOpen(true);
    request({ threadId, all: true });
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  };
  useHotkey((e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && !isDialogOpen(), show);
  useEffect(() => {
    // the palette closes first; open once it has let go of the focus
    const onOpen = () => setTimeout(show, 0);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  });

  const close = () => { setOpen(false); setQuery(''); clearMarks(); };
  // another chat: start over
  useEffect(() => close, [threadId]);

  // mark the matches, and again whenever the transcript changes (new messages, streaming, older pages)
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(`[data-transcript="${CSS.escape(threadId)}"]`);
    const q = query.trim();
    if (!open || !root || !q) { clearMarks(); ranges.current = []; setCount(0); return; }
    let frame = 0;
    const mark = () => {
      frame = 0;
      ranges.current = findRanges(root, q);
      setCount(ranges.current.length);
      setAt((a) => Math.min(a, Math.max(0, ranges.current.length - 1)));
      const reg = highlights();
      if (reg) reg.set(ALL, new Highlight(...ranges.current));
    };
    mark();
    const mo = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(mark); });
    mo.observe(root, { subtree: true, childList: true, characterData: true });
    return () => { mo.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [open, query, threadId]);

  // the current match: its own colour, scrolled into the middle of the view
  useEffect(() => {
    const r = ranges.current[at];
    const reg = highlights();
    if (!open || !r) { reg?.delete(CURRENT); return; }
    reg?.set(CURRENT, new Highlight(r));
    request({ threadId, detach: true });
    r.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [at, count, open, threadId]);

  useEffect(() => { setAt(0); }, [query]);
  useEffect(() => clearMarks, []);

  if (!open) return null;
  const step = (d: number) => { if (count) setAt((a) => (a + d + count) % count); };
  return (
    <div role="search" className="glass-popover ab-pill squircle absolute top-2 right-5 z-20 flex h-9 items-center gap-1 rounded-control-lg pr-1 pl-3">
      <Icon icon={Search} size={14} className="shrink-0 text-muted" />
      <input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); step(e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey) ? -1 : 1); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        }}
        placeholder="Find in chat"
        aria-label="Find in chat"
        spellCheck={false}
        className="w-48 bg-transparent text-copy text-fg outline-none placeholder:text-muted"
      />
      <span aria-live="polite" className="w-14 shrink-0 text-right text-note text-muted tabular-nums">
        {query.trim() ? (count ? `${at + 1} of ${count}` : 'None') : ''}
      </span>
      <Button size="icon-xs" variant="ghost" icon={ChevronUp} aria-label="Previous match" disabled={!count} onClick={() => step(-1)} />
      <Button size="icon-xs" variant="ghost" icon={ChevronDown} aria-label="Next match" disabled={!count} onClick={() => step(1)} />
      <Button size="icon-xs" variant="ghost" icon={X} aria-label="Close find" onClick={close} />
    </div>
  );
}
