// A routine in the chat (chat-core `routineRuns.ts`): its prompt is one quiet centred line, "↻ Asana check · 13:50",
// that opens to show the prompt (never a full bubble: the words are the routine's, not yours, and they repeat every
// run), with its (i) on hover (it came from a routine, when exactly). Its runs that had nothing to say fold into one
// line, "↻ Asana check ran 14 times · last 13:50  ✓", that opens to show them as they were.
import { useState, type ReactNode } from 'react';
import type { Message } from '@appubot/protocol';
import { routineFoldText, routinePromptText, type RoutineFold } from '@appubot/chat-core';
import { ChevronDown, Repeat } from '../../components/ui/icons';
import { Icon, cn } from '../../components/ui';
import { ChatMarkdown } from './Markdown';
import { MessageActions } from './MessageActions';
import { ReactionChip } from './Reactions';

const LINE = 'ab-pill squircle inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-control px-2.5 py-1 text-ui text-muted hover:bg-fg/5 hover:text-fg-2 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]';

function Chevron({ open }: { open: boolean }) {
  return <Icon icon={ChevronDown} size={12} className={cn('shrink-0 transition-transform duration-150', open && 'rotate-180')} />;
}

/** A routine's prompt as one line; pressing it shows the prompt under it. */
export function RoutinePromptLine({ msg, botName }: { msg: Message; botName?: string }) {
  const [open, setOpen] = useState(false);
  const { name, time, prompt } = routinePromptText(msg);
  const reacted = msg.reactions?.some((r) => r.by === 'bot');
  return (
    <div className="chat-routine-line flex w-full flex-col items-center">
      <div className="group/msg flex max-w-full min-w-0 items-center gap-1">
        {/* the (i) on the line's left and an empty twin on its right, so the line stays centred */}
        <MessageActions text={prompt} sent={msg} at={msg.createdAt} side="left" />
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={LINE} aria-label={`${name}, a routine, ran at ${time}. ${open ? 'Hide' : 'Show'} what it asked`}>
          <Icon icon={Repeat} size={13} className="shrink-0" />
          <span className="truncate font-medium text-fg-2">{name}</span>
          <span className="shrink-0 tabular-nums">· {time}</span>
          <Chevron open={open} />
        </button>
        <span aria-hidden className="w-[52px] shrink-0" />
      </div>
      {open ? (
        <div className="squircle mt-1 max-w-[80%] min-w-0 rounded-card bg-surface-2 px-3.5 py-2.5 text-copy leading-[1.6] text-fg-2">
          <ChatMarkdown text={prompt} variant="user" />
        </div>
      ) : null}
      {reacted ? <div className="flex h-6 items-center text-[11px] text-muted"><ReactionChip msg={msg} by="bot" botName={botName} /></div> : null}
    </div>
  );
}

/** Runs of a routine with nothing to say, in a row: one line; open, its runs (`children`) under it as they were. */
export function RoutineFoldLine({ fold, children }: { fold: RoutineFold; children: (open: boolean) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const { label, reply, a11y } = routineFoldText(fold);
  return (
    <div className="chat-routine-fold flex flex-col">
      <div className="flex justify-center px-1 pb-3.5">
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={LINE} aria-label={`${a11y}. ${open ? 'Hide' : 'Show'} the runs`}>
          <Icon icon={Repeat} size={13} className="shrink-0" />
          <span className="truncate tabular-nums">{label}</span>
          {reply ? <span className="ab-pill squircle max-w-32 shrink-0 truncate rounded-md bg-surface-2 px-1.5 text-note text-fg-2">{reply}</span> : null}
          <Chevron open={open} />
        </button>
      </div>
      {open ? <div className="flex flex-col">{children(open)}</div> : null}
    </div>
  );
}
