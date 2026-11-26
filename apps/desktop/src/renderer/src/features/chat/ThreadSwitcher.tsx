// One of a bot's threads as a row: its name, last message, time, unread dot and state; it renames in place and deletes
// (asked first). The side panel's Threads tab lists them (features/chat/ThreadsPanel.tsx); the header's own switcher
// popover, which this row was made for, went on 2026-11-17 with the thread's name in the header.
import { useEffect, useRef, useState } from 'react';
import { shownPreview, stripMarkdown, type Thread } from '@appubot/protocol';
import { rosterTime, threadTitle } from '@appubot/chat-core';
import { Pencil, Trash2 } from '../../components/ui/icons';
import { Button, Spinner, Tooltip, cn } from '../../components/ui';
import { deleteThread, renameThread } from '../../lib/actions';

/** One thread: its name, last message, time and state; renames in place and deletes (asked first) on hover. */
export function ThreadRow({ t, active, onScreen, unread, waiting, now, renaming, onHover, onOpen, onRename, onRenamed }: {
  t: Thread; active: boolean; onScreen: boolean; unread: boolean; waiting: boolean; now: number; renaming: boolean;
  onHover: () => void; onOpen: () => void; onRename: () => void; onRenamed: () => void;
}) {
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  /** the edit ended (saved or cancelled): the blur of the input going away must not save it again */
  const ended = useRef(false);
  useEffect(() => {
    if (!renaming) return;
    ended.current = false;
    setDraft(threadTitle(t));
    requestAnimationFrame(() => input.current?.select());
  }, [renaming]);
  const save = () => { if (ended.current) return; ended.current = true; const v = draft; onRenamed(); void renameThread(t.id, v); };
  const cancel = () => { ended.current = true; onRenamed(); };
  const preview = shownPreview(t.lastMessagePreview) ? stripMarkdown(shownPreview(t.lastMessagePreview)) : '';

  return (
    <div
      role="option"
      aria-selected={onScreen}
      data-thread-row={t.id}
      onMouseMove={onHover}
      className={cn(
        'group/thread relative rounded-row transition-colors duration-100',
        onScreen ? 'bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)]' : active && 'bg-[color-mix(in_srgb,var(--ab-fg)_4.5%,transparent)]',
      )}
    >
      {renaming ? (
        <div className="flex h-[52px] items-center px-2">
          <input
            ref={input}
            value={draft}
            maxLength={120}
            aria-label="Thread name"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') { e.preventDefault(); save(); }
              else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            }}
            className="ab-pill squircle h-8 w-full rounded-md bg-surface-2 px-3 text-copy text-fg outline-none shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ab-fg)_22%,transparent)]"
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            tabIndex={-1}
            onClick={onOpen}
            className="squircle flex w-full min-w-0 flex-col gap-px rounded-row px-2.5 py-2 text-left outline-none"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn('min-w-0 truncate text-copy', unread ? 'font-semibold text-fg' : 'text-fg')}>{threadTitle(t)}</span>
              <span className="min-w-1 flex-1" />
              {t.status === 'running' ? <Spinner size={11} className="shrink-0 text-muted" /> : null}
              {waiting ? <span role="img" aria-label="Needs you" className="size-2 shrink-0 rounded-full bg-attention" /> : null}
              {unread ? <span role="img" aria-label="Unread" className="size-2 shrink-0 rounded-full bg-unread" /> : null}
              <time className="shrink-0 text-note tabular-nums text-muted transition-opacity group-hover/thread:opacity-0">{rosterTime(t.updatedAt, now)}</time>
            </span>
            <span className={cn('truncate text-ui leading-[17px]', unread ? 'text-fg-2' : 'text-muted')}>{preview || 'No messages yet'}</span>
          </button>
          {/* hover actions sit over the time */}
          <span className="pointer-events-none absolute top-1 right-1 flex items-center gap-px opacity-0 transition-opacity group-hover/thread:pointer-events-auto group-hover/thread:opacity-100">
            <Tooltip label="Rename">
              <Button size="icon-xs" variant="ghost" icon={Pencil} aria-label="Rename thread" tabIndex={-1} onClick={onRename} />
            </Tooltip>
            <Tooltip label="Delete">
              <Button size="icon-xs" variant="ghost" icon={Trash2} aria-label="Delete thread" tabIndex={-1} onClick={() => deleteThread(t.id)} className="hover:text-danger" />
            </Tooltip>
          </span>
        </>
      )}
    </div>
  );
}
